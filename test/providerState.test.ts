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
    const events = mapHookRecord(record);
    // mapHookRecord now returns NormalizedEvent[]; fold every event in order.
    const arr = Array.isArray(events) ? events : (events ? [events] : []);
    for (const ev of arr) {
      state = applyEvent(state, ev);
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

test("WorkerActivity on a never-spawned id updates the metric but creates no canvas worker", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    // no spawn, so no canvas worker exists...
    { event: "PreToolUse", tool: "Read", workerId: "ghost", at: T + 200 },
  ]);
  // ...but the metric must still be created and marked active (this is the fix
  // that lets the orchestrator/seeded agents light up without a spawn).
  assert.equal(state.workers["ghost"], undefined);
  const metric = state.agentMetrics.find((m) => m.id === "ghost");
  assert.ok(metric, "metric should be created for activity without a spawn");
  assert.equal(metric!.status, "active");
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

test("WorkerStopped with no tokens leaves agentMetrics.tokens at 0", () => {
  // SubagentStop record without a tokens field -> tokens defaults to 0
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

test("WorkerStopped with tokens is reflected in agentMetrics.tokens", () => {
  // SubagentStop record carrying tokens -> tokens accumulate in metric
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "w-tok2", at: T + 100 },
    { event: "SubagentStop", workerId: "w-tok2", tokens: 4200, at: T + 500 },
  ]);
  const metric = state.agentMetrics.find((m) => m.id === "w-tok2");
  assert.ok(metric);
  assert.equal(metric!.tokens, 4200);
});

// ---------------------------------------------------------------------------
// Name override map and new AgentMetric fields
// ---------------------------------------------------------------------------

test("primary-agent id yields name 'Fallback Agent' via override map", () => {
  const state = applyEvent(initialWorldState(), {
    type: "WorkerSpawned",
    at: T,
    workerId: "primary-agent",
  });
  const metric = state.agentMetrics.find((m) => m.id === "primary-agent");
  assert.ok(metric, "metric should exist for primary-agent");
  assert.equal(metric!.name, "Fallback Agent");
});

test("WorkerSpawned with explicit name overrides the computed name", () => {
  const state = applyEvent(initialWorldState(), {
    type: "WorkerSpawned",
    at: T,
    workerId: "primary-agent",
    name: "Fallback Agent",
  });
  const metric = state.agentMetrics.find((m) => m.id === "primary-agent");
  assert.ok(metric);
  assert.equal(metric!.name, "Fallback Agent");
});

test("WorkerSpawned with model and description populates those fields on AgentMetric", () => {
  const state = applyEvent(initialWorldState(), {
    type: "WorkerSpawned",
    at: T,
    workerId: "coding-specialist",
    model: "Sonnet",
    description: "Core implementation in src/core and src/providers.",
  });
  const metric = state.agentMetrics.find((m) => m.id === "coding-specialist");
  assert.ok(metric, "metric should exist for coding-specialist");
  assert.equal(metric!.model, "Sonnet");
  assert.equal(metric!.description, "Core implementation in src/core and src/providers.");
});

test("WorkerSpawned without model/description leaves those fields undefined", () => {
  const state = applyEvent(initialWorldState(), {
    type: "WorkerSpawned",
    at: T,
    workerId: "search-retrieval",
  });
  const metric = state.agentMetrics.find((m) => m.id === "search-retrieval");
  assert.ok(metric);
  assert.equal(metric!.model, undefined);
  assert.equal(metric!.description, undefined);
});

// ---------------------------------------------------------------------------
// Orchestrator lifecycle + per-turn token capture
// ---------------------------------------------------------------------------

test("SessionStart marks the orchestrator metric active", () => {
  const state = fold([{ event: "UserPromptSubmit", at: T }]);
  const orch = state.agentMetrics.find((m) => m.id === "orchestrator");
  assert.ok(orch, "orchestrator metric should exist after SessionStart");
  assert.equal(orch!.status, "active");
});

