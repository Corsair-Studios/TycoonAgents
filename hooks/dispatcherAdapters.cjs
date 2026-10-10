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
const binDiscovery = require("./binDiscovery.cjs");

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

/** Vendors with their own fixed endpoint/key handling; never routed through the custom-endpoint path. */
const FIXED_OPENAI_COMPAT_VENDORS = ["xai", "mistral", "moonshot", "google", "openai", "anthropic"];

/** True when a slot is a user-defined custom endpoint (any non-fixed vendor on the openai-compatible transport). */
function isCustomEndpointSlot(vendor, opts) {
  const v = String(vendor || "").toLowerCase();
  if (!v || FIXED_OPENAI_COMPAT_VENDORS.indexOf(v) !== -1) return false;
  return !!(opts && (opts.transport === "openai-compatible" || opts.endpointEnv));
}

/** Resolve which adapter key a vendor string maps to. Pure. `opts` ({transport, endpointEnv}) routes custom-endpoint vendors. */
function adapterKeyForVendor(vendor, opts) {
  const v = String(vendor || "").toLowerCase();
  if (isCustomEndpointSlot(v, opts)) return "openai-compatible";
  if (v === "anthropic") return "anthropic";
  if (v === "openai-compatible" || v === "local" || v === "moonshot" || v === "mistral" || v === "xai") return "openai-compatible";
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
  const isWin = process.platform === "win32";
  const home = os.homedir();
  const extraDirs = [];
  if (isWin) {
    if (process.env.APPDATA) extraDirs.push(path.join(process.env.APPDATA, "npm"));
    if (home) extraDirs.push(path.join(home, ".local", "bin"));
  }
  const found = binDiscovery.findBinary("claude", {
    names: isWin ? ["claude.cmd", "claude.exe", "claude"] : ["claude"],
    extraDirs,
  });
  return { bin: found.bin, triedPaths: tried.concat(found.tried) };
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

function runClaudeCli(command, args, cwd, timeoutMs, promptText, childEnv, opts) {
  const label = (opts && opts.label) || "claude CLI";
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env: childEnv || process.env, stdio: ["pipe", "pipe", "pipe"], shell: !!(opts && opts.shell), windowsHide: true });
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
      resolve({ error: `${label} timed out after ${timeoutMs}ms (set CLAUDE_CLI_TIMEOUT_MS to override)` });
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

/**
 * Claude subscription gate (decision 2026-10-06): when the dispatcher runs for
 * the OpenCode harness (TYCOON_DISPATCH_HOST=opencode) the claude -p bridge
 * needs the per-user opt-in flag (file `opencode-claude-subscription-optin`
 * in the per-user app-data dir, same path src/core/claudeSubscriptionBridge.ts
 * writes). Returns an error message when blocked, else null. Unreadable flag =
 * not opted in. Claude Code (host "claude") and Codex (host unset) never block.
 */
function claudeSubscriptionBlock(env) {
  const e = env || process.env;
  if (e.TYCOON_DISPATCH_HOST !== "opencode") return null;
  try {
    const os = require("os");
    let dir;
    if (typeof e.TYCOON_STANDALONE_DATA_DIR === "string" && e.TYCOON_STANDALONE_DATA_DIR.trim() !== "") {
      dir = path.resolve(e.TYCOON_STANDALONE_DATA_DIR.trim());
    } else if (process.platform === "win32") {
      const base = typeof e.APPDATA === "string" && e.APPDATA.trim() !== "" ? e.APPDATA : path.join(os.homedir(), "AppData", "Roaming");
      dir = path.join(base, "TycoonAgents");
    } else if (process.platform === "darwin") {
      dir = path.join(os.homedir(), "Library", "Application Support", "TycoonAgents");
    } else {
      const base = typeof e.XDG_DATA_HOME === "string" && e.XDG_DATA_HOME.trim() !== "" ? e.XDG_DATA_HOME : path.join(os.homedir(), ".local", "share");
      dir = path.join(base, "tycoonagents");
    }
    if (fs.existsSync(path.join(dir, "opencode-claude-subscription-optin"))) return null;
  } catch { /* fall through: unreadable = not opted in */ }
  return "Claude via the claude CLI needs the 'Allow Claude subscription via the claude CLI under OpenCode' setting (off by default; Claude uses an Anthropic API key, ANTHROPIC_API_KEY, under OpenCode). Enable it in the TycoonAgents Settings screen.";
}

/**
 * Permission mode for the `claude -p` child. Base mode, first match wins:
 *   1. the agent file's `permissionMode:` frontmatter line
 *   2. role default: `plan` (read-only) for reviewers/search/audit agents, for
 *      agents whose `tools:` list has no edit tool or whose `disallowedTools`
 *      lists Edit/Write, and for unknown agents or files with no frontmatter;
 *      `acceptEdits` for other (builder) agents, including frontmatter with no
 *      `tools:` line.
 * env CLAUDE_CLI_PERMISSION_MODE can only DOWNGRADE that base (plan < default
 * < acceptEdits); it never upgrades a read-only role. Only plan, acceptEdits
 * and default are accepted anywhere; any other value (e.g. bypassPermissions,
 * dontAsk) is ignored, so the dispatcher never bypasses the user's permissions.
 * acceptEdits children run with cwd = project (CLAUDE_CLI_CWD ignored), no
 * --add-dir, a leaf preamble, Task/Agent disallowed and hooks skipped
 * (TYCOON_BRIDGE_CHILD=1); every other mode keeps the isolated scratch dir.
 */
