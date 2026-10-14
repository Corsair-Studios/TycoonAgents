/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Relay enforcement in hooks/tycoon-claude-hook.cjs (PreToolUse deny of file
 * edits until the provider is called / always in write mode, SubagentStop
 * warning) and the clean forwarded brief in src/core/agentRelay.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertToRelay,
  reconcileRelay,
  regenerateRelay,
  relayTargetFor,
  decideRelayToolCall,
  buildRelayBrief,
  RELAY_BRIEF_BEGIN,
  RELAY_BRIEF_END,
  RELAY_ORIGINAL_BEGIN,
  RELAY_ORIGINAL_HEADING_LEGACY,
  type RelayTarget,
} from "../src/core/agentRelay";

const REPO_ROOT = process.cwd();
const SESSION = "sess-relay";

const BODY =
  "\n# Coding Specialist\n\n## Role\nImplements code.\n\n## Keywords (for task routing)\nimplement|code\n\n## Working discipline\nYou are a LEAF. do the assigned task YOURSELF - reads, searches, and edits.\nReturn only once the files are written.\n\n## Team Notes\nUser extra: prefer small diffs.\n";
const ORIGINAL = `---\nname: coding-specialist\ndescription: "Implements code."\nmodel: sonnet\n---${BODY}`;

const target = (server: string, tool: string, kind: "workspace" | "text-only"): RelayTarget => ({
  agentId: "coding-specialist",
  server,
  tool,
  vendor: "openai",
  slotModel: "openai/gpt-6.1-sol",
  kind,
});
const CODEX = relayTargetFor("coding-specialist", { vendor: "openai", transport: "mcp", mcpServer: "codex", tools: ["codex"], model: "openai/gpt-6.1-sol" })!;
const CODEX_WRITE = relayTargetFor("coding-specialist", { vendor: "openai", transport: "mcp", mcpServer: "codex-write", tools: ["codex"], model: "openai/gpt-6.1-sol" })!;

function setup(agents: Record<string, string>): { root: string; hookPath: string } {
  const root = mkdtempSync(join(tmpdir(), "tycoon-relayenf-"));
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  mkdirSync(join(root, ".claude", "tycoon"), { recursive: true });
  for (const [id, text] of Object.entries(agents)) writeFileSync(join(root, ".claude", "agents", `${id}.md`), text);
  const hookDir = mkdtempSync(join(tmpdir(), "tycoon-relayenf-hook-"));
  const hookPath = join(hookDir, "tycoon-claude-hook.cjs");
  copyFileSync(join(REPO_ROOT, "hooks", "tycoon-claude-hook.cjs"), hookPath);
  for (const f of ["agentBackend.js", "modelAliases.js", "fallbackChain.js"]) {
    const src = join(REPO_ROOT, "out", "src", "core", f);
    if (existsSync(src)) copyFileSync(src, join(hookDir, f));
  }
  for (const f of ["bridge-result.cjs", "delegationEnforcement.js"]) copyFileSync(join(REPO_ROOT, "hooks", f), join(hookDir, f));
  return { root, hookPath };
}

function run(p: { root: string; hookPath: string }, payload: Record<string, unknown>): string {
  const r = spawnSync(process.execPath, [p.hookPath], {
    input: JSON.stringify({ session_id: SESSION, ...payload }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: p.root },
  });
  assert.equal(r.status, 0, `hook exited non-zero: ${r.stderr}`);
  return r.stdout;
}

