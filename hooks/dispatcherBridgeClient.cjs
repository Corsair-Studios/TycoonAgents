"use strict";
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Plan p99-t2: the dispatcher's way of driving an already-configured foreign
 * bridge (openai-compatible / claude-cli / codex / gemini MCP servers) without
 * re-implementing any vendor logic. It acts as a minimal MCP stdio CLIENT:
 * read the bridge's launch config from the project's .mcp.json, spawn it,
 * initialize -> tools/call -> parse the shared bridge-result envelope, then
 * shut the child down. One short-lived child per call, never reused.
 *
 * Discovery (docs/PATH-DISCOVERY.md): the server config comes from
 * <projectDir>/.mcp.json `mcpServers[name]` (projectDir is resolved by the
 * caller: TYCOON_PROJECT_DIR override, then cwd). A missing file/entry, an
 * unsupported (non-stdio) entry, or a spawn failure is reported explicitly as
 * a provider_error envelope (kind "not_configured" / "cli_missing"), never
 * silently skipped. Relative `args` are resolved against projectDir so the
 * dispatcher can be launched from any cwd.
 *
 * Trust: the entry is only a pointer. It is spawned only in canonical form
 * (see resolveTrustedBridge); anything else fails with kind "bridge_untrusted".
 *
 * Secrets: only allowlisted env keys from .mcp.json are forwarded, plus this
 * process's env; nothing is logged.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const bridgeResult = require("./bridge-result.cjs");

const DEFAULT_STEP_TIMEOUT_MS = 180000;
const SHUTDOWN_GRACE_MS = 2000;
const DEFAULT_GUARD_GRACE_MS = 15000;

/** Default MCP tool per catalog bridge server, used when a chain slot has no `tools`. */
const DEFAULT_TOOL_BY_SERVER = {
  "openai-compatible": "chat",
  "claude-cli": "claude",
  codex: "codex",
  gemini: "ask-gemini",
};

function defaultToolForServer(serverName) {
  return DEFAULT_TOOL_BY_SERVER[serverName];
}

/** Reads <projectDir>/.mcp.json -> mcpServers[name]. Returns { entry } or { error }. */
function readServerEntry(projectDir, serverName) {
  const file = path.join(projectDir, ".mcp.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { error: `MCP server "${serverName}" is not configured: could not read ${file} (${err && err.code ? err.code : "unreadable"}).` };
  }
  const entry = parsed && parsed.mcpServers && parsed.mcpServers[serverName];
  if (!entry || typeof entry !== "object") {
    return { error: `MCP server "${serverName}" is not configured in ${file}.` };
  }
  if (typeof entry.command !== "string" || entry.command === "") {
    return { error: `MCP server "${serverName}" in ${file} is not a stdio server (no command); the dispatcher can only drive stdio bridges.` };
  }
  return { entry };
}

/** Claude Code's .mcp.json expansion: ${VAR} and ${VAR:-default}; an unset VAR without default is left as written. */
function expandVars(value, env) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name, dflt) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    return dflt !== undefined ? dflt : whole;
  });
}

/**
 * Canonical-form gate. A project's .mcp.json is repo-controlled, so the
 * dispatcher never runs an entry's command/args/env as written. It spawns only
 * `process.execPath <our own bridge script>` where the script is one of the
 * known bridge files for that server, sitting in the dispatcher's own
 * directory (realpath-checked: no symlink, junction or escape). Anything
 * else is refused with kind "bridge_untrusted" and nothing is spawned.
 */
const BRIDGE_SCRIPTS_BY_SERVER = {
  "openai-compatible": ["openai-compatible-mcp.cjs"],
  "claude-cli": ["claude-cli-mcp.cjs"],
  codex: ["codex-mcp-launcher.cjs", "codex-app-server-mcp.cjs"],
  gemini: ["gemini-mcp-wrapper.cjs"],
};

