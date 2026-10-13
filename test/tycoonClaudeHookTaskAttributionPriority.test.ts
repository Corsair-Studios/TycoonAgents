/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for the 2026-09-06 ready-test rerun misattributions: Task spawns
// briefed as "<agent-id>: <keywords> check" (the shape CLAUDE.md's
// delegation table produces) were mis-routed by keyword scoring because the
// prompt/description shared a keyword with a DIFFERENT agent
// (verse-expert and uefn-auditor once both matched bare "verse" after the
// hook's non-alnum-strip; "claude-worker"/"codex-reviewer"/"gemini-reviewer"/
// "kimi-reviewer" Task prompts routinely contain "test" from phrases like
// "Ready test rerun", which scored as a strong match for
// testing-specialist).
//
// Fix under test (hooks/tycoon-claude-hook.cjs):
//   1. Priority -2: a Task description beginning with "<agent-id>:" (or
//      em-dash/hyphen) where agent-id matches an installed
//      .claude/agents/<id>.md wins outright, before subagent_type mapping
//      and before keyword scoring.
//   2. Keyword scoring (matchAgentFromKeywords) now weights description
//      matches (DESCRIPTION_WEIGHT) far above prompt-body matches, so a
//      keyword only present in the prompt body can no longer outscore a
//      description match.
//
// Driven the same way as tycoonClaudeHookAttribution.test.ts: spawn the hook
// as a child process with a Task PreToolUse payload and inspect the
// activity.jsonl record it writes.
//
// This file owns ONLY test/ — it does not and must not edit
// hooks/tycoon-claude-hook.cjs.

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
  tool?: string;
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

function activityPath(projectRoot: string): string {
  return join(projectRoot, ".claude", "tycoon", "activity.jsonl");
}

function readActivity(projectRoot: string): ActivityRecord[] {
  const raw = readFileSync(activityPath(projectRoot), "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ActivityRecord);
}

const AGENT_MD: Record<string, string> = {
  "coding-specialist": "Implements code.\nmodel: sonnet",
  "search-retrieval": "Search and retrieval.\nmodel: haiku",
  "testing-specialist": "Writes tests.\nmodel: sonnet",
  "verse-expert": "Verse/UEFN digest.\nmodel: sonnet",
  "uefn-auditor": "Verse audit/lint.\nmodel: sonnet",
  "claude-worker": "Claude CLI subscription worker.\nmodel: sonnet",
  "codex-reviewer": "Codex cross-vendor review.\nmodel: sonnet",
  "gemini-reviewer": "Gemini cross-vendor review.\nmodel: sonnet",
  "kimi-reviewer": "Kimi/qwen cross-vendor review.\nmodel: sonnet",
};

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), "tycoon-hook-task-priority-test-"));
  const agentsDir = join(root, ".claude", "agents");
  const tycoonDir = join(root, ".claude", "tycoon");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(tycoonDir, { recursive: true });
  for (const [id, desc] of Object.entries(AGENT_MD)) {
    writeFileSync(join(agentsDir, id + ".md"), `---\ndescription: ${desc}\n---\nBody.\n`, "utf8");
  }
  // Mirrors .claude/tycoon/agent-keywords.json — pipe-separated keyword
  // patterns exactly as generated from each agent's "Keywords (for task
  // routing)" section, including the reviewer agents' own keywords (codex,
  // gemini, kimi, claude-cli, foreign-review) which ARE present in this
  // table (confirmed against the live repo's agent-keywords.json).
  const keywordsConfig = {
    fallback_agent: "coding-specialist",
    agents: {
      "coding-specialist": { pattern: "implement|code|fix|bug|refactor|create|add|update|function|class|method|logic|algorithm|typescript" },
      "search-retrieval": { pattern: "search|find|look|where|locate|explore|grep|glob|file|pattern|reference|documentation|example|retrieval" },
      "testing-specialist": { pattern: "test|spec|vitest|jest|mocha|assert|mock|stub|testing|qa|verify|validate|e2e|fixture|coverage|unit" },
      "verse-expert": { pattern: "verse|uefn|fortnite|device|island|creative|digest" },
      "uefn-auditor": { pattern: "auditor|lint|deprecation|deprecated|compliance" },
      "codex-reviewer": { pattern: "codex|foreign-review|cross-vendor|second-opinion|adversarial-review" },
      "gemini-reviewer": { pattern: "gemini|foreign-review|cross-vendor|second-opinion|adversarial-review" },
      "kimi-reviewer": { pattern: "kimi|qwen|local-review|openai-compatible|foreign-review|cross-vendor|second-opinion|adversarial-review" },
      "claude-worker": { pattern: "claude-cli|subscription-worker" },
    },
  };
  writeFileSync(join(tycoonDir, "agent-keywords.json"), JSON.stringify(keywordsConfig, null, 2), "utf8");
  return root;
}

