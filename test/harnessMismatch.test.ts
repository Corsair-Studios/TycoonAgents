/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Harness-mismatch hint: a person prompts the non-selected harness (Claude Code on a
// Codex project, or the reverse). Hook records carry userPrompt:true only for a
// person's own top-level prompt; the host scanner turns that into a pending hint.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  dismissMismatch,
  loadDismissedMismatch,
  isMismatchSuppressed,
  mismatchPayload,
  newHarnessMismatchState,
  scanHarnessMismatch,
  suppressMismatch,
} from "../src/host/vscode/harnessMismatch";
import { MSG } from "../src/host/vscode/messages";

const CLAUDE_HOOK = path.join(process.cwd(), "hooks", "tycoon-claude-hook.cjs");
const CODEX_HOOK = path.join(process.cwd(), "hooks", "tycoon-codex-hook.cjs");

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mismatch-"));
  fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
  return root;
}
const activityPath = (root: string) => path.join(root, ".claude", "tycoon", "activity.jsonl");
function append(root: string, ...recs: object[]): void {
  fs.appendFileSync(activityPath(root), recs.map((r) => JSON.stringify(r) + "\n").join(""));
}
function memento() {
  const m = new Map<string, unknown>();
  return { get: <T>(k: string) => m.get(k) as T | undefined, update: (k: string, v: unknown) => void m.set(k, v) };
}
/** Baseline scan, then append `recs` and rescan. */
function feed(selected: string, ...recs: object[]) {
  const root = tmpRoot();
  fs.writeFileSync(activityPath(root), "");
  const st = newHarnessMismatchState();
  scanHarnessMismatch(root, selected, st);
  append(root, ...recs);
  scanHarnessMismatch(root, selected, st);
  return { root, st };
}

test("Claude Code UserPromptSubmit on a Codex project raises the hint", () => {
  const { st } = feed("codex", { event: "UserPromptSubmit", at: 5, sessionId: "s", userPrompt: true });
  const p = mismatchPayload(st, "codex", false);
  assert.equal(p.active, true);
  assert.equal(p.from, "claude-code");
  assert.equal(p.promptAt, 5);
});

test("Claude tool, subagent and untagged prompt events do not raise the hint", () => {
  const { st } = feed(
    "codex",
    { event: "PreToolUse", at: 1, tool: "Read" },
    { event: "PreToolUse", at: 2, tool: "Task", workerId: "w" },
    { event: "SubagentStop", at: 3, workerId: "w" },
    { event: "UserPromptSubmit", at: 4 }
  );
  assert.equal(mismatchPayload(st, "codex", false).active, false);
});

test("Codex user turn on a Claude Code project raises the hint; non-user Codex records do not", () => {
  const a = feed("claude-code", { event: "Stop", provider: "codex", at: 9, userPrompt: true });
  const pa = mismatchPayload(a.st, "claude-code", false);
  assert.equal(pa.active, true);
  assert.equal(pa.from, "codex");
  const b = feed("claude-code", { event: "PreToolUse", provider: "codex", at: 1, tool: "x" }, { event: "Stop", provider: "codex", at: 2 });
  assert.equal(mismatchPayload(b.st, "claude-code", false).active, false);
});

test("history present before the first scan never raises the hint", () => {
  const root = tmpRoot();
  append(root, { event: "UserPromptSubmit", at: 1, userPrompt: true });
  const st = newHarnessMismatchState();
  scanHarnessMismatch(root, "codex", st);
  assert.equal(mismatchPayload(st, "codex", false).active, false);
});

test("auto-clears when activity from the selected harness arrives; switching the harness resets", () => {
  const { root, st } = feed("codex", { event: "UserPromptSubmit", at: 5, userPrompt: true });
  assert.equal(mismatchPayload(st, "codex", false).active, true);
  append(root, { event: "PreToolUse", provider: "codex", at: 6, tool: "shell" });
  scanHarnessMismatch(root, "codex", st);
  assert.equal(mismatchPayload(st, "codex", false).active, false);

  append(root, { event: "UserPromptSubmit", at: 7, userPrompt: true });
  scanHarnessMismatch(root, "codex", st);
  assert.equal(mismatchPayload(st, "codex", false).active, true);
  scanHarnessMismatch(root, "claude-code", st);
  assert.equal(mismatchPayload(st, "claude-code", false).active, false);
});