/** Entry env keys that may carry a literal value (enum-like settings, no paths or secrets). */
const ENV_LITERAL_KEYS = {
  TYCOON_CODEX_BACKEND: /^(auto|mcp-server|app-server)$/,
  GEMINI_MCP_BACKEND: /^(agy|gemini)$/,
  TYCOON_DISPATCH_HOST: /^(claude|codex|opencode|gemini)$/,
  TYCOON_BRIDGE_TIMEOUT_MS: /^\d{1,9}$/,
};
/** Entry env keys that may only reference the user's own same-named variable (`${NAME}`). */
const ENV_REFERENCE_KEYS = new Set([
  "OPENAI_COMPAT_BASE_URL",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_MODEL",
  "GEMINI_API_KEY",
]);
/** `-c key=value` Codex launcher args that stay within a safe sandbox. */
const CODEX_CONFIG_ARG = {
  model: /^"[A-Za-z0-9._:\/-]{1,80}"$/,
  model_reasoning_effort: /^"(minimal|low|medium|high|xhigh)"$/,
  approval_policy: /^"(never|on-request|on-failure|untrusted)"$/,
  sandbox_mode: /^"(read-only|workspace-write)"$/,
};

function untrusted(serverName, why) {
  return {
    error: `MCP server "${serverName}" in the project's .mcp.json is not in the canonical TycoonAgents bridge form (${why}); the dispatcher will not launch it. Reinstall the bridge from the TycoonAgents MCP catalog.`,
    kind: "bridge_untrusted",
  };
}

function safeRealpath(p) {
  try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); } catch { return undefined; }
}

function sameFile(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The per-user launcher folder TycoonAgents keeps current (src/core/stableBridgeDir.ts):
 * ALWAYS <os.homedir()>/.tycoonagents/bin. No environment variable can move it: a
 * repository can set env for this process, and this folder decides what is trusted.
 */
function stableBridgeDir() {
  try { return path.join(require("os").homedir(), ".tycoonagents", "bin"); } catch { return undefined; }
}

/**
 * True when `requested` resolves to a regular file named `base` sitting directly in the
 * real stable folder: the folder is not a link, the file is not a symlink or junction,
 * and its real location is the folder's real location.
 */
function isStableCopy(requested, base) {
  const dir = stableBridgeDir();
  if (!dir) return false;
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return false;
    const st = fs.lstatSync(requested);
    if (!st.isFile() || st.isSymbolicLink()) return false;
  } catch { return false; }
  const dirReal = safeRealpath(dir);
  const reqReal = safeRealpath(requested);
  if (!dirReal || !reqReal || path.basename(reqReal) !== base) return false;
  return sameFile(path.dirname(reqReal), dirReal) && sameFile(path.dirname(path.resolve(requested)), path.resolve(dir));
}

/** Returns { command, args, env } to spawn, or { error, kind } when the entry is not canonical. */
function resolveTrustedBridge(serverName, entry, projectDir, hooksDir) {
  const allowed = Object.prototype.hasOwnProperty.call(BRIDGE_SCRIPTS_BY_SERVER, serverName) ? BRIDGE_SCRIPTS_BY_SERVER[serverName] : undefined;
  if (!allowed) return untrusted(serverName, "unknown bridge server");
  if (entry.command !== "node") return untrusted(serverName, "command must be node");
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (args.length === 0 || typeof args[0] !== "string") return untrusted(serverName, "no bridge script");
  const base = path.basename(args[0].split("\\").join("/"));
  if (!allowed.includes(base)) return untrusted(serverName, "script is not a known bridge for this server");
  const ownPath = path.join(hooksDir, base);
  let st;
  try { st = fs.lstatSync(ownPath); } catch { return untrusted(serverName, "bridge script is missing next to the dispatcher"); }
  if (!st.isFile() || st.isSymbolicLink()) return untrusted(serverName, "bridge script is not a regular file");
  const ownReal = safeRealpath(ownPath);
  const dirReal = safeRealpath(hooksDir);
  if (!ownReal || !dirReal || !sameFile(ownReal, path.join(dirReal, base))) return untrusted(serverName, "bridge script path escapes the dispatcher directory");
  const requested = path.resolve(projectDir, args[0]);
  const requestedReal = safeRealpath(requested);
  if (!requestedReal || !(sameFile(requestedReal, ownReal) || isStableCopy(requested, base))) return untrusted(serverName, "script is not the dispatcher's own copy");
  const extra = args.slice(1);
  if (extra.length > 0) {
    if (serverName !== "codex" || extra.length % 2 !== 0) return untrusted(serverName, "unexpected arguments");
    for (let i = 0; i < extra.length; i += 2) {
      const m = extra[i] === "-c" && typeof extra[i + 1] === "string" ? /^([a-z_]+)=([\s\S]*)$/.exec(extra[i + 1]) : null;
      const rule = m && Object.prototype.hasOwnProperty.call(CODEX_CONFIG_ARG, m[1]) ? CODEX_CONFIG_ARG[m[1]] : undefined;
      if (!rule || !rule.test(m[2])) return untrusted(serverName, "unexpected arguments");
    }
  }
  const env = {};
  if (entry.env !== undefined && entry.env !== null) {
    if (typeof entry.env !== "object" || Array.isArray(entry.env)) return untrusted(serverName, "malformed env");
    for (const [k, v] of Object.entries(entry.env)) {
      if (typeof v !== "string") return untrusted(serverName, `env ${k} is not allowed`);
      if (Object.prototype.hasOwnProperty.call(ENV_LITERAL_KEYS, k) && ENV_LITERAL_KEYS[k].test(v)) env[k] = v;
      else if (ENV_REFERENCE_KEYS.has(k) && v === "${" + k + "}") env[k] = expandVars(v, process.env);
      else return untrusted(serverName, `env ${k} is not allowed`);
    }
  }
  return { command: process.execPath, args: [ownReal, ...extra], env };
}

