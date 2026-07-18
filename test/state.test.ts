/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStateFromRecords, applyEvent, initialWorldState } from "../src/core/state";
import type { HookRecord } from "../src/providers/claude-code/hookRecord";
import type { AgentMetric } from "../src/core/state";

const T = 1700000000000;

function metric(agentMetrics: AgentMetric[], id: string): AgentMetric | undefined {
  return agentMetrics.find((m) => m.id === id);
}

// ---------------------------------------------------------------------------
// computeStateFromRecords: session-scoped replay (Delegation Health dual view)
// ---------------------------------------------------------------------------

// Session "A": orchestrator does a direct Edit (directEdits) and a direct Grep
// (directSearches, the delegation leak), plus a subagent "coding-specialist"
// that completes with 100 tokens.
const sessionARecords: HookRecord[] = [
  { event: "PreToolUse", tool: "Edit", sessionId: "A", at: T },
  { event: "PreToolUse", tool: "Grep", sessionId: "A", at: T + 1 },
  { event: "SubagentStop", workerId: "coding-specialist", tokens: 100, sessionId: "A", at: T + 2 },
];

// Session "B": same shapes, different sessionId and different counts, so the
// two sessions are trivially distinguishable in assertions (500 tokens, not
// 100; and a second directEdit that must NOT bleed into session A's total).
const sessionBRecords: HookRecord[] = [
  { event: "PreToolUse", tool: "Edit", sessionId: "B", at: T + 10 },
  { event: "SubagentStop", workerId: "coding-specialist", tokens: 500, sessionId: "B", at: T + 12 },
];

const allRecords: HookRecord[] = [...sessionARecords, ...sessionBRecords];

test("filterSessionId set -> only records carrying that sessionId contribute to agentMetrics", () => {
  const state = computeStateFromRecords(allRecords, "A");
  const orchestrator = metric(state.agentMetrics, "orchestrator");
  const coder = metric(state.agentMetrics, "coding-specialist");
  assert.ok(orchestrator, "orchestrator metric should exist from session A's Edit/Grep");
  assert.equal(orchestrator!.directEdits, 1, "only session A's Edit should count");
  assert.equal(orchestrator!.directSearches, 1, "only session A's Grep should count");
  assert.ok(coder, "coding-specialist metric should exist from session A's SubagentStop");
  assert.equal(coder!.tokens, 100, "only session A's 100 tokens should count");
});

test("filterSessionId set -> session B's activity is fully excluded from session A's totals", () => {
  const state = computeStateFromRecords(allRecords, "A");
  const coder = metric(state.agentMetrics, "coding-specialist");
  assert.ok(coder);
  // Session B contributed 500 tokens and a second Edit; neither may appear.
  assert.notEqual(coder!.tokens, 600, "session B's 500 tokens must not be folded into session A's total");
  assert.equal(coder!.tokens, 100);
  const orchestrator = metric(state.agentMetrics, "orchestrator");
  assert.ok(orchestrator);
  assert.notEqual(orchestrator!.directEdits, 2, "session B's Edit must not be folded into session A's total");
  assert.equal(orchestrator!.directEdits, 1);
});

test("filterSessionId undefined -> every record contributes regardless of sessionId (cumulative)", () => {
  const state = computeStateFromRecords(allRecords, undefined);
  const orchestrator = metric(state.agentMetrics, "orchestrator");
  const coder = metric(state.agentMetrics, "coding-specialist");
  assert.ok(orchestrator);
  assert.ok(coder);
  // Both sessions' Edits/tokens are folded together.
  assert.equal(orchestrator!.directEdits, 2, "session A's + session B's Edit");
  assert.equal(orchestrator!.directSearches, 1, "only session A had a Grep");
  assert.equal(coder!.tokens, 600, "session A's 100 + session B's 500");
});

test("filterSessionId undefined -> matches folding all records manually via the same reducer path", () => {
  // computeStateFromRecords with no filter must be equivalent to folding every
  // record unconditionally: rebuild the same result via a second, independent
  // call scoped to each session and sum the pieces we care about, to guard
  // against a future refactor silently dropping records when unfiltered.
  const cumulative = computeStateFromRecords(allRecords, undefined);
  const onlyA = computeStateFromRecords(sessionARecords, undefined);
  const onlyB = computeStateFromRecords(sessionBRecords, undefined);
  const cumCoder = metric(cumulative.agentMetrics, "coding-specialist")!;
  const aCoder = metric(onlyA.agentMetrics, "coding-specialist")!;
  const bCoder = metric(onlyB.agentMetrics, "coding-specialist")!;
  assert.equal(cumCoder.tokens, aCoder.tokens + bCoder.tokens);
  const cumOrch = metric(cumulative.agentMetrics, "orchestrator")!;
  const aOrch = metric(onlyA.agentMetrics, "orchestrator")!;
  const bOrch = metric(onlyB.agentMetrics, "orchestrator")!;
  assert.equal(cumOrch.directEdits, aOrch.directEdits + bOrch.directEdits);
});

test("records with no sessionId at all are excluded from a session-scoped rebuild", () => {
  // Legacy records (written by a hook version predating sessionId) must not be
  // attributed to any specific session filter.
  const legacyRecord: HookRecord = { event: "PreToolUse", tool: "Edit", at: T + 20 };
  const state = computeStateFromRecords([...sessionARecords, legacyRecord], "A");
  const orchestrator = metric(state.agentMetrics, "orchestrator")!;
  assert.equal(orchestrator.directEdits, 1, "the sessionId-less record must not count toward session A");
});