function decision(out: string): { decision?: string; reason?: string } {
  if (!out.trim()) return {};
  const s = (JSON.parse(out) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput ?? {};
  return { decision: s.permissionDecision, reason: s.permissionDecisionReason };
}

function activity(root: string): Array<Record<string, unknown>> {
  const f = join(root, ".claude", "tycoon", "activity.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

const post = (tool: string, id = "run-1", resp: unknown = { content: [{ type: "text", text: "done" }] }, event = "PostToolUse") => ({
  hook_event_name: event,
  tool_name: tool,
  tool_input: {},
  tool_response: resp,
  agent_id: id,
  agent_type: "coding-specialist",
});

const sub = (tool: string, id = "run-1", type = "coding-specialist", extra: Record<string, unknown> = {}) => ({
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: { file_path: "x.txt" },
  agent_id: id,
  agent_type: type,
  ...extra,
});

function relayAgents(t: RelayTarget): Record<string, string> {
  return { "coding-specialist": convertToRelay(ORIGINAL, t)!, "plain-agent": "---\nname: plain-agent\nmodel: sonnet\n---\nbody\n" };
}

test("propose mode: Edit is denied before the provider call and allowed after", () => {
  const p = setup(relayAgents(CODEX));
  const before = decision(run(p, sub("Edit")));
  assert.equal(before.decision, "deny");
  assert.equal(before.reason, "relay agent must call its provider first");
  assert.equal(decision(run(p, sub("Write"))).decision, "deny");
  assert.equal(decision(run(p, sub("MultiEdit"))).decision, "deny");
  assert.equal(decision(run(p, sub("NotebookEdit"))).decision, "deny");
  // the provider call itself is allowed; only its successful response unlocks edits
  assert.equal(decision(run(p, sub("mcp__codex__codex"))).decision, undefined);
  assert.equal(decision(run(p, sub("Edit"))).decision, "deny", "attempted but not yet answered");
  run(p, post("mcp__codex__codex"));
  assert.equal(decision(run(p, sub("Edit"))).decision, undefined);
  // a different run of the same agent is still gated (keyed by run id, not agent name)
  assert.equal(decision(run(p, sub("Edit", "run-2"))).decision, "deny");
  // so is the same run id in a different session
  assert.equal(decision(run(p, { ...sub("Edit"), session_id: "other-session" })).decision, "deny");
});

test("propose mode: mcp__tycoon__delegate also counts as the provider call", () => {
  const p = setup(relayAgents(CODEX));
  assert.equal(decision(run(p, sub("mcp__tycoon__delegate"))).decision, undefined);
  run(p, post("mcp__tycoon__delegate"));
  assert.equal(decision(run(p, sub("Write"))).decision, undefined);
});

test("write mode: Edit is always denied, even after the provider call", () => {
  const p = setup(relayAgents(CODEX_WRITE));
  const d = decision(run(p, sub("Edit")));
  assert.equal(d.decision, "deny");
  assert.equal(d.reason, "the provider makes edits in write mode");
  run(p, sub("mcp__codex-write__codex"));
  run(p, post("mcp__codex-write__codex"));
  assert.equal(decision(run(p, sub("Edit"))).reason, "the provider makes edits in write mode");
  assert.equal(decision(run(p, sub("Write"))).decision, "deny");
});

test("Read, Grep and Glob are never denied for a relay; Bash and PowerShell always are", () => {
  for (const t of [CODEX, CODEX_WRITE]) {
    const p = setup(relayAgents(t));
    for (const tool of ["Read", "Grep", "Glob"]) assert.equal(decision(run(p, sub(tool))).decision, undefined, `${t.server} ${tool}`);
    run(p, sub(`mcp__${t.server}__${t.tool}`));
    run(p, post(`mcp__${t.server}__${t.tool}`));
    for (const tool of ["Bash", "PowerShell"]) {
      const d = decision(run(p, sub(tool)));
      assert.equal(d.decision, "deny", `${t.server} ${tool}`);
      assert.equal(d.reason, "relay agents do not run shell commands");
    }
  }
});

test("a failed provider call does not unlock edits; a later successful one does", () => {
  const p = setup(relayAgents(CODEX));
  run(p, sub("mcp__codex__codex"));
  run(p, post("mcp__codex__codex", "run-1", { isError: true, content: [{ type: "text", text: "boom" }] }));
  assert.equal(decision(run(p, sub("Edit"))).decision, "deny");
  run(p, post("mcp__codex__codex", "run-1", undefined, "PostToolUseFailure"));
  assert.equal(decision(run(p, sub("Edit"))).decision, "deny");
  const env = JSON.stringify({ tycoonBridge: 1, status: "timeout" });
  run(p, post("mcp__codex__codex", "run-1", { structuredContent: JSON.parse(env), content: [{ type: "text", text: env }] }));
  assert.equal(decision(run(p, sub("Edit"))).decision, "deny", "timeout envelope");
  run(p, post("mcp__codex__codex"));
  assert.equal(decision(run(p, sub("Edit"))).decision, undefined);
});

test("parallel relay runs keep separate state", () => {
  const p = setup(relayAgents(CODEX));
  const runs = ["a", "b", "c", "d"];
  for (const id of runs) run(p, sub("mcp__codex__codex", id));
  for (const id of ["a", "c"]) run(p, post("mcp__codex__codex", id));
  for (const id of runs) assert.equal(decision(run(p, sub("Edit", id))).decision, id === "a" || id === "c" ? undefined : "deny", id);
  const dir = join(p.root, ".claude", "tycoon", "relay-runs");
  assert.ok(existsSync(dir));
  // SubagentStop deletes that run's files
  run(p, { hook_event_name: "SubagentStop", agent_id: "a", agent_type: "coding-specialist" });
  assert.equal(decision(run(p, sub("Edit", "a"))).decision, "deny");
  assert.equal(decision(run(p, sub("Edit", "c"))).decision, undefined);
});

test("non-relay agents and the orchestrator are unaffected", () => {
  const p = setup(relayAgents(CODEX));
  assert.equal(decision(run(p, sub("Bash", "run-9", "plain-agent"))).decision, undefined);
  assert.equal(decision(run(p, sub("Edit", "run-9", "plain-agent"))).decision, undefined);
  assert.equal(decision(run(p, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "x" } })).decision, undefined);
});

test("fails open and logs once when the run state is unreadable", () => {
  const p = setup(relayAgents(CODEX));
  writeFileSync(join(p.root, ".claude", "tycoon", "relay-runs"), "a file where the state dir should be");
  assert.equal(decision(run(p, sub("Edit"))).decision, undefined);
  assert.equal(decision(run(p, sub("Edit"))).decision, undefined);
  const log = readFileSync(join(p.root, ".claude", "tycoon", "hook-warnings.log"), "utf8").split("\n").filter((l) => l.includes("relay enforcement failed open"));
  assert.equal(log.length, 1);
});

test("SubagentStop of a relay run with no provider call records relay_no_provider_call; a called run does not", () => {
  const p = setup(relayAgents(CODEX));
  run(p, sub("Read"));
  run(p, { hook_event_name: "SubagentStop", agent_id: "run-1", agent_type: "coding-specialist" });
  const warned = activity(p.root).filter((r) => r.kind === "relay_no_provider_call");
  assert.equal(warned.length, 1);
  assert.equal(warned[0].event, "ProviderError");
  assert.equal(warned[0].workerId, "coding-specialist");

  run(p, sub("mcp__codex__codex", "run-3"));
  run(p, { hook_event_name: "SubagentStop", agent_id: "run-3", agent_type: "coding-specialist" });
  assert.equal(activity(p.root).filter((r) => r.kind === "relay_no_provider_call").length, 1);
});

test("hook decision matches decideRelayToolCall for every case", () => {
  for (const t of [CODEX, CODEX_WRITE, target("claude-cli", "claude", "workspace"), target("gemini", "ask-gemini", "text-only")]) {
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Grep", "Glob", "Bash", "PowerShell"]) {
      for (const called of [false, true]) {
        const p = setup(relayAgents(t));
        if (called) {
          run(p, sub(`mcp__${t.server}__${t.tool}`));
          run(p, post(`mcp__${t.server}__${t.tool}`));
        }
        const hook = decision(run(p, sub(tool)));
        const core = decideRelayToolCall({ server: t.server, toolName: tool, providerCalled: called });
        assert.equal(hook.decision === "deny", !core.allow, `${t.server} ${tool} called=${called}`);
        if (!core.allow) assert.equal(hook.reason, core.reason);
      }
    }
  }
});

