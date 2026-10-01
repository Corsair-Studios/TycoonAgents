/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Plan task p98-t2: each of the stdio MCP bridges (openai-compatible-mcp,
// claude-cli-mcp, and the codex mcp-server path behind codex-mcp-launcher)
// returns the shared bridge envelope for ok / provider_error / timeout /
// empty output, and truncates output above TYCOON_BRIDGE_MAX_CHARS. The
// codex app-server shim's own statuses are covered in codexAppServerMcp.test.ts.
//
// Every bridge is driven as a real child process over newline-delimited
// JSON-RPC. Fakes are Node scripts (behind a .cmd shim on win32, a +x shell
// script elsewhere) and a loopback HTTP server - never a compiled .exe.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bridge = require("../../hooks/bridge-result.cjs") as {
  parseBridgeResult: (r: unknown) => { status: string; provider: string; model: string; summary: string; truncated: boolean; error?: { kind: string } } | null;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createMcpResultProxy } = require("../../hooks/codex-mcp-launcher.cjs") as {
  createMcpResultProxy: (opts: Record<string, unknown>) => { onClientLine: (l: string) => void; onChildLine: (l: string) => void; dispose: () => void };
};

const HOOKS_DIR = path.join(__dirname, "..", "..", "hooks");
const IS_WIN = process.platform === "win32";
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-bridge-status-"));
after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

type Reply = { result?: { content?: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> } };

/** Spawns a bridge, sends one tools/call (id 1), resolves with the id-1 response (or null on `waitMs` with none), then closes it. */
function callBridge(
  script: string,
  scriptArgs: string[],
  env: NodeJS.ProcessEnv,
  params: Record<string, unknown>,
  opts: { waitMs?: number; settleMs?: number } = {},
): Promise<{ reply: Reply | null; ids: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...scriptArgs], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buffer = "";
    let stderr = "";
    let reply: Reply | null = null;
    let ids = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(giveUp);
      try { child.stdin.end(); } catch { /* ignore */ }
      setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve({ reply, ids, stderr });
      }, opts.settleMs ?? 0);
    };
    child.stderr.on("data", (c) => { stderr += c; });
    child.stdout.on("data", (c) => {
      buffer += c;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) { ids += 1; reply = msg; if (ids === 1) setTimeout(finish, opts.settleMs ?? 0); }
        } catch { /* not a JSON-RPC line (e.g. trailing usage line) */ }
      }
    });
    child.on("close", () => { if (!done) { done = true; clearTimeout(giveUp); resolve({ reply, ids, stderr }); } });
    const giveUp = setTimeout(finish, opts.waitMs ?? 15_000);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }) + "\n");
  });
}

function envelope(reply: Reply | null) {
  assert.ok(reply && reply.result, "expected a tools/call result");
  const env = bridge.parseBridgeResult(reply!.result);
  assert.ok(env, `expected a bridge envelope in structuredContent, got: ${JSON.stringify(reply)}`);
  return env!;
}

// ---------------------------------------------------------------------------
// openai-compatible-mcp, against a loopback chat-completions server.
// ---------------------------------------------------------------------------

let server: http.Server | undefined;
let baseUrl = "";
function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const prompt = String(JSON.parse(body).messages[0].content);
        if (prompt === "HANG") return; // never answers
        if (prompt === "AUTH") { res.writeHead(401, { "Content-Type": "application/json" }); res.end('{"error":"Invalid API key"}'); return; }
        if (prompt === "QUOTA") { res.writeHead(429, { "Content-Type": "application/json" }); res.end('{"error":"You exceeded your current quota"}'); return; }
        const content = prompt === "EMPTY" ? "  " : prompt === "BIG" ? "x".repeat(100) : "answer";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
      resolve();
    });
  });
}
after(() => { if (server) { server.closeAllConnections(); server.close(); } });

const OPENAI = path.join(HOOKS_DIR, "openai-compatible-mcp.cjs");
function openai(prompt: string, env: NodeJS.ProcessEnv = {}) {
  return callBridge(OPENAI, [], { OPENAI_COMPAT_BASE_URL: baseUrl, OPENAI_COMPAT_API_KEY: "test-key", ...env }, { name: "chat", arguments: { model: "fake-model", prompt } });
}

