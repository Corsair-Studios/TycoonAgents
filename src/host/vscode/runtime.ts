/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import { applyEvent, initialWorldState } from "../../core/state";
import type { WorldState } from "../../core/state";
import type { NormalizedEvent } from "../../core/events";

/** Holds the live WorldState and notifies listeners on each change. */
export class Runtime {
  private state: WorldState = initialWorldState();
  private listeners: Array<(s: WorldState) => void> = [];

  /** Fold a normalized event into the world state and notify all listeners. */
  ingest(event: NormalizedEvent): void {
    this.state = applyEvent(this.state, event);
    for (const cb of this.listeners) {
      cb(this.state);
    }
  }

  /** Return the current world state snapshot. */
  getState(): WorldState {
    return this.state;
  }

  /** Subscribe to state changes. Returns a disposable. */
  onChange(cb: (s: WorldState) => void): { dispose(): void } {
    this.listeners.push(cb);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== cb);
      },
    };
  }
}
