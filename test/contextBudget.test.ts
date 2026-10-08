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
  stripManagedBlocks,
  TRIM_REVIEW_THRESHOLDS,
  TRIM_REVIEW_DISABLED_TIP,
  TRIM_REVIEW_PROMPT,
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

test("gradeClaudeMd: 7999 -> ok", () => {
  assert.equal(gradeClaudeMd(7999), "ok");
});

test("gradeClaudeMd: 8000 -> warn", () => {
  assert.equal(gradeClaudeMd(8000), "warn");
});

test("gradeClaudeMd: 15999 -> warn", () => {
  assert.equal(gradeClaudeMd(15999), "warn");
});

test("gradeClaudeMd: 16000 -> high", () => {
  assert.equal(gradeClaudeMd(16000), "high");
});

// ---------------------------------------------------------------------------
// gradeAgent
// ---------------------------------------------------------------------------

test("gradeAgent: 1999 -> ok", () => {
  assert.equal(gradeAgent(1999), "ok");
});

test("gradeAgent: 2000 -> warn", () => {
  assert.equal(gradeAgent(2000), "warn");
});

test("gradeAgent: a large reference agent (~5800 tokens) -> high, not a defect (UI labels it intentionally large)", () => {
  assert.equal(gradeAgent(5800), "high");
});

test("gradeAgent: 3999 -> warn", () => {
  assert.equal(gradeAgent(3999), "warn");
});

test("gradeAgent: 4000 -> high", () => {
  assert.equal(gradeAgent(4000), "high");
});

// ---------------------------------------------------------------------------
// Two-scale divergence: CLAUDE.md and agent files are graded on different
// scales on purpose (CLAUDE.md carries the doctrine and is loaded every
// prompt; agent files should stay small and focused).
// ---------------------------------------------------------------------------

