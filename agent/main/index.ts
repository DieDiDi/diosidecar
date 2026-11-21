// Electron Main process entry for drawio-agent (Phase 3: full PanelHost backend,
// ACP multi-backend runtime, Stdio Canvas MCP bridge, Option C approval gate via session.#pending,
// electron-store PanelSettings, safeStorage macOS Keychain API keys, JSONL session store, capturePage)
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  App,
  BrowserWindow,
  Dialog,
  IpcMain,
  IpcMainInvokeEvent,
  Rectangle,
  SafeStorage,
  Shell,
} from "electron";
import Store from "electron-store";

import { createRuntime } from "../core/agent/runtime.ts";
import { BACKENDS, isNative } from "../core/agent/backends.ts";
import { findBinary } from "../core/agent/env.ts";
import type {
  AgentSession,
  BackendId,
  BackendValues,
  ChatEvent,
  PanelSettings,
  PromptInput,
  SavedSession,
  ToolKind,
} from "../core/types.ts";
import { createNodeSpawner } from "./node-spawner.ts";
import { createSessionStore } from "./store.ts";
import { createApiKeyStore } from "./api-key-store.js";
import { startCanvasBridgeHttp, type CanvasBridgeHttp } from "./canvas-bridge-http.ts";

// Inlined at build time by esbuild loader { ".md": "text" }
import systemBriefMd from "../skills/system-brief.md";
import xmlEssentialsMd from "../skills/xml-essentials.md";

export interface InitDrawioAgentDeps {
  app: App;
  ipcMain: IpcMain;
  BrowserWindow: typeof BrowserWindow;
  safeStorage: SafeStorage;
  dialog: Dialog;
  shell: Shell;
}

interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrawioAgentSettings extends PanelSettings {
  sidebarWidth: number;
  sidebarOpen: boolean;
  mutationPolicy: "auto" | "confirm-destructive" | "confirm-all";
}

