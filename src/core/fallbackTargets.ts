/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Plan p25-t4: pure per-harness dispatchability check for a routing.json
// fallback target (a `RoutingSlot` used as a chain entry or as the
// top-level `defaultFallback`). Zero dependencies — safe to compile to
// out/src/core/fallbackTargets.js and require() from the standalone build,
// same posture as routingProfile.ts.
//
// Mirrors the vendor table in hooks/dispatcherAdapters.cjs's
// adapterKeyForVendor()/googleAdapter() (read-only reference, not imported —
// that file is a runtime dispatcher, not host/webview-safe):
//   codex:        anthropic, openai-compatible/local/moonshot -> dispatchable
//                 google -> dispatchable only when GEMINI_API_KEY is set
//                 openai -> dispatchable (native to codex)
//                 anything else -> not dispatchable
//   claude-code:  any slot with a route is dispatchable (no cross-vendor
//                 dispatcher gate the way codex has one)
//   opencode:     provider availability lives in opencode.json, generated
//                 dynamically per vendor (scripts/generate-opencode-config.mjs)
//                 and not knowable from routing.json alone -> always
//                 dispatchable, `ok: true` with a soft `reason` note.
//
// The webview (media/src/main/095-fallback-dispatchability.js) duplicates
// this table rather than importing it — media/main.js is a plain-JS
// concatenation build (scripts/build-webview.mjs) with no module loader, so
// a compiled out/src/core/*.js cannot be required() into the browser. Keep
// the two tables in sync by hand; test/fallbackTargets.test.ts and
// test/webviewSmoke.test.ts both assert the same cases.
// ---------------------------------------------------------------------------

import type { RoutingSlot } from "./routingProfile";

export type HarnessId = "claude-code" | "codex" | "opencode" | string;

export interface FallbackTargetCheck {
  ok: boolean;
  /** Present when ok is false (a hard block) or when ok is true but the
   *  result carries a soft caveat worth surfacing (e.g. opencode's
   *  "not knowable offline" note). */
  reason?: string;
}

/** Minimal env shape so callers can pass process.env or a plain object; never mutated. */
export type EnvLike = Record<string, string | undefined>;

const CODEX_ANTHROPIC_LIKE = new Set(["anthropic"]);
const CODEX_OPENAI_COMPATIBLE_LIKE = new Set(["openai-compatible", "local", "moonshot"]);

/**
 * Decide whether `slot` (a fallback-chain entry, or the top-level
 * `defaultFallback`) can actually be dispatched under `harness`. Pure and
 * side-effect free except for reading `env` (or `process.env` when `env` is
 * omitted) to check GEMINI_API_KEY for codex's google case — never reads
 * disk, never reads the local env value store (callers that need that
 * fallback should resolve GEMINI_API_KEY themselves and pass it in `env`).
 *
 * A slot with no `vendor` is treated as ok — an empty vendor means "use
 * whatever the merged default supplies", which this helper cannot evaluate
 * in isolation, so it never blocks on it.
 */
export function isFallbackTargetDispatchable(
  slot: RoutingSlot | null | undefined,
  harness: HarnessId,
  env?: EnvLike
): FallbackTargetCheck {
  const vendor = typeof slot?.vendor === "string" ? slot.vendor.trim().toLowerCase() : "";
  if (vendor === "") return { ok: true };

  if (harness === "codex") {
    if (CODEX_ANTHROPIC_LIKE.has(vendor) || CODEX_OPENAI_COMPATIBLE_LIKE.has(vendor) || vendor === "openai") {
      return { ok: true };
    }
    if (vendor === "google") {
      const source = env ?? (typeof process !== "undefined" ? process.env : {});
      const hasKey = typeof source["GEMINI_API_KEY"] === "string" && source["GEMINI_API_KEY"] !== "";
      return hasKey
        ? { ok: true }
        : { ok: false, reason: `vendor "google" needs GEMINI_API_KEY set to dispatch under Codex` };
    }
    return { ok: false, reason: `vendor "${vendor}" has no Codex dispatcher adapter` };
  }

  if (harness === "opencode") {
    // Provider availability lives in opencode.json and is generated
    // per-vendor at apply time — routing.json alone can't say whether it's
    // configured, so this never hard-blocks a save.
    return { ok: true, reason: `opencode provider availability for "${vendor}" is not knowable offline` };
  }

  // claude-code (and any other/unknown harness): any routed slot dispatches.
  return { ok: true };
}