test("records with no sessionId at all DO contribute when filterSessionId is undefined", () => {
  const legacyRecord: HookRecord = { event: "PreToolUse", tool: "Edit", at: T + 20 };
  const state = computeStateFromRecords([...sessionARecords, legacyRecord], undefined);
  const orchestrator = metric(state.agentMetrics, "orchestrator")!;
  assert.equal(orchestrator.directEdits, 2, "session A's Edit + the sessionId-less Edit");
});

test("empty records array -> initialWorldState-equivalent (no agentMetrics)", () => {
  const state = computeStateFromRecords([], "A");
  assert.equal(state.agentMetrics.length, 0);
  assert.equal(state.sessionActive, false);
});

// ---------------------------------------------------------------------------
// computeStateFromRecords: lastActivityAt (plan-stall indicator input)
// ---------------------------------------------------------------------------
// lastActivityAt is the max `at` across records the reducer actually INCLUDES
// (i.e. it respects the same filterSessionId gate as everything else in the
// loop), or null when no record is included. media/main.js's isPlanStalled()
// treats this as the sole staleness signal for the "plan may be stalled"
// advisory note.

test("lastActivityAt: unfiltered rebuild -> max `at` across ALL records, not just the last one pushed", () => {
  const state = computeStateFromRecords(allRecords, undefined);
  // allRecords = [...sessionARecords (T..T+2), ...sessionBRecords (T+10, T+12)];
  // the max is session B's last record (T + 12), which is also array-last here,
  // so also assert against a shuffled copy to prove it's a real max, not "last write wins".
  assert.equal(state.lastActivityAt, T + 12);
  const shuffled = [...allRecords].reverse();
  const shuffledState = computeStateFromRecords(shuffled, undefined);
  assert.equal(shuffledState.lastActivityAt, T + 12, "max must not depend on array order");
});

test("lastActivityAt: empty records array -> null", () => {
  const state = computeStateFromRecords([], undefined);
  assert.equal(state.lastActivityAt, null);
});

test("lastActivityAt: empty records array with a sessionId filter -> still null", () => {
  const state = computeStateFromRecords([], "A");
  assert.equal(state.lastActivityAt, null);
});

test("lastActivityAt: session-scoped rebuild only considers that session's records", () => {
  const state = computeStateFromRecords(allRecords, "A");
  // Session A's own max `at` is T + 2 (its SubagentStop) — session B's later
  // T + 10/T + 12 records must not leak into a session-A-scoped max.
  assert.equal(state.lastActivityAt, T + 2);
});

test("lastActivityAt: sessionId-less legacy records are excluded from a session-scoped max but included when unfiltered", () => {
  const legacyRecord: HookRecord = { event: "PreToolUse", tool: "Edit", at: T + 100 };
  const scoped = computeStateFromRecords([...sessionARecords, legacyRecord], "A");
  assert.equal(scoped.lastActivityAt, T + 2, "the sessionId-less record's later `at` must not count toward session A");
  const unscoped = computeStateFromRecords([...sessionARecords, legacyRecord], undefined);
  assert.equal(unscoped.lastActivityAt, T + 100, "the sessionId-less record DOES count when unfiltered");
});

// ---------------------------------------------------------------------------
// applyEvent: top-level lastActivityAt (live Runtime incremental path)
// ---------------------------------------------------------------------------
// Guards a dead-code regression: the live Runtime builds state via
// initialWorldState() + applyEvent() (NOT computeStateFromRecords, which is
// only used for the session-scoped "Delegation Health" rebuild). Before this
// fix, applyEvent never touched the top-level lastActivityAt, so on the
// actual production path it stayed undefined forever and media/main.js's
// "plan stalled" advisory could never fire. This mirrors the
// computeStateFromRecords lastActivityAt tests above, but drives the OTHER
// public entry point every other applyEvent-based test in this repo uses
// (see test/providerState.test.ts, test/agentRoster.test.ts).

test("applyEvent: lastActivityAt is null before any event is applied", () => {
  const state = initialWorldState();
  assert.equal(state.lastActivityAt, null);
});

test("applyEvent: lastActivityAt tracks the max `at` across a mixed-order sequence of events", () => {
  let state = initialWorldState();
  state = applyEvent(state, { type: "SessionStart", at: T });
  assert.equal(state.lastActivityAt, T);
  state = applyEvent(state, { type: "WorkerSpawned", at: T + 50, workerId: "w-1" });
  assert.equal(state.lastActivityAt, T + 50);
  // An earlier-timestamped event must not roll the running max backwards.
  state = applyEvent(state, { type: "WorkerActivity", at: T + 10, workerId: "w-1", kind: "build" });
  assert.equal(state.lastActivityAt, T + 50, "an earlier `at` must not decrease the running max");
  state = applyEvent(state, { type: "TaskCompleted", at: T + 200, workerId: "w-1" });
  assert.equal(state.lastActivityAt, T + 200, "a later `at` must advance the running max");
});

test("applyEvent: lastActivityAt updates on ProviderError too, not just the agent-specific branches", () => {
  const state = applyEvent(initialWorldState(), {
    type: "ProviderError",
    at: T + 999,
    workerId: "w-err",
    message: "oops",
  });
  assert.equal(state.lastActivityAt, T + 999, "every event type must refresh lastActivityAt, not just a subset");
});
