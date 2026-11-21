// Shared renderer types for drawio-agent Phase 1

export interface AgentUiSettings {
  sidebarOpen: boolean;
  sidebarWidth: number;
  mutationPolicy: "auto" | "confirm-destructive" | "confirm-all";
}

export interface SnapshotResult {
  mime: "image/png";
  base64: string;
  dataUrl: string;
  filePath: string;
  width: number;
  height: number;
  bytes: number;
}

export interface CellSummary {
  id: string;
  kind: "vertex" | "edge";
  label: string;
  parent: string;
  geometry?: { x: number; y: number; w: number; h: number };
  style?: string;
  source?: string;
  target?: string;
}

export interface CanvasContext {
  file: {
    title: string;
    path?: string;
    modified: boolean;
  };
  page: {
    id: string;
    name: string;
    index: number;
    totalPages: number;
    stats: { vertexCount: number; edgeCount: number };
  };
  selection: {
    count: number;
    cells: CellSummary[];
  };
  summary: {
    truncated: boolean;
    totalCells: number;
    cells: CellSummary[];
  };
}

export interface CellUpdateInput {
  id: string;
  label?: string;
  stylePatch?: Record<string, string | number | null>;
  styleReplace?: string;
  geometry?: { x?: number; y?: number; w?: number; h?: number };
}

export interface InsertXmlInput {
  xml: string;
  position?: { x: number; y: number };
  replaceCurrentPage?: boolean;
}

export interface InsertMermaidInput {
  code: string;
  position?: { x: number; y: number };
  replaceCurrentPage?: boolean;
}

export interface MutationResult {
  ok: boolean;
  summary: string;
  affectedIds: string[];
  repairs?: string[];
  canUndo: boolean;
}

export interface DrawioAgentBridgeApi {
  rpc: <T = unknown>(target: string, method: string, ...args: unknown[]) => Promise<T>;
  on: (channel: string, listener: (data: unknown) => void) => () => void;
}

declare global {
  interface Window {
    drawioAgent?: DrawioAgentBridgeApi;
    Draw?: {
      loadPlugin: (fn: (ui: any) => void) => void;
    };
    Editor?: {
      isDarkMode: () => boolean;
      addListener?: (name: string, fn: () => void) => void;
    };
    mxEvent?: any;
    mxUtils?: any;
    mxConstants?: any;
    mxGeometry?: any;
  }
}
