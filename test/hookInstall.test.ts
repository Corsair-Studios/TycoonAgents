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
import { spawnSync } from "node:child_process";
import {
  mergeTycoonHooks,
  migrateLegacyHookMatchers,
  TYCOON_HOOK_SLOTS,
  cleanupForeignHookArtifacts,
  findLegacyHookCommands,
  LEGACY_HOOK_BASENAMES,
  LEGACY_STATE_FILE_NAMES,
  mergeManagedSubagentDepthEnv,
  syncRuntimeFile,
  RUNTIME_HOOK_FILES,
  MCP_BRIDGE_HOOK_FILES,
  rewriteMcpJsonBridgePaths,
  copyMcpBridgeHooks,
  healInstalledHookCopies,
  buildAbsoluteHookCommand,
  resolveHookInterpreter,
  migrateRelativeHookCommand,
} from "../src/host/vscode/hookInstall";

const cmd = "node /path/tycoon-claude-hook.cjs";

test("empty settings produces all 10 hook slots", () => {
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

  const ptu3 = hooks["PreToolUse"].find((e) => e.matcher === "mcp__.*");
  assert.ok(ptu3, "PreToolUse mcp__.* entry must exist");
  assert.ok(ptu3!.hooks[0].command.includes("tycoon-claude-hook.cjs"));

  // PostToolUse - mcp__.* (fallback detection) and Task|Agent (gate events)
  assert.ok(Array.isArray(hooks["PostToolUse"]), "PostToolUse should be an array");
  const ptu4 = hooks["PostToolUse"].find((e) => e.matcher === "mcp__.*");
  assert.ok(ptu4, "PostToolUse mcp__.* entry must exist");
  assert.ok(ptu4!.hooks[0].command.includes("tycoon-claude-hook.cjs"));

  const ptu5 = hooks["PostToolUse"].find((e) => e.matcher === "Task|Agent");
  assert.ok(ptu5, "PostToolUse Task|Agent entry must exist");
  assert.ok(ptu5!.hooks[0].command.includes("tycoon-claude-hook.cjs"));

  // p99-t1: PostToolUseFailure mcp__.* (isError:true bridge results)
  const ptf = hooks["PostToolUseFailure"]?.find((e) => e.matcher === "mcp__.*");
  assert.ok(ptf, "PostToolUseFailure mcp__.* entry must exist");
  assert.ok(ptf!.hooks[0].command.includes("tycoon-claude-hook.cjs"));

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

  // TeammateIdle
  const ti = hooks["TeammateIdle"]?.find((e) => e.matcher === "");
  assert.ok(ti, "TeammateIdle entry must exist");
  assert.ok(ti!.hooks[0].command.includes("tycoon-claude-hook.cjs"));

  // TaskCreated
  const tcr = hooks["TaskCreated"]?.find((e) => e.matcher === "");
  assert.ok(tcr, "TaskCreated entry must exist");
  assert.ok(tcr!.hooks[0].command.includes("tycoon-claude-hook.cjs"));
});

test("idempotency: running twice produces no duplicates", () => {
  const once = mergeTycoonHooks({}, cmd);
  const twice = mergeTycoonHooks(once, cmd);
  const hooks = twice.hooks as Record<string, unknown[]>;

  // PreToolUse should still have exactly 3 entries
  assert.equal(hooks["PreToolUse"].length, 3, "PreToolUse must have exactly 3 entries after two merges");
  // PostToolUse should still have exactly 2 entries (mcp__.* and Task|Agent)
  assert.equal(hooks["PostToolUse"].length, 2, "PostToolUse must have exactly 2 entries after two merges");
  // All other multi-matcher-free events should still have exactly 1 entry
  assert.equal(hooks["UserPromptSubmit"].length, 1);
  assert.equal(hooks["SubagentStop"].length, 1);
  assert.equal(hooks["Stop"].length, 1);
  assert.equal(hooks["TaskCompleted"].length, 1);
  assert.equal(hooks["TeammateIdle"].length, 1);
  assert.equal(hooks["TaskCreated"].length, 1);
});

test("mergeTycoonHooks: PostToolUse Task|Agent slot is added to an existing settings object and not duplicated on a second merge", () => {
  const existing: Record<string, unknown> = {
    hooks: {
      PostToolUse: [
        { matcher: "mcp__.*", hooks: [{ type: "command", command: cmd }] },
        { matcher: "SomeForeignTool", hooks: [{ type: "command", command: "node /other/hook.js" }] },
      ],
    },
  };

  const once = mergeTycoonHooks(existing, cmd);
  const hooksOnce = once.hooks as Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
  const taskAgentOnce = hooksOnce["PostToolUse"].filter((e) => e.matcher === "Task|Agent");
  assert.equal(taskAgentOnce.length, 1, "Task|Agent slot must be added exactly once");
  assert.ok(taskAgentOnce[0].hooks[0].command.includes("tycoon-claude-hook.cjs"));
  // Pre-existing entries are preserved.
  assert.ok(hooksOnce["PostToolUse"].some((e) => e.matcher === "mcp__.*"));
  assert.ok(hooksOnce["PostToolUse"].some((e) => e.matcher === "SomeForeignTool"));
  assert.equal(hooksOnce["PostToolUse"].length, 3);

  const twice = mergeTycoonHooks(once, cmd);
  const hooksTwice = twice.hooks as Record<string, Array<{ matcher: string }>>;
  const taskAgentTwice = hooksTwice["PostToolUse"].filter((e) => e.matcher === "Task|Agent");
  assert.equal(taskAgentTwice.length, 1, "re-merge must not duplicate the Task|Agent slot");
  assert.equal(hooksTwice["PostToolUse"].length, 3, "re-merge must not change the entry count");
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
// mergeTycoonHooks: foreign-hook-shares-our-matcher idempotency bug
// (the entry `list.find` masking bug — a third-party hook sharing our
// matcher string, sitting BEFORE our own entry, used to hide our entry from
// the old first-match-only check and cause a duplicate to be appended).
// ---------------------------------------------------------------------------

test("foreign hook sharing our empty matcher, ordered before ours, on Stop: no duplicate on merge, none added on re-merge", () => {
  const input: Record<string, unknown> = {
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "node foreign-formatter.js" }] }],
    },
  };
  const once = mergeTycoonHooks(input, cmd);
  const stopOnce = (once.hooks as Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>)["Stop"];
  const oursOnce = stopOnce.filter((e) => e.hooks.some((h) => h.command.includes("tycoon-claude-hook.cjs")));
  assert.equal(oursOnce.length, 1, "our hook must be added exactly once");
  assert.ok(stopOnce.some((e) => e.hooks[0].command === "node foreign-formatter.js"), "foreign hook must be untouched");

  const twice = mergeTycoonHooks(once, cmd);
  const stopTwice = (twice.hooks as Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>)["Stop"];
  const oursTwice = stopTwice.filter((e) => e.hooks.some((h) => h.command.includes("tycoon-claude-hook.cjs")));
  assert.equal(oursTwice.length, 1, "re-merge must not add another tycoon entry");
  assert.equal(stopTwice.length, 2, "total entry count must stay stable across re-merge");
});

