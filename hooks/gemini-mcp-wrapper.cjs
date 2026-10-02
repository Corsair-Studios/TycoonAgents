/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Thin MCP stdio wrapper around the community gemini-mcp-tool (jamubc). It
 * launches a PINNED version of that package, proxies newline-delimited
 * JSON-RPC both ways unchanged, and rewrites only tools/call results into the
 * shared bridge envelope (hooks/bridge-result.cjs): ok / provider_error /
 * timeout / empty, with a size cap. A timed-out call kills the child process
 * tree (it is respawned on the next call); exit or stdin close kills it too.
 *
 * Command discovery (docs/PATH-DISCOVERY.md): TYCOON_GEMINI_MCP_CMD override
 * (optional TYCOON_GEMINI_MCP_ARGS, a JSON array) wins; otherwise `npx` is
 * found on PATH, then beside the running node binary, and failure lists every
 * place tried and names the override.
 *
 * Env: TYCOON_GEMINI_MCP_CMD, TYCOON_GEMINI_MCP_ARGS, TYCOON_BRIDGE_TIMEOUT_MS
 * (default 180000), TYCOON_BRIDGE_MAX_CHARS (default 12000), GEMINI_MCP_BACKEND
 * (agy | gemini, read by gemini-mcp-tool itself), GEMINI_MODEL (label only).
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { formatBridgeResult, withTimeout, providerErrorResult } = require("./bridge-result.cjs");

const PINNED_PACKAGE = "gemini-mcp-tool@1.1.8";
const PROVIDER = "gemini";
const IS_WIN = process.platform === "win32";

