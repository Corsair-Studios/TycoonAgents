/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TYCOON_HOOK_SLOTS } from "../src/host/vscode/hookInstall";
import {
  findForeignHooks,
  diagnose,
  repairSettings,
  type DoctorFinding,
} from "../src/host/vscode/hookDoctor";

const CMD = `node "C:/ext/tycoon-claude-hook.cjs"`;
const OLD_CMD = `node "C:/old/path/tycoon-claude-hook.cjs"`;
const FOREIGN_CMD = `node "C:/old/other-hook.cjs"`;

/**
 * Build a minimal settings object that wires all 7 TYCOON_HOOK_SLOTS to the
 * given command. Mirrors what repairSettings and mergeTycoonHooks produce.
 */
function buildFullSettings(command: string): any {
  const hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>> = {};
  for (const slot of TYCOON_HOOK_SLOTS) {
    if (!hooks[slot.event]) hooks[slot.event] = [];
    hooks[slot.event].push({
      matcher: slot.matcher,
      hooks: [{ type: "command", command }],
    });
  }
  return { hooks };
}

// ---------------------------------------------------------------------------
// diagnose
// ---------------------------------------------------------------------------

test("diagnose: null settings + hookScriptExists:true -> hooks-missing error", () => {
  const findings = diagnose({
    localSettings: null,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
  });
  const f = findings.find((x: DoctorFinding) => x.id === "hooks-missing");
  assert.ok(f, "should contain a hooks-missing finding");
  assert.equal(f!.severity, "error");
  assert.equal(f!.fixable, true);
  assert.equal(f!.destructive, false);
});

test("diagnose: empty settings + hookScriptExists:true -> hooks-missing error", () => {
  const findings = diagnose({
    localSettings: {},
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
  });
  const f = findings.find((x: DoctorFinding) => x.id === "hooks-missing");
  assert.ok(f, "should contain a hooks-missing finding");
  assert.equal(f!.severity, "error");
  assert.equal(f!.fixable, true);
  assert.equal(f!.destructive, false);
});

test("diagnose: all 7 slots wired correctly + no foreign + hookScriptExists:true -> single hooks-healthy ok", () => {
  const settings = buildFullSettings(CMD);
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
  });
  assert.ok(findings.length >= 1, "should have at least one finding");
  const healthy = findings.find((x: DoctorFinding) => x.id === "hooks-healthy");
  assert.ok(healthy, "should contain hooks-healthy finding");
  assert.equal(healthy!.severity, "ok");
  const errors = findings.filter((x: DoctorFinding) => x.severity === "error" || x.severity === "warn");
  assert.equal(errors.length, 0, "should have no errors or warnings");
});

test("diagnose: hookScriptExists:false -> hooks-script-missing error, not fixable", () => {
  const findings = diagnose({
    localSettings: buildFullSettings(CMD),
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: false,
  });
  const f = findings.find((x: DoctorFinding) => x.id === "hook-script-missing");
  assert.ok(f, "should contain hook-script-missing finding");
  assert.equal(f!.severity, "error");
  assert.equal(f!.fixable, false);
});

test("diagnose: stale Tycoon path (different from currentHookCommand) -> hooks-stale warn, fixable", () => {
  const settings = buildFullSettings(OLD_CMD); // has tycoon-claude-hook.cjs but old path
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
  });
  const f = findings.find((x: DoctorFinding) => x.id === "hooks-stale");
  assert.ok(f, "should contain hooks-stale finding");
  assert.equal(f!.severity, "warn");
  assert.equal(f!.fixable, true);
});

test("diagnose: foreign hook present -> hooks-foreign warn, fixable, destructive", () => {
  const settings = buildFullSettings(CMD);
  // Inject a foreign (non-Tycoon) command under UserPromptSubmit
  settings.hooks["UserPromptSubmit"].push({
    matcher: "",
    hooks: [{ type: "command", command: FOREIGN_CMD }],
  });
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
  });
  const f = findings.find((x: DoctorFinding) => x.id === "hooks-foreign");
  assert.ok(f, "should contain hooks-foreign finding");
  assert.equal(f!.severity, "warn");
  assert.equal(f!.fixable, true);
  assert.equal(f!.destructive, true);
});

// ---------------------------------------------------------------------------
// findForeignHooks
// ---------------------------------------------------------------------------

test("findForeignHooks: no hooks field -> returns empty array", () => {
  const foreign = findForeignHooks({ someOtherField: true }, { another: 42 });
  assert.deepEqual(foreign, []);
});

test("findForeignHooks: foreign command in sharedSettings Tycoon event -> returned", () => {
  const shared: any = {
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: FOREIGN_CMD }] }],
    },
  };
  const foreign = findForeignHooks(null, shared);
  assert.ok(foreign.includes(FOREIGN_CMD), "foreign command from sharedSettings must be returned");
});

test("findForeignHooks: same foreign command in both settings -> deduplicated to one entry", () => {
  const local: any = {
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: FOREIGN_CMD }] }],
    },
  };
  const shared: any = {
    hooks: {
      SubagentStop: [{ matcher: "", hooks: [{ type: "command", command: FOREIGN_CMD }] }],
    },
  };
  const foreign = findForeignHooks(local, shared);
  assert.equal(
    foreign.filter((c) => c === FOREIGN_CMD).length,
    1,
    "Duplicate foreign command across local+shared must appear only once"
  );
});

