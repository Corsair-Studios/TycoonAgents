"use strict";
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Plan p22-t10: resolves a Codex rollout file's first-line session_meta for
 * a given thread id, so notify-entry-point records can be enriched with
 * sub-agent attribution (thread_source, agent_path/agent_nickname,
 * parent_thread_id). Read-only, bounded to CODEX_HOME/sessions, first-line
 * only. Fail-open: any error returns null, never throws.
 */

const fs = require("fs");
const path = require("path");

/**
 * Resolves CODEX_HOME per docs/PATH-DISCOVERY.md's override-first ladder:
 * env override, else ~/.codex. Accepts an optional env object (defaulting
 * to process.env) so callers/tests can inject an isolated environment
 * instead of depending on the real machine's home directory.
 */
function resolveCodexHome(env = process.env) {
  const override = env.CODEX_HOME;
  if (override && override.trim()) return override.trim();
  const home = env.USERPROFILE || env.HOME;
  if (!home) return null;
  return path.join(home, ".codex");
}

/**
 * Recursively searches a single root directory (a date-partition tree) for
 * a file whose name contains threadId, returning the newest match (by
 * filename, which embeds an ISO-ish timestamp prefix, so lexicographic max
 * is also chronological max). Fail-open: returns null on any read error.
 */
function findRolloutFileInRoot(threadId, rootDir) {
  let best = null;
  const stack = [rootDir];
  try {
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) {
          if (!best || entry.name > best.name) best = { name: entry.name, full };
        }
      }
    }
  } catch {
    return null;
  }
  return best;
}

/**
 * Plan p30-t2: searches CODEX_HOME/sessions and CODEX_HOME/archived_sessions
 * (app-server threads archive their rollout under the latter) for a file
 * whose name contains threadId, applying the same date-partition walk and
 * newest-by-filename selection within each root. When both roots produce a
 * candidate, the one with the newer filesystem mtime wins (filenames alone
 * aren't comparable across the two roots). Bounded to those two trees;
 * never throws.
 */
function findRolloutFile(threadId, codexHome, env = process.env) {
  if (!threadId) return null;
  const home = codexHome || resolveCodexHome(env);
  if (!home) return null;

  const sessionsCandidate = findRolloutFileInRoot(threadId, path.join(home, "sessions"));
  const archivedCandidate = findRolloutFileInRoot(threadId, path.join(home, "archived_sessions"));

  if (sessionsCandidate && archivedCandidate) {
    try {
      const sessionsMtime = fs.statSync(sessionsCandidate.full).mtimeMs;
      const archivedMtime = fs.statSync(archivedCandidate.full).mtimeMs;
      return archivedMtime > sessionsMtime ? archivedCandidate.full : sessionsCandidate.full;
    } catch {
      return sessionsCandidate.full;
    }
  }

  if (sessionsCandidate) return sessionsCandidate.full;
  if (archivedCandidate) return archivedCandidate.full;
  return null;
}

/**
 * Reads only the first line of a rollout file and parses it as a
 * session_meta item. Returns the payload object, or null on any failure
 * (missing file, unreadable, not JSON, not a session_meta item).
 */
