/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mapHookRecord } from "../src/providers/claude-code/mapHookRecord";
import type { HookRecord } from "../src/providers/claude-code/hookRecord";
import { applyEvent, initialWorldState, creditedElapsed } from "../src/core/state";
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
// parentId/tier propagation (Team Lead Mode Phase 3: hierarchy telemetry)
// ---------------------------------------------------------------------------

test("WorkerSpawned with parentId and tier populates those fields on AgentMetric", () => {
  const state = applyEvent(initialWorldState(), {
    type: "WorkerSpawned",
    at: T,
    workerId: "coding-specialist",
    parentId: "build-lead",
    tier: "worker",
  });
  const metric = state.agentMetrics.find((m) => m.id === "coding-specialist");
  assert.ok(metric, "metric should exist for coding-specialist");
  assert.equal(metric!.parentId, "build-lead");
  assert.equal(metric!.tier, "worker");
});

test("WorkerSpawned without parentId/tier leaves those fields undefined (flat / legacy)", () => {
  const state = applyEvent(initialWorldState(), {
    type: "WorkerSpawned",
    at: T,
    workerId: "search-retrieval",
  });
  const metric = state.agentMetrics.find((m) => m.id === "search-retrieval");
  assert.ok(metric);
  assert.equal(metric!.parentId, undefined);
  assert.equal(metric!.tier, undefined);
});

