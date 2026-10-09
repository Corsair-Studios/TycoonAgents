import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";

import {
  CUSTOM_ENDPOINT_RULES,
  customEndpointNameProblem,
  customEndpointUrlProblem,
  customKeyNameProblem,
} from "../src/core/vendorKeys";
import { runCustomEndpointTest, cancelAllVendorKeyTests, mapCustomHttpStatus, declaredMcpEnvNames } from "../src/core/vendorKeyTest";
import { setValue } from "../src/core/localEnvStore";

/*
 * Custom endpoint as a first-class OpenAI-compatible route (Claude Code and
 * Codex hosts): the slot's endpointEnv / apiKeyEnv NAMES reach the bridge,
 * which resolves values (env, then per-user store), applies the key/URL rules
 * and never lets the key into arguments, logs or envelopes. Fake HTTP servers
 * and a Node-script fake bridge only; no compiled executables.
 */

const HOOKS_DIR = path.join(process.cwd(), "hooks");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const adapters = require(path.join(HOOKS_DIR, "dispatcherAdapters.cjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const chain = require(path.join(HOOKS_DIR, "dispatcherClaudeChain.cjs"));

const KEY = "gsk-custom-secret-value-0123456789";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

type Mode = "ok" | "auth" | "notfound" | "echo-key" | "hang" | "models";

async function fakeServer(mode: Mode): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const sockets = new Set<import("net").Socket>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers["authorization"] as string | undefined, body });
      if (mode === "hang") return;
      const json = (status: number, obj: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (mode === "auth") return json(401, { error: "invalid api key" });
      if (mode === "echo-key") return json(401, { error: "bad key " + (req.headers["authorization"] ?? "") });
      if (mode === "notfound") return json(404, { error: "model does not exist" });
      if ((req.url ?? "").endsWith("/models")) return json(200, { data: [{ id: "llama3" }] });
      json(200, { choices: [{ message: { content: "pong" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

function tempStore(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ce-store-"));
}

// ---- rules -----------------------------------------------------------------

test("custom key variable: must look like a credential and must not be a well-known unrelated secret", () => {
  for (const ok of ["GROQ_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_KEY", "MY_PROVIDER_TOKEN", "OLLAMA_API_KEY"]) {
    assert.equal(customKeyNameProblem(ok, "https://api.groq.com/openai/v1"), undefined, ok);
  }
  for (const bad of ["GROQ_URL", "groq_api_key", "GROQ_API_KEY ", "PATH", "HOME", "", "_API_KEY", "1_KEY"]) {
    assert.match(customKeyNameProblem(bad, "https://x.test") ?? "", /credential name/, JSON.stringify(bad));
  }
  for (const denied of [
    "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AZURE_OPENAI_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS", "ANTHROPIC_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "MOONSHOT_API_KEY", "GEMINI_API_KEY",
    "SSH_AUTH_TOKEN", "GPG_KEY", "MY_SSH_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "TYCOON_THEME_SERVICE_TOKEN", "STRIPE_API_KEY",
    "HF_TOKEN", "VERCEL_TOKEN", "CF_API_TOKEN", "DEPLOY_TOKEN", "NETLIFY_AUTH_TOKEN", "SENTRY_AUTH_TOKEN", "HUGGINGFACE_API_KEY",
  ]) {
    const msg = customKeyNameProblem(denied, "https://x.test");
    assert.ok(msg, denied + " must be refused");
    assert.ok(!msg.includes(KEY));
  }
  // The generic OPENAI_COMPAT_API_KEY belongs to its own generic slot only.
  assert.equal(customKeyNameProblem("OPENAI_COMPAT_API_KEY", "https://x.test", "OPENAI_COMPAT_BASE_URL"), undefined);
  assert.match(customKeyNameProblem("OPENAI_COMPAT_API_KEY", "https://x.test", "OLLAMA_BASE_URL") ?? "", /generic/);
  assert.match(customKeyNameProblem("OPENAI_COMPAT_API_KEY", "https://x.test") ?? "", /generic/);
  // OPENAI_API_KEY is on the deny-list for every custom endpoint.
  for (const url of ["https://evil.example/v1", "", undefined]) {
    assert.match(customKeyNameProblem("OPENAI_API_KEY", url) ?? "", /can't be used for a custom endpoint/);
  }
});

test("custom base URL: https, or http only for localhost / 127.0.0.1 / ::1; no embedded credentials", () => {
  for (const ok of ["https://api.groq.com/openai/v1", "http://localhost:11434", "http://127.0.0.1:1234/v1", "http://[::1]:8000"]) {
    assert.equal(customEndpointUrlProblem(ok), undefined, ok);
  }
  assert.match(customEndpointUrlProblem("http://192.168.1.5:11434") ?? "", /https/);
  assert.match(customEndpointUrlProblem("http://example.com/v1") ?? "", /https/);
  assert.match(customEndpointUrlProblem("ftp://example.com") ?? "", /https/);
  assert.match(customEndpointUrlProblem("not a url") ?? "", /not a valid URL/);
  assert.match(customEndpointUrlProblem("https://user:pw@example.com/v1") ?? "", /credentials/);
  assert.match(customEndpointUrlProblem("http://localhost.evil.com") ?? "", /https/);
  assert.equal(customEndpointNameProblem("OLLAMA_BASE_URL"), undefined);
  assert.match(customEndpointNameProblem("ollama url") ?? "", /upper-case/);
  assert.match(customEndpointNameProblem("OLLAMA_URL") ?? "", /_BASE_URL/);
  assert.match(customEndpointNameProblem("EVIL_ENDPOINT") ?? "", /_BASE_URL/);
  assert.equal(customEndpointNameProblem("OPENAI_COMPAT_BASE_URL"), undefined);
});

test("the TypeScript rules and both hook copies carry identical regexes and deny-lists", () => {
  // Evaluate each hook's rule block in isolation (mcp.cjs runs a stdio server when required).
  const evalRules = (file: string, upto: string): any => {
    const src = fs.readFileSync(path.join(HOOKS_DIR, file), "utf8");
    const start = src.indexOf("const CUSTOM_KEY_NAME_RE");
    const end = src.indexOf(upto);
    assert.ok(start > 0 && end > start, file);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(`${src.slice(start, end)}\nreturn { CUSTOM_RULES, customKeyNameProblem, customEndpointNameProblem, customEndpointUrlProblem };`)();
  };
  const mcp = evalRules("openai-compatible-mcp.cjs", "function isLocalHostUrl");
  const adp = evalRules("dispatcherAdapters.cjs", "function isLocalHostUrl");
  assert.deepEqual(adp.CUSTOM_RULES, CUSTOM_ENDPOINT_RULES, "dispatcherAdapters.cjs rules differ from vendorKeys.ts");
  assert.deepEqual(mcp.CUSTOM_RULES, CUSTOM_ENDPOINT_RULES, "openai-compatible-mcp.cjs rules differ from vendorKeys.ts");
  // Every fixed vendor spec key name is in the shared deny-list.
  for (const n of ["XAI_API_KEY", "MISTRAL_API_KEY", "MOONSHOT_API_KEY", "GEMINI_API_KEY"]) assert.ok(CUSTOM_ENDPOINT_RULES.denyExact.includes(n), n);
  // Behavioural spot-check on the URL rule (the shared function bodies, not just the data).
  for (const u of ["https://a.test", "http://localhost:1", "http://10.0.0.1", "nope", "https://u:p@a.test", "http://[::1]:2"]) {
    assert.equal(!!adp.customEndpointUrlProblem(u), !!customEndpointUrlProblem(u), u);
    assert.equal(!!mcp.customEndpointUrlProblem(u), !!customEndpointUrlProblem(u), u);
  }
  for (const n of ["GROQ_API_KEY", "OPENAI_COMPAT_API_KEY", "OPENAI_API_KEY", "HF_TOKEN", "foo"]) {
    for (const ep of ["OPENAI_COMPAT_BASE_URL", "X_BASE_URL"]) {
      assert.equal(!!adp.customKeyNameProblem(n, "https://a.test", ep), !!customKeyNameProblem(n, "https://a.test", ep), n + ep);
      assert.equal(!!mcp.customKeyNameProblem(n, "https://a.test", ep), !!customKeyNameProblem(n, "https://a.test", ep), n + ep);
    }
  }
});

test("declared .mcp.json env names are read the same way by the TS and CJS implementations", () => {
  const root = tempStore();
  fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { a: { command: "x", env: { EVIL_BASE_URL: "https://attacker.example", B: "1" } }, c: { command: "y" }, d: { command: "z", env: { XAI_BASE_URL: "https://attacker.example" } } } }));
  const ts = Array.from(declaredMcpEnvNames(root)).sort();
  const cjs = Array.from(adapters.declaredMcpEnvNames(root) as Set<string>).sort();
  for (const n of ["B", "EVIL_BASE_URL", "XAI_BASE_URL"]) {
    assert.ok(ts.includes(n), "ts " + n);
    assert.ok(cjs.includes(n), "cjs " + n);
  }
});

// ---- STEP 1a: the openai-compatible MCP server -------------------------------

function callMcp(env: Record<string, string>, args: Record<string, unknown>, cwd?: string): Promise<{ text: string; isError: boolean; raw: string }> {
  return new Promise((resolve, reject) => {
    const clean: Record<string, string> = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TYCOON_STANDALONE_DATA_DIR: tempStore(), ...env };
    const child = spawn(process.execPath, [path.join(HOOKS_DIR, "openai-compatible-mcp.cjs")], { env: clean, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, cwd: cwd ?? tempStore() });
    let out = "";
    let err = "";
    let done = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("mcp timeout"));
    }, 15000);
    const finish = (): void => {
      if (done) return;
      const resp = out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return {};
          }
        })
        .find((m) => m.id === 2);
      if (!resp) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve({ text: String(resp.result?.content?.[0]?.text ?? ""), isError: !!resp.result?.isError, raw: out + err });
    };
    child.stdout.on("data", (c) => {
      out += c;
      finish();
    });
    child.stderr.on("data", (c) => (err += c));
    child.on("close", () => {
      if (!done) reject(new Error("no response; stderr=" + err));
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "chat", arguments: args } }) + "\n");
  });
}

