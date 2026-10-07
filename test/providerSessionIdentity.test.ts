/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Verifies p22-t8: roster/per-worker state is keyed by (provider, workerId),
// not the bare workerId alone, so two live harnesses running the same
// specialist id under different providers no longer clobber each other's
// roster entry. See src/core/state.ts's rosterKey/findMetric/upsertMetric.
//
// sessionId deliberately does NOT participate in the key -- see rosterKey's
// doc comment in state.ts for why (it would fragment computeStateFromRecords'
// cumulative multi-session rollup, an existing, unrelated behaviour covered
// by state.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, initialWorldState } from "../src/core/state";
import type { AgentMetric } from "../src/core/state";
import type { NormalizedEvent } from "../src/core/events";

const T = 1700000000000;

function metricsFor(agentMetrics: AgentMetric[], id: string): AgentMetric[] {
  return agentMetrics.filter((m) => m.id === id);
}

// Per-provider live state stays independent internally; the PUBLIC list is
// merged to one row per agent id (see toPublicMetrics in state.ts).
function internalsFor(state: ReturnType<typeof initialWorldState>, id: string) {
  return state._agentMetricsInternal.filter((m) => m.id === id);
}

test("two providers emitting the same workerId produce two distinct roster entries with independent state", () => {
  let state = initialWorldState();

  const spawnClaude: NormalizedEvent = {
    type: "WorkerSpawned",
    at: T,
    workerId: "coding-specialist",
    role: "general-purpose",
    provider: "claude-code",
    sessionId: "session-1",
  };
  const spawnOther: NormalizedEvent = {
    type: "WorkerSpawned",
    at: T + 1,
    workerId: "coding-specialist",
    role: "general-purpose",
    provider: "opencode",
    sessionId: "session-2",
  };
  state = applyEvent(state, spawnClaude);
  state = applyEvent(state, spawnOther);

  assert.equal(internalsFor(state, "coding-specialist").length, 2, "two distinct internal entries expected, one per provider");
  assert.equal(metricsFor(state.agentMetrics, "coding-specialist").length, 1, "public Metrics list shows one row per agent id");

  // Complete a task only for the claude-code instance; the opencode instance
  // must be untouched.
  const complete: NormalizedEvent = {
    type: "TaskCompleted",
    at: T + 5,
    workerId: "coding-specialist",
    provider: "claude-code",
    sessionId: "session-1",
  };
  state = applyEvent(state, complete);

  const afterComplete = internalsFor(state, "coding-specialist");
  const claudeEntry = afterComplete.find((m) => m.taskCount === 1);
  const otherEntry = afterComplete.find((m) => m.taskCount === 0);
  assert.ok(claudeEntry, "claude-code entry should have taskCount 1");
  assert.ok(otherEntry, "opencode entry should be unaffected (taskCount 0)");

  // Stop only the opencode instance; the claude-code instance must stay active.
  const stopOther: NormalizedEvent = {
    type: "WorkerStopped",
    at: T + 10,
    workerId: "coding-specialist",
    provider: "opencode",
    sessionId: "session-2",
  };
  state = applyEvent(state, stopOther);
  const afterStop = internalsFor(state, "coding-specialist");
  const claudeStill = afterStop.find((m) => m.status === "active");
  const otherStopped = afterStop.find((m) => m.status === "idle");
  assert.ok(claudeStill, "claude-code entry should remain active after opencode instance stops");
  assert.ok(otherStopped, "opencode entry should be idle after WorkerStopped");
});

test("single-provider activity (no provider/sessionId on events) collapses to one roster entry as before", () => {
  let state = initialWorldState();
  const spawn: NormalizedEvent = {
    type: "WorkerSpawned",
    at: T,
    workerId: "coding-specialist",
    role: "general-purpose",
  };
  const complete: NormalizedEvent = {
    type: "TaskCompleted",
    at: T + 1,
    workerId: "coding-specialist",
  };
  const stop: NormalizedEvent = {
    type: "WorkerStopped",
    at: T + 2,
    workerId: "coding-specialist",
    tokens: 42,
  };
  state = applyEvent(state, spawn);
  state = applyEvent(state, complete);
  state = applyEvent(state, stop);

  const entries = metricsFor(state.agentMetrics, "coding-specialist");
  assert.equal(entries.length, 1, "missing provider must default consistently to a single entry");
  assert.equal(entries[0].taskCount, 1);
  assert.equal(entries[0].tokens, 42);
  assert.equal(entries[0].status, "idle");
});

