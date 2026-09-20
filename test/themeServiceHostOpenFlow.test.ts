/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p75-t1/t3: tests for the builder-first Theme Builder open flow in
// src/host/vscode/themeServiceHost.ts — getCachedOrPendingStatus(),
// refreshStatusInBackground(), the "waking" remap of unavailable/timeout
// errors, the 5/10/20/30s (capped ~3min) retry backoff, and
// cancelBackgroundStatusRetry()/dispose() stopping it. All deterministic:
// a hand-written fake ThemeServiceClient and injected setTimeout/clearTimeout
// (no real timers, no network).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createThemeServiceHost,
  type ThemeServiceHostStatus,
} from "../src/host/vscode/themeServiceHost";
import type {
  ThemeServiceClient,
  ThemeServiceResult,
  ThemeServiceStatus,
  ThemeServicePricing,
} from "../src/core/themeServiceClient";

const PRICING: ThemeServicePricing = {
  typicalTheme: { min: 8, max: 20, typical: 14 },
  packs: [],
} as unknown as ThemeServicePricing;

function okStatus(value: Partial<ThemeServiceStatus> = {}): ThemeServiceResult<ThemeServiceStatus> {
  return { ok: true, value: { signedIn: false, ...value } as ThemeServiceStatus };
}

function errResult<T>(kind: string, message = kind): ThemeServiceResult<T> {
  return { ok: false, error: { kind, message } as any };
}

/** A fake timer queue: setTimeout/clearTimeout that only fire on explicit advance(). */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  return {
    setTimeout(fn: () => void, ms: number): number {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id: unknown): void {
      pending.delete(id as number);
    },
    /** Advances virtual time and fires (in order) any timers now due. Re-checks
     * after each fire since firing one may schedule another at/after `now`. */
    async advance(ms: number): Promise<void> {
      now += ms;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let dueId: number | undefined;
        let due: { at: number; fn: () => void } | undefined;
        for (const [id, t] of pending) {
          if (t.at <= now && (due === undefined || t.at < due.at)) {
            dueId = id;
            due = t;
          }
        }
        if (due === undefined || dueId === undefined) break;
        pending.delete(dueId);
        due.fn();
        // Let any queued microtasks (the host's async retry closures) run
        // before checking for newly-scheduled timers.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    activeCount(): number {
      return pending.size;
    },
  };
}

/**
 * A minimal fake ThemeServiceClient. `statusQueue` is consumed one entry per
 * getStatus() call (last entry repeats once exhausted); `neverResolve: true`
 * makes getStatus() return a promise that never settles.
 */
function fakeClient(opts: {
  statusQueue?: Array<ThemeServiceResult<ThemeServiceStatus>>;
  neverResolve?: boolean;
}): { client: ThemeServiceClient; getStatusCalls: () => number } {
  const queue = opts.statusQueue ? [...opts.statusQueue] : [];
  let calls = 0;
  const client: Partial<ThemeServiceClient> = {
    async getStatus() {
      calls++;
      if (opts.neverResolve) return new Promise<ThemeServiceResult<ThemeServiceStatus>>(() => {});
      if (queue.length === 0) return okStatus();
      return queue.length > 1 ? queue.shift()! : queue[0];
    },
    async getPricing() {
      return { ok: true, value: PRICING };
    },
  };
  return { client: client as ThemeServiceClient, getStatusCalls: () => calls };
}

