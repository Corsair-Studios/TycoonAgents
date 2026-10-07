/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Main-session StopFailure -> classified activity record -> OrchestratorLimit
 * event -> state.orchestratorLimit (cleared by the next orchestrator activity).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEvent, initialWorldState, isOrchestratorLimitActive } from "../src/core/state";
import { mapHookRecord } from "../src/providers/claude-code/mapHookRecord";
import type { HookRecord } from "../src/providers/claude-code/hookRecord";

const HOOK_PATH = join(process.cwd(), "hooks", "tycoon-claude-hook.cjs");

function run(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), "tycoon-orchlimit-"));
  mkdirSync(join(root, ".claude", "tycoon"), { recursive: true });
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  const cfg = mkdtempSync(join(tmpdir(), "tycoon-orchlimit-cfg-"));
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ session_id: "s-orch", hook_event_name: "StopFailure", ...payload }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_CONFIG_DIR: cfg, TYCOON_MANAGED_SETTINGS_DIR: join(cfg, "no-managed") },
  });
  assert.equal(r.status, 0, r.stderr);
  const f = join(root, ".claude", "tycoon", "activity.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function stopRec(payload: Record<string, unknown>): Record<string, unknown> {
  const rec = run(payload).find((r) => r.event === "StopFailure");
  assert.ok(rec, "StopFailure record written");
  return rec;
}

test("usage limit with reset text -> quota + resetHint + resetAt", () => {
  const rec = stopRec({ error: "rate_limit", last_assistant_message: "You've hit your 5-hour limit · resets 3pm" });
  assert.equal(rec.workerId, "orchestrator");
  assert.equal(rec.reason, "quota");
  assert.match(String(rec.resetHint), /resets 3pm/);
  assert.equal(typeof rec.resetAt, "number");
  assert.ok((rec.resetAt as number) > (rec.at as number));
});

test("weekly limit wording without 'you've hit' still classifies as quota", () => {
  assert.equal(stopRec({ error: "unknown", last_assistant_message: "Weekly limit reached, resets Mon 12am" }).reason, "quota");
  assert.equal(stopRec({ error: "unknown", last_assistant_message: "Your 5-hour limit is exhausted" }).reason, "quota");
});

test("plain rate limit and overloaded keep their kinds", () => {
  assert.equal(stopRec({ error: "rate_limit", last_assistant_message: "Too many requests" }).reason, "rate_limit");
  assert.equal(stopRec({ error: "overloaded", last_assistant_message: "" }).reason, "overloaded");
});

test("unknown error is still recorded with kind unknown and no reset fields", () => {
  const rec = stopRec({ error: "weird_new_thing", last_assistant_message: "" });
  assert.equal(rec.reason, "unknown");
  assert.equal(rec.resetHint, undefined);
  assert.equal(rec.resetAt, undefined);
});

test("subagent StopFailure record carries no limit fields and maps without OrchestratorLimit", () => {
  const rec = stopRec({ agent_id: "a1", agent_type: "coding-specialist", error: "rate_limit", last_assistant_message: "You've hit your weekly limit · resets 12am" });
  assert.equal(rec.workerId, "coding-specialist");
  assert.equal(rec.resetAt, undefined);
  const events = mapHookRecord(rec as unknown as HookRecord);
  assert.ok(!events.some((e) => e.type === "OrchestratorLimit"));
});

test("mapHookRecord: orchestrator StopFailure with reason -> ProviderError + OrchestratorLimit", () => {
  const events = mapHookRecord({ event: "StopFailure", workerId: "orchestrator", reason: "quota", resetHint: "resets 3pm", resetAt: 99, message: "m", at: 5 });
  assert.deepEqual(events.map((e) => e.type), ["ProviderError", "OrchestratorLimit"]);
  const lim = events[1];
  assert.ok(lim.type === "OrchestratorLimit");
  assert.equal(lim.kind, "quota");
  assert.equal(lim.resetAt, 99);
});

test("state: OrchestratorLimit sets orchestratorLimit; orchestrator activity or new prompt clears it", () => {
  let s = applyEvent(initialWorldState(), { type: "OrchestratorLimit", at: 10, kind: "quota", resetHint: "resets 3pm", message: "m" });
  assert.deepEqual(s.orchestratorLimit, { kind: "quota", at: 10, resetHint: "resets 3pm", message: "m" });
  // Another worker's activity does not clear it.
  const other = applyEvent(s, { type: "WorkerActivity", at: 11, workerId: "coding-specialist", kind: "build", detail: "Edit" });
  assert.ok(other.orchestratorLimit);
  // Orchestrator tool use clears it.
  const afterTool = applyEvent(s, { type: "WorkerActivity", at: 12, workerId: "orchestrator", kind: "survey", detail: "Read" });
  assert.equal(afterTool.orchestratorLimit, undefined);
  // So does the next user prompt.
  s = applyEvent(s, { type: "SessionStart", at: 13 });
  assert.equal(s.orchestratorLimit, undefined);
  // Same-timestamp replay of older activity does not clear a newer limit.
  const s2 = applyEvent(initialWorldState(), { type: "OrchestratorLimit", at: 50, kind: "quota" });
  assert.ok(applyEvent(s2, { type: "SessionStart", at: 40 }).orchestratorLimit);
});

test("classifier: weekly/5-hour limit needs a hit verb; unrelated prose is not quota", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const br = require(join(process.cwd(), "hooks", "bridge-result.cjs")) as { classifyProviderError(m: string): string };
  assert.notEqual(br.classifyProviderError("the weekly limit logic is wrong"), "quota");
  assert.equal(br.classifyProviderError("weekly limit reached"), "quota");
  assert.equal(br.classifyProviderError("you exhausted the 5-hour limit"), "quota");
});

test("parseResetAt: timezone names/offsets give no resetAt; zone-less clock and Z ISO do", () => {
  const rec = (m: string) => stopRec({ error: "rate_limit", last_assistant_message: m });
  assert.equal(rec("You've hit your weekly limit · resets 3pm (Europe/Paris)").resetAt, undefined);
  assert.equal(rec("You've hit your weekly limit · resets 3pm PST").resetAt, undefined);
  assert.equal(typeof rec("You've hit your weekly limit · resets 3pm").resetAt, "number");
  const hint = String(rec("You've hit your weekly limit · resets 3pm. Upgrade to continue").resetHint);
  assert.ok(hint.length <= 80 && !hint.includes("Upgrade"));
});

test("state: stale orchestratorLimit expires (resetAt passed, or 6h without resetAt)", () => {
  const withReset = applyEvent(initialWorldState(), { type: "OrchestratorLimit", at: 1000, kind: "quota", resetAt: 5000 });
  assert.ok(isOrchestratorLimitActive(withReset.orchestratorLimit, 4999));
  assert.ok(!isOrchestratorLimitActive(withReset.orchestratorLimit, 5000));
  assert.equal(applyEvent(withReset, { type: "WorkerActivity", at: 6000, workerId: "x", kind: "build", detail: "Edit" }).orchestratorLimit, undefined);
  const noReset = applyEvent(initialWorldState(), { type: "OrchestratorLimit", at: 1000, kind: "unknown" });
  assert.ok(applyEvent(noReset, { type: "SessionStop", at: 1000 + 3600_000 }).orchestratorLimit);
  assert.equal(applyEvent(noReset, { type: "SessionStop", at: 1000 + 6 * 3600_000 + 1 }).orchestratorLimit, undefined);
});
