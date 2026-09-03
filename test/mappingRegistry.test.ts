/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { registerMapper, getMapper, hasMapper, tryMapRecord } from "../src/core/mappingRegistry";
import { computeStateFromRecords } from "../src/core/state";
import { mapHookRecord } from "../src/providers/claude-code/mapHookRecord";
import { applyEvent, initialWorldState } from "../src/core/state";
import "../src/providers/claude-code/index";
import type { HookRecord } from "../src/providers/claude-code/hookRecord";
import type { NormalizedEvent } from "../src/core/events";

const T = 1700000000000;

// ---------------------------------------------------------------------------
// (a) a custom-registered provider mapper drives computeStateFromRecords
// ---------------------------------------------------------------------------

test("registerMapper: a dummy provider's events drive computeStateFromRecords, not the claude-code mapper", () => {
  registerMapper("dummy-x", (): NormalizedEvent[] => [
    { type: "WorkerSpawned", at: T, workerId: "dummy-worker" },
  ]);

  const records = [{ event: "PreToolUse", tool: "Edit", provider: "dummy-x", at: T }];
  const { agentMetrics } = computeStateFromRecords(records as unknown as HookRecord[]);

  const dummy = agentMetrics.find((m) => m.id === "dummy-worker");
  assert.ok(dummy, "dummy mapper's WorkerSpawned should produce a dummy-worker metric");

  // The claude-code mapper would have treated this record as an orchestrator
  // Edit; assert that never happened because dispatch went to dummy-x instead.
  const orchestrator = agentMetrics.find((m) => m.id === "orchestrator");
  assert.ok(!orchestrator || orchestrator.directEdits === 0, "claude-code mapping of this record must not have occurred");
});

// ---------------------------------------------------------------------------
// (b) records without a `provider` field match mapHookRecord's own output
// ---------------------------------------------------------------------------

test("mapRecord (via computeStateFromRecords): records with no provider field match mapHookRecord folded manually", () => {
  const records: HookRecord[] = [
    { event: "PreToolUse", tool: "Edit", sessionId: "A", at: T },
    { event: "PreToolUse", tool: "Grep", sessionId: "A", at: T + 1 },
    { event: "SubagentStop", workerId: "coding-specialist", tokens: 100, sessionId: "A", at: T + 2 },
  ];

  const viaRegistry = computeStateFromRecords(records, "A");

  let manual = initialWorldState();
  for (const r of records) {
    for (const ev of mapHookRecord(r)) {
      manual = applyEvent(manual, ev);
    }
  }

  assert.deepStrictEqual(viaRegistry.agentMetrics, manual.agentMetrics);
  assert.deepStrictEqual(viaRegistry.lastActivityAt, manual.lastActivityAt);
});

// ---------------------------------------------------------------------------
// (c) getMapper on an unregistered id throws with a descriptive message
// ---------------------------------------------------------------------------

test("getMapper: unregistered provider id throws, listing it and claude-code among registered ids", () => {
  assert.throws(
    () => getMapper("never-registered"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /never-registered/);
      assert.match(err.message, /claude-code/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// (d) lazy default registration: requiring only out/src/core/state.js works
// ---------------------------------------------------------------------------

test("lazy default: computeStateFromRecords works in a fresh process that never requires the providers index", () => {
  // __dirname here is out/test (this file compiles to out/test/mappingRegistry.test.js);
  // the compiled state.js lives alongside it at out/src/core/state.js.
  const stateJsPath = path.join(__dirname, "..", "src", "core", "state.js").replace(/\\/g, "\\\\");

  const script = `
    const { computeStateFromRecords } = require("${stateJsPath}");
    const T = ${T};
    const records = [
      { event: "PreToolUse", tool: "Edit", sessionId: "S", at: T },
    ];
    const state = computeStateFromRecords(records, "S");
    const orchestrator = state.agentMetrics.find((m) => m.id === "orchestrator");
    if (!orchestrator || orchestrator.directEdits !== 1) {
      console.error("FAIL", JSON.stringify(state.agentMetrics));
      process.exit(1);
    }
    console.log("OK");
  `;

  const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.match(out, /OK/);
});

// ---------------------------------------------------------------------------
// (e) hasMapper reflects the claude-code provider registration
// ---------------------------------------------------------------------------

test("hasMapper: 'claude-code' is registered after importing the claude-code provider index", () => {
  assert.equal(hasMapper("claude-code"), true);
});

// ---------------------------------------------------------------------------
// (f) computeStateFromRecords skips records with an unregistered provider
// ---------------------------------------------------------------------------

test("computeStateFromRecords: unregistered provider record is skipped, not thrown", () => {
  const validRecords: HookRecord[] = [
    { event: "PreToolUse", tool: "Edit", sessionId: "B", at: T },
    { event: "PreToolUse", tool: "Grep", sessionId: "B", at: T + 1 },
  ];
  const mixedRecords = [
    validRecords[0],
    { provider: "bogus", event: "PreToolUse", tool: "Read", at: T + 1 },
    validRecords[1],
  ];

  const expected = computeStateFromRecords(validRecords, "B");
  let actual: ReturnType<typeof computeStateFromRecords> | undefined;
  assert.doesNotThrow(() => {
    actual = computeStateFromRecords(mixedRecords as unknown as HookRecord[], "B");
  });
  assert.deepStrictEqual(actual!.agentMetrics, expected.agentMetrics);
});

// ---------------------------------------------------------------------------
// (g) console.warn fires exactly once per distinct unregistered provider id
// ---------------------------------------------------------------------------

test("computeStateFromRecords: warns once per distinct unregistered provider id", () => {
  const originalWarn = console.warn;
  const calls: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    const records = [
      { provider: "bogus2", event: "PreToolUse", tool: "Read", at: T },
      { provider: "bogus2", event: "PreToolUse", tool: "Read", at: T + 1 },
    ];
    computeStateFromRecords(records as unknown as HookRecord[]);
  } finally {
    console.warn = originalWarn;
  }
  const bogusWarnings = calls.filter((args) => args.some((a) => typeof a === "string" && a.includes("bogus2")));
  assert.equal(bogusWarnings.length, 1, `expected exactly one warning for 'bogus2', got ${bogusWarnings.length}`);
});

// ---------------------------------------------------------------------------
// (h) tryMapRecord returns undefined for unregistered providers; getMapper throws
// ---------------------------------------------------------------------------

test("tryMapRecord: returns undefined for an unregistered provider, unlike getMapper", () => {
  const result = tryMapRecord({ provider: "bogus3", event: "PreToolUse", tool: "Read", at: T });
  assert.equal(result, undefined);
  assert.throws(() => getMapper("bogus3"));
});
