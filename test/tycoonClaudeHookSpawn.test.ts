/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