function pathCandidates(name) {
  const dirs = (process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
  const exts = IS_WIN ? [".cmd", ".exe", ".bat", ""] : [""];
  const out = [];
  const add = (p) => {
    if (!out.includes(p)) out.push(p);
  };
  for (const d of dirs) for (const e of exts) add(path.join(d, name + e));
  for (const e of exts) add(path.join(path.dirname(process.execPath), name + e));
  return out;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Returns { command, args } or throws an Error listing every location tried. */
function resolveCommand(env) {
  const override = (env.TYCOON_GEMINI_MCP_CMD || "").trim();
  if (override) {
    let args = [];
    if (env.TYCOON_GEMINI_MCP_ARGS) {
      try {
        args = JSON.parse(env.TYCOON_GEMINI_MCP_ARGS);
      } catch {
        args = null;
      }
      if (!Array.isArray(args)) throw new Error("TYCOON_GEMINI_MCP_ARGS must be a JSON array of strings");
    }
    return { command: override, args };
  }
  const tried = pathCandidates("npx");
  const found = tried.find(isFile);
  if (!found) {
    throw new Error(
      "npx was not found. Tried: " +
        tried.join(", ") +
        ". Install Node.js or set TYCOON_GEMINI_MCP_CMD (and optionally TYCOON_GEMINI_MCP_ARGS as a JSON array) to the command that starts the Gemini MCP server.",
    );
  }
  return { command: found, args: ["-y", PINNED_PACKAGE] };
}

/**
 * cmd.exe needs a single pre-quoted command line to run a .cmd/.bat shim (a
 * bare path with a space in a directory name is split at the space). Quotes the
 * command and any argument containing whitespace or cmd metacharacters.
 */
function shellCommandLine(command, args) {
  const quote = (s) => (/[\s"&|<>^()%!]/.test(String(s)) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s));
  return [quote(command), ...(args || []).map(quote)].join(" ");
}

function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function textOf(result) {
  const blocks = result && Array.isArray(result.content) ? result.content : [];
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Pure: maps a child's tools/call result (or JSON-RPC error) to a bridge result. */
function normalizeCallResult(msg, model) {
  if (msg.error) {
    return providerErrorResult({ provider: PROVIDER, model, text: (msg.error && msg.error.message) || "Gemini MCP server returned an error" });
  }
  const text = textOf(msg.result);
  if (msg.result && msg.result.isError === true) {
    return providerErrorResult({ provider: PROVIDER, model, text: text.slice(0, 400) || "Gemini call failed" });
  }
  return formatBridgeResult({ status: "ok", provider: PROVIDER, model, text });
}

const MAX_PENDING = 64;
const DEFAULT_REQUEST_TIMEOUT_MS = 180000;

function requestTimeoutMs(env) {
  const n = Number(String(env.TYCOON_BRIDGE_TIMEOUT_MS || "").trim());
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 2147483647) : DEFAULT_REQUEST_TIMEOUT_MS;
}

function run() {
  const env = process.env;
  const model = env.GEMINI_MODEL || "gemini";
  const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

  let child = null;
  let startError = null;
  let initRequest = null;
  let reinitId = null;
  const pending = new Map(); // id -> { isCall, resolve, owner: child that received it, timer? }

  const errResult = (message, kind) => providerErrorResult({ provider: PROVIDER, model, text: message, kind });

  // Fails only the requests that were sent to `owner`, so a replaced child's
  // late exit never touches calls in flight on its successor.
  function failOwned(owner, message, kind) {
    for (const [id, p] of pending) {
      if (p.owner !== owner) continue;
      pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      if (p.isCall) p.resolve(errResult(message, kind));
      else out({ jsonrpc: "2.0", id, error: { code: -32000, message } });
    }
  }

  function send(obj) {
    if (child && child.stdin.writable) child.stdin.write(JSON.stringify(obj) + "\n");
  }

  function onChildLine(c, line) {
    if (child !== c) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg && reinitId !== null && msg.id === reinitId && !msg.method) {
      reinitId = null;
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return;
    }
    const p = msg && msg.id !== undefined && !msg.method ? pending.get(msg.id) : null;
    if (!p) {
      out(msg);
      return;
    }
    pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if (p.isCall) p.resolve(normalizeCallResult(msg, model));
    else out(msg);
  }

  function ensureChild() {
    if (child && child.exitCode === null) return true;
    let cmd;
    try {
      cmd = resolveCommand(env);
    } catch (e) {
      startError = e.message;
      return false;
    }
    const needsShell = IS_WIN && /\.(cmd|bat)$/i.test(cmd.command);
    const c = needsShell
      ? spawn(shellCommandLine(cmd.command, cmd.args), { stdio: ["pipe", "pipe", "inherit"], detached: !IS_WIN, shell: true, windowsHide: true })
      : spawn(cmd.command, cmd.args, { stdio: ["pipe", "pipe", "inherit"], detached: !IS_WIN, shell: needsShell, windowsHide: true });
    child = c;
    startError = null;
    c.on("error", (e) => {
      const message = "Could not start the Gemini MCP server (" + cmd.command + "): " + e.message;
      if (child === c) {
        child = null;
        startError = message;
      }
      failOwned(c, message, "cli_missing");
    });
    c.on("exit", (code, signal) => {
      if (child === c) child = null;
      failOwned(c, "Gemini MCP server exited (" + (signal || "code " + code) + ")");
    });
    c.stdin.on("error", () => {});
    readline.createInterface({ input: c.stdout }).on("line", (line) => onChildLine(c, line));
    if (initRequest) {
      reinitId = "tycoon-reinit";
      send(Object.assign({}, initRequest, { id: reinitId }));
    }
    return true;
  }

  function handleCall(msg) {
    if (!ensureChild()) {
      out({ jsonrpc: "2.0", id: msg.id, result: errResult(startError, "cli_missing") });
      return;
    }
    if (pending.size >= MAX_PENDING) {
      out({ jsonrpc: "2.0", id: msg.id, result: errResult("Too many in-flight Gemini requests (" + MAX_PENDING + ")", "rate_limit") });
      return;
    }
    const owner = child;
    let settled = false;
    const work = new Promise((resolve) => {
      pending.set(msg.id, {
        isCall: true,
        owner,
        resolve: (v) => {
          settled = true;
          resolve(v);
        },
      });
    });
    send(msg);
    withTimeout(work, undefined, "gemini call", { provider: PROVIDER, model, env }).then((result) => {
      if (!settled) {
        pending.delete(msg.id);
        killTree(owner);
        if (child === owner) child = null;
      }
      out({ jsonrpc: "2.0", id: msg.id, result });
    });
  }

  function handleRequest(msg) {
    if (pending.size >= MAX_PENDING) {
      out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Too many in-flight requests (" + MAX_PENDING + ")" } });
      return;
    }
    const owner = child;
    const limit = requestTimeoutMs(env);
    const timer = setTimeout(() => {
      if (!pending.delete(msg.id)) return;
      out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: msg.method + " timed out after " + limit + "ms" } });
      killTree(owner);
      if (child === owner) child = null;
    }, limit);
    if (typeof timer.unref === "function") timer.unref();
    pending.set(msg.id, { isCall: false, owner, timer, resolve() {} });
    send(msg);
  }

  function onClientLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (msg && msg.method === "initialize") initRequest = msg;
    if (msg && msg.method === "tools/call" && msg.id !== undefined) {
      handleCall(msg);
      return;
    }
    if (!ensureChild()) {
      if (msg && msg.id !== undefined && msg.method) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: startError } });
      return;
    }
    if (msg && msg.id !== undefined && msg.method) handleRequest(msg);
    else send(msg);
  }

  const shutdown = () => {
    killTree(child);
    child = null;
  };
  process.on("exit", shutdown);
  process.stdout.on("error", () => {
    shutdown();
    process.exit(0);
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(0));
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", onClientLine);
  rl.on("close", () => {
    shutdown();
    process.exit(0);
  });
  ensureChild();
}

if (require.main === module) run();

module.exports = { PINNED_PACKAGE, normalizeCallResult, resolveCommand, shellCommandLine };