test("foreign hook sharing our PreToolUse Task|Agent|Skill matcher, ordered before ours: no duplicate on merge, none added on re-merge", () => {
  const matcher = "Task|Agent|Skill";
  const input: Record<string, unknown> = {
    hooks: {
      PreToolUse: [{ matcher, hooks: [{ type: "command", command: "node foreign-task-logger.js" }] }],
    },
  };
  const once = mergeTycoonHooks(input, cmd);
  const ptuOnce = (once.hooks as Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>)["PreToolUse"];
  const matchingOnce = ptuOnce.filter((e) => e.matcher === matcher);
  const oursOnce = matchingOnce.filter((e) => e.hooks.some((h) => h.command.includes("tycoon-claude-hook.cjs")));
  assert.equal(oursOnce.length, 1, "our hook must be added exactly once");
  assert.ok(matchingOnce.some((e) => e.hooks[0].command === "node foreign-task-logger.js"), "foreign hook must be untouched");

  const twice = mergeTycoonHooks(once, cmd);
  const ptuTwice = (twice.hooks as Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>)["PreToolUse"];
  const matchingTwice = ptuTwice.filter((e) => e.matcher === matcher);
  const oursTwice = matchingTwice.filter((e) => e.hooks.some((h) => h.command.includes("tycoon-claude-hook.cjs")));
  assert.equal(oursTwice.length, 1, "re-merge must not add another tycoon entry");
  assert.equal(matchingTwice.length, 2, "total matching-matcher entry count must stay stable across re-merge");
});

// ---------------------------------------------------------------------------
// mergeTycoonHooks: secondary self-heal — collapse pre-existing duplicate
// tycoon entries (leftovers from the old bug) down to exactly one.
// ---------------------------------------------------------------------------

