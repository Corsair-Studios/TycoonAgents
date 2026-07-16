/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  gradeClaudeMd,
  gradeAgent,
  buildContextBudget,
} from "../src/host/vscode/contextBudget";

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

test("estimateTokens: empty string -> 0", () => {
  assert.equal(estimateTokens(""), 0);
});

test("estimateTokens: 4-char string -> 1", () => {
  assert.equal(estimateTokens("abcd"), 1);
});

test("estimateTokens: 5-char string -> 2", () => {
  assert.equal(estimateTokens("abcde"), 2);
});

// ---------------------------------------------------------------------------
// gradeClaudeMd
// ---------------------------------------------------------------------------

test("gradeClaudeMd: 1999 -> ok", () => {
  assert.equal(gradeClaudeMd(1999), "ok");
});

test("gradeClaudeMd: 2000 -> warn", () => {
  assert.equal(gradeClaudeMd(2000), "warn");
});

test("gradeClaudeMd: 3999 -> warn", () => {
  assert.equal(gradeClaudeMd(3999), "warn");
});

test("gradeClaudeMd: 4000 -> high", () => {
  assert.equal(gradeClaudeMd(4000), "high");
});

// ---------------------------------------------------------------------------
// gradeAgent
// ---------------------------------------------------------------------------

test("gradeAgent: 1499 -> ok", () => {
  assert.equal(gradeAgent(1499), "ok");
});

test("gradeAgent: 1500 -> warn", () => {
  assert.equal(gradeAgent(1500), "warn");
});

test("gradeAgent: a large reference agent (~2500 tokens) -> warn, not high", () => {
  assert.equal(gradeAgent(2500), "warn");
});

test("gradeAgent: 3999 -> warn", () => {
  assert.equal(gradeAgent(3999), "warn");
});

test("gradeAgent: 4000 -> high", () => {
  assert.equal(gradeAgent(4000), "high");
});

// ---------------------------------------------------------------------------
// buildContextBudget
// ---------------------------------------------------------------------------

test("buildContextBudget: null claudeMd, empty agents -> perPromptTokens=0, agentsTotalTokens=0, overall=ok, claudeMd=null", () => {
  const budget = buildContextBudget(null, []);
  assert.equal(budget.claudeMd, null);
  assert.equal(budget.perPromptTokens, 0);
  assert.equal(budget.agentsTotalTokens, 0);
  assert.equal(budget.overall, "ok");
  assert.deepEqual(budget.agents, []);
});

test("buildContextBudget: claudeMd with >=4000 tokens (16000 chars) -> overall=high, perPromptTokens>0", () => {
  const bigContent = "x".repeat(16000); // 16000 / 4 = 4000 tokens -> high
  const budget = buildContextBudget(bigContent, []);
  assert.ok(budget.perPromptTokens > 0, "perPromptTokens must be positive");
  assert.equal(budget.overall, "high");
  assert.ok(budget.claudeMd !== null);
  assert.equal(budget.claudeMd!.grade, "high");
});

test("buildContextBudget: null claudeMd, one high-grade agent -> overall=high", () => {
  // 4000 tokens -> high grade: 4000 * 4 = 16000 chars
  const highAgentContent = "a".repeat(16000);
  const budget = buildContextBudget(null, [{ name: "heavy-agent.md", content: highAgentContent }]);
  assert.equal(budget.overall, "high");
  assert.equal(budget.agents[0].grade, "high");
});

test("buildContextBudget: null claudeMd, mixed agents (ok + warn) -> overall=warn", () => {
  // ok agent: <1500 tokens = <6000 chars
  const okContent = "a".repeat(100);
  // warn agent: >=1500 and <4000 tokens = >=6000 and <16000 chars
  const warnContent = "b".repeat(8000); // 8000 / 4 = 2000 tokens -> warn
  const budget = buildContextBudget(null, [
    { name: "small-agent.md", content: okContent },
    { name: "medium-agent.md", content: warnContent },
  ]);
  assert.equal(budget.overall, "warn");
});

test("buildContextBudget: claudeMd (warn grade) + high-grade agent -> overall uses claudeMd grade (warn)", () => {
  // warn claudeMd: >=2000 and <4000 tokens = >=8000 and <16000 chars
  const warnClaudeMd = "c".repeat(10000); // 10000 / 4 = 2500 tokens -> warn
  // high agent: >=4000 tokens = >=16000 chars
  const highAgentContent = "d".repeat(16000); // 16000 / 4 = 4000 tokens -> high
  const budget = buildContextBudget(warnClaudeMd, [{ name: "heavy-agent.md", content: highAgentContent }]);
  assert.equal(budget.overall, "warn", "overall must follow claudeMd grade, not worst agent grade");
  assert.equal(budget.claudeMd!.grade, "warn");
  assert.equal(budget.agents[0].grade, "high");
});
