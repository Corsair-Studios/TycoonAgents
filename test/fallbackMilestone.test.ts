/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Plan task p15-t4: end-to-end coverage for the PRD's three M2 acceptance
 * criteria. Only what is NOT already covered by test/fallbackChain.test.ts,
 * test/fallbackChainClaudeHook.test.ts, test/fallbackOf.test.ts,
 * test/metricsRollup.test.ts and test/opencodeEnforcementHooks.test.ts is
 * added here:
 *
 *   (1) fallback execution proceeds on the first working entry with
 *       fallbackOf set: opencodeEnforcementHooks.test.ts drives a failure and
 *       asserts the resulting FallbackTriggered activity record + nudge, but
 *       never asserts the field the PRD actually cares about — that the very
 *       NEXT toolExecuteBefore("task") dispatch for that slot writes a
 *       PreToolUse/Task activity record carrying fallbackOf === the original
 *       slot id and model === fallback[0]. Added below.
 *
 *   (2) metrics rollup attributes fallback cost to the vendor that ran: this
 *       is already fully covered by metricsRollup.test.ts's "buildMetricsRollup
 *       attributes fallback cost to the vendor that actually ran, not the
 *       assigned one" — nothing added here.
 *
 *   (3) non-fallback per-agent totals are unaffected by the fallback feature:
 *       fallbackOf.test.ts's "no fallback dispatch" test spot-checks a few
 *       fields (fallbackCount, model, tokens). Added below: a full
 *       field-by-field deep-equality of computeStateFromRecords' AgentMetric
 *       output (minus the new fallbackCount field) against the exact shape
 *       expected from the input records, PLUS feeding that same
 *       agentMetrics array through media/main.js's buildMetricsRollup and the
 *       per-agent cost helper to prove neither one perturbs a normal
 *       (non-fallback) total.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as ts from "typescript";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStateFromRecords } from "../src/core/state";
import type { HookRecord } from "../src/providers/claude-code/hookRecord";

// ---------------------------------------------------------------------------
// (1) driven plugin scenario: task fails -> the NEXT task dispatch record
// carries fallbackOf and model fallback[0].
// ---------------------------------------------------------------------------

const PLUGIN_SRC_PATH = join(process.cwd(), "hooks", "tycoon-opencode-plugin.ts");
const DELEGATION_ENFORCEMENT_JS = join(process.cwd(), "out", "src", "core", "delegationEnforcement.js");
const FALLBACK_CHAIN_JS = join(process.cwd(), "out", "src", "core", "fallbackChain.js");

function compilePlugin(): { modulePath: string; moduleDir: string } {
  const moduleDir = mkdtempSync(join(tmpdir(), "tycoon-fallback-milestone-plugin-"));
  const source = readFileSync(PLUGIN_SRC_PATH, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    fileName: "tycoon-opencode-plugin.ts",
  });
  const modulePath = join(moduleDir, "tycoon-opencode-plugin.js");
  writeFileSync(modulePath, output.outputText, "utf8");
  writeFileSync(join(moduleDir, "delegationEnforcement.js"), readFileSync(DELEGATION_ENFORCEMENT_JS, "utf8"), "utf8");
  writeFileSync(join(moduleDir, "fallbackChain.js"), readFileSync(FALLBACK_CHAIN_JS, "utf8"), "utf8");
  return { modulePath, moduleDir };
}

