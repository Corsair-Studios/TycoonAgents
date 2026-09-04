/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Unit coverage for every pure export of src/core/delegationEnforcement.ts
 * (plan task p14-t3). These are the algorithms shared verbatim by
 * hooks/tycoon-claude-hook.cjs and hooks/tycoon-opencode-plugin.ts — parity
 * with the hook's own inline copies is covered separately by
 * test/enforcementParity.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchAgentFromKeywords,
  decideDirectToolCall,
  decideSpawn,
  LEAF_WORKER_DENY_MESSAGE,
  startReviewGate,
  advanceReviewGate,
  isReviewGateTerminal,
  decideToolCall,
} from "../src/core/delegationEnforcement";

const KEYWORDS = {
  fallback_agent: "primary-agent",
  agents: {
    "search-retrieval": { pattern: "search|find|grep|glob" },
    "coding-specialist": { pattern: "implement|code|fix|bug" },
    "testing-specialist": { pattern: "test|spec|coverage" },
  },
};

// ---------------------------------------------------------------------------
// matchAgentFromKeywords
// ---------------------------------------------------------------------------

test("matchAgentFromKeywords: single keyword match resolves to its agent", () => {
  const m = matchAgentFromKeywords("please fix this bug", KEYWORDS);
  assert.ok(m);
  assert.equal(m!.agentId, "coding-specialist");
  assert.equal(m!.matchedKeyword, "fix");
});

test("matchAgentFromKeywords: tie-break picks the FIRST agent to reach the highest score (insertion order), not a later equal score", () => {
  // "search" scores search-retrieval 1; "test" scores testing-specialist 1.
  // Both tie at score 1 -> the strictly-greater-than comparison keeps the
  // first (earlier-inserted) winner rather than overwriting on a tie.
  const m = matchAgentFromKeywords("search and test", KEYWORDS);
  assert.ok(m);
  assert.equal(m!.agentId, "search-retrieval");
});

test("matchAgentFromKeywords: higher keyword-hit count wins over a single hit", () => {
  const m = matchAgentFromKeywords("search find grep and one bug", KEYWORDS);
  assert.ok(m);
  assert.equal(m!.agentId, "search-retrieval", "3 hits (search, find, grep) beats 1 hit (bug)");
});

test("matchAgentFromKeywords: matching is case-insensitive and punctuation-insensitive", () => {
  const m = matchAgentFromKeywords("Please FIX/this-BUG!!", KEYWORDS);
  assert.ok(m);
  assert.equal(m!.agentId, "coding-specialist");
});

test("matchAgentFromKeywords: no keyword present returns null", () => {
  assert.equal(matchAgentFromKeywords("nothing relevant here", KEYWORDS), null);
});

test("matchAgentFromKeywords: null/undefined config returns null without throwing", () => {
  assert.equal(matchAgentFromKeywords("fix the bug", null), null);
  assert.equal(matchAgentFromKeywords("fix the bug", undefined), null);
  assert.equal(matchAgentFromKeywords("fix the bug", {}), null);
});

test("matchAgentFromKeywords: word-boundary aware — a substring inside another word does not count as a hit", () => {
  // "testing" contains "test" as a substring, but the word-split matcher
  // only matches whole tokens, so it must NOT score testing-specialist.
  const m = matchAgentFromKeywords("we are contesting the outcome", KEYWORDS);
  assert.equal(m, null);
});

// ---------------------------------------------------------------------------
// decideDirectToolCall
// ---------------------------------------------------------------------------

test("decideDirectToolCall: Grep always nudges toward search-retrieval", () => {
  const d = decideDirectToolCall("Grep", 0);
  assert.equal(d.action, "nudge");
  assert.ok(d.message!.includes("search-retrieval"));
});

test("decideDirectToolCall: Glob always nudges toward search-retrieval", () => {
  const d = decideDirectToolCall("Glob", 5);
  assert.equal(d.action, "nudge");
  assert.ok(d.message!.includes("search-retrieval"));
});

