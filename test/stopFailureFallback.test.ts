/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * StopFailure: a Claude Code subagent killed by an API error (weekly/usage
 * limit, model_not_found...) must be recorded, marked stopped, and routed to
 * its fallback, with guidance reaching the orchestrator once. Drives the real
 * hook as a child process (same pattern as fallbackChainClaudeHook.test.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEvent, initialWorldState } from "../src/core/state";
import { mapHookRecord } from "../src/providers/claude-code/mapHookRecord";
import { addMissingAutoHealSlots, TYCOON_HOOK_SLOTS } from "../src/host/vscode/hookInstall";

const HOOK_PATH = join(process.cwd(), "hooks", "tycoon-claude-hook.cjs");
const SESSION = "sess-stopfailure";

function makeProject(routing?: Record<string, unknown>, settings?: Record<string, unknown>): { root: string; cfg: string } {
  const root = mkdtempSync(join(tmpdir(), "tycoon-stopfail-"));
  mkdirSync(join(root, ".claude", "tycoon"), { recursive: true });
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  writeFileSync(join(root, ".claude", "agents", "coding-specialist.md"), "---\nname: coding-specialist\nmodel: sonnet\n---\nbody\n");
  if (routing) writeFileSync(join(root, ".claude", "tycoon", "routing.json"), JSON.stringify(routing));
  if (settings) writeFileSync(join(root, ".claude", "settings.local.json"), JSON.stringify(settings));
  const cfg = mkdtempSync(join(tmpdir(), "tycoon-stopfail-cfg-"));
  return { root, cfg };
}

function run(proj: { root: string; cfg: string }, payload: Record<string, unknown>): string {
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ session_id: SESSION, ...payload }),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: proj.root,
      CLAUDE_CONFIG_DIR: proj.cfg,
      TYCOON_MANAGED_SETTINGS_DIR: join(proj.cfg, "no-managed"),
    },
  });
  assert.equal(r.status, 0, `hook exited non-zero: ${r.stderr}`);
  return r.stdout;
}

function activity(root: string): Array<Record<string, unknown>> {
  const f = join(root, ".claude", "tycoon", "activity.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function spawnCodingSpecialist(proj: { root: string; cfg: string }): string {
  return run(proj, {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    permission_mode: "default",
    tool_input: { subagent_type: "coding-specialist", description: "do thing", prompt: "x" },
  });
}

const WEEKLY = "You've hit your weekly limit · resets 12am (America/Los_Angeles)";

function stopFailure(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    hook_event_name: "StopFailure",
    agent_id: "a1b2c3",
    agent_type: "coding-specialist",
    error: "rate_limit",
    last_assistant_message: WEEKLY,
    ...extra,
  };
}

test("subagent weekly limit: records stop + fallback and guides the orchestrator once", () => {
  const proj = makeProject({ agents: { "coding-specialist": { fallback: [{ vendor: "anthropic", model: "opus" }] } } });
  spawnCodingSpecialist(proj);
  const out = run(proj, stopFailure({}));
  assert.equal(out, "", "StopFailure is notification-only: no stdout");

  const recs = activity(proj.root);
  const stop = recs.find((r) => r.event === "StopFailure");
  assert.ok(stop, "StopFailure record written");
  assert.equal(stop.workerId, "coding-specialist");
  assert.equal(stop.reason, "quota");
  assert.ok(typeof stop.spawnId === "string" && stop.spawnId, "dead spawn id carried so the panel releases it");
  assert.ok(recs.some((r) => r.event === "ProviderError" && r.workerId === "coding-specialist"));
  const fb = recs.find((r) => r.event === "FallbackTriggered");
  assert.ok(fb, "FallbackTriggered written");
  assert.equal(fb.nextModel, "opus");
  assert.match(String(fb.reason), /weekly limit/);
  assert.match(String(fb.reason), /resets 12am/);

  const prompt = run(proj, { hook_event_name: "UserPromptSubmit", prompt: "go on" });
  const ctx = JSON.parse(prompt).hookSpecificOutput.additionalContext as string;
  assert.match(ctx, /coding-specialist/);
  assert.match(ctx, /weekly limit/);
  assert.match(ctx, /resets 12am/);
  assert.match(ctx, /model parameter set to "opus"/);

  assert.equal(run(proj, { hook_event_name: "UserPromptSubmit", prompt: "again" }), "", "guidance delivered only once");
});

