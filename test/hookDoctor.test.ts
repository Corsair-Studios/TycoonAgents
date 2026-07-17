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
