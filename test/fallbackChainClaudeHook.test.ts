/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Plan task p15-t1 (coordinator follow-up): Stop must evict the current
 * session's entry from .claude/tycoon/fallback-state.json, mirroring the
 * OpenCode plugin's in-memory FallbackState.endSession on root-session
 * idle. Driven the same way as test/tycoonClaudeHookAttribution.test.ts —
 * spawn the real hook as a child process, pipe a JSON payload on stdin.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const HOOK_PATH = join(REPO_ROOT, "hooks", "tycoon-claude-hook.cjs");

// The PostToolUse mcp__ fallback path (~1944) attributes a failure via
// buildMcpBackendRouting, which needs agentBackend.js/modelAliases.js next
// to the hook (getAgentBackendModule, hooks/tycoon-claude-hook.cjs:254-270).
// hooks/agentBackend.js is a build artifact (scripts/copy-hook-runtime.mjs,
// `npm run build`), not produced by `npm test` (tsc -p . only), so it is
// absent on a clean clone/CI checkout — the mcp__ lookup then misses and no
// FallbackTriggered record is written. Run the "usage-limit failure" case
// against a scratch copy of the hook with out/src/core/{agentBackend,
// modelAliases}.js (always produced by tsc) copied next to it — same
// technique as test/hookBackendRouting.test.ts's setupProject(withModule).
function runHookWithBackendModule(projectRoot: string, payload: Record<string, unknown>): string {
  const hookDir = mkdtempSync(join(tmpdir(), "tycoon-hook-fallback-copy-"));
  const hookPath = join(hookDir, "tycoon-claude-hook.cjs");
  copyFileSync(HOOK_PATH, hookPath);
  copyFileSync(join(REPO_ROOT, "out", "src", "core", "agentBackend.js"), join(hookDir, "agentBackend.js"));
  copyFileSync(join(REPO_ROOT, "out", "src", "core", "modelAliases.js"), join(hookDir, "modelAliases.js"));
  // fallbackChain.js is tracked (unlike agentBackend/modelAliases) but the
  // hook still resolves it next to itself (getFallbackChainModule,
  // hooks/tycoon-claude-hook.cjs:291-294) — needed here too since the copy
  // lives in its own scratch dir, not the real hooks/ directory.
  copyFileSync(join(REPO_ROOT, "hooks", "fallbackChain.js"), join(hookDir, "fallbackChain.js"));
  try {
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
    });
    assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);
    return result.stdout;
  } finally {
    rmSync(hookDir, { recursive: true, force: true });
  }
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

function fallbackStatePath(projectRoot: string): string {
  return join(projectRoot, ".claude", "tycoon", "fallback-state.json");
}

function activityPath(projectRoot: string): string {
  return join(projectRoot, ".claude", "tycoon", "activity.jsonl");
}

function readActivity(projectRoot: string): Array<Record<string, unknown>> {
  if (!existsSync(activityPath(projectRoot))) return [];
  return readFileSync(activityPath(projectRoot), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), "tycoon-hook-fallback-stop-test-"));
  mkdirSync(join(root, ".claude", "tycoon"), { recursive: true });
  return root;
}

test("Stop evicts the current session's entry from fallback-state.json, leaving other sessions intact, and Stop's own record is unaffected", () => {
  const root = setupProject();
  const tycoonDir = join(root, ".claude", "tycoon");
  writeFileSync(
    fallbackStatePath(root),
    JSON.stringify({
      "session-a": { "codex-reviewer": { attemptsSoFar: 1 } },
      "session-b": { "gemini-reviewer": { attemptsSoFar: 2 } },
    }),
    "utf8",
  );

  runHook(root, { hook_event_name: "Stop", session_id: "session-a" });

  const stateAfter = JSON.parse(readFileSync(fallbackStatePath(root), "utf8"));
  assert.equal(
    Object.prototype.hasOwnProperty.call(stateAfter, "session-a"),
    false,
    "session-a's fallback tracking must be evicted on Stop",
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(stateAfter, "session-b"),
    "session-b's fallback tracking must survive session-a's Stop",
  );

  const records = readActivity(root);
  const stopRecord = records.find((r) => r.event === "Stop");
  assert.ok(stopRecord, "Stop must still write its own activity record");
  assert.equal(stopRecord!.sessionId, "session-a");
  assert.equal(stopRecord!.workerId, "orchestrator");

  void tycoonDir;
});

test("Stop with no fallback-state.json present is a safe no-op (no file created, no crash)", () => {
  const root = setupProject();

  const result = runHook(root, { hook_event_name: "Stop", session_id: "session-x" });
  assert.equal(result.status, 0);
  assert.equal(existsSync(fallbackStatePath(root)), false);

  const records = readActivity(root);
  assert.ok(records.some((r) => r.event === "Stop" && r.sessionId === "session-x"));
});