interface PendingToolCall {
  resolve: (val: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const perBackend = <T>(v: T): BackendValues<T> => ({
  "claude-code": v,
  codex: v,
  pi: v,
  opencode: v,
});

export function defaultDrawioSettings(): DrawioAgentSettings {
  return {
    backend: "codex",
    model: perBackend(""),
    mode: perBackend(""),
    effort: perBackend(""),
    auth: { "claude-code": "subscription", codex: "subscription", pi: "api-key", opencode: "subscription" },
    prompts: [
      { id: "p1", title: "美化选中排版", text: "优化当前选中图形的配色、对齐与字号，保持原意不变，改完用视觉自查确认没有重叠。", slot: 1 },
      { id: "p2", title: "补充异常分支", text: "基于当前选中的流程节点，补充合理的异常处理、重试或降级分支。", slot: 2 },
      { id: "p3", title: "生成流程图", text: "帮我根据以下描述在当前画布绘制一张清晰的流程图：", slot: 3 },
      { id: "p4", title: "解释当前图表", text: "结合当前页面和选中图形，简明扼要地解释这段流程或架构的核心逻辑。", slot: 4 },
    ],
    skills: {},
    followFocus: true,
    attachSelection: true,
    attachAreas: false,
    enterToSend: true,
    showThinking: true,
    expandTools: false,
    showUsage: false,
    openAtStart: false,
    welcomed: true,
    scrollOnSend: true,
    titleSource: "agent",
    chatFolder: "",
    translate: false,
    translateTo: "zh-Hans",
    translateModel: perBackend(""),
    uiLanguage: "",
    appearance: {
      glass: false,
      accent: "",
      background: "none",
      image: "",
      imageVisibility: 30,
      imageBlur: 0,
      textSize: "default",
      density: "comfortable",
    },
    sidebarWidth: 420,
    sidebarOpen: false,
    mutationPolicy: "confirm-destructive",
  };
}

const MAX_SNAPSHOT_EDGE = 1568;
const MAX_SNAPSHOT_FILES = 20;
const TOOL_TIMEOUT_MS = 30_000;

const MUTATING_TOOLS = new Set(["update_cells", "insert_xml", "insert_mermaid", "delete_cells"]);

let initialized = false;

function unpackedPath(p: string): string {
  return p.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
}

function classifyMutation(
  tool: string,
  args: Record<string, unknown>
): { mutating: boolean; destructive: boolean; title: string; kind: ToolKind } {
  if (!MUTATING_TOOLS.has(tool)) {
    return { mutating: false, destructive: false, title: tool, kind: "read" };
  }
  if (tool === "delete_cells") {
    const ids = Array.isArray(args.cellIds) ? args.cellIds : [];
    return {
      mutating: true,
      destructive: true,
      title: `删除画布上的 ${ids.length} 个图形元素`,
      kind: "delete",
    };
  }
  if ((tool === "insert_xml" || tool === "insert_mermaid") && Boolean(args.replaceCurrentPage)) {
    return {
      mutating: true,
      destructive: true,
      title: tool === "insert_mermaid" ? "使用 Mermaid 替换当前整页画布" : "使用新 XML 替换当前整页画布",
      kind: "edit",
    };
  }
  if (tool === "update_cells") {
    const updates = Array.isArray(args.updates) ? args.updates : [];
    return {
      mutating: true,
      destructive: false,
      title: `修改画布上的 ${updates.length} 个图形元素`,
      kind: "edit",
    };
  }
  return {
    mutating: true,
    destructive: false,
    title: tool === "insert_mermaid" ? "向画布插入 Mermaid 图形" : "向画布插入 XML 图形",
    kind: "edit",
  };
}

async function pruneOldSnapshots(dir: string): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith(".png"));
    if (names.length <= MAX_SNAPSHOT_FILES) return;
    const entries = await Promise.all(
      names.map(async (name) => {
        const full = join(dir, name);
        const s = await stat(full).catch(() => null);
        return { full, mtime: s?.mtimeMs ?? 0 };
      })
    );
    entries.sort((a, b) => a.mtime - b.mtime);
    const toDelete = entries.slice(0, entries.length - MAX_SNAPSHOT_FILES);
    await Promise.all(toDelete.map((e) => unlink(e.full).catch(() => {})));
  } catch {
    // non-fatal
  }
}