test("(openai-compatible) ok result carries the envelope, usage and readable text", async () => {
  await startServer();
  const { reply } = await openai("OK");
  const env = envelope(reply);
  assert.equal(env.status, "ok");
  assert.equal(env.provider, "openai-compatible");
  assert.equal(env.model, "fake-model");
  assert.equal(env.summary, "answer");
  assert.equal(env.truncated, false);
  assert.equal(reply!.result!.isError, false);
  assert.deepEqual(reply!.result!.structuredContent!.usage, { input_tokens: 3, output_tokens: 4 });
  assert.ok(reply!.result!.content![0].text.endsWith("answer"));
});

test("(openai-compatible) HTTP 401 and 429 are provider_error with auth / rate_limit kinds", async () => {
  const auth = envelope((await openai("AUTH")).reply);
  assert.equal(auth.status, "provider_error");
  assert.equal(auth.error?.kind, "auth");
  const limited = envelope((await openai("QUOTA")).reply);
  assert.equal(limited.status, "provider_error");
  assert.equal(limited.error?.kind, "rate_limit");
});

test("(openai-compatible) an unreachable endpoint is provider_error network", async () => {
  const net = envelope((await openai("OK", { OPENAI_COMPAT_BASE_URL: "http://127.0.0.1:1" })).reply);
  assert.equal(net.status, "provider_error");
  assert.equal(net.error?.kind, "network");
});

test("(openai-compatible) a request past the timeout returns status timeout", async () => {
  const { reply } = await openai("HANG", { OPENAI_COMPAT_TIMEOUT_MS: "300" });
  const env = envelope(reply);
  assert.equal(env.status, "timeout");
  assert.equal(env.error?.kind, "timeout");
  assert.equal(reply!.result!.isError, true);
});

test("(openai-compatible) TYCOON_BRIDGE_TIMEOUT_MS applies when the bridge-specific var is unset", async () => {
  const env = envelope((await openai("HANG", { TYCOON_BRIDGE_TIMEOUT_MS: "300" })).reply);
  assert.equal(env.status, "timeout");
});

test("(openai-compatible) whitespace-only content returns status empty", async () => {
  const env = envelope((await openai("EMPTY")).reply);
  assert.equal(env.status, "empty");
});

test("(openai-compatible) output above TYCOON_BRIDGE_MAX_CHARS is truncated with truncated=true", async () => {
  const env = envelope((await openai("BIG", { TYCOON_BRIDGE_MAX_CHARS: "10" })).reply);
  assert.equal(env.status, "ok");
  assert.equal(env.truncated, true);
  assert.ok(env.summary.startsWith("xxxxxxxxxx") && env.summary.length < 100);
});

// ---------------------------------------------------------------------------
// claude-cli-mcp, against a fake `claude` CLI (Node script behind a shim).
// ---------------------------------------------------------------------------

const FAKE_CLAUDE_SRC = `
let input = "";
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  const prompt = input.trim();
  if (prompt === "HANG") { setInterval(() => {}, 1000); return; }
  const base = { type: "result", session_id: "s1", num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 6 } };
  if (prompt === "AUTH") { process.stdout.write(JSON.stringify({ ...base, is_error: true, result: "401 Unauthorized: not logged in" })); process.exit(1); }
  if (prompt === "EMPTY") { process.stdout.write(JSON.stringify({ ...base, is_error: false, result: "  " })); return; }
  const result = prompt === "BIG" ? "y".repeat(100) : "answer";
  process.stdout.write(JSON.stringify({ ...base, is_error: false, result }));
});
`;

