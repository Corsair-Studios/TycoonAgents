/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import type { NormalizedEvent, WorkerId } from "./events";
import { tryMapRecord } from "./mappingRegistry";

/**
 * Minimal shape state.ts needs from a raw provider record, kept local so
 * src/core never imports a specific provider (see mappingRegistry.ts).
 * Provider-specific record types (e.g. HookRecord) are structurally
 * compatible with this and can be passed directly.
 */
export interface RawRecord {
  at: number;
  sessionId?: string;
  provider?: string;
}

// Pure, host-agnostic world state (see docs/DESIGN.md section 7.3).
// Knows nothing about VS Code, Claude, or any provider.

export type WorkerState =
  | "arrive"
  | "walk"
  | "build"
  | "haul"
  | "survey"
  | "wait"
  | "celebrate"
  | "leave";

export interface Worker {
  id: WorkerId;
  role?: string;
  state: WorkerState;
  /**
   * Provider that owns this canvas entry (p22-t8 gap fix). `state.workers`
   * is still keyed by bare workerId because media/main.js and other host
   * consumers index it directly as `state.workers[agent.id]` (bare id, not
   * a composite key) -- see 110-hud-canvas-draw.js, 120-agent-dance-*.js,
   * media/main.js's `state.workers[agent.id]` reads. Every WorkerActivity /
   * TaskCompleted / WorkerStopped mutation must check this field against the
   * event's resolved provider before touching the entry, so a second
   * provider's worker reusing the same bare id can never flip a live
   * sprite's state (arrive/build/celebrate/leave) that actually belongs to a
   * different provider's run. Undefined only for legacy/never-provider-set
   * entries; treated the same as "claude-code".
   */
  provider?: string;
}

/** Per-agent activity metrics, aggregated from the normalized event stream. */
export interface AgentMetric {
  /** Agent identifier (e.g. workerId / session id). */
  id: string;
  /** Human-readable display name derived from id (kebab -> Title Case). */
  name: string;
  /** LLM model this agent runs on (e.g. "Opus", "Sonnet", "Haiku"). */
  model?: string;
  /** Backend vendor (e.g. "anthropic" | "openai" | "google"), from a generic mcp/openai-compatible backend match (p2-t5). Undefined when never reported. */
  vendor?: string;
  /** Backend cost model class ("metered" | "subscription" | "local"), from the same backend match as `vendor` (p2-t5). Undefined when never reported. */
  costModelClass?: "metered" | "subscription" | "local";
  /**
   * Originally assigned slot id (agent id) when this agent's most recent run
   * was a fallback re-dispatch, per FallbackState (src/core/fallbackChain.ts,
   * p15-t2). Cleared by the next non-fallback spawn; fallbackCount keeps history.
   */
  fallbackOf?: string;
  /** 1-based index into the fallback chain for the most recent fallback dispatch. Undefined when never fallen back. */
  fallbackDepth?: number;
  /** p32-t2: true when the most recent fallback dispatch resolved to the routing-level
   *  defaultFallback rather than the agent's own chain entry. Undefined when never fallen back
   *  or on records predating this field. */
  fallbackIsDefault?: boolean;
  /** Model the most recent fallback dispatch ran on (survives the marker being cleared). Absent when never fallen back. */
  lastFallbackModel?: string;
  /** Agent id that ran the most recent cross-agent fallback re-dispatch (e.g. "codex-reviewer" for gemini-reviewer). Absent for same-agent fallbacks. */
  lastFallbackVia?: string;
  /** Total number of fallback re-dispatches recorded for this agent. Always present (default 0) so the webview can sum it. */
  fallbackCount: number;
  /** One-line description of this agent's role. */
  description?: string;
  /** Agent tier from .md frontmatter, e.g. "lead" (Team Lead Mode). Undefined for flat agents. */
  tier?: string;
  /**
   * Id of the agent that spawned this one, inferred from the hook's active-agent
   * stack at spawn time. Approximate under concurrent spawns — see
   * docs/plan/team-lead-mode.md Phase 3. Undefined when spawned by the
   * top-level orchestrator or when hierarchy telemetry is unavailable.
   */
  parentId?: string;
  /**
   * Delegation topology ("flat" | "team_leads") active when this agent was
   * spawned (or, for the orchestrator, at its most recent SessionStop). Team
   * Lead Mode Phase 4: measurement. Undefined on legacy records written
   * before this field existed — computeDelegationModeStats treats those as
   * "flat", since pre-Phase-4 telemetry is overwhelmingly flat-mode data.
   */
  delegationMode?: string;
  status: "active" | "idle" | "done" | "error";
  /** Number of TaskCompleted events attributed to this agent. */
  taskCount: number;
  /** Number of WorkerActivity events with kind === "wire" (MCP calls). */
  mcpCount: number;
  /** Cumulative active wall-clock milliseconds (finalized on WorkerStopped). */
  activeMs: number;
  /** Cumulative tokens consumed by this agent, summed from SubagentStop events. */
  tokens: number;
  /**
   * Cumulative cache-read tokens consumed by this agent, summed separately
   * from `tokens` because cache reads price at ~0.1x the model's input rate
   * rather than full rate (see media/main.js's cost-lens math). 0 for
   * records that never carried the field.
   */
  cacheReadTokens: number;
  /**
   * Epoch-ms timestamp of when this agent last became active, or null if not
   * currently active. Exposed so the webview can show live elapsed time while
   * an agent is still working (activeMs only finalizes on WorkerStopped).
   */
  workStartAt: number | null;
  /**
   * Epoch-ms timestamp of the most recent activity event for this agent, or
   * null if the agent has never been active. Used by creditedElapsed to freeze
   * the live timer after the idle-freeze grace period.
   */
  lastActivityAt: number | null;
  /** Direct Grep/Glob calls by this agent — the delegation leak (must be delegated per CLAUDE.md). */
  directSearches: number;
  /** Direct Read calls by this agent — allowed for known files; informational, not a leak. */
  directReads: number;
  /** WorkerActivity kind "build" or "haul" (Edit/Write) performed directly by this agent. */
  directEdits: number;
  /** Task/Agent spawns credited to the orchestrator. */
  delegations: number;
  /**
   * Orchestrator-only: cumulative coordination tokens bucketed by the model
   * that was active when each SessionStop's token delta was recorded (keyed
   * by the same model id string as `model`). Lets the delegation-savings
   * counterfactual price each historical bucket at the model that actually
   * coordinated it, instead of retroactively repricing all-time history at
   * whatever model is current now (see docs/KNOWN-BUG... orchestrator model
   * switch mispricing). Undefined/empty on legacy records or non-orchestrator
   * agents; callers must fall back to the scalar `model`/`tokens` fields.
   */
  modelBreakdown?: Record<string, number>;
  /**
   * Orchestrator-only: same shape and purpose as `modelBreakdown`, but for
   * cache-read tokens. Tracked as its OWN per-model map (not folded into
   * `modelBreakdown`) because a cache read can be served under a different
   * active model than the one that originally created the cache entry, and
   * cache reads price at ~0.1x the model's input rate — mixing the two
   * buckets would make downstream per-model repricing (media/main.js's
   * resolveOrchestratorPrice and the delegation-savings counterfactual)
   * incorrect. Undefined/empty on legacy records or non-orchestrator agents.
   */
  cacheReadModelBreakdown?: Record<string, number>;
  /**
   * The most recent worker report (final assistant-message text from its
   * transcript, capped 600 chars — see HookRecord.report) attributed to
   * this agent. Overwritten on each WorkerStopped, not accumulated — only
   * the latest report is kept, matching the panel's "what did this agent
   * just do" use case rather than a full history. Undefined when no
   * SubagentStop for this agent has ever carried a report.
   */
  lastReport?: string;
  /**
   * The original (pre-truncation) character length of lastReport, so a
   * genuinely short report can be distinguished from one truncated to fit
   * the 600-char cap. Overwritten in lockstep with lastReport.
   */
  lastReportChars?: number;
  /**
   * True when this agent's `tokens` came from real vendor-reported usage
   * counts on its most recent WorkerStopped (see HookRecord.usageReported).
   * Undefined/legacy records and the native Claude Code path default to
   * true (Claude has always reported real transcript-derived usage) so the
   * Metrics tab's savings math is unaffected until a foreign-harness worker
   * (codex/gemini/kimi via hooks/tycoon-dispatcher-mcp.cjs) explicitly
   * reports otherwise. False disqualifies this agent from the savings
   * eligibility computed in media/src/main/080-packs-events.js.
   */
  usageReported?: boolean;
  /**
   * Per-spawn instance ids currently live for this agent (WorkerSpawned's
   * spawnId, pushed on spawn / removed on the matching WorkerStopped by
   * spawnId). Lets two concurrent spawns routed to the same agent id show
   * as distinct instances instead of collapsing into one active card.
   * Undefined when no event for this agent has ever carried a spawnId
   * (legacy hook records) — treated as the single-instance path: status
   * flips active/idle on every spawn/stop exactly as before this field
   * existed, regardless of liveSpawns.
   */
  liveSpawns?: string[];
  /**
   * Per-spawn start timestamps (WorkerSpawned's spawnId -> event.at), keyed
   * the same way as liveSpawns. Lets WorkerStopped credit exactly the
   * elapsed window for THAT spawn instead of crediting the whole
   * multi-spawn window from workStartAt (the first spawn's start) on every
   * stop, which double-credits overlapping concurrent spawns of one agent.
   * Undefined when no event for this agent has ever carried a spawnId
   * (legacy hook records) — treated as the single-instance path exactly as
   * before this field existed.
   */
  spawnStartAt?: Record<string, number>;
  /**
   * MCP tool calls this agent has started (PreToolUse) and not yet seen finish
   * (PostToolUse / PostToolUseFailure). While non-empty, creditedElapsed keeps
   * accruing past the idle freeze, up to IN_FLIGHT_CEILING_MS per call. Absent
   * (never an empty array) when nothing is in flight. `id` is the hook's
   * tool_use_id when it carried one, else calls are matched by tool name.
   */
  inFlightCalls?: { id?: string; tool: string; at: number; foreign?: { vendor: string; cli: string; model: string | null } }[];
  /**
   * Bash/PowerShell calls by this agent that ran another vendor's LLM CLI
   * (codex exec, gemini -p, ...). Also counted in mcpCount. Absent until the first one.
   */
  foreignCliCalls?: number;
  /** The most recent foreign-LLM CLI call (vendor, cli, model). Absent until the first one. */
  lastForeignCli?: { vendor: string; cli: string; model: string | null };
  /**
   * True when the MOST RECENT spawn for this agent had its role guessed
   * from keyword scoring (HookRecord.roleInferred) rather than an explicit
   * agent name/subagent_type match. Undefined/false otherwise.
   */
  roleInferred?: boolean;
  /**
   * The most recent spawn's own task brief (HookRecord.description /
   * WorkerSpawned.currentDescription) — distinct from the static
   * `description` field above, which is the agent's .md frontmatter
   * description. Undefined when never reported.
   */
  currentDescription?: string;
}

