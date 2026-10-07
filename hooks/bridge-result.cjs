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
 *     error?: { kind, message, resetHint?, retryAfterMs? } }
 *                                          (error only on non-ok statuses)
 *
 * error.resetHint / error.retryAfterMs (optional, additive): when a
 * provider_error message says when the limit lifts ("resets Mon 12:00am",
 * "try again at ...", "regain access on ...", "retry after 5 seconds"),
 * formatBridgeResult copies that hint out of the message (see
 * extractResetHint). retryAfterMs is set only for a short relative wait.
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
const RESET_HINT_MAX = 120;
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
    const hint = status === "provider_error" ? extractResetHint(err.message || "") : {};
    const resetHint = typeof err.resetHint === "string" && err.resetHint ? err.resetHint.slice(0, RESET_HINT_MAX) : hint.resetHint;
    const retryAfterMs = validRetryAfter(err.retryAfterMs) ? err.retryAfterMs : hint.retryAfterMs;
    if (resetHint) envelope.error.resetHint = resetHint;
    if (retryAfterMs !== undefined) envelope.error.retryAfterMs = retryAfterMs;
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
 * billing | rate_limit | overloaded | not_found | network | cli_missing |
 * backend_unreadable | unknown.
 *   quota       a plan/usage cap that lasts until a reset (Claude Code
 *               weekly/session/spend limit, Codex usage limit, OpenAI
 *               insufficient_quota, Gemini resource exhausted, Kimi daily
 *               TPD cap, Anthropic enforced spend limit). Not retried.
 *   billing     the account has no money/credit (credit balance too low,
 *               billing_error, 402 Payment Required, DashScope Arrearage).
 *               Not retried.
 *   rate_limit  a short-window throttle (429, too many requests, Throttling).
 *               Retried once when the provider names a short wait.
 *   overloaded  the provider is at capacity (Anthropic 529 overloaded_error,
 *               Kimi engine_overloaded_error). Retried like rate_limit.
 * (tool_denied is never classified from text; a bridge sets it explicitly via
 * `kind` when the backend tried to use a tool headless mode cannot approve.)
 * backend_unreadable: the backend ran but its reply could not be read back
 * (e.g. agy's SQLite transcript); retryable. An HTTP status
 * (opts.httpStatus) wins over text matching, except that a 429/402 body
 * naming a hard quota or billing failure refines the kind. Shared by every
 * bridge. Callers pass ERROR text only, never an ok summary.
 */
// 529 only with HTTP/status/error context ("529 Overloaded", "status 529",
// "HTTP 529", "error 529"), never a bare number such as a stack frame "x.js:529:10".
const OVERLOADED_RE = /overloaded_error|engine_overloaded|(?<![:\w.])529\s+overloaded|(?:status|http|error|code)\W{0,3}529(?![:\w.])/i;
const BILLING_RE = /billing_error|credit balance is (?:too )?low|insufficient (?:credits?|balance|funds)|payment required|\bArrearage\b/i;
const QUOTA_SPECIFIC_RE = /you'?ve (?:hit|reached) your [\w -]{0,30}limit|(?:\b(?:5|five)[- ]hour|\bweekly) limit\b.{0,40}\b(?:reached|hit|exceeded|exhausted)\b|\b(?:reached|hit|exceeded|exhausted)\b.{0,40}(?:\b(?:5|five)[- ]hour|\bweekly) limit\b|usage limit reached|reached your (?:api )?usage limits?|regain access on|enforced_spend_limit|spend limit|insufficient_quota|exceeded_current_quota|exceeded your current quota|allocated quota exceeded|AllocationQuota|resource has been exhausted|\bTPD\b[^\n]{0,30}rate limit|tokens per day|requests per day/i;
// Under an explicit HTTP 429 only machine codes / unambiguous cap wordings
// refine to quota (a bare prose "exceeded your current quota" stays rate_limit).
const QUOTA_CODE_RE = /insufficient_quota|exceeded_current_quota|enforced_spend_limit|AllocationQuota|resource has been exhausted|you'?ve (?:hit|reached) your [\w -]{0,30}limit|\bTPD\b[^\n]{0,30}rate limit/i;
const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests|requests too quickly|acceleration_limit|\bThrottling\b|overloaded/i;

// A 403 that is really a spending cap (Mistral returns 403 when the org's
// monthly spending limit is exceeded) is billing, not an auth failure.
const SPEND_CAP_RE = /spending limit|spend(?:ing)? cap|monthly (?:spend(?:ing)? )?limit|usage limit/i;

function classifyProviderError(message, opts) {
  const t = String(message === undefined || message === null ? "" : message);
  const status = opts && Number(opts.httpStatus);
  if (status === 403 && SPEND_CAP_RE.test(t)) return "billing";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return QUOTA_CODE_RE.test(t) ? "quota" : "rate_limit";
  if (status === 402) return BILLING_RE.test(t) ? "billing" : "quota";
  if (status === 529) return "overloaded";
  if (status === 404) return "not_found";
  if (/ENOENT|could not find the claude cli|failed to spawn|spawn [^\n]*EACCES|could not resolve a \.js entry|app-server child exited|not recognized as an internal|command not found|(?<!\bmodel:?\s*["'`]?)\b(?:agy|gemini)(?: cli| command| binary)?\s+(?:is\s+)?not (?:installed|found)\b|\b(?:agy|gemini|codex|claude|cli|command|binary|npx)\b[^\n]{0,30}\bnot installed\b/i.test(t)) return "cli_missing";
  if (/\b403\b/.test(t) && SPEND_CAP_RE.test(t)) return "billing";
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid api key|incorrect api key|authentication|not logged in|log ?in|oauth|(?:api|key|token|credential|auth|403)[^\n]{0,60}permission[ _]denied|permission[ _]denied[^\n]{0,60}(?:api|key|token|credential|auth|403)/i.test(t)) return "auth";
  if (OVERLOADED_RE.test(t)) return "overloaded";
  if (BILLING_RE.test(t)) return "billing";
  if (QUOTA_SPECIFIC_RE.test(t)) return "quota";
  if (RATE_LIMIT_RE.test(t)) return "rate_limit";
  if (/\b402\b|quota|usage limit|limit reached|insufficient[^\n]{0,20}(?:quota|balance|credits?|funds)|out of credits?|credits?[^\n]{0,20}(?:exhausted|depleted|exceeded|limit|balance)|billing (?:details|limit|hard limit)|exceeded your|resource_exhausted/i.test(t)) return "quota";
  if (/\b404\b|not found|model_not_found|does not exist|unsupported model|issue with the selected model/i.test(t)) return "not_found";
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|network|fetch failed|socket hang up/i.test(t)) return "network";
  if (/could not extract a model reply|found a SQLite transcript/i.test(t)) return "backend_unreadable";
  return "unknown";
}

function validRetryAfter(ms) {
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0;
}

function trimHint(s) {
  return s.replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "").slice(0, RESET_HINT_MAX);
}

const UNIT_MS = { ms: 1, millisecond: 1, milliseconds: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000 };

/**
 * Pulls a "when does this limit lift" hint out of a provider error message.
 * Returns { resetHint?, retryAfterMs? }: resetHint is a short human string
 * ("resets Mon 12:00am", "try again at Sep 11th, 2026 4:36 AM", "regain
 * access on 2026-09-01 at 00:00 UTC", "resets at <ISO>" from Claude Code's
 * "usage limit reached|<epoch>" form); retryAfterMs is set only for a
 * relative wait ("retry after 5 seconds", "try again in 20s", "retry in
 * 1.5s", "Retry-After: 7"). Never throws.
 */
function extractResetHint(message) {
  const out = {};
  const t = typeof message === "string" ? message : "";
  if (!t) return out;
  const rel = /(?:retry[- ]after|(?:try|retry) again in|retry in)[:\s]+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)?(?![\w])/i.exec(t);
  if (rel) {
    const unit = (rel[2] || "s").toLowerCase();
    const ms = Math.round(Number(rel[1]) * (UNIT_MS[unit] || 1000));
    if (Number.isFinite(ms)) out.retryAfterMs = ms;
    out.resetHint = trimHint(rel[0]);
    return out;
  }
  const resets = /\bresets\s+([^\n|]{1,80})/i.exec(t);
  if (resets) {
    out.resetHint = trimHint("resets " + resets[1]);
    return out;
  }
  const at = /\btry again (?:at|after|on)\s+([^\n]{1,80}?)(?:\.(?:\s|$)|\n|$)/i.exec(t);
  if (at) {
    out.resetHint = trimHint("try again at " + at[1]);
    return out;
  }
  const regain = /\bregain access on\s+([^\n]{1,80}?)(?:\.(?:\s|$)|\n|$)/i.exec(t);
  if (regain) {
    out.resetHint = trimHint("regain access on " + regain[1]);
    return out;
  }
  const epoch = /usage limit reached\|(\d{10,13})\b/i.exec(t);
  if (epoch) {
    const n = Number(epoch[1]);
    const d = new Date(epoch[1].length === 13 ? n : n * 1000);
    if (!isNaN(d.getTime())) out.resetHint = "resets at " + d.toISOString();
  }
  return out;
}