function writeFakeClaude(): string {
  const dir = fs.mkdtempSync(path.join(fixtureRoot, "claude-"));
  const js = path.join(dir, "fake-claude.js");
  fs.writeFileSync(js, FAKE_CLAUDE_SRC, "utf8");
  if (IS_WIN) {
    const cmd = path.join(dir, "claude.cmd");
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`, "utf8");
    return cmd;
  }
  const sh = path.join(dir, "claude");
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, "utf8");
  fs.chmodSync(sh, 0o755);
  return sh;
}

const CLAUDE = path.join(HOOKS_DIR, "claude-cli-mcp.cjs");
const fakeClaudeBin = writeFakeClaude();
function claude(prompt: string, env: NodeJS.ProcessEnv = {}) {
  return callBridge(CLAUDE, [], { CLAUDE_CLI_BIN: fakeClaudeBin, ...env }, { name: "claude", arguments: { prompt, model: "haiku" } });
}

test("(claude-cli) ok result carries the envelope and keeps usage/cost fields", async () => {
  const { reply } = await claude("OK");
  const env = envelope(reply);
  assert.equal(env.status, "ok");
  assert.equal(env.provider, "claude-cli");
  assert.equal(env.model, "haiku");
  assert.equal(env.summary, "answer");
  const sc = reply!.result!.structuredContent!;
  assert.deepEqual(sc.usage, { input_tokens: 5, output_tokens: 6 });
  assert.equal(sc.cost_usd, 0.01);
  assert.equal(sc.session_id, "s1");
  assert.equal(sc.is_error, false);
});

test("(claude-cli) a CLI auth failure is provider_error auth with readable text", async () => {
  const { reply } = await claude("AUTH");
  const env = envelope(reply);
  assert.equal(env.status, "provider_error");
  assert.equal(env.error?.kind, "auth");
  assert.ok(reply!.result!.content![0].text.includes("401 Unauthorized"));
  assert.equal(reply!.result!.isError, true);
});

test("(claude-cli) a missing CLI is provider_error cli_missing", async () => {
  const env = envelope((await claude("OK", { CLAUDE_CLI_BIN: path.join(fixtureRoot, "no-such-dir", IS_WIN ? "claude.cmd" : "claude") })).reply);
  assert.equal(env.status, "provider_error");
  assert.equal(env.error?.kind, "cli_missing");
});

test("(claude-cli) a hung CLI returns status timeout", async () => {
  const env = envelope((await claude("HANG", { CLAUDE_CLI_TIMEOUT_MS: "500" })).reply);
  assert.equal(env.status, "timeout");
  assert.equal(env.error?.kind, "timeout");
});

test("(claude-cli) an empty result returns status empty", async () => {
  assert.equal(envelope((await claude("EMPTY")).reply).status, "empty");
});

test("(claude-cli) output above TYCOON_BRIDGE_MAX_CHARS is truncated with truncated=true", async () => {
  const env = envelope((await claude("BIG", { TYCOON_BRIDGE_MAX_CHARS: "10" })).reply);
  assert.equal(env.status, "ok");
  assert.equal(env.truncated, true);
});

// ---------------------------------------------------------------------------
// codex mcp-server path: hooks/codex-mcp-launcher.cjs proxying a fake
// `codex mcp-server`. The launcher is run for real with CODEX_CLI_PATH
// pointing at a Node-script shim that answers --version / --help and then
// speaks MCP when asked for `mcp-server`.
// ---------------------------------------------------------------------------

const FAKE_CODEX_SRC = `
const rest = process.argv.slice(2);
if (rest[0] === "--version") { console.log("codex-cli 0.153.0-test"); process.exit(0); }
if (rest[rest.length - 1] === "--help") { console.log("Commands:\\n  mcp-server   Run the MCP stdio server\\n"); process.exit(0); }
const readline = require("readline");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const text = (t, isError) => ({ content: [{ type: "text", text: t }], structuredContent: { threadId: "t1", content: t }, isError });
readline.createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "notifications/cancelled") { process.stderr.write("CANCELLED:" + m.params.requestId + "\\n"); send({ jsonrpc: "2.0", id: m.params.requestId, result: text("LATE") }); return; }
  if (m.method === "initialize") { send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } }); return; }
  if (m.method !== "tools/call") return;
  const prompt = m.params.arguments.prompt;
  if (prompt === "HANG") return;
  if (prompt === "AUTH") return send({ jsonrpc: "2.0", id: m.id, result: text("401 Unauthorized: please log in", true) });
  if (prompt === "EMPTY") return send({ jsonrpc: "2.0", id: m.id, result: text("  ") });
  send({ jsonrpc: "2.0", id: m.id, result: text(prompt === "BIG" ? "z".repeat(100) : "answer") });
});
`;

function writeFakeCodex(): string {
  const dir = fs.mkdtempSync(path.join(fixtureRoot, "codex-"));
  const js = path.join(dir, "fake-codex.js");
  fs.writeFileSync(js, FAKE_CODEX_SRC, "utf8");
  if (IS_WIN) {
    const cmd = path.join(dir, "codex.cmd");
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`, "utf8");
    return cmd;
  }
  const sh = path.join(dir, "codex");
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, "utf8");
  fs.chmodSync(sh, 0o755);
  return sh;
}