test("orchestrator tool activity keeps it active even with no spawn", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Edit", workerId: "orchestrator", at: T + 100 },
  ]);
  const orch = state.agentMetrics.find((m) => m.id === "orchestrator");
  assert.ok(orch);
  assert.equal(orch!.status, "active");
  assert.equal(state.workers["orchestrator"], undefined); // metrics-only, no desk
});

test("Stop finalizes the orchestrator with its per-turn token delta + model", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Read", workerId: "orchestrator", at: T + 100 },
    { event: "Stop", workerId: "orchestrator", tokens: 8400, model: "claude-opus-4-6", at: T + 5000 },
  ]);
  const orch = state.agentMetrics.find((m) => m.id === "orchestrator");
  assert.ok(orch);
  assert.equal(orch!.status, "idle");
  assert.equal(orch!.tokens, 8400);
  assert.equal(orch!.model, "claude-opus-4-6");
  // active from SessionStart (T) to Stop (T+5000)
  assert.equal(orch!.activeMs, 5000);
  assert.equal(state.sessionActive, false);
});

test("orchestrator tokens accumulate across multiple turns", () => {
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "Stop", workerId: "orchestrator", tokens: 1000, at: T + 1000 },
    { event: "UserPromptSubmit", at: T + 2000 },
    { event: "Stop", workerId: "orchestrator", tokens: 2500, at: T + 3000 },
  ]);
  const orch = state.agentMetrics.find((m) => m.id === "orchestrator");
  assert.ok(orch);
  assert.equal(orch!.tokens, 3500);
});

test("Stop maps to SessionStop carrying tokens and model", () => {
  const events = mapHookRecord({ event: "Stop", workerId: "orchestrator", tokens: 99, model: "claude-opus-4-6", at: T });
  assert.ok(Array.isArray(events));
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.type, "SessionStop");
  if (event.type === "SessionStop") {
    assert.equal(event.tokens, 99);
    assert.equal(event.model, "claude-opus-4-6");
  }
});

// ---------------------------------------------------------------------------
// New contract: task-count tracking via mapped events through applyEvent
// ---------------------------------------------------------------------------

test("Task spawn (via hook) bumps orchestrator taskCount to 1", () => {
  // PreToolUse Task → [WorkerSpawned, TaskCompleted{workerId:"orchestrator"}]
  // The trailing TaskCompleted must increment orchestrator.taskCount.
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "coding-specialist", at: T + 100 },
  ]);
  const orch = state.agentMetrics.find((m) => m.id === "orchestrator");
  assert.ok(orch, "orchestrator metric must exist");
  assert.equal(orch!.taskCount, 1, "orchestrator taskCount should be 1 after spawning one Task");
});

test("Skill spawn does NOT bump orchestrator taskCount", () => {
  // PreToolUse Skill → [WorkerSpawned] only — no trailing TaskCompleted.
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Skill", workerId: "office-ready-test", at: T + 100 },
  ]);
  const orch = state.agentMetrics.find((m) => m.id === "orchestrator");
  // orchestrator may or may not exist; if it does, taskCount must be 0.
  if (orch) {
    assert.equal(orch!.taskCount, 0, "Skill spawn must not increment orchestrator taskCount");
  }
});

test("SubagentStop for 'coding-specialist': taskCount===1, status idle, workStartAt null", () => {
  // SubagentStop → [TaskCompleted{workerId:"coding-specialist"}, WorkerStopped{workerId:"coding-specialist"}]
  // TaskCompleted increments taskCount and sets status active; WorkerStopped then sets idle + clears timer.
  // The net result: taskCount===1 AND status idle AND workStartAt===null.
  const state = fold([
    { event: "UserPromptSubmit", at: T },
    { event: "PreToolUse", tool: "Task", workerId: "coding-specialist", at: T + 100 },
    { event: "SubagentStop", workerId: "coding-specialist", at: T + 600 },
  ]);
  const metric = state.agentMetrics.find((m) => m.id === "coding-specialist");
  assert.ok(metric, "metric for coding-specialist must exist");
  assert.equal(metric!.taskCount, 1, "taskCount should be 1 (from TaskCompleted inside SubagentStop)");
  assert.equal(metric!.status, "idle", "status should be idle (WorkerStopped fires after TaskCompleted)");
  assert.equal(metric!.workStartAt, null, "timer must be finalized (not restarted by the preceding TaskCompleted)");
});

