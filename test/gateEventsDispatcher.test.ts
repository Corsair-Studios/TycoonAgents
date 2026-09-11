/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tests hooks/gateEvents.cjs (plan p29-t3) directly, and its wiring into
// hooks/tycoon-dispatcher-mcp.cjs's delegate tool result: an unseen gate
// event is prefixed onto the result text exactly once, then not surfaced
// again on a subsequent call once the cursor has advanced.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gateEvents = require("../../hooks/gateEvents.cjs") as {
  readUnseenGateEvents: (tycoonDir: string, cursorFileName?: string) => Record<string, unknown>[];
  formatGateEventLine: (evt: Record<string, unknown>) => string;
  formatGateEventLines: (events: Record<string, unknown>[]) => string;
  sanitizeGateText: (value: unknown, maxLen: number) => string;
};

function makeTycoonDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-gate-events-test-"));
  return dir;
}

function writeGateEvent(tycoonDir: string, evt: Record<string, unknown>) {
  fs.appendFileSync(path.join(tycoonDir, "gate-events.jsonl"), JSON.stringify(evt) + "\n", "utf8");
}

test("gateEvents: readUnseenGateEvents returns [] when no events file exists", () => {
  const dir = makeTycoonDir();
  assert.deepEqual(gateEvents.readUnseenGateEvents(dir, "gate-events.codex.cursor"), []);
});

test("gateEvents: reads new events once, then nothing until more are appended", () => {
  const dir = makeTycoonDir();
  writeGateEvent(dir, { gate: "approved", phaseNum: 2, name: "Design", ts: "2026-09-11T00:00:00Z", source: "user" });

  const first = gateEvents.readUnseenGateEvents(dir, "gate-events.codex.cursor");
  assert.equal(first.length, 1);
  assert.equal(first[0].gate, "approved");

  const second = gateEvents.readUnseenGateEvents(dir, "gate-events.codex.cursor");
  assert.deepEqual(second, []);

  writeGateEvent(dir, { gate: "approved", phaseNum: 3, name: "Build", ts: "2026-09-11T00:05:00Z", source: "user" });
  const third = gateEvents.readUnseenGateEvents(dir, "gate-events.codex.cursor");
  assert.equal(third.length, 1);
  assert.equal(third[0].phaseNum, 3);
});

test("gateEvents: separate cursor files track independent positions in the same jsonl", () => {
  const dir = makeTycoonDir();
  writeGateEvent(dir, { gate: "approved", phaseNum: 1, name: "Plan", ts: "t1", source: "user" });

  const codexSeen = gateEvents.readUnseenGateEvents(dir, "gate-events.codex.cursor");
  assert.equal(codexSeen.length, 1);

  // OpenCode's own cursor hasn't advanced — it still sees the same event.
  const opencodeSeen = gateEvents.readUnseenGateEvents(dir, "gate-events.opencode.cursor");
  assert.equal(opencodeSeen.length, 1);

  // Codex's cursor is now past it; OpenCode's is independently advanced too.
  assert.deepEqual(gateEvents.readUnseenGateEvents(dir, "gate-events.codex.cursor"), []);
  assert.deepEqual(gateEvents.readUnseenGateEvents(dir, "gate-events.opencode.cursor"), []);
});

test("gateEvents: formatGateEventLines sanitizes and formats", () => {
  const line = gateEvents.formatGateEventLine({
    gate: "approved",
    phaseNum: 4,
    name: "Ship\nit",
    ts: "2026-09-11T00:00:00Z",
    source: "user",
  });
  assert.equal(line, "Plan gate update: phase 4 Ship it approved at 2026-09-11T00:00:00Z (user).");
  assert.equal(gateEvents.formatGateEventLines([]), "");
});

// ---------------------------------------------------------------------------
// Dispatcher wiring
// ---------------------------------------------------------------------------

function makeProjectDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-dispatcher-gate-test-"));
  fs.mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", "tycoon"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude", "tycoon", "agent-keywords.json"),
    JSON.stringify({
      fallback_agent: "primary-agent",
      agents: { "coding-specialist": { pattern: "implement|code|fix|bug|refactor" } },
    }),
  );
  fs.writeFileSync(path.join(dir, ".claude", "agents", "coding-specialist.md"), "---\nmodel: sonnet\n---\nbody");
  fs.writeFileSync(path.join(dir, ".claude", "agents", "primary-agent.md"), "---\nmodel: sonnet\n---\nbody");
  fs.writeFileSync(
    path.join(dir, ".claude", "agents", "claude-worker.md"),
    "---\nbackend:\n  vendor: anthropic\n  model: claude-sonnet-4-6\n  costModelClass: subscription\n---\nbody",
  );
  return dir;
}

function loadDispatcherModule(projectDir: string) {
  const modPath = require.resolve("../../hooks/tycoon-dispatcher-mcp.cjs");
  delete require.cache[modPath];
  const prevProjectDir = process.env.TYCOON_PROJECT_DIR;
  const prevAdapter = process.env.TYCOON_DISPATCH_ADAPTER;
  process.env.TYCOON_PROJECT_DIR = projectDir;
  process.env.TYCOON_DISPATCH_ADAPTER = "stub";
  const mod = require(modPath) as {
    handleDelegateTool: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;
  };
  return {
    mod,
    restore: () => {
      if (prevProjectDir === undefined) delete process.env.TYCOON_PROJECT_DIR; else process.env.TYCOON_PROJECT_DIR = prevProjectDir;
      if (prevAdapter === undefined) delete process.env.TYCOON_DISPATCH_ADAPTER; else process.env.TYCOON_DISPATCH_ADAPTER = prevAdapter;
    },
  };
}

test("dispatcher delegate: prefixes an unseen gate event onto the result text once, then not again", async () => {
  const projectDir = makeProjectDir();
  const tycoonDir = path.join(projectDir, ".claude", "tycoon");
  writeGateEvent(tycoonDir, { gate: "approved", phaseNum: 5, name: "Rollout", ts: "2026-09-11T01:00:00Z", source: "user" });

  const { mod, restore } = loadDispatcherModule(projectDir);
  try {
    const first = await mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" });
    assert.equal(first.isError, undefined);
    const firstText = first.content[0].text;
    assert.match(firstText, /^Plan gate update: phase 5 Rollout approved at 2026-09-11T01:00:00Z \(user\)\.\n\n/);

    const second = await mod.handleDelegateTool({ specialist: "coding-specialist", task: "do another thing" });
    assert.equal(second.isError, undefined);
    assert.doesNotMatch(second.content[0].text, /Plan gate update:/);
  } finally {
    restore();
  }
});

test("dispatcher delegate: no gate-events file means no prefix and no error", async () => {
  const projectDir = makeProjectDir();
  const { mod, restore } = loadDispatcherModule(projectDir);
  try {
    const result = await mod.handleDelegateTool({ specialist: "coding-specialist", task: "do a thing" });
    assert.equal(result.isError, undefined);
    assert.doesNotMatch(result.content[0].text, /Plan gate update:/);
  } finally {
    restore();
  }
});
