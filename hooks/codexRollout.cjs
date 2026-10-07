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

/**
 * Normalizes a filesystem path for cross-platform comparison: backslashes
 * to forward slashes, lowercased on win32 (case-insensitive filesystem),
 * trailing slash stripped. Used to match a rollout's recorded `cwd` against
 * TYCOON_PROJECT_DIR without false negatives from slash/case differences.
 */
function normalizePathForCompare(p) {
  if (!p || typeof p !== "string") return "";
  let s = p.replace(/\\/g, "/");
  if (process.platform === "win32") s = s.toLowerCase();
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
  // The rollout originator is authoritative when readable: a genuine host
  // thread stays tracked even if the env marker leaked into this process.
  const o = sessionMeta && typeof sessionMeta.originator === "string" ? sessionMeta.originator.trim() : "";
  if (o) return o.toLowerCase().startsWith("tycoon-");
  return !!(env && env.TYCOON_CODEX_BRIDGE === "1");
}

module.exports = {
  isTycoonBridgeThread,
  resolveCodexHome,
  findRolloutFile,
  readSessionMeta,
  resolveSessionMeta,
  workerIdFromAgentPath,
  resolveWorkerId,
  findNewestUserThreadForCwd,
};
