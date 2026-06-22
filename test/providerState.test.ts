/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapHookRecord } from "../src/providers/claude-code/mapHookRecord";
import type { HookRecord } from "../src/providers/claude-code/hookRecord";
import { applyEvent, initialWorldState } from "../src/core/state";
import type { WorldState } from "../src/core/state";

const T = 1700000000000;

function fold(records: HookRecord[]): WorldState {
  let state = initialWorldState();
  for (const record of records) {
    const event = mapHookRecord(record);
    if (event) {
      state = applyEvent(state, event);
    }
  }
  return state;
}

test("SessionStart sets sessionActive true", () => {
  const state = fold([{ event: "UserPromptSubmit", at: T }]);
  assert.equal(state.sessionActive, true);
});

test("SessionStop sets sessionActive false", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "Stop", at: T + 1000 },
  ]);
  assert.equal(state.sessionActive, false);
});

test("WorkerSpawned adds worker in 'arrive' state", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-1", at: T + 100 },
  ]);
  assert.ok(state.workers["w-1"] !== undefined, "worker w-1 should exist");
  assert.equal(state.workers["w-1"].state, "arrive");
  assert.equal(state.workers["w-1"].role, "Task");
});

test("WorkerActivity survey sets worker state to 'survey'", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-2", at: T + 100 },
    { event: "PreToolUse", tool: "Read", workerId: "w-2", at: T + 200 },
  ]);
  assert.equal(state.workers["w-2"].state, "survey");
});

test("WorkerActivity build sets worker state to 'build'", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-3", at: T + 100 },
    { event: "PreToolUse", tool: "Edit", workerId: "w-3", at: T + 200 },
  ]);
  assert.equal(state.workers["w-3"].state, "build");
});

test("WorkerActivity haul sets worker state to 'haul'", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-4", at: T + 100 },
    { event: "PreToolUse", tool: "Write", workerId: "w-4", at: T + 200 },
  ]);
  assert.equal(state.workers["w-4"].state, "haul");
});

test("WorkerStopped sets worker state to 'leave'", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-5", at: T + 100 },
    { event: "SubagentStop", workerId: "w-5", at: T + 300 },
  ]);
  assert.equal(state.workers["w-5"].state, "leave");
});

test("Multiple workers can coexist independently", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-a", at: T + 100 },
    { event: "PreToolUse", tool: "Task", workerId: "w-b", at: T + 110 },
    { event: "PreToolUse", tool: "Read", workerId: "w-a", at: T + 200 },
    { event: "PreToolUse", tool: "Edit", workerId: "w-b", at: T + 210 },
  ]);
  assert.equal(state.workers["w-a"].state, "survey");
  assert.equal(state.workers["w-b"].state, "build");
});

test("wire (mcp__) activity maps through ACTIVITY_TO_STATE to 'build'", () => {
  // wire -> "build" via ACTIVITY_TO_STATE in state.ts
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-6", at: T + 100 },
    { event: "PreToolUse", tool: "mcp__some__tool", workerId: "w-6", at: T + 200 },
  ]);
  // wire maps to "build" per ACTIVITY_TO_STATE in state.ts
  assert.equal(state.workers["w-6"].state, "build");
});

test("initialWorldState has no workers and sessionActive false", () => {
  const state = initialWorldState();
  assert.equal(state.sessionActive, false);
  assert.deepEqual(state.workers, {});
  assert.equal(state.completedTasks, 0);
});

test("WorkerActivity on unknown workerId leaves state unchanged", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    // no spawn, so worker doesn't exist
    { event: "PreToolUse", tool: "Read", workerId: "ghost", at: T + 200 },
  ]);
  assert.equal(state.workers["ghost"], undefined);
});

// ---------------------------------------------------------------------------
// AgentMetric tests
// ---------------------------------------------------------------------------

test("initialWorldState has empty agentMetrics", () => {
  const state = fold([]);
  assert.deepEqual(state.agentMetrics, []);
});

test("WorkerSpawned creates an active AgentMetric entry", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "search-retrieval", at: T + 100 },
  ]);
  const metric = state.agentMetrics.find((m) => m.id === "search-retrieval");
  assert.ok(metric, "metric should exist for search-retrieval");
  assert.equal(metric!.status, "active");
  assert.equal(metric!.taskCount, 0);
  assert.equal(metric!.mcpCount, 0);
  assert.equal(metric!.tokens, 0);
});

test("AgentMetric name is title-cased from workerId", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "coding-specialist", at: T + 100 },
  ]);
  const metric = state.agentMetrics.find((m) => m.id === "coding-specialist");
  assert.ok(metric);
  assert.equal(metric!.name, "Coding Specialist");
});

test("wire (mcp__) WorkerActivity increments mcpCount", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-mcp", at: T + 100 },
    { event: "PreToolUse", tool: "mcp__drive__list", workerId: "w-mcp", at: T + 200 },
    { event: "PreToolUse", tool: "mcp__drive__read", workerId: "w-mcp", at: T + 300 },
  ]);
  const metric = state.agentMetrics.find((m) => m.id === "w-mcp");
  assert.ok(metric);
  assert.equal(metric!.mcpCount, 2);
  assert.equal(metric!.status, "active");
});

test("non-wire WorkerActivity does not increment mcpCount", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-read", at: T + 100 },
    { event: "PreToolUse", tool: "Read", workerId: "w-read", at: T + 200 },
    { event: "PreToolUse", tool: "Edit", workerId: "w-read", at: T + 300 },
  ]);
  const metric = state.agentMetrics.find((m) => m.id === "w-read");
  assert.ok(metric);
  assert.equal(metric!.mcpCount, 0);
});

test("WorkerStopped finalizes activeMs and sets status idle", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-stop", at: T + 100 },
    { event: "SubagentStop", workerId: "w-stop", at: T + 600 },
  ]);
  const metric = state.agentMetrics.find((m) => m.id === "w-stop");
  assert.ok(metric);
  assert.equal(metric!.status, "idle");
  // activeMs should be approximately 500ms (T+600 - T+100)
  assert.equal(metric!.activeMs, 500);
});

test("ProviderError for a workerId sets status error", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-err", at: T + 100 },
    // ProviderError has no mapHookRecord mapping; apply directly via applyEvent
  ]);
  // Apply the ProviderError event directly since mapHookRecord doesn't emit it from a HookRecord
  const errState = applyEvent(state, { type: "ProviderError", at: T + 500, workerId: "w-err", message: "oops" });
  const metric = errState.agentMetrics.find((m) => m.id === "w-err");
  assert.ok(metric);
  assert.equal(metric!.status, "error");
});

test("TaskCompleted increments taskCount", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-tasks", at: T + 100 },
  ]);
  // Apply TaskCompleted directly (no HookRecord maps to this yet)
  const s2 = applyEvent(state, { type: "TaskCompleted", at: T + 300, workerId: "w-tasks" });
  const s3 = applyEvent(s2, { type: "TaskCompleted", at: T + 500, workerId: "w-tasks" });
  const metric = s3.agentMetrics.find((m) => m.id === "w-tasks");
  assert.ok(metric);
  assert.equal(metric!.taskCount, 2);
});

test("tokens is always 0 (stubbed pending live capture)", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-tok", at: T + 100 },
    { event: "PreToolUse", tool: "mcp__some__tool", workerId: "w-tok", at: T + 200 },
    { event: "SubagentStop", workerId: "w-tok", at: T + 300 },
  ]);
  const metric = state.agentMetrics.find((m) => m.id === "w-tok");
  assert.ok(metric);
  assert.equal(metric!.tokens, 0);
});