test("guidance also reaches the orchestrator via PostToolUse Task|Agent and PreToolUse", () => {
  const proj = makeProject({ agents: { "coding-specialist": { fallback: [{ vendor: "anthropic", model: "haiku" }] } } });
  spawnCodingSpecialist(proj);
  run(proj, stopFailure({}));
  const post = run(proj, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: {} });
  assert.match(JSON.parse(post).hookSpecificOutput.additionalContext, /"haiku"/);

  spawnCodingSpecialist(proj);
  run(proj, stopFailure({}));
  const pre = run(proj, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "x" } });
  assert.match(JSON.parse(pre).hookSpecificOutput.additionalContext, /coding-specialist/);
});

test("a subagent's own hook calls never consume the orchestrator's guidance", () => {
  const proj = makeProject({ agents: { "coding-specialist": { fallback: [{ vendor: "anthropic", model: "opus" }] } } });
  spawnCodingSpecialist(proj);
  run(proj, stopFailure({}));
  assert.equal(run(proj, { hook_event_name: "UserPromptSubmit", agent_id: "other" }), "");
  assert.match(run(proj, { hook_event_name: "UserPromptSubmit" }), /coding-specialist/);
});

test("model_not_found with no chain: plain report-to-user guidance, kind not_found", () => {
  const proj = makeProject();
  spawnCodingSpecialist(proj);
  run(proj, stopFailure({ error: "model_not_found", last_assistant_message: "There's an issue with the selected model (claude-x). It may not exist." }));
  const pe = activity(proj.root).find((r) => r.event === "ProviderError");
  assert.ok(pe);
  assert.equal(pe.reason, "not_found");
  const ctx = JSON.parse(run(proj, { hook_event_name: "UserPromptSubmit" })).hookSpecificOutput.additionalContext as string;
  assert.match(ctx, /coding-specialist/);
  assert.match(ctx, /exhausted|report/i);
});

test("main-session StopFailure is recorded only: no fallback, no guidance", () => {
  const proj = makeProject({ agents: { "coding-specialist": { fallback: [{ vendor: "anthropic", model: "opus" }] } } });
  run(proj, { hook_event_name: "StopFailure", error: "rate_limit", last_assistant_message: WEEKLY });
  const recs = activity(proj.root);
  const stop = recs.find((r) => r.event === "StopFailure");
  assert.ok(stop);
  assert.equal(stop.workerId, "orchestrator");
  assert.match(String(stop.message), /Orchestrator hit its limit/);
  assert.match(String(stop.message), /resets 12am/);
  assert.ok(!recs.some((r) => r.event === "FallbackTriggered" || r.event === "ProviderError"));
  assert.equal(run(proj, { hook_event_name: "UserPromptSubmit" }), "");
});

test("anthropic fallback re-dispatch gets model via updatedInput only when Agent is already allowed", () => {
  const routing = { agents: { "coding-specialist": { fallback: [{ vendor: "anthropic", model: "opus" }] } } };

  const allowed = makeProject(routing, { permissions: { allow: ["Agent"] } });
  spawnCodingSpecialist(allowed);
  run(allowed, stopFailure({}));
  const out = JSON.parse(spawnCodingSpecialist(allowed)).hookSpecificOutput;
  assert.equal(out.permissionDecision, "allow");
  assert.equal(out.updatedInput.model, "opus");
  assert.equal(out.updatedInput.subagent_type, "coding-specialist");
  assert.equal(out.additionalContext, undefined, "re-dispatching agent's own guidance is dropped, not repeated");

  const notAllowed = makeProject(routing);
  spawnCodingSpecialist(notAllowed);
  run(notAllowed, stopFailure({}));
  assert.equal(spawnCodingSpecialist(notAllowed), "", "no allow rule: no decision, no input change");

  const managed = makeProject(routing, { permissions: { allow: ["Agent"] } });
  mkdirSync(join(managed.cfg, "no-managed"), { recursive: true });
  writeFileSync(join(managed.cfg, "no-managed", "managed-settings.json"), "{}");
  spawnCodingSpecialist(managed);
  run(managed, stopFailure({}));
  assert.equal(spawnCodingSpecialist(managed), "", "managed policy present: never inject");
});

test("mapHookRecord: StopFailure releases a subagent's spawn and flags the error", () => {
  const events = mapHookRecord({ event: "StopFailure", workerId: "coding-specialist", spawnId: "s1", message: "m", at: 1 });
  assert.deepEqual(events.map((e) => e.type), ["WorkerStopped", "ProviderError"]);
  assert.ok(!events.some((e) => e.type === "TaskCompleted"));
  const main = mapHookRecord({ event: "StopFailure", workerId: "orchestrator", message: "Orchestrator hit its limit", at: 1 });
  assert.deepEqual(main.map((e) => e.type), ["ProviderError"]);
});