test("forwarded brief omits Working discipline, keeps Role, Keywords and user sections", () => {
  const relayed = convertToRelay(ORIGINAL, CODEX)!;
  const brief = relayed.slice(relayed.indexOf(RELAY_BRIEF_BEGIN) + RELAY_BRIEF_BEGIN.length, relayed.indexOf(RELAY_BRIEF_END));
  assert.match(brief, /## Role\nImplements code\./);
  assert.match(brief, /## Keywords \(for task routing\)/);
  assert.match(brief, /## Team Notes\nUser extra: prefer small diffs\./);
  assert.doesNotMatch(brief, /Working discipline|LEAF|YOURSELF|files are written/);
  // the full original is still preserved verbatim for revert
  assert.ok(relayed.slice(relayed.indexOf(RELAY_ORIGINAL_BEGIN)).includes("do the assigned task YOURSELF"));
  assert.equal(reconcileRelay(relayed, null), ORIGINAL);
  assert.equal(buildRelayBrief("## Working discipline\nx\n"), "");
  assert.equal(buildRelayBrief("## Role\nr\n\n##   WORKING   Discipline  \nx\n\n## Notes\nn\n"), "## Role\nr\n\n## Notes\nn");
  assert.equal(reconcileRelay(relayed, null), ORIGINAL, "revert is byte-identical");
});

test("CRLF files get the brief too and still revert byte-identically", () => {
  const crlf = ORIGINAL.replace(/\n/g, "\r\n");
  const relayed = convertToRelay(crlf, CODEX)!;
  assert.doesNotMatch(relayed.replace(/\r\n/g, "\n").slice(relayed.indexOf(RELAY_BRIEF_BEGIN), relayed.indexOf(RELAY_BRIEF_END)), /LEAF/);
  assert.equal(reconcileRelay(relayed, null), crlf);
});

test("Save regenerates an old 0.0.743 relay: new brief block and heading, revert still exact", () => {
  const fresh = convertToRelay(ORIGINAL, CODEX)!;
  // Rebuild what 0.0.743 wrote: no brief block, legacy heading.
  const legacy = fresh
    .replace(/\n### Brief to forward[\s\S]*?<!-- tycoon:relay-brief:end -->/, "")
    .replace("## Original instructions (kept for revert, not forwarded)", RELAY_ORIGINAL_HEADING_LEGACY);
  assert.ok(!legacy.includes(RELAY_BRIEF_BEGIN));
  const healed = regenerateRelay(legacy, CODEX)!;
  assert.ok(healed.includes(RELAY_BRIEF_BEGIN));
  assert.ok(!healed.includes(RELAY_ORIGINAL_HEADING_LEGACY));
  assert.equal(reconcileRelay(healed, null), ORIGINAL);
});
