/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * No-dispatcher fallback from INSIDE a subagent: a provider failure of a
 * vendor MCP tool must tell the subagent to stop (it cannot spawn agents),
 * queue re-dispatch guidance for the parent (delivered by the next
 * PostToolUse Agent result), name an agent that can reach the fallback, not
 * double-consume the chain on a repeated failure, and not double the vendor
 * prefix / error kind in the message. Fakes are plain JSON payloads.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const SESSION = "sess-subagent-fb";

function setup(opts: { chain?: Array<Record<string, unknown>>; extraAgents?: Record<string, string> } = {}): { root: string; hookPath: string } {
  const root = mkdtempSync(join(tmpdir(), "tycoon-subfb-"));
  const agents = join(root, ".claude", "agents");
  mkdirSync(agents, { recursive: true });
  mkdirSync(join(root, ".claude", "tycoon"), { recursive: true });
  writeFileSync(
    join(agents, "gemini-reviewer.md"),
    "---\nname: gemini-reviewer\nmodel: haiku\ndisallowedTools: Agent\nbackend:\n  vendor: google\n  transport: mcp\n  mcpServer: gemini\n  tools: [ask-gemini]\n  model: google/gemini-2.5-pro\n  costModelClass: metered\n---\nbody\n",
  );
  writeFileSync(
    join(agents, "codex-reviewer.md"),
    "---\nname: codex-reviewer\nmodel: haiku\nbackend:\n  vendor: openai\n  transport: mcp\n  mcpServer: codex\n  tools: [codex]\n  model: openai/gpt-5.6-sol\n  costModelClass: metered\n---\nbody\n",
  );
  writeFileSync(
    join(root, ".claude", "tycoon", "routing.json"),
    JSON.stringify({
      agents: {
        "gemini-reviewer": {
          vendor: "google",
          model: "google/gemini-2.5-pro",
          transport: "mcp",
          mcpServer: "gemini",
          fallback: opts.chain ?? [{ vendor: "openai", model: "openai/gpt-5.6-sol", transport: "mcp", mcpServer: "codex" }],
        },
      },
    }),
  );
  for (const [id, body] of Object.entries(opts.extraAgents ?? {})) writeFileSync(join(agents, `${id}.md`), body);
  // Scratch hook dir with the runtime modules next to it (they are build artifacts).
  const hookDir = mkdtempSync(join(tmpdir(), "tycoon-subfb-hook-"));
  const hookPath = join(hookDir, "tycoon-claude-hook.cjs");
  copyFileSync(join(REPO_ROOT, "hooks", "tycoon-claude-hook.cjs"), hookPath);
  for (const f of ["agentBackend.js", "modelAliases.js"]) copyFileSync(join(REPO_ROOT, "out", "src", "core", f), join(hookDir, f));
  copyFileSync(join(REPO_ROOT, "out", "src", "core", "fallbackChain.js"), join(hookDir, "fallbackChain.js"));
  for (const f of ["bridge-result.cjs", "delegationEnforcement.js"]) {
    const src = join(REPO_ROOT, "hooks", f);
    if (existsSync(src)) copyFileSync(src, join(hookDir, f));
  }
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

function ctx(out: string): string {
  if (!out.trim()) return "";
  return (JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
}

function activity(root: string): Array<Record<string, unknown>> {
  const f = join(root, ".claude", "tycoon", "activity.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

const failure = (extra: Record<string, unknown> = {}) => ({
  hook_event_name: "PostToolUseFailure",
  tool_name: "mcp__gemini__ask-gemini",
  error: "Request timed out: RESOURCE_EXHAUSTED quota",
  ...extra,
});

test("subagent failure: subagent is told to stop, parent guidance queued and delivered on a successful Agent result naming codex-reviewer", () => {
  const p = setup();
  const sub = ctx(run(p, failure({ agent_id: "a1", agent_type: "gemini-reviewer" })));
  assert.match(sub, /Do not retry this tool or the same provider/);
  assert.match(sub, /provider-unavailable/);
  assert.doesNotMatch(sub, /google\/google\//);
  assert.doesNotMatch(sub, /timeout\/timeout/);

  const state = JSON.parse(readFileSync(join(p.root, ".claude", "tycoon", "fallback-state.json"), "utf8"));
  assert.equal(state[SESSION]["gemini-reviewer"].attemptsSoFar, 1);
  assert.equal(state.__pending[SESSION].length, 1);

  const fb = activity(p.root).filter((r) => r.event === "FallbackTriggered");
  assert.equal(fb.length, 1);
  assert.equal(fb[0].workerId, "gemini-reviewer");

  // Successful Agent result in the parent session consumes the pending guidance.
  const parent = ctx(run(p, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_response: { ok: true } }));
  assert.match(parent, /Re-dispatch the same task to codex-reviewer/);
  assert.match(parent, /gemini-reviewer's fallback/);
  assert.doesNotMatch(parent, /google\/google\//);
  const after = JSON.parse(readFileSync(join(p.root, ".claude", "tycoon", "fallback-state.json"), "utf8"));
  assert.equal(after.__pending[SESSION], undefined);
});

test("agent_type alone (no agent_id) is detected as subagent context", () => {
  const p = setup();
  const sub = ctx(run(p, failure({ agent_type: "gemini-reviewer" })));
  assert.match(sub, /Do not retry this tool/);
});

test("repeated failure of the same provider/model does not consume the next fallback step or re-queue guidance", () => {
  const p = setup();
  run(p, failure({ agent_id: "a1", agent_type: "gemini-reviewer" }));
  const second = ctx(run(p, failure({ agent_id: "a1", agent_type: "gemini-reviewer" })));
  assert.match(second, /Do not retry this tool/);
  assert.doesNotMatch(second, /exhausted/);
  const state = JSON.parse(readFileSync(join(p.root, ".claude", "tycoon", "fallback-state.json"), "utf8"));
  assert.equal(state[SESSION]["gemini-reviewer"].attemptsSoFar, 1);
  assert.equal(state.__pending[SESSION].length, 1);
  assert.equal(activity(p.root).filter((r) => r.event === "FallbackTriggered").length, 1);
  const parent = ctx(run(p, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_response: "done" }));
  assert.match(parent, /codex-reviewer/);
  assert.doesNotMatch(parent, /exhausted/);
});

test("PostToolUse isError backstop in a subagent behaves like PostToolUseFailure", () => {
  const p = setup();
  const sub = ctx(
    run(p, {
      hook_event_name: "PostToolUse",
      tool_name: "mcp__gemini__ask-gemini",
      agent_id: "a2",
      agent_type: "gemini-reviewer",
      tool_response: { isError: true, content: [{ type: "text", text: "429 RESOURCE_EXHAUSTED quota" }] },
    }),
  );
  assert.match(sub, /Do not retry this tool or the same provider/);
  const state = JSON.parse(readFileSync(join(p.root, ".claude", "tycoon", "fallback-state.json"), "utf8"));
  assert.equal(state.__pending[SESSION].length, 1);
});

test("without another reachable agent the parent keeps the same-agent wording", () => {
  const p = setup();
  // Remove codex-reviewer so nothing can reach the fallback slot.
  writeFileSync(join(p.root, ".claude", "agents", "codex-reviewer.md"), "---\nname: codex-reviewer\nmodel: haiku\n---\nbody\n");
  run(p, failure({ agent_id: "a1", agent_type: "gemini-reviewer" }));
  const parent = ctx(run(p, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_response: "done" }));
  assert.match(parent, /Re-dispatch the same task to gemini-reviewer;/);
});

test("orchestrator context is unchanged: advances each failure, no pending queue, no doubled prefix", () => {
  const p = setup();
  const first = ctx(run(p, failure()));
  assert.match(first, /Re-dispatch the same task to gemini-reviewer; the next provider in its fallback chain is openai\/gpt-5\.6-sol/);
  assert.doesNotMatch(first, /google\/google\//);
  const second = ctx(run(p, failure()));
  assert.match(second, /exhausted/);
  const state = JSON.parse(readFileSync(join(p.root, ".claude", "tycoon", "fallback-state.json"), "utf8"));
  assert.equal(state.__pending, undefined);
});

const agentMd = (id: string, server: string, vendor: string, model: string) =>
  `---
name: ${id}
model: haiku
backend:
  vendor: ${vendor}
  transport: mcp
  mcpServer: ${server}
  tools: [x]
  model: ${model}
  costModelClass: metered
---
body
`;
const readState = (root: string) => JSON.parse(readFileSync(join(root, ".claude", "tycoon", "fallback-state.json"), "utf8"));

test("(a) non-subagent failure keeps the status/kind reason text unchanged", () => {
  const p = setup();
  const out = ctx(run(p, { hook_event_name: "PostToolUseFailure", tool_name: "mcp__gemini__ask-gemini", error: "RESOURCE_EXHAUSTED quota" }));
  assert.match(out, /Re-dispatch the same task to gemini-reviewer;/);
  const rec = activity(p.root).find((r) => r.event === "FallbackTriggered");
  assert.ok(rec);
  assert.equal(rec!.reason, "RESOURCE_EXHAUSTED quota");
});

test("(b) a separate later task (new agent_id) after delivery to another agent starts a fresh chain and queues again", () => {
  const two = [
    { vendor: "openai", model: "openai/gpt-5.6-sol", transport: "mcp", mcpServer: "codex" },
    { vendor: "moonshot", model: "moonshot/kimi-k2", transport: "mcp", mcpServer: "kimi" },
  ];
  const p = setup({ chain: two });
  run(p, failure({ agent_id: "a1", agent_type: "gemini-reviewer" }));
  const first = ctx(run(p, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_response: "done" }));
  assert.match(first, /codex-reviewer/);
  assert.equal(readState(p.root)[SESSION]?.["gemini-reviewer"], undefined);
  const sub = ctx(run(p, failure({ agent_id: "a2", agent_type: "gemini-reviewer" })));
  assert.match(sub, /orchestrator will re-dispatch/);
  const st = readState(p.root);
  assert.equal(st[SESSION]["gemini-reviewer"].attemptsSoFar, 1);
  assert.equal(st.__pending[SESSION].length, 1);
  assert.equal(activity(p.root).filter((r) => r.event === "FallbackTriggered").length, 2);
});

test("(b2) same agent_id failing again after its guidance was consumed re-queues guidance", () => {
  const p = setup();
  run(p, failure({ agent_id: "a1", agent_type: "gemini-reviewer" }));
  run(p, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_response: "done" });
  run(p, failure({ agent_id: "a1", agent_type: "gemini-reviewer" }));
  assert.equal(readState(p.root).__pending[SESSION].length, 1);
});

test("(c) two concurrent subagents failing both record and queue guidance without lost updates", () => {
  const p = setup();
  run(p, failure({ agent_id: "a1", agent_type: "gemini-reviewer" }));
  run(p, failure({ agent_id: "a2", agent_type: "gemini-reviewer" }));
  const st = readState(p.root);
  assert.equal(st[SESSION]["gemini-reviewer"].attemptsSoFar, 2);
  assert.equal(st.__pending[SESSION].length, 2);
});

test("(d1) agent with the right vendor but a different mcpServer is not named", () => {
  const p = setup({ extraAgents: { "codex-reviewer": agentMd("codex-reviewer", "other", "openai", "openai/gpt-5.6-sol") } });
  run(p, failure({ agent_id: "a1", agent_type: "gemini-reviewer" }));
  const parent = ctx(run(p, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_response: "done" }));
  assert.match(parent, /Re-dispatch the same task to gemini-reviewer;/);
});

test("(d2) another agent bound to the already-failed mcpServer is excluded", () => {
  const p = setup({
    chain: [{ vendor: "google", model: "google/gemini-2.5-flash", transport: "mcp", mcpServer: "gemini" }],
    extraAgents: { "gemini-second": agentMd("gemini-second", "gemini", "google", "google/gemini-2.5-flash") },
  });
  run(p, failure({ agent_id: "a1", agent_type: "gemini-reviewer" }));
  const parent = ctx(run(p, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_response: "done" }));
  assert.doesNotMatch(parent, /gemini-second/);
});

test("(d3) slot without mcpServer falls back to a same-vendor, same-transport agent", () => {
  const p = setup({ chain: [{ vendor: "openai", model: "openai/gpt-5.6-sol", transport: "mcp" }] });
  run(p, failure({ agent_id: "a1", agent_type: "gemini-reviewer" }));
  const parent = ctx(run(p, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_response: "done" }));
  assert.match(parent, /Re-dispatch the same task to codex-reviewer/);
});