test("mcp chat: custom endpointEnv/apiKeyEnv names are honoured; two endpoints side by side use their own URL and key", async () => {
  const a = await fakeServer("ok");
  const b = await fakeServer("ok");
  try {
    const env = { OLLAMA_BASE_URL: a.url, LOCALAI_BASE_URL: b.url, GROQ_API_KEY: KEY, LOCALAI_API_KEY: "key-for-b-0000" };
    const r1 = await callMcp(env, { model: "llama3", prompt: "hi", endpointEnv: "OLLAMA_BASE_URL", apiKeyEnv: "GROQ_API_KEY" });
    const r2 = await callMcp(env, { model: "qwen", prompt: "hi", endpointEnv: "LOCALAI_BASE_URL", apiKeyEnv: "LOCALAI_API_KEY" });
    assert.equal(r1.isError, false, r1.text);
    assert.equal(r2.isError, false, r2.text);
    assert.equal(a.seen.length, 1);
    assert.equal(b.seen.length, 1);
    assert.equal(a.seen[0].auth, "Bearer " + KEY);
    assert.equal(b.seen[0].auth, "Bearer key-for-b-0000");
    assert.equal(a.seen[0].url, "/v1/chat/completions");
    assert.equal(JSON.parse(a.seen[0].body).model, "llama3");
    assert.ok(!r1.raw.includes(KEY) && !r2.raw.includes("key-for-b-0000"), "no key value in the envelope or logs");
  } finally {
    await a.close();
    await b.close();
  }
});

