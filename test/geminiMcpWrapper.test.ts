/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Plan task p98-t3: hooks/gemini-mcp-wrapper.cjs proxies a (fake) child MCP
// server, passes tools/list through, normalizes tools/call into the bridge
// envelope (ok / provider_error / timeout / empty / truncation) and kills the
// child. The fake child is a Node script run through node directly - no .exe.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WRAPPER = path.join(__dirname, "..", "..", "hooks", "gemini-mcp-wrapper.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PINNED_PACKAGE } = require("../../hooks/gemini-mcp-wrapper.cjs") as { PINNED_PACKAGE: string };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-gemini-wrap-"));
const liveWrappers = new Set<ChildProcess>();
after(() => {
  for (const w of liveWrappers) {
    try { w.stdin?.end(); w.kill(); } catch { /* already gone */ }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseBridgeResult } = require("../../hooks/bridge-result.cjs") as { parseBridgeResult: (r: unknown) => { status: string; provider: string; summary: string; truncated: boolean; error?: { kind: string } } | null };

const FAKE = path.join(root, "fake-gemini-mcp.js");
fs.writeFileSync(
  FAKE,
  String.raw`
const readline = require("readline");
const fs = require("fs");
if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
let spawnIndex = 1;
if (process.env.FAKE_COUNT_FILE) {
  try { spawnIndex = Number(fs.readFileSync(process.env.FAKE_COUNT_FILE, "utf8")) + 1; } catch {}
  fs.writeFileSync(process.env.FAKE_COUNT_FILE, String(spawnIndex));
}
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
  if (m.method === "tools/list" && process.env.FAKE_MODE === "nolist") return;
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "ask-gemini", inputSchema: { type: "object" } }] } });
  if (m.method !== "tools/call") return;
  const mode = process.env.FAKE_MODE;
  const text = (t, isError) => send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: t }], isError: !!isError } });
  if (mode === "hang") return;
  if (mode === "hang-first") { if (spawnIndex === 1) return; return setTimeout(() => text("late child answer"), 250); }
  globalThis.calls = (globalThis.calls || 0) + 1;
  const UNREAD = "Error executing ask-gemini: agy: found a SQLite transcript (C:/x/c.db) but could not extract a model reply from its schema. Please report this with the agy version";
  if (mode === "unreadable-once") return globalThis.calls === 1 ? text(UNREAD, true) : text("second try answer");
  if (mode === "unreadable") return text(UNREAD, true);
  if (mode === "agywarn") return text('Warning: Backend "agy" ignores model selection (print-mode is gemini-3.5-flash-only); "gemini-2.5-pro" was not applied.\nreply');
  if (mode === "agymissing") return text("Error: agy not installed", true);
  if (mode === "pathecho") return text(process.env.PATH || "");
  if (mode === "empty") return text("   ");
  if (mode === "big") return text("x".repeat(500));
  if (mode === "auth") return text("Error: 401 Unauthorized - please log in again", true);
  if (mode === "quota") return text("RESOURCE_EXHAUSTED: quota exceeded", true);
  if (mode === "rpcerror") return send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "getaddrinfo ENOTFOUND example.test" } });
  text("fake answer");
});
`,
);

type Msg = { id?: number; result?: any; error?: any };

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Sends requests in order (each waits for its id's reply), returns replies by id and the wrapper handle. */
async function drive(env: Record<string, string>, requests: object[], keepOpen = false) {
  const pidFile = path.join(root, "pid-" + Math.random().toString(36).slice(2));
  const wrapper = spawn(process.execPath, [WRAPPER], {
    env: { ...process.env, TYCOON_GEMINI_MCP_CMD: process.execPath, TYCOON_GEMINI_MCP_ARGS: JSON.stringify([FAKE]), FAKE_PID_FILE: pidFile, GEMINI_MCP_BACKEND: "gemini", ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let errText = "";
  wrapper.stderr.on("data", (c) => (errText += c));
  liveWrappers.add(wrapper);
  wrapper.on("exit", () => liveWrappers.delete(wrapper));
  const replies = new Map<number, Msg>();
  const waiters = new Map<number, (m: Msg) => void>();
  let buf = "";
  wrapper.stdout.on("data", (c) => {
    buf += c;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line) as Msg;
      if (m.id !== undefined) {
        replies.set(m.id, m);
        waiters.get(m.id)?.(m);
      }
    }
  });
  for (const raw of requests as { id?: number; noWait?: boolean }[]) {
    const { noWait, ...req } = raw;
    wrapper.stdin.write(JSON.stringify(req) + "\n");
    if (req.id !== undefined && !noWait) {
      await new Promise<void>((resolve) => {
        if (replies.has(req.id!)) return resolve();
        waiters.set(req.id!, () => resolve());
      });
    }
  }
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf8"));
  } catch {
    /* child never started */
  }
  if (!keepOpen) wrapper.stdin.end();
  return { replies, pid, wrapper, getErr: () => errText };
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ask-gemini", arguments: { prompt: "hi" } } });

test("pinned package is an exact version", () => {
  assert.match(PINNED_PACKAGE, /^gemini-mcp-tool@\d+\.\d+\.\d+$/);
});

test("tools/list and initialize pass through unchanged; ok call carries the envelope", async () => {
  const r = await drive({ FAKE_MODE: "ok" }, [init, { jsonrpc: "2.0", id: 2, method: "tools/list" }, call(3)]);
  const { replies, pid } = r;
  assert.equal(replies.get(1)!.result?.serverInfo.name, "fake", JSON.stringify(replies.get(1)));
  assert.equal(replies.get(2)!.result.tools[0].name, "ask-gemini");
  const sc = replies.get(3)!.result.structuredContent;
  assert.equal(sc.status, "ok");
  assert.equal(sc.provider, "gemini");
  assert.equal(sc.summary, "fake answer");
  assert.equal(replies.get(3)!.result.isError, false);
  assert.match(replies.get(3)!.result.content[0].text, /^TYCOON_BRIDGE /);
  assert.ok(await waitDead(pid), "child killed when stdin closes");
});

test("provider errors map to error.kind", async () => {
  const auth = await drive({ FAKE_MODE: "auth" }, [init, call(2)]);
  assert.equal(auth.replies.get(2)!.result.structuredContent.status, "provider_error");
  assert.equal(auth.replies.get(2)!.result.structuredContent.error.kind, "auth");
  assert.equal(auth.replies.get(2)!.result.isError, true);
  const quota = await drive({ FAKE_MODE: "quota" }, [init, call(2)]);
  assert.equal(quota.replies.get(2)!.result.structuredContent.error.kind, "quota");
  const net = await drive({ FAKE_MODE: "rpcerror" }, [init, call(2)]);
  assert.equal(net.replies.get(2)!.result.structuredContent.error.kind, "network");
});

test("blank output becomes status empty", async () => {
  const { replies } = await drive({ FAKE_MODE: "empty" }, [init, call(2)]);
  assert.equal(replies.get(2)!.result.structuredContent.status, "empty");
});

test("summary is capped at TYCOON_BRIDGE_MAX_CHARS and flagged truncated", async () => {
  const { replies } = await drive({ FAKE_MODE: "big", TYCOON_BRIDGE_MAX_CHARS: "100" }, [init, call(2)]);
  const sc = replies.get(2)!.result.structuredContent;
  assert.equal(sc.status, "ok");
  assert.equal(sc.truncated, true);
  assert.ok(sc.summary.length < 200);
});

test("a hung call times out with status timeout and the child is killed", async () => {
  const { replies, pid, wrapper } = await drive({ FAKE_MODE: "hang", TYCOON_BRIDGE_TIMEOUT_MS: "400" }, [init, call(2)], true);
  try {
    const sc = replies.get(2)!.result.structuredContent;
    assert.equal(sc.status, "timeout");
    assert.equal(sc.error.kind, "timeout");
    assert.ok(pid > 0);
    assert.ok(await waitDead(pid), "child killed on timeout");
  } finally {
    wrapper.stdin.end();
    wrapper.kill();
  }
});

test("an unstartable command yields a clear provider_error instead of hanging", async () => {
  const { replies } = await drive({ TYCOON_GEMINI_MCP_CMD: path.join(root, "does-not-exist") }, [call(2)]);
  const sc = replies.get(2)!.result.structuredContent;
  assert.equal(sc.status, "provider_error");
  assert.equal(sc.error.kind, "cli_missing");
});

/** Asserts the reply's envelope through parseBridgeResult (the same reader the hook uses) and that isError tracks status. */
function envelopeFor(replies: Map<number, Msg>, id: number) {
  const result = replies.get(id)!.result;
  const env = parseBridgeResult(result);
  assert.ok(env, "expected a parseable envelope: " + JSON.stringify(result));
  assert.equal(result.isError, env!.status !== "ok", "isError must be true for every non-ok status");
  return env!;
}

test("every status parses through parseBridgeResult with isError set for non-ok", async () => {
  const ok = envelopeFor((await drive({ FAKE_MODE: "ok" }, [init, call(2)])).replies, 2);
  assert.equal(ok.status, "ok");
  assert.equal(ok.provider, "gemini");
  const perr = envelopeFor((await drive({ FAKE_MODE: "auth" }, [init, call(2)])).replies, 2);
  assert.equal(perr.status, "provider_error");
  assert.equal(perr.error?.kind, "auth");
  const empty = envelopeFor((await drive({ FAKE_MODE: "empty" }, [init, call(2)])).replies, 2);
  assert.equal(empty.status, "empty");
  const big = envelopeFor((await drive({ FAKE_MODE: "big", TYCOON_BRIDGE_MAX_CHARS: "50" }, [init, call(2)])).replies, 2);
  assert.equal(big.status, "ok");
  assert.equal(big.truncated, true);
  const hung = await drive({ FAKE_MODE: "hang", TYCOON_BRIDGE_TIMEOUT_MS: "300" }, [init, call(2)], true);
  try {
    const t = envelopeFor(hung.replies, 2);
    assert.equal(t.status, "timeout");
    assert.equal(t.error?.kind, "timeout");
  } finally {
    hung.wrapper.stdin.end();
    hung.wrapper.kill();
  }
});

test("a missing agy/gemini CLI reported by the tool is cli_missing, a bare RESOURCE_EXHAUSTED is quota", async () => {
  const missing = envelopeFor((await drive({ FAKE_MODE: "agymissing" }, [init, call(2)])).replies, 2);
  assert.equal(missing.error?.kind, "cli_missing");
  const quota = envelopeFor((await drive({ FAKE_MODE: "quota" }, [init, call(2)])).replies, 2);
  assert.equal(quota.error?.kind, "quota");
});

test("a replaced child's late exit does not fail the new child's in-flight call", async () => {
  const countFile = path.join(root, "count-" + Math.random().toString(36).slice(2));
  const r = await drive({ FAKE_MODE: "hang-first", FAKE_COUNT_FILE: countFile, TYCOON_BRIDGE_TIMEOUT_MS: "2500" }, [init, call(2), call(3)], true);
  try {
    const first = envelopeFor(r.replies, 2);
    assert.equal(first.status, "timeout");
    const second = envelopeFor(r.replies, 3);
    assert.equal(second.status, "ok", "call on the respawned child must survive the old child's exit: " + JSON.stringify(r.replies.get(3)));
    assert.equal(second.summary, "late child answer");
    assert.equal(fs.readFileSync(countFile, "utf8"), "2", "exactly one respawn");
  } finally {
    r.wrapper.stdin.end();
    r.wrapper.kill();
  }
});

test("the pending map is capped at 64: the 65th in-flight call and a tools/list are rejected immediately", async () => {
  const hangs = Array.from({ length: 64 }, (_, i) => ({ ...call(100 + i), noWait: true }));
  const r = await drive(
    { FAKE_MODE: "hang", TYCOON_BRIDGE_TIMEOUT_MS: "30000" },
    [init, ...hangs, call(300), { jsonrpc: "2.0", id: 301, method: "tools/list" }],
    true,
  );
  try {
    const over = envelopeFor(r.replies, 300);
    assert.equal(over.status, "provider_error");
    assert.equal(over.error?.kind, "rate_limit");
    assert.match(r.replies.get(300)!.result.content[0].text, /64/);
    assert.equal(r.replies.get(301)!.error.code, -32000);
    assert.match(r.replies.get(301)!.error.message, /Too many in-flight requests \(64\)/);
    assert.equal(r.replies.has(100), false, "the hung calls themselves are still pending");
  } finally {
    r.wrapper.stdin.end();
    r.wrapper.kill();
  }
  assert.ok(r.pid > 0 && (await waitDead(r.pid)), "child killed when the wrapper is closed");
});

test("a non-call request (tools/list) that never answers times out with a JSON-RPC error and kills the child", async () => {
  const r = await drive({ FAKE_MODE: "nolist", TYCOON_BRIDGE_TIMEOUT_MS: "400" }, [init, { jsonrpc: "2.0", id: 2, method: "tools/list" }], true);
  try {
    const err = r.replies.get(2)!.error;
    assert.equal(err.code, -32000);
    assert.match(err.message, /tools\/list timed out after 400ms/);
    assert.ok(r.pid > 0);
    assert.ok(await waitDead(r.pid), "child killed after the request timed out");
  } finally {
    r.wrapper.stdin.end();
    r.wrapper.kill();
  }
});

test("shellCommandLine quotes a command path and arguments containing spaces or cmd metacharacters", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { shellCommandLine } = require("../../hooks/gemini-mcp-wrapper.cjs") as { shellCommandLine: (c: string, a: string[]) => string };
  assert.equal(
    shellCommandLine("C:\\Program Files\\nodejs\\npx.cmd", ["-y", "pkg name", "a&b"]),
    '"C:\\Program Files\\nodejs\\npx.cmd" -y "pkg name" "a&b"',
  );
  assert.equal(shellCommandLine("npx.cmd", ["-y", "pkg"]), "npx.cmd -y pkg");
});

test("a .cmd shim under a directory containing a space starts and answers (win32 shell quoting)", { skip: process.platform !== "win32" }, async () => {
  const spaced = path.join(root, "Program Files fake", "nodejs");
  fs.mkdirSync(spaced, { recursive: true });
  const shim = path.join(spaced, "fake-gemini.cmd");
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${FAKE}" %*\r\n`);
  const { replies } = await drive(
    { TYCOON_GEMINI_MCP_CMD: shim, TYCOON_GEMINI_MCP_ARGS: JSON.stringify(["--flag", "two words"]) },
    [init, call(2)],
  );
  assert.ok(replies.get(1)?.result, "initialize answered through the quoted .cmd shim");
  const parsed = parseBridgeResult(replies.get(2)?.result);
  assert.equal(parsed?.status, "ok");
});

// Antigravity CLI discovery: fake agy (Node script behind a .cmd shim / sh), never an .exe.
function makeFakeAgy(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const js = path.join(dir, "agy-fake.js");
  fs.writeFileSync(js, "process.exit(0);\n");
  const file = path.join(dir, process.platform === "win32" ? "agy.cmd" : "agy");
  if (process.platform === "win32") fs.writeFileSync(file, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
  else fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
  return file;
}

function agyEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    GEMINI_MCP_BACKEND: "agy",
    FAKE_MODE: "pathecho",
    PATH: path.dirname(process.execPath),
    LOCALAPPDATA: path.join(home, "Local"),
    HOME: home,
    USERPROFILE: home,
    ...extra,
  };
}

const agyBinDir = (home: string) => (process.platform === "win32" ? path.join(home, "Local", "agy", "bin") : path.join(home, ".local", "bin"));

type AgyResult = { skipped?: boolean; dir?: string; file?: string; source?: string; onPath?: boolean; error?: string };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wrapperApi = require("../../hooks/gemini-mcp-wrapper.cjs") as {
  resolveAgy: (env: Record<string, string>) => AgyResult;
  childEnv: (env: Record<string, string>, agy: AgyResult) => Record<string, string>;
};
const discoverEnv = (home: string, extra: Record<string, string> = {}) => {
  const e = agyEnv(home, extra);
  delete (e as Record<string, string | undefined>).FAKE_MODE;
  return e;
};

test("agy in the install dir is discovered and its dir is prepended to the child's PATH", () => {
  const home = fs.mkdtempSync(path.join(root, "home-"));
  makeFakeAgy(agyBinDir(home));
  const env = discoverEnv(home);
  const agy = wrapperApi.resolveAgy(env);
  assert.equal(agy.dir, agyBinDir(home));
  assert.equal(agy.onPath, false);
  assert.ok(wrapperApi.childEnv(env, agy).PATH.startsWith(agyBinDir(home) + path.delimiter));
});

test("TYCOON_AGY_PATH (file or dir) wins over the install dir", () => {
  const home = fs.mkdtempSync(path.join(root, "home-"));
  makeFakeAgy(agyBinDir(home));
  const other = path.join(root, "other-agy-" + Math.random().toString(36).slice(2));
  const file = makeFakeAgy(other);
  for (const value of [file, other]) {
    const agy = wrapperApi.resolveAgy(discoverEnv(home, { TYCOON_AGY_PATH: value }));
    assert.equal(agy.dir, other);
    assert.equal(agy.source, "TYCOON_AGY_PATH");
  }
});

test("agy not found yields an error naming where we looked and TYCOON_AGY_PATH; a bad override is explicit", () => {
  const home = fs.mkdtempSync(path.join(root, "home-"));
  const agy = wrapperApi.resolveAgy(discoverEnv(home));
  assert.match(agy.error!, /TYCOON_AGY_PATH/);
  assert.ok(agy.error!.includes(agyBinDir(home)), agy.error);
  makeFakeAgy(agyBinDir(home));
  const bad = wrapperApi.resolveAgy(discoverEnv(home, { TYCOON_AGY_PATH: path.join(root, "nope") }));
  assert.match(bad.error!, /TYCOON_AGY_PATH is set to/);
});

test("end to end: agy missing with the agy backend returns cli_missing (no TYCOON_GEMINI_MCP_CMD)", async () => {
  const home = fs.mkdtempSync(path.join(root, "home-"));
  const { replies } = await drive(agyEnv(home, { TYCOON_GEMINI_MCP_CMD: "", TYCOON_GEMINI_MCP_ARGS: "" }), [init, call(2)]);
  const e = envelopeFor(replies, 2);
  assert.equal(e.error?.kind, "cli_missing");
  assert.match(replies.get(2)!.result.content[0].text, /Antigravity|npx|TYCOON_AGY_PATH/);
});

test("a TYCOON_GEMINI_MCP_CMD override skips agy discovery (custom server gets no agy cli_missing)", async () => {
  const home = fs.mkdtempSync(path.join(root, "home-"));
  assert.equal(wrapperApi.resolveAgy(discoverEnv(home, { TYCOON_GEMINI_MCP_CMD: "x" })).skipped, true);
  const { replies } = await drive(agyEnv(home, { FAKE_MODE: "ok" }), [init, call(2)]);
  assert.equal(envelopeFor(replies, 2).status, "ok");
});

test("agy already on PATH is used without a prepend, and quoted PATH entries are unquoted", () => {
  const home = fs.mkdtempSync(path.join(root, "home-"));
  const dir = path.join(root, "onpath-" + Math.random().toString(36).slice(2));
  makeFakeAgy(dir);
  const env = discoverEnv(home, { PATH: '"' + dir + '"' + path.delimiter + path.dirname(process.execPath) });
  const agy = wrapperApi.resolveAgy(env);
  assert.equal(agy.onPath, true);
  assert.equal(agy.dir, dir);
  assert.equal(wrapperApi.childEnv(env, agy), env);
});

test("childEnv preserves the existing Path/PATH key casing and never adds a duplicate", () => {
  const agy: AgyResult = { dir: path.join(root, "agydir"), onPath: false };
  const win = wrapperApi.childEnv({ Path: "C:a", Other: "1" }, agy);
  assert.equal(win.Path, agy.dir + path.delimiter + "C:a");
  assert.equal(Object.keys(win).filter((k) => k.toUpperCase() === "PATH").length, 1);
  assert.equal("PATH" in win, false);
  const up = wrapperApi.childEnv({ PATH: "/a" }, agy);
  assert.equal(up.PATH, agy.dir + path.delimiter + "/a");
  assert.equal(Object.keys(up).filter((k) => k.toUpperCase() === "PATH").length, 1);
});

test("backend_unreadable then success: retried once transparently and returns ok", async () => {
  const r = await drive({ FAKE_MODE: "unreadable-once" }, [init, call(2)]);
  const sc = r.replies.get(2)!.result.structuredContent;
  assert.equal(sc.status, "ok", JSON.stringify(sc));
  assert.equal(sc.summary, "second try answer");
});

test("backend_unreadable twice: provider_error backend_unreadable with the user-facing message", async () => {
  const r = await drive({ FAKE_MODE: "unreadable" }, [init, call(2)]);
  const sc = r.replies.get(2)!.result.structuredContent;
  assert.equal(sc.status, "provider_error");
  assert.equal(sc.error.kind, "backend_unreadable");
  assert.match(sc.error.message, /reply couldn't be read/);
  assert.match(sc.error.message, /GEMINI_MCP_BACKEND=gemini/);
});

test("other error kinds are not retried", async () => {
  const r = await drive({ FAKE_MODE: "auth" }, [init, call(2)]);
  assert.equal(r.replies.get(2)!.result.structuredContent.error.kind, "auth");
});

test("envelope model reflects what ran: parsed from the agy warning, else agy-default, else the label", async () => {
  const warned = await drive({ FAKE_MODE: "agywarn", GEMINI_MCP_BACKEND: "agy", GEMINI_MODEL: "gemini-2.5-pro" }, [init, call(2)]);
  assert.equal((warned.replies.get(2)!.result.structuredContent as any).model, "gemini-3.5-flash");
  const plain = await drive({ FAKE_MODE: "ok", GEMINI_MCP_BACKEND: "agy", GEMINI_MODEL: "gemini-2.5-pro" }, [init, call(2)]);
  assert.equal((plain.replies.get(2)!.result.structuredContent as any).model, "agy-default");
  const cli = await drive({ FAKE_MODE: "ok", GEMINI_MODEL: "gemini-2.5-pro" }, [init, call(2)]);
  assert.equal((cli.replies.get(2)!.result.structuredContent as any).model, "gemini-2.5-pro");
});
