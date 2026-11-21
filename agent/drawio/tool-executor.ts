// Renderer-side executor for live canvas tool calls forwarded from Electron Main (CanvasBridgeHttp).
import type { CanvasContext } from "./types.ts";

export interface ToolExecutorDeps {
  ui: any;
  context: {
    getContext: () => CanvasContext;
  };
  mutator: {
    updateCells: (updates: any[]) => any;
    insertXml: (input: any) => any;
    insertMermaid: (input: any) => Promise<any>;
    deleteCells: (cellIds: string[], includeEdges?: boolean) => any;
    selectAndFocus: (cellIds?: string[]) => any;
  };
  onMutation?: (summary: string) => void;
}

export function attachCanvasToolExecutor({ ui, context, mutator, onMutation }: ToolExecutorDeps): () => void {
  if (!window.drawioAgent) return () => {};

  const graph = ui.editor.graph;
  const model = graph.getModel();

  function getCellsDetail(cellIds: string[]) {
    return cellIds.map((rawId) => {
      const id = String(rawId);
      const cell = model.getCell(id);
      if (!cell) return { id, found: false };
      const isEdge = Boolean(model.isEdge(cell));
      const geo = model.getGeometry(cell);
      const parent = model.getParent(cell);
      const src = isEdge ? model.getTerminal(cell, true) : null;
      const tgt = isEdge ? model.getTerminal(cell, false) : null;
      return {
        id,
        found: true,
        kind: isEdge ? "edge" : "vertex",
        value: typeof cell.value === "string" ? cell.value : String(graph.convertValueToString(cell) ?? ""),
        style: String(model.getStyle(cell) ?? ""),
        parent: String(parent?.id ?? "1"),
        ...(geo && !isEdge
          ? {
              geometry: {
                x: Math.round(geo.x ?? 0),
                y: Math.round(geo.y ?? 0),
                w: Math.round(geo.width ?? 0),
                h: Math.round(geo.height ?? 0),
              },
            }
          : {}),
        ...(src?.id != null ? { source: String(src.id) } : {}),
        ...(tgt?.id != null ? { target: String(tgt.id) } : {}),
      };
    });
  }

  return window.drawioAgent.on("agent:tool:execute", async (raw) => {
    const req = (raw ?? {}) as { callId?: string; tool?: string; args?: Record<string, unknown> };
    if (!req.callId || !req.tool) return;

    try {
      const args = req.args ?? {};
      let result: unknown;

      switch (req.tool) {
        case "get_diagram_rect": {
          const el = ui.diagramContainer as HTMLElement | undefined;
          const r = el?.getBoundingClientRect();
          result = r ? { x: r.left, y: r.top, width: r.width, height: r.height } : {};
          break;
        }
        case "get_diagram_summary": {
          result = context.getContext();
          break;
        }
        case "get_cells_detail": {
          const ids = Array.isArray(args.cellIds) ? args.cellIds.map(String) : [];
          result = getCellsDetail(ids);
          break;
        }
        case "update_cells": {
          const res = mutator.updateCells(Array.isArray(args.updates) ? args.updates : []);
          if (res?.ok) onMutation?.(res.summary);
          result = res;
          break;
        }
        case "insert_xml": {
          const res = mutator.insertXml({
            xml: String(args.xml ?? ""),
            position: args.position as { x: number; y: number } | undefined,
            replaceCurrentPage: Boolean(args.replaceCurrentPage),
          });
          if (res?.ok) onMutation?.(res.summary);
          result = res;
          break;
        }
        case "insert_mermaid": {
          const res = await mutator.insertMermaid({
            code: String(args.code ?? ""),
            position: args.position as { x: number; y: number } | undefined,
            replaceCurrentPage: Boolean(args.replaceCurrentPage),
          });
          if (res?.ok) onMutation?.(res.summary);
          result = res;
          break;
        }
        case "delete_cells": {
          const ids = Array.isArray(args.cellIds) ? args.cellIds.map(String) : [];
          const res = mutator.deleteCells(ids, args.includeEdges !== false);
          if (res?.ok) onMutation?.(res.summary);
          result = res;
          break;
        }
        case "select_and_focus": {
          const ids = Array.isArray(args.cellIds) ? args.cellIds.map(String) : [];
          result = mutator.selectAndFocus(ids);
          break;
        }
        default:
          throw new Error(`Unsupported renderer tool: ${req.tool}`);
      }

      await window.drawioAgent!.rpc("tool", "reply", { callId: req.callId, ok: true, result });
    } catch (err) {
      await window.drawioAgent!.rpc("tool", "reply", {
        callId: req.callId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
