/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * VS Code host-side glue for the Corsair Theme Service (p42-t1). Owns:
 *  - the panel-message handlers for THEME_SERVICE_* (see messages.ts)
 *  - the in-memory PKCE code-verifier held between THEME_SERVICE_GOOGLE_START
 *    and the deep-link/pasted-code completion
 *  - status refresh on webview focus, and a bounded poll while a checkout is
 *    pending
 *
 * No `vscode` import is required to be free of side effects at module load
 * (only types are used from it, same posture as themeServiceToken.ts) so
 * this stays unit-testable without a real extension host. The concrete
 * `vscode.SecretStorage`/`openExternal`/URI-handler wiring lives in
 * panel.ts / extension.ts, which own the actual `vscode` calls.
 *
 * Never posts a token: {@link ThemeServiceStatus}-shaped payloads only ever
 * carry signedIn/email/provider/credits/pricing/pendingCheckout/error.
 */

import type * as vscode from "vscode";
import {
  createThemeServiceClient,
  resolveThemeServiceEndpoint,
  type ThemeServiceClient,
  type ThemeServiceStatus,
  type ThemeServicePricing,
  type ThemeServiceError,
} from "../../core/themeServiceClient";
import { createVsCodeThemeServiceTokenStore } from "./themeServiceToken";

export interface ThemeServiceHostStatus {
  signedIn: boolean;
  email?: string;
  provider?: string;
  credits?: number;
  locked?: boolean;
  strikes?: number;
  pricing?: ThemeServicePricing;
  pendingCheckout?: boolean;
  error?: { kind: string; message: string };
  /** p62-t2: whether the sign-in view should show the optional referral-code
   * field — true only while signed out AND {@link ThemeServiceDeviceState.hasEverSignedIn}
   * is false (never on a device that has signed in before). */
  showReferralField?: boolean;
  /** p62-t2: one-shot result line ("Referral applied." / "Referral not
   * applied (<reason>).") surfaced exactly once, immediately after the
   * first sign-in on this device applies a pending referral code. Cleared
   * from the host's side after this single post. */
  referralMessage?: string;
  /** p62-t2: echoes a code set by the vscode://…/sign-in?ref=CODE deep link
   * (or previously typed) back to the webview so its field can show it —
   * pre-fill only, distinct from `referralMessage`. Present only while
   * signed out and a code is pending. */
  referralCodePrefill?: string;
  /** p64-t1: plain hostname of the Theme Service endpoint, present only when
   * an override (VS Code setting / standalone env var) is in effect — never
   * shown against the production endpoint. Rendered in the sign-in area as
   * "Service: <host>". */
  endpointHost?: string;
  /**
   * p65-t2: set alongside `error.kind === "browser_open_failed"` — the
   * Google sign-in URL the browser couldn't be opened for, so the webview
   * can offer "Open the sign-in link" (re-posts THEME_SERVICE_GOOGLE_OPEN)
   * and "Copy link" buttons instead of only the paste-code fallback.
   */
  browserUrl?: string;
  /**
   * p75-t1: set only on OPEN_THEME_BUILDER's immediate reply when no status
   * has ever been fetched yet (no cached snapshot) — the webview shows its
   * normal "Connecting…" state and waits for the THEME_SERVICE_STATUS that
   * follows shortly. Never set on a cached snapshot, even a stale one.
   */
  pending?: boolean;
}

/**
 * p62-t2: per-device "has this device ever completed a sign-in" flag, kept
 * OUTSIDE the token store (it must survive a sign-out, unlike the session
 * token) and outside any project file. VS Code backs this with
 * `context.globalState` (see createVsCodeThemeServiceDeviceState in
 * themeServiceToken.ts); the standalone host backs it with its own
 * app-data file. Never mirrors the referral code itself — only this one
 * boolean.
 */
export interface ThemeServiceDeviceState {
  hasEverSignedIn(): Promise<boolean>;
  markSignedIn(): Promise<void>;
}

