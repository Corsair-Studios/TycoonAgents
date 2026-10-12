/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

"use strict";

// Codex hook/notify adapter (plan p22-t3). Codex CLI 0.153.0 was found, per
// docs/codex-harness-findings.md, to fire the top-level `notify` config
// entry reliably (agent-turn-complete payload) while `[hooks.*]` never
// executed in any tested configuration. This script therefore supports
// BOTH entry points so it works today via notify and gains no-code-change
// coverage the moment hooks start firing on a future codex-cli version:
//
//   (a) notify entry point: codex invokes this script as
//       `node tycoon-codex-hook.cjs '<json>'` (payload as argv[2]) per its
//       `notify = ["node", "<script>"]` config contract. Some codex
//       versions may instead pipe the payload on stdin with no argv — both
//       are accepted (see detectEntryPoint below).
//   (b) hooks entry point: codex invokes this script as a `[hooks.<event>]`
//       command with a JSON event on stdin, using the 12 event names in
//       docs/codex-harness-findings.md (session_start, session_end,
//       user_prompt_submit, pre_tool_use, post_tool_use, permission_request,
//       pre_compact, post_compact, subagent_start, subagent_stop, stop,
//       interrupt).
//
// Detection: a notify payload always carries a "type" field (e.g.
// "agent-turn-complete") and a "thread-id" field, with no "hook_event_name"
// or bare snake_case event name field. A hooks-entry payload carries an
// event name either as payload.event / payload.hook_event_name (matching
// one of the 12 names above) or is inferred from argv[2] when codex passes
// the event name as a CLI argument alongside the JSON on stdin (observed
// shape for some hook runners). If neither shape is recognized, the record
// is dropped silently (fail-open — never crash the codex turn).
//
// Output: activity.jsonl records shaped like HookRecord (see
// src/providers/claude-code/hookRecord.ts) with provider:"codex",
// sessionId = codex thread-id, and event names translated to the Claude-hook
// vocabulary mapHookRecord.ts actually switches on: "UserPromptSubmit",
// "PreToolUse", "SubagentStop", "Stop". Events with no Claude-hook analogue
// (permission_request, pre_compact, post_compact, interrupt, session_end)
// are still written (for forward-compatible fixtures/inspection) but map to
// [] in mapHookRecord, same as any other unrecognized HookRecord.event.

const fs = require("fs");
const path = require("path");

const codexRouting = require("./codexRouting.cjs");
const codexRollout = require("./codexRollout.cjs");

/** Codex hooks.* event names -> Claude-hook vocabulary HookRecord.event. */
const HOOKS_EVENT_MAP = {
  session_start: "UserPromptSubmit",
  user_prompt_submit: "UserPromptSubmit",
  pre_tool_use: "PreToolUse",
  post_tool_use: "PreToolUse", // no PostToolUse-distinct HookRecord shape; folded into PreToolUse's WorkerActivity mapping
  subagent_start: "PreToolUse", // synthetic Task-shaped spawn, see mapCodexHooksEvent
  subagent_stop: "SubagentStop",
  stop: "Stop",
  session_end: "Stop",
  // No Claude-hook analogue; passed through verbatim so mapHookRecord's
  // default case drops them (documented as [] output), never crashing.
  permission_request: "permission_request",
  pre_compact: "pre_compact",
  post_compact: "post_compact",
  interrupt: "interrupt",
};

// Project root for this invocation. The notify entry is machine-wide, so the
// root is discovered from where Codex is running (see main()), never from this
// script's own location. null = TycoonAgents is not installed for this cwd.
let resolvedProjectRoot = null;

function getProjectRoot() {
  const override = process.env.CLAUDE_PROJECT_DIR;
  if (override && override.trim()) return override.trim();
  return resolvedProjectRoot;
}

