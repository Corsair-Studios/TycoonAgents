/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isFallbackTargetDispatchable } from "../src/core/fallbackTargets";

test("isFallbackTargetDispatchable: no vendor is always ok, any harness", () => {
  assert.equal(isFallbackTargetDispatchable({}, "codex").ok, true);
  assert.equal(isFallbackTargetDispatchable(undefined, "opencode").ok, true);
  assert.equal(isFallbackTargetDispatchable(null, "claude-code").ok, true);
});

test("isFallbackTargetDispatchable: claude-code accepts any routed vendor", () => {
  assert.equal(isFallbackTargetDispatchable({ vendor: "anthropic" }, "claude-code").ok, true);
  assert.equal(isFallbackTargetDispatchable({ vendor: "openai" }, "claude-code").ok, true);
  assert.equal(isFallbackTargetDispatchable({ vendor: "google" }, "claude-code").ok, true);
  assert.equal(isFallbackTargetDispatchable({ vendor: "some-unknown-vendor" }, "claude-code").ok, true);
});

test("isFallbackTargetDispatchable: codex accepts anthropic, openai-compatible/local/moonshot, and native openai", () => {
  assert.equal(isFallbackTargetDispatchable({ vendor: "anthropic" }, "codex").ok, true);
  assert.equal(isFallbackTargetDispatchable({ vendor: "openai-compatible" }, "codex").ok, true);
  assert.equal(isFallbackTargetDispatchable({ vendor: "local" }, "codex").ok, true);
  assert.equal(isFallbackTargetDispatchable({ vendor: "moonshot" }, "codex").ok, true);
  assert.equal(isFallbackTargetDispatchable({ vendor: "openai" }, "codex").ok, true);
});

test("isFallbackTargetDispatchable: codex + google is a non-blocking skip warning, with or without a key", () => {
  for (const env of [{}, { GEMINI_API_KEY: "k" }]) {
    const r = isFallbackTargetDispatchable({ vendor: "google" }, "codex", env);
    assert.equal(r.ok, true);
    assert.match(r.reason ?? "", /Google fallbacks are skipped on the Codex host/);
  }
});

test("isFallbackTargetDispatchable: codex rejects an unlisted vendor naming it in the reason", () => {
  const result = isFallbackTargetDispatchable({ vendor: "mystery-vendor" }, "codex");
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /mystery-vendor/);
});

test("isFallbackTargetDispatchable: opencode is always ok, with a soft not-knowable-offline reason", () => {
  const result = isFallbackTargetDispatchable({ vendor: "anthropic" }, "opencode");
  assert.equal(result.ok, true);
  assert.match(result.reason ?? "", /not knowable offline/);
});

test("isFallbackTargetDispatchable: vendor casing is normalized", () => {
  assert.equal(isFallbackTargetDispatchable({ vendor: "Google" }, "codex", { GEMINI_API_KEY: "x" }).ok, true);
  assert.match(isFallbackTargetDispatchable({ vendor: "Google" }, "codex").reason ?? "", /skipped/);
  assert.equal(isFallbackTargetDispatchable({ vendor: "ANTHROPIC" }, "codex").ok, true);
});

// Parity with hooks/dispatcherAdapters.cjs: every vendor the dispatcher can
// run on a real adapter must be accepted on Codex, and vice versa.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dispatcherAdaptersForParity = require("../../hooks/dispatcherAdapters.cjs");

test("Codex dispatchable vendors match hooks/dispatcherAdapters.cjs adapterKeyForVendor (google excluded)", () => {
  const candidates = [
    "anthropic", "openai", "openai-compatible", "local", "moonshot", "mistral", "xai", "google", "deepseek", "nonsense",
  ];
  for (const vendor of candidates) {
    if (vendor === "google") continue;
    const key = dispatcherAdaptersForParity.adapterKeyForVendor(vendor);
    const hasAdapter = key !== "unsupported";
    const check = isFallbackTargetDispatchable({ vendor } as never, "codex", {});
    assert.equal(check.ok, hasAdapter, `vendor "${vendor}": adapter key "${key}" vs TS ok=${check.ok}`);
  }
  // Google stays a non-blocking skip warning on Codex.
  const google = isFallbackTargetDispatchable({ vendor: "google" } as never, "codex", {});
  assert.equal(google.ok, true);
  assert.match(google.reason ?? "", /skipped/);
});