test("findForeignHooks: command in non-Tycoon event -> not flagged as foreign", () => {
  const settings: any = {
    hooks: {
      SomeOtherEvent: [{ matcher: "", hooks: [{ type: "command", command: FOREIGN_CMD }] }],
    },
  };
  const foreign = findForeignHooks(settings, null);
  assert.deepEqual(foreign, [], "Commands in non-Tycoon events must not be listed as foreign");
});

test("findForeignHooks: non-Tycoon command in a Tycoon event -> returned as foreign", () => {
  const settings: any = {
    hooks: {
      UserPromptSubmit: [
        { matcher: "", hooks: [{ type: "command", command: FOREIGN_CMD }] },
      ],
    },
  };
  const foreign = findForeignHooks(settings, null);
  assert.ok(foreign.includes(FOREIGN_CMD), "FOREIGN_CMD should be in foreign list");
});

test("findForeignHooks: Tycoon command is NOT returned as foreign", () => {
  const settings = buildFullSettings(CMD);
  const foreign = findForeignHooks(settings, null);
  assert.equal(foreign.length, 0, "Tycoon commands must not be listed as foreign");
});

test("findForeignHooks: null settings -> returns empty array", () => {
  const foreign = findForeignHooks(null, null);
  assert.deepEqual(foreign, []);
});

test("diagnose: hooks-missing detail contains the total slot count", () => {
  const findings = diagnose({
    localSettings: null,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
  });
  const f = findings.find((x: DoctorFinding) => x.id === "hooks-missing");
  assert.ok(f, "should contain hooks-missing finding");
  assert.ok(
    f!.detail.includes(String(TYCOON_HOOK_SLOTS.length)),
    `detail must reference "${TYCOON_HOOK_SLOTS.length}" (total slot count)`
  );
});

test("diagnose: duplicate Tycoon command in a slot -> hooks-duplicate warn", () => {
  const settings = buildFullSettings(CMD);
  // Add a duplicate under UserPromptSubmit's matcher="" entry
  settings.hooks["UserPromptSubmit"][0].hooks.push({ type: "command", command: CMD });
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
  });
  const f = findings.find((x: DoctorFinding) => x.id === "hooks-duplicate");
  assert.ok(f, "should contain hooks-duplicate finding");
  assert.equal(f!.severity, "warn");
});

test("diagnose: Tycoon commands in both local and shared settings -> hooks-split warn", () => {
  const localPartial: any = {
    hooks: {
      UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: CMD }] }],
    },
  };
  const sharedPartial: any = {
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: CMD }] }],
    },
  };
  const findings = diagnose({
    localSettings: localPartial,
    sharedSettings: sharedPartial,
    currentHookCommand: CMD,
    hookScriptExists: true,
  });
  const f = findings.find((x: DoctorFinding) => x.id === "hooks-split");
  assert.ok(f, "should contain hooks-split finding");
  assert.equal(f!.severity, "warn");
});

test("diagnose: stale + foreign coexist as separate findings", () => {
  const settings = buildFullSettings(OLD_CMD);
  // Inject a foreign command too
  settings.hooks["UserPromptSubmit"].push({
    matcher: "",
    hooks: [{ type: "command", command: FOREIGN_CMD }],
  });
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
  });
  const ids = findings.map((x: DoctorFinding) => x.id);
  assert.ok(ids.includes("hooks-stale"), "Expected hooks-stale alongside hooks-foreign");
  assert.ok(ids.includes("hooks-foreign"), "Expected hooks-foreign alongside hooks-stale");
});

test("diagnose: hook-script-missing does not suppress hooks-missing (independent checks)", () => {
  const findings = diagnose({
    localSettings: null,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: false,
  });
  const ids = findings.map((x: DoctorFinding) => x.id);
  assert.ok(ids.includes("hook-script-missing"), "Expected hook-script-missing");
  assert.ok(ids.includes("hooks-missing"), "Expected hooks-missing alongside hook-script-missing");
});

// ---------------------------------------------------------------------------
// repairSettings
// ---------------------------------------------------------------------------

test("repairSettings: null input + removeForeign:false -> all 7 slots wired; changes non-empty; input not mutated", () => {
  const input = null;
  const { settings, changes } = repairSettings(input, CMD, { removeForeign: false });
  assert.ok(settings, "result.settings must exist");
  assert.ok(Array.isArray(changes) && changes.length > 0, "changes should be non-empty");

  // Verify all 7 slots present
  for (const slot of TYCOON_HOOK_SLOTS) {
    const list: Array<{ matcher: string; hooks: Array<{ command: string }> }> =
      settings.hooks?.[slot.event] ?? [];
    const entry = list.find((e) => e.matcher === slot.matcher);
    assert.ok(entry, `slot ${slot.event}/${slot.matcher} must be present`);
    const hasTycoon = entry!.hooks.some((h) => h.command.includes("tycoon-claude-hook.cjs"));
    assert.ok(hasTycoon, `slot ${slot.event}/${slot.matcher} must have Tycoon command`);
  }
  // input (null) trivially not mutated; just verify no throw
});