/** Activity file for the resolved project, or null (no mkdir, no write) when none. */
function resolveActivityFile() {
  const projectRoot = getProjectRoot();
  if (!projectRoot) return null;
  return path.join(projectRoot, ".claude", "tycoon", "activity.jsonl");
}

function appendRecord(activityFile, record) {
  if (!activityFile) return;
  try {
    fs.appendFileSync(activityFile, JSON.stringify(record) + "\n", "utf8");
  } catch {
    /* never crash the codex turn over a telemetry write failure */
  }
}

// ---------------------------------------------------------------------------
// Plan p22-t5: routing policy under Codex. Codex's native spawn tool is
// exposed to a pre_tool_use hook as a tool with an inferred name like
// "spawn_agent" (no live payload has confirmed the exact shape — see
// docs/codex-harness-findings.md — so every accessor below stays tolerant:
// tool_name / tool / name for the tool identity, and
// agent / agent_role / role / description / subagent_type for who it wants
// to spawn). subagent_start (mapped from CollabAgentSpawn* per the harness
// findings) is also routed through this same path, since it is the other
// place a spawn attempt can be observed.
//
// A tiny on-disk stack (separate from the Claude-hook's own
// active-agent.json — different host, different session shape) tracks
// which codex threads are themselves bound workers, so a nested spawn
// attempt (a worker trying to spawn another worker) can be denied the same
// way hooks/delegationEnforcement.js's decideSpawn() denies it for Claude.
// ---------------------------------------------------------------------------

function resolveActiveStackFile() {
  const projectRoot = getProjectRoot();
  if (!projectRoot) return null;
  return path.join(projectRoot, ".claude", "tycoon", "active-agent-codex.json");
}

// Entries are pruned on every read once older than this TTL, mirroring
// .claude/tycoon/tycoon-claude-hook.cjs's ORPHAN_ENTRY_TTL_MS (that
// constant is not exported for require(), so this is a documented,
// independently-set copy of the same 30-minute value/rationale: a
// defensive backstop against a stack entry that never got popped — e.g. a
// subagent_stop event that never fires for a codex thread — not a tuned
// SLA, so the window stays generous to avoid evicting a merely slow
// worker's live entry).
// Duplicates .claude/tycoon/tycoon-claude-hook.cjs's ORPHAN_ENTRY_TTL_MS
// (same 30-minute value, same backstop rationale). Not centralized: that
// file is a pure CLI script with no module.exports, so importing the
// constant from it would require adding an export surface to a script that
// currently has none — left as a literal here rather than risk changing its
// CLI behaviour (plan p23-t5 follow-up 2).
const CODEX_STACK_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

function readActiveStack(stackFile) {
  if (!stackFile) return [];
  try {
    const raw = fs.readFileSync(stackFile, "utf8");
    const parsed = JSON.parse(raw);
    const stack = Array.isArray(parsed.stack) ? parsed.stack : [];
    const now = Date.now();
    return stack.filter((e) => typeof e.at !== "number" || now - e.at <= CODEX_STACK_MAX_AGE_MS);
  } catch {
    return [];
  }
}

function writeActiveStack(stackFile, stack) {
  if (!stackFile) return;
  try {
    fs.mkdirSync(path.dirname(stackFile), { recursive: true });
    fs.writeFileSync(stackFile, JSON.stringify({ stack }, null, 2), "utf8");
  } catch {
    /* fail-open: a stack write failure just means nesting can't be tracked this call */
  }
}

/** True when payload's tool identity looks like Codex's native agent-spawn tool. */
function isSpawnLikeTool(eventName, payload) {
  if (eventName === "subagent_start") return true;
  const toolName = String(payload.tool_name || payload.tool || payload.name || "");
  return /spawn_agent|spawn-agent|spawn_subagent/i.test(toolName);
}

