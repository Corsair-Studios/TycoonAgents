/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Ready-test-parity benchmark (plan task p14-t3): proves the OpenCode
 * plugin's ported delegation enforcement (hooks/tycoon-opencode-plugin.ts,
 * backed by src/core/delegationEnforcement.ts) matches
 * hooks/tycoon-claude-hook.cjs's original algorithms for the SAME inputs,
 * against a shared fixture roster. See docs/ENFORCEMENT-PARITY-BENCHMARK.md
 * for how to run this and the per-rule results table.
 *
 * Each scenario below drives BOTH hosts against the same fixture roster and
 * inputs, then asserts equivalence per rule (not aggregate). Where OpenCode
 * structurally cannot enforce a behavior the Claude hook can (it can only
 * log, never block: see hooks/tycoon-opencode-plugin.ts's own comments at
 * the `task` tool.execute.before guard and at the review-gate wiring), the
 * assertion checks the logged record and the scenario is marked
 * "enforcement parity: logged-only" rather than faking a block.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as ts from "typescript";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchAgentFromKeywords,
  startReviewGate,
  advanceReviewGate,
  isReviewGateTerminal,
  LEAF_WORKER_DENY_MESSAGE,
} from "../src/core/delegationEnforcement";

const HOOK_PATH = join(process.cwd(), "hooks", "tycoon-claude-hook.cjs");
const PLUGIN_SRC_PATH = join(process.cwd(), "hooks", "tycoon-opencode-plugin.ts");
const DELEGATION_ENFORCEMENT_JS = join(process.cwd(), "out", "src", "core", "delegationEnforcement.js");

// ---------------------------------------------------------------------------
// Fixture roster ("parity-roster-v1"): 4 agent .md files + one
// agent-keywords.json, shared by every scenario in this file. Named here so
// docs/ENFORCEMENT-PARITY-BENCHMARK.md can point at exactly this shape.
// ---------------------------------------------------------------------------

function writeFixtureRoster(root: string): void {
  const agentsDir = join(root, ".claude", "agents");
  const tycoonDir = join(root, ".claude", "tycoon");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(tycoonDir, { recursive: true });

  writeFileSync(
    join(agentsDir, "coding-specialist.md"),
    "---\ndescription: Implements code, fixes bugs.\nmodel: sonnet\n---\nBody.\n",
    "utf8"
  );
  writeFileSync(
    join(agentsDir, "search-retrieval.md"),
    "---\ndescription: Searches and retrieves.\nmodel: haiku\n---\nBody.\n",
    "utf8"
  );
  writeFileSync(
    join(agentsDir, "uefn-auditor.md"),
    "---\ndescription: Reviews changes for correctness.\nmodel: sonnet\n---\nBody.\n",
    "utf8"
  );
  writeFileSync(
    join(agentsDir, "build-lead.md"),
    "---\ndescription: Leads the build team.\nmodel: opus\ntier: lead\n---\nBody.\n",
    "utf8"
  );

  writeFileSync(
    join(tycoonDir, "agent-keywords.json"),
    JSON.stringify({
      fallback_agent: "primary-agent",
      agents: {
        "coding-specialist": { pattern: "implement|code|fix|bug" },
        "search-retrieval": { pattern: "search|find|grep|glob" },
      },
    }),
    "utf8"
  );
}

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), "tycoon-enforcement-parity-"));
  writeFixtureRoster(root);
  return root;
}

function readActivity(projectRoot: string): Record<string, unknown>[] {
  const activityPath = join(projectRoot, ".claude", "tycoon", "activity.jsonl");
  if (!existsSync(activityPath)) return [];
  return readFileSync(activityPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// --- Claude hook driver (spawnSync, same idiom as test/tycoonClaudeHookSpawnGuard.test.ts) ---

function runHook(projectRoot: string, payload: unknown): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
  });
  assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);
  return { status: result.status, stdout: result.stdout };
}

// --- OpenCode plugin driver (in-memory transpile, same idiom as test/opencodePlugin.test.ts) ---

function compilePlugin(): { modulePath: string; moduleDir: string } {
  const moduleDir = mkdtempSync(join(tmpdir(), "tycoon-opencode-plugin-parity-"));
  const source = readFileSync(PLUGIN_SRC_PATH, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: "tycoon-opencode-plugin.ts",
  });
  const modulePath = join(moduleDir, "tycoon-opencode-plugin.js");
  writeFileSync(modulePath, output.outputText, "utf8");
  // The plugin resolves delegationEnforcement.js relative to its own
  // __dirname (see getDelegationEnforcementModule), so drop the real
  // compiled module next to the transpiled plugin, exactly as the installer
  // copies it next to the shipped .opencode/plugin/ file.
  writeFileSync(join(moduleDir, "delegationEnforcement.js"), readFileSync(DELEGATION_ENFORCEMENT_JS, "utf8"), "utf8");
  return { modulePath, moduleDir };
}

