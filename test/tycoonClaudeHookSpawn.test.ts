/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// hooks/tycoon-claude-hook.cjs is a standalone CJS script (no module.exports),
// invoked fresh as a child process for every hook event in real usage. It is
// not unit-testable via require() without side effects, so these tests drive
// it the way Claude Code does: spawn the script, pipe a JSON payload on
// stdin, and inspect the activity.jsonl it writes under a scratch
// CLAUDE_PROJECT_DIR. This exercises the parentId push/pop (active-agent
// stack) and tier (agent .md frontmatter) additions end-to-end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK_PATH = join(process.cwd(), "hooks", "tycoon-claude-hook.cjs");

interface ActivityRecord {
  event: string;
  workerId?: string;
  tier?: string;
  parentId?: string;
  delegationMode?: string;
  [key: string]: unknown;
}

function runHook(projectRoot: string, payload: Record<string, unknown>): void {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
  });
  assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);
}

function readActivity(projectRoot: string): ActivityRecord[] {
  const activityPath = join(projectRoot, ".claude", "tycoon", "activity.jsonl");
  const raw = readFileSync(activityPath, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ActivityRecord);
}

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), "tycoon-hook-test-"));
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "build-lead.md"),
    "---\ndescription: Leads the build team.\nmodel: opus\ntier: lead\n---\nBody.\n",
    "utf8",
  );
  writeFileSync(
    join(agentsDir, "coding-specialist.md"),
    "---\ndescription: Implements code.\nmodel: sonnet\n---\nBody.\n",
    "utf8",
  );
  writeFileSync(
    join(agentsDir, "ux-ui-designer.md"),
    "---\ndescription: Designs UI.\nmodel: sonnet\n---\nBody.\n",
    "utf8",
  );
  return root;
}

test("hook records tier on a lead spawn and no parentId at top level", () => {
  const root = setupProject();
  try {
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "build-lead", description: "lead the build team", prompt: "own build domain" },
      session_id: "test-session-1",
    });
    const records = readActivity(root);
    const leadSpawn = records.find((r) => r.event === "PreToolUse" && r.workerId === "build-lead");
    assert.ok(leadSpawn, "expected a spawn record for build-lead");
    assert.equal(leadSpawn!.tier, "lead");
    assert.equal(leadSpawn!.parentId, undefined, "top-level spawn must have no parentId");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook records parentId on a worker spawned while a lead is active on the stack", () => {
  const root = setupProject();
  try {
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "build-lead", description: "lead the build team", prompt: "own build domain" },
      session_id: "test-session-1",
    });
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "coding-specialist", description: "implement widget", prompt: "write code" },
      session_id: "test-session-1",
    });
    const records = readActivity(root);
    const workerSpawn = records.find((r) => r.event === "PreToolUse" && r.workerId === "coding-specialist");
    assert.ok(workerSpawn, "expected a spawn record for coding-specialist");
    assert.equal(workerSpawn!.parentId, "build-lead");
    assert.equal(workerSpawn!.tier, undefined, "coding-specialist.md has no tier field");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SubagentStop pops the stack so the next sibling spawn is still attributed to the lead", () => {
  const root = setupProject();
  try {
    // lead spawns
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "build-lead" },
      session_id: "test-session-1",
    });
    // lead spawns worker #1
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "coding-specialist" },
      session_id: "test-session-1",
    });
    // worker #1 finishes and is popped
    runHook(root, {
      hook_event_name: "SubagentStop",
      tool_input: { subagent_type: "coding-specialist" },
      session_id: "test-session-1",
    });
    // lead spawns worker #2 — parent should still be build-lead, not coding-specialist
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "ux-ui-designer" },
      session_id: "test-session-1",
    });
    const records = readActivity(root);
    const secondWorkerSpawn = records.find((r) => r.event === "PreToolUse" && r.workerId === "ux-ui-designer");
    assert.ok(secondWorkerSpawn, "expected a spawn record for ux-ui-designer");
    assert.equal(secondWorkerSpawn!.parentId, "build-lead");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook never crashes (exit 0) on a payload missing all optional fields", () => {
  const root = setupProject();
  try {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Task" }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(result.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// delegationMode stamping (Team Lead Mode Phase 4: measurement)
// ---------------------------------------------------------------------------

test("hook stamps delegationMode 'flat' by default when execution.json is missing", () => {
  const root = setupProject();
  try {
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "coding-specialist" },
      session_id: "test-session-mode-1",
    });
    const records = readActivity(root);
    const spawn = records.find((r) => r.event === "PreToolUse" && r.workerId === "coding-specialist");
    assert.ok(spawn, "expected a spawn record");
    assert.equal(spawn!.delegationMode, "flat");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook stamps delegationMode from .claude/tycoon/execution.json when set to team_leads", () => {
  const root = setupProject();
  try {
    const tycoonDir = join(root, ".claude", "tycoon");
    mkdirSync(tycoonDir, { recursive: true });
    writeFileSync(join(tycoonDir, "execution.json"), JSON.stringify({ delegation_mode: "team_leads" }), "utf8");

    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "build-lead" },
      session_id: "test-session-mode-2",
    });
    // Stop maps to SessionStop, which also carries delegationMode.
    runHook(root, { hook_event_name: "Stop", session_id: "test-session-mode-2" });

    const records = readActivity(root);
    const spawn = records.find((r) => r.event === "PreToolUse" && r.workerId === "build-lead");
    const stop = records.find((r) => r.event === "Stop");
    assert.ok(spawn, "expected a spawn record");
    assert.equal(spawn!.delegationMode, "team_leads");
    assert.ok(stop, "expected a Stop record");
    assert.equal(stop!.delegationMode, "team_leads");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook falls back to 'flat' when execution.json contains invalid JSON (never throws)", () => {
  const root = setupProject();
  try {
    const tycoonDir = join(root, ".claude", "tycoon");
    mkdirSync(tycoonDir, { recursive: true });
    writeFileSync(join(tycoonDir, "execution.json"), "{ not valid json", "utf8");

    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: { subagent_type: "coding-specialist" },
        session_id: "test-session-mode-3",
      }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);

    const records = readActivity(root);
    const spawn = records.find((r) => r.event === "PreToolUse" && r.workerId === "coding-specialist");
    assert.ok(spawn, "expected a spawn record");
    assert.equal(spawn!.delegationMode, "flat", "invalid JSON must fall back to flat, not throw");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Session Journal (opt-in, default off): UserPromptSubmit appends
