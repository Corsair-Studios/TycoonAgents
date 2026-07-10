/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  mergeTycoonHooks,
  TYCOON_HOOK_SLOTS,
  cleanupForeignHookArtifacts,
  findLegacyHookCommands,
  LEGACY_HOOK_BASENAMES,
  LEGACY_STATE_FILE_NAMES,
} from "../src/host/vscode/hookInstall";

const cmd = "node /path/tycoon-claude-hook.cjs";

test("empty settings produces all 7 hook slots", () => {
  const result = mergeTycoonHooks({}, cmd);
  const hooks = result.hooks as Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;

  // UserPromptSubmit
  assert.ok(Array.isArray(hooks["UserPromptSubmit"]), "UserPromptSubmit should be an array");
  const ups = hooks["UserPromptSubmit"].find((e) => e.matcher === "");
  assert.ok(ups, "UserPromptSubmit entry with empty matcher must exist");
  assert.ok(ups!.hooks[0].command.includes("tycoon-claude-hook.cjs"));

  // PreToolUse - 3 matchers
  assert.ok(Array.isArray(hooks["PreToolUse"]), "PreToolUse should be an array");
  const ptu1 = hooks["PreToolUse"].find((e) => e.matcher === "Task|Agent|Skill");
  assert.ok(ptu1, "PreToolUse Task|Agent|Skill entry must exist");
  assert.ok(ptu1!.hooks[0].command.includes("tycoon-claude-hook.cjs"));

  const ptu2 = hooks["PreToolUse"].find((e) => e.matcher === "Read|Write|Edit|Grep|Glob|Bash");
  assert.ok(ptu2, "PreToolUse Read|Write|Edit|Grep|Glob|Bash entry must exist");
  assert.ok(ptu2!.hooks[0].command.includes("tycoon-claude-hook.cjs"));

  const ptu3 = hooks["PreToolUse"].find((e) => e.matcher === "mcp__");
  assert.ok(ptu3, "PreToolUse mcp__ entry must exist");
  assert.ok(ptu3!.hooks[0].command.includes("tycoon-claude-hook.cjs"));

  // SubagentStop
  const sas = hooks["SubagentStop"]?.find((e) => e.matcher === "");
  assert.ok(sas, "SubagentStop entry must exist");
  assert.ok(sas!.hooks[0].command.includes("tycoon-claude-hook.cjs"));

  // Stop
  const stop = hooks["Stop"]?.find((e) => e.matcher === "");
  assert.ok(stop, "Stop entry must exist");
  assert.ok(stop!.hooks[0].command.includes("tycoon-claude-hook.cjs"));

  // TaskCompleted
  const tc = hooks["TaskCompleted"]?.find((e) => e.matcher === "");
  assert.ok(tc, "TaskCompleted entry must exist");
  assert.ok(tc!.hooks[0].command.includes("tycoon-claude-hook.cjs"));
});

test("idempotency: running twice produces no duplicates", () => {
  const once = mergeTycoonHooks({}, cmd);
  const twice = mergeTycoonHooks(once, cmd);
  const hooks = twice.hooks as Record<string, unknown[]>;

  // PreToolUse should still have exactly 3 entries
  assert.equal(hooks["PreToolUse"].length, 3, "PreToolUse must have exactly 3 entries after two merges");
  // All other multi-matcher-free events should still have exactly 1 entry
  assert.equal(hooks["UserPromptSubmit"].length, 1);
  assert.equal(hooks["SubagentStop"].length, 1);
  assert.equal(hooks["Stop"].length, 1);
  assert.equal(hooks["TaskCompleted"].length, 1);
});

test("preserves unrelated hooks in PreToolUse", () => {
  const input: Record<string, unknown> = {
    hooks: {
      PreToolUse: [
        { matcher: "SomeOther", hooks: [{ type: "command", command: "other.js" }] },
      ],
    },
  };
  const result = mergeTycoonHooks(input, cmd);
  const ptu = (result.hooks as Record<string, Array<{ matcher: string }>>)["PreToolUse"];
  const hasOther = ptu.some((e) => e.matcher === "SomeOther");
  assert.ok(hasOther, "Unrelated SomeOther matcher must be preserved");
  const hasTas = ptu.some((e) => e.matcher === "Task|Agent|Skill");
  assert.ok(hasTas, "Task|Agent|Skill matcher must be added");
  // Total: 1 existing + 3 tycoon = 4
  assert.equal(ptu.length, 4, "PreToolUse should have 4 entries (1 existing + 3 tycoon)");
});