const ALLOWED_PERMISSION_MODES = ["plan", "acceptEdits", "default"];
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const READ_ONLY_NAME_RE = /review|search|retriev|audit|explore/i;

function validPermissionMode(value) {
  const v = typeof value === "string" ? value.trim().replace(/^["']|["']$/g, "") : "";
  return ALLOWED_PERMISSION_MODES.includes(v) ? v : undefined;
}

/** Top-level frontmatter scalar/list values of an agent .md: { key: raw text incl. continuation lines }. */
function readAgentFrontmatter(agentFilePath) {
  let raw;
  try {
    raw = fs.readFileSync(agentFilePath, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  } catch {
    return undefined;
  }
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return undefined;
  const out = {};
  let key;
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) {
      key = m[1];
      out[key] = m[2];
    } else if (key && /^\s+\S/.test(line)) {
      out[key] += " " + line.trim();
    }
  }
  return out;
}

/** True when the agent's backend block declares transport: mcp (a wrapper around a bridge tool). */
function isBridgeWrapperFrontmatter(fm) {
  return !!fm && typeof fm.backend === "string" && /\btransport:\s*mcp(?=[\s]|$)/i.test(fm.backend);
}

function toolTokens(text) {
  return String(text || "").split(/[\s,\[\]'"]+/).map((s) => s.replace(/^-+/, "").trim()).filter(Boolean);
}

const MODE_RANK = { plan: 0, default: 1, acceptEdits: 2 };

function resolveClaudePermissionMode(agentInfo) {
  const base = baseClaudePermissionMode(agentInfo);
  const fromEnv = validPermissionMode(resolveVendorEnv("CLAUDE_CLI_PERMISSION_MODE"));
  return fromEnv && MODE_RANK[fromEnv] <= MODE_RANK[base] ? fromEnv : base;
}

function baseClaudePermissionMode(agentInfo) {
  const workerId = agentInfo && typeof agentInfo.workerId === "string" ? agentInfo.workerId : "";
  const projectDir = agentInfo && typeof agentInfo.projectDir === "string" ? agentInfo.projectDir : "";
  if (!workerId || !projectDir || !/^[\w.-]+$/.test(workerId)) return "plan";
  const fm = readAgentFrontmatter(path.join(projectDir, ".claude", "agents", `${workerId}.md`));
  if (!fm) return "plan";
  const fromFile = validPermissionMode(fm.permissionMode);
  if (fromFile) return fromFile;
  if (READ_ONLY_NAME_RE.test(workerId)) return "plan";
  // Bridge wrappers (backend.transport: mcp) restrict tools only to force the wrapper through its
  // bridge tool; the dispatcher runs the backend directly, so those lists say nothing about the role.
  // Only the claude-cli wrapper is a builder; any other bridge wrapper stays read-only.
  if (isBridgeWrapperFrontmatter(fm)) return /\bmcpServer:\s*["']?claude-cli["']?(?=[\s]|$)/i.test(fm.backend) ? "acceptEdits" : "plan";
  if (typeof fm.tools === "string" && !toolTokens(fm.tools).some((t) => EDIT_TOOLS.includes(t))) return "plan";
  if (toolTokens(fm.disallowedTools).some((t) => t === "Edit" || t === "Write")) return "plan";
  return "acceptEdits";
}

/** True for review/search/audit roles and agents without edit tools: the shared read-only classifier (Claude `plan`, Codex `read-only` sandbox). */
function isReadOnlyAgent(agentInfo) {
  return baseClaudePermissionMode(agentInfo) === "plan";
}

const LEAF_PREAMBLE =
  "You are a leaf worker launched by the TycoonAgents dispatcher. Do the task yourself with your own tools and edit files directly. Do not delegate or spawn agents. Project instructions about delegating apply to the orchestrator, not to you.";

/** Anthropic adapter: `claude -p --output-format json` over stdin, no shell. */
async function anthropicAdapter(task, agentInfo) {
  const blocked = claudeSubscriptionBlock();
  if (blocked) return { error: blocked };
  const rawModel = (agentInfo && agentInfo.model) || resolveVendorEnv("CLAUDE_CLI_MODEL") || "haiku";
  // The claude CLI takes an alias ("sonnet") or a bare id ("claude-sonnet-5-5"),
  // never the vendor-qualified "anthropic/..." form a backend.model carries.
  const model = rawModel.replace(/^anthropic\//i, "");
  if (!MODEL_RE.test(model)) return { error: `Invalid model "${model}"` };

  const { bin, triedPaths } = discoverClaudeBin();
  if (!bin) {
    return { error: `Could not find the claude CLI. Tried: ${triedPaths.join(", ")}. Set CLAUDE_CLI_BIN to override.`, kind: "cli_missing" };
  }
  const spawnTarget = resolveSpawnTarget(bin);
  if (spawnTarget.error) return { error: spawnTarget.error };

  const permissionMode = resolveClaudePermissionMode(agentInfo);
  let cwd = resolveDefaultCwd();
  if (permissionMode === "acceptEdits") {
    // Builders always edit the project, never elsewhere (CLAUDE_CLI_CWD ignored).
    const projectDir = agentInfo && agentInfo.projectDir;
    try {
      if (typeof projectDir === "string" && projectDir && fs.statSync(projectDir).isDirectory()) cwd = projectDir;
    } catch { /* keep the scratch dir: edits cannot reach the project */ }
  }
  const timeoutMs = resolveTimeoutMs();
  const maxTurns = resolveMaxTurns();
  const cliArgs = [
    "-p",
    "--output-format", "json",
    "--max-turns", String(maxTurns),
    "--model", model,
    "--permission-mode", permissionMode,
  ];
  if (permissionMode === "plan") {
    // Plan mode cannot write, so the project can be exposed for reading from the scratch cwd.
    const projectDir = agentInfo && agentInfo.projectDir;
    try {
      if (typeof projectDir === "string" && projectDir && fs.statSync(projectDir).isDirectory()) cliArgs.push("--add-dir", projectDir);
    } catch { /* no readable project: scratch only */ }
  }
  if (permissionMode === "acceptEdits") {
    cliArgs.push("--append-system-prompt", LEAF_PREAMBLE, "--disallowedTools", "Task,Agent");
  }
  const finalArgs = [...spawnTarget.args, ...cliArgs];
  const argvForLog = redactSecrets([spawnTarget.command, ...finalArgs].join(" "));
  const run = await runClaudeCli(spawnTarget.command, finalArgs, cwd, timeoutMs, task, { ...process.env, TYCOON_BRIDGE_CHILD: "1" });
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

// Custom endpoint rules - mirrored in src/core/vendorKeys.ts and
// hooks/openai-compatible-mcp.cjs (a test asserts all three agree).
const CUSTOM_KEY_NAME_RE = /^[A-Z][A-Z0-9_]*(_API_KEY|_KEY|_TOKEN)$/;
const CUSTOM_ENDPOINT_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}_BASE_URL$/;
// Sorted; includes every fixed vendor spec key name (src/core/vendorKeys.ts VENDOR_KEY_SPECS).
const CUSTOM_KEY_DENY_EXACT = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CF_API_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CODECOV_TOKEN", "DEPLOY_TOKEN", "GEMINI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "MISTRAL_API_KEY", "MOONSHOT_API_KEY", "NODE_AUTH_TOKEN", "NPM_TOKEN", "PYPI_TOKEN", "SONAR_TOKEN", "TERRAFORM_TOKEN", "TF_TOKEN", "VERCEL_TOKEN", "XAI_API_KEY"];
const CUSTOM_KEY_DENY_PREFIX = ["ANTHROPIC_", "ASANA_", "ATLASSIAN_", "AWS_", "AZURE_", "BITBUCKET_", "CF_", "CIRCLECI_", "CLAUDE_", "CLOUDFLARE_", "DATADOG_", "DD_", "DIGITALOCEAN_", "DOCKER_", "EXPO_", "FIREBASE_", "GCLOUD_", "GCP_", "GH_", "GITHUB_", "GITLAB_", "GPG_", "HEROKU_", "HF_", "HUGGINGFACE_", "JIRA_", "LINEAR_", "NETLIFY_", "NOTION_", "NPM_", "PAGERDUTY_", "PGP_", "RENDER_", "SENDGRID_", "SENTRY_", "SLACK_", "SSH_", "STRIPE_", "SUPABASE_", "TRAVIS_", "TWILIO_", "TYCOON_", "VERCEL_"];
const CUSTOM_KEY_DENY_SUBSTR = ["GPG", "PASSPHRASE", "PASSWORD", "PGP", "PRIVATE_KEY", "SSH"];
const CUSTOM_RULES = {
  keyNameRe: CUSTOM_KEY_NAME_RE.source,
  endpointNameRe: CUSTOM_ENDPOINT_NAME_RE.source,
  denyExact: CUSTOM_KEY_DENY_EXACT,
  denyPrefix: CUSTOM_KEY_DENY_PREFIX,
  denySubstr: CUSTOM_KEY_DENY_SUBSTR,
};

function customKeyNameProblem(name, baseUrl, endpointEnv) {
  if (typeof name !== "string" || !CUSTOM_KEY_NAME_RE.test(name)) {
    return `API key variable "${String(name).slice(0, 60)}" must look like a credential name, e.g. GROQ_API_KEY (upper case, ending in _API_KEY, _KEY or _TOKEN).`;
  }
  if (name === "OPENAI_COMPAT_API_KEY") {
    if (endpointEnv === "OPENAI_COMPAT_BASE_URL") return undefined;
    return "OPENAI_COMPAT_API_KEY belongs to the generic OPENAI_COMPAT_BASE_URL endpoint only; use a dedicated variable (e.g. MYPROVIDER_API_KEY).";
  }
  if (name === "OPENAI_API_KEY") {
    return "OPENAI_API_KEY can't be used for a custom endpoint; store the key under your own name, e.g. MYPROVIDER_API_KEY";
  }
  if (
    CUSTOM_KEY_DENY_EXACT.includes(name) ||
    CUSTOM_KEY_DENY_PREFIX.some((p) => name.startsWith(p)) ||
    CUSTOM_KEY_DENY_SUBSTR.some((s) => name.includes(s))
  ) {
    return `${name} is a credential for another service and is never sent to a custom endpoint; use a dedicated variable (e.g. MYPROVIDER_API_KEY).`;
  }
  return undefined;
}

function customEndpointNameProblem(name) {
  if (typeof name !== "string" || !CUSTOM_ENDPOINT_NAME_RE.test(name)) {
    return `Base URL variable "${String(name).slice(0, 60)}" must be an upper-case variable name ending in _BASE_URL, e.g. OLLAMA_BASE_URL.`;
  }
  return undefined;
}

function customEndpointUrlProblem(url) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    return "The base URL is not a valid URL.";
  }
  if (u.username || u.password) return "The base URL must not contain credentials.";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (u.protocol === "https:") return undefined;
  if (u.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(host)) return undefined;
  return "The base URL must use https (http is only allowed for localhost, 127.0.0.1 or ::1).";
}

function isLocalHostUrl(url) {
  try {
    const h = new URL(String(url).trim()).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

/** Variable NAMES declared in any env block of the project's .mcp.json (repo-controlled, so untrusted for base URLs). */
function declaredMcpEnvNames(extraDir) {
  const names = new Set();
  const dirs = [extraDir, process.env.TYCOON_PROJECT_DIR, process.env.CLAUDE_PROJECT_DIR, process.cwd()].filter(Boolean);
  for (const d of dirs) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, ".mcp.json"), "utf8").replace(/^\uFEFF/, ""));
      const servers = (j && j.mcpServers) || j || {};
      for (const e of Object.values(servers)) {
        if (e && typeof e === "object" && e.env && typeof e.env === "object") for (const k of Object.keys(e.env)) names.add(k);
      }
    } catch { /* no/invalid .mcp.json: nothing declared */ }
  }
  return names;
}