test("mcp chat: values resolve from the per-user store when the env var is unset; a local server needs no key", async () => {
  const srv = await fakeServer("ok");
  const dir = tempStore();
  try {
    setValue("STORED_BASE_URL", srv.url, { env: { TYCOON_STANDALONE_DATA_DIR: dir } as NodeJS.ProcessEnv });
    setValue("STORED_API_KEY", KEY, { env: { TYCOON_STANDALONE_DATA_DIR: dir } as NodeJS.ProcessEnv });
    const withKey = await callMcp({ TYCOON_STANDALONE_DATA_DIR: dir }, { model: "m", prompt: "hi", endpointEnv: "STORED_BASE_URL", apiKeyEnv: "STORED_API_KEY" });
    assert.equal(withKey.isError, false, withKey.text);
    assert.equal(srv.seen[0].auth, "Bearer " + KEY);
    // Key variable named but unset on a localhost server: runs keyless.
    const keyless = await callMcp({ TYCOON_STANDALONE_DATA_DIR: dir }, { model: "m", prompt: "hi", endpointEnv: "STORED_BASE_URL", apiKeyEnv: "UNSET_API_KEY" });
    assert.equal(keyless.isError, false, keyless.text);
    assert.equal(srv.seen[1].auth, undefined);
  } finally {
    await srv.close();
  }
});