test("Don't show again persists per project and silences the payload", () => {
  const { root, st } = feed("codex", { event: "UserPromptSubmit", at: 5, userPrompt: true });
  const store = memento();
  assert.equal(isMismatchSuppressed(store, root), false);
  suppressMismatch(store, root);
  assert.equal(isMismatchSuppressed(store, root), true);
  assert.equal(isMismatchSuppressed(store, root + "-other"), false);
  assert.equal(mismatchPayload(st, "codex", isMismatchSuppressed(store, root)).active, false);
});

test("Dismiss is per session/thread: same thread (Codex or Claude) never re-raises, a new one does", () => {
  const root = tmpRoot();
  fs.writeFileSync(activityPath(root), "");
  const st = newHarnessMismatchState();
  const store = memento();
  scanHarnessMismatch(root, "claude-code", st);
  append(root,
    { event: "UserPromptSubmit", provider: "codex", sessionId: "t1", at: 1, userPrompt: true },
    { event: "Stop", provider: "codex", sessionId: "t1", at: 2, userPrompt: true });
  scanHarnessMismatch(root, "claude-code", st);
  const p1 = mismatchPayload(st, "claude-code", false);
  assert.equal(p1.active, true);
  assert.equal(p1.promptAt, 1, "second record of the same turn keeps the first at");
  dismissMismatch(st, store, root);
  assert.equal(mismatchPayload(st, "claude-code", false).active, false);
  append(root, { event: "Stop", provider: "codex", sessionId: "t1", at: 50, userPrompt: true });
  scanHarnessMismatch(root, "claude-code", st);
  assert.equal(mismatchPayload(st, "claude-code", false).active, false, "second turn, same thread");
  append(root, { event: "Stop", provider: "codex", sessionId: "t2", at: 60, userPrompt: true });
  scanHarnessMismatch(root, "claude-code", st);
  assert.equal(mismatchPayload(st, "claude-code", false).active, true, "new thread");

  const st2 = newHarnessMismatchState();
  loadDismissedMismatch(st2, store, root);
  assert.ok(st2.dismissed.includes("codex:t1"), "persisted");

  const c = feed("codex", { event: "UserPromptSubmit", sessionId: "s1", at: 1, userPrompt: true });
  dismissMismatch(c.st, undefined, c.root);
  append(c.root, { event: "UserPromptSubmit", sessionId: "s1", at: 9, userPrompt: true });
  scanHarnessMismatch(c.root, "codex", c.st);
  assert.equal(mismatchPayload(c.st, "codex", false).active, false, "Claude same session");
});

test("dismissed ids are bounded to the last 50", () => {
  const st = newHarnessMismatchState();
  for (let i = 0; i < 60; i++) {
    st.pending = { from: "codex", at: i, sessionId: `codex:t${i}` };
    dismissMismatch(st, undefined, "r");
  }
  assert.equal(st.dismissed.length, 50);
  assert.equal(st.dismissed[49], "codex:t59");
});

test("activity.jsonl absent on first scan: its first content is new, not history", () => {
  const root = tmpRoot();
  const st = newHarnessMismatchState();
  scanHarnessMismatch(root, "codex", st);
  append(root, { event: "UserPromptSubmit", sessionId: "s", at: 3, userPrompt: true });
  scanHarnessMismatch(root, "codex", st);
  assert.equal(mismatchPayload(st, "codex", false).active, true);
});

