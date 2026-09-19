/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * p68-t3: unit tests for src/core/keywordHealth.ts — computeKeywordHealth,
 * normalizeAgentKeywords, computeWildcardStats — plus the KEYWORD_HEALTH_FIX
 * zod schema in src/host/vscode/messages.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeKeywordHealth,
  normalizeAgentKeywords,
  computeWildcardStats,
  type WildcardTaskRecord,
} from "../src/core/keywordHealth";
import type { ReconcileAgentInput } from "../src/host/vscode/agentKeywordDefaults";
import { MSG_SCHEMAS } from "../src/host/vscode/messages";

const noDefaults: Record<string, string> = {};

function agents(...ids: string[]): ReconcileAgentInput[] {
  return ids.map((id) => ({ id, keywords: "" }));
}

// ---- computeKeywordHealth: one test per finding kind -----------------------

test("computeKeywordHealth: no_keywords when an agent has an empty pattern and no default/body fallback", () => {
  const config = { agents: { "coding-specialist": { pattern: "" } } };
  const findings = computeKeywordHealth(agents("coding-specialist"), config, noDefaults);
  assert.ok(findings.some((f) => f.kind === "no_keywords" && f.agentId === "coding-specialist"));
});

test("computeKeywordHealth: dangling_ref for a config entry with no matching agent file", () => {
  const config = { agents: { "ghost-agent": { pattern: "ghost" } } };
  const findings = computeKeywordHealth(agents("coding-specialist"), config, noDefaults);
  const f = findings.find((x) => x.kind === "dangling_ref");
  assert.ok(f, "expected a dangling_ref finding");
  assert.equal(f!.agentId, "ghost-agent");
  assert.equal(f!.fix?.kind, "reconcile");
});

test("computeKeywordHealth: pending_reconcile for a roster agent missing from config", () => {
  const config = { agents: {} };
  const findings = computeKeywordHealth(agents("coding-specialist"), config, { "coding-specialist": "code|fix" });
  const f = findings.find((x) => x.kind === "pending_reconcile");
  assert.ok(f, "expected a pending_reconcile finding");
  assert.equal(f!.agentId, "coding-specialist");
});

test("computeKeywordHealth: multi_word_segment for a short whitespace segment (<= 3 words)", () => {
  const config = { agents: { "coding-specialist": { pattern: "code|bug fix" } } };
  const findings = computeKeywordHealth(agents("coding-specialist"), config, noDefaults);
  const f = findings.find((x) => x.kind === "multi_word_segment");
  assert.ok(f, "expected a multi_word_segment finding");
  assert.equal(f!.fix?.kind, "split_segment");
});

test("computeKeywordHealth: prose_pattern for a long/malformed legacy segment (modeled on an actual prose sentence)", () => {
  const proseSentence =
    "you write clean focused tested code and should be routed whenever the user mentions implementation work";
  const config = { agents: { "coding-specialist": { pattern: proseSentence } } };
  const findings = computeKeywordHealth(agents("coding-specialist"), config, noDefaults);
  const f = findings.find((x) => x.kind === "prose_pattern");
  assert.ok(f, "expected a prose_pattern finding for a malformed legacy prose entry");
  assert.equal(f!.fix?.kind, "drop_segment");
});

test("computeKeywordHealth: duplicate_keyword — first agent in object order wins", () => {
  const config = {
    agents: {
      "coding-specialist": { pattern: "implement|fix" },
      "testing-specialist": { pattern: "test|fix" },
    },
  };
  const findings = computeKeywordHealth(agents("coding-specialist", "testing-specialist"), config, noDefaults);
  const f = findings.find((x) => x.kind === "duplicate_keyword");
  assert.ok(f, "expected a duplicate_keyword finding");
  assert.equal(f!.agentId, "coding-specialist", "first entry in config object order should win ties");
  assert.match(f!.detail, /"fix"/);
});

test("computeKeywordHealth: wildcard_first when primary-agent is listed before a later specialist", () => {
  const config = {
    agents: {
      "primary-agent": { pattern: "task" },
      "coding-specialist": { pattern: "implement" },
    },
  };
  const findings = computeKeywordHealth(agents("primary-agent", "coding-specialist"), config, noDefaults);
  const f = findings.find((x) => x.kind === "wildcard_first");
  assert.ok(f, "expected a wildcard_first finding");
  assert.equal(f!.agentId, "primary-agent");
  assert.equal(f!.fix?.kind, "reorder");
});

test("computeKeywordHealth: no wildcard_first when primary-agent is already last", () => {
  const config = {
    agents: {
      "coding-specialist": { pattern: "implement" },
      "primary-agent": { pattern: "task" },
    },
  };
  const findings = computeKeywordHealth(agents("coding-specialist", "primary-agent"), config, noDefaults);
  assert.ok(!findings.some((x) => x.kind === "wildcard_first"));
});

// ---- normalizeAgentKeywords -------------------------------------------------

