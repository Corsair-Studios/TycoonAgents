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
  migrateLegacyHookMatchers,
  TYCOON_HOOK_SLOTS,
  cleanupForeignHookArtifacts,
  findLegacyHookCommands,
  LEGACY_HOOK_BASENAMES,
  LEGACY_STATE_FILE_NAMES,
  mergeManagedSubagentDepthEnv,
} from "../src/host/vscode/hookInstall";

const cmd = "node /path/tycoon-claude-hook.cjs";

test("empty settings produces all 9 hook slots", () => {
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
  // All other multi-matcher-free events should still have exactly 1 entry
  assert.equal(hooks["UserPromptSubmit"].length, 1);
  assert.equal(hooks["SubagentStop"].length, 1);
  assert.equal(hooks["Stop"].length, 1);
  assert.equal(hooks["TaskCompleted"].length, 1);
  assert.equal(hooks["TeammateIdle"].length, 1);
  assert.equal(hooks["TaskCreated"].length, 1);
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
