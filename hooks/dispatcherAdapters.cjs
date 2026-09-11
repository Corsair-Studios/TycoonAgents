"use strict";
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Plan p23-t1: pure vendor->adapter selection + adapter implementations used
 * by hooks/tycoon-dispatcher-mcp.cjs. Split out so the selection logic is
 * unit-testable without spawning real processes (tests inject a stub adapter
 * via env TYCOON_DISPATCH_ADAPTER=stub or a passed-in adapter map).
 *
 * Adapter contract: async (task, agentInfo) => { text, usage?, error? }
 *   - text: string result on success.
 *   - usage: optional { input_tokens?, output_tokens? } if the vendor reports it.
 *   - error: string reason on failure — caller writes a ProviderError record
 *     and returns an isError result; adapters never throw for expected
 *     failure modes (missing env, non-2xx, spawn failure), only for truly
 *     unexpected bugs.
 *
 * Vendor -> adapter table (docs/codex-cross-vendor-bridge.md Option A):
 *   anthropic                      -> claude -p json (reuses hooks/claude-cli-mcp.cjs's
 *                                      spawn/JSON-parsing logic, model from the agent file)
 *   openai-compatible|local|moonshot -> HTTP POST to OPENAI_COMPAT_BASE_URL (same
 *                                      pattern as hooks/openai-compatible-mcp.cjs)
 *   google                         -> gemini shim if GEMINI_API_KEY/GEMINI_CLI configured,
 *                                      else an explicit error (no silent substitution)
 *   openai                         -> explicit error: "use Codex native agents"
 *   anything else                  -> explicit error naming the unsupported vendor
 *
 * Secrets: only env var NAMES appear in code/log text below, never values.
 */

const { spawn } = require("child_process");
const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// p23-t10: resolve vendor endpoint env vars from either the Codex process
// environment or the per-user local env value store (hooks/localEnvStore.js
// / out/src/core/localEnvStore.js), same fallback the Routing screen and
// hooks/openai-compatible-mcp.cjs already use. process.env is checked
// FIRST; the store is a fallback only. Values are never logged — only
// variable NAMES appear in error text or activity records.
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
      // never crash the dispatcher.
    }
  }
  try {
    process.stderr.write("tycoon-dispatcher: local env value store unavailable — falling back to process env only for vendor endpoint vars.\n");
  } catch { /* best effort */ }
  return undefined;
}

/**
 * Resolve `name` from `env` (defaults to process.env) first, else the
 * per-user local env value store, else undefined. Never throws, never logs
 * the resolved value. `env` doubles as the store's `opts.env` so tests can
 * redirect the store directory via TYCOON_STANDALONE_DATA_DIR in the same
 * object passed here.
 */
function resolveVendorEnv(name, env) {
  const source = env || process.env;
  const fromEnv = source[name];
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  try {
    const store = localEnvStore();
    if (store && typeof store.getValue === "function") {
      const fromStore = store.getValue(name, { env: source });
      if (typeof fromStore === "string" && fromStore !== "") return fromStore;
    }
  } catch {
    // fail-open to undefined
  }
  return undefined;
}

/** Standard "not set anywhere" message naming both sources checked, never a value. */
function missingVendorEnvMessage(name) {
  return `${name} is not set in the Codex process environment or the TycoonAgents local env store.`;
}

/** Resolve which adapter key a vendor string maps to. Pure. */
function adapterKeyForVendor(vendor) {
  const v = String(vendor || "").toLowerCase();
  if (v === "anthropic") return "anthropic";
  if (v === "openai-compatible" || v === "local" || v === "moonshot") return "openai-compatible";
  if (v === "google") return "google";
  if (v === "openai") return "openai";
  return "unsupported";
}

// --- anthropic adapter: reuses claude-cli-mcp.cjs's binary discovery/spawn ---

const MODEL_RE = /^[A-Za-z0-9._\-\/]{1,100}$/;
const DEFAULT_TIMEOUT_MS = 180000;

