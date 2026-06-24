/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTycoonHooks, TYCOON_HOOK_SLOTS } from "../src/host/vscode/hookInstall";

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
