/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Covers the Priority -1 "AGENT:<agent-id>" explicit routing override in
// hooks/tycoon-claude-hook.cjs (see the block above "// Priority 0: Agent
// tool "name" param" in the PreToolUse Task-spawn handler). Driven the same
// way as test/tycoonClaudeHookSpawn.test.ts: spawn the hook as a child
// process with a PreToolUse/Task payload on stdin, then inspect the
// activity.jsonl record it appends under a scratch CLAUDE_PROJECT_DIR.
//
// Regression this guards: three briefs intended for codex-reviewer landed on
// coding-specialist / workspace-monitor instead, because the task's subject
// matter (hooks, records, active state, sessions, code, updates) out-scored
// the routing intent under plain keyword scoring. The override marker lets
// the orchestrator force attribution regardless of keyword density.

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
  routingMethod?: string;
  matchedKeyword?: string;
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

// Mirrors the real .claude/tycoon/agent-keywords.json (see that file in this
// repo) closely enough to reproduce the actual regression: coding-specialist
// and workspace-monitor both carry keywords that a codex-review-shaped brief
// legitimately contains.
const REAL_KEYWORDS_CONFIG = {
  fallback_agent: "primary-agent",
  agents: {
    "search-retrieval": {
      pattern:
        "search|find|look|where|locate|explore|grep|glob|file|pattern|reference|documentation|example|retrieval",
    },
    "coding-specialist": {
      pattern:
        "implement|code|fix|bug|refactor|create|add|update|function|class|method|logic|algorithm|typescript",
    },
    "testing-specialist": {
      pattern: "test|spec|vitest|jest|mocha|assert|mock|stub|testing|qa|verify|validate|e2e|fixture|coverage|unit",
    },
    "vscode-integration": {
      pattern:
        "vscode|extension|webview|panel|lifecycle|api|command|activation|manifest|menus|settings|configuration|disposable|message",
    },
    "ux-ui-designer": {
      pattern: "ux|ui|design|layout|css|canvas|render|animation|sprite|scene|visual|style|transition|accessibility",
    },
    "workspace-monitor": {
      pattern: "monitor|lifecycle|event|activity|hook|status|track|real-time|session|mapping|normalize|record|idle|active",
    },
    "primary-agent": {
      pattern: "orchestrate|coordinate|plan|delegate|primary|main|orchestrator",
    },
    "codex-reviewer": {
      pattern: "codex|foreign-review|cross-vendor|second-opinion|adversarial-review",
    },
  },
};

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), "tycoon-hook-override-test-"));
  const agentsDir = join(root, ".claude", "agents");
  const tycoonDir = join(root, ".claude", "tycoon");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(tycoonDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "codex-reviewer.md"),
    "---\ndescription: Cross-vendor adversarial review.\nmodel: opus\n---\nBody.\n",
    "utf8",
  );
  writeFileSync(
    join(agentsDir, "coding-specialist.md"),
    "---\ndescription: Implements code.\nmodel: sonnet\n---\nBody.\n",
    "utf8",
  );
  writeFileSync(
    join(agentsDir, "workspace-monitor.md"),
    "---\ndescription: Monitors agent lifecycle events.\nmodel: sonnet\n---\nBody.\n",
    "utf8",
  );
  writeFileSync(join(tycoonDir, "agent-keywords.json"), JSON.stringify(REAL_KEYWORDS_CONFIG, null, 2), "utf8");
  return root;
}

function spawnTaskPayload(prompt: string, description = "review the change"): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Task",
    tool_input: { subagent_type: "general-purpose", description, prompt },
    session_id: "override-test-session",
  };
}

