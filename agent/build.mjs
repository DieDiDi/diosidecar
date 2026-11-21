// SPDX-License-Identifier: AGPL-3.0-or-later
// Sourced from plugin/scripts/build.mjs in 54yyyu/zotero-mcp. See THIRD_PARTY_NOTICES.md.
// Unified esbuild bundler for drawio-agent (adapted from zotero-mcp/plugin/scripts/build.mjs)
// Produces 3 self-contained single files and idempotently hooks drawio's PostConfig.js:
//   1. agent/dist/main.mjs          (Electron Main ESM)
//   2. agent/dist/mcp-server.mjs    (Stdio Canvas MCP ESM, .md docs inlined)
//   3. drawio/.../agent-sidebar.js  (draw.io Renderer plugin IIFE)
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentRoot = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(agentRoot, "..");
const dev = process.argv.includes("--dev");

const drawioWebapp = join(desktopRoot, "drawio", "src", "main", "webapp");
const postConfigPath = join(drawioWebapp, "js", "PostConfig.js");
const pluginOutPath = join(drawioWebapp, "plugins", "agent-sidebar.js");

if (!existsSync(postConfigPath)) {
  console.error(
    `[drawio-agent] Missing draw.io submodule at ${postConfigPath}.\n` +
      `Run "git submodule update --init --recursive" first.`
  );
  process.exit(1);
}

// Idempotently hook drawio/src/main/webapp/js/PostConfig.js so the upstream
// drawio submodule stays unmodified in Git history.
function ensurePostConfigHook() {
  const src = readFileSync(postConfigPath, "utf8");
  if (src.includes("plugins/agent-sidebar.js")) {
    return false;
  }
  const hook =
    "\n// DioSidecar sidebar hook, added by agent/build.mjs on 2026-11-21.\n" +
    "App.initPluginCallback();\n" +
    "mxscript('plugins/agent-sidebar.js');\n";
  const next = src.endsWith("\n") ? src + hook.slice(1) : src + hook;
  writeFileSync(postConfigPath, next, "utf8");
  return true;
}

const patched = ensurePostConfigHook();
mkdirSync(join(agentRoot, "dist"), { recursive: true });
mkdirSync(dirname(pluginOutPath), { recursive: true });

// 1. Electron Main process bundle (ESM, single file)
await build({
  entryPoints: [join(agentRoot, "main", "index.ts")],
  outfile: join(agentRoot, "dist", "main.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["electron", "electron-store", "electron-log"],
  sourcemap: dev ? "inline" : false,
  minify: false,
  charset: "utf8",
  loader: { ".md": "text" },
});

// 2. Stdio Canvas MCP Server bundle (ESM, single self-contained file)
await build({
  entryPoints: [join(agentRoot, "mcp", "server.mjs")],
  outfile: join(agentRoot, "dist", "mcp-server.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: false,
  minify: false,
  charset: "utf8",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  loader: { ".md": "text" },
});

// 3. draw.io Renderer plugin bundle (IIFE, single file loaded via PostConfig.js)
await build({
  entryPoints: [join(agentRoot, "drawio", "index.ts")],
  outfile: pluginOutPath,
  bundle: true,
  format: "iife",
  globalName: "DrawioAgentPlugin",
  platform: "browser",
  target: "chrome130",
  sourcemap: dev ? "inline" : false,
  minify: !dev,
  charset: "utf8",
  loader: { ".md": "text", ".css": "text" },
});

console.log(
  `[drawio-agent] built main.mjs, mcp-server.mjs, and plugins/agent-sidebar.js` +
    (patched ? " (patched drawio PostConfig.js)" : "")
);
