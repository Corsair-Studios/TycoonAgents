/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Task p69-t4: hooks/tycoon-claude-hook.cjs has no module.exports, so
 * isCodexModelSlugError() and readFlatRoutingAgentEntry() (both unexported)
 * are exercised end-to-end via the real PostToolUse mcp__codex__* failure
 * path, mirroring test/fallbackChainClaudeHook.test.ts's
 * runHookWithBackendModule technique (agentBackend.js/modelAliases.js are
 * build artifacts absent on a clean `npm test`-only checkout, so a scratch
 * copy of the hook with tsc's out/src/core/*.js copied alongside it is used
 * instead of the real hooks/ directory).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const HOOK_PATH = join(REPO_ROOT, "hooks", "tycoon-claude-hook.cjs");

function runHookWithBackendModule(projectRoot: string, payload: Record<string, unknown>): void {
  const hookDir = mkdtempSync(join(tmpdir(), "tycoon-hook-slugflat-copy-"));
  const hookPath = join(hookDir, "tycoon-claude-hook.cjs");
  copyFileSync(HOOK_PATH, hookPath);
  copyFileSync(join(REPO_ROOT, "out", "src", "core", "agentBackend.js"), join(hookDir, "agentBackend.js"));
  copyFileSync(join(REPO_ROOT, "out", "src", "core", "modelAliases.js"), join(hookDir, "modelAliases.js"));
  copyFileSync(join(REPO_ROOT, "hooks", "fallbackChain.js"), join(hookDir, "fallbackChain.js"));
  try {
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
    });
    assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);
  } finally {
    rmSync(hookDir, { recursive: true, force: true });
  }
}

function activityPath(root: string): string {
  return join(root, ".claude", "tycoon", "activity.jsonl");
}

function readActivity(root: string): Array<Record<string, unknown>> {
  return readFileSync(activityPath(root), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function writeCodexReviewerAgent(agentsDir: string): void {
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
      "  model: openai/codex-astra",
      "  costModelClass: subscription",
      "---",
      "",
      "# Codex Reviewer (test fixture)",
      "",
    ].join("\n"),
    "utf8",
  );
}

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), "tycoon-hook-slugflat-test-"));
  mkdirSync(join(root, ".claude", "tycoon"), { recursive: true });
  return root;
}

// ---------------------------------------------------------------------------
// isCodexModelSlugError classification + "codex debug models" hint
// ---------------------------------------------------------------------------

test("PostToolUse: a Codex model-slug rejection text triggers FallbackTriggered with the 'codex debug models' hint appended to reason", () => {
  const root = setupProject();
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeCodexReviewerAgent(agentsDir);
  writeFileSync(
    join(root, ".claude", "tycoon", "routing.resolved.json"),
    JSON.stringify({ agents: {}, defaultFallback: { vendor: "moonshot", model: "moonshot/kimi-k2" } }),
    "utf8",
  );

  runHookWithBackendModule(root, {
    hook_event_name: "PostToolUseFailure", // p99-t1: error results arrive as PostToolUseFailure
    tool_name: "mcp__codex__codex",
    tool_input: {},
    error: "The 'codex-astra' model is not supported when using Codex with a ChatGPT account.",
    session_id: "test-session-slug1",
  });

  const records = readActivity(root);
  const triggered = records.find((r) => r.event === "FallbackTriggered");
  assert.ok(triggered, "expected a FallbackTriggered record for the model-slug rejection");
  assert.equal(triggered!.workerId, "codex-reviewer");
  assert.ok(
    String(triggered!.reason).includes("Hint: run `codex debug models`"),
    `expected the codex debug models hint in reason, got: ${triggered!.reason}`,
  );
});

test("PostToolUse: a model-slug rejection text is case-insensitively matched", () => {
  const root = setupProject();
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeCodexReviewerAgent(agentsDir);
  writeFileSync(
    join(root, ".claude", "tycoon", "routing.resolved.json"),
    JSON.stringify({ agents: {}, defaultFallback: { vendor: "moonshot", model: "moonshot/kimi-k2" } }),
    "utf8",
  );

  runHookWithBackendModule(root, {
    hook_event_name: "PostToolUseFailure", // p99-t1: error results arrive as PostToolUseFailure
    tool_name: "mcp__codex__codex",
    tool_input: {},
    error: "THE MODEL IS NOT SUPPORTED WHEN USING CODEX WITH A CHATGPT ACCOUNT.",
    session_id: "test-session-slug2",
  });

  const records = readActivity(root);
  assert.ok(records.some((r) => r.event === "FallbackTriggered"), "case-insensitive match must still trigger fallback");
});

test("PostToolUse: ordinary non-matching failure text gets no 'codex debug models' hint appended", () => {
  const root = setupProject();
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeCodexReviewerAgent(agentsDir);
  writeFileSync(
    join(root, ".claude", "tycoon", "routing.resolved.json"),
    JSON.stringify({ agents: {}, defaultFallback: { vendor: "moonshot", model: "moonshot/kimi-k2" } }),
    "utf8",
  );

  runHookWithBackendModule(root, {
    hook_event_name: "PostToolUseFailure", // p99-t1: error results arrive as PostToolUseFailure
    tool_name: "mcp__codex__codex",
    tool_input: {},
    error: "Error: usage limit reached for this account",
    session_id: "test-session-slug3",
  });

  const records = readActivity(root);
  const triggered = records.find((r) => r.event === "FallbackTriggered");
  assert.ok(triggered, "usage-limit text is still a provider failure and must still trigger fallback");
  assert.ok(
    !String(triggered!.reason).includes("codex debug models"),
    "the model-slug hint must only be appended for an actual model-slug rejection",
  );
});

