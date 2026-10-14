/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// The dispatcher launches bridges only in canonical form: node + its own
// sibling bridge script, allowlisted env. A forged project .mcp.json entry is
// refused with kind "bridge_untrusted" and nothing is spawned.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require("../../hooks/dispatcherBridgeClient.cjs") as {
  callBridgeTool: (o: Record<string, unknown>) => Promise<{ error?: string; kind?: string; result?: unknown }>;
};

interface Env {
  project: string;
  hooks: string;
  spawned: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }>;
  spawn: (command: string, args: string[], opts: { env: Record<string, string | undefined> }) => unknown;
}

function setup(entry: unknown, serverName = "gemini"): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-trust-"));
  const project = path.join(root, "project");
  const hooks = path.join(project, ".claude", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  for (const f of ["gemini-mcp-wrapper.cjs", "codex-mcp-launcher.cjs"]) fs.writeFileSync(path.join(hooks, f), "// bridge\n");
  fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { [serverName]: entry } }));
  const spawned: Env["spawned"] = [];
  const spawn: Env["spawn"] = (command, args, opts) => {
    spawned.push({ command, args, env: opts.env });
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdin = { write: () => undefined, end: () => undefined };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    setImmediate(() => child.emit("exit", 1));
    return child;
  };
  return { project, hooks, spawned, spawn };
}

async function call(e: Env, serverName = "gemini") {
  return client.callBridgeTool({ projectDir: e.project, serverName, toolName: "ask-gemini", toolArgs: {}, hooksDir: e.hooks, spawn: e.spawn, timeoutMs: 1000, graceMs: 0 });
}

const GOOD = { command: "node", args: [".claude/hooks/gemini-mcp-wrapper.cjs"] };

test("forged command is refused and nothing is spawned", async () => {
  const e = setup({ command: "evil.cmd", args: [".claude/hooks/gemini-mcp-wrapper.cjs"] });
  const r = await call(e);
  assert.equal(r.kind, "bridge_untrusted");
  assert.equal(e.spawned.length, 0);
});

test("script outside the dispatcher directory is refused", async () => {
  const e = setup({ command: "node", args: ["evil/gemini-mcp-wrapper.cjs"] });
  fs.mkdirSync(path.join(e.project, "evil"));
  fs.writeFileSync(path.join(e.project, "evil", "gemini-mcp-wrapper.cjs"), "// evil\n");
  const r = await call(e);
  assert.equal(r.kind, "bridge_untrusted");
  assert.equal(e.spawned.length, 0);
});

test("unknown script name and extra args are refused", async () => {
  for (const entry of [
    { command: "node", args: [".claude/hooks/other.cjs"] },
    { command: "node", args: [".claude/hooks/gemini-mcp-wrapper.cjs", "--evil"] },
    { command: "node", args: [".claude/hooks/codex-mcp-launcher.cjs"] },
  ]) {
    const e = setup(entry);
    const r = await call(e);
    assert.equal(r.kind, "bridge_untrusted", JSON.stringify(entry));
    assert.equal(e.spawned.length, 0);
  }
});

test("non-allowlisted env is refused", async () => {
  for (const env of [{ NODE_OPTIONS: "--require x" }, { PATH: "/evil" }, { TYCOON_AGY_PATH: "evil" }, { OPENAI_COMPAT_BASE_URL: "http://evil" }]) {
    const e = setup({ ...GOOD, env });
    const r = await call(e);
    assert.equal(r.kind, "bridge_untrusted", JSON.stringify(env));
    assert.equal(e.spawned.length, 0);
  }
});

test("symlinked bridge script is refused", async (t) => {
  const e = setup(GOOD);
  const real = path.join(e.project, "real.cjs");
  fs.writeFileSync(real, "// real\n");
  fs.rmSync(path.join(e.hooks, "gemini-mcp-wrapper.cjs"));
  try {
    fs.symlinkSync(real, path.join(e.hooks, "gemini-mcp-wrapper.cjs"), "file");
  } catch {
    t.skip("symlinks not permitted on this machine");
    return;
  }
  const r = await call(e);
  assert.equal(r.kind, "bridge_untrusted");
  assert.equal(e.spawned.length, 0);
});

test("canonical entry spawns process.execPath with the sibling script and allowlisted env", async () => {
  const e = setup({ ...GOOD, env: { GEMINI_MCP_BACKEND: "gemini", GEMINI_API_KEY: "${GEMINI_API_KEY}" } });
  const r = await call(e);
  assert.notEqual(r.kind, "bridge_untrusted");
  assert.equal(e.spawned.length, 1);
  assert.equal(e.spawned[0].command, process.execPath);
  assert.equal(e.spawned[0].args[0], fs.realpathSync.native(path.join(e.hooks, "gemini-mcp-wrapper.cjs")));
  assert.equal(e.spawned[0].env.GEMINI_MCP_BACKEND, "gemini");
});

test("codex entry with the catalog -c args is canonical; a dangerous sandbox is not", async () => {
  const args = [".claude/hooks/codex-mcp-launcher.cjs", "-c", 'model="gpt-5.6-sol"', "-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"'];
  const ok = setup({ command: "node", args }, "codex");
  await call(ok, "codex");
  assert.equal(ok.spawned.length, 1);
  const bad = setup({ command: "node", args: [...args.slice(0, 5), "-c", 'sandbox_mode="danger-full-access"'] }, "codex");
  const r = await call(bad, "codex");
  assert.equal(r.kind, "bridge_untrusted");
  assert.equal(bad.spawned.length, 0);
});

test("project-copy hooks never fall back to ../out/localEnvStore.js", () => {
  for (const f of ["dispatcherAdapters.cjs", "gemini-mcp-wrapper.cjs", "openai-compatible-mcp.cjs"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "hooks", f), "utf8");
    assert.match(src, /basename\(path\.dirname\(__dirname\)\)\.toLowerCase\(\) === "\.claude"\) return \[own\]/, f);
  }
});
