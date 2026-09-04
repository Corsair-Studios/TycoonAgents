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