test("(e) redispatch to a different agent resets the slot's attempts on delivery: a later unrelated failure is not exhausted", () => {
  const p = setup();
  run(p, failure({ agent_id: "a1", agent_type: "gemini-reviewer" }));
  run(p, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_response: "done" });
  assert.equal(readState(p.root)[SESSION]?.["gemini-reviewer"], undefined);
  run(p, failure({ agent_id: "a2", agent_type: "gemini-reviewer" }));
  const parent = ctx(run(p, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_response: "done" }));
  assert.match(parent, /Re-dispatch the same task to codex-reviewer/);
  assert.doesNotMatch(parent, /exhausted/);
});

test("(f) same-agent wording keeps attempts on delivery and resets on the slot's next successful call", () => {
  const p = setup({ extraAgents: { "codex-reviewer": "---\nname: codex-reviewer\nmodel: haiku\n---\nbody\n" } });
  run(p, failure({ agent_id: "a1", agent_type: "gemini-reviewer" }));
  // The failed run's own clean-looking stop must not reset while guidance is pending.
  run(p, { hook_event_name: "SubagentStop", agent_type: "gemini-reviewer", agent_id: "a1" });
  assert.equal(readState(p.root)[SESSION]["gemini-reviewer"].attemptsSoFar, 1);
  run(p, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_response: "done" });
  assert.equal(readState(p.root)[SESSION]["gemini-reviewer"].attemptsSoFar, 1);
  run(p, { hook_event_name: "PostToolUse", tool_name: "mcp__gemini__ask-gemini", tool_response: "fine result", agent_id: "a3", agent_type: "gemini-reviewer" });
  assert.equal(readState(p.root)[SESSION]?.["gemini-reviewer"], undefined);
});

