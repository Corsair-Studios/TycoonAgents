import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VENDOR_KEY_SPECS, vendorKeySpecFor, vendorKeySpecById, signInNote, allVendorKeyEnvNames } from "../src/core/vendorKeys";
import { mapBridgeAttempt, runVendorKeyTest } from "../src/core/vendorKeyTest";
import { buildRoutingView, probeEnv } from "../src/core/routingHostOps";

const HOOKS_DIR = path.join(process.cwd(), "hooks");

test("vendor key spec: prefixed vendors map to fixed key + base URL names", () => {
  const xai = vendorKeySpecFor("xai");
  assert.ok(xai);
  assert.deepEqual(xai.rows.map((r) => r.env), ["XAI_API_KEY", "XAI_BASE_URL"]);
  assert.equal(xai.rows[0].required, true);
  assert.equal(xai.rows[1].required, false);
  assert.equal(xai.rows[1].defaultValue, "https://api.x.ai/v1");
  assert.deepEqual(vendorKeySpecFor("Mistral")?.rows.map((r) => r.env), ["MISTRAL_API_KEY", "MISTRAL_BASE_URL"]);
  assert.deepEqual(vendorKeySpecFor("moonshot")?.rows.map((r) => r.env), ["MOONSHOT_API_KEY", "MOONSHOT_BASE_URL"]);
});

test("vendor key spec: sign-in vendors need no key and say so", () => {
  const openai = vendorKeySpecFor("openai")!;
  assert.equal(openai.auth, "signin");
  assert.equal(openai.rows.length, 0);
  assert.equal(signInNote(openai), "Uses your Codex sign-in — no key needed");
  assert.equal(signInNote(vendorKeySpecFor("anthropic")!), "Uses your Claude sign-in — no key needed");
  const google = vendorKeySpecFor("google")!;
  assert.equal(signInNote(google), "Uses your Antigravity sign-in — no key needed");
  // Gemini CLI backend: GEMINI_API_KEY, optional (agy needs none).
  assert.deepEqual(google.rows.map((r) => [r.env, r.required]), [["GEMINI_API_KEY", false]]);
  assert.deepEqual(google.test, { server: "gemini", tool: "ping" });
});

test("vendor key spec: unknown and custom vendors have no spec (free-form fields stay)", () => {
  assert.equal(vendorKeySpecFor("ollama-windows"), null);
  assert.equal(vendorKeySpecFor("custom-endpoint"), null);
  assert.equal(vendorKeySpecFor(""), null);
  assert.equal(vendorKeySpecById("nope"), null);
});

test("vendor key spec rows match hooks/openai-compatible-mcp.cjs VENDOR_DEFAULTS", () => {
  const src = fs.readFileSync(path.join(HOOKS_DIR, "openai-compatible-mcp.cjs"), "utf8");
  const re = /\{ prefix: "([a-z]+)\/", baseUrlEnv: "([A-Z_]+)", defaultBaseUrl: "([^"]+)", apiKeyEnv: "([A-Z_]+)" \}/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(src)) !== null) {
    n++;
    const spec = vendorKeySpecById(m[1]);
    assert.ok(spec, `spec for ${m[1]}`);
    assert.equal(spec.modelPrefix, `${m[1]}/`);
    assert.equal(spec.rows.find((r) => r.kind === "credential")?.env, m[4]);
    const url = spec.rows.find((r) => r.kind === "endpoint");
    assert.equal(url?.env, m[2]);
    assert.equal(url?.defaultValue, m[3]);
  }
  assert.equal(n, 3);
});

test("routing view presets carry vendorKeys, and the probe never carries a value", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vk-view-"));
  const view = buildRoutingView({ root, env: { XAI_API_KEY: "sk-view-secret-123456" } as NodeJS.ProcessEnv });
  assert.deepEqual(view.presets.vendorKeys, VENDOR_KEY_SPECS);
  // The webview probes the fixed names itself (probeEnv message) when it renders a row.
  assert.deepEqual(probeEnv(allVendorKeyEnvNames(), { XAI_API_KEY: "sk-view-secret-123456" } as NodeJS.ProcessEnv)["XAI_API_KEY"].env, true);
  assert.ok(!JSON.stringify(view).includes("sk-view-secret-123456"), "probe never carries a value");
});