const LAUNCHER = path.join(HOOKS_DIR, "codex-mcp-launcher.cjs");
const fakeCodexBin = writeFakeCodex();
function codex(prompt: string, env: NodeJS.ProcessEnv = {}, opts: { waitMs?: number; settleMs?: number } = {}) {
  return callBridge(
    LAUNCHER,
    ["-c", "model=fake-model", "mcp-server"],
    { CODEX_CLI_PATH: fakeCodexBin, ...env },
    { name: "codex", arguments: { prompt } },
    opts,
  );
}

test("(codex mcp-server) ok result is wrapped in the envelope and keeps threadId", async () => {
  const { reply } = await codex("OK");
  const env = envelope(reply);
  assert.equal(env.status, "ok");
  assert.equal(env.provider, "codex");
  assert.equal(env.model, "fake-model");
  assert.equal(env.summary, "answer");
  assert.equal(reply!.result!.structuredContent!.threadId, "t1");
  assert.equal(reply!.result!.structuredContent!.content, "answer");
});

test("(codex mcp-server) a codex isError result is provider_error with a classified kind", async () => {
  const { reply } = await codex("AUTH");
  const env = envelope(reply);
  assert.equal(env.status, "provider_error");
  assert.equal(env.error?.kind, "auth");
  assert.equal(reply!.result!.isError, true);
  assert.ok(reply!.result!.content![0].text.includes("401 Unauthorized"));
});

test("(codex mcp-server) an unanswered call returns status timeout, cancels the child, and drops the late answer", async () => {
  const { reply, ids, stderr } = await codex("HANG", { CODEX_MCP_TIMEOUT_MS: "400" }, { settleMs: 600 });
  const env = envelope(reply);
  assert.equal(env.status, "timeout");
  assert.equal(env.error?.kind, "timeout");
  assert.equal(ids, 1, "the late real response must not reach the client");
  assert.ok(stderr.includes("CANCELLED:1"), `expected the child to receive notifications/cancelled, stderr: ${stderr}`);
});

test("(codex mcp-server) TYCOON_BRIDGE_TIMEOUT_MS is the shared fallback timeout", async () => {
  const { reply } = await codex("HANG", { TYCOON_BRIDGE_TIMEOUT_MS: "400" });
  assert.equal(envelope(reply).status, "timeout");
});

test("(codex mcp-server) whitespace-only output returns status empty", async () => {
  assert.equal(envelope((await codex("EMPTY")).reply).status, "empty");
});

test("(codex mcp-server) output above TYCOON_BRIDGE_MAX_CHARS is truncated with truncated=true", async () => {
  const { reply } = await codex("BIG", { TYCOON_BRIDGE_MAX_CHARS: "10" });
  const env = envelope(reply);
  assert.equal(env.status, "ok");
  assert.equal(env.truncated, true);
  assert.ok((reply!.result!.structuredContent!.content as string).length < 100, "codex content mirrors the capped summary");
});

test("(codex mcp-server proxy) non-tools/call traffic and unparsable lines pass through untouched", () => {
  const toClient: string[] = [];
  const toChild: string[] = [];
  const proxy = createMcpResultProxy({ writeClient: (l: string) => toClient.push(l), writeChild: (l: string) => toChild.push(l), timeoutMs: 60_000, model: "" });
  try {
    const init = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} });
    proxy.onClientLine(init);
    proxy.onChildLine(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { protocolVersion: "x" } }));
    proxy.onChildLine("not json at all");
    proxy.onChildLine(JSON.stringify({ jsonrpc: "2.0", method: "codex/event", params: { a: 1 } }));
    assert.deepEqual(toChild, [init]);
    assert.equal(toClient.length, 3);
    assert.equal(toClient[1], "not json at all");
    assert.equal(JSON.parse(toClient[0]).result.structuredContent, undefined);
  } finally {
    proxy.dispose();
  }
});