test("repairSettings: empty input + removeForeign:false -> all 7 slots wired; input not mutated", () => {
  const input: any = {};
  const before = JSON.stringify(input);
  const { settings, changes } = repairSettings(input, CMD, { removeForeign: false });
  assert.equal(JSON.stringify(input), before, "input must not be mutated");
  assert.ok(changes.length > 0);

  for (const slot of TYCOON_HOOK_SLOTS) {
    const list: Array<{ matcher: string; hooks: Array<{ command: string }> }> =
      settings.hooks?.[slot.event] ?? [];
    const entry = list.find((e) => e.matcher === slot.matcher);
    assert.ok(entry, `slot ${slot.event}/${slot.matcher} must be present`);
  }
});

test("repairSettings: foreign command + removeForeign:true -> foreign gone, Tycoon present, changes mention removal", () => {
  const input = buildFullSettings(CMD);
  // Add a foreign command under PreToolUse / Task|Agent|Skill
  input.hooks["PreToolUse"].push({
    matcher: "Task|Agent|Skill",
    hooks: [{ type: "command", command: FOREIGN_CMD }],
  });
  const { settings, changes } = repairSettings(input, CMD, {
    removeForeign: true,
    foreignCommands: [FOREIGN_CMD],
  });

  // Foreign command must be gone
  for (const event of Object.keys(settings.hooks ?? {})) {
    for (const entry of settings.hooks[event] ?? []) {
      for (const h of entry.hooks ?? []) {
        assert.notEqual(h.command, FOREIGN_CMD, "foreign command must be removed");
      }
    }
  }

  // Tycoon hooks still present
  for (const slot of TYCOON_HOOK_SLOTS) {
    const list: Array<{ matcher: string; hooks: Array<{ command: string }> }> =
      settings.hooks?.[slot.event] ?? [];
    const entry = list.find((e) => e.matcher === slot.matcher);
    assert.ok(entry, `slot ${slot.event}/${slot.matcher} must remain after foreign removal`);
  }

  const mentionsRemoval = changes.some(
    (c: string) => c.toLowerCase().includes("remov") || c.toLowerCase().includes("foreign") || c.toLowerCase().includes("delet")
  );
  assert.ok(mentionsRemoval, "changes should mention the removal");
});

test("repairSettings: duplicate Tycoon commands in a slot -> deduped to one", () => {
  const input = buildFullSettings(CMD);
  // Add a duplicate under UserPromptSubmit
  input.hooks["UserPromptSubmit"][0].hooks.push({ type: "command", command: CMD });
  const { settings } = repairSettings(input, CMD, { removeForeign: false });
  const ups = settings.hooks?.["UserPromptSubmit"];
  const entry = (ups as Array<{ matcher: string; hooks: Array<{ command: string }> }>)?.find(
    (e) => e.matcher === ""
  );
  assert.ok(entry, "UserPromptSubmit empty-matcher entry must exist");
  const tycoonCount = entry!.hooks.filter((h) => h.command.includes("tycoon-claude-hook.cjs")).length;
  assert.equal(tycoonCount, 1, "Duplicate Tycoon command must be collapsed to one");
});

test("repairSettings: removeForeign:false does not remove external commands even when listed", () => {
  const input = buildFullSettings(CMD);
  input.hooks["Stop"].push({
    matcher: "",
    hooks: [{ type: "command", command: FOREIGN_CMD }],
  });
  const { settings } = repairSettings(input, CMD, {
    removeForeign: false,
    foreignCommands: [FOREIGN_CMD],
  });
  const stopEntries: Array<{ matcher: string; hooks: Array<{ command: string }> }> =
    settings.hooks?.["Stop"] ?? [];
  const allStopCmds = stopEntries.flatMap((e) => e.hooks.map((h) => h.command));
  assert.ok(allStopCmds.includes(FOREIGN_CMD), "External command must be preserved when removeForeign:false");
});

test("repairSettings: already-correct settings -> changes:[]", () => {
  const input = buildFullSettings(CMD);
  const { changes } = repairSettings(input, CMD, { removeForeign: false });
  assert.deepEqual(changes, [], "No changes expected when settings already correct");
});

test("repairSettings: pre-existing bare mcp__ entry (ours) is renamed to mcp__.*, not duplicated", () => {
  const input: any = {
    hooks: {
      PreToolUse: [{ matcher: "mcp__", hooks: [{ type: "command", command: CMD }] }],
    },
  };
  const { settings, changes } = repairSettings(input, CMD, { removeForeign: false });
  const ptu: Array<{ matcher: string; hooks: Array<{ command: string }> }> = settings.hooks["PreToolUse"];
  assert.equal(ptu.filter((e) => e.matcher === "mcp__").length, 0, "old bare mcp__ matcher must be gone");
  const upgraded = ptu.filter((e) => e.matcher === "mcp__.*");
  assert.equal(upgraded.length, 1, "exactly one mcp__.* entry must exist (no double-wiring)");
  assert.equal(
    upgraded[0].hooks.filter((h) => h.command === CMD).length,
    1,
    "renamed entry must carry exactly one Tycoon command"
  );
  assert.ok(changes.some((c) => c.includes("mcp__") && c.includes("mcp__.*")), "changes should mention the upgrade");
});