/** Tolerant extraction of a spawn-shaped toolInput from a pre_tool_use / subagent_start payload. */
function extractSpawnToolInput(payload) {
  const src = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : payload;
  return {
    name: src.name,
    subagent_type: src.subagent_type,
    description: src.description || payload.agent_role || payload.description,
    prompt: src.prompt || payload.prompt,
    agent: src.agent,
    agent_role: src.agent_role || payload.agent_role,
    role: src.role,
  };
}

let cachedKeywordsConfig;
let cachedKeywordsError = false;
function loadKeywordsConfigFailOpen(projectRoot) {
  if (cachedKeywordsConfig || cachedKeywordsError) return cachedKeywordsConfig;
  try {
    cachedKeywordsConfig = codexRouting.loadAgentKeywords(projectRoot);
  } catch {
    // Fail-open: routing without keyword config falls back to explicit-only
    // matches plus the configured fallback_agent (absent here), rather than
    // ever crashing the codex turn over a missing/broken config file.
    cachedKeywordsError = true;
  }
  return cachedKeywordsConfig;
}

let cachedVendorMap;
function loadVendorMapFailOpen(agentsDir) {
  if (!cachedVendorMap) {
    try {
      cachedVendorMap = codexRouting.buildVendorMap(agentsDir);
    } catch {
      cachedVendorMap = new Map();
    }
  }
  return cachedVendorMap;
}

/**
 * Evaluates one spawn attempt (pre_tool_use with a spawn-like tool, or
 * subagent_start) against codexRouting.resolveCodexSpecialist, updates the
 * nested-delegation stack, and appends a ProviderError record to
 * activityFile when the resolved specialist cannot run under Codex.
 * Returns { decision: "allow"|"deny", denyOutput?: object } — denyOutput,
 * when present, is written to stdout by main() using the same
 * hookSpecificOutput/permissionDecision convention the Claude hook uses,
 * so a future hooks-enabled Codex build can act on it the same way.
 * Fail-open by construction: any internal error allows the spawn through
 * rather than ever wedging the turn.
 */
/** Must match DISPATCHER_MARKER_START in src/providers/codex/installCodexDispatcher.ts. */
const DISPATCHER_MARKER_START = "# tycoon-dispatcher: managed mcp server (do not edit by hand)";

/**
 * Detects whether the tycoon-dispatcher MCP server is configured. Checks
 * two signals: (1) TYCOON_CODEX_DISPATCHER_CONFIGURED=1 in this process's
 * env, set when the notify hook happens to inherit the MCP server's env;
 * (2) as a fallback, a bounded read of CODEX_HOME/config.toml for the
 * managed dispatcher marker, since the notify hook normally runs as
 * Codex's own child and inherits Codex's environment, not the MCP server's.
 * Reuses codexRollout.resolveCodexHome for discovery. Never throws.
 */
function isDispatcherConfigured(env = process.env) {
  if (env.TYCOON_CODEX_DISPATCHER_CONFIGURED === "1") return true;
  try {
    const codexHome = codexRollout.resolveCodexHome(env);
    if (!codexHome) return false;
    const configTomlPath = path.join(codexHome, "config.toml");
    if (!fs.existsSync(configTomlPath)) return false;
    const text = fs.readFileSync(configTomlPath, "utf8");
    return text.includes(DISPATCHER_MARKER_START);
  } catch {
    return false;
  }
}

