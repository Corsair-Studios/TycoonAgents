#!/usr/bin/env node
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * ---------------------------------------------------------------------------
 * Zero-dependency MCP stdio server that lets a Claude Max subscriber's OWN
 * `claude` CLI login do model work for TycoonAgents — never a third-party
 * OAuth token, never a credential TycoonAgents stores or forwards. This is
 * the Claude-CLI counterpart to hooks/openai-compatible-mcp.cjs (protocol
 * skeleton copied from there — see its header comment for the wire-format
 * background) and to the `codex` MCP entry in media/mcp/catalog.json, which
 * runs `codex mcp-server` under a ChatGPT subscription the same way.
 *
 * Transport / handshake: identical to openai-compatible-mcp.cjs — legacy MCP
 * stdio (initialize -> notifications/initialized -> tools/list -> tools/call),
 * one JSON-RPC 2.0 message per line on stdin/stdout, stderr free for logging
 * and never parsed by the client.
 *
 * Methods implemented:
 *   initialize   -> { protocolVersion (echoed), capabilities: { tools: {} },
 *                      serverInfo: { name, version } }
 *   tools/list   -> { tools: [ <claude tool descriptor> ] }
 *   tools/call   -> { content: [ { type: "text", text: <CLI result text> } ],
 *                      structuredContent: { usage, cost_usd, model_usage,
 *                        session_id, num_turns, is_error },
 *                      isError?: true }
 *
 * The `claude` tool's inputSchema: { prompt: string (required), system?:
 * string, model?: string, max_turns?: number, cwd?: string,
 * allowed_tools?: string[] }.
 *
 * SECURITY — no shell, ever. An earlier revision of this file built one
 * cmd.exe command string (via now-deleted quoteCmdArg/quoteWindowsCommand
 * helpers) to work around Windows refusing to exec a .cmd shim directly, and
 * spawned it with shell:true. That was a command-injection bug: cmd.exe
 * treats & | < > ^ % as metacharacters EVEN INSIDE double quotes, so a
 * prompt like `" & echo INJECTED & "` executed arbitrary commands. This
 * revision never sets shell:true and never builds a shell command string.
 * Untrusted content (prompt, system, allowed_tools, model) either goes
 * through argv as a discrete array element (Node quotes each element
 * correctly for CreateProcess without a shell) or, for the prompt
 * specifically, over stdin — never through a shell.
 *
 * What actually runs: `claude -p --output-format json --max-turns <N>
 * --model <M> --permission-mode <mode>` (+ `--allowedTools <...>` when
 * allowed_tools is given, + `--append-system-prompt <system>` when system is
 * given), with the prompt text written to the child's stdin and the stream
 * closed — NOT passed as a positional argv element. Verified directly:
 * `echo "Reply with the single word OK." | claude -p --output-format json
 * --max-turns 1 --model claude-haiku-4-5` returns the normal JSON result
 * with result:"OK", and a prompt containing `& | ^ %` round-trips as plain
 * text with no shell interpretation. `--max-turns` is not listed in `claude
 * --help` on the version this was verified against (Claude Code 2.1.258)
 * but is accepted and honored. Every other flag used here (--model,
 * --permission-mode, --allowedTools, --append-system-prompt,
 * --output-format) IS documented by `claude --help`; re-check that output
 * before adding any further flag, since undocumented flags can change
 * without notice.
 *
 * Input validation (defense in depth even though nothing here reaches a
 * shell): `model` must match MODEL_RE; each `allowed_tools` entry must match
 * ALLOWED_TOOL_RE; `system` is rejected if it contains a NUL byte or a C0
 * control character other than tab/newline/carriage-return; `cwd`, when
 * given, must already exist as a directory. Any failure is isError, never a
 * silent coercion.
 *
 * Working directory: the caller's `cwd` arg, else CLAUDE_CLI_CWD, else a
 * fresh per-process scratch directory under os.tmpdir() — deliberately NOT
 * this project's root, so the orchestrator's own CLAUDE.md / project context
 * is not auto-loaded into every subscription-backed call (that inflates
 * prompt-cache-creation tokens and cost). Pass `cwd` (or set CLAUDE_CLI_CWD)
 * to the project directory on purpose when the call actually needs file
 * context from it.
 *
 * Permission mode: defaults to "plan" (read-only planning, no tool side
 * effects) via CLAUDE_CLI_PERMISSION_MODE, since this bridge exists to let a
 * subscription do read/advise work, not to hand it unattended write access.
 * Override only when the caller understands the consequences.
 *
 * Binary discovery (docs/PATH-DISCOVERY.md ladder — explicit override first,
 * then multiple independent signals, never one guess, fail with every path
 * tried on total failure):
 *   1. CLAUDE_CLI_BIN env var, if set — used as-is, no further probing.
 *   2. `claude` resolved off PATH (claude.cmd / claude.exe on win32, plain
 *      `claude` elsewhere).
 *   3. %APPDATA%/npm/claude.cmd (npm global installs on Windows).
 *   4. ~/.local/bin/claude (a common Linux/macOS user-local install).
 *   5. /usr/local/bin/claude (a common systemwide Unix install).
 * On total failure: isError listing every path tried and naming
 * CLAUDE_CLI_BIN as the override.
 *
 * Spawning what discovery found (resolveSpawnTarget): an .exe or an
 * extensionless native binary is spawned directly with an argv array — no
 * shell needed. A .cmd/.bat (an npm-generated shim on Windows) CANNOT be
 * exec'd directly by Node without a shell, so instead of falling back to
 * shell:true, this reads the shim's own text and extracts the quoted
 * "<...>.js" path it invokes (standard npm shim shape: `"%_prog%"
 * "%dp0%\..\<pkg>\<entry>.js" %*`), substitutes %dp0%/%~dp0% with the
 * shim's own directory, resolves it to an absolute path, and — if that file
 * exists — spawns `process.execPath <resolved-entry.js> <args>` directly
 * (no shell, no .cmd involved at all). If no such .js path can be resolved,
 * this is isError explaining that and naming CLAUDE_CLI_BIN as the way to
 * point directly at a native binary or a resolvable entry point — it never
 * silently falls back to a shell.
 *
 * Response shape contract (for the hook / any downstream parser):
 *   - content[0].text is ALWAYS the CLI's `result` field on success.
 *   - structuredContent.usage = { input_tokens, output_tokens,
 *     cache_read_tokens, cache_creation_tokens }, mapped from the CLI JSON's
 *     top-level `usage` object. Fields omitted (not zero-filled) when the
 *     CLI JSON has no `usage` object.
 *   - structuredContent.cost_usd <- total_cost_usd, when present.
 *   - structuredContent.model_usage <- the CLI JSON's `modelUsage` object,
 *     re-keyed "anthropic/<canonicalModel>" -> { inputTokens, outputTokens,
 *     cacheReadInputTokens, cacheCreationInputTokens, costUSD }. Multiple
 *     modelUsage entries can share one canonicalModel (observed: a
 *     timestamped model id and its alias both present) — later entries for
 *     the same canonicalModel key are summed rather than overwriting, so no
 *     usage is silently dropped.
 *   - structuredContent.session_id / num_turns / is_error <- the matching
 *     top-level CLI JSON fields.
 *   - A trailing NDJSON line `{"usage": {...}}` is ALSO appended after the
 *     JSON-RPC response line, mirroring openai-compatible-mcp.cjs, for a
 *     caller that scrapes raw stdout instead of parsing structuredContent.
 *   - Every result carries the shared bridge envelope (hooks/bridge-result.cjs)
 *     in structuredContent beside the fields above: status ok | provider_error
 *     | timeout | empty, provider "claude-cli", model, summary (capped at
 *     TYCOON_BRIDGE_MAX_CHARS, truncated=true above it) and, on non-ok,
 *     error { kind, message }. kind is auth | quota | rate_limit | not_found |
 *     network | cli_missing | unknown.
 *   - Non-zero CLI exit, unparsable CLI stdout, a missing/unresolvable binary,
 *     invalid input, or the CLI JSON's own `is_error:true` are provider_error
 *     results (isError:true) with a plain-text message in content[0].text. A
 *     hung process past the timeout is status "timeout"; an empty/whitespace
 *     `result` is status "empty". Never a thrown exception and never a
 *     JSON-RPC `error` object.
 *   - Prompt text and any credentials are NEVER written to stderr or logs.
 * ---------------------------------------------------------------------------
 */

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { formatBridgeResult, providerErrorResult } = require("./bridge-result.cjs");