/**
 * Internal tracking record. Extends the public AgentMetric with a composite
 * roster key so two live harnesses that reuse the same bare workerId (e.g.
 * two "coding-specialist" runs from different providers/sessions) get
 * independent roster entries instead of overwriting each other (p22-t8).
 * `_rosterKey` is stripped before the metric is exposed publicly — see
 * toPublicMetrics — so `id` stays the bare workerId the UI already expects.
 */
interface AgentMetricInternal extends AgentMetric {
  _rosterKey: string;
}

/**
 * Composite roster key: (provider, workerId). Missing provider defaults to
 * "claude-code" so every existing single-provider record hashes to the same
 * key it always has, keeping single-provider roster output identical to
 * before.
 *
 * `sessionId` is intentionally NOT part of this key even though it rides
 * along on every NormalizedEvent (p22-t1). computeStateFromRecords's
 * cumulative "since last reset" replay (filterSessionId undefined) folds
 * records from many historical sessionIds into ONE roster entry per
 * workerId by design (see state.test.ts's "filterSessionId undefined"
 * suite) -- keying on sessionId would fragment that rollup every time a new
 * Claude Code session starts, which is not the bug this task fixes. The bug
 * is two DIFFERENT PROVIDERS (e.g. claude-code and an OpenCode-backed
 * harness) dispatching a worker under the same bare id and clobbering each
 * other's roster entry; provider alone distinguishes that case while
 * leaving same-provider, multi-session accumulation untouched.
 */
function rosterKey(workerId: string, provider?: string): string {
  return `${provider ?? "claude-code"}::${workerId}`;
}

/** Normalize a possibly-undefined event provider to its default (p22-t8). */
function resolveProvider(provider?: string): string {
  return provider ?? "claude-code";
}

export interface MetricsWorldState {
  sessionActive: boolean;
  workers: Record<WorkerId, Worker>;
  /** Count of completed tasks - drives build progression. */
  completedTasks: number;
  /**
   * Count of SubagentStop events that could not be attributed to a
   * non-orchestrator worker (empty active stack, or workerId resolving to
   * "orchestrator") — see TaskCompleted handling below. These are excluded
   * from `completedTasks` and the orchestrator's own agentMetrics taskCount
   * so a burst of unattributed SubagentStop events (e.g. Claude Code's
   * built-in Explore/Plan sub-agents, which do not carry our workerId) never
   * inflates the orchestrator's visible task count (p63-t2).
   */
  unattributedTasks: number;
  /** Per-agent metrics list, ordered by first-seen time. */
  agentMetrics: AgentMetric[];
  /** Internal: extended metric records that include workStartAt for activeMs computation. */
  _agentMetricsInternal: AgentMetricInternal[];
  /** Freeze live timer after this many ms with no activity (default 180000 = 3 min). */
  idleFreezeMs: number;
  /** Most recent hook activity timestamp (epoch ms) across all agents, or null if none. */
  lastActivityAt?: number | null;
  /**
   * Set when the main session died on an API error / usage limit
   * (OrchestratorLimit); cleared by the next orchestrator activity
   * (SessionStart or an orchestrator WorkerActivity after `at`).
   */
  orchestratorLimit?: { kind: string; at: number; resetHint?: string; resetAt?: number; message?: string };
  /** Newest CodexSandboxUnavailable record (epoch ms): Codex's Windows sandbox could not start. */
  codexSandboxUnavailableAt?: number;
  /** Newest Codex worker run that finished with vendor-reported usage (a real success). */
  lastCodexWorkerOkAt?: number;
  /** Internal: ids seeded via WorkerRegistered (the installed .claude/agents roster). Absent until a roster is seeded. */
  _registeredIds?: string[];
  /** Internal: true once the host signalled (RosterSeeded) that the full roster was seeded. Stale-marker clearing waits for it. */
  _rosterSeeded?: boolean;
}

/** Override map: workerId values that should not use the default title-case formatter. */
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  "primary-agent": "Wildcard Agent",
};