test("collapses 3 pre-existing duplicate tycoon entries on one slot down to 1, preserving an unrelated hook on the same event", () => {
  const input: Record<string, unknown> = {
    hooks: {
      Stop: [
        { matcher: "", hooks: [{ type: "command", command: cmd }] },
        { matcher: "", hooks: [{ type: "command", command: "node unrelated-other.js" }] },
        { matcher: "", hooks: [{ type: "command", command: cmd }] },
        { matcher: "", hooks: [{ type: "command", command: cmd }] },
      ],
    },
  };
  const result = mergeTycoonHooks(input, cmd);
  const stop = (result.hooks as Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>)["Stop"];
  const ours = stop.filter((e) => e.hooks.every((h) => h.command.includes("tycoon-claude-hook.cjs")));
  assert.equal(ours.length, 1, "duplicate tycoon entries must collapse to exactly 1");
  assert.ok(
    stop.some((e) => e.hooks.some((h) => h.command === "node unrelated-other.js")),
    "unrelated hook entry must be preserved"
  );
  assert.equal(stop.length, 2, "total entries: 1 collapsed tycoon + 1 unrelated");
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

// ---------------------------------------------------------------------------
// Legacy "mcp__" -> "mcp__.*" matcher migration
// (mergeTycoonHooks in-place rename + migrateLegacyHookMatchers narrow heal)
// ---------------------------------------------------------------------------

test("mergeTycoonHooks: pre-existing bare mcp__ entry (ours) is renamed to mcp__.*, not duplicated", () => {
  const input: Record<string, unknown> = {
    hooks: {
      PreToolUse: [{ matcher: "mcp__", hooks: [{ type: "command", command: cmd }] }],
    },
  };
  const result = mergeTycoonHooks(input, cmd);
  const ptu = (result.hooks as Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>)["PreToolUse"];
  assert.equal(ptu.filter((e) => e.matcher === "mcp__").length, 0, "old bare mcp__ matcher must be gone");
  const news = ptu.filter((e) => e.matcher === "mcp__.*");
  assert.equal(news.length, 1, "exactly one mcp__.* entry must exist");
  assert.equal(news[0].hooks.length, 1, "renamed entry must not gain extra hooks");
});

test("mergeTycoonHooks: user-customized bare mcp__ entry (different command) is left alone, mcp__.* added separately", () => {
  const input: Record<string, unknown> = {
    hooks: {
      PreToolUse: [{ matcher: "mcp__", hooks: [{ type: "command", command: "node user-custom-mcp-logger.js" }] }],
    },
  };
  const result = mergeTycoonHooks(input, cmd);
  const ptu = (result.hooks as Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>)["PreToolUse"];
  const oldEntry = ptu.find((e) => e.matcher === "mcp__");
  assert.ok(oldEntry, "user's custom mcp__ entry must be preserved untouched");
  assert.equal(oldEntry!.hooks[0].command, "node user-custom-mcp-logger.js");
  const newEntry = ptu.find((e) => e.matcher === "mcp__.*");
  assert.ok(newEntry, "our mcp__.* entry must still be added");
  assert.ok(newEntry!.hooks.some((h) => h.command === cmd));
});

test("mergeTycoonHooks: already-migrated mcp__.* entry is untouched and idempotent on re-merge", () => {
  const once = mergeTycoonHooks({}, cmd);
  const twice = mergeTycoonHooks(once, cmd);
  const ptu = (twice.hooks as Record<string, Array<{ matcher: string }>>)["PreToolUse"];
  assert.equal(ptu.filter((e) => e.matcher === "mcp__.*").length, 1);
  assert.equal(ptu.filter((e) => e.matcher === "mcp__").length, 0);
});

test("migrateLegacyHookMatchers: old bare mcp__ (ours) -> mcp__.*, changed:true", () => {
  const input: Record<string, unknown> = {
    hooks: {
      PreToolUse: [
        { matcher: "mcp__", hooks: [{ type: "command", command: cmd }] },
        { matcher: "Task|Agent|Skill", hooks: [{ type: "command", command: cmd }] },
      ],
    },
  };
  const { settings, changed } = migrateLegacyHookMatchers(input);
  assert.equal(changed, true);
  const ptu = (settings.hooks as Record<string, unknown>)["PreToolUse"] as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
  assert.equal(ptu.find((e) => e.matcher === "mcp__"), undefined, "bare mcp__ must be gone");
  const upgraded = ptu.find((e) => e.matcher === "mcp__.*");
  assert.ok(upgraded, "mcp__.* must exist after migration");
  assert.equal(upgraded!.hooks[0].command, cmd);
  // Unrelated entry untouched.
  assert.ok(ptu.some((e) => e.matcher === "Task|Agent|Skill"));
});

test("migrateLegacyHookMatchers: user-customized mcp__ entry (different command) is left untouched", () => {
  const input: Record<string, unknown> = {
    hooks: {
      PreToolUse: [{ matcher: "mcp__", hooks: [{ type: "command", command: "node user-custom-mcp-logger.js" }] }],
    },
  };
  const { settings, changed } = migrateLegacyHookMatchers(input);
  assert.equal(changed, false, "a non-ours entry must never be migrated");
  assert.equal(settings, input, "no-op must return the SAME object reference");
});

test("migrateLegacyHookMatchers: already-current mcp__.* settings -> no-op, same object reference", () => {
  const already = mergeTycoonHooks({}, cmd);
  const { settings, changed } = migrateLegacyHookMatchers(already);
  assert.equal(changed, false);
  assert.equal(settings, already, "no-op must return the SAME object reference");
});

test("migrateLegacyHookMatchers: settings with no hooks section -> no-op, no throw", () => {
  const { settings, changed } = migrateLegacyHookMatchers({});
  assert.equal(changed, false);
  assert.deepEqual(settings, {});
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

// ---------------------------------------------------------------------------
// cleanupForeignHookArtifacts: CleanupForeignHookArtifactsOptions.removeForeignCommands
//
// Independent verification of the fix for a CRITICAL review finding: the
// Hook Doctor UI now shows a "Remove other harnesses' hooks" checkbox that
// must be a REAL gate on whether settings.json/settings.local.json get
// mutated at all — not merely a gate on the reported result. Before the fix,
// legacy-basename hook commands were always stripped regardless of the
// checkbox, i.e. the checkbox was inert/lying to the user about a
// destructive action.
// ---------------------------------------------------------------------------

const LEGACY_CMD_A = `node "/old/project/.claude/hooks/${LEGACY_HOOK_BASENAMES[0]}"`; // task-start.cjs
const LEGACY_CMD_B = `node "/old/project/.claude/hooks/teammate-idle.cjs"`; // present in LEGACY_HOOK_BASENAMES

/**
 * Builds a fixture `.claude/` dir containing settings.local.json with a mix
 * of (a) legacy-basename hook commands, (b) our own tycoon-claude-hook.cjs
 * command, and (c) orphaned agent-activity-<ts>-<pid>.json spool files.
 * Returns the dir path and the exact settings.local.json content written, so
 * callers can assert byte-identical no-write behavior.
 */
function makeMixedFixture(): { dir: string; settingsPath: string; settingsContent: string } {
  const dir = makeTmpClaudeDir();
  const settings = mergeTycoonHooks({}, cmd) as any;
  settings.hooks.UserPromptSubmit.push({
    matcher: "",
    hooks: [{ type: "command", command: LEGACY_CMD_A }],
  });
  settings.hooks.Stop.push({
    matcher: "",
    hooks: [{ type: "command", command: LEGACY_CMD_B }],
  });
  const settingsContent = JSON.stringify(settings, null, 2);
  const settingsPath = path.join(dir, "settings.local.json");
  fs.writeFileSync(settingsPath, settingsContent);

  // Orphaned agent-activity-<ts>-<pid>.json artifact files.
  fs.writeFileSync(path.join(dir, "agent-activity-1738000000000-4321.json"), "{}");
  fs.writeFileSync(path.join(dir, "agent-activity-1738000005555-9876.json"), "{}");

  return { dir, settingsPath, settingsContent };
}

test("cleanupForeignHookArtifacts: removeForeignCommands:false skips settings entirely — legacy AND our own commands remain, file is untouched, orphan files still deleted", () => {
  const { dir, settingsPath, settingsContent } = makeMixedFixture();
  try {
    const statBefore = fs.statSync(settingsPath);

    const result = cleanupForeignHookArtifacts(dir, { removeForeignCommands: false });

    // THE assertion that would have caught the shipped defect: with the gate
    // off, no settings read/write happens, so nothing is reported stripped.
    assert.deepEqual(result.strippedForeignHookCommands, [], "no commands may be reported stripped when removeForeignCommands:false");

    const afterContent = fs.readFileSync(settingsPath, "utf8");
    assert.equal(afterContent, settingsContent, "settings.local.json content must be byte-identical — no write may occur");

    const statAfter = fs.statSync(settingsPath);
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs, "settings.local.json mtime must be unchanged — proves no write happened, not just same content");

    // Legacy commands remain verbatim.
    const after = JSON.parse(afterContent);
    const allCmds = Object.values(after.hooks as Record<string, any[]>)
      .flat()
      .flatMap((e: any) => e.hooks.map((h: any) => h.command));
    assert.ok(allCmds.includes(LEGACY_CMD_A), "legacy command A must REMAIN when removeForeignCommands:false");
    assert.ok(allCmds.includes(LEGACY_CMD_B), "legacy command B must REMAIN when removeForeignCommands:false");
    assert.ok(allCmds.includes(cmd), "our own tycoon-claude-hook.cjs command must remain present");

    // Orphan artifact files are still deleted regardless of the flag.
    assert.ok(!fs.existsSync(path.join(dir, "agent-activity-1738000000000-4321.json")), "orphan artifact file A must still be deleted");
    assert.ok(!fs.existsSync(path.join(dir, "agent-activity-1738000005555-9876.json")), "orphan artifact file B must still be deleted");
    assert.ok(result.deletedLeftoverFiles.includes("agent-activity-1738000000000-4321.json"));
    assert.ok(result.deletedLeftoverFiles.includes("agent-activity-1738000005555-9876.json"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupForeignHookArtifacts: removeForeignCommands:true (explicit) strips legacy commands, preserves our own, deletes orphan files", () => {
  const { dir, settingsPath } = makeMixedFixture();
  try {
    const result = cleanupForeignHookArtifacts(dir, { removeForeignCommands: true });

    assert.ok(result.strippedForeignHookCommands.includes(LEGACY_CMD_A));
    assert.ok(result.strippedForeignHookCommands.includes(LEGACY_CMD_B));

    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const allCmds = Object.values(after.hooks as Record<string, any[]>)
      .flat()
      .flatMap((e: any) => e.hooks.map((h: any) => h.command));
    assert.ok(!allCmds.includes(LEGACY_CMD_A), "legacy command A must be removed");
    assert.ok(!allCmds.includes(LEGACY_CMD_B), "legacy command B must be removed");
    assert.ok(allCmds.includes(cmd), "our own tycoon hook command must never be stripped");

    assert.ok(!fs.existsSync(path.join(dir, "agent-activity-1738000000000-4321.json")), "orphan artifact file A must be deleted");
    assert.ok(!fs.existsSync(path.join(dir, "agent-activity-1738000005555-9876.json")), "orphan artifact file B must be deleted");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupForeignHookArtifacts: option object present but removeForeignCommands key omitted ({}) behaves as true", () => {
  const { dir, settingsPath } = makeMixedFixture();
  try {
    const result = cleanupForeignHookArtifacts(dir, {});

    assert.ok(result.strippedForeignHookCommands.includes(LEGACY_CMD_A));
    assert.ok(result.strippedForeignHookCommands.includes(LEGACY_CMD_B));

    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const allCmds = Object.values(after.hooks as Record<string, any[]>)
      .flat()
      .flatMap((e: any) => e.hooks.map((h: any) => h.command));
    assert.ok(!allCmds.includes(LEGACY_CMD_A));
    assert.ok(!allCmds.includes(LEGACY_CMD_B));
    assert.ok(allCmds.includes(cmd));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupForeignHookArtifacts: options argument entirely omitted (Install Hooks' call shape) behaves as true — protects Install Hooks", () => {
  const { dir, settingsPath } = makeMixedFixture();
  try {
    // Call with ONLY the dir arg, exactly as Install Hooks does today.
    const result = cleanupForeignHookArtifacts(dir);

    assert.ok(result.strippedForeignHookCommands.includes(LEGACY_CMD_A));
    assert.ok(result.strippedForeignHookCommands.includes(LEGACY_CMD_B));

    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const allCmds = Object.values(after.hooks as Record<string, any[]>)
      .flat()
      .flatMap((e: any) => e.hooks.map((h: any) => h.command));
    assert.ok(!allCmds.includes(LEGACY_CMD_A), "Install Hooks' default call must still strip legacy commands");
    assert.ok(!allCmds.includes(LEGACY_CMD_B));
    assert.ok(allCmds.includes(cmd));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// mergeManagedSubagentDepthEnv — belt-and-braces harness-level cap for the
// PreToolUse spawn guard: writes CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH into
// settings.env only when the key is entirely absent, "1" for flat/direct
// delegation and "2" for team_leads.
// ---------------------------------------------------------------------------

test("mergeManagedSubagentDepthEnv writes '1' (flat/direct) when the key is absent and there is no env block at all", () => {
  const result = mergeManagedSubagentDepthEnv({}, "1");
  assert.deepEqual(result, { env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" } });
});

test("mergeManagedSubagentDepthEnv writes '2' (team_leads) when the key is absent", () => {
  const result = mergeManagedSubagentDepthEnv({ env: {} }, "2");
  const env = result.env as Record<string, unknown>;
  assert.equal(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, "2");
});

test("mergeManagedSubagentDepthEnv leaves a pre-existing user value (e.g. '3') completely untouched, returning the SAME object", () => {
  const existing = { env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "3" } };
  const result = mergeManagedSubagentDepthEnv(existing, "2");
  assert.equal(result, existing, "must return the identical object reference — a true no-op, not a rebuilt copy");
  const env = result.env as Record<string, unknown>;
  assert.equal(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, "3", "the user's own value must survive unchanged");
});

test("mergeManagedSubagentDepthEnv leaves a pre-existing value untouched even from an earlier install (idempotency), regardless of what desiredDepth is passed next", () => {
  const afterFirstInstall = mergeManagedSubagentDepthEnv({}, "1");
  const afterModeSwitch = mergeManagedSubagentDepthEnv(afterFirstInstall, "2");
  const env = afterModeSwitch.env as Record<string, unknown>;
  assert.equal(
    env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH,
    "1",
    "a later mode switch must not silently raise a value this function itself wrote on an earlier install"
  );
});

test("mergeManagedSubagentDepthEnv merges cleanly into settings.env without clobbering unrelated env keys or top-level keys", () => {
  const existing = { env: { SOME_OTHER_VAR: "keep-me" }, otherTopLevelKey: "also-keep" };
  const result = mergeManagedSubagentDepthEnv(existing, "1");
  assert.deepEqual(result, {
    otherTopLevelKey: "also-keep",
    env: { SOME_OTHER_VAR: "keep-me", CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" },
  });
});

test("mergeManagedSubagentDepthEnv tolerates a malformed (non-object) existing env block by treating it as empty", () => {
  for (const badEnv of [null, "not-an-object", [1, 2, 3]]) {
    const result = mergeManagedSubagentDepthEnv({ env: badEnv as unknown }, "2");
    const env = result.env as Record<string, unknown>;
    assert.equal(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, "2", `badEnv=${JSON.stringify(badEnv)} must not prevent the write`);
  }
});

// --- syncRuntimeFile (2026-09-06 stale-copy bug fix) -----------------------

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-hookinstall-sync-"));
}

test("syncRuntimeFile: creates the destination when it does not exist", () => {
  const dir = mkTempDir();
  try {
    const src = path.join(dir, "src.cjs");
    fs.writeFileSync(src, "content-v1");
    const dest = path.join(dir, "nested", "dest.cjs");
    const status = syncRuntimeFile(src, dest);
    assert.equal(status, "created");
    assert.equal(fs.readFileSync(dest, "utf8"), "content-v1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("syncRuntimeFile: overwrites a stale destination that differs by content", () => {
  const dir = mkTempDir();
  try {
    const src = path.join(dir, "src.cjs");
    fs.writeFileSync(src, "content-v2");
    const dest = path.join(dir, "dest.cjs");
    fs.writeFileSync(dest, "content-v1-stale");
    const status = syncRuntimeFile(src, dest);
    assert.equal(status, "refreshed");
    assert.equal(fs.readFileSync(dest, "utf8"), "content-v2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("syncRuntimeFile: leaves a byte-identical destination untouched (mtime unchanged)", () => {
  const dir = mkTempDir();
  try {
    const src = path.join(dir, "src.cjs");
    fs.writeFileSync(src, "same-content");
    const dest = path.join(dir, "dest.cjs");
    fs.writeFileSync(dest, "same-content");
    const mtimeBefore = fs.statSync(dest).mtimeMs;
    const status = syncRuntimeFile(src, dest);
    assert.equal(status, "unchanged");
    assert.equal(fs.statSync(dest).mtimeMs, mtimeBefore);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- portable hook command (p48-t1) -----------------------------------

test("portable hookCommand contains no absolute path and survives a machine-A -> machine-B copy", () => {
  const projectA = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-hook-projA-"));
  const projectB = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-hook-projB-"));
  try {
    // Simulate machine A: HOME=projectA/home, install a portable hook
    // command + a project-local copy of the hook script under
    // <projectA>/.claude/tycoon/.
    const homeA = path.join(projectA, "home");
    fs.mkdirSync(homeA, { recursive: true });
    const tycoonDirA = path.join(projectA, ".claude", "tycoon");
    fs.mkdirSync(tycoonDirA, { recursive: true });

    // Minimal stand-in hook script (no compiled binary): reads stdin,
    // exits 0. Mirrors tycoon-claude-hook.cjs's basic contract for this
    // portability check without depending on its full behavior.
    const hookScriptContent =
      "#!/usr/bin/env node\n" +
      "let data = '';\n" +
      "process.stdin.on('data', (c) => { data += c; });\n" +
      "process.stdin.on('end', () => { JSON.parse(data || '{}'); process.exit(0); });\n";
    fs.writeFileSync(path.join(tycoonDirA, "tycoon-claude-hook.cjs"), hookScriptContent);

    const hookCommand = "node .claude/tycoon/tycoon-claude-hook.cjs";
    const merged = mergeTycoonHooks({}, hookCommand);
    const settingsPath = path.join(projectA, ".claude", "settings.local.json");
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));

    // Assert the written command string carries no absolute path (neither
    // POSIX nor Windows drive-letter form) and no reference to homeA.
    const writtenSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const allCommands: string[] = [];
    for (const event of Object.keys(writtenSettings.hooks)) {
      for (const entry of writtenSettings.hooks[event]) {
        for (const h of entry.hooks) allCommands.push(h.command);
      }
    }
    assert.ok(allCommands.length > 0, "expected at least one hook command");
    for (const c of allCommands) {
      assert.equal(c, hookCommand);
      assert.ok(!path.isAbsolute(c.replace(/^node\s+/, "")), `command must not be absolute: ${c}`);
      assert.ok(!/^[A-Za-z]:[\\/]/.test(c), `command must not contain a drive-letter path: ${c}`);
      assert.ok(!c.includes(homeA), `command must not reference machine A's HOME: ${c}`);
    }

    // Simulate cloning to machine B: copy the whole .claude/ folder to a
    // different project root under a different HOME.
    const homeB = path.join(projectB, "home");
    fs.mkdirSync(homeB, { recursive: true });
    fs.cpSync(path.join(projectA, ".claude"), path.join(projectB, ".claude"), { recursive: true });

    const hookScriptPathB = path.join(projectB, ".claude", "tycoon", "tycoon-claude-hook.cjs");
    assert.ok(fs.existsSync(hookScriptPathB), "hook script copy must exist on machine B");

    // Spawn the portable command exactly as Claude Code would: cwd =
    // project root, minimal SessionStart JSON on stdin, HOME pointed at
    // machine B's own home dir (never machine A's).
    const result = spawnSync("node", [".claude/tycoon/tycoon-claude-hook.cjs"], {
      cwd: projectB,
      env: { ...process.env, HOME: homeB, USERPROFILE: homeB },
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "test" }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `hook script should exit 0 on machine B; stderr: ${result.stderr}`);
  } finally {
    fs.rmSync(projectA, { recursive: true, force: true });
    fs.rmSync(projectB, { recursive: true, force: true });
  }
});

test("RUNTIME_HOOK_FILES includes the hook script and its known runtime companions", () => {
  assert.ok(RUNTIME_HOOK_FILES.includes("tycoon-claude-hook.cjs"));
  assert.ok(RUNTIME_HOOK_FILES.includes("agentBackend.js"));
  assert.ok(RUNTIME_HOOK_FILES.includes("modelAliases.js"));
  assert.ok(RUNTIME_HOOK_FILES.includes("delegationEnforcement.js"));
  assert.ok(RUNTIME_HOOK_FILES.includes("fallbackChain.js"));
  assert.ok(RUNTIME_HOOK_FILES.includes("bridge-result.cjs"));
});

// ---------------------------------------------------------------------------
// MCP_BRIDGE_HOOK_FILES — the list panel.ts's best-effort copy loop
// (_ensureMcpBridgeHooksInstalled ~6345/teamSetupHost.ts ~400) iterates to
// place the Codex app-server bridge scripts into .claude/hooks/. Both
// consuming call sites are private/unexported, so this pins the exact
// exported list they both read from, and independently verifies each named
// file actually exists in hooks/ (the real source the copy loop reads from)
// so the list can never silently point at a renamed/missing script.
// ---------------------------------------------------------------------------

test("MCP_BRIDGE_HOOK_FILES is the four bridge scripts followed by the dispatcher server and its required modules, in that order", () => {
  assert.deepEqual(MCP_BRIDGE_HOOK_FILES, [
    "codex-mcp-launcher.cjs",
    "codex-app-server-mcp.cjs",
    "bridge-result.cjs",
    "gemini-mcp-wrapper.cjs",
    "claude-cli-mcp.cjs",
    "openai-compatible-mcp.cjs",
    "localEnvStore.js",
    "tycoon-dispatcher-mcp.cjs",
    "dispatcherAdapters.cjs",
    "dispatcherBridgeClient.cjs",
    "dispatcherClaudeChain.cjs",
    "codexRouting.cjs",
    "codexRollout.cjs",
    "gateEvents.cjs",
    "delegationEnforcement.js",
    "fallbackChain.js",
    "harnessModelDefaults.cjs",
    "binDiscovery.cjs",
    "claudePermissionMode.cjs",
  ]);
});

test("every MCP_BRIDGE_HOOK_FILES entry exists as a real file under hooks/ (the copy loop's source)", () => {
  // Files generated into hooks/ by scripts/copy-hook-runtime.mjs are gitignored
  // build artifacts: on a fresh checkout they only exist under out/src/core.
  const script = fs.readFileSync(path.join(process.cwd(), "scripts", "copy-hook-runtime.mjs"), "utf8");
  const listMatch = /const files = \[([^\]]*)\]/.exec(script);
  assert.ok(listMatch, "copy-hook-runtime.mjs must declare `const files = [...]`");
  const generated = new Set([...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  for (const name of MCP_BRIDGE_HOOK_FILES) {
    const p = path.join(process.cwd(), "hooks", name);
    if (generated.has(name)) {
      const built = path.join(process.cwd(), "out", "src", "core", name);
      assert.ok(
        fs.existsSync(p) || fs.existsSync(built),
        `${name} is generated by copy-hook-runtime; must exist at ${p} or ${built}`,
      );
    } else {
      assert.ok(fs.existsSync(p), `${name} must exist at ${p} for the best-effort copy to have anything to copy`);
    }
  }
  assert.ok(generated.has("localEnvStore.js"), "localEnvStore.js must be in copy-hook-runtime's generated list");
});

// ---------------------------------------------------------------------------
// buildAbsoluteHookCommand (hook-cwd-relative-command incident fix): the
// command must be an ABSOLUTE, quoted path so it keeps resolving even after
// the session's cwd leaves the project root mid-session (a relative
// "node .claude/tycoon/tycoon-claude-hook.cjs" silently stops firing then).
// ---------------------------------------------------------------------------

test("buildAbsoluteHookCommand: posix-style root produces a quoted absolute node command", () => {
  const cmd2 = buildAbsoluteHookCommand("/home/user/my-project", { platform: "win32" });
  assert.equal(cmd2, `node "${path.win32.join("/home/user/my-project", ".claude", "tycoon", "tycoon-claude-hook.cjs")}"`);
  assert.ok(cmd2.startsWith('node "'), "must be quoted");
  assert.ok(cmd2.includes("tycoon-claude-hook.cjs"));
});

test("buildAbsoluteHookCommand: Windows-style root produces a quoted absolute node command", () => {
  const cmd2 = buildAbsoluteHookCommand("D:\\ACode\\MyProject", { platform: "win32" });
  assert.ok(cmd2.startsWith('node "'), "must be quoted");
  assert.ok(cmd2.includes("tycoon-claude-hook.cjs"));
  assert.ok(cmd2.endsWith('"'), "must end with a closing quote");
});

test("buildAbsoluteHookCommand: a project path containing spaces stays inside one quoted argument", () => {
  const root = path.win32.join("C:\\Temp", "My Test Project " + Date.now());
  const cmd2 = buildAbsoluteHookCommand(root, { platform: "win32" });
  // The whole path (spaces and all) must sit between exactly one pair of
  // double quotes — otherwise a shell would split it into multiple argv
  // entries and `node` would fail to find the script.
  const match = cmd2.match(/^node "(.+)"$/);
  assert.ok(match, `command must be exactly node "<path>", got: ${cmd2}`);
  assert.equal(match![1], path.win32.join(root, ".claude", "tycoon", "tycoon-claude-hook.cjs"));
});

test("buildAbsoluteHookCommand: darwin/linux writes the discovered absolute node path, quoted", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const cmd2 = buildAbsoluteHookCommand("/p", { platform, resolveNode: () => "/opt/homebrew/bin/node" });
    assert.equal(cmd2, `"/opt/homebrew/bin/node" "${path.posix.join("/p", ".claude", "tycoon", "tycoon-claude-hook.cjs")}"`);
  }
});

test("buildAbsoluteHookCommand: darwin with no discoverable node falls back to bare node", () => {
  assert.ok(buildAbsoluteHookCommand("/p", { platform: "darwin", resolveNode: () => "node" }).startsWith('node "'));
  assert.ok(buildAbsoluteHookCommand("/p", { platform: "darwin", resolveNode: () => { throw new Error("x"); } }).startsWith('node "'));
  assert.equal(resolveHookInterpreter({ platform: "darwin", resolveNode: () => "node" }).resolved, false);
});

test("buildAbsoluteHookCommand: win32 never uses the discovered path", () => {
  const cmd2 = buildAbsoluteHookCommand("D:/proj",{ platform: "win32", resolveNode: () => "/opt/homebrew/bin/node" });
  assert.ok(cmd2.startsWith('node "'));
});

test("buildAbsoluteHookCommand: an Electron host binary is never written as the interpreter", () => {
  assert.ok(buildAbsoluteHookCommand("/p", { platform: "linux", resolveNode: () => "/usr/share/code/code" }).startsWith('node "'));
});

test("buildAbsoluteHookCommand: never produces the old bare project-relative form", () => {
  const cmd2 = buildAbsoluteHookCommand("/some/project");
  assert.notEqual(cmd2, "node .claude/tycoon/tycoon-claude-hook.cjs");
});

// ---------------------------------------------------------------------------
// migrateRelativeHookCommand (auto-migration on activation/panel-open)
// ---------------------------------------------------------------------------

test("migrateRelativeHookCommand: rewrites a relative Tycoon command to the absolute form, marks changed", () => {
  const abs = buildAbsoluteHookCommand("/proj");
  const existing = {
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "node .claude/tycoon/tycoon-claude-hook.cjs" }] }],
    },
  };
  const { settings, changed } = migrateRelativeHookCommand(existing, abs);
  assert.equal(changed, true);
  assert.equal((settings.hooks as any).Stop[0].hooks[0].command, abs);
});

test("migrateRelativeHookCommand: an already-absolute command is left alone, changed:false, same object reference", () => {
  const abs = buildAbsoluteHookCommand("/proj");
  const existing = {
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: abs }] }],
    },
  };
  const { settings, changed } = migrateRelativeHookCommand(existing, abs);
  assert.equal(changed, false);
  assert.equal(settings, existing, "must return the SAME object reference on a no-op");
});

test("migrateRelativeHookCommand: preserves every unrelated entry and top-level key untouched", () => {
  const abs = buildAbsoluteHookCommand("/proj");
  const existing = {
    hooks: {
      Stop: [
        { matcher: "", hooks: [{ type: "command", command: "node .claude/tycoon/tycoon-claude-hook.cjs" }] },
        { matcher: "foo", hooks: [{ type: "command", command: "node /some/other/foreign-hook.cjs" }] },
      ],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: abs }] }],
    },
    env: { SOME_USER_VAR: "keep-me" },
    someOtherTopLevelKey: { nested: "preserve-me" },
  };
  const { settings } = migrateRelativeHookCommand(existing, abs);
  assert.equal((settings.hooks as any).Stop[0].hooks[0].command, abs, "relative command migrated");
  assert.equal(
    (settings.hooks as any).Stop[1].hooks[0].command,
    "node /some/other/foreign-hook.cjs",
    "foreign hook command must be untouched",
  );
  assert.equal((settings.hooks as any).PreToolUse[0].hooks[0].command, abs, "already-absolute entry untouched");
  assert.deepEqual(settings.env, { SOME_USER_VAR: "keep-me" });
  assert.deepEqual(settings.someOtherTopLevelKey, { nested: "preserve-me" });
});

test("migrateRelativeHookCommand: also matches the Windows-backslash relative form", () => {
  const abs = buildAbsoluteHookCommand("D:\\proj");
  const existing = {
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "node .claude\\tycoon\\tycoon-claude-hook.cjs" }] }],
    },
  };
  const { settings, changed } = migrateRelativeHookCommand(existing, abs);
  assert.equal(changed, true);
  assert.equal((settings.hooks as any).Stop[0].hooks[0].command, abs);
});

