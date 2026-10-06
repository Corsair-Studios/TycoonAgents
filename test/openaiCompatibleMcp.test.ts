/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Plan task p98-t4: smoke tests for hooks/openai-compatible-mcp.cjs, run as a
// real child process speaking MCP over stdio against a loopback
// chat-completions server (no external network). Covers ok / provider_error /
// timeout / empty / truncation; every non-ok reply must set isError.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as path from "node:path";
import { callBridge, cleanupBridges, envelopeOf } from "./helpers/mcpBridge";

const SCRIPT = path.join(__dirname, "..", "..", "hooks", "openai-compatible-mcp.cjs");

let server: http.Server | undefined;
let baseUrl = "";

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const prompt = String(JSON.parse(body).messages[0].content);
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
        };
        if (prompt === "HANG") return; // never answers
        if (prompt === "AUTH") return json(401, '{"error":"Invalid API key"}');
        if (prompt === "RATE") return json(429, '{"error":"Too many requests"}');
        if (prompt === "QUOTA") return json(402, '{"error":"Insufficient credit"}');
        if (prompt === "MISSING") return json(404, '{"error":"model does not exist"}');
        const content = prompt === "EMPTY" ? "   " : prompt === "BIG" ? "x".repeat(200) : "answer";
        json(200, { choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
      resolve();
    });
  });
}

after(() => {
  cleanupBridges();
  if (server) { server.closeAllConnections(); server.close(); }
});

async function openai(prompt: string, env: NodeJS.ProcessEnv = {}) {
  if (!server) await startServer();
  return callBridge(SCRIPT, { OPENAI_COMPAT_BASE_URL: baseUrl, OPENAI_COMPAT_API_KEY: "test-key", ...env }, { name: "chat", arguments: { model: "fake-model", prompt } });
}

test("ok: envelope, provider/model, summary and usage; isError false", async () => {
  const { reply } = await openai("OK");
  const env = envelopeOf(reply);
  assert.equal(env.status, "ok");
  assert.equal(env.provider, "openai-compatible");
  assert.equal(env.model, "fake-model");
  assert.equal(env.summary, "answer");
  assert.equal(env.truncated, false);
  assert.equal(env.error, undefined);
  assert.equal(reply!.result!.isError, false);
  assert.deepEqual(reply!.result!.structuredContent!.usage, { input_tokens: 3, output_tokens: 4 });
});

test("provider_error: HTTP statuses map to auth / rate_limit / billing / not_found with isError", async () => {
  // A 402 whose body says "Insufficient credit" is billing (OpenRouter-style); a bare 402 stays quota.
  const cases: Array<[string, string]> = [["AUTH", "auth"], ["RATE", "rate_limit"], ["QUOTA", "billing"], ["MISSING", "not_found"]];
  for (const [prompt, kind] of cases) {
    const { reply } = await openai(prompt);
    const env = envelopeOf(reply);
    assert.equal(env.status, "provider_error", prompt);
    assert.equal(env.error?.kind, kind, prompt);
    assert.equal(reply!.result!.isError, true, prompt);
  }
});

test("provider_error: an unreachable endpoint is kind network", async () => {
  const { reply } = await openai("OK", { OPENAI_COMPAT_BASE_URL: "http://127.0.0.1:1" });
  const env = envelopeOf(reply);
  assert.equal(env.status, "provider_error");
  assert.equal(env.error?.kind, "network");
  assert.equal(reply!.result!.isError, true);
});

test("timeout: an unanswered request returns status timeout within the injected limit", async () => {
  const { reply } = await openai("HANG", { OPENAI_COMPAT_TIMEOUT_MS: "300" });
  const env = envelopeOf(reply);
  assert.equal(env.status, "timeout");
  assert.equal(env.error?.kind, "timeout");
  assert.equal(reply!.result!.isError, true);
});

test("empty: whitespace-only content is status empty with isError", async () => {
  const { reply } = await openai("EMPTY");
  const env = envelopeOf(reply);
  assert.equal(env.status, "empty");
  assert.equal(env.error?.kind, "empty");
  assert.equal(reply!.result!.isError, true);
});

test("truncation: output above TYCOON_BRIDGE_MAX_CHARS is capped, truncated=true, still ok", async () => {
  const { reply } = await openai("BIG", { TYCOON_BRIDGE_MAX_CHARS: "10" });
  const env = envelopeOf(reply);
  assert.equal(env.status, "ok");
  assert.equal(env.truncated, true);
  assert.ok(env.summary.startsWith("x".repeat(10)) && env.summary.length < 100, env.summary);
  assert.equal(reply!.result!.isError, false);
});
