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
}

/** Internal tracking record for computing activeMs across pause/resume cycles. */
interface AgentMetricInternal extends AgentMetric {
  /** Epoch-ms timestamp of when this agent last became active (null if not currently active). */
  workStartAt: number | null;
}

export interface WorldState {
  sessionActive: boolean;
  workers: Record<WorkerId, Worker>;
  /** Count of completed tasks - drives build progression. */
  completedTasks: number;
  /** Per-agent metrics list, ordered by first-seen time. */
  agentMetrics: AgentMetric[];
  /** Internal: extended metric records that include workStartAt for activeMs computation. */
  _agentMetricsInternal: AgentMetricInternal[];
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

export function initialWorldState(): WorldState {
  return {
    sessionActive: false,
    workers: {},
    completedTasks: 0,
    agentMetrics: [],
    _agentMetricsInternal: [],
  };
}

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
  };
  return [...internals, updater(fresh)];
}

/** Strip the internal field to produce the public AgentMetric list. */
function toPublicMetrics(internals: AgentMetricInternal[]): AgentMetric[] {
  return internals.map(({ workStartAt: _ws, ...pub }) => pub);
}

/** Compute how many ms have elapsed since workStartAt (0 if not active). */
function elapsedSince(workStartAt: number | null, now: number): number {
  return workStartAt !== null ? Math.max(0, now - workStartAt) : 0;
}

// Pure reducer: fold a normalized event into the world state.
// NOTE: skeleton - mappings are intentionally minimal; tune per docs/DESIGN.md section 3.
export function applyEvent(state: WorldState, event: NormalizedEvent): WorldState {
  switch (event.type) {
    case "SessionStart":
      return { ...state, sessionActive: true };

    case "SessionStop":
      return { ...state, sessionActive: false };

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
      const worker = state.workers[event.workerId];
      if (!worker) {
        return state;
      }
      const nextWorkerState: WorkerState = ACTIVITY_TO_STATE[event.kind] ?? "build";
      const nextWorkers = {
        ...state.workers,
        [event.workerId]: { ...worker, state: nextWorkerState },
      };
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
      const worker = state.workers[event.workerId];
      if (!worker) {
        return state;
      }
      const nextWorkers = {
        ...state.workers,
        [event.workerId]: { ...worker, state: "leave" as WorkerState },
      };
      // Finalize activeMs: add elapsed since workStartAt, then clear the timer.
      // Accumulate tokens when the event carries a count.
      const nextInternals = upsertMetric(
        state._agentMetricsInternal,
        event.workerId,
        (m) => ({
          ...m,
          status: "idle" as const,
          activeMs: m.activeMs + elapsedSince(m.workStartAt, event.at),
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
          activeMs: m.activeMs + elapsedSince(m.workStartAt, event.at),
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