test("repairSettings: user-customized bare mcp__ entry (different command) is left untouched, mcp__.* added separately", () => {
  const input: any = {
    hooks: {
      PreToolUse: [{ matcher: "mcp__", hooks: [{ type: "command", command: "node user-custom-mcp-logger.js" }] }],
    },
  };
  const { settings } = repairSettings(input, CMD, { removeForeign: false });
  const ptu: Array<{ matcher: string; hooks: Array<{ command: string }> }> = settings.hooks["PreToolUse"];
  const oldEntry = ptu.find((e) => e.matcher === "mcp__");
  assert.ok(oldEntry, "user's custom mcp__ entry must be preserved");
  assert.equal(oldEntry!.hooks[0].command, "node user-custom-mcp-logger.js");
  const newEntry = ptu.find((e) => e.matcher === "mcp__.*");
  assert.ok(newEntry, "our mcp__.* entry must still be wired");
  assert.ok(newEntry!.hooks.some((h) => h.command === CMD));
});

// ---------------------------------------------------------------------------
// diagnose: operational health (legacy artifacts, stale lock, stuck stack,
// malformed activity records) — all driven by optional DoctorInput fields
// that a settings-only diagnose() call simply omits.
// ---------------------------------------------------------------------------

test("diagnose: healthy settings + no operational-health data supplied -> stays hooks-healthy (backward compatible)", () => {
  const settings = buildFullSettings(CMD);
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "hooks-healthy");
});

test("diagnose: leftover legacy state files present -> legacy-artifacts error, not healthy", () => {
  const settings = buildFullSettings(CMD);
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
    legacyArtifacts: { leftoverFiles: ["hook-config.json"], hookCommands: [] },
  });
  const f = findings.find((x: DoctorFinding) => x.id === "legacy-artifacts");
  assert.ok(f, "should contain legacy-artifacts finding");
  assert.equal(f!.severity, "error");
  assert.equal(f!.fixable, true);
  assert.equal(f!.destructive, false, "leftover state-file cleanup is safe to auto-fix, unlike removing foreign hook commands");
  assert.ok(!findings.some((x: DoctorFinding) => x.id === "hooks-healthy"), "must not report healthy");
});

test("diagnose: legacy hook commands present (no leftover files) -> legacy-artifacts error", () => {
  const settings = buildFullSettings(CMD);
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
    legacyArtifacts: { leftoverFiles: [], hookCommands: [FOREIGN_CMD] },
  });
  const f = findings.find((x: DoctorFinding) => x.id === "legacy-artifacts");
  assert.ok(f, "should contain legacy-artifacts finding");
});

test("diagnose: empty legacyArtifacts (no leftovers) -> no legacy-artifacts finding, stays healthy", () => {
  const settings = buildFullSettings(CMD);
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
    legacyArtifacts: { leftoverFiles: [], hookCommands: [] },
  });
  assert.ok(!findings.some((x: DoctorFinding) => x.id === "legacy-artifacts"));
  assert.ok(findings.some((x: DoctorFinding) => x.id === "hooks-healthy"));
});

test("diagnose: stale lock (>30s old) -> hooks-lock-stale error, not healthy", () => {
  const settings = buildFullSettings(CMD);
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
    lockFileAgeMs: 45_000,
  });
  const f = findings.find((x: DoctorFinding) => x.id === "hooks-lock-stale");
  assert.ok(f, "should contain hooks-lock-stale finding");
  assert.equal(f!.severity, "error");
  assert.ok(!findings.some((x: DoctorFinding) => x.id === "hooks-healthy"));
});

test("diagnose: fresh lock (<30s old) -> no hooks-lock-stale finding", () => {
  const settings = buildFullSettings(CMD);
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
    lockFileAgeMs: 500,
  });
  assert.ok(!findings.some((x: DoctorFinding) => x.id === "hooks-lock-stale"));
});

test("diagnose: non-empty stack with stale timestamp (>10min) -> hooks-stack-stuck error, not healthy", () => {
  const settings = buildFullSettings(CMD);
  const now = 1_000_000_000_000;
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
    activeAgentState: { stack: [{ agentId: "coding-specialist" }], agentId: "coding-specialist", timestampMs: now - 11 * 60 * 1000 },
    nowMs: now,
  });
  const f = findings.find((x: DoctorFinding) => x.id === "hooks-stack-stuck");
  assert.ok(f, "should contain hooks-stack-stuck finding");
  assert.equal(f!.severity, "error");
  assert.ok(!findings.some((x: DoctorFinding) => x.id === "hooks-healthy"));
});

test("diagnose: empty stack + agentId 'none' -> no hooks-stack-stuck finding even if timestamp is old", () => {
  const settings = buildFullSettings(CMD);
  const now = 1_000_000_000_000;
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
    activeAgentState: { stack: [], agentId: "none", timestampMs: now - 60 * 60 * 1000 },
    nowMs: now,
  });
  assert.ok(!findings.some((x: DoctorFinding) => x.id === "hooks-stack-stuck"));
});