/** Convert a workerId / kebab-case string to Title Case display name. */
function toDisplayName(id: string): string {
  if (id in DISPLAY_NAME_OVERRIDES) {
    return DISPLAY_NAME_OVERRIDES[id];
  }
  return id
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** How long a limit with no parseable resetAt stays shown (ms). */
export const ORCHESTRATOR_LIMIT_FALLBACK_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Pure: is this orchestratorLimit still current at `now`? It expires once
 * resetAt has passed, or ORCHESTRATOR_LIMIT_FALLBACK_TTL_MS after `at` when
 * resetAt is absent. For the UI to hide stale limits between events.
 */
export function isOrchestratorLimitActive(
  limit: { at: number; resetAt?: number } | undefined,
  now: number,
): boolean {
  if (!limit) return false;
  return limit.resetAt !== undefined ? now < limit.resetAt : now - limit.at < ORCHESTRATOR_LIMIT_FALLBACK_TTL_MS;
}

/**
 * Pure: should the Codex sandbox warning show? True when a
 * CodexSandboxUnavailable record exists and no Codex worker run has finished
 * successfully (with vendor-reported usage) since.
 */
export function isCodexSandboxWarningActive(
  state: { codexSandboxUnavailableAt?: number; lastCodexWorkerOkAt?: number } | undefined,
): boolean {
  if (!state || state.codexSandboxUnavailableAt === undefined) return false;
  return state.lastCodexWorkerOkAt === undefined || state.lastCodexWorkerOkAt < state.codexSandboxUnavailableAt;
}

export const CODEX_SANDBOX_WARNING_MESSAGE =
  "Codex's Windows sandbox couldn't start on this machine, so Codex workers can't run commands. Repair it in Codex, or set windows.sandbox = \"unelevated\" in your Codex config.";

/** The Settings warning text while the Codex sandbox warning is active, else undefined. */
export function codexSandboxWarning(
  state: { codexSandboxUnavailableAt?: number; lastCodexWorkerOkAt?: number } | undefined,
): string | undefined {
  return isCodexSandboxWarningActive(state) ? CODEX_SANDBOX_WARNING_MESSAGE : undefined;
}

export function initialWorldState(limits?: { idleFreezeMs?: number }): MetricsWorldState {
  return {
    sessionActive: false,
    workers: {},
    completedTasks: 0,
    unattributedTasks: 0,
    agentMetrics: [],
    _agentMetricsInternal: [],
    idleFreezeMs: limits?.idleFreezeMs ?? 180000,
    lastActivityAt: null,
  };
}

/** Agent id used for the main session / coordinator row. */
const ORCHESTRATOR_ID = "orchestrator";

const ACTIVITY_TO_STATE: Record<string, WorkerState> = {
  survey: "survey",
  build: "build",
  haul: "haul",
  wire: "build",
  shell: "build",
};

// ---------------------------------------------------------------------------
// AgentMetric helpers (pure, no side-effects)
// ---------------------------------------------------------------------------

/** Find the internal metric for a (provider, workerId) pair, or undefined. */
function findMetric(
  internals: AgentMetricInternal[],
  workerId: string,
  provider?: string,
): AgentMetricInternal | undefined {
  const key = rosterKey(workerId, provider);
  return internals.find((m) => m._rosterKey === key);
}

/**
 * Return a new internals array with the metric for (provider, workerId)
 * replaced/inserted. `id` on the resulting metric is always the bare
 * workerId (never the composite key) so display names, metrics ids shown to
 * the UI, and single-provider behaviour stay identical to before.
 *
 * Accepts (and ignores, for keying purposes) an optional `sessionId` -- call
 * sites pass `event.sessionId` through for future use and readability, but
 * it does not participate in `rosterKey`; see rosterKey's doc comment.
 */
function upsertMetric(
  internals: AgentMetricInternal[],
  workerId: string,
  updater: (m: AgentMetricInternal) => AgentMetricInternal,
  provider?: string,
  _sessionId?: string,
): AgentMetricInternal[] {
  const key = rosterKey(workerId, provider);
  const existing = findMetric(internals, workerId, provider);
  if (existing) {
    return internals.map((m) => (m._rosterKey === key ? updater(m) : m));
  }
  // Create a fresh metric entry then apply the updater.
  const fresh: AgentMetricInternal = {
    id: workerId,
    _rosterKey: key,
    name: toDisplayName(workerId),
    model: undefined,
    vendor: undefined,
    costModelClass: undefined,
    fallbackOf: undefined,
    fallbackDepth: undefined,
    fallbackIsDefault: undefined,
    fallbackCount: 0,
    description: undefined,
    tier: undefined,
    parentId: undefined,
    delegationMode: undefined,
    status: "idle",
    taskCount: 0,
    mcpCount: 0,
    activeMs: 0,
    tokens: 0,
    cacheReadTokens: 0,
    workStartAt: null,
    lastActivityAt: null,
    directSearches: 0,
    directReads: 0,
    directEdits: 0,
    delegations: 0,
    modelBreakdown: undefined,
    cacheReadModelBreakdown: undefined,
    lastReport: undefined,
    // usageReported deliberately OMITTED here (not even as `undefined`):
    // some tests deepEqual a freshly-computed AgentMetric against a literal
    // that predates this field, and Node's assert.deepEqual treats an
    // explicit `key: undefined` as a different shape than the key being
    // absent. The WorkerStopped case below only adds the key when an event
    // actually carries it; readers must treat a genuinely absent key as
    // true (see AgentMetric.usageReported's doc comment).
  };
  return [...internals, updater(fresh)];
}

/** Produce the public AgentMetric list (workStartAt is now part of the public shape). */
function toPublicMetrics(internals: AgentMetricInternal[]): AgentMetric[] {
  // Internals stay keyed by (provider, workerId) so live per-provider state
  // never clobbers across harnesses (p22-t8), but the PUBLIC list is one row
  // per canonical agent id: the same agent reached through claude-code and a
  // foreign harness (codex/opencode) must not show as two Metrics rows.
  const out: AgentMetric[] = [];
  const byId = new Map<string, number>();
  for (const { _rosterKey, ...rest } of internals) {
    const canon = rest.id;
    const row: AgentMetric = { ...rest };
    const at = byId.get(canon);
    if (at === undefined) {
      byId.set(canon, out.length);
      out.push(row);
    } else {
      out[at] = mergeMetricRows(out[at]!, row);
    }
  }
  return out;
}

function sumMaps(a?: Record<string, number>, b?: Record<string, number>): Record<string, number> | undefined {
  if (!a && !b) return undefined;
  const r: Record<string, number> = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b ?? {})) r[k] = (r[k] ?? 0) + v;
  return r;
}

/** Fold row b (another provider's entry for the same agent) into a; totals are summed, nothing is dropped. */
function mergeMetricRows(a: AgentMetric, b: AgentMetric): AgentMetric {
  const starts = [a.workStartAt, b.workStartAt].filter((x): x is number => x !== null);
  const lasts = [a.lastActivityAt, b.lastActivityAt].filter((x): x is number => x !== null);
  const live = a.status === "active" || b.status === "active";
  // Per-run descriptive fields come from the row that is active, else the
  // most recently active one (not blindly the first-seen row).
  const pickB = a.status !== "active" && (b.status === "active" || (b.lastActivityAt ?? -1) > (a.lastActivityAt ?? -1));
  const cur = pickB ? b : a;
  const oth = pickB ? a : b;
  const merged: AgentMetric = {
    ...b,
    ...a,
    currentDescription: cur.currentDescription ?? oth.currentDescription,
    roleInferred: cur.roleInferred ?? oth.roleInferred,
    lastReportChars: cur.lastReportChars ?? oth.lastReportChars,
    model: a.model ?? b.model,
    vendor: a.vendor ?? b.vendor,
    costModelClass: a.costModelClass ?? b.costModelClass,
    description: a.description ?? b.description,
    tier: a.tier ?? b.tier,
    parentId: a.parentId ?? b.parentId,
    delegationMode: a.delegationMode ?? b.delegationMode,
    lastReport: cur.lastReport ?? oth.lastReport,
    status: live ? "active" : a.status === "error" || b.status === "error" ? "error" : a.status,
    fallbackCount: a.fallbackCount + b.fallbackCount,
    taskCount: a.taskCount + b.taskCount,
    mcpCount: a.mcpCount + b.mcpCount,
    activeMs: a.activeMs + b.activeMs,
    tokens: a.tokens + b.tokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    workStartAt: starts.length ? Math.min(...starts) : null,
    lastActivityAt: lasts.length ? Math.max(...lasts) : null,
    directSearches: a.directSearches + b.directSearches,
    directReads: a.directReads + b.directReads,
    directEdits: a.directEdits + b.directEdits,
    delegations: a.delegations + b.delegations,
  };
  const mb = sumMaps(a.modelBreakdown, b.modelBreakdown);
  if (mb) merged.modelBreakdown = mb;
  const cb = sumMaps(a.cacheReadModelBreakdown, b.cacheReadModelBreakdown);
  if (cb) merged.cacheReadModelBreakdown = cb;
  if (a.liveSpawns || b.liveSpawns) merged.liveSpawns = [...(a.liveSpawns ?? []), ...(b.liveSpawns ?? [])];
  if (a.spawnStartAt || b.spawnStartAt) merged.spawnStartAt = { ...(b.spawnStartAt ?? {}), ...(a.spawnStartAt ?? {}) };
  if (a.foreignCliCalls || b.foreignCliCalls) merged.foreignCliCalls = (a.foreignCliCalls ?? 0) + (b.foreignCliCalls ?? 0);
  if (a.lastForeignCli || b.lastForeignCli) merged.lastForeignCli = a.lastForeignCli ?? b.lastForeignCli;
  if (a.inFlightCalls || b.inFlightCalls) merged.inFlightCalls = [...(a.inFlightCalls ?? []), ...(b.inFlightCalls ?? [])];
  if (a.usageReported === false || b.usageReported === false) merged.usageReported = false;
  return merged;
}