const SERVER_NAME = "claude-cli-mcp";
const SERVER_VERSION = "1.0.0";

const DEFAULT_MODEL = "haiku"; // alias: always resolves to the newest Haiku, never a pinned version
const DEFAULT_MAX_TURNS = 1;
const DEFAULT_PERMISSION_MODE = "plan";
const DEFAULT_TIMEOUT_MS = 180000;

// Validation patterns — defense in depth (see header comment "Input validation").
const MODEL_RE = /^[A-Za-z0-9._\-\/]{1,100}$/;
const ALLOWED_TOOL_RE = /^[A-Za-z0-9_:*().,\-\/ ]{1,200}$/;
// C0 control chars other than \t (09) \n (0A) \r (0D), plus NUL (00, already covered).
const DISALLOWED_CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

const CLAUDE_TOOL = {
  name: "claude",
  description:
    "Run a prompt through the user's own `claude` CLI login (a Claude Max/Pro subscription) instead of a metered API key — legitimate first-party CLI use, never a third-party OAuth token. Runs non-interactively via `claude -p`, with the prompt delivered over stdin (never a shell).",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The prompt to send. Delivered over the CLI's stdin, never through a shell." },
      system: { type: "string", description: "Optional text appended to the default system prompt (--append-system-prompt). Must not contain NUL or other control characters." },
      model: { type: "string", description: "Model alias or full name (e.g. 'haiku', 'sonnet' — an alias always resolves to the newest model). Defaults to CLAUDE_CLI_MODEL env or 'haiku'. Must match /^[A-Za-z0-9._-/]{1,100}$/." },
      max_turns: { type: "number", description: "Max agentic turns. Defaults to 1." },
      cwd: { type: "string", description: "Working directory for the CLI session. Must already exist as a directory. Defaults to CLAUDE_CLI_CWD env, else a fresh scratch directory (so the caller's project CLAUDE.md is NOT auto-loaded unless you set this deliberately)." },
      allowed_tools: {
        type: "array",
        description: "Optional list of built-in tool names to allow (--allowedTools). Each entry must match /^[A-Za-z0-9_:*().,\\-\\/ ]{1,200}$/.",
        items: { type: "string" },
      },
    },
    required: ["prompt"],
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

