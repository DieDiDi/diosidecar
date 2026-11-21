// SPDX-License-Identifier: AGPL-3.0-or-later
// Sourced from plugin/src/agent/index.ts in 54yyyu/zotero-mcp. See THIRD_PARTY_NOTICES.md.
// What src/zotero needs from the agent layer.
export { CATALOG_CLEANUP, createRuntime } from "./runtime.ts";
export type { RuntimeOpts } from "./runtime.ts";
export { buildBrief, CONTEXT_TAG, CALLOUT_GUIDE, DRAWING_GUIDE, FORMAT_GUIDE, TOOL_SHEET } from "./brief.ts";
export { prepareWorkspace } from "./workspace.ts";
export { BACKENDS, isNative, resumeCommand } from "./backends.ts";
export { findBinary } from "./env.ts";
export { TRANSLATOR_PROMPT, pickLowEffort, pickTranslateModel, translationRequest, translatorPrompt } from "./translate.ts";
