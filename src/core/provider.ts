/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import type { EventSink } from "./events";

// A Provider turns some activity source (Claude Code hooks, another harness, a
// local/API model loop) into the normalized event stream. See docs/DESIGN.md section 6.
// The core consumes only normalized events, so adding a provider never touches the renderer.
export interface Provider {
  /** Stable identifier, e.g. "claude-code", "ollama". */
  readonly id: string;
  /** Begin emitting normalized events to the sink. */
  start(emit: EventSink): Promise<void> | void;
  /** Stop emitting and release resources. */
  stop(): Promise<void> | void;
}