/** Test seam: replaces the canonical-form gate with fn(serverName, entry) -> { command, args, env }. Pass undefined to restore. */
let trustOverride;
function setTrustOverrideForTests(fn) { trustOverride = fn; }

function spawnBridge(resolved, projectDir, extraEnv, spawnImpl) {
  const env = Object.assign({}, process.env, resolved.env || {}, extraEnv || {});
  const doSpawn = spawnImpl || spawn;
  return doSpawn(resolved.command, resolved.args, { cwd: projectDir, env, stdio: ["pipe", "pipe", "pipe"] });
}

/** Kills the child and, on Windows, its whole tree (a .cmd/shell shim or launcher leaves grandchildren otherwise). */
/** Absolute System32 taskkill.exe (a bare name is resolved against cwd first on Windows); null if absent. */
function taskkillPath() {
  const p = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
  try { return fs.existsSync(p) ? p : null; } catch { return null; }
}

function killTree(child) {
  const tk = process.platform === "win32" && child.pid ? taskkillPath() : null;
  if (tk) {
    try {
      const k = spawn(tk, ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      k.on("error", () => { try { child.kill(); } catch { /* gone */ } });
      return;
    } catch { /* fall through */ }
  }
  try { child.kill(); } catch { /* already gone */ }
}

/**
 * Calls one tool on one stdio bridge. Always resolves; never rejects.
 * Resolves { result } (the raw MCP CallToolResult) or { error, kind } for
 * transport-level failures (spawn error, early exit, JSON-RPC error, timeout).
 *
 * opts: { projectDir, serverName, toolName, toolArgs, timeoutMs?, env?, hooksDir?, spawn? } (hooksDir/spawn are test seams)
 */
function callBridgeTool(opts) {
  return new Promise((resolve) => {
    const found = readServerEntry(opts.projectDir, opts.serverName);
    if (found.error) {
      resolve({ error: found.error, kind: "not_configured" });
      return;
    }
    // The bridge enforces its own timeout (TYCOON_BRIDGE_TIMEOUT_MS, passed by the caller);
    // this guard only fires if the bridge itself is wedged, so it waits that long plus a grace.
    const bridgeTimeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_STEP_TIMEOUT_MS;
    const graceMs = Number(opts.graceMs) >= 0 ? Number(opts.graceMs) : DEFAULT_GUARD_GRACE_MS;
    const timeoutMs = bridgeTimeoutMs + graceMs;
    let resolved;
    if (trustOverride) {
      const o = trustOverride(opts.serverName, found.entry);
      const base = Object.assign({}, process.env);
      const oenv = {};
      for (const [k, v] of Object.entries(o.env || {})) oenv[k] = expandVars(v, base);
      resolved = { command: expandVars(o.command, base), args: (o.args || []).map((a) => expandVars(a, base)), env: oenv };
    } else {
      resolved = resolveTrustedBridge(opts.serverName, found.entry, opts.projectDir, opts.hooksDir || __dirname);
      if (resolved.error) {
        resolve({ error: resolved.error, kind: resolved.kind });
        return;
      }
    }
    let child;
    try {
      child = spawnBridge(resolved, opts.projectDir, opts.env, opts.spawn);
    } catch (err) {
      resolve({ error: `Failed to spawn MCP server "${opts.serverName}": ${err && err.message ? err.message : String(err)}`, kind: "cli_missing" });
      return;
    }

    let settled = false;
    let stderrTail = "";
    let buffer = "";
    const pending = new Map();
    let nextId = 1;

    const shutdown = () => {
      try { child.stdin.end(); } catch { /* already closed */ }
      const killTimer = setTimeout(() => killTree(child), SHUTDOWN_GRACE_MS);
      if (killTimer.unref) killTimer.unref();
      child.once("exit", () => clearTimeout(killTimer));
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const p of pending.values()) p.resolve({ transportError: "closed" });
      pending.clear();
      shutdown();
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish({ error: `MCP server "${opts.serverName}" did not answer within ${timeoutMs}ms`, kind: "timeout" });
    }, timeoutMs);

    const send = (obj) => {
      try { child.stdin.write(JSON.stringify(obj) + "\n"); } catch { /* surfaced via exit/error */ }
    };
    const request = (method, params) =>
      new Promise((res) => {
        const id = nextId++;
        pending.set(id, { resolve: res });
        send({ jsonrpc: "2.0", id, method, params });
      });

    child.stderr.on("data", (c) => { stderrTail = (stderrTail + c).slice(-400); });
    child.on("error", (err) => {
      finish({ error: `Failed to run MCP server "${opts.serverName}": ${err && err.message ? err.message : String(err)}`, kind: "cli_missing" });
    });
    child.on("exit", (code) => {
      if (settled) return;
      const tail = stderrTail.trim() ? ` stderr: ${stderrTail.trim().slice(-300)}` : "";
      finish({ error: `MCP server "${opts.serverName}" exited (code ${code}) before answering.${tail}`, kind: "cli_missing" });
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          p.resolve(msg);
        }
      }
    });

    (async () => {
      const init = await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "tycoon-dispatcher", version: "1.0.0" },
      });
      if (settled) return;
      if (!init || init.error) {
        finish({ error: `MCP server "${opts.serverName}" rejected initialize: ${init && init.error ? init.error.message : "no response"}`, kind: "cli_missing" });
        return;
      }
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const call = await request("tools/call", { name: opts.toolName, arguments: opts.toolArgs || {} });
      if (settled) return;
      if (!call || call.error) {
        finish({ error: `MCP server "${opts.serverName}" tool "${opts.toolName}" failed: ${call && call.error ? call.error.message : "no response"}`, kind: "provider_error" });
        return;
      }
      finish({ result: call.result || {} });
    })().catch((err) => {
      finish({ error: `Unexpected dispatcher client error: ${err && err.message ? err.message : String(err)}`, kind: "unknown" });
    });
  });
}

