/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Plan p15-t2: fallbackOf/fallbackDepth tagging on HookRecord/NormalizedEvent
// and fallbackOf/fallbackDepth/fallbackCount aggregation on AgentMetric.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapHookRecord } from "../src/providers/claude-code/mapHookRecord";
import { computeStateFromRecords } from "../src/core/state";
import type { HookRecord } from "../src/providers/claude-code/hookRecord";

test("mapHookRecord: fallback re-dispatch Task record carries fallbackOf/fallbackDepth onto WorkerSpawned", () => {
  const record: HookRecord = {
    event: "PreToolUse",
    tool: "Task",
    workerId: "codex-reviewer",
    model: "gemini-2.5-pro",
    vendor: "google",
    costModelClass: "metered",
    fallbackOf: "codex-reviewer",
    fallbackDepth: 1,
    at: 1000,
  };
  const events = mapHookRecord(record);
  assert.equal(events.length, 1);
  const spawned = events[0] as { type: string; fallbackOf?: string; fallbackDepth?: number; model?: string };
  assert.equal(spawned.type, "WorkerSpawned");
  assert.equal(spawned.fallbackOf, "codex-reviewer");
  assert.equal(spawned.fallbackDepth, 1);
  assert.equal(spawned.model, "gemini-2.5-pro");
});

test("mapHookRecord: non-fallback Task record carries no fallbackOf key at all", () => {
  const record: HookRecord = {
    event: "PreToolUse",
    tool: "Task",
    workerId: "coding-specialist",
    model: "claude-sonnet-4-6",
    at: 1000,
  };
  const events = mapHookRecord(record);
  assert.equal(events.length, 1);
  assert.ok(!("fallbackOf" in events[0]));
  assert.ok(!("fallbackDepth" in events[0]));
});

test("computeStateFromRecords: one fallback dispatch yields fallbackCount 1 and fallback model", () => {
  const records: HookRecord[] = [
    {
      event: "PreToolUse",
      tool: "Task",
      workerId: "codex-reviewer",
      model: "gemini-2.5-pro",
      vendor: "google",
      costModelClass: "metered",
      fallbackOf: "codex-reviewer",
      fallbackDepth: 1,
      sessionId: "s1",
      at: 1000,
    },
    {
      event: "SubagentStop",
      workerId: "codex-reviewer",
      tokens: 500,
      sessionId: "s1",
      at: 2000,
    },
  ];
  const state = computeStateFromRecords(records);
  const metric = state.agentMetrics.find((m) => m.id === "codex-reviewer");
  assert.ok(metric);
  assert.equal(metric!.fallbackCount, 1);
  assert.equal(metric!.fallbackOf, "codex-reviewer");
  assert.equal(metric!.fallbackDepth, 1);
  assert.equal(metric!.model, "gemini-2.5-pro");
  assert.equal(metric!.vendor, "google");
});

test("computeStateFromRecords: no fallback dispatch yields fallbackCount 0 and unaffected metrics", () => {
  const records: HookRecord[] = [
    {
      event: "PreToolUse",
      tool: "Task",
      workerId: "coding-specialist",
      model: "claude-sonnet-4-6",
      sessionId: "s2",
      at: 1000,
    },
    {
      event: "SubagentStop",
      workerId: "coding-specialist",
      tokens: 300,
      sessionId: "s2",
      at: 2000,
    },
  ];
  const state = computeStateFromRecords(records);
  const metric = state.agentMetrics.find((m) => m.id === "coding-specialist");
  assert.ok(metric);
  assert.equal(metric!.fallbackCount, 0);
  assert.equal(metric!.fallbackOf, undefined);
  assert.equal(metric!.fallbackDepth, undefined);
  assert.equal(metric!.model, "claude-sonnet-4-6");
  assert.equal(metric!.tokens, 300);
});

