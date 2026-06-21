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

export interface WorldState {
  sessionActive: boolean;
  workers: Record<WorkerId, Worker>;
  /** Count of completed tasks - drives build progression. */
  completedTasks: number;
}

export function initialWorldState(): WorldState {
  return { sessionActive: false, workers: {}, completedTasks: 0 };
}

const ACTIVITY_TO_STATE: Record<string, WorkerState> = {
  survey: "survey",
  build: "build",
  haul: "haul",
  wire: "build",
  shell: "build",
};

// Pure reducer: fold a normalized event into the world state.
// NOTE: skeleton - mappings are intentionally minimal; tune per docs/DESIGN.md section 3.
export function applyEvent(state: WorldState, event: NormalizedEvent): WorldState {
  switch (event.type) {
    case "SessionStart":
      return { ...state, sessionActive: true };
    case "SessionStop":
      return { ...state, sessionActive: false };
    case "WorkerSpawned":
      return {
        ...state,
        workers: {
          ...state.workers,
          [event.workerId]: { id: event.workerId, role: event.role, state: "arrive" },
        },
      };
    case "WorkerActivity": {
      const worker = state.workers[event.workerId];
      if (!worker) {
        return state;
      }
      const nextState: WorkerState = ACTIVITY_TO_STATE[event.kind] ?? "build";
      return {
        ...state,
        workers: { ...state.workers, [event.workerId]: { ...worker, state: nextState } },
      };
    }
    case "TaskCompleted": {
      const worker = state.workers[event.workerId];
      const workers = worker
        ? { ...state.workers, [event.workerId]: { ...worker, state: "celebrate" as WorkerState } }
        : state.workers;
      return { ...state, workers, completedTasks: state.completedTasks + 1 };
    }
    case "WorkerStopped": {
      const worker = state.workers[event.workerId];
      if (!worker) {
        return state;
      }
      return {
        ...state,
        workers: { ...state.workers, [event.workerId]: { ...worker, state: "leave" } },
      };
    }
    case "ProviderError":
      return state;
    default:
      return state;
  }
}
