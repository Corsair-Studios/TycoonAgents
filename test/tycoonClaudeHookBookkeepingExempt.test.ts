import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideDirectToolCall, isOrchestratorBookkeepingPath } from "../src/core/delegationEnforcement";

const HOOK_PATH = join(process.cwd(), "hooks", "tycoon-claude-hook.cjs");

function nudged(root: string, tool: string, filePath: string): boolean {
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: filePath }, session_id: "s" }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.includes("ran directly on the orchestrator");
}

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "tycoon-bookkeeping-"));
  mkdirSync(join(root, ".claude", "tycoon"), { recursive: true });
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("orchestrator Edit of the session journal gets no nudge (Windows-style and POSIX-style paths)", () => {
  withRoot((root) => {
    const fwd = root.replace(/[\\]/g, "/");
    assert.equal(nudged(root, "Edit", join(root, ".claude", "session-journal.json")), false);
    assert.equal(nudged(root, "Edit", `${fwd}/.claude/session-journal.json`), false);
    assert.equal(nudged(root, "Edit", ".claude\\session-journal.json"), false);
    assert.equal(nudged(root, "Edit", ".claude/session-journal.json"), false);
  });
});

test("orchestrator Write of plan.json and plan.json.bak gets no nudge", () => {
  withRoot((root) => {
    const fwd = root.replace(/[\\]/g, "/");
    assert.equal(nudged(root, "Write", join(root, ".claude", "tycoon", "plan.json")), false);
    assert.equal(nudged(root, "Write", `${fwd}/.claude/tycoon/plan.json.bak`), false);
    assert.equal(nudged(root, "Write", ".claude\\tycoon\\plan.json"), false);
    assert.equal(nudged(root, "Write", ".claude/tycoon/plan.json.bak"), false);
  });
});

test("orchestrator Edit of other files still nudges", () => {
  withRoot((root) => {
    const fwd = root.replace(/[\\]/g, "/");
    assert.equal(nudged(root, "Edit", join(root, "src", "x.js")), true);
    assert.equal(nudged(root, "Edit", `${fwd}/src/x.js`), true);
    assert.equal(nudged(root, "Edit", "src\\x.js"), true);
    assert.equal(nudged(root, "Write", ".claude/tycoon/other.json"), true);
    assert.equal(nudged(root, "Write", ".claude/session-journal.json.old"), true);
    assert.equal(nudged(root, "Write", "sub/.claude/session-journal.json"), true);
  });
});

test("isOrchestratorBookkeepingPath folds case on win32 only and decideDirectToolCall mirrors the exemption", () => {
  assert.equal(isOrchestratorBookkeepingPath("D:\\P\\.CLAUDE\\Session-Journal.json", "d:/p", "win32"), true);
  assert.equal(isOrchestratorBookkeepingPath("/p/.CLAUDE/session-journal.json", "/p", "linux"), false);
  assert.equal(isOrchestratorBookkeepingPath("/p/.claude/tycoon/../session-journal.json", "/p", "linux"), true);
  const ctx = { filePath: ".claude/session-journal.json", projectRoot: "/p" };
  assert.equal(decideDirectToolCall("Edit", 0, "coding-specialist", ctx).action, "allow");
  assert.equal(decideDirectToolCall("Edit", 0, "coding-specialist", { filePath: "src/x.js", projectRoot: "/p" }).action, "nudge");
  assert.equal(decideDirectToolCall("Edit", 0).action, "nudge");
});

test("relative paths that escape the project root via .. are not exempt", () => {
  withRoot((root) => {
    const win = "..\\..\\.claude\\session-journal.json";
    const posix = "../../.claude/tycoon/plan.json";
    assert.equal(nudged(root, "Edit", win), true);
    assert.equal(nudged(root, "Write", posix), true);
    assert.equal(decideDirectToolCall("Edit", 0, "coding-specialist", { filePath: win, projectRoot: "/p/q" }).action, "nudge");
    assert.equal(decideDirectToolCall("Write", 0, "coding-specialist", { filePath: posix, projectRoot: "/p/q" }).action, "nudge");
    assert.equal(decideDirectToolCall("Write", 0, "coding-specialist", { filePath: posix, projectRoot: "C:/p/q" }).action, "nudge");
  });
});