test("(g) cross-agent re-dispatch: the codex-reviewer spawn is tagged fallbackOf gemini-reviewer once, then spawns normally", () => {
  const p = setup();
  run(p, failure({ agent_id: "a1", agent_type: "gemini-reviewer" }));
  run(p, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_response: { ok: true } }); // guidance delivered
  const spawn = () => run(p, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "codex-reviewer", description: "review", prompt: "review cart.js" } });
  spawn();
  spawn();
  const spawns = activity(p.root).filter((r) => r.event === "PreToolUse" && r.tool === "Agent" && r.workerId === "codex-reviewer");
  assert.equal(spawns.length, 2);
  assert.equal(spawns[0].fallbackOf, "gemini-reviewer");
  assert.equal(spawns[0].fallbackDepth, 1);
  assert.equal(spawns[0].fallbackModel, "openai/gpt-5.6-sol");
  assert.equal(spawns[1].fallbackOf, undefined);
});

test("(h) a codex-reviewer spawn with no pending cross-agent re-dispatch is not tagged", () => {
  const p = setup();
  run(p, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "codex-reviewer", description: "review", prompt: "x" } });
  const spawns = activity(p.root).filter((r) => r.event === "PreToolUse" && r.tool === "Agent");
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].fallbackOf, undefined);
});

