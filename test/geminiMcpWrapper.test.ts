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

const FAKE = path.join(root, "fake-gemini-mcp.js");
fs.writeFileSync(
  FAKE,
  String.raw`
const readline = require("readline");
const fs = require("fs");
if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "ask-gemini", inputSchema: { type: "object" } }] } });
  if (m.method !== "tools/call") return;
  const mode = process.env.FAKE_MODE;
  const text = (t, isError) => send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: t }], isError: !!isError } });
  if (mode === "hang") return;
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
    env: { ...process.env, TYCOON_GEMINI_MCP_CMD: process.execPath, TYCOON_GEMINI_MCP_ARGS: JSON.stringify([FAKE]), FAKE_PID_FILE: pidFile, ...env },
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
  for (const req of requests as { id?: number }[]) {
    wrapper.stdin.write(JSON.stringify(req) + "\n");
    if (req.id !== undefined) {
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
