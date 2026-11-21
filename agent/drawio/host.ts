// DrawioPanelHost: implements zotero-mcp's PanelHost contract on top of draw.io Desktop + Electron Main IPC.
import type {
  AgentRuntime,
  AgentSession,
  BackendId,
  BackendStatus,
  Catalog,
  ChatEvent,
  ContextChip,
  DoctorCheck,
  ItemHit,
  ModeOption,
  ModelOption,
  NoteRequest,
  PanelHost,
  PanelSettings,
  PromptInput,
  SavedNote,
  SavedSession,
  SkillHost,
  StartOpts,
  ZoteroRef,
} from "../core/types.ts";
import { repeatLine } from "../core/ui/economy.ts";
import type { CanvasContext } from "./types.ts";

export interface DrawioHostDeps {
  ui: any;
  initialSettings: PanelSettings;
  aboutInfo: { version: string; workspace: string };
  context: {
    getContext: () => CanvasContext;
    onChange: (cb: () => void) => () => void;
  };
  mutator: {
    selectAndFocus: (cellIds?: string[]) => { ok: boolean; count: number };
  };
  getTheme: () => "light" | "dark";
  onThemeChange: (cb: () => void) => () => void;
}

interface MainStartResponse {
  sessionId: string;
  backend: BackendId;
  account?: string;
  supportsImages: boolean;
  canCompact: boolean;
  models: ModelOption[];
  currentModel?: string;
  defaultModel?: string;
  modes: ModeOption[];
  currentMode?: string;
  efforts: ModeOption[];
  currentEffort?: string;
  cwd: string;
}

