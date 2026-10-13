/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Codex-harness model defaults on the dispatcher side (hooks/harnessModelDefaults.cjs,
// hooks/tycoon-dispatcher-mcp.cjs Codex path, the codex exec adapter, the
// bridge-child skip, and scripts/generate-codex-config.mjs). Offline: the
// codex binary is a Node script behind a .cmd shim (never an .exe).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";

/* eslint-disable @typescript-eslint/no-var-requires */
const defaults = require("../../hooks/harnessModelDefaults.cjs") as {
  CODEX_TIER_MODELS: Record<string, { model: string; effort?: string }>;
  resolveHarnessDefault: (
    harness: string,
    agent: { frontmatterModel?: string; backendVendor?: string; backendMcpServer?: string; routingSlot?: { vendor?: string; model?: string } },
  ) => { vendor: string; model?: string; effort?: string; source: string };
};
const adapters = require("../../hooks/dispatcherAdapters.cjs") as {
  openaiAdapter: (task: string, info: Record<string, unknown>) => Promise<{ text?: string; error?: string }>;
  isReadOnlyAgent: (info: Record<string, unknown>) => boolean;
};
const codexRollout = require("../../hooks/codexRollout.cjs") as {
  isTycoonBridgeThread: (meta: unknown, env: Record<string, string | undefined>) => boolean;
};
/* eslint-enable @typescript-eslint/no-var-requires */

const dynamicImport = new Function("specifier", "return import(specifier);") as (s: string) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test("tier mapping: haiku -> luna, sonnet -> sol, opus/fable -> astra", () => {
  assert.deepEqual(defaults.CODEX_TIER_MODELS, {
    haiku: { model: "gpt-6-luna" },
    sonnet: { model: "gpt-6.1-sol" },
    opus: { model: "gpt-6-astra" },
    fable: { model: "gpt-6-astra" },
  });
  const r = (m?: string) => defaults.resolveHarnessDefault("codex", { frontmatterModel: m });
  assert.deepEqual(r("haiku"), { vendor: "openai", model: "gpt-6-luna", source: "harness-default" });
  assert.deepEqual(r("sonnet"), { vendor: "openai", model: "gpt-6.1-sol", source: "harness-default" });
  assert.equal(r("opus").model, "gpt-6-astra");
  assert.equal(r("fable").model, "gpt-6-astra");
  assert.equal(r("claude-opus-4-7").model, "gpt-6-astra");
  assert.equal(r("anthropic/haiku").model, "gpt-6-luna");
  assert.equal(r("inherit").model, "gpt-6.1-sol");
  assert.equal(r(undefined).model, "gpt-6.1-sol");
});

test("explicit routing slot, foreign vendor, claude-worker and gpt-* frontmatter are kept", () => {
  const slot = defaults.resolveHarnessDefault("codex", { frontmatterModel: "haiku", routingSlot: { model: "claude-sonnet-5-5" } });
  assert.equal(slot.source, "explicit");
  assert.equal(slot.model, "claude-sonnet-5-5");
  const foreign = defaults.resolveHarnessDefault("codex", { frontmatterModel: "kimi-k2", backendVendor: "moonshot" });
  assert.deepEqual([foreign.vendor, foreign.model, foreign.source], ["moonshot", "kimi-k2", "agent-vendor"]);
  const cw = defaults.resolveHarnessDefault("codex", { frontmatterModel: "anthropic/sonnet", backendVendor: "anthropic", backendMcpServer: "claude-cli" });
  assert.deepEqual([cw.vendor, cw.model, cw.source], ["anthropic", "anthropic/sonnet", "agent-vendor"]);
  const gpt = defaults.resolveHarnessDefault("codex", { frontmatterModel: "gpt-6-astra" });
  assert.deepEqual([gpt.vendor, gpt.model], ["openai", "gpt-6-astra"]);
});

test("non-codex harness returns the agent's own vendor/model unchanged", () => {
  const r = defaults.resolveHarnessDefault("claude-code", { frontmatterModel: "sonnet" });
  assert.deepEqual([r.vendor, r.model], ["anthropic", "sonnet"]);
  const f = defaults.resolveHarnessDefault("opencode", { frontmatterModel: "kimi-k2", backendVendor: "moonshot" });
  assert.deepEqual([f.vendor, f.model], ["moonshot", "kimi-k2"]);
});

function makeProject(agents: Record<string, string>, extra: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-harness-defaults-"));
  fs.mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", "tycoon"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude", "tycoon", "agent-keywords.json"),
    JSON.stringify({ fallback_agent: "coding-specialist", agents: { "coding-specialist": { pattern: "implement|fix" } } }),
  );
  for (const [id, body] of Object.entries(agents)) fs.writeFileSync(path.join(dir, ".claude", "agents", `${id}.md`), body);
  for (const [name, value] of Object.entries(extra)) fs.writeFileSync(path.join(dir, ".claude", "tycoon", name), JSON.stringify(value));
  return dir;
}