test("rotation to a larger file is detected via first-line fingerprint", () => {
  const root = tmpRoot();
  append(root, { event: "PreToolUse", at: 1, tool: "a" });
  const st = newHarnessMismatchState();
  scanHarnessMismatch(root, "codex", st);
  // Replace with a new, larger file whose first line differs.
  fs.writeFileSync(
    activityPath(root),
    [{ event: "SessionStart", at: 100, sessionId: "n", pad: "x".repeat(200) }, { event: "UserPromptSubmit", sessionId: "n", at: 101, userPrompt: true }]
      .map((r) => JSON.stringify(r) + "\n").join("")
  );
  scanHarnessMismatch(root, "codex", st);
  assert.equal(mismatchPayload(st, "codex", false).active, true);
});

test("message names exist for the host/webview contract", () => {
  assert.equal(MSG.HARNESS_MISMATCH_DISMISS, "harnessMismatchDismiss");
  assert.equal(MSG.HARNESS_MISMATCH, "harnessMismatch");
  assert.equal(MSG.HARNESS_MISMATCH_SUPPRESS, "harnessMismatchSuppress");
});

function runClaudeHook(root: string, payload: object, extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root, ...extra };
  if (!("TYCOON_BRIDGE_CHILD" in extra)) delete env.TYCOON_BRIDGE_CHILD;
  return spawnSync(process.execPath, [CLAUDE_HOOK], { input: JSON.stringify(payload), encoding: "utf8", env });
}
function records(root: string): Array<Record<string, unknown>> {
  try {
    return fs.readFileSync(activityPath(root), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test("Claude hook: a person's UserPromptSubmit is flagged; subagent prompt, tool events and bridge children are not", () => {
  const root = tmpRoot();
  runClaudeHook(root, { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "hi" });
  runClaudeHook(root, { hook_event_name: "UserPromptSubmit", session_id: "s2", agent_id: "sub-1", prompt: "x" });
  const recs = records(root).filter((r) => r.event === "UserPromptSubmit");
  assert.equal(recs.find((r) => r.sessionId === "s1")?.userPrompt, true);
  assert.equal(recs.find((r) => r.sessionId === "s2")?.userPrompt, undefined);

  const root2 = tmpRoot();
  runClaudeHook(root2, { hook_event_name: "PreToolUse", tool_name: "Read", session_id: "s3", tool_input: {} });
  assert.ok(records(root2).every((r) => r.userPrompt === undefined));

  const root3 = tmpRoot();
  runClaudeHook(root3, { hook_event_name: "UserPromptSubmit", session_id: "s4", prompt: "hi" }, { TYCOON_BRIDGE_CHILD: "1" });
  assert.equal(records(root3).length, 0, "bridge child writes nothing, so no hint");
});

test("Codex hook: user notify turn is flagged; a bridge child writes nothing", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const hook = require(CODEX_HOOK) as {
    mapNotifyPayload: (p: Record<string, unknown>, f: string, at: number, env?: NodeJS.ProcessEnv) => Array<Record<string, unknown>>;
    mapHooksPayload: (e: string, p: Record<string, unknown>, at: number) => Array<Record<string, unknown>>;
  };
  const recs = hook.mapNotifyPayload({ type: "agent-turn-complete", "thread-id": "t-user" }, path.join(os.tmpdir(), "nope-activity.jsonl"), 100, {});
  assert.deepEqual(recs.map((r) => [r.event, r.userPrompt]), [["UserPromptSubmit", true], ["Stop", true]]);
  const tool = hook.mapHooksPayload("pre_tool_use", { thread_id: "t", tool_name: "shell" }, 1);
  assert.equal(tool[0].userPrompt, undefined);

  const root = tmpRoot();
  const r = spawnSync(process.execPath, [CODEX_HOOK, JSON.stringify({ type: "agent-turn-complete", "thread-id": "t-bridge", cwd: root })], {
    encoding: "utf8",
    input: "",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, TYCOON_BRIDGE_CHILD: "1" },
  });
  assert.equal(r.status, 0);
  assert.equal(records(root).length, 0);
});

test("claude-cli bridge child env carries TYCOON_BRIDGE_CHILD=1 (source guard)", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "hooks", "claude-cli-mcp.cjs"), "utf8");
  assert.match(src, /TYCOON_BRIDGE_CHILD: "1"/);
});
