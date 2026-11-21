// Lightweight mxGraph canvas mutator reusing drawio-mcp's repair-xml, diagram-shorthand & normalize-model.
// Every mutation runs inside a single synchronous beginUpdate()/endUpdate() transaction for native 1-step Cmd+Z Undo.
import { repairDiagramXml } from "../shared/repair-xml.js";
import { expandDiagramShorthand } from "../shared/diagram-shorthand.js";
import { normalizeDiagram } from "../shared/normalize-model.js";
import type {
  CellUpdateInput,
  InsertMermaidInput,
  InsertXmlInput,
  MutationResult,
} from "./types.ts";

export function createCanvasMutator(ui: any) {
  const graph = ui.editor.graph;
  const model = graph.getModel();
  const undoManager = ui.editor.undoManager;

  // Track the exact Undo stack index of our last mutation so the card Undo button never undoes later manual edits.
  let lastMutationUndoIndex: number | null = null;
  let lastAffectedIds: string[] = [];

  function recordUndoMarker(affectedIds: string[]): boolean {
    lastAffectedIds = affectedIds;
    const idx = typeof undoManager?.indexOfNextAdd === "number" ? undoManager.indexOfNextAdd : null;
    lastMutationUndoIndex = idx;
    return canUndoLast();
  }

  function canUndoLast(): boolean {
    if (lastMutationUndoIndex === null || !undoManager) return false;
    return (
      typeof undoManager.canUndo === "function" &&
      undoManager.canUndo() &&
      undoManager.indexOfNextAdd === lastMutationUndoIndex
    );
  }

  function undoLast(): { ok: boolean; reason?: string } {
    if (!canUndoLast()) {
      return { ok: false, reason: "已有后续手动编辑或无可撤销记录，请使用原生 ⌘Z" };
    }
    undoManager.undo();
    lastMutationUndoIndex = null;
    return { ok: true };
  }

  /** Computes a simple, predictable insertion offset (no complex collision solver). */
  function resolveInsertOffset(position?: { x: number; y: number }): { dx: number; dy: number } {
    if (position && typeof position.x === "number" && typeof position.y === "number") {
      return { dx: Math.round(position.x), dy: Math.round(position.y) };
    }
    const sel = graph.getSelectionCells?.() ?? [];
    if (sel.length > 0) {
      const bounds = graph.getBoundingBoxFromGeometry(sel, true);
      if (bounds) {
        return { dx: Math.round(bounds.x + bounds.width + 60), dy: Math.round(bounds.y) };
      }
    }
    const pageBounds = graph.getGraphBounds?.();
    const scale = graph.view?.scale || 1;
    const tr = graph.view?.translate || { x: 0, y: 0 };
    if (pageBounds && pageBounds.width > 0) {
      const rightX = pageBounds.x / scale - tr.x + pageBounds.width / scale;
      const topY = pageBounds.y / scale - tr.y;
      return { dx: Math.round(rightX + 80), dy: Math.round(Math.max(40, topY)) };
    }
    return { dx: 40, dy: 40 };
  }

  /** Extracts the <mxGraphModel> Element from an mxGraphModel or mxfile XML string. */
  function parseGraphModelElement(xml: string): Element {
    const doc = window.mxUtils.parseXml(xml);
    const root = doc?.documentElement;
    if (!root || root.nodeName === "parsererror") {
      throw new Error("Invalid draw.io XML");
    }
    if (root.nodeName === "mxGraphModel") return root;
    const nested = root.getElementsByTagName("mxGraphModel")?.[0];
    if (nested) return nested;
    throw new Error(`Expected <mxGraphModel>, got <${root.nodeName}>`);
  }

  /** Official drawio-mcp preprocessing pipeline: repair -> shorthand -> normalize. */
  function preprocessXml(rawXml: string): { xml: string; repairs: string[] } {
    const repaired = repairDiagramXml(rawXml);
    const expanded = expandDiagramShorthand(repaired.xml);
    const normalized = normalizeDiagram(expanded.xml);
    return {
      xml: normalized.xml,
      repairs: repaired.repairs ?? [],
    };
  }

  /**
   * Commits an <mxGraphModel> XML element synchronously in a SINGLE beginUpdate/endUpdate transaction.
   * For replaceCurrentPage=true, removes existing children and imports into the live model instead of calling
   * ui.editor.setGraphXml(), so the native Cmd+Z undo history is 100% preserved.
   */
  function commitModelXml(
    xml: string,
    opts: { position?: { x: number; y: number }; replaceCurrentPage?: boolean; repairs?: string[] }
  ): MutationResult {
    const modelEl = parseGraphModelElement(xml);
    const offset = opts.replaceCurrentPage ? { dx: 0, dy: 0 } : resolveInsertOffset(opts.position);

    let inserted: any[] = [];
    model.beginUpdate();
    try {
      if (opts.replaceCurrentPage) {
        const parent = graph.getDefaultParent();
        const existing = graph.getChildCells(parent, true, true) ?? [];
        if (existing.length > 0) {
          graph.removeCells(existing, true);
        }
      }
      inserted = graph.importGraphModel(modelEl, offset.dx, offset.dy, false) ?? [];
    } finally {
      model.endUpdate();
    }

    const ids = inserted.map((c: any) => String(c.id ?? "")).filter(Boolean);
    if (inserted.length > 0) {
      graph.setSelectionCells(inserted);
      graph.scrollCellToVisible(inserted[0], true);
    }

    const canUndo = recordUndoMarker(ids);
    return {
      ok: true,
      summary: opts.replaceCurrentPage
        ? `已整页替换为 ${ids.length} 个图形元素（可按 ⌘Z 一步恢复旧图）`
        : `已插入 ${ids.length} 个图形元素`,
      affectedIds: ids,
      ...(opts.repairs?.length ? { repairs: opts.repairs } : {}),
      canUndo,
    };
  }

  function updateCells(updates: CellUpdateInput[]): MutationResult {
    if (!Array.isArray(updates) || updates.length === 0) {
      return { ok: false, summary: "没有指定需要修改的图元", affectedIds: [], canUndo: canUndoLast() };
    }

    const touched: any[] = [];
    model.beginUpdate();
    try {
      for (const u of updates) {
        const cell = model.getCell(String(u.id));
        if (!cell) continue;
        touched.push(cell);

        if (typeof u.label === "string") {
          graph.cellLabelChanged(cell, u.label, false);
        }

        if (typeof u.styleReplace === "string") {
          model.setStyle(cell, u.styleReplace);
        } else if (u.stylePatch && typeof u.stylePatch === "object") {
          for (const [key, val] of Object.entries(u.stylePatch)) {
            graph.setCellStyles(key, val === null ? null : String(val), [cell]);
          }
        }

        if (u.geometry && typeof u.geometry === "object") {
          const prev = model.getGeometry(cell);
          if (prev) {
            const next = prev.clone();
            if (typeof u.geometry.x === "number") next.x = u.geometry.x;
            if (typeof u.geometry.y === "number") next.y = u.geometry.y;
            if (typeof u.geometry.w === "number") next.width = u.geometry.w;
            if (typeof u.geometry.h === "number") next.height = u.geometry.h;
            model.setGeometry(cell, next);
          }
        }
      }
    } finally {
      model.endUpdate();
    }

    if (touched.length === 0) {
      return { ok: false, summary: "未找到匹配 ID 的图元", affectedIds: [], canUndo: canUndoLast() };
    }

    const ids = touched.map((c) => String(c.id));
    graph.setSelectionCells(touched);
    const canUndo = recordUndoMarker(ids);
    return {
      ok: true,
      summary: `已更新 ${ids.length} 个图元`,
      affectedIds: ids,
      canUndo,
    };
  }

  function insertXml(input: InsertXmlInput): MutationResult {
    const { xml, repairs } = preprocessXml(input.xml);
    return commitModelXml(xml, {
      position: input.position,
      replaceCurrentPage: input.replaceCurrentPage,
      repairs,
    });
  }

  function insertMermaid(input: InsertMermaidInput): Promise<MutationResult> {
    return new Promise((resolve, reject) => {
      if (typeof ui.parseMermaidDiagram !== "function") {
        reject(new Error("ui.parseMermaidDiagram is not available in this draw.io build"));
        return;
      }
      ui.parseMermaidDiagram(
        input.code,
        null,
        (xml: string) => {
          try {
            const res = commitModelXml(xml, {
              position: input.position,
              replaceCurrentPage: input.replaceCurrentPage,
            });
            resolve(res);
          } catch (err) {
            reject(err);
          }
        },
        (err: unknown) => {
          reject(err instanceof Error ? err : new Error(String(err || "Mermaid parse failed")));
        }
      );
    });
  }

  function deleteCells(cellIds: string[], includeEdges = true): MutationResult {
    const cells = cellIds.map((id) => model.getCell(String(id))).filter(Boolean);
    if (cells.length === 0) {
      return { ok: false, summary: "未找到可删除的图元", affectedIds: [], canUndo: canUndoLast() };
    }

    const ids = cells.map((c) => String(c.id));
    model.beginUpdate();
    try {
      graph.removeCells(cells, includeEdges);
    } finally {
      model.endUpdate();
    }

    const canUndo = recordUndoMarker(ids);
    return {
      ok: true,
      summary: `已删除 ${ids.length} 个图元`,
      affectedIds: ids,
      canUndo,
    };
  }

  function selectAndFocus(cellIds?: string[]): { ok: boolean; count: number } {
    const ids = cellIds && cellIds.length > 0 ? cellIds : lastAffectedIds;
    const cells = ids.map((id) => model.getCell(String(id))).filter(Boolean);
    if (cells.length === 0) return { ok: false, count: 0 };
    graph.setSelectionCells(cells);
    graph.scrollCellToVisible(cells[0], true);
    return { ok: true, count: cells.length };
  }

  return {
    updateCells,
    insertXml,
    insertMermaid,
    deleteCells,
    selectAndFocus,
    canUndoLast,
    undoLast,
  };
}
