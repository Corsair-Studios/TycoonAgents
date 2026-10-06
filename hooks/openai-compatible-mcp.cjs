#!/usr/bin/env node
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * ---------------------------------------------------------------------------
 * Zero-dependency MCP stdio server bridging Claude to any OpenAI-compatible
 * chat-completions endpoint (vLLM, Ollama, LM Studio, or a hosted
 * OpenAI-compatible API such as Moonshot's Kimi or Alibaba's Qwen — including
 * one running on a remote VM). See media/mcp/catalog.json's "openai-compatible"
 * entry for the launch config; catalog id "openai-compatible".
 *
 * Transport: JSON-RPC 2.0 messages, one per line, newline-delimited, over
 * stdin/stdout (the standard MCP stdio framing — see
 * https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio).
 * stderr is free for logging and is never parsed by the client.
 *
 * Handshake: as of the 2026-07-28 spec revision, MCP's *current* ("modern")
 * wire format carries protocol version + capabilities as per-request `_meta`
 * on every call, with no initialize handshake at all (see
 * https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle,
 * "Versioning and Compatibility"). That revision explicitly keeps the older
 * ("legacy", 2025-11-25 and earlier) `initialize`-handshake flow working for
 * exactly this reason: a "Legacy client, Dual-era server" pairing "Works...
 * according to the negotiated legacy revision." Claude Code, as of this
 * writing, still speaks the legacy handshake (initialize -> initialized ->
 * tools/list -> tools/call), so this server implements ONLY that path —
 * simplest, and it is the one every current client here actually uses. It
 * echoes back whatever protocolVersion the client sent in its `initialize`
 * request (a widely-used compatibility pattern for a server with no reason
 * to refuse an older client), rather than hardcoding one version string that
 * could reject a client speaking a slightly different legacy revision.
 *
 * Methods implemented:
 *   initialize   -> { protocolVersion (echoed), capabilities: { tools: {} },
 *                      serverInfo: { name, version } }
 *   (notifications/initialized received, no response — it is a notification)
 *   tools/list   -> { tools: [ <chat tool descriptor> ] }
 *   tools/call   -> { content: [ { type: "text", text: <assistant reply> } ],
 *                      structuredContent: { usage: { input_tokens, output_tokens } },
 *                      isError?: true }
 *
 * The `chat` tool's inputSchema: { model: string, prompt: string,
 * system?: string, messages?: [{role, content}], max_tokens?: number }.
 * Exactly one of `prompt` or `messages` should be given; `prompt` (+ optional
 * `system`) is sugar for a one-shot [{role:"system",...}?, {role:"user",...}]
 * messages array.
 *
 * Response shape contract (for the hook / any downstream parser):
 *   - content[0].text is ALWAYS the plain assistant text on success.
 *   - structuredContent.usage, when the upstream response carried a `usage`
 *     object, is { input_tokens, output_tokens } mapped 1:1 from OpenAI's
 *     { prompt_tokens, completion_tokens }. Omitted (not present, never
 *     zero-filled) when the upstream response has no usage object.
 *   - A trailing NDJSON line `{"usage": {...}}` is ALSO appended after the
 *     JSON-RPC response line on stdout when usage is available, as a
 *     belt-and-suspenders path for a caller that scrapes raw stdout instead
 *     of parsing structuredContent — this is not itself a JSON-RPC message
 *     and MUST be ignored by a spec-compliant JSON-RPC client (parse each
 *     stdout line as JSON-RPC and skip lines that don't look like one).
 *   - Every tools/call result carries the shared bridge envelope (see
 *     hooks/bridge-result.cjs) in structuredContent: status ok | provider_error
 *     | timeout | empty, plus provider ("openai-compatible"), model, summary,
 *     truncated and, on non-ok, error { kind, message }. The summary is capped
 *     at TYCOON_BRIDGE_MAX_CHARS (truncated=true above it); content[0].text
 *     is the capped summary on ok, else the readable error message.
 *   - Missing OPENAI_COMPAT_BASE_URL, or any request-time failure (network
 *     error, non-2xx, malformed upstream JSON), is a provider_error result
 *     (isError:true) with a plain-text message in content[0].text naming the
 *     problem and an error.kind of auth | quota | rate_limit | not_found |
 *     network | unknown — never a thrown exception and never a JSON-RPC
 *     `error` object. An elapsed request timeout is status "timeout"; an
 *     empty/whitespace completion is status "empty".
 * ---------------------------------------------------------------------------
 */

"use strict";

const http = require("http");
const https = require("https");
const readline = require("readline");
const path = require("path");
const fs = require("fs");
const { formatBridgeResult, providerErrorResult } = require("./bridge-result.cjs");

// ---------------------------------------------------------------------------
// p13-t6: local-store fallback for OPENAI_COMPAT_BASE_URL /
// OPENAI_COMPAT_API_KEY. process.env is checked FIRST (unchanged behavior);
// only when a var is unset do we fall back to the per-user secret store
// (src/core/localEnvStore.ts, compiled). Resolution order for the compiled
// module, fail-open at every step (a hook must never crash a chat call
// because the store is unavailable):
//   1. hooks/localEnvStore.js — a copy shipped alongside this hook (see
//      scripts/copy-hook-runtime.mjs), same posture as agentBackend.js/
//      modelAliases.js already copied there.
//   2. ../out/src/core/localEnvStore.js — a dev checkout that built but
//      hasn't run copy-hook-runtime yet.
// The stored value is never logged.
// ---------------------------------------------------------------------------
let _localEnvStore;
let _localEnvStoreTried = false;
function localEnvStore() {
  if (_localEnvStoreTried) return _localEnvStore;
  _localEnvStoreTried = true;
  const candidates = [path.join(__dirname, "localEnvStore.js"), path.join(__dirname, "..", "out", "src", "core", "localEnvStore.js")];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        _localEnvStore = require(candidate);
        return _localEnvStore;
      }
    } catch {
      // Try the next candidate — a broken/missing compiled module must
      // never crash the MCP server.
    }
  }
  return undefined;
}