test("mcp chat: refuses a denied or non-credential key variable and never contacts the server", async () => {
  const srv = await fakeServer("ok");
  try {
    for (const apiKeyEnv of ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MY_PASSWORD", "path"]) {
      const r = await callMcp({ C_BASE_URL: srv.url, GITHUB_TOKEN: "ghp_secretvalue", AWS_SECRET_ACCESS_KEY: "awssecret", ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-openai-x" }, { model: "m", prompt: "hi", endpointEnv: "C_BASE_URL", apiKeyEnv });
      assert.equal(r.isError, true, apiKeyEnv);
      assert.ok(!/ghp_secretvalue|awssecret|sk-ant-x|sk-openai-x/.test(r.raw), "no secret value in " + apiKeyEnv + " refusal");
    }
    assert.equal(srv.seen.length, 0, "no request was made for any refused name");
  } finally {
    await srv.close();
  }
});

test("mcp chat: refuses http to a non-local host (key never sent), invalid and credentialed URLs", async () => {
  for (const bad of ["http://192.168.1.50:11434", "http://example.com", "ftp://x.test", "https://user:pw@x.test", "garbage"]) {
    const r = await callMcp({ C_BASE_URL: bad, C_API_KEY: KEY }, { model: "m", prompt: "hi", endpointEnv: "C_BASE_URL", apiKeyEnv: "C_API_KEY" });
    assert.equal(r.isError, true, bad);
    assert.ok(!r.raw.includes(KEY));
  }
  const missing = await callMcp({}, { model: "m", prompt: "hi", endpointEnv: "NOT_SET_BASE_URL" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /NOT_SET_BASE_URL is not set/);
  const remoteNoKey = await callMcp({ C_BASE_URL: "https://remote.example.com/v1" }, { model: "m", prompt: "hi", endpointEnv: "C_BASE_URL", apiKeyEnv: "REMOTE_API_KEY" });
  assert.match(remoteNoKey.text, /REMOTE_API_KEY is not set/);
});

test("mcp chat: a key echoed back by the endpoint is scrubbed from the error envelope", async () => {
  const srv = await fakeServer("echo-key");
  try {
    const r = await callMcp({ C_BASE_URL: srv.url, C_API_KEY: KEY }, { model: "m", prompt: "hi", endpointEnv: "C_BASE_URL", apiKeyEnv: "C_API_KEY" });
    assert.equal(r.isError, true);
    assert.ok(!r.raw.includes(KEY), "key value redacted");
    assert.match(r.raw, /redacted/);
  } finally {
    await srv.close();
  }
});

test("mcp chat: existing fixed-name routes are unchanged (bare id uses OPENAI_COMPAT_*, xai/ ignores custom names)", async () => {
  const srv = await fakeServer("ok");
  const other = await fakeServer("ok");
  try {
    const bare = await callMcp({ OPENAI_COMPAT_BASE_URL: srv.url, OPENAI_COMPAT_API_KEY: "generic-key-1" }, { model: "llama3", prompt: "hi" });
    assert.equal(bare.isError, false, bare.text);
    assert.equal(srv.seen[0].auth, "Bearer generic-key-1");
    // A prefixed model never follows custom names: the dedicated XAI pair wins.
    const xai = await callMcp({ XAI_BASE_URL: srv.url, XAI_API_KEY: "xai-key-1", C_BASE_URL: other.url, C_API_KEY: KEY }, { model: "xai/grok-4.7", prompt: "hi", endpointEnv: "C_BASE_URL", apiKeyEnv: "C_API_KEY" });
    assert.equal(xai.isError, false, xai.text);
    assert.equal(other.seen.length, 0, "custom names ignored for a vendor-prefixed model");
    assert.equal(srv.seen[1].auth, "Bearer xai-key-1");
    assert.equal(JSON.parse(srv.seen[1].body).model, "grok-4.7");
  } finally {
    await srv.close();
    await other.close();
  }
});

// ---- STEP 1b: dispatcher (Codex adapter + Claude chain) ----------------------

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("dispatcher adapter: a custom vendor routes to the openai-compatible adapter and honours the slot's names", async () => {
  assert.equal(adapters.adapterKeyForVendor("ollama-windows"), "unsupported", "no transport info: unchanged");
  assert.equal(adapters.adapterKeyForVendor("ollama-windows", { transport: "openai-compatible" }), "openai-compatible");
  assert.equal(adapters.adapterKeyForVendor("xai", { transport: "openai-compatible", endpointEnv: "XAI_BASE_URL" }), "openai-compatible", "fixed vendors route to the openai-compatible adapter");
  assert.equal(adapters.adapterKeyForVendor("moonshot", { endpointEnv: "MOONSHOT_BASE_URL" }), "openai-compatible");

  // Fixed vendors keep their handling: a slot's custom names never redirect their endpoint or key.
  const fixedSrv = await fakeServer("ok");
  const evilSrv = await fakeServer("ok");
  try {
    await withEnv({ TYCOON_STANDALONE_DATA_DIR: tempStore(), XAI_BASE_URL: fixedSrv.url, XAI_API_KEY: "xai-key-fixed", EVIL_BASE_URL: evilSrv.url, EVIL_API_KEY: KEY }, async () => {
      const { fn } = adapters.resolveAdapter("xai", { transport: "openai-compatible", endpointEnv: "EVIL_BASE_URL" });
      const res = await fn("do it", { vendor: "xai", model: "xai/grok-4.7", workerId: "w", endpointEnv: "EVIL_BASE_URL", apiKeyEnv: "EVIL_API_KEY" });
      assert.equal(res.error, undefined);
      assert.equal(evilSrv.seen.length, 0, "slot-named endpoint ignored for a fixed vendor");
      assert.equal(fixedSrv.seen[0].auth, "Bearer xai-key-fixed");
    });
  } finally {
    await fixedSrv.close();
    await evilSrv.close();
  }

  const srv = await fakeServer("ok");
  try {
    await withEnv({ TYCOON_STANDALONE_DATA_DIR: tempStore(), C_BASE_URL: srv.url, C_API_KEY: KEY, OPENAI_COMPAT_BASE_URL: undefined }, async () => {
      const { fn } = adapters.resolveAdapter("ollama-windows", { transport: "openai-compatible", endpointEnv: "C_BASE_URL" });
      const res = await fn("do it", { vendor: "ollama-windows", model: "ollama-windows/llama3:8b", workerId: "w", endpointEnv: "C_BASE_URL", apiKeyEnv: "C_API_KEY" });
      assert.equal(res.error, undefined);
      assert.equal(res.text, "pong");
      assert.equal(srv.seen[0].auth, "Bearer " + KEY);
      assert.equal(JSON.parse(srv.seen[0].body).model, "llama3:8b", "the Routing screen's vendor/ prefix is dropped upstream");

      const denied = await fn("x", { vendor: "ollama-windows", model: "m", endpointEnv: "C_BASE_URL", apiKeyEnv: "GITHUB_TOKEN" });
      assert.match(denied.error, /never sent to a custom endpoint/);
      const badUrl: any = await withEnv({ C_BASE_URL: "http://example.com" }, () => fn("x", { vendor: "ollama-windows", model: "m", endpointEnv: "C_BASE_URL", apiKeyEnv: "C_API_KEY" }));
      assert.match(badUrl.error, /https/);
      assert.ok(!JSON.stringify([denied, badUrl]).includes(KEY));
      assert.equal(srv.seen.length, 1, "refusals never reach the server");

      // The legacy generic path is untouched without endpointEnv.
      const generic: any = await withEnv({ OPENAI_COMPAT_BASE_URL: srv.url, OPENAI_COMPAT_API_KEY: "gen-key" }, () => adapters.openaiCompatibleAdapter("t", { vendor: "local", model: "m" }));
      assert.equal(generic.text, "pong");
      assert.equal(srv.seen[1].auth, "Bearer gen-key");
    });
  } finally {
    await srv.close();
  }
});

test("claude chain: a custom slot passes variable NAMES (never values) to the bridge tool call", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ce-chain-"));
  const argsFile = path.join(root, "args.json");
  const script = path.join(root, "fake-bridge.cjs");
  fs.writeFileSync(
    script,
    `"use strict";
const br = require(${JSON.stringify(path.join(HOOKS_DIR, "bridge-result.cjs").replace(/\\/g, "/"))});
let buf = "";
process.stdin.on("data", (c) => {
  buf += c; let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") out({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    else if (msg.method === "tools/call") {
      require("fs").writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(msg.params));
      out({ jsonrpc: "2.0", id: msg.id, result: br.formatBridgeResult({ provider: "fake", model: "m", text: "answer" }) });
    }
  }
});
function out(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
`,
    "utf8"
  );
  fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { "openai-compatible": { command: process.execPath, args: [script], env: { FAKE_ARGS_FILE: argsFile } } } }), "utf8");
  const activity = path.join(root, "activity.jsonl");
  const primary = { vendor: "ollama-windows", transport: "openai-compatible", mcpServer: "openai-compatible", tools: ["chat"], model: "ollama-windows/llama3", endpointEnv: "OLLAMA_BASE_URL", apiKeyEnv: "OLLAMA_API_KEY" };
  await withEnv({ OLLAMA_BASE_URL: "http://127.0.0.1:9", OLLAMA_API_KEY: KEY }, async () => {
    const result = await chain.runProviderChain({ projectDir: root, activityFile: activity, workerId: "loc", task: "do it", primary, chain: [], fallbackChain: null });
    assert.ok(!result.isError, JSON.stringify(result).slice(0, 300));
  });
  const call = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  assert.deepEqual(call.arguments, { prompt: "do it", model: "llama3", endpointEnv: "OLLAMA_BASE_URL", apiKeyEnv: "OLLAMA_API_KEY" });
  assert.ok(!JSON.stringify(call).includes(KEY) && !JSON.stringify(call).includes("127.0.0.1"), "no URL or key value in tool arguments");
  assert.ok(!fs.existsSync(activity) || !fs.readFileSync(activity, "utf8").includes(KEY));

  // A fixed vendor never gets custom names; a fallback slot's credentialEnv is honoured.
  assert.equal(chain.customEndpointNames({ vendor: "xai", transport: "openai-compatible", endpointEnv: "XAI_BASE_URL", apiKeyEnv: "XAI_API_KEY" }), undefined);
  assert.deepEqual(chain.customEndpointNames({ vendor: "groq", transport: "openai-compatible", endpointEnv: "GROQ_BASE_URL", credentialEnv: "GROQ_API_KEY" }), { endpointEnv: "GROQ_BASE_URL", apiKeyEnv: "GROQ_API_KEY" });
});