// ---------------------------------------------------------------------------
// readFlatRoutingAgentEntry: routing.resolved.json missing the agent entirely
// falls back to .claude/tycoon/routing.json's flat agents[id] shape.
// ---------------------------------------------------------------------------

test("PostToolUse: routing.resolved.json present but missing the failing agent falls back to routing.json's flat entry (chain honored)", () => {
  const root = setupProject();
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeCodexReviewerAgent(agentsDir);
  // resolved routing exists but has NO entry for codex-reviewer.
  writeFileSync(
    join(root, ".claude", "tycoon", "routing.resolved.json"),
    JSON.stringify({ agents: {} }),
    "utf8",
  );
  // Flat routing.json DOES have an entry with its own fallback chain.
  writeFileSync(
    join(root, ".claude", "tycoon", "routing.json"),
    JSON.stringify({
      agents: {
        "codex-reviewer": {
          fallback: [{ vendor: "google", model: "google/gemini-2.5-pro" }],
        },
      },
    }),
    "utf8",
  );

  runHookWithBackendModule(root, {
    hook_event_name: "PostToolUseFailure", // p99-t1: error results arrive as PostToolUseFailure
    tool_name: "mcp__codex__codex",
    tool_input: {},
    error: "Error: usage limit reached for this account",
    session_id: "test-session-flat1",
  });

  const records = readActivity(root);
  const triggered = records.find((r) => r.event === "FallbackTriggered");
  assert.ok(triggered, "expected a FallbackTriggered record");
  assert.equal(triggered!.nextModel, "google/gemini-2.5-pro", "must resolve via routing.json's flat fallback chain, not silently no-op");
});

test("PostToolUse: flat routing.json entry's own defaultFallback is used when the flat entry has no chain", () => {
  const root = setupProject();
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeCodexReviewerAgent(agentsDir);
  writeFileSync(join(root, ".claude", "tycoon", "routing.resolved.json"), JSON.stringify({ agents: {} }), "utf8");
  writeFileSync(
    join(root, ".claude", "tycoon", "routing.json"),
    JSON.stringify({
      agents: { "codex-reviewer": {} },
      defaultFallback: { vendor: "moonshot", model: "moonshot/kimi-k2" },
    }),
    "utf8",
  );

  runHookWithBackendModule(root, {
    hook_event_name: "PostToolUseFailure", // p99-t1: error results arrive as PostToolUseFailure
    tool_name: "mcp__codex__codex",
    tool_input: {},
    error: "Error: usage limit reached for this account",
    session_id: "test-session-flat2",
  });

  const records = readActivity(root);
  const triggered = records.find((r) => r.event === "FallbackTriggered");
  assert.ok(triggered);
  assert.equal(triggered!.nextModel, "moonshot/kimi-k2");
});

test("PostToolUse: flat entry's useDefaultFallback:false suppresses the flat defaultFallback once its own (empty) chain is exhausted", () => {
  const root = setupProject();
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeCodexReviewerAgent(agentsDir);
  writeFileSync(join(root, ".claude", "tycoon", "routing.resolved.json"), JSON.stringify({ agents: {} }), "utf8");
  writeFileSync(
    join(root, ".claude", "tycoon", "routing.json"),
    JSON.stringify({
      agents: { "codex-reviewer": { useDefaultFallback: false } },
      defaultFallback: { vendor: "moonshot", model: "moonshot/kimi-k2" },
    }),
    "utf8",
  );

  runHookWithBackendModule(root, {
    hook_event_name: "PostToolUseFailure", // p99-t1: error results arrive as PostToolUseFailure
    tool_name: "mcp__codex__codex",
    tool_input: {},
    error: "Error: usage limit reached for this account",
    session_id: "test-session-flat3",
  });

  const records = readActivity(root);
  // No FallbackTriggered at all is the wrong assertion (the failure record
  // still fires the branch); what must NOT happen is landing on the
  // suppressed default model.
  const triggered = records.find((r) => r.event === "FallbackTriggered");
  if (triggered) {
    assert.notEqual(triggered.nextModel, "moonshot/kimi-k2", "useDefaultFallback:false on the flat entry must suppress the flat default");
  }
});

test("PostToolUse: no routing.resolved.json AND no routing.json at all -> fail-open, no crash, no FallbackTriggered with a fabricated model", () => {
  const root = setupProject();
  const agentsDir = join(root, ".claude", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeCodexReviewerAgent(agentsDir);
  // Neither routing.resolved.json nor routing.json written at all.

  runHookWithBackendModule(root, {
    hook_event_name: "PostToolUseFailure", // p99-t1: error results arrive as PostToolUseFailure
    tool_name: "mcp__codex__codex",
    tool_input: {},
    error: "Error: usage limit reached for this account",
    session_id: "test-session-flat4",
  });

  const records = readActivity(root);
  const triggered = records.find((r) => r.event === "FallbackTriggered");
  assert.ok(triggered, "the hook must still record a FallbackTriggered attempt even with no routing files");
  assert.ok(triggered!.nextModel === undefined || triggered!.nextModel === null, "no chain and no default anywhere means no next model to report");
});
