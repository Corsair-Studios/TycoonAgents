/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

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
  fable: "claude-fable-5",
};

export function resolveModelAlias(rawModel: string | undefined): string | undefined {
  if (!rawModel) return undefined;
  const key = rawModel.toLowerCase();
  return Object.prototype.hasOwnProperty.call(MODEL_ALIASES, key) ? MODEL_ALIASES[key] : rawModel;
}