test("migrateRelativeHookCommand: no hooks section -> no-op, changed:false", () => {
  const abs = buildAbsoluteHookCommand("/proj");
  const existing = { someKey: "value" };
  const { settings, changed } = migrateRelativeHookCommand(existing, abs);
  assert.equal(changed, false);
  assert.equal(settings, existing);
});

test("catalog: bundled bridge servers launch the project copy, never an extension path", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "media", "mcp", "catalog.json"), "utf8")) as Array<{ id: string; config?: { args?: string[] } }>;
  for (const id of ["claude-cli", "gemini", "openai-compatible"]) {
    const entry = catalog.find((e) => e.id === id);
    assert.ok(entry, id);
    const arg = entry!.config!.args![0];
    assert.match(arg, /^\.claude\/hooks\/[^/]+$/, id);
    assert.ok(MCP_BRIDGE_HOOK_FILES.includes(arg.split("/").pop()!), `${id} file is in MCP_BRIDGE_HOOK_FILES`);
  }
  assert.ok(!JSON.stringify(catalog).includes("${EXTENSION_DIR}"));
});

test("rewriteMcpJsonBridgePaths: rewrites versioned extension paths for our bridges, leaves other servers alone, copies missing file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-mcp-heal-"));
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-mcp-src-"));
  try {
    for (const f of ["gemini-mcp-wrapper.cjs", "claude-cli-mcp.cjs", "openai-compatible-mcp.cjs"]) fs.writeFileSync(path.join(srcDir, f), "// " + f);
    const original = {
      mcpServers: {
        gemini: { command: "node", args: ["C:/Users/u/.vscode/extensions/tycoonagents.tycoonagents-0.0.685/hooks/gemini-mcp-wrapper.cjs"] },
        "claude-cli": { command: "node", args: ["C:\\Users\\u\\.vscode\\extensions\\TycoonAgents.tycoonagents-0.0.685\\hooks\\claude-cli-mcp.cjs"], env: { A: "1" } },
        "openai-compatible": { command: "node", args: ["/home/u/.vscode/extensions/tycoonagents.tycoonagents-0.0.600/hooks/openai-compatible-mcp.cjs"] },
        mine: { command: "node", args: ["/opt/other/hooks/gemini-mcp-wrapper.cjs"] },
        theirs: { command: "node", args: ["C:/x/tycoonagents.tycoonagents-1/hooks/not-ours.cjs"] },
      },
      keep: true,
    };
    fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify(original, null, 2) + "\n");
    fs.mkdirSync(path.join(root, ".claude", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "hooks", "gemini-mcp-wrapper.cjs"), "// existing");
    const ids = rewriteMcpJsonBridgePaths(root, (f) => path.join(srcDir, f));
    assert.deepEqual(ids.sort(), ["claude-cli", "gemini", "openai-compatible"]);
    const out = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
    assert.deepEqual(out.mcpServers.gemini.args, [".claude/hooks/gemini-mcp-wrapper.cjs"]);
    assert.deepEqual(out.mcpServers["claude-cli"].args, [".claude/hooks/claude-cli-mcp.cjs"]);
    assert.deepEqual(out.mcpServers["claude-cli"].env, { A: "1" });
    assert.deepEqual(out.mcpServers["openai-compatible"].args, [".claude/hooks/openai-compatible-mcp.cjs"]);
    assert.deepEqual(out.mcpServers.mine, original.mcpServers.mine);
    assert.deepEqual(out.mcpServers.theirs, original.mcpServers.theirs);
    assert.equal(out.keep, true);
    assert.equal(fs.readFileSync(path.join(root, ".claude", "hooks", "gemini-mcp-wrapper.cjs"), "utf8"), "// existing");
    assert.equal(fs.readFileSync(path.join(root, ".claude", "hooks", "claude-cli-mcp.cjs"), "utf8"), "// claude-cli-mcp.cjs");
    assert.deepEqual(rewriteMcpJsonBridgePaths(root, (f) => path.join(srcDir, f)), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
});

