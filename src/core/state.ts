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
   * Originally assigned slot id (agent id) for the most recent fallback
   * re-dispatch of this agent, per FallbackState (src/core/fallbackChain.ts,
   * p15-t2). Undefined when this agent has never run on a fallback model.
   */
  fallbackOf?: string;
  /** 1-based index into the fallback chain for the most recent fallback dispatch. Undefined when never fallen back. */
  fallbackDepth?: number;
  /** p32-t2: true when the most recent fallback dispatch resolved to the routing-level
   *  defaultFallback rather than the agent's own chain entry. Undefined when never fallen back
   *  or on records predating this field. */
  fallbackIsDefault?: boolean;
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
  /** Per-agent metrics list, ordered by first-seen time. */
  agentMetrics: AgentMetric[];
  /** Internal: extended metric records that include workStartAt for activeMs computation. */
  _agentMetricsInternal: AgentMetricInternal[];
  /** Freeze live timer after this many ms with no activity (default 180000 = 3 min). */
  idleFreezeMs: number;
  /** Hard cap on any single active stretch in ms (default 900000 = 15 min). */
  sanityCapMs: number;
  /** Most recent hook activity timestamp (epoch ms) across all agents, or null if none. */
  lastActivityAt?: number | null;
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

export function initialWorldState(limits?: { idleFreezeMs?: number; sanityCapMs?: number }): MetricsWorldState {
  return {
    sessionActive: false,
    workers: {},
    completedTasks: 0,
    agentMetrics: [],
    _agentMetricsInternal: [],
    idleFreezeMs: limits?.idleFreezeMs ?? 180000,
    sanityCapMs: limits?.sanityCapMs ?? 900000,
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
  };
  return [...internals, updater(fresh)];
}

/** Produce the public AgentMetric list (workStartAt is now part of the public shape). */
function toPublicMetrics(internals: AgentMetricInternal[]): AgentMetric[] {
  return internals.map(({ _rosterKey, ...rest }) => ({ ...rest }));
}

/** Compute how many ms have elapsed since workStartAt (0 if not active). */
function elapsedSince(workStartAt: number | null, now: number): number {
  return workStartAt !== null ? Math.max(0, now - workStartAt) : 0;
}

/**
 * Compute credited elapsed time for an active stretch, capped by idle-freeze
 * and a hard sanity cap.
 *
 * - If lastActivityAt is known, freeze "now" at lastActivityAt + idleFreezeMs
 *   so idle gaps don't inflate the total.
 * - Clamp the result to [0, sanityCapMs] to prevent runaway values from
 *   sessions that were cut off without a proper stop event.
 */
export function creditedElapsed(
  workStartAt: number | null,
  lastActivityAt: number | null,
  now: number,
  idleFreezeMs: number,
  sanityCapMs: number,
): number {
  if (workStartAt === null) return 0;
  const cappedNow = lastActivityAt !== null ? Math.min(now, lastActivityAt + idleFreezeMs) : now;
  return Math.min(Math.max(0, cappedNow - workStartAt), sanityCapMs);
}

