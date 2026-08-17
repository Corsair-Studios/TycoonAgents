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

// ---------------------------------------------------------------------------
// Compliance nudge: non-blocking additionalContext warning on direct
// Grep/Glob/Edit/Write/Read calls made by the orchestrator (never a spawned
// worker). Mirrors runHook's spawnSync pattern but captures stdout directly
// since runHook() only asserts exit status.
// ---------------------------------------------------------------------------

interface HookResult {
  status: number | null;
  stdout: string;
}

function runHookCapture(projectRoot: string, payload: Record<string, unknown>): HookResult {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
  });
  assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);
  return { status: result.status, stdout: result.stdout };
}

function preToolUse(tool: string, sessionId = "nudge-session"): Record<string, unknown> {
  return { hook_event_name: "PreToolUse", tool_name: tool, tool_input: {}, session_id: sessionId };
}

test("Compliance nudge: orchestrator Grep gets additionalContext pointing to search-retrieval, exit 0, warned:true", () => {
  const root = setupProject();
  try {
    const { stdout } = runHookCapture(root, preToolUse("Grep"));
    assert.ok(stdout.includes("additionalContext"), "expected additionalContext in stdout");
    assert.ok(stdout.includes("search-retrieval"), "expected search-retrieval mention");
    const parsed = JSON.parse(stdout);
    assert.ok(typeof parsed.additionalContext === "string" && parsed.additionalContext.length > 0);
    assert.equal(parsed.permissionDecision, undefined, "must never set permissionDecision");

    const records = readActivity(root);
    const rec = records.find((r) => r.event === "PreToolUse" && r.tool === "Grep");
    assert.ok(rec, "expected an activity record for Grep");
    assert.equal(rec!.warned, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Compliance nudge: orchestrator Edit gets additionalContext pointing to coding-specialist", () => {
  const root = setupProject();
  try {
    const { stdout } = runHookCapture(root, preToolUse("Edit"));
    assert.ok(stdout.includes("coding-specialist"), "expected coding-specialist mention");
    const records = readActivity(root);
    const rec = records.find((r) => r.event === "PreToolUse" && r.tool === "Edit");
    assert.equal(rec!.warned, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Compliance nudge: orchestrator Read #1 and #2 stay silent, Read #3 warns with the count", () => {
  const root = setupProject();
  try {
    const r1 = runHookCapture(root, preToolUse("Read"));
    assert.equal(r1.stdout, "", "1st Read must stay silent");
    const r2 = runHookCapture(root, preToolUse("Read"));
    assert.equal(r2.stdout, "", "2nd Read must stay silent");
    const r3 = runHookCapture(root, preToolUse("Read"));
    assert.ok(r3.stdout.includes("additionalContext"), "3rd Read must warn");
    assert.ok(r3.stdout.includes("3"), "warning text must include the count");

    const records = readActivity(root);
    const reads = records.filter((r) => r.event === "PreToolUse" && r.tool === "Read");
    assert.equal(reads.length, 3);
    assert.equal(reads[0].warned, undefined);
    assert.equal(reads[1].warned, undefined);
    assert.equal(reads[2].warned, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Compliance nudge: Stop resets the per-turn read counter", () => {
  const root = setupProject();
  try {
    runHookCapture(root, preToolUse("Read"));
    runHookCapture(root, preToolUse("Read"));
    runHook(root, { hook_event_name: "Stop", session_id: "nudge-session" });
    const r1 = runHookCapture(root, preToolUse("Read"));
    const r2 = runHookCapture(root, preToolUse("Read"));
    assert.equal(r1.stdout, "", "post-reset 1st Read must stay silent");
    assert.equal(r2.stdout, "", "post-reset 2nd Read must stay silent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Compliance nudge: never fires for a worker active on the stack (Grep, Edit, Read x3)", () => {
  const root = setupProject();
  try {
    // Push a worker onto the active-agent stack, as existing tests do.
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "coding-specialist" },
      session_id: "nudge-worker-session",
    });

    const g = runHookCapture(root, preToolUse("Grep", "nudge-worker-session"));
    assert.equal(g.stdout, "", "worker Grep must never be nagged");
    const e = runHookCapture(root, preToolUse("Edit", "nudge-worker-session"));
    assert.equal(e.stdout, "", "worker Edit must never be nagged");
    for (let i = 0; i < 3; i++) {
      const r = runHookCapture(root, preToolUse("Read", "nudge-worker-session"));
      assert.equal(r.stdout, "", `worker Read #${i + 1} must never be nagged`);
    }

    const records = readActivity(root);
    const workerRecords = records.filter(
      (r) => r.event === "PreToolUse" && (r.tool === "Grep" || r.tool === "Edit" || r.tool === "Read")
    );
    assert.ok(workerRecords.length > 0, "expected worker tool records");
    for (const rec of workerRecords) {
      assert.equal(rec.warned, undefined, "worker records must never carry warned:true");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Compliance nudge: Bash on the orchestrator never warns", () => {
  const root = setupProject();
  try {
    const { stdout } = runHookCapture(root, preToolUse("Bash"));
    assert.equal(stdout, "", "Bash must never trigger a nudge");
    const records = readActivity(root);
    const rec = records.find((r) => r.event === "PreToolUse" && r.tool === "Bash");
    assert.equal(rec!.warned, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// extractSubagentTokens reordering: component-level (splittable) usage data
// must win over a pre-summed total_tokens scalar, so cache-read consumption
// is never silently dropped. extractSubagentTokens is not exported (the
// script has no module.exports — see file header), so it is exercised the
// same way as the rest of this suite: spawn the hook, send a SubagentStop
// payload, and inspect the tokens/cacheReadTokens fields it writes onto the
// activity.jsonl record (hooks/tycoon-claude-hook.cjs:691-693).
// ---------------------------------------------------------------------------

test("SubagentStop: component fields win over a co-present total_tokens scalar, preserving cacheReadTokens", () => {
  const root = setupProject();
  try {
    runHook(root, {
      hook_event_name: "SubagentStop",
      tool_input: { subagent_type: "coding-specialist" },
      session_id: "sess-token-order-1",
      usage: {
        // Pre-summed scalar that would have won under the old priority order
        // (and returned cacheReadTokens: undefined).
        total_tokens: 999999,
        // Splittable components co-present on the same usage object.
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 4000,
      },
    });
    const records = readActivity(root);
    const stop = records.find((r) => r.event === "SubagentStop");
    assert.ok(stop, "expected a SubagentStop record");
    // Component sum (100 + 50 + 10 = 160), NOT the total_tokens scalar (999999).
    assert.equal(stop!.tokens, 160, "component sum must win over the pre-summed total_tokens scalar");
    assert.equal(stop!.cacheReadTokens, 4000, "cache-read tokens must survive when component data is present");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SubagentStop: total_tokens scalar is used only when no component data is present anywhere", () => {
  const root = setupProject();
  try {
    runHook(root, {
      hook_event_name: "SubagentStop",
      tool_input: { subagent_type: "coding-specialist" },
      session_id: "sess-token-order-2",
      usage: {
        total_tokens: 777,
        // No input_tokens/output_tokens/cache_creation_input_tokens/cache_read_input_tokens.
      },
    });
    const records = readActivity(root);
    const stop = records.find((r) => r.event === "SubagentStop");
    assert.ok(stop, "expected a SubagentStop record");
    assert.equal(stop!.tokens, 777, "must fall back to total_tokens when no component data exists");
    assert.equal(
      Object.prototype.hasOwnProperty.call(stop, "cacheReadTokens"),
      false,
      "cacheReadTokens must be absent (undefined) when only a pre-summed scalar is available"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Compliance nudge: a corrupt orchestrator-turn-reads.json degrades to no warning, no crash", () => {
  const root = setupProject();
  try {
    const tycoonDir = join(root, ".claude", "tycoon");
    mkdirSync(tycoonDir, { recursive: true });
    writeFileSync(join(tycoonDir, "orchestrator-turn-reads.json"), "{ not valid json", "utf8");

    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify(preToolUse("Read")),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);
    assert.equal(result.stdout, "", "corrupt counter must fail open (no warning), not crash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