function readSessionMeta(filePath) {
  if (!filePath) return null;
  try {
    // Read a bounded chunk (first line of session_meta is small; rollouts
    // can be large, so avoid reading the whole file). 64KB comfortably
    // covers the observed session_meta line (~4-6KB with base_instructions).
    const fd = fs.openSync(filePath, "r");
    try {
      const bufSize = 65536;
      const buf = Buffer.alloc(bufSize);
      const bytesRead = fs.readSync(fd, buf, 0, bufSize, 0);
      const chunk = buf.toString("utf8", 0, bytesRead);
      const newlineIdx = chunk.indexOf("\n");
      const firstLine = newlineIdx === -1 ? chunk : chunk.slice(0, newlineIdx);
      if (!firstLine.trim()) return null;
      const item = JSON.parse(firstLine);
      if (!item || item.type !== "session_meta" || !item.payload || typeof item.payload !== "object") return null;
      return item.payload;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Resolves the session_meta payload for a given Codex thread id. Returns
 * null (and never throws) when CODEX_HOME can't be resolved, no rollout
 * file matches, or the file can't be read/parsed.
 */
function resolveSessionMeta(threadId, codexHome, env = process.env) {
  try {
    const filePath = findRolloutFile(threadId, codexHome, env);
    if (!filePath) return null;
    return readSessionMeta(filePath);
  } catch {
    return null;
  }
}

/**
 * Derives a roster workerId candidate from a Codex agent_path such as
 * "<agent_root>/search_retrieval_1" -> "search-retrieval": basename, strip a
 * trailing "_<digits>" instance suffix, then translate underscores to
 * hyphens. Returns null when agentPath is falsy.
 */
function workerIdFromAgentPath(agentPath) {
  if (!agentPath || typeof agentPath !== "string") return null;
  const base = path.basename(agentPath);
  const stripped = base.replace(/_\d+$/, "");
  return stripped.replace(/_/g, "-");
}

/**
 * Resolves the workerId to attribute a subagent thread to, per the task
 * brief's priority order: (1) agent_path basename (normalized) when it
 * matches a known roster agent id, (2) nickname matched against
 * agent-keywords.json patterns, (3) literal fallback "codex-agent".
 * knownAgentIds: Set<string> of roster agent ids (from .claude/agents/*.md
 * basenames). matchNicknameFn: optional (nickname) => string|null, kept
 * injectable for tests; defaults to no match.
 */
function resolveWorkerId(sessionMeta, knownAgentIds, matchNicknameFn) {
  const fromPath = workerIdFromAgentPath(sessionMeta && sessionMeta.agent_path);
  if (fromPath && knownAgentIds && knownAgentIds.has(fromPath)) return fromPath;

  const nickname = sessionMeta && sessionMeta.agent_nickname;
  if (nickname && typeof matchNicknameFn === "function") {
    const matched = matchNicknameFn(nickname);
    if (matched) return matched;
  }

  return "codex-agent";
}

// Per-process realpath memo (darwin only); cleared when it grows past 500 entries.
const REALPATH_CACHE = new Map();

/**
 * Normalizes a filesystem path for cross-platform comparison: backslashes
 * to forward slashes, lowercased on win32 (case-insensitive filesystem),
 * trailing slash stripped. Used to match a rollout's recorded `cwd` against
 * TYCOON_PROJECT_DIR without false negatives from slash/case differences.
 */
function normalizePathForCompare(p, opts) {
  if (!p || typeof p !== "string") return "";
  const platform = (opts && opts.platform) || process.platform;
  let s = p;
  if (platform === "darwin") {
    // macOS: /var -> /private/var and /tmp -> /private/tmp are symlinks, and volumes are case-insensitive by default.
    const cache = (opts && opts.cache) || (opts && opts.realpath ? null : REALPATH_CACHE);
    if (cache && cache.has(p)) {
      s = cache.get(p);
    } else {
      try {
        s = ((opts && opts.realpath) || fs.realpathSync)(s);
      } catch { /* path no longer exists: compare the spelling as recorded */ }
      if (cache) {
        if (cache.size > 500) cache.clear();
        cache.set(p, s);
      }
    }
  }
  s = s.replace(/\\/g, "/");
  if (platform === "win32" || platform === "darwin") s = s.toLowerCase();
  return s.replace(/\/+$/, "");
}

/**
 * Lists every *.jsonl rollout file under sessionsDir, newest first by
 * filename (rollout filenames embed an ISO-ish timestamp prefix, so
 * lexicographic descending order is also chronological descending order).
 * Bounded to `limit` entries. Fail-open: returns [] on any read error.
 */
function listRolloutFilesNewestFirst(sessionsDir, limit) {
  const all = [];
  const stack = [sessionsDir];
  try {
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          all.push({ name: entry.name, full });
        }
      }
    }
  } catch {
    return [];
  }
  all.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return typeof limit === "number" && limit >= 0 ? all.slice(0, limit) : all;
}