function requireFreshPlugin(): { plugin: any; moduleDir: string } {
  const { modulePath, moduleDir } = compilePlugin();
  delete require.cache[require.resolve(modulePath)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return { plugin: require(modulePath), moduleDir };
}

function readActivity(activityFile: string): Array<Record<string, unknown>> {
  if (!existsSync(activityFile)) return [];
  return readFileSync(activityFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function setupDirectory(): string {
  return mkdtempSync(join(tmpdir(), "tycoon-fallback-milestone-dir-"));
}

function writeRoutingGenerated(directory: string, agentId: string, fallback: string[]): void {
  mkdirSync(join(directory, ".opencode"), { recursive: true });
  writeFileSync(
    join(directory, ".opencode", "tycoon-routing.generated.json"),
    JSON.stringify({ agents: { [agentId]: { model: "anthropic/sonnet", fallback } }, orchestrator: {} }, null, 2),
    "utf8"
  );
}

test("PRD M2 (1): after a provider failure, the next task dispatch's PreToolUse/Task record carries fallbackOf===slotId and model===fallback[0]", async () => {
  const { plugin: mod, moduleDir } = requireFreshPlugin();
  const directory = setupDirectory();
  try {
  writeRoutingGenerated(directory, "coding-specialist", ["openai/gpt-5.4-mini", "moonshot/kimi-k2"]);
  const plugin = mod.createPlugin({ directory, now: () => 1 });

  // First dispatch: primary model, no fallback tagging yet.
  await plugin.toolExecuteBefore({
    tool: "task",
    sessionID: "root-session",
    args: { subagent_type: "coding-specialist", description: "implement thing" },
  });
  let records = readActivity(plugin._paths.activityFile);
  const firstDispatch = records.find((r) => r.event === "PreToolUse" && r.tool === "Task");
  assert.ok(firstDispatch, "first dispatch should write a PreToolUse/Task record");
  assert.equal("fallbackOf" in firstDispatch!, false, "the FIRST dispatch on a slot must carry no fallbackOf");

  // Primary fails with a recognized provider-outage pattern.
  await plugin.toolExecuteAfter(
    { tool: "task", sessionID: "root-session", args: { subagent_type: "coding-specialist" } },
    {
      metadata: {
        parentSessionId: "root-session",
        sessionId: "child-session-1",
        model: { providerID: "anthropic", modelID: "sonnet" },
      },
      output: "<task>Error: usage limit reached for this account</task>",
    }
  );

  // The re-dispatch: this is the "next task dispatch record" the PRD's
  // acceptance criterion is about. It must carry fallbackOf pointing at the
  // ORIGINAL slot id and the fallback[0] model, proving execution proceeds
  // on the first working chain entry rather than stalling or re-trying the
  // dead primary.
  await plugin.toolExecuteBefore({
    tool: "task",
    sessionID: "root-session",
    args: { subagent_type: "coding-specialist", description: "retry implement thing" },
  });

  records = readActivity(plugin._paths.activityFile);
  const dispatchRecords = records.filter((r) => r.event === "PreToolUse" && r.tool === "Task");
  assert.equal(dispatchRecords.length, 2, "exactly two Task dispatch records so far (primary + one re-dispatch)");
  const redispatch = dispatchRecords[1];
  assert.equal(redispatch.fallbackOf, "coding-specialist", "re-dispatch must carry the ORIGINAL slot id in fallbackOf");
  assert.equal(redispatch.fallbackDepth, 1, "first fallback re-dispatch is chain position 1");
  assert.equal(redispatch.model, "openai/gpt-5.4-mini", "re-dispatch model must be fallback[0], not the dead primary");
  assert.equal(redispatch.vendor, "openai", "re-dispatch vendor must match fallback[0]'s own vendor, not the primary's");

  // The matching SubagentStop for this re-dispatch must agree with the
  // spawn on model/vendor, even when OpenCode's own session metadata still
  // reports the ORIGINAL primary (anthropic/sonnet) rather than the
  // fallback model that actually ran — this is the bug: a stop record
  // observed with model "ollama-windows/qwen3.8:27b" while the matching
  // spawn said "opencode/big-pickle".
  await plugin.toolExecuteAfter(
    { tool: "task", sessionID: "root-session", args: { subagent_type: "coding-specialist" } },
    {
      metadata: {
        parentSessionId: "root-session",
        sessionId: "child-session-2",
        model: { providerID: "anthropic", modelID: "sonnet" },
      },
      output: "<task>done</task>",
    }
  );
  records = readActivity(plugin._paths.activityFile);
  const stopRecords = records.filter((r) => r.event === "SubagentStop");
  const fallbackStop = stopRecords.find((r) => r.fallbackOf === "coding-specialist");
  assert.ok(fallbackStop, "fallback re-dispatch must produce a SubagentStop record");
  assert.equal(
    fallbackStop!.model,
    redispatch.model,
    "SubagentStop model must match the fallback model the matching PreToolUse spawn used, not OpenCode's session metadata"
  );
  assert.equal(fallbackStop!.vendor, redispatch.vendor, "SubagentStop vendor must match the spawn's vendor");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(moduleDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (3) non-fallback per-agent totals unchanged: computeStateFromRecords full
// field-by-field shape check (minus fallbackCount), plus buildMetricsRollup
// and the per-agent cost path showing no diff from a hand-computed total.
// ---------------------------------------------------------------------------

interface RollupResult {
  byVendor: Array<{ vendor: string; tokens: number; costUsd: number | null; costLabel: string; agents: number }>;
  byCostClass: Array<{ costModelClass: string; tokens: number; costUsd: number | null; costLabel: string }>;
  fallbackCount: number;
  localTimeRows: Array<{ agent: string; vendor: string; model: string; activeMs: number }>;
}

interface RollupModule {
  buildMetricsRollup: (agentMetrics: unknown[] | undefined) => RollupResult;
  estCostUSDWithCache: (tokens: number, cacheReadTokens: number, model: string, explicitCostModelClass?: string) => number | null;
}

// Same closure-slicing technique as test/metricsRollup.test.ts and
// test/pricing.test.ts: buildMetricsRollup/estCostUSDWithCache are
// mutually-referencing top-level declarations in media/main.js's IIFE, so
// evaluating the contiguous slice via `new Function` yields real references.
function loadRollupModule(): RollupModule {
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
  const body = `${slice}\nreturn { buildMetricsRollup, estCostUSDWithCache };`;
  // eslint-disable-next-line no-new-func
  return new Function(body)() as RollupModule;
}

test("PRD M2 (3): computeStateFromRecords for a no-fallbackOf fixture matches the exact expected AgentMetric shape apart from fallbackCount:0", () => {
  const records: HookRecord[] = [
    {
      event: "PreToolUse",
      tool: "Task",
      workerId: "coding-specialist",
      model: "claude-sonnet-4-6",
      vendor: "anthropic",
      costModelClass: "metered",
      sessionId: "s-milestone-3",
      at: 1000,
    },
    {
      event: "SubagentStop",
      workerId: "coding-specialist",
      tokens: 300,
      sessionId: "s-milestone-3",
      at: 2000,
    },
  ];
  const state = computeStateFromRecords(records);
  const metric = state.agentMetrics.find((m) => m.id === "coding-specialist");
  assert.ok(metric, "coding-specialist metric should exist");

  // fallbackCount is the ONLY field this feature is allowed to add/change
  // for a non-fallback record stream — pull it out and check it separately.
  const { fallbackCount, ...rest } = metric!;
  assert.equal(fallbackCount, 0, "fallbackCount must default to 0 when no fallback dispatch occurred");
  assert.equal(metric!.fallbackOf, undefined, "fallbackOf must be absent for a non-fallback agent");
  assert.equal(metric!.fallbackDepth, undefined, "fallbackDepth must be absent for a non-fallback agent");

  // Every other field must exactly match what a non-fallback-aware reader
  // would have computed from these records — no field the fallback feature
  // touches (model, vendor, costModelClass, tokens, taskCount, status, ...)
  // may have shifted.
  assert.deepEqual(rest, {
    id: "coding-specialist",
    name: "Coding Specialist",
    model: "claude-sonnet-4-6",
    vendor: "anthropic",
    costModelClass: "metered",
    fallbackOf: undefined,
    fallbackDepth: undefined,
    description: undefined,
    tier: undefined,
    parentId: undefined,
    delegationMode: undefined,
    status: "idle",
    taskCount: 1,
    mcpCount: 0,
    activeMs: 1000,
    tokens: 300,
    cacheReadTokens: 0,
    workStartAt: null,
    lastActivityAt: 2000,
    directSearches: 0,
    directReads: 0,
    directEdits: 0,
    delegations: 0,
    modelBreakdown: undefined,
    cacheReadModelBreakdown: undefined,
    lastReport: undefined,
    lastReportChars: undefined,
  });

  // Same fixture's rollup and per-agent cost path must show no diff from a
  // hand-computed non-fallback total: buildMetricsRollup's fallbackCount
  // stays 0, and its per-vendor cost/tokens equal exactly what
  // estCostUSDWithCache computes directly off the metric's own fields.
  const rollupMod = loadRollupModule();
  const rollup = rollupMod.buildMetricsRollup(state.agentMetrics);
  assert.equal(rollup.fallbackCount, 0, "no fallback dispatches occurred -> rollup fallbackCount must be 0");
  assert.equal(rollup.localTimeRows.length, 0);

  const expectedCost = rollupMod.estCostUSDWithCache(metric!.tokens, metric!.cacheReadTokens, metric!.model!, metric!.costModelClass);
  const vendorRow = rollup.byVendor.find((v) => v.vendor === "anthropic");
  assert.ok(vendorRow, "anthropic vendor row should exist");
  assert.equal(vendorRow!.tokens, metric!.tokens + metric!.cacheReadTokens, "vendor row tokens must equal the agent's own tokens (single agent, no fallback redirection)");
  assert.equal(vendorRow!.costUsd, expectedCost, "vendor row cost must equal the directly-computed per-agent cost, with no fallback-attribution diff");
  assert.equal(vendorRow!.agents, 1);

  const classRow = rollup.byCostClass.find((c) => c.costModelClass === "metered");
  assert.ok(classRow, "metered cost-class row should exist");
  assert.equal(classRow!.costUsd, expectedCost, "cost-class row cost must equal the directly-computed per-agent cost");
});
