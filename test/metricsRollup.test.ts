/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Direct coverage of media/main.js's buildMetricsRollup (p15-t3), extracted
// with the same closure-slicing technique as test/pricing.test.ts: the
// pricing/rollup helpers are mutually-referencing top-level function/const
// declarations in the same IIFE closure, so evaluating the contiguous source
// slice with `new Function` yields real references to the actual
// implementations rather than reimplementations of them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface RollupVendorRow {
  vendor: string;
  tokens: number;
  costUsd: number | null;
  costLabel: string;
  agents: number;
}

interface RollupClassRow {
  costModelClass: string;
  tokens: number;
  costUsd: number | null;
  costLabel: string;
}

interface RollupResult {
  byVendor: RollupVendorRow[];
  byCostClass: RollupClassRow[];
  fallbackCount: number;
  localTimeRows: Array<{ agent: string; vendor: string; model: string; activeMs: number }>;
}

interface RollupModule {
  buildMetricsRollup: (agentMetrics: unknown[] | undefined) => RollupResult;
}

function loadRollupModule(): RollupModule {
  const mainPath = join(process.cwd(), "media", "main.js");
  const src = readFileSync(mainPath, "utf8");

  const startMarker = "const PRICE_TABLE = {";
  const startIdx = src.indexOf(startMarker);
  assert.ok(startIdx !== -1, 'Could not find "const PRICE_TABLE = {" in media/main.js');

  const endMarker = "function buildMetricsRollup(agentMetrics) {";
  const fnStart = src.indexOf(endMarker);
  assert.ok(fnStart !== -1, "Could not find buildMetricsRollup function in media/main.js");

  // Balanced-brace scan from buildMetricsRollup's opening brace to its close.
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
  const body = `${slice}\nreturn { buildMetricsRollup };`;
  // eslint-disable-next-line no-new-func
  return new Function(body)() as RollupModule;
}

const mod = loadRollupModule();

function baseItem(overrides: Record<string, unknown>) {
  return {
    id: "agent",
    name: "agent",
    status: "idle",
    taskCount: 1,
    mcpCount: 0,
    activeMs: 0,
    tokens: 0,
    cacheReadTokens: 0,
    fallbackCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 4-item fixture: metered anthropic, subscription openai, local moonshot
// (zero tokens, active time), and a fallback-tagged google item.
// ---------------------------------------------------------------------------

const fixture = [
  baseItem({
    id: "coding-specialist",
    name: "coding-specialist",
    vendor: "anthropic",
    model: "anthropic/sonnet",
    costModelClass: "metered",
    tokens: 1_000_000,
    cacheReadTokens: 0,
  }),
  baseItem({
    id: "codex-reviewer",
    name: "codex-reviewer",
    vendor: "openai",
    model: "openai/gpt-5.4-mini",
    costModelClass: "subscription",
    tokens: 500_000,
    cacheReadTokens: 0,
  }),
  baseItem({
    id: "kimi-reviewer",
    name: "kimi-reviewer",
    vendor: "moonshot",
    model: "moonshot/kimi-k2",
    costModelClass: "local",
    tokens: 0,
    cacheReadTokens: 0,
    activeMs: 45_000,
  }),
  baseItem({
    id: "gemini-reviewer",
    name: "gemini-reviewer",
    vendor: "google",
    model: "google/gemini-2.5-flash",
    costModelClass: "metered",
    tokens: 200_000,
    cacheReadTokens: 0,
    fallbackOf: "codex-reviewer",
    fallbackDepth: 1,
    fallbackCount: 1,
  }),
];

test("buildMetricsRollup sums tokens per vendor", () => {
  const result = mod.buildMetricsRollup(fixture);
  const byVendor = Object.fromEntries(result.byVendor.map((v) => [v.vendor, v]));

  assert.equal(byVendor["anthropic"].tokens, 1_000_000);
  assert.equal(byVendor["anthropic"].agents, 1);
  assert.equal(byVendor["openai"].tokens, 500_000);
  assert.equal(byVendor["moonshot"].tokens, 0);
  assert.equal(byVendor["google"].tokens, 200_000);
});

test("buildMetricsRollup sums tokens/cost per cost class", () => {
  const result = mod.buildMetricsRollup(fixture);
  const byClass = Object.fromEntries(result.byCostClass.map((c) => [c.costModelClass, c]));

  assert.equal(byClass["metered"].tokens, 1_000_000 + 200_000);
  assert.ok(byClass["metered"].costUsd !== null && byClass["metered"].costUsd > 0);

  assert.equal(byClass["subscription"].tokens, 500_000);
  assert.equal(byClass["subscription"].costUsd, null);
  assert.equal(byClass["subscription"].costLabel, "quota");

  assert.equal(byClass["local"].tokens, 0);
  assert.equal(byClass["local"].costUsd, null);
  assert.equal(byClass["local"].costLabel, "local");
});

test("buildMetricsRollup counts fallback dispatches", () => {
  const result = mod.buildMetricsRollup(fixture);
  assert.equal(result.fallbackCount, 1);
});

test("buildMetricsRollup attributes fallback cost to the vendor that actually ran, not the assigned one", () => {
  const result = mod.buildMetricsRollup(fixture);
  const byVendor = Object.fromEntries(result.byVendor.map((v) => [v.vendor, v]));

  // The fallback item is tagged fallbackOf: "codex-reviewer" (openai), but it
  // actually ran as google/gemini-2.5-flash — its cost must land under google,
  // and must NOT inflate openai's total beyond its own single item.
  assert.ok(byVendor["google"].costUsd !== null && byVendor["google"].costUsd > 0);
  assert.equal(byVendor["openai"].agents, 1);
});

test("buildMetricsRollup produces a local time-based row for zero-token local items", () => {
  const result = mod.buildMetricsRollup(fixture);
  assert.equal(result.localTimeRows.length, 1);
  const row = result.localTimeRows[0];
  assert.equal(row.agent, "kimi-reviewer");
  assert.equal(row.vendor, "moonshot");
  assert.equal(row.model, "moonshot/kimi-k2");
  assert.equal(row.activeMs, 45_000);
});

// ---------------------------------------------------------------------------
// No-fallback fixture: fallbackCount stays 0, and the input array/items are
// never mutated.
// ---------------------------------------------------------------------------

test("buildMetricsRollup reports zero fallbacks when none occurred, and does not mutate its input", () => {
  const noFallback = [
    baseItem({
      id: "coding-specialist",
      vendor: "anthropic",
      model: "anthropic/sonnet",
      costModelClass: "metered",
      tokens: 300_000,
    }),
    baseItem({
      id: "testing-specialist",
      vendor: "anthropic",
      model: "anthropic/haiku",
      costModelClass: "metered",
      tokens: 100_000,
    }),
  ];
  const snapshot = JSON.parse(JSON.stringify(noFallback));

  const result = mod.buildMetricsRollup(noFallback);

  assert.equal(result.fallbackCount, 0);
  assert.deepEqual(noFallback, snapshot);
});
