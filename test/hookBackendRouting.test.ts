/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for the generic backend-aware MCP routing added to
// hooks/tycoon-claude-hook.cjs (buildMcpBackendRouting/lookupMcpBackend,
// ~84-217; PreToolUse call site ~1345-1385; legacy mcp__codex__ fallback
// ~1505-1512, gated on agentBackend.js being ABSENT next to the hook). Same
// spawn-the-real-script technique as test/tycoonClaudeHookCodexOffload.test.ts
// — the hook is a standalone .cjs with no exports, invoked fresh per event.
//
// The hook requires path.join(__dirname, "agentBackend.js") and
// "modelAliases.js" (lazily, guarded — see getAgentBackendModule /
// getModelAliasesModule). To exercise the "module present" path we copy
// out/src/core/{agentBackend,modelAliases}.js next to a copy of the hook in
// a scratch dir; to exercise "module absent" we simply don't.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const REAL_HOOK_PATH = join(REPO_ROOT, "hooks", "tycoon-claude-hook.cjs");
const FIXTURE_PATH = join(REPO_ROOT, "test", "fixtures", "codex-offload-before.jsonl");
const CODEX_REVIEWER_MD = join(REPO_ROOT, ".claude", "agents", "codex-reviewer.md");

interface ActivityRecord {
  event: string;
  tool?: string;
  workerId?: string;
  model?: string;
  vendor?: string;
  costModelClass?: string;
  tokens?: number;
  cacheReadTokens?: number;
  at?: number;
  delegationMode?: string;
  sessionId?: string;
  [key: string]: unknown;
}

function readFixtureRecord(): ActivityRecord {
  const raw = readFileSync(FIXTURE_PATH, "utf8").trim();
  return JSON.parse(raw.split("\n")[0]) as ActivityRecord;
}

/** Set up a scratch project dir with .claude/agents/ (and optionally a hook copy with the compiled modules next to it). */
function setupProject(opts: { withModule: boolean; extraAgentMd?: { name: string; content: string } }): {
  root: string;
  hookPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "tycoon-hook-backend-test-"));
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  if (opts.extraAgentMd) {
    writeFileSync(join(root, ".claude", "agents", opts.extraAgentMd.name), opts.extraAgentMd.content, "utf8");
  }

  // Hook + module copies live in their own scratch dir (separate from
  // projectRoot) so __dirname resolution finds/doesn't-find the modules
  // independent of the project's own .claude/agents contents.
  const hookDir = mkdtempSync(join(tmpdir(), "tycoon-hook-copy-"));
  const hookPath = join(hookDir, "tycoon-claude-hook.cjs");
  copyFileSync(REAL_HOOK_PATH, hookPath);
  if (opts.withModule) {
    copyFileSync(join(REPO_ROOT, "out", "src", "core", "agentBackend.js"), join(hookDir, "agentBackend.js"));
    copyFileSync(join(REPO_ROOT, "out", "src", "core", "modelAliases.js"), join(hookDir, "modelAliases.js"));
  }
  return { root, hookPath };
}