/**
 * Normalizes any CallToolResult (or transport failure from callBridgeTool)
 * into one envelope-shaped attempt: { status, provider, model, summary,
 * error?, usage? }. Envelope from a TycoonAgents bridge (structuredContent or
 * the trusted text header) is authoritative; a result without one (a
 * third-party bridge) is judged by isError / emptiness.
 */
function normalizeAttempt(call, slotInfo) {
  const provider = (slotInfo && slotInfo.provider) || "";
  const model = (slotInfo && slotInfo.model) || "";
  if (!call || call.error) {
    const message = (call && call.error) || "bridge call failed";
    const error = bridgeResult.describeProviderError(message, { kind: call && call.kind });
    const status = error.kind === "timeout" ? "timeout" : "provider_error";
    return { status, provider, model, summary: "", error };
  }
  const result = call.result || {};
  const usage = result.structuredContent && result.structuredContent.usage ? result.structuredContent.usage : undefined;
  const env = bridgeResult.parseBridgeResult(result, { trustedTextHeader: true });
  if (env) {
    const out = { status: env.status, provider: env.provider || provider, model: env.model || model, summary: env.summary || "" };
    if (env.error) out.error = env.error;
    if (usage) out.usage = usage;
    return out;
  }
  const first = Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === "string" ? result.content[0].text : "";
  if (result.isError === true) {
    return { status: "provider_error", provider, model, summary: "", error: bridgeResult.describeProviderError(first.slice(0, 500) || "Provider call failed") };
  }
  if (first.trim() === "") {
    return { status: "empty", provider, model, summary: "", error: { kind: "empty", message: "Provider returned empty output" } };
  }
  const out = { status: "ok", provider, model, summary: first };
  if (usage) out.usage = usage;
  return out;
}

module.exports = {
  DEFAULT_STEP_TIMEOUT_MS,
  defaultToolForServer,
  readServerEntry,
  resolveTrustedBridge,
  setTrustOverrideForTests,
  expandVars,
  callBridgeTool,
  normalizeAttempt,
  taskkillPath,
};