/**
 * Base URL values that may receive a key: the per-user store, or the real
 * process env when the name is NOT declared in the project's .mcp.json (a
 * cloned repo controls that env block). `untrusted` may be used only for
 * requests that carry no key.
 */
function resolveUrlVar(name, projectDir) {
  const declared = declaredMcpEnvNames(projectDir).has(name);
  const fromEnv = typeof process.env[name] === "string" && process.env[name] !== "" ? process.env[name] : undefined;
  let stored;
  try {
    const store = localEnvStore();
    if (store && typeof store.getValue === "function") stored = store.getValue(name, { env: process.env }) || undefined;
  } catch { /* fail-open */ }
  if (!declared) return { trusted: fromEnv || stored };
  return { trusted: stored, untrusted: fromEnv };
}

function untrustedUrlMessage(name) {
  return `${name} is declared in this project's .mcp.json, so its value cannot receive an API key: the base URL must be set in your user settings (Set value…), not in project files.`;
}

/** Model id sent upstream for a custom endpoint: drop the one leading "<vendor>/" the Routing screen adds at save time. */
function customUpstreamModel(vendor, model) {
  const m = String(model || "");
  const prefix = String(vendor || "").toLowerCase() + "/";
  return prefix.length > 1 && m.toLowerCase().indexOf(prefix) === 0 && m.length > prefix.length ? m.slice(prefix.length) : m;
}