export function createDrawioPanelHost(deps: DrawioHostDeps): PanelHost {
  const { ui, context, mutator, getTheme, onThemeChange } = deps;
  const rpc = <T = unknown>(target: string, method: string, ...args: unknown[]): Promise<T> => {
    if (!window.drawioAgent) return Promise.reject(new Error("window.drawioAgent bridge unavailable"));
    return window.drawioAgent.rpc<T>(target, method, ...args);
  };

  let cachedSettings: PanelSettings = deps.initialSettings;
  let cachedAbout = deps.aboutInfo;
  const settingsListeners = new Set<() => void>();

  // Listen for external settings changes from other windows
  const unsubSettings =
    window.drawioAgent?.on("agent:settings:changed", (next) => {
      if (next && typeof next === "object") {
        cachedSettings = next as PanelSettings;
        for (const cb of [...settingsListeners]) {
          try {
            cb();
          } catch {
            // ignore
          }
        }
      }
    }) ?? (() => {});

  // Event router for active IPC-backed AgentSession
  const sessionEventListeners = new Map<string, Set<(ev: ChatEvent) => void>>();
  window.drawioAgent?.on("agent:event", (raw) => {
    const msg = (raw ?? {}) as { sessionId?: string | null; event?: ChatEvent };
    if (!msg.event) return;
    if (msg.sessionId) {
      const set = sessionEventListeners.get(msg.sessionId);
      if (set) {
        for (const l of [...set]) {
          try {
            l(msg.event);
          } catch {
            // ignore
          }
        }
      }
    }
  });

  const runtime: AgentRuntime = {
    detect: () => rpc<BackendStatus[]>("runtime", "detect"),
    catalog: (backend: BackendId) => rpc<Catalog>("runtime", "catalog", backend),
    async start(opts: StartOpts): Promise<AgentSession> {
      const meta = await rpc<MainStartResponse>("session", "start", {
        backend: opts.backend,
        cwd: opts.cwd,
        brief: opts.brief,
        model: opts.model,
        mode: opts.mode,
        effort: opts.effort,
        auth: opts.auth,
        resumeSessionId: opts.resumeSessionId,
      });

      const listeners = new Set<(ev: ChatEvent) => void>();
      sessionEventListeners.set(meta.sessionId, listeners);

      let models = meta.models ?? [];
      let currentModel = meta.currentModel;
      const defaultModel = meta.defaultModel;
      let modes = meta.modes ?? [];
      let currentMode = meta.currentMode;
      let efforts = meta.efforts ?? [];
      let currentEffort = meta.currentEffort;

      const proxy: AgentSession = {
        get sessionId() {
          return meta.sessionId;
        },
        get backend() {
          return meta.backend;
        },
        get account() {
          return meta.account;
        },
        get supportsImages() {
          return meta.supportsImages;
        },
        get canCompact() {
          return meta.canCompact;
        },
        models: () => models,
        currentModel: () => currentModel,
        defaultModel: () => defaultModel,
        modes: () => modes,
        currentMode: () => currentMode,
        efforts: () => efforts,
        currentEffort: () => currentEffort,
        async setModel(id: string) {
          const res = await rpc<{ models: ModelOption[]; currentModel?: string; efforts: ModeOption[]; currentEffort?: string }>(
            "session",
            "setModel",
            id
          );
          if (res.models) models = res.models;
          currentModel = res.currentModel;
          if (res.efforts) efforts = res.efforts;
          currentEffort = res.currentEffort;
        },
        async setEffort(id: string) {
          const res = await rpc<{ currentEffort?: string }>("session", "setEffort", id);
          currentEffort = res.currentEffort;
        },
        async setMode(id: string) {
          const res = await rpc<{ currentMode?: string }>("session", "setMode", id);
          currentMode = res.currentMode;
        },
        on(listener: (ev: ChatEvent) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt(input: PromptInput) {
          await rpc("session", "prompt", input);
        },
        async cancel() {
          await rpc("session", "cancel");
        },
        async compact() {
          await rpc("session", "compact");
        },
        respondPermission(id: string, optionId: string | null) {
          void rpc("session", "respondPermission", id, optionId);
        },
        async close() {
          sessionEventListeners.delete(meta.sessionId);
          listeners.clear();
          await rpc("session", "close");
        },
      };

      return proxy;
    },
  };

  // Minimal SkillHost (Phase 3 focuses on built-in prompts & live canvas skills)
  const skills: SkillHost = {
    get dir() {
      return cachedAbout.workspace;
    },
    list: async () => [],
    read: async () => "",
    write: async () => {},
    remove: async () => {},
    reveal: async () => {
      await rpc("system", "revealWorkspace");
    },
    pick: async () => null,
    inspect: async () => {
      throw new Error("Skill import is not enabled in this build");
    },
    add: async () => {},
    use: async () => "",
  };

  function currentContext(): ContextChip[] {
    const s = cachedSettings;
    if (!s.followFocus) return [];
    const ctx = context.getContext();
    const fileKey = ctx.file.path || ctx.file.title;
    const chips: ContextChip[] = [
      {
        id: `page:${ctx.page.id}`,
        kind: "reader",
        label: `${ctx.file.title} · ${ctx.page.name} (${ctx.page.stats.vertexCount} 节点)`,
        auto: true,
        pinned: false,
        ref: { libraryID: 1, itemKey: fileKey, pageLabel: ctx.page.name },
        text: JSON.stringify({ file: ctx.file, page: ctx.page, summary: ctx.summary }),
      },
    ];

    if (s.attachSelection && ctx.selection.count > 0) {
      const selIds = ctx.selection.cells.map((c) => c.id);
      const preview = ctx.selection.cells
        .slice(0, 2)
        .map((c) => c.label || `#${c.id}`)
        .join(", ");
      chips.push({
        id: `sel:${selIds.join(",")}`,
        kind: "selection",
        label: `已选 ${ctx.selection.count} 项${preview ? ` (${preview})` : ""}`,
        auto: true,
        pinned: false,
        ref: { libraryID: 1, itemKey: fileKey, annotationKey: selIds.join(",") },
        text: JSON.stringify(ctx.selection),
      });
    }

    return chips;
  }

  function describeContext(chips: ContextChip[]): { text: string; images: { mime: string; data: string }[] } {
    const lines: string[] = [];
    const images: { mime: string; data: string }[] = [];

    for (const c of chips) {
      if (c.kind === "image" && c.image) {
        if (c.repeat) {
          const r = repeatLine([c]);
          if (r) lines.push(r);
        } else {
          images.push(c.image);
          lines.push(`[Reference image attached: ${c.label}]`);
        }
        continue;
      }
      if (c.repeat) {
        const r = repeatLine([c]);
        if (r) lines.push(r);
        continue;
      }
      if (c.kind === "reader" && c.text) {
        lines.push(`<drawio_page_context>\n${c.text}\n</drawio_page_context>`);
      } else if (c.kind === "selection" && c.text) {
        lines.push(`<drawio_selection>\n${c.text}\n</drawio_selection>`);
      } else if (c.kind === "item" && c.text) {
        lines.push(`<drawio_cell_mention label=${JSON.stringify(c.label)}>\n${c.text}\n</drawio_cell_mention>`);
      }
    }

    return { text: lines.join("\n"), images };
  }

  const host: PanelHost = {
    runtime,
    skills,
    currentContext,
    onContextChange: (cb) => context.onChange(cb),

    // Lightweight @ mention search over cells on the active canvas
    async search(query: string): Promise<ItemHit[]> {
      const ctx = context.getContext();
      const q = query.trim().toLowerCase();
      return ctx.summary.cells
        .filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
        .slice(0, 12)
        .map((c) => ({
          kind: "item" as const,
          title: c.label || `Cell #${c.id}`,
          subtitle: `${c.kind} · id=${c.id}`,
          ref: { libraryID: 1, itemKey: c.id },
        }));
    },

    async chipFor(hit: ItemHit): Promise<ContextChip> {
      const id = hit.ref.itemKey || "";
      return {
        id: `cell:${id}`,
        kind: "item",
        label: hit.title,
        auto: false,
        pinned: true,
        ref: hit.ref,
        text: JSON.stringify({ id, title: hit.title, subtitle: hit.subtitle }),
      };
    },

    async dropChips() {
      return [];
    },

    async open(target: string | ZoteroRef) {
      if (typeof target === "object" && target) {
        const ids = target.annotationKey
          ? target.annotationKey.split(",").filter(Boolean)
          : target.itemKey
            ? [target.itemKey]
            : [];
        if (ids.length > 0) {
          mutator.selectAndFocus(ids);
        }
      }
    },

    async paperContext() {
      return [];
    },

    describeContext,

    getSettings: () => cachedSettings,

    async setSettings(patch: Partial<PanelSettings>) {
      cachedSettings = await rpc<PanelSettings>("settings", "set", patch);
      cachedAbout = await rpc<{ version: string; workspace: string }>("system", "about");
    },

    async setApiKey(backend: BackendId, key: string | null) {
      await rpc("settings", "setApiKey", backend, key);
    },

    async hasApiKey(backend: BackendId) {
      return await rpc<boolean>("settings", "hasApiKey", backend);
    },

    sessions: () => rpc<SavedSession[]>("store", "sessions"),
    loadEvents: (sessionId: string) => rpc<ChatEvent[]>("store", "loadEvents", sessionId),

    async appendEvent(session: SavedSession, ev: ChatEvent) {
      const ctx = context.getContext();
      const filePath = session.filePath || ctx.file.path || ctx.file.title;
      await rpc("store", "appendEvent", { ...session, filePath }, ev);
    },

    deleteSession: (sessionId: string) => rpc<void>("store", "deleteSession", sessionId),
    renameSession: (sessionId: string, title: string) => rpc<void>("store", "renameSession", sessionId, title),

    paperTitle(): string | null {
      const ctx = context.getContext();
      return `${ctx.file.title} · ${ctx.page.name}`;
    },

    clearHistory: () => rpc<void>("store", "clearAll"),
    revealWorkspace: async () => {
      await rpc("system", "revealWorkspace");
    },

    async resetSettings() {
      cachedSettings = await rpc<PanelSettings>("settings", "reset");
    },

    about: () => cachedAbout,

    async doctor(): Promise<DoctorCheck[]> {
      const info = await rpc<{
        nodeBin: string | null;
        statuses: BackendStatus[];
        activeBackend: BackendStatus | null;
      }>("system", "doctor");

      const checks: DoctorCheck[] = [
        {
          id: "node",
          ok: Boolean(info.nodeBin),
          label: info.nodeBin ? "Node.js 已就绪" : "未找到 Node.js",
          detail: info.nodeBin ?? "请安装 Node.js 20+ 并确保在 PATH 中",
        },
        {
          id: "backend",
          ok: Boolean(info.activeBackend?.available),
          label: info.activeBackend?.available
            ? `${info.activeBackend.label} 已连接${info.activeBackend.account ? ` (${info.activeBackend.account})` : ""}`
            : `${info.activeBackend?.label ?? cachedSettings.backend} 未就绪`,
          detail: info.activeBackend?.reason,
        },
      ];
      return checks;
    },

    async prepareSession(cwd?: string) {
      const about = await rpc<{ version: string; workspace: string }>("system", "about");
      cachedAbout = about;
      return {
        cwd: cwd || about.workspace,
        brief: "",
        env: {},
      };
    },

    chooseFolder: (start?: string) => rpc<string | null>("system", "chooseFolder", start),

    async saveFile(suggestedName: string, data: Uint8Array | string, _mime: string) {
      const payload = typeof data === "string" ? data : Array.from(data);
      return await rpc<string | null>("system", "saveFile", suggestedName, payload);
    },

    async saveNote(_note: NoteRequest): Promise<SavedNote> {
      throw new Error("saveNote is not used in draw.io Agent");
    },

    chooseImage: async () => null,
    loadImage: async () => null,
    removeImage: async () => {},

    resumeCommand(_session: SavedSession): string | null {
      return null;
    },

    locale(): string {
      return (ui?.editor?.graph?.dialect ? navigator.language : navigator.language) || "zh-CN";
    },

    theme: getTheme,
    onThemeChange,

    onSettingsChange(cb: () => void) {
      settingsListeners.add(cb);
      return () => {
        settingsListeners.delete(cb);
      };
    },
  };

  // Expose cleanup helper if needed
  void unsubSettings;
  return host;
}
