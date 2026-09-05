/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Plan task p15-t1: unit coverage for the shared fallback-chain resolver
 * (src/core/fallbackChain.ts), consumed by both hosts' wiring.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isProviderFailure,
  resolveNextFallback,
  buildFallbackInstruction,
  FallbackState,
} from "../src/core/fallbackChain";
import type { RoutingSlot } from "../src/core/routingProfile";

test("isProviderFailure matches the documented quota/unavailable/unreachable patterns", () => {
  assert.equal(isProviderFailure("usage limit reached for this account"), true);
  assert.equal(isProviderFailure("spend cap exceeded"), true);
  assert.equal(isProviderFailure("out of credits"), true);
  assert.equal(isProviderFailure("401 Unauthorized"), true);
  assert.equal(isProviderFailure("quota exceeded: RESOURCE_EXHAUSTED"), true);
  assert.equal(isProviderFailure("rate limit hit"), true);
  assert.equal(isProviderFailure("OPENAI_COMPAT_BASE_URL is not set"), true);
  assert.equal(isProviderFailure("connect ECONNREFUSED 127.0.0.1:443"), true);
  assert.equal(isProviderFailure("chat tool failed: socket hang up"), true);
  assert.equal(isProviderFailure("verdict: provider-unavailable"), true);
  // p15-t1 attempt 5: OpenCode's own connection-failure wording, observed
  // live against a dead OLLAMA_BASE_URL (docs/opencode-probe-findings.md
  // "Remote VM smoke, attempt 5").
  assert.equal(
    isProviderFailure(
      "Subagent failed (task_id: ses_f902f9840ffequHtUb2asqVyj5): Cannot connect to API: Unable to connect. Is the computer able to access the url?"
    ),
    true
  );
  assert.equal(isProviderFailure('{"name":"APIError","data":{"message":"..."}}'), true);
});

test("isProviderFailure does not flag ordinary success/failure text unrelated to provider outages", () => {
  assert.equal(isProviderFailure("Done: implemented the thing."), false);
  assert.equal(isProviderFailure("verdict: changes-requested"), false);
  assert.equal(isProviderFailure(""), false);
  assert.equal(isProviderFailure(undefined), false);
  assert.equal(isProviderFailure(null), false);
});

function chain(): RoutingSlot[] {
  return [{ model: "openai/gpt-5.4-mini", vendor: "openai" }, { model: "moonshot/kimi-k2", vendor: "moonshot" }];
}

test("resolveNextFallback: 0 attempts so far resolves to fallback[0]", () => {
  const result = resolveNextFallback({ slotId: "coding-specialist", chain: chain(), attemptsSoFar: 0 });
  assert.equal(result.exhausted, false);
  assert.equal(result.slot?.model, "openai/gpt-5.4-mini");
  assert.equal(result.index, 0);
});

test("resolveNextFallback: 1 attempt so far resolves to fallback[1]", () => {
  const result = resolveNextFallback({ slotId: "coding-specialist", chain: chain(), attemptsSoFar: 1 });
  assert.equal(result.exhausted, false);
  assert.equal(result.slot?.model, "moonshot/kimi-k2");
  assert.equal(result.index, 1);
});

test("resolveNextFallback: attemptsSoFar past the chain length is exhausted", () => {
  const result = resolveNextFallback({ slotId: "coding-specialist", chain: chain(), attemptsSoFar: 2 });
  assert.equal(result.exhausted, true);
  assert.equal(result.slot, null);
});

test("resolveNextFallback: an empty chain is immediately exhausted", () => {
  const result = resolveNextFallback({ slotId: "coding-specialist", chain: [], attemptsSoFar: 0 });
  assert.equal(result.exhausted, true);
  assert.equal(result.slot, null);
});