const PROVIDER = "claude-cli";

/** A provider_error bridge result; `kind` overrides the text-based classification. */
function isErrorResult(text, kind, model) {
  return providerErrorResult({ provider: PROVIDER, model, text, kind });
}

/** CLAUDE_CLI_TIMEOUT_MS first, then the shared TYCOON_BRIDGE_TIMEOUT_MS, else the 180s default. */
function resolveTimeoutMs() {
  for (const name of ["CLAUDE_CLI_TIMEOUT_MS", "TYCOON_BRIDGE_TIMEOUT_MS"]) {
    const n = Number(process.env[name]);
    if (process.env[name] && Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TIMEOUT_MS;
}

/** Binary discovery ladder — see header comment. Returns { bin, triedPaths }. */
function discoverClaudeBin() {
  const tried = [];

  const envBin = process.env.CLAUDE_CLI_BIN;
  if (envBin) {
    return { bin: envBin, triedPaths: [`CLAUDE_CLI_BIN=${envBin}`] };
  }

  // PATH lookup.
  const pathVar = process.env.PATH || process.env.Path || "";
  const pathDirs = pathVar.split(path.delimiter).filter(Boolean);
  const isWin = process.platform === "win32";
  const pathCandidates = isWin ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];
  for (const dir of pathDirs) {
    for (const cand of pathCandidates) {
      const full = path.join(dir, cand);
      tried.push(full);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return { bin: full, triedPaths: tried };
        }
      } catch { /* keep probing */ }
    }
  }

  // Well-known install locations.
  const fallbacks = [];
  if (isWin && process.env.APPDATA) {
    fallbacks.push(path.join(process.env.APPDATA, "npm", "claude.cmd"));
  }
  const home = os.homedir();
  if (home) {
    fallbacks.push(path.join(home, ".local", "bin", "claude"));
  }
  fallbacks.push("/usr/local/bin/claude");

  for (const full of fallbacks) {
    tried.push(full);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        return { bin: full, triedPaths: tried };
      }
    } catch { /* keep probing */ }
  }

  return { bin: null, triedPaths: tried };
}