test("(i) an unrelated spawn neither consumes the mark nor gets fallbackOf; the target still gets tagged after", () => {
  const p = setup();
  run(p, failure({ agent_id: "a1", agent_type: "gemini-reviewer" }));
  run(p, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_response: { ok: true } });
  run(p, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "search-retrieval", description: "find", prompt: "x" } });
  run(p, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "codex-reviewer", description: "review", prompt: "x" } });
  const spawns = activity(p.root).filter((r) => r.event === "PreToolUse" && r.tool === "Agent");
  assert.equal(spawns[0].fallbackOf, undefined);
  assert.equal(spawns[1].fallbackOf, "gemini-reviewer");
});

test("(j) the failed slot's own normal spawn drops the mark so a later codex-reviewer spawn is untagged", () => {
  const p = setup();
  run(p, failure({ agent_id: "a1", agent_type: "gemini-reviewer" }));
  run(p, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_response: { ok: true } });
  run(p, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "gemini-reviewer", description: "again", prompt: "x" } });
  run(p, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "codex-reviewer", description: "review", prompt: "x" } });
  const spawns = activity(p.root).filter((r) => r.event === "PreToolUse" && r.tool === "Agent" && r.workerId === "codex-reviewer");
  assert.equal(spawns[0].fallbackOf, undefined);
});
