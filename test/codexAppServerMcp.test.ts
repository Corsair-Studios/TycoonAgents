/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tests hooks/codex-app-server-mcp.cjs (plan p30-t1) offline against a fake
// `app-server` child process (a tiny Node script written to a temp dir, not
// the real Codex binary) that replays the JSON-RPC method flow captured in
// test/fixtures/codex-hooks/app-server/ (initialize -> thread/start ->
// turn/start -> item/* notifications -> turn/completed, plus an
// item/commandExecution/requestApproval id-bearing request mid-turn). Never
// sends a prompt to a real model.
//
// Also asserts the shim's embedded `codex` / `codex-reply` tool schemas are
// byte-identical to test/fixtures/codex-hooks/app-server/tools-list-0.153.json,
// captured once from the pinned 0.153 `mcp-server` binary (see that file's
// header comment and docs/codex-harness-findings.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const shim = require("../../hooks/codex-app-server-mcp.cjs") as {
  AppServerClient: new (binaryPath: string, extraArgs?: string[]) => {
    ensureInitialized: () => Promise<unknown>;
    request: (method: string, params?: unknown) => Promise<unknown>;
    waitForTurn: (threadId: string, turnId: string | undefined, timeoutMs: number) => Promise<{ threadId: string; text: string; turn: unknown }>;
    dispose: () => void;
  };
  CODEX_TOOL: unknown;
  CODEX_REPLY_TOOL: unknown;
  handleCodexTool: (args: Record<string, unknown>, client?: unknown) => Promise<{ content?: { type: string; text: string }[]; isError?: boolean; structuredContent?: { threadId: string; content: string } }>;
  handleCodexReplyTool: (args: Record<string, unknown>, client?: unknown) => Promise<{ content?: { type: string; text: string }[]; isError?: boolean; structuredContent?: { threadId: string; content: string } }>;
};

const FIXTURE_TOOLS_LIST_PATH = path.join(__dirname, "..", "..", "test", "fixtures", "codex-hooks", "app-server", "tools-list-0.153.json");
const LAUNCHER_PATH = path.join(__dirname, "..", "..", "hooks", "codex-mcp-launcher.cjs");
const NODE_BIN_DIR = path.dirname(process.execPath);

// ---------------------------------------------------------------------------
// 1. Tool schemas: the shim's embedded CODEX_TOOL/CODEX_REPLY_TOOL must be
//    byte-identical (as objects) to the fixture captured from the real 0.153
//    `mcp-server` binary's tools/list response.
// ---------------------------------------------------------------------------

test("(schema) CODEX_TOOL and CODEX_REPLY_TOOL match the pinned 0.153 tools/list fixture exactly", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_TOOLS_LIST_PATH, "utf8"));
  const fixtureTools = fixture.tools as Array<{ name: string }>;
  const codexFixture = fixtureTools.find((t) => t.name === "codex");
  const replyFixture = fixtureTools.find((t) => t.name === "codex-reply");
  assert.ok(codexFixture, "fixture must contain a 'codex' tool");
  assert.ok(replyFixture, "fixture must contain a 'codex-reply' tool");
  assert.deepEqual(shim.CODEX_TOOL, codexFixture, "CODEX_TOOL must match the fixture exactly");
  assert.deepEqual(shim.CODEX_REPLY_TOOL, replyFixture, "CODEX_REPLY_TOOL must match the fixture exactly");
});

// ---------------------------------------------------------------------------
// Fake app-server fixture: a tiny Node script (written to a temp dir per
// test, not checked in) that speaks just enough of the app-server protocol
// to drive the shim's AppServerClient through a full round trip, an
// approval-decline, and a timeout. Reads newline-delimited JSON-RPC from
// stdin, writes newline-delimited JSON-RPC to stdout.
// ---------------------------------------------------------------------------