test("diagnose: non-empty stack with RECENT timestamp -> no hooks-stack-stuck finding", () => {
  const settings = buildFullSettings(CMD);
  const now = 1_000_000_000_000;
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
    activeAgentState: { stack: [{ agentId: "coding-specialist" }], agentId: "coding-specialist", timestampMs: now - 5_000 },
    nowMs: now,
  });
  assert.ok(!findings.some((x: DoctorFinding) => x.id === "hooks-stack-stuck"));
});

test("diagnose: malformed activity tail lines -> activity-malformed warn", () => {
  const settings = buildFullSettings(CMD);
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
    activityTailLines: ["{not json", '{"event":"Stop","at":1}'],
  });
  const f = findings.find((x: DoctorFinding) => x.id === "activity-malformed");
  assert.ok(f, "should contain activity-malformed finding");
  assert.equal(f!.severity, "warn");
});

test("diagnose: well-formed activity tail lines -> no activity-malformed finding, stays healthy", () => {
  const settings = buildFullSettings(CMD);
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
    activityTailLines: ['{"event":"Stop","at":1}', '{"event":"PreToolUse","at":2}'],
  });
  assert.ok(!findings.some((x: DoctorFinding) => x.id === "activity-malformed"));
  assert.ok(findings.some((x: DoctorFinding) => x.id === "hooks-healthy"));
});

test("repairSettings: stale Tycoon command -> replaced with currentHookCommand, no duplicate", () => {
  const input = buildFullSettings(OLD_CMD); // all slots have old path
  const { settings } = repairSettings(input, CMD, { removeForeign: false });

  for (const slot of TYCOON_HOOK_SLOTS) {
    const list: Array<{ matcher: string; hooks: Array<{ command: string }> }> =
      settings.hooks?.[slot.event] ?? [];
    const entries = list.filter((e) => e.matcher === slot.matcher);
    // Should not have duplicates
    assert.ok(entries.length >= 1, `slot ${slot.event}/${slot.matcher} must exist`);
    const tycoonHooks = entries.flatMap((e) =>
      e.hooks.filter((h) => h.command.includes("tycoon-claude-hook.cjs"))
    );
    assert.equal(tycoonHooks.length, 1, `slot ${slot.event}/${slot.matcher} must have exactly 1 Tycoon command`);
    assert.equal(tycoonHooks[0].command, CMD, "stale command must be replaced with currentHookCommand");
  }
});

// ---------------------------------------------------------------------------
// hook-cwd-relative-command incident: relative-command detection + migration
// ---------------------------------------------------------------------------

const RELATIVE_CMD = "node .claude/tycoon/tycoon-claude-hook.cjs";
const RELATIVE_CMD_BACKSLASH = "node .claude\\tycoon\\tycoon-claude-hook.cjs";

test("diagnose: a project-relative hook command raises hooks-relative-command (and generic hooks-stale)", () => {
  const settings = buildFullSettings(RELATIVE_CMD);
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
  });
  const relFinding = findings.find((x: DoctorFinding) => x.id === "hooks-relative-command");
  assert.ok(relFinding, "hooks-relative-command finding must be present");
  assert.equal(relFinding!.fixable, true);
  assert.ok(findings.some((x: DoctorFinding) => x.id === "hooks-stale"), "generic staleness must also fire");
});

test("diagnose: a Windows-backslash relative hook command also raises hooks-relative-command", () => {
  const settings = buildFullSettings(RELATIVE_CMD_BACKSLASH);
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
  });
  assert.ok(findings.some((x: DoctorFinding) => x.id === "hooks-relative-command"));
});

test("diagnose: today's absolute quoted command form never raises hooks-relative-command", () => {
  const settings = buildFullSettings(CMD);
  const findings = diagnose({
    localSettings: settings,
    sharedSettings: null,
    currentHookCommand: CMD,
    hookScriptExists: true,
  });
  assert.ok(!findings.some((x: DoctorFinding) => x.id === "hooks-relative-command"));
});

