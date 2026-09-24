/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Regression coverage for the "hook-cwd-relative-command" incident: an
// MPGames session cd'd into a subfolder mid-session, the installed hook
// command was `node .claude/tycoon/tycoon-claude-hook.cjs` (project-relative),
// and once cwd left the project root `node` could no longer resolve that
// relative script path — the hook silently stopped firing and
// activity.jsonl stopped growing for the rest of the session.
//
// The COMMAND-generation half of the fix (buildAbsoluteHookCommand) is
// covered in test/hookInstall.test.ts. This file covers the SCRIPT's own
// resilience once it does get invoked from a subfolder cwd: it must still
// resolve and write to the PROJECT ROOT's .claude/tycoon/activity.jsonl,
// not somewhere relative to cwd, in both of the following cases:
//   (a) CLAUDE_PROJECT_DIR is set (Claude Code's normal behavior) — the
//       script must honor it regardless of cwd.
//   (b) CLAUDE_PROJECT_DIR is unset — the script's findProjectRootFallback
//       must walk up from its own script location (not cwd) to find the
//       `.claude/tycoon` marker.
// Spawning is done directly with `cwd` set to a subdirectory, so this
// exercises real process cwd, not just an env var.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE_HOOK_PATH = join(process.cwd(), "hooks", "tycoon-claude-hook.cjs");

function activityPath(projectRoot: string): string {
  return join(projectRoot, ".claude", "tycoon", "activity.jsonl");
}

function readActivityCount(projectRoot: string): number {
  const p = activityPath(projectRoot);
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean).length;
}

const PAYLOAD = JSON.stringify({
  hook_event_name: "Stop",
  session_id: "cwd-independence-test",
});

test("hook script (CLAUDE_PROJECT_DIR set): still writes to the project root's activity.jsonl when spawned with cwd = a subfolder", () => {
  const root = mkdtempSync(join(tmpdir(), "tycoon-cwd-test-"));
  try {
    const subDir = join(root, "design-docs", "roguelike");
    mkdirSync(subDir, { recursive: true });

    const before = readActivityCount(root);
    const result = spawnSync(process.execPath, [SOURCE_HOOK_PATH], {
      input: PAYLOAD,
      encoding: "utf8",
      cwd: subDir, // simulates the session's cwd having left the project root
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);
    const after = readActivityCount(root);
    assert.ok(after > before, "activity.jsonl at the PROJECT ROOT must gain a record even though cwd was a subfolder");
    assert.equal(readActivityCount(subDir), 0, "no activity.jsonl should be written under the subfolder cwd");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook script (CLAUDE_PROJECT_DIR unset): findProjectRootFallback walks up from the SCRIPT's own location, not cwd, and still logs to the root", () => {
  // Build an isolated fake project: <root>/.claude/tycoon/tycoon-claude-hook.cjs
  // (mirrors the real install layout) plus a deep cwd subfolder with no
  // .claude marker of its own, so a cwd-based walk-up would find nothing.
  const root = mkdtempSync(join(tmpdir(), "tycoon-cwd-fallback-test-"));
  try {
    const installedTycoonDir = join(root, ".claude", "tycoon");
    mkdirSync(installedTycoonDir, { recursive: true });
    const installedHookPath = join(installedTycoonDir, "tycoon-claude-hook.cjs");
    cpSync(SOURCE_HOOK_PATH, installedHookPath);

    const subDir = join(root, "docs", "games", "deep", "nested");
    mkdirSync(subDir, { recursive: true });

    const before = readActivityCount(root);
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    const result = spawnSync(process.execPath, [installedHookPath], {
      input: PAYLOAD,
      encoding: "utf8",
      cwd: subDir,
      env,
    });
    assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);
    const after = readActivityCount(root);
    assert.ok(
      after > before,
      "with CLAUDE_PROJECT_DIR unset, the script must still find the project root by walking up from its own " +
        "install location (.claude/tycoon marker) and log there, not fail or log relative to cwd"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
