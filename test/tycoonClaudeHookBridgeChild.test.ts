/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// A dispatcher-launched claude -p child sets TYCOON_BRIDGE_CHILD=1; the hook
// must exit 0 with no output and no writes (the dispatcher records the worker).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(process.cwd(), "hooks", "tycoon-claude-hook.cjs");
const PAYLOAD = JSON.stringify({ hook_event_name: "Stop", session_id: "bridge-child-test" });

test("hook: TYCOON_BRIDGE_CHILD=1 exits 0 silently and writes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "tycoon-bridge-child-"));
  try {
    const r = spawnSync(process.execPath, [HOOK], {
      input: PAYLOAD,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, TYCOON_BRIDGE_CHILD: "1" },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(existsSync(join(root, ".claude")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook: without TYCOON_BRIDGE_CHILD the same payload still records", () => {
  const root = mkdtempSync(join(tmpdir(), "tycoon-bridge-child-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root };
    delete env.TYCOON_BRIDGE_CHILD;
    const r = spawnSync(process.execPath, [HOOK], { input: PAYLOAD, encoding: "utf8", env });
    assert.equal(r.status, 0);
    assert.equal(existsSync(join(root, ".claude", "tycoon", "activity.jsonl")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