test("does not mutate input object", () => {
  const input: Record<string, unknown> = {};
  const clonedBefore = structuredClone(input);
  mergeTycoonHooks(input, cmd);
  assert.deepEqual(input, clonedBefore, "input must not be mutated");
});

test("does not mutate input.hooks reference when hooks exist", () => {
  const existingHooks = {
    PreToolUse: [{ matcher: "SomeOther", hooks: [{ type: "command", command: "other.js" }] }],
  };
  const input: Record<string, unknown> = { hooks: existingHooks };
  const originalHooksRef = input.hooks;
  mergeTycoonHooks(input, cmd);
  assert.equal(input.hooks, originalHooksRef, "input.hooks reference must not be replaced");
  assert.equal((input.hooks as typeof existingHooks).PreToolUse.length, 1, "original PreToolUse array must not be extended");
});

// ---------------------------------------------------------------------------
// findLegacyHookCommands
// ---------------------------------------------------------------------------

const LEGACY_CMD = `node "/old/project/.claude/hooks/${LEGACY_HOOK_BASENAMES[0]}"`;

test("findLegacyHookCommands: null/empty settings -> []", () => {
  assert.deepEqual(findLegacyHookCommands(null), []);
  assert.deepEqual(findLegacyHookCommands({}), []);
});

test("findLegacyHookCommands: legacy basename in a Tycoon event -> returned", () => {
  const settings = {
    hooks: { UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: LEGACY_CMD }] }] },
  };
  assert.deepEqual(findLegacyHookCommands(settings), [LEGACY_CMD]);
});

test("findLegacyHookCommands: our own command is never flagged as legacy", () => {
  const settings = mergeTycoonHooks({}, cmd);
  assert.deepEqual(findLegacyHookCommands(settings), []);
});

test("findLegacyHookCommands: legacy basename in a non-Tycoon event -> not returned", () => {
  const settings = {
    hooks: { SomeOtherEvent: [{ matcher: "", hooks: [{ type: "command", command: LEGACY_CMD }] }] },
  };
  assert.deepEqual(findLegacyHookCommands(settings), []);
});

// ---------------------------------------------------------------------------
// cleanupForeignHookArtifacts
// ---------------------------------------------------------------------------

function makeTmpClaudeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hookInstall-cleanup-"));
}