function taskPreToolUse(description: string, prompt: string, sessionId = "priority-session"): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Task",
    tool_input: { subagent_type: "general-purpose", description, prompt },
    session_id: sessionId,
  };
}

function lastRecord(root: string): ActivityRecord {
  const records = readActivity(root).filter((r) => r.event === "PreToolUse" && r.tool === "Task");
  const rec = records[records.length - 1];
  assert.ok(rec, "expected a PreToolUse/Task activity record");
  return rec;
}

// ---------------------------------------------------------------------------
// The five reproduced misattributions
// ---------------------------------------------------------------------------

test("uefn-auditor: verse-audit description no longer loses to verse-expert on shared 'verse' keyword", () => {
  const root = setupProject();
  try {
    runHook(root, taskPreToolUse(
      "uefn-auditor: verse-audit verse-lint check",
      "Run the verse audit and lint checks across the project.",
    ));
    const rec = lastRecord(root);
    assert.equal(rec.workerId, "uefn-auditor");
    assert.equal(rec.routingMethod, "description-prefix");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claude-worker: claude-cli subscription-worker description no longer loses to testing-specialist on 'test' in the prompt", () => {
  const root = setupProject();
  try {
    runHook(root, taskPreToolUse(
      "claude-worker: claude-cli subscription-worker check",
      "Ready test rerun — confirm the claude-worker subscription CLI bridge responds.",
    ));
    const rec = lastRecord(root);
    assert.equal(rec.workerId, "claude-worker");
    assert.equal(rec.routingMethod, "description-prefix");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex-reviewer: codex foreign-review description no longer loses to testing-specialist on 'test' in the prompt", () => {
  const root = setupProject();
  try {
    runHook(root, taskPreToolUse(
      "codex-reviewer: codex foreign-review check",
      "Ready test rerun — confirm the codex MCP reviewer responds.",
    ));
    const rec = lastRecord(root);
    assert.equal(rec.workerId, "codex-reviewer");
    assert.equal(rec.routingMethod, "description-prefix");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gemini-reviewer: gemini foreign-review description no longer loses to testing-specialist on 'test' in the prompt", () => {
  const root = setupProject();
  try {
    runHook(root, taskPreToolUse(
      "gemini-reviewer: gemini foreign-review check",
      "Ready test rerun — confirm the gemini reviewer responds.",
    ));
    const rec = lastRecord(root);
    assert.equal(rec.workerId, "gemini-reviewer");
    assert.equal(rec.routingMethod, "description-prefix");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kimi-reviewer: kimi qwen description no longer loses to testing-specialist on 'test' in the prompt", () => {
  const root = setupProject();
  try {
    runHook(root, taskPreToolUse(
      "kimi-reviewer: kimi qwen local-review check",
      "Ready test rerun — confirm the kimi/qwen local reviewer responds.",
    ));
    const rec = lastRecord(root);
    assert.equal(rec.workerId, "kimi-reviewer");
    assert.equal(rec.routingMethod, "description-prefix");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression: ordinary descriptions with no "<agent-id>:" prefix still route
// by keyword scoring exactly as before.
// ---------------------------------------------------------------------------

test("regression: 'implement the retry logic' still routes to coding-specialist", () => {
  const root = setupProject();
  try {
    runHook(root, taskPreToolUse(
      "coding-specialist: implement retry logic",
      "implement the retry logic",
    ));
    const rec = lastRecord(root);
    assert.equal(rec.workerId, "coding-specialist");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("regression: description with no agent-id prefix, 'search where X is defined', still routes to search-retrieval by keyword", () => {
  const root = setupProject();
  try {
    runHook(root, taskPreToolUse(
      "search-retrieval: find where X is defined",
      "search where X is defined",
    ));
    const rec = lastRecord(root);
    assert.equal(rec.workerId, "search-retrieval");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("regression: a plain description with no agent-id prefix at all still routes by keyword scoring (no crash on missing prefix match)", () => {
  const root = setupProject();
  try {
    runHook(root, taskPreToolUse(
      "find where the retry logic is defined",
      "search the codebase for the retry implementation",
    ));
    const rec = lastRecord(root);
    assert.equal(rec.workerId, "search-retrieval");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
