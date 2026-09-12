/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for the bounded cross-model consensus protocol
// (src/host/vscode/consensusProtocol.ts), p5-t2: termination proofs for the
// round cap, immediate-convergence short-circuit, mid-exchange provider
// failure, and the dead-session special case. This module is I/O-free (the
// Codex call is injected), so every test here is deterministic pure-function
// testing — no live Codex call, no network, no real binary, no timers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONSENSUS_MAX_ROUNDS,
  runConsensusExchange,
  positionsMatch,
  type ConsensusCaller,
  type ConsensusCallResult,
  type ConsensusPosition,
  type ConsensusRoundInput,
} from "../src/host/vscode/consensusProtocol";
import type { CodexReviewReplyParams } from "../src/host/vscode/foreignReview";

function roundInput(stance: ConsensusPosition["stance"], round: number): ConsensusRoundInput {
  return {
    claudePosition: { stance, rationale: `claude round ${round}` },
    codexPrompt: `round ${round} prompt`,
    claudeCostModelClass: "subscription",
    claudeModelId: "claude-test-model",
    codexCostModelClass: "subscription",
  };
}

function agreeResult(round: number): ConsensusCallResult {
  return { content: `stance: agree\nrationale: round ${round}`, threadId: "thread-abc" };
}

// Claude's roundInput() fixture always takes stance "disagree" in the
// non-convergent tests below, so Codex must reply with a DIFFERENT stance
// ("agree") to genuinely mismatch — positionsMatch compares stance equality,
// so two "disagree" stances from opposite sides would (correctly) count as
// convergence on "we both disagree with each other's disagreement" being
// the same enum value, which is not what these fixtures intend to simulate.
function mismatchResult(round: number): ConsensusCallResult {
  return { content: `stance: agree\nrationale: round ${round}`, threadId: "thread-abc" };
}

// ---------------------------------------------------------------------------
// 1. Non-convergent case: hard round cap
// ---------------------------------------------------------------------------

test("runConsensusExchange: perpetual disagreement runs at most CONSENSUS_MAX_ROUNDS rounds and returns no-agreement", async () => {
  let callCount = 0;
  const roundInputs = Array.from({ length: CONSENSUS_MAX_ROUNDS + 10 }, (_, i) => roundInput("disagree", i + 1));
  const call: ConsensusCaller = async (_params) => {
    callCount++;
    return mismatchResult(callCount);
  };

  const outcome = await runConsensusExchange(roundInputs, call);

  assert.equal(callCount, CONSENSUS_MAX_ROUNDS, "must call the injected caller exactly the capped number of times");
  assert.ok(callCount <= CONSENSUS_MAX_ROUNDS, "call count must never exceed the hard cap");
  assert.equal(outcome.status, "no-agreement");
  assert.equal(outcome.status === "no-agreement" && outcome.rounds.length, CONSENSUS_MAX_ROUNDS);
});

// ---------------------------------------------------------------------------
// 4. Cap sourced from one named constant
// ---------------------------------------------------------------------------

test("runConsensusExchange: the non-convergent round count equals the exported CONSENSUS_MAX_ROUNDS constant exactly", async () => {
  let callCount = 0;
  const roundInputs = Array.from({ length: CONSENSUS_MAX_ROUNDS + 5 }, (_, i) => roundInput("disagree", i + 1));
  const call: ConsensusCaller = async () => {
    callCount++;
    return mismatchResult(callCount);
  };

  await runConsensusExchange(roundInputs, call);

  // Asserting equality against the imported constant (not a hardcoded 4)
  // means changing CONSENSUS_MAX_ROUNDS changes this expectation
  // automatically — this is what makes the cap a one-line diff to change.
  assert.equal(callCount, CONSENSUS_MAX_ROUNDS);
  assert.equal(CONSENSUS_MAX_ROUNDS, 4, "sanity: documented value at time of writing");
});

// ---------------------------------------------------------------------------
// 2. Immediate convergence short-circuits
// ---------------------------------------------------------------------------

test("runConsensusExchange: agreement on round 1 returns agreed and invokes the caller only once", async () => {
  let callCount = 0;
  const roundInputs = Array.from({ length: CONSENSUS_MAX_ROUNDS }, (_, i) => roundInput("agree", i + 1));
  const call: ConsensusCaller = async () => {
    callCount++;
    return agreeResult(callCount);
  };

  const outcome = await runConsensusExchange(roundInputs, call);

  assert.equal(callCount, 1, "must not run further rounds once convergence is reached");
  assert.equal(outcome.status, "agreed");
  assert.equal(outcome.status === "agreed" && outcome.stance, "agree");
  assert.equal(outcome.status === "agreed" && outcome.round, 1);
  assert.equal(outcome.status === "agreed" && outcome.rounds.length, 1);
});

