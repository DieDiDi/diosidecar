// draw.io built-in plugin entry (Phase 3: full Zotero Agent Shadow DOM UI + DrawioPanelHost)
// Adapts zotero-mcp/plugin/src/zotero/inject.ts for draw.io Desktop:
// - Right-docked Shadow DOM sidebar with 7px drag-resize handle
// - CSS Grid width sync on ui.container (idempotent across all themes, zero overlap)
// - 4-line native ui.keyHandler.isEnabledForEvent isolation via composedPath()
// - Full Zotero Agent UI (mountPanel) + live [定位图形] / [撤销 (⌘Z)] bar
// - Toolbar toggle button, Extras menu entry, Cmd+Option+L toggle & Cmd+Ctrl+1..4 prompt slots
import type { MountPanel, PanelSettings } from "../core/types.ts";
import { mountPanel } from "../core/ui/index.ts";
import { createContextCollector } from "./context.ts";
import { createDrawioPanelHost } from "./host.ts";
import { createCanvasMutator } from "./mutator.ts";
import { attachCanvasToolExecutor } from "./tool-executor.ts";

interface SavedPanelPrefs extends PanelSettings {
  sidebarOpen?: boolean;
  sidebarWidth?: number;
}

const MIN_W = 320;
const MAX_W = 860;
const DEFAULT_W = 420;

const AGENT_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="9 -1 110 125" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path stroke-width="11" d="M40 12H88a26 26 0 0 1 26 26V78a26 26 0 0 1-26 26H62L38 118V104H40a26 26 0 0 1-26-26V38a26 26 0 0 1 26-26Z"/><path stroke-width="11" d="M51 39H64a19 19 0 0 1 0 38H51Z"/></svg>';

function currentTheme(): "light" | "dark" {
  try {
    return window.Editor?.isDarkMode?.() ? "dark" : "light";
  } catch {
    return "light";
  }
}

function clampWidth(w: number): number {
  return Math.min(MAX_W, Math.max(MIN_W, Math.round(w || DEFAULT_W)));
}

