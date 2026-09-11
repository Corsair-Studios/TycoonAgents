/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import type { EventSink } from "./events";

// A Provider turns some activity source (Claude Code hooks, another harness, a
// local/API model loop) into the normalized event stream. See docs/DESIGN.md section 6.
// The core consumes only normalized events, so adding a provider never touches the renderer.
export interface Provider {
  /**
   * Stable identifier, e.g. "claude-code", "ollama". This MUST match the
   * `provider` string stamped onto every NormalizedEvent this provider
   * emits (see events.ts) and the provider id keyed in mappingRegistry, so
   * two live harnesses tailing the same activity source can never complete,
   * overwrite, or misattribute each other's workers (p22-t1).
   */
  readonly id: string;
  /** Begin emitting normalized events to the sink. */
  start(emit: EventSink): Promise<void> | void;
  /** Stop emitting and release resources. */
  stop(): Promise<void> | void;
}