test("runConsensusExchange: convergence on a later round stops before the cap", async () => {
  let callCount = 0;
  const roundInputs = [
    roundInput("disagree", 1),
    roundInput("disagree", 2),
    roundInput("agree", 3),
    roundInput("agree", 4),
  ];
  const call: ConsensusCaller = async () => {
    callCount++;
    if (callCount < 3) return mismatchResult(callCount);
    return agreeResult(callCount);
  };

  const outcome = await runConsensusExchange(roundInputs, call);

  assert.equal(callCount, 3, "must stop the round after convergence, never running round 4");
  assert.equal(outcome.status, "agreed");
  assert.equal(outcome.status === "agreed" && outcome.round, 3);
});

// ---------------------------------------------------------------------------
// 3. Mid-exchange provider failure
// ---------------------------------------------------------------------------

test("runConsensusExchange: isError:true on round 2 terminates with provider-failure, not a hang or retry", async () => {
  let callCount = 0;
  const roundInputs = Array.from({ length: CONSENSUS_MAX_ROUNDS }, (_, i) => roundInput("disagree", i + 1));
  const call: ConsensusCaller = async () => {
    callCount++;
    if (callCount === 1) return mismatchResult(1);
    return { isError: true, content: "some unrelated provider error" };
  };

  const outcome = await runConsensusExchange(roundInputs, call);

  assert.equal(callCount, 2, "must terminate immediately on the failing round, no further retries");
  assert.equal(outcome.status, "provider-failure");
  assert.equal(outcome.status === "provider-failure" && outcome.round, 2);
  assert.equal(outcome.status === "provider-failure" && outcome.providerError, "some unrelated provider error");
  assert.equal(outcome.status === "provider-failure" && outcome.rounds.length, 1, "only the successful round 1 is recorded");
});

test("runConsensusExchange: a thrown Error on round 2 resolves to provider-failure with the message preserved, not a rejection", async () => {
  let callCount = 0;
  const roundInputs = Array.from({ length: CONSENSUS_MAX_ROUNDS }, (_, i) => roundInput("disagree", i + 1));
  const call: ConsensusCaller = async () => {
    callCount++;
    if (callCount === 1) return mismatchResult(1);
    throw new Error("simulated transport failure");
  };

  const outcome = await runConsensusExchange(roundInputs, call);

  assert.equal(callCount, 2, "the failing round is still the last one invoked");
  assert.equal(outcome.status, "provider-failure");
  assert.equal(outcome.status === "provider-failure" && outcome.round, 2);
  assert.equal(outcome.status === "provider-failure" && outcome.providerError, "simulated transport failure");
  assert.equal(outcome.status === "provider-failure" && outcome.rounds.length, 1, "only the successful round 1 is recorded");
});

test("runConsensusExchange: a thrown non-Error value resolves to provider-failure with a safely stringified providerError, never '[object Object]' swallowing the failure", async () => {
  let callCount = 0;
  const roundInputs = Array.from({ length: CONSENSUS_MAX_ROUNDS }, (_, i) => roundInput("disagree", i + 1));
  const call: ConsensusCaller = async () => {
    callCount++;
    if (callCount === 1) return mismatchResult(1);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw "raw string transport failure";
  };

  const outcome = await runConsensusExchange(roundInputs, call);

  assert.equal(outcome.status, "provider-failure");
  assert.equal(outcome.status === "provider-failure" && outcome.round, 2);
  assert.equal(outcome.status === "provider-failure" && outcome.providerError, "raw string transport failure");
  assert.notEqual(outcome.status === "provider-failure" && outcome.providerError, "[object Object]");
});

// ---------------------------------------------------------------------------
// Dead-session special case
// ---------------------------------------------------------------------------

