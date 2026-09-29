/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Latest concrete model id per alias family. Claude Code resolves the bare
// aliases (opus/sonnet/haiku/fable) to the newest model on its own, so
// Claude-side defaults never pin a version. Hosts that need a concrete
// provider/model id (OpenCode's models.dev catalog has no "latest" alias and
// rejects `anthropic/sonnet`) resolve through this map instead — the SINGLE
// place a concrete default id lives. The update-pricing skill / release
// checklist refreshes this map whenever a newer model ships. Ids come from
// the Claude docs models overview.
// ---------------------------------------------------------------------------
export const LATEST_MODEL_IDS: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5-1",
};

// ---------------------------------------------------------------------------
// Shared alias table for the `model:` frontmatter shorthand (opus/sonnet/
// haiku/fable). This is the SAME table hooks/tycoon-claude-hook.cjs keeps as
// SHORTHAND_MODEL (lines ~105-110) — it is intentionally not required from
// there today because the hook is a standalone zero-dep .cjs that must run
// even when out/ has not been built. This module is the canonical source for
// any TypeScript code (agentBackend.ts included); a future task may make the
// hook `require("../out/src/core/modelAliases.js")` instead of keeping its
// own copy, at which point this comment and SHORTHAND_MODEL's should both be
// updated to point at each other.
// ---------------------------------------------------------------------------
export const MODEL_ALIASES: Record<string, string> = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
  fable: LATEST_MODEL_IDS.fable,
};

/**
 * Maps an alias ("sonnet") or its vendor-qualified form ("anthropic/sonnet")
 * to the newest concrete Anthropic model id ("claude-sonnet-5-5"). Returns
 * undefined for anything that is not a known alias (a concrete id, another
 * vendor's model, empty input) so callers keep it untouched.
 */
export function resolveLatestModelId(rawModel: string | undefined): string | undefined {
  if (!rawModel) return undefined;
  const key = rawModel.toLowerCase().replace(/^anthropic\//, "");
  return Object.prototype.hasOwnProperty.call(LATEST_MODEL_IDS, key) ? LATEST_MODEL_IDS[key] : undefined;
}

export function resolveModelAlias(rawModel: string | undefined): string | undefined {
  if (!rawModel) return undefined;
  const key = rawModel.toLowerCase();
  return Object.prototype.hasOwnProperty.call(MODEL_ALIASES, key) ? MODEL_ALIASES[key] : rawModel;
}
