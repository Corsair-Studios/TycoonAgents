/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Direct coverage of media/main.js's buildDelegationLedger, added 2026-09-07
// to replace the single "~N% of token cost avoided" headline with a
// per-currency ledger (metered $/token, subscription quota, local
// hardware) plus an honest counterfactual. Loaded with the same
// closure-slicing technique as test/metricsRollup.test.ts and
// test/pricing.test.ts: buildDelegationLedger calls costModelClass and
// estCostUSDWithCache, which are function declarations defined LATER in the
// same IIFE closure but hoisted, so the slice must run through the end of
// the source file (not stop at buildDelegationLedger's closing brace) to
// pick those declarations up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface LedgerResult {
  metered: { usd: number; tokens: number; unknownModels: string[] };
  subscription: { tokens: number };
  local: { tokens: number };
  unknown: { tokens: number; rows: unknown[] };
  counterfactualUsd: number | null;
  billedUsd: number;
  avoidedUsd: number | null;
  billableTokens: number;
}

interface LedgerModule {
  buildDelegationLedger: (rows: unknown[] | undefined, pricing: unknown, orchestratorRate: number | null) => LedgerResult;
  PRICE_TABLE: Record<string, { perMtok: number; weight: number }>;
}

function loadLedgerModule(): LedgerModule {
  const mainPath = join(process.cwd(), "media", "main.js");
  const src = readFileSync(mainPath, "utf8");

  const startMarker = "const PRICE_TABLE = {";
  const startIdx = src.indexOf(startMarker);
  assert.ok(startIdx !== -1, 'Could not find "const PRICE_TABLE = {" in media/main.js');

  // End at buildMetricsRollup's closing brace — the SAME endpoint
  // test/metricsRollup.test.ts uses. That range already carries every
  // hoisted declaration buildDelegationLedger calls (costModelClass,
  // resolvePriceKey, DEFAULT_PRICE_KEY) without pulling in earlier
  // const/let declarations from outside the PRICE_TABLE..buildMetricsRollup
  // window (slicing to the IIFE's true end pulled in references to
  // const declared BEFORE PRICE_TABLE, e.g. DANCE_OFF_CONFETTI_COLORS,
  // which then threw as not-yet-declared).
  const endMarker = "function buildMetricsRollup(agentMetrics) {";
  const fnStart = src.indexOf(endMarker);
  assert.ok(fnStart !== -1, "Could not find buildMetricsRollup function in media/main.js");
  const braceStart = src.indexOf("{", fnStart + endMarker.length - 1);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end !== -1, "Could not find closing brace for buildMetricsRollup in media/main.js");

  const slice = src.slice(startIdx, end + 1);
  const body = `${slice}\nreturn { buildDelegationLedger, PRICE_TABLE };`;
  // eslint-disable-next-line no-new-func
  return new Function(body)() as LedgerModule;
}

const mod = loadLedgerModule();

function row(overrides: Record<string, unknown>) {
  return { id: "agent", tokens: 0, cacheReadTokens: 0, ...overrides };
}

test("buildDelegationLedger: mixed vendors split into metered/subscription/local currencies", () => {
  const rows = [
    row({ id: "coding-specialist", model: "anthropic/sonnet", costModelClass: "metered", tokens: 1_000_000 }),
    row({ id: "codex-reviewer", model: "openai/gpt-6-astra", costModelClass: "subscription", tokens: 500_000 }),
    row({ id: "kimi-reviewer", model: "moonshot/kimi-k2", costModelClass: "local", tokens: 200_000 }),
  ];
  const result = mod.buildDelegationLedger(rows, mod.PRICE_TABLE, null);

  assert.equal(result.metered.tokens, 1_000_000);
  assert.ok(result.metered.usd > 0);
  assert.equal(result.subscription.tokens, 500_000);
  assert.equal(result.local.tokens, 200_000);
  assert.equal(result.metered.unknownModels.length, 0);
});