/** Compute how many ms have elapsed since workStartAt (0 if not active). */
function elapsedSince(workStartAt: number | null, now: number): number {
  return workStartAt !== null ? Math.max(0, now - workStartAt) : 0;
}

/** Ceiling on how long ONE in-flight tool call keeps a run accruing past the idle freeze (30 min). */
export const IN_FLIGHT_CEILING_MS = 30 * 60 * 1000;

/**
 * Compute credited elapsed time for an active stretch.
 *
 * - There is no per-run hard cap: a run accrues for as long as it stays active.
 * - Idle freeze: "now" is clamped to lastActivityAt + idleFreezeMs so idle gaps
 *   don't inflate the total.
 * - Exception: while an MCP tool call is in flight (started, no matching
 *   PostToolUse yet) the run keeps accruing until that call's start +
 *   IN_FLIGHT_CEILING_MS, after which it freezes as idle again.
 *
 * media/src/main/080-packs-events.js liveMsFor mirrors this exactly.
 */
export function creditedElapsed(
  workStartAt: number | null,
  lastActivityAt: number | null,
  now: number,
  idleFreezeMs: number,
  inFlightCalls?: readonly { at: number }[] | null,
): number {
  if (workStartAt === null) return 0;
  if (lastActivityAt === null) return Math.max(0, now - workStartAt);
  let until = lastActivityAt + idleFreezeMs;
  if (inFlightCalls) {
    for (const c of inFlightCalls) until = Math.max(until, c.at + IN_FLIGHT_CEILING_MS);
  }
  return Math.max(0, Math.min(now, until) - workStartAt);
}

/** In-flight calls younger than the ceiling; ones whose PostToolUse never arrived are dropped. */
function pruneInFlight(calls: NonNullable<AgentMetric["inFlightCalls"]> | undefined, now: number) {
  return calls?.filter((c) => now - c.at <= IN_FLIGHT_CEILING_MS);
}

/** Drop the in-flight list (key removed, not emptied) from a metric. */
function withoutInFlight<T extends AgentMetric>(m: T): T {
  if (m.inFlightCalls === undefined) return m;
  const { inFlightCalls: _drop, ...rest } = m;
  return rest as T;
}

/**
 * In-flight bookkeeping for a WorkerActivity. A foreign-CLI call has no end record (no PostToolUse
 * hook runs for shell commands), so it ends when the same worker's next activity arrives. MCP calls
 * stay until WorkerToolDone retires them.
 */
function withActivityInFlight<T extends AgentMetric>(next: T, prev: AgentMetric, event: Extract<NormalizedEvent, { type: "WorkerActivity" }>): T {
  const live = (pruneInFlight(prev.inFlightCalls, event.at) ?? []).filter((c) => !c.foreign);
  const isMcpCall = event.detail !== undefined && event.detail.startsWith("mcp__");
  const added =
    isMcpCall || event.foreignCli !== undefined
      ? [{
          ...(event.toolUseId !== undefined ? { id: event.toolUseId } : {}),
          tool: event.detail ?? "",
          at: event.at,
          ...(event.foreignCli !== undefined ? { foreign: event.foreignCli } : {}),
        }]
      : [];
  const all = [...live, ...added];
  return all.length > 0 ? { ...next, inFlightCalls: all } : withoutInFlight(next);
}

// Pure reducer: fold a normalized event into the world state.
// NOTE: skeleton - mappings are intentionally minimal; tune per docs/DESIGN.md section 3.
export function applyEvent(state: MetricsWorldState, event: NormalizedEvent): MetricsWorldState {
  const next = applyEventCore(state, event);
  const registeredBase = next._registeredIds ?? state._registeredIds;
  const registered =
    event.type === "WorkerRegistered" && !(registeredBase ?? []).includes(event.workerId)
      ? [...(registeredBase ?? []), event.workerId]
      : registeredBase;
  const seeded = event.type === "RosterSeeded" ? true : state._rosterSeeded === true;
  if (!registered || registered.length === 0 || !seeded) {
    return registered !== next._registeredIds || seeded !== next._rosterSeeded
      ? { ...next, ...(registered ? { _registeredIds: registered } : {}), ...(seeded ? { _rosterSeeded: true } : {}) }
      : next;
  }
  // Once a roster is seeded, an agent whose file no longer exists (deleted
  // since its last fallback) must not keep an amber "(fb)" marker forever.
  // Only the marker is cleared; the metrics row and fallbackCount stay.
  const stale = (m: AgentMetric): boolean =>
    m.fallbackOf !== undefined && m.id !== ORCHESTRATOR_ID && m.id !== "primary-agent" && !registered.includes(m.id);
  const clear = <T extends AgentMetric>(m: T): T =>
    stale(m) ? { ...m, fallbackOf: undefined, fallbackDepth: undefined, fallbackIsDefault: undefined } : m;
  const anyStale = next._agentMetricsInternal.some(stale);
  return {
    ...next,
    _registeredIds: registered,
    _rosterSeeded: true,
    ...(anyStale
      ? {
          _agentMetricsInternal: next._agentMetricsInternal.map(clear),
          agentMetrics: next.agentMetrics.map(clear),
        }
      : {}),
  };
}