function discoverClaudeBin() {
  const tried = [];
  const envBin = resolveVendorEnv("CLAUDE_CLI_BIN");
  if (envBin) return { bin: envBin, triedPaths: [`CLAUDE_CLI_BIN=${envBin}`] };
  const pathVar = process.env.PATH || process.env.Path || "";
  const pathDirs = pathVar.split(path.delimiter).filter(Boolean);
  const isWin = process.platform === "win32";
  const pathCandidates = isWin ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];
  for (const dir of pathDirs) {
    for (const cand of pathCandidates) {
      const full = path.join(dir, cand);
      tried.push(full);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return { bin: full, triedPaths: tried };
      } catch { /* keep probing */ }
    }
  }
  const fallbacks = [];
  if (isWin && process.env.APPDATA) fallbacks.push(path.join(process.env.APPDATA, "npm", "claude.cmd"));
  const home = os.homedir();
  if (home) fallbacks.push(path.join(home, ".local", "bin", "claude"));
  fallbacks.push("/usr/local/bin/claude");
  for (const full of fallbacks) {
    tried.push(full);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return { bin: full, triedPaths: tried };
    } catch { /* keep probing */ }
  }
  return { bin: null, triedPaths: tried };
}

function resolveCmdShimJsEntry(cmdPath) {
  let content;
  try {
    content = fs.readFileSync(cmdPath, "utf8");
  } catch {
    return null;
  }
  const shimDir = path.dirname(cmdPath);
  const matches = content.matchAll(/"([^"\r\n]*\.m?js)"/gi);
  for (const m of matches) {
    let raw = m[1];
    raw = raw.replace(/%~?dp0%/gi, shimDir + path.sep);
    const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(shimDir, raw);
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    } catch { /* try the next match */ }
  }
  return null;
}

function resolveSpawnTarget(bin) {
  const isWin = process.platform === "win32";
  if (isWin && /\.(cmd|bat)$/i.test(bin)) {
    const jsEntry = resolveCmdShimJsEntry(bin);
    if (jsEntry) return { command: process.execPath, args: [jsEntry], error: null };
    return {
      command: null,
      args: null,
      error: `Could not resolve a .js entry point from the npm shim at ${bin} — set CLAUDE_CLI_BIN to a native .exe or resolvable entry point.`,
    };
  }
  return { command: bin, args: [], error: null };
}