// Pure reducer: fold a normalized event into the world state.
// NOTE: skeleton - mappings are intentionally minimal; tune per docs/DESIGN.md section 3.
export function applyEvent(state: MetricsWorldState, event: NormalizedEvent): MetricsWorldState {
  // Refresh the top-level "most recent hook activity" timestamp before branching,
  // so EVERY event type (not just the ones with agent-specific handling) keeps it
  // current -- this is what a downstream "plan stalled" advisory reads. Every
  // NormalizedEvent carries `at` (see core/events.ts), but guard defensively in
  // case a future variant ever omits it.
  if (typeof event.at === "number") {
    state = { ...state, lastActivityAt: Math.max(state.lastActivityAt ?? 0, event.at) };
  }
  switch (event.type) {
    case "SessionStart": {
      // The orchestrator (main session) is working for the whole turn — light it
      // up the moment the user submits, covering the thinking phase before any
      // tool call. Only the canvas worker depends on a spawn; the metric does not.
      const afterOrchestrator = upsertMetric(
        state._agentMetricsInternal,
        ORCHESTRATOR_ID,
        (m) => ({
          ...m,
          status: "active" as const,
          activeMs: m.activeMs + creditedElapsed(m.workStartAt, m.lastActivityAt, event.at, state.idleFreezeMs, state.sanityCapMs),
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
          ? { ...m, status: "idle" as const, workStartAt: null }
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
            ...m,
            status: "idle" as const,
            activeMs: m.activeMs + creditedElapsed(m.workStartAt, m.lastActivityAt, event.at, state.idleFreezeMs, state.sanityCapMs),
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
              ...m,
              status: "idle" as const,
              activeMs: m.activeMs + creditedElapsed(m.workStartAt, m.lastActivityAt, event.at, state.idleFreezeMs, state.sanityCapMs),
              workStartAt: null,
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
          name: event.name ?? m.name,
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
          // If the event provides an explicit name, use it; otherwise keep computed name.
          name: event.name ?? m.name,
          model: event.model ?? m.model,
          description: event.description ?? m.description,
          tier: event.tier ?? m.tier,
          parentId: event.parentId ?? m.parentId,
          delegationMode: event.delegationMode ?? m.delegationMode,
          vendor: event.vendor ?? m.vendor,
          costModelClass: event.costModelClass ?? m.costModelClass,
          fallbackOf: event.fallbackOf ?? m.fallbackOf,
          fallbackDepth: event.fallbackDepth ?? m.fallbackDepth,
          fallbackIsDefault: event.fallbackOf !== undefined ? event.fallbackIsDefault : m.fallbackIsDefault,
          fallbackCount: event.fallbackOf !== undefined ? m.fallbackCount + 1 : m.fallbackCount,
          status: "active" as const,
          workStartAt: m.workStartAt ?? event.at,
          lastActivityAt: event.at,
        }),
        event.provider,
        event.sessionId,
      );
      const isRealDelegation = event.role === "Task" || event.role === "Agent";
      const nextInternals = isRealDelegation
        ? upsertMetric(
            afterChild,
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
        : afterChild;
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
      const isMcp = event.kind === "wire";
      // For survey activity, split the genuinely-forbidden Grep/Glob (the delegation
      // leak) from a plain Read, which CLAUDE.md allows directly for known files.
      const isSurvey = event.kind === "survey";
      const isForbiddenSearch = isSurvey && (event.detail === "Grep" || event.detail === "Glob");
      const isRead = isSurvey && !isForbiddenSearch;
      const nextInternals = upsertMetric(
        state._agentMetricsInternal,
        event.workerId,
        (m) => ({
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
        }),
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

    case "TaskCompleted": {
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
        (m) => ({
          ...m,
          status: "idle" as const,
          activeMs: m.activeMs + creditedElapsed(m.workStartAt, m.lastActivityAt, event.at, state.idleFreezeMs, state.sanityCapMs),
          tokens: m.tokens + (event.tokens ?? 0),
          cacheReadTokens: m.cacheReadTokens + (event.cacheReadTokens ?? 0),
          workStartAt: null,
          // Most-recent report only (never accumulated). A WorkerStopped
          // event without a report (older hook version, or the transcript
          // had no report to extract) must NOT clobber a previously captured
          // report — only overwrite when this event actually carries one.
          lastReport: event.report !== undefined ? event.report : m.lastReport,
          lastReportChars: event.report !== undefined ? event.reportChars : m.lastReportChars,
        }),
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
        (m) => ({
          ...m,
          status: "error" as const,
          // Finalize any active time before entering error state.
          activeMs: m.activeMs + creditedElapsed(m.workStartAt, m.lastActivityAt, event.at, state.idleFreezeMs, state.sanityCapMs),
          workStartAt: null,
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
): MetricsWorldState {
  let state = initialWorldState();
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