test("decideDirectToolCall: Edit always nudges toward coding-specialist", () => {
  const d = decideDirectToolCall("Edit", 0);
  assert.equal(d.action, "nudge");
  assert.ok(d.message!.includes("coding-specialist"));
});

test("decideDirectToolCall: Write always nudges toward coding-specialist", () => {
  const d = decideDirectToolCall("Write", 0);
  assert.equal(d.action, "nudge");
  assert.ok(d.message!.includes("coding-specialist"));
});

test("decideDirectToolCall: Read #1 and #2 (readCountSoFar 0,1) stay silent (allow), returning the incremented count", () => {
  const r1 = decideDirectToolCall("Read", 0);
  assert.equal(r1.action, "allow");
  assert.equal(r1.nextReadCount, 1);

  const r2 = decideDirectToolCall("Read", 1);
  assert.equal(r2.action, "allow");
  assert.equal(r2.nextReadCount, 2);
});

test("decideDirectToolCall: Read #3 (readCountSoFar 2 -> nextCount 3) crosses the threshold and nudges", () => {
  const r3 = decideDirectToolCall("Read", 2);
  assert.equal(r3.action, "nudge");
  assert.equal(r3.nextReadCount, 3);
  assert.ok(r3.message!.includes("3 direct reads"));
  assert.ok(r3.message!.includes("search-retrieval"));
});

test("decideDirectToolCall: Read #4+ keeps nudging with the growing count", () => {
  const r4 = decideDirectToolCall("Read", 3);
  assert.equal(r4.action, "nudge");
  assert.equal(r4.nextReadCount, 4);
  assert.ok(r4.message!.includes("4 direct reads"));
});

test("decideDirectToolCall: an unrecognized tool (e.g. Bash) always allows with no message", () => {
  const d = decideDirectToolCall("Bash", 10);
  assert.deepEqual(d, { action: "allow" });
});

// ---------------------------------------------------------------------------
// decideSpawn / LEAF_WORKER_DENY_MESSAGE
// ---------------------------------------------------------------------------

test("decideSpawn: empty spawnerAgentId (orchestrator itself) is always allowed", () => {
  const d = decideSpawn({ spawnerAgentId: "", spawnerAgentType: "", delegationMode: "flat", spawnerIsLead: false });
  assert.deepEqual(d, { action: "allow" });
});

test("decideSpawn: a leaf worker (non-empty spawnerAgentId) in flat mode is denied with the exact LEAF_WORKER_DENY_MESSAGE", () => {
  const d = decideSpawn({
    spawnerAgentId: "spawned-worker-uuid",
    spawnerAgentType: "coding-specialist",
    delegationMode: "flat",
    spawnerIsLead: false,
  });
  assert.equal(d.action, "deny");
  assert.equal(d.message, LEAF_WORKER_DENY_MESSAGE);
});

test("decideSpawn: a worker in team_leads mode but NOT tier:lead is still denied", () => {
  const d = decideSpawn({
    spawnerAgentId: "spawned-worker-uuid",
    spawnerAgentType: "coding-specialist",
    delegationMode: "team_leads",
    spawnerIsLead: false,
  });
  assert.equal(d.action, "deny");
  assert.equal(d.message, LEAF_WORKER_DENY_MESSAGE);
});

test("decideSpawn: a tier:lead spawner in team_leads mode is allowed", () => {
  const d = decideSpawn({
    spawnerAgentId: "build-lead-uuid",
    spawnerAgentType: "build-lead",
    delegationMode: "team_leads",
    spawnerIsLead: true,
  });
  assert.deepEqual(d, { action: "allow" });
});

test("decideSpawn: a tier:lead spawner in FLAT mode (not team_leads) is still denied — mode gates the lead exception", () => {
  const d = decideSpawn({
    spawnerAgentId: "build-lead-uuid",
    spawnerAgentType: "build-lead",
    delegationMode: "flat",
    spawnerIsLead: true,
  });
  assert.equal(d.action, "deny");
  assert.equal(d.message, LEAF_WORKER_DENY_MESSAGE);
});