const FAKE_APP_SERVER_SRC = `
const readline = require("readline");
let turnCounter = 0;
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake/0.0.0" } });
    return;
  }
  if (msg.method === "thread/start") {
    send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "fake-thread-1" } } });
    return;
  }
  if (msg.method === "turn/start") {
    turnCounter += 1;
    const turnId = "fake-turn-" + turnCounter;
    const threadId = msg.params.threadId;
    send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
    const promptText = (msg.params.input && msg.params.input[0] && msg.params.input[0].text) || "";
    if (promptText === "NEVER_COMPLETE") return; // deliberately never sends turn/completed
    let finalText = "Hello";
    if (promptText === "SLOW_A") finalText = "SLOW_A_DONE";
    else if (promptText === "FAST_B") finalText = "FAST_B_DONE";
    const delay = promptText.indexOf("SLOW") !== -1 ? 80 : 20;
    setTimeout(() => {
      send({ method: "item/started", params: { threadId, turnId, item: { type: "agentMessage", id: "m1" } } });
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "m1", delta: finalText.slice(0, 2) } });
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "m1", delta: finalText.slice(2) } });
      if (promptText === "TRIGGER_APPROVAL") {
        send({
          method: "item/commandExecution/requestApproval",
          id: 999,
          params: { kind: "command", threadId, turnId, itemId: "exec-1", command: "echo hi", availableDecisions: ["accept", "cancel"] },
        });
      }
      send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "m1", text: finalText } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    }, delay);
    return;
  }
});
`;

function writeFakeAppServer(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-fake-appserver-"));
  const file = path.join(dir, "fake-app-server.cjs");
  fs.writeFileSync(file, FAKE_APP_SERVER_SRC, "utf8");
  return file;
}

// AppServerClient always spawns `binaryPath ["app-server", "--stdio",
// ...extraArgs]` and binaryPath must itself be directly executable (it is
// spawned, not run through `node <script>`) — so the fake "codex binary" is
// a real OS-executable wrapper (a .cmd shim on Windows, run via
// AppServerClient's own shell:true-for-.cmd handling; a shebang shell
// script marked +x elsewhere) that ignores its argv entirely and always
// execs the fake app-server Node script over inherited stdio.
function writeFakeCodexBinaryWrapper(fakeAppServerPath: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-fake-codex-bin-"));
  if (process.platform === "win32") {
    const cmdPath = path.join(dir, "fake-codex.cmd");
    fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${fakeAppServerPath}"\r\n`, "utf8");
    return cmdPath;
  }
  const shPath = path.join(dir, "fake-codex");
  fs.writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${fakeAppServerPath}"\n`, "utf8");
  fs.chmodSync(shPath, 0o755);
  return shPath;
}

function makeClient(fakeAppServerPath: string) {
  const binaryPath = writeFakeCodexBinaryWrapper(fakeAppServerPath);
  return new shim.AppServerClient(binaryPath, []);
}

// ---------------------------------------------------------------------------
// 2. codex tool call: full round trip returns assembled text + thread id.
// ---------------------------------------------------------------------------

test("(codex) round-trips a turn and returns final text + thread id", async () => {
  const fakeAppServer = writeFakeAppServer();
  const client = makeClient(fakeAppServer);
  try {
    const result = await shim.handleCodexTool({ prompt: "hi there", cwd: process.cwd() }, client);
    assert.equal(result.isError, undefined, `expected success, got: ${JSON.stringify(result)}`);
    assert.equal(result.content && result.content[0].text, "Hello");
    assert.equal(result.structuredContent && result.structuredContent.threadId, "fake-thread-1");
    assert.equal(result.structuredContent && result.structuredContent.content, "Hello");
  } finally {
    client.dispose();
  }
});

// ---------------------------------------------------------------------------
// 3. codex-reply: sends turn/start on the existing thread (no new thread/start).
// ---------------------------------------------------------------------------

