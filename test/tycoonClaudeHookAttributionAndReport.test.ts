/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for two fixes to hooks/tycoon-claude-hook.cjs:
//
// 1. Concurrent-spawn attribution bug: a non-spawn tool call (Read/Edit/
//    Bash/mcp__*) used to attribute to whichever active-agent stack entry
//    was TOPMOST, not the entry that actually made the call. When a second
//    worker spawns while a first worker is still live, every call the first
//    worker makes afterward was misattributed to the second (see
//    resolveNonSpawnAgent's doc comment, ~line 483+). The fix binds Claude
//    Code's per-call `payload.agent_id` (present on any tool-call payload
//    issued from inside a spawned sub-agent) to the stack entry that owns
//    it, so later calls from that instance resolve exactly instead of by
//    stack order. Also covers the orphan-eviction TTL sweep
//    (readAndPruneActiveStack) that keeps a never-popped entry from
//    corrupting attribution forever.
//
// 2. Worker report capture: SubagentStop now extracts the subagent's final
//    assistant-message text from its transcript (lastAssistantTextFromTranscript)
//    and stores it as an optional, length-capped `report` field.
//
// Same idiom as test/tycoonClaudeHookSpawn.test.ts: spawn the real script as
// a child process, pipe a JSON payload on stdin, inspect activity.jsonl.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK_PATH = join(process.cwd(), "hooks", "tycoon-claude-hook.cjs");

interface ActivityRecord {
  event: string;
  workerId?: string;
  tool?: string;
  report?: string;
  reportChars?: number;
  reason?: string;
  ageMs?: number;
  [key: string]: unknown;
}

function runHook(projectRoot: string, payload: Record<string, unknown>): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
  });
  assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);
  return { status: result.status, stdout: result.stdout };
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

function readActiveStack(projectRoot: string): any[] {
  const p = join(projectRoot, ".claude", "tycoon", "active-agent.json");
  const raw = JSON.parse(readFileSync(p, "utf8"));
  return Array.isArray(raw.stack) ? raw.stack : [];
}

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), "tycoon-hook-attr-test-"));
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "codex-reviewer.md"),
    "---\ndescription: Foreign-model review.\nmodel: sonnet\n---\nBody.\n",
    "utf8",
  );
  writeFileSync(
    join(agentsDir, "vscode-integration.md"),
    "---\ndescription: VS Code extension work.\nmodel: sonnet\n---\nBody.\n",
    "utf8",
  );
  return root;
}

// ---------------------------------------------------------------------------
// 1. Concurrent-spawn attribution: A spawns, B spawns while A is still live,
//    A makes a tool call -> must attribute to A, not B (the incident from
//    .claude/tycoon/activity.jsonl this fix closes: codex-reviewer's Bash
//    calls after vscode-integration spawned on top).
// ---------------------------------------------------------------------------

