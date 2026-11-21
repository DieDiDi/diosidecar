// SPDX-License-Identifier: Apache-2.0
// Adapted for DioSidecar from drawio-mcp/mcp-tool-server/src/index.js. See THIRD_PARTY_NOTICES.md.
// Bundles into a single self-contained file (agent/dist/mcp-server.mjs) with .md docs inlined via esbuild.
import { readFileSync, existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { repairDiagramXml } from "../shared/repair-xml.js";
import { expandDiagramShorthand } from "../shared/diagram-shorthand.js";
import { normalizeDiagram } from "../shared/normalize-model.js";
import { buildTagMap, searchShapes } from "../shared/shape-search.js";
import { layoutXml } from "./elk-pass.js";

// Inlined at build time by esbuild loader { ".md": "text" } (zero __dirname ENOENT)
import chatViewXmlRef from "../skills/chat-view-xml.md";
import xmlReferenceDoc from "../skills/xml-reference.md";
import mermaidReferenceDoc from "../skills/mermaid-reference.md";
import styleReferenceDoc from "../skills/style-reference.md";

const BRIDGE_URL = process.env.DRAWIO_BRIDGE_URL || "";
const BRIDGE_TOKEN = process.env.DRAWIO_BRIDGE_TOKEN || "";
const WINDOW_ID = Number(process.env.DRAWIO_WINDOW_ID || "0");
const SHAPE_INDEX_PATH = process.env.DRAWIO_SHAPE_INDEX_PATH || "";

let shapeIndexCache = null;
let shapeTagMapCache = null;

function ensureShapeIndex() {
  if (shapeIndexCache && shapeTagMapCache) {
    return { index: shapeIndexCache, tagMap: shapeTagMapCache };
  }
  if (!SHAPE_INDEX_PATH || !existsSync(SHAPE_INDEX_PATH)) {
    throw new Error(`Shape index not found at DRAWIO_SHAPE_INDEX_PATH=${SHAPE_INDEX_PATH}`);
  }
  const raw = readFileSync(SHAPE_INDEX_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Invalid shape index JSON");
  }
  shapeIndexCache = parsed;
  shapeTagMapCache = buildTagMap(parsed);
  return { index: shapeIndexCache, tagMap: shapeTagMapCache };
}

async function callBridge(tool, args) {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    throw new Error("draw.io bridge env (DRAWIO_BRIDGE_URL / DRAWIO_BRIDGE_TOKEN) not configured");
  }
  const resp = await fetch(`${BRIDGE_URL}/tool`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
    },
    body: JSON.stringify({ windowId: WINDOW_ID, tool, args }),
  });
  const data = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
  if (!resp.ok || !data.ok) {
    throw new Error(data.error || `Bridge error (${resp.status})`);
  }
  return data.result;
}

