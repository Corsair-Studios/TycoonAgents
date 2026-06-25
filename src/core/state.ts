/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import type { NormalizedEvent, WorkerId } from "./events";

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
}

/** Internal tracking record (kept as an alias now that workStartAt is public). */
type AgentMetricInternal = AgentMetric;

export interface WorldState {
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

export function initialWorldState(limits?: { idleFreezeMs?: number; sanityCapMs?: number }): WorldState {
  return {
    sessionActive: false,
    workers: {},
    completedTasks: 0,
    agentMetrics: [],
    _agentMetricsInternal: [],
    idleFreezeMs: limits?.idleFreezeMs ?? 180000,
    sanityCapMs: limits?.sanityCapMs ?? 900000,
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
    status: "idle",
    taskCount: 0,
    mcpCount: 0,
    activeMs: 0,
    tokens: 0,
    workStartAt: null,
    lastActivityAt: null,
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
export function applyEvent(state: WorldState, event: NormalizedEvent): WorldState {
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
          workStartAt: m.workStartAt ?? event.at,
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
      const nextInternals = upsertMetric(
        state._agentMetricsInternal,
        event.workerId,
        (m) => ({
          ...m,
          // If the event provides an explicit name, use it; otherwise keep computed name.
          name: event.name ?? m.name,
          model: event.model ?? m.model,
          description: event.description ?? m.description,
          status: "active" as const,
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
      const nextInternals = upsertMetric(
        state._agentMetricsInternal,
        event.workerId,
        (m) => ({
          ...m,
          status: "active" as const,
          mcpCount: isMcp ? m.mcpCount + 1 : m.mcpCount,
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