function evaluateSpawnRouting(eventName, payload, activityFile, env = process.env) {
  try {
    const projectRoot = getProjectRoot();
    if (!projectRoot) return { decision: "allow" };
    const agentsDir = path.join(projectRoot, ".claude", "agents");
    const stackFile = resolveActiveStackFile();
    const threadId = payload["thread-id"] || payload.thread_id || payload.session_id || "";

    const stack = readActiveStack(stackFile);
    const nested = stack.some((e) => e.threadId === threadId);

    const toolInput = extractSpawnToolInput(payload);
    const keywordsConfig = loadKeywordsConfigFailOpen(projectRoot);
    const knownAgentIds = codexRouting.listKnownAgentIds(agentsDir);
    const vendorMap = loadVendorMapFailOpen(agentsDir);
    const dispatcherConfigured = isDispatcherConfigured(env);

    const result = codexRouting.resolveCodexSpecialist({
      toolInput,
      activeAgentStack: nested ? [{ agentId: "bound" }] : [],
      keywordsConfig,
      knownAgentIds,
      vendorOf: (id) => vendorMap.get(id),
      dispatcherConfigured,
    });

    if (result.denied) {
      if (result.providerError) {
        appendRecord(activityFile, { ...result.providerError, sessionId: threadId, at: Date.now() });
      } else {
        appendRecord(activityFile, {
          event: "SpawnDenied",
          provider: "codex",
          reason: result.reason || "unknown",
          sessionId: threadId,
          at: Date.now(),
        });
      }
      return {
        decision: "deny",
        denyOutput: {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              result.message ||
              (result.reason === "specialist-unavailable"
                ? `specialist "${result.workerId}" cannot run under Codex (non-OpenAI vendor, no dispatcher configured) — not substituting another model.`
                : `codex spawn denied: ${result.reason || "no matching specialist"}.`),
          },
        },
      };
    }

    // Allowed: if this is a spawn creating a new worker thread, push it onto
    // the nesting stack so a subsequent spawn FROM that thread is denied.
    const receiverThreadId = payload.receiver_thread_id || payload.receiver_agents || undefined;
    if (receiverThreadId) {
      stack.push({ threadId: receiverThreadId, agentId: result.workerId, at: Date.now() });
      writeActiveStack(stackFile, stack);
    }
    return { decision: "allow", workerId: result.workerId, source: result.source };
  } catch {
    // Fail-open: routing evaluation must never block a spawn on its own error.
    return { decision: "allow" };
  }
}

// Tracks, within this process invocation only, whether we've already
// synthesized a SessionStart for a given thread-id. Each hook invocation is
// a fresh process, so this in-memory set only guards against a single
// notify payload accidentally producing two SessionStart records within one
// call (it never can, structurally) — real de-dup of "have we EVER seen a
// SessionStart for this thread" happens by consulting activityFile itself,
// see hasSeenSessionStart.
function hasSeenSessionStart(activityFile, threadId) {
  if (!threadId) return true; // no thread id to correlate on: skip synthesis rather than guess
  try {
    if (!fs.existsSync(activityFile)) return false;
    const contents = fs.readFileSync(activityFile, "utf8");
    const lines = contents.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        rec &&
        rec.provider === "codex" &&
        rec.sessionId === threadId &&
        (rec.event === "UserPromptSubmit" || rec.event === "SessionStart")
      ) {
        return true;
      }
    }
    return false;
  } catch {
    // Fail-open: if we can't read the file to check, assume unseen so the
    // synthetic SessionStart still gets written (worst case: one extra
    // SessionStart record, never a missing/dropped Stop).
    return false;
  }
}

/**
 * True when activityFile already contains a Task-shaped PreToolUse
 * (provider "codex", tool "Task") for threadId — i.e. this child thread's
 * WorkerSpawned record has already been written by a prior notify. Guards
 * mapNotifyPayload's subagent branch the same way hasSeenSessionStart
 * guards the parent branch, so a multi-turn sub-agent thread spawns its
 * worker once instead of once per notify.
 */
function hasSeenTaskSpawn(activityFile, threadId) {
  if (!threadId) return true; // no thread id to correlate on: skip synthesis rather than guess
  try {
    if (!fs.existsSync(activityFile)) return false;
    const contents = fs.readFileSync(activityFile, "utf8");
    const lines = contents.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        rec &&
        rec.provider === "codex" &&
        rec.sessionId === threadId &&
        rec.event === "PreToolUse" &&
        rec.tool === "Task"
      ) {
        return true;
      }
    }
    return false;
  } catch {
    // Fail-open: if we can't read the file to check, assume unseen so the
    // spawn record still gets written (worst case: one duplicate spawn,
    // never a missing one).
    return false;
  }
}

