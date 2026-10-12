/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Module-level "TycoonAgents is writing hooks" flag. The MCP approval guard
// must not hash a half-copied hook closure (slow disk / antivirus) and revoke a
// healthy approval, so every hook/bridge copy runs inside this gate.

let depth = 0;
const idleListeners = new Set<() => void>();

export function beginHookWrite(): void {
  depth++;
}

export function endHookWrite(): void {
  if (depth > 0) depth--;
  if (depth === 0) {
    for (const l of [...idleListeners]) {
      try {
        l();
      } catch {
        /* listener errors never break an install */
      }
    }
  }
}

export function isHookWriteActive(): boolean {
  return depth > 0;
}

/** Called each time the last active hook write ends. Returns an unsubscribe function. */
export function onHookWritesIdle(listener: () => void): () => void {
  idleListeners.add(listener);
  return () => {
    idleListeners.delete(listener);
  };
}

/** Runs `fn` with the gate held; released even when `fn` throws. */
export function withHookWrite<T>(fn: () => T): T {
  beginHookWrite();
  try {
    return fn();
  } finally {
    endHookWrite();
  }
}