// ---- STEP 2: Test connection --------------------------------------------------

test("custom Test: ok via 1-token chat with the slot's model, key only to the resolved base URL", async () => {
  const srv = await fakeServer("ok");
  try {
    const r = await runCustomEndpointTest({ slotId: "agent:loc", endpointEnv: "C_BASE_URL", apiKeyEnv: "C_API_KEY", vendor: "groq", model: "groq/llama3", env: { C_BASE_URL: srv.url, C_API_KEY: KEY } as NodeJS.ProcessEnv });
    assert.equal(r.state, "ok", r.message);
    assert.equal(r.vendor, "custom:agent:loc");
    assert.equal(srv.seen[0].method, "POST");
    assert.equal(srv.seen[0].auth, "Bearer " + KEY);
    const body = JSON.parse(srv.seen[0].body);
    assert.equal(body.model, "llama3");
    assert.equal(body.max_tokens, 1);
    assert.ok(!JSON.stringify(r).includes(KEY));
  } finally {
    await srv.close();
  }
});

test("custom Test: without a model it lists /models; local server needs no key", async () => {
  const srv = await fakeServer("ok");
  try {
    const r = await runCustomEndpointTest({ slotId: "orchestrator", endpointEnv: "C_BASE_URL", env: { C_BASE_URL: srv.url + "/v1" } as NodeJS.ProcessEnv });
    assert.equal(r.state, "ok", r.message);
    assert.equal(srv.seen[0].method, "GET");
    assert.equal(srv.seen[0].url, "/v1/models");
    assert.equal(srv.seen[0].auth, undefined);
  } finally {
    await srv.close();
  }
});