/** Custom-endpoint call: names come from the slot (agentInfo), values resolve via env then the per-user store; validated, never logged. */
async function customEndpointAdapter(task, agentInfo) {
  const endpointEnv = agentInfo.endpointEnv;
  const nameProblem = customEndpointNameProblem(endpointEnv);
  if (nameProblem) return { error: nameProblem };
  const urlRes = resolveUrlVar(endpointEnv, agentInfo.projectDir);
  const baseUrlRaw = urlRes.trusted || urlRes.untrusted;
  if (!baseUrlRaw) return { error: missingVendorEnvMessage(endpointEnv), kind: "not_configured" };
  const baseUrl = baseUrlRaw.trim();
  const urlProblem = customEndpointUrlProblem(baseUrl);
  if (urlProblem) return { error: `${endpointEnv}: ${urlProblem}` };
  let apiKey;
  const keyEnv = agentInfo.apiKeyEnv;
  if (keyEnv) {
    const keyProblem = customKeyNameProblem(keyEnv, baseUrl, endpointEnv);
    if (keyProblem) return { error: keyProblem };
    apiKey = resolveVendorEnv(keyEnv) || undefined;
    if (!apiKey && !isLocalHostUrl(baseUrl)) return { error: missingVendorEnvMessage(keyEnv), kind: "not_configured" };
    if (apiKey && !urlRes.trusted) return { error: untrustedUrlMessage(endpointEnv) };
  }
  const rawTimeout = resolveVendorEnv("OPENAI_COMPAT_TIMEOUT_MS");
  const timeoutMs = Number(rawTimeout) > 0 ? Number(rawTimeout) : 120000;
  const url = buildChatUrl(baseUrl);
  const scrub = (t) => (apiKey ? String(t).split(apiKey).join("[redacted]") : String(t));
  let res;
  try {
    res = await postJson(url, { model: customUpstreamModel(agentInfo.vendor, agentInfo.model || "default"), messages: [{ role: "user", content: attachReferencedFiles(task, agentInfo && agentInfo.projectDir) }] }, apiKey, timeoutMs);
  } catch (err) {
    return { error: scrub(`Request to ${url} failed: ${err && err.message ? err.message : String(err)}`) };
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    return { error: scrub(`Endpoint ${url} returned HTTP ${res.statusCode}: ${res.body.slice(0, 500)}`) };
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

// --- text-only adapters: attach project files the task refers to ---------------------------------

const ATTACH_MAX_FILE_BYTES = 64 * 1024;
const ATTACH_MAX_TOTAL_BYTES = 256 * 1024;
const ATTACH_MAX_FILES = 10;
const SECRET_BASENAME_RE = /secret|token|credential|passw|\.env|\.pem|\.key|\.tfvars|\.tfstate|\.p12|\.pfx|\.keystore|\.sqlite|\.db$|^id_(rsa|dsa|ecdsa|ed25519)|^service-account.*\.json$/i;
const SECRET_EXACT_BASENAMES = [".npmrc", ".pypirc", ".netrc", ".pgpass", ".htpasswd", ".mcp.json", "settings.local.json"];
const SECRET_SEGMENTS = [".git", "node_modules", ".ssh", ".aws", ".docker"];

function isSecretLookingPath(p) {
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  if (parts.some((seg) => SECRET_SEGMENTS.indexOf(seg.toLowerCase()) !== -1)) return true;
  const base = (parts[parts.length - 1] || "").toLowerCase();
  return SECRET_EXACT_BASENAMES.indexOf(base) !== -1 || SECRET_BASENAME_RE.test(base);
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Path-like tokens in a task: relative or absolute, with a file extension. Bare words count only with an extension. */
function pathTokensIn(task) {
  const seen = new Set();
  const out = [];
  for (const raw of String(task || "").split(/[\s"'`()<>[\],;]+/)) {
    const tok = raw.replace(/[.:!?]+$/, "").replace(/:\d+(?::\d+)?$/, "");
    if (!tok || tok.length > 260 || tok.indexOf("://") !== -1) continue;
    if (!/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/** Simple .gitignore support (no negation, no dependency): returns a predicate on a project-relative path. */
function gitignoreMatcher(root) {
  let raw = "";
  try { raw = fs.readFileSync(path.join(root, ".gitignore"), "utf8"); } catch { return () => false; }
  const rules = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] === "#" || t[0] === "!") continue;
    const anchored = t.indexOf("/") !== -1 && t.indexOf("/") !== t.length - 1;
    const pat = t.replace(/^\//, "").replace(/\/$/, "");
    const body = pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
    rules.push({ anchored, re: new RegExp("^" + body + "$") });
  }
  return (rel) => {
    const parts = rel.split("/");
    return rules.some((r) => {
      if (r.anchored) return parts.some((_, k) => r.re.test(parts.slice(0, k + 1).join("/")));
      return parts.some((seg) => r.re.test(seg));
    });
  };
}

/**
 * For adapters with no tool access: append the project files the task names as fenced blocks.
 * Only regular text files inside the project (realpath-checked), within size caps, and never
 * secret-looking ones. Returns the task unchanged when nothing resolves and nothing needs a note.
 */
function attachReferencedFiles(task, projectDir) {
  const text = String(task || "");
  if (typeof projectDir !== "string" || !projectDir) return text;
  let root;
  try {
    root = fs.realpathSync(projectDir);
  } catch {
    return text;
  }
  let storeDir;
  try {
    const store = localEnvStore();
    if (store && typeof store.resolveStoreDir === "function") storeDir = fs.realpathSync(store.resolveStoreDir({ env: process.env }));
  } catch { /* store dir may not exist: nothing to protect */ }

  const ignored = gitignoreMatcher(root);
  const blocks = [];
  const skipped = [];
  let total = 0;
  for (const tok of pathTokensIn(text)) {
    const hasSlash = /[\\/]/.test(tok);
    const lexical = path.resolve(root, tok);
    if (isSecretLookingPath(tok)) { skipped.push(`${tok} (secret)`); continue; }
    let real;
    try {
      real = fs.realpathSync(lexical);
    } catch {
      if (hasSlash) skipped.push(`${tok} (${isInside(root, lexical) ? "not found" : "outside project"})`);
      continue;
    }
    if (!isInside(root, real)) { skipped.push(`${tok} (outside project)`); continue; }
    if (isSecretLookingPath(path.relative(root, real)) || (storeDir && isInside(storeDir, real)) || ignored(path.relative(root, real).split(path.sep).join("/"))) { skipped.push(`${tok} (secret)`); continue; }
    let fd;
    let buf;
    try {
      fd = fs.openSync(real, "r");
      const st = fs.fstatSync(fd);
      if (!st.isFile()) continue;
      if (st.size > ATTACH_MAX_FILE_BYTES) { skipped.push(`${tok} (too large)`); continue; }
      if (blocks.length >= ATTACH_MAX_FILES || total + st.size > ATTACH_MAX_TOTAL_BYTES) { skipped.push(`${tok} (attachment limit)`); continue; }
      buf = Buffer.alloc(Math.min(st.size, ATTACH_MAX_FILE_BYTES));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      buf = buf.subarray(0, n);
    } catch {
      continue;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
    if (buf.indexOf(0) !== -1) { skipped.push(`${tok} (not text)`); continue; }
    total += buf.length;
    const rel = path.relative(root, real).split(path.sep).join("/");
    blocks.push(`File: ${rel}\n\`\`\`\n${buf.toString("utf8")}\n\`\`\``);
  }
  if (!blocks.length && !skipped.length) return text;
  let out = text;
  if (blocks.length) out += "\n\nAttached project files:\n\n" + blocks.join("\n\n");
  if (skipped.length) out += `\n\nNot attached: ${skipped.join("; ")}.`;
  return out;
}

/**
 * Fixed-vendor endpoints on the openai-compatible transport. Mirrors VENDOR_DEFAULTS in
 * hooks/openai-compatible-mcp.cjs (same env names, same default base URLs): a prefixed model
 * uses ONLY its own endpoint/key pair, never the generic OPENAI_COMPAT_* one.
 */
const FIXED_VENDOR_ENDPOINTS = {
  xai: { prefix: "xai/", baseUrlEnv: "XAI_BASE_URL", defaultBaseUrl: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY" },
  mistral: { prefix: "mistral/", baseUrlEnv: "MISTRAL_BASE_URL", defaultBaseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY" },
  moonshot: { prefix: "moonshot/", baseUrlEnv: "MOONSHOT_BASE_URL", defaultBaseUrl: "https://api.moonshot.ai/v1", apiKeyEnv: "MOONSHOT_API_KEY" },
};

/** The vendor-prefixed form of a model id ("mistral-large-latest" -> "mistral/mistral-large-latest"); already-prefixed ids are left alone. */
function withVendorPrefix(vendor, model) {
  const spec = FIXED_VENDOR_ENDPOINTS[String(vendor || "").toLowerCase()];
  const m = String(model || "");
  if (!spec || !m) return m;
  return m.toLowerCase().indexOf(spec.prefix) === 0 ? m : spec.prefix + m;
}

/** Chat call for a fixed vendor (xai, mistral, moonshot); names only in errors, key values never logged. */
async function fixedVendorAdapter(task, agentInfo, spec) {
  const prefixed = withVendorPrefix(agentInfo.vendor, agentInfo.model);
  const upstreamModel = prefixed ? prefixed.slice(spec.prefix.length) : "";
  if (!upstreamModel) return { error: `${agentInfo.vendor} slot has no model configured.` };
  const urlRes = resolveUrlVar(spec.baseUrlEnv, agentInfo.projectDir);
  const baseUrl = (urlRes.trusted || urlRes.untrusted || spec.defaultBaseUrl).trim();
  const apiKey = resolveVendorEnv(spec.apiKeyEnv) || undefined;
  if (!apiKey) return { error: `${missingVendorEnvMessage(spec.apiKeyEnv)} Set it on the Agents screen (model "${prefixed}" requires it; the generic OPENAI_COMPAT_API_KEY is never used for this vendor).`, kind: "not_configured" };
  if (!urlRes.trusted && urlRes.untrusted) return { error: untrustedUrlMessage(spec.baseUrlEnv) };
  const urlProblem = customEndpointUrlProblem(baseUrl);
  if (urlProblem) return { error: `${spec.baseUrlEnv}: ${urlProblem}` };
  const scrub = (t) => String(t).split(apiKey).join("[redacted]");
  const rawTimeout = resolveVendorEnv("OPENAI_COMPAT_TIMEOUT_MS");
  const timeoutMs = Number(rawTimeout) > 0 ? Number(rawTimeout) : 120000;
  const url = buildChatUrl(baseUrl);
  let res;
  try {
    res = await postJson(url, { model: upstreamModel, messages: [{ role: "user", content: attachReferencedFiles(task, agentInfo && agentInfo.projectDir) }] }, apiKey, timeoutMs);
  } catch (err) {
    return { error: scrub(`Request to ${url} failed: ${err && err.message ? err.message : String(err)}`) };
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    return { error: scrub(`Endpoint ${url} returned HTTP ${res.statusCode}: ${res.body.slice(0, 500)}`) };
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

/** openai-compatible adapter: reads OPENAI_COMPAT_BASE_URL / OPENAI_COMPAT_API_KEY (names only, never logs values). */
async function openaiCompatibleAdapter(task, agentInfo) {
  if (agentInfo && agentInfo.endpointEnv && isCustomEndpointSlot(agentInfo.vendor, agentInfo)) return customEndpointAdapter(task, agentInfo);
  const fixedSpec = agentInfo && FIXED_VENDOR_ENDPOINTS[String(agentInfo.vendor || "").toLowerCase()];
  if (fixedSpec) return fixedVendorAdapter(task, agentInfo, fixedSpec);
  const genericUrl = resolveUrlVar("OPENAI_COMPAT_BASE_URL", agentInfo && agentInfo.projectDir);
  const baseUrl = genericUrl.trusted || genericUrl.untrusted;
  if (!baseUrl) return { error: missingVendorEnvMessage("OPENAI_COMPAT_BASE_URL"), kind: "not_configured" };
  const model = (agentInfo && agentInfo.model) || "default";
  const apiKey = resolveVendorEnv("OPENAI_COMPAT_API_KEY") || undefined;
  if (apiKey && !genericUrl.trusted) return { error: untrustedUrlMessage("OPENAI_COMPAT_BASE_URL") };
  const rawTimeout = resolveVendorEnv("OPENAI_COMPAT_TIMEOUT_MS");
  const timeoutMs = Number(rawTimeout) > 0 ? Number(rawTimeout) : 120000;
  const url = buildChatUrl(baseUrl);
  let res;
  try {
    res = await postJson(url, { model, messages: [{ role: "user", content: attachReferencedFiles(task, agentInfo && agentInfo.projectDir) }] }, apiKey, timeoutMs);
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
    return { error: "Gemini on the Codex harness needs GEMINI_API_KEY (set it on the Agents screen). Antigravity sign-in isn't supported on the Codex harness yet.", kind: "not_configured" };
  }
  return { error: "google vendor: gemini shim not implemented — set up gemini-mcp-tool per media/mcp/catalog.json's gemini entry instead of dispatching through this bridge.", kind: "not_configured" };
}

const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"];
const CODEX_BRIDGE_ORIGINATOR = "tycoon-dispatcher-exec";

/** Codex's elevated Windows sandbox could not start: every shell command in the child fails. */
const CODEX_SANDBOX_SIGNATURE_RE = /setup refresh had errors|Failed to create unified exec process|CreateProcess[^\n]{0,120}Rejected|Rejected[^\n]{0,120}CreateProcess/i;
const CODEX_LOG_LINE_RE = /^\s*(?:\S+\s+)?(?:ERROR|WARN)\b|exec_command failed:/;
/** Only Codex's own stderr log/error lines count; stdout (the worker's answer) may quote these strings legitimately. */
function isCodexSandboxUnavailable(stderr) {
  return String(stderr || "").split(/\r?\n/).some((l) => CODEX_LOG_LINE_RE.test(l) && CODEX_SANDBOX_SIGNATURE_RE.test(l));
}
/**
 * Codex's macOS Seatbelt sandbox refused to start the worker's shell. Deliberately narrow: only a
 * Codex log line naming sandbox-exec / sandbox_apply / seatbelt counts, never a bare "Operation not
 * permitted", which the user's own code can raise for unrelated reasons.
 */
const CODEX_MACOS_SANDBOX_SIGNATURE_RE = /sandbox-exec[^\n]{0,160}(?:sandbox_apply|not permitted|denied)|sandbox_apply[^\n]{0,80}(?:not permitted|denied)|seatbelt[^\n]{0,120}(?:denied|fail|error|unavailable)/i;
function isCodexMacosSandboxUnavailable(stderr, platform) {
  if ((platform || process.platform) !== "darwin") return false;
  return String(stderr || "").split(/\r?\n/).some((l) => CODEX_LOG_LINE_RE.test(l) && CODEX_MACOS_SANDBOX_SIGNATURE_RE.test(l));
}
const CODEX_MACOS_SANDBOX_UNAVAILABLE_MESSAGE = "Codex's macOS sandbox blocked the worker from running commands. Sandbox settings are your decision: review sandbox_mode in ~/.codex/config.toml. TycoonAgents does not change them.";
/** The structured sandbox error for this stderr on this platform, or null when it is not a sandbox failure. */
function codexSandboxFailure(stderr, platform) {
  if (isCodexSandboxUnavailable(stderr)) return { error: CODEX_SANDBOX_UNAVAILABLE_MESSAGE, kind: "sandbox_unavailable" };
  if (isCodexMacosSandboxUnavailable(stderr, platform)) return { error: CODEX_MACOS_SANDBOX_UNAVAILABLE_MESSAGE, kind: "sandbox_unavailable" };
  return null;
}
const CODEX_SANDBOX_UNAVAILABLE_MESSAGE = "Codex's Windows sandbox couldn't start on this machine, so the worker couldn't run commands. Repair it in Codex, or set windows.sandbox = \"unelevated\" in your Codex config (config.toml).";

/** Runs `codex exec` for an openai slot on the Codex harness; elsewhere an openai specialist is Codex-native. */
async function openaiAdapter(task, agentInfo) {
  if (!agentInfo || agentInfo.harness !== "codex") return { error: "use Codex native agents" };
  const launcher = require("./codex-mcp-launcher.cjs");
  let bin;
  const realExit = process.exit;
  process.exit = () => { throw new Error("codex-not-found"); };
  try {
    bin = launcher.discoverCodexBinary(["exec"], { skipCapability: true });
  } catch {
    return { error: "Could not find the Codex CLI. Set CODEX_BINARY_PATH to the codex binary's full path.", kind: "cli_missing" };
  } finally {
    process.exit = realExit;
  }
  if (typeof bin !== "string") return { error: "Could not find the Codex CLI. Set CODEX_BINARY_PATH to the codex binary's full path.", kind: "cli_missing" };

  const bare = String((agentInfo && agentInfo.model) || "").trim().replace(/^openai\//i, "");
  const model = bare && MODEL_RE.test(bare) && !/^(gpt-5|gpt-6)$/i.test(bare) ? bare : undefined;
  const readOnly = isReadOnlyAgent(agentInfo);
  let cwd = resolveDefaultCwd();
  if (!readOnly) {
    // Builders always edit the project, never elsewhere.
    const projectDir = agentInfo && agentInfo.projectDir;
    try {
      if (typeof projectDir === "string" && projectDir && fs.statSync(projectDir).isDirectory()) cwd = projectDir;
    } catch { /* keep the scratch dir: edits cannot reach the project */ }
  }
  // mcp_servers.tycoon.enabled=false: the child must not see the machine-wide tycoon MCP server and delegate again.
  const args = ["exec", "--skip-git-repo-check", "-s", readOnly ? "read-only" : "workspace-write", "-c", "approval_policy=never", "-c", "mcp_servers.tycoon.enabled=false"];
  if (model) args.push("-m", model);
  const effort = agentInfo && typeof agentInfo.effort === "string" ? agentInfo.effort.trim().toLowerCase() : "";
  if (CODEX_EFFORTS.includes(effort)) args.push("-c", `model_reasoning_effort=${effort}`);
  args.push("-");

  const prompt = readOnly ? task : `${LEAF_PREAMBLE}

${task}`;
  const childEnv = {
    ...process.env,
    TYCOON_BRIDGE_CHILD: "1",
    TYCOON_CODEX_BRIDGE: "1",
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: CODEX_BRIDGE_ORIGINATOR,
  };
  const run = await runClaudeCli(bin, args, cwd, resolveTimeoutMs(), prompt, childEnv, { shell: launcher.needsShell(bin), label: "codex exec" });
  if (run.error) return { error: `${run.error} (argv: ${redactSecrets([bin, ...args].join(" "))})` };
  const sandboxFailure = codexSandboxFailure(run.stderr);
  if (sandboxFailure) return sandboxFailure;
  if (run.code !== 0) {
    const tail = redactSecrets(run.stderr || "").slice(-500);
    return { error: `codex exec exited ${run.code} (argv: ${redactSecrets([bin, ...args].join(" "))}).${tail ? ` stderr: ${tail}` : ""}` };
  }
  return { text: String(run.stdout || "").trim() };
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
function resolveAdapter(vendor, opts) {
  if (process.env.TYCOON_DISPATCH_ADAPTER === "stub") {
    return { key: adapterKeyForVendor(vendor, opts), fn: stubAdapter };
  }
  const key = adapterKeyForVendor(vendor, opts);
  return { key, fn: ADAPTERS[key] };
}

module.exports = {
  codexSandboxFailure,
  claudeSubscriptionBlock,
  adapterKeyForVendor,
  resolveAdapter,
  resolveVendorEnv,
  missingVendorEnvMessage,
  isCustomEndpointSlot,
  customUpstreamModel,
  customKeyNameProblem,
  customEndpointNameProblem,
  customEndpointUrlProblem,
  CUSTOM_RULES,
  declaredMcpEnvNames,
  anthropicAdapter,
  resolveClaudePermissionMode,
  isReadOnlyAgent,
  openaiCompatibleAdapter,
  googleAdapter,
  openaiAdapter,
  withVendorPrefix,
  attachReferencedFiles,
  FIXED_VENDOR_ENDPOINTS,
  unsupportedAdapter,
  stubAdapter,
};