test("mapBridgeAttempt maps envelope status + error.kind", () => {
  assert.equal(mapBridgeAttempt({ status: "ok" }), "ok");
  assert.equal(mapBridgeAttempt({ status: "timeout" }), "timeout");
  assert.equal(mapBridgeAttempt({ status: "provider_error", error: { kind: "auth" } }), "auth");
  assert.equal(mapBridgeAttempt({ status: "provider_error", error: { kind: "not_found" } }), "not_found");
  assert.equal(mapBridgeAttempt({ status: "provider_error", error: { kind: "network" } }), "network");
  assert.equal(mapBridgeAttempt({ status: "provider_error", error: { kind: "cli_missing" } }), "not_installed");
  assert.equal(mapBridgeAttempt({ status: "provider_error", error: { kind: "quota" } }), "error");
  assert.equal(mapBridgeAttempt(null), "error");
});

// ---- Node-script fake bridge (never an .exe) ------------------------------

const SECRET = "sk-fake-secret-value-0123456789";

function fakeBridgeSource(): string {
  return `
"use strict";
const br = require(${JSON.stringify(path.join(HOOKS_DIR, "bridge-result.cjs").replace(/\\/g, "/"))});
const mode = process.env.FAKE_MODE || "ok";
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      out({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    } else if (msg.method === "tools/call") {
      if (process.env.FAKE_ARGS_FILE) require("fs").writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(msg.params));
      if (mode === "hang") return;
      let result;
      if (mode === "ok") result = br.formatBridgeResult({ provider: "fake", model: "m", text: "pong" });
      else if (mode === "auth") result = br.providerErrorResult({ provider: "fake", model: "m", text: "HTTP 401 invalid api key " + (process.env.XAI_API_KEY || ""), httpStatus: 401 });
      else if (mode === "not_found") result = br.providerErrorResult({ provider: "fake", model: "m", text: "model does not exist", httpStatus: 404 });
      else if (mode === "echo") result = br.formatBridgeResult({ provider: "fake", model: String(msg.params.arguments.model), text: JSON.stringify(msg.params.arguments) });
      out({ jsonrpc: "2.0", id: msg.id, result });
    }
  }
});
function out(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
`;
}

function makeProject(mode: string, server = "openai-compatible", extraEnv: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vk-proj-"));
  const script = path.join(root, "fake-bridge.cjs");
  fs.writeFileSync(script, fakeBridgeSource(), "utf8");
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { [server]: { command: process.execPath, args: [script], env: { FAKE_MODE: mode, ...extraEnv } } } }),
    "utf8"
  );
  return root;
}

function withEmptyStore<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.TYCOON_STANDALONE_DATA_DIR;
  process.env.TYCOON_STANDALONE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-store-"));
  return fn().finally(() => {
    if (prev === undefined) delete process.env.TYCOON_STANDALONE_DATA_DIR;
    else process.env.TYCOON_STANDALONE_DATA_DIR = prev;
  });
}

const KEYED_ENV = { XAI_API_KEY: SECRET } as NodeJS.ProcessEnv;

test("runVendorKeyTest: missing key short-circuits without spawning the bridge", () =>
  withEmptyStore(async () => {
    const root = makeProject("ok");
    const r = await runVendorKeyTest({ vendorId: "xai", projectRoot: root, hooksDir: HOOKS_DIR, env: {} });
    assert.equal(r.state, "missing_key");
  }));

test("runVendorKeyTest: ok / auth / not_found map from the real bridge envelope", () =>
  withEmptyStore(async () => {
    const ok = await runVendorKeyTest({ vendorId: "xai", projectRoot: makeProject("ok"), hooksDir: HOOKS_DIR, env: KEYED_ENV });
    assert.equal(ok.state, "ok");
    const nf = await runVendorKeyTest({ vendorId: "xai", projectRoot: makeProject("not_found"), hooksDir: HOOKS_DIR, env: KEYED_ENV });
    assert.equal(nf.state, "not_found");
    const auth = await runVendorKeyTest({ vendorId: "xai", projectRoot: makeProject("auth"), hooksDir: HOOKS_DIR, env: KEYED_ENV });
    assert.equal(auth.state, "auth");
    assert.ok(!JSON.stringify(auth).includes(SECRET), "key value redacted from the result");
  }));

