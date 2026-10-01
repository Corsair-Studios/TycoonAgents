/*
 * Plan p99-t2: in-process provider fallback on the Claude host through the
 * dispatcher's delegate tool (hooks/dispatcherClaudeChain.cjs). Two-or-more
 * fake bridges are Node scripts launched from a project .mcp.json; each call
 * is logged so the tests can prove which bridge ran inside ONE delegate call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = process.cwd();

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

const FAKE_BRIDGE = `
"use strict";
const readline = require("readline");
const fs = require("fs");
const br = require(process.env.FAKE_BRIDGE_RESULT);
const name = process.env.FAKE_NAME;
const mode = process.env.FAKE_MODE;
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") { send(msg.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "1" } }); return; }
  if (msg.method !== "tools/call") return;
  const model = (msg.params.arguments && msg.params.arguments.model) || "m-" + name;
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ server: name, pid: process.pid, tool: msg.params.name, args: msg.params.arguments, depth: process.env.TYCOON_DISPATCH_DEPTH }) + "\\n");
  if (mode === "hang") return;
  if (mode === "fail") { send(msg.id, br.providerErrorResult({ provider: name, model, text: "rate limit exceeded (HTTP 429)" })); return; }
  if (mode === "empty") { send(msg.id, br.formatBridgeResult({ provider: name, model, text: "" })); return; }
  send(msg.id, br.formatBridgeResult({ provider: name, model, text: "review from " + name, extra: { usage: { input_tokens: 3, output_tokens: 4 } } }));
});
`;

interface Slot { vendor: string; transport: string; mcpServer: string; tools: string[]; model: string; costModelClass: string }
function slot(server: string, model = `vendor-${server}/model-${server}`, cmc = "metered"): Slot {
  return { vendor: `vendor-${server}`, transport: "mcp", mcpServer: server, tools: ["review"], model, costModelClass: cmc };
}

interface Project {
  dir: string;
  logFile: string;
  calls: () => Array<{ server: string; pid: number; tool: string; args: Record<string, unknown>; depth?: string }>;
  records: () => Array<Record<string, unknown>>;
}

function makeProject(opts: {
  modes: Record<string, string>;
  primary?: string;
  chain?: Slot[];
  defaultFallback?: Slot;
  useDefaultFallback?: boolean;
}): Project {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-p99t2-"));
  fs.mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", "tycoon"), { recursive: true });
  const bridgeFile = path.join(dir, "fake-bridge.cjs");
  fs.writeFileSync(bridgeFile, FAKE_BRIDGE);
  const logFile = path.join(dir, "calls.log");
  const primary = opts.primary ?? "fake-a";
  const mcpServers: Record<string, unknown> = {};
  for (const [name, mode] of Object.entries(opts.modes)) {
    mcpServers[name] = {
      command: process.execPath,
      args: [bridgeFile],
      env: { FAKE_NAME: name, FAKE_MODE: mode, FAKE_LOG: logFile, FAKE_BRIDGE_RESULT: path.join(REPO_ROOT, "hooks", "bridge-result.cjs") },
    };
  }
  fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers }));
  const p = slot(primary);
  fs.writeFileSync(
    path.join(dir, ".claude", "agents", "fake-reviewer.md"),
    [
      "---",
      "model: sonnet",
      "backend:",
      `  vendor: ${p.vendor}`,
      "  transport: mcp",
      `  mcpServer: ${primary}`,
      "  tools: [review]",
      `  model: ${p.model}`,
      "  costModelClass: metered",
      "---",
      "",
      "# Fake Reviewer",
      "",
    ].join("\n"),
  );
  const agentEntry: Record<string, unknown> = { backend: p, fallback: opts.chain ?? [] };
  if (opts.useDefaultFallback === false) agentEntry.useDefaultFallback = false;
  const resolved: Record<string, unknown> = { agents: { "fake-reviewer": agentEntry } };
  if (opts.defaultFallback) resolved.defaultFallback = opts.defaultFallback;
  fs.writeFileSync(path.join(dir, ".claude", "tycoon", "routing.resolved.json"), JSON.stringify(resolved));
  fs.writeFileSync(
    path.join(dir, ".claude", "tycoon", "agent-keywords.json"),
    JSON.stringify({ fallback_agent: "fake-reviewer", agents: { "fake-reviewer": { pattern: "review" } } }),
  );
  // The orchestrator's own spawn record for the subagent (written by the hook in real runs).
  fs.writeFileSync(
    path.join(dir, ".claude", "tycoon", "activity.jsonl"),
    JSON.stringify({ event: "PreToolUse", tool: "Agent", workerId: "fake-reviewer", model: p.model, vendor: p.vendor, sessionId: "sess-1", parentId: "orchestrator", at: 1 }) + "\n",
  );
  return {
    dir,
    logFile,
    calls: () =>
      fs.existsSync(logFile)
        ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [],
    records: () =>
      fs
        .readFileSync(path.join(dir, ".claude", "tycoon", "activity.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  };
}

async function delegate(project: Project, task = "review this diff"): Promise<ToolResult> {
  const modPath = require.resolve("../../hooks/tycoon-dispatcher-mcp.cjs");
  delete require.cache[modPath];
  const prev = { dir: process.env.TYCOON_PROJECT_DIR, host: process.env.TYCOON_DISPATCH_HOST, depth: process.env.TYCOON_DISPATCH_DEPTH, timeout: process.env.TYCOON_DISPATCH_STEP_TIMEOUT_MS };
  process.env.TYCOON_PROJECT_DIR = project.dir;
  process.env.TYCOON_DISPATCH_HOST = "claude";
  delete process.env.TYCOON_DISPATCH_DEPTH;
  process.env.TYCOON_DISPATCH_STEP_TIMEOUT_MS = "15000";
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(modPath) as { handleDelegateTool: (a: Record<string, unknown>) => Promise<ToolResult> };
    return await mod.handleDelegateTool({ specialist: "fake-reviewer", task });
  } finally {
    for (const [k, v] of [["TYCOON_PROJECT_DIR", prev.dir], ["TYCOON_DISPATCH_HOST", prev.host], ["TYCOON_DISPATCH_DEPTH", prev.depth], ["TYCOON_DISPATCH_STEP_TIMEOUT_MS", prev.timeout]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertNoLeakedBridges(project: Project): Promise<void> {
  const pids = [...new Set(project.calls().map((c) => c.pid))];
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && pids.some(isAlive)) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(pids.filter(isAlive), [], "every spawned fake bridge must have exited");
}

function cleanup(project: Project): void {
  try {
    fs.rmSync(project.dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

test("primary provider_error -> fallback bridge answers inside the same delegate call; attribution follows the answering provider", async () => {
  const project = makeProject({ modes: { "fake-a": "fail", "fake-b": "ok" }, chain: [slot("fake-b", "vendor-fake-b/model-fake-b", "local")] });
  try {
    const res = await delegate(project);
    assert.notEqual(res.isError, true);
    const sc = res.structuredContent as Record<string, any>;
    assert.equal(sc.status, "ok");
    assert.equal(sc.provider, "fake-b");
    assert.match(String(sc.summary), /review from fake-b/);
    assert.equal(sc.fellBackFrom, "vendor-fake-a/vendor-fake-a/model-fake-a");
    assert.deepEqual(sc.attempts.map((a: any) => [a.mcpServer, a.status, a.depth]), [["fake-a", "provider_error", 0], ["fake-b", "ok", 1]]);
    assert.equal(sc.attempts[0].kind, "rate_limit");

    const calls = project.calls();
    assert.deepEqual(calls.map((c) => c.server), ["fake-a", "fake-b"], "primary then fallback, once each, in one call");
    assert.ok(calls.every((c) => c.depth === "1"), "child bridges run with TYCOON_DISPATCH_DEPTH=1");
    assert.equal(calls[1].args.prompt, "review this diff");

    const recs = project.records();
    const trig = recs.filter((r) => r.event === "FallbackTriggered");
    assert.equal(trig.length, 1);
    assert.equal(trig[0].failedModel, "vendor-fake-a/model-fake-a");
    assert.equal(trig[0].nextModel, "vendor-fake-b/model-fake-b");
    assert.equal(trig[0].bridgeStatus, "provider_error");
    assert.equal(trig[0].sessionId, "sess-1");

    const spawns = recs.filter((r) => r.event === "PreToolUse" && r.fallbackOf !== undefined);
    assert.equal(spawns.length, 1, "only the answering fallback is attributed");
    assert.equal(spawns[0].vendor, "vendor-fake-b");
    assert.equal(spawns[0].model, "vendor-fake-b/model-fake-b");
    assert.equal(spawns[0].costModelClass, "local");
    assert.equal(spawns[0].fallbackDepth, 1);
    assert.equal(spawns[0].fallbackIsDefault, false);
    assert.equal(spawns[0].sessionId, "sess-1");
    const stop = recs.find((r) => r.event === "SubagentStop" && r.spawnId === spawns[0].spawnId);
    assert.ok(stop, "the fallback spawn is closed with a matching SubagentStop");
    assert.equal(stop!.tokens, 7);

    // The panel mapping carries the answering provider's attribution ("(fb)" source fields).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { mapHookRecord } = require("../src/providers/claude-code/mapHookRecord") as { mapHookRecord: (r: unknown) => Array<Record<string, unknown>> };
    const ev = mapHookRecord(spawns[0]).find((e) => e.type === "WorkerSpawned");
    assert.equal(ev!.vendor, "vendor-fake-b");
    assert.equal(ev!.fallbackOf, "fake-reviewer");
    assert.equal(ev!.fallbackIsDefault, false);

    await assertNoLeakedBridges(project);
  } finally {
    cleanup(project);
  }
});

test("a successful primary writes no fallback records and never calls the fallback bridge", async () => {
  const project = makeProject({ modes: { "fake-a": "ok", "fake-b": "ok" }, chain: [slot("fake-b")] });
  try {
    const res = await delegate(project);
    assert.equal((res.structuredContent as Record<string, any>).provider, "fake-a");
    assert.deepEqual(project.calls().map((c) => c.server), ["fake-a"]);
    assert.equal(project.records().filter((r) => r.fallbackOf !== undefined || r.event === "FallbackTriggered").length, 0);
    await assertNoLeakedBridges(project);
  } finally {
    cleanup(project);
  }
});

test("an empty primary answer also falls back; defaultFallback is attributed as default", async () => {
  const project = makeProject({ modes: { "fake-a": "empty", "fake-c": "ok" }, chain: [], defaultFallback: slot("fake-c") });
  try {
    const res = await delegate(project);
    const sc = res.structuredContent as Record<string, any>;
    assert.equal(sc.provider, "fake-c");
    assert.equal(sc.answeredBy.isDefault, true);
    const spawn = project.records().find((r) => r.event === "PreToolUse" && r.fallbackOf !== undefined);
    assert.equal(spawn!.fallbackIsDefault, true);
    await assertNoLeakedBridges(project);
  } finally {
    cleanup(project);
  }
});

test("exhausted chain returns a structured provider_error listing every attempt, never an approval", async () => {
  const project = makeProject({ modes: { "fake-a": "fail", "fake-b": "fail" }, chain: [slot("fake-b")] });
  try {
    const res = await delegate(project);
    assert.equal(res.isError, true);
    const sc = res.structuredContent as Record<string, any>;
    assert.equal(sc.status, "provider_error");
    assert.equal(sc.error.kind, "chain_exhausted");
    assert.equal(sc.exhausted, true);
    assert.equal(sc.attempts.length, 2);
    assert.deepEqual(sc.attempts.map((a: any) => a.provider), ["vendor-fake-a", "vendor-fake-b"]);
    assert.ok(sc.attempts.every((a: any) => a.status === "provider_error" && a.kind === "rate_limit"));
    const text = res.content[0].text;
    assert.match(text, /^TYCOON_BRIDGE /);
    assert.doesNotMatch(text, /approve|lgtm/i);
    assert.match(text, /vendor-fake-a/);
    assert.match(text, /vendor-fake-b/);
    // No fallback spawn is attributed when nothing answered.
    assert.equal(project.records().filter((r) => r.event === "PreToolUse" && r.fallbackOf !== undefined).length, 0);
    assert.ok(project.records().some((r) => r.event === "ProviderError" && r.workerId === "fake-reviewer"));
    await assertNoLeakedBridges(project);
  } finally {
    cleanup(project);
  }
});

test("no fallback configured: a single failing provider returns provider_error, not an approval", async () => {
  const project = makeProject({ modes: { "fake-a": "fail" }, chain: [] });
  try {
    const res = await delegate(project);
    assert.equal(res.isError, true);
    const sc = res.structuredContent as Record<string, any>;
    assert.equal(sc.status, "provider_error");
    assert.equal(sc.attempts.length, 1);
    await assertNoLeakedBridges(project);
  } finally {
    cleanup(project);
  }
});

test("depth cap 3: at most the primary plus three fallback calls, defaultFallback never fires past the cap", async () => {
  const project = makeProject({
    modes: { "fake-a": "fail", "fake-b": "fail", "fake-c": "ok" },
    chain: [slot("fake-b", "vendor-fake-b/m1"), slot("fake-b", "vendor-fake-b/m2"), slot("fake-b", "vendor-fake-b/m3"), slot("fake-b", "vendor-fake-b/m4")],
    defaultFallback: slot("fake-c"),
  });
  try {
    const res = await delegate(project);
    assert.equal(res.isError, true);
    const calls = project.calls();
    assert.equal(calls.filter((c) => c.server === "fake-a").length, 1);
    assert.equal(calls.filter((c) => c.server === "fake-b").length, 3, "exactly three fallback calls");
    assert.equal(calls.filter((c) => c.server === "fake-c").length, 0, "default fallback must not exceed the cap");
    assert.equal((res.structuredContent as Record<string, any>).attempts.length, 4);
    await assertNoLeakedBridges(project);
  } finally {
    cleanup(project);
  }
});

test("self-loop guard: a chain entry or default identical to an attempted slot is skipped, not called", async () => {
  const primary = slot("fake-a");
  const project = makeProject({
    modes: { "fake-a": "fail", "fake-b": "ok" },
    chain: [{ ...primary }, slot("fake-b")],
    defaultFallback: { ...primary },
  });
  try {
    const res = await delegate(project);
    const sc = res.structuredContent as Record<string, any>;
    assert.equal(sc.provider, "fake-b");
    assert.deepEqual(project.calls().map((c) => c.server), ["fake-a", "fake-b"], "fake-a is called exactly once");
    assert.ok(sc.attempts.some((a: any) => a.status === "skipped" && a.kind === "self_loop"));
    await assertNoLeakedBridges(project);
  } finally {
    cleanup(project);
  }
});

test("a default identical to the failing primary is declined: exhausted without calling the primary twice", async () => {
  const primary = slot("fake-a");
  const project = makeProject({ modes: { "fake-a": "fail" }, chain: [], defaultFallback: { ...primary } });
  try {
    const res = await delegate(project);
    assert.equal(res.isError, true);
    assert.equal(project.calls().length, 1);
    await assertNoLeakedBridges(project);
  } finally {
    cleanup(project);
  }
});

test("a hung primary times out and falls back; the hung child is cleaned up", async () => {
  const project = makeProject({ modes: { "fake-a": "hang", "fake-b": "ok" }, chain: [slot("fake-b")] });
  try {
    const modPath = require.resolve("../../hooks/tycoon-dispatcher-mcp.cjs");
    delete require.cache[modPath];
    const prev = { dir: process.env.TYCOON_PROJECT_DIR, host: process.env.TYCOON_DISPATCH_HOST, timeout: process.env.TYCOON_DISPATCH_STEP_TIMEOUT_MS };
    process.env.TYCOON_PROJECT_DIR = project.dir;
    process.env.TYCOON_DISPATCH_HOST = "claude";
    process.env.TYCOON_DISPATCH_STEP_TIMEOUT_MS = "1500";
    let res: ToolResult;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(modPath) as { handleDelegateTool: (a: Record<string, unknown>) => Promise<ToolResult> };
      res = await mod.handleDelegateTool({ specialist: "fake-reviewer", task: "review" });
    } finally {
      for (const [k, v] of [["TYCOON_PROJECT_DIR", prev.dir], ["TYCOON_DISPATCH_HOST", prev.host], ["TYCOON_DISPATCH_STEP_TIMEOUT_MS", prev.timeout]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const sc = res.structuredContent as Record<string, any>;
    assert.equal(sc.provider, "fake-b");
    assert.equal(sc.attempts[0].status, "timeout");
    await assertNoLeakedBridges(project);
  } finally {
    cleanup(project);
  }
});

test("a chain step naming an unconfigured MCP server is a provider_error attempt, then the next step runs", async () => {
  const project = makeProject({ modes: { "fake-a": "fail", "fake-b": "ok" }, chain: [slot("fake-missing"), slot("fake-b")] });
  try {
    const res = await delegate(project);
    const sc = res.structuredContent as Record<string, any>;
    assert.equal(sc.provider, "fake-b");
    assert.equal(sc.attempts[1].kind, "not_configured");
    await assertNoLeakedBridges(project);
  } finally {
    cleanup(project);
  }
});

// ---------------------------------------------------------------------------
// Hook side: dispatcher-routed failures must not produce prose re-dispatch or
// a spawn attribution swap.
// ---------------------------------------------------------------------------

function runHook(root: string, payload: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-p99t2-hook-"));
  try {
    fs.copyFileSync(path.join(REPO_ROOT, "hooks", "tycoon-claude-hook.cjs"), path.join(dir, "tycoon-claude-hook.cjs"));
    fs.copyFileSync(path.join(REPO_ROOT, "out", "src", "core", "agentBackend.js"), path.join(dir, "agentBackend.js"));
    fs.copyFileSync(path.join(REPO_ROOT, "out", "src", "core", "modelAliases.js"), path.join(dir, "modelAliases.js"));
    fs.copyFileSync(path.join(REPO_ROOT, "hooks", "fallbackChain.js"), path.join(dir, "fallbackChain.js"));
    fs.copyFileSync(path.join(REPO_ROOT, "hooks", "bridge-result.cjs"), path.join(dir, "bridge-result.cjs"));
    const r = spawnSync(process.execPath, [path.join(dir, "tycoon-claude-hook.cjs")], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(r.status, 0, `hook exited non-zero: ${r.stderr}`);
    return r.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function hookProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-p99t2-hookproj-"));
  fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  // The agent's backend names the dispatcher server, so the generic MCP-backend
  // lookup WOULD match its delegate tool and inject prose without the fix.
  fs.writeFileSync(
    path.join(root, ".claude", "agents", "fake-reviewer.md"),
    ["---", "model: sonnet", "backend:", "  vendor: vendor-fake-a", "  transport: mcp", "  mcpServer: tycoon", "  tools: [delegate]", "  model: vendor-fake-a/model-fake-a", "  costModelClass: metered", "---", "", "# Fake Reviewer", ""].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, ".claude", "tycoon", "routing.resolved.json"),
    JSON.stringify({ agents: { "fake-reviewer": { fallback: [{ vendor: "vendor-fake-b", model: "vendor-fake-b/model-fake-b", costModelClass: "local" }] } } }),
  );
  return root;
}

function activity(root: string): Array<Record<string, unknown>> {
  const p = path.join(root, ".claude", "tycoon", "activity.jsonl");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

test("hook: an exhausted dispatcher result (attempts envelope) injects no re-dispatch and records no FallbackTriggered", () => {
  const root = hookProject();
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { providerErrorResult } = require("../../hooks/bridge-result.cjs") as { providerErrorResult: (o: Record<string, unknown>) => { structuredContent: Record<string, unknown> } };
    const env = providerErrorResult({ provider: "tycoon-dispatcher", text: "every provider failed" }).structuredContent;
    env.attempts = [{ provider: "vendor-fake-a", status: "provider_error" }, { provider: "vendor-fake-b", status: "provider_error" }];
    for (const hook_event_name of ["PostToolUse", "PostToolUseFailure"]) {
      const out = runHook(root, {
        hook_event_name,
        tool_name: "mcp__tycoon__delegate",
        tool_input: { specialist: "fake-reviewer", task: "review" },
        ...(hook_event_name === "PostToolUse" ? { tool_response: { isError: true, structuredContent: env, content: [{ type: "text", text: "x" }] } } : { error: "every provider failed" }),
        session_id: "sess-1",
      });
      assert.doesNotMatch(out, /Re-dispatch|additionalContext/);
    }
    assert.equal(activity(root).filter((r) => r.event === "FallbackTriggered").length, 0);
    assert.equal(fs.existsSync(path.join(root, ".claude", "tycoon", "fallback-state.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hook: spawning a dispatcher-routed agent never swaps attribution to a fallback that did not run", () => {
  const root = hookProject();
  try {
    fs.writeFileSync(path.join(root, ".claude", "tycoon", "fallback-state.json"), JSON.stringify({ "sess-1": { "fake-reviewer": { attemptsSoFar: 1 } } }));
    runHook(root, {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "fake-reviewer", description: "review it", prompt: "review" },
      session_id: "sess-1",
    });
    const spawn = activity(root).find((r) => r.event === "PreToolUse" && r.workerId === "fake-reviewer");
    assert.ok(spawn);
    assert.equal(spawn!.fallbackOf, undefined);
    assert.equal(spawn!.vendor, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hook: a direct (non-dispatcher) MCP failure still produces the last-resort prose, with accurate wording", () => {
  const root = hookProject();
  try {
    fs.writeFileSync(
      path.join(root, ".claude", "agents", "fake-reviewer.md"),
      ["---", "model: sonnet", "backend:", "  vendor: vendor-fake-a", "  transport: mcp", "  mcpServer: third-party", "  tools: [review]", "  model: vendor-fake-a/model-fake-a", "  costModelClass: metered", "---", "", "# Fake Reviewer", ""].join("\n"),
    );
    const out = runHook(root, {
      hook_event_name: "PostToolUseFailure",
      tool_name: "mcp__third-party__review",
      tool_input: { prompt: "x" },
      error: "rate limit exceeded (HTTP 429)",
      session_id: "sess-1",
    });
    assert.match(out, /Re-dispatch the same task to fake-reviewer/);
    assert.match(out, /mcp__tycoon__delegate/);
    assert.doesNotMatch(out, /it now runs on/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
