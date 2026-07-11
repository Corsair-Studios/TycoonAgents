/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStateFromRecords } from "../src/core/state";
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