test("Stop with no session_id in the payload leaves fallback-state.json untouched", () => {
  const root = setupProject();
  writeFileSync(
    fallbackStatePath(root),
    JSON.stringify({ "session-a": { "codex-reviewer": { attemptsSoFar: 1 } } }),
    "utf8",
  );

  runHook(root, { hook_event_name: "Stop" });

  const stateAfter = JSON.parse(readFileSync(fallbackStatePath(root), "utf8"));
  assert.ok(Object.prototype.hasOwnProperty.call(stateAfter, "session-a"));
});

// ---------------------------------------------------------------------------
// Plan task p25-t3: routing.resolved.json's top-level `defaultFallback` is
// now wired at both call sites (PreToolUse re-dispatch ~1504, PostToolUse
// mcp__ failure ~1770), used only when the slot itself has no `fallback`
// chain — and PostToolUse for mcp__codex/gemini/kimi tools with a
// provider-failure result text emits the same FallbackTriggered/PreToolUse
// spawn record path the hook already has for a failed native worker.
// ---------------------------------------------------------------------------

test("PreToolUse re-dispatch (call site ~1504): a slot with no own fallback chain uses routing.resolved.json's top-level defaultFallback", () => {
  const root = setupProject();
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "coding-specialist.md"), "---\ndescription: Implements code.\nmodel: sonnet\n---\nBody.\n", "utf8");
  writeFileSync(
    join(root, ".claude", "tycoon", "routing.resolved.json"),
    JSON.stringify({ agents: {}, defaultFallback: { vendor: "moonshot", model: "moonshot/kimi-k2" } }),
    "utf8",
  );
  writeFileSync(
    fallbackStatePath(root),
    JSON.stringify({ "test-session-fb1": { "coding-specialist": { attemptsSoFar: 1 } } }),
    "utf8",
  );

  runHook(root, {
    hook_event_name: "PreToolUse",
    tool_name: "Task",
    tool_input: { subagent_type: "coding-specialist", description: "implement widget", prompt: "write code" },
    session_id: "test-session-fb1",
  });

  const records = readActivity(root);
  const spawn = records.find((r) => r.event === "PreToolUse" && r.workerId === "coding-specialist");
  assert.ok(spawn, "expected a spawn record for coding-specialist");
  assert.equal(spawn!.fallbackOf, "coding-specialist");
  assert.equal(spawn!.fallbackDepth, 1);
  assert.equal(spawn!.vendor, "moonshot");
  assert.equal(spawn!.model, "moonshot/kimi-k2");
  assert.equal(spawn!.fallbackIsDefault, true);
});

test("PreToolUse re-dispatch: defaultFallback is never used when the slot has its own explicit fallback chain (unchanged behaviour)", () => {
  const root = setupProject();
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "coding-specialist.md"), "---\ndescription: Implements code.\nmodel: sonnet\n---\nBody.\n", "utf8");
  writeFileSync(
    join(root, ".claude", "tycoon", "routing.resolved.json"),
    JSON.stringify({
      agents: { "coding-specialist": { fallback: [{ vendor: "google", model: "google/gemini-2.5-pro" }] } },
      defaultFallback: { vendor: "moonshot", model: "moonshot/kimi-k2" },
    }),
    "utf8",
  );
  writeFileSync(
    fallbackStatePath(root),
    JSON.stringify({ "test-session-fb2": { "coding-specialist": { attemptsSoFar: 1 } } }),
    "utf8",
  );

  runHook(root, {
    hook_event_name: "PreToolUse",
    tool_name: "Task",
    tool_input: { subagent_type: "coding-specialist", description: "implement widget", prompt: "write code" },
    session_id: "test-session-fb2",
  });

  const records = readActivity(root);
  const spawn = records.find((r) => r.event === "PreToolUse" && r.workerId === "coding-specialist");
  assert.ok(spawn);
  assert.equal(spawn!.vendor, "google");
  assert.equal(spawn!.model, "google/gemini-2.5-pro");
  assert.equal(spawn!.fallbackIsDefault, false);
});

// p31-t1: the routing-level defaultFallback now fires once an EXPLICIT
// chain is exhausted too, not only when the slot has no chain at all —
// gated by the per-slot useDefaultFallback switch on routing.resolved.json.

