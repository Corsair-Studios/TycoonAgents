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
const bridge = require("../../hooks/bridge-result.cjs") as {
  parseBridgeResult: (r: unknown) => { status: string; provider: string; truncated: boolean; error?: { kind: string } } | null;
};
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
  handleCodexTool: (args: Record<string, unknown>, client?: unknown) => Promise<{ content?: { type: string; text: string }[]; isError?: boolean; structuredContent?: { threadId: string; content: string; summary?: string } }>;
  handleCodexReplyTool: (args: Record<string, unknown>, client?: unknown) => Promise<{ content?: { type: string; text: string }[]; isError?: boolean; structuredContent?: { threadId: string; content: string; summary?: string } }>;
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
  if (msg.method === "turn/interrupt") {
    if (process.env.FAKE_APP_SERVER_LOG) require("fs").appendFileSync(process.env.FAKE_APP_SERVER_LOG, "INTERRUPT:" + msg.params.threadId + ":" + msg.params.turnId + "\\n");
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    if (process.env.FAKE_IGNORE_INTERRUPT !== "1") send({ method: "turn/completed", params: { threadId: msg.params.threadId, turn: { id: msg.params.turnId, status: "interrupted" } } });
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
    if (promptText === "EMPTY_ANSWER") finalText = " ";
    else if (promptText === "SLOW_A") finalText = "SLOW_A_DONE";
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
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: promptText === "FAIL_TURN" ? "failed" : "completed", error: promptText === "FAIL_TURN" ? { message: "401 Unauthorized" } : undefined } } });
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
    assert.equal(result.isError, false, `expected success, got: ${JSON.stringify(result)}`);
    assert.equal(result.structuredContent && result.structuredContent.summary, "Hello");
    assert.equal(result.structuredContent && result.structuredContent.threadId, "fake-thread-1");
    assert.equal(result.structuredContent && result.structuredContent.content, "Hello");
    const env = bridge.parseBridgeResult(result);
    assert.deepEqual({ status: env?.status, provider: env?.provider, truncated: env?.truncated }, { status: "ok", provider: "codex-app-server", truncated: false });
    assert.ok(result.content && result.content[0].text.endsWith("Hello"), "content[0].text keeps the readable answer after the header line");
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
    assert.equal(first.isError, false);
    const threadId = first.structuredContent && first.structuredContent.threadId;
    assert.ok(threadId, "expected a thread id from the first call");

    const second = await shim.handleCodexReplyTool({ prompt: "again", threadId }, client);
    assert.equal(second.isError, false, `expected success, got: ${JSON.stringify(second)}`);
    assert.equal(second.structuredContent && second.structuredContent.threadId, threadId, "codex-reply must reuse the same thread id, not start a new one");
    assert.equal(second.structuredContent && second.structuredContent.summary, "Hello");
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
    assert.equal(result.isError, false, `expected the turn to complete despite the approval request, got: ${JSON.stringify(result)}`);
    assert.equal(result.structuredContent && result.structuredContent.summary, "Hello");
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

    assert.equal(slow.isError, false, `expected SLOW_A to succeed, got: ${JSON.stringify(slow)}`);
    assert.equal(fast.isError, false, `expected FAST_B to succeed, got: ${JSON.stringify(fast)}`);
    assert.equal(slow.structuredContent && slow.structuredContent.summary, "SLOW_A_DONE", "the slower call must resolve with its OWN text, not the faster call's");
    assert.equal(fast.structuredContent && fast.structuredContent.summary, "FAST_B_DONE", "the faster call must resolve with its OWN text, not the slower call's");
  } finally {
    client.dispose();
  }
});

// ---------------------------------------------------------------------------
// 4c. Spawn "error" event: a binary path that cannot be spawned (ENOENT)
//     rejects the in-flight request PROMPTLY (not after the ~600s default
//     timeout) — hooks/codex-app-server-mcp.cjs:216-233's child.on("error")
//     handler. Uses needsShell(binaryPath) === false (an absolute non-.cmd
//     path) so Node spawns it directly with shell:false and a genuinely
//     missing path fires "error" (ENOENT) rather than a shell-reported
//     "not recognized" exit.
// ---------------------------------------------------------------------------

