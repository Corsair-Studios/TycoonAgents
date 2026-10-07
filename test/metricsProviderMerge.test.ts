/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Regression: one agent = one Metrics row. A real shared activity.jsonl mixes
// claude-code records (no provider tag) with codex-provider records. Those
// used to produce two Orchestrator rows, two Codex Reviewer rows and a stray
// Codex Agent row. Fixture is trimmed from a real dispatch-testbed log.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapHookRecord } from "../src/providers/claude-code/mapHookRecord";
import type { HookRecord } from "../src/providers/claude-code/hookRecord";
import { applyEvent, initialWorldState } from "../src/core/state";

const REPO_ROOT = join(__dirname, "..", "..");
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "activity-multi-provider-dupes.jsonl");

function reduce(filter?: (r: HookRecord) => boolean) {
  let state = initialWorldState();
  for (const line of readFileSync(FIXTURE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as HookRecord;
    if (filter && !filter(rec)) continue;
    for (const ev of mapHookRecord(rec)) state = applyEvent(state, ev);
  }
  return state;
}

test("mixed claude-code + codex log yields one row per agent id", () => {
  const ids = reduce().agentMetrics.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(",")}`);
  assert.equal(ids.filter((i) => i === "orchestrator").length, 1);
  assert.equal(ids.filter((i) => i === "codex-reviewer").length, 1);
});

test("merging loses no task or token totals", () => {
  const state = reduce();
  const sum = (k: "taskCount" | "tokens" | "activeMs") =>
    state._agentMetricsInternal.reduce((a, m) => a + m[k], 0);
  const pub = (k: "taskCount" | "tokens" | "activeMs") => state.agentMetrics.reduce((a, m) => a + m[k], 0);
  for (const k of ["taskCount", "tokens", "activeMs"] as const) assert.equal(pub(k), sum(k), k);
  const cr = state.agentMetrics.find((m) => m.id === "codex-reviewer")!;
  const crInternal = state._agentMetricsInternal.filter((m) => m.id === "codex-reviewer");
  assert.equal(crInternal.length, 2, "internals stay per-provider");
  assert.equal(cr.taskCount, crInternal[0]!.taskCount + crInternal[1]!.taskCount);
  assert.ok(cr.tokens > 0);
});

test("per-session scoping is preserved: filtering to the claude session excludes codex-provider rows", () => {
  const state = reduce((r) => r.provider !== "codex");
  const cr = state.agentMetrics.find((m) => m.id === "codex-reviewer")!;
  const full = reduce().agentMetrics.find((m) => m.id === "codex-reviewer")!;
  assert.equal(cr.taskCount + 1, full.taskCount);
});

import type { NormalizedEvent } from "../src/core/events";

test("merge precedence: active row's description/status/liveSpawns win, totals sum", () => {
  const T = 1700000000000;
  let s = initialWorldState();
  const ev = (e: Partial<NormalizedEvent> & { type: string }) => (s = applyEvent(s, e as NormalizedEvent));
  ev({ type: "WorkerSpawned", at: T, workerId: "codex-reviewer", role: "r", provider: "claude-code", spawnId: "s1", currentDescription: "old run" });
  ev({ type: "WorkerStopped", at: T + 10, workerId: "codex-reviewer", provider: "claude-code", spawnId: "s1", tokens: 100 });
  ev({ type: "WorkerSpawned", at: T + 20, workerId: "codex-reviewer", role: "r", provider: "codex", spawnId: "s2", currentDescription: "live run" });
  const rows = s.agentMetrics.filter((m) => m.id === "codex-reviewer");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "active");
  assert.equal(rows[0]!.currentDescription, "live run");
  assert.deepEqual(rows[0]!.liveSpawns, ["s2"]);
  assert.equal(rows[0]!.tokens, 100);
});