const NEWEST_THREAD_SCAN_LIMIT = 50;

/**
 * Plan p23-t9: resolves the Codex thread id of the nearest USER-originated
 * session (thread_source "user", or absent for older rollouts) whose
 * recorded cwd matches `cwd` — used by the dispatcher MCP server to
 * attribute a delegate() call to the live Codex session that made it, when
 * Codex hasn't set TYCOON_CODEX_THREAD_ID in the MCP server's env. Scans the
 * NEWEST_THREAD_SCAN_LIMIT newest rollout files under CODEX_HOME/sessions
 * (bounded — never a full-tree unbounded scan) and returns the first
 * matching thread's id, or null when CODEX_HOME/cwd can't be resolved or no
 * rollout matches. Fail-open: never throws.
 */
function findNewestUserThreadForCwd(cwd, env = process.env) {
  try {
    if (!cwd) return null;
    const home = resolveCodexHome(env);
    if (!home) return null;
    const sessionsDir = path.join(home, "sessions");
    const targetCwd = normalizePathForCompare(cwd);
    if (!targetCwd) return null;
    const files = listRolloutFilesNewestFirst(sessionsDir, NEWEST_THREAD_SCAN_LIMIT);
    for (const f of files) {
      const meta = readSessionMeta(f.full);
      if (!meta) continue;
      if (meta.thread_source && meta.thread_source !== "user") continue;
      const metaCwd = normalizePathForCompare(meta.cwd);
      if (metaCwd && metaCwd === targetCwd) {
        if (meta.id) return meta.id;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * True when a Codex thread was started by a TycoonAgents bridge (the app-server
 * shim or the mcp-server launcher) on behalf of a Claude-side delegate call, as
 * opposed to a genuine Codex-host session. Its time/tokens are already counted
 * on the delegating agent (e.g. codex-reviewer), so recording the thread again
 * as a codex "orchestrator"/"codex-agent" double counts. Signals: rollout
 * session_meta.originator "tycoon-*" (the app-server shim sets clientInfo.name
 * "tycoon-codex-app-server-shim", which Codex records as originator), or the
 * TYCOON_CODEX_BRIDGE=1 env marker the bridges set on the Codex child.
 */
function isTycoonBridgeThread(sessionMeta, env = process.env) {
  // A codex exec child the dispatcher started for a specialist (it sets TYCOON_BRIDGE_CHILD=1 on that child only).
  if (env && env.TYCOON_BRIDGE_CHILD === "1") return true;
  // The rollout originator is authoritative when readable: a genuine host
  // thread stays tracked even if the env marker leaked into this process.
  const o = sessionMeta && typeof sessionMeta.originator === "string" ? sessionMeta.originator.trim() : "";
  if (o) return o.toLowerCase().startsWith("tycoon-");
  return !!(env && env.TYCOON_CODEX_BRIDGE === "1");
}

/**
 * Walks UP from startDir to the nearest ancestor (inclusive) containing
 * `.claude/tycoon/` - the marker that TycoonAgents is installed there.
 * Returns that ancestor or null. Never throws, never creates anything.
 */
function findTycoonProjectRoot(startDir) {
  try {
    if (!startDir || typeof startDir !== "string") return null;
    let dir = path.resolve(startDir);
    for (;;) {
      try {
        if (fs.statSync(path.join(dir, ".claude", "tycoon")).isDirectory()) return dir;
      } catch {
        /* not here, keep walking */
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

/**
 * Project-root discovery for the machine-wide Codex notify hook:
 * CLAUDE_PROJECT_DIR env (override-first), else the first candidate start dir
 * (caller passes payload cwd, rollout session_meta cwd, process.cwd() in
 * order) whose walk-up finds `.claude/tycoon/`. Returns null when nothing
 * is found (caller must no-op, never write).
 */
function resolveProjectRoot(candidateDirs, env = process.env) {
  const override = env && env.CLAUDE_PROJECT_DIR;
  if (override && override.trim()) return override.trim();
  for (const c of candidateDirs || []) {
    const found = findTycoonProjectRoot(c);
    if (found) return found;
  }
  return null;
}

const DELEGATE_CALL_WINDOW_MS = 2 * 60 * 1000;
const DELEGATE_FILE_MAX_AGE_MS = 10 * 60 * 1000;
const DELEGATE_MATCH_MAX_FILES = 20;
const DELEGATE_MATCH_TAIL_BYTES = 256 * 1024;

/** Reads at most the last maxBytes of a file as utf8 (drops a possibly-partial first line). */
function readTail(filePath, maxBytes) {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Candidate rollout files for a delegate-call match: only today's and
 * yesterday's sessions/YYYY/MM/DD directories (local and UTC dates, since the
 * directory date convention is not guaranteed), modified in the last 10
 * minutes, newest-modified first, capped at 20. Computed once per delegate
 * call and reused across retries. Fail-open: [] on any error.
 */
function listCandidateRollouts(env = process.env, now = Date.now()) {
  try {
    const home = resolveCodexHome(env);
    if (!home) return [];
    const dirs = new Set();
    for (const offset of [0, 1]) {
      const d = new Date(now - offset * 86400000);
      dirs.add(path.join(home, "sessions", String(d.getFullYear()), pad2(d.getMonth() + 1), pad2(d.getDate())));
      dirs.add(path.join(home, "sessions", String(d.getUTCFullYear()), pad2(d.getUTCMonth() + 1), pad2(d.getUTCDate())));
    }
    const out = [];
    for (const dir of dirs) {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
        const full = path.join(dir, name);
        try {
          const mtime = fs.statSync(full).mtimeMs;
          if (now - mtime <= DELEGATE_FILE_MAX_AGE_MS) out.push({ full, mtime });
        } catch {
          /* skip */
        }
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, DELEGATE_MATCH_MAX_FILES);
  } catch {
    return [];
  }
}

/** Escapes non-ASCII as \uXXXX (what a JS/JSON producer may emit). */
function escapeNonAscii(str) {
  return str.replace(/[^\x00-\x7f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Source forms in which a JS exec call may embed `task` as a string literal body. */
function taskSourceForms(task) {
  const dq = JSON.stringify(task).slice(1, -1);
  const sq = task
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return [dq, escapeNonAscii(dq), sq, escapeNonAscii(sq), task];
}

/**
 * True when a rollout response_item payload is a call of the tycoon delegate
 * tool carrying `task`. Two observed shapes (Codex 0.162, rollout-*.jsonl):
 *  - {type:"custom_tool_call", name:"exec", input:"<JS source>"} where the JS
 *    contains `tools.mcp__tycoon__delegate({specialist:"..",task:".."})`;
 *  - {type:"function_call", name:"mcp__tycoon__delegate", arguments:"<JSON>"}.
 */
function payloadIsDelegateCallWithTask(payload, task) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.type === "function_call") {
    if (!/delegate/.test(String(payload.name || ""))) return false;
    try {
      const a = JSON.parse(payload.arguments);
      return !!a && a.task === task;
    } catch {
      return false;
    }
  }
  if (payload.type === "custom_tool_call") {
    const src = typeof payload.input === "string" ? payload.input : "";
    if (!/mcp__tycoon__delegate/.test(src)) return false;
    return taskSourceForms(task).some((f) => f && src.includes(f));
  }
  return false;
}

/** True when a rollout response_item payload is any call of the tycoon delegate tool. */
function payloadIsAnyDelegateCall(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.type === "function_call") return /delegate/.test(String(payload.name || ""));
  if (payload.type === "custom_tool_call") return typeof payload.input === "string" && /mcp__tycoon__delegate/.test(payload.input);
  return false;
}

/** Delegate-call lines in a rollout's tail: [{ ts (ms from the line's own timestamp), payload }]. */
function readDelegateCalls(filePath) {
  const calls = [];
  let text;
  try {
    text = readTail(filePath, DELEGATE_MATCH_TAIL_BYTES);
  } catch {
    return calls;
  }
  for (const line of text.split("\n")) {
    if (!line.includes("delegate")) continue;
    try {
      const item = JSON.parse(line);
      if (!item || item.type !== "response_item" || !payloadIsAnyDelegateCall(item.payload)) continue;
      const ts = Date.parse(item.timestamp);
      if (Number.isFinite(ts)) calls.push({ ts, payload: item.payload });
    } catch {
      /* skip bad line */
    }
  }
  return calls;
}

/**
 * Finds the live Codex thread that issued a tycoon delegate call: among the
 * candidate rollouts, the delegate call line carrying this `task` with the
 * newest line timestamp (not file mtime), and only if that timestamp is within
 * the last ~2 minutes. Returns { threadId, cwd, filePath } (id and cwd from the
 * first-line session_meta) or null. Fail-open, never throws.
 */
function findThreadForDelegateCall(task, env = process.env, now = Date.now(), candidates) {
  try {
    if (typeof task !== "string" || !task) return null;
    const files = candidates || listCandidateRollouts(env, now);
    let best = null;
    for (const f of files) {
      for (const c of readDelegateCalls(f.full)) {
        if (now - c.ts > DELEGATE_CALL_WINDOW_MS || c.ts - now > DELEGATE_CALL_WINDOW_MS) continue;
        if (!payloadIsDelegateCallWithTask(c.payload, task)) continue;
        if (!best || c.ts > best.ts) best = { ts: c.ts, full: f.full };
      }
    }
    if (!best) return null;
    const meta = readSessionMeta(best.full);
    if (!meta || !meta.id) return null;
    return { threadId: meta.id, cwd: typeof meta.cwd === "string" ? meta.cwd : undefined, filePath: best.full };
  } catch {
    return null;
  }
}

/**
 * Fallback when no rollout contains the call's literal task (e.g. built
 * dynamically in code-mode JS): rollouts holding a tycoon delegate call whose
 * line timestamp is within ~2 minutes and whose session_meta.cwd walks up to a
 * .claude/tycoon/ marker. If those belong to MORE THAN ONE project the caller
 * cannot be told apart, so this returns null rather than guess; within one
 * project the newest call wins. Returns { threadId, cwd, filePath } or null.
 */
function findRecentDelegateThread(env = process.env, now = Date.now(), candidates) {
  try {
    const files = candidates || listCandidateRollouts(env, now);
    const qualifying = [];
    for (const f of files) {
      let newest = -Infinity;
      for (const c of readDelegateCalls(f.full)) {
        if (now - c.ts <= DELEGATE_CALL_WINDOW_MS && c.ts - now <= DELEGATE_CALL_WINDOW_MS && c.ts > newest) newest = c.ts;
      }
      if (newest === -Infinity) continue;
      const meta = readSessionMeta(f.full);
      if (!meta || !meta.id || typeof meta.cwd !== "string") continue;
      const root = findTycoonProjectRoot(meta.cwd);
      if (!root) continue;
      qualifying.push({ ts: newest, root, threadId: meta.id, cwd: meta.cwd, filePath: f.full });
    }
    if (!qualifying.length) return null;
    const roots = new Set(qualifying.map((q) => normalizePathForCompare(q.root)));
    if (roots.size > 1) return null; // concurrent sessions in different projects: ambiguous
    qualifying.sort((a, b) => b.ts - a.ts);
    const q = qualifying[0];
    return { threadId: q.threadId, cwd: q.cwd, filePath: q.filePath };
  } catch {
    return null;
  }
}

module.exports = {
  normalizePathForCompare,
  listCandidateRollouts,
  findThreadForDelegateCall,
  findRecentDelegateThread,
  findTycoonProjectRoot,
  resolveProjectRoot,
  isTycoonBridgeThread,
  resolveCodexHome,
  findRolloutFile,
  readSessionMeta,
  resolveSessionMeta,
  workerIdFromAgentPath,
  resolveWorkerId,
  findNewestUserThreadForCwd,
};