test("normalizeAgentKeywords: fixes a malformed legacy entry (prose pattern, multi-word segment, dupes, wildcard order)", () => {
  const proseSentence =
    "you write clean focused tested code and should be routed whenever the user mentions implementation work";
  const config = {
    agents: {
      "primary-agent": { pattern: "task" },
      "coding-specialist": { pattern: `${proseSentence}|implement|bug fix|implement` },
    },
  };
  const { config: fixed, changed } = normalizeAgentKeywords(
    config,
    agents("primary-agent", "coding-specialist"),
    noDefaults
  );
  assert.equal(changed, true);
  const codingPattern: string = fixed.agents["coding-specialist"].pattern;
  assert.ok(!codingPattern.includes(" "), "no whitespace segments should survive normalization");
  assert.ok(!codingPattern.toLowerCase().includes(proseSentence.split(" ")[0]), "prose segment dropped");
  const tokens = codingPattern.split("|").filter(Boolean);
  assert.equal(new Set(tokens.map((t) => t.toLowerCase())).size, tokens.length, "no duplicate tokens");
  assert.deepEqual(Object.keys(fixed.agents).slice(-1), ["primary-agent"], "primary-agent moved last");
});

test("normalizeAgentKeywords: idempotent — a second run on its own output makes no further changes", () => {
  const config = {
    agents: {
      "primary-agent": { pattern: "task" },
      "coding-specialist": { pattern: "implement|bug fix|implement|code" },
    },
  };
  const roster = agents("primary-agent", "coding-specialist");
  const first = normalizeAgentKeywords(config, roster, noDefaults);
  assert.equal(first.changed, true);
  const second = normalizeAgentKeywords(first.config, roster, noDefaults);
  assert.equal(second.changed, false, "second run should report no change");
  assert.deepEqual(second.config, first.config, "second run's output should be byte-identical to the first");
});

test("normalizeAgentKeywords: seeds a missing entry from defaults", () => {
  const config = { agents: {} };
  const roster = agents("coding-specialist");
  const { config: fixed } = normalizeAgentKeywords(config, roster, { "coding-specialist": "implement|code|fix" });
  assert.equal(fixed.agents["coding-specialist"].pattern, "implement|code|fix");
});

// ---- computeWildcardStats ---------------------------------------------------

test("computeWildcardStats: counts only primary-agent spawns with routingMethod 'keyword' and surfaces unmatched, non-stopword tokens", () => {
  const known = new Set(["implement", "code"]);
  const records: WildcardTaskRecord[] = [
    { workerId: "primary-agent", routingMethod: "keyword", description: "deploy the new release pipeline" },
    { workerId: "primary-agent", routingMethod: "keyword", description: "deploy again with the release notes" },
    { workerId: "primary-agent", routingMethod: "semantic", description: "deploy something" }, // wrong method
    { workerId: "coding-specialist", routingMethod: "keyword", description: "deploy" }, // wrong worker
    { workerId: "primary-agent", routingMethod: "keyword", description: "implement code changes" }, // all known/stopwords-ish
  ];
  const stats = computeWildcardStats(records, known, 5);
  assert.equal(stats.wildcardTasksThisSession, 3, "only primary-agent + keyword routingMethod records count");
  assert.ok(stats.unmatchedWords.includes("deploy"), "deploy should surface as an unmatched token");
  assert.ok(!stats.unmatchedWords.includes("the"), "stopwords are excluded");
  assert.ok(!stats.unmatchedWords.includes("implement"), "already-known tokens are excluded");
});

test("computeWildcardStats: respects the limit parameter", () => {
  const known = new Set<string>();
  const records: WildcardTaskRecord[] = [
    { workerId: "primary-agent", routingMethod: "keyword", description: "alpha beta gamma delta epsilon" },
  ];
  const stats = computeWildcardStats(records, known, 2);
  assert.equal(stats.unmatchedWords.length, 2);
});

// ---- KEYWORD_HEALTH_FIX schema (messages.ts) -------------------------------

test("KEYWORD_HEALTH_FIX schema: accepts fix_all and a well-formed add", () => {
  const schema = MSG_SCHEMAS.KEYWORD_HEALTH_FIX;
  assert.doesNotThrow(() => schema.parse({ action: "fix_all" }));
  assert.doesNotThrow(() => schema.parse({ action: "add", agentId: "coding-specialist", token: "implement" }));
});

test("KEYWORD_HEALTH_FIX schema: rejects a bad agentId (uppercase/invalid chars) and a bad token", () => {
  const schema = MSG_SCHEMAS.KEYWORD_HEALTH_FIX;
  assert.throws(() => schema.parse({ action: "add", agentId: "Coding Specialist!", token: "implement" }));
  assert.throws(() => schema.parse({ action: "add", agentId: "coding-specialist", token: "has spaces" }));
  assert.throws(() => schema.parse({ action: "add", agentId: "coding-specialist", token: "TOO".repeat(20) }));
});