test("(codex-reply) continues an existing thread via another turn/start", async () => {
  const fakeAppServer = writeFakeAppServer();
  const client = makeClient(fakeAppServer);
  try {
    const first = await shim.handleCodexTool({ prompt: "hi", cwd: process.cwd() }, client);
    assert.equal(first.isError, undefined);
    const threadId = first.structuredContent && first.structuredContent.threadId;
    assert.ok(threadId, "expected a thread id from the first call");

    const second = await shim.handleCodexReplyTool({ prompt: "again", threadId }, client);
    assert.equal(second.isError, undefined, `expected success, got: ${JSON.stringify(second)}`);
    assert.equal(second.structuredContent && second.structuredContent.threadId, threadId, "codex-reply must reuse the same thread id, not start a new one");
    assert.equal(second.content && second.content[0].text, "Hello");
  } finally {
    client.dispose();
  }
});

// ---------------------------------------------------------------------------
// 4. Approval request: an id-bearing item/commandExecution/requestApproval
//    mid-turn is auto-declined and the turn still completes normally.
// ---------------------------------------------------------------------------

test("(approval) a mid-turn approval request is auto-declined and the turn still completes", async () => {
  const fakeAppServer = writeFakeAppServer();
  const client = makeClient(fakeAppServer);
  try {
    const result = await shim.handleCodexTool({ prompt: "TRIGGER_APPROVAL", cwd: process.cwd() }, client);
    assert.equal(result.isError, undefined, `expected the turn to complete despite the approval request, got: ${JSON.stringify(result)}`);
    assert.equal(result.content && result.content[0].text, "Hello");
  } finally {
    client.dispose();
  }
});

// ---------------------------------------------------------------------------
// 4b. Concurrency: two overlapping codex-reply calls on the SAME thread get
//     distinct turnIds; the fake server completes the slower-requested one
//     first (out of order) — both callers must still resolve with their own
//     text, proving turn listeners are keyed by (threadId, turnId), not
//     threadId alone (a threadId-only key would let the second registration
//     overwrite the first and hang it until timeout).
// ---------------------------------------------------------------------------

test("(concurrency) two concurrent codex-reply calls on one thread resolve independently, even completing out of order", async () => {
  const fakeAppServer = writeFakeAppServer();
  const client = makeClient(fakeAppServer);
  try {
    const first = await shim.handleCodexTool({ prompt: "hi", cwd: process.cwd() }, client);
    const threadId = first.structuredContent && first.structuredContent.threadId;
    assert.ok(threadId, "expected a thread id from the first call");

    // SLOW_A is requested first but its fake-server delay (80ms) is longer
    // than FAST_B's (20ms), so FAST_B's turn/completed arrives first.
    const [slow, fast] = await Promise.all([
      shim.handleCodexReplyTool({ prompt: "SLOW_A", threadId }, client),
      shim.handleCodexReplyTool({ prompt: "FAST_B", threadId }, client),
    ]);

    assert.equal(slow.isError, undefined, `expected SLOW_A to succeed, got: ${JSON.stringify(slow)}`);
    assert.equal(fast.isError, undefined, `expected FAST_B to succeed, got: ${JSON.stringify(fast)}`);
    assert.equal(slow.content && slow.content[0].text, "SLOW_A_DONE", "the slower call must resolve with its OWN text, not the faster call's");
    assert.equal(fast.content && fast.content[0].text, "FAST_B_DONE", "the faster call must resolve with its OWN text, not the slower call's");
  } finally {
    client.dispose();
  }
});

// ---------------------------------------------------------------------------
// 5. Timeout: a turn that never sends turn/completed rejects cleanly within
//    the configured timeout instead of hanging.
// ---------------------------------------------------------------------------