function requireFreshPlugin(): { mod: any } {
  const { modulePath } = compilePlugin();
  delete require.cache[require.resolve(modulePath)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(modulePath);
  return { mod };
}

function readPluginActivity(activityFile: string): Record<string, unknown>[] {
  if (!existsSync(activityFile)) return [];
  return readFileSync(activityFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Rule 1 (full parity): orchestrator direct Grep -> identical nudge message
// on both hosts. decideDirectToolCall is called by both with the SAME
// inputs, so the message text must be byte-identical.
// ---------------------------------------------------------------------------

test("Rule 1 [full parity]: orchestrator direct Grep produces the identical nudge message on the Claude hook and the OpenCode plugin", async () => {
  const root = setupProject();
  try {
    const { stdout } = runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Grep",
      tool_input: {},
      session_id: "rule1-session",
    });
    const hookParsed = JSON.parse(stdout);
    const hookMessage: string = hookParsed.additionalContext;
    assert.ok(hookMessage.includes("search-retrieval"));

    // Separate roster copy for the plugin side — the hook run above already
    // wrote its own activity.jsonl under `root`; reusing the same directory
    // would make the plugin append to the SAME file, and the "first match"
    // lookup below would silently find the hook's own record instead of the
    // plugin's.
    const pluginRoot = setupProject();
    const { mod } = requireFreshPlugin();
    const plugin = mod.createPlugin({ directory: pluginRoot, now: () => 1 });
    await plugin.toolExecuteBefore({ tool: "grep", sessionID: "rule1-session", args: {} });
    const records = readPluginActivity(plugin._paths.activityFile);
    const rec = records.find((r) => r.event === "PreToolUse" && r.workerId === "orchestrator");
    assert.ok(rec, "expected a plugin PreToolUse record for the orchestrator");

    assert.equal(rec!.message, hookMessage, "plugin nudge message must be byte-identical to the hook's");
    rmSync(pluginRoot, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rule 2 (full parity): a Task call with no explicit/resolvable
// subagent_type is keyword-routed identically on both hosts from the same
// description+prompt text.
// ---------------------------------------------------------------------------

test("Rule 2 [full parity]: task text with no explicit agent is keyword-routed to the SAME agent with the SAME matched keyword on both hosts", async () => {
  const root = setupProject();
  try {
    const description = "fix the parser bug";
    const prompt = "please implement a fix";

    const { stdout } = runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { description, prompt },
      session_id: "rule2-session",
    });
    assert.equal(stdout, "", "a plain keyword-routed spawn from the orchestrator produces no stdout output");
    const hookRecords = readActivity(root);
    const hookSpawn = hookRecords.find((r) => r.event === "PreToolUse" && r.tool === "Task");
    assert.ok(hookSpawn);
    assert.equal(hookSpawn!.routingMethod, "keyword");
    assert.equal(hookSpawn!.workerId, "coding-specialist");
    assert.equal(hookSpawn!.matchedKeyword, "implement");

    // Separate roster copy for the plugin side (see Rule 1's comment: same
    // directory would make the plugin append to the hook's own activity file).
    const pluginRoot2 = setupProject();
    const { mod } = requireFreshPlugin();
    const plugin = mod.createPlugin({ directory: pluginRoot2, now: () => 1 });
    await plugin.toolExecuteBefore({ tool: "task", sessionID: "rule2-session", args: { description, prompt } });
    const pluginRecords = readPluginActivity(plugin._paths.activityFile);
    const pluginSpawn = pluginRecords.find((r) => r.event === "PreToolUse" && r.tool === "Task");
    assert.ok(pluginSpawn);

    assert.equal(pluginSpawn!.routingMethod, hookSpawn!.routingMethod);
    assert.equal(pluginSpawn!.workerId, hookSpawn!.workerId);
    assert.equal(pluginSpawn!.matchedKeyword, hookSpawn!.matchedKeyword);

    // Cross-check both against the shared pure function directly, proving
    // the equivalence is not coincidental but IS the shared algorithm.
    const direct = matchAgentFromKeywords(
      `${description} ${prompt}`.toLowerCase(),
      JSON.parse(readFileSync(join(root, ".claude", "tycoon", "agent-keywords.json"), "utf8"))
    );
    assert.equal(direct!.agentId, "coding-specialist");
    assert.equal(direct!.matchedKeyword, "implement");
    rmSync(pluginRoot2, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rule 3 (logged-only parity): a leaf worker attempts to spawn. The Claude
// hook structurally BLOCKS it (stdout permissionDecision:"deny"); the
// OpenCode plugin cannot block tool.execute.before (see the plugin's own
// comment at the `task` guard) — it only logs a SpawnDenied-equivalent
// record. Both must use the identical LEAF_WORKER_DENY_MESSAGE text.
// ---------------------------------------------------------------------------

test("Rule 3 [enforcement parity: logged-only]: leaf-worker spawn attempt is BLOCKED by the Claude hook and LOGGED (not blocked) by the OpenCode plugin, with the identical deny message", async () => {
  const root = setupProject();
  try {
    const { stdout } = runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "coding-specialist", description: "do a thing" },
      agent_id: "spawned-worker-uuid",
      agent_type: "coding-specialist",
      session_id: "rule3-session",
    });
    const hookParsed = JSON.parse(stdout);
    assert.equal(hookParsed.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(hookParsed.hookSpecificOutput.permissionDecisionReason, LEAF_WORKER_DENY_MESSAGE);
    const hookRecords = readActivity(root);
    assert.ok(hookRecords.find((r) => r.event === "SpawnDenied"), "expected a Claude-hook SpawnDenied record");
    assert.equal(
      hookRecords.find((r) => r.event === "PreToolUse" && r.workerId === "coding-specialist"),
      undefined,
      "the Claude hook must not also produce a normal spawn record for a denied spawn"
    );

    // Drive the plugin's SAME scenario: first push "coding-specialist" onto
    // the active-agent stack (so the spawner is non-empty / a leaf, per the
    // plugin's depth-derivation rule), then attempt a nested task spawn from
    // that same session.
    const pluginRoot3 = setupProject();
    const { mod } = requireFreshPlugin();
    const plugin = mod.createPlugin({ directory: pluginRoot3, now: () => 1 });
    await plugin.toolExecuteBefore({
      tool: "task",
      sessionID: "rule3-parent-session",
      args: { subagent_type: "coding-specialist", description: "do a thing" },
    });
    await plugin.toolExecuteBefore({
      tool: "task",
      sessionID: "rule3-session", // nested call "from" the pushed worker
      args: { subagent_type: "coding-specialist", description: "leaf tries to spawn" },
    });

    const pluginRecords = readPluginActivity(plugin._paths.activityFile);
    const denial = pluginRecords.find((r) => r.event === "SpawnDenied");
    assert.ok(denial, "expected a plugin SpawnDenied record (logged-only — OpenCode's own permission deny-list is what actually blocks the call in production)");
    assert.equal(denial!.message, LEAF_WORKER_DENY_MESSAGE, "plugin's logged deny message must match the hook's exactly");

    // Unlike the Claude hook, the plugin's tool.execute.before has no
    // mechanism to prevent the nested `task` call from proceeding — it still
    // records a normal PreToolUse spawn record alongside the SpawnDenied log.
    // This IS the documented structural gap (see the plugin's own comment at
    // the guard) rather than a parity bug.
    const nestedSpawnStillLogged = pluginRecords.some(
      (r) => r.event === "PreToolUse" && r.tool === "Task" && r.sessionId === "rule3-session"
    );
    assert.ok(
      nestedSpawnStillLogged,
      "documents the structural gap: the plugin logs but cannot block the nested spawn (OpenCode's own permission deny-list is the actual blocker in production)"
    );
    rmSync(pluginRoot3, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rule 4 (logged-only parity): specialist finish -> auditor review requests
// changes -> fix -> re-review approves -> terminal, never advances further.
// The Claude hook (.cjs) has NO review-gate wiring of its own — CLAUDE.md's
// "Review pass" section is orchestrator PROMPT doctrine, not hook code (grep
// confirms no ReviewGate/startReviewGate/advanceReviewGate reference in
// hooks/tycoon-claude-hook.cjs). So the "Claude hook" side of this rule is
// the shared algorithm itself (src/core/delegationEnforcement.ts), called
// directly with the sequence a compliant orchestrator's prompt doctrine
// would drive; the OpenCode plugin side is the ACTUAL best-effort runtime
// wiring in hooks/tycoon-opencode-plugin.ts's toolExecuteAfter. Parity here
// means: the plugin's real wiring reaches the exact same terminal states, in
// the exact same order, as the shared state machine the hook's doctrine
// documents — never faking a "block" the hook doesn't structurally have.
// ---------------------------------------------------------------------------

test("Rule 4 [enforcement parity: logged-only]: one fix-and-recheck round reaches a terminal review-gate state, and never advances a third time, identically on the shared algorithm and the plugin's live wiring", async () => {
  const root = setupProject();
  try {
    // -- Shared-algorithm side (the doctrine hooks/tycoon-claude-hook.cjs
    // relies on the orchestrator's own prompt to follow, since the .cjs
    // itself never calls these functions) --
    let algoState = startReviewGate();
    algoState = advanceReviewGate(algoState, false); // auditor: changes requested
    assert.equal(algoState.status, "changes_requested");
    assert.equal(isReviewGateTerminal(algoState), false);
    algoState = advanceReviewGate(algoState, true); // fix applied, re-review approves
    assert.equal(algoState.status, "approved");
    assert.equal(isReviewGateTerminal(algoState), true);
    const algoReviewsRun = algoState.reviewsRun;

    // -- Plugin live-wiring side: coding-specialist finishes (arms
    // awaiting_review), uefn-auditor finishes with a rejection marker
    // (changes_requested), coding-specialist finishes again (gate left
    // alone, non-terminal), uefn-auditor finishes approving (approved).
    const { mod } = requireFreshPlugin();
    const plugin = mod.createPlugin({ directory: root, now: () => 1 });
    const parentSessionId = "rule4-parent-session";

    async function subagentStop(workerId: string, outputText: string) {
      await plugin.toolExecuteBefore({ tool: "task", sessionID: parentSessionId, args: { subagent_type: workerId } });
      await plugin.toolExecuteAfter(
        { tool: "task", sessionID: parentSessionId, args: { subagent_type: workerId } },
        { metadata: { parentSessionId, sessionId: `${workerId}-child` }, output: outputText }
      );
    }

    await subagentStop("coding-specialist", "Implemented the feature.");
    await subagentStop("uefn-auditor", "Changes requested: missing null check.");
    await subagentStop("coding-specialist", "Fixed the null check.");
    await subagentStop("uefn-auditor", "Approved, no further issues.");

    const gateRecords = readPluginActivity(plugin._paths.activityFile).filter((r) => r.event === "ReviewGate");
    assert.equal(gateRecords.length, 2, "expected exactly two ReviewGate transitions (reject, then approve)");
    assert.equal(gateRecords[0].reviewGateStatus, "changes_requested");
    assert.equal(gateRecords[1].reviewGateStatus, "approved");

    // Cross-host parity: same terminal status, same total review count.
    assert.equal(gateRecords[1].reviewGateStatus, algoState.status);
    assert.equal(algoReviewsRun, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Rule 4b [enforcement parity: logged-only]: two rejections in a row reach done_after_one_round and a THIRD auditor pass never advances the gate again", async () => {
  const root = setupProject();
  try {
    let algoState = startReviewGate();
    algoState = advanceReviewGate(algoState, false);
    algoState = advanceReviewGate(algoState, false); // second rejection -> terminal, stop cycling
    assert.equal(algoState.status, "done_after_one_round");
    assert.equal(isReviewGateTerminal(algoState), true);

    const { mod } = requireFreshPlugin();
    const plugin = mod.createPlugin({ directory: root, now: () => 1 });
    const parentSessionId = "rule4b-parent-session";

    async function subagentStop(workerId: string, outputText: string) {
      await plugin.toolExecuteBefore({ tool: "task", sessionID: parentSessionId, args: { subagent_type: workerId } });
      await plugin.toolExecuteAfter(
        { tool: "task", sessionID: parentSessionId, args: { subagent_type: workerId } },
        { metadata: { parentSessionId, sessionId: `${workerId}-child` }, output: outputText }
      );
    }

    await subagentStop("coding-specialist", "Implemented the feature.");
    await subagentStop("uefn-auditor", "Changes requested: missing test.");
    await subagentStop("coding-specialist", "Added a test, still not quite right.");
    await subagentStop("uefn-auditor", "Changes requested again: still not approved.");
    // A THIRD auditor pass for the same parent session must be a no-op —
    // the gate is already terminal and the doctrine forbids further cycling.
    await subagentStop("uefn-auditor", "Changes requested yet again.");

    const gateRecords = readPluginActivity(plugin._paths.activityFile).filter((r) => r.event === "ReviewGate");
    assert.equal(gateRecords.length, 2, "only the first two auditor passes should produce a ReviewGate transition; the third must be suppressed by isReviewGateTerminal");
    assert.equal(gateRecords[1].reviewGateStatus, "done_after_one_round");
    assert.equal(gateRecords[1].reviewGateStatus, algoState.status, "plugin's terminal status matches the shared algorithm's");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