test("StopFailure slot is registered and added to existing installs by the heal", () => {
  assert.ok(TYCOON_HOOK_SLOTS.some((s) => s.event === "StopFailure"));
  const old = { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: 'node "/x/tycoon-claude-hook.cjs"' }] }] } };
  const healed = addMissingAutoHealSlots(old);
  assert.equal(healed.changed, true);
  const list = (healed.settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).StopFailure;
  assert.equal(list.length, 1);
  assert.equal(list[0].hooks[0].command, 'node "/x/tycoon-claude-hook.cjs"');
  assert.equal(addMissingAutoHealSlots(healed.settings).changed, false, "idempotent");
  const foreign = { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "other.sh" }] }] } };
  assert.equal(addMissingAutoHealSlots(foreign).changed, false, "never adds to a project without our hook");
});

test("StopFailure -> Stop -> next-turn re-dispatch still gets fallbackOf and the model swap", () => {
  const proj = makeProject({ agents: { "coding-specialist": { fallback: [{ vendor: "anthropic", model: "opus" }] } } }, { permissions: { allow: ["Agent"] } });
  spawnCodingSpecialist(proj);
  run(proj, stopFailure({}));
  run(proj, { hook_event_name: "Stop" });
  const out = JSON.parse(spawnCodingSpecialist(proj)).hookSpecificOutput;
  assert.equal(out.updatedInput.model, "opus");
  const spawn = activity(proj.root).filter((r) => r.event === "PreToolUse" && r.tool === "Agent").pop();
  assert.equal(spawn?.fallbackOf, "coding-specialist");
  // a successful SubagentStop for that worker clears the carried fallback
  run(proj, { hook_event_name: "SubagentStop", agent_type: "coding-specialist" });
  run(proj, { hook_event_name: "Stop" });
  assert.equal(JSON.parse(readFileSync(join(proj.root, ".claude", "tycoon", "fallback-state.json"), "utf8"))[SESSION], undefined);
});

test("parallel StopFailure events from two subagents both keep their guidance", async () => {
  const proj = makeProject({ agents: { "coding-specialist": { fallback: [{ vendor: "anthropic", model: "opus" }] } } });
  writeFileSync(join(proj.root, ".claude", "agents", "testing-specialist.md"), "---\nname: testing-specialist\nmodel: sonnet\n---\nbody\n");
  const env = { ...process.env, CLAUDE_PROJECT_DIR: proj.root, CLAUDE_CONFIG_DIR: proj.cfg, TYCOON_MANAGED_SETTINGS_DIR: join(proj.cfg, "no-managed") };
  const { spawn } = await import("node:child_process");
  const fire = (agentType: string): Promise<void> =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [HOOK_PATH], { env });
      c.on("close", () => resolve());
      c.stdin.end(JSON.stringify({ session_id: SESSION, ...stopFailure({ agent_type: agentType, agent_id: agentType }) }));
    });
  for (let i = 0; i < 4; i++) {
    await Promise.all([fire("coding-specialist"), fire("testing-specialist")]);
  }
  const ctx = JSON.parse(run(proj, { hook_event_name: "UserPromptSubmit" })).hookSpecificOutput.additionalContext as string;
  assert.match(ctx, /agent coding-specialist/);
  assert.match(ctx, /agent testing-specialist/);
  assert.equal((ctx.match(/agent coding-specialist/g) ?? []).length, 4, "no queued entry was lost");
  assert.equal((ctx.match(/agent testing-specialist/g) ?? []).length, 4);
});

test("exhausted/empty chain emits ProviderError but no FallbackTriggered", () => {
  const proj = makeProject();
  spawnCodingSpecialist(proj);
  run(proj, stopFailure({}));
  const recs = activity(proj.root);
  assert.ok(recs.some((r) => r.event === "ProviderError"));
  assert.ok(!recs.some((r) => r.event === "FallbackTriggered"));
});

test("state: ProviderError keeps an agent active while another spawn is live, errors it when none are", () => {
  let st = applyEvent(initialWorldState(), { type: "WorkerSpawned", at: 1, workerId: "w", spawnId: "s1" });
  st = applyEvent(st, { type: "WorkerSpawned", at: 2, workerId: "w", spawnId: "s2" });
  st = applyEvent(st, { type: "WorkerStopped", at: 3, workerId: "w", spawnId: "s1" });
  st = applyEvent(st, { type: "ProviderError", at: 3, workerId: "w", message: "m" });
  assert.equal(st.agentMetrics.find((m) => m.id === "w")?.status, "active");
  st = applyEvent(st, { type: "WorkerStopped", at: 4, workerId: "w", spawnId: "s2" });
  st = applyEvent(st, { type: "ProviderError", at: 4, workerId: "w", message: "m" });
  assert.equal(st.agentMetrics.find((m) => m.id === "w")?.status, "error");
});