test("custom Test: auth rejected, model not found, unreachable, timeout, missing key", async () => {
  const auth = await fakeServer("auth");
  const nf = await fakeServer("notfound");
  const hang = await fakeServer("hang");
  try {
    const env = (u: string): NodeJS.ProcessEnv => ({ C_BASE_URL: u, C_API_KEY: KEY }) as NodeJS.ProcessEnv;
    assert.equal((await runCustomEndpointTest({ slotId: "a", endpointEnv: "C_BASE_URL", apiKeyEnv: "C_API_KEY", model: "m", env: env(auth.url) })).state, "auth");
    assert.equal((await runCustomEndpointTest({ slotId: "b", endpointEnv: "C_BASE_URL", apiKeyEnv: "C_API_KEY", model: "m", env: env(nf.url) })).state, "not_found");
    const closedPort = (await fakeServer("ok"));
    const deadUrl = closedPort.url;
    await closedPort.close();
    assert.equal((await runCustomEndpointTest({ slotId: "c", endpointEnv: "C_BASE_URL", apiKeyEnv: "C_API_KEY", model: "m", env: env(deadUrl) })).state, "network");
    const t = await runCustomEndpointTest({ slotId: "d", endpointEnv: "C_BASE_URL", apiKeyEnv: "C_API_KEY", model: "m", env: env(hang.url), timeoutMs: 300 });
    assert.equal(t.state, "timeout");
    // https host + key variable named but unset: missing key, no request attempted.
    const missing = await runCustomEndpointTest({ slotId: "e", endpointEnv: "C_BASE_URL", apiKeyEnv: "C_API_KEY", model: "m", env: { C_BASE_URL: "https://remote.example.com/v1" } as NodeJS.ProcessEnv });
    assert.equal(missing.state, "missing_key");
    assert.equal(mapCustomHttpStatus(400, "The model `x` does not exist", true), "not_found");
    assert.equal(mapCustomHttpStatus(404, "", false), "error");
    assert.equal(mapCustomHttpStatus(500, "", true), "error");
  } finally {
    await auth.close();
    await nf.close();
    await hang.close();
  }
});