/**
 * Builds a (nickname) => workerId|null matcher backed by
 * agent-keywords.json's keyword patterns, for codexRollout.resolveWorkerId's
 * priority-2 nickname fallback. Fail-open: any loader error yields a
 * matcher that always returns null (falls through to "codex-agent").
 */
function makeNicknameMatcher(projectRoot) {
  const keywordsConfig = loadKeywordsConfigFailOpen(projectRoot);
  if (!keywordsConfig || !keywordsConfig.agents) return () => null;
  return (nickname) => {
    try {
      // matchAgentFromKeywords scores a description string against each
      // agent's keyword pattern; a bare nickname (e.g. "Hegel") itself
      // never matches a keyword pattern (nicknames are arbitrary names,
      // not task descriptions) — this only helps when a future codex
      // build sets agent_nickname to something keyword-bearing (e.g. an
      // agent_role string). Absence of a match is expected and fine; the
      // caller falls back to "codex-agent".
      return codexRouting.matchAgentFromKeywords(nickname, keywordsConfig, "") || null;
    } catch {
      return null;
    }
  };
}

/**
 * Maps a notify-entry-point payload (type:"agent-turn-complete", per
 * docs/codex-harness-findings.md's captured fixture) into HookRecord[]. A
 * notify payload carries no tool/session-boundary detail on its own, so
 * this looks up the thread's rollout session_meta (plan p22-t10) to learn
 * whether the thread is a native Codex sub-agent (thread_source
 * "subagent"): when so, it emits a WorkerSpawned-shaped PreToolUse record
 * (workerId resolved from agent_path/nickname, parentId = parent_thread_id,
 * tool:"Task") followed by a SubagentStop record, matching the shape the
 * hook already uses for its synthetic Task spawn from subagent_start (see
 * mapHooksPayload above). For a "user" thread_source, or when the rollout
 * is missing/unreadable, behaviour is unchanged from before this task: a
 * synthetic UserPromptSubmit (once per thread) plus a Stop record — and a
 * single warning line is logged to stderr in the fallback case.
 */