test("buildDelegationLedger: a model with no rate in the pricing table is excluded from the dollar sum and flagged", () => {
  // Pass a pricing table with NO DEFAULT_PRICE_KEY row and no entry for this
  // model, forcing the price lookup to fail closed to null (real shipped
  // PRICE_TABLE always seeds DEFAULT_PRICE_KEY — this simulates a vendor
  // genuinely missing from the table, e.g. before an update-pricing run).
  const pricingWithoutFallback: Record<string, { perMtok: number; weight: number }> = {};
  const rows = [row({ id: "mystery-agent", model: "totally-unrecognized-vendor/model-x", costModelClass: "metered", tokens: 400_000 })];
  const result = mod.buildDelegationLedger(rows, pricingWithoutFallback, null);

  assert.equal(result.metered.tokens, 400_000);
  assert.equal(result.metered.usd, 0);
  assert.deepEqual(result.metered.unknownModels, ["totally-unrecognized-vendor/model-x"]);
});

test("buildDelegationLedger: orchestrator rate unknown -> counterfactual/avoided are null, not fabricated", () => {
  const rows = [row({ id: "coding-specialist", model: "anthropic/sonnet", costModelClass: "metered", tokens: 100_000 })];
  const result = mod.buildDelegationLedger(rows, mod.PRICE_TABLE, null);

  assert.equal(result.counterfactualUsd, null);
  assert.equal(result.avoidedUsd, null);
  assert.equal(result.billableTokens, 100_000);
});

test("buildDelegationLedger: cacheReadTokens are excluded from billableTokens (used for the counterfactual)", () => {
  const rows = [row({ id: "coding-specialist", model: "anthropic/sonnet", costModelClass: "metered", tokens: 100_000, cacheReadTokens: 900_000 })];
  const result = mod.buildDelegationLedger(rows, mod.PRICE_TABLE, 10);

  assert.equal(result.billableTokens, 100_000, "cacheReadTokens must not inflate billableTokens");
  // counterfactual = 100000/1e6 * 10 = $1.00, computed from billable tokens only.
  assert.equal(result.counterfactualUsd, 1);
  // metered.tokens still includes the cache-read tokens for display purposes.
  assert.equal(result.metered.tokens, 1_000_000);
});

test("buildDelegationLedger: avoided never goes negative — clamps to 0 when billed exceeds the counterfactual", () => {
  const rows = [row({ id: "coding-specialist", model: "anthropic/sonnet", costModelClass: "metered", tokens: 1_000_000 })];
  // Sonnet costs $4/Mtok billed = $4.00; an orchestrator rate of 1 $/Mtok
  // makes the counterfactual ($1.00) cheaper than what was actually billed.
  const result = mod.buildDelegationLedger(rows, mod.PRICE_TABLE, 1);

  assert.equal(result.billedUsd, 4);
  assert.equal(result.counterfactualUsd, 1);
  assert.equal(result.avoidedUsd, 0, "avoided must clamp to 0, never render negative");
});

test("buildDelegationLedger: a row with neither model nor costModelClass lands in unknown, never priced/metered, never in the counterfactual", () => {
  const rows = [
    row({ id: "mystery-agent", tokens: 50_000, taskCount: 2 }),
    row({ id: "coding-specialist", model: "anthropic/sonnet", costModelClass: "metered", tokens: 100_000 }),
  ];
  const result = mod.buildDelegationLedger(rows, mod.PRICE_TABLE, 10);

  assert.equal(result.unknown.tokens, 50_000);
  assert.equal(result.unknown.rows.length, 1);
  assert.equal((result.unknown.rows[0] as { id: string }).id, "mystery-agent");
  assert.equal(result.metered.tokens, 100_000, "the unknown row must not be folded into metered");
  assert.equal(result.metered.usd, 0.4, "the unknown row must not be priced into metered.usd");
  // billableTokens excludes the unknown row's 50000 -> counterfactual is
  // 100000/1e6*10 = $1.00, not 150000/1e6*10 = $1.50.
  assert.equal(result.billableTokens, 100_000);
  assert.equal(result.counterfactualUsd, 1);
});

test("buildDelegationLedger: empty/undefined rows produce an all-zero ledger, no throw", () => {
  assert.doesNotThrow(() => mod.buildDelegationLedger(undefined, mod.PRICE_TABLE, 4));
  const result = mod.buildDelegationLedger([], mod.PRICE_TABLE, 4);
  assert.equal(result.metered.tokens, 0);
  assert.equal(result.subscription.tokens, 0);
  assert.equal(result.local.tokens, 0);
  assert.equal(result.billedUsd, 0);
  assert.equal(result.counterfactualUsd, 0);
  assert.equal(result.avoidedUsd, 0);
});