/** Kinds that hand off to the next fallback slot right away (no retry). */
const NO_RETRY_KINDS = ["quota", "billing"];
/** Kinds that may be retried once on the same slot after a short wait. */
const SHORT_RETRY_KINDS = ["rate_limit", "overloaded"];
const SHORT_RETRY_MAX_MS = 10000;

/**
 * Retry policy shared by the dispatcher loops (the bridges themselves never
 * retry rate limits, so a dispatched call is retried at most once):
 * quota/billing fall back immediately; rate_limit/overloaded get ONE retry on
 * the same slot only when the error named a wait <= 10s (retryAfterMs) and
 * the wait PLUS a minimum retry run (opts.minRunMs, default 1000) fits in
 * what is left of the step budget (opts.budgetLeftMs, when known); the caller
 * then runs the retry with only the budget that remains after the wait.
 * Everything else falls back without a retry. Returns the wait in ms, or -1.
 */
const MIN_RETRY_RUN_MS = 1000;
function shortRetryDelayMs(error, opts) {
  if (!error || SHORT_RETRY_KINDS.indexOf(error.kind) === -1) return -1;
  const ms = error.retryAfterMs;
  if (!validRetryAfter(ms) || ms > SHORT_RETRY_MAX_MS) return -1;
  const left = opts && typeof opts.budgetLeftMs === "number" ? opts.budgetLeftMs : Infinity;
  const minRun = opts && typeof opts.minRunMs === "number" && opts.minRunMs >= 0 ? opts.minRunMs : MIN_RETRY_RUN_MS;
  return ms + minRun <= left ? ms : -1;
}

/** { kind, message, resetHint?, retryAfterMs? } for an error string (opts: { kind?, httpStatus? }). */
function describeProviderError(message, opts) {
  const msg = String(message === undefined || message === null ? "" : message);
  const kind = (opts && opts.kind) || classifyProviderError(msg, opts);
  const err = { kind, message: capError(msg) };
  const hint = extractResetHint(msg);
  if (hint.resetHint) err.resetHint = hint.resetHint;
  if (hint.retryAfterMs !== undefined) err.retryAfterMs = hint.retryAfterMs;
  return err;
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
  extractResetHint,
  describeProviderError,
  shortRetryDelayMs,
  NO_RETRY_KINDS,
  SHORT_RETRY_KINDS,
  SHORT_RETRY_MAX_MS,
  MIN_RETRY_RUN_MS,
  providerErrorResult,
};
