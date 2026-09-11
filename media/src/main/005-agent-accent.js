// Part: 005-agent-accent
// Pure accent-decision helper for roster/agent nameplates: an agent running
// on an LLM foreign to the current harness is accented light blue
// (--accent-info); a fallback agent is accented amber (--accent, the same
// token .theme-review-retry-warning uses) and its rendered name gets the
// suffix " (fb)"; fallback wins over foreign. Kept dependency-free and pure
// so it can be unit-tested directly (see test/agentAccent.test.ts) without
// booting the full media/main.js webview runtime.

/**
 * @typedef {"claude-code" | "codex" | "opencode" | string} Harness
 * @typedef {"fallback" | "foreign" | "native"} AgentAccentKind
 */

/**
 * Map of harness id -> its native LLM vendor id. `undefined`/unlisted
 * harnesses (e.g. "opencode", which has no single native vendor) fall
 * through to "every non-empty vendor is foreign" below.
 * @type {Record<string, string>}
 */
var AGENT_ACCENT_NATIVE_VENDOR_BY_HARNESS = {
  "claude-code": "anthropic",
  "codex": "openai",
};

/**
 * Decide the accent kind for a roster/agent-metrics entry.
 *
 * - `fallbackOf` non-empty string  -> "fallback" (wins over foreign)
 * - `vendor` missing/unknown       -> "native" (never guess)
 * - harness has a known native vendor and `vendor` matches it -> "native"
 * - harness has a known native vendor and `vendor` differs    -> "foreign"
 * - harness has no known native vendor (e.g. "opencode")      -> "foreign"
 *   for any non-empty `vendor`
 *
 * @param {{ vendor?: string | null, costModelClass?: string | null, fallbackOf?: string | null, harness?: Harness | null }} agent
 * @returns {AgentAccentKind}
 */
function agentAccent(agent) {
  var a = agent || {};
  if (typeof a.fallbackOf === "string" && a.fallbackOf.trim() !== "") {
    return "fallback";
  }
  var vendor = typeof a.vendor === "string" ? a.vendor.trim() : "";
  if (vendor === "") {
    return "native";
  }
  var harness = typeof a.harness === "string" ? a.harness : "";
  var nativeVendor = Object.prototype.hasOwnProperty.call(AGENT_ACCENT_NATIVE_VENDOR_BY_HARNESS, harness)
    ? AGENT_ACCENT_NATIVE_VENDOR_BY_HARNESS[harness]
    : undefined;
  if (nativeVendor === undefined) {
    // Unknown/no-native-vendor harness (e.g. "opencode"): any reported
    // vendor is foreign.
    return "foreign";
  }
  return vendor === nativeVendor ? "native" : "foreign";
}

// Node-testable export (no-op in the browser: `module` is undefined there,
// so this block never runs inside the concatenated media/main.js webview
// bundle). Lets test/agentAccent.test.ts `require()` this part file
// directly without booting the full jsdom webview runtime.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { agentAccent: agentAccent, AGENT_ACCENT_NATIVE_VENDOR_BY_HARNESS: AGENT_ACCENT_NATIVE_VENDOR_BY_HARNESS };
}
