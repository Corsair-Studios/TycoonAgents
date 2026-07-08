/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentMarkdown } from "../src/providers/claude-code/agentRoster";
import { applyEvent, initialWorldState } from "../src/core/state";

const T = 1700000000000;

test("parseAgentMarkdown extracts model, name (H1), and Role description", () => {
  const md = [
    "---",
    "model: claude-sonnet-4-6",
    "---",
    "",
    "# Coding Specialist",
    "",
    "## Role",
    "You handle core implementation for TycoonAgents.",
  ].join("\n");
  const agent = parseAgentMarkdown("coding-specialist", md);
  assert.equal(agent.id, "coding-specialist");
  assert.equal(agent.name, "Coding Specialist");
  assert.equal(agent.model, "claude-sonnet-4-6");
  assert.equal(agent.description, "You handle core implementation for TycoonAgents.");
});

test("parseAgentMarkdown falls back to title-cased id when no H1 present", () => {
  const agent = parseAgentMarkdown("search-retrieval", "---\nmodel: claude-haiku-4-5\n---\n");
  assert.equal(agent.name, "Search Retrieval");
  assert.equal(agent.model, "claude-haiku-4-5");
  assert.equal(agent.description, undefined);
});

test("WorkerRegistered seeds an idle metric with zero stats", () => {
  const s = applyEvent(initialWorldState(), {
    type: "WorkerRegistered",
    at: T,
    workerId: "ux-ui-designer",
    name: "UX/UI Designer",
    model: "claude-sonnet-4-6",
    description: "Designs the canvas scene.",
  });
  assert.equal(s.agentMetrics.length, 1);
  const m = s.agentMetrics[0];
  assert.equal(m.id, "ux-ui-designer");
  assert.equal(m.name, "UX/UI Designer");
  assert.equal(m.status, "idle");
  assert.equal(m.taskCount, 0);
  assert.equal(m.tokens, 0);
  assert.equal(m.activeMs, 0);
});

test("WorkerRegistered does not reactivate or reset an already-active agent's stats", () => {
  let s = initialWorldState();
  // Agent does real work first.
  s = applyEvent(s, { type: "WorkerSpawned", at: T, workerId: "coding-specialist", role: "Task" });
  s = applyEvent(s, { type: "WorkerStopped", at: T + 5000, workerId: "coding-specialist", tokens: 1200 });
  // Late registration (e.g. roster seed) must not clobber accumulated stats.
  s = applyEvent(s, {
    type: "WorkerRegistered",
    at: T + 6000,
    workerId: "coding-specialist",
    name: "Coding Specialist",
    model: "claude-sonnet-4-6",
  });
  const m = s.agentMetrics.find((x) => x.id === "coding-specialist");
  assert.ok(m);
  assert.equal(m!.status, "idle");
  assert.equal(m!.tokens, 1200);
  assert.equal(m!.model, "claude-sonnet-4-6");
});
