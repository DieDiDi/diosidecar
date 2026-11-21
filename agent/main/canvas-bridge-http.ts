// Localhost HTTP bridge (127.0.0.1 random port + Bearer token) connecting Stdio Canvas MCP
// to the live draw.io renderer window via Electron IPC, with Option C approval hook.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface ToolDispatchRequest {
  windowId: number;
  tool: string;
  args: Record<string, unknown>;
}

export interface CanvasBridgeHttp {
  readonly port: number;
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB for large XML diagrams

export async function startCanvasBridgeHttp(
  onToolCall: (req: ToolDispatchRequest) => Promise<unknown>
): Promise<CanvasBridgeHttp> {
  const token = randomBytes(24).toString("hex");

  const server: Server = createServer((req, res) => {
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };

    if (req.method !== "POST" || req.url !== "/tool") {
      sendJson(404, { error: "Not found" });
      return;
    }

    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      sendJson(401, { error: "Unauthorized" });
      return;
    }

    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", async () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(raw) as Partial<ToolDispatchRequest>;
        if (!parsed.tool || typeof parsed.tool !== "string") {
          sendJson(400, { error: "Missing tool name" });
          return;
        }
        const windowId = typeof parsed.windowId === "number" ? parsed.windowId : Number(parsed.windowId ?? 0);
        const result = await onToolCall({
          windowId,
          tool: parsed.tool,
          args: (parsed.args && typeof parsed.args === "object" ? parsed.args : {}) as Record<string, unknown>,
        });
        sendJson(200, { ok: true, result });
      } catch (err) {
        sendJson(500, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  if (!port) throw new Error("Failed to bind CanvasBridgeHttp port");

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