const TOOLS = [
  {
    name: "get_diagram_summary",
    description:
      "Read the active draw.io page's file info, current selection, and a compact summary of up to 50 cells (id, kind, label, parent, source/target).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_cells_detail",
    description:
      "Read full details (raw label/HTML, style string, exact geometry x/y/w/h, parent, endpoints) for specific cell IDs on the active draw.io page.",
    inputSchema: {
      type: "object",
      properties: {
        cellIds: {
          type: "array",
          items: { type: "string" },
          description: "Array of mxCell IDs to inspect.",
        },
      },
      required: ["cellIds"],
    },
  },
  {
    name: "search_shapes",
    description:
      "Search draw.io's offline shape library (AWS, Azure, GCP, Kubernetes, Cisco, UML, flowchart icons) to get exact style strings and recommended dimensions. Always call this instead of inventing mxgraph.* style names.",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          description: 'Search terms, e.g. ["aws4 lambda", "database", "k8s pod"].',
        },
        limit: {
          type: "number",
          description: "Max results per query (default 5, max 15).",
        },
      },
      required: ["queries"],
    },
  },
  {
    name: "get_drawio_reference",
    description:
      "Fetch official draw.io authoring guidelines on demand: 'design' (layout/aesthetics for 13 diagram types + role shorthand), 'xml' (full mxGraphModel reference), 'mermaid' (supported Mermaid types), or 'styles' (color palettes & edge styles).",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: ["design", "xml", "mermaid", "styles"],
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "inspect_canvas_image",
    description:
      "Capture a live PNG snapshot of the current draw.io canvas viewport for visual self-check (checking overlapping labels, crossing edges, or visual balance). Call at most once after creating a complex diagram or when asked to improve visual aesthetics.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "update_cells",
    description:
      "Update existing cells in-place on the live draw.io canvas (label, style keys, geometry) in one atomic Cmd+Z undo step. Prefer this over rewriting the diagram for targeted edits.",
    inputSchema: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              stylePatch: {
                type: "object",
                additionalProperties: { type: ["string", "number", "null"] },
                description: 'Style key-value overrides, e.g. {"fillColor": "#d5e8d4", "strokeColor": "#82b366"}.',
              },
              styleReplace: { type: "string" },
              geometry: {
                type: "object",
                properties: {
                  x: { type: "number" },
                  y: { type: "number" },
                  w: { type: "number" },
                  h: { type: "number" },
                },
              },
            },
            required: ["id"],
          },
        },
      },
      required: ["updates"],
    },
  },
  {
    name: "insert_xml",
    description:
      "Insert draw.io <mxGraphModel> XML onto the live canvas (or replace the current page while preserving Cmd+Z undo). Automatically runs repair-xml, role shorthand expansion (role=step|decision|start|end|error|data|external|container), container/edge normalization, and optional offline ELK auto-layout.",
    inputSchema: {
      type: "object",
      properties: {
        xml: {
          type: "string",
          description: "Valid <mxGraphModel> XML string (no XML comments).",
        },
        position: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
          description: "Optional top-left insertion offset. Omit to place neatly beside selection or existing diagram.",
        },
        layout: {
          type: "string",
          enum: ["none", "vertical", "horizontal"],
          description: "Optional offline ELK auto-layout before inserting into canvas.",
        },
        replaceCurrentPage: {
          type: "boolean",
          description: "If true, replaces all cells on the active page inside a single undoable transaction.",
        },
      },
      required: ["xml"],
    },
  },
  {
    name: "insert_mermaid",
    description:
      "Convert Mermaid diagram code directly into native editable draw.io vector shapes on the live canvas in a single Cmd+Z undo step. Best for flowcharts, sequence, state, class, ER, gantt, mindmap.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Mermaid diagram code." },
        position: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
        },
        replaceCurrentPage: { type: "boolean" },
      },
      required: ["code"],
    },
  },
  {
    name: "delete_cells",
    description: "Delete specific cells (and optionally their connected edges) in a single Cmd+Z undo step.",
    inputSchema: {
      type: "object",
      properties: {
        cellIds: { type: "array", items: { type: "string" } },
        includeEdges: { type: "boolean", description: "Default true." },
      },
      required: ["cellIds"],
    },
  },
  {
    name: "select_and_focus",
    description: "Select and scroll specific cells into view on the live canvas so the user sees them immediately.",
    inputSchema: {
      type: "object",
      properties: {
        cellIds: { type: "array", items: { type: "string" } },
      },
      required: ["cellIds"],
    },
  },
];

const server = new Server(
  { name: "drawio-canvas", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments && typeof req.params.arguments === "object"
    ? req.params.arguments
    : {});

  try {
    if (name === "get_drawio_reference") {
      const topic = String(args.topic || "design");
      const map = {
        design: chatViewXmlRef,
        xml: xmlReferenceDoc,
        mermaid: mermaidReferenceDoc,
        styles: styleReferenceDoc,
      };
      const text = map[topic] || chatViewXmlRef;
      return { content: [{ type: "text", text }] };
    }

    if (name === "search_shapes") {
      const queries = Array.isArray(args.queries) ? args.queries.map(String) : [];
      const limit = Math.min(15, Math.max(1, Number(args.limit || 5)));
      const { index, tagMap } = ensureShapeIndex();
      const blocks = queries.map((q) => {
        const hits = searchShapes(index, tagMap, q, limit);
        if (!hits.length) return `Query "${q}": no matches`;
        const lines = hits.map((h) => `- ${h.title} (${h.w}x${h.h}): ${h.style}`);
        return `Query "${q}":\n${lines.join("\n")}`;
      });
      return { content: [{ type: "text", text: blocks.join("\n\n") }] };
    }

    if (name === "insert_xml") {
      const rawXml = String(args.xml || "");
      const repaired = repairDiagramXml(rawXml);
      const expanded = expandDiagramShorthand(repaired.xml);
      const normalized = normalizeDiagram(expanded.xml);
      let finalXml = normalized.xml;

      const layout = String(args.layout || "none");
      let layoutNote = "";
      if (layout === "vertical" || layout === "horizontal") {
        try {
          finalXml = await layoutXml(finalXml, { direction: layout });
        } catch (err) {
          layoutNote = ` (ELK layout skipped: ${err instanceof Error ? err.message : String(err)})`;
        }
      }

      const result = await callBridge("insert_xml", {
        xml: finalXml,
        position: args.position,
        replaceCurrentPage: Boolean(args.replaceCurrentPage),
        repairs: repaired.repairs,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ ...result, layoutNote: layoutNote || undefined }) }],
      };
    }

    if (name === "inspect_canvas_image") {
      const snap = await callBridge("inspect_canvas_image", {});
      return {
        content: [
          {
            type: "image",
            data: snap.base64,
            mimeType: "image/png",
          },
          {
            type: "text",
            text: `Captured live canvas snapshot (${snap.width}x${snap.height} PNG, saved at ${snap.filePath}). Inspect for overlapping text, clipped labels, or crossing edges.`,
          },
        ],
      };
    }

    // All remaining live canvas tools forward directly to Electron Main -> Renderer
    const result = await callBridge(name, args);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error in ${name}: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