test("a tool call made by worker A (via its bound agent_id) while worker B is also live attributes to A, not stack-top B — the exact incident interleaving from .claude/tycoon/activity.jsonl (codex-reviewer, then vscode-integration spawned on top by the orchestrator, then codex-reviewer keeps calling tools)", () => {
  const root = setupProject();
  try {
    // Orchestrator spawns A (codex-reviewer) — no agent_id (orchestrator calls
    // never carry one; only calls made from INSIDE a spawned worker do).
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { name: "codex-reviewer", description: "review", prompt: "review the diff" },
      session_id: "s1",
    });

    // A's first tool call, made from INSIDE A (agent_id = A's instance uuid).
    // Binds instanceId "instance-A" to the codex-reviewer stack entry
    // (case 2: exactly one unbound entry at this point).
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git diff" },
      agent_id: "instance-A",
      agent_type: "codex-reviewer",
      session_id: "s1",
    });

    // Orchestrator spawns B (vscode-integration) WHILE A is still live —
    // pushed on top of A, exactly like the real incident trail. Still an
    // orchestrator-issued spawn (no agent_id), same as the real records.
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { name: "vscode-integration", description: "webview panel", prompt: "fix panel" },
      session_id: "s1",
    });

    // A makes ANOTHER tool call — this is the exact bug scenario. Before the
    // fix this attributed to vscode-integration (stack-top, pushed after A).
    // After the fix, instance-A is already bound, so it resolves to
    // codex-reviewer exactly regardless of what was pushed on top since.
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "codex review --apply" },
      agent_id: "instance-A",
      agent_type: "codex-reviewer",
      session_id: "s1",
    });

    // B also makes a tool call, using ITS OWN instance id (first sighting,
    // binds instance-B to the remaining unbound entry) — must attribute to B.
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "panel.ts" },
      agent_id: "instance-B",
      agent_type: "vscode-integration",
      session_id: "s1",
    });

    const records = readActivity(root);
    const bashCalls = records.filter((r) => r.event === "PreToolUse" && r.tool === "Bash");
    assert.equal(bashCalls.length, 2);
    assert.ok(
      bashCalls.every((r) => r.workerId === "codex-reviewer"),
      `expected both Bash calls attributed to codex-reviewer, got: ${JSON.stringify(bashCalls.map((r) => r.workerId))}`,
    );

    const readCall = records.find((r) => r.event === "PreToolUse" && r.tool === "Read");
    assert.equal(readCall?.workerId, "vscode-integration");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parent attribution for a concurrent spawn resolves via the spawner's bound agent_id, not stack-top guessing", () => {
  const root = setupProject();
  try {
    // Two leads (team_leads mode) live concurrently; A spawns first, then B,
    // then A spawns a SECOND worker while B is on top — parentId must still
    // resolve to A via A's bound instanceId, not to B (stack-top).
    const execDir = join(root, ".claude", "tycoon");
    mkdirSync(execDir, { recursive: true });
    writeFileSync(join(execDir, "execution.json"), JSON.stringify({ delegation_mode: "team_leads" }), "utf8");
    writeFileSync(
      join(root, ".claude", "agents", "codex-reviewer.md"),
      "---\ndescription: Foreign-model review.\nmodel: sonnet\ntier: lead\n---\nBody.\n",
      "utf8",
    );

    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { name: "codex-reviewer" },
      session_id: "s1",
    });
    // A's first call binds instance-A.
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git diff" },
      agent_id: "instance-A",
      agent_type: "codex-reviewer",
      session_id: "s1",
    });
    // Orchestrator spawns B on top.
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { name: "vscode-integration" },
      session_id: "s1",
    });
    // A (a lead) spawns a second worker while B is topmost — A's spawn call
    // carries instance-A, already bound, so parentId must resolve to A.
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { name: "coding-specialist-2", description: "implement widget", prompt: "write code" },
      agent_id: "instance-A",
      agent_type: "codex-reviewer",
      session_id: "s1",
    });

    const records = readActivity(root);
    const grandchildSpawn = records.filter((r) => r.event === "PreToolUse" && r.tool === "Agent")[2];
    assert.ok(grandchildSpawn, "expected a third spawn record");
    assert.equal(grandchildSpawn.parentId, "codex-reviewer", "parentId must resolve via A's bound instanceId, not stack-top (vscode-integration)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("first sighting with exactly one unbound stack entry binds unambiguously", () => {
  const root = setupProject();
  try {
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { name: "codex-reviewer" },
      session_id: "s1",
    });
    // First call from inside codex-reviewer — no prior binding exists yet,
    // exactly one live (unbound) entry -> binds and resolves correctly.
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Grep",
      tool_input: { pattern: "foo" },
      agent_id: "instance-A",
      session_id: "s1",
    });
    const stack = readActiveStack(root);
    assert.equal(stack.length, 1);
    assert.equal(stack[0].instanceId, "instance-A");

    const grepCall = readActivity(root).find((r) => r.tool === "Grep");
    assert.equal(grepCall?.workerId, "codex-reviewer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no agent_id on the payload at all (legacy / orchestrator) falls back to stack-top peek unchanged", () => {
  const root = setupProject();
  try {
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { name: "codex-reviewer" },
      session_id: "s1",
    });
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      session_id: "s1",
      // no agent_id field at all
    });
    const bashCall = readActivity(root).find((r) => r.tool === "Bash");
    assert.equal(bashCall?.workerId, "codex-reviewer", "single live entry, stack-top fallback still correct");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Orphan eviction: an entry that never gets a SubagentStop is bounded and
//    logged, not left to corrupt attribution forever.
// ---------------------------------------------------------------------------

test("an orphaned stack entry older than the TTL is evicted on next read, logged via an AgentEvicted record, and does not corrupt subsequent attribution", () => {
  const root = setupProject();
  try {
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { name: "codex-reviewer" },
      session_id: "s1",
    });

    // Manually age the stack entry past the 30-minute TTL (simulates an
    // interrupted/crashed worker that never fired SubagentStop).
    const stackPath = join(root, ".claude", "tycoon", "active-agent.json");
    const data = JSON.parse(readFileSync(stackPath, "utf8"));
    data.stack[0].timestamp = Date.now() - 31 * 60 * 1000;
    writeFileSync(stackPath, JSON.stringify(data), "utf8");

    // Next spawn (a fresh worker) triggers a read/prune of the stack.
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { name: "vscode-integration" },
      session_id: "s1",
    });

    const records = readActivity(root);
    const eviction = records.find((r) => r.event === "AgentEvicted");
    assert.ok(eviction, "expected an AgentEvicted record, eviction must be logged not silent");
    assert.equal(eviction!.workerId, "codex-reviewer");
    assert.equal(eviction!.reason, "orphan-ttl");
    assert.ok(typeof eviction!.ageMs === "number" && eviction!.ageMs! >= 31 * 60 * 1000);

    // The orphan must no longer be attributable: a subsequent call with no
    // agent_id must resolve to the surviving worker (stack-top of what's left),
    // not the evicted orphan.
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      session_id: "s1",
    });
    const bashCall = readActivity(root).find((r) => r.tool === "Bash");
    assert.equal(bashCall?.workerId, "vscode-integration");

    const stack = readActiveStack(root);
    assert.equal(stack.length, 1);
    assert.equal(stack[0].agentId, "vscode-integration");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Worker report capture.