function mountAgentSidebar(ui: any): void {
  if (document.getElementById("drawio-agent-sidebar")) return;

  let isOpen = false;
  let width = DEFAULT_W;

  // 1. Right-docked host container (fixed outside .geEditor CSS Grid flow)
  const host = document.createElement("div");
  host.id = "drawio-agent-sidebar";
  host.style.cssText = [
    "position: fixed",
    "top: 0",
    "right: 0",
    "bottom: 0",
    `width: ${width}px`,
    "z-index: 200",
    "display: none",
    "flex-direction: column",
    "box-sizing: border-box",
    "border-left: 1px solid rgba(128, 128, 128, 0.28)",
    "box-shadow: -2px 0 12px rgba(0, 0, 0, 0.08)",
  ].join(";");

  // Compact live Canvas Mutation Action Bar (定位图形 + 一键撤销 ⌘Z)
  const actionBar = document.createElement("div");
  actionBar.id = "drawio-agent-undo-bar";
  actionBar.style.cssText = [
    "display: none",
    "align-items: center",
    "justify-content: space-between",
    "gap: 6px",
    "padding: 6px 10px",
    "font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
    "font-size: 12px",
    "border-bottom: 1px solid rgba(128, 128, 128, 0.22)",
    "flex: 0 0 auto",
  ].join(";");

  const actionLabel = document.createElement("span");
  actionLabel.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";

  const actionBtns = document.createElement("div");
  actionBtns.style.cssText = "display: flex; align-items: center; gap: 6px; flex: 0 0 auto;";

  const mkBarBtn = (text: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.style.cssText = [
      "padding: 3px 8px",
      "border-radius: 5px",
      "border: 1px solid rgba(128, 128, 128, 0.35)",
      "background: transparent",
      "color: inherit",
      "font-size: 11px",
      "cursor: pointer",
    ].join(";");
    return b;
  };

  const btnFocus = mkBarBtn("定位图形");
  const btnUndo = mkBarBtn("撤销 (⌘Z)");
  const btnHideBar = mkBarBtn("×");
  btnHideBar.style.border = "none";
  btnHideBar.style.padding = "2px 5px";

  actionBtns.append(btnFocus, btnUndo, btnHideBar);
  actionBar.append(actionLabel, actionBtns);

  const surface = document.createElement("div");
  surface.id = "drawio-agent-surface";
  surface.style.cssText = "flex: 1 1 auto; min-height: 0; width: 100%; display: flex; flex-direction: column;";
  const shadow = surface.attachShadow({ mode: "open" });

  // 7px left-edge drag resize handle (adapted from zotero-mcp/plugin/src/zotero/inject.ts)
  const handle = document.createElement("div");
  handle.id = "drawio-agent-resize";
  handle.style.cssText =
    "position: absolute; top: 0; bottom: 0; left: -3px; width: 7px; cursor: col-resize; z-index: 10;";

  host.append(actionBar, surface, handle);
  document.documentElement.appendChild(host);

  const syncBarTheme = () => {
    const dark = currentTheme() === "dark";
    actionBar.style.background = dark ? "#1a1d22" : "#f5f6f7";
    actionBar.style.color = dark ? "#e6e8eb" : "#16181d";
  };
  syncBarTheme();

  // 2. Idempotent layout sync: shrink .geEditor container width via CSS Grid
  const syncEditorLayout = () => {
    const container = ui.container as HTMLElement | undefined;
    if (container) {
      container.style.width = isOpen ? `calc(100% - ${width}px)` : "100%";
    }
    host.style.width = `${width}px`;
    host.style.display = isOpen ? "flex" : "none";
    try {
      ui.editor?.graph?.sizeDidChange?.();
    } catch {
      // ignore during early boot
    }
  };

  if (typeof ui.refresh === "function") {
    const origRefresh = ui.refresh.bind(ui);
    ui.refresh = function (sizeDidChange?: boolean) {
      origRefresh(sizeDidChange);
      const container = ui.container as HTMLElement | undefined;
      if (container) {
        container.style.width = isOpen ? `calc(100% - ${width}px)` : "100%";
      }
    };
  }

  // 3. Drag resize handler
  handle.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.screenX;
    const startW = width;

    const onMove = (m: PointerEvent) => {
      width = clampWidth(startW + (startX - m.screenX));
      syncEditorLayout();
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      void window.drawioAgent?.rpc("settings", "set", { sidebarWidth: width }).catch(() => {});
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });

  // 4. Native 4-line draw.io keyHandler isolation + clipboard/key bubbling guard
  if (ui.keyHandler && typeof ui.keyHandler.isEnabledForEvent === "function") {
    const origEnabled = ui.keyHandler.isEnabledForEvent.bind(ui.keyHandler);
    ui.keyHandler.isEnabledForEvent = function (evt: Event) {
      if (evt.composedPath?.().includes(host) || host.contains(evt.target as Node | null)) {
        return false;
      }
      return origEnabled(evt);
    };
  }

  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const isToggleShortcut = (e: KeyboardEvent) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    return mod && e.altKey && !e.shiftKey && e.code === "KeyL";
  };
  const slotShortcutNumber = (e: KeyboardEvent): number | null => {
    const slotMod = isMac ? e.metaKey && e.ctrlKey : e.ctrlKey && e.altKey;
    if (!slotMod) return null;
    const m = /^Digit([1-4])$/.exec(e.code);
    return m ? Number(m[1]) : null;
  };

  for (const type of ["keydown", "keyup", "keypress", "copy", "cut", "paste"] as const) {
    host.addEventListener(type, (evt) => {
      if (type === "keydown") {
        const ke = evt as KeyboardEvent;
        if (isToggleShortcut(ke) || slotShortcutNumber(ke) !== null) return;
      }
      evt.stopPropagation();
    });
  }

  // 5. Canvas context, mutator & live tool executor
  const context = createContextCollector(ui);
  const mutator = createCanvasMutator(ui);

  const syncUndoButton = () => {
    const can = mutator.canUndoLast();
    btnUndo.disabled = !can;
    btnUndo.style.opacity = can ? "1" : "0.45";
    btnUndo.title = can ? "撤销 Agent 上一次画布修改" : "已有后续手动编辑，请使用原生 ⌘Z";
  };

  const showMutationBar = (summary: string) => {
    actionLabel.textContent = `✓ ${summary}`;
    actionBar.style.display = "flex";
    syncUndoButton();
  };

  context.onChange(syncUndoButton);
  btnFocus.addEventListener("click", () => mutator.selectAndFocus());
  btnUndo.addEventListener("click", () => {
    const res = mutator.undoLast();
    if (res.ok) {
      actionLabel.textContent = "↶ 已撤销上次画布修改";
    }
    syncUndoButton();
  });
  btnHideBar.addEventListener("click", () => {
    actionBar.style.display = "none";
  });

  attachCanvasToolExecutor({
    ui,
    context,
    mutator,
    onMutation: showMutationBar,
  });

  // 6. Theme change broadcaster
  const themeListeners = new Set<() => void>();
  let lastTheme = currentTheme();
  const broadcastTheme = () => {
    const next = currentTheme();
    syncBarTheme();
    if (next === lastTheme) return;
    lastTheme = next;
    for (const cb of [...themeListeners]) {
      try {
        cb();
      } catch {
        // ignore
      }
    }
  };
  ui.addListener?.("darkModeChanged", broadcastTheme);
  window.Editor?.addListener?.("darkModeChanged", broadcastTheme);
  const darkObserver = new MutationObserver(broadcastTheme);
  darkObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  if (document.body) {
    darkObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  // 7. Lazy mount of full Zotero Agent Shadow DOM UI (mountPanel)
  let panelHandle: ReturnType<MountPanel> | null = null;
  let mounting: Promise<ReturnType<MountPanel>> | null = null;

  const ensurePanel = (): Promise<ReturnType<MountPanel>> => {
    if (panelHandle) return Promise.resolve(panelHandle);
    mounting ??= (async () => {
      const [settings, aboutInfo] = await Promise.all([
        window.drawioAgent!.rpc<SavedPanelPrefs>("settings", "get"),
        window.drawioAgent!.rpc<{ version: string; workspace: string }>("system", "about"),
      ]);
      const panelHost = createDrawioPanelHost({
        ui,
        initialSettings: settings,
        aboutInfo,
        context,
        mutator,
        getTheme: currentTheme,
        onThemeChange: (cb) => {
          themeListeners.add(cb);
          return () => themeListeners.delete(cb);
        },
      });
      panelHandle = mountPanel(shadow, panelHost);
      return panelHandle;
    })();
    return mounting;
  };

  // Zotero UI close button dispatches "zmc-close" on the shadow host
  surface.addEventListener("zmc-close", () => setOpen(false));

  // 8. Toolbar toggle button + Extras menu action
  let toggleBtn: HTMLButtonElement | null = null;

  const updateToggleVisual = () => {
    if (!toggleBtn) return;
    toggleBtn.setAttribute("aria-pressed", String(isOpen));
    toggleBtn.style.background = isOpen ? "rgba(37, 99, 235, 0.16)" : "transparent";
    toggleBtn.style.color = isOpen ? "#2563eb" : "inherit";
  };

  const setOpen = (next: boolean, persist = true) => {
    isOpen = next;
    syncEditorLayout();
    updateToggleVisual();
    if (isOpen) {
      void ensurePanel().then((h) => h.focusComposer());
    }
    if (persist) {
      void window.drawioAgent?.rpc("settings", "set", { sidebarOpen: isOpen }).catch(() => {});
    }
  };

  if (ui.actions?.addAction) {
    ui.actions.addAction("toggleDrawioAgent", () => setOpen(!isOpen), null, null, "Cmd+Alt+L");
  }
  const extrasMenu = ui.menus?.get?.("extras");
  if (extrasMenu && typeof extrasMenu.funct === "function") {
    const origExtras = extrasMenu.funct;
    extrasMenu.funct = function (menu: any, parent: any) {
      origExtras.apply(this, arguments);
      menu.addSeparator(parent);
      menu.addItem("Agent 侧栏 (⌘⌥L)", null, () => setOpen(!isOpen), parent);
    };
  }

  const toolbarHost = (ui.toolbar?.container || ui.menubarContainer) as HTMLElement | undefined;
  if (toolbarHost) {
    toggleBtn = document.createElement("button");
    toggleBtn.id = "drawio-agent-toggle";
    toggleBtn.type = "button";
    toggleBtn.title = "Agent 侧栏 (⌘⌥L)";
    toggleBtn.setAttribute("aria-label", "Agent 侧栏");
    toggleBtn.style.cssText = [
      "display: inline-flex",
      "align-items: center",
      "gap: 4px",
      "height: 24px",
      "padding: 0 8px",
      "margin-left: 6px",
      "border-radius: 5px",
      "border: 1px solid rgba(128, 128, 128, 0.28)",
      "background: transparent",
      "color: inherit",
      "font-size: 12px",
      "font-weight: 500",
      "cursor: pointer",
      "vertical-align: middle",
    ].join(";");
    toggleBtn.innerHTML = `${AGENT_ICON_SVG}<span>Agent</span>`;
    toggleBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setOpen(!isOpen);
    });
    toolbarHost.appendChild(toggleBtn);
    updateToggleVisual();
  }

  // 9. Global shortcuts: Cmd+Option+L toggle & Cmd+Ctrl+1..4 prompt slots
  window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (isToggleShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(!isOpen);
        return;
      }
      const slot = slotShortcutNumber(e);
      if (slot !== null) {
        e.preventDefault();
        e.stopPropagation();
        if (!isOpen) setOpen(true);
        void ensurePanel().then((h) => h.runPrompt(slot));
      }
    },
    true
  );

  // 10. Restore persisted sidebar width & openAtStart / sidebarOpen
  void window.drawioAgent
    ?.rpc<SavedPanelPrefs>("settings", "get")
    .then((saved) => {
      if (saved && typeof saved.sidebarWidth === "number") {
        width = clampWidth(saved.sidebarWidth);
      }
      if (saved?.openAtStart || saved?.sidebarOpen) {
        setOpen(true, false);
      } else {
        syncEditorLayout();
      }
    })
    .catch(() => {
      syncEditorLayout();
    });

  console.log("[drawio-agent] Sidebar plugin loaded");
}

if (typeof window !== "undefined" && window.Draw?.loadPlugin) {
  window.Draw.loadPlugin((ui: any) => {
    mountAgentSidebar(ui);
  });
} else {
  console.warn("[drawio-agent] Draw.loadPlugin not available");
}