export interface ThemeServiceHostOptions {
  secrets: vscode.SecretStorage;
  /**
   * Opens a URL in the user's default browser (vscode.env.openExternal).
   * Returns/resolves `false` on a known failure (matches
   * `vscode.env.openExternal`'s `Thenable<boolean>`); a thrown/rejected
   * error is also treated as failure by handleGoogleStart.
   */
  openExternal: (url: string) => boolean | void | Thenable<boolean | void>;
  /** Posts the current status to the webview. */
  postStatus: (status: ThemeServiceHostStatus) => void;
  /** Injectable client for tests; defaults to a real one on the VS Code token store. */
  client?: ThemeServiceClient;
  /**
   * p64-t1: raw, unvalidated Theme Service endpoint override — the VS Code
   * `tycoonagents.themeService.endpoint` setting value, or the standalone
   * `THEME_SERVICE_ENDPOINT` env var. Validated here via
   * {@link resolveThemeServiceEndpoint}; an invalid value falls back to the
   * production endpoint with one logged warning. Ignored when `client` is
   * supplied directly (tests own their own endpoint then).
   */
  endpointOverride?: string;
  /** p59-t3: extension version sent as the X-Tycoon-Client header on every Theme Service request. */
  clientVersion?: string;
  /** p75-t1: passed through to createThemeServiceClient's statusTimeoutMs; test-only (a real client build ignores this when `client` is injected). */
  statusTimeoutMs?: number;
  /** p62-t2: per-device first-sign-in tracker, gating the referral field and
   * the one-time apply-on-first-sign-in call. Omitting it disables the
   * referral prompt entirely (showReferralField stays false) rather than
   * risking a false "first sign-in" on every call. */
  deviceState?: ThemeServiceDeviceState;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Injectable timers for the OPEN_THEME_BUILDER "waking" retry backoff (p75-t1); default global setTimeout/clearTimeout. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /**
   * p66-t1: optional diagnostic logger (the shared "TycoonAgents" output
   * channel from src/host/vscode/log.ts). Logs step names and hostnames
   * only — never the full authorize URL (it carries a code_challenge) or
   * any key/token. Omitted in tests, where logging is a no-op.
   */
  log?: (msg: string) => void;
  /**
   * p72-t1: the running host's own URI scheme (`vscode.env.uriScheme`) —
   * "vscode" on stable, "vscode-insiders" on Insiders, and whatever a fork
   * (VSCodium, Cursor, Windsurf, Antigravity, ...) reports for itself. Used
   * to build the deep-link redirect so the OS reopens the SAME editor that
   * started sign-in instead of always the stable build. Falls back to
   * "vscode" when omitted or empty.
   */
  uriScheme?: string;
}

const CHECKOUT_POLL_INTERVAL_MS = 5_000;
const CHECKOUT_POLL_MAX_MS = 10 * 60_000;

function toErrorPayload(error: ThemeServiceError): { kind: string; message: string } {
  return { kind: error.kind, message: error.message };
}

/**
 * p66-t1: hostname only, for logging — never logs the full authorize URL
 * (it carries a PKCE code_challenge) or any query string/key.
 */
