/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Regression test: standalone/'s cli.mjs (via sharedLogic.mjs) dropped
// provider:"opencode" records when only the claude-code mapper was
// registered. src/providers/registerAllMappers.ts is the single place both
// the VS Code host (providerFactory.ts, panel.ts) and the standalone bridge
// register every provider's mapper together, since one activity.jsonl can
// carry records from more than one provider regardless of which provider a
// host is actually configured to run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hasMapper, mapRecord } from "../src/core/mappingRegistry";
import "../src/providers/registerAllMappers";

test("registerAllMappers: registers both the claude-code and opencode mappers", () => {
  assert.equal(hasMapper("claude-code"), true);
  assert.equal(hasMapper("opencode"), true);
});

test("registerAllMappers: maps a provider:opencode record without throwing", () => {
  const events = mapRecord({
    event: "UserPromptSubmit",
    provider: "opencode",
    sessionId: "sess-oc-1",
    at: 1234,
    prompt: "hi",
  });
  assert.ok(Array.isArray(events));
});
