/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tests hooks/bridge-result.cjs (plan p98-t1): the shared MCP bridge result
// envelope, its truncation/error caps, withTimeout, and parseBridgeResult.

import { test } from "node:test";
import assert from "node:assert/strict";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bridge = require("../../hooks/bridge-result.cjs") as {
  STATUSES: string[];
  DEFAULT_MAX_CHARS: number;
  TEXT_HEADER_PREFIX: string;
  formatBridgeResult: (o: Record<string, unknown>) => {
    content: Array<{ type: string; text: string }>;
    isError: boolean;
    structuredContent: Record<string, any>;
  };
  withTimeout: (p: Promise<unknown>, ms?: number, label?: string, o?: Record<string, unknown>) => Promise<any>;
  parseBridgeResult: (r: unknown) => Record<string, any> | null;
};

const { formatBridgeResult, withTimeout, parseBridgeResult } = bridge;

test("ok result carries the envelope and isError false", () => {
  const r = formatBridgeResult({ provider: "openai-compatible", model: "kimi-k2", text: "LGTM, mentions 401 and quota only in prose" });
  assert.equal(r.isError, false);
  assert.equal(r.content[0].text, "LGTM, mentions 401 and quota only in prose");
  assert.deepEqual(r.structuredContent, {
    tycoonBridge: 1,
    status: "ok",
    provider: "openai-compatible",
    model: "kimi-k2",
    summary: "LGTM, mentions 401 and quota only in prose",
    truncated: false,
  });
});

test("every non-ok status sets isError and an error object", () => {
  for (const status of ["provider_error", "timeout", "empty"]) {
    const r = formatBridgeResult({
      status,
      provider: "p",
      model: "m",
      text: status === "empty" ? "" : "partial",
      error: { kind: "http_401", message: "bad key" },
    });
    assert.equal(r.isError, true, status);
    assert.equal(r.structuredContent.status, status);
    assert.ok(r.structuredContent.error, status);
    assert.ok(r.content[0].text.length > 0, `${status} text must not be blank`);
  }
});

test("provider_error keeps the supplied error kind and message", () => {
  const r = formatBridgeResult({ status: "provider_error", provider: "p", model: "m", error: { kind: "http_429", message: "rate limited" } });
  assert.deepEqual(r.structuredContent.error, { kind: "http_429", message: "rate limited" });
});

test("empty and whitespace-only output become status empty", () => {
  for (const text of ["", "   \n\t "]) {
    const r = formatBridgeResult({ provider: "p", model: "m", text });
    assert.equal(r.structuredContent.status, "empty");
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error.kind, "empty");
  }
  assert.equal(formatBridgeResult({ provider: "p", model: "m" }).structuredContent.status, "empty");
});

test("summary is capped at TYCOON_BRIDGE_MAX_CHARS with truncated flag and marker", () => {
  const r = formatBridgeResult({ provider: "p", model: "m", text: "a".repeat(150), env: { TYCOON_BRIDGE_MAX_CHARS: "100" } });
  assert.equal(r.structuredContent.truncated, true);
  assert.equal(r.structuredContent.status, "ok");
  assert.match(r.structuredContent.summary, /\[truncated 50 chars\]$/);
  assert.equal(r.structuredContent.summary.startsWith("a".repeat(100)), true);
  assert.equal(r.isError, false);
});

test("text at exactly the cap is not truncated; default cap is 12000", () => {
  const at = formatBridgeResult({ provider: "p", model: "m", text: "b".repeat(100), env: { TYCOON_BRIDGE_MAX_CHARS: "100" } });
  assert.equal(at.structuredContent.truncated, false);
  const big = formatBridgeResult({ provider: "p", model: "m", text: "c".repeat(bridge.DEFAULT_MAX_CHARS + 1), env: {} });
  assert.equal(big.structuredContent.truncated, true);
});

test("invalid TYCOON_BRIDGE_MAX_CHARS falls back to the default", () => {
  const r = formatBridgeResult({ provider: "p", model: "m", text: "x".repeat(500), env: { TYCOON_BRIDGE_MAX_CHARS: "nope" } });
  assert.equal(r.structuredContent.truncated, false);
});

test("error.message is capped at 500 chars", () => {
  const r = formatBridgeResult({ status: "provider_error", provider: "p", model: "m", error: { kind: "x", message: "e".repeat(2000) } });
  assert.equal(r.structuredContent.error.message.length, 500);
});

test("extra fields merge into structuredContent without overriding the envelope", () => {
  const r = formatBridgeResult({ provider: "p", model: "m", text: "hi", extra: { usage: { input_tokens: 3 }, status: "bogus" } });
  assert.deepEqual(r.structuredContent.usage, { input_tokens: 3 });
  assert.equal(r.structuredContent.status, "ok");
});

test("withTimeout resolves to a timeout result when the promise outlasts the injected timeout", async () => {
  const never = new Promise(() => undefined);
  const r = await withTimeout(never, 10, "kimi", { provider: "openai-compatible", model: "kimi-k2" });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.status, "timeout");
  assert.equal(r.structuredContent.provider, "openai-compatible");
  assert.equal(r.structuredContent.error.kind, "timeout");
  assert.match(r.structuredContent.error.message, /kimi timed out after 10ms/);
});

test("withTimeout passes through a promise that settles first", async () => {
  const value = { ok: true };
  assert.equal(await withTimeout(Promise.resolve(value), 1000, "x"), value);
});

test("withTimeout default comes from env then the caller's defaultMs", async () => {
  const never = new Promise(() => undefined);
  const viaEnv = await withTimeout(never, undefined, "a", { env: { TYCOON_BRIDGE_TIMEOUT_MS: "5" } });
  assert.match(viaEnv.structuredContent.error.message, /after 5ms/);
  const viaDefault = await withTimeout(never, undefined, "b", { defaultMs: 7, env: {} });
  assert.match(viaDefault.structuredContent.error.message, /after 7ms/);
});

test("parseBridgeResult round-trips a formatted result in each delivery form", () => {
  for (const status of ["ok", "provider_error", "timeout", "empty"]) {
    const r = formatBridgeResult({ status, provider: "p", model: "m", text: status === "empty" ? "" : "body", error: { kind: "k", message: "msg" } });
    const expected = parseBridgeResult(r);
    assert.ok(expected);
    assert.equal(expected!.status, status === "ok" ? "ok" : status);
    assert.deepEqual(parseBridgeResult(JSON.stringify(r)), expected);
    assert.deepEqual(parseBridgeResult({ tool_response: r }), expected);
    assert.deepEqual(parseBridgeResult(r.structuredContent), expected);
    const header = bridge.TEXT_HEADER_PREFIX + JSON.stringify(expected) + "\nhuman summary";
    assert.deepEqual(parseBridgeResult({ content: [{ type: "text", text: header }] }), expected);
    assert.deepEqual(parseBridgeResult(header), expected);
  }
});

test("parseBridgeResult returns null for foreign responses", () => {
  assert.equal(parseBridgeResult(undefined), null);
  assert.equal(parseBridgeResult(null), null);
  assert.equal(parseBridgeResult("Error 401 Unauthorized: quota exceeded"), null);
  assert.equal(parseBridgeResult({ content: [{ type: "text", text: "plain review text" }], isError: true }), null);
  assert.equal(parseBridgeResult({ structuredContent: { usage: {} } }), null);
  assert.equal(parseBridgeResult({ tycoonBridge: 2, status: "ok" }), null);
  assert.equal(parseBridgeResult(bridge.TEXT_HEADER_PREFIX + "{not json"), null);
});
