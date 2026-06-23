/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

// Normalized activity event stream (see docs/DESIGN.md section 6).
// Providers translate a tool's raw activity into these provider-agnostic events.
// The state model and renderer consume ONLY these types.

export type WorkerId = string;

/** What a worker is doing, mapped from a provider's raw tool activity. */
export type ActivityKind =
  | "survey" // read / search
  | "build"  // generic edit / in-progress work
  | "haul"   // file write / large operation
  | "wire"   // external / MCP / integration call
  | "shell"; // shell / command execution

export type NormalizedEvent =
  | { type: "SessionStart"; at: number }
  // SessionStop carries the orchestrator's per-turn token delta + model (from the
  // Stop hook's transcript read) so the orchestrator row shows real token usage.
  | { type: "SessionStop"; at: number; tokens?: number; model?: string }
  // Identity-only registration: seeds an idle roster entry without marking it active.
  | { type: "WorkerRegistered"; at: number; workerId: WorkerId; name?: string; model?: string; description?: string }
  | { type: "WorkerSpawned"; at: number; workerId: WorkerId; role?: string; name?: string; model?: string; description?: string }
  | { type: "WorkerActivity"; at: number; workerId: WorkerId; kind: ActivityKind; detail?: string }
  | { type: "TaskCompleted"; at: number; workerId: WorkerId; label?: string }
  | { type: "WorkerStopped"; at: number; workerId: WorkerId; tokens?: number }
  | { type: "ProviderError"; at: number; workerId?: WorkerId; message: string };

export type EventSink = (event: NormalizedEvent) => void;