/** process.env[name] first, else the per-user local store, else undefined. Never throws, never logs the value. */
function resolveEnvOrLocal(name) {
  const fromEnv = process.env[name];
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  try {
    const store = localEnvStore();
    if (store && typeof store.getValue === "function") return store.getValue(name);
  } catch {
    // fail-open
  }
  return undefined;
}

const SERVER_NAME = "openai-compatible-mcp";
const SERVER_VERSION = "1.0.0";

const CHAT_TOOL = {
  name: "chat",
  description:
    "Send a chat completion request to an OpenAI-compatible endpoint (vLLM, Ollama, LM Studio, or a hosted OpenAI-compatible API such as Kimi or Qwen), configured via OPENAI_COMPAT_BASE_URL / OPENAI_COMPAT_API_KEY.",
  inputSchema: {
    type: "object",
    properties: {
      model: { type: "string", description: "Model id as understood by the target endpoint (e.g. \"moonshot/kimi-k2.6\", \"llama3\", \"qwen2.5\")." },
      prompt: { type: "string", description: "User prompt. Ignored if `messages` is given." },
      system: { type: "string", description: "Optional system prompt, prepended when using `prompt`." },
      messages: {
        type: "array",
        description: "Full chat messages array, alternative to prompt/system.",
        items: {
          type: "object",
          properties: {
            role: { type: "string" },
            content: { type: "string" },
          },
          required: ["role", "content"],
        },
      },
      max_tokens: { type: "number", description: "Optional max tokens to generate." },
    },
    required: ["model"],
  },
};

