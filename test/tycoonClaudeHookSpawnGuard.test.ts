/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for the leaf-worker spawn guard added to hooks/tycoon-claude-hook.cjs
// (~709-767, inside the PreToolUse `isSpawn` branch — see the guard's own
// comment block for the doctrine it structurally enforces: workers are
// leaves, never spawn sub-agents). Same idiom as test/tycoonClaudeHookSpawn
// .test.ts: spawn the real script as a child process, pipe a JSON payload on
// stdin, and inspect both its stdout and the activity.jsonl it writes.
//
// Claude Code stamps `agent_id`/`agent_type` on the PreToolUse payload ONLY
// when the Task/Agent call originates INSIDE a spawned sub-agent — both are
// absent for the main-session orchestrator. The guard denies a spawn attempt
// from a non-empty agent_id UNLESS delegationMode is "team_leads" AND the
// spawner's agent_type resolves (via its own .claude/agents/<id>.md
// frontmatter) to `tier: lead`.

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
  parentId?: string;
  agentId?: string;
  agentType?: string;
  attemptedSubagentType?: string;
  delegationMode?: string;
  [key: string]: unknown;
}

interface HookResult {
  status: number | null;
  stdout: string;
}

function runHook(projectRoot: string, payload: unknown): void {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
  });
  assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);
}

function runHookCapture(projectRoot: string, payload: unknown): HookResult {
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

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), "tycoon-hook-guard-test-"));
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

function writeExecutionConfigFile(projectRoot: string, config: Record<string, unknown>): void {
  const tycoonDir = join(projectRoot, ".claude", "tycoon");
  mkdirSync(tycoonDir, { recursive: true });
  writeFileSync(join(tycoonDir, "execution.json"), JSON.stringify(config), "utf8");
}

function assertIsSingleDenyJson(stdout: string): Record<string, any> {
  // JSON.parse requires the ENTIRE string to be exactly one JSON value — any
  // trailing/extra content after a complete value throws — so a successful
  // parse here already proves "exactly one JSON object", not just "valid
  // JSON somewhere in the output".
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(
    typeof parsed.hookSpecificOutput.permissionDecisionReason === "string" &&
      parsed.hookSpecificOutput.permissionDecisionReason.length > 0,
    "permissionDecisionReason must be a non-empty explanatory string"
  );
  return parsed;
}

// ---------------------------------------------------------------------------
// (a) Worker spawn attempt (agent_id present, flat/default mode) -> denied.
// ---------------------------------------------------------------------------

test("guard denies a worker spawn attempt in flat mode: stdout is exactly one deny JSON object, a SpawnDenied record is written, and nothing is pushed onto the active-agent stack", () => {
  const root = setupProject();
  try {
    const { stdout } = runHookCapture(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "coding-specialist", description: "do a thing", prompt: "write code" },
      agent_id: "spawned-worker-uuid",
      agent_type: "coding-specialist",
      session_id: "guard-session-1",
    });
    assertIsSingleDenyJson(stdout);

    const records = readActivity(root);
    const denial = records.find((r) => r.event === "SpawnDenied");
    assert.ok(denial, "expected a SpawnDenied record");
    assert.equal(denial!.agentId, "spawned-worker-uuid");
    assert.equal(denial!.agentType, "coding-specialist");
    assert.equal(denial!.attemptedSubagentType, "coding-specialist");
    assert.equal(
      records.find((r) => r.event === "PreToolUse" && r.workerId === "coding-specialist"),
      undefined,
      "a denied spawn must never also produce a normal spawn record"
    );

    // Confirm nothing was pushed onto the active-agent stack: a follow-up
    // orchestrator-style spawn (no agent_id) must have NO parentId — if the
    // denied attempt had pushed itself, this spawn would wrongly inherit one.
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "ux-ui-designer" },
      session_id: "guard-session-1",
    });
    const nextSpawn = readActivity(root).find((r) => r.event === "PreToolUse" && r.workerId === "ux-ui-designer");
    assert.ok(nextSpawn, "expected the follow-up spawn record");
    assert.equal(nextSpawn!.parentId, undefined, "denied spawn must not have been pushed onto the active-agent stack");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (b) Orchestrator spawn (no agent_id) -> identical to pre-guard behavior.
// ---------------------------------------------------------------------------