test("single-provider activity across DIFFERENT sessionIds still collapses to one roster entry (sessionId not in the key)", () => {
  let state = initialWorldState();
  const spawn: NormalizedEvent = {
    type: "WorkerSpawned",
    at: T,
    workerId: "coding-specialist",
    role: "general-purpose",
    provider: "claude-code",
    sessionId: "session-A",
  };
  const complete: NormalizedEvent = {
    type: "TaskCompleted",
    at: T + 1,
    workerId: "coding-specialist",
    provider: "claude-code",
    sessionId: "session-B",
  };
  state = applyEvent(state, spawn);
  state = applyEvent(state, complete);

  const entries = metricsFor(state.agentMetrics, "coding-specialist");
  assert.equal(entries.length, 1, "same provider, different sessionId must still merge into one entry");
  assert.equal(entries[0].taskCount, 1);
});

test("explicit default provider ('claude-code') hashes to the same key as an omitted provider", () => {
  let state = initialWorldState();
  const spawnOmitted: NormalizedEvent = {
    type: "WorkerSpawned",
    at: T,
    workerId: "worker-x",
    role: "general-purpose",
  };
  state = applyEvent(state, spawnOmitted);
  const complete: NormalizedEvent = {
    type: "TaskCompleted",
    at: T + 1,
    workerId: "worker-x",
    provider: "claude-code",
  };
  state = applyEvent(state, complete);

  const entries = metricsFor(state.agentMetrics, "worker-x");
  assert.equal(entries.length, 1, "explicit default must hash identically to an omitted provider");
  assert.equal(entries[0].taskCount, 1);
});

test("state.workers canvas entry: a WorkerStopped from a different provider leaves the original provider's worker untouched", () => {
  let state = initialWorldState();

  const spawnClaude: NormalizedEvent = {
    type: "WorkerSpawned",
    at: T,
    workerId: "coding-specialist",
    role: "general-purpose",
    provider: "claude-code",
    sessionId: "session-1",
  };
  state = applyEvent(state, spawnClaude);
  assert.equal(state.workers["coding-specialist"].state, "arrive");

  // Move the claude-code worker into "build" via activity, then stop a
  // same-bare-id worker from a DIFFERENT provider. The claude-code entry's
  // canvas state must stay exactly as it was before the foreign stop.
  const activityClaude: NormalizedEvent = {
    type: "WorkerActivity",
    at: T + 1,
    workerId: "coding-specialist",
    kind: "build",
    provider: "claude-code",
    sessionId: "session-1",
  };
  state = applyEvent(state, activityClaude);
  assert.equal(state.workers["coding-specialist"].state, "build");

  const stopOther: NormalizedEvent = {
    type: "WorkerStopped",
    at: T + 2,
    workerId: "coding-specialist",
    provider: "opencode",
    sessionId: "session-2",
  };
  state = applyEvent(state, stopOther);

  assert.equal(
    state.workers["coding-specialist"].state,
    "build",
    "a WorkerStopped from provider 'opencode' must not flip the 'claude-code' worker's sprite to leave",
  );

  // A TaskCompleted from the foreign provider must likewise not flip it to celebrate.
  const completeOther: NormalizedEvent = {
    type: "TaskCompleted",
    at: T + 3,
    workerId: "coding-specialist",
    provider: "opencode",
    sessionId: "session-2",
  };
  state = applyEvent(state, completeOther);
  assert.equal(
    state.workers["coding-specialist"].state,
    "build",
    "a TaskCompleted from provider 'opencode' must not flip the 'claude-code' worker's sprite to celebrate",
  );

  // The claude-code provider's OWN WorkerStopped still works normally.
  const stopClaude: NormalizedEvent = {
    type: "WorkerStopped",
    at: T + 4,
    workerId: "coding-specialist",
    provider: "claude-code",
    sessionId: "session-1",
  };
  state = applyEvent(state, stopClaude);
  assert.equal(state.workers["coding-specialist"].state, "leave");
});

test("public AgentMetric never exposes the internal roster key", () => {
  let state = initialWorldState();
  const spawn: NormalizedEvent = {
    type: "WorkerSpawned",
    at: T,
    workerId: "worker-y",
    role: "general-purpose",
    provider: "claude-code",
    sessionId: "s1",
  };
  state = applyEvent(state, spawn);
  const entry = metricsFor(state.agentMetrics, "worker-y")[0];
  assert.ok(entry);
  assert.equal((entry as unknown as { _rosterKey?: string })._rosterKey, undefined);
  assert.equal(entry.id, "worker-y", "public id must stay the bare workerId, not a composite key");
});