// ---------------------------------------------------------------------------
// Stale-state reconciliation: stuck-active agent cleanup
// ---------------------------------------------------------------------------

test("SessionStop finalizes ALL active subagents, not just the orchestrator", () => {
  // Drive "search-retrieval" to active via WorkerSpawned, then stop the session.
  // The subagent's stop event never arrives — simulating a killed process.
  const spawnAt = T + 100;
  const stopAt = T + 5000;
  let state = initialWorldState();
  // SessionStart → orchestrator goes active
  state = applyEvent(state, { type: "SessionStart", at: T });
  // WorkerSpawned → search-retrieval goes active, workStartAt = spawnAt
  state = applyEvent(state, { type: "WorkerSpawned", at: spawnAt, workerId: "search-retrieval" });
  // SessionStop → should finalize BOTH orchestrator AND search-retrieval
  state = applyEvent(state, { type: "SessionStop", at: stopAt });

  const orch = state.agentMetrics.find((m) => m.id === "orchestrator");
  assert.ok(orch, "orchestrator metric must exist");
  assert.equal(orch!.status, "idle", "orchestrator should be idle after SessionStop");

  const sub = state.agentMetrics.find((m) => m.id === "search-retrieval");
  assert.ok(sub, "search-retrieval metric must exist");
  assert.equal(sub!.status, "idle", "search-retrieval should be finalized to idle by SessionStop");
  assert.equal(sub!.workStartAt, null, "search-retrieval workStartAt must be null after SessionStop");
  // activeMs must have grown by (stopAt - spawnAt) = 4900
  assert.equal(sub!.activeMs, stopAt - spawnAt, "search-retrieval activeMs must credit elapsed time up to SessionStop");
});

test("SessionStart clears stale active subagents WITHOUT crediting activeMs", () => {
  // Simulate a previous turn where "search-retrieval" was left active (process died,
  // no WorkerStopped ever fired). The activeMs at the point of death is 0.
  // A new SessionStart arrives much later — it must reset status/workStartAt
  // but must NOT add any elapsed time (the stale workStartAt is untrustworthy).
  const staleStartAt = T + 100;
  const newSessionAt = T + 60_000; // 60s later
  let state = initialWorldState();
  // Drive search-retrieval to active (workStartAt = staleStartAt, activeMs = 0)
  state = applyEvent(state, { type: "SessionStart", at: T });
  state = applyEvent(state, { type: "WorkerSpawned", at: staleStartAt, workerId: "search-retrieval" });
  // No stop event — agent is stuck active. Capture activeMs before the new session.
  const stuckMetric = state.agentMetrics.find((m) => m.id === "search-retrieval");
  assert.ok(stuckMetric, "search-retrieval must be active before the new session");
  const activeMsBefore = stuckMetric!.activeMs;

  // New turn begins — SessionStart should sweep away the stale agent
  state = applyEvent(state, { type: "SessionStart", at: newSessionAt });

  const sub = state.agentMetrics.find((m) => m.id === "search-retrieval");
  assert.ok(sub, "search-retrieval metric must still exist after new SessionStart");
  assert.equal(sub!.status, "idle", "stale active agent must be reset to idle by SessionStart");
  assert.equal(sub!.workStartAt, null, "workStartAt must be cleared by SessionStart sweep");
  assert.equal(sub!.activeMs, activeMsBefore, "activeMs must NOT increase — stale time must not be credited");
});
