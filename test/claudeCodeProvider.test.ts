/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ClaudeCodeProvider (src/providers/claude-code/claudeCodeProvider.ts) tails
// activity.jsonl and never touches vscode, so it's constructible directly
// under plain `node --test` (no module stub needed, unlike reviewSynthesis's
// vscode-entangled target). drain() is private and timer-driven in normal
// use; these tests call it directly via an `any` cast so behavior can be
// exercised deterministically, one tick at a time, without real timers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeProvider } from "../src/providers/claude-code/claudeCodeProvider";
import type { NormalizedEvent } from "../src/core/events";

function setupFile(initial = ""): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "tycoon-provider-test-"));
  const file = join(dir, "activity.jsonl");
  writeFileSync(file, initial, "utf8");
  return { dir, file };
}

function makeProvider(file: string): ClaudeCodeProvider {
  return new ClaudeCodeProvider({ activityFile: file });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function drainNow(provider: ClaudeCodeProvider, emit: (e: NormalizedEvent) => void): Promise<void> {
  await (provider as any).drain(emit);
}

function record(at: number): string {
  return JSON.stringify({ event: "UserPromptSubmit", at });
}

test("complete lines parse into events", async () => {
  const { dir, file } = setupFile(`${record(1)}\n${record(2)}\n`);
  try {
    const provider = makeProvider(file);
    const events: NormalizedEvent[] = [];
    await drainNow(provider, (e) => events.push(e));
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "SessionStart");
    assert.equal(events[1].type, "SessionStart");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a partial trailing line is not lost", async () => {
  const { dir, file } = setupFile(`${record(1)}\n`);
  try {
    const provider = makeProvider(file);
    const events: NormalizedEvent[] = [];

    // Writer flushes a record but hasn't written its trailing newline yet.
    appendFileSync(file, '{"event":"Stop","at":2', "utf8");
    await drainNow(provider, (e) => events.push(e));
    // Only the first, complete line should have been emitted so far.
    assert.equal(events.length, 1);

    // Writer completes the record on a later flush.
    appendFileSync(file, "}\n", "utf8");
    await drainNow(provider, (e) => events.push(e));
    assert.equal(events.length, 2);
    assert.equal(events[1].type, "SessionStop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("truncation resets offset to 0", async () => {
  const { dir, file } = setupFile(`${record(1)}\n${record(2)}\n`);
  try {
    const provider = makeProvider(file);
    const events: NormalizedEvent[] = [];
    await drainNow(provider, (e) => events.push(e));
    assert.equal(events.length, 2);

    // Simulate rotation: file is truncated and rewritten smaller than the
    // prior offset.
    writeFileSync(file, `${record(3)}\n`, "utf8");
    await drainNow(provider, (e) => events.push(e));
    assert.equal(events.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed JSON line is skipped without aborting the batch", async () => {
  const { dir, file } = setupFile(`${record(1)}\nnot json\n${record(2)}\n`);
  try {
    const provider = makeProvider(file);
    const events: NormalizedEvent[] = [];
    await drainNow(provider, (e) => events.push(e));
    assert.equal(events.length, 2);
    assert.equal(events[0].at, 1);
    assert.equal(events[1].at, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chunk cap is honored across ticks: a large backlog drains fully over multiple calls", async () => {
  // Build a backlog comfortably larger than the provider's 4MB read cap so a
  // single drain() call cannot consume it in one pass.
  const line = record(1) + "\n"; // fixed-size, valid line
  const lineCount = Math.ceil((5 * 1024 * 1024) / line.length);
  const backlog = line.repeat(lineCount);
  const { dir, file } = setupFile(backlog);
  try {
    const provider = makeProvider(file);
    const events: NormalizedEvent[] = [];

    await drainNow(provider, (e) => events.push(e));
    const offsetAfterFirstTick = (provider as any).offset as number;
    assert.ok(
      offsetAfterFirstTick > 0 && offsetAfterFirstTick < backlog.length,
      "first tick should make partial progress, not drain the whole backlog",
    );
    assert.ok(
      offsetAfterFirstTick <= 4 * 1024 * 1024,
      "a single tick must not read past the chunk cap",
    );

    let ticks = 1;
    while ((provider as any).offset < backlog.length && ticks < 10) {
      await drainNow(provider, (e) => events.push(e));
      ticks += 1;
    }

    assert.ok(ticks > 1, "backlog should require more than one drain() call");
    assert.equal((provider as any).offset, backlog.length, "backlog should fully drain eventually");
    assert.equal(events.length, lineCount, "every line in the backlog should have been parsed exactly once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