function runHook(hookPath: string, projectRoot: string, payload: Record<string, unknown>): void {
  const result = spawnSync(process.execPath, [hookPath], {
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

function cleanup(...dirs: string[]): void {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

test("agentBackend.js present in out/src/core (build precondition for this suite)", () => {
  assert.ok(existsSync(join(REPO_ROOT, "out", "src", "core", "agentBackend.js")), "run tsc -p . before this suite");
  assert.ok(existsSync(join(REPO_ROOT, "out", "src", "core", "modelAliases.js")), "run tsc -p . before this suite");
});

// ---------------------------------------------------------------------------
// (a) WITHOUT the copied module: legacy mcp__codex__ special case fires,
// output matches the pre-change fixture (modulo the non-deterministic `at`
// timestamp, which the hook sets to Date.now()).
// ---------------------------------------------------------------------------

test("(a) without agentBackend.js next to the hook, a mcp__codex__codex call reproduces the pre-change fixture record", () => {
  const fixture = readFixtureRecord();
  const { root, hookPath } = setupProject({ withModule: false });
  try {
    runHook(hookPath, root, {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__codex__codex",
      tool_input: {},
      session_id: fixture.sessionId,
    });
    const records = readActivity(root);
    const rec = records.find((r) => r.event === "PreToolUse" && r.tool === "mcp__codex__codex");
    assert.ok(rec, "expected an activity record for the mcp__codex__codex call");

    const { at: _fixtureAt, ...fixtureRest } = fixture;
    const { at: _recAt, ...recRest } = rec!;
    assert.deepEqual(recRest, fixtureRest, "record fields (excluding the non-deterministic `at` timestamp) must match the pre-change fixture exactly");
    assert.equal(typeof rec!.at, "number");
    assert.equal("vendor" in rec!, false, "legacy path never adds vendor");
    assert.equal("costModelClass" in rec!, false, "legacy path never adds costModelClass");
  } finally {
    cleanup(root, join(hookPath, ".."));
  }
});

// ---------------------------------------------------------------------------
// (b) WITH the module and the real codex-reviewer.md: same base record plus
// model 'openai/gpt-6-astra', vendor 'openai', costModelClass 'subscription'.
// ---------------------------------------------------------------------------

test("(b) with agentBackend.js present and the real codex-reviewer.md, a mcp__codex__codex call adds vendor+costModelClass and the backend model", () => {
  const fixture = readFixtureRecord();
  const { root, hookPath } = setupProject({ withModule: true });
  try {
    copyFileSync(CODEX_REVIEWER_MD, join(root, ".claude", "agents", "codex-reviewer.md"));
    runHook(hookPath, root, {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__codex__codex",
      tool_input: {},
      session_id: fixture.sessionId,
    });
    const records = readActivity(root);
    const rec = records.find((r) => r.event === "PreToolUse" && r.tool === "mcp__codex__codex");
    assert.ok(rec, "expected an activity record for the mcp__codex__codex call");

    assert.equal(rec!.model, "openai/gpt-6-astra", "model must come from codex-reviewer.md's backend.model");
    assert.equal(rec!.vendor, "openai");
    assert.equal(rec!.costModelClass, "subscription");
    assert.equal(rec!.tool, "mcp__codex__codex");
    assert.equal(rec!.workerId, "orchestrator");
    assert.equal(rec!.delegationMode, "flat");
    assert.equal(rec!.sessionId, fixture.sessionId);
    assert.equal("tokens" in rec!, false, "tokens must stay absent — Codex's MCP surface never reports usage");
    assert.equal("cacheReadTokens" in rec!, false);
  } finally {
    cleanup(root, join(hookPath, ".."));
  }
});

// ---------------------------------------------------------------------------
// (c) A synthetic agent with mcpServer 'gemini', tools ['ask'] routes
// mcp__gemini__ask with vendor 'google'.
// ---------------------------------------------------------------------------

test("(c) a synthetic agent with mcpServer 'gemini' and tools ['ask'] routes mcp__gemini__ask with vendor google", () => {
  const geminiAgentMd = `---
model: sonnet
backend:
  vendor: google
  transport: mcp
  mcpServer: gemini
  tools: [ask]
  model: google/gemini-2.5-pro
  costModelClass: metered
---

# Gemini Reviewer (test fixture)
`;
  const { root, hookPath } = setupProject({ withModule: true, extraAgentMd: { name: "gemini-test-agent.md", content: geminiAgentMd } });
  try {
    runHook(hookPath, root, {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__gemini__ask",
      tool_input: {},
      session_id: "test-session-gemini-1",
    });
    const records = readActivity(root);
    const rec = records.find((r) => r.event === "PreToolUse" && r.tool === "mcp__gemini__ask");
    assert.ok(rec, "expected an activity record for the mcp__gemini__ask call");
    assert.equal(rec!.vendor, "google");
    assert.equal(rec!.model, "google/gemini-2.5-pro");
    assert.equal(rec!.costModelClass, "metered");
  } finally {
    cleanup(root, join(hookPath, ".."));
  }
});

// ---------------------------------------------------------------------------
// (d) A tool from an unregistered MCP server still yields the generic
// 'wire' WorkerActivity (no model/vendor/costModelClass), as before.
// ---------------------------------------------------------------------------

test("(d) a tool from an unregistered MCP server yields the generic activity record with no model/vendor/costModelClass", () => {
  const { root, hookPath } = setupProject({ withModule: true });
  try {
    runHook(hookPath, root, {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__totally-unregistered-server__do-thing",
      tool_input: { model: "should-not-be-copied" },
      session_id: "test-session-unregistered-1",
    });
    const records = readActivity(root);
    const rec = records.find((r) => r.event === "PreToolUse" && r.tool === "mcp__totally-unregistered-server__do-thing");
    assert.ok(rec, "expected an activity record for the unregistered-server call");
    assert.equal("model" in rec!, false, "no backend matched this server — no model should be fabricated");
    assert.equal("vendor" in rec!, false);
    assert.equal("costModelClass" in rec!, false);
    assert.equal("tokens" in rec!, false);
    assert.equal(rec!.workerId, "orchestrator");
  } finally {
    cleanup(root, join(hookPath, ".."));
  }
});