/** Reads an npm-generated .cmd/.bat shim's text and extracts the absolute
 * path of the .js entry point it invokes, if resolvable. Standard npm shim
 * shape: `"%_prog%"  "%dp0%\..\<pkg>\<entry>.js" %*` (see node_modules/.bin
 * shims for the exact template). Returns null — never throws — when the
 * file can't be read or no resolvable .js path is found. */
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
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return resolved;
      }
    } catch { /* try the next match */ }
  }
  return null;
}

/** Turns a discovered binary path into something spawn-able WITHOUT a
 * shell. Returns { command, args, error }: `args` is a prefix to place
 * before the CLI's own argv (empty unless a .js entry point was resolved,
 * in which case it is [entryPath] and `command` is process.execPath). See
 * header comment "Spawning what discovery found". */
function resolveSpawnTarget(bin) {
  const isWin = process.platform === "win32";
  if (isWin && /\.(cmd|bat)$/i.test(bin)) {
    const jsEntry = resolveCmdShimJsEntry(bin);
    if (jsEntry) {
      return { command: process.execPath, args: [jsEntry], error: null };
    }
    return {
      command: null,
      args: null,
      error:
        `Could not resolve a .js entry point from the npm shim at ${bin} — refusing to run it through a shell. ` +
        "Set CLAUDE_CLI_BIN to either the claude CLI's .js entry point, or a native .exe, to bypass shim resolution.",
    };
  }
  return { command: bin, args: [], error: null };
}