test("orchestrator spawn (no agent_id field at all) is unaffected by the guard: spawn record pushed, no deny, no SpawnDenied record", () => {
  const root = setupProject();
  try {
    const { stdout } = runHookCapture(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "coding-specialist", description: "implement widget", prompt: "write code" },
      session_id: "guard-session-orchestrator",
    });
    assert.equal(stdout, "", "orchestrator spawn must produce no stdout output at all");

    const records = readActivity(root);
    assert.equal(records.find((r) => r.event === "SpawnDenied"), undefined);
    const spawn = records.find((r) => r.event === "PreToolUse" && r.workerId === "coding-specialist");
    assert.ok(spawn, "expected a normal spawn record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c) team_leads mode + spawner resolving to tier:lead -> allowed. Same
// payload in flat mode -> denied (mode gating).
// ---------------------------------------------------------------------------

test("team_leads mode: a spawner whose agent_type resolves (case/space-insensitively) to a tier:lead agent is allowed to spawn — record pushed, no deny", () => {
  const root = setupProject();
  try {
    writeExecutionConfigFile(root, { delegation_mode: "team_leads" });
    const { stdout } = runHookCapture(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "coding-specialist" },
      agent_id: "lead-instance-uuid",
      agent_type: "Build Lead", // normalizes to "build-lead" (lowercase, spaces -> hyphens)
      session_id: "guard-session-lead",
    });
    assert.equal(stdout, "", "an allowed (lead) spawn must produce no deny output");

    const records = readActivity(root);
    assert.equal(records.find((r) => r.event === "SpawnDenied"), undefined, "no SpawnDenied record expected");
    const spawn = records.find((r) => r.event === "PreToolUse" && r.workerId === "coding-specialist");
    assert.ok(spawn, "expected a normal spawn record to be pushed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the SAME lead payload is DENIED in flat mode — the tier:lead carve-out only applies when delegationMode is team_leads", () => {
  const root = setupProject();
  try {
    // No execution.json written at all -> defaults to flat.
    const { stdout } = runHookCapture(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "coding-specialist" },
      agent_id: "lead-instance-uuid",
      agent_type: "build-lead",
      session_id: "guard-session-lead-flat",
    });
    const parsed = assertIsSingleDenyJson(stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");

    const denial = readActivity(root).find((r) => r.event === "SpawnDenied");
    assert.ok(denial, "expected a SpawnDenied record in flat mode even for a lead-tier agent_type");
    assert.equal(denial!.delegationMode, "flat");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (d) team_leads mode + non-lead worker agent_type -> denied.
// ---------------------------------------------------------------------------

test("team_leads mode: a spawner whose agent_type resolves to a NON-lead agent (no tier field) is denied", () => {
  const root = setupProject();
  try {
    writeExecutionConfigFile(root, { delegation_mode: "team_leads" });
    const { stdout } = runHookCapture(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "ux-ui-designer" },
      agent_id: "worker-instance-uuid",
      agent_type: "coding-specialist", // coding-specialist.md has no tier field
      session_id: "guard-session-nonlead",
    });
    assertIsSingleDenyJson(stdout);
    const denial = readActivity(root).find((r) => r.event === "SpawnDenied");
    assert.ok(denial);
    assert.equal(denial!.agentType, "coding-specialist");
    assert.equal(denial!.delegationMode, "team_leads");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (e) Fail-open: never crashes, regardless of a broken/missing agents dir or
// a malformed payload.
//
// CLARIFICATION on the "agents dir missing/unreadable" case, verified
// against the actual source (readAgentTier, ~line 159): readAgentTier has
// its OWN internal try/catch and returns `undefined` (never throws) when
// the agents directory or the specific agent's .md file doesn't exist. That
// means a missing agents dir does NOT exercise the guard's own outer
// fail-open catch at all — it flows through the ordinary "not a lead"
// branch and correctly DENIES (verified empirically: `readAgentTier`
// returning undefined makes `spawnerIsLead` false exactly like a real
// non-lead agent would). "Fail-open" here means the hook never crashes,
// hangs, or emits malformed output when the environment is broken — not
// that it silently ALLOWS an unverifiable spawner. The malformed-payload
// cases below are where "no deny emitted" is the actually-correct,
// verified outcome (a non-string agent_id degrades to "absent").
// ---------------------------------------------------------------------------

test("fail-open: agent_id present but the .claude/agents directory is entirely missing still resolves to a single well-formed deny JSON, never a crash", () => {
  const root = mkdtempSync(join(tmpdir(), "tycoon-hook-guard-test-"));
  try {
    // Deliberately no .claude/agents directory anywhere under root.
    mkdirSync(join(root, ".claude", "tycoon"), { recursive: true });
    writeFileSync(join(root, ".claude", "tycoon", "execution.json"), JSON.stringify({ delegation_mode: "team_leads" }), "utf8");

    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: { subagent_type: "coding-specialist" },
        agent_id: "some-uuid",
        agent_type: "build-lead",
        session_id: "guard-session-noagentsdir",
      }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);
    assertIsSingleDenyJson(result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fail-open: a malformed agent_id (wrong type, a number) is coerced to absent — exit 0, no deny emitted", () => {
  const root = setupProject();
  try {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: { subagent_type: "coding-specialist" },
        agent_id: 12345,
        agent_type: "coding-specialist",
        session_id: "guard-session-malformed-id",
      }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);
    assert.equal(result.stdout, "", "a non-string agent_id must be coerced to absent -- no deny emitted");
    assert.equal(
      readActivity(root).find((r) => r.event === "SpawnDenied"),
      undefined
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fail-open: a malformed tool_input (a string instead of an object) never crashes the guard (exit 0)", () => {
  const root = setupProject();
  try {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: "not-an-object",
        agent_id: "uuid-1",
        agent_type: "coding-specialist",
        session_id: "guard-session-malformed-tool-input",
      }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (f) Empty-string agent_id -> treated as absent (allowed).
// ---------------------------------------------------------------------------

test("an empty-string agent_id is treated as absent — allowed, no deny — even paired with a non-lead agent_type", () => {
  const root = setupProject();
  try {
    const { stdout } = runHookCapture(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "coding-specialist" },
      agent_id: "",
      agent_type: "coding-specialist",
      session_id: "guard-session-empty-id",
    });
    assert.equal(stdout, "", "empty-string agent_id must be treated as absent (orchestrator) — no deny");
    assert.equal(
      readActivity(root).find((r) => r.event === "SpawnDenied"),
      undefined
    );
    const spawn = readActivity(root).find((r) => r.event === "PreToolUse" && r.workerId === "coding-specialist");
    assert.ok(spawn, "expected a normal spawn record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