function hostOnly(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

/**
 * p66-t1 review fix: a thrown openExternal error's `.message` can echo the
 * URL it was given (which carries a PKCE code_challenge) — never logged or
 * posted verbatim. Only a fixed message plus the error's constructor name.
 */
function scrubOpenExternalError(err: unknown): string {
  const ctor = err instanceof Error ? err.constructor.name : typeof err;
  return `couldn't open the browser for sign-in (${ctor})`;
}

export interface ThemeServiceHost {
  handleGetStatus(): Promise<void>;
  /** Same computation as handleGetStatus but returns instead of posting — used by OPEN_THEME_BUILDER's THEME_BUILDER_OPENED reply. */
  getStatusSnapshot(): Promise<ThemeServiceHostStatus>;
  /**
   * p75-t1: the last snapshot successfully built (by getStatusSnapshot,
   * handleGetStatus, or a background retry), if any — returned SYNCHRONOUSLY
   * with no network call, so OPEN_THEME_BUILDER's THEME_BUILDER_OPENED reply
   * never awaits a fetch. `{ signedIn: false, pending: true }` when nothing
   * has ever resolved yet.
   */
  getCachedOrPendingStatus(): ThemeServiceHostStatus;
  /**
   * p75-t1: kicks off a background status/pricing fetch (short
   * statusTimeoutMs) with retry-with-backoff on 503/timeout, posting
   * THEME_SERVICE_STATUS on every result via opts.postStatus. Called right
   * after OPEN_THEME_BUILDER's immediate getCachedOrPendingStatus() reply.
   * Safe to call repeatedly — a new call cancels any retry already pending.
   */
  refreshStatusInBackground(): void;
  /** p75-t1: cancels a pending background retry — called on THEME_BUILDER_CLOSED or panel dispose. */
  cancelBackgroundStatusRetry(): void;
  handleRequestMagicLink(email: string): Promise<void>;
  handleVerify(email: string, code: string): Promise<void>;
  handleGoogleStart(): Promise<void>;
  /**
   * p65-t2: re-opens a Google sign-in URL the webview already has (from a
   * prior browser_open_failed status) WITHOUT starting a new PKCE handshake
   * — the pending code verifier from the original handleGoogleStart is
   * still valid and must not be discarded.
   */
  handleGoogleOpen(): Promise<void>;
  handleGoogleComplete(code: string | undefined): Promise<void>;
  handleSignOut(): Promise<void>;
  handleBuyCredits(pack: string): Promise<void>;
  /** p62-t2: stashes (or clears, when `code` is empty/undefined) the
   * referral code typed/pre-filled in the sign-in field. Never sent
   * anywhere until {@link ThemeServiceHost}'s next successful first
   * sign-in on this device; never persisted. */
  handleSetReferralCode(code: string | undefined): void;
  /** Called by the registered vscode.window.registerUriHandler on a deep-link callback. */
  handleUriCallback(code: string): Promise<void>;
  /**
   * p72-t1: true iff a Google sign-in is currently awaiting its deep-link
   * completion (handleGoogleStart succeeded and nothing has consumed the
   * code verifier yet). The caller (panel.ts's static handleUriCallback)
   * checks this BEFORE calling handleUriCallback, so a stray callback — no
   * sign-in pending on this device/window — can show the code instead of a
   * bare "not signed in" error.
   */
  hasPendingGoogleSignIn(): boolean;
  /**
   * p62-t2: runs the same first-sign-in/referral-apply bookkeeping as
   * handleVerify/handleUriCallback, WITHOUT posting a status. Exposed so a
   * host that reimplements its own sign-in completion path (the standalone
   * host's Google loopback listener, which bypasses handleGoogleComplete —
   * see standalone/src/themeServiceHost.mjs) can still call it right after
   * ITS OWN successful completeGoogleSignIn, before its own postStatus.
   */
  notifySignInSucceeded(): Promise<void>;
  /**
   * The shared {@link ThemeServiceClient} this host was built on (p43-t1) —
   * lets panel.ts wire `themeService.setThemeImageGenerator` to the same
   * authenticated client instance used for status/checkout, instead of
   * constructing a second one.
   */
  getClient(): ThemeServiceClient;
  /**
   * p64-t1: plain hostname of the effective Theme Service endpoint when
   * overridden, else undefined — used by the diagnostic report and by
   * getStatusSnapshot()'s `endpointHost` field.
   */
  getEffectiveEndpointHost(): string | undefined;
  start(): void;
  dispose(): void;
}

/**
 * Factory. `client` defaults to a real {@link createThemeServiceClient} built
 * on the VS Code SecretStorage-backed token store — inject a fake in tests.
 */
export function createThemeServiceHost(opts: ThemeServiceHostOptions): ThemeServiceHost {
  // p66-t1: no-op when the caller (e.g. tests) omits a logger.
  const log = opts.log ?? (() => {});
  // p64-t1: resolved once at construction, regardless of whether `client`
  // is injected — a test-supplied client already owns its own endpoint, so
  // effectiveEndpointHost only reflects the override when this factory is
  // the one building the client.
  const endpointResolution = resolveThemeServiceEndpoint(opts.endpointOverride);
  if (!opts.client && endpointResolution.warning) {
    console.warn(`[tycoonagents] ${endpointResolution.warning}`);
  }
  const effectiveEndpointHost: string | undefined =
    !opts.client && endpointResolution.overridden
      ? new URL(endpointResolution.endpoint).host
      : undefined;
  const client: ThemeServiceClient =
    opts.client ?? createThemeServiceClient({
      tokenStore: createVsCodeThemeServiceTokenStore(opts.secrets),
      clientVersion: opts.clientVersion,
      endpoint: endpointResolution.overridden ? endpointResolution.endpoint : undefined,
      statusTimeoutMs: opts.statusTimeoutMs,
    });
  const now = opts.now ?? (() => Date.now());
  const setIntervalImpl = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearIntervalImpl = opts.clearInterval ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));
  const setTimeoutImpl = opts.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutImpl = opts.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));

  // p75-t1: fixed, never server text — see OPEN_THEME_BUILDER contract.
  const WAKING_MESSAGE = "The theme service is starting up. This can take about a minute.";
  const UNAVAILABLE_MESSAGE = "Theme Service unavailable. No credits were charged.";
  // 5, 10, 20, 30, 30, 30... seconds, up to ~3 minutes total.
  const STATUS_RETRY_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000, 30_000, 30_000];
  const STATUS_RETRY_MAX_TOTAL_MS = 3 * 60_000;

  let disposed = false;
  let pendingGoogleCodeVerifier: string | null = null;
  // p65-t2 (review fix): the webview's THEME_SERVICE_GOOGLE_OPEN payload is
  // advisory only — never trusted. handleGoogleOpen always re-opens THIS
  // stored URL from the matching handleGoogleStart, never a caller-supplied
  // one, so a compromised/buggy webview can't redirect the browser open.
  let pendingGoogleBrowserUrl: string | null = null;
  let lastKnownCredits: number | undefined;
  let pendingCheckout = false;
  let pollHandle: unknown | undefined;
  let pollDeadline = 0;
  let lastCachedPricing: ThemeServicePricing | undefined;
  const deviceState = opts.deviceState;
  // p62-t2: never persisted — see ThemeServiceHostStatus.referralMessage /
  // handleSetReferralCode docs above.
  let pendingReferralCode: string | null = null;
  let pendingReferralMessage: string | undefined;
  // p75-t1: last snapshot successfully built, for OPEN_THEME_BUILDER's
  // immediate (no-await) reply. Never cleared on a later failure — a stale
  // signed-in snapshot is a better first paint than a bare "Connecting…".
  let lastSnapshot: ThemeServiceHostStatus | undefined;
  let statusRetryHandle: unknown | undefined;
  let statusRetryGeneration = 0;

  /**
   * Called right after ANY sign-in completes successfully (magic-link
   * verify or Google complete, whichever host performs it — the standalone
   * host also calls this via getClient()-adjacent wiring is NOT needed
   * since it reuses this same function through the returned host object).
   * Applies a pending referral code exactly once, only on this device's
   * first-ever sign-in, then always clears the pending code (never sent on
   * a later sign-in).
   */
  async function afterSignInSucceeded(): Promise<void> {
    let wasFirstSignIn = false;
    if (deviceState) {
      try {
        wasFirstSignIn = !(await deviceState.hasEverSignedIn());
      } catch {
        wasFirstSignIn = false;
      }
      try {
        await deviceState.markSignedIn();
      } catch {
        /* best-effort; worst case the referral prompt reappears next time */
      }
    }
    const code = pendingReferralCode;
    pendingReferralCode = null;
    if (!wasFirstSignIn || !code) return;
    const res = await client.applyReferralCode(code);
    if (res.ok) {
      pendingReferralMessage = res.value.applied
        ? "Referral applied."
        : `Referral not applied (${res.value.reason ?? "unknown"}).`;
    }
    // On a network/server failure, drop it silently — sign-in itself already
    // succeeded and must not appear to have failed over the referral call.
  }

  function stopPoll(): void {
    if (pollHandle !== undefined) {
      clearIntervalImpl(pollHandle);
      pollHandle = undefined;
    }
    pendingCheckout = false;
  }

  async function buildStatus(): Promise<ThemeServiceHostStatus> {
    const res = await client.getStatus();
    if (!res.ok) {
      return { signedIn: false, pendingCheckout, error: toErrorPayload(res.error) };
    }
    const status: ThemeServiceStatus = res.value;
    // Refetch pricing on every status build (it can change server-side);
    // the cached copy is kept only as a fallback when the refetch fails.
    const pricingRes = await client.getPricing();
    if (pricingRes.ok) lastCachedPricing = pricingRes.value;
    let showReferralField = false;
    if (!status.signedIn && deviceState) {
      try {
        showReferralField = !(await deviceState.hasEverSignedIn());
      } catch {
        showReferralField = false;
      }
    }
    const referralMessage = pendingReferralMessage;
    pendingReferralMessage = undefined;
    return {
      signedIn: status.signedIn,
      email: status.email,
      provider: status.role,
      credits: status.credits,
      locked: status.locked,
      strikes: status.strikes,
      pricing: lastCachedPricing,
      pendingCheckout,
      showReferralField,
      referralMessage,
      referralCodePrefill: !status.signedIn && pendingReferralCode ? pendingReferralCode : undefined,
      endpointHost: effectiveEndpointHost,
    };
  }

  async function postFreshStatus(): Promise<void> {
    if (disposed) return;
    const status = await buildStatus();
    lastSnapshot = status;
    opts.postStatus(status);
  }

  /**
   * p75-t1: same as buildStatus, but a 503/timeout from the status/pricing
   * fetch is remapped to kind "waking" (fixed message) instead of
   * "unavailable" — used only by the OPEN_THEME_BUILDER open flow and its
   * background retry, never by handleGetStatus/poll, which keep their
   * existing "unavailable" behavior.
   */
  async function buildSnapshotForOpen(): Promise<ThemeServiceHostStatus> {
    const status = await buildStatus();
    if (status.error && (status.error.kind === "unavailable" || status.error.kind === "timeout")) {
      return { ...status, error: { kind: "waking", message: WAKING_MESSAGE } };
    }
    return status;
  }

  function stopStatusRetry(): void {
    statusRetryGeneration++;
    if (statusRetryHandle !== undefined) {
      clearTimeoutImpl(statusRetryHandle);
      statusRetryHandle = undefined;
    }
  }

  /**
   * Runs one background snapshot fetch, posts it, and — if it's still
   * "waking" — schedules the next retry per STATUS_RETRY_BACKOFF_MS, up to
   * STATUS_RETRY_MAX_TOTAL_MS total, after which it posts a final
   * "unavailable" result and stops.
   */
  function scheduleStatusRetry(attemptIndex: number, elapsedMs: number, generation: number): void {
    const delay = STATUS_RETRY_BACKOFF_MS[Math.min(attemptIndex, STATUS_RETRY_BACKOFF_MS.length - 1)];
    if (elapsedMs + delay > STATUS_RETRY_MAX_TOTAL_MS) {
      if (disposed || generation !== statusRetryGeneration) return;
      lastSnapshot = { signedIn: false, pendingCheckout, error: { kind: "unavailable", message: UNAVAILABLE_MESSAGE } };
      opts.postStatus(lastSnapshot);
      return;
    }
    statusRetryHandle = setTimeoutImpl(() => {
      void (async () => {
        if (disposed || generation !== statusRetryGeneration) return;
        const status = await buildSnapshotForOpen();
        if (disposed || generation !== statusRetryGeneration) return;
        lastSnapshot = status;
        opts.postStatus(status);
        if (status.error?.kind === "waking") {
          scheduleStatusRetry(attemptIndex + 1, elapsedMs + delay, generation);
        }
      })();
    }, delay);
  }

  async function pollTick(): Promise<void> {
    if (disposed) return;
    if (now() >= pollDeadline) {
      stopPoll();
      await postFreshStatus();
      return;
    }
    const res = await client.getStatus();
    if (res.ok && res.value.signedIn) {
      const credits = res.value.credits;
      if (lastKnownCredits !== undefined && credits !== undefined && credits > lastKnownCredits) {
        lastKnownCredits = credits;
        stopPoll();
        await postFreshStatus();
        return;
      }
      if (credits !== undefined) lastKnownCredits = credits;
    }
    // Keep polling; no separate status post per tick beyond the terminal ones
    // above, to avoid spamming the webview every 5s.
  }

  function startPoll(): void {
    stopPoll();
    pendingCheckout = true;
    pollDeadline = now() + CHECKOUT_POLL_MAX_MS;
    pollHandle = setIntervalImpl(() => {
      void pollTick();
    }, CHECKOUT_POLL_INTERVAL_MS);
  }

  async function completeGoogle(authCode: string | undefined): Promise<void> {
    if (!authCode || authCode.length === 0) return;
    const codeVerifier = pendingGoogleCodeVerifier;
    if (!codeVerifier) {
      opts.postStatus({ signedIn: false, pendingCheckout, error: { kind: "not_signed_in", message: "no pending Google sign-in" } });
      return;
    }
    pendingGoogleCodeVerifier = null;
    pendingGoogleBrowserUrl = null;
    const res = await client.completeGoogleSignIn({ authCode, codeVerifier });
    if (!res.ok) {
      opts.postStatus({ signedIn: false, pendingCheckout, error: toErrorPayload(res.error) });
      return;
    }
    await afterSignInSucceeded();
    await postFreshStatus();
  }

  return {
    async handleGetStatus() {
      await postFreshStatus();
    },

    async getStatusSnapshot() {
      const status = await buildSnapshotForOpen();
      lastSnapshot = status;
      return status;
    },

    getCachedOrPendingStatus() {
      return lastSnapshot ?? { signedIn: false, pending: true };
    },

    refreshStatusInBackground() {
      stopStatusRetry();
      const generation = statusRetryGeneration;
      void (async () => {
        if (disposed || generation !== statusRetryGeneration) return;
        const status = await buildSnapshotForOpen();
        if (disposed || generation !== statusRetryGeneration) return;
        lastSnapshot = status;
        opts.postStatus(status);
        if (status.error?.kind === "waking") {
          scheduleStatusRetry(0, 0, generation);
        }
      })();
    },

    cancelBackgroundStatusRetry() {
      stopStatusRetry();
    },

    async handleRequestMagicLink(email) {
      const res = await client.requestMagicLink(email);
      if (!res.ok) {
        opts.postStatus({ signedIn: false, pendingCheckout, error: toErrorPayload(res.error) });
        return;
      }
      await postFreshStatus();
    },

    async handleVerify(email, code) {
      const res = await client.verifyMagicLink(email, code);
      if (!res.ok) {
        opts.postStatus({ signedIn: false, pendingCheckout, error: toErrorPayload(res.error) });
        return;
      }
      await afterSignInSucceeded();
      await postFreshStatus();
    },

    async handleGoogleStart() {
      log("themeServiceHost.handleGoogleStart: start");
      // publisher.name for the deep-link authority, resolved by the caller
      // (panel.ts) via package.json. The SCHEME is the running host's own
      // (opts.uriScheme, i.e. vscode.env.uriScheme) so the OS reopens
      // whichever editor — stable, Insiders, or a fork — started this
      // sign-in, instead of always vscode://. Falls back to "vscode" when
      // the host didn't supply one (e.g. an older test double).
      const scheme = opts.uriScheme && opts.uriScheme.length > 0 ? opts.uriScheme : "vscode";
      const redirectTo = `${scheme}://tycoonagents.tycoonagents/theme-service-auth`;
      const res = await client.startGoogleSignIn({ redirectTo });
      if (!res.ok) {
        log(`themeServiceHost.handleGoogleStart: startGoogleSignIn failed kind=${res.error.kind}`);
        opts.postStatus({ signedIn: false, pendingCheckout, error: toErrorPayload(res.error) });
        return;
      }
      pendingGoogleCodeVerifier = res.value.codeVerifier;
      const browserUrl = res.value.browserUrl;
      pendingGoogleBrowserUrl = browserUrl;
      // browserUrl is the Supabase-hosted authorize endpoint, so its host is
      // also the resolved auth-config Supabase host — one log line covers both.
      log(`themeServiceHost.handleGoogleStart: auth-config resolved, authorize URL built host=${hostOnly(browserUrl)}`);
      // Review fix: post the browserUrl status BEFORE awaiting openExternal
      // so the fallback link is available immediately, and so a fast
      // deep-link completion (which posts signedIn:true) can never be
      // overwritten by this handler's own post landing after it.
      opts.postStatus({ signedIn: false, pendingCheckout, browserUrl });
      let opened: boolean | void;
      try {
        opened = await opts.openExternal(browserUrl);
      } catch (err) {
        log(`themeServiceHost.handleGoogleStart: openExternal threw: ${scrubOpenExternalError(err)}`);
        // Completion (handleGoogleComplete/handleUriCallback) clears
        // pendingGoogleCodeVerifier on success — if it's already gone, sign-in
        // finished while openExternal was pending, so skip this post entirely
        // rather than clobbering the signedIn:true status just delivered.
        if (pendingGoogleCodeVerifier !== null) {
          opts.postStatus({
            signedIn: false,
            pendingCheckout,
            error: { kind: "browser_open_failed", message: scrubOpenExternalError(err) },
            browserUrl,
          });
        }
        return;
      }
      if (opened === false) {
        log("themeServiceHost.handleGoogleStart: openExternal returned false");
        if (pendingGoogleCodeVerifier !== null) {
          opts.postStatus({
            signedIn: false,
            pendingCheckout,
            error: { kind: "browser_open_failed", message: "couldn't open the browser for sign-in" },
            browserUrl,
          });
        }
        return;
      }
      log("themeServiceHost.handleGoogleStart: openExternal succeeded");
      // Nothing further to post on success — the pre-await post above already
      // delivered browserUrl, and posting again here risks overwriting a
      // signedIn:true the deep-link completion posted in the meantime.
    },

    async handleGoogleOpen() {
      const url = pendingGoogleBrowserUrl;
      if (!url) return;
      log(`themeServiceHost.handleGoogleOpen: reopening host=${hostOnly(url)}`);
      let opened: boolean | void;
      try {
        opened = await opts.openExternal(url);
      } catch (err) {
        log(`themeServiceHost.handleGoogleOpen: openExternal threw: ${scrubOpenExternalError(err)}`);
        opts.postStatus({
          signedIn: false,
          pendingCheckout,
          error: { kind: "browser_open_failed", message: scrubOpenExternalError(err) },
          browserUrl: url,
        });
        return;
      }
      if (opened === false) {
        log("themeServiceHost.handleGoogleOpen: openExternal returned false");
        opts.postStatus({
          signedIn: false,
          pendingCheckout,
          error: { kind: "browser_open_failed", message: "couldn't open the browser for sign-in" },
          browserUrl: url,
        });
        return;
      }
      log("themeServiceHost.handleGoogleOpen: openExternal succeeded");
      opts.postStatus({ signedIn: false, pendingCheckout, browserUrl: url });
    },

    async handleGoogleComplete(code) {
      await completeGoogle(code);
    },

    async handleUriCallback(code) {
      await completeGoogle(code);
    },

    hasPendingGoogleSignIn() {
      return pendingGoogleCodeVerifier !== null;
    },

    getClient() {
      return client;
    },

    getEffectiveEndpointHost() {
      return effectiveEndpointHost;
    },

    handleSetReferralCode(code) {
      const trimmed = code?.trim();
      pendingReferralCode = trimmed && trimmed.length > 0 ? trimmed : null;
    },

    async notifySignInSucceeded() {
      await afterSignInSucceeded();
    },

    async handleSignOut() {
      await client.signOut();
      stopPoll();
      lastKnownCredits = undefined;
      await postFreshStatus();
    },

    async handleBuyCredits(pack) {
      // Refetch pricing immediately before checkout so the pack picker (and
      // any price shown to the user) reflects current pricing at purchase
      // time; keep the cached copy if this refetch fails.
      const pricingRes = await client.getPricing();
      if (pricingRes.ok) lastCachedPricing = pricingRes.value;
      const res = await client.createCheckoutSession(pack);
      if (!res.ok) {
        opts.postStatus({ signedIn: false, pendingCheckout, error: toErrorPayload(res.error) });
        return;
      }
      const statusRes = await client.getStatus();
      lastKnownCredits = statusRes.ok ? statusRes.value.credits : undefined;
      await opts.openExternal(res.value.url);
      startPoll();
      await postFreshStatus();
    },

    start() {
      disposed = false;
    },

    dispose() {
      disposed = true;
      stopStatusRetry();
      stopPoll();
      pendingGoogleCodeVerifier = null;
      pendingGoogleBrowserUrl = null;
      pendingReferralCode = null;
      pendingReferralMessage = undefined;
    },
  };
}
