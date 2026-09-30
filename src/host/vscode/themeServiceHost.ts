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
  /**
   * p91-t2 fix: optional, not just boolean — a definitive `false` tells the
   * webview the account is signed out (hides the credits chip, wipes its
   * cached balance). A transient failure (buildStatus's catch,
   * refreshStatusInBackground/scheduleStatusRetry's safety nets) must never
   * claim that; it omits signedIn so the webview's signedInKnown/cache
   * fallback applies instead of a false sign-out.
   */
  signedIn?: boolean;
  email?: string;
  /** Additive: the Supabase account id (JWT `sub` claim), display-only, for
   * support reports. Best-effort/unverified — never used for anything
   * security-sensitive. Omitted whenever it isn't known yet. */
  userId?: string;
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
  /**
   * p92: true iff the token store holds a session (no network validation),
   * false when it definitely doesn't, undefined when that couldn't be
   * checked. Lets the webview tell "genuinely signed out" apart from "a
   * session exists but this status fetch failed/timed out" when signedIn
   * can't be confirmed true — the latter must never show Sign in.
   */
  hasStoredSession?: boolean;
  /**
   * Follow-up fix: the last credits balance persisted in
   * {@link ThemeServiceCreditsCache} (VS Code: `ExtensionContext.globalState`,
   * keyed by user id — survives across sessions/restarts, unlike the
   * webview's own localStorage, which is a per-viewer convenience only and
   * can be empty on a private window or cleared site data). Set on every
   * status this host builds, including the very first synchronous reply at
   * panel open (getCachedOrPendingStatus), BEFORE any network call. Additive
   * only — a host/build that never wires a creditsCache simply omits it, and
   * older webview code that doesn't know this field behaves exactly as
   * before. The webview prefers the live `credits` field first, then this
   * field, then its own localStorage cache.
   */
  cachedCredits?: number;
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

/**
 * Follow-up fix: durable, cross-session last-known-balance cache — stores
 * ONLY a user id and a credits number, never a token/secret. VS Code backs
 * this with `context.globalState` (see createVsCodeThemeServiceCreditsCache
 * in themeServiceCreditsCache.ts), a per-device Memento that survives a
 * window/VS Code restart, unlike the webview's own localStorage (which this
 * host cache backs up, not replaces — the webview still prefers a live
 * value first).
 *
 * Review fix: `get()`'s record is keyed by user id precisely because a
 * caller MUST validate it against the currently-known signed-in user id
 * before surfacing its `credits` as `cachedCredits` — a stale record from a
 * DIFFERENT account (an account switch on the same device) must never be
 * shown under the newly-signed-in user just because it happens to be the
 * only thing in the cache. createThemeServiceHost's cachedCreditsField()
 * does this check (against its own in-memory `currentUserId`, updated on
 * every definitive signed-in status) and omits `cachedCredits` entirely
 * when the current account isn't known yet or doesn't match.
 */
export interface ThemeServiceCreditsCache {
  get(): { userId: string; credits: number } | undefined;
  set(userId: string, credits: number): void | Promise<void>;
  clear(): void | Promise<void>;
}

/**
 * p83-t1: the shape of a parsed `/theme-service-auth` callback URI, built
 * by the host's static URI handler (panel.ts / standalone equivalent) and
 * handed to {@link ThemeServiceHost.handleUriCallback}. Only parameter
 * NAMES are ever carried for logging (`queryParamNames`/
 * `fragmentParamNames`) — never a raw query string or fragment, and never
 * anything not explicitly named here (code/tokens/error code only).
 */
