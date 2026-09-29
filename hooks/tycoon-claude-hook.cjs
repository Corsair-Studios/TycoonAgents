/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Per-spawn instance identifier, generated at push time (independent of
// Claude Code's own payload.agent_id, which is only bound to a stack entry
// lazily on that instance's first non-spawn tool call — see
// resolveAgainstStack's doc comment). Lets the panel tell two concurrent
// spawns of the same agentId apart from the moment the Task tool fires,
// without waiting on that later bind. Falls back to a counter-based id if
// crypto.randomUUID is unavailable (older Node).
let spawnIdCounter = 0;
function generateSpawnId() {
  try {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* fall through to counter fallback */ }
  spawnIdCounter += 1;
  return "spawn-" + Date.now() + "-" + spawnIdCounter;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Fallback project-root resolver used only when CLAUDE_PROJECT_DIR is unset
 * (Claude Code normally sets it in the hook's environment, but a foreign
 * runner or a stripped-down env might not). Walks up from this script's own
 * location looking for a `.claude/tycoon/` directory containing this file,
 * so it is correct regardless of how deep the installed copy sits (today:
 * `<root>/.claude/tycoon/tycoon-claude-hook.cjs`, two levels down — a fixed
 * `path.resolve(__dirname, "..")` would land one level short, at `.claude`
 * instead of the project root). Falls back to `path.resolve(__dirname, "..", "..")`
 * (today's actual installed depth) if no `.claude/tycoon` marker is found
 * within a bounded number of hops, so a still-unexpected layout never turns
 * into an infinite/unbounded upward walk.
 * @returns {string}
 */
function findProjectRootFallback() {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const marker = path.join(dir, ".claude", "tycoon");
    try {
      if (fs.existsSync(marker) && fs.statSync(marker).isDirectory()) return dir;
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return path.resolve(__dirname, "..", "..");
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(stripBom(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function atomicWriteSync(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, data, "utf8");
  for (let i = 0; i < 3; i++) {
    try {
      if (process.platform === "win32" && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      fs.renameSync(tmp, filePath);
      return;
    } catch {
      if (i === 2) {
        fs.writeFileSync(filePath, data, "utf8");
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        return;
      }
      // brief spin before retry
      const end = Date.now() + 50;
      while (Date.now() < end) { /* busy wait */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Gate events (plan p29-t2): surface unseen plan-gate approvals/rejections
// from <tycoonDir>/gate-events.jsonl to the orchestrator via additionalContext.
// Purely additive/read-only w.r.t. that file - the host side (panel/standalone)
// owns writing gate-events.jsonl; this hook only reads it and tracks a byte
// offset cursor so each event is surfaced exactly once.
// ---------------------------------------------------------------------------

/**
 * Read gate events appended to gate-events.jsonl since the last recorded
 * cursor, then advance the cursor to the file's current size. Malformed
 * lines are skipped. A missing cursor file is treated as offset 0. If the
 * events file has shrunk below the stored cursor (rotated/truncated), the
 * cursor resets to 0 so events are re-read from the start rather than
 * silently skipped.
 * @param {string} tycoonDir
 * @returns {Array<Record<string, unknown>>}
 */
function readUnseenGateEvents(tycoonDir) {
  const eventsPath = path.join(tycoonDir, "gate-events.jsonl");
  const cursorPath = path.join(tycoonDir, "gate-events.cursor");

  let size;
  try {
    size = fs.statSync(eventsPath).size;
  } catch {
    return []; // no events file yet
  }

  let cursor = 0;
  try {
    const raw = fs.readFileSync(cursorPath, "utf8").trim();
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) cursor = parsed;
  } catch { /* missing cursor = 0 */ }

  if (cursor > size) cursor = 0; // file shrank below cursor: reset

  if (cursor >= size) return []; // nothing new

  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  try {
    const fd = fs.openSync(eventsPath, "r");
    try {
      const len = size - cursor;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, cursor);
      const chunk = buf.toString("utf8");
      const lines = chunk.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsedLine = JSON.parse(trimmed);
          if (parsedLine && typeof parsedLine === "object") events.push(parsedLine);
        } catch { /* skip malformed line */ }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return []; // read failed: fail open, no events surfaced this call
  }

  try {
    atomicWriteSync(cursorPath, String(size));
  } catch { /* best-effort: a failed cursor write may re-surface events next call */ }

  return events;
}

/**
 * Format one gate event into a single line of additionalContext text.
 * Falls back gracefully when optional fields are missing.
 * @param {Record<string, unknown>} evt
 * @returns {string}
 */
/**
 * Collapse newlines/tabs to single spaces, strip other control chars, trim,
 * and cap to maxLen (appending an ellipsis when truncated). Keeps a single
 * untrusted field from breaking the one-line-per-event additionalContext
 * format or growing it unboundedly.
 * @param {unknown} value
 * @param {number} maxLen
 * @returns {string}
 */
function sanitizeGateText(value, maxLen) {
  if (typeof value !== "string" || !value) return "";
  // eslint-disable-next-line no-control-regex
  let s = value.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}

function formatGateEventLine(evt) {
  const gate = typeof evt.gate === "string" ? evt.gate : "pending";
  const phaseNumRaw = evt.phaseNum;
  const phaseNum = typeof phaseNumRaw === "number" && Number.isFinite(phaseNumRaw) ? phaseNumRaw : null;
  const rawName = typeof evt.name === "string" && evt.name ? evt.name : (typeof evt.phaseId === "string" ? evt.phaseId : "unknown");
  const name = sanitizeGateText(rawName, 120) || "unknown";
  const phaseId = sanitizeGateText(evt.phaseId, 32);
  const ts = typeof evt.ts === "string" ? evt.ts : "";
  const source = typeof evt.source === "string" ? evt.source : "unknown";
  const phaseLabel = phaseNum !== null ? `phase ${phaseNum}` : (phaseId ? `phase ${phaseId}` : "phase ?");
  return `Plan gate update: ${phaseLabel} ${name} ${gate}${ts ? ` at ${ts}` : ""} (${source}).`;
}

/**
 * Build the merged additionalContext string for a set of gate events, plus
 * any existing additionalContext text the handler already produced. Returns
 * null when there is nothing to add (no events and no existing text).
 * @param {Array<Record<string, unknown>>} events
 * @param {string} [existing]
 * @returns {string|null}
 */
function mergeGateEventContext(events, existing) {
  if (!events || events.length === 0) return existing || null;
  const lines = events.map(formatGateEventLine).join("\n");
  if (existing) return existing + "\n" + lines;
  return lines;
}

// A lock file older than this is assumed to belong to a crashed or foreign
// process (every hook invocation finishes in well under this window) and is
// safe to steal rather than let the active-agent stack freeze forever.
const LOCK_STALE_MS = 30000;

function acquireLock(lockPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code === "EEXIST") {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lockPath); continue; }
        } catch { /* stale check failed (lock vanished mid-check, etc.) - keep waiting */ }
        const end = Date.now() + 10;
        while (Date.now() < end) { /* spin */ }
      } else {
        return false;
      }
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Model defaults (sourced from CLAUDE.md model assignments). Telemetry labels
// only, and bare aliases on purpose: the same value an agent .md with
// `model: sonnet` yields, so a default never pins a version.
// ---------------------------------------------------------------------------
const MODEL_DEFAULTS = {
  "orchestrator":      "opus",
  "search-retrieval":  "haiku",
  "primary-agent":     "sonnet",
  "coding-specialist": "sonnet",
  "testing-specialist":"sonnet",
  "vscode-integration":"sonnet",
  "ux-ui-designer":    "sonnet",
  "workspace-monitor": "sonnet",
};

// SHORTHAND_MODEL is telemetry-only: resolveModel() applies it to the value
// read from an agent .md's `model:` frontmatter (or an explicit Task model),
// and the result is only ever written to activity.jsonl / the active-agent
// stack. There is NO live API call, so the bare aliases opus/sonnet/haiku are
// safe here and stay consistent with what the Settings GUI now writes. Fable
// keeps its canonical id (no auto-latest alias exists).
//
// This is a LEGACY fallback copy of src/core/modelAliases.ts's MODEL_ALIASES,
// kept because the hook is a standalone zero-dep .cjs that must run even
// when the compiled module below isn't available next to it (dev checkout
// that hasn't built out/, or a packaged install missing it for any reason).
// When the installer (src/host/vscode/panel.ts) has copied the compiled
// modelAliases.js alongside this hook, that copy is used instead — see
// agentBackendModule / getShorthandModel below (p2-t2).
const SHORTHAND_MODEL = {
  "opus":   "opus",
  "sonnet": "sonnet",
  "haiku":  "haiku",
  "fable":  "claude-fable-5-1", // must equal LATEST_MODEL_IDS.fable (asserted by test/modelAliasesLatest.test.ts)
};

// ---------------------------------------------------------------------------
// Backend-aware generic routing (p2-t2). The installer copies the compiled
// src/core/agentBackend.js and modelAliases.js next to this hook (into
// <project>/.claude/tycoon/) so it can parse any agent's `backend:`
// frontmatter instead of hardcoding the Codex MCP special case. Loaded once,
// lazily, and guarded: if either module is missing (unbuilt out/, or an old
// installer that hasn't copied them yet), we log one warning to stderr and
// every caller below falls back to legacy behavior (the literal
// mcp__codex__ special case and the local SHORTHAND_MODEL table).
// ---------------------------------------------------------------------------
let _agentBackendModule; // undefined = not yet attempted, null = load failed
function getAgentBackendModule() {
  if (_agentBackendModule === undefined) {
    try {
      _agentBackendModule = require(path.join(__dirname, "agentBackend.js"));
    } catch (err) {
      _agentBackendModule = null;
      try {
        process.stderr.write(
          "[tycoon-hook] agentBackend.js not available next to the hook — falling back to legacy Codex-only routing: " +
            (err && err.message ? err.message : String(err)) +
            "\n"
        );
      } catch { /* never let a warning break the hook */ }
    }
  }
  return _agentBackendModule;
}

let _modelAliasesModule; // undefined = not yet attempted, null = load failed
function getModelAliasesModule() {
  if (_modelAliasesModule === undefined) {
    try {
      _modelAliasesModule = require(path.join(__dirname, "modelAliases.js"));
    } catch {
      _modelAliasesModule = null; // silent: getAgentBackendModule already warns once
    }
  }
  return _modelAliasesModule;
}

// Plan p15-t1: fallback-chain resolver, shared with hooks/tycoon-opencode-
// plugin.ts (src/core/fallbackChain.ts, compiled + copied next to this hook
// by scripts/copy-hook-runtime.mjs, same lazy/guarded pattern as
// agentBackend.js above). Missing means fallback dispatch is simply
// disabled — every non-failure code path elsewhere in this hook is
// unaffected.
let _fallbackChainModule; // undefined = not yet attempted, null = load failed
function getFallbackChainModule() {
  if (_fallbackChainModule === undefined) {
    try {
      _fallbackChainModule = require(path.join(__dirname, "fallbackChain.js"));
    } catch {
      _fallbackChainModule = null; // silent: absence just disables fallback dispatch
    }
  }
  return _fallbackChainModule;
}

// p69-t2 (docs/codex-reviewer-onboarding-friction-2026-09-18.md #5, #8):
// Codex's own model-slug rejection ("The 'codex-astra' model is not
// supported when using Codex with a ChatGPT account.") is a distinct
// provider-failure shape the shared fallbackChain.isProviderFailure()
// patterns don't cover (it isn't a quota/auth/connection failure — the
// binary and account are fine, the caller just guessed a display name
// instead of the real slug). Recognised here, in this hook only, so a
// misconfigured Codex agent's model gets a specific, actionable hint
// instead of silently falling back with a generic reason string.
const CODEX_MODEL_SLUG_ERROR_PATTERN = /model is not supported when using codex with a chatgpt account/i;
const CODEX_MODEL_SLUG_ERROR_HINT = "Hint: run `codex debug models` to list the real model slugs available on this Codex account.";
function isCodexModelSlugError(text) {
  return typeof text === "string" && CODEX_MODEL_SLUG_ERROR_PATTERN.test(text);
}

// Per-process FallbackState. tycoon-claude-hook.cjs is a short-lived CLI
// process invoked fresh per hook event (unlike the long-lived OpenCode
// plugin process), so failure counts cannot be held in memory across calls;
// they are persisted to a small JSON sidecar under .claude/tycoon/ instead,
// keyed by session id, and reloaded/saved on each PostToolUse invocation
// that touches it. Bounded by simple size cap + oldest-eviction, mirroring
// the OpenCode plugin's in-memory Map cap.
const FALLBACK_STATE_MAX_SESSIONS = 200;
function loadFallbackStateFile(tycoonDir) {
  const file = path.join(tycoonDir, "fallback-state.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
// p69-t3: when routing.resolved.json (written by scripts/apply-routing-profile.mjs)
// has no entry for an agent — either the script was never run in this
// consumer project, or the agent was hand-added to routing.json after the
// last apply — fall back to reading .claude/tycoon/routing.json's FLAT
// per-agent entry directly instead of silently getting no fallback chain.
// routing.json's shape (RoutingSlot, src/core/routingProfile.ts) uses the
// SAME field names consumed here (model/vendor/costModelClass/fallback/
// useDefaultFallback) as routing.resolved.json's nested
// `agents[id].backend`/`fallback` shape, so no conversion is needed — see
// docs/adding-a-non-anthropic-agent.md's "Routing files" section for a
// side-by-side of both shapes. Fail-open: any missing/malformed file
// returns undefined and callers keep today's "no fallback" behavior.
function readFlatRoutingAgentEntry(tycoonDir, agentId) {
  const flat = readJsonSafe(path.join(tycoonDir, "routing.json"));
  const entry = flat && flat.agents && flat.agents[agentId];
  if (!entry || typeof entry !== "object") return undefined;
  return {
    chain: Array.isArray(entry.fallback) ? entry.fallback : [],
    defaultFallback: flat.defaultFallback,
    useDefaultFallback: entry.useDefaultFallback === false ? false : true,
  };
}

function saveFallbackStateFile(tycoonDir, data) {
  const file = path.join(tycoonDir, "fallback-state.json");
  try {
    const keys = Object.keys(data);
    while (keys.length > FALLBACK_STATE_MAX_SESSIONS) {
      delete data[keys.shift()];
    }
    fs.mkdirSync(tycoonDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), "utf8");
  } catch { /* never let persistence failure break the hook */ }
}

function getShorthandModel() {
  const mod = getModelAliasesModule();
  return (mod && mod.MODEL_ALIASES) || SHORTHAND_MODEL;
}

function resolveModel(rawModel, agentId) {
  if (rawModel) {
    const table = getShorthandModel();
    return table[rawModel.toLowerCase()] || rawModel;
  }
  return MODEL_DEFAULTS[agentId];
}

// Scan .claude/agents/*.md, parse each backend via agentBackend.js, and
// build a map keyed by "mcp__<mcpServer>__<tool>" (or, when a backend omits
// `tools`, by a marker matched via prefix "mcp__<mcpServer>__" against any
// tool on that server) -> { agentId, vendor, model, costModelClass }. Built
// fresh per hook invocation (each PreToolUse is a fresh short-lived process,
// so there is no long-lived cache to keep warm) and only when the
// agentBackend module actually loaded. Only transports 'mcp' and
// 'openai-compatible' participate — 'claude-native' backends have no MCP
// tool surface to route.
function buildMcpBackendRouting(agentsDir) {
  const mod = getAgentBackendModule();
  if (!mod) return null;
  const exact = new Map();   // "mcp__server__tool" -> entry
  const prefixes = [];       // [{ prefix: "mcp__server__", entry }]
  let files;
  try {
    files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return { exact, prefixes };
  }
  for (const file of files) {
    const agentId = file.slice(0, -3);
    let text;
    try {
      text = fs.readFileSync(path.join(agentsDir, file), "utf8");
    } catch {
      continue;
    }
    let backend;
    try {
      const frontmatter = mod.readAgentFrontmatter(text);
      backend = mod.parseAgentBackend(frontmatter);
    } catch {
      continue; // malformed backend block — skip this agent, don't crash the hook
    }
    if (!backend || (backend.transport !== "mcp" && backend.transport !== "openai-compatible")) continue;
    if (!backend.mcpServer) continue;
    const entry = {
      agentId,
      vendor: backend.vendor,
      model: backend.model,
      costModelClass: backend.costModelClass,
    };
    const serverPrefix = "mcp__" + backend.mcpServer + "__";
    if (Array.isArray(backend.tools) && backend.tools.length > 0) {
      for (const tool of backend.tools) {
        exact.set(serverPrefix + tool, entry);
      }
    } else {
      prefixes.push({ prefix: serverPrefix, entry });
    }
  }
  return { exact, prefixes };
}

// p_bugfix: lightweight, zero-dependency scan for an mcpServer's
// backend.model directly out of .claude/agents/*.md frontmatter, used ONLY
// by the legacy mcp__codex__ fallback below when agentBackend.js isn't
// available next to the hook (so buildMcpBackendRouting/lookupMcpBackend
// above never ran). Mirrors the subset of YAML readAgentFrontmatter parses
// (flat backend.<key>: value lines under an indented `backend:` block) but
// without requiring the compiled module, so the correct model still shows
// up even in an unbuilt/uninstalled checkout. Returns the raw model string
// verbatim (e.g. "openai/gpt-5") — same convention as the compiled path,
// which does not strip the vendor prefix either (see test (b) in
// test/hookBackendRouting.test.ts).
function findBackendModelForMcpServer(agentsDir, mcpServer) {
  let files;
  try {
    files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return undefined;
  }
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(agentsDir, file), "utf8");
    } catch {
      continue;
    }
    const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    const fmMatch = normalized.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const backendMatch = fmMatch[1].match(/^backend:\s*\n((?:[ \t]+\S.*\n?)*)/m);
    if (!backendMatch) continue;
    const block = backendMatch[1];
    const serverMatch = block.match(/^\s*mcpServer:\s*(\S+)\s*$/m);
    const server = serverMatch ? serverMatch[1].replace(/^["']|["']$/g, "") : undefined;
    if (server !== mcpServer) continue;
    const modelMatch = block.match(/^\s*model:\s*(\S+)\s*$/m);
    if (modelMatch) return modelMatch[1].replace(/^["']|["']$/g, "");
  }
  return undefined;
}

// Second fallback tier: routing.resolved.json's agents[agentId].backend.model
// (written by scripts/apply-routing-profile.mjs), tried when no agent .md
// file could be scanned/matched directly. agentId here is the agent whose
// backend declares this mcpServer, if any is known via findBackendModelForMcpServer's
// caller; when the caller doesn't know which agentId to look up it scans every
// entry in resolvedRouting.agents for one whose backend.mcpServer matches.
function findResolvedRoutingModelForMcpServer(tycoonDir, mcpServer) {
  const resolved = readJsonSafe(path.join(tycoonDir, "routing.resolved.json"));
  const agents = resolved && resolved.agents;
  if (!agents || typeof agents !== "object") return undefined;
  for (const agentId of Object.keys(agents)) {
    const entry = agents[agentId];
    const backend = entry && entry.backend;
    if (backend && backend.mcpServer === mcpServer && typeof backend.model === "string" && backend.model) {
      return backend.model;
    }
  }
  return undefined;
}

function lookupMcpBackend(routing, toolName) {
  if (!routing) return undefined;
  const hit = routing.exact.get(toolName);
  if (hit) return hit;
  for (const { prefix, entry } of routing.prefixes) {
    if (toolName.indexOf(prefix) === 0) return entry;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Agent description from frontmatter
// ---------------------------------------------------------------------------
function readAgentDescription(agentsDir, agentId) {
  try {
    const mdPath = path.join(agentsDir, agentId + ".md");
    if (!fs.existsSync(mdPath)) return undefined;
    const content = fs.readFileSync(mdPath, "utf8");
    // Extract description from YAML frontmatter between --- markers
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return undefined;
    const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
    return descMatch ? descMatch[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Agent model from frontmatter (source of truth edited by the Settings GUI)
// ---------------------------------------------------------------------------
function readAgentModel(agentsDir, agentId) {
  try {
    const mdPath = path.join(agentsDir, agentId + ".md");
    if (!fs.existsSync(mdPath)) return undefined;
    const content = fs.readFileSync(mdPath, "utf8");
    // Extract model from YAML frontmatter between --- markers
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return undefined;
    const modelMatch = fmMatch[1].match(/^model:\s*(.+)$/m);
    return modelMatch ? modelMatch[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Agent tier from frontmatter (e.g. `tier: lead`) — used by the metrics panel
// to identify team-lead rows and roll worker totals up under them.
// ---------------------------------------------------------------------------
function readAgentTier(agentsDir, agentId) {
  try {
    const mdPath = path.join(agentsDir, agentId + ".md");
    if (!fs.existsSync(mdPath)) return undefined;
    const content = fs.readFileSync(mdPath, "utf8");
    // Extract tier from YAML frontmatter between --- markers
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return undefined;
    const tierMatch = fmMatch[1].match(/^tier:\s*(.+)$/m);
    return tierMatch ? tierMatch[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Delegation mode (Team Lead Mode Phase 4: measurement) — read from
// .claude/tycoon/execution.json and cached for the lifetime of this process
// (one hook invocation = one event; re-reading per call inside that single
// invocation would be wasted I/O). Defensive: a missing file, missing dir,
// or invalid/unrecognized JSON all fall back to "flat" — never throws.
// Historical records keep whatever mode was cached when THEY were written;
// toggling the mode later does not retroactively change past records.
// ---------------------------------------------------------------------------
let cachedDelegationMode; // undefined until first read this process
function readDelegationMode(tycoonDir) {
  if (cachedDelegationMode !== undefined) return cachedDelegationMode;
  let mode = "flat";
  try {
    const parsed = readJsonSafe(path.join(tycoonDir, "execution.json"));
    if (parsed && (parsed.delegation_mode === "flat" || parsed.delegation_mode === "team_leads")) {
      mode = parsed.delegation_mode;
    }
  } catch {
    mode = "flat";
  }
  cachedDelegationMode = mode;
  return mode;
}

// ---------------------------------------------------------------------------
// Session journal entry cap (Session Journal feature, off by default) — read
// from .claude/tycoon/execution.json and cached for the lifetime of this
// process, same shape as readDelegationMode above (one hook invocation = one
// event; re-reading per call inside that single invocation is wasted I/O).
// Valid values are integers 0-5; anything missing, non-numeric, out of
// range, or unparseable defaults to 0 (feature off) so existing installs see
// zero behavior change until the setting is explicitly turned on.
// ---------------------------------------------------------------------------
let cachedSessionJournalEntries; // undefined until first read this process
function readSessionJournalEntries(tycoonDir) {
  if (cachedSessionJournalEntries !== undefined) return cachedSessionJournalEntries;
  let n = 0;
  try {
    const parsed = readJsonSafe(path.join(tycoonDir, "execution.json"));
    const v = parsed && parsed.sessionJournalEntries;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5) {
      n = v;
    }
  } catch {
    n = 0;
  }
  cachedSessionJournalEntries = n;
  return n;
}

// ---------------------------------------------------------------------------
// Session journal writer — appends the submitted prompt to
// <projectRoot>/.claude/session-journal.json, trimmed to the last N entries
// (N = readSessionJournalEntries, 0 = caller never invokes this). Only
// called when N > 0 (see the UserPromptSubmit handler below).
//
// Robustness: readJsonSafe strips a BOM and returns null on bad JSON (this
// project has a documented history of PowerShell Out-File BOMs and other
// corruption breaking JSON state files), so a missing/unreadable/malformed
// file starts a fresh structure rather than throwing. Unknown top-level keys
// on an existing, parseable file are preserved via a shallow merge, the same
// pattern writeExecutionConfig() uses in delegationDoctrine.ts. The write
// itself goes through atomicWriteSync (temp file + rename) so a crash
// mid-write cannot leave invalid JSON on disk. Every failure mode is
// swallowed — a broken journal must never break the hook.
// ---------------------------------------------------------------------------
function appendSessionJournalEntry(projectRoot, promptText, maxEntries, at) {
  try {
    const journalPath = path.join(projectRoot, ".claude", "session-journal.json");
    const existing = readJsonSafe(journalPath);
    const base = (existing && typeof existing === "object" && !Array.isArray(existing)) ? existing : {};
    const entries = Array.isArray(base.entries) ? base.entries.slice() : [];

    // Prompts routinely contain pasted secrets and absolute paths, and this
    // file can end up committed to a user's repo — truncate hard before it
    // ever touches disk.
    const MAX_PROMPT_CHARS = 300;
    const safePrompt = typeof promptText === "string" ? promptText : "";
    const truncatedPrompt = safePrompt.length > MAX_PROMPT_CHARS
      ? safePrompt.slice(0, MAX_PROMPT_CHARS) + "..."
      : safePrompt;

    // summary is always null on append; the assistant fills it in later per
    // CLAUDE.md's Session Journal section. An existing entry's summary is
    // never touched here — this only ever pushes a brand-new entry.
    entries.push({ timestamp: new Date(at).toISOString(), prompt: truncatedPrompt, summary: null });

    // Trim to the last N; also re-trims older overflow if maxEntries shrank
    // since the last write.
    const trimmed = maxEntries > 0 ? entries.slice(Math.max(0, entries.length - maxEntries)) : [];

    const merged = Object.assign({}, base, { maxEntries, entries: trimmed });
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    atomicWriteSync(journalPath, JSON.stringify(merged, null, 2));
  } catch {
    // Best-effort: a corrupted or unwritable journal must never break the hook.
  }
}

// ---------------------------------------------------------------------------
// Keyword-based agent matching
// ---------------------------------------------------------------------------
// Word-set builder shared by both call shapes below.
function wordSetOf(text) {
  return new Set(
    String(text || "").toLowerCase().replace(/[^a-z0-9]/g, " ").split(/\s+/).filter(Boolean)
  );
}

// Backward-compatible single-text form (used by transcript-keyword matching
// in popMatchedAgent, where there is no description/prompt split) plus a
// weighted two-part form used by Task attribution: `searchTextOrDescription`
// is scored as the DESCRIPTION when `promptText` is also supplied, with each
// description match worth far more than a prompt match (WEIGHT below) so a
// prompt body that happens to contain another agent's keyword (e.g. "Ready
// test rerun" containing "test") cannot outscore a description that actually
// names the right agent's own domain. Prompt matches only add up when the
// description alone doesn't already decide it, i.e. they can break ties
// among descriptions with equal (including zero) description-side score, but
// can never overturn a description match by themselves.
const DESCRIPTION_WEIGHT = 1000;
function matchAgentFromKeywords(searchTextOrDescription, keywordsConfig, promptText) {
  if (!keywordsConfig || !keywordsConfig.agents) return null;
  const hasSplit = typeof promptText === "string";
  const descWords = wordSetOf(searchTextOrDescription);
  const promptWords = hasSplit ? wordSetOf(promptText) : null;

  let bestAgent = null, bestScore = 0, bestKeyword = "";
  for (const [agentId, cfg] of Object.entries(keywordsConfig.agents)) {
    if (!cfg.pattern) continue;
    let descScore = 0, promptScore = 0, firstMatch = "";
    for (const kw of cfg.pattern.split("|")) {
      const norm = kw.toLowerCase().trim();
      if (!norm) continue;
      if (descWords.has(norm)) {
        descScore++;
        if (!firstMatch) firstMatch = kw;
      } else if (hasSplit && promptWords.has(norm)) {
        promptScore++;
        if (!firstMatch) firstMatch = kw;
      }
    }
    const score = hasSplit ? (descScore * DESCRIPTION_WEIGHT + promptScore) : descScore;
    if (score > bestScore) { bestScore = score; bestAgent = agentId; bestKeyword = firstMatch; }
  }
  return bestScore > 0 ? { agentId: bestAgent, matchedKeyword: bestKeyword } : null;
}

// ---------------------------------------------------------------------------
// Active-agent stack: push on spawn, pop on SubagentStop
// ---------------------------------------------------------------------------
function pushActiveAgent(activeAgentFile, entry) {
  const lockPath = activeAgentFile + ".lock";
  if (!acquireLock(lockPath, 5000)) return;
  try {
    const existing = readJsonSafe(activeAgentFile) || { version: 1, agentId: "none", timestamp: 0, stack: [] };
    const stack = Array.isArray(existing.stack) ? existing.stack : [];
    stack.push(entry);
    atomicWriteSync(activeAgentFile, JSON.stringify({ version: 1, agentId: entry.agentId, timestamp: entry.timestamp, stack }, null, 2));
  } finally {
    releaseLock(lockPath);
  }
}

// Read the first user-message text from a sub-agent transcript, used to
// disambiguate parallel agents that share the same subagent_type.
function firstUserTextFromTranscript(transcriptPath) {
  try {
    if (!transcriptPath || typeof transcriptPath !== "string") return "";
    const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.role === "user" || (msg.message && msg.message.role === "user")) {
          const msgObj = msg.message || msg;
          const content = msgObj.content;
          if (typeof content === "string") return content;
          if (Array.isArray(content)) {
            return content
              .map((c) => (typeof c === "string" ? c : (c.text || "")))
              .join(" ");
          }
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* transcript not accessible */ }
  return "";
}

// Hard cap on the captured worker report (p21-t8: tightened from 2000 to 600
// — the delegation doctrine caps worker reports at ~250 words, and
// activity.jsonl growth (62k+ records already) is bounded far tighter at 600
// chars against a worker that ignores the cap or a transcript with an
// unusually long final message). The panel/standalone UI reads `report`
// straight off this persisted record (see src/providers/claude-code/
// mapHookRecord.ts and src/core/state.ts's lastReport) — there is no
// separate transient full-text path, so this cap IS what the UI shows.
// `reportChars` preserves the original (pre-truncation) length so the UI/
// diagnostics can tell a genuinely short report from a truncated one.
const REPORT_MAX_CHARS = 600;

// Cut `text` to at most REPORT_MAX_CHARS UTF-16 code units, backing off one
// more position if that would split a surrogate pair (a UTF-8-safe/
// codepoint-safe boundary), then appends " …[truncated N chars]" where N is
// the number of chars removed. Returns { text, reportChars } where
// reportChars is always the ORIGINAL (pre-truncation) length so callers can
// distinguish "short report" from "truncated report" even after the text is
// cut.
const TRUNCATION_PREFIX = " …[truncated ";
const TRUNCATION_SUFFIX = " chars]";

function capReportText(text) {
  const reportChars = text.length;
  if (reportChars <= REPORT_MAX_CHARS) return { text, reportChars };
  // Reserve room for the marker BEFORE cutting, so the final stored string
  // (truncated text + marker) never exceeds REPORT_MAX_CHARS. `removed`
  // (reportChars - cut) is always < reportChars, so reportChars's own digit
  // count is a safe upper bound on the marker's digit count regardless of
  // exactly where `cut` lands.
  const maxRemovedDigits = String(reportChars).length;
  const reservedSuffixLen = TRUNCATION_PREFIX.length + maxRemovedDigits + TRUNCATION_SUFFIX.length;
  let cut = Math.max(0, REPORT_MAX_CHARS - reservedSuffixLen);
  // Back off if `cut` lands inside a surrogate pair (i.e. text[cut - 1] is a
  // high surrogate that pairs with text[cut]) — a UTF-8/codepoint-safe
  // boundary.
  if (cut > 0) {
    const prev = text.charCodeAt(cut - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
  }
  const truncated = text.slice(0, cut);
  const removed = reportChars - cut;
  return { text: truncated + TRUNCATION_PREFIX + removed + TRUNCATION_SUFFIX, reportChars };
}

// Extract the subagent's FINAL assistant-message text from its transcript —
// the symmetric counterpart to firstUserTextFromTranscript above, used to
// capture what a worker actually reported (not just counts/tokens) for the
// panel. Walks the transcript backward (mirrors extractSubagentTokens' same
// backward walk for the same reason: only the LAST assistant turn is the
// worker's final report, not a running concatenation of every turn) and
// returns the first assistant message text found. Fails open on any error —
// missing file, malformed JSON, non-string path — returning "" exactly like
// firstUserTextFromTranscript, NEVER throwing. Caller treats "" as "no
// report available" and must omit the field entirely, never store "".
// Returns the RAW, uncapped text — caller runs it through capReportText()
// before storing so reportChars reflects the true original length.
function lastAssistantTextFromTranscript(transcriptPath) {
  try {
    if (!transcriptPath || typeof transcriptPath !== "string") return "";
    const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const msgObj = msg.message || msg;
        const role = msg.role || msgObj.role;
        if (role !== "assistant") continue;
        const content = msgObj.content;
        let text = "";
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter((c) => !c || c.type !== "tool_use") // skip tool-call blocks, keep prose
            .map((c) => (typeof c === "string" ? c : (c.text || "")))
            .join(" ")
            .trim();
        }
        if (text) {
          return text;
        }
        // Assistant turn found but it was tool-calls-only (no prose) — keep
        // walking backward for an earlier assistant turn that has text.
      } catch { /* skip malformed line */ }
    }
  } catch { /* transcript not accessible */ }
  return "";
}

// Pop the stopped sub-agent from the stack. Disambiguate parallel agents by
// (-1) exact instanceId match, (0) transcript keyword match, (1) subagentType
// match, else (2) LIFO pop.
// Disambiguate and remove the stopped sub-agent using a prioritized match strategy.
//
// FIX 2: instanceId (Claude Code's payload.agent_id, the same per-instance
// UUID resolveNonSpawnAgent binds — see its doc comment) is the HIGHEST
// priority, checked before transcript/subagentType/LIFO, because it is the
// only discriminator that is exact rather than heuristic. Two concurrent
// same-subagentType workers (e.g. two general-purpose/sonnet siblings) are
// indistinguishable to every priority below this one — that indistinguishability
// is what caused the live swapped-SubagentStop-reports regression this fix
// closes. When instanceId is absent (older Claude Code) or doesn't match any
// stack entry (never bound — e.g. the entry's only tool call raced a lock
// timeout in resolveNonSpawnAgent, or the agent never made a non-spawn call
// before stopping), this falls through unchanged to the pre-existing
// heuristics as a fail-open fallback — never a hard requirement.
function popMatchedAgent(activeAgentFile, opts) {
  const subagentType = (opts && opts.subagentType) || "";
  const transcriptPath = opts && opts.transcriptPath;
  const keywordsConfig = opts && opts.keywordsConfig;
  const instanceId = (opts && opts.instanceId) || "";
  const lockPath = activeAgentFile + ".lock";
  if (!acquireLock(lockPath, 5000)) return null;
  try {
    const data = readJsonSafe(activeAgentFile);
    if (!data) return null;
    const stack = Array.isArray(data.stack) ? data.stack : [];
    if (stack.length === 0) return null;

    let removedIdx = -1;

    // Priority -1 (highest): exact instanceId match. Beats every heuristic
    // below because it identifies the SPECIFIC worker instance, not just a
    // plausible one.
    if (instanceId) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].instanceId === instanceId) { removedIdx = i; break; }
      }
    }

    // Priority 0: transcript-based keyword match against agents present in the stack.
    if (removedIdx < 0 && transcriptPath && keywordsConfig) {
      const firstUserText = firstUserTextFromTranscript(transcriptPath);
      if (firstUserText) {
        const m = matchAgentFromKeywords(firstUserText, keywordsConfig);
        if (m) {
          for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].agentId === m.agentId) { removedIdx = i; break; }
          }
        }
      }
    }

    // Priority 1: match by subagentType embedded in the stack entry. When
    // exactly one candidate matches, use it. When several concurrent
    // same-type spawns are live and none has bound an instanceId yet (the
    // exact-instanceId Priority -1 above already failed, so any candidate
    // that DOES have a bound instanceId is confirmed to be a DIFFERENT,
    // still-live spawn — never this one), prefer an UNBOUND candidate
    // (instanceId not yet set) over a bound one, then break remaining ties
    // FIFO (oldest/lowest stack index first) rather than LIFO — the stack's
    // natural push order is spawn order, so the oldest same-type entry is
    // the most likely one to be stopping first.
    if (removedIdx < 0 && subagentType) {
      const candidates = [];
      for (let i = 0; i < stack.length; i++) {
        const e = stack[i];
        if (e.subagentType && e.subagentType.toLowerCase() === subagentType) candidates.push(i);
      }
      if (candidates.length === 1) {
        removedIdx = candidates[0];
      } else if (candidates.length > 1) {
        const unbound = candidates.filter((i) => !stack[i].instanceId);
        removedIdx = unbound.length > 0 ? unbound[0] : candidates[0];
      }
    }

    // Priority 2: LIFO fallback.
    const popped = removedIdx >= 0 ? stack.splice(removedIdx, 1)[0] : stack.pop();
    const topAgentId = stack.length > 0 ? stack[stack.length - 1].agentId : "none";
    atomicWriteSync(activeAgentFile, JSON.stringify({ version: 1, agentId: topAgentId, timestamp: Date.now(), stack }, null, 2));
    return popped || null;
  } finally {
    releaseLock(lockPath);
  }
}

// 4-priority sub-agent token extraction, ordered to prefer SPLITTABLE component
// data over PRE-SUMMED scalars: component sum on payload.usage/tool_usage ->
// last transcript usage line (component sum) -> total_tokens verbatim -> regex
// on tool_response. The first two paths expose cache_read_input_tokens
// separately from billable tokens, so the metrics panel can show cache-read
// consumption. The last two only ever see an already-summed total_tokens
// number with no way to recover the split, so they are last-resort fallbacks
// used only when no component data exists anywhere.
function extractSubagentTokens(payload) {
  try {
    const usageObj = payload.usage || payload.tool_usage;
    if (usageObj && typeof usageObj === "object") {
      const sum =
        Number(usageObj.input_tokens || 0) +
        Number(usageObj.output_tokens || 0) +
        Number(usageObj.cache_creation_input_tokens || 0);
      const cacheReadTokens = Number(usageObj.cache_read_input_tokens || 0);
      if (sum > 0 || cacheReadTokens > 0) {
        return {
          tokens: sum > 0 ? sum : undefined,
          cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
        };
      }
    }

    const transcriptPath = payload.agent_transcript_path || payload.transcript_path;
    if (transcriptPath && typeof transcriptPath === "string") {
      try {
        const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
        // Sum over EVERY assistant usage line in the subagent's transcript —
        // each usage object is PER MESSAGE, not cumulative, so reading only
        // the last line undercounts a multi-turn worker. Do NOT filter on
        // isSidechain here: this transcript_path is the subagent's OWN
        // transcript file, and every entry in it is marked isSidechain true
        // (it's a sidechain relative to the orchestrator's transcript) — a
        // sidechain filter here would drop all of the worker's own usage.
        let sum = 0;
        let cacheReadTokens = 0;
        let any = false;
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          try {
            const msg = JSON.parse(lines[i]);
            if (msg.type && msg.type !== "assistant") continue;
            const u = msg.usage || (msg.message && msg.message.usage);
            if (u && typeof u === "object") {
              sum +=
                Number(u.input_tokens || 0) +
                Number(u.output_tokens || 0) +
                Number(u.cache_creation_input_tokens || 0);
              cacheReadTokens += Number(u.cache_read_input_tokens || 0);
              any = true;
            }
          } catch { /* skip malformed line */ }
        }
        // Do NOT return early here when both are <= 0 — fall through so
        // the pre-summed scalar fallbacks below still get a chance to run.
        if (any && (sum > 0 || cacheReadTokens > 0)) {
          return {
            tokens: sum > 0 ? sum : undefined,
            cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
          };
        }
      } catch { /* transcript not accessible */ }
    }

    if (usageObj && typeof usageObj === "object" && typeof usageObj.total_tokens === "number" && usageObj.total_tokens > 0) {
      // total_tokens arrives pre-summed by the caller — the source doesn't
      // expose billable vs cache-read components separately, so cache-read
      // cannot be split out here. Last resort: only used when no component
      // data was available above.
      return { tokens: usageObj.total_tokens, cacheReadTokens: undefined };
    }

    const toolResponse =
      typeof payload.tool_response === "string"
        ? payload.tool_response
        : (payload.tool_response && JSON.stringify(payload.tool_response)) || "";
    const m = toolResponse.match(/total_tokens[:\s]+(\d+)/i);
    if (m) {
      const n = parseInt(m[1], 10);
      // Regex match on a pre-summed total_tokens field — same limitation as
      // the total_tokens-verbatim path above: no billable/cache-read split available.
      if (!isNaN(n) && n > 0) return { tokens: n, cacheReadTokens: undefined };
    }
  } catch { /* never crash the hook over token extraction */ }
  return { tokens: undefined, cacheReadTokens: undefined };
}

function peekActiveAgent(activeAgentFile) {
  try {
    const data = readJsonSafe(activeAgentFile);
    if (!data) return null;
    const stack = Array.isArray(data.stack) ? data.stack : [];
    return stack.length > 0 ? stack[stack.length - 1] : null;
  } catch {
    return null;
  }
}

// A stack entry that never received a matching SubagentStop (interrupted
// worker, crashed process, denied/abandoned spawn whose lineage kept
// running, etc.) would otherwise sit on the stack forever, corrupting every
// later peek/attribution. UserPromptSubmit used to unconditionally wipe the
// whole stack for this (clearActiveStack, removed) but that also destroyed
// entries for subagents still genuinely in flight across a turn boundary —
// the 2026-09-06 ready-test regression, where 11 of 12 rapid-fire spawns had
// their SubagentStop fall back to workerId "orchestrator" because an
// intervening UserPromptSubmit wiped their stack entry first. UserPromptSubmit
// now calls this TTL-based prune instead, so only entries older than this
// TTL are evicted and a live entry from an in-flight spawn survives. No
// single "normal" worker runtime is authoritative — this is a defensive
// backstop, not a tuned SLA — so the window is generous on purpose to avoid
// evicting a merely slow worker.
const ORPHAN_ENTRY_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Effective "last activity" instant for TTL purposes: prefer entry.lastSeen
// (refreshed by resolveNonSpawnAgent every time a call resolves to this
// entry — see the single-lock bind below), falling back to entry.timestamp
// (spawn time, never updated) for entries written before lastSeen existed or
// that have never had a non-spawn call resolve to them yet. Using spawn time
// alone was the TTL defect Codex flagged twice: a worker genuinely still
// making tool calls past 30 minutes (e.g. a long UEFN scan) would age out
// mid-turn purely because it was SPAWNED long ago, not because it went idle.
function effectiveLastActivity(entry, now) {
  if (typeof entry.lastSeen === "number") return entry.lastSeen;
  if (typeof entry.timestamp === "number") return entry.timestamp;
  return now;
}

// Lock-free prune core shared by readAndPruneActiveStack (read-only callers,
// e.g. the spawn-parent site) and the atomic bind-and-write path below
// (resolveNonSpawnAgent), so both TTL-evict using the exact same rule
// (effectiveLastActivity, Fix 3) without duplicating the loop. Operates on an
// already-in-memory stack; does no I/O and takes no lock itself — callers own
// locking and eviction logging.
function pruneStackCore(stack, now) {
  const kept = [];
  const evicted = [];
  for (const entry of stack) {
    const basis = effectiveLastActivity(entry, now);
    if (now - basis > ORPHAN_ENTRY_TTL_MS) {
      evicted.push(entry);
    } else {
      kept.push(entry);
    }
  }
  return { kept, evicted };
}

// Best-effort, non-blocking: append one AgentEvicted record per evicted
// entry. Never lets logging failure affect the caller's control flow.
function logEvictions(activityFile, evicted, now) {
  for (const entry of evicted) {
    try {
      const evictionRecord = {
        event: "AgentEvicted",
        workerId: entry.agentId || "unknown",
        reason: "orphan-ttl",
        // ageBasis names which field determined eviction (lastSeen vs the
        // spawn-time timestamp fallback) so a stale-vs-truly-idle eviction is
        // diagnosable from activity.jsonl alone, per Fix 3.
        ageBasis: typeof entry.lastSeen === "number" ? "lastSeen" : "timestamp",
        ageMs: now - effectiveLastActivity(entry, now),
        at: now,
      };
      fs.appendFileSync(activityFile, JSON.stringify(evictionRecord) + "\n", "utf8");
    } catch { /* never let eviction logging break attribution */ }
  }
}

// Read the active-agent stack, evicting any entry whose effectiveLastActivity
// (Fix 3) is older than ORPHAN_ENTRY_TTL_MS. Eviction is logged to
// activityFile as an "AgentEvicted" record (never silent) and the pruned
// stack is written back. Returns the (possibly pruned) stack, or [] on any
// error. Best-effort: a failure to acquire the lock or to write back leaves
// the stack as last read (still usable for this call) rather than blocking
// attribution.
//
// NOTE: this function is read-then-release — it does NOT hold its lock open
// for a caller to mutate-and-write-back afterward. That was exactly the bug
// in Fix 1 (see resolveNonSpawnAgent below): a caller that read here, then
// mutated an entry in memory, then called writeActiveStack separately was
// doing a non-atomic read/modify/write split across TWO lock acquisitions,
// letting two racing calls both read the same unbound stack and both bind to
// it. Any caller that needs to read-decide-write as one unit (i.e. bind an
// instanceId) MUST use the single-lock path (resolveNonSpawnAgent), not this
// function plus a separate write. Callers that only need a pruned READ (no
// follow-up write of a decision made from that read) — e.g. the spawn-parent
// lookup — are fine using this as-is.
function readAndPruneActiveStack(activeAgentFile, activityFile, now) {
  const lockPath = activeAgentFile + ".lock";
  if (!acquireLock(lockPath, 5000)) {
    // Could not get the lock in time; fall back to a raw (unpruned) read so
    // attribution still has something to work with this call.
    const data = readJsonSafe(activeAgentFile);
    return Array.isArray(data && data.stack) ? data.stack : [];
  }
  try {
    const data = readJsonSafe(activeAgentFile);
    const stack = Array.isArray(data && data.stack) ? data.stack : [];
    const { kept, evicted } = pruneStackCore(stack, now);
    if (evicted.length > 0) {
      const topAgentId = kept.length > 0 ? kept[kept.length - 1].agentId : "none";
      atomicWriteSync(activeAgentFile, JSON.stringify({ version: 1, agentId: topAgentId, timestamp: now, stack: kept }, null, 2));
      logEvictions(activityFile, evicted, now);
    }
    return kept;
  } catch {
    return [];
  } finally {
    releaseLock(lockPath);
  }
}

// Lock-free decision core for resolveNonSpawnAgent: given an ALREADY-READ,
// ALREADY-PRUNED stack (still in memory, not yet written back), decide which
// entry a call carrying `instanceId` belongs to, mutating that entry's
// instanceId/lastSeen in place when a bind is made. Does no I/O and takes no
// lock — it exists ONLY so the single held-lock caller below can do
// read -> prune -> decide -> mutate -> write as one unit without duplicating
// the matching logic. Never call this without holding the active-agent lock
// across the read that produced `stack` AND the write-back of its mutations
// — splitting those across two lock acquisitions is exactly Fix 1's bug (see
// the NOTE on readAndPruneActiveStack above).
//
// Strategy, in order:
//   1. Exact match: an entry already bound to this call's instanceId.
//      This is the fix for the concurrent-spawn bug — two siblings on the
//      stack at once now resolve by WHICH one actually made the call, not by
//      which is on top.
//   2. First sighting, unambiguous: no entry is bound to this instanceId yet,
//      but exactly one live entry has no instanceId bound at all -> bind this
//      instanceId to it (it must be that entry's first tool call) and use it.
//   3. First sighting, ambiguous: no entry bound to this instanceId, and
//      MULTIPLE entries are still unbound (two+ freshly spawned siblings
//      whose first calls race before either has been bound). No discriminator
//      exists to pick between them from a single tool-call payload alone, so
//      this falls back to stack-top — the same approximation as before, but
//      now narrowed to only the genuinely ambiguous window. The entry picked
//      is still bound to this instanceId, so the NEXT call from the same
//      instance resolves exactly via case 1.
//   4. No instanceId on the payload at all (older Claude Code, or the
//      orchestrator's own direct tool calls have no agent_id): stack-top,
//      unchanged legacy behavior.
//
// Every case that resolves to a live entry (1, 2, 3, and 4) also stamps
// entry.lastSeen = now — Fix 3's TTL basis — so an entry under active use
// never ages out purely because it was spawned long ago (see
// effectiveLastActivity). This rides along on the same in-memory mutation
// and the same write-back as the instanceId bind, at no extra lock cost.
//
// Returns { entry, workerId } where entry is the matched stack object (or
// null) and workerId is entry.agentId or "orchestrator".
function resolveAgainstStack(stack, instanceId, now) {
  if (stack.length === 0) return { entry: null, workerId: "orchestrator" };

  if (instanceId) {
    // Case 1: exact match on an already-bound instance.
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].instanceId === instanceId) {
        stack[i].lastSeen = now;
        return { entry: stack[i], workerId: stack[i].agentId };
      }
    }

    // Case 2/3: not bound yet. Collect unbound entries.
    const unbound = stack.filter((e) => !e.instanceId);
    let target = null;
    if (unbound.length === 1) {
      target = unbound[0];
    } else if (unbound.length > 1) {
      // Ambiguous first sighting: fall back to stack-top among the unbound
      // entries (best available signal, not a guaranteed-correct one).
      target = unbound[unbound.length - 1];
    }
    if (target) {
      target.instanceId = instanceId;
      target.lastSeen = now;
      return { entry: target, workerId: target.agentId };
    }
    // Every entry already bound to a DIFFERENT instanceId (e.g. an instanceId
    // format we don't recognize, or a race we couldn't resolve) -> fall
    // through to legacy stack-top.
  }

  const top = stack[stack.length - 1];
  top.lastSeen = now;
  return { entry: top, workerId: top.agentId };
}

// Resolve which stack entry a non-spawn tool call (Read/Edit/Bash/mcp__*/etc.
// fired from PreToolUse) belongs to, and bind Claude Code's per-call
// `payload.agent_id` (a UUID identifying the specific running subagent
// instance — stamped on every tool-call payload made from inside a spawned
// sub-agent, confirmed by the leaf-worker spawn guard's own use of the same
// field at ~line 732) onto that entry so later calls from the SAME instance
// resolve exactly instead of by stack-top guessing.
//
// FIX 1 (single-lock invariant): the read (with TTL prune), the bind
// decision, the in-memory mutation, and the write-back all happen here
// inside ONE held lock acquisition — never split across
// readAndPruneActiveStack + a separate writeActiveStack call, which is what
// let two racing first-sightings both read the same unbound stack, both
// decide to bind to the same entry, and have the second writer silently
// clobber the first (last-writer-wins), permanently mis-binding a UUID to
// the wrong worker for the rest of the session. Holding one lock across
// read-decide-write makes the whole operation atomic with respect to any
// other resolveNonSpawnAgent call: a second racing call blocks on the lock
// and, once it acquires it, reads the FIRST call's already-written bind, so
// it correctly lands in case 1 (exact match) or the now-narrower case 2/3
// instead of re-racing the same decision.
//
// Lock-acquisition failure (5000ms): fails OPEN, never blocks attribution.
// Falls back to a raw, unpruned, unlocked read and resolves via
// resolveAgainstStack WITHOUT persisting any bind — this call's workerId is
// still correct (best-effort), but the instanceId bind (and lastSeen stamp)
// isn't saved, so the NEXT call retries the bind under lock rather than
// this one corrupting the stack with an unsynchronized write.
//
// Returns { entry, workerId } — entry is the matched stack object (or null,
// only meaningful within this call since it isn't guaranteed persisted) and
// workerId is entry.agentId or "orchestrator".
function resolveNonSpawnAgent(activeAgentFile, activityFile, instanceId, now) {
  const lockPath = activeAgentFile + ".lock";
  if (!acquireLock(lockPath, 5000)) {
    // Could not get the lock in time: resolve from a best-effort unpruned
    // read WITHOUT writing anything back (see doc comment above) — never
    // block attribution on lock contention.
    const data = readJsonSafe(activeAgentFile);
    const stack = Array.isArray(data && data.stack) ? data.stack : [];
    return resolveAgainstStack(stack, instanceId, now);
  }
  try {
    const data = readJsonSafe(activeAgentFile);
    const rawStack = Array.isArray(data && data.stack) ? data.stack : [];
    const { kept, evicted } = pruneStackCore(rawStack, now);
    const result = resolveAgainstStack(kept, instanceId, now);
    // Write back whenever the stack changed shape (eviction) OR content
    // (instanceId/lastSeen mutated by resolveAgainstStack) — both happen
    // under this SAME lock acquisition, satisfying the single-lock
    // invariant this fix exists for.
    if (kept.length > 0 || evicted.length > 0) {
      const topAgentId = kept.length > 0 ? kept[kept.length - 1].agentId : "none";
      atomicWriteSync(activeAgentFile, JSON.stringify({ version: 1, agentId: topAgentId, timestamp: now, stack: kept }, null, 2));
    }
    if (evicted.length > 0) logEvictions(activityFile, evicted, now);
    return result;
  } catch {
    return { entry: null, workerId: "orchestrator" };
  } finally {
    releaseLock(lockPath);
  }
}

// ---------------------------------------------------------------------------
// Compliance nudge (orchestrator-only): a non-blocking additionalContext
// message surfaced on Grep/Glob/Edit/Write/Read when the orchestrator (not a
// spawned worker) calls them directly. Never fires for a tool call made while
// a sub-agent is active on the stack — workers ARE the leaves and are
// SUPPOSED to grep/edit; warning them would contradict their own doctrine.
//
// Read gets a per-turn counter (orchestrator-turn-reads.json) instead of an
// always-on warning: doctrine explicitly allows a known-path read, verifying
// a specialist's work, or a one-off lookup, so the 1st and 2nd orchestrator
// Read in a turn stay silent; only the 3rd-and-onward nags. The counter
// resets to 0 on Stop (end of the assistant turn). Fully defensive: a
// missing/corrupt counter file degrades to "don't warn", never to crashing.
// ---------------------------------------------------------------------------
function readOrchestratorTurnReads(tycoonDir) {
  try {
    const parsed = readJsonSafe(path.join(tycoonDir, "orchestrator-turn-reads.json"));
    const n = parsed && parsed.count;
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) return n;
  } catch { /* fall through to 0 */ }
  return 0;
}

function writeOrchestratorTurnReads(tycoonDir, count) {
  try {
    const filePath = path.join(tycoonDir, "orchestrator-turn-reads.json");
    atomicWriteSync(filePath, JSON.stringify({ count }));
  } catch { /* best-effort: a stuck counter must never break the hook */ }
}

function resetOrchestratorTurnReads(tycoonDir) {
  writeOrchestratorTurnReads(tycoonDir, 0);
}

// Returns a warning message string, or undefined when no nudge should fire.
// Only ever called when workerId === "orchestrator".
function computeComplianceNudge(toolName, tycoonDir) {
  if (toolName === "Grep" || toolName === "Glob") {
    return `${toolName} ran directly on the orchestrator. Searches belong to search-retrieval (Haiku) — cheaper, and the work stays visible in the delegation view.`;
  }
  if (toolName === "Edit" || toolName === "Write") {
    return `${toolName} ran directly on the orchestrator. File changes belong to a specialist (coding-specialist) — the orchestrator coordinates, it does not implement.`;
  }
  if (toolName === "Read") {
    const nextCount = readOrchestratorTurnReads(tycoonDir) + 1;
    writeOrchestratorTurnReads(tycoonDir, nextCount);
    if (nextCount >= 3) {
      return `That is ${nextCount} direct reads this turn — this is becoming a survey, not a known-path lookup. Multi-file reading belongs to search-retrieval (Haiku).`;
    }
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Orchestrator per-turn token delta (main session has no SubagentStop, so we
// read the transcript on Stop and diff against the previous turn's cumulative).
// ---------------------------------------------------------------------------
// A minimal, best-effort logger for warnings this hook wants visible but
// that must never affect the reported token record. Appends one JSON line to
// hook-warnings.log under tycoonDir; failures here are swallowed — logging
// must never be why a hook call crashes.
function logHookWarning(tycoonDir, message, extra) {
  try {
    fs.mkdirSync(tycoonDir, { recursive: true });
    const logFile = path.join(tycoonDir, "hook-warnings.log");
    const entry = { at: new Date().toISOString(), message, ...(extra || {}) };
    fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf8");
  } catch { /* logging must never crash the hook */ }
}

// A single assistant transcript entry's billable/cache-read token split, or
// undefined if the entry carries no usage. Skips sidechain entries (nested
// tool-use sub-conversations, not the top-level turn) and any entry whose
// `type` is present and not "assistant" (usage only ever lives on assistant
// turns).
function usageFromTranscriptEntry(msg) {
  if (!msg || typeof msg !== "object") return undefined;
  if (msg.isSidechain) return undefined;
  if (msg.type && msg.type !== "assistant") return undefined;
  const u = msg.usage || (msg.message && msg.message.usage);
  if (!u || typeof u !== "object") return undefined;
  return {
    tokens:
      Number(u.input_tokens || 0) +
      Number(u.output_tokens || 0) +
      Number(u.cache_creation_input_tokens || 0),
    cacheReadTokens: Number(u.cache_read_input_tokens || 0),
  };
}

// True when `msg` is a genuine human-typed prompt: type "user", not a
// sidechain, and content that is plain text rather than a synthetic
// tool_result message (Claude Code represents tool results as "user" role
// entries too).
function isHumanUserEntry(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (msg.isSidechain) return false;
  if (msg.type !== "user") return false;
  const msgObj = msg.message || msg;
  const content = msgObj.content;
  if (typeof content === "string") return true;
  if (Array.isArray(content)) {
    return !content.some((c) => c && typeof c === "object" && c.type === "tool_result");
  }
  return false;
}

// ---------------------------------------------------------------------------
// Orchestrator per-turn token delta (main session has no SubagentStop, so we
// read the transcript on Stop and diff against the previous turn's cumulative).
//
// Cursor design (p63-t1): the naive "sum the whole transcript, diff against
// last total" approach reports the ENTIRE session history as one delta the
// first time it runs on a transcript (no state file yet, or the state names
// a different transcriptPath — e.g. a fresh install, or state-file writes
// silently failing because .claude/tycoon/ didn't exist yet). On a fresh
// install this can report hundreds of millions of tokens from a 54-second
// session. Instead we persist a CURSOR (count of transcript lines already
// processed) alongside lastTotal. On first sight of a transcript we seed the
// cursor at the last human user entry, so only entries AFTER that (the final
// turn) are ever summed and reported — never prior history. Each subsequent
// call sums only entries past the previous cursor, so cost is O(new lines),
// not O(whole transcript), and a stale/failed state write can never cause a
// quadratic re-report of the same history.
// ---------------------------------------------------------------------------
function captureOrchestratorTokens(payload, tycoonDir) {
  try {
    const transcriptPath = payload.transcript_path;
    if (!transcriptPath || typeof transcriptPath !== "string") return {};
    const rawLines = fs.readFileSync(transcriptPath, "utf8").split("\n");
    // A file ending in a newline (the normal case) produces a trailing empty
    // element from split("\n") that is not a real line. Strip it so
    // lines.length reflects the true line count — otherwise the persisted
    // cursor points one past the real end and the first line appended before
    // the next Stop gets skipped.
    const lines = rawLines.length > 0 && rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;

    const stateFile = path.join(tycoonDir, "orchestrator-token-state.json");
    const prev = readJsonSafe(stateFile);
    const isFreshTranscript = !prev || prev.transcriptPath !== transcriptPath;

    let startIdx = 0; // index of first line NOT yet processed
    if (!isFreshTranscript && typeof prev.cursorLine === "number" && prev.cursorLine >= 0) {
      startIdx = prev.cursorLine;
    } else {
      // Seed: only the final turn (entries after the last human user entry)
      // should ever be reported the first time we see this transcript.
      let seedIdx = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        try {
          const msg = JSON.parse(lines[i]);
          if (isHumanUserEntry(msg)) { seedIdx = i + 1; break; }
        } catch { /* skip malformed line */ }
      }
      startIdx = seedIdx;
    }

    let delta = 0;
    let cacheReadDelta = 0;
    let lastUuid;
    let model;
    for (let i = startIdx; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const msg = JSON.parse(lines[i]);
        if (msg.uuid) lastUuid = msg.uuid;
        const usage = usageFromTranscriptEntry(msg);
        if (usage) {
          delta += usage.tokens;
          cacheReadDelta += usage.cacheReadTokens;
        }
      } catch { /* skip malformed line */ }
    }

    // Most recent assistant entry (whole transcript) carries the live model id.
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const msg = JSON.parse(lines[i]);
        const m = (msg.message && msg.message.model) || msg.model;
        if (m && typeof m === "string") { model = m; break; }
      } catch { /* skip */ }
    }

    // Sanity ceiling: a single delta this large is almost certainly an
    // accounting bug (e.g. a full-history re-report), not real usage. Drop
    // it rather than report a number that would blow up the panel's totals.
    // The cursor below still advances past these lines regardless of
    // `dropped` — by design, so the same oversized lines are never re-summed
    // and re-dropped on every subsequent Stop.
    const CEILING = 20_000_000;
    let dropped = false;
    if (delta > CEILING) {
      logHookWarning(tycoonDir, "captureOrchestratorTokens: delta exceeded sanity ceiling, dropped", {
        delta,
        ceiling: CEILING,
        transcript: path.basename(transcriptPath),
      });
      dropped = true;
    }

    const newCursor = lines.length;
    let wrote = false;
    try {
      fs.mkdirSync(tycoonDir, { recursive: true });
      atomicWriteSync(
        stateFile,
        JSON.stringify({
          transcriptPath,
          cursorLine: newCursor,
          lastUuid,
          lastTotal: (isFreshTranscript || !prev || typeof prev.lastTotal !== "number" ? 0 : prev.lastTotal) + (dropped ? 0 : delta),
          lastCacheReadTotal: (isFreshTranscript || !prev || typeof prev.lastCacheReadTotal !== "number" ? 0 : prev.lastCacheReadTotal) + cacheReadDelta,
        })
      );
      wrote = true;
    } catch {
      wrote = false;
    }

    // If we could not persist the new cursor, we must NOT report this delta:
    // the next call would start from the same stale cursor and re-sum these
    // same lines again, but reporting now would already have counted them
    // once — silently double-accounting every call until the write starts
    // succeeding. Skipping the report (not the state write) is the safe
    // failure mode.
    if (!wrote) {
      logHookWarning(tycoonDir, "captureOrchestratorTokens: state write failed, skipping report to avoid re-report", {
        transcript: path.basename(transcriptPath),
      });
      return { model };
    }

    if (dropped) return { model };

    return {
      tokens: delta > 0 ? delta : undefined,
      cacheReadTokens: cacheReadDelta > 0 ? cacheReadDelta : undefined,
      model,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(raw) {
  const projectRoot =
    process.env.CLAUDE_PROJECT_DIR || findProjectRootFallback();

  const tycoonDir = path.join(projectRoot, ".claude", "tycoon");
  try { fs.mkdirSync(tycoonDir, { recursive: true }); } catch { process.exit(0); }

  const agentsDir = path.join(projectRoot, ".claude", "agents");
  const keywordsConfig = readJsonSafe(path.join(tycoonDir, "agent-keywords.json"));
  const fallbackAgent = keywordsConfig ? (keywordsConfig.fallback_agent || "primary-agent") : "primary-agent";
  const activeAgentFile = path.join(tycoonDir, "active-agent.json");
  const activityFile = path.join(tycoonDir, "activity.jsonl");
  const delegationMode = readDelegationMode(tycoonDir);

  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  const hookEvent = payload.hook_event_name || "";
  const toolName = payload.tool_name || "";
  const toolInput = payload.tool_input || payload || {};

  const at = Date.now();

  // DIAGNOSTIC (Bug 4 verify-first): capture raw team-event payloads so the
  // token-attribution fix can be built against real shapes. Purely observational
  // — never alters activity tracking. Capped + fully guarded.
  const TEAM_EVENTS = new Set(["TaskCreated", "TaskCompleted", "TeammateIdle"]);
  if (TEAM_EVENTS.has(hookEvent)) {
    try {
      const samplesFile = path.join(tycoonDir, "hook-event-samples.jsonl");
      // cap to avoid unbounded growth: only append while under N lines
      let lineCount = 0;
      try { lineCount = fs.readFileSync(samplesFile, "utf8").split("\n").filter(Boolean).length; } catch {}
      if (lineCount < 300) {
        fs.appendFileSync(samplesFile, JSON.stringify({ diagnostic: true, event: hookEvent, at: Date.now(), payload }) + "\n", "utf8");
      }
    } catch { /* never let diagnostics break the hook */ }
    // these events have no other handler today — record and exit cleanly
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // SubagentStop: pop the matching agent off the stack and capture its tokens.
  // SubagentStop payloads usually omit tool_input/usage, so we fall back to
  // payload.agent_type for matching and the transcript for the token count.
  // -------------------------------------------------------------------------
  if (hookEvent === "SubagentStop") {
    const ssInput = payload.tool_input || {};
    const subagentType = (ssInput.subagent_type || payload.agent_type || "").toLowerCase();
    const transcriptPath = payload.agent_transcript_path || payload.transcript_path;
    // Same per-instance UUID and same guard used at the spawn-guard site
    // (~line 936) and the spawn-parent site (~line 1087) — payload.agent_id
    // is Claude Code's discriminator for the SPECIFIC subagent instance that
    // is stopping, not just its type. FIX 2: passed into popMatchedAgent as
    // its highest-priority match (see that function's doc comment) so two
    // concurrent same-subagentType workers stopping are told apart exactly
    // instead of by transcript-keyword/subagentType/LIFO heuristics — the
    // direct cause of the live swapped-SubagentStop-reports regression.
    const instanceId = typeof payload.agent_id === "string" && payload.agent_id !== "" ? payload.agent_id : "";

    const popped = popMatchedAgent(activeAgentFile, { subagentType, transcriptPath, keywordsConfig, instanceId });
    const workerId = (popped && popped.agentId) || "orchestrator";

    /** @type {Record<string, unknown>} */
    const record = {
      event: hookEvent,
      workerId,
      at,
    };
    if (delegationMode) record.delegationMode = delegationMode;

    // Auditability (Fix 2): record which instanceId popMatchedAgent actually
    // matched against (not merely the instanceId this payload carried — if
    // the exact match failed, popped may have no instanceId at all, or a
    // different one from an unrelated earlier bind) so activity.jsonl shows
    // the TRUE basis for this attribution, not just what was offered.
    if (popped && typeof popped.instanceId === "string" && popped.instanceId !== "") {
      record.instanceId = popped.instanceId;
    }
    // spawnId: the same per-spawn id stamped on this instance's PreToolUse
    // spawn record (generateSpawnId), carried on the stack entry and
    // returned by popMatchedAgent — lets the panel remove exactly this
    // instance from AgentMetric.liveSpawns instead of guessing.
    if (popped && typeof popped.spawnId === "string" && popped.spawnId !== "") {
      record.spawnId = popped.spawnId;
    }

    if (popped && popped.model) record.model = popped.model;
    if (popped && popped.fallbackOf !== undefined) {
      record.fallbackOf = popped.fallbackOf;
      record.fallbackDepth = popped.fallbackDepth;
      record.fallbackIsDefault = popped.fallbackIsDefault === true;
    }

    const { tokens, cacheReadTokens } = extractSubagentTokens(payload);
    if (tokens !== undefined && tokens > 0) record.tokens = tokens;
    if (cacheReadTokens !== undefined && cacheReadTokens > 0) record.cacheReadTokens = cacheReadTokens;
    if (payload.session_id) record.sessionId = payload.session_id;

    // Worker report capture: the subagent's final assistant-message text,
    // extracted from the same transcript already resolved above. Optional —
    // omitted entirely (never an empty string) when the transcript is
    // missing/unreadable or its final assistant turn had no prose text.
    // p21-t8: capped at REPORT_MAX_CHARS (600) via capReportText — reportChars
    // carries the original (pre-truncation) length so the UI/diagnostics can
    // tell a short report from a truncated one.
    const rawReport = lastAssistantTextFromTranscript(transcriptPath);
    if (rawReport) {
      const capped = capReportText(rawReport);
      record.report = capped.text;
      record.reportChars = capped.reportChars;
    }

    try {
      fs.appendFileSync(activityFile, JSON.stringify(record) + "\n", "utf8");
    } catch { /* ignore */ }
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // PreToolUse: spawn events get full attribution; other tools get activity
  // -------------------------------------------------------------------------
  if (hookEvent === "PreToolUse") {
    const isSpawn = toolName === "Task" || toolName === "Agent";
    const isSkill = toolName === "Skill";

    if (isSpawn) {
      // -----------------------------------------------------------------
      // Leaf-worker spawn guard — structural enforcement of the "workers
      // are leaves, never spawn sub-agents" doctrine (see
      // delegationDoctrine.ts's renderWorkerLeafSection). A worker spawned
      // as the BUILT-IN `general-purpose` subagent_type loads no
      // .claude/agents/*.md file, so the `disallowedTools: Agent`
      // frontmatter packCatalog.ts writes into generated agent files never
      // applies to it — this hook-level guard is what actually covers that
      // path. Claude Code stamps `agent_id`/`agent_type` on the
      // PreToolUse payload ONLY when the call originates inside a spawned
      // sub-agent (both are absent for the main-session orchestrator), so
      // an empty/missing agent_id is treated as "this is the orchestrator"
      // and is NEVER denied. A configured team-lead agent (tier: lead in
      // its own .claude/agents/<id>.md, only meaningful in team_leads
      // mode) is exempt — leads are allowed to spawn their own workers.
      // FAIL-OPEN by construction: every lookup below is wrapped so that
      // any error (malformed payload, missing agentsDir, unreadable file)
      // falls through to normal spawn handling rather than ever denying —
      // a broken guard must never block the orchestrator or wedge a
      // session.
      // -----------------------------------------------------------------
      try {
        const spawnerAgentId = typeof payload.agent_id === "string" ? payload.agent_id : "";
        if (spawnerAgentId !== "") {
          const spawnerAgentType = typeof payload.agent_type === "string" ? payload.agent_type : "";
          const normalizedSpawnerType = spawnerAgentType.toLowerCase().replace(/\s+/g, "-");
          const spawnerIsLead =
            delegationMode === "team_leads" &&
            normalizedSpawnerType !== "" &&
            readAgentTier(agentsDir, normalizedSpawnerType) === "lead";

          if (!spawnerIsLead) {
            const attemptedSubagentType = toolInput.subagent_type || toolInput.name || "";
            /** @type {Record<string, unknown>} */
            const denialRecord = {
              event: "SpawnDenied",
              tool: toolName,
              agentId: spawnerAgentId,
              agentType: spawnerAgentType || "unknown",
              attemptedSubagentType,
              at,
            };
            if (delegationMode) denialRecord.delegationMode = delegationMode;
            if (payload.session_id) denialRecord.sessionId = payload.session_id;
            try {
              fs.appendFileSync(activityFile, JSON.stringify(denialRecord) + "\n", "utf8");
            } catch { /* ignore */ }

            const denialReason =
              "Blocked: you are a leaf worker — workers do not spawn sub-agents. Do the work yourself with your own tools, chunked into bounded sequential calls if it is long (see your brief). This block is structural (TycoonAgents leaf-worker rule).";
            // A write failure here (e.g. EPIPE) must never silently degrade
            // to an allow: exit 0 with no stdout means "no decision" to
            // Claude Code, which is ALLOW. So the stdout write is the ONLY
            // path that exits 0 — any failure falls back to exit code 2
            // (reason on stderr), which the Claude Code hooks docs also
            // treat as a block, so the deny still lands either way.
            try {
              process.stdout.write(JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: denialReason,
                },
              }));
              process.exit(0);
            } catch {
              try { process.stderr.write(denialReason); } catch { /* best-effort */ }
              process.exit(2);
            }
          }
        }
      } catch {
        // Fail open: any guard error falls through to normal spawn handling.
      }

      // --- Agent attribution (5-priority routing) ---
      const subagentType = toolInput.subagent_type || "";
      const description = toolInput.description || "";
      const prompt = (toolInput.prompt || "").substring(0, 500);

      let agentId = "unknown";
      let routingMethod = "fallback";
      let matchedKeyword = "";

      // Priority -2 (highest): Task description begins with "<agent-id>:" or
      // "<agent-id> —"/"<agent-id> -" where agent-id exactly matches an
      // installed .claude/agents/*.md basename. This is how CLAUDE.md's
      // delegation table briefs a Task ("uefn-auditor: verse-audit
      // verse-lint check", "codex-reviewer: codex foreign-review check") and
      // must win outright, before subagent_type mapping and before keyword
      // scoring — otherwise a shared keyword elsewhere in the description or
      // prompt body (e.g. "verse" also matching verse-expert, or "test" in
      // "Ready test rerun" also matching testing-specialist) can outscore the
      // agent the description actually names.
      try {
        const prefixMatch = description.match(/^\s*([a-z0-9][a-z0-9-]*)\s*(?::|—|-)\s/i);
        if (prefixMatch) {
          const prefixId = prefixMatch[1].toLowerCase();
          if (fs.existsSync(path.join(agentsDir, prefixId + ".md"))) {
            agentId = prefixId;
            routingMethod = "description-prefix";
            matchedKeyword = prefixMatch[1];
          }
        }
      } catch {
        // Fail open: any prefix-parsing error falls through to normal routing.
      }

      // Priority -1: Explicit "AGENT:<agent-id>" marker anywhere in the FULL prompt
      // (not the 500-char window used for keyword scoring below). Lets the
      // orchestrator force routing when an accurate task description is
      // unavoidably dense with another agent's keywords. Case-insensitive;
      // bounded character class avoids catastrophic backtracking; first match
      // wins; unvalidated ids are ignored and fall through to normal routing.
      try {
        const fullPrompt = toolInput.prompt || "";
        const overrideMatch = agentId === "unknown" ? fullPrompt.match(/AGENT:\s?([a-z0-9-]+)/i) : null;
        if (overrideMatch) {
          const overrideId = overrideMatch[1].toLowerCase().replace(/\s+/g, "-");
          if (overrideId && fs.existsSync(path.join(agentsDir, overrideId + ".md"))) {
            agentId = overrideId;
            routingMethod = "override";
            matchedKeyword = overrideMatch[1];
          }
        }
      } catch {
        // Fail open: any override-parsing error falls through to normal routing.
      }

      // Priority 0: Agent tool "name" param -> exact agent id
      const agentName = (toolInput.name || "").toLowerCase().replace(/\s+/g, "-");
      if (agentId === "unknown" && agentName && fs.existsSync(path.join(agentsDir, agentName + ".md"))) {
        agentId = agentName;
        routingMethod = "name";
        matchedKeyword = toolInput.name;
      }

      // Priority 1: Explicit subagent_type that maps to a known agent file
      if (agentId === "unknown" && subagentType) {
        const normalized = subagentType.toLowerCase().replace(/\s+/g, "-");
        if (normalized !== "general-purpose" && normalized !== "general" && normalized !== "explore") {
          if (fs.existsSync(path.join(agentsDir, normalized + ".md"))) {
            agentId = normalized;
            routingMethod = "explicit";
            matchedKeyword = subagentType;
          }
        }
        // Explore -> search-retrieval alias
        if (agentId === "unknown" && normalized === "explore") {
          agentId = "search-retrieval";
          routingMethod = "explicit";
          matchedKeyword = subagentType;
        }
        // Try keyword fallback on subagentType text when not a file match
        if (agentId === "unknown" && keywordsConfig) {
          const m = matchAgentFromKeywords(normalized.replace(/-/g, " "), keywordsConfig);
          if (m) { agentId = m.agentId; matchedKeyword = m.matchedKeyword; routingMethod = "explicit"; }
        }
      }

      // Priority 2: Keyword matching, description weighted far above prompt
      // body (DESCRIPTION_WEIGHT in matchAgentFromKeywords) so a prompt
      // containing another agent's keyword (e.g. "Ready test rerun"
      // matching testing-specialist's "test") cannot outscore the
      // description's own match.
      if (agentId === "unknown" && keywordsConfig) {
        const m = matchAgentFromKeywords(description, keywordsConfig, prompt);
        if (m) { agentId = m.agentId; matchedKeyword = m.matchedKeyword; routingMethod = "keyword"; }
      }

      // Priority 3: Fallback
      if (agentId === "unknown") {
        agentId = fallbackAgent;
        routingMethod = "fallback";
      }

      const rawModel = toolInput.model;
      // Priority: explicit Task model -> agent .md frontmatter model -> MODEL_DEFAULTS.
      // resolveModel applies SHORTHAND to any provided value and falls back to
      // MODEL_DEFAULTS[agentId] when the value is falsy.
      let model = resolveModel(rawModel || readAgentModel(agentsDir, agentId), agentId);
      const agentDescription = readAgentDescription(agentsDir, agentId);
      const tier = readAgentTier(agentsDir, agentId);

      // p15-t2: this dispatch is a fallback re-dispatch iff FallbackState
      // (persisted per-session at .claude/tycoon/fallback-state.json) has a
      // recorded failure for this agentId in this session. When so, stamp
      // fallbackOf/fallbackDepth and swap model/vendor/costModelClass to the
      // chain entry that actually runs — resolved from
      // .claude/tycoon/routing.resolved.json's agents[agentId].fallback
      // (Backend[], written by scripts/apply-routing-profile.mjs), not the
      // assigned primary. Fail-open: any missing state/routing file just
      // means no fallback fields are added (today's behavior).
      let fallbackOf;
      let fallbackDepth;
      let fallbackVendor;
      let fallbackCostModelClass;
      let fallbackIsDefault;
      try {
        const fallbackChain = getFallbackChainModule();
        const sessId = typeof payload.session_id === "string" ? payload.session_id : undefined;
        if (fallbackChain && sessId) {
          const stateData = loadFallbackStateFile(tycoonDir);
          const perSession = stateData[sessId] || {};
          const attemptsSoFar = (perSession[agentId] && perSession[agentId].attemptsSoFar) || 0;
          if (attemptsSoFar > 0) {
            const resolvedRouting = readJsonSafe(path.join(tycoonDir, "routing.resolved.json"));
            const resolvedAgentEntry = resolvedRouting && resolvedRouting.agents && resolvedRouting.agents[agentId];
            // p69-t3: routing.resolved.json has no entry for this agent (the
            // apply-routing-profile.mjs regen script was never run against a
            // hand edit) — fall back to routing.json's flat entry so a hand
            // edit still takes effect instead of being silently inert.
            const flatEntry = !resolvedAgentEntry ? readFlatRoutingAgentEntry(tycoonDir, agentId) : undefined;
            const chainRaw = (resolvedAgentEntry && resolvedAgentEntry.fallback) || (flatEntry && flatEntry.chain) || [];
            const chain = Array.isArray(chainRaw) ? chainRaw : [];
            const result = fallbackChain.resolveNextFallback({
              slotId: agentId,
              chain,
              attemptsSoFar: attemptsSoFar - 1,
              defaultFallback: (resolvedRouting && resolvedRouting.defaultFallback) || (flatEntry && flatEntry.defaultFallback),
              useDefaultFallback: resolvedAgentEntry
                ? resolvedAgentEntry.useDefaultFallback !== false
                : flatEntry
                  ? flatEntry.useDefaultFallback
                  : true,
              failingSlot: { model },
            });
            if (!result.exhausted && result.slot) {
              fallbackOf = agentId;
              fallbackDepth = result.index + 1;
              if (result.slot.model) model = result.slot.model;
              fallbackVendor = result.slot.vendor;
              fallbackCostModelClass = result.slot.costModelClass;
              fallbackIsDefault = result.isDefault === true;
            }
          }
        }
      } catch {
        // Fail open: any error here must never break normal spawn attribution.
      }

      // Parent attribution: the spawning payload carries the SAME
      // payload.agent_id discriminator as any other tool call made from
      // inside a subagent (confirmed by the leaf-worker spawn guard's own
      // use of this field above). When present, it is matched against an
      // already-bound stack entry exactly like resolveNonSpawnAgent's case 1
      // — this correctly picks the spawning sibling out of several live
      // entries instead of guessing stack-top, fixing parent attribution for
      // the same class of concurrent-spawn interleaving as the non-spawn fix
      // below. It only falls back to stack-top peek when the spawner's
      // agent_id is absent (this is the orchestrator itself — never has an
      // agent_id) or not yet bound to any entry (the spawner's own very
      // first tool call was this spawn, so no prior non-spawn call bound it
      // yet — genuinely rare, since a lead has almost always made at least
      // one other call first). That residual fallback window is the
      // remaining accepted approximation (see docs/plan/team-lead-mode.md
      // Phase 3).
      const spawnerInstanceId = typeof payload.agent_id === "string" && payload.agent_id !== "" ? payload.agent_id : "";
      // Always read-and-prune here (not only when spawnerInstanceId is
      // present): a spawn is as good a trigger point as any non-spawn call
      // to sweep orphaned entries, and orchestrator-issued spawns (the
      // common case — no agent_id) would otherwise never exercise the TTL
      // eviction sweep at all.
      const stackNow = readAndPruneActiveStack(activeAgentFile, activityFile, at);
      let parentEntry = null;
      if (spawnerInstanceId) {
        for (let i = stackNow.length - 1; i >= 0; i--) {
          if (stackNow[i].instanceId === spawnerInstanceId) { parentEntry = stackNow[i]; break; }
        }
      }
      if (!parentEntry) parentEntry = stackNow.length > 0 ? stackNow[stackNow.length - 1] : null;
      const parentId = (parentEntry && parentEntry.agentId && parentEntry.agentId !== "none")
        ? parentEntry.agentId
        : undefined;

      const spawnId = generateSpawnId();
      const stackEntry = { agentId, model, timestamp: at, subagentType, parentId, fallbackOf, fallbackDepth, fallbackIsDefault, spawnId };
      pushActiveAgent(activeAgentFile, stackEntry);

      // roleInferred: true when this spawn's agentId came from keyword
      // scoring (routingMethod "keyword") rather than an explicit agent
      // name/subagent_type match — i.e. subagent_type was a built-in
      // (general-purpose/Explore) and the description/prompt text was
      // scored against agent-keywords.json. Lets the panel flag a spawn
      // that landed on an agent by guesswork instead of direct routing.
      const roleInferred = routingMethod === "keyword";

      /** @type {Record<string, unknown>} */
      const record = {
        event: hookEvent,
        tool: toolName,
        workerId: agentId,
        model,
        routingMethod,
        matchedKeyword,
        spawnId,
        at,
      };
      // description: only emitted when non-empty. This is a spawn record
      // (isSpawn true, we are inside that branch) so toolInput.description
      // here is the Task/Agent call's own brief -- but a repeat spawn of
      // the same worker can omit it, and mapHookRecord/state.ts would
      // otherwise treat an empty string as "clear the description",
      // blanking the panel's spawn-desc line at the worker's next spawn.
      if (description) record.description = description;
      if (agentDescription) record.agentDescription = agentDescription;
      if (tier) record.tier = tier;
      if (parentId) record.parentId = parentId;
      if (delegationMode) record.delegationMode = delegationMode;
      if (payload.session_id) record.sessionId = payload.session_id;
      if (roleInferred) record.roleInferred = true;
      if (fallbackOf !== undefined) {
        record.fallbackOf = fallbackOf;
        record.fallbackDepth = fallbackDepth;
        record.fallbackIsDefault = fallbackIsDefault === true;
        if (fallbackVendor) record.vendor = fallbackVendor;
        if (fallbackCostModelClass) record.costModelClass = fallbackCostModelClass;
      }

      try {
        fs.appendFileSync(activityFile, JSON.stringify(record) + "\n", "utf8");
      } catch { /* ignore */ }
      process.exit(0);
    }

    if (isSkill) {
      // Attribute Skill calls to the currently active agent (stack top)
      const top = peekActiveAgent(activeAgentFile);
      const skillAgentId = (top && top.agentId && top.agentId !== "none") ? top.agentId : "orchestrator";
      const skillName = toolInput.skill || description || "unknown-skill";

      /** @type {Record<string, unknown>} */
      const record = {
        event: hookEvent,
        tool: toolName,
        workerId: skillAgentId,
        skillName,
        at,
      };
      if (delegationMode) record.delegationMode = delegationMode;
      if (payload.session_id) record.sessionId = payload.session_id;

      try {
        fs.appendFileSync(activityFile, JSON.stringify(record) + "\n", "utf8");
      } catch { /* ignore */ }
      process.exit(0);
    }

    // Non-spawn tool activity (Read, Edit, Bash, mcp__*, etc.)
    if (toolName) {
      // payload.agent_id is Claude Code's own per-instance UUID for the
      // subagent that issued this call (present only when the call
      // originates inside a spawned sub-agent — see resolveNonSpawnAgent's
      // doc comment). When present it lets us attribute this EXACT call to
      // the EXACT worker that made it instead of guessing from stack order,
      // which is what previously misattributed every call made by an
      // earlier-spawned sibling once a later sibling was pushed on top.
      const instanceId = typeof payload.agent_id === "string" && payload.agent_id !== "" ? payload.agent_id : "";
      const resolved = resolveNonSpawnAgent(activeAgentFile, activityFile, instanceId, at);
      const workerId = resolved.workerId;

      // Compliance nudge: ONLY ever computed for the orchestrator itself.
      // Spawned workers are leaves and are supposed to grep/edit directly —
      // never nag them.
      let nudge;
      if (workerId === "orchestrator") {
        nudge = computeComplianceNudge(toolName, tycoonDir);
      }

      /** @type {Record<string, unknown>} */
      const record = {
        event: hookEvent,
        tool: toolName,
        workerId,
        at,
      };
      if (delegationMode) record.delegationMode = delegationMode;
      if (payload.session_id) record.sessionId = payload.session_id;
      if (nudge) record.warned = true;

      // -------------------------------------------------------------------
      // Codex offload visibility (p6-t2): the Codex MCP server (media/mcp/
      // catalog.json id "codex") is invoked through this same PreToolUse
      // path — Claude Code names MCP tool calls "mcp__<serverId>__<tool>",
      // so a Codex call surfaces here as toolName "mcp__codex__codex" or
      // "mcp__codex__codex-reply". This is an EXTENSION of the existing
      // non-spawn branch, not a new write site: the branch already fires
      // for every mcp__* tool and already writes tool/workerId/at, so the
      // only gap was the model id and the (deliberately absent) token
      // fields. No parallel site was needed.
      //
      // model: the `codex` tool accepts a per-call `model` argument that
      // overrides the server's baked-in default (verified in
      // media/mcp/catalog.json's codex entry and docs/codex-mcp-probe-
      // findings.md Section 3 — precedence CONFIRMED live). When the
      // caller didn't pass one, the record falls back to the launch-time
      // default baked into catalog.json's config.args
      // (`-c model="gpt-6-astra"`) rather than leaving model empty, since
      // that is genuinely the model the call ran on absent an override.
      //
      // tokens / cacheReadTokens: deliberately OMITTED (left undefined),
      // never estimated or defaulted to 0. Per docs/codex-mcp-probe-
      // findings.md Sections 1-3, a successful `tools/call` response for
      // the `codex`/`codex-reply` tools carries only
      // {content, structuredContent:{threadId, content}} — no usage/token
      // object of any kind. Section 7 further confirms (via source
      // inspection of codex_tool_runner.rs) that the RateLimitWindow
      // usage data Codex's core computes internally is NOT forwarded to
      // this MCP tools/call surface. A future maintainer who is tempted to
      // "fill in" tokens from character/prompt-length should not — this
      // project has a standing rule against fabricated numbers, and the
      // metrics panel already renders an absent tokens field as "—"
      // rather than inventing one.
      // Generic path (p2-t2): route ANY mcp__<server>__<tool> call through
      // the backend map built from .claude/agents/*.md `backend:`
      // frontmatter (buildMcpBackendRouting/lookupMcpBackend above), rather
      // than hardcoding the Codex server. Adds vendor/costModelClass, which
      // the legacy fallback below never had.
      const mcpRouting = toolName.indexOf("mcp__") === 0 ? buildMcpBackendRouting(agentsDir) : null;
      const mcpBackend = mcpRouting ? lookupMcpBackend(mcpRouting, toolName) : undefined;
      if (mcpBackend) {
        const backendModel = (toolInput && typeof toolInput.model === "string" && toolInput.model)
          ? toolInput.model
          : mcpBackend.model;
        record.model = backendModel;
        record.vendor = mcpBackend.vendor;
        record.costModelClass = mcpBackend.costModelClass;
        // tokens / cacheReadTokens intentionally left unset unless a future
        // tool result surface actually carries usage — see comment above.
      } else if (toolName.indexOf("mcp__codex__") === 0) {
        // LEGACY FALLBACK: fires whenever no backend map entry matched this
        // call — either agentBackend.js isn't available next to this hook
        // (unbuilt out/, or an installer that hasn't copied it yet —
        // mcpRouting === null), or it IS available but no *.md declares a
        // `backend:` block for the codex server (mcpRouting is a real but
        // non-matching map). Both cases must still record a Codex model
        // rather than silently dropping it (mcpRouting being non-null was
        // previously mistaken for "already handled", which dropped
        // record.model whenever no agent had opted into backend routing).
        // Once codex-reviewer.md declares a `backend:` block, mcpBackend
        // above is truthy and this branch is skipped via the preceding
        // else-if, so there is no double routing.
        const CODEX_TOOL_PREFIX = "mcp__codex__";
        if (toolName.indexOf(CODEX_TOOL_PREFIX) === 0) {
          // p_bugfix: resolve in order — (1) a per-call override, (2) an
          // agent .md's backend.model scanned directly (no compiled module
          // required — see findBackendModelForMcpServer above), (3)
          // routing.resolved.json's slot model for this mcpServer, (4) the
          // legacy launch-time default. This fixes activity records
          // reporting the stale catalog.json launch default (gpt-6-astra)
          // when an agent file has since repinned backend.model (e.g.
          // codex-reviewer.md -> openai/gpt-5) but agentBackend.js wasn't
          // available next to the hook to route it through mcpBackend above.
          const codexModel =
            (toolInput && typeof toolInput.model === "string" && toolInput.model) ||
            findBackendModelForMcpServer(agentsDir, "codex") ||
            findResolvedRoutingModelForMcpServer(tycoonDir, "codex") ||
            "gpt-6-astra"; // catalog.json's codex entry launch-time default (-c model=)
          record.model = codexModel;
          // tokens / cacheReadTokens intentionally left unset — see comment above.
        }
      }

      try {
        fs.appendFileSync(activityFile, JSON.stringify(record) + "\n", "utf8");
      } catch { /* ignore */ }

      if (nudge) {
        try {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              additionalContext: nudge,
            },
          }));
        } catch { /* never let output construction break the hook */ }
      }
    }
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // PostToolUse (plan p15-t1): a registered backend MCP tool call (the
  // generic mcp__<server>__<tool> map built by buildMcpBackendRouting, same
  // map the PreToolUse branch above uses for vendor/model attribution)
  // whose result matches isProviderFailure gets a FallbackTriggered
  // activity record and an additionalContext instruction telling the
  // orchestrator to re-dispatch the same task on the next fallback chain
  // entry. This does NOT touch any existing hook output for a non-failure
  // PostToolUse — there was no PostToolUse handling in this hook before
  // this addition, so nothing here can regress an existing byte-identical
  // output (see test/tycoonClaudeHook*.test.ts, unchanged by this task).
  // -------------------------------------------------------------------------
  if (hookEvent === "PostToolUse") {
    try {
      const fallbackChain = getFallbackChainModule();
      if (fallbackChain && toolName && toolName.indexOf("mcp__") === 0) {
        const mcpRouting = buildMcpBackendRouting(agentsDir);
        const mcpBackend = lookupMcpBackend(mcpRouting, toolName);
        if (mcpBackend && mcpBackend.agentId) {
          const toolResponseText =
            typeof payload.tool_response === "string"
              ? payload.tool_response
              : (payload.tool_response && JSON.stringify(payload.tool_response)) || "";
          const codexModelSlugError = isCodexModelSlugError(toolResponseText);
          if (fallbackChain.isProviderFailure(toolResponseText) || codexModelSlugError) {
            const slotId = mcpBackend.agentId;
            const sessionId = typeof payload.session_id === "string" ? payload.session_id : "unknown-session";
            const resolvedRouting = readJsonSafe(
              path.join(tycoonDir, "routing.resolved.json")
            );
            const resolvedAgentEntry = resolvedRouting && resolvedRouting.agents && resolvedRouting.agents[slotId];
            // p69-t3: same routing.json flat-entry fallback as the PreToolUse
            // site above — see readFlatRoutingAgentEntry.
            const flatEntry = !resolvedAgentEntry ? readFlatRoutingAgentEntry(tycoonDir, slotId) : undefined;
            const chainRaw = (resolvedAgentEntry && resolvedAgentEntry.fallback) || (flatEntry && flatEntry.chain) || [];
            const chain = Array.isArray(chainRaw) ? chainRaw : [];

            const stateData = loadFallbackStateFile(tycoonDir);
            const perSession = stateData[sessionId] || {};
            const attemptsSoFar = (perSession[slotId] && perSession[slotId].attemptsSoFar) || 0;
            const newAttempts = attemptsSoFar + 1;
            perSession[slotId] = { attemptsSoFar: newAttempts };
            stateData[sessionId] = perSession;
            saveFallbackStateFile(tycoonDir, stateData);

            const result = fallbackChain.resolveNextFallback({
              slotId,
              chain,
              attemptsSoFar: newAttempts - 1,
              defaultFallback: (resolvedRouting && resolvedRouting.defaultFallback) || (flatEntry && flatEntry.defaultFallback),
              useDefaultFallback: resolvedAgentEntry
                ? resolvedAgentEntry.useDefaultFallback !== false
                : flatEntry
                  ? flatEntry.useDefaultFallback
                  : true,
              failingSlot: { vendor: mcpBackend.vendor, model: mcpBackend.model },
            });
            const reasonText = codexModelSlugError
              ? `${toolResponseText.slice(0, 300)} ${CODEX_MODEL_SLUG_ERROR_HINT}`
              : toolResponseText.slice(0, 300);
            const instruction = fallbackChain.buildFallbackInstruction({
              workerId: slotId,
              failedProvider: mcpBackend.vendor,
              failedModel: mcpBackend.model,
              reason: reasonText,
              result,
              chainLength: chain.length,
            });

            /** @type {Record<string, unknown>} */
            const fallbackRecord = {
              event: "FallbackTriggered",
              workerId: slotId,
              slotId,
              failedModel: mcpBackend.model,
              nextModel: result.slot && result.slot.model,
              fallbackIsDefault: result.isDefault === true,
              reason: reasonText,
              at,
            };
            if (payload.session_id) fallbackRecord.sessionId = payload.session_id;
            try {
              fs.appendFileSync(activityFile, JSON.stringify(fallbackRecord) + "\n", "utf8");
            } catch { /* ignore */ }

            try {
              process.stdout.write(JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: "PostToolUse",
                  additionalContext: instruction,
                },
              }));
            } catch { /* never let output construction break the hook */ }
          }
        }
      } else if (toolName === "Task" || toolName === "Agent") {
        // Surface unseen plan-gate approvals/rejections (plan p29-t2). Only
        // this hook's own PostToolUse output for the Task/Agent tool ("Task"
        // is a deprecated alias for "Agent") - the mcp__ branch above is
        // mutually exclusive (toolName can't match both).
        //
        // Orchestrator-only: this hook also runs inside spawned subagent
        // sessions, and a subagent's own Task/Agent spawn would otherwise
        // consume the shared gate-events cursor before the orchestrator ever
        // sees those events. payload.agent_id is present only inside a
        // spawned subagent (absent/empty for the main-session orchestrator —
        // see the PreToolUse spawn guard's identical convention above), so
        // only read/advance the cursor when it is absent/empty.
        const isOrchestrator = !(typeof payload.agent_id === "string" && payload.agent_id !== "");
        const gateEvents = isOrchestrator ? readUnseenGateEvents(tycoonDir) : [];
        if (gateEvents.length > 0) {
          const additionalContext = mergeGateEventContext(gateEvents);
          if (additionalContext) {
            try {
              process.stdout.write(JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: "PostToolUse",
                  additionalContext,
                },
              }));
            } catch { /* never let output construction break the hook */ }
          }
        }
      }
    } catch {
      // Fail open: any error in fallback detection must never break the hook.
    }
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Stop: end of the main turn. Finalize the orchestrator with its per-turn
  // token delta + model so its row shows real usage (not 0).
  // -------------------------------------------------------------------------
  if (hookEvent === "Stop") {
    resetOrchestratorTurnReads(tycoonDir);
    const { tokens, cacheReadTokens, model } = captureOrchestratorTokens(payload, tycoonDir);
    /** @type {Record<string, unknown>} */
    const record = { event: hookEvent, workerId: "orchestrator", at };
    if (tokens !== undefined) record.tokens = tokens;
    if (cacheReadTokens !== undefined) record.cacheReadTokens = cacheReadTokens;
    if (model) record.model = model;
    if (delegationMode) record.delegationMode = delegationMode;
    if (payload.session_id) record.sessionId = payload.session_id;
    try {
      fs.appendFileSync(activityFile, JSON.stringify(record) + "\n", "utf8");
    } catch { /* ignore */ }
    // p15-t1: the turn is ending — evict this session's tracked fallback
    // failures from the persisted sidecar, mirroring the OpenCode plugin's
    // in-memory FallbackState.endSession on root-session idle. Fail-open:
    // any error here must never affect the Stop record already written
    // above or any other hook output.
    try {
      if (payload.session_id) {
        const stateData = loadFallbackStateFile(tycoonDir);
        if (Object.prototype.hasOwnProperty.call(stateData, payload.session_id)) {
          delete stateData[payload.session_id];
          saveFallbackStateFile(tycoonDir, stateData);
        }
      }
    } catch { /* fail open: never affect Stop's own output */ }
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Other events (UserPromptSubmit, etc.) — pass through as-is
  // -------------------------------------------------------------------------
  // UserPromptSubmit always fires at the start of a turn. If the previous turn
  // was interrupted, its sub-agents never fired SubagentStop and remain on the
  // stack, so this used to unconditionally clearActiveStack() here — but that
  // also wipes entries for subagents still genuinely in flight across a turn
  // boundary (see the ORPHAN_ENTRY_TTL_MS comment above). Use the TTL-based
  // prune instead so a live entry survives. (Still maps downstream to
  // SessionStart as before — this only changes the stack-reset side effect.)
  if (hookEvent === "UserPromptSubmit") {
    readAndPruneActiveStack(activeAgentFile, activityFile, at);

    // Session journal (opt-in, default off — see CLAUDE.md "Session Journal").
    // payload.prompt is the UserPromptSubmit hook's documented field for the
    // submitted prompt text (confirmed against the installed Claude Code
    // binary's hook-payload schema: hook_event_name/prompt/session_title).
    const journalMax = readSessionJournalEntries(tycoonDir);
    if (journalMax > 0) {
      const promptText = typeof payload.prompt === "string" ? payload.prompt : "";
      appendSessionJournalEntry(projectRoot, promptText, journalMax, at);
    }

    // Surface unseen plan-gate approvals/rejections (plan p29-t2).
    // Orchestrator-only: see the matching guard in the PostToolUse Task/Agent
    // branch above — a subagent session must never consume the shared
    // gate-events cursor.
    try {
      const isOrchestrator = !(typeof payload.agent_id === "string" && payload.agent_id !== "");
      const gateEvents = isOrchestrator ? readUnseenGateEvents(tycoonDir) : [];
      if (gateEvents.length > 0) {
        const additionalContext = mergeGateEventContext(gateEvents);
        if (additionalContext) {
          try {
            process.stdout.write(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext,
              },
            }));
          } catch { /* never let output construction break the hook */ }
        }
      }
    } catch {
      // Fail open: any error surfacing gate events must never break UserPromptSubmit.
    }
  }

  // SessionStart/SessionStop fired from INSIDE a spawned subagent's own
  // Claude Code session (payload.agent_id present) must never fall through
  // to the generic record builder below: mapHookRecord.ts maps this event
  // to {type:"SessionStart"}/{type:"SessionStop"}, which state.ts's
  // orphan-sweep reducers (~458/536) clear EVERY active worker's
  // currentDescription/liveSpawns on — a subagent merely starting/ending
  // its own turn would wipe every OTHER worker's live spawn bookkeeping.
  // Orchestrator SessionStart/SessionStop (no agent_id) is unaffected.
  if (
    (hookEvent === "SessionStart" || hookEvent === "SessionStop") &&
    typeof payload.agent_id === "string" &&
    payload.agent_id !== ""
  ) {
    process.exit(0);
  }

  /** @type {Record<string, unknown>} */
  const record = {
    event: hookEvent,
    at,
  };
  if (toolName) record.tool = toolName;
  if (delegationMode) record.delegationMode = delegationMode;
  if (payload.session_id) record.sessionId = payload.session_id;

  try {
    fs.appendFileSync(activityFile, JSON.stringify(record) + "\n", "utf8");
  } catch { /* ignore */ }

  process.exit(0);
}

// Read the hook payload from stdin via the streaming API. This is fully
// cross-platform (works on Windows and POSIX) and avoids the EAGAIN / ENOENT
// pitfalls of synchronous fd-0 or /dev/stdin reads.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => main(input));
process.stdin.on("error", () => process.exit(0));
