// Live draw.io canvas context collector (selection, active page, file metadata, flat cell summary)
import type { CanvasContext, CellSummary } from "./types.ts";

const MAX_SUMMARY_CELLS = 50;

function plainLabel(graph: any, cell: any): string {
  try {
    const raw = String(graph.convertValueToString(cell) ?? "");
    // Strip simple HTML tags while preserving line breaks for readability
    const stripped = raw
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, " ")
      .trim();
    return stripped;
  } catch {
    return "";
  }
}

function serializeCell(graph: any, cell: any, includeDetails: boolean): CellSummary {
  const model = graph.getModel();
  const isEdge = Boolean(model.isEdge(cell));
  const parent = model.getParent(cell);
  const out: CellSummary = {
    id: String(cell.id ?? ""),
    kind: isEdge ? "edge" : "vertex",
    label: plainLabel(graph, cell),
    parent: String(parent?.id ?? "1"),
  };

  if (isEdge) {
    const src = model.getTerminal(cell, true);
    const tgt = model.getTerminal(cell, false);
    if (src?.id != null) out.source = String(src.id);
    if (tgt?.id != null) out.target = String(tgt.id);
  }

  if (includeDetails) {
    const geo = model.getGeometry(cell);
    if (geo && !isEdge) {
      out.geometry = {
        x: Math.round(geo.x ?? 0),
        y: Math.round(geo.y ?? 0),
        w: Math.round(geo.width ?? 0),
        h: Math.round(geo.height ?? 0),
      };
    }
    const style = model.getStyle(cell);
    if (typeof style === "string" && style.length > 0) {
      out.style = style;
    }
  }

  return out;
}

export function createContextCollector(ui: any) {
  const listeners = new Set<() => void>();
  let debounceTimer: number | null = null;

  const notify = () => {
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      for (const cb of [...listeners]) {
        try {
          cb();
        } catch {
          // ignore UI listener errors
        }
      }
    }, 40);
  };

  const graph = ui.editor.graph;
  const selModel = graph.getSelectionModel();
  const model = graph.getModel();
  const mxEvent = window.mxEvent;

  if (mxEvent) {
    selModel.addListener(mxEvent.CHANGE, notify);
    model.addListener(mxEvent.CHANGE, notify);
    ui.editor.addListener("pageSelected", notify);
    ui.addListener?.("fileDescriptorChanged", notify);
    ui.addListener?.("pageSelected", notify);
  }

  function getContext(): CanvasContext {
    const file = ui.getCurrentFile?.();
    const pages: any[] = Array.isArray(ui.pages) ? ui.pages : [];
    const currentPage = ui.currentPage;
    const pageIndex = currentPage ? Math.max(0, pages.indexOf(currentPage)) : 0;

    const allCellsObj = model.cells ?? {};
    const allCells: any[] = Object.values(allCellsObj).filter((c: any) => {
      if (!c) return false;
      const id = String(c.id ?? "");
      if (id === "0" || id === "1") return false;
      return model.isVertex(c) || model.isEdge(c);
    });

    let vertexCount = 0;
    let edgeCount = 0;
    for (const c of allCells) {
      if (model.isEdge(c)) edgeCount++;
      else vertexCount++;
    }

    const selected = (graph.getSelectionCells() ?? []).filter(Boolean);
    const selectedSummaries = selected.map((c: any) => serializeCell(graph, c, true));

    const summaryCells = allCells
      .slice(0, MAX_SUMMARY_CELLS)
      .map((c: any) => serializeCell(graph, c, false));

    const title =
      (typeof file?.getTitle === "function" ? file.getTitle() : undefined) ||
      document.title?.replace(/\s*-\s*draw\.io$/i, "") ||
      "Untitled Diagram";

    const filePath =
      typeof file?.fileObject?.path === "string"
        ? file.fileObject.path
        : typeof file?.path === "string"
          ? file.path
          : undefined;

    return {
      file: {
        title: String(title),
        ...(filePath ? { path: filePath } : {}),
        modified: Boolean(typeof file?.isModified === "function" ? file.isModified() : ui.editor.modified),
      },
      page: {
        id: String(currentPage?.getId?.() ?? "page-0"),
        name: String(currentPage?.getName?.() ?? "Page-1"),
        index: pageIndex,
        totalPages: Math.max(1, pages.length),
        stats: { vertexCount, edgeCount },
      },
      selection: {
        count: selectedSummaries.length,
        cells: selectedSummaries,
      },
      summary: {
        truncated: allCells.length > MAX_SUMMARY_CELLS,
        totalCells: allCells.length,
        cells: summaryCells,
      },
    };
  }

  return {
    getContext,
    onChange(cb: () => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose(): void {
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      if (mxEvent) {
        selModel.removeListener(notify);
        model.removeListener(notify);
        ui.editor.removeListener(notify);
        ui.removeListener?.(notify);
      }
      listeners.clear();
    },
  };
}