function mapNotifyPayload(payload, activityFile, at, env = process.env) {
  const threadId = payload["thread-id"] || payload.thread_id || "";
  const records = [];

  let sessionMeta = null;
  try {
    sessionMeta = codexRollout.resolveSessionMeta(threadId, undefined, env);
  } catch {
    sessionMeta = null;
  }

  if (codexRollout.isTycoonBridgeThread(sessionMeta, env)) return [];

  if (!sessionMeta) {
    try {
      process.stderr.write(
        `tycoon-codex-hook: no rollout session_meta found for thread ${threadId || "(unknown)"}; falling back to default notify mapping.\n`,
      );
    } catch {
      /* best-effort */
    }
  }

  if (sessionMeta && sessionMeta.thread_source === "subagent") {
    const projectRoot = getProjectRoot() || process.cwd();
    const agentsDir = path.join(projectRoot, ".claude", "agents");
    let knownAgentIds;
    try {
      knownAgentIds = codexRouting.listKnownAgentIds(agentsDir);
    } catch {
      knownAgentIds = new Set();
    }
    const workerId = codexRollout.resolveWorkerId(sessionMeta, knownAgentIds, makeNicknameMatcher(projectRoot));
    const parentId =
      sessionMeta.parent_thread_id ||
      (sessionMeta.source && sessionMeta.source.subagent && sessionMeta.source.subagent.thread_spawn
        ? sessionMeta.source.subagent.thread_spawn.parent_thread_id
        : undefined);

    // A notify fires once per turn, INCLUDING each turn of a multi-turn
    // sub-agent thread (same thread-id every time). Only the first notify
    // for this child thread should spawn the worker (mirrors
    // hasSeenSessionStart's guard on the parent branch below) — a later
    // notify for a thread we've already spawned emits a WorkerActivity-shaped
    // PreToolUse instead (mapHookRecord's PreToolUse branch maps any
    // non-Task/Agent/Skill tool to WorkerActivity; toolToActivityKind's
    // default falls through to "build" for an unrecognized tool string, so
    // this never throws or needs a new ActivityKind).
    //
    // Stop semantics: the notify payload and rollout session_meta expose no
    // "is this the final turn" signal (no turn-count/completion field was
    // observed in the live fixtures), so there is no reliable way to tell an
    // intermediate turn from the terminal one. Emitting SubagentStop on
    // EVERY turn (current behavior, kept) means a still-running multi-turn
    // sub-agent is shown as closed between turns and its next notify reopens
    // it as activity-only — an imperfect but self-correcting picture. This is
    // preferred over withholding SubagentStop, which would risk a worker
    // stuck permanently "running" if a thread's actual final notify is ever
    // missed.
    if (hasSeenTaskSpawn(activityFile, threadId)) {
      records.push({ event: "PreToolUse", provider: "codex", tool: "notify", workerId, sessionId: threadId, at });
      records.push({ event: "SubagentStop", provider: "codex", workerId, sessionId: threadId, at: at + 1 });
      return records;
    }

    /** @type {Record<string, unknown>} */
    const spawnRecord = {
      event: "PreToolUse",
      provider: "codex",
      tool: "Task",
      workerId,
      sessionId: threadId,
      at,
    };
    if (parentId) spawnRecord.parentId = parentId;
    records.push(spawnRecord);
    records.push({ event: "SubagentStop", provider: "codex", workerId, sessionId: threadId, at: at + 1 });
    return records;
  }

  // "user" thread_source, or no rollout available: today's default mapping.
  if (!hasSeenSessionStart(activityFile, threadId)) {
    records.push({ event: "UserPromptSubmit", provider: "codex", sessionId: threadId, at, userPrompt: true });
  }
  // userPrompt: a person-initiated Codex turn (bridge children exit earlier); the panel hints when the harness is not Codex.
  records.push({ event: "Stop", provider: "codex", sessionId: threadId, at: at + 1, userPrompt: true });
  return records;
}

/** True when a hooks-entry payload belongs to a TycoonAgents bridge-started Codex thread. Never throws. */
function isBridgeHooksPayload(payload, env = process.env) {
  let meta = null;
  try {
    const tid = payload["thread-id"] || payload.thread_id || payload.session_id || "";
    meta = tid ? codexRollout.resolveSessionMeta(tid, undefined, env) : null;
  } catch {
    meta = null;
  }
  return codexRollout.isTycoonBridgeThread(meta, env);
}

/**
 * Maps a hooks-entry-point payload (one of the 12 documented event names)
 * into HookRecord[]. subagent_start additionally needs a tool field so
 * mapHookRecord's PreToolUse branch recognizes it as a spawn (tool:"Task");
 * every other event maps 1:1.
 */
function mapHooksPayload(eventName, payload, at) {
  const threadId = payload["thread-id"] || payload.thread_id || payload.session_id || "";
  const claudeEvent = HOOKS_EVENT_MAP[eventName];
  if (!claudeEvent) return [];

  /** @type {Record<string, unknown>} */
  const record = { event: claudeEvent, provider: "codex", sessionId: threadId, at };

  if (eventName === "subagent_start") {
    record.tool = "Task";
    record.workerId =
      payload.receiver_thread_id || payload.receiver_agents || payload.agent_nickname || undefined;
    if (payload.agent_role) record.agentDescription = String(payload.agent_role);
  } else if (eventName === "post_tool_use" || eventName === "pre_tool_use") {
    record.tool = payload.tool_name || payload.tool || "unknown";
  } else if (eventName === "subagent_stop") {
    record.workerId = payload.receiver_thread_id || payload.sender_thread_id || undefined;
  } else if (eventName === "user_prompt_submit" && threadId) {
    // A person's own prompt (rollout thread_source "user"); never a subagent thread. Lets the panel hint on a harness mismatch.
    try {
      const meta = codexRollout.resolveSessionMeta(threadId, undefined, process.env);
      if (meta && (!meta.thread_source || meta.thread_source === "user")) record.userPrompt = true;
    } catch {
      /* fail-open: no flag */
    }
  }

  // Strip undefined keys (JSON.stringify already omits them, but keep the
  // record object clean for callers/tests that inspect it directly).
  for (const k of Object.keys(record)) {
    if (record[k] === undefined) delete record[k];
  }
  return [record];
}