test("healInstalledHookCopies: also heals .mcp.json; malformed .mcp.json is swallowed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-mcp-heal2-"));
  try {
    fs.writeFileSync(path.join(root, ".mcp.json"), "{ not json");
    const warnings: string[] = [];
    healInstalledHookCopies(root, () => undefined, (m) => warnings.push(m));
    assert.equal(warnings.length, 1);
    assert.equal(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"), "{ not json");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("copyMcpBridgeHooks: a server with no .claude/hooks reference copies nothing; gemini copies the wrapper plus its requires", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-mcp-copy-"));
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-mcp-copysrc-"));
  try {
    for (const f of MCP_BRIDGE_HOOK_FILES) fs.writeFileSync(path.join(srcDir, f), "// " + f);
    const resolve = (f: string): string => path.join(srcDir, f);
    assert.deepEqual(copyMcpBridgeHooks(root, { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }, resolve), []);
    assert.ok(!fs.existsSync(path.join(root, ".claude")));
    const copied = copyMcpBridgeHooks(root, { command: "node", args: [".claude/hooks/gemini-mcp-wrapper.cjs"] }, resolve);
    assert.deepEqual(copied.sort(), ["bridge-result.cjs", "gemini-mcp-wrapper.cjs", "localEnvStore.js"]);
    assert.deepEqual(fs.readdirSync(path.join(root, ".claude", "hooks")).sort(), ["bridge-result.cjs", "gemini-mcp-wrapper.cjs", "localEnvStore.js", "package.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
});

test("rewriteMcpJsonBridgePaths: adds TYCOON_PROJECT_DIR to an existing gemini entry only when missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-mcp-heal-env-"));
  try {
    const mcp = { mcpServers: { gemini: { command: "node", args: [".claude/hooks/gemini-mcp-wrapper.cjs"], env: { A: "1" } }, other: { command: "x" } } };
    fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify(mcp, null, 2) + "\n");
    assert.deepEqual(rewriteMcpJsonBridgePaths(root, () => undefined), ["gemini"]);
    const out = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
    assert.equal(out.mcpServers.gemini.env.TYCOON_PROJECT_DIR, root.replace(/\\/g, "/"));
    assert.equal(out.mcpServers.gemini.env.A, "1");
    assert.equal(out.mcpServers.other.env, undefined);
    assert.deepEqual(rewriteMcpJsonBridgePaths(root, () => undefined), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