test("(spawn error) a binary that cannot be spawned rejects the pending codex tool call promptly, not after the full timeout", async () => {
  const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-fake-codex-missing-"));
  const missingBinaryPath = path.join(missingDir, "definitely-does-not-exist-codex-binary");
  const client = new shim.AppServerClient(missingBinaryPath, []);
  try {
    const start = Date.now();
    // handleCodexTool converts the rejected initialize into a provider_error
    // bridge result (error.kind cli_missing) that names the unspawnable binary.
    const result = await shim.handleCodexTool({ prompt: "hi", cwd: process.cwd() }, client);
    const env = bridge.parseBridgeResult(result);
    assert.equal(result.isError, true);
    assert.equal(env?.status, "provider_error");
    assert.equal(env?.error?.kind, "cli_missing");
    assert.ok(/failed to spawn app-server child/.test(result.content![0].text), `expected the spawn-error message, got: ${result.content![0].text}`);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `expected a prompt rejection well under the timeout, took ${elapsed}ms`);
  } finally {
    client.dispose();
    fs.rmSync(missingDir, { recursive: true, force: true });
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

// p98-t2: the structured bridge statuses for timeout, provider error, empty
// output and over-cap output, through the real tool handler.
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test("(bridge) a turn that never completes returns status timeout", async () => {
  const client = makeClient(writeFakeAppServer());
  try {
    const result = await withEnv({ CODEX_APP_SERVER_TIMEOUT_MS: "150" }, () => shim.handleCodexTool({ prompt: "NEVER_COMPLETE", cwd: process.cwd() }, client));
    const env = bridge.parseBridgeResult(result);
    assert.equal(result.isError, true);
    assert.equal(env?.status, "timeout");
    assert.equal(env?.error?.kind, "timeout");
  } finally {
    client.dispose();
  }
});

async function timedOutTurn(env: Record<string, string>) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-fake-interrupt-")), "log.txt");
  const client = makeClient(writeFakeAppServer());
  const result = await withEnv({ CODEX_APP_SERVER_TIMEOUT_MS: "150", FAKE_APP_SERVER_LOG: log, ...env }, async () => {
    const r = await shim.handleCodexTool({ prompt: "NEVER_COMPLETE", cwd: process.cwd() }, client);
    await new Promise((resolve) => setTimeout(resolve, 700));
    return r;
  });
  const logged = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  return { client: client as unknown as { child: unknown; dispose: () => void }, result, logged };
}

test("(bridge) a timed-out turn is sent turn/interrupt; a cooperative child is left running", async () => {
  const { client, result, logged } = await timedOutTurn({ CODEX_APP_SERVER_INTERRUPT_GRACE_MS: "300" });
  try {
    assert.equal(bridge.parseBridgeResult(result)?.status, "timeout");
    assert.ok(/INTERRUPT:fake-thread-1:fake-turn-1/.test(logged), `expected turn/interrupt, got: ${logged}`);
    assert.notEqual(client.child, null, "a child that completed the interrupted turn must not be killed");
  } finally {
    client.dispose();
  }
});

test("(bridge) a child that ignores turn/interrupt is terminated after the grace period", async () => {
  const { client, result, logged } = await timedOutTurn({ CODEX_APP_SERVER_INTERRUPT_GRACE_MS: "200", FAKE_IGNORE_INTERRUPT: "1" });
  try {
    assert.equal(bridge.parseBridgeResult(result)?.status, "timeout");
    assert.ok(/INTERRUPT:fake-thread-1:fake-turn-1/.test(logged), `expected turn/interrupt, got: ${logged}`);
    assert.equal(client.child, null, "the app-server child must be terminated when the turn does not stop");
  } finally {
    client.dispose();
  }
});

test("(bridge) a failed turn returns provider_error with a classified kind", async () => {
  const client = makeClient(writeFakeAppServer());
  try {
    const result = await shim.handleCodexTool({ prompt: "FAIL_TURN", cwd: process.cwd() }, client);
    const env = bridge.parseBridgeResult(result);
    assert.equal(result.isError, true);
    assert.equal(env?.status, "provider_error");
    assert.equal(env?.error?.kind, "auth");
    assert.ok(result.content![0].text.includes("401 Unauthorized"));
  } finally {
    client.dispose();
  }
});

test("(bridge) whitespace-only output returns status empty", async () => {
  const client = makeClient(writeFakeAppServer());
  try {
    const result = await shim.handleCodexTool({ prompt: "EMPTY_ANSWER", cwd: process.cwd() }, client);
    assert.equal(bridge.parseBridgeResult(result)?.status, "empty");
    assert.equal(result.isError, true);
  } finally {
    client.dispose();
  }
});

test("(bridge) output above TYCOON_BRIDGE_MAX_CHARS is truncated with truncated=true", async () => {
  const client = makeClient(writeFakeAppServer());
  try {
    const result = await withEnv({ TYCOON_BRIDGE_MAX_CHARS: "2" }, () => shim.handleCodexTool({ prompt: "hi", cwd: process.cwd() }, client));
    const env = bridge.parseBridgeResult(result);
    assert.equal(env?.status, "ok");
    assert.equal(env?.truncated, true);
    assert.ok(result.structuredContent!.summary!.startsWith("He"));
    assert.ok(result.structuredContent!.content.length < "Hello".length + 40);
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

// ---------------------------------------------------------------------------
// 7. (p56-t4) Cross-platform (never skipped) end-to-end proof of the same
//    fallback branch: drives the real MCP handshake (initialize + tools/list)
//    over the launcher's stdio, through the app-server shim it hands off to.
//    initialize/tools/list are answered by codex-app-server-mcp.cjs's own
//    handleRequest() without ever spawning a real app-server child (see
//    handleRequest() above — only tools/call touches AppServerClient), so the
//    fake codex binary here only needs to content-verify as Codex (--version)
//    and omit "mcp-server" from --help; it is never actually invoked with
//    "app-server". Windows: .cmd shim (a plain-text batch file, never a
//    compiled or renamed .exe). POSIX: a #!/bin/sh shebang script (chmod
//    755) run via execve. Both are plain scripts wrapping this same fake
//    Node source, matching the no-unsigned-exe test policy used throughout
//    this file and codexMcpLauncher.test.ts.
// ---------------------------------------------------------------------------

function writeIncapableFakeCodexBinary(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-launcher-fallback-mcp-"));
  const scriptPath = path.join(dir, "codex-fake.js");
  fs.writeFileSync(
    scriptPath,
    [
      'const args = process.argv.slice(2);',
      'if (args[0] === "--version") { console.log("codex-cli 0.0.0-fallback-test"); process.exit(0); }',
      'if (args[args.length - 1] === "--help") {',
      '  console.log("Commands:\\n  version   Show version\\n  app-server   App server");',
      '  process.exit(0);',
      '}',
      'process.exit(0);',
    ].join("\n"),
    "utf8",
  );
  if (process.platform === "win32") {
    const cmdPath = path.join(dir, "codex-fake.cmd");
    fs.writeFileSync(cmdPath, `@echo off\r\nnode "${scriptPath}" %*\r\n`, "utf8");
    return cmdPath;
  }
  const shPath = path.join(dir, "codex-fake");
  fs.writeFileSync(shPath, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, "utf8");
  fs.chmodSync(shPath, 0o755);
  return shPath;
}

test("(launcher fallback, cross-platform) an MCP initialize + tools/list over stdio reaches the app-server shim, not exit 1", () => {
  const binaryPath = writeIncapableFakeCodexBinary();
  const emptyProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-launcher-fallback-mcp-empty-root-"));
  const env: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SystemDrive: process.env.SystemDrive,
    PATH: process.platform === "win32" ? NODE_BIN_DIR : `${NODE_BIN_DIR}:/bin:/usr/bin`,
    CODEX_LAUNCHER_PROJECT_ROOT: emptyProjectRoot,
    CODEX_CLI_PATH: binaryPath,
  };

  try {
    const child = spawn(process.execPath, [LAUNCHER_PATH, "mcp-server"], {
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses: Record<number, unknown> = {};
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString();
      let idx;
      while ((idx = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, idx).trim();
        buffered = buffered.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (typeof msg.id === "number") responses[msg.id] = msg;
      }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");

    return new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const poll = setInterval(() => {
        if (responses[1] && responses[2]) {
          clearInterval(poll);
          try {
            assert.ok(stderr.includes("falling back to the app-server"), `expected the fallback log line, got stderr:\n${stderr}`);
            const initResult = (responses[1] as { result: { serverInfo: { name: string } } }).result;
            assert.equal(initResult.serverInfo.name, "codex-app-server-mcp", "expected the app-server shim's own serverInfo, proving the launcher handed off to it");
            const toolsResult = (responses[2] as { result: { tools: { name: string }[] } }).result;
            const names = toolsResult.tools.map((t) => t.name);
            assert.deepEqual(names.sort(), ["codex", "codex-reply"], `expected the adapter's tools/list response, got: ${JSON.stringify(names)}`);
            child.kill();
            resolve();
          } catch (err) {
            child.kill();
            reject(err);
          }
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          child.kill();
          reject(new Error(`timed out waiting for initialize/tools-list responses; stderr so far:\n${stderr}`));
        }
      }, 50);
    }).finally(() => {
      fs.rmSync(path.dirname(binaryPath), { recursive: true, force: true });
      fs.rmSync(emptyProjectRoot, { recursive: true, force: true });
    });
  } catch (err) {
    fs.rmSync(path.dirname(binaryPath), { recursive: true, force: true });
    fs.rmSync(emptyProjectRoot, { recursive: true, force: true });
    throw err;
  }
});

test("(model) handleCodexTool passes the per-call model (openai/ stripped) on thread/start; absent model sends none", async () => {
  const calls: Array<{ method: string; params: any }> = [];
  const client = {
    ensureInitialized: async () => undefined,
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "t1" } };
      return { turn: { id: "u1" } };
    },
    waitForTurn: async () => ({ threadId: "t1", text: "ok", turn: { status: "completed" } }),
    dispose: () => undefined,
  };
  await shim.handleCodexTool({ prompt: "hi", cwd: process.cwd(), model: "openai/gpt-6-astra" }, client);
  assert.equal(calls.find((c) => c.method === "thread/start")!.params.model, "gpt-6-astra");
  calls.length = 0;
  const res = await shim.handleCodexTool({ prompt: "hi", cwd: process.cwd() }, client);
  assert.equal("model" in calls.find((c) => c.method === "thread/start")!.params, false);
  assert.ok(!res.isError);
});