function resolveDefaultCwd() {
  const cwd = resolveVendorEnv("CLAUDE_CLI_CWD");
  if (cwd) return cwd;
  const scratch = path.join(os.tmpdir(), `tycoon-dispatcher-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(scratch, { recursive: true });
  } catch { /* spawn will surface a failure if truly unusable */ }
  return scratch;
}

function runClaudeCli(command, args, cwd, timeoutMs, promptText) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ error: `Failed to spawn ${command}: ${err && err.message ? err.message : String(err)}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* best effort */ }
      resolve({ error: `claude CLI timed out after ${timeoutMs}ms (set CLAUDE_CLI_TIMEOUT_MS to override)` });
    }, timeoutMs);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ error: `Failed to run ${command}: ${err && err.message ? err.message : String(err)}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    try {
      child.stdin.write(promptText);
      child.stdin.end();
    } catch { /* resolved via close/error handlers */ }
  });
}

function resolveTimeoutMs() {
  const raw = resolveVendorEnv("CLAUDE_CLI_TIMEOUT_MS");
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

// Default of 1 leaves zero room for a single tool round trip: any task that
// reads or edits a file needs at least 2 turns (tool_use, then the reply
// that consumes the tool result), and `claude -p` reports that as
// terminal_reason "max_turns" / is_error true with no usable `result`
// string — which the caller then reports as a bare "claude CLI exited 1"
// with no context. 30 gives a coding-specialist-shaped task (a handful of
// reads/edits) real headroom while still bounding a runaway loop.
const DEFAULT_MAX_TURNS = 30;
function resolveMaxTurns() {
  const raw = resolveVendorEnv("CLAUDE_CLI_MAX_TURNS");
  if (!raw) return DEFAULT_MAX_TURNS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_TURNS;
}

/** Redact anything that looks like a bearer token / API key / long secret-ish run. */
function redactSecrets(text) {
  return String(text || "")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-***REDACTED***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, "Bearer ***REDACTED***")
    .replace(/[A-Za-z0-9_-]{32,}/g, "***REDACTED***");
}

/** Anthropic adapter: `claude -p --output-format json` over stdin, no shell. */
async function anthropicAdapter(task, agentInfo) {
  const model = (agentInfo && agentInfo.model) || resolveVendorEnv("CLAUDE_CLI_MODEL") || "claude-haiku-4-5";
  if (!MODEL_RE.test(model)) return { error: `Invalid model "${model}"` };

  const { bin, triedPaths } = discoverClaudeBin();
  if (!bin) {
    return { error: `Could not find the claude CLI. Tried: ${triedPaths.join(", ")}. Set CLAUDE_CLI_BIN to override.` };
  }
  const spawnTarget = resolveSpawnTarget(bin);
  if (spawnTarget.error) return { error: spawnTarget.error };

  const permissionMode = resolveVendorEnv("CLAUDE_CLI_PERMISSION_MODE") || "plan";
  const cwd = resolveDefaultCwd();
  const timeoutMs = resolveTimeoutMs();
  const maxTurns = resolveMaxTurns();
  const cliArgs = [
    "-p",
    "--output-format", "json",
    "--max-turns", String(maxTurns),
    "--model", model,
    "--permission-mode", permissionMode,
  ];
  const finalArgs = [...spawnTarget.args, ...cliArgs];
  const argvForLog = redactSecrets([spawnTarget.command, ...finalArgs].join(" "));
  const run = await runClaudeCli(spawnTarget.command, finalArgs, cwd, timeoutMs, task);
  if (run.error) return { error: `${run.error} (argv: ${argvForLog})` };

  const stderrTail = redactSecrets(run.stderr || "").slice(-500);

  let parsed;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    const detail = stderrTail ? ` stderr: ${stderrTail}` : "";
    return { error: `claude CLI produced non-JSON output (exit ${run.code}, argv: ${argvForLog}).${detail} stdout: ${run.stdout.slice(0, 500)}` };
  }
  if (run.code !== 0 || parsed.is_error === true) {
    if (typeof parsed.result === "string" && parsed.result) return { error: parsed.result };
    const reasons = Array.isArray(parsed.errors) && parsed.errors.length ? ` reasons: ${parsed.errors.join("; ")}` : "";
    const subtype = parsed.subtype ? ` subtype: ${parsed.subtype}` : "";
    const detail = stderrTail ? ` stderr: ${stderrTail}` : "";
    return { error: `claude CLI exited ${run.code} (argv: ${argvForLog}).${subtype}${reasons}${detail}` };
  }
  const usage = {};
  if (parsed.usage && typeof parsed.usage.input_tokens === "number") usage.input_tokens = parsed.usage.input_tokens;
  if (parsed.usage && typeof parsed.usage.output_tokens === "number") usage.output_tokens = parsed.usage.output_tokens;
  return { text: typeof parsed.result === "string" ? parsed.result : "", usage: Object.keys(usage).length ? usage : undefined };
}

// --- openai-compatible adapter: HTTP POST, same pattern as openai-compatible-mcp.cjs ---

function buildChatUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const withV1 = /\/v1$/.test(trimmed) ? trimmed : trimmed + "/v1";
  return withV1 + "/chat/completions";
}

function postJson(urlString, body, apiKey, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (err) {
      reject(new Error(`Invalid OPENAI_COMPAT_BASE_URL: ${err.message}`));
      return;
    }
    const payload = JSON.stringify(body);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
    if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
    const lib = url.protocol === "https:" ? https : http;
    let settled = false;
    const req = lib.request(
      { hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: url.pathname + url.search, method: "POST", headers },
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

/** openai-compatible adapter: reads OPENAI_COMPAT_BASE_URL / OPENAI_COMPAT_API_KEY (names only, never logs values). */
async function openaiCompatibleAdapter(task, agentInfo) {
  const baseUrl = resolveVendorEnv("OPENAI_COMPAT_BASE_URL");
  if (!baseUrl) return { error: missingVendorEnvMessage("OPENAI_COMPAT_BASE_URL") };
  const model = (agentInfo && agentInfo.model) || "default";
  const apiKey = resolveVendorEnv("OPENAI_COMPAT_API_KEY") || undefined;
  const rawTimeout = resolveVendorEnv("OPENAI_COMPAT_TIMEOUT_MS");
  const timeoutMs = Number(rawTimeout) > 0 ? Number(rawTimeout) : 120000;
  const url = buildChatUrl(baseUrl);
  let res;
  try {
    res = await postJson(url, { model, messages: [{ role: "user", content: task }] }, apiKey, timeoutMs);
  } catch (err) {
    return { error: `Request to ${url} failed: ${err && err.message ? err.message : String(err)}` };
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    return { error: `Endpoint ${url} returned HTTP ${res.statusCode}: ${res.body.slice(0, 500)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return { error: `Endpoint ${url} returned non-JSON response.` };
  }
  const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  const text = choice && choice.message && typeof choice.message.content === "string" ? choice.message.content : undefined;
  if (text === undefined) return { error: `Endpoint ${url} returned an unexpected shape (no choices[0].message.content).` };
  const usage = {};
  if (parsed.usage && typeof parsed.usage.prompt_tokens === "number") usage.input_tokens = parsed.usage.prompt_tokens;
  if (parsed.usage && typeof parsed.usage.completion_tokens === "number") usage.output_tokens = parsed.usage.completion_tokens;
  return { text, usage: Object.keys(usage).length ? usage : undefined };
}