// ---------------------------------------------------------------------------
// Review gate: startReviewGate / advanceReviewGate / isReviewGateTerminal
// ---------------------------------------------------------------------------

test("startReviewGate: begins at awaiting_review with reviewsRun 0, not terminal", () => {
  const s = startReviewGate();
  assert.deepEqual(s, { status: "awaiting_review", reviewsRun: 0 });
  assert.equal(isReviewGateTerminal(s), false);
});

test("advanceReviewGate: approved on the first review reaches terminal 'approved' immediately", () => {
  const s0 = startReviewGate();
  const s1 = advanceReviewGate(s0, true);
  assert.deepEqual(s1, { status: "approved", reviewsRun: 1 });
  assert.equal(isReviewGateTerminal(s1), true);
});

test("advanceReviewGate: rejected on the first review -> changes_requested (non-terminal, one fix round allowed)", () => {
  const s0 = startReviewGate();
  const s1 = advanceReviewGate(s0, false);
  assert.deepEqual(s1, { status: "changes_requested", reviewsRun: 1 });
  assert.equal(isReviewGateTerminal(s1), false);
});

test("advanceReviewGate: rejected again on the SECOND review (after one fix round) reaches terminal 'done_after_one_round' — never cycles further", () => {
  const s0 = startReviewGate();
  const s1 = advanceReviewGate(s0, false); // changes_requested, reviewsRun 1
  const s2 = advanceReviewGate(s1, false); // second pass still rejected
  assert.deepEqual(s2, { status: "done_after_one_round", reviewsRun: 2 });
  assert.equal(isReviewGateTerminal(s2), true);

  // Feeding the terminal state through again must not advance past
  // reviewsRun 2 into a third round: the doctrine is a SINGLE fix-and-recheck
  // round, not open-ended cycling. Callers are expected to check
  // isReviewGateTerminal before calling advanceReviewGate again, but the
  // function itself must not silently keep incrementing forever if misused —
  // verify a third call still lands on a terminal status.
  const s3 = advanceReviewGate(s2, false);
  assert.equal(isReviewGateTerminal(s3), true, "a third rejection must still resolve to a terminal state");
});

test("advanceReviewGate: approved on the SECOND review (after one fix round) reaches terminal 'approved'", () => {
  const s0 = startReviewGate();
  const s1 = advanceReviewGate(s0, false); // changes_requested
  const s2 = advanceReviewGate(s1, true); // fix accepted
  assert.deepEqual(s2, { status: "approved", reviewsRun: 2 });
  assert.equal(isReviewGateTerminal(s2), true);
});

// ---------------------------------------------------------------------------
// decideToolCall: single dispatch entry point
// ---------------------------------------------------------------------------

test("decideToolCall: isSpawnTool true dispatches to decideSpawn", () => {
  const d = decideToolCall({
    toolName: "Task",
    isSpawnTool: true,
    spawn: { spawnerAgentId: "w1", spawnerAgentType: "coding-specialist", delegationMode: "flat", spawnerIsLead: false },
  });
  assert.equal(d.action, "deny");
  assert.equal(d.message, LEAF_WORKER_DENY_MESSAGE);
});

test("decideToolCall: isSpawnTool false dispatches to decideDirectToolCall", () => {
  const d = decideToolCall({ toolName: "Grep", isSpawnTool: false });
  assert.equal(d.action, "nudge");
  assert.ok(d.message!.includes("search-retrieval"));
});

test("decideToolCall: isSpawnTool true but spawn context missing falls through to decideDirectToolCall (defensive)", () => {
  const d = decideToolCall({ toolName: "Read", isSpawnTool: true, readCountSoFar: 0 });
  assert.equal(d.action, "allow");
  assert.equal(d.nextReadCount, 1);
});