// .claude/session-journal.json when execution.json's sessionJournalEntries
// is set. Reuses the runHook/setupProject helpers above; each session-journal
// interface is its own child-process invocation, so the hook's per-process
// caches (cachedSessionJournalEntries etc.) never leak across tests.
// ---------------------------------------------------------------------------

interface JournalEntry {
  timestamp: string;
  prompt: string;
  summary: string | null;
  [key: string]: unknown;
}

interface JournalFile {
  maxEntries: number;
  entries: JournalEntry[];
  [key: string]: unknown;
}

function journalPath(projectRoot: string): string {
  return join(projectRoot, ".claude", "session-journal.json");
}

function writeExecutionConfigFile(projectRoot: string, config: Record<string, unknown>): void {
  const tycoonDir = join(projectRoot, ".claude", "tycoon");
  mkdirSync(tycoonDir, { recursive: true });
  writeFileSync(join(tycoonDir, "execution.json"), JSON.stringify(config), "utf8");
}

function submitPrompt(projectRoot: string, prompt: string, sessionId = "journal-session"): void {
  runHook(projectRoot, { hook_event_name: "UserPromptSubmit", prompt, session_id: sessionId });
}

test("Session Journal: setting sessionJournalEntries:3 and submitting a prompt creates session-journal.json", () => {
  const root = setupProject();
  try {
    writeExecutionConfigFile(root, { delegation_mode: "flat", sessionJournalEntries: 3 });
    submitPrompt(root, "first prompt");

    const journal = JSON.parse(readFileSync(journalPath(root), "utf8")) as JournalFile;
    assert.equal(journal.maxEntries, 3);
    assert.equal(journal.entries.length, 1);
    assert.equal(journal.entries[0].prompt, "first prompt");
    assert.equal(journal.entries[0].summary, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Session Journal: 5 successive appends at N=3 trim to the last 3 entries, most recent last", () => {
  const root = setupProject();
  try {
    writeExecutionConfigFile(root, { delegation_mode: "flat", sessionJournalEntries: 3 });
    for (let i = 1; i <= 5; i++) {
      submitPrompt(root, `prompt ${i}`);
    }

    const journal = JSON.parse(readFileSync(journalPath(root), "utf8")) as JournalFile;
    assert.equal(journal.maxEntries, 3);
    assert.equal(journal.entries.length, 3);
    assert.deepEqual(
      journal.entries.map((e) => e.prompt),
      ["prompt 3", "prompt 4", "prompt 5"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Session Journal: a prompt longer than 300 chars is truncated with an ellipsis", () => {
  const root = setupProject();
  try {
    writeExecutionConfigFile(root, { delegation_mode: "flat", sessionJournalEntries: 3 });
    const longPrompt = "x".repeat(400);
    submitPrompt(root, longPrompt);

    const journal = JSON.parse(readFileSync(journalPath(root), "utf8")) as JournalFile;
    assert.equal(journal.entries[0].prompt.length, 303, "300 chars + '...'");
    assert.equal(journal.entries[0].prompt, "x".repeat(300) + "...");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Session Journal: an existing entry's non-null summary survives a later append", () => {
  const root = setupProject();
  try {
    writeExecutionConfigFile(root, { delegation_mode: "flat", sessionJournalEntries: 3 });
    submitPrompt(root, "prompt one");

    // Simulate the assistant filling in the summary for the first entry.
    const beforePath = journalPath(root);
    const before = JSON.parse(readFileSync(beforePath, "utf8")) as JournalFile;
    before.entries[0].summary = "Did the thing.";
    writeFileSync(beforePath, JSON.stringify(before, null, 2), "utf8");

    submitPrompt(root, "prompt two");

    const after = JSON.parse(readFileSync(beforePath, "utf8")) as JournalFile;
    assert.equal(after.entries.length, 2);
    assert.equal(after.entries[0].summary, "Did the thing.", "existing summary must survive a later append");
    assert.equal(after.entries[1].summary, null, "new entry's summary starts null");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Session Journal: an unknown top-level key on the journal file survives an append", () => {
  const root = setupProject();
  try {
    writeExecutionConfigFile(root, { delegation_mode: "flat", sessionJournalEntries: 3 });
    const p = journalPath(root);
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(p, JSON.stringify({ maxEntries: 3, entries: [], customField: "keep-me" }), "utf8");

    submitPrompt(root, "a prompt");

    const journal = JSON.parse(readFileSync(p, "utf8")) as JournalFile;
    assert.equal(journal.customField, "keep-me", "unknown top-level key must survive the append");
    assert.equal(journal.entries.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Session Journal: a malformed/BOM'd existing journal file does not throw and starts fresh", () => {
  const root = setupProject();
  try {
    writeExecutionConfigFile(root, { delegation_mode: "flat", sessionJournalEntries: 3 });
    const p = journalPath(root);
    mkdirSync(join(root, ".claude"), { recursive: true });
    // BOM + invalid JSON.
    writeFileSync(p, "﻿{ not valid json", "utf8");

    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "recovering prompt", session_id: "journal-session" }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);

    const journal = JSON.parse(readFileSync(p, "utf8")) as JournalFile;
    assert.equal(journal.entries.length, 1, "must start fresh rather than throwing on malformed content");
    assert.equal(journal.entries[0].prompt, "recovering prompt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Session Journal: sessionJournalEntries:0 (feature off) creates no journal file", () => {
  const root = setupProject();
  try {
    writeExecutionConfigFile(root, { delegation_mode: "flat", sessionJournalEntries: 0 });
    submitPrompt(root, "should not be journaled");
    assert.equal(existsSync(journalPath(root)), false, "N=0 must be a complete no-op for the journal file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Session Journal: a missing sessionJournalEntries key (execution.json absent entirely) creates no journal file", () => {
  const root = setupProject();
  try {
    // No execution.json written at all.
    submitPrompt(root, "should not be journaled either");
    assert.equal(existsSync(journalPath(root)), false, "missing key must default to off and create no file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 0.0.531 fix: SubagentStop (~line 593) and Stop (~line 767) previously never
// wrote `sessionId` onto their activity.jsonl record — the guard
// `if (payload.session_id) record.sessionId = payload.session_id;` existed on
// PreToolUse/UserPromptSubmit but was missing on these two branches. Because
// panel.ts's session-scoped fold (_computeSessionDelegationHealth) could not
// see a sessionId on these records, SubagentStop's taskCount/tokens never
// landed in "This session" scope, and Stop never became a SessionStop event,
// so the orchestrator's workStartAt was never cleared and activeMs compounded
// across turns. These tests pin the hook-level half of the fix: both event
// types now stamp the real session_id verbatim, and stamp NOTHING when the
// payload has no session_id (no fabricated key).
// ---------------------------------------------------------------------------

test("hook stamps sessionId onto a SubagentStop record from payload.session_id", () => {
  const root = setupProject();
  try {
    runHook(root, {
      hook_event_name: "SubagentStop",
      tool_input: { subagent_type: "coding-specialist" },
      session_id: "sess-subagent-abc",
    });
    const records = readActivity(root);
    const stop = records.find((r) => r.event === "SubagentStop");
    assert.ok(stop, "expected a SubagentStop record");
    assert.equal(stop!.sessionId, "sess-subagent-abc");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook stamps sessionId onto a Stop record from payload.session_id", () => {
  const root = setupProject();
  try {
    runHook(root, { hook_event_name: "Stop", session_id: "sess-stop-xyz" });
    const records = readActivity(root);
    const stop = records.find((r) => r.event === "Stop");
    assert.ok(stop, "expected a Stop record");
    assert.equal(stop!.sessionId, "sess-stop-xyz");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook does not fabricate a sessionId key on SubagentStop or Stop when payload.session_id is absent", () => {
  const root = setupProject();
  try {
    // No session_id field at all on either payload.
    runHook(root, { hook_event_name: "SubagentStop", tool_input: { subagent_type: "coding-specialist" } });
    runHook(root, { hook_event_name: "Stop" });
    const records = readActivity(root);
    const ssRecord = records.find((r) => r.event === "SubagentStop");
    const stopRecord = records.find((r) => r.event === "Stop");
    assert.ok(ssRecord, "expected a SubagentStop record");
    assert.ok(stopRecord, "expected a Stop record");
    assert.ok(
      !Object.prototype.hasOwnProperty.call(ssRecord, "sessionId"),
      "SubagentStop record must not carry a fabricated sessionId key when the payload omits session_id"
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(stopRecord, "sessionId"),
      "Stop record must not carry a fabricated sessionId key when the payload omits session_id"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