// The fallback marker reflects the most recent run only; fallbackCount and
// lastFallbackModel keep the history.
function fbRecords(): HookRecord[] {
  return [
    // Run 1: dispatcher path. Wrapper spawn (no fallbackOf) arrives first,
    // then the dispatcher's own fallback spawn/stop with a fresh spawnId.
    { event: "PreToolUse", tool: "Task", workerId: "codex-reviewer", model: "gpt-5", vendor: "openai", spawnId: "w1", sessionId: "s", at: 1000 },
    { event: "PreToolUse", tool: "Task", workerId: "codex-reviewer", model: "gemini-2.5-pro", vendor: "google", fallbackOf: "codex-reviewer", fallbackDepth: 1, fallbackIsDefault: true, spawnId: "d1", sessionId: "s", at: 1100 },
    { event: "SubagentStop", workerId: "codex-reviewer", fallbackOf: "codex-reviewer", fallbackDepth: 1, spawnId: "d1", sessionId: "s", at: 1200 },
    { event: "SubagentStop", workerId: "codex-reviewer", spawnId: "w1", sessionId: "s", at: 1300 },
  ] as HookRecord[];
}

test("fallback marker: dispatcher-path fallback run shows fallbackOf during and after the run", () => {
  const recs = fbRecords();
  const during = computeStateFromRecords(recs.slice(0, 2)).agentMetrics.find((m) => m.id === "codex-reviewer")!;
  assert.equal(during.fallbackOf, "codex-reviewer");
  assert.equal(during.fallbackIsDefault, true);
  const after = computeStateFromRecords(recs).agentMetrics.find((m) => m.id === "codex-reviewer")!;
  assert.equal(after.fallbackOf, "codex-reviewer");
  assert.equal(after.fallbackDepth, 1);
  assert.equal(after.fallbackIsDefault, true);
  assert.equal(after.fallbackCount, 1);
  assert.equal(after.lastFallbackModel, "gemini-2.5-pro");
});

test("fallback marker: the next normal run clears it but keeps fallbackCount and lastFallbackModel", () => {
  const recs: HookRecord[] = [
    ...fbRecords(),
    { event: "PreToolUse", tool: "Task", workerId: "codex-reviewer", model: "gpt-5", vendor: "openai", spawnId: "w2", sessionId: "s", at: 2000 },
  ] as HookRecord[];
  const m = computeStateFromRecords(recs).agentMetrics.find((x) => x.id === "codex-reviewer")!;
  assert.equal(m.fallbackOf, undefined);
  assert.equal(m.fallbackDepth, undefined);
  assert.equal(m.fallbackIsDefault, undefined);
  assert.equal(m.fallbackCount, 1);
  assert.equal(m.lastFallbackModel, "gemini-2.5-pro");
  assert.equal(m.model, "gpt-5");
});

test("fallback marker: a duplicate non-fallback start for a spawnId already live does not clear the run's fallback", () => {
  const recs: HookRecord[] = [
    { event: "PreToolUse", tool: "Task", workerId: "codex-reviewer", model: "gemini-2.5-pro", fallbackOf: "codex-reviewer", fallbackDepth: 1, spawnId: "d1", sessionId: "s", at: 1000 },
    { event: "PreToolUse", tool: "Task", workerId: "codex-reviewer", spawnId: "d1", sessionId: "s", at: 1050 },
  ] as HookRecord[];
  const m = computeStateFromRecords(recs).agentMetrics.find((x) => x.id === "codex-reviewer")!;
  assert.equal(m.fallbackOf, "codex-reviewer");
});

test("fallback marker: two fallback runs then a normal run counts 2, replay is deterministic", () => {
  const recs: HookRecord[] = [
    ...fbRecords(),
    { event: "PreToolUse", tool: "Task", workerId: "codex-reviewer", model: "claude-haiku", fallbackOf: "codex-reviewer", fallbackDepth: 2, spawnId: "d2", sessionId: "s", at: 3000 },
    { event: "SubagentStop", workerId: "codex-reviewer", spawnId: "d2", sessionId: "s", at: 3100 },
    { event: "PreToolUse", tool: "Task", workerId: "codex-reviewer", model: "gpt-5", spawnId: "w3", sessionId: "s", at: 4000 },
  ] as HookRecord[];
  const a = computeStateFromRecords(recs);
  const b = computeStateFromRecords(JSON.parse(JSON.stringify(recs)));
  assert.deepEqual(a.agentMetrics, b.agentMetrics);
  const m = a.agentMetrics.find((x) => x.id === "codex-reviewer")!;
  assert.equal(m.fallbackOf, undefined);
  assert.equal(m.fallbackCount, 2);
  assert.equal(m.lastFallbackModel, "claude-haiku");
});