export function initDrawioAgent({ app, ipcMain, BrowserWindow, safeStorage, dialog, shell }: InitDrawioAgentDeps): void {
  if (initialized) return;
  initialized = true;

  const mainDir = dirname(fileURLToPath(import.meta.url)); // .../agent/dist
  const agentDir = dirname(mainDir); // .../agent
  const desktopRoot = dirname(agentDir); // .../drawio-desktop

  const mcpServerPath = unpackedPath(join(mainDir, "mcp-server.mjs"));
  const shapeIndexPath = unpackedPath(join(agentDir, "shared", "search-index.json"));
  const localElkPath = unpackedPath(
    join(desktopRoot, "drawio", "src", "main", "webapp", "js", "elk", "drawio-elk.min.js")
  );

  const dataDir = join(app.getPath("userData"), "drawio-agent");
  const bridgeDir = join(dataDir, "bridges");
  const sessionsDir = join(dataDir, "sessions");
  const defaultWorkspace = join(dataDir, "workspace");
  const keysFile = join(dataDir, "keys.json");
  const snapshotDir = join(tmpdir(), "drawio-agent-snapshots");

  let settingsStore: Store<DrawioAgentSettings> | null = null;
  try {
    settingsStore = new Store<DrawioAgentSettings>({
      name: "drawio-agent-v3",
      defaults: defaultDrawioSettings(),
    });
  } catch (err) {
    console.error("[drawio-agent] Failed to initialize electron-store:", err);
  }

  function getSettings(): DrawioAgentSettings {
    const def = defaultDrawioSettings();
    if (!settingsStore) return def;
    const cur = settingsStore.store as Partial<DrawioAgentSettings>;
    return {
      ...def,
      ...cur,
      model: { ...def.model, ...(cur.model ?? {}) },
      mode: { ...def.mode, ...(cur.mode ?? {}) },
      effort: { ...def.effort, ...(cur.effort ?? {}) },
      auth: { ...def.auth, ...(cur.auth ?? {}) },
      translateModel: { ...def.translateModel, ...(cur.translateModel ?? {}) },
      appearance: { ...def.appearance, ...(cur.appearance ?? {}) },
    };
  }

  const apiKeys = createApiKeyStore(keysFile, safeStorage);
  const sessionStore = createSessionStore(sessionsDir);
  const spawner = createNodeSpawner();

  const windowSessions = new Map<number, { session: AgentSession; unsub: () => void }>();
  const watchedWindows = new Set<number>();
  const pendingTools = new Map<string, PendingToolCall>();
  let toolSeq = 0;
  let bridgePromise: Promise<CanvasBridgeHttp> | null = null;

  function findWindowByWebContentsId(wcId: number): BrowserWindow | undefined {
    const all = BrowserWindow.getAllWindows();
    const exact = all.find((w) => !w.isDestroyed() && w.webContents.id === wcId);
    if (exact) return exact;
    return BrowserWindow.getFocusedWindow() ?? all.find((w) => !w.isDestroyed());
  }

  async function captureCanvas(win: BrowserWindow, rawRect?: Partial<CaptureRect>) {
    const r = rawRect ?? {};
    const rect: Rectangle | undefined =
      typeof r.x === "number" &&
      typeof r.y === "number" &&
      typeof r.width === "number" &&
      typeof r.height === "number" &&
      r.width > 1 &&
      r.height > 1
        ? {
            x: Math.max(0, Math.round(r.x)),
            y: Math.max(0, Math.round(r.y)),
            width: Math.max(1, Math.round(r.width)),
            height: Math.max(1, Math.round(r.height)),
          }
        : undefined;

    let img = await win.webContents.capturePage(rect);
    const origSize = img.getSize();
    const longEdge = Math.max(origSize.width, origSize.height);
    if (longEdge > MAX_SNAPSHOT_EDGE) {
      const scale = MAX_SNAPSHOT_EDGE / longEdge;
      img = img.resize({
        width: Math.max(1, Math.round(origSize.width * scale)),
        height: Math.max(1, Math.round(origSize.height * scale)),
        quality: "good",
      });
    }

    const size = img.getSize();
    const pngBuf = img.toPNG();
    const base64 = pngBuf.toString("base64");

    await mkdir(snapshotDir, { recursive: true });
    const filePath = join(snapshotDir, `canvas-${Date.now()}.png`);
    await writeFile(filePath, pngBuf);
    void pruneOldSnapshots(snapshotDir);

    return {
      mime: "image/png" as const,
      base64,
      dataUrl: `data:image/png;base64,${base64}`,
      filePath,
      width: size.width,
      height: size.height,
      bytes: pngBuf.length,
    };
  }

  function dispatchRendererTool(win: BrowserWindow, tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (win.isDestroyed()) {
      return Promise.reject(new Error("Target draw.io window is closed"));
    }
    const callId = `tc-${++toolSeq}-${Date.now().toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingTools.delete(callId);
        reject(new Error(`Renderer tool "${tool}" timed out after ${TOOL_TIMEOUT_MS / 1000}s`));
      }, TOOL_TIMEOUT_MS);

      pendingTools.set(callId, { resolve, reject, timer });
      win.webContents.send("agent:tool:execute", { callId, tool, args });
    });
  }

  function ensureBridge(): Promise<CanvasBridgeHttp> {
    bridgePromise ??= startCanvasBridgeHttp(async ({ windowId, tool, args }) => {
      const win = findWindowByWebContentsId(windowId);
      if (!win) throw new Error("No open draw.io window found");

      if (tool === "inspect_canvas_image") {
        const rect = (await dispatchRendererTool(win, "get_diagram_rect", {})) as Partial<CaptureRect>;
        return await captureCanvas(win, rect);
      }

      // Option C approval gate: reuse session.requestLocalPermission() (#pending + #cancelPending)
      const cls = classifyMutation(tool, args);
      if (cls.mutating) {
        const policy = getSettings().mutationPolicy ?? "confirm-destructive";
        const needsApproval =
          policy === "confirm-all" || (policy === "confirm-destructive" && cls.destructive);

        if (needsApproval) {
          const active = windowSessions.get(win.webContents.id);
          if (active?.session.requestLocalPermission) {
            const chosen = await active.session.requestLocalPermission({
              title: cls.title,
              kind: cls.kind,
              input: args,
            });
            if (chosen !== "allow_once") {
              throw new Error("用户已拒绝本次画布修改操作。");
            }
          }
        }
      }

      return await dispatchRendererTool(win, tool, args);
    });
    return bridgePromise;
  }

  function attachWindowCleanup(win: BrowserWindow): void {
    const wcId = win.webContents.id;
    if (watchedWindows.has(wcId)) return;
    watchedWindows.add(wcId);
    win.once("closed", () => {
      watchedWindows.delete(wcId);
      const active = windowSessions.get(wcId);
      if (active) {
        windowSessions.delete(wcId);
        active.unsub();
        void active.session.close().catch(() => {});
      }
    });
  }

  async function closeWindowSession(wcId: number): Promise<void> {
    const prev = windowSessions.get(wcId);
    if (!prev) return;
    windowSessions.delete(wcId);
    prev.unsub();
    await prev.session.close().catch(() => {});
  }

  const runtime = createRuntime({
    spawner,
    bridgeDir,
    customAgent: () => getSettings().customAgent,
    onProgress: (msg) => {
      console.log("[drawio-agent:bridge]", msg);
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send("agent:event", {
            sessionId: null,
            event: { t: "notice", level: "info", message: msg } satisfies ChatEvent,
          });
        }
      }
    },
  });

  app.on("before-quit", () => {
    for (const [wcId] of [...windowSessions]) {
      void closeWindowSession(wcId);
    }
    if (bridgePromise) {
      void bridgePromise.then((b) => b.close()).catch(() => {});
    }
  });

  type RpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>;

  const handlers: Record<string, Record<string, RpcHandler>> = {
    system: {
      ping: () => ({
        ok: true,
        platform: process.platform,
        appVersion: app.getVersion(),
      }),
      about: () => ({
        version: app.getVersion(),
        workspace: getSettings().chatFolder || defaultWorkspace,
      }),
      doctor: async () => {
        const env = await spawner.baseEnv();
        const nodeBin = await findBinary(spawner, env, "node");
        const statuses = await runtime.detect();
        const backend = getSettings().backend;
        const cur = statuses.find((s) => s.id === backend);
        return {
          nodeBin,
          statuses,
          activeBackend: cur ?? null,
        };
      },
      revealWorkspace: async () => {
        const ws = getSettings().chatFolder || defaultWorkspace;
        await mkdir(ws, { recursive: true });
        await shell.openPath(ws);
        return { ok: true };
      },
      chooseFolder: async (event, start) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        const res = await dialog.showOpenDialog(win ?? undefined!, {
          properties: ["openDirectory", "createDirectory"],
          ...(typeof start === "string" && start ? { defaultPath: start } : {}),
        });
        return res.canceled ? null : (res.filePaths[0] ?? null);
      },
      saveFile: async (event, suggestedName, data) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        const res = await dialog.showSaveDialog(win ?? undefined!, {
          defaultPath: String(suggestedName || "diagram.png"),
        });
        if (res.canceled || !res.filePath) return null;
        if (typeof data === "string") {
          await writeFile(res.filePath, data, "utf8");
        } else if (Array.isArray(data)) {
          await writeFile(res.filePath, Buffer.from(data as number[]));
        }
        return res.filePath;
      },
      resumeCommand: (_event, session) => {
        const s = session as SavedSession | undefined;
        if (!s?.agentSessionId || s.backend === "custom") return null;
        const spec = BACKENDS[s.backend];
        if (!spec) return null;
        const cmd = isNative(spec) ? spec.resume(s.agentSessionId) : spec.resume(s.agentSessionId);
        return s.cwd ? `cd ${JSON.stringify(s.cwd)} && ${cmd}` : cmd;
      },
    },
    settings: {
      get: () => getSettings(),
      set: (event, patch) => {
        if (!patch || typeof patch !== "object") return getSettings();
        const cur = getSettings();
        const p = patch as Partial<DrawioAgentSettings>;
        const next: DrawioAgentSettings = {
          ...cur,
          ...p,
          ...(typeof p.sidebarWidth === "number"
            ? { sidebarWidth: Math.min(800, Math.max(320, Math.round(p.sidebarWidth))) }
            : {}),
          ...(p.model ? { model: { ...cur.model, ...p.model } } : {}),
          ...(p.mode ? { mode: { ...cur.mode, ...p.mode } } : {}),
          ...(p.effort ? { effort: { ...cur.effort, ...p.effort } } : {}),
          ...(p.auth ? { auth: { ...cur.auth, ...p.auth } } : {}),
          ...(p.appearance ? { appearance: { ...cur.appearance, ...p.appearance } } : {}),
        };
        if (settingsStore) settingsStore.set(next);
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed() && win.webContents.id !== event.sender.id) {
            win.webContents.send("agent:settings:changed", next);
          }
        }
        return next;
      },
      reset: () => {
        const def = defaultDrawioSettings();
        if (settingsStore) settingsStore.set(def);
        return def;
      },
      setApiKey: async (_event, backend, key) => {
        await apiKeys.set(String(backend), key == null ? null : String(key));
        return { ok: true };
      },
      hasApiKey: async (_event, backend) => {
        return (await apiKeys.get(String(backend))) !== null;
      },
    },
    canvas: {
      capturePage: async (event, rawRect) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) throw new Error("No active BrowserWindow for capturePage");
        return await captureCanvas(win, rawRect as Partial<CaptureRect>);
      },
    },
    tool: {
      reply: (_event, raw) => {
        const payload = (raw ?? {}) as { callId?: string; ok?: boolean; result?: unknown; error?: string };
        const pending = payload.callId ? pendingTools.get(payload.callId) : undefined;
        if (!pending) return { ok: false };
        pendingTools.delete(payload.callId!);
        clearTimeout(pending.timer);
        if (payload.ok) {
          pending.resolve(payload.result);
        } else {
          pending.reject(new Error(payload.error || "Tool execution failed"));
        }
        return { ok: true };
      },
    },
    runtime: {
      detect: () => runtime.detect(),
      catalog: (_event, backend) => runtime.catalog(String(backend || "codex") as BackendId),
    },
    session: {
      start: async (event, rawOpts) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) throw new Error("No active BrowserWindow");
        attachWindowCleanup(win);
        const wcId = win.webContents.id;

        await closeWindowSession(wcId);

        const opts = (rawOpts ?? {}) as {
          backend?: BackendId;
          cwd?: string;
          brief?: string;
          model?: string;
          mode?: string;
          effort?: string;
          auth?: "subscription" | "api-key";
          resumeSessionId?: string;
        };

        const settings = getSettings();
        const cwd = opts.cwd || settings.chatFolder || defaultWorkspace;
        await mkdir(cwd, { recursive: true });

        const bridge = await ensureBridge();
        const env = await spawner.baseEnv();
        const nodeBin = await findBinary(spawner, env, "node");
        if (!nodeBin) {
          throw new Error("System Node.js binary not found on PATH (required for drawio-canvas MCP)");
        }

        const backend: BackendId = opts.backend ?? settings.backend ?? "codex";
        const auth = opts.auth ?? (backend === "custom" ? undefined : settings.auth[backend]);
        const extraEnv: Record<string, string> = {};
        if (auth === "api-key" && backend !== "custom") {
          const apiKey = await apiKeys.get(backend);
          const varName = BACKENDS[backend]?.apiKeyVars[0];
          if (apiKey && varName) extraEnv[varName] = apiKey;
        }

        // For pi: pi CLI loads MCP from project-level .pi/mcp.json with exposure: "direct"
        // and checks ~/.pi/agent/trust.json to verify that cwd is trusted.
        if (backend === "pi") {
          try {
            const piBin = await findBinary(spawner, env, "pi");
            if (piBin) extraEnv.PI_ACP_PI_COMMAND = piBin;

            const piDir = join(cwd, ".pi");
            await mkdir(piDir, { recursive: true });
            const piMcpConfig = {
              mcpServers: {
                "drawio-canvas": {
                  command: nodeBin,
                  args: [mcpServerPath],
                  env: {
                    DRAWIO_BRIDGE_URL: bridge.url,
                    DRAWIO_BRIDGE_TOKEN: bridge.token,
                    DRAWIO_WINDOW_ID: String(wcId),
                    DRAWIO_ELK_URL: localElkPath,
                    DRAWIO_SHAPE_INDEX_PATH: shapeIndexPath,
                  },
                  exposure: "direct",
                },
              },
            };
            await writeFile(join(piDir, "mcp.json"), JSON.stringify(piMcpConfig, null, 2), "utf8");

            const trustPath = join(homedir(), ".pi", "agent", "trust.json");
            let trustData: Record<string, boolean> = {};
            try {
              trustData = JSON.parse(await readFile(trustPath, "utf8"));
            } catch {}
            if (!trustData[cwd]) {
              trustData[cwd] = true;
              await mkdir(dirname(trustPath), { recursive: true });
              await writeFile(trustPath, JSON.stringify(trustData, null, 2), "utf8");
            }
            extraEnv.PI_APPROVE = "1";
          } catch (e) {
            console.warn("[drawio-agent] failed to setup pi mcp.json / trust.json:", e);
          }
        }

        // For opencode: opencode CLI loads MCP servers from opencode.json in project root (cwd)
        // and uses permission: { "*": "allow" } for non-blocking direct tool execution.
        if (backend === "opencode") {
          try {
            const opencodeConfig = {
              "$schema": "https://opencode.ai/config.json",
              mcp: {
                servers: {
                  "drawio-canvas": {
                    command: nodeBin,
                    args: [mcpServerPath],
                    env: {
                      DRAWIO_BRIDGE_URL: bridge.url,
                      DRAWIO_BRIDGE_TOKEN: bridge.token,
                      DRAWIO_WINDOW_ID: String(wcId),
                      DRAWIO_ELK_URL: localElkPath,
                      DRAWIO_SHAPE_INDEX_PATH: shapeIndexPath,
                    },
                  },
                },
              },
              permission: {
                "*": "allow",
              },
            };
            await writeFile(join(cwd, "opencode.json"), JSON.stringify(opencodeConfig, null, 2), "utf8");
          } catch (e) {
            console.warn("[drawio-agent] failed to setup opencode.json:", e);
          }
        }

        // Also write standard .mcp.json in cwd for generic MCP clients (Claude Code, etc.)
        try {
          const stdMcpConfig = {
            mcpServers: {
              "drawio-canvas": {
                command: nodeBin,
                args: [mcpServerPath],
                env: {
                  DRAWIO_BRIDGE_URL: bridge.url,
                  DRAWIO_BRIDGE_TOKEN: bridge.token,
                  DRAWIO_WINDOW_ID: String(wcId),
                  DRAWIO_ELK_URL: localElkPath,
                  DRAWIO_SHAPE_INDEX_PATH: shapeIndexPath,
                },
              },
            },
          };
          await writeFile(join(cwd, ".mcp.json"), JSON.stringify(stdMcpConfig, null, 2), "utf8");
        } catch {}

        const brief = opts.brief || `${systemBriefMd.trim()}\n\n${xmlEssentialsMd.trim()}`;

        const session = await runtime.start({
          backend,
          cwd,
          brief,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.mode ? { mode: opts.mode } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(auth ? { auth } : {}),
          ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
          ...(Object.keys(extraEnv).length ? { env: extraEnv } : {}),
          mcpServers: [
            {
              name: "drawio-canvas",
              command: nodeBin,
              args: [mcpServerPath],
              env: [
                { name: "DRAWIO_BRIDGE_URL", value: bridge.url },
                { name: "DRAWIO_BRIDGE_TOKEN", value: bridge.token },
                { name: "DRAWIO_WINDOW_ID", value: String(wcId) },
                { name: "DRAWIO_ELK_URL", value: localElkPath },
                { name: "DRAWIO_SHAPE_INDEX_PATH", value: shapeIndexPath },
              ],
            },
          ],
        });

        const unsub = session.on((ev: ChatEvent) => {
          if (!win.isDestroyed()) {
            win.webContents.send("agent:event", { sessionId: session.sessionId, event: ev });
          }
        });

        windowSessions.set(wcId, { session, unsub });

        return {
          sessionId: session.sessionId,
          backend: session.backend,
          account: session.account,
          supportsImages: session.supportsImages,
          canCompact: session.canCompact,
          models: session.models(),
          currentModel: session.currentModel(),
          defaultModel: session.defaultModel(),
          modes: session.modes(),
          currentMode: session.currentMode(),
          efforts: session.efforts(),
          currentEffort: session.currentEffort(),
          cwd,
        };
      },
      prompt: async (event, input) => {
        const active = windowSessions.get(event.sender.id);
        if (!active) throw new Error("No active agent session");
        await active.session.prompt(input as PromptInput);
        return { ok: true };
      },
      cancel: async (event) => {
        const active = windowSessions.get(event.sender.id);
        if (!active) return { ok: false };
        await active.session.cancel();
        return { ok: true };
      },
      compact: async (event) => {
        const active = windowSessions.get(event.sender.id);
        if (!active) return { ok: false };
        await active.session.compact();
        return { ok: true };
      },
      setModel: async (event, modelId) => {
        const active = windowSessions.get(event.sender.id);
        if (!active) throw new Error("No active agent session");
        await active.session.setModel(String(modelId));
        return {
          models: active.session.models(),
          currentModel: active.session.currentModel(),
          efforts: active.session.efforts(),
          currentEffort: active.session.currentEffort(),
        };
      },
      setEffort: async (event, effortId) => {
        const active = windowSessions.get(event.sender.id);
        if (!active) throw new Error("No active agent session");
        await active.session.setEffort(String(effortId));
        return { currentEffort: active.session.currentEffort() };
      },
      setMode: async (event, modeId) => {
        const active = windowSessions.get(event.sender.id);
        if (!active) throw new Error("No active agent session");
        await active.session.setMode(String(modeId));
        return { currentMode: active.session.currentMode() };
      },
      respondPermission: (event, id, optionId) => {
        const active = windowSessions.get(event.sender.id);
        if (!active) return { ok: false };
        active.session.respondPermission(String(id), optionId == null ? null : String(optionId));
        return { ok: true };
      },
      close: async (event) => {
        await closeWindowSession(event.sender.id);
        return { ok: true };
      },
    },
    store: {
      sessions: () => sessionStore.sessions(),
      loadEvents: (_event, id) => sessionStore.loadEvents(String(id)),
      appendEvent: (_event, session, ev) => sessionStore.appendEvent(session as SavedSession, ev as ChatEvent),
      deleteSession: (_event, id) => sessionStore.deleteSession(String(id)),
      renameSession: (_event, id, title) => sessionStore.renameSession(String(id), String(title)),
      clearAll: () => sessionStore.clearAll(),
    },
  };

  ipcMain.handle("agent:rpc", async (event, payload: { target?: string; method?: string; args?: unknown[] }) => {
    const target = payload?.target;
    const method = payload?.method;
    const args = Array.isArray(payload?.args) ? payload.args : [];
    const group = target ? handlers[target] : undefined;
    const fn = group && method ? group[method] : undefined;
    if (!fn) {
      throw new Error(`Unknown drawioAgent RPC: ${String(target)}.${String(method)}`);
    }
    return await fn(event, ...args);
  });

  console.log("[drawio-agent] Main IPC + ACP + Canvas MCP initialized");
}
