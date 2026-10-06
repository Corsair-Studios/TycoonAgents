/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_SUBSCRIPTION_NOTE,
  OPENCODE_ANTHROPIC_API_KEY_ENV,
  claudeSubscriptionState,
  readClaudeSubscriptionOptIn,
  usesClaudeSubscriptionRoute,
  writeClaudeSubscriptionOptIn,
} from "../src/core/claudeSubscriptionBridge";
import { buildRoutingView, setClaudeSubscriptionOptIn } from "../src/core/routingHostOps";

function withDataDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sub-optin-"));
  const prev = process.env.TYCOON_STANDALONE_DATA_DIR;
  process.env.TYCOON_STANDALONE_DATA_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TYCOON_STANDALONE_DATA_DIR;
    else process.env.TYCOON_STANDALONE_DATA_DIR = prev;
  }
}

const bridged = { vendor: "anthropic", transport: "mcp", mcpServer: "claude-cli", costModelClass: "subscription" };
const apiKeySlot = { vendor: "anthropic", transport: "claude-native", costModelClass: "metered" };

test("default: opt-in flag is off and the API-key env name is ANTHROPIC_API_KEY", () => {
  withDataDir(() => {
    assert.equal(readClaudeSubscriptionOptIn(), false);
  });
  assert.equal(OPENCODE_ANTHROPIC_API_KEY_ENV, "ANTHROPIC_API_KEY");
});

test("usesClaudeSubscriptionRoute: claude-cli bridge and anthropic mcp+subscription only", () => {
  assert.equal(usesClaudeSubscriptionRoute(bridged), true);
  assert.equal(usesClaudeSubscriptionRoute({ vendor: "anthropic", transport: "mcp", costModelClass: "subscription" }), true);
  assert.equal(usesClaudeSubscriptionRoute(apiKeySlot), false);
  assert.equal(usesClaudeSubscriptionRoute({ vendor: "openai", transport: "mcp", mcpServer: "codex", costModelClass: "subscription" }), false);
  assert.equal(usesClaudeSubscriptionRoute(undefined), false);
});

test("opencode + default (opt-in off): new subscription route is not allowed, no note on API-key slots", () => {
  assert.deepEqual(claudeSubscriptionState({ harness: "opencode", slot: apiKeySlot, optIn: false }), { showNote: false, allowed: false });
});

test("opencode + opt-in on: route allowed, note shown once the slot uses it", () => {
  assert.deepEqual(claudeSubscriptionState({ harness: "opencode", slot: bridged, optIn: true }), { showNote: true, allowed: true });
  assert.deepEqual(claudeSubscriptionState({ harness: "opencode", slot: apiKeySlot, optIn: true }), { showNote: false, allowed: true });
});

test("opencode + existing subscription config (opt-in off): keeps working and shows the note", () => {
  assert.deepEqual(claudeSubscriptionState({ harness: "opencode", slot: bridged, optIn: false }), { showNote: true, allowed: true });
});

test("claude-code and codex hosts are unaffected", () => {
  for (const harness of ["claude-code", "codex"]) {
    assert.deepEqual(claudeSubscriptionState({ harness, slot: bridged, optIn: false }), { showNote: false, allowed: true });
  }
});

test("opt-in flag round-trips through the per-user app-data dir, outside any project", () => {
  withDataDir((dir) => {
    writeClaudeSubscriptionOptIn(true);
    assert.equal(readClaudeSubscriptionOptIn(), true);
    assert.ok(fs.readdirSync(dir).includes("opencode-claude-subscription-optin"));
    writeClaudeSubscriptionOptIn(false);
    assert.equal(readClaudeSubscriptionOptIn(), false);
    writeClaudeSubscriptionOptIn(false);
  });
});

test("routing view carries claudeSubscriptionOptIn (default false) and reflects setClaudeSubscriptionOptIn", () => {
  withDataDir(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sub-root-"));
    assert.equal(buildRoutingView({ root, env: {} }).claudeSubscriptionOptIn, false);
    assert.equal(setClaudeSubscriptionOptIn(true), true);
    assert.equal(buildRoutingView({ root, env: {} }).claudeSubscriptionOptIn, true);
    assert.equal(setClaudeSubscriptionOptIn(false), false);
  });
});

test("webview copy of the note matches the core constant", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "media", "src", "main", "100-slot-editor-settings.js"), "utf8");
  assert.ok(src.includes(CLAUDE_SUBSCRIPTION_NOTE), "100-slot-editor-settings.js must carry the exact note text");
});