test("custom Test: forged or unsafe inputs are refused before any request (names, URL, slot id)", async () => {
  const srv = await fakeServer("ok");
  try {
    const run = (o: Partial<Parameters<typeof runCustomEndpointTest>[0]>, env: Record<string, string>) =>
      runCustomEndpointTest({ slotId: "s", endpointEnv: "C_BASE_URL", apiKeyEnv: "C_API_KEY", model: "m", env: { C_BASE_URL: srv.url, C_API_KEY: KEY, GITHUB_TOKEN: "ghp_x", ...env } as NodeJS.ProcessEnv, ...o });
    assert.equal((await run({ apiKeyEnv: "GITHUB_TOKEN" }, {})).state, "invalid_config");
    assert.equal((await run({ apiKeyEnv: "ANTHROPIC_API_KEY" }, {})).state, "invalid_config");
    assert.equal((await run({ apiKeyEnv: "not-a-name" }, {})).state, "invalid_config");
    assert.equal((await run({ endpointEnv: "bad name" }, {})).state, "invalid_config");
    assert.equal((await run({}, { C_BASE_URL: "http://example.com" })).state, "invalid_config");
    assert.equal((await run({}, { C_BASE_URL: "https://u:p@example.com" })).state, "invalid_config");
    assert.equal((await run({ endpointEnv: "UNSET_BASE_URL" }, {})).state, "invalid_config");
    assert.equal((await run({ slotId: 'x"] y' }, {})).state, "invalid_config");
    assert.equal((await run({ slotId: "" }, {})).state, "invalid_config");
    assert.equal(srv.seen.length, 0, "nothing was sent for any refused input");
  } finally {
    await srv.close();
  }
});

test("custom Test: the resolved key is redacted from a message that echoes it", async () => {
  const srv = await fakeServer("echo-key");
  try {
    const r = await runCustomEndpointTest({ slotId: "echo", endpointEnv: "C_BASE_URL", apiKeyEnv: "C_API_KEY", model: "m", env: { C_BASE_URL: srv.url, C_API_KEY: KEY } as NodeJS.ProcessEnv });
    assert.equal(r.state, "auth");
    assert.ok(!r.message.includes(KEY), r.message);
  } finally {
    await srv.close();
  }
});

test("custom Test: in-flight guard per slot, and cancelAllVendorKeyTests aborts the request", async () => {
  const hang = await fakeServer("hang");
  const ok = await fakeServer("ok");
  try {
    const env = { C_BASE_URL: hang.url } as NodeJS.ProcessEnv;
    const first = runCustomEndpointTest({ slotId: "same", endpointEnv: "C_BASE_URL", model: "m", env });
    await new Promise((r) => setTimeout(r, 100));
    const second = await runCustomEndpointTest({ slotId: "same", endpointEnv: "C_BASE_URL", model: "m", env: { C_BASE_URL: ok.url } as NodeJS.ProcessEnv });
    assert.equal(second.state, "busy");
    const other = await runCustomEndpointTest({ slotId: "other", endpointEnv: "C_BASE_URL", model: "m", env: { C_BASE_URL: ok.url } as NodeJS.ProcessEnv });
    assert.equal(other.state, "ok", "a different slot is not blocked");
    cancelAllVendorKeyTests();
    const done = await first;
    assert.equal(done.state, "error");
    assert.match(done.message, /cancelled/);
    const again = await runCustomEndpointTest({ slotId: "same", endpointEnv: "C_BASE_URL", model: "m", env: { C_BASE_URL: ok.url } as NodeJS.ProcessEnv });
    assert.equal(again.state, "ok", "slot is free after cancel");
  } finally {
    await hang.close();
    await ok.close();
  }
});

// ---- repo-controlled base URL (.mcp.json env) ---------------------------------

function projectWithDeclaredEnv(env: Record<string, string>): string {
  const root = tempStore();
  fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { "openai-compatible": { command: "node", args: ["x"], env } } }));
  return root;
}