test("repairSettings: migrates a relative hook command to the absolute currentHookCommand, every other slot/value untouched", () => {
  const input = {
    ...buildFullSettings(RELATIVE_CMD),
    env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1", SOME_USER_VAR: "keep-me" },
    someOtherTopLevelKey: { nested: "preserve-me" },
  };
  const { settings, changes } = repairSettings(input, CMD, { removeForeign: false });

  // Every slot's Tycoon command is now the absolute currentHookCommand.
  for (const slot of TYCOON_HOOK_SLOTS) {
    const list: Array<{ matcher: string; hooks: Array<{ command: string }> }> =
      settings.hooks?.[slot.event] ?? [];
    const entry = list.find((e) => e.matcher === slot.matcher);
    assert.ok(entry, `slot ${slot.event}/${slot.matcher} must exist after migration`);
    const tycoonCmd = entry!.hooks.find((h) => h.command.includes("tycoon-claude-hook.cjs"));
    assert.equal(tycoonCmd?.command, CMD, "relative command must be migrated to the absolute form");
  }
  assert.ok(changes.length > 0, "repair must report at least one change");

  // Unrelated top-level content is preserved byte-for-byte in structure.
  assert.deepEqual(settings.env, { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1", SOME_USER_VAR: "keep-me" });
  assert.deepEqual(settings.someOtherTopLevelKey, { nested: "preserve-me" });
});

// ---------------------------------------------------------------------------
// repairSettings: mixed-form Tycoon commands are normalised + deduplicated
// ---------------------------------------------------------------------------

const ABS_CMD = String.raw`node "d:\Vignetta\.claude\tycoon\tycoon-claude-hook.cjs"`;
const REL_CMD = `node ".claude/tycoon/tycoon-claude-hook.cjs"`;

function tycoonCmdsFor(settings: any, event: string, matcher: string): string[] {
  const out: string[] = [];
  for (const e of settings.hooks[event] ?? []) {
    if (e.matcher !== matcher) continue;
    for (const h of e.hooks) if (h.command.includes("tycoon-claude-hook.cjs")) out.push(h.command);
  }
  return out;
}

test("repairSettings: Vignetta shape (absolute + relative duplicate, separate UserPromptSubmit entries) -> one current entry; diagnose clean", () => {
  const input = buildFullSettings(ABS_CMD);
  input.hooks.UserPromptSubmit.push({ matcher: "", hooks: [{ type: "command", command: REL_CMD }] });
  const { settings } = repairSettings(input, ABS_CMD, { removeForeign: false });
  assert.deepEqual(tycoonCmdsFor(settings, "UserPromptSubmit", ""), [ABS_CMD]);
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  const findings = diagnose({ localSettings: settings, sharedSettings: null, currentHookCommand: ABS_CMD, hookScriptExists: true });
  assert.deepEqual(findings.map((f) => f.id), ["hooks-healthy"]);
});

test("diagnose: duplicate across separate entries is flagged", () => {
  const input = buildFullSettings(ABS_CMD);
  input.hooks.UserPromptSubmit.push({ matcher: "", hooks: [{ type: "command", command: REL_CMD }] });
  const findings = diagnose({ localSettings: input, sharedSettings: null, currentHookCommand: ABS_CMD, hookScriptExists: true });
  assert.ok(findings.some((f) => f.id === "hooks-duplicate"));
  assert.ok(findings.some((f) => f.id === "hooks-stale"));
});

test("repairSettings: mixed slashes, quoting and drive-letter case all collapse to the current command", () => {
  const input = buildFullSettings(ABS_CMD);
  input.hooks.Stop = [
    { matcher: "", hooks: [{ type: "command", command: `node D:/Vignetta/.claude/tycoon/tycoon-claude-hook.cjs` }] },
    { matcher: "", hooks: [{ type: "command", command: String.raw`node "d:\Vignetta\.claude\tycoon\tycoon-claude-hook.cjs"` }] },
    { matcher: "", hooks: [{ type: "command", command: String.raw`node .claude\tycoon\tycoon-claude-hook.cjs` }] },
  ];
  const { settings } = repairSettings(input, ABS_CMD, { removeForeign: false });
  assert.deepEqual(tycoonCmdsFor(settings, "Stop", ""), [ABS_CMD]);
});

test("repairSettings: non-Tycoon hooks in the same slot are untouched and keep their order", () => {
  const other = { type: "command", command: `node "C:/other/their-hook.cjs"` };
  const input = buildFullSettings(ABS_CMD);
  input.hooks.UserPromptSubmit = [
    { matcher: "", hooks: [other, { type: "command", command: REL_CMD }] },
    { matcher: "", hooks: [{ type: "command", command: ABS_CMD }, { type: "command", command: `echo hi` }] },
  ];
  const { settings } = repairSettings(input, ABS_CMD, { removeForeign: false });
  const entries = settings.hooks.UserPromptSubmit;
  assert.deepEqual(entries[0].hooks, [other, { type: "command", command: ABS_CMD }]);
  assert.deepEqual(entries[1].hooks, [{ type: "command", command: `echo hi` }]);
});

test("repairSettings: idempotent - second run reports no changes and yields identical settings", () => {
  const input = buildFullSettings(ABS_CMD);
  input.hooks.UserPromptSubmit.push({ matcher: "", hooks: [{ type: "command", command: REL_CMD }] });
  const first = repairSettings(input, ABS_CMD, { removeForeign: false });
  const second = repairSettings(first.settings, ABS_CMD, { removeForeign: false });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.settings, first.settings);
});

test("repairSettings: a user wrapper that only mentions the hook name in a comment is not Tycoon and is left alone", () => {
  const wrapper = { type: "command", command: `node my-wrap.cjs # tycoon-claude-hook.cjs` };
  const input = buildFullSettings(ABS_CMD);
  input.hooks.UserPromptSubmit.push({ matcher: "", hooks: [wrapper] });
  const findings = diagnose({ localSettings: input, sharedSettings: null, currentHookCommand: ABS_CMD, hookScriptExists: true });
  assert.ok(!findings.some((f) => f.id === "hooks-duplicate" || f.id === "hooks-stale"));
  const { settings } = repairSettings(input, ABS_CMD, { removeForeign: false });
  const cmds = settings.hooks.UserPromptSubmit.flatMap((e: any) => e.hooks.map((h: any) => h.command));
  assert.ok(cmds.includes(wrapper.command));
  assert.deepEqual(tycoonCmdsFor(settings, "UserPromptSubmit", "").filter((c) => c !== wrapper.command), [ABS_CMD]);
});

// ---------------------------------------------------------------------------
// Interpreter handling (macOS minimal-PATH incident: bare `node` not found)
// ---------------------------------------------------------------------------

const ABS_NODE = `"/opt/homebrew/bin/node" "/p/.claude/tycoon/tycoon-claude-hook.cjs"`;
const BARE_NODE = `node "/p/.claude/tycoon/tycoon-claude-hook.cjs"`;
const darwin = (existing: string[] = []) => ({ platform: "darwin" as const, fileExists: (p: string) => existing.includes(p) });

test("doctor recognises the absolute-interpreter form as a Tycoon command (no foreign, wired)", () => {
  const settings = buildFullSettings(ABS_NODE);
  assert.deepEqual(findForeignHooks(settings, null), []);
  const findings = diagnose({ localSettings: settings, sharedSettings: null, currentHookCommand: ABS_NODE, hookScriptExists: true, env: darwin(["/opt/homebrew/bin/node"]) });
  assert.deepEqual(findings.map((f) => f.id), ["hooks-healthy"]);
});

test("darwin: bare node is stale when the current command uses an absolute node", () => {
  const findings = diagnose({ localSettings: buildFullSettings(BARE_NODE), sharedSettings: null, currentHookCommand: ABS_NODE, hookScriptExists: true, env: darwin() });
  assert.ok(findings.some((f) => f.id === "hooks-stale" && f.fixable));
  const { settings } = repairSettings(buildFullSettings(BARE_NODE), ABS_NODE, { removeForeign: false, env: darwin() });
  assert.equal(settings.hooks.Stop[0].hooks[0].command, ABS_NODE);
});

test("darwin: an absolute node path that no longer exists is stale and rewritten", () => {
  const gone = `"/Users/u/.nvm/versions/node/v18.0.0/bin/node" "/p/.claude/tycoon/tycoon-claude-hook.cjs"`;
  const findings = diagnose({ localSettings: buildFullSettings(gone), sharedSettings: null, currentHookCommand: ABS_NODE, hookScriptExists: true, env: darwin() });
  assert.ok(findings.some((f) => f.id === "hooks-stale"));
});

test("darwin: discovery failed (current is bare) keeps an existing absolute node, not stale", () => {
  const findings = diagnose({ localSettings: buildFullSettings(ABS_NODE), sharedSettings: null, currentHookCommand: BARE_NODE, hookScriptExists: true, env: darwin(["/opt/homebrew/bin/node"]) });
  assert.ok(!findings.some((f) => f.id === "hooks-stale"));
  const { changes } = repairSettings(buildFullSettings(ABS_NODE), BARE_NODE, { removeForeign: false, env: darwin(["/opt/homebrew/bin/node"]) });
  assert.deepEqual(changes, []);
});

test("win32: differing command is stale exactly as before", () => {
  const findings = diagnose({ localSettings: buildFullSettings(ABS_NODE), sharedSettings: null, currentHookCommand: BARE_NODE, hookScriptExists: true, env: { platform: "win32" } });
  assert.ok(findings.some((f) => f.id === "hooks-stale"));
});

test("interpreterCheck failure yields a hooks-node-missing finding, never healthy", () => {
  const findings = diagnose({ localSettings: buildFullSettings(BARE_NODE), sharedSettings: null, currentHookCommand: BARE_NODE, hookScriptExists: true, env: darwin(), interpreterCheck: { ok: false, interpreter: "node" } });
  const f = findings.find((x) => x.id === "hooks-node-missing");
  assert.ok(f);
  assert.match(f!.detail, /TYCOON_NODE_PATH/);
  assert.ok(!findings.some((x) => x.id === "hooks-healthy"));
  const ok = diagnose({ localSettings: buildFullSettings(BARE_NODE), sharedSettings: null, currentHookCommand: BARE_NODE, hookScriptExists: true, env: darwin(), interpreterCheck: { ok: true, interpreter: "node" } });
  assert.deepEqual(ok.map((x) => x.id), ["hooks-healthy"]);
});

// ---------------------------------------------------------------------------
// Review fixes: ping-pong, quoting, Electron guard
// ---------------------------------------------------------------------------
import { isStaleCommand, firstTycoonInterpreter, isTycoonCommand, rewriteStaleTycoonInterpreters } from "../src/host/vscode/hookDoctor";
import { buildHookCommandForScript, quoteHookToken } from "../src/host/vscode/hookInstall";

const SCRIPT = "/p/.claude/tycoon/tycoon-claude-hook.cjs";
const NODE_A = `"/opt/homebrew/bin/node" "${SCRIPT}"`;
const NODE_B = `"/Users/u/.nvm/versions/node/v20/bin/node" "${SCRIPT}"`;

test("ping-pong: a valid stored absolute node is not stale when discovery returns a different valid node", () => {
  const env = darwin(["/opt/homebrew/bin/node", "/Users/u/.nvm/versions/node/v20/bin/node"]);
  assert.equal(isStaleCommand(NODE_A, NODE_B, env), false);
  assert.equal(isStaleCommand(NODE_B, NODE_A, env), false);
});

test("ping-pong: two consecutive repairs with alternating discovery results write nothing", () => {
  const env = darwin(["/opt/homebrew/bin/node", "/Users/u/.nvm/versions/node/v20/bin/node"]);
  const start = buildFullSettings(NODE_A);
  const r1 = repairSettings(start, NODE_B, { removeForeign: false, env });
  const r2 = repairSettings(r1.settings, NODE_A, { removeForeign: false, env });
  assert.deepEqual(r1.changes, []);
  assert.deepEqual(r2.changes, []);
  assert.deepEqual(r2.settings, start);
});

test("stale: non-executable or Electron stored interpreter is rewritten; different script is stale", () => {
  assert.equal(isStaleCommand(NODE_A, NODE_B, { platform: "darwin", fileExists: () => true, isExecutable: () => false }), true);
  const electron = `"/Applications/Visual Studio Code.app/Contents/MacOS/Electron" "${SCRIPT}"`;
  assert.equal(isStaleCommand(electron, NODE_A, { platform: "darwin", fileExists: () => true }), true);
  const otherScript = `"/opt/homebrew/bin/node" "/q/.claude/tycoon/tycoon-claude-hook.cjs"`;
  assert.equal(isStaleCommand(otherScript, NODE_A, darwin(["/opt/homebrew/bin/node"])), true);
});

test("quoting: paths with space, accent, dollar, backtick, double and single quote round-trip on POSIX", () => {
  const nodes = ["/opt/my node/bin/node", "/Users/rené/bin/node", "/u/$HOME/node", "/u/`id`/node", '/u/"q"/node', "/u/it's/node"];
  for (const node of nodes) {
    for (const script of ["/p/a b/tycoon-claude-hook.cjs", "/p/$x`y`\"z\"'w/tycoon-claude-hook.cjs", "/p/é/tycoon-claude-hook.cjs"]) {
      const cmd = buildHookCommandForScript(script, { platform: "darwin", resolveNode: () => node });
      assert.ok(isTycoonCommand(cmd), cmd);
      assert.equal(firstTycoonInterpreter(buildFullSettings(cmd)), node, cmd);
      assert.deepEqual(findForeignHooks(buildFullSettings(cmd), null), []);
    }
  }
  assert.equal(quoteHookToken("/a/b c", "darwin"), '"/a/b c"');
  assert.equal(quoteHookToken("/a/$b", "darwin"), "'/a/$b'");
  assert.equal(quoteHookToken("/a/it's$", "darwin"), "'/a/it'\\''s$'");
  assert.equal(quoteHookToken("C:\\a\\b", "win32"), '"C:\\a\\b"');
});

test("Electron guard: helper paths from discovery fall back to bare node", () => {
  const helpers = [
    "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
    "/Applications/Cursor.app/Contents/MacOS/Cursor Helper",
    "/opt/electron/dist/node",
    "/x/Foo.app/Contents/MacOS/node",
  ];
  for (const h of helpers) {
    assert.equal(buildHookCommandForScript(SCRIPT, { platform: "darwin", resolveNode: () => h }), `node "${SCRIPT}"`, h);
  }
});

test("rejected TYCOON_NODE_PATH override surfaces hooks-node-missing with an editor-helper hint", () => {
  const findings = diagnose({ localSettings: buildFullSettings(BARE_NODE), sharedSettings: null, currentHookCommand: BARE_NODE, hookScriptExists: true, env: darwin(), nodeOverrideRejected: "/Applications/Cursor.app/Contents/MacOS/Cursor Helper" });
  const f = findings.find((x) => x.id === "hooks-node-missing");
  assert.ok(f);
  assert.match(f!.detail, /editor helper/);
});

test("rewriteStaleTycoonInterpreters: bare node for the same script is rewritten; valid absolute node and win32 untouched", () => {
  const env = darwin(["/opt/homebrew/bin/node"]);
  const r = rewriteStaleTycoonInterpreters(buildFullSettings(`node "${SCRIPT}"`), NODE_A, env);
  assert.equal(r.changed, true);
  assert.equal((r.settings as any).hooks.Stop[0].hooks[0].command, NODE_A);
  assert.equal(rewriteStaleTycoonInterpreters(buildFullSettings(NODE_B), NODE_A, darwin(["/Users/u/.nvm/versions/node/v20/bin/node"])).changed, false);
  assert.equal(rewriteStaleTycoonInterpreters(buildFullSettings(`node "${SCRIPT}"`), NODE_A, { platform: "win32" }).changed, false);
  assert.equal(rewriteStaleTycoonInterpreters(buildFullSettings(`node "/q/tycoon-claude-hook.cjs"`), NODE_A, env).changed, false);
});