export interface GoogleCallbackParams {
  /** PKCE `?code=` query parameter, when present. */
  code?: string;
  /** Implicit-flow `#access_token=` fragment parameter, when present. */
  accessToken?: string;
  /** Implicit-flow `#refresh_token=` fragment parameter, when present. */
  refreshToken?: string;
  /** Implicit-flow `#expires_in=` fragment parameter, when present. */
  expiresIn?: number;
  /** Standard OAuth `error`/`error_description` code name (e.g. "access_denied") from the query or fragment — never the description text verbatim. */
  errorCode?: string;
  /** Names only (never values) of every query parameter on the callback URI, for logging. */
  queryParamNames?: string[];
  /** Names only (never values) of every fragment parameter on the callback URI, for logging. */
  fragmentParamNames?: string[];
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
  /**
   * p87: posts THEME_SERVICE_GOOGLE_OPENED once openExternal settles (or
   * the attempt fails before reaching it) for a Google sign-in — lets the
   * webview leave its "Contacting sign-in service…" loading state. Optional
   * so older test doubles that don't care about this transition still
   * compile; a real panel always supplies it.
   */
  postGoogleOpened?: (result: { ok: boolean; error?: { kind: string; message: string } }) => void;
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
  /**
   * Follow-up fix: durable per-device last-known-balance cache, backed by
   * ExtensionContext.globalState. Omitting it (older callers, tests) simply
   * means `cachedCredits` is never set on any status — no behavior change.
   */
  creditsCache?: ThemeServiceCreditsCache;
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
  // Follow-up fix: the rate_limited message text (minute/day/provider,
  // built from scope/limit/retryAfterSeconds) is constructed once in
  // themeServiceClient.ts's 429 handling — the single place both this
  // status/sign-in path AND per-item image-generation errors (see
  // themeService.ts, which uses the same ThemeServiceClient) get their
  // ThemeServiceError from. Nothing to build here; just pass it through.
  return { kind: error.kind, message: error.message };
}

/**
 * p66-t1: hostname only, for logging — never logs the full authorize URL
 * (it carries a PKCE code_challenge) or any query string/key.
 */
/**
 * p87: validates the optional `authLandingUrl` from GET /api/auth-config —
 * must be a well-formed absolute https URL, and kept to a sane length so a
 * malformed/huge value can't be smuggled into redirect_to. Invalid input is
 * ignored (caller falls back to the direct deep link) rather than failing
 * sign-in outright.
 */
