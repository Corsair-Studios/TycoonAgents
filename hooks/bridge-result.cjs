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
 * returns structuredContent). content[0].text is a first-line header
 * ("TYCOON_BRIDGE {envelope without summary}") followed by the human-readable
 * summary, for clients that drop structuredContent. isError is true for every
 * non-ok status.
 *
 * Trust rule (model output is untrusted and can contain any text):
 *   - structuredContent on a tool_response object is authoritative.
 *   - The text header is read ONLY when structuredContent is absent, ONLY from
 *     content[0], and ONLY when the caller passes { trustedTextHeader: true }
 *     (the hook does this solely for known TycoonAgents bridge tool names).
 *   - A bare string or a top-level envelope-shaped object is never trusted
 *     without that same opt-in.
 *   - formatBridgeResult escapes any line of the model's text that begins with
 *     "TYCOON_BRIDGE" (backslash prefix) so it can never read as a header.
 * parseBridgeResult never throws; unreadable input yields null.
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

const MAX_TIMER_MS = 2147483647;
const MAX_UNWRAP_DEPTH = 3;

// Digits-only strict parse: "12abc", "1e3", "-5", "0" fall back.
function positiveInt(raw, fallback) {
  const str = typeof raw === "number" ? (Number.isInteger(raw) ? String(raw) : "") : typeof raw === "string" ? raw.trim() : "";
  if (!/^[0-9]+$/.test(str)) return fallback;
  const n = Number(str);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function clampTimer(ms) {
  return Math.min(ms, MAX_TIMER_MS);
}

function escapeHeaderLines(text) {
  return text.replace(/^([ \t]*)TYCOON_BRIDGE/gm, "$1\\TYCOON_BRIDGE");
}

function maxChars(env) {
  return positiveInt((env || process.env).TYCOON_BRIDGE_MAX_CHARS, DEFAULT_MAX_CHARS);
}

function timeoutMs(defaultMs, env) {
  return clampTimer(positiveInt((env || process.env).TYCOON_BRIDGE_TIMEOUT_MS, positiveInt(defaultMs, DEFAULT_TIMEOUT_MS)));
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

  const capped = capText(escapeHeaderLines(raw), maxChars(o.env));
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
  const body = capped.text !== "" ? capped.text : envelope.error ? envelope.error.message : "";
  const header = Object.assign({}, envelope);
  delete header.summary;
  const text = TEXT_HEADER_PREFIX + JSON.stringify(header) + "\n" + body;
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
  const limit = ms !== undefined && ms !== null ? clampTimer(positiveInt(ms, fallbackMs)) : fallbackMs;
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

function fromHeaderText(text) {
  if (typeof text !== "string") return null;
  const nl = text.indexOf("\n");
  const line = nl === -1 ? text : text.slice(0, nl);
  const first = line.endsWith(String.fromCharCode(13)) ? line.slice(0, -1) : line;
  if (!first.startsWith(TEXT_HEADER_PREFIX)) return null;
  try {
    const v = JSON.parse(first.slice(TEXT_HEADER_PREFIX.length));
    if (!isEnvelope(v)) return null;
    const env = pickEnvelope(Object.assign({ summary: "" }, v));
    env.summary = nl === -1 ? "" : text.slice(nl + 1);
    return env;
  } catch {
    return null;
  }
}

function parseInner(resp, trusted, depth) {
  if (depth > MAX_UNWRAP_DEPTH || !resp || typeof resp !== "object") return null;
  if (Array.isArray(resp)) return trusted ? parseInner({ content: resp }, trusted, depth + 1) : null;
  const sc = resp.structuredContent;
  if (sc !== undefined && sc !== null) return isEnvelope(sc) ? pickEnvelope(sc) : null;
  if (trusted && isEnvelope(resp)) return pickEnvelope(resp);
  const wrapped = resp.tool_response;
  if (wrapped !== undefined && wrapped !== null) return parseInner(wrapped, trusted, depth + 1);
  if (trusted && Array.isArray(resp.content) && resp.content.length > 0) {
    const block = resp.content[0];
    if (block && typeof block.text === "string") return fromHeaderText(block.text);
  }
  return null;
}

/**
 * Reads an envelope out of a tool_response object. structuredContent is
 * authoritative; the text header, a top-level envelope-shaped object, a
 * content array and a bare string are honoured only with
 * opts.trustedTextHeader === true (see the trust rule above). Never throws.
 */
function parseBridgeResult(toolResponse, opts) {
  try {
    const trusted = !!(opts && opts.trustedTextHeader === true);
    let resp = toolResponse;
    if (typeof resp === "string") {
      if (!trusted) return null;
      const t = resp.trim();
      if (!t.startsWith("{")) return fromHeaderText(resp);
      try {
        resp = JSON.parse(t);
      } catch {
        return fromHeaderText(resp);
      }
    }
    return parseInner(resp, trusted, 0);
  } catch {
    return null;
  }
}

/**
 * Short error.kind for a provider/CLI failure message: auth | quota |
 * rate_limit | not_found | network | cli_missing | unknown. An HTTP status
 * (opts.httpStatus) wins over text matching. Shared by every bridge.
 */
function classifyProviderError(message, opts) {
  const t = String(message === undefined || message === null ? "" : message);
  const status = opts && Number(opts.httpStatus);
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 402) return "quota";
  if (status === 404) return "not_found";
  if (/ENOENT|could not find the claude cli|failed to spawn|could not resolve a \.js entry|app-server child exited|not recognized as an internal|command not found|(?<!model )(?<!model: )\b(?:agy|gemini)(?: cli| command| binary)?\s+(?:is\s+)?not (?:installed|found)\b|\bnot installed\b/i.test(t)) return "cli_missing";
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid api key|incorrect api key|authentication|not logged in|log ?in|oauth|permission[ _]denied/i.test(t)) return "auth";
  if (/\b429\b|rate.?limit|too many requests|overloaded/i.test(t)) return "rate_limit";
  if (/\b402\b|quota|usage limit|limit reached|insufficient|billing|credit|exceeded your|resource_exhausted/i.test(t)) return "quota";
  if (/\b404\b|not found|model_not_found|does not exist|unsupported model|issue with the selected model/i.test(t)) return "not_found";
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|network|fetch failed|socket hang up/i.test(t)) return "network";
  return "unknown";
}

/**
 * A provider_error bridge result. opts: { provider, model, text, kind?,
 * httpStatus? }; kind overrides classification.
 */
function providerErrorResult(opts) {
  const o = opts || {};
  return formatBridgeResult({
    status: "provider_error",
    provider: o.provider,
    model: o.model || "",
    text: o.text,
    error: { kind: o.kind || classifyProviderError(o.text, { httpStatus: o.httpStatus }), message: o.text },
  });
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
  classifyProviderError,
  providerErrorResult,
};