// ---------------------------------------------------------------------------

function writeTranscript(root: string, lines: unknown[]): string {
  const transcriptPath = join(root, "transcript.jsonl");
  writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return transcriptPath;
}

test("SubagentStop captures the final assistant message as an optional report field", () => {
  const root = setupProject();
  try {
    const transcriptPath = writeTranscript(root, [
      { role: "user", message: { role: "user", content: "do the thing" } },
      { role: "assistant", message: { role: "assistant", content: "working on it" } },
      { role: "assistant", message: { role: "assistant", content: "Fixed hookRecord.ts:10, added report field. Verified with tsc." } },
    ]);

    runHook(root, {
      hook_event_name: "SubagentStop",
      agent_transcript_path: transcriptPath,
      agent_type: "codex-reviewer",
      session_id: "s1",
    });

    const stopRecord = readActivity(root).find((r) => r.event === "SubagentStop");
    assert.ok(stopRecord);
    assert.equal(stopRecord!.report, "Fixed hookRecord.ts:10, added report field. Verified with tsc.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a report longer than the cap is truncated with an explicit marker and carries reportChars", () => {
  const root = setupProject();
  try {
    const longText = "x".repeat(2500);
    const transcriptPath = writeTranscript(root, [
      { role: "assistant", message: { role: "assistant", content: longText } },
    ]);

    runHook(root, {
      hook_event_name: "SubagentStop",
      agent_transcript_path: transcriptPath,
      agent_type: "codex-reviewer",
      session_id: "s1",
    });

    const stopRecord = readActivity(root).find((r) => r.event === "SubagentStop");
    assert.ok(stopRecord?.report);
    assert.ok(stopRecord!.report!.length <= 600, `expected capped length, got ${stopRecord!.report!.length}`);
    assert.match(stopRecord!.report!, /…\[truncated \d+ chars\]$/, "expected an explicit truncation marker");
    assert.equal(stopRecord!.reportChars, 2500, "reportChars must carry the ORIGINAL pre-truncation length");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a 5,000-char report is stored as <= 600 chars + marker with reportChars 5000", () => {
  const root = setupProject();
  try {
    const longText = "y".repeat(5000);
    const transcriptPath = writeTranscript(root, [
      { role: "assistant", message: { role: "assistant", content: longText } },
    ]);

    runHook(root, {
      hook_event_name: "SubagentStop",
      agent_transcript_path: transcriptPath,
      agent_type: "codex-reviewer",
      session_id: "s1",
    });

    const stopRecord = readActivity(root).find((r) => r.event === "SubagentStop");
    assert.ok(stopRecord?.report);
    assert.ok(stopRecord!.report!.length <= 600, `expected capped length, got ${stopRecord!.report!.length}`);
    assert.equal(stopRecord!.reportChars, 5000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a short report is stored unchanged with reportChars matching its own length", () => {
  const root = setupProject();
  try {
    const shortText = "All good, verified with tsc.";
    const transcriptPath = writeTranscript(root, [
      { role: "assistant", message: { role: "assistant", content: shortText } },
    ]);

    runHook(root, {
      hook_event_name: "SubagentStop",
      agent_transcript_path: transcriptPath,
      agent_type: "codex-reviewer",
      session_id: "s1",
    });

    const stopRecord = readActivity(root).find((r) => r.event === "SubagentStop");
    assert.equal(stopRecord!.report, shortText);
    assert.equal(stopRecord!.reportChars, shortText.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing/unreadable transcript fails open: no report field, no crash", () => {
  const root = setupProject();
  try {
    runHook(root, {
      hook_event_name: "SubagentStop",
      agent_transcript_path: join(root, "does-not-exist.jsonl"),
      agent_type: "codex-reviewer",
      session_id: "s1",
    });

    const stopRecord = readActivity(root).find((r) => r.event === "SubagentStop");
    assert.ok(stopRecord);
    assert.equal(stopRecord!.report, undefined, "report must be OMITTED, never an empty string standing in for unreadable");
    assert.ok(!("report" in stopRecord!), "report key must not be present at all when unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a transcript with no agent_transcript_path/transcript_path at all also fails open with no report field", () => {
  const root = setupProject();
  try {
    runHook(root, {
      hook_event_name: "SubagentStop",
      agent_type: "codex-reviewer",
      session_id: "s1",
    });
    const stopRecord = readActivity(root).find((r) => r.event === "SubagentStop");
    assert.ok(stopRecord);
    assert.equal(stopRecord!.report, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