test("(timeout) a turn that never completes rejects cleanly instead of hanging", async () => {
  const fakeAppServer = writeFakeAppServer();
  const client = makeClient(fakeAppServer);
  try {
    await client.ensureInitialized();
    const threadResult: any = await client.request("thread/start", { cwd: process.cwd() });
    const threadId = threadResult.thread.id;
    const turnResult: any = await client.request("turn/start", { threadId, input: [{ type: "text", text: "NEVER_COMPLETE" }] });
    const turnId = turnResult.turn.id;

    const start = Date.now();
    await assert.rejects(
      () => client.waitForTurn(threadId, turnId, 150),
      /timed out/i,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `expected the timeout to fire quickly, took ${elapsed}ms`);
  } finally {
    client.dispose();
  }
});

// ---------------------------------------------------------------------------
// 6. Launcher fallback: when no candidate has the mcp-server capability,
//    the launcher execs the app-server shim (logged, not a silent failure)
//    instead of exiting 1. We only assert the stderr fallback line and that
//    the child process is actually the shim (it exits promptly because its
//    real discovery, given a scrubbed env, then fails on CODEX_CLI_PATH
//    pointing at a non-real binary once it tries to spawn app-server — that
//    failure is fine, this test only proves the launcher HANDED OFF to the
//    shim rather than exiting 1 itself for a capability-only failure).
// ---------------------------------------------------------------------------

test("(launcher fallback) capability-incapable-only discovery execs the app-server shim instead of exiting 1", { skip: process.platform !== "win32" && "requires the win32 fixture binary naming used elsewhere in codexMcpLauncher.test.ts" }, () => {
  // This test only exercises the fallback branch's control flow with a
  // trivial always-incapable fake binary (a script that just prints a
  // codex-cli version banner and, for --help, a Commands list WITHOUT
  // mcp-server) — it does not require the real .NET csc.exe fixture the
  // sibling launcher test file uses.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-launcher-fallback-"));
  const fakeBinDir = path.join(dir, "bin");
  fs.mkdirSync(fakeBinDir, { recursive: true });
  const scriptPath = path.join(fakeBinDir, "codex-fake.cjs");
  fs.writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.0.0-fallback-test"); process.exit(0); }
if (args[args.length - 1] === "--help") { console.log("Commands:\\n  version   Show version\\n  app-server   App server"); process.exit(0); }
process.exit(0);
`,
    "utf8",
  );
  // Windows can't spawn a .cjs directly with shell:false; wrap it as a .cmd
  // shim so the launcher's needsShell()/probeCandidate() path treats it as
  // a real resolvable command via CODEX_CLI_PATH override (shell:false is
  // only forced for a resolved absolute non-.cmd path — CODEX_CLI_PATH here
  // ends in .cmd so needsShell() returns true).
  const cmdPath = path.join(fakeBinDir, "codex-fake.cmd");
  fs.writeFileSync(cmdPath, `@echo off\r\nnode "${scriptPath}" %*\r\n`, "utf8");

  const emptyProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-launcher-fallback-empty-root-"));
  const env: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SystemDrive: process.env.SystemDrive,
    PATH: NODE_BIN_DIR,
    CODEX_LAUNCHER_PROJECT_ROOT: emptyProjectRoot,
    CODEX_CLI_PATH: cmdPath,
    // Give the shim a short timeout and let its own (real, unreachable)
    // discovery fail fast rather than hang the test — the shim will try to
    // spawn CODEX_CLI_PATH (our fake .cmd) with "app-server" "--stdio",
    // which the fake script ignores/exits 0 on, so the shim's app-server
    // child just exits immediately and any subsequent request rejects.
    CODEX_APP_SERVER_TIMEOUT_MS: "200",
  };

  const result = spawnSync(process.execPath, [LAUNCHER_PATH, "mcp-server"], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    input: "",
  });

  try {
    assert.ok(
      (result.stderr || "").includes("falling back to the app-server"),
      `expected the launcher to log the fallback decision, got stderr:\n${result.stderr}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(emptyProjectRoot, { recursive: true, force: true });
  }
});
