/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * Shared bounded wait for the first-run bundled-theme seed. Lives in its own
 * module (no 'vscode' import, no panel dependency) so both surfaces that load
 * a theme on open — the main panel (panel.ts) and the Theater sidebar view
 * (src/extension/main.ts) — can gate their first load on the same promise
 * without importing each other.
 */

/**
 * How long a surface waits for the first-run bundled-theme seed before giving
 * up and rendering whatever is on disk. Exported so tests can reason about it.
 */
export const THEME_SEED_WAIT_MS = 5000;

/**
 * Await `ready` but never longer than THEME_SEED_WAIT_MS, and never reject.
 * Undefined input resolves immediately (nothing was seeding).
 */
export async function waitForBundledThemes(
  ready: Promise<unknown> | undefined,
  timeoutMs: number = THEME_SEED_WAIT_MS,
): Promise<void> {
  // Lazy, best-effort require: log.ts imports 'vscode', which does not exist
  // when this module is loaded from a bare Node process (this file is
  // otherwise vscode-free, and tests/main.ts's non-vscode paths rely on
  // that). Swallow the failure and log nothing rather than throw.
  let log: (msg: string) => void = () => {};
  try {
    log = (require('./log') as typeof import('./log')).log;
  } catch {
    // Not running inside the extension host — logging is a no-op.
  }
  if (!ready) {
    log('waitForBundledThemes: no seed promise supplied, resolving immediately');
    return;
  }
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: 'resolved' | 'timeout' | 'error' = 'timeout';
  try {
    await Promise.race([
      ready.then(() => {
        outcome = 'resolved';
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch (error) {
    outcome = 'error';
    log(`waitForBundledThemes: seed promise rejected: ${String(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
    log(`waitForBundledThemes: outcome=${outcome} waitedMs=${Date.now() - startedAt}`);
  }
}
