/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for the Codex offload activity record (p6-t2),
// hooks/tycoon-claude-hook.cjs ~968-975 (the CODEX_TOOL_PREFIX branch of
// the non-spawn PreToolUse handler). Same technique as
// test/tycoonClaudeHookSpawn.test.ts: hooks/tycoon-claude-hook.cjs is a
// standalone CJS script with no module.exports, invoked fresh as a child
// process for every real hook event — it is not require()-able without
// side effects, so this drives the real script the way Claude Code does:
// spawn it, pipe a JSON payload on stdin, inspect the activity.jsonl it
// writes under a scratch CLAUDE_PROJECT_DIR.
//
// THE HONEST-METRICS PROPERTY: a Codex record must carry a real model
// string and must NEVER fabricate a tokens/cacheReadTokens count. Per the
// hook's own doc comment, the codex/codex-reply MCP tools' response never
// carries a usage object, so `tokens` is deliberately left UNSET (absent
// from the JSON entirely) rather than defaulted to 0 — 0 is the tempting
// wrong answer because it reads as "real, zero-token call" instead of
// "unknown, never measured." Every assertion here checks for the FIELD'S
// ABSENCE (`"tokens" in record` is false), not merely a falsy/zero value,
// so a future regression that starts writing `tokens: 0` is caught.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK_PATH = join(process.cwd(), "hooks", "tycoon-claude-hook.cjs");

interface ActivityRecord {
  event: string;
  tool?: string;
  workerId?: string;
  model?: string;
  tokens?: number;
  cacheReadTokens?: number;
  at?: string;
  [key: string]: unknown;
}

function runHook(projectRoot: string, payload: Record<string, unknown>): void {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
  });
  assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);
}

function readActivity(projectRoot: string): ActivityRecord[] {
  const activityPath = join(projectRoot, ".claude", "tycoon", "activity.jsonl");
  const raw = readFileSync(activityPath, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ActivityRecord);
}

// activity.jsonl lines are raw text, not parsed objects, so a field left
// "unset" by the hook (never assigned onto `record`) is genuinely absent
// from the serialized JSON — this checks the raw line text, not just the
// parsed object, to rule out JSON.parse silently reintroducing a key.
function rawLineForTool(projectRoot: string, toolName: string): string {
  const activityPath = join(projectRoot, ".claude", "tycoon", "activity.jsonl");
  const raw = readFileSync(activityPath, "utf8");
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .find((l) => JSON.parse(l).tool === toolName);
  assert.ok(line, `expected an activity line for tool ${toolName}`);
  return line!;
}

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), "tycoon-hook-codex-test-"));
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  return root;
}

test("Codex tool call: model falls back to gpt-5.4-mini when tool_input carries no model, and tokens/cacheReadTokens are absent (not 0)", () => {
  const root = setupProject();
  try {
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__codex__codex",
      tool_input: { prompt: "do a thing" },
      session_id: "test-session-codex-1",
    });

    const records = readActivity(root);
    const rec = records.find((r) => r.event === "PreToolUse" && r.tool === "mcp__codex__codex");
    assert.ok(rec, "expected an activity record for the mcp__codex__codex call");
    assert.equal(rec!.model, "gpt-5.4-mini", "model must fall back to the catalog.json launch-time default");

    assert.equal("tokens" in rec!, false, "tokens must be entirely ABSENT from the record, not present-and-0");
    assert.equal("cacheReadTokens" in rec!, false, "cacheReadTokens must be entirely ABSENT, not present-and-0");
    assert.notEqual(rec!.tokens, 0, "tokens must never be fabricated as 0 — 0 reads as a real measured zero-token call");

    const rawLine = rawLineForTool(root, "mcp__codex__codex");
    assert.equal(rawLine.includes('"tokens"'), false, "raw serialized JSON must not contain a tokens key at all");
    assert.equal(rawLine.includes('"cacheReadTokens"'), false, "raw serialized JSON must not contain a cacheReadTokens key at all");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex tool call: an explicit tool_input.model overrides the launch-time default, tokens still absent", () => {
  const root = setupProject();
  try {
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__codex__codex-reply",
      tool_input: { model: "gpt-5.4-custom", threadId: "abc123" },
      session_id: "test-session-codex-2",
    });

    const records = readActivity(root);
    const rec = records.find((r) => r.event === "PreToolUse" && r.tool === "mcp__codex__codex-reply");
    assert.ok(rec, "expected an activity record for the mcp__codex__codex-reply call");
    assert.equal(rec!.model, "gpt-5.4-custom", "an explicit per-call model must override the catalog.json default");
    assert.equal("tokens" in rec!, false);
    assert.equal("cacheReadTokens" in rec!, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex tool call: a non-string tool_input.model (e.g. a number) is ignored, falling back to the default rather than writing a bad value", () => {
  const root = setupProject();
  try {
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__codex__codex",
      tool_input: { model: 12345 },
      session_id: "test-session-codex-3",
    });

    const records = readActivity(root);
    const rec = records.find((r) => r.event === "PreToolUse" && r.tool === "mcp__codex__codex");
    assert.ok(rec);
    assert.equal(rec!.model, "gpt-5.4-mini", "a non-string model value must not be written through — default applies");
    assert.equal("tokens" in rec!, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Non-Codex mcp__ tool call is unaffected: no model field is fabricated for a tool outside the mcp__codex__ prefix", () => {
  const root = setupProject();
  try {
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__some-other-server__do-thing",
      tool_input: { model: "should-not-be-copied" },
      session_id: "test-session-codex-4",
    });

    const records = readActivity(root);
    const rec = records.find((r) => r.event === "PreToolUse" && r.tool === "mcp__some-other-server__do-thing");
    assert.ok(rec, "expected an activity record for the non-Codex mcp__ call");
    assert.equal("model" in rec!, false, "the CODEX_TOOL_PREFIX branch must not fire for a non-codex mcp__ tool");
    assert.equal("tokens" in rec!, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
