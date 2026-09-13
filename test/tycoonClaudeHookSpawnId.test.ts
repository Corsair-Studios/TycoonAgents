/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Targeted coverage for the popMatchedAgent same-subagent_type disambiguation
// fix (hooks/tycoon-claude-hook.cjs, popMatchedAgent's Priority 1 branch):
// two concurrent same-subagent_type spawns, NEITHER of which has lazily
// bound an instanceId yet (no non-spawn tool call made from inside either
// one), must still be told apart by SubagentStop so each stop pops its OWN
// spawnId — not whichever entry the previous LIFO scan happened to land on.
// The fix prefers an unbound candidate and breaks ties FIFO (oldest spawn
// first), matching the natural stop order in this test: first spawned,
// first stopped.

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
  tool?: string;
  spawnId?: string;
  description?: string;
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

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), "tycoon-hook-spawnid-test-"));
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  return root;
}

test("two concurrent same-subagent_type spawns, neither with a bound instanceId: the FIRST spawn's SubagentStop pops spawn A's spawnId, then the SECOND's SubagentStop pops spawn B's — never swapped", () => {
  const root = setupProject();
  try {
    // Spawn A: general-purpose, "task A". No agent_id (orchestrator-issued).
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "general-purpose", description: "task A", prompt: "do task A" },
      session_id: "s1",
    });

    // Spawn B: same subagent_type, pushed on top while A is still live.
    // Neither A nor B has made a non-spawn tool call, so NEITHER has a bound
    // instanceId — the exact ambiguous case this fix disambiguates.
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "general-purpose", description: "task B", prompt: "do task B" },
      session_id: "s1",
    });

    const spawnRecords = readActivity(root).filter(
      (r) => r.event === "PreToolUse" && r.tool === "Task",
    );
    assert.equal(spawnRecords.length, 2);
    const spawnIdA = spawnRecords[0].spawnId;
    const spawnIdB = spawnRecords[1].spawnId;
    assert.ok(typeof spawnIdA === "string" && spawnIdA.length > 0);
    assert.ok(typeof spawnIdB === "string" && spawnIdB.length > 0);
    assert.notEqual(spawnIdA, spawnIdB);

    // A stops FIRST — no agent_id (never bound one). Priority 1 must prefer
    // the oldest unbound same-type candidate (A), not LIFO stack-top (B).
    runHook(root, {
      hook_event_name: "SubagentStop",
      tool_input: { subagent_type: "general-purpose" },
      session_id: "s1",
    });

    // B stops SECOND — same shape, only B's entry remains on the stack.
    runHook(root, {
      hook_event_name: "SubagentStop",
      tool_input: { subagent_type: "general-purpose" },
      session_id: "s1",
    });

    const stopRecords = readActivity(root).filter((r) => r.event === "SubagentStop");
    assert.equal(stopRecords.length, 2);
    assert.equal(
      stopRecords[0].spawnId,
      spawnIdA,
      `first SubagentStop should carry spawn A's spawnId (${spawnIdA}), got ${stopRecords[0].spawnId}`,
    );
    assert.equal(
      stopRecords[1].spawnId,
      spawnIdB,
      `second SubagentStop should carry spawn B's spawnId (${spawnIdB}), got ${stopRecords[1].spawnId}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
