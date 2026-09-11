/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Plan task p29-t2: the Claude hook surfaces unseen plan-gate
 * approvals/rejections from <tycoonDir>/gate-events.jsonl to the
 * orchestrator via additionalContext, on UserPromptSubmit and on
 * PostToolUse for tool_name "Task". Driven the same way as
 * test/fallbackChainClaudeHook.test.ts - spawn the real hook as a child
 * process, pipe a JSON payload on stdin.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, statSync } from "node:fs";
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

function tycoonDirPath(projectRoot: string): string {
  return join(projectRoot, ".claude", "tycoon");
}

function gateEventsPath(projectRoot: string): string {
  return join(tycoonDirPath(projectRoot), "gate-events.jsonl");
}

function gateCursorPath(projectRoot: string): string {
  return join(tycoonDirPath(projectRoot), "gate-events.cursor");
}

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), "tycoon-hook-gate-events-test-"));
  mkdirSync(tycoonDirPath(root), { recursive: true });
  return root;
}

function parsedOutput(stdout: string): Record<string, unknown> | null {
  if (!stdout.trim()) return null;
  return JSON.parse(stdout);
}

test("UserPromptSubmit: a gate event produces additionalContext once, then none on a second call with no new events", () => {
  const root = setupProject();
  writeFileSync(
    gateEventsPath(root),
    JSON.stringify({
      ts: "2026-09-11T12:00:00Z",
      type: "gate",
      phaseId: "p28",
      phaseNum: 28,
      name: "Codex MCP launcher with runtime discovery",
      gate: "approved",
      source: "panel",
    }) + "\n",
    "utf8",
  );

  const first = runHook(root, { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "continue" });
  const out1 = parsedOutput(first.stdout);
  assert.ok(out1, "first call should emit additionalContext");
  assert.match(
    String(out1!.additionalContext),
    /Plan gate update: phase 28 Codex MCP launcher with runtime discovery approved at 2026-09-11T12:00:00Z \(panel\)\./,
  );

  assert.ok(existsSync(gateCursorPath(root)), "cursor file should be created");
  const cursorAfterFirst = readFileSync(gateCursorPath(root), "utf8").trim();
  assert.equal(cursorAfterFirst, String(statSync(gateEventsPath(root)).size));

  const second = runHook(root, { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "continue again" });
  const out2 = parsedOutput(second.stdout);
  assert.equal(out2, null, "second call with no new events should emit no additionalContext");
});

test("PostToolUse Task: malformed lines are skipped and a shrunk file resets the cursor to re-read from the start", () => {
  const root = setupProject();
  writeFileSync(
    gateEventsPath(root),
    [
      JSON.stringify({ ts: "2026-09-11T13:00:00Z", type: "gate", phaseId: "p29", phaseNum: 29, name: "Gate surfacing", gate: "rejected", source: "standalone" }),
      "{not valid json",
      "",
    ].join("\n") + "\n",
    "utf8",
  );

  const first = runHook(root, { hook_event_name: "PostToolUse", tool_name: "Task", session_id: "s2" });
  const out1 = parsedOutput(first.stdout);
  assert.ok(out1, "should emit hookSpecificOutput for Task PostToolUse");
  const hso1 = out1!.hookSpecificOutput as Record<string, unknown>;
  assert.equal(hso1.hookEventName, "PostToolUse");
  const ctx1 = String(hso1.additionalContext);
  assert.match(ctx1, /phase 29 Gate surfacing rejected/);
  // Only one valid line -> exactly one gate line in the context.
  assert.equal(ctx1.split("\n").filter((l) => l.trim()).length, 1);

  // Simulate rotation: file shrinks below the recorded cursor.
  writeFileSync(
    gateEventsPath(root),
    JSON.stringify({ ts: "2026-09-11T14:00:00Z", type: "gate", phaseId: "p30", phaseNum: 30, name: "Post-rotation gate", gate: "pending", source: "panel" }) + "\n",
    "utf8",
  );

  const second = runHook(root, { hook_event_name: "PostToolUse", tool_name: "Task", session_id: "s2" });
  const out2 = parsedOutput(second.stdout);
  assert.ok(out2, "cursor reset after shrink should re-surface events from offset 0");
  const hso2 = out2!.hookSpecificOutput as Record<string, unknown>;
  assert.match(String(hso2.additionalContext), /phase 30 Post-rotation gate pending/);
});

test("UserPromptSubmit: a multi-line 500-char name is sanitized to a single line, capped, with no control chars, under the additionalContext line cap", () => {
  const root = setupProject();
  const longName = "line one\r\nline two\ttabbed\n" + "x".repeat(500);
  writeFileSync(
    gateEventsPath(root),
    JSON.stringify({
      ts: "2026-09-11T16:00:00Z",
      type: "gate",
      phaseId: "p32-with-a-very-long-phase-id-that-exceeds-the-cap",
      phaseNum: 32,
      name: longName,
      gate: "approved",
      source: "panel",
    }) + "\n",
    "utf8",
  );

  const result = runHook(root, { hook_event_name: "UserPromptSubmit", session_id: "s4", prompt: "go" });
  const out = parsedOutput(result.stdout);
  assert.ok(out, "should emit additionalContext");
  const ctx = String(out!.additionalContext);

  assert.equal(ctx.split("\n").length, 1, "context must be exactly one line despite the multi-line input name");
  assert.doesNotMatch(ctx, /[\r\n\t]/, "no raw control chars (CR/LF/TAB) may survive into the line");
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(ctx, /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/, "no other control chars may survive into the line");
  assert.match(ctx, /line one line two tabbed x{50,}…/, "name is collapsed to spaces then truncated with an ellipsis");
  assert.ok(ctx.length < 250, `line should stay well under the 120-char name cap plus surrounding text, got ${ctx.length}`);
});

test("PostToolUse for a non-Task tool with no mcp__ prefix is unaffected by gate events (existing behavior unchanged)", () => {
  const root = setupProject();
  writeFileSync(
    gateEventsPath(root),
    JSON.stringify({ ts: "2026-09-11T15:00:00Z", type: "gate", phaseId: "p31", phaseNum: 31, name: "Unrelated", gate: "approved", source: "panel" }) + "\n",
    "utf8",
  );

  const result = runHook(root, { hook_event_name: "PostToolUse", tool_name: "Read", session_id: "s3" });
  assert.equal(result.stdout.trim(), "", "non-Task, non-mcp__ PostToolUse must emit nothing, as before");
});
