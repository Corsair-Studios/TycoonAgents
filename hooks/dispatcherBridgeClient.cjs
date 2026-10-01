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
 * Secrets: only the child's own env block from .mcp.json is forwarded, plus
 * this process's env; nothing is logged.
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

function resolveArg(arg, projectDir) {
  // Only project-relative script paths (e.g. ".claude/hooks/x.cjs") are rebased;
  // flags and other values pass through untouched.
  if (typeof arg !== "string") return String(arg);
  if (/^\.{1,2}[\\/]/.test(arg) || /^\.claude[\\/]/.test(arg)) {
    const abs = path.resolve(projectDir, arg);
    return fs.existsSync(abs) ? abs : arg;
  }
  return arg;
}

function spawnBridge(entry, projectDir, extraEnv) {
  const base = Object.assign({}, process.env);
  const command = expandVars(entry.command, base);
  const args = (Array.isArray(entry.args) ? entry.args : []).map((a) => resolveArg(expandVars(a, base), projectDir));
  const entryEnv = {};
  if (entry.env && typeof entry.env === "object") {
    for (const [k, v] of Object.entries(entry.env)) entryEnv[k] = expandVars(v, base);
  }
  const env = Object.assign({}, base, entryEnv, extraEnv || {});
  const isWinShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  if (isWinShim) {
    const quote = (s) => (/[\s"&|<>^]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : s);
    return spawn([quote(command), ...args.map(quote)].join(" "), { cwd: projectDir, env, shell: true, stdio: ["pipe", "pipe", "pipe"] });
  }
  return spawn(command, args, { cwd: projectDir, env, stdio: ["pipe", "pipe", "pipe"] });
}

/** Kills the child and, on Windows, its whole tree (a .cmd/shell shim or launcher leaves grandchildren otherwise). */
function killTree(child) {
  if (process.platform === "win32" && child.pid) {
    try {
      const k = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
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
 * opts: { projectDir, serverName, toolName, toolArgs, timeoutMs?, env? }
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
    let child;
    try {
      child = spawnBridge(found.entry, opts.projectDir, opts.env);
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
    const kind = (call && call.kind) || bridgeResult.classifyProviderError(message);
    const status = kind === "timeout" ? "timeout" : "provider_error";
    return { status, provider, model, summary: "", error: { kind, message } };
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
    return { status: "provider_error", provider, model, summary: "", error: { kind: bridgeResult.classifyProviderError(first), message: first.slice(0, 500) || "Provider call failed" } };
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
  expandVars,
  callBridgeTool,
  normalizeAttempt,
};
