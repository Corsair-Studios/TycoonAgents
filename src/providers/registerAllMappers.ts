/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Single place that guarantees every provider's record->NormalizedEvent[]
// mapper is registered into src/core/mappingRegistry, regardless of which
// provider id a host actually runs with. Records from more than one
// provider can coexist in one activity.jsonl (e.g. a project that has both
// the Claude Code hook and the OpenCode plugin installed), so a host must
// understand every provider's record shape even though it only tails one
// selected Provider — the `--provider`/setting choice governs which
// Provider object drains the file, not which mappers are known.
//
// Importing either src/providers/claude-code/index.ts or
// src/providers/opencode/index.ts already registers that provider's mapper
// as a module-load side effect; this module just imports both together so
// callers (src/host/vscode/providerFactory.ts, standalone/'s sharedLogic.mjs)
// have one call that guarantees the full set instead of duplicating the
// provider import list in more than one place.

import "./claude-code";
import "./opencode";
import "./codex";

/** No-op function; importing this module is what registers the mappers.
 * Call it anyway (rather than only relying on the bare import) so a bundler
 * or `require()` call site that might tree-shake an unused import still
 * keeps this module's side effects. */
export function registerAllMappers(): void {
  // Intentionally empty — see module header. Both provider modules register
  // their mappers at import time above.
}
