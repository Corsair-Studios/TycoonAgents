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
 *   - Missing OPENAI_COMPAT_BASE_URL, or any request-time failure (network
 *     error, non-2xx, malformed upstream JSON), is reported as a normal
 *     tools/call result with isError:true and a plain-text message in
 *     content[0].text naming the problem — never a thrown exception and
 *     never a JSON-RPC `error` object, matching the codex MCP server's own
 *     isError convention documented in .claude/agents/codex-reviewer.md.
 * ---------------------------------------------------------------------------
 */

"use strict";

const http = require("http");
const https = require("https");
const readline = require("readline");

const SERVER_NAME = "openai-compatible-mcp";
const SERVER_VERSION = "1.0.0";

const CHAT_TOOL = {
  name: "chat",
  description:
    "Send a chat completion request to an OpenAI-compatible endpoint (vLLM, Ollama, LM Studio, or a hosted OpenAI-compatible API such as Kimi or Qwen), configured via OPENAI_COMPAT_BASE_URL / OPENAI_COMPAT_API_KEY.",
  inputSchema: {
    type: "object",
    properties: {
      model: { type: "string", description: "Model id as understood by the target endpoint (e.g. \"moonshot/kimi-k2\", \"llama3\", \"qwen2.5\")." },
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

function resolveTimeoutMs() {
  const raw = process.env.OPENAI_COMPAT_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
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
          resolve({ statusCode: res.statusCode || 0, body: data });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`Request to ${urlString} timed out after ${timeoutMs}ms (set OPENAI_COMPAT_TIMEOUT_MS to override)`));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

async function handleChatTool(args) {
  const baseUrl = process.env.OPENAI_COMPAT_BASE_URL;
  if (!baseUrl) {
    return {
      isError: true,
      content: [{ type: "text", text: "OPENAI_COMPAT_BASE_URL is not set — configure it to the base URL of your OpenAI-compatible endpoint (e.g. http://localhost:11434 for Ollama, or your vLLM/LM Studio/hosted API base)." }],
    };
  }
  const model = args && typeof args.model === "string" ? args.model : undefined;
  if (!model) {
    return { isError: true, content: [{ type: "text", text: "Missing required argument: model" }] };
  }
  let messages;
  if (Array.isArray(args.messages) && args.messages.length > 0) {
    messages = args.messages;
  } else if (typeof args.prompt === "string") {
    messages = [];
    if (typeof args.system === "string" && args.system) messages.push({ role: "system", content: args.system });
    messages.push({ role: "user", content: args.prompt });
  } else {
    return { isError: true, content: [{ type: "text", text: "Provide either `prompt` (+ optional `system`) or `messages`." }] };
  }

  const requestBody = { model, messages };
  if (typeof args.max_tokens === "number") requestBody.max_tokens = args.max_tokens;

  const url = buildChatUrl(baseUrl);
  const apiKey = process.env.OPENAI_COMPAT_API_KEY || undefined;

  let res;
  try {
    res = await postJson(url, requestBody, apiKey);
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Request to ${url} failed: ${err && err.message ? err.message : String(err)}` }] };
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return { isError: true, content: [{ type: "text", text: `Endpoint ${url} returned HTTP ${res.statusCode}: ${res.body.slice(0, 2000)}` }] };
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Endpoint ${url} returned non-JSON response: ${res.body.slice(0, 2000)}` }] };
  }

  const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  const text = choice && choice.message && typeof choice.message.content === "string" ? choice.message.content : undefined;
  if (text === undefined) {
    return { isError: true, content: [{ type: "text", text: `Endpoint ${url} returned an unexpected shape (no choices[0].message.content): ${res.body.slice(0, 2000)}` }] };
  }

  const result = { content: [{ type: "text", text }] };
  const usageRaw = parsed && parsed.usage;
  if (usageRaw && (typeof usageRaw.prompt_tokens === "number" || typeof usageRaw.completion_tokens === "number")) {
    const usage = {
      input_tokens: usageRaw.prompt_tokens,
      output_tokens: usageRaw.completion_tokens,
    };
    result.structuredContent = { usage };
    // Belt-and-suspenders trailing NDJSON line — see header comment.
    try { process.stdout.write(JSON.stringify({ usage }) + "\n"); } catch { /* never break the server over a logging line */ }
  }
  return result;
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
      respond(id, { isError: true, content: [{ type: "text", text: `Unexpected error: ${err && err.message ? err.message : String(err)}` }] });
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