function applyEventCore(state: MetricsWorldState, event: NormalizedEvent): MetricsWorldState {
  // Refresh the top-level "most recent hook activity" timestamp before branching,
  // so EVERY event type (not just the ones with agent-specific handling) keeps it
  // current -- this is what a downstream "plan stalled" advisory reads. Every
  // NormalizedEvent carries `at` (see core/events.ts), but guard defensively in
  // case a future variant ever omits it.
  if (typeof event.at === "number") {
    state = { ...state, lastActivityAt: Math.max(state.lastActivityAt ?? 0, event.at) };
  }
  if (
    state.orchestratorLimit &&
    event.type !== "OrchestratorLimit" &&
    event.at > state.orchestratorLimit.at &&
    (!isOrchestratorLimitActive(state.orchestratorLimit, event.at) || event.type === "SessionStart" || (event.type === "WorkerActivity" && event.workerId === ORCHESTRATOR_ID))
  ) {
    const { orchestratorLimit: _cleared, ...rest } = state;
    state = rest;
  }
  if (event.type === "WorkerStopped" && event.provider === "codex" && event.ok === true) {
    state = { ...state, lastCodexWorkerOkAt: Math.max(state.lastCodexWorkerOkAt ?? 0, event.at) };
  }
  switch (event.type) {
    case "CodexSandboxUnavailable":
      return { ...state, codexSandboxUnavailableAt: Math.max(state.codexSandboxUnavailableAt ?? 0, event.at) };
    case "OrchestratorLimit":
      return {
        ...state,
        orchestratorLimit: {
          kind: event.kind,
          at: event.at,
          ...(event.resetHint !== undefined ? { resetHint: event.resetHint } : {}),
          ...(event.resetAt !== undefined ? { resetAt: event.resetAt } : {}),
          ...(event.message !== undefined ? { message: event.message } : {}),
        },
      };
    case "SessionStart": {
      // The orchestrator (main session) is working for the whole turn — light it
      // up the moment the user submits, covering the thinking phase before any
      // tool call. Only the canvas worker depends on a spawn; the metric does not.
      const afterOrchestrator = upsertMetric(
        state._agentMetricsInternal,
        ORCHESTRATOR_ID,
        (m) => ({
          ...withoutInFlight(m),
          status: "active" as const,
          activeMs: m.activeMs + creditedElapsed(m.workStartAt, m.lastActivityAt, event.at, state.idleFreezeMs, m.inFlightCalls),
          workStartAt: event.at,
          lastActivityAt: event.at,
        }),
        event.provider,
        event.sessionId,
      );
      // Sweep: clear any non-orchestrator agents that were left active by a prior
      // dead turn. Do NOT credit activeMs — the workStartAt is from a prior turn
      // and the elapsed time is untrustworthy.
      const nextInternals = afterOrchestrator.map((m) =>
        m.id !== ORCHESTRATOR_ID && (m.status === "active" || m.workStartAt !== null)
          ? {
              ...withoutInFlight(m),
              status: "idle" as const,
              workStartAt: null,
              // Clear any spawn-instance bookkeeping left over from the dead
              // turn — an orphaned liveSpawns/currentDescription would
              // otherwise produce a false "xN" badge/phantom canvas clone on
              // the NEXT real spawn for this agent id. Conditional so an
              // agent that never had these fields (legacy fixtures) is
              // untouched.
              ...(m.liveSpawns !== undefined ? { liveSpawns: [] } : {}),
              ...(m.spawnStartAt !== undefined ? { spawnStartAt: {} } : {}),
              ...(m.currentDescription !== undefined ? { currentDescription: undefined } : {}),
            }
          : m,
      );
      return {
        ...state,
        sessionActive: true,
        _agentMetricsInternal: nextInternals,
        agentMetrics: toPublicMetrics(nextInternals),
      };
    }

    case "SessionStop": {
      // Turn ended: finalize the orchestrator's active time and fold in the
      // per-turn token delta + model carried on the Stop event.
      const afterOrchestrator = upsertMetric(
        state._agentMetricsInternal,
        ORCHESTRATOR_ID,
        (m) => {
          const tokenDelta = event.tokens ?? 0;
          const cacheReadDelta = event.cacheReadTokens ?? 0;
          // Attribute this delta to whichever model actually coordinated it
          // (the model on THIS event, falling back to the entry's prior
          // model) rather than whatever model is current when the panel
          // later reprices history -- this is what lets the delegation tab's
          // counterfactual price each bucket correctly even after the user
          // switches the orchestrator's session model.
          const activeModel = event.model ?? m.model;
          const nextBreakdown =
            tokenDelta > 0 && activeModel
              ? {
                  ...m.modelBreakdown,
                  [activeModel]: (m.modelBreakdown?.[activeModel] ?? 0) + tokenDelta,
                }
              : m.modelBreakdown;
          // Cache reads get their OWN per-model breakdown (see AgentMetric's
          // cacheReadModelBreakdown doc) since they price at ~0.1x rather
          // than full rate and may be served under a different active model
          // than the one that created the cache entry.
          const nextCacheReadBreakdown =
            cacheReadDelta > 0 && activeModel
              ? {
                  ...m.cacheReadModelBreakdown,
                  [activeModel]: (m.cacheReadModelBreakdown?.[activeModel] ?? 0) + cacheReadDelta,
                }
              : m.cacheReadModelBreakdown;
          return {
            ...withoutInFlight(m),
            status: "idle" as const,
            activeMs: m.activeMs + creditedElapsed(m.workStartAt, m.lastActivityAt, event.at, state.idleFreezeMs, m.inFlightCalls),
            tokens: m.tokens + tokenDelta,
            cacheReadTokens: m.cacheReadTokens + cacheReadDelta,
            model: event.model ?? m.model,
            delegationMode: event.delegationMode ?? m.delegationMode,
            workStartAt: null,
            modelBreakdown: nextBreakdown,
            cacheReadModelBreakdown: nextCacheReadBreakdown,
          };
        },
        event.provider,
        event.sessionId,
      );
      // Sweep: finalize any non-orchestrator agents that are still active due to
      // a missed SubagentStop (e.g. process died before the hook fired).
      const nextInternals = afterOrchestrator.map((m) =>
        m.id !== ORCHESTRATOR_ID && (m.status === "active" || m.workStartAt !== null)
          ? {
              ...withoutInFlight(m),
              status: "idle" as const,
              activeMs: m.activeMs + creditedElapsed(m.workStartAt, m.lastActivityAt, event.at, state.idleFreezeMs, m.inFlightCalls),
              workStartAt: null,
              // Same orphan-sweep cleanup as SessionStart's sweep above — see
              // its comment.
              ...(m.liveSpawns !== undefined ? { liveSpawns: [] } : {}),
              ...(m.spawnStartAt !== undefined ? { spawnStartAt: {} } : {}),
              ...(m.currentDescription !== undefined ? { currentDescription: undefined } : {}),
            }
          : m,
      );
      return {
        ...state,
        sessionActive: false,
        _agentMetricsInternal: nextInternals,
        agentMetrics: toPublicMetrics(nextInternals),
      };
    }

    case "WorkerRegistered": {
      // Seed (or enrich) an idle roster entry. Never activates the agent and
      // never disturbs stats that real activity may have already accumulated.
      const nextInternals = upsertMetric(
        state._agentMetricsInternal,
        event.workerId,
        (m) => ({
          ...m,
          name:
            event.workerId in DISPLAY_NAME_OVERRIDES
              ? DISPLAY_NAME_OVERRIDES[event.workerId]
              : event.name ?? m.name,
          model: event.model ?? m.model,
          description: event.description ?? m.description,
        }),
        event.provider,
        event.sessionId,
      );
      return {
        ...state,
        _agentMetricsInternal: nextInternals,
        agentMetrics: toPublicMetrics(nextInternals),
      };
    }

    case "WorkerSpawned": {
      // state.workers is keyed by bare workerId because host consumers (e.g.
      // media/main.js's `state.workers[agent.id]`) index it directly by the
      // bare id, not a composite key (p22-t8). If a different provider
      // reuses the same bare workerId while an existing entry from another
      // provider is still live, do NOT clobber that entry -- park the new
      // one under a composite key instead so it exists for bookkeeping but
      // can never be looked up (and thus never rendered/mutated) via the
      // bare id path.
      const spawnProvider = resolveProvider(event.provider);
      const existingSpawnWorker = state.workers[event.workerId];
      const spawnWorkerKey =
        !existingSpawnWorker || resolveProvider(existingSpawnWorker.provider) === spawnProvider
          ? event.workerId
          : rosterKey(event.workerId, spawnProvider);
      const nextWorkers = {
        ...state.workers,
        [spawnWorkerKey]: { id: event.workerId, role: event.role, state: "arrive" as WorkerState, provider: spawnProvider },
      };
      // Ensure a metric entry exists for this agent and mark it active.
      const afterChild = upsertMetric(
        state._agentMetricsInternal,
        event.workerId,
        (m) => ({
          ...m,
          // If this workerId has a display-name override (e.g. primary-agent
          // -> "Wildcard Agent"), it always wins over both a stale event.name
          // (a spawn record carrying the old agent-file H1, whether live or
          // replayed from a persisted activity log) and any previously
          // persisted metric name. Otherwise, an explicit event name wins;
          // failing that, keep the computed name.
          name:
            event.workerId in DISPLAY_NAME_OVERRIDES
              ? DISPLAY_NAME_OVERRIDES[event.workerId]
              : event.name ?? m.name,
          model: event.model ?? m.model,
          description: event.description ?? m.description,
          tier: event.tier ?? m.tier,
          parentId: event.parentId ?? m.parentId,
          delegationMode: event.delegationMode ?? m.delegationMode,
          vendor: event.vendor ?? m.vendor,
          costModelClass: event.costModelClass ?? m.costModelClass,
          // The fallback marker describes the most recent run only. A fallback
          // spawn sets it; a NEW non-fallback spawn clears it. A non-fallback
          // spawn re-reporting a spawnId already live (same run) keeps it, so
          // a duplicate start record can never undo the run's own fallback.
          // fallbackCount stays cumulative history.
          ...(event.fallbackOf !== undefined
            ? {
                fallbackOf: event.fallbackOf,
                fallbackDepth: event.fallbackDepth ?? m.fallbackDepth,
                fallbackIsDefault: event.fallbackIsDefault,
                ...(event.fallbackOf === event.workerId && (event.fallbackModel ?? event.model) !== undefined
                  ? { lastFallbackModel: event.fallbackModel ?? event.model }
                  : {}),
              }
            : event.spawnId !== undefined && (m.liveSpawns ?? []).includes(event.spawnId)
              ? {}
              : { fallbackOf: undefined, fallbackDepth: undefined, fallbackIsDefault: undefined }),
          fallbackCount: event.fallbackOf !== undefined && event.fallbackOf === event.workerId ? m.fallbackCount + 1 : m.fallbackCount,
          status: "active" as const,
          // A new run never shows an older run's note. A duplicate start record
          // for a spawnId already live (same run) keeps it.
          ...(event.spawnId !== undefined && (m.liveSpawns ?? []).includes(event.spawnId)
            ? {}
            : { lastReport: undefined, lastReportChars: undefined }),
          workStartAt: m.workStartAt ?? event.at,
          lastActivityAt: event.at,
          // liveSpawns: only touched when this event carries a spawnId — a
          // legacy event (no spawnId) leaves it exactly as it was (undefined
          // stays undefined), so old fixtures/deepEqual tests are unaffected.
          ...(event.spawnId !== undefined
            ? {
                liveSpawns: [...(m.liveSpawns ?? []), event.spawnId],
                spawnStartAt: { ...(m.spawnStartAt ?? {}), [event.spawnId]: event.at },
              }
            : {}),
          ...(event.roleInferred !== undefined ? { roleInferred: event.roleInferred } : {}),
          ...(event.currentDescription !== undefined && event.currentDescription.trim() !== ""
            ? { currentDescription: event.currentDescription }
            : {}),
        }),
        event.provider,
        event.sessionId,
      );
      // Cross-agent re-dispatch: the spawned agent (event.workerId) is running
      // as a fallback for ANOTHER slot (event.fallbackOf), so that slot's row
      // gets the marker too. It clears on the slot's own next non-fallback
      // spawn, exactly like a same-agent fallback marker.
      const crossFallbackSlot =
        event.fallbackOf !== undefined && event.fallbackOf !== event.workerId ? event.fallbackOf : undefined;
      const afterSlot =
        crossFallbackSlot !== undefined
          ? upsertMetric(
              afterChild,
              crossFallbackSlot,
              (m) => ({
                ...m,
                fallbackOf: crossFallbackSlot,
                fallbackDepth: event.fallbackDepth ?? m.fallbackDepth,
                fallbackIsDefault: event.fallbackIsDefault,
                lastFallbackModel: event.fallbackModel ?? event.model ?? m.lastFallbackModel,
                lastFallbackVia: event.workerId,
                fallbackCount: m.fallbackCount + 1,
              }),
              event.provider,
              event.sessionId,
            )
          : afterChild;
      const isRealDelegation = event.role === "Task" || event.role === "Agent";
      const nextInternals = isRealDelegation
        ? upsertMetric(
            afterSlot,
            ORCHESTRATOR_ID,
            (m) => ({
              ...m,
              delegations: m.delegations + 1,
              // Keep the orchestrator "alive" when it delegates. This liveness
              // previously rode on a spawn-time TaskCompleted for the
              // orchestrator, which was removed to stop double-counting tasks
              // (see mapHookRecord's Task/Agent branch).
              status: "active" as const,
              workStartAt: m.workStartAt ?? event.at,
              lastActivityAt: event.at,
            }),
            event.provider,
            event.sessionId,
          )
        : afterSlot;
      return {
        ...state,
        workers: nextWorkers,
        _agentMetricsInternal: nextInternals,
        agentMetrics: toPublicMetrics(nextInternals),
      };
    }

    case "WorkerActivity": {
      // Update the worker's canvas state only if it exists, but ALWAYS update the
      // metric — seeded agents (and the orchestrator) have metrics with no worker.
      // Only mutate the canvas entry when it belongs to this event's
      // provider -- otherwise a different provider's worker sharing the
      // same bare workerId would flip a live sprite that isn't theirs
      // (p22-t8 gap fix). agentMetrics rows (below) are already correctly
      // separated by rosterKey; this guard does the same for state.workers.
      const activityProvider = resolveProvider(event.provider);
      const worker = state.workers[event.workerId];
      const nextWorkers =
        worker && resolveProvider(worker.provider) === activityProvider
          ? {
              ...state.workers,
              [event.workerId]: { ...worker, state: ACTIVITY_TO_STATE[event.kind] ?? "build" },
            }
          : state.workers;
      // Update metrics: increment mcpCount for wire activity; keep/start active timer.
      const isMcp = event.kind === "wire" || event.foreignCli !== undefined;
      // For survey activity, split the genuinely-forbidden Grep/Glob (the delegation
      // leak) from a plain Read, which CLAUDE.md allows directly for known files.
      const isSurvey = event.kind === "survey";
      const isForbiddenSearch = isSurvey && (event.detail === "Grep" || event.detail === "Glob");
      const isRead = isSurvey && !isForbiddenSearch;
      const nextInternals = upsertMetric(
        state._agentMetricsInternal,
        event.workerId,
        (m) => withActivityInFlight({
          ...m,
          status: "active" as const,
          mcpCount: isMcp ? m.mcpCount + 1 : m.mcpCount,
          directSearches: isForbiddenSearch ? m.directSearches + 1 : m.directSearches,
          directReads: isRead ? m.directReads + 1 : m.directReads,
          directEdits: (event.kind === "build" || event.kind === "haul") ? m.directEdits + 1 : m.directEdits,
          vendor: event.vendor ?? m.vendor,
          costModelClass: event.costModelClass ?? m.costModelClass,
          // Start timer if not already running.
          workStartAt: m.workStartAt ?? event.at,
          lastActivityAt: event.at,
          // A call to another LLM through its CLI counts like an MCP provider call.
          ...(event.foreignCli !== undefined
            ? { foreignCliCalls: (m.foreignCliCalls ?? 0) + 1, lastForeignCli: event.foreignCli }
            : {}),
        }, m, event),
        event.provider,
        event.sessionId,
      );
      return {
        ...state,
        workers: nextWorkers,
        _agentMetricsInternal: nextInternals,
        agentMetrics: toPublicMetrics(nextInternals),
      };
    }

    case "WorkerToolDone": {
      // PostToolUse / PostToolUseFailure for an MCP call: retire the matching
      // in-flight entry (by tool_use_id when both sides have one, else the
      // oldest entry for the same tool). Never starts a timer or flips status.
      const nextInternals = upsertMetric(
        state._agentMetricsInternal,
        event.workerId,
        (m) => {
          // A finished MCP call also means the worker moved on, which ends any foreign-CLI call.
          const calls = pruneInFlight(m.inFlightCalls, event.at)?.filter((c) => !c.foreign);
          if (!calls || calls.length === 0) return m.inFlightCalls ? withoutInFlight(m) : m;
          let idx = event.toolUseId !== undefined ? calls.findIndex((c) => c.id === event.toolUseId) : -1;
          if (idx < 0) idx = calls.findIndex((c) => c.tool === event.tool && (event.toolUseId === undefined || c.id === undefined));
          if (idx < 0) return m;
          const remaining = calls.filter((_, i) => i !== idx);
          const base = remaining.length > 0 ? { ...m, inFlightCalls: remaining } : withoutInFlight(m);
          return m.workStartAt !== null ? { ...base, lastActivityAt: Math.max(m.lastActivityAt ?? 0, event.at) } : base;
        },
        event.provider,
        event.sessionId,
      );
      return {
        ...state,
        _agentMetricsInternal: nextInternals,
        agentMetrics: toPublicMetrics(nextInternals),
      };
    }

    case "TaskCompleted": {
      // A SubagentStop that mapHookRecord could not attribute to a real
      // worker (empty active stack, or a workerId that fell back to the
      // literal "orchestrator") must not inflate the orchestrator's visible
      // task count — see mapHookRecord.ts's `const workerId = record.workerId
      // ?? "orchestrator"` fallback (p63-t2). Count it separately instead.
      if (event.workerId === "orchestrator") {
        return {
          ...state,
          unattributedTasks: state.unattributedTasks + 1,
        };
      }
      // Canvas worker is optional; the metric always updates.
      // Same provider guard as WorkerActivity (p22-t8 gap fix).
      const completeProvider = resolveProvider(event.provider);
      const worker = state.workers[event.workerId];
      const nextWorkers =
        worker && resolveProvider(worker.provider) === completeProvider
          ? { ...state.workers, [event.workerId]: { ...worker, state: "celebrate" as WorkerState } }
          : state.workers;
      // Increment taskCount; stay active (worker may do more after a task completes).
      const nextInternals = upsertMetric(
        state._agentMetricsInternal,
        event.workerId,
        (m) => ({
          ...m,
          taskCount: m.taskCount + 1,
          status: "active" as const,
          workStartAt: m.workStartAt ?? event.at,
          lastActivityAt: event.at,
        }),
        event.provider,
        event.sessionId,
      );
      return {
        ...state,
        workers: nextWorkers,
        completedTasks: state.completedTasks + 1,
        _agentMetricsInternal: nextInternals,
        agentMetrics: toPublicMetrics(nextInternals),
      };
    }

    case "WorkerStopped": {
      // Canvas worker is optional; the metric (tokens, activeMs) always finalizes.
      // Same provider guard as WorkerActivity (p22-t8 gap fix): a
      // WorkerStopped from provider B must never flip provider A's live
      // sprite to "leave".
      const stopProvider = resolveProvider(event.provider);
      const worker = state.workers[event.workerId];
      const nextWorkers =
        worker && resolveProvider(worker.provider) === stopProvider
          ? { ...state.workers, [event.workerId]: { ...worker, state: "leave" as WorkerState } }
          : state.workers;
      // Finalize activeMs: add elapsed since workStartAt, then clear the timer.
      // Accumulate tokens when the event carries a count.
      const nextInternals = upsertMetric(
        state._agentMetricsInternal,
        event.workerId,
        (m) => {
          // liveSpawns: only touched when this event carries a spawnId AND
          // the metric already has a liveSpawns list (legacy events, or an
          // agent that has never had a spawnId recorded, leave it untouched
          // — single-instance path). When a spawnId is removed and the list
          // becomes empty, the agent truly has no more live instances; when
          // it is still non-empty, another concurrent spawn is still
          // running and status must stay "active", not flip to idle.
          const nextLiveSpawns =
            event.spawnId !== undefined && m.liveSpawns !== undefined
              ? m.liveSpawns.filter((id) => id !== event.spawnId)
              : m.liveSpawns;
          const stillLive = nextLiveSpawns !== undefined && nextLiveSpawns.length > 0;
          // Per-spawn credit: when this stop names a spawnId we have a
          // recorded start for, credit exactly that spawn's elapsed window
          // (and drop its entry) instead of the shared workStartAt, which
          // would double-credit overlapping concurrent spawns of the same
          // agent. Stops without a spawnId, or naming an unknown spawnId
          // (legacy hook records, or a spawnId we never saw a Spawned for),
          // fall back to the original whole-window behaviour.
          const hasSpawnCredit =
            event.spawnId !== undefined && m.spawnStartAt !== undefined && event.spawnId in m.spawnStartAt;
          const creditedMs = hasSpawnCredit
            ? creditedElapsed(m.spawnStartAt![event.spawnId!], m.lastActivityAt, event.at, state.idleFreezeMs, m.inFlightCalls)
            : creditedElapsed(m.workStartAt, m.lastActivityAt, event.at, state.idleFreezeMs, m.inFlightCalls);
          let nextSpawnStartAt = m.spawnStartAt;
          let nextWorkStartAt = stillLive ? m.workStartAt : null;
          if (hasSpawnCredit) {
            nextSpawnStartAt = { ...m.spawnStartAt };
            delete nextSpawnStartAt[event.spawnId!];
            if (stillLive) {
              const remaining = Object.values(nextSpawnStartAt);
              nextWorkStartAt = remaining.length > 0 ? Math.min(...remaining) : m.workStartAt;
            } else {
              nextWorkStartAt = null;
            }
          }
          return {
            ...(stillLive ? m : withoutInFlight(m)),
            status: stillLive ? ("active" as const) : ("idle" as const),
            // A cross-agent fallback TARGET row (marker names ANOTHER slot)
            // drops its marker once its run ends and no other spawn of it is
            // live. The failed slot's own row and same-agent markers
            // (fallbackOf === own id) are untouched.
            ...(!stillLive && m.fallbackOf !== undefined && m.fallbackOf !== event.workerId
              ? { fallbackOf: undefined, fallbackDepth: undefined, fallbackIsDefault: undefined }
              : {}),
            ...(nextLiveSpawns !== undefined ? { liveSpawns: nextLiveSpawns } : {}),
            ...(nextSpawnStartAt !== m.spawnStartAt ? { spawnStartAt: nextSpawnStartAt } : {}),
            activeMs: m.activeMs + creditedMs,
            tokens: m.tokens + (event.tokens ?? 0),
            cacheReadTokens: m.cacheReadTokens + (event.cacheReadTokens ?? 0),
            workStartAt: nextWorkStartAt,
            // Most-recent report only (never accumulated). A WorkerStopped
            // event without a report (older hook version, or the transcript
            // had no report to extract) must NOT clobber a previously captured
            // report — only overwrite when this event actually carries one.
            lastReport: event.report !== undefined ? event.report : m.lastReport,
            lastReportChars: event.report !== undefined ? event.reportChars : m.lastReportChars,
            // Overwritten only when this event explicitly carries the field
            // (foreign-harness dispatch records always do); a native Claude
            // Code SubagentStop never sets it, so the key stays absent and
            // readers fall back to their own true default (see
            // AgentMetric.usageReported's doc comment) rather than this
            // reducer materializing it.
            ...(event.usageReported !== undefined ? { usageReported: event.usageReported } : {}),
          };
        },
        event.provider,
        event.sessionId,
      );
      return {
        ...state,
        workers: nextWorkers,
        _agentMetricsInternal: nextInternals,
        agentMetrics: toPublicMetrics(nextInternals),
      };
    }

    case "ProviderError": {
      if (!event.workerId) {
        return state;
      }
      const nextInternals = upsertMetric(
        state._agentMetricsInternal,
        event.workerId,
        (m) =>
          // Other healthy spawns of this agent are still live (the failed one
          // was already released by its WorkerStopped): the error belongs to
          // that spawn only, so the agent stays as it is.
          m.liveSpawns !== undefined && m.liveSpawns.length > 0
            ? m
            : {
                ...withoutInFlight(m),
                status: "error" as const,
                // Finalize any active time before entering error state.
                activeMs: m.activeMs + creditedElapsed(m.workStartAt, m.lastActivityAt, event.at, state.idleFreezeMs, m.inFlightCalls),
                workStartAt: null,
              },
        event.provider,
        event.sessionId,
      );
      return {
        ...state,
        _agentMetricsInternal: nextInternals,
        agentMetrics: toPublicMetrics(nextInternals),
      };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Delegation mode measurement (Team Lead Mode Phase 4)
// ---------------------------------------------------------------------------

/** Per-delegation-mode rollup, one entry per mode that has at least one agent. */
export interface DelegationModeStats {
  /** "flat" | "team_leads" (mirrors .claude/tycoon/execution.json's delegation_mode). */
  mode: string;
  /** Sum of taskCount across every agent recorded under this mode. */
  completedTasks: number;
  /**
   * Sum of tokens + cacheReadTokens across every agent recorded under this
   * mode — the same combined (billable + cache-read) basis used everywhere
   * else in the panel (see media/main.js's TOKENS column), not billable
   * tokens alone.
   */
  totalTokens: number;
  /** Sum of activeMs across every agent recorded under this mode. */
  activeMs: number;
  /**
   * True wall-clock span for this mode: max(lastActivityAt) - min(workStartAt)
   * across the mode's agents, in ms. Unlike activeMs (a SUM across agents that
   * overcounts concurrent/parallel work), this reflects real elapsed time, so
   * totalTokens / (wallClockMs / 1000) is an honest tokens/second for the mode.
   * 0 when there isn't at least one agent with both timestamps known.
   */
  wallClockMs: number;
  /**
   * team_leads only: tokens + cacheReadTokens consumed by tier==="lead"
   * agents. 0 for "flat" (leads only exist under Team Leads mode, per
   * doctrine).
   */
  leadTokens: number;
  /**
   * team_leads only: leadTokens plus tokens + cacheReadTokens consumed by
   * every agent whose parentId points at one of those leads (i.e. leads +
   * their workers, NOT every agent recorded under team_leads mode —
   * small-task work that skips a lead per doctrine is excluded from this
   * denominator, since it was never part of a team). 0 for "flat".
   */
  teamTokens: number;
  /**
   * leadTokens / teamTokens as a percentage, or null when teamTokens is 0
   * (no lead-routed work observed yet). This is the direct measurement of
   * the install screen's "10-20% more tokens" claim for Team Leads mode.
   */
  leadOverheadPct: number | null;
}

/**
 * Aggregate agentMetrics into per-delegation-mode stats. Pure — no fs/vscode
 * access — so it can run against a live MetricsWorldState snapshot or a synthetic
 * fixture in tests.
 *
 * Mode resolution: an agent's own `delegationMode` field wins; agents with no
 * `delegationMode` (legacy records predating Team Lead Mode Phase 4, or an
 * agent whose spawn/stop event never carried the field) are bucketed as
 * "flat" — pre-Phase-4 telemetry is overwhelmingly flat-mode data, so this is
 * the accurate default rather than a guess.
 *
 * Only modes with at least one agent produce an entry — callers render "no
 * data for this mode" by simply not finding it, rather than a zeroed row.
 */
export function computeDelegationModeStats(agentMetrics: AgentMetric[]): DelegationModeStats[] {
  const totals = new Map<
    string,
    { completedTasks: number; totalTokens: number; activeMs: number; minStart: number; maxLast: number }
  >();
  const resolveMode = (m: AgentMetric): string => (m.delegationMode === "team_leads" ? "team_leads" : "flat");

  for (const m of agentMetrics) {
    const mode = resolveMode(m);
    const bucket = totals.get(mode) ?? {
      completedTasks: 0,
      totalTokens: 0,
      activeMs: 0,
      minStart: Infinity,
      maxLast: -Infinity,
    };
    bucket.completedTasks += m.taskCount;
    bucket.totalTokens += m.tokens + m.cacheReadTokens;
    bucket.activeMs += m.activeMs;
    if (typeof m.workStartAt === "number" && isFinite(m.workStartAt) && m.workStartAt > 0) {
      bucket.minStart = Math.min(bucket.minStart, m.workStartAt);
    }
    if (typeof m.lastActivityAt === "number" && isFinite(m.lastActivityAt) && m.lastActivityAt > 0) {
      bucket.maxLast = Math.max(bucket.maxLast, m.lastActivityAt);
    }
    totals.set(mode, bucket);
  }

  // Lead coordination overhead: leads identified by tier === "lead"; their
  // "team" is the lead plus every agent whose parentId resolves to that lead.
  const leadIds = new Set(
    agentMetrics.filter((m) => (m.tier ?? "").toLowerCase() === "lead").map((m) => m.id),
  );
  let leadTokens = 0;
  let teamTokens = 0;
  for (const m of agentMetrics) {
    if (leadIds.has(m.id)) {
      leadTokens += m.tokens + m.cacheReadTokens;
      teamTokens += m.tokens + m.cacheReadTokens;
    } else if (m.parentId !== undefined && leadIds.has(m.parentId)) {
      teamTokens += m.tokens + m.cacheReadTokens;
    }
  }

  const result: DelegationModeStats[] = [];
  for (const [mode, bucket] of totals) {
    const isTeamLeads = mode === "team_leads";
    const wallClockMs =
      isFinite(bucket.minStart) && isFinite(bucket.maxLast) && bucket.maxLast > bucket.minStart
        ? bucket.maxLast - bucket.minStart
        : 0;
    result.push({
      mode,
      completedTasks: bucket.completedTasks,
      totalTokens: bucket.totalTokens,
      activeMs: bucket.activeMs,
      wallClockMs,
      leadTokens: isTeamLeads ? leadTokens : 0,
      teamTokens: isTeamLeads ? teamTokens : 0,
      leadOverheadPct: isTeamLeads && teamTokens > 0 ? (leadTokens / teamTokens) * 100 : null,
    });
  }
  // Stable, predictable order: "flat" before "team_leads" when both are present.
  result.sort((a, b) => (a.mode === "flat" ? -1 : b.mode === "flat" ? 1 : 0));
  return result;
}

// ---------------------------------------------------------------------------
// Session-scoped state rebuild (Delegation Health dual view: "this session"
// vs. "since last reset")
// ---------------------------------------------------------------------------

/**
 * Rebuild a MetricsWorldState by replaying a list of raw HookRecords through
 * the SAME reducer path the live runtime uses (mapHookRecord -> applyEvent),
 * starting from a fresh initialWorldState(). Pure — no fs/vscode access — so
 * it can run against a records array read from disk by a host, or a synthetic
 * fixture in tests.
 *
 * When `filterSessionId` is provided, only records whose `sessionId` matches
 * are folded in (records with no sessionId, e.g. from hook versions predating
 * that field, are excluded from a session-scoped rebuild). When
 * `filterSessionId` is undefined, every record is folded in — this reproduces
 * the cumulative "since last reset" state (equivalent to the live runtime's
 * accumulated state, given the same records).
 */
export function computeStateFromRecords(
  records: RawRecord[],
  filterSessionId?: string,
  seedEvents?: NormalizedEvent[],
): MetricsWorldState {
  let state = initialWorldState();
  // Roster seeding (WorkerRegistered / RosterSeeded) applied before any record,
  // mirroring the live runtime where the host seeds the roster at start.
  for (const event of seedEvents ?? []) {
    state = applyEvent(state, event);
  }
  let lastActivityAt: number | null = null;
  for (const record of records) {
    if (filterSessionId !== undefined && record.sessionId !== filterSessionId) continue;
    if (lastActivityAt === null || record.at > lastActivityAt) lastActivityAt = record.at;
    for (const event of tryMapRecord(record) ?? []) {
      state = applyEvent(state, event);
    }
  }
  return { ...state, lastActivityAt };
}