function setup(opts: { statusQueue?: Array<ThemeServiceResult<ThemeServiceStatus>>; neverResolve?: boolean }) {
  const { client, getStatusCalls } = fakeClient(opts);
  const posted: ThemeServiceHostStatus[] = [];
  const timers = fakeTimers();
  const host = createThemeServiceHost({
    secrets: {} as any,
    client,
    openExternal: () => true,
    postStatus: (status) => posted.push(status),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  host.start();
  return { host, posted, timers, getStatusCalls };
}

test("getCachedOrPendingStatus returns pending:true synchronously when no snapshot exists yet (client never resolves)", () => {
  const { host } = setup({ neverResolve: true });
  const snapshot = host.getCachedOrPendingStatus();
  assert.deepEqual(snapshot, { signedIn: false, pending: true });
});

test("refreshStatusInBackground: 503 then signed-out posts waking first, then the signed-out status after 5s", async () => {
  const { host, posted, timers } = setup({
    statusQueue: [errResult("unavailable"), okStatus({ signedIn: false })],
  });

  host.refreshStatusInBackground();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(posted.length, 1, "expected the first (waking) post before any time advances");
  assert.equal(posted[0].error?.kind, "waking");
  assert.equal(
    posted[0].error?.message,
    "The theme service is starting up. This can take about a minute.",
  );

  await timers.advance(5_000);
  assert.equal(posted.length, 2, "expected the retry to post after the 5s backoff");
  assert.equal(posted[1].signedIn, false);
  assert.equal(posted[1].error, undefined);
});

test("retry sequence follows 5/10/20/30s and gives up with kind unavailable and the fixed message", async () => {
  // Derive the expected schedule from the host's own constants
  // (STATUS_RETRY_BACKOFF_MS = [5000,10000,20000,30000,30000,30000],
  // STATUS_RETRY_MAX_TOTAL_MS = 180000) rather than guessing: each attempt i
  // (0-based) uses delay = BACKOFF[min(i, BACKOFF.length-1)], and a delay is
  // only actually scheduled while elapsed+delay <= 180000; the round that
  // would exceed the cap gives up immediately instead of scheduling.
  const BACKOFF = [5_000, 10_000, 20_000, 30_000, 30_000, 30_000];
  const MAX_TOTAL = 3 * 60_000;
  const expectedDelays: number[] = [];
  {
    let elapsed = 0;
    let i = 0;
    while (true) {
      const delay = BACKOFF[Math.min(i, BACKOFF.length - 1)];
      if (elapsed + delay > MAX_TOTAL) break;
      expectedDelays.push(delay);
      elapsed += delay;
      i++;
    }
  }

  const alwaysUnavailable = errResult<ThemeServiceStatus>("unavailable");
  const { client, getStatusCalls } = fakeClient({ statusQueue: [alwaysUnavailable] });
  const posted: ThemeServiceHostStatus[] = [];
  const timers = fakeTimers();
  const recordedDelays: number[] = [];
  const host = createThemeServiceHost({
    secrets: {} as any,
    client,
    openExternal: () => true,
    postStatus: (status) => posted.push(status),
    setTimeout: ((fn: () => void, ms: number) => {
      recordedDelays.push(ms);
      return timers.setTimeout(fn, ms);
    }) as any,
    clearTimeout: timers.clearTimeout,
  });
  host.start();

  host.refreshStatusInBackground();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].error?.kind, "waking");

  // Drive the retry loop forward in 30s steps — enough to exceed the ~3
  // minute total cap and force the final give-up post — stopping as soon as
  // no timer remains scheduled.
  for (let i = 0; i < 12 && timers.activeCount() > 0; i++) {
    await timers.advance(30_000);
  }

  assert.deepEqual(
    recordedDelays,
    expectedDelays,
    "scheduled retry delays must match the constant-derived backoff/cap sequence",
  );

  // getStatus is called once for the initial fetch plus once per scheduled
  // retry, and NOT again for the final give-up post (which is synthesized
  // without another fetch).
  assert.equal(getStatusCalls(), expectedDelays.length + 1);

  // After exhausting the backoff schedule past the ~3 minute cap, the final
  // post must be the fixed "unavailable" result, not another "waking".
  const last = posted[posted.length - 1];
  assert.equal(last.error?.kind, "unavailable");
  assert.equal(last.error?.message, "Theme Service unavailable. No credits were charged.");
  assert.equal(timers.activeCount(), 0, "no timer should remain scheduled once the retry gives up");
});

test("cancelBackgroundStatusRetry stops the timer — no further posts after advancing time", async () => {
  const alwaysUnavailable = errResult<ThemeServiceStatus>("unavailable");
  const { host, posted, timers } = setup({ statusQueue: [alwaysUnavailable] });

  host.refreshStatusInBackground();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(posted.length, 1);

  host.cancelBackgroundStatusRetry();
  assert.equal(timers.activeCount(), 0, "cancel must clear the pending retry timer");

  await timers.advance(60_000);
  assert.equal(posted.length, 1, "no post should land after cancellation, however far time advances");
});

test("dispose stops the retry — no further posts after advancing time", async () => {
  const alwaysUnavailable = errResult<ThemeServiceStatus>("unavailable");
  const { host, posted, timers } = setup({ statusQueue: [alwaysUnavailable] });

  host.refreshStatusInBackground();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(posted.length, 1);

  host.dispose();
  await timers.advance(60_000);
  assert.equal(posted.length, 1, "no post should land after dispose, however far time advances");
});

test("a second refresh during a pending retry does not double-post", async () => {
  const alwaysUnavailable = errResult<ThemeServiceStatus>("unavailable");
  const { host, posted, timers, getStatusCalls } = setup({ statusQueue: [alwaysUnavailable] });

  host.refreshStatusInBackground();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(posted.length, 1);
  const callsAfterFirst = getStatusCalls();

  // A second refresh call cancels the first retry's timer and starts its own
  // — the stale first retry must never fire once superseded.
  host.refreshStatusInBackground();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(posted.length, 2, "the second refresh's own immediate fetch should post once");

  await timers.advance(5_000);
  // Only the second refresh's own retry chain may have fired at 5s — never
  // both, which would double the getStatus call count and post twice more.
  assert.ok(posted.length <= 3, `expected at most one retry post at 5s, got ${posted.length - 2} extra`);
  assert.equal(getStatusCalls() - callsAfterFirst <= 2, true);
});

test("401 (not_signed_in) is NOT remapped to waking", async () => {
  const { host, posted } = setup({ statusQueue: [errResult("not_signed_in")] });
  host.refreshStatusInBackground();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].error?.kind, "not_signed_in");
});

test("timeout is remapped to waking, same as unavailable", async () => {
  const { host, posted } = setup({ statusQueue: [errResult("timeout")] });
  host.refreshStatusInBackground();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].error?.kind, "waking");
});
