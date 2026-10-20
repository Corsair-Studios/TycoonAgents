/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { applyEvent, initialWorldState } from "../../core/state";
import type { MetricsWorldState } from "../../core/state";
import type { NormalizedEvent } from "../../core/events";

/** Holds the live MetricsWorldState and notifies listeners on each change. */
export class Runtime {
  private state: MetricsWorldState;
  private listeners: Array<(s: MetricsWorldState) => void> = [];

  constructor(private limits?: { idleFreezeMs: number }) {
    this.state = initialWorldState(limits);
  }

  /** Fold a normalized event into the world state and notify all listeners. */
  ingest(event: NormalizedEvent): void {
    this.state = applyEvent(this.state, event);
    for (const cb of this.listeners) {
      cb(this.state);
    }
  }

  /** Reset to a fresh initial world state and notify all listeners. */
  reset(): void {
    this.state = initialWorldState(this.limits);
    for (const cb of this.listeners) {
      cb(this.state);
    }
  }

  /** Return the current world state snapshot. */
  getState(): MetricsWorldState {
    return this.state;
  }

  /** Subscribe to state changes. Returns a disposable. */
  onChange(cb: (s: MetricsWorldState) => void): { dispose(): void } {
    this.listeners.push(cb);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== cb);
      },
    };
  }
}
