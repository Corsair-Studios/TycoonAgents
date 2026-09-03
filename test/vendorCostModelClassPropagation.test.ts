/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for vendor/costModelClass propagation into AgentMetric
// (src/core/state.ts's WorkerActivity branch, ~475-476): once a hook record
// reports vendor+costModelClass for an agent, that agent's metric must keep
// carrying them even when a LATER activity record for the same agent omits
// both fields — `event.vendor ?? m.vendor` / `event.costModelClass ??
// m.costModelClass` must never let an absent field on one event blank out a
// value a prior event already established.
//
// test/state.test.ts is left untouched per task scope; this is a new,
// separate file using the same computeStateFromRecords/HookRecord technique
// that file already establishes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStateFromRecords } from "../src/core/state";
import type { HookRecord } from "../src/providers/claude-code/hookRecord";
import type { AgentMetric } from "../src/core/state";

const T = 1700000000000;

function metric(agentMetrics: AgentMetric[], id: string): AgentMetric | undefined {
  return agentMetrics.find((m) => m.id === id);
}

test("vendor/costModelClass from a mcp__ WorkerActivity record propagate into agentMetrics", () => {
  const records: HookRecord[] = [
    {
      event: "PreToolUse",
      tool: "mcp__codex__codex",
      workerId: "codex-reviewer",
      model: "openai/gpt-5.4-mini",
      vendor: "openai",
      costModelClass: "subscription",
      sessionId: "S1",
      at: T,
    },
  ];
  const state = computeStateFromRecords(records);
  const m = metric(state.agentMetrics, "codex-reviewer");
  assert.ok(m, "expected an agentMetrics entry for codex-reviewer");
  assert.equal(m!.vendor, "openai");
  assert.equal(m!.costModelClass, "subscription");
});

test("vendor/costModelClass set by an earlier event are NOT overwritten by a later event that omits them", () => {
  const records: HookRecord[] = [
    {
      event: "PreToolUse",
      tool: "mcp__codex__codex",
      workerId: "codex-reviewer",
      model: "openai/gpt-5.4-mini",
      vendor: "openai",
      costModelClass: "subscription",
      sessionId: "S1",
      at: T,
    },
    // A later activity record for the SAME agent that carries no
    // vendor/costModelClass at all (e.g. a plain Read the agent also makes).
    {
      event: "PreToolUse",
      tool: "Read",
      workerId: "codex-reviewer",
      sessionId: "S1",
      at: T + 1,
    },
  ];
  const state = computeStateFromRecords(records);
  const m = metric(state.agentMetrics, "codex-reviewer");
  assert.ok(m, "expected an agentMetrics entry for codex-reviewer");
  assert.equal(m!.vendor, "openai", "vendor must survive a later event that omits it");
  assert.equal(m!.costModelClass, "subscription", "costModelClass must survive a later event that omits it");
});

test("an agent that never reports vendor/costModelClass keeps both undefined (no fabricated values)", () => {
  const records: HookRecord[] = [
    { event: "PreToolUse", tool: "Edit", workerId: "coding-specialist", sessionId: "S1", at: T },
  ];
  const state = computeStateFromRecords(records);
  const m = metric(state.agentMetrics, "coding-specialist");
  assert.ok(m);
  assert.equal(m!.vendor, undefined);
  assert.equal(m!.costModelClass, undefined);
});

test("vendor/costModelClass carried on a Task PreToolUse (WorkerSpawned) alone propagate into agentMetrics, with no WorkerActivity in between", () => {
  const records: HookRecord[] = [
    {
      event: "PreToolUse",
      tool: "Task",
      workerId: "codex-reviewer",
      model: "openai/gpt-5.4-mini",
      vendor: "openai",
      costModelClass: "subscription",
      sessionId: "S1",
      at: T,
    },
    {
      event: "SubagentStop",
      workerId: "codex-reviewer",
      sessionId: "S1",
      at: T + 1,
    },
  ];
  const state = computeStateFromRecords(records);
  const m = metric(state.agentMetrics, "codex-reviewer");
  assert.ok(m, "expected an agentMetrics entry for codex-reviewer");
  assert.equal(m!.vendor, "openai");
  assert.equal(m!.costModelClass, "subscription");
  assert.equal(m!.model, "openai/gpt-5.4-mini");
});