/**
 * Detects which entry point a raw invocation represents and returns the
 * parsed JSON payload plus an explicit hooksEventName when this is shape
 * (b). argvPayload is process.argv[2] (notify's documented single-arg JSON
 * string); stdinPayload is whatever was piped to stdin, used both as the
 * notify fallback (some codex builds pipe rather than pass an arg) and as
 * the hooks-entry payload proper.
 */
function detectEntryPoint(argvPayload, stdinPayload, argvEventName) {
  const raw = (argvPayload && argvPayload.trim()) || (stdinPayload && stdinPayload.trim()) || "";
  if (!raw) return null;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;

  // Hooks entry: event name given explicitly via argv (some hook runners
  // pass the event name as a CLI arg alongside a stdin/arg JSON body) or
  // embedded in the payload itself.
  const explicitEvent =
    argvEventName && HOOKS_EVENT_MAP[argvEventName] !== undefined
      ? argvEventName
      : payload.hook_event_name && HOOKS_EVENT_MAP[payload.hook_event_name] !== undefined
        ? payload.hook_event_name
        : payload.event && HOOKS_EVENT_MAP[payload.event] !== undefined
          ? payload.event
          : null;
  if (explicitEvent) {
    return { kind: "hooks", eventName: explicitEvent, payload };
  }

  // Notify entry: distinguishing shape per the captured fixture — a "type"
  // field (e.g. "agent-turn-complete") and a "thread-id" field, no
  // recognized hooks event name anywhere.
  if (typeof payload.type === "string" && (payload["thread-id"] || payload.thread_id)) {
    return { kind: "notify", payload };
  }

  return null;
}

/** Removes the stack entry for a subagent_stop's worker thread, if present. Fail-open. */
function popActiveStackEntry(payload) {
  try {
    const stackFile = resolveActiveStackFile();
    const workerThreadId = payload.receiver_thread_id || payload.sender_thread_id || undefined;
    if (!workerThreadId) return;
    const stack = readActiveStack(stackFile).filter((e) => e.threadId !== workerThreadId);
    writeActiveStack(stackFile, stack);
  } catch {
    /* fail-open */
  }
}

/**
 * Resolves the project root for a detected payload: env override, payload cwd,
 * rollout session_meta cwd, process.cwd() - each walked up to the nearest
 * `.claude/tycoon/`. Sets the module-level root; returns it (null = no-op).
 */
function discoverProjectRoot(payload, env = process.env) {
  const candidates = [];
  if (payload && typeof payload.cwd === "string" && payload.cwd) candidates.push(payload.cwd);
  try {
    const tid = payload && (payload["thread-id"] || payload.thread_id || payload.session_id);
    const meta = tid ? codexRollout.resolveSessionMeta(tid, undefined, env) : null;
    if (meta && typeof meta.cwd === "string" && meta.cwd) candidates.push(meta.cwd);
  } catch {
    /* fail-open */
  }
  candidates.push(process.cwd());
  resolvedProjectRoot = codexRollout.resolveProjectRoot(candidates, env);
  return resolvedProjectRoot;
}

