/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Plan task p98-t4: smoke tests for hooks/claude-cli-mcp.cjs, run as a real
// child process speaking MCP over stdio against a fake `claude` CLI (a Node
// script behind a .cmd shim on win32 / a +x sh shim elsewhere, never an
// .exe). Covers ok / provider_error / timeout / empty / truncation; every
// non-ok reply must set isError.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callBridge, cleanupBridges, envelopeOf } from "./helpers/mcpBridge";
import { writeFakeCli, IS_WIN } from "./helpers/fakeCli";

const SCRIPT = path.join(__dirname, "..", "..", "hooks", "claude-cli-mcp.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-claude-cli-"));
after(() => {
  cleanupBridges();
  fs.rmSync(root, { recursive: true, force: true });
});

const FAKE_SRC = `
let input = "";
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  const prompt = input.trim();
  if (prompt === "HANG") { setInterval(() => {}, 1000); return; }
  const base = { type: "result", session_id: "s1", num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 6 } };
  const fail = (msg) => { process.stdout.write(JSON.stringify({ ...base, is_error: true, result: msg })); process.exit(1); };
  if (prompt === "AUTH") return fail("401 Unauthorized: not logged in");
  if (prompt === "QUOTA") return fail("Claude usage limit reached");
  if (prompt === "EMPTY") { process.stdout.write(JSON.stringify({ ...base, is_error: false, result: "  " })); return; }
  const result = prompt === "ENV" ? "marker=" + process.env.TYCOON_BRIDGE_CHILD : prompt === "BIG" ? "y".repeat(200) : "answer";
  process.stdout.write(JSON.stringify({ ...base, is_error: false, result }));
});
`;

function writeFakeClaude(): string {
  const js = path.join(root, "fake-claude.js");
  fs.writeFileSync(js, FAKE_SRC, "utf8");
  return writeFakeCli({
    dir: root,
    name: IS_WIN ? "claude.cmd" : "claude",
    win: `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`,
    posix: `exec "${process.execPath}" "${js}" "$@"`,
  });
}

const fakeBin = writeFakeClaude();
function claude(prompt: string, env: NodeJS.ProcessEnv = {}) {
  return callBridge(SCRIPT, { CLAUDE_CLI_BIN: fakeBin, ...env }, { name: "claude", arguments: { prompt, model: "haiku" } });
}

test("ok: envelope, provider/model, summary, usage and cost kept; isError false", async () => {
  const { reply } = await claude("OK");
  const env = envelopeOf(reply);
  assert.equal(env.status, "ok");
  assert.equal(env.provider, "claude-cli");
  assert.equal(env.model, "haiku");
  assert.equal(env.summary, "answer");
  assert.equal(env.truncated, false);
  assert.equal(reply!.result!.isError, false);
  const sc = reply!.result!.structuredContent!;
  assert.deepEqual(sc.usage, { input_tokens: 5, output_tokens: 6 });
  assert.equal(sc.cost_usd, 0.01);
});

test("provider_error: CLI auth and quota failures are classified, readable and isError", async () => {
  const auth = await claude("AUTH");
  const a = envelopeOf(auth.reply);
  assert.equal(a.status, "provider_error");
  assert.equal(a.error?.kind, "auth");
  assert.equal(auth.reply!.result!.isError, true);
  assert.ok(auth.reply!.result!.content![0].text.includes("401 Unauthorized"));
  const quota = await claude("QUOTA");
  assert.equal(envelopeOf(quota.reply).error?.kind, "quota");
  assert.equal(quota.reply!.result!.isError, true);
});

test("provider_error: a missing CLI is kind cli_missing", async () => {
  const { reply } = await claude("OK", { CLAUDE_CLI_BIN: path.join(root, "no-such-dir", IS_WIN ? "claude.cmd" : "claude") });
  const env = envelopeOf(reply);
  assert.equal(env.status, "provider_error");
  assert.equal(env.error?.kind, "cli_missing");
  assert.equal(reply!.result!.isError, true);
});

test("timeout: a hung CLI returns status timeout within the injected limit", async () => {
  const { reply } = await claude("HANG", { CLAUDE_CLI_TIMEOUT_MS: "500" });
  const env = envelopeOf(reply);
  assert.equal(env.status, "timeout");
  assert.equal(env.error?.kind, "timeout");
  assert.equal(reply!.result!.isError, true);
});

test("empty: a blank result is status empty with isError", async () => {
  const { reply } = await claude("EMPTY");
  const env = envelopeOf(reply);
  assert.equal(env.status, "empty");
  assert.equal(reply!.result!.isError, true);
});

test("truncation: output above TYCOON_BRIDGE_MAX_CHARS is capped, truncated=true, still ok", async () => {
  const { reply } = await claude("BIG", { TYCOON_BRIDGE_MAX_CHARS: "10" });
  const env = envelopeOf(reply);
  assert.equal(env.status, "ok");
  assert.equal(env.truncated, true);
  assert.ok(env.summary.length < 100, env.summary);
  assert.equal(reply!.result!.isError, false);
});

test("the claude -p child is marked TYCOON_BRIDGE_CHILD=1 so the Tycoon hooks skip it", async () => {
  const { reply } = await claude("ENV");
  assert.equal(envelopeOf(reply).summary, "marker=1");
});
