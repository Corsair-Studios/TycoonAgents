/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Direct coverage of media/main.js's buildSavingsEligibility (and the
// `savings` sub-result it feeds inside buildDelegationLedger) — see
// media/src/main/080-packs-events.js ~363-443. Loaded with the same
// closure-slicing technique as test/buildDelegationLedger.test.ts: both
// functions call costModelClass/resolvePriceKey, which are function
// declarations defined LATER in the same IIFE closure but hoisted, so the
// slice must run through buildMetricsRollup's closing brace to pick those
// declarations up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface SavingsResult {
  eligible: boolean;
  reason: string | null;
  agents: string[];
}

interface LedgerResult {
  savings: SavingsResult;
}

interface Module {
  buildSavingsEligibility: (list: unknown[], table: unknown, orchestratorRate: number | null) => SavingsResult;
  buildDelegationLedger: (rows: unknown[] | undefined, pricing: unknown, orchestratorRate: number | null) => LedgerResult;
  PRICE_TABLE: Record<string, { perMtok: number; weight: number }>;
}

function loadModule(): Module {
  const mainPath = join(process.cwd(), "media", "main.js");
  const src = readFileSync(mainPath, "utf8");

  const startMarker = "const PRICE_TABLE = {";
  const startIdx = src.indexOf(startMarker);
  assert.ok(startIdx !== -1, 'Could not find "const PRICE_TABLE = {" in media/main.js');

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
  const body = `${slice}\nreturn { buildSavingsEligibility, buildDelegationLedger, PRICE_TABLE };`;
  // eslint-disable-next-line no-new-func
  return new Function(body)() as Module;
}

const mod = loadModule();

const ANTHROPIC_ORCH_RATE = mod.PRICE_TABLE["anthropic/sonnet"].perMtok;

function agent(overrides: Record<string, unknown>) {
  return {
    id: "worker",
    vendor: "anthropic",
    model: "sonnet",
    usageReported: true,
    ...overrides,
  };
}

test("buildSavingsEligibility: pure Anthropic set with reported usage is eligible, reason null", () => {
  const list = [
    agent({ id: "a1", model: "sonnet" }),
    agent({ id: "a2", model: "haiku" }),
  ];
  const result = mod.buildSavingsEligibility(list, mod.PRICE_TABLE, ANTHROPIC_ORCH_RATE);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, null);
});

test("buildSavingsEligibility: two vendors -> ineligible, reason mixed vendors", () => {
  const list = [
    agent({ id: "a1", vendor: "anthropic", model: "sonnet" }),
    agent({ id: "a2", vendor: "openai", model: "gpt-5" }),
  ];
  const result = mod.buildSavingsEligibility(list, mod.PRICE_TABLE, ANTHROPIC_ORCH_RATE);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "mixed vendors");
});

test("buildSavingsEligibility: one agent with usageReported false -> reason names that agent", () => {
  const list = [
    agent({ id: "a1", model: "sonnet" }),
    agent({ id: "a2", model: "haiku", usageReported: false }),
  ];
  const result = mod.buildSavingsEligibility(list, mod.PRICE_TABLE, ANTHROPIC_ORCH_RATE);
  assert.equal(result.eligible, false);
  assert.match(result.reason as string, /usage not reported by a2/);
});

test("buildSavingsEligibility: vendor absent from PRICE_TABLE -> no price table for <vendor>", () => {
  const list = [agent({ id: "a1", vendor: "acme", model: "acme-large" })];
  const result = mod.buildSavingsEligibility(list, mod.PRICE_TABLE, ANTHROPIC_ORCH_RATE);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "no price table for acme");
});

test("buildSavingsEligibility: orchestrator unpriced -> orchestrator model unpriced", () => {
  const list = [agent({ id: "a1", model: "sonnet" })];
  const result = mod.buildSavingsEligibility(list, mod.PRICE_TABLE, null);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "orchestrator model unpriced");
});

test("buildSavingsEligibility: legacy rows with bare model ids and no vendor field are still eligible", () => {
  const list = [
    { id: "a1", model: "sonnet", usageReported: true },
    { id: "a2", model: "opus", usageReported: true },
  ];
  const result = mod.buildSavingsEligibility(list, mod.PRICE_TABLE, ANTHROPIC_ORCH_RATE);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, null);
});

test("buildDelegationLedger: savings sub-result mirrors buildSavingsEligibility for a mixed-vendor set", () => {
  const list = [
    agent({ id: "a1", vendor: "anthropic", model: "sonnet" }),
    agent({ id: "a2", vendor: "openai", model: "gpt-5" }),
  ];
  const ledger = mod.buildDelegationLedger(list, mod.PRICE_TABLE, ANTHROPIC_ORCH_RATE);
  assert.equal(ledger.savings.eligible, false);
  assert.equal(ledger.savings.reason, "mixed vendors");
});

test("buildDelegationLedger: savings sub-result is eligible for a pure priced Anthropic set", () => {
  const list = [agent({ id: "a1", model: "sonnet" })];
  const ledger = mod.buildDelegationLedger(list, mod.PRICE_TABLE, ANTHROPIC_ORCH_RATE);
  assert.equal(ledger.savings.eligible, true);
  assert.equal(ledger.savings.reason, null);
});