function main() {
  // Sessions the dispatcher started for a specialist are already tracked on the delegating row.
  if (process.env.TYCOON_BRIDGE_CHILD === "1") process.exit(0);
  const at = Date.now();

  // argv[2]: notify's documented single-JSON-arg shape, OR a bare event
  // name when a hooks runner passes `<script> <event_name>` with the body
  // on stdin — try both interpretations.
  const arg2 = process.argv[2];
  let argvPayload = null;
  let argvEventName = null;
  if (arg2 !== undefined) {
    const trimmed = arg2.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      argvPayload = trimmed;
    } else if (HOOKS_EVENT_MAP[trimmed] !== undefined) {
      argvEventName = trimmed;
    }
  }

  let stdinData = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    stdinData += chunk;
  });
  const finish = () => {
    const detected = detectEntryPoint(argvPayload, stdinData, argvEventName);
    if (!detected) {
      process.exit(0);
      return;
    }

    // Machine-wide entry: find the project from where Codex runs. No
    // TycoonAgents project found -> do nothing (no write, no mkdir).
    if (!discoverProjectRoot(detected.payload)) {
      process.exit(0);
      return;
    }
    const activityFile = resolveActivityFile();

    // Routing policy under Codex (p22-t5): a spawn attempt (subagent_start,
    // or a pre_tool_use whose tool looks like Codex's native agent-spawn
    // tool) is routed/denied BEFORE the normal record mapping below, so a
    // denial short-circuits with a hookSpecificOutput deny decision the
    // same way the Claude hook's leaf-worker guard does.
    if (detected.kind === "hooks" && (detected.eventName === "subagent_start" || detected.eventName === "pre_tool_use")) {
      if (isSpawnLikeTool(detected.eventName, detected.payload)) {
        const routing = evaluateSpawnRouting(detected.eventName, detected.payload, activityFile);
        if (routing.decision === "deny") {
          try {
            process.stdout.write(JSON.stringify(routing.denyOutput));
            process.exit(0);
            return;
          } catch {
            try {
              process.stderr.write(routing.denyOutput.hookSpecificOutput.permissionDecisionReason);
            } catch {
              /* best-effort */
            }
            process.exit(2);
            return;
          }
        }
      }
    }

    if (detected.kind === "hooks" && detected.eventName === "subagent_stop") {
      popActiveStackEntry(detected.payload);
    }

    // Same bridge-thread suppression as mapNotifyPayload (notify path).
    if (detected.kind === "hooks" && isBridgeHooksPayload(detected.payload, process.env)) {
      process.exit(0);
      return;
    }

    const records =
      detected.kind === "notify"
        ? mapNotifyPayload(detected.payload, activityFile, at)
        : mapHooksPayload(detected.eventName, detected.payload, at);
    for (const record of records) appendRecord(activityFile, record);
    process.exit(0);
  };
  process.stdin.on("end", finish);
  process.stdin.on("error", finish);

  // If nothing was piped (e.g. a synchronous notify invocation with no
  // stdin at all), stdin 'end' still fires once Node detects EOF on a
  // closed/empty stream — but guard with a short fallback timer in case the
  // platform never signals it (observed on some Windows spawn shapes).
  setTimeout(() => {
    if (stdinData === "" && argvPayload !== null) finish();
  }, 200).unref();
}

module.exports = {
  HOOKS_EVENT_MAP,
  detectEntryPoint,
  mapNotifyPayload,
  mapHooksPayload,
  isBridgeHooksPayload,
  hasSeenSessionStart,
  hasSeenTaskSpawn,
  isSpawnLikeTool,
  extractSpawnToolInput,
  evaluateSpawnRouting,
  isDispatcherConfigured,
  resolveActiveStackFile,
  resolveActivityFile,
  discoverProjectRoot,
  readActiveStack,
  writeActiveStack,
  popActiveStackEntry,
  CODEX_STACK_MAX_AGE_MS,
};

if (require.main === module) {
  main();
}