async function delegate(dir: string, specialist: string, env: Record<string, string | undefined>) {
  const modPath = require.resolve("../../hooks/tycoon-dispatcher-mcp.cjs");
  delete require.cache[modPath];
  const saved: Record<string, string | undefined> = {};
  const all = { TYCOON_PROJECT_DIR: dir, TYCOON_DISPATCH_ADAPTER: "stub", TYCOON_CODEX_DISPATCHER_CONFIGURED: undefined, ...env };
  for (const [k, v] of Object.entries(all)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    const mod = require(modPath) as { handleDelegateTool: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>; resolveActivityFile: () => string };
    const res = await mod.handleDelegateTool({ specialist, task: "do it" });
    const pre = fs.readFileSync(mod.resolveActivityFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.event === "PreToolUse" && r.workerId === specialist).pop();
    return { res, pre };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const AGENTS = {
  "coding-specialist": "---\nmodel: sonnet\n---\nbody",
  "search-retrieval": "---\nmodel: haiku\n---\nbody",
  "kimi-reviewer": "---\nmodel: haiku\nbackend:\n  vendor: moonshot\n  model: kimi-k2\n---\nbody",
  "claude-worker": "---\nmodel: sonnet\nbackend:\n  vendor: anthropic\n  transport: mcp\n  mcpServer: claude-cli\n  model: anthropic/sonnet\n---\nbody",
};

test("dispatcher on the Codex harness records the effective openai model (execution.json provider)", async () => {
  const dir = makeProject(AGENTS, { "execution.json": { provider: "codex" } });
  try {
    const sonnet = await delegate(dir, "coding-specialist", {});
    assert.deepEqual([sonnet.pre.vendor, sonnet.pre.model], ["openai", "gpt-6.1-sol"]);
    assert.equal(sonnet.res.content[0].text.startsWith("stub:openai:"), true);
    const mod = require("../../hooks/tycoon-dispatcher-mcp.cjs") as { resolveActivityFile: () => string };
    const prevDir = process.env.TYCOON_PROJECT_DIR;
    process.env.TYCOON_PROJECT_DIR = dir;
    const okStops = fs.readFileSync(mod.resolveActivityFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.event === "SubagentStop");
    if (prevDir === undefined) delete process.env.TYCOON_PROJECT_DIR; else process.env.TYCOON_PROJECT_DIR = prevDir;
    assert.ok(okStops.length >= 1 && okStops.every((x) => x.ok === true));
    const haiku = await delegate(dir, "search-retrieval", {});
    assert.deepEqual([haiku.pre.vendor, haiku.pre.model], ["openai", "gpt-6-luna"]);
    const kimi = await delegate(dir, "kimi-reviewer", {});
    assert.deepEqual([kimi.pre.vendor, kimi.pre.model], ["moonshot", "kimi-k2"]);
    const cw = await delegate(dir, "claude-worker", {});
    assert.equal(cw.pre.vendor, "anthropic");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatcher on the Codex harness: env marker works, explicit routing slot wins", async () => {
  const dir = makeProject(AGENTS, { "routing.json": { agents: { "coding-specialist": { vendor: "openai", model: "gpt-6-astra" } } } });
  try {
    const r = await delegate(dir, "coding-specialist", { TYCOON_CODEX_DISPATCHER_CONFIGURED: "1" });
    assert.deepEqual([r.pre.vendor, r.pre.model], ["openai", "gpt-6-astra"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatcher without a Codex harness signal keeps the agent's own vendor/model", async () => {
  const dir = makeProject(AGENTS, { "execution.json": { provider: "claude-code" } });
  try {
    const r = await delegate(dir, "coding-specialist", {});
    assert.deepEqual([r.pre.vendor, r.pre.model], ["anthropic", "sonnet"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeFakeCodex(recordFile: string, output = "fake codex done", stderrLine = ""): { dir: string; bin: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-fake-codex-"));
  const body = [
    "const fs = require('fs');",
    "if (process.argv[2] === '--version') { console.log('codex-cli 0.153.0'); process.exit(0); }",
    "let stdin = '';",
    "process.stdin.on('data', (c) => { stdin += c; });",
    "process.stdin.on('end', () => {",
    `  fs.writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin, bridgeChild: process.env.TYCOON_BRIDGE_CHILD, originator: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE }));`,
    `  if (${JSON.stringify(stderrLine)}) console.error(${JSON.stringify(stderrLine)});`,
    `  console.log(${JSON.stringify(output)});`,
    "});",
  ].join("\n");
  let bin: string;
  if (process.platform === "win32") {
    const js = path.join(dir, "fake-codex.js");
    fs.writeFileSync(js, body);
    bin = path.join(dir, "fake-codex.cmd");
    fs.writeFileSync(bin, `@echo off\r\nnode "${js}" %*\r\n`);
  } else {
    bin = path.join(dir, "fake-codex");
    fs.writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`);
    fs.chmodSync(bin, 0o755);
  }
  return { dir, bin };
}

async function runCodexAdapter(workerId: string, projectDir: string, model: string, effort?: string) {
  const recordFile = path.join(os.tmpdir(), `tycoon-fake-codex-rec-${process.pid}-${Date.now()}-${workerId}.json`);
  const fake = makeFakeCodex(recordFile);
  const prev = process.env.CODEX_BINARY_PATH;
  process.env.CODEX_BINARY_PATH = fake.bin;
  try {
    const res = await adapters.openaiAdapter("review this", { harness: "codex", vendor: "openai", model, effort, workerId, projectDir });
    const rec = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, "utf8")) : undefined;
    return { res, rec };
  } finally {
    if (prev === undefined) delete process.env.CODEX_BINARY_PATH; else process.env.CODEX_BINARY_PATH = prev;
    fs.rmSync(fake.dir, { recursive: true, force: true });
    fs.rmSync(recordFile, { force: true });
  }
}

test("codex exec adapter: builder gets workspace-write, project cwd, model, effort, leaf preamble, bridge-child env", async () => {
  const dir = makeProject({ "coding-specialist": "---\nmodel: sonnet\n---\nbody" });
  try {
    const { res, rec } = await runCodexAdapter("coding-specialist", dir, "gpt-6.1-sol", "low");
    assert.equal(res.text, "fake codex done");
    assert.ok(rec, "fake codex ran");
    const argv: string[] = rec.argv;
    assert.equal(argv[0], "exec");
    assert.equal(argv[argv.indexOf("-s") + 1], "workspace-write");
    assert.equal(argv[argv.indexOf("-m") + 1], "gpt-6.1-sol");
    assert.ok(argv.includes("model_reasoning_effort=low"));
    assert.ok(argv.includes("approval_policy=never"));
    assert.ok(argv.includes("mcp_servers.tycoon.enabled=false"));
    assert.equal(fs.realpathSync(rec.cwd), fs.realpathSync(dir));
    assert.match(rec.stdin, /leaf worker/);
    assert.match(rec.stdin, /review this/);
    assert.equal(rec.bridgeChild, "1");
    assert.match(rec.originator, /^tycoon-/);
    assert.equal(argv.some((a) => /danger|bypass/i.test(a)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codex exec adapter: reviewer is read-only, not in the project cwd, no bypass flags", async () => {
  const dir = makeProject({ "code-reviewer": "---\nmodel: haiku\n---\nbody" });
  try {
    assert.equal(adapters.isReadOnlyAgent({ workerId: "code-reviewer", projectDir: dir }), true);
    const { rec } = await runCodexAdapter("code-reviewer", dir, "gpt-6.1-sol");
    assert.ok(rec);
    const argv: string[] = rec.argv;
    assert.equal(argv[argv.indexOf("-s") + 1], "read-only");
    assert.notEqual(fs.realpathSync(rec.cwd), fs.realpathSync(dir));
    assert.doesNotMatch(rec.stdin, /leaf worker/);
    assert.equal(argv.some((a) => /danger|bypass/i.test(a)), false);
    assert.equal(argv.some((a) => a.startsWith("model_reasoning_effort")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SANDBOX_MESSAGE = "Codex's Windows sandbox couldn't start on this machine, so the worker couldn't run commands. Repair it in Codex, or set windows.sandbox = \"unelevated\" in your Codex config (config.toml).";

test("codex exec adapter: sandbox failure output becomes kind sandbox_unavailable", async () => {
  const dir = makeProject({ "coding-specialist": "---\nmodel: sonnet\n---\nbody" });
  const recordFile = path.join(os.tmpdir(), `tycoon-fake-codex-sbx-${process.pid}-${Date.now()}.json`);
  const fake = makeFakeCodex(recordFile, "", "2026-10-09T10:00:00Z ERROR Failed to create unified exec process: helper_unknown_error: setup refresh had errors");
  const prev = process.env.CODEX_BINARY_PATH;
  process.env.CODEX_BINARY_PATH = fake.bin;
  try {
    const res = (await adapters.openaiAdapter("t", { harness: "codex", vendor: "openai", model: "gpt-6.1-sol", workerId: "coding-specialist", projectDir: dir })) as { error?: string; kind?: string };
    assert.equal(res.kind, "sandbox_unavailable");
    assert.equal(res.error, SANDBOX_MESSAGE);
  } finally {
    if (prev === undefined) delete process.env.CODEX_BINARY_PATH; else process.env.CODEX_BINARY_PATH = prev;
    fs.rmSync(fake.dir, { recursive: true, force: true });
    fs.rmSync(recordFile, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codex exec adapter: a successful answer quoting the sandbox strings is not flagged", async () => {
  const dir = makeProject({ "coding-specialist": "---\nmodel: sonnet\n---\nbody" });
  const recordFile = path.join(os.tmpdir(), `tycoon-fake-codex-fp-${process.pid}-${Date.now()}.json`);
  const fake = makeFakeCodex(recordFile, "the code says: CreateProcess failed Rejected; setup refresh had errors; Failed to create unified exec process");
  const prev = process.env.CODEX_BINARY_PATH;
  process.env.CODEX_BINARY_PATH = fake.bin;
  try {
    const res = (await adapters.openaiAdapter("t", { harness: "codex", vendor: "openai", model: "gpt-6.1-sol", workerId: "coding-specialist", projectDir: dir })) as { text?: string; error?: string; kind?: string };
    assert.equal(res.kind, undefined);
    assert.equal(res.error, undefined);
    assert.match(res.text as string, /setup refresh had errors/);
  } finally {
    if (prev === undefined) delete process.env.CODEX_BINARY_PATH; else process.env.CODEX_BINARY_PATH = prev;
    fs.rmSync(fake.dir, { recursive: true, force: true });
    fs.rmSync(recordFile, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatcher: sandbox failure returns structured provider_error and writes one CodexSandboxUnavailable record", async () => {
  const dir = makeProject(AGENTS, { "execution.json": { provider: "codex" } });
  const recordFile = path.join(os.tmpdir(), `tycoon-fake-codex-sbx2-${process.pid}-${Date.now()}.json`);
  const fake = makeFakeCodex(recordFile, "", "exec_command failed: CreateProcess { message: \"Rejected(setup refresh had errors)\" }");
  try {
    const env = { TYCOON_DISPATCH_ADAPTER: undefined, CODEX_BINARY_PATH: fake.bin };
    const first = await delegate(dir, "coding-specialist", env);
    const r = first.res as unknown as { isError?: boolean; structuredContent?: { status?: string; error?: { kind?: string; message?: string } } };
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent?.status, "provider_error");
    assert.equal(r.structuredContent?.error?.kind, "sandbox_unavailable");
    assert.equal(r.structuredContent?.error?.message, SANDBOX_MESSAGE);
    // Second call in the same (cached) module: the record must not repeat.
    const mod = require("../../hooks/tycoon-dispatcher-mcp.cjs") as { handleDelegateTool: (a: Record<string, unknown>) => Promise<unknown>; resolveActivityFile: () => string };
    process.env.TYCOON_PROJECT_DIR = dir;
    process.env.CODEX_BINARY_PATH = fake.bin;
    delete process.env.TYCOON_DISPATCH_ADAPTER;
    await mod.handleDelegateTool({ specialist: "coding-specialist", task: "again" });
    const recs = fs.readFileSync(mod.resolveActivityFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.event === "CodexSandboxUnavailable");
    const stops = fs.readFileSync(mod.resolveActivityFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.event === "SubagentStop");
    delete process.env.TYCOON_PROJECT_DIR;
    delete process.env.CODEX_BINARY_PATH;
    assert.equal(recs.length, 1);
    assert.ok(stops.length >= 1 && stops.every((x) => x.ok === false));
    assert.equal(recs[0].provider, "codex");
    assert.equal(typeof recs[0].at, "number");
  } finally {
    fs.rmSync(fake.dir, { recursive: true, force: true });
    fs.rmSync(recordFile, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("openai adapter outside the Codex harness still refuses (Codex-native)", async () => {
  const res = await adapters.openaiAdapter("x", { vendor: "openai", model: "gpt-6-astra" });
  assert.equal(res.error, "use Codex native agents");
});

test("dispatcher-started codex exec sessions are bridge threads (no duplicate rows)", () => {
  assert.equal(codexRollout.isTycoonBridgeThread({ originator: "codex_exec" }, { TYCOON_BRIDGE_CHILD: "1" }), true);
  assert.equal(codexRollout.isTycoonBridgeThread({ originator: "codex_exec" }, {}), false);
  assert.equal(codexRollout.isTycoonBridgeThread({ originator: "tycoon-dispatcher-exec" }, {}), true);
});

test("generator states each specialist's effective Codex model", async () => {
  const dir = makeProject({
    "coding-specialist": "---\nname: coding-specialist\nmodel: sonnet\n---\n# C\n\nImplements.\n",
    "search-retrieval": "---\nname: search-retrieval\nmodel: haiku\n---\n# S\n\nSearches.\n",
    "planner": "---\nname: planner\nmodel: opus\n---\n# P\n\nPlans.\n",
  });
  try {
    const gen = await dynamicImport(pathToFileURL(path.join(process.cwd(), "scripts", "generate-codex-config.mjs")).href);
    const { agentsMdBlock, agentsToml } = gen.generateCodexConfig({ projectDir: dir });
    assert.match(agentsMdBlock, /coding-specialist[^\n]*runs on gpt-6\.1-sol \|/);
    assert.match(agentsMdBlock, /search-retrieval[^\n]*runs on gpt-6-luna/);
    assert.match(agentsMdBlock, /planner[^\n]*runs on gpt-6-astra/);
    assert.match(agentsMdBlock, /`delegate` tool/);
    assert.match(agentsToml, /# effective Codex model: gpt-6-astra/);
    assert.match(agentsToml, /# dispatched via tycoon delegate/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