test("runVendorKeyTest: bridge that never answers times out", () =>
  withEmptyStore(async () => {
    const r = await runVendorKeyTest({ vendorId: "xai", projectRoot: makeProject("hang"), hooksDir: HOOKS_DIR, env: KEYED_ENV, timeoutMs: 6000 });
    assert.equal(r.state, "timeout");
  }));

test("runVendorKeyTest: sends a 1-token chat with the slot's prefixed model, else the spec test model", () =>
  withEmptyStore(async () => {
    const argsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vk-args-")), "args.json");
    const r1 = await runVendorKeyTest({ vendorId: "xai", model: "xai/grok-4.7", projectRoot: makeProject("echo", "openai-compatible", { FAKE_ARGS_FILE: argsFile }), hooksDir: HOOKS_DIR, env: KEYED_ENV });
    assert.equal(r1.state, "ok");
    const call1 = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    assert.equal(call1.name, "chat");
    assert.equal(call1.arguments.model, "xai/grok-4.7");
    assert.equal(call1.arguments.max_tokens, 1);
    // A model without the vendor prefix would route to the generic endpoint, so the spec's test model is used.
    const r2 = await runVendorKeyTest({ vendorId: "xai", model: "llama3", projectRoot: makeProject("echo", "openai-compatible", { FAKE_ARGS_FILE: argsFile }), hooksDir: HOOKS_DIR, env: KEYED_ENV });
    assert.equal(r2.state, "ok");
    assert.equal(JSON.parse(fs.readFileSync(argsFile, "utf8")).arguments.model, "xai/grok-build-0.1");
  }));

test("runVendorKeyTest: sign-in vendor without a ping tool has no test; unknown bridge reports not installed", () =>
  withEmptyStore(async () => {
    const none = await runVendorKeyTest({ vendorId: "openai", projectRoot: makeProject("ok"), hooksDir: HOOKS_DIR, env: {} });
    assert.equal(none.state, "error");
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "vk-empty-"));
    const missing = await runVendorKeyTest({ vendorId: "google", projectRoot: empty, hooksDir: path.join(empty, "no-hooks"), env: {} });
    assert.equal(missing.state, "not_installed");
  }));

// ---- exfil guard, in-flight guard, cancellation, redaction ------------------

import { offHostForKey, cancelAllVendorKeyTests } from "../src/core/vendorKeyTest";

test("offHostForKey: only https to the default host passes; local http only for the generic endpoint", () => {
  assert.equal(offHostForKey("https://api.x.ai/v1", "https://api.x.ai/v1"), undefined);
  assert.equal(offHostForKey("https://evil.example/v1", "https://api.x.ai/v1"), "evil.example");
  assert.equal(offHostForKey("http://api.x.ai/v1", "https://api.x.ai/v1"), "api.x.ai");
  assert.equal(offHostForKey("http://localhost:11434/v1", "https://api.x.ai/v1"), "localhost:11434");
  assert.equal(offHostForKey("http://localhost:11434/v1", undefined, true), undefined);
  assert.equal(offHostForKey("http://127.0.0.1:8000", undefined, true), undefined);
  assert.equal(offHostForKey("http://[::1]:8000", undefined, true), undefined);
  assert.equal(offHostForKey("http://example.com", undefined, true), "example.com");
  assert.equal(offHostForKey("https://example.com", undefined, true), undefined);
  assert.equal(offHostForKey("not a url", undefined, true), "(invalid URL)");
});

