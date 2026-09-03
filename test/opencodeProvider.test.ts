/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Mirrors test/state.test.ts's model/vendor/tokens assertions and
// test/claudeCodeProvider.test.ts's drain-driving pattern, but for the
// opencode provider: src/providers/opencode/index.ts (OpenCodeProvider),
// mapOpenCodeRecord.ts (registered as "opencode", delegates to
// mapHookRecord, PluginError -> []), and src/core/mappingRegistry.ts's
// getMapper/tryMapRecord dispatch by record.provider.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeStateFromRecords } from "../src/core/state";
import { getMapper, tryMapRecord } from "../src/core/mappingRegistry";
import "../src/providers/claude-code"; // registers "claude-code" mapper
import "../src/providers/opencode"; // registers "opencode" mapper
import { OpenCodeProvider } from "../src/providers/opencode";
import type { NormalizedEvent } from "../src/core/events";

const T = 1700000000000;

const fixtureLines = [
  { event: "UserPromptSubmit", provider: "opencode", sessionId: "S", at: T },
  {
    event: "PreToolUse",
    tool: "Task",
    provider: "opencode",
    workerId: "probe-sub",
    agentDescription: "probe",
    sessionId: "S",
    parentId: "orchestrator",
    model: "openai/gpt-5",
    at: T + 1,
  },
  // vendor/costModelClass ride on a WorkerActivity-shaped PreToolUse record
  // (mapHookRecord only threads vendor/costModelClass through the non-Task
  // "WorkerActivity" branch, not the Task-spawn "WorkerSpawned" branch — see
  // src/providers/claude-code/mapHookRecord.ts's PreToolUse switch).
  {
    event: "PreToolUse",
    tool: "Read",
    provider: "opencode",
    workerId: "probe-sub",
    model: "openai/gpt-5",
    vendor: "openai",
    costModelClass: "metered",
    sessionId: "S",
    at: T + 2,
  },
  {
    event: "SubagentStop",
    provider: "opencode",
    workerId: "probe-sub",
    tokens: 1234,
    cacheReadTokens: 500,
    sessionId: "S",
    at: T + 3,
  },
  { event: "Stop", provider: "opencode", sessionId: "S", at: T + 4 },
];

function setupFile(initial = ""): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "tycoon-opencode-provider-test-"));
  const file = join(dir, "activity.jsonl");
  writeFileSync(file, initial, "utf8");
  return { dir, file };
}

function toLines(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

test("(a) opencode fixture lines map through getMapper('opencode') into a session with agentMetrics for the worker", () => {
  const state = computeStateFromRecords(fixtureLines as any, "S");
  assert.ok(state.lastActivityAt !== null, "session should register activity");
  const worker = state.agentMetrics.find((m) => m.id === "probe-sub");
  assert.ok(worker, "probe-sub agentMetric should exist");
  assert.equal(worker!.model, "openai/gpt-5");
  assert.equal(worker!.vendor, "openai");
  assert.equal(worker!.tokens, 1234);
  assert.equal(worker!.cacheReadTokens, 500);

  // Direct getMapper('opencode') dispatch on the PreToolUse Task record
  // should behave the same as tryMapRecord's provider-field dispatch.
  const mapper = getMapper("opencode");
  const viaMapper = mapper(fixtureLines[1]);
  const viaTryMap = tryMapRecord(fixtureLines[1]);
  assert.deepEqual(viaMapper, viaTryMap);
});

test("(b) mixed claude-code + opencode lines both map, no cross-talk", () => {
  const mixed = [
    { event: "SubagentStop", provider: "claude-code", workerId: "cc-worker", tokens: 10, sessionId: "M", at: T },
    {
      event: "SubagentStop",
      provider: "opencode",
      workerId: "oc-worker",
      tokens: 20,
      sessionId: "M",
      at: T + 1,
    },
  ];
  const state = computeStateFromRecords(mixed as any, "M");
  const cc = state.agentMetrics.find((m) => m.id === "cc-worker");
  const oc = state.agentMetrics.find((m) => m.id === "oc-worker");
  assert.ok(cc, "claude-code worker should be mapped");
  assert.ok(oc, "opencode worker should be mapped");
  assert.equal(cc!.tokens, 10);
  assert.equal(oc!.tokens, 20);
});

test("(c) a PluginError line yields no events and does not throw", () => {
  const record = { event: "PluginError", provider: "opencode", error: "boom", at: T };
  assert.doesNotThrow(() => {
    const events = tryMapRecord(record);
    assert.deepEqual(events, []);
  });
});

test("(d) createProvider returns the right provider class per id", async () => {
  const { createProvider } = await import("../src/host/vscode/providerFactory");
  const { ClaudeCodeProvider } = await import("../src/providers/claude-code");
  const file = join(tmpdir(), "activity.jsonl");
  const oc = createProvider("opencode", file);
  const cc = createProvider("claude-code", file);
  assert.ok(oc instanceof OpenCodeProvider);
  assert.ok(cc instanceof ClaudeCodeProvider);
});

test("(e) OpenCodeProvider.start(emit) tails a real file and stop() halts emissions", async () => {
  const { dir, file } = setupFile("");
  try {
    const provider = new OpenCodeProvider({ activityFile: file, pollIntervalMs: 20 });
    const events: NormalizedEvent[] = [];
    provider.start((e) => events.push(e));

    appendFileSync(file, toLines(fixtureLines), "utf8");

    // Poll until events show up (bounded wait), rather than a fixed sleep.
    const deadline = Date.now() + 3000;
    while (events.length < 6 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    // 6 events from 5 lines: SubagentStop maps to TWO events (TaskCompleted +
    // WorkerStopped), everything else maps 1:1 (see mapHookRecord.ts).
    assert.equal(events.length, 6, "all fixture lines should have been emitted");
    assert.equal(events[0].type, "SessionStart");
    assert.equal(events[events.length - 1].type, "SessionStop");

    provider.stop();
    const countAfterStop = events.length;
    appendFileSync(file, toLines([{ event: "Stop", provider: "opencode", sessionId: "S", at: T + 100 }]), "utf8");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(events.length, countAfterStop, "no further events should be emitted after stop()");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