function isValidAuthLandingUrl(url: string): boolean {
  if (url.length === 0 || url.length > 2048) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

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
  /**
   * Applies the authoritative post-attempt balance (`credits` from a
   * successful /api/generate or /api/plan response) immediately: updates the
   * last snapshot, the durable balance cache and posts THEME_SERVICE_STATUS,
   * instead of waiting for the next /api/account poll. A no-op when no
   * signed-in snapshot exists yet or `credits` is not a finite number.
   */
  applyCreditsFromAttempt(credits: number): void;
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
  /**
   * Called by the registered vscode.window.registerUriHandler on a
   * deep-link callback. A plain string is the legacy shape (a bare
   * `code`, kept for backward compatibility with the pasted-code path and
   * existing callers). p83-t1: a {@link GoogleCallbackParams} object
   * additionally covers the implicit flow (`access_token`/`refresh_token`
   * in the URL fragment) and an OAuth `error` code, plus the query/
   * fragment parameter NAMES (never values) for logging.
   */
  handleUriCallback(input: string | GoogleCallbackParams): Promise<void>;
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

  // Follow-up fix: durable cachedCredits field, read/written through
  // opts.creditsCache (ExtensionContext.globalState-backed; see
  // ThemeServiceCreditsCache's doc comment). Every helper here swallows its
  // own errors — a broken/throwing cache must never take down a status
  // build or a sign-out.
  //
  // Review fix: `currentUserId` is this host's own in-memory record of the
  // last account it definitively confirmed signed in (set only from a
  // successful buildStatus fetch — see below). cachedCreditsField() gates
  // its read on this matching the cache's own userId, so a stale balance
  // from a DIFFERENT account (an account switch, or simply a fresh host
  // process that hasn't confirmed anyone yet) is never surfaced as
  // `cachedCredits`. When currentUserId isn't known yet, cachedCredits is
  // omitted entirely — never a guess.
  let currentUserId: string | undefined;
  /**
   * Additive: the Supabase account id (JWT `sub`), display-only, surfaced on
   * the status as `userId` for support reports. Separate from
   * `currentUserId` above (which tracks email and gates the credits cache) —
   * this never falls back to email. Best-effort: a failed/empty decode just
   * means the account-id line stays hidden in the webview.
   */
  let accountUserId: string | undefined;
  async function refreshAccountUserId(): Promise<void> {
    try {
      const id = await client.getStoredUserId();
      if (id) accountUserId = id;
    } catch {
      // best-effort only
    }
  }
  /**
   * Follow-up fix: after a full VS Code restart, currentUserId starts
   * unknown and stayed that way until the first live status fetch
   * succeeded — so cachedCredits was never offered at panel open right
   * after a restart, exactly when a Render cold start makes it matter most
   * (the user saw "…" again). Seed it here from the STORED session alone
   * (client.getStoredIdentity — SecretStorage + an unverified JWT claim
   * read, no network call — see its doc comment), started fire-and-forget
   * from start() so it's normally done well before the webview's first
   * status request even without being awaited anywhere. Never overwrites an
   * already-confirmed currentUserId (a live fetch's result always wins).
   */
  async function seedCurrentUserIdFromStoredSession(): Promise<void> {
    if (currentUserId) return;
    try {
      const identity = await client.getStoredIdentity();
      if (identity && !currentUserId) currentUserId = identity;
      await refreshAccountUserId();
    } catch {
      // best-effort only — an unseeded currentUserId just means
      // cachedCredits stays omitted until the first live fetch, same as
      // before this fix.
    }
  }
  function cachedCreditsField(): { cachedCredits?: number } {
    try {
      if (!currentUserId) return {};
      const v = opts.creditsCache?.get();
      return v && v.userId === currentUserId && typeof v.credits === "number"
        ? { cachedCredits: v.credits }
        : {};
    } catch {
      return {};
    }
  }
  function persistCredits(userId: string | undefined, credits: number | undefined): void {
    if (!opts.creditsCache || !userId || typeof credits !== "number") return;
    try {
      void Promise.resolve(opts.creditsCache.set(userId, credits)).catch(() => {});
    } catch {
      // ignore — the durable cache is a convenience, not a requirement
    }
  }
  function clearPersistedCredits(): void {
    if (!opts.creditsCache) return;
    try {
      void Promise.resolve(opts.creditsCache.clear()).catch(() => {});
    } catch {
      // ignore
    }
  }

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
  // p92: last successfully-checked hasStoredSession, used as a fallback when
  // a fresh client.hasStoredSession() call throws, and for the synchronous
  // pending stub in getCachedOrPendingStatus (which can't await one).
  let cachedHasStoredSession: boolean | undefined;
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
    // p91 fix: this whole body used to be un-caught — a thrown exception
    // anywhere in here (client.getStatus()/getPricing(), a rejected
    // deviceState call slipping past its own try, etc.) meant the caller's
    // await never resolved, so a pending:true stub the webview already
    // showed ("…") never got a follow-up post and stayed there forever. This
    // is the single point every status-producing path (postFreshStatus,
    // buildSnapshotForOpen, refreshStatusInBackground, scheduleStatusRetry)
    // goes through, so catching here guarantees ALL of them always resolve
    // to a terminal status instead of throwing.
    // p92: checked once per buildStatus call, outside the main try, so a
    // throw here can't skip the terminal-status guarantee the try/catch
    // below provides. No network call (see hasStoredSession's own doc).
    let hasStoredSession: boolean | undefined;
    try {
      hasStoredSession = await client.hasStoredSession();
      cachedHasStoredSession = hasStoredSession;
    } catch {
      hasStoredSession = cachedHasStoredSession;
    }
    try {
      const res = await client.getStatus();
      if (!res.ok) {
        // Bug fix (v0.0.661): only a DEFINITIVE sign-out ("not_signed_in" —
        // no session, or a session whose refresh was rejected, e.g. a
        // revoked/expired refresh token or a 401 the client couldn't
        // recover from; see clearSession() in themeServiceClient.ts)
        // reports signedIn:false. Every other kind here (timeout,
        // unreachable, server_error, unavailable, invalid_response,
        // rate_limited, ...) is a TRANSIENT failure of the status fetch
        // itself and must omit signedIn, exactly like buildStatus's own
        // catch below — otherwise a real signed-in user's brief network
        // hiccup gets reported as a definitive sign-out, wiping the
        // webview's cached credits balance (writeCachedThemeServiceStatus)
        // and leaving no way back to a signed-in view once the network
        // recovers.
        const definitiveSignOut = res.error.kind === "not_signed_in";
        if (definitiveSignOut) {
          clearPersistedCredits();
          currentUserId = undefined;
          accountUserId = undefined;
        }
        return {
          ...(definitiveSignOut ? { signedIn: false as const } : {}),
          pendingCheckout,
          error: toErrorPayload(res.error),
          ...(typeof hasStoredSession === "boolean" ? { hasStoredSession } : {}),
          // A definitive sign-out never carries a stale cachedCredits; every
          // other (transient) kind still offers it so the webview has
          // something to show during the hiccup.
          ...(definitiveSignOut ? {} : cachedCreditsField()),
          ...(definitiveSignOut ? {} : accountUserId ? { userId: accountUserId } : {}),
        };
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
      // p89: a signed-in status must always carry a numeric credits balance —
      // client.getStatus() only ever returns ok:true+signedIn:true alongside a
      // validated numeric credits field, so this should be unreachable, but a
      // future backend/client change could silently drop it (e.g. a renamed
      // field) and leave the webview chip stuck with nothing to show. Log once
      // per occurrence (names/kinds only, no account values) so a regression
      // here can't hide behind a status log line that always says "ok".
      if (status.signedIn && typeof status.credits !== "number") {
        log("themeServiceHost.buildStatus: signedIn=true but credits is not a number");
      }
      // Follow-up fix: persist the durable cache on every genuine signed-in
      // fetch that carries a numeric balance, and clear it on a definitive
      // sign-out — mirrors the webview's own localStorage write/clear, but
      // survives a VS Code restart and a private-window/cleared-storage
      // webview.
      //
      // Review fix: also track currentUserId here (the only place a
      // definitive signedIn status is ever built) and, if this confirmed
      // account differs from the cache's own userId, clear the stale
      // record FIRST — an account switch must never leave the previous
      // user's balance sitting under the new user's id. persistCredits
      // right after (when this fetch also has a numeric balance) then
      // writes the fresh one, so net effect is "overwrite".
      if (status.signedIn === false) {
        clearPersistedCredits();
        currentUserId = undefined;
        accountUserId = undefined;
      } else if (status.signedIn) {
        if (status.email && currentUserId && status.email !== currentUserId) {
          clearPersistedCredits();
        }
        if (status.email) currentUserId = status.email;
        if (typeof status.credits === "number") persistCredits(status.email, status.credits);
        await refreshAccountUserId();
      }
      return {
        signedIn: status.signedIn,
        email: status.email,
        ...(status.signedIn && accountUserId ? { userId: accountUserId } : {}),
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
        ...(typeof hasStoredSession === "boolean" ? { hasStoredSession } : {}),
        ...(status.signedIn === false ? {} : cachedCreditsField()),
      };
    } catch (err) {
      const ctor = err instanceof Error ? err.constructor.name : typeof err;
      log(`themeServiceHost.buildStatus: threw ${ctor}`);
      // signedIn deliberately omitted (not false) — a hardcoded false told
      // the webview this account is definitively signed out, which hides
      // the chip and wipes its cached balance on a transient throw even for
      // a signed-in user. Leaving it undefined lets the webview's
      // signedInKnown/cache fallback apply instead.
      //
      // kind "internal" (not "unavailable"): an unhandled exception is a bug
      // in this process, not a cold Theme Service backend. buildSnapshotForOpen
      // only remaps "unavailable"/"timeout" to "waking", and only THOSE kinds
      // arm the 10/20/30s retry chain in refreshStatusInBackground/
      // scheduleStatusRetry — using "unavailable" here would silently retry a
      // local exception for up to STATUS_RETRY_MAX_TOTAL_MS instead of
      // surfacing it once.
      return {
        pendingCheckout,
        error: { kind: "internal", message: UNAVAILABLE_MESSAGE },
        ...(typeof hasStoredSession === "boolean" ? { hasStoredSession } : {}),
        ...cachedCreditsField(),
      };
    }
  }

  async function postFreshStatus(): Promise<void> {
    if (disposed) return;
    const status = await buildStatus();
    log(`themeServiceHost.postFreshStatus: account fetch=${status.error ? `error kind=${status.error.kind}` : "ok"}`);
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
      // p91-t2 fix: signedIn omitted, not false — retries exhausting after
      // ~3 minutes of "waking" is a transient unavailability, not a known
      // sign-out; a hardcoded false here hid the credits chip and wiped its
      // cached balance for a signed-in user who was simply waiting on a slow
      // wake-up.
      //
      // p92 review fix: hasStoredSession is deliberately set to false here
      // (not omitted, and not the last-known cachedHasStoredSession) — this
      // IS the escape hatch. The soft-state (hasStoredSession:true) view has
      // no time limit of its own; after ~3 minutes of retries the service is
      // either genuinely down for good or the stored session itself is bad,
      // and the person needs a way out (Sign in) rather than an infinite
      // silent "waking up…" spinner with no path forward.
      lastSnapshot = {
        pendingCheckout,
        error: { kind: "unavailable", message: UNAVAILABLE_MESSAGE },
        hasStoredSession: false,
        ...cachedCreditsField(),
      };
      opts.postStatus(lastSnapshot);
      return;
    }
    statusRetryHandle = setTimeoutImpl(() => {
      void (async () => {
        if (disposed || generation !== statusRetryGeneration) return;
        let status: ThemeServiceHostStatus;
        try {
          status = await buildSnapshotForOpen();
        } catch (err) {
          // p91 fix: buildStatus already catches internally, but this is a
          // second safety net — nothing between here and a terminal post may
          // ever throw without one, or a "waking" retry chain could die
          // silently and leave the last-posted stub/"waking" status stuck.
          // signedIn omitted, not false — same reasoning as buildStatus's
          // own catch (p91-t2).
          // kind "internal" (not "unavailable") — see buildStatus's catch;
          // "waking" never matches below so this correctly stops the retry
          // chain instead of continuing to treat a local exception as a cold
          // start.
          const ctor = err instanceof Error ? err.constructor.name : typeof err;
          log(`themeServiceHost.scheduleStatusRetry: unexpected throw ${ctor}`);
          status = { pendingCheckout, error: { kind: "internal", message: UNAVAILABLE_MESSAGE } };
        }
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
    if (!authCode || authCode.length === 0) {
      log("themeServiceHost.completeGoogle: no code, early exit");
      return;
    }
    const codeVerifier = pendingGoogleCodeVerifier;
    if (!codeVerifier) {
      log("themeServiceHost.completeGoogle: no pending Google sign-in, early exit");
      opts.postStatus({ signedIn: false, pendingCheckout, error: { kind: "not_signed_in", message: "no pending Google sign-in" } });
      return;
    }
    pendingGoogleCodeVerifier = null;
    pendingGoogleBrowserUrl = null;
    log("themeServiceHost.completeGoogle: code exchange request start");
    const res = await client.completeGoogleSignIn({ authCode, codeVerifier });
    log(`themeServiceHost.completeGoogle: code exchange status=${res.ok ? "ok" : `error kind=${res.error.kind}${res.error.status !== undefined ? ` http=${res.error.status}` : ""}`}`);
    if (!res.ok) {
      opts.postStatus({ signedIn: false, pendingCheckout, error: toErrorPayload(res.error) });
      return;
    }
    log("themeServiceHost.completeGoogle: session stored=yes");
    await afterSignInSucceeded();
    await postFreshStatus();
  }

  /**
   * p83-t1: single entry point for both the deep-link callback and the
   * legacy pasted-code path. Accepts either a bare code string (legacy) or
   * a {@link GoogleCallbackParams} object covering the implicit flow and
   * OAuth errors. Every branch is logged (names/kinds only, never values).
   */
  async function handleGoogleCallback(input: string | GoogleCallbackParams): Promise<void> {
    const params: GoogleCallbackParams = typeof input === "string" ? { code: input } : input;
    const queryNames = params.queryParamNames ?? (params.code !== undefined ? ["code"] : []);
    const fragmentNames =
      params.fragmentParamNames ??
      (params.accessToken !== undefined || params.refreshToken !== undefined
        ? ["access_token", "refresh_token"]
        : []);
    log(
      `themeServiceHost.handleUriCallback: received query=[${queryNames.join(",")}] fragment=[${fragmentNames.join(",")}]`,
    );
    const pending = pendingGoogleCodeVerifier !== null;
    log(`themeServiceHost.handleUriCallback: pending sign-in=${pending}`);

    if (params.errorCode) {
      log(`themeServiceHost.handleUriCallback: branch=oauth-error code=${params.errorCode}`);
      if (pending) {
        pendingGoogleCodeVerifier = null;
        pendingGoogleBrowserUrl = null;
        opts.postStatus({
          signedIn: false,
          pendingCheckout,
          error: { kind: "oauth_error", message: `Google sign-in wasn't completed (${params.errorCode}).` },
        });
      }
      return;
    }

    if (params.accessToken && params.refreshToken) {
      log("themeServiceHost.handleUriCallback: branch=implicit-tokens");
      if (!pending) {
        log("themeServiceHost.handleUriCallback: no pending Google sign-in, early exit");
        return;
      }
      pendingGoogleCodeVerifier = null;
      pendingGoogleBrowserUrl = null;
      log("themeServiceHost.handleUriCallback: verifying implicit token before storing session");
      const res = await client.completeGoogleSignInImplicit({
        accessToken: params.accessToken,
        refreshToken: params.refreshToken,
        expiresIn: params.expiresIn,
      });
      log(
        `themeServiceHost.handleUriCallback: implicit token verify kind=${res.ok ? "ok" : res.error.kind}${!res.ok && res.error.status !== undefined ? ` http=${res.error.status}` : ""} session stored=${res.ok ? "yes" : "no"}`,
      );
      if (!res.ok) {
        // p83-t2 review fix: the candidate token failed verification (e.g.
        // it was crafted/bogus) — nothing was ever persisted (see
        // completeGoogleSignInImplicit), and the pending sign-in was
        // already cleared above so this can't be retried with the same
        // stale tokens. Fixed, non-server-text message only.
        opts.postStatus({
          signedIn: false,
          pendingCheckout,
          error: { kind: "not_signed_in", message: "Sign-in could not be verified." },
        });
        return;
      }
      await afterSignInSucceeded();
      await postFreshStatus();
      return;
    }

    if (params.code) {
      log("themeServiceHost.handleUriCallback: branch=code");
      await completeGoogle(params.code);
      return;
    }

    log("themeServiceHost.handleUriCallback: branch=no-usable-params");
    if (pending) {
      opts.postStatus({
        signedIn: false,
        pendingCheckout,
        error: { kind: "not_signed_in", message: "Google sign-in callback didn't include a code or tokens." },
      });
    }
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
      // Follow-up fix: this is the FIRST status the webview ever sees at
      // panel open — returned synchronously, before any network call — so
      // it's where cachedCredits matters most: the webview's own
      // localStorage cache can be empty (private window, cleared site data,
      // or simply a fresh webview origin), but the durable host-side cache
      // (ExtensionContext.globalState, keyed by user id) survives across
      // sessions and even a VS Code restart.
      return lastSnapshot
        ? { ...lastSnapshot, ...cachedCreditsField() }
        : {
            signedIn: false,
            pending: true,
            ...(typeof cachedHasStoredSession === "boolean" ? { hasStoredSession: cachedHasStoredSession } : {}),
            ...cachedCreditsField(),
          };
    },

    applyCreditsFromAttempt(credits) {
      if (disposed || typeof credits !== "number" || !Number.isFinite(credits)) return;
      if (!lastSnapshot || lastSnapshot.signedIn !== true) return;
      lastKnownCredits = credits;
      persistCredits(currentUserId, credits);
      lastSnapshot = { ...lastSnapshot, credits };
      opts.postStatus(lastSnapshot);
    },

    refreshStatusInBackground() {
      stopStatusRetry();
      const generation = statusRetryGeneration;
      void (async () => {
        if (disposed || generation !== statusRetryGeneration) return;
        let status: ThemeServiceHostStatus;
        try {
          status = await buildSnapshotForOpen();
        } catch (err) {
          // p91 fix: this is the path that follows OPEN_THEME_BUILDER's
          // pending:true stub — without this catch, a throw here left that
          // stub with no follow-up post, so the webview's "…" chip never
          // resolved.
          // signedIn omitted, not false — same reasoning as buildStatus's
          // own catch (p91-t2).
          // kind "internal" (not "unavailable") — see buildStatus's catch;
          // never matches "waking" below, so no retry chain starts for a
          // local exception.
          const ctor = err instanceof Error ? err.constructor.name : typeof err;
          log(`themeServiceHost.refreshStatusInBackground: unexpected throw ${ctor}`);
          status = { pendingCheckout, error: { kind: "internal", message: UNAVAILABLE_MESSAGE } };
        }
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
      // p87: when the backend advertises an authLandingUrl, redirect_to goes
      // through it (`${authLandingUrl}?scheme=<encoded scheme>`) so the
      // landing page can reopen the deep link itself; an absent or invalid
      // authLandingUrl keeps today's direct deep link exactly.
      const landingRes = await client.getAuthLandingUrl();
      let redirectTo = `${scheme}://tycoonagents.tycoonagents/theme-service-auth`;
      if (landingRes.ok && landingRes.value) {
        if (isValidAuthLandingUrl(landingRes.value)) {
          // Review fix: build via URL/searchParams, not string concatenation
          // — an authLandingUrl that already carries a query string (e.g.
          // "...?ref=abc") must get "&scheme=..." appended correctly, not a
          // second "?scheme=..." that yields an invalid "?a=1?scheme=...".
          const u = new URL(landingRes.value);
          u.searchParams.set("scheme", scheme);
          redirectTo = u.toString();
        } else {
          log("themeServiceHost.handleGoogleStart: authLandingUrl invalid, ignoring");
        }
      }
      const res = await client.startGoogleSignIn({ redirectTo });
      if (!res.ok) {
        log(`themeServiceHost.handleGoogleStart: startGoogleSignIn failed kind=${res.error.kind}`);
        opts.postStatus({ signedIn: false, pendingCheckout, error: toErrorPayload(res.error) });
        opts.postGoogleOpened?.({ ok: false, error: toErrorPayload(res.error) });
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
        opts.postGoogleOpened?.({ ok: false, error: { kind: "browser_open_failed", message: scrubOpenExternalError(err) } });
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
        opts.postGoogleOpened?.({
          ok: false,
          error: { kind: "browser_open_failed", message: "couldn't open the browser for sign-in" },
        });
        return;
      }
      log("themeServiceHost.handleGoogleStart: openExternal succeeded");
      // Nothing further to post on success — the pre-await post above already
      // delivered browserUrl, and posting again here risks overwriting a
      // signedIn:true the deep-link completion posted in the meantime.
      opts.postGoogleOpened?.({ ok: true });
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

    async handleUriCallback(input) {
      await handleGoogleCallback(input);
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
      clearPersistedCredits();
      currentUserId = undefined;
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
      // Fire-and-forget: see seedCurrentUserIdFromStoredSession's doc
      // comment. Not awaited — start() itself must stay synchronous (panel.ts
      // calls it from its constructor) — but SecretStorage + a JWT decode is
      // fast enough to reliably finish before the webview's first status
      // request in practice, and every read path that consults
      // currentUserId already degrades gracefully (omits cachedCredits) if
      // it hasn't.
      void seedCurrentUserIdFromStoredSession();
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