test("runVendorKeyTest: a custom base URL (env, .mcp.json env, or store) is never called and the key never sent", () =>
  withEmptyStore(async () => {
    const argsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vk-args-")), "args.json");
    // env var
    const r1 = await runVendorKeyTest({ vendorId: "xai", projectRoot: makeProject("ok", "openai-compatible", { FAKE_ARGS_FILE: argsFile }), hooksDir: HOOKS_DIR, env: { ...KEYED_ENV, XAI_BASE_URL: "https://proxy.example.net/v1" } });
    assert.equal(r1.state, "custom_url");
    assert.match(r1.message, /proxy\.example\.net/);
    assert.equal(fs.existsSync(argsFile), false, "bridge not spawned");
    // .mcp.json env block
    const r2 = await runVendorKeyTest({ vendorId: "xai", projectRoot: makeProject("ok", "openai-compatible", { XAI_BASE_URL: "http://api.x.ai/v1", FAKE_ARGS_FILE: argsFile }), hooksDir: HOOKS_DIR, env: KEYED_ENV });
    assert.equal(r2.state, "custom_url");
    assert.equal(fs.existsSync(argsFile), false);
    // per-user store
    const { setValue } = await import("../src/core/localEnvStore");
    setValue("XAI_BASE_URL", "https://stored.example.org/v1");
    const r3 = await runVendorKeyTest({ vendorId: "xai", projectRoot: makeProject("ok"), hooksDir: HOOKS_DIR, env: KEYED_ENV });
    assert.equal(r3.state, "custom_url");
    // the default host itself is fine
    const r4 = await runVendorKeyTest({ vendorId: "mistral", projectRoot: makeProject("ok"), hooksDir: HOOKS_DIR, env: { MISTRAL_API_KEY: "k-mistral", MISTRAL_BASE_URL: "https://api.mistral.ai/v1" } as NodeJS.ProcessEnv });
    assert.equal(r4.state, "ok");
  }));

test("runVendorKeyTest: second request for the same vendor while one runs returns busy; cancel kills the child", () =>
  withEmptyStore(async () => {
    const first = runVendorKeyTest({ vendorId: "xai", projectRoot: makeProject("hang"), hooksDir: HOOKS_DIR, env: KEYED_ENV });
    await new Promise((r) => setTimeout(r, 300));
    const second = await runVendorKeyTest({ vendorId: "xai", projectRoot: makeProject("ok"), hooksDir: HOOKS_DIR, env: KEYED_ENV });
    assert.equal(second.state, "busy");
    assert.match(second.message, /Already testing/);
    // a different vendor is not blocked by this one
    const other = await runVendorKeyTest({ vendorId: "mistral", projectRoot: makeProject("ok"), hooksDir: HOOKS_DIR, env: { MISTRAL_API_KEY: "k" } as NodeJS.ProcessEnv });
    assert.equal(other.state, "ok");
    const started = Date.now();
    cancelAllVendorKeyTests();
    const r = await first;
    assert.ok(Date.now() - started < 5000, "cancelled run returns well before the 20s guard");
    assert.equal(r.state, "error");
    assert.match(r.message, /cancelled/i);
    // slot freed
    const again = await runVendorKeyTest({ vendorId: "xai", projectRoot: makeProject("ok"), hooksDir: HOOKS_DIR, env: KEYED_ENV });
    assert.equal(again.state, "ok");
  }));

test("runVendorKeyTest: redacts every spec key value (any length) found in env, not only the tested vendor's", () =>
  withEmptyStore(async () => {
    const prev = { x: process.env.XAI_API_KEY, m: process.env.MISTRAL_API_KEY };
    process.env.XAI_API_KEY = "abc";
    process.env.MISTRAL_API_KEY = "zz9";
    try {
      // The fake bridge echoes XAI_API_KEY into its auth error; add the other vendor's value via env too.
      const r = await runVendorKeyTest({ vendorId: "xai", projectRoot: makeProject("auth"), hooksDir: HOOKS_DIR, env: process.env });
      assert.equal(r.state, "auth");
      assert.ok(!r.message.includes("abc"), r.message);
      assert.match(r.message, /\[redacted\]/);
    } finally {
      if (prev.x === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = prev.x;
      if (prev.m === undefined) delete process.env.MISTRAL_API_KEY; else process.env.MISTRAL_API_KEY = prev.m;
    }
  }));