/** google adapter: only when GEMINI_API_KEY is configured (env var name only, never value). No shim yet -> explicit error otherwise. */
async function googleAdapter(_task, _agentInfo) {
  if (!resolveVendorEnv("GEMINI_API_KEY")) {
    return { error: `google vendor requires GEMINI_API_KEY — ${missingVendorEnvMessage("GEMINI_API_KEY")} No gemini shim wired yet, refusing to substitute another model.` };
  }
  return { error: "google vendor: gemini shim not implemented — set up gemini-mcp-tool per media/mcp/catalog.json's gemini entry instead of dispatching through this bridge." };
}

async function openaiAdapter() {
  return { error: "use Codex native agents" };
}

async function unsupportedAdapter(_task, agentInfo) {
  return { error: `Unsupported vendor "${agentInfo && agentInfo.vendor}" — no dispatcher adapter configured for it.` };
}

/** Stub adapter for offline tests (TYCOON_DISPATCH_ADAPTER=stub). Echoes deterministic output, reads no network/process.
 * p25-t3: when env TYCOON_STUB_ERROR_TEXT is set, fails with that text for the next
 * TYCOON_STUB_FAIL_COUNT calls (decrementing that env var itself as the counter — no
 * extra module state), then succeeds normally — lets dispatcher-fallback tests force a
 * provider-failure on the first N attempts and observe the chain advance/exhaust. */
async function stubAdapter(task, agentInfo) {
  const failText = process.env.TYCOON_STUB_ERROR_TEXT;
  if (failText) {
    const remaining = Number(process.env.TYCOON_STUB_FAIL_COUNT || "0");
    if (remaining > 0) {
      process.env.TYCOON_STUB_FAIL_COUNT = String(remaining - 1);
      return { error: failText };
    }
  }
  return { text: `stub:${(agentInfo && agentInfo.vendor) || "unknown"}:${task}`, usage: { input_tokens: 1, output_tokens: 1 } };
}

const ADAPTERS = {
  anthropic: anthropicAdapter,
  "openai-compatible": openaiCompatibleAdapter,
  google: googleAdapter,
  openai: openaiAdapter,
  unsupported: unsupportedAdapter,
};

/** Resolve which adapter fn to call for a vendor, honoring TYCOON_DISPATCH_ADAPTER=stub for offline tests. */
function resolveAdapter(vendor) {
  if (process.env.TYCOON_DISPATCH_ADAPTER === "stub") {
    return { key: adapterKeyForVendor(vendor), fn: stubAdapter };
  }
  const key = adapterKeyForVendor(vendor);
  return { key, fn: ADAPTERS[key] };
}

module.exports = {
  adapterKeyForVendor,
  resolveAdapter,
  resolveVendorEnv,
  missingVendorEnvMessage,
  anthropicAdapter,
  openaiCompatibleAdapter,
  googleAdapter,
  openaiAdapter,
  unsupportedAdapter,
  stubAdapter,
};