test("PreToolUse re-dispatch: defaultFallback fires once an explicit 1-entry chain is exhausted", () => {
  const root = setupProject();
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "coding-specialist.md"), "---\ndescription: Implements code.\nmodel: sonnet\n---\nBody.\n", "utf8");
  writeFileSync(
    join(root, ".claude", "tycoon", "routing.resolved.json"),
    JSON.stringify({
      agents: { "coding-specialist": { fallback: [{ vendor: "google", model: "google/gemini-2.5-pro" }] } },
      defaultFallback: { vendor: "moonshot", model: "moonshot/kimi-k2" },
    }),
    "utf8",
  );
  writeFileSync(
    fallbackStatePath(root),
    // attemptsSoFar 2: chain[0] already tried once (attempt 1), this is the
    // second recorded failure -> resolver call uses attemptsSoFar-1 = 1,
    // which is past the 1-entry explicit chain -> defaultFallback.
    JSON.stringify({ "test-session-fb3": { "coding-specialist": { attemptsSoFar: 2 } } }),
    "utf8",
  );

  runHook(root, {
    hook_event_name: "PreToolUse",
    tool_name: "Task",
    tool_input: { subagent_type: "coding-specialist", description: "implement widget", prompt: "write code" },
    session_id: "test-session-fb3",
  });

  const records = readActivity(root);
  const spawn = records.find((r) => r.event === "PreToolUse" && r.workerId === "coding-specialist");
  assert.ok(spawn);
  assert.equal(spawn!.vendor, "moonshot");
  assert.equal(spawn!.model, "moonshot/kimi-k2");
});

test("PreToolUse re-dispatch: useDefaultFallback:false on the slot suppresses the default once its explicit chain is exhausted", () => {
  const root = setupProject();
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "coding-specialist.md"), "---\ndescription: Implements code.\nmodel: sonnet\n---\nBody.\n", "utf8");
  writeFileSync(
    join(root, ".claude", "tycoon", "routing.resolved.json"),
    JSON.stringify({
      agents: {
        "coding-specialist": {
          fallback: [{ vendor: "google", model: "google/gemini-2.5-pro" }],
          useDefaultFallback: false,
        },
      },
      defaultFallback: { vendor: "moonshot", model: "moonshot/kimi-k2" },
    }),
    "utf8",
  );
  writeFileSync(
    fallbackStatePath(root),
    JSON.stringify({ "test-session-fb4": { "coding-specialist": { attemptsSoFar: 2 } } }),
    "utf8",
  );

  runHook(root, {
    hook_event_name: "PreToolUse",
    tool_name: "Task",
    tool_input: { subagent_type: "coding-specialist", description: "implement widget", prompt: "write code" },
    session_id: "test-session-fb4",
  });

  const records = readActivity(root);
  const spawn = records.find((r) => r.event === "PreToolUse" && r.workerId === "coding-specialist");
  // Exhausted with no fallback -> no fallbackOf/fallbackDepth fields added,
  // dispatch proceeds on the originally assigned model unchanged.
  assert.ok(spawn);
  assert.notEqual(spawn!.vendor, "moonshot");
  assert.notEqual(spawn!.model, "moonshot/kimi-k2");
});

test("PostToolUse mcp__codex__* result with a usage-limit failure text emits a FallbackTriggered record and a fallback spawn attributed to the bound reviewer agent", () => {
  const root = setupProject();
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "codex-reviewer.md"),
    [
      "---",
      "model: sonnet",
      "backend:",
      "  vendor: openai",
      "  transport: mcp",
      "  mcpServer: codex",
      "  tools: [codex]",
      "  model: openai/gpt-6-astra",
      "  costModelClass: subscription",
      "---",
      "",
      "# Codex Reviewer (test fixture)",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, ".claude", "tycoon", "routing.resolved.json"),
    JSON.stringify({ agents: {}, defaultFallback: { vendor: "moonshot", model: "moonshot/kimi-k2" } }),
    "utf8",
  );

  runHookWithBackendModule(root, {
    hook_event_name: "PostToolUse",
    tool_name: "mcp__codex__codex",
    tool_input: {},
    tool_response: "Error: usage limit reached for this account",
    session_id: "test-session-fb3",
  });

  const records = readActivity(root);
  const triggered = records.find((r) => r.event === "FallbackTriggered");
  assert.ok(triggered, "expected a FallbackTriggered record for the mcp__codex__codex failure");
  assert.equal(triggered!.workerId, "codex-reviewer");
  assert.equal(triggered!.nextModel, "moonshot/kimi-k2");
});

test("PostToolUse mcp__ result with ordinary (non-failure) text writes no FallbackTriggered record", () => {
  const root = setupProject();
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "codex-reviewer.md"),
    [
      "---",
      "model: sonnet",
      "backend:",
      "  vendor: openai",
      "  transport: mcp",
      "  mcpServer: codex",
      "  tools: [codex]",
      "  model: openai/gpt-6-astra",
      "  costModelClass: subscription",
      "---",
      "",
      "# Codex Reviewer (test fixture)",
      "",
    ].join("\n"),
    "utf8",
  );

  runHook(root, {
    hook_event_name: "PostToolUse",
    tool_name: "mcp__codex__codex",
    tool_input: {},
    tool_response: "verdict: changes-requested — looks fine otherwise",
    session_id: "test-session-fb4",
  });

  const records = readActivity(root);
  assert.equal(records.some((r) => r.event === "FallbackTriggered"), false);
});
