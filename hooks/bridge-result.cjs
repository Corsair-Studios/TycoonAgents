/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Shared result contract for the MCP bridges that call foreign LLMs
 * (openai-compatible-mcp, claude-cli-mcp, codex-app-server-mcp,
 * tycoon-dispatcher-mcp). Every bridge formats its tools/call result through
 * formatBridgeResult() so fallback detection can read a structured status
 * instead of regex-scanning response text (which false-positives on a
 * successful review that quotes "401"/"quota" and misses timeouts/empty output).
 *
 * Envelope:
 *   { tycoonBridge: 1,
 *     status: "ok" | "provider_error" | "timeout" | "empty",
 *     provider, model, summary, truncated,
 *     error?: { kind, message } }          (error only on non-ok statuses)
 *
 * Delivery: the envelope rides in the MCP CallToolResult's `structuredContent`
 * (supported since MCP protocol 2025-06-18; every bridge echoes the client's
 * protocolVersion, defaulting to 2025-06-18, and claude-cli-mcp already
 * returns structuredContent). `content[0].text` carries the human-readable
 * summary. isError is true for every non-ok status. parseBridgeResult() also
 * accepts a first-line JSON header in the text ("TYCOON_BRIDGE {json}"), so a
 * hook payload that drops structuredContent can still be read.
 *
 * Env vars (names only; bridges may pass their own defaults):
 *   TYCOON_BRIDGE_MAX_CHARS   summary cap in characters (default 12000)
 *   TYCOON_BRIDGE_TIMEOUT_MS  withTimeout default in ms (default 180000)
 *
 * Zero dependencies. Ships next to the bridges (hooks/, and
 * MCP_BRIDGE_HOOK_FILES in src/host/vscode/hookInstall.ts for projects).
 */
"use strict";

const ENVELOPE_VERSION = 1;
const STATUSES = ["ok", "provider_error", "timeout", "empty"];
const DEFAULT_MAX_CHARS = 12000;
const DEFAULT_TIMEOUT_MS = 180000;
const ERROR_MESSAGE_MAX = 500;
const TEXT_HEADER_PREFIX = "TYCOON_BRIDGE ";