test("buildFallbackInstruction names the next model and position when not exhausted", () => {
  const result = resolveNextFallback({ slotId: "coding-specialist", chain: chain(), attemptsSoFar: 0 });
  const text = buildFallbackInstruction({
    workerId: "coding-specialist",
    failedProvider: "anthropic",
    failedModel: "sonnet",
    reason: "usage limit reached",
    result,
    chainLength: 2,
  });
  assert.match(text, /coding-specialist failed on provider\/model anthropic\/sonnet/);
  assert.match(text, /usage limit reached/);
  assert.match(text, /Re-dispatch the same task to coding-specialist/);
  assert.match(text, /openai\/gpt-5\.4-mini/);
  assert.match(text, /fallback 1 of 2/);
});

test("buildFallbackInstruction says to report failure, not retry, when exhausted", () => {
  const result = resolveNextFallback({ slotId: "coding-specialist", chain: chain(), attemptsSoFar: 2 });
  const text = buildFallbackInstruction({
    workerId: "coding-specialist",
    failedModel: "kimi-k2",
    reason: "ECONNREFUSED",
    result,
    chainLength: 2,
  });
  assert.match(text, /exhausted/i);
  assert.match(text, /report the failure/i);
  assert.doesNotMatch(text, /Re-dispatch/);
});

// ---------------------------------------------------------------------------
// FallbackState: acceptance criterion — "A test simulating an unreachable
// primary provider for a slot asserts execution proceeds on the first
// working fallback entry", plus repeated failure -> exhaustion, plus no
// failure -> no state recorded.
// ---------------------------------------------------------------------------

test("FallbackState: primary failure on a 2-deep chain resolves getNext to fallback[0] (first working fallback entry)", () => {
  const state = new FallbackState();
  const record = state.recordFailure("session-1", "coding-specialist", chain(), "anthropic/sonnet", "unreachable");
  assert.equal(record.attemptsSoFar, 1);

  const next = state.getNext("session-1", "coding-specialist");
  assert.ok(next);
  assert.equal(next!.exhausted, false);
  assert.equal(next!.slot?.model, "openai/gpt-5.4-mini");
});

test("FallbackState: a second failure on the same slot advances to fallback[1]", () => {
  const state = new FallbackState();
  state.recordFailure("session-1", "coding-specialist", chain(), "anthropic/sonnet", "unreachable");
  state.recordFailure("session-1", "coding-specialist", chain(), "openai/gpt-5.4-mini", "rate limit");

  const next = state.getNext("session-1", "coding-specialist");
  assert.ok(next);
  assert.equal(next!.exhausted, false);
  assert.equal(next!.slot?.model, "moonshot/kimi-k2");
});

test("FallbackState: a third failure exhausts the 2-deep chain", () => {
  const state = new FallbackState();
  state.recordFailure("session-1", "coding-specialist", chain(), "anthropic/sonnet", "unreachable");
  state.recordFailure("session-1", "coding-specialist", chain(), "openai/gpt-5.4-mini", "rate limit");
  state.recordFailure("session-1", "coding-specialist", chain(), "moonshot/kimi-k2", "401 Unauthorized");

  const next = state.getNext("session-1", "coding-specialist");
  assert.ok(next);
  assert.equal(next!.exhausted, true);
  assert.equal(next!.slot, null);
});

test("FallbackState: no failure recorded means no state and getNext returns undefined", () => {
  const state = new FallbackState();
  assert.equal(state.getNext("session-1", "coding-specialist"), undefined);
  assert.equal(state.getRecord("session-1", "coding-specialist"), undefined);
});

test("FallbackState: endSession clears tracked failures for that session only", () => {
  const state = new FallbackState();
  state.recordFailure("session-1", "coding-specialist", chain(), "anthropic/sonnet", "unreachable");
  state.recordFailure("session-2", "coding-specialist", chain(), "anthropic/sonnet", "unreachable");

  state.endSession("session-1");

  assert.equal(state.getNext("session-1", "coding-specialist"), undefined);
  assert.notEqual(state.getNext("session-2", "coding-specialist"), undefined);
});