function writeMessage(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function respond(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Build the base URL for the chat completions endpoint, tolerating a
 * BASE_URL that already ends in "/v1" (or "/v1/"). */
function buildChatUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const withV1 = /\/v1$/.test(trimmed) ? trimmed : trimmed + "/v1";
  return withV1 + "/chat/completions";
}

/** Default request timeout, overridable via OPENAI_COMPAT_TIMEOUT_MS — bounds
 * how long a single tools/call waits on a hung/unresponsive endpoint before
 * failing with isError:true instead of hanging the server (and the calling
 * agent's turn) indefinitely. */
const DEFAULT_TIMEOUT_MS = 120000;

/** OPENAI_COMPAT_TIMEOUT_MS first, then the shared TYCOON_BRIDGE_TIMEOUT_MS, else the 120s default. */
function resolveTimeoutMs() {
  for (const name of ["OPENAI_COMPAT_TIMEOUT_MS", "TYCOON_BRIDGE_TIMEOUT_MS"]) {
    const n = Number(process.env[name]);
    if (process.env[name] && Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TIMEOUT_MS;
}

const PROVIDER = "openai-compatible";

function errorResult(model, text, statusCode, kindOverride) {
  return providerErrorResult({ provider: PROVIDER, model, text, kind: kindOverride, httpStatus: statusCode });
}

function postJson(urlString, body, apiKey) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (err) {
      reject(new Error(`Invalid OPENAI_COMPAT_BASE_URL: ${err.message}`));
      return;
    }
    const payload = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    };
    if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
    const lib = url.protocol === "https:" ? https : http;
    const timeoutMs = resolveTimeoutMs();
    let settled = false;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve({ statusCode: res.statusCode || 0, body: data });
        });
      },
    );
    // Total deadline (not socket-idle): a slowly trickling response is bounded too.
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      const err = new Error(`Request to ${urlString} timed out after ${timeoutMs}ms (set OPENAI_COMPAT_TIMEOUT_MS or TYCOON_BRIDGE_TIMEOUT_MS to override)`);
      err.bridgeTimeout = true;
      reject(err);
    }, timeoutMs);
    if (deadline.unref) deadline.unref();
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Vendor-prefixed models — a known vendor's model id (e.g. "xai/grok-4.7")
// is routed to a DEDICATED endpoint/key pair, completely separate from the
// generic OPENAI_COMPAT_BASE_URL/OPENAI_COMPAT_API_KEY pair a Kimi/Qwen/
// local-endpoint user configures — the two must never mix: a request for a
// prefixed model must not silently go to whatever host/key the generic
// pair happens to point at (and vice versa), or a Kimi user's Grok calls
// would leak to the Kimi host under the Kimi key, or a Grok user's Kimi
// calls would go to xAI. `baseUrlEnv` is an explicit override (checked
// first); `defaultBaseUrl` is used only when that override is unset.
// `apiKeyEnv` is the ONLY key source for a prefixed model — no fallback to
// OPENAI_COMPAT_API_KEY. The vendor's own prefix is stripped before the
// model id is sent upstream (the vendor's API doesn't know this project's
// "xai/" disambiguation prefix); pricing/metrics lookups elsewhere in this
// project key off the PREFIXED id (e.g. "xai/grok-build-0.1"), which this
// server never sees or touches — only the outgoing HTTP request strips it.
// ---------------------------------------------------------------------------
const VENDOR_DEFAULTS = [
  { prefix: "xai/", baseUrlEnv: "XAI_BASE_URL", defaultBaseUrl: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY" },
  // Mistral routes ONLY on the explicit "mistral/" prefix: bare ids like
  // "mistral:7b" or "dolphin-mistral" are local Ollama/LM Studio models on the
  // generic OPENAI_COMPAT_* path and must never reach the cloud endpoint.
  { prefix: "mistral/", baseUrlEnv: "MISTRAL_BASE_URL", defaultBaseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY" },
  // Moonshot (Kimi) routes ONLY on the explicit "moonshot/" prefix, so hosted
  // Kimi no longer shares OPENAI_COMPAT_* with local models (Qwen via Ollama,
  // bare ids like "qwen3:8b"), which stay on the generic path. International
  // endpoint per https://platform.kimi.ai/docs/guide/start-using-kimi-api.
  { prefix: "moonshot/", baseUrlEnv: "MOONSHOT_BASE_URL", defaultBaseUrl: "https://api.moonshot.ai/v1", apiKeyEnv: "MOONSHOT_API_KEY" },
];

function vendorDefaultsFor(model) {
  if (typeof model !== "string") return undefined;
  return VENDOR_DEFAULTS.find((v) => model.startsWith(v.prefix));
}

async function handleChatTool(args) {
  const model = args && typeof args.model === "string" ? args.model : undefined;
  if (!model) {
    return errorResult("", "Missing required argument: model", undefined, "unknown");
  }
  const vendorDefault = vendorDefaultsFor(model);

  let baseUrl;
  let apiKey;
  if (vendorDefault) {
    // Prefixed model: dedicated endpoint/key only, never the generic
    // OPENAI_COMPAT_* pair — see the comment above this table.
    baseUrl = resolveEnvOrLocal(vendorDefault.baseUrlEnv) || vendorDefault.defaultBaseUrl;
    apiKey = resolveEnvOrLocal(vendorDefault.apiKeyEnv);
    if (!apiKey && vendorDefault.prefix === "moonshot/") {
      // Existing Kimi installs configured the generic pair. Honor it ONLY when
      // its host is Moonshot's own, so the key never goes to another host.
      const legacyBase = resolveEnvOrLocal("OPENAI_COMPAT_BASE_URL");
      const legacyKey = resolveEnvOrLocal("OPENAI_COMPAT_API_KEY");
      let legacyHost = "";
      try { legacyHost = new URL(legacyBase).hostname.toLowerCase(); } catch { /* not a URL */ }
      if (legacyKey && /(^|\.)moonshot\.(ai|cn)$/.test(legacyHost)) {
        baseUrl = legacyBase;
        apiKey = legacyKey;
      }
    }
    if (!apiKey && vendorDefault.prefix === "moonshot/") {
      return errorResult(model, `${vendorDefault.apiKeyEnv} is not set — configure it to your Moonshot API key (model "${model}" requires it). The legacy OPENAI_COMPAT_BASE_URL/OPENAI_COMPAT_API_KEY pair is only honored when OPENAI_COMPAT_BASE_URL points at a moonshot.ai or moonshot.cn host.`, undefined, "auth");
    }
    if (!apiKey) {
      return errorResult(model, `${vendorDefault.apiKeyEnv} is not set — configure it to your API key for this endpoint (model "${model}" requires it; the generic OPENAI_COMPAT_API_KEY is never used for this vendor).`, undefined, "auth");
    }
  } else {
    baseUrl = resolveEnvOrLocal("OPENAI_COMPAT_BASE_URL");
    if (!baseUrl) {
      return errorResult(model, "OPENAI_COMPAT_BASE_URL is not set — configure it to the base URL of your OpenAI-compatible endpoint (e.g. http://localhost:11434 for Ollama, or your vLLM/LM Studio/hosted API base).", undefined, "unknown");
    }
    apiKey = resolveEnvOrLocal("OPENAI_COMPAT_API_KEY") || undefined;
  }

  let messages;
  if (Array.isArray(args.messages) && args.messages.length > 0) {
    messages = args.messages;
  } else if (typeof args.prompt === "string") {
    messages = [];
    if (typeof args.system === "string" && args.system) messages.push({ role: "system", content: args.system });
    messages.push({ role: "user", content: args.prompt });
  } else {
    return errorResult(model, "Provide either `prompt` (+ optional `system`) or `messages`.", undefined, "unknown");
  }

  // Strip this project's disambiguation prefix (e.g. "xai/") before sending
  // upstream — the vendor's own API only knows its own model id form.
  const upstreamModel = vendorDefault ? model.slice(vendorDefault.prefix.length) : model;
  const requestBody = { model: upstreamModel, messages };
  if (typeof args.max_tokens === "number") requestBody.max_tokens = args.max_tokens;

  const url = buildChatUrl(baseUrl);

  let res;
  try {
    res = await postJson(url, requestBody, apiKey);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (err && err.bridgeTimeout) {
      return formatBridgeResult({ status: "timeout", provider: PROVIDER, model, error: { kind: "timeout", message } });
    }
    return errorResult(model, `Request to ${url} failed: ${message}`);
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return errorResult(model, `Endpoint ${url} returned HTTP ${res.statusCode}: ${res.body.slice(0, 2000)}`, res.statusCode);
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (err) {
    return errorResult(model, `Endpoint ${url} returned non-JSON response: ${res.body.slice(0, 2000)}`, undefined, "unknown");
  }

  const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  const text = choice && choice.message && typeof choice.message.content === "string" ? choice.message.content : undefined;
  if (text === undefined) {
    return errorResult(model, `Endpoint ${url} returned an unexpected shape (no choices[0].message.content): ${res.body.slice(0, 2000)}`, undefined, "unknown");
  }

  const usageRaw = parsed && parsed.usage;
  let usage;
  if (usageRaw && (typeof usageRaw.prompt_tokens === "number" || typeof usageRaw.completion_tokens === "number")) {
    usage = {
      input_tokens: usageRaw.prompt_tokens,
      output_tokens: usageRaw.completion_tokens,
    };
    // Belt-and-suspenders trailing NDJSON line — see header comment.
    try { process.stdout.write(JSON.stringify({ usage }) + "\n"); } catch { /* never break the server over a logging line */ }
  }
  return formatBridgeResult({
    status: "ok",
    provider: PROVIDER,
    model,
    text,
    error: { kind: "empty", message: "Endpoint returned an empty completion" },
    extra: usage ? { usage } : undefined,
  });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    const clientProtocolVersion = params && typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
    respond(id, {
      protocolVersion: clientProtocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }

  if (method === "notifications/initialized") {
    // Notification — no id, no response.
    return;
  }

  if (method === "tools/list") {
    respond(id, { tools: [CHAT_TOOL] });
    return;
  }

  if (method === "tools/call") {
    const toolName = params && params.name;
    const args = (params && params.arguments) || {};
    if (toolName !== "chat") {
      respond(id, { isError: true, content: [{ type: "text", text: `Unknown tool: ${toolName}` }] });
      return;
    }
    try {
      const result = await handleChatTool(args);
      respond(id, result);
    } catch (err) {
      // Defensive: handleChatTool should never throw, but never let an
      // unexpected exception crash the server or leave the client hanging.
      respond(id, errorResult("", `Unexpected error: ${err && err.message ? err.message : String(err)}`, undefined, "unknown"));
    }
    return;
  }

  // Unknown method with an id: respond with a JSON-RPC method-not-found error.
  if (id !== undefined) {
    respondError(id, -32601, `Method not found: ${method}`);
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      // Ignore unparsable lines rather than crashing the server — but note it
      // on stderr (never stdout, which is reserved for JSON-RPC messages) so
      // a malformed line is diagnosable instead of silently vanishing.
      try {
        process.stderr.write(
          `[openai-compatible-mcp] ignoring malformed JSON-RPC line: ${err && err.message ? err.message : String(err)}
`
        );
      } catch { /* never let a stderr write break the server */ }
      return;
    }
    handleRequest(msg).catch(() => { /* handleRequest itself never rejects; defensive only */ });
  });
  rl.on("close", () => process.exit(0));
}

main();