test("cleanupForeignHookArtifacts: clean project (empty dir) -> no-op, no throw", () => {
  const dir = makeTmpClaudeDir();
  try {
    const result = cleanupForeignHookArtifacts(dir);
    assert.deepEqual(result.strippedForeignHookCommands, []);
    assert.equal(result.clearedStaleLock, false);
    assert.equal(result.resetStack, false);
    assert.deepEqual(result.deletedLeftoverFiles, []);
    assert.deepEqual(result.changes, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupForeignHookArtifacts: strips legacy hook entries, keeps ours + unrelated hooks", () => {
  const dir = makeTmpClaudeDir();
  try {
    const settings = mergeTycoonHooks({}, cmd) as any;
    // Legacy command sharing the UserPromptSubmit slot with ours.
    settings.hooks.UserPromptSubmit.push({
      matcher: "",
      hooks: [{ type: "command", command: LEGACY_CMD }],
    });
    // Unrelated non-agent hook in a Tycoon event slot must survive.
    settings.hooks.Stop.push({
      matcher: "",
      hooks: [{ type: "command", command: "node unrelated-formatter.js" }],
    });
    fs.writeFileSync(path.join(dir, "settings.local.json"), JSON.stringify(settings, null, 2));

    const result = cleanupForeignHookArtifacts(dir);
    assert.deepEqual(result.strippedForeignHookCommands, [LEGACY_CMD]);

    const after = JSON.parse(fs.readFileSync(path.join(dir, "settings.local.json"), "utf8"));
    const allCmds = Object.values(after.hooks as Record<string, any[]>)
      .flat()
      .flatMap((e: any) => e.hooks.map((h: any) => h.command));
    assert.ok(!allCmds.includes(LEGACY_CMD), "legacy command must be removed");
    assert.ok(allCmds.includes(cmd), "our command must remain");
    assert.ok(allCmds.includes("node unrelated-formatter.js"), "unrelated hook must be preserved");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupForeignHookArtifacts: deletes known leftover legacy state files + agent-activity-*.json", () => {
  const dir = makeTmpClaudeDir();
  try {
    for (const name of LEGACY_STATE_FILE_NAMES) {
      fs.writeFileSync(path.join(dir, name), "{}");
    }
    fs.writeFileSync(path.join(dir, "agent-activity-2026-01-01.json"), "{}");
    fs.writeFileSync(path.join(dir, "unrelated-user-file.json"), "{}");

    const result = cleanupForeignHookArtifacts(dir);

    for (const name of LEGACY_STATE_FILE_NAMES) {
      assert.ok(!fs.existsSync(path.join(dir, name)), `${name} must be deleted`);
      assert.ok(result.deletedLeftoverFiles.includes(name));
    }
    assert.ok(!fs.existsSync(path.join(dir, "agent-activity-2026-01-01.json")), "agent-activity-*.json must be deleted");
    assert.ok(fs.existsSync(path.join(dir, "unrelated-user-file.json")), "unrelated file must NOT be deleted");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupForeignHookArtifacts: clears a stale lock and resets a stuck stack", () => {
  const dir = makeTmpClaudeDir();
  const tycoonDir = path.join(dir, "tycoon");
  fs.mkdirSync(tycoonDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(tycoonDir, "active-agent.json.lock"), "12345");
    fs.writeFileSync(
      path.join(tycoonDir, "active-agent.json"),
      JSON.stringify({ version: 1, agentId: "coding-specialist", timestamp: Date.now() - 999999, stack: [{ agentId: "coding-specialist" }] })
    );

    const result = cleanupForeignHookArtifacts(dir);
    assert.equal(result.clearedStaleLock, true);
    assert.equal(result.resetStack, true);
    assert.ok(!fs.existsSync(path.join(tycoonDir, "active-agent.json.lock")), "lock must be deleted");

    const after = JSON.parse(fs.readFileSync(path.join(tycoonDir, "active-agent.json"), "utf8"));
    assert.equal(after.agentId, "none");
    assert.deepEqual(after.stack, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupForeignHookArtifacts: an already-clean active-agent.json (no lock, empty stack) is left alone", () => {
  const dir = makeTmpClaudeDir();
  const tycoonDir = path.join(dir, "tycoon");
  fs.mkdirSync(tycoonDir, { recursive: true });
  try {
    const cleanState = { version: 1, agentId: "none", timestamp: 123, stack: [] };
    fs.writeFileSync(path.join(tycoonDir, "active-agent.json"), JSON.stringify(cleanState));

    const result = cleanupForeignHookArtifacts(dir);
    assert.equal(result.resetStack, false, "an already-empty stack must not be reported as reset");

    const after = JSON.parse(fs.readFileSync(path.join(tycoonDir, "active-agent.json"), "utf8"));
    assert.deepEqual(after, cleanState, "already-clean file must be untouched");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupForeignHookArtifacts: idempotent — second run on already-cleaned project is a no-op", () => {
  const dir = makeTmpClaudeDir();
  try {
    const settings = mergeTycoonHooks({}, cmd) as any;
    settings.hooks.UserPromptSubmit.push({
      matcher: "",
      hooks: [{ type: "command", command: LEGACY_CMD }],
    });
    fs.writeFileSync(path.join(dir, "settings.local.json"), JSON.stringify(settings, null, 2));
    for (const name of LEGACY_STATE_FILE_NAMES) {
      fs.writeFileSync(path.join(dir, name), "{}");
    }

    cleanupForeignHookArtifacts(dir);
    const second = cleanupForeignHookArtifacts(dir);

    assert.deepEqual(second.strippedForeignHookCommands, []);
    assert.deepEqual(second.deletedLeftoverFiles, []);
    assert.equal(second.clearedStaleLock, false);
    assert.equal(second.resetStack, false);
    assert.deepEqual(second.changes, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