test("gradeClaudeMd vs gradeAgent: same token count (~5000) grades differently -- CLAUDE.md ok, agent high", () => {
  assert.equal(gradeClaudeMd(5000), "ok");
  assert.equal(gradeAgent(5000), "high");
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

test("buildContextBudget: claudeMd with >=16000 tokens (64000 chars) -> overall=high, perPromptTokens>0", () => {
  const bigContent = "x".repeat(64000); // 64000 / 4 = 16000 tokens -> high
  const budget = buildContextBudget(bigContent, []);
  assert.ok(budget.perPromptTokens > 0, "perPromptTokens must be positive");
  assert.equal(budget.overall, "high");
  assert.ok(budget.claudeMd !== null);
  assert.equal(budget.claudeMd!.grade, "high");
});

test("buildContextBudget: null claudeMd, one high-grade agent -> overall=high", () => {
  // 4000 tokens -> high grade (agent scale): 4000 * 4 = 16000 chars
  const highAgentContent = "a".repeat(16000);
  const budget = buildContextBudget(null, [{ name: "heavy-agent.md", content: highAgentContent }]);
  assert.equal(budget.overall, "high");
  assert.equal(budget.agents[0].grade, "high");
});

test("buildContextBudget: null claudeMd, mixed agents (ok + warn) -> overall=warn", () => {
  // ok agent: <2000 tokens = <8000 chars (agent scale)
  const okContent = "a".repeat(100);
  // warn agent: >=2000 and <4000 tokens = >=8000 and <16000 chars (agent scale)
  const warnContent = "b".repeat(10000); // 10000 / 4 = 2500 tokens -> warn
  const budget = buildContextBudget(null, [
    { name: "small-agent.md", content: okContent },
    { name: "medium-agent.md", content: warnContent },
  ]);
  assert.equal(budget.overall, "warn");
});

test("buildContextBudget: claudeMd (warn grade) + high-grade agent -> overall uses claudeMd grade (warn)", () => {
  // warn claudeMd: >=8000 and <16000 tokens = >=32000 and <64000 chars (CLAUDE.md's own, higher scale)
  const warnClaudeMd = "c".repeat(40000); // 40000 / 4 = 10000 tokens -> warn
  // high agent: >=4000 tokens = >=16000 chars (agent's tighter scale)
  const highAgentContent = "d".repeat(16000); // 16000 / 4 = 4000 tokens -> high
  const budget = buildContextBudget(warnClaudeMd, [{ name: "heavy-agent.md", content: highAgentContent }]);
  assert.equal(budget.overall, "warn", "overall must follow claudeMd grade, not worst agent grade");
  assert.equal(budget.claudeMd!.grade, "warn");
  assert.equal(budget.agents[0].grade, "high");
});

// ---------------------------------------------------------------------------
// trimReview gate ("Review for trimming" button)
// ---------------------------------------------------------------------------

import { upsertDelegationSection } from "../src/host/vscode/delegationDoctrine";
import { REGULAR_AGENTS, buildAgentMarkdown } from "../src/host/vscode/packCatalog";

test("trimReview: fresh install fixture (managed block + pack agents) is disabled", () => {
  const claudeMd = upsertDelegationSection("# Project\n", "x".repeat(40000));
  const agents = REGULAR_AGENTS.map((a) => ({ name: `${a.id}.md`, content: buildAgentMarkdown(a, "core") }));
  const small = upsertDelegationSection("# Project\n", "x".repeat(8000));
  const budget = buildContextBudget(small, agents);
  assert.ok(budget.perPromptTokens < TRIM_REVIEW_THRESHOLDS.perPromptTokens);
  assert.equal(budget.trimReview.enabled, false);
  assert.equal(budget.trimReview.tip, TRIM_REVIEW_DISABLED_TIP);
});

test("trimReview: no CLAUDE.md and no agents -> disabled", () => {
  assert.equal(buildContextBudget(null, []).trimReview.enabled, false);
});

test("trimReview: large user section outside managed blocks -> enabled", () => {
  const base = upsertDelegationSection("# Project\n", "managed body");
  const withUser = base + "\n" + "my own long notes. ".repeat(500);
  const budget = buildContextBudget(withUser, []);
  assert.ok(budget.trimReview.userClaudeMdTokens > TRIM_REVIEW_THRESHOLDS.userClaudeMdTokens);
  assert.equal(budget.trimReview.enabled, true);
});

test("trimReview: per-prompt total above the high bar -> enabled", () => {
  const big = upsertDelegationSection("", "m".repeat((TRIM_REVIEW_THRESHOLDS.perPromptTokens + 100) * 4));
  assert.equal(buildContextBudget(big, []).trimReview.enabled, true);
});

test("trimReview: pack agent with user additions -> enabled; unmarked agent ignored", () => {
  const def = REGULAR_AGENTS[0];
  const marked = buildAgentMarkdown(def, "core") + "\n## My notes\n" + "extra guidance. ".repeat(400);
  assert.equal(buildContextBudget(null, [{ name: `${def.id}.md`, content: marked }]).trimReview.enabled, true);
  const unmarked = "---\nname: " + def.id + "\n---\n" + "extra guidance. ".repeat(400);
  assert.equal(buildContextBudget(null, [{ name: `${def.id}.md`, content: unmarked }]).trimReview.enabled, false);
});

test("stripManagedBlocks removes tycoon:* blocks only", () => {
  const out = stripManagedBlocks("a\n<!-- tycoon:delegation -->\nX\n<!-- /tycoon:delegation -->\nb");
  assert.equal(out.replace(/\s+/g, ""), "ab");
});

test("trim review prompt carries the protection clause and approval gate", () => {
  assert.match(TRIM_REVIEW_PROMPT, /Do not modify[\s\S]*managed block/);
  assert.match(TRIM_REVIEW_PROMPT, /delegation/);
  assert.match(TRIM_REVIEW_PROMPT, /OWN additions/);
  assert.match(TRIM_REVIEW_PROMPT, /Do NOT edit any file directly[\s\S]*approval/);
  assert.equal(buildContextBudget(null, []).trimReview.prompt, TRIM_REVIEW_PROMPT);
});

test("stripManagedBlocks: orphan open marker strips to EOF", () => {
  assert.equal(stripManagedBlocks("keep\n<!-- tycoon:delegation -->\nno close").trim(), "keep");
  const damaged = "<!-- tycoon:delegation -->\n" + "z".repeat(20000);
  assert.equal(buildContextBudget(damaged, []).trimReview.userClaudeMdTokens, 0);
});

test("trimReview: frontmatter growth never counts; per-file not summed", () => {
  const def = REGULAR_AGENTS[0];
  const fm = buildAgentMarkdown(def, "core").replace("---\n", "---\nbackend:\n  note: " + "r".repeat(8000) + "\n");
  assert.equal(buildContextBudget(null, [{ name: `${def.id}.md`, content: fm }]).trimReview.enabled, false);
  const many = REGULAR_AGENTS.slice(0, 4).map((a) => ({
    name: `${a.id}.md`,
    content: buildAgentMarkdown(a, "core") + "\n" + "y".repeat(1200),
  }));
  assert.equal(buildContextBudget(null, many).trimReview.enabled, false);
});