test("runConsensusExchange: a dead-session ('Session not found for thread_id') reply produces provider-failure, not no-agreement or agreed", async () => {
  let callCount = 0;
  // Claude disagrees on round 1 and Codex replies "agree" — a genuine
  // mismatch — so the exchange proceeds to round 2, where the dead-session
  // error is hit.
  const roundInputs = Array.from({ length: CONSENSUS_MAX_ROUNDS }, (_, i) => roundInput("disagree", i + 1));
  const call: ConsensusCaller = async () => {
    callCount++;
    if (callCount === 1) return agreeResult(1);
    return { isError: true, content: "Session not found for thread_id: thread-abc" };
  };

  const outcome = await runConsensusExchange(roundInputs, call);

  assert.equal(outcome.status, "provider-failure");
  assert.notEqual(outcome.status, "no-agreement");
  assert.notEqual(outcome.status, "agreed");
  assert.equal(
    outcome.status === "provider-failure" && outcome.providerError.toLowerCase().includes("session not found"),
    true,
  );
});

// ---------------------------------------------------------------------------
// Abstain never counts as agreement
// ---------------------------------------------------------------------------

test("positionsMatch: abstain on either side never counts as agreement, including abstain vs abstain", () => {
  assert.equal(positionsMatch({ stance: "abstain", rationale: "" }, { stance: "abstain", rationale: "" }), false);
  assert.equal(positionsMatch({ stance: "abstain", rationale: "" }, { stance: "agree", rationale: "" }), false);
  assert.equal(positionsMatch({ stance: "agree", rationale: "" }, { stance: "abstain", rationale: "" }), false);
});

test("runConsensusExchange: both sides abstaining every round runs the full cap and returns no-agreement", async () => {
  let callCount = 0;
  const roundInputs = Array.from({ length: CONSENSUS_MAX_ROUNDS }, (_, i) => roundInput("abstain", i + 1));
  const call: ConsensusCaller = async () => {
    callCount++;
    return { content: `stance: abstain\nrationale: round ${callCount}`, threadId: "thread-abc" };
  };

  const outcome = await runConsensusExchange(roundInputs, call);

  assert.equal(callCount, CONSENSUS_MAX_ROUNDS);
  assert.equal(outcome.status, "no-agreement");
});

// ---------------------------------------------------------------------------
// Rounds 2+ use codex-reply with the persisted threadId
// ---------------------------------------------------------------------------

test("runConsensusExchange: round 1 uses a fresh codex call, rounds 2+ use codex-reply with the persisted threadId", async () => {
  const receivedParams: Array<Record<string, unknown>> = [];
  const roundInputs = [roundInput("disagree", 1), roundInput("disagree", 2), roundInput("agree", 3)];
  let callCount = 0;
  const call: ConsensusCaller = async (params) => {
    callCount++;
    receivedParams.push(params as unknown as Record<string, unknown>);
    // Claude's stance is "disagree" for rounds 1-2 (see roundInputs above);
    // Codex replying "agree" is a genuine mismatch so the exchange proceeds.
    if (callCount === 1) return { content: "stance: agree\nrationale: r1", threadId: "thread-xyz" };
    if (callCount === 2) return { content: "stance: agree\nrationale: r2", threadId: "thread-xyz" };
    return { content: "stance: agree\nrationale: r3", threadId: "thread-xyz" };
  };

  const outcome = await runConsensusExchange(roundInputs, call);

  assert.equal(outcome.status, "agreed");
  assert.equal(receivedParams.length, 3);

  // Round 1: fresh `codex` call — no threadId field, has prompt.
  assert.equal("threadId" in receivedParams[0], false);
  assert.equal(receivedParams[0].prompt, "round 1 prompt");

  // Rounds 2 and 3: `codex-reply` against the persisted threadId from round 1.
  const round2 = receivedParams[1] as unknown as CodexReviewReplyParams;
  assert.equal(round2.threadId, "thread-xyz");
  assert.equal(round2.prompt, "round 2 prompt");

  const round3 = receivedParams[2] as unknown as CodexReviewReplyParams;
  assert.equal(round3.threadId, "thread-xyz");
  assert.equal(round3.prompt, "round 3 prompt");
});

// ---------------------------------------------------------------------------
// unparseable reply is distinct from provider-failure
// ---------------------------------------------------------------------------

test("runConsensusExchange: a reply with no parseable stance returns unparseable, not provider-failure or agreed", async () => {
  const roundInputs = [roundInput("agree", 1)];
  const call: ConsensusCaller = async () => ({ content: "this is not structured at all", threadId: "thread-1" });

  const outcome = await runConsensusExchange(roundInputs, call);

  assert.equal(outcome.status, "unparseable");
  assert.equal(outcome.status === "unparseable" && outcome.side, "codex");
  assert.equal(outcome.status === "unparseable" && outcome.round, 1);
});
