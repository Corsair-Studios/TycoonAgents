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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK_PATH = join(process.cwd(), "hooks", "tycoon-claude-hook.cjs");

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