test("override marker wins over dense competing keywords (regression: codex-review briefs misrouted to coding-specialist/workspace-monitor)", () => {
  const root = setupProject();
  try {
    // Deliberately dense with coding-specialist and workspace-monitor
    // keywords (hook, record, active, session, code, update) — this is the
    // exact shape of brief that previously out-scored intent under plain
    // keyword matching.
    const densePrompt =
      "AGENT:codex-reviewer Review the hook that writes activity records for the active session. " +
      "Check that the code update to the routing logic is correct and that the active-agent stack " +
      "records the right session state after every hook event.";
    runHook(root, spawnTaskPayload(densePrompt));

    const records = readActivity(root);
    const spawn = records.find((r) => r.event === "PreToolUse");
    assert.ok(spawn, "expected a spawn record");
    assert.equal(spawn!.workerId, "codex-reviewer");
    assert.equal(spawn!.routingMethod, "override");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("override marker beyond the 500-char keyword window still wins", () => {
  const root = setupProject();
  try {
    // Keyword scoring only reads description + first 500 chars of prompt;
    // the override must scan the FULL prompt. Pad well past 500 chars
    // before placing the marker.
    const filler = "This brief needs careful background context before the actual instruction. ".repeat(10);
    assert.ok(filler.length > 500, "filler must exceed the 500-char keyword window");
    const prompt = `${filler}Now, for the real task: AGENT:codex-reviewer please perform the cross-vendor review.`;
    runHook(root, spawnTaskPayload(prompt));

    const records = readActivity(root);
    const spawn = records.find((r) => r.event === "PreToolUse");
    assert.ok(spawn, "expected a spawn record");
    assert.equal(spawn!.workerId, "codex-reviewer");
    assert.equal(spawn!.routingMethod, "override");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("override id with no matching agent file is ignored (anti-fabrication guard) and falls through to keyword routing", () => {
  const root = setupProject();
  try {
    const prompt = "AGENT:no-such-agent please implement a fix for this bug and refactor the function.";
    runHook(root, spawnTaskPayload(prompt));

    const records = readActivity(root);
    const spawn = records.find((r) => r.event === "PreToolUse");
    assert.ok(spawn, "expected a spawn record");
    assert.notEqual(spawn!.workerId, "no-such-agent", "unvalidated override id must never be fabricated as an agentId");
    assert.notEqual(spawn!.routingMethod, "override");
    // Falls through to keyword routing: "implement", "fix", "bug", "refactor",
    // "function" are all coding-specialist keywords.
    assert.equal(spawn!.workerId, "coding-specialist");
    assert.equal(spawn!.routingMethod, "keyword");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("override marker is case-insensitive", () => {
  const root = setupProject();
  try {
    runHook(root, spawnTaskPayload("agent:codex-reviewer please review this."));
    const records = readActivity(root);
    const spawn = records.find((r) => r.event === "PreToolUse");
    assert.ok(spawn, "expected a spawn record for lowercase marker");
    assert.equal(spawn!.workerId, "codex-reviewer");
    assert.equal(spawn!.routingMethod, "override");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const root2 = setupProject();
  try {
    runHook(root2, spawnTaskPayload("Agent:Codex-Reviewer please review this."));
    const records = readActivity(root2);
    const spawn = records.find((r) => r.event === "PreToolUse");
    assert.ok(spawn, "expected a spawn record for mixed-case marker");
    assert.equal(spawn!.workerId, "codex-reviewer");
    assert.equal(spawn!.routingMethod, "override");
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }
});

test("no marker present leaves existing keyword routing completely unchanged", () => {
  const root = setupProject();
  try {
    // No AGENT: marker anywhere — must behave exactly as before the
    // override existed: plain keyword scoring, routingMethod "keyword".
    const prompt = "Please implement a fix for this bug and refactor the function to add a new class method.";
    runHook(root, spawnTaskPayload(prompt, "implement a fix"));

    const records = readActivity(root);
    const spawn = records.find((r) => r.event === "PreToolUse");
    assert.ok(spawn, "expected a spawn record");
    assert.equal(spawn!.workerId, "coding-specialist");
    assert.equal(spawn!.routingMethod, "keyword");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no marker present with no keyword match falls back to fallback_agent, routingMethod fallback", () => {
  const root = setupProject();
  try {
    const prompt = "zzz qqq xxx nonsense words matching nothing in the keyword table zzz qqq";
    runHook(root, spawnTaskPayload(prompt, "zzz qqq"));

    const records = readActivity(root);
    const spawn = records.find((r) => r.event === "PreToolUse");
    assert.ok(spawn, "expected a spawn record");
    assert.equal(spawn!.routingMethod, "fallback");
    assert.equal(spawn!.workerId, "primary-agent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multiple override markers present: the first one wins", () => {
  const root = setupProject();
  try {
    const prompt =
      "AGENT:codex-reviewer do the review, and if you need help AGENT:coding-specialist can assist afterward.";
    runHook(root, spawnTaskPayload(prompt));

    const records = readActivity(root);
    const spawn = records.find((r) => r.event === "PreToolUse");
    assert.ok(spawn, "expected a spawn record");
    assert.equal(spawn!.workerId, "codex-reviewer", "first marker in prompt order must win");
    assert.equal(spawn!.routingMethod, "override");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
