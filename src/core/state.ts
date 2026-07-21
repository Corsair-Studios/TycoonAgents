/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import type { NormalizedEvent, WorkerId } from "./events";
import { mapHookRecord } from "../providers/claude-code/mapHookRecord";
import type { HookRecord } from "../providers/claude-code/hookRecord";

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
}

/** Per-agent activity metrics, aggregated from the normalized event stream. */
export interface AgentMetric {
  /** Agent identifier (e.g. workerId / session id). */
  id: string;
  /** Human-readable display name derived from id (kebab -> Title Case). */
  name: string;
  /** LLM model this agent runs on (e.g. "Opus", "Sonnet", "Haiku"). */
  model?: string;
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
}

/** Internal tracking record (kept as an alias now that workStartAt is public). */
type AgentMetricInternal = AgentMetric;

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
  "primary-agent": "Fallback Agent",
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

/** Find the internal metric for a workerId, or undefined. */
function findMetric(
  internals: AgentMetricInternal[],
  workerId: string,
): AgentMetricInternal | undefined {
  return internals.find((m) => m.id === workerId);
}

/** Return a new internals array with the metric for workerId replaced/inserted. */
function upsertMetric(
  internals: AgentMetricInternal[],
  workerId: string,
  updater: (m: AgentMetricInternal) => AgentMetricInternal,
): AgentMetricInternal[] {
  const existing = findMetric(internals, workerId);
  if (existing) {
    return internals.map((m) => (m.id === workerId ? updater(m) : m));
  }
  // Create a fresh metric entry then apply the updater.
  const fresh: AgentMetricInternal = {
    id: workerId,
    name: toDisplayName(workerId),
    model: undefined,
    description: undefined,
    tier: undefined,
    parentId: undefined,
    delegationMode: undefined,
    status: "idle",
    taskCount: 0,
    mcpCount: 0,
    activeMs: 0,
    tokens: 0,
    workStartAt: null,
    lastActivityAt: null,
    directSearches: 0,
    directReads: 0,
    directEdits: 0,
    delegations: 0,
  };
  return [...internals, updater(fresh)];
}

/** Produce the public AgentMetric list (workStartAt is now part of the public shape). */
function toPublicMetrics(internals: AgentMetricInternal[]): AgentMetric[] {
  return internals.map((m) => ({ ...m }));
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
        (m) => ({
          ...m,
          status: "idle" as const,
          activeMs: m.activeMs + creditedElapsed(m.workStartAt, m.lastActivityAt, event.at, state.idleFreezeMs, state.sanityCapMs),
          tokens: m.tokens + (event.tokens ?? 0),
          model: event.model ?? m.model,
          delegationMode: event.delegationMode ?? m.delegationMode,
          workStartAt: null,
        }),
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
      );
      return {
        ...state,
        _agentMetricsInternal: nextInternals,
        agentMetrics: toPublicMetrics(nextInternals),
      };
    }

    case "WorkerSpawned": {
      const nextWorkers = {
        ...state.workers,
        [event.workerId]: { id: event.workerId, role: event.role, state: "arrive" as WorkerState },
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
          status: "active" as const,
          workStartAt: m.workStartAt ?? event.at,
          lastActivityAt: event.at,
        }),
      );
      const isRealDelegation = event.role === "Task" || event.role === "Agent";
      const nextInternals = isRealDelegation
        ? upsertMetric(afterChild, ORCHESTRATOR_ID, (m) => ({
            ...m,
            delegations: m.delegations + 1,
            // Keep the orchestrator "alive" when it delegates. This liveness
            // previously rode on a spawn-time TaskCompleted for the
            // orchestrator, which was removed to stop double-counting tasks
            // (see mapHookRecord's Task/Agent branch).
            status: "active" as const,
            workStartAt: m.workStartAt ?? event.at,
            lastActivityAt: event.at,
          }))
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
      const worker = state.workers[event.workerId];
      const nextWorkers = worker
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
          // Start timer if not already running.
          workStartAt: m.workStartAt ?? event.at,
          lastActivityAt: event.at,
        }),
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
      const worker = state.workers[event.workerId];
      const nextWorkers = worker
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
      const worker = state.workers[event.workerId];
      const nextWorkers = worker
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
          workStartAt: null,
        }),
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
  /** Sum of tokens across every agent recorded under this mode. */
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
   * team_leads only: tokens consumed by tier==="lead" agents. 0 for "flat"
   * (leads only exist under Team Leads mode, per doctrine).
   */
  leadTokens: number;
  /**
   * team_leads only: leadTokens plus tokens consumed by every agent whose
   * parentId points at one of those leads (i.e. leads + their workers, NOT
   * every agent recorded under team_leads mode — small-task work that skips
   * a lead per doctrine is excluded from this denominator, since it was
   * never part of a team). 0 for "flat".
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
    bucket.totalTokens += m.tokens;
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
      leadTokens += m.tokens;
      teamTokens += m.tokens;
    } else if (m.parentId !== undefined && leadIds.has(m.parentId)) {
      teamTokens += m.tokens;
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
  records: HookRecord[],
  filterSessionId?: string,
): MetricsWorldState {
  let state = initialWorldState();
  let lastActivityAt: number | null = null;
  for (const record of records) {
    if (filterSessionId !== undefined && record.sessionId !== filterSessionId) continue;
    if (lastActivityAt === null || record.at > lastActivityAt) lastActivityAt = record.at;
    for (const event of mapHookRecord(record)) {
      state = applyEvent(state, event);
    }
  }
  return { ...state, lastActivityAt };
}