test("Lead spawn (tier: lead) followed by worker spawn (parentId: lead) both populate AgentMetric", () => {
  let state = applyEvent(initialWorldState(), {
    type: "WorkerSpawned",
    at: T,
    workerId: "build-lead",
    role: "Task",
    tier: "lead",
  });
  state = applyEvent(state, {
    type: "WorkerSpawned",
    at: T + 10,
    workerId: "coding-specialist",
    role: "Task",
    parentId: "build-lead",
  });
  const lead = state.agentMetrics.find((m) => m.id === "build-lead");
  const worker = state.agentMetrics.find((m) => m.id === "coding-specialist");
  assert.ok(lead && worker);
  assert.equal(lead!.tier, "lead");
  assert.equal(worker!.parentId, "build-lead");
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

// ---------------------------------------------------------------------------
// creditedElapsed unit tests
// ---------------------------------------------------------------------------

test("creditedElapsed: null workStartAt returns 0", () => {
  // When the agent has never started, elapsed is 0 regardless of other params.
  assert.equal(creditedElapsed(null, null, T + 5000, 180_000, 900_000), 0);
  assert.equal(creditedElapsed(null, T + 1000, T + 5000, 180_000, 900_000), 0);
});

test("creditedElapsed: idle freeze binds when gap exceeds freezeMs", () => {
  // workStart=0, lastActivity=0, now=200_000 (200s > 180s freeze).
  // cappedNow = min(200_000, 0+180_000) = 180_000; result = min(180_000, 900_000) = 180_000.
  const result = creditedElapsed(0, 0, 200_000, 180_000, 900_000);
  assert.equal(result, 180_000);
});

test("creditedElapsed: sanity cap binds when elapsed exceeds capMs", () => {
  // workStart=0, lastActivity=1_000_000, now=1_000_000 (no freeze gap).
  // cappedNow = min(1_000_000, 1_000_000+180_000) = 1_000_000; elapsed=1_000_000 > 900_000.
  const result = creditedElapsed(0, 1_000_000, 1_000_000, 180_000, 900_000);
  assert.equal(result, 900_000);
});

test("creditedElapsed: normal contiguous run returns now-workStart", () => {
  // workStart=1000, lastActivity=1200, now=1300. Gap=100 < freeze=180_000.
  // cappedNow = min(1300, 1200+180_000) = 1300; elapsed=300 < 900_000.
  const result = creditedElapsed(1000, 1200, 1300, 180_000, 900_000);
  assert.equal(result, 300);
});

// ---------------------------------------------------------------------------
// Idle-freeze + sanity-cap integration tests (via applyEvent)
// ---------------------------------------------------------------------------

test("REGRESSION: contiguous events with small gaps credit full elapsed (freeze unaffected)", () => {
  // Spawn at t=0, WorkerActivity at t=100, WorkerStopped at t=300 on the same worker.
  // Gap since last activity at stop = 300-100 = 200ms, well under 180s freeze.
  // Expected activeMs = 300 (stop - spawn, no freeze).
  let state = initialWorldState();
  state = applyEvent(state, { type: "SessionStart", at: 0 });
  state = applyEvent(state, { type: "WorkerSpawned", at: 0, workerId: "w-regress" });
  state = applyEvent(state, { type: "WorkerActivity", at: 100, workerId: "w-regress", kind: "build" });
  state = applyEvent(state, { type: "WorkerStopped", at: 300, workerId: "w-regress" });
  const metric = state.agentMetrics.find((m) => m.id === "w-regress");
  assert.ok(metric, "metric for w-regress must exist");
  assert.equal(metric!.activeMs, 300, "small gaps must not trigger freeze; full 300ms credited");
});

test("IDLE FREEZE: no activity after spawn; stop after freeze window caps activeMs at idleFreezeMs", () => {
  // Spawn at t=0 (lastActivityAt=0 from spawn event), stop at t=200_000 (> 180_000 freeze).
  // Expected activeMs = lastActivityAt + idleFreezeMs - workStartAt = 0+180_000-0 = 180_000.
  const spawnAt = 0;
  const stopAt = 200_000; // 200s, exceeds 180s freeze
  let state = initialWorldState();
  state = applyEvent(state, { type: "SessionStart", at: spawnAt });
  state = applyEvent(state, { type: "WorkerSpawned", at: spawnAt, workerId: "w-freeze" });
  // No WorkerActivity event — lastActivityAt stays at spawnAt (set by WorkerSpawned).
  state = applyEvent(state, { type: "WorkerStopped", at: stopAt, workerId: "w-freeze" });
  const metric = state.agentMetrics.find((m) => m.id === "w-freeze");
  assert.ok(metric, "metric for w-freeze must exist");
  assert.equal(
    metric!.activeMs,
    180_000,
    "activeMs must be capped at idleFreezeMs (180s) when no activity follows spawn",
  );
});

test("SANITY CAP: very long run with recent activity is capped at sanityCapMs", () => {
  // Spawn at t=0, WorkerActivity at t=1_000_000 (lastActivityAt=1_000_000),
  // WorkerStopped at t=1_000_000 (now==lastActivity => freeze doesn't bind).
  // elapsed = 1_000_000 - 0 = 1_000_000 > 900_000 sanity cap.
  // Expected activeMs = 900_000.
  const spawnAt = 0;
  const activityAt = 1_000_000;
  const stopAt = 1_000_000;
  let state = initialWorldState();
  state = applyEvent(state, { type: "SessionStart", at: spawnAt });
  state = applyEvent(state, { type: "WorkerSpawned", at: spawnAt, workerId: "w-cap" });
  state = applyEvent(state, { type: "WorkerActivity", at: activityAt, workerId: "w-cap", kind: "build" });
  state = applyEvent(state, { type: "WorkerStopped", at: stopAt, workerId: "w-cap" });
  const metric = state.agentMetrics.find((m) => m.id === "w-cap");
  assert.ok(metric, "metric for w-cap must exist");
  assert.equal(
    metric!.activeMs,
    900_000,
    "activeMs must be capped at sanityCapMs (900s) when elapsed exceeds the cap",
  );
});

// ---------------------------------------------------------------------------
// SessionStart credit-and-reset behavior (interrupted turn recovery)
// ---------------------------------------------------------------------------

test("SessionStart credits and resets a stale active stretch (interrupted turn)", () => {
  // Simulate an interrupted prior turn: orchestrator started at T0 with a
  // WorkerActivity at T0 (so workStartAt=T0, lastActivityAt=T0, activeMs=1000 from
  // an even earlier stop that we fold in manually).
  //
  // Then a second SessionStart arrives at T1 = T0 + 60min.
  // Expected behavior (new contract):
  //   - activeMs gains creditedElapsed(T0, T0, T1, 180000, 900000) = 180000
  //     (because lastActivityAt+idleFreezeMs = T0+180000 < T1, so cap binds at 180000)
  //   - workStartAt is RESET to T1 (not preserved as T0)
  //   - status = "active", lastActivityAt = T1

  const T0 = T;
  const T1 = T0 + 60 * 60 * 1000; // 60 minutes later

  let state = initialWorldState();

  // First SessionStart: orchestrator created, workStartAt=T0, lastActivityAt=T0
  state = applyEvent(state, { type: "SessionStart", at: T0 });

  // WorkerActivity for orchestrator at T0: keeps workStartAt=T0, lastActivityAt=T0
  state = applyEvent(state, { type: "WorkerActivity", at: T0, workerId: "orchestrator", kind: "survey" });

  // Simulate prior accumulated activeMs by folding the credited elapsed directly
  // (we DON'T send a Stop — this is an interrupted turn). The orchestrator is still
  // "active" with workStartAt=T0. We manually add 1000ms by going via applyEvent
  // with a faked WorkerActivity that doesn't change workStartAt/lastActivityAt.
  // Actually, the cleanest approach: set a baseline via a second SessionStart scenario.
  // Instead: record current orchestrator activeMs, then send the second SessionStart.
  const orchBefore = state.agentMetrics.find((m) => m.id === "orchestrator");
  assert.ok(orchBefore, "orchestrator must exist before second SessionStart");
  assert.equal(orchBefore!.workStartAt, T0, "workStartAt should be T0 before second SessionStart");

  // Second SessionStart at T1 (60 min later, no stop in between)
  state = applyEvent(state, { type: "SessionStart", at: T1 });

  const orchAfter = state.agentMetrics.find((m) => m.id === "orchestrator");
  assert.ok(orchAfter, "orchestrator must exist after second SessionStart");

  // creditedElapsed(T0, T0, T1, 180000, 900000):
  //   cappedNow = min(T1, T0+180000) = T0+180000 (since T1 = T0+3600000 >> T0+180000)
  //   elapsed = (T0+180000) - T0 = 180000, capped at min(180000, 900000) = 180000
  const expectedGain = 180_000;
  const expectedActiveMs = orchBefore!.activeMs + expectedGain;

  assert.equal(
    orchAfter!.activeMs,
    expectedActiveMs,
    `activeMs must gain exactly ${expectedGain}ms (idle-freeze credit) from interrupted turn`,
  );
  assert.equal(
    orchAfter!.workStartAt,
    T1,
    "workStartAt must be RESET to T1 (not stale T0) after second SessionStart",
  );
  assert.equal(orchAfter!.lastActivityAt, T1, "lastActivityAt must be T1 after second SessionStart");
  assert.equal(orchAfter!.status, "active", "orchestrator must be active after SessionStart");
});

test("SessionStart after clean stop credits nothing and resets workStartAt", () => {
  // SessionStart → SessionStop (workStartAt cleared to null) → SessionStart again.
  // The second SessionStart must credit 0 (no active stretch) and set workStartAt = event.at.
  const T0 = T;
  const stopAt = T0 + 5000;
  const T2 = T0 + 10_000;

  let state = initialWorldState();

  // First turn
  state = applyEvent(state, { type: "SessionStart", at: T0 });
  state = applyEvent(state, { type: "SessionStop", at: stopAt });

  const orchAfterStop = state.agentMetrics.find((m) => m.id === "orchestrator");
  assert.ok(orchAfterStop, "orchestrator must exist after SessionStop");
  assert.equal(orchAfterStop!.workStartAt, null, "workStartAt must be null after SessionStop");
  const activeMsAfterStop = orchAfterStop!.activeMs; // e.g. 5000

  // Second turn — clean start, no interrupted active stretch
  state = applyEvent(state, { type: "SessionStart", at: T2 });

  const orchAfterSecond = state.agentMetrics.find((m) => m.id === "orchestrator");
  assert.ok(orchAfterSecond, "orchestrator must exist after second SessionStart");
  assert.equal(
    orchAfterSecond!.activeMs,
    activeMsAfterStop,
    "activeMs must NOT increase on SessionStart when workStartAt was null (clean stop)",
  );
  assert.equal(
    orchAfterSecond!.workStartAt,
    T2,
    "workStartAt must be set to the new session timestamp",
  );
  assert.equal(orchAfterSecond!.status, "active", "orchestrator must be active after second SessionStart");
});

// ---------------------------------------------------------------------------
// Delegation Health counters
// ---------------------------------------------------------------------------

/** Locate a metric by id from the public agentMetrics list. */
function findMetricById(state: WorldState, id: string) {
  return state.agentMetrics.find((m) => m.id === id);
}

describe("Delegation Health counters", () => {
  test("fresh metric starts with directSearches, directReads, directEdits, delegations all at 0", () => {
    // A just-spawned worker should have all counters initialised to zero.
    const state = applyEvent(initialWorldState(), {
      type: "WorkerSpawned",
      at: T,
      workerId: "fresh-agent",
    });
    const m = findMetricById(state, "fresh-agent");
    assert.ok(m, "metric must exist after WorkerSpawned");
    assert.equal(m!.directSearches, 0, "directSearches starts at 0");
    assert.equal(m!.directReads, 0, "directReads starts at 0");
    assert.equal(m!.directEdits, 0, "directEdits starts at 0");
    assert.equal(m!.delegations, 0, "delegations starts at 0");
  });

  test("survey + detail 'Grep' or 'Glob' increments directSearches (the leak), not directReads", () => {
    let state = initialWorldState();
    state = applyEvent(state, { type: "SessionStart", at: T });
    state = applyEvent(state, { type: "WorkerSpawned", at: T + 10, workerId: "dh-search" });
    state = applyEvent(state, { type: "WorkerActivity", at: T + 100, workerId: "dh-search", kind: "survey", detail: "Grep" });
    state = applyEvent(state, { type: "WorkerActivity", at: T + 200, workerId: "dh-search", kind: "survey", detail: "Glob" });
    const m = findMetricById(state, "dh-search");
    assert.ok(m);
    assert.equal(m!.directSearches, 2, "Grep + Glob should yield directSearches===2");
    assert.equal(m!.directReads, 0, "Grep/Glob must NOT increment directReads");
    assert.equal(m!.directEdits, 0, "directEdits must remain 0 for survey events");
  });

  test("survey + detail 'Read' increments directReads (allowed), not directSearches", () => {
    let state = initialWorldState();
    state = applyEvent(state, { type: "SessionStart", at: T });
    state = applyEvent(state, { type: "WorkerSpawned", at: T + 10, workerId: "dh-read" });
    state = applyEvent(state, { type: "WorkerActivity", at: T + 100, workerId: "dh-read", kind: "survey", detail: "Read" });
    state = applyEvent(state, { type: "WorkerActivity", at: T + 200, workerId: "dh-read", kind: "survey", detail: "Read" });
    const m = findMetricById(state, "dh-read");
    assert.ok(m);
    assert.equal(m!.directReads, 2, "two Reads should yield directReads===2");
    assert.equal(m!.directSearches, 0, "Read must NOT increment directSearches");
  });

  test("WorkerActivity kind 'build' increments directEdits, not searches/reads", () => {
    let state = initialWorldState();
    state = applyEvent(state, { type: "SessionStart", at: T });
    state = applyEvent(state, { type: "WorkerSpawned", at: T + 10, workerId: "dh-builder" });
    state = applyEvent(state, { type: "WorkerActivity", at: T + 100, workerId: "dh-builder", kind: "build", detail: "Edit" });
    const m = findMetricById(state, "dh-builder");
    assert.ok(m);
    assert.equal(m!.directEdits, 1, "one build activity should yield directEdits===1");
    assert.equal(m!.directSearches, 0, "directSearches must remain 0 for build events");
    assert.equal(m!.directReads, 0, "directReads must remain 0 for build events");
  });

  test("WorkerActivity kind 'haul' increments directEdits on that workerId", () => {
    let state = initialWorldState();
    state = applyEvent(state, { type: "SessionStart", at: T });
    state = applyEvent(state, { type: "WorkerSpawned", at: T + 10, workerId: "dh-hauler" });
    state = applyEvent(state, { type: "WorkerActivity", at: T + 100, workerId: "dh-hauler", kind: "haul", detail: "Write" });
    state = applyEvent(state, { type: "WorkerActivity", at: T + 200, workerId: "dh-hauler", kind: "haul", detail: "Write" });
    state = applyEvent(state, { type: "WorkerActivity", at: T + 300, workerId: "dh-hauler", kind: "build", detail: "Edit" });
    const m = findMetricById(state, "dh-hauler");
    assert.ok(m);
    assert.equal(m!.directEdits, 3, "two haul + one build should yield directEdits===3");
    assert.equal(m!.directSearches, 0, "directSearches must remain 0 for haul/build events");
  });

  test("WorkerActivity kind 'wire' increments NEITHER searches/reads NOR directEdits", () => {
    let state = initialWorldState();
    state = applyEvent(state, { type: "SessionStart", at: T });
    state = applyEvent(state, { type: "WorkerSpawned", at: T + 10, workerId: "dh-wire" });
    state = applyEvent(state, { type: "WorkerActivity", at: T + 100, workerId: "dh-wire", kind: "wire", detail: "mcp__x__y" });
    const m = findMetricById(state, "dh-wire");
    assert.ok(m);
    assert.equal(m!.directSearches, 0, "wire must not increment directSearches");
    assert.equal(m!.directReads, 0, "wire must not increment directReads");
    assert.equal(m!.directEdits, 0, "wire must not increment directEdits");
  });

  test("WorkerActivity kind 'shell' increments NEITHER searches/reads NOR directEdits", () => {
    let state = initialWorldState();
    state = applyEvent(state, { type: "SessionStart", at: T });
    state = applyEvent(state, { type: "WorkerSpawned", at: T + 10, workerId: "dh-shell" });
    state = applyEvent(state, { type: "WorkerActivity", at: T + 100, workerId: "dh-shell", kind: "shell", detail: "Bash" });
    const m = findMetricById(state, "dh-shell");
    assert.ok(m);
    assert.equal(m!.directSearches, 0, "shell must not increment directSearches");
    assert.equal(m!.directReads, 0, "shell must not increment directReads");
    assert.equal(m!.directEdits, 0, "shell must not increment directEdits");
  });

  test("WorkerSpawned with role 'Task' increments delegations on orchestrator, NOT on the child", () => {
    let state = initialWorldState();
    state = applyEvent(state, { type: "SessionStart", at: T });
    state = applyEvent(state, { type: "WorkerSpawned", at: T + 100, workerId: "child-task", role: "Task" });
    const orch = findMetricById(state, "orchestrator");
    assert.ok(orch, "orchestrator metric must exist");
    assert.equal(orch!.delegations, 1, "orchestrator.delegations must be 1 after a Task spawn");
    const child = findMetricById(state, "child-task");
    assert.ok(child, "child metric must exist");
    assert.equal(child!.delegations, 0, "child.delegations must remain 0");
  });

  test("WorkerSpawned with role 'Agent' increments delegations on orchestrator, NOT on the child", () => {
    let state = initialWorldState();
    state = applyEvent(state, { type: "SessionStart", at: T });
    state = applyEvent(state, { type: "WorkerSpawned", at: T + 100, workerId: "child-agent", role: "Agent" });
    const orch = findMetricById(state, "orchestrator");
    assert.ok(orch, "orchestrator metric must exist");
    assert.equal(orch!.delegations, 1, "orchestrator.delegations must be 1 after an Agent spawn");
    const child = findMetricById(state, "child-agent");
    assert.ok(child, "child metric must exist");
    assert.equal(child!.delegations, 0, "child.delegations must remain 0");
  });

  test("WorkerSpawned with role 'Skill' does NOT increment delegations", () => {
    let state = initialWorldState();
    state = applyEvent(state, { type: "SessionStart", at: T });
    state = applyEvent(state, { type: "WorkerSpawned", at: T + 100, workerId: "skill-worker", role: "Skill" });
    const orch = findMetricById(state, "orchestrator");
    assert.ok(orch, "orchestrator metric must exist");
    assert.equal(orch!.delegations, 0, "Skill spawn must NOT increment orchestrator.delegations");
  });

  test("multiple Task/Agent spawns accumulate delegations on orchestrator", () => {
    let state = initialWorldState();
    state = applyEvent(state, { type: "SessionStart", at: T });
    state = applyEvent(state, { type: "WorkerSpawned", at: T + 100, workerId: "child-1", role: "Task" });
    state = applyEvent(state, { type: "WorkerSpawned", at: T + 200, workerId: "child-2", role: "Agent" });
    state = applyEvent(state, { type: "WorkerSpawned", at: T + 300, workerId: "skill-1", role: "Skill" });
    state = applyEvent(state, { type: "WorkerSpawned", at: T + 400, workerId: "child-3", role: "Task" });
    const orch = findMetricById(state, "orchestrator");
    assert.ok(orch, "orchestrator metric must exist");
    // Task + Agent + Task = 3 delegations; Skill does not count
    assert.equal(orch!.delegations, 3, "three Task/Agent spawns should yield delegations===3");
  });
});