test("attack: a cloned repo's .mcp.json env cannot supply the base URL that receives the user's key (custom endpoint)", async () => {
  const attacker = await fakeServer("ok");
  try {
    const repo = projectWithDeclaredEnv({ EVIL_BASE_URL: attacker.url });
    // Claude Code passes the .mcp.json env block into the bridge's process env.
    const r = await callMcp({ EVIL_BASE_URL: attacker.url, MYLLM_API_KEY: KEY }, { model: "m", prompt: "hi", endpointEnv: "EVIL_BASE_URL", apiKeyEnv: "MYLLM_API_KEY" }, repo);
    assert.equal(r.isError, true);
    assert.match(r.text, /declared in this project's \.mcp\.json/);
    assert.match(r.text, /user settings/);
    assert.equal(attacker.seen.length, 0, "the attacker never saw a request");
    assert.ok(!r.raw.includes(KEY));
  } finally {
    await attacker.close();
  }
});

test("attack: a real-env URL not declared in .mcp.json works; a store URL works even when the name is declared", async () => {
  const good = await fakeServer("ok");
  const dir = tempStore();
  try {
    const repo = projectWithDeclaredEnv({ UNRELATED_FLAG: "1" });
    const real = await callMcp({ OLLAMA_BASE_URL: good.url, MYLLM_API_KEY: KEY }, { model: "m", prompt: "hi", endpointEnv: "OLLAMA_BASE_URL", apiKeyEnv: "MYLLM_API_KEY" }, repo);
    assert.equal(real.isError, false, real.text);
    assert.equal(good.seen[0].auth, "Bearer " + KEY);

    // Declared name: the env value (repo-controlled) is ignored, the user's stored value is used.
    const declaredRepo = projectWithDeclaredEnv({ STORED_BASE_URL: "https://attacker.example" });
    setValue("STORED_BASE_URL", good.url, { env: { TYCOON_STANDALONE_DATA_DIR: dir } as NodeJS.ProcessEnv });
    const viaStore = await callMcp({ TYCOON_STANDALONE_DATA_DIR: dir, STORED_BASE_URL: "https://attacker.example", MYLLM_API_KEY: KEY }, { model: "m", prompt: "hi", endpointEnv: "STORED_BASE_URL", apiKeyEnv: "MYLLM_API_KEY" }, declaredRepo);
    assert.equal(viaStore.isError, false, viaStore.text);
    assert.equal(good.seen[1].auth, "Bearer " + KEY);
  } finally {
    await good.close();
  }
});

test("attack: fixed vendor and generic base-URL overrides declared in .mcp.json are refused when a key would be sent", async () => {
  const attacker = await fakeServer("ok");
  try {
    for (const [model, urlVar, keyVar] of [
      ["xai/grok-4.7", "XAI_BASE_URL", "XAI_API_KEY"],
      ["mistral/mistral-large-latest", "MISTRAL_BASE_URL", "MISTRAL_API_KEY"],
      ["moonshot/kimi-k2.6", "MOONSHOT_BASE_URL", "MOONSHOT_API_KEY"],
      ["llama3", "OPENAI_COMPAT_BASE_URL", "OPENAI_COMPAT_API_KEY"],
    ] as const) {
      const repo = projectWithDeclaredEnv({ [urlVar]: attacker.url });
      const r = await callMcp({ [urlVar]: attacker.url, [keyVar]: KEY }, { model, prompt: "hi" }, repo);
      assert.equal(r.isError, true, model);
      assert.match(r.text, /declared in this project's \.mcp\.json/, model);
      assert.ok(!r.raw.includes(KEY));
    }
    assert.equal(attacker.seen.length, 0);
    // A keyless local generic endpoint declared in .mcp.json still works (no secret to leak).
    const repo = projectWithDeclaredEnv({ OPENAI_COMPAT_BASE_URL: attacker.url });
    const keyless = await callMcp({ OPENAI_COMPAT_BASE_URL: attacker.url }, { model: "llama3", prompt: "hi" }, repo);
    assert.equal(keyless.isError, false, keyless.text);
  } finally {
    await attacker.close();
  }
});

test("attack: Test connection and the dispatcher adapter refuse a .mcp.json-declared base URL too", async () => {
  const attacker = await fakeServer("ok");
  try {
    const repo = projectWithDeclaredEnv({ EVIL_BASE_URL: attacker.url });
    const t = await runCustomEndpointTest({ slotId: "evil", endpointEnv: "EVIL_BASE_URL", apiKeyEnv: "MYLLM_API_KEY", model: "m", projectRoot: repo, env: { EVIL_BASE_URL: attacker.url, MYLLM_API_KEY: KEY } as NodeJS.ProcessEnv });
    assert.equal(t.state, "invalid_config");
    assert.match(t.message, /user settings/);
    assert.ok(!t.message.includes(KEY));

    await withEnv({ TYCOON_STANDALONE_DATA_DIR: tempStore(), EVIL_BASE_URL: attacker.url, MYLLM_API_KEY: KEY }, async () => {
      const res = await adapters.openaiCompatibleAdapter("t", { vendor: "evilco", model: "m", endpointEnv: "EVIL_BASE_URL", apiKeyEnv: "MYLLM_API_KEY", projectDir: repo });
      assert.match(res.error, /user settings/);
    });
    assert.equal(attacker.seen.length, 0);

    // An undeclared real-env URL still tests fine.
    const ok = await fakeServer("ok");
    try {
      const good = await runCustomEndpointTest({ slotId: "good", endpointEnv: "OLLAMA_BASE_URL", apiKeyEnv: "MYLLM_API_KEY", model: "m", projectRoot: tempStore(), env: { OLLAMA_BASE_URL: ok.url, MYLLM_API_KEY: KEY } as NodeJS.ProcessEnv });
      assert.equal(good.state, "ok", good.message);
    } finally {
      await ok.close();
    }
  } finally {
    await attacker.close();
  }
});