function positiveInt(raw, fallback) {
  const n = Number.parseInt(String(raw === undefined || raw === null ? "" : raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function maxChars(env) {
  return positiveInt((env || process.env).TYCOON_BRIDGE_MAX_CHARS, DEFAULT_MAX_CHARS);
}

function timeoutMs(defaultMs, env) {
  return positiveInt((env || process.env).TYCOON_BRIDGE_TIMEOUT_MS, defaultMs || DEFAULT_TIMEOUT_MS);
}

function capText(text, cap) {
  if (text.length <= cap) return { text, truncated: false };
  const dropped = text.length - cap;
  return { text: text.slice(0, cap) + "\n[truncated " + dropped + " chars]", truncated: true };
}

function capError(message) {
  const s = typeof message === "string" ? message : String(message === undefined || message === null ? "" : message);
  return s.length <= ERROR_MESSAGE_MAX ? s : s.slice(0, ERROR_MESSAGE_MAX - 3) + "...";
}

/**
 * opts: { status?, provider, model, text?, error?: {kind, message}|string,
 *         extra?: object (merged into structuredContent beside the envelope),
 *         env?: object (tests) }
 * status defaults to "ok"; an "ok" with blank text is downgraded to "empty".
 */
function formatBridgeResult(opts) {
  const o = opts || {};
  const raw = typeof o.text === "string" ? o.text : "";
  let status = STATUSES.includes(o.status) ? o.status : "ok";
  if (status === "ok" && raw.trim() === "") status = "empty";

  const capped = capText(raw, maxChars(o.env));
  const envelope = {
    tycoonBridge: ENVELOPE_VERSION,
    status,
    provider: o.provider === undefined || o.provider === null ? "" : String(o.provider),
    model: o.model === undefined || o.model === null ? "" : String(o.model),
    summary: capped.text,
    truncated: capped.truncated,
  };
  if (status !== "ok") {
    const err = typeof o.error === "string" ? { message: o.error } : o.error || {};
    const kind = typeof err.kind === "string" && err.kind ? err.kind : status;
    const fallbackMsg =
      status === "empty" ? "Provider returned empty output" : status === "timeout" ? "Provider call timed out" : "Provider call failed";
    envelope.error = { kind, message: capError(err.message || fallbackMsg) };
  }

  const isError = status !== "ok";
  const text = capped.text !== "" ? capped.text : envelope.error ? envelope.error.message : "";
  const structuredContent = Object.assign({}, o.extra && typeof o.extra === "object" ? o.extra : {}, envelope);
  return { content: [{ type: "text", text }], isError, structuredContent };
}

/**
 * Resolves to promise's value, or to a "timeout" bridge result after `ms`
 * (default TYCOON_BRIDGE_TIMEOUT_MS, else `opts.defaultMs`, else 180000).
 * opts: { provider?, model?, defaultMs?, env? }. The timer is cleared and
 * unref'd so it never holds the process open.
 */
function withTimeout(promise, ms, label, opts) {
  const o = opts || {};
  const fallbackMs = timeoutMs(o.defaultMs, o.env);
  const limit = ms !== undefined && ms !== null ? positiveInt(ms, fallbackMs) : fallbackMs;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve(
        formatBridgeResult({
          status: "timeout",
          provider: o.provider || label || "",
          model: o.model || "",
          error: { kind: "timeout", message: (label || "provider call") + " timed out after " + limit + "ms" },
        }),
      );
    }, limit);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function isEnvelope(v) {
  return !!v && typeof v === "object" && v.tycoonBridge === ENVELOPE_VERSION && STATUSES.includes(v.status);
}

function pickEnvelope(v) {
  const env = {
    tycoonBridge: v.tycoonBridge,
    status: v.status,
    provider: v.provider,
    model: v.model,
    summary: v.summary,
    truncated: v.truncated,
  };
  if (v.error) env.error = v.error;
  return env;
}

function fromText(text) {
  if (typeof text !== "string") return null;
  const first = text.split(/\r?\n/, 1)[0];
  if (!first.startsWith(TEXT_HEADER_PREFIX)) return null;
  try {
    const v = JSON.parse(first.slice(TEXT_HEADER_PREFIX.length));
    return isEnvelope(v) ? pickEnvelope(v) : null;
  } catch {
    return null;
  }
}

/**
 * Reads an envelope out of a tool_response (CallToolResult object, content
 * array, or JSON string). Returns the envelope or null when none is present.
 */
function parseBridgeResult(toolResponse) {
  let resp = toolResponse;
  if (typeof resp === "string") {
    const t = resp.trim();
    if (!t.startsWith("{")) return fromText(resp);
    try {
      resp = JSON.parse(t);
    } catch {
      return fromText(resp);
    }
  }
  if (Array.isArray(resp)) resp = { content: resp };
  if (!resp || typeof resp !== "object") return null;
  if (isEnvelope(resp)) return pickEnvelope(resp);
  if (isEnvelope(resp.structuredContent)) return pickEnvelope(resp.structuredContent);
  if (resp.tool_response !== undefined) return parseBridgeResult(resp.tool_response);
  if (Array.isArray(resp.content)) {
    for (const block of resp.content) {
      if (block && typeof block.text === "string") {
        const found = fromText(block.text);
        if (found) return found;
      }
    }
  }
  return null;
}

module.exports = {
  ENVELOPE_VERSION,
  STATUSES,
  DEFAULT_MAX_CHARS,
  DEFAULT_TIMEOUT_MS,
  ERROR_MESSAGE_MAX,
  TEXT_HEADER_PREFIX,
  formatBridgeResult,
  withTimeout,
  parseBridgeResult,
};