function resolveDefaultCwd() {
  if (process.env.CLAUDE_CLI_CWD) return process.env.CLAUDE_CLI_CWD;
  const scratch = path.join(os.tmpdir(), `claude-cli-mcp-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(scratch, { recursive: true });
  } catch {
    // Fall through — spawn will surface an ENOENT-style error if this is
    // truly unusable, which is reported as isError like any other failure.
  }
  return scratch;
}

/** Spawns `command args` with no shell involved, writes `promptText` to its
 * stdin and closes it, and collects stdout/stderr until close or timeout. */
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
      resolve({ timedOut: true, error: `claude CLI timed out after ${timeoutMs}ms (set CLAUDE_CLI_TIMEOUT_MS or TYCOON_BRIDGE_TIMEOUT_MS to override)` });
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
    } catch {
      // A write failure here still resolves via the close/error handlers
      // above — nothing further to do.
    }
  });
}

/** Maps the CLI's `usage` object to this bridge's structuredContent.usage shape. */
function mapUsage(usageRaw) {
  if (!usageRaw || typeof usageRaw !== "object") return undefined;
  const usage = {};
  if (typeof usageRaw.input_tokens === "number") usage.input_tokens = usageRaw.input_tokens;
  if (typeof usageRaw.output_tokens === "number") usage.output_tokens = usageRaw.output_tokens;
  if (typeof usageRaw.cache_read_input_tokens === "number") usage.cache_read_tokens = usageRaw.cache_read_input_tokens;
  if (typeof usageRaw.cache_creation_input_tokens === "number") usage.cache_creation_tokens = usageRaw.cache_creation_input_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Maps the CLI's `modelUsage` object to { "anthropic/<canonicalModel>": {...} },
 * summing entries that share a canonicalModel (the CLI can emit more than
 * one modelUsage key — e.g. a timestamped id and its alias — for one run). */
function mapModelUsage(modelUsageRaw) {
  if (!modelUsageRaw || typeof modelUsageRaw !== "object") return undefined;
  const out = {};
  for (const entry of Object.values(modelUsageRaw)) {
    if (!entry || typeof entry !== "object") continue;
    const canonical = typeof entry.canonicalModel === "string" ? entry.canonicalModel : "unknown";
    const key = `anthropic/${canonical}`;
    const prev = out[key] || {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0,
    };
    out[key] = {
      inputTokens: prev.inputTokens + (typeof entry.inputTokens === "number" ? entry.inputTokens : 0),
      outputTokens: prev.outputTokens + (typeof entry.outputTokens === "number" ? entry.outputTokens : 0),
      cacheReadInputTokens: prev.cacheReadInputTokens + (typeof entry.cacheReadInputTokens === "number" ? entry.cacheReadInputTokens : 0),
      cacheCreationInputTokens: prev.cacheCreationInputTokens + (typeof entry.cacheCreationInputTokens === "number" ? entry.cacheCreationInputTokens : 0),
      costUSD: prev.costUSD + (typeof entry.costUSD === "number" ? entry.costUSD : 0),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function handleClaudeTool(args) {
  const prompt = args && typeof args.prompt === "string" ? args.prompt : undefined;
  if (!prompt) {
    return isErrorResult("Missing required argument: prompt", "unknown");
  }

  const model = (typeof args.model === "string" && args.model) || process.env.CLAUDE_CLI_MODEL || DEFAULT_MODEL;
  if (!MODEL_RE.test(model)) {
    return isErrorResult(`Invalid model "${model}" — must match ${MODEL_RE}`, "unknown");
  }

  const maxTurns = typeof args.max_turns === "number" && args.max_turns > 0 ? args.max_turns : DEFAULT_MAX_TURNS;
  const permissionMode = process.env.CLAUDE_CLI_PERMISSION_MODE || DEFAULT_PERMISSION_MODE;

  let system;
  if (typeof args.system === "string" && args.system) {
    if (DISALLOWED_CONTROL_CHAR_RE.test(args.system)) {
      return isErrorResult("Invalid system: contains a NUL byte or a disallowed control character.", "unknown", model);
    }
    system = args.system;
  }

  let allowedTools;
  if (Array.isArray(args.allowed_tools) && args.allowed_tools.length > 0) {
    for (const tool of args.allowed_tools) {
      if (typeof tool !== "string" || !ALLOWED_TOOL_RE.test(tool)) {
        return isErrorResult(`Invalid allowed_tools entry ${JSON.stringify(tool)} — each entry must match ${ALLOWED_TOOL_RE}`, "unknown", model);
      }
    }
    allowedTools = args.allowed_tools;
  }

  let cwd;
  if (typeof args.cwd === "string" && args.cwd) {
    let stat;
    try {
      stat = fs.statSync(args.cwd);
    } catch {
      return isErrorResult(`Invalid cwd "${args.cwd}": does not exist.`, "unknown", model);
    }
    if (!stat.isDirectory()) {
      return isErrorResult(`Invalid cwd "${args.cwd}": not a directory.`, "unknown", model);
    }
    cwd = args.cwd;
  } else {
    cwd = resolveDefaultCwd();
  }

  const { bin, triedPaths } = discoverClaudeBin();
  if (!bin) {
    return isErrorResult(
      `Could not find the claude CLI. Tried:\n${triedPaths.map((p) => `  - ${p}`).join("\n")}\n` +
      "Set CLAUDE_CLI_BIN to the full path of your claude binary to override discovery.",
      "cli_missing",
      model
    );
  }

  const spawnTarget = resolveSpawnTarget(bin);
  if (spawnTarget.error) {
    return isErrorResult(spawnTarget.error, "cli_missing", model);
  }

  const timeoutMs = resolveTimeoutMs();

  const cliArgs = [
    "-p",
    "--output-format", "json",
    "--max-turns", String(maxTurns),
    "--model", model,
    "--permission-mode", permissionMode,
  ];
  if (system) {
    cliArgs.push("--append-system-prompt", system);
  }
  if (allowedTools) {
    cliArgs.push("--allowedTools", allowedTools.join(","));
  }

  const finalArgs = [...spawnTarget.args, ...cliArgs];
  const run = await runClaudeCli(spawnTarget.command, finalArgs, cwd, timeoutMs, prompt);
  if (run.timedOut) {
    return formatBridgeResult({ status: "timeout", provider: PROVIDER, model, error: { kind: "timeout", message: run.error } });
  }
  if (run.error) {
    return isErrorResult(run.error, /ENOENT|EACCES|EINVAL|spawn/i.test(run.error) ? "cli_missing" : undefined, model);
  }

  let parsed;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    const stderrSnippet = run.stderr ? ` stderr: ${run.stderr.slice(0, 1000)}` : "";
    return isErrorResult(`claude CLI produced non-JSON output (exit ${run.code}): ${run.stdout.slice(0, 1000)}${stderrSnippet}`, undefined, model);
  }

  if (run.code !== 0 || parsed.is_error === true) {
    const message = typeof parsed.result === "string" && parsed.result
      ? parsed.result
      : `claude CLI exited ${run.code}${run.stderr ? `: ${run.stderr.slice(0, 1000)}` : ""}`;
    return isErrorResult(message, undefined, model);
  }

  const text = typeof parsed.result === "string" ? parsed.result : "";
  const structuredContent = {};
  const usage = mapUsage(parsed.usage);
  if (usage) structuredContent.usage = usage;
  if (typeof parsed.total_cost_usd === "number") structuredContent.cost_usd = parsed.total_cost_usd;
  const modelUsage = mapModelUsage(parsed.modelUsage);
  if (modelUsage) structuredContent.model_usage = modelUsage;
  if (typeof parsed.session_id === "string") structuredContent.session_id = parsed.session_id;
  if (typeof parsed.num_turns === "number") structuredContent.num_turns = parsed.num_turns;
  structuredContent.is_error = parsed.is_error === true;

  if (usage && text.trim() !== "") {
    // Belt-and-suspenders trailing NDJSON line — see header comment.
    try { process.stdout.write(JSON.stringify({ usage }) + "\n"); } catch { /* never break the server over a logging line */ }
  }
  return formatBridgeResult({
    status: "ok",
    provider: PROVIDER,
    model,
    text,
    error: { kind: "empty", message: "claude CLI returned an empty result" },
    extra: structuredContent,
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
    return;
  }

  if (method === "tools/list") {
    respond(id, { tools: [CLAUDE_TOOL] });
    return;
  }

  if (method === "tools/call") {
    const toolName = params && params.name;
    const args = (params && params.arguments) || {};
    if (toolName !== "claude") {
      respond(id, { isError: true, content: [{ type: "text", text: `Unknown tool: ${toolName}` }] });
      return;
    }
    try {
      const result = await handleClaudeTool(args);
      respond(id, result);
    } catch (err) {
      respond(id, isErrorResult(`Unexpected error: ${err && err.message ? err.message : String(err)}`, "unknown"));
    }
    return;
  }

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
      try {
        process.stderr.write(
          `[claude-cli-mcp] ignoring malformed JSON-RPC line: ${err && err.message ? err.message : String(err)}\n`
        );
      } catch { /* never let a stderr write break the server */ }
      return;
    }
    handleRequest(msg).catch(() => { /* handleRequest itself never rejects; defensive only */ });
  });
  rl.on("close", () => process.exit(0));
}

main();
