/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * Pure client for the Corsair Theme Service — see docs/theme-service-api.md
 * (v2) for the full contract. No `vscode` import, no `node:crypto` and no
 * other Node-only modules: usable from the extension, the standalone app,
 * and the webview build alike. All host-specific glue (SecretStorage,
 * app-data secrets/, browser open, deep links) is the caller's job via
 * {@link ThemeServiceClientOptions}.
 *
 * Auth is Supabase GoTrue REST, called directly (no `@supabase/supabase-js`)
 * the same way Speciary's viewer does — see docs/theme-service-api.md
 * "Auth — Supabase GoTrue REST, direct from the client".
 */

import { sanitizeImageProviderText } from "./imageProviderText";
import type { StructuredGenerateRequest } from "./themePromptTemplates";

// Canonical production endpoints (docs/theme-service-api.md, Conventions),
// same pattern as FEEDBACK_ENDPOINT in src/host/vscode/feedbackSubmit.ts:36.
// Baked into every shipped release; repointable server-side without a
// client update, never a throwaway subdomain. Do not change these to
// test/staging values in a commit that ships.
export const THEME_SERVICE_ENDPOINT = "https://theme.corsairstudios.com";

/**
 * Validates and normalizes a user/env-supplied Theme Service endpoint
 * override (VS Code setting `tycoonagents.themeService.endpoint`, standalone
 * env var `THEME_SERVICE_ENDPOINT`) — shared by both hosts (p64-t1) so the
 * validation rule lives in exactly one place. Requires an `https:` URL with
 * no query string or fragment; a path is allowed but a trailing slash is
 * stripped. Any invalid or empty input falls back to
 * {@link THEME_SERVICE_ENDPOINT} with `overridden: false` and a `warning`
 * the caller should log once (never thrown — an invalid override must never
 * crash startup).
 */
export function resolveThemeServiceEndpoint(raw: string | undefined): {
  endpoint: string;
  overridden: boolean;
  warning?: string;
} {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return { endpoint: THEME_SERVICE_ENDPOINT, overridden: false };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      endpoint: THEME_SERVICE_ENDPOINT,
      overridden: false,
      warning: `invalid Theme Service endpoint override "${trimmed}" — falling back to the production service`,
    };
  }
  if (url.protocol !== "https:") {
    return {
      endpoint: THEME_SERVICE_ENDPOINT,
      overridden: false,
      warning: `Theme Service endpoint override "${trimmed}" must use https — falling back to the production service`,
    };
  }
  if (url.username || url.password) {
    return {
      endpoint: THEME_SERVICE_ENDPOINT,
      overridden: false,
      warning: `Theme Service endpoint override "${trimmed}" must not include userinfo — falling back to the production service`,
    };
  }
  if (url.search || url.hash) {
    return {
      endpoint: THEME_SERVICE_ENDPOINT,
      overridden: false,
      warning: `Theme Service endpoint override "${trimmed}" must not include a query string or fragment — falling back to the production service`,
    };
  }
  const path = url.pathname.replace(/\/+$/, "");
  const endpoint = `${url.protocol}//${url.host}${path}`;
  return { endpoint, overridden: true };
}
/**
 * GET `${endpoint}/api/auth-config` response shape (p65) — the Supabase
 * project URL and publishable (anon) key are no longer baked into the
 * client at build time; they're fetched once per client instance from the
 * Theme Service itself. Supabase's anon key is public by design (meant to
 * ship client-side), so caching it in memory for the process lifetime is
 * fine — it is never written to disk or logged.
 */
export interface ThemeServiceAuthConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  promptTemplateVersion: string;
  contractVersion: string;
  /**
   * Optional absolute https landing-page URL (p87). When present, the
   * Google sign-in redirect_to becomes `${authLandingUrl}?scheme=<encoded
   * vscode.env.uriScheme>` instead of the direct deep link, so the landing
   * page can reopen `<scheme>://tycoonagents.tycoonagents/theme-service-auth`
   * itself. Passed through here as the raw string from the server; callers
   * (themeServiceHost) do the https/length validation and log-on-reject
   * since only they have a logger, and fall back to today's direct deep
   * link when it's absent or invalid.
   */
  authLandingUrl?: string;
}

export type ThemeServiceErrorKind =
  | "not_signed_in"
  | "insufficient_credits"
  | "content_blocked"
  | "account_locked"
  | "rate_limited"
  | "provider_failed"
  | "unavailable"
  | "unreachable"
  | "timeout"
  | "server_error"
  | "bad_request"
  | "invalid_response";

export interface ThemeServiceError {
  kind: ThemeServiceErrorKind;
  status?: number;
  message: string;
  refunded?: boolean;
  credits?: number;
  /** p85: the backend's `code` field on a 400 bad_request body (e.g. "board_not_priced"), when present. */
  code?: string;
  /** content_blocked only: the moderation categories the backend flagged (e.g. "illicit", "self-harm/intent"), OR a single-element array holding the likeness/IP precheck's singular `category: "likeness" | "ip"` field (p94). Absent on an older backend that only sends `error: "content_blocked"`. */
  categories?: string[];
  /** content_blocked only: the request field paths the backend flagged (the backend's userTextFields, e.g. "slot[2].visual_description", "theme.creativeDirection"). Absent on an older backend, and absent on the likeness/IP precheck block (that shape has no `fields`). */
  fields?: string[];
  /**
   * rate_limited only: which limit was hit — "minute"/"day" (this account's
   * own request rate) or "provider" (the underlying image provider is
   * rate-limiting the whole service). Absent on an older backend that only
   * sends the bare `{ error: "rate_limited" }` shape.
   */
  scope?: "minute" | "day" | "provider";
  /** rate_limited only: the numeric limit the backend enforced (e.g. 5 generations/minute), when it sent one. Never guessed/hard-coded by the client. */
  limit?: number;
  /** rate_limited only: how long to wait before retrying, in whole seconds — from the response body's `retryAfterSeconds` field, falling back to the `Retry-After` header (seconds form) when the body omits it. Undefined when neither is present/parseable. */
  retryAfterSeconds?: number;
}

/** Whole, non-negative seconds, rendered compactly (e.g. "12s"). */
function formatWaitSeconds(seconds: number): string {
  return `${Math.max(0, Math.round(seconds))}s`;
}

/** A day-scope wait rendered in hours (>= 1h) or minutes, whichever reads naturally — never seconds, per the rate-limit message contract. */
function formatDayWait(seconds: number): string {
  if (seconds >= 3600) {
    const hours = Math.max(1, Math.round(seconds / 3600));
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * Builds the rate_limited message text shown to the user, from whatever the
 * backend's 429 body/Retry-After header actually carried. This is the
 * single place this text is built — both the sign-in/status path
 * (themeServiceHost.ts's toErrorPayload just passes it through) and
 * per-item image-generation errors (themeService.ts, which shares this same
 * ThemeServiceClient) get their ThemeServiceError from here, so both surface
 * the same wording. Every number in the result comes from the response; a
 * field the backend omitted (an older backend, or this particular limit
 * having no numeric value) is simply left out of the sentence rather than
 * guessed/hard-coded.
 */
function buildRateLimitedMessage(
  scope: "minute" | "day" | "provider" | undefined,
  limit: number | undefined,
  retryAfterSeconds: number | undefined,
): string {
  if (scope === "provider") {
    const wait = retryAfterSeconds !== undefined
      ? ` Try again in ${formatWaitSeconds(retryAfterSeconds)}, or generate fewer at once.`
      : " Try again shortly, or generate fewer at once.";
    return `The image service is busy right now.${wait} No credits were charged.`;
  }

  if (scope === "minute" || scope === "day") {
    let message = "Too many requests";
    if (limit !== undefined) message += ` — the Theme Service allows up to ${limit} generations per ${scope}`;
    message += ".";
    if (retryAfterSeconds !== undefined) {
      const wait = scope === "day" ? formatDayWait(retryAfterSeconds) : formatWaitSeconds(retryAfterSeconds);
      message += ` Try again in ${wait}.`;
    }
    return `${message} No credits were charged.`;
  }

  // Older backend (no scope on the response at all) — the original generic
  // text, never inventing numbers it doesn't have.
  return "Too many requests, try again shortly. No credits were charged.";
}

export type ThemeServiceResult<T> = { ok: true; value: T } | { ok: false; error: ThemeServiceError };

/**
 * Per-host token store. `get`/`set`/`clear` still take/return a plain
 * string for backward compatibility with the VS Code (`SecretStorage`) and
 * standalone (`secrets/`) adapters — the client serializes/parses the
 * Supabase session as JSON inside that string.
 */
export interface ThemeServiceTokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ThemeServiceClientOptions {
  /** Injectable for tests / non-global-fetch hosts; defaults to global `fetch`. */
  fetch?: typeof fetch;
  tokenStore: ThemeServiceTokenStore;
  /** Overrides {@link THEME_SERVICE_ENDPOINT}; for tests only. */
  endpoint?: string;
  /**
   * Test-only override for the Supabase project URL that otherwise comes
   * from GET `${endpoint}/api/auth-config` (p65). Supplying both this and
   * {@link supabaseAnonKey} bypasses that fetch entirely.
   */
  supabaseUrl?: string;
  /**
   * Test-only override for the Supabase publishable/anon key that
   * otherwise comes from GET `${endpoint}/api/auth-config` (p65). Supplying
   * both this and {@link supabaseUrl} bypasses that fetch entirely.
   */
  supabaseAnonKey?: string;
  /** Injectable clock (ms epoch); defaults to `Date.now`. */
  now?: () => number;
  /** Injectable PKCE code-verifier generator; for deterministic tests. */
  createCodeVerifier?: () => string;
  /**
   * Extension/host version string sent as the `X-Tycoon-Client` header on
   * every Theme Service request (v3.4), so the service can log/gate by
   * client build. Optional for tests; omitted entirely when absent.
   */
  clientVersion?: string;
  /**
   * Bounds every Theme Service request with an AbortController so a hung
   * connection can't stall the caller forever. Default 200_000ms (200s) —
   * p86: kept above the server's own 170-180s /api/plan and /api/generate
   * budgets so the server always answers (success, error, or refund) first
   * instead of the client aborting and racing it;
   * override for tests or slower generation endpoints. Does not apply to
   * the Supabase auth requests.
   */
  requestTimeoutMs?: number;
  /**
   * Bounds the status/pricing snapshot fetches (getStatus, getPricing) used
   * by OPEN_THEME_BUILDER's immediate-open flow and its background retry —
   * intentionally much shorter than {@link requestTimeoutMs} so a sleeping
   * Render Free backend doesn't hold the webview on "Connecting…" for
   * minutes. Default 10_000ms (10s).
   */
  statusTimeoutMs?: number;
  /**
   * Bounds POST /api/plan specifically (planRequest) — longer than
   * {@link requestTimeoutMs} on purpose. Plan generation now runs the model
   * in strict json_schema mode (v3.5+), which produces a much larger,
   * fully-populated response (20+ keys, hundreds of array entries) and can
   * take several minutes; the UI's own "AI is filling the theme slots"
   * loading copy already says so. requestTimeoutMs's 200s default assumed a
   * server-side /api/plan budget of 170-180s that predates strict
   * json_schema — a bug (v0.0.656) showed the server completing and
   * charging the credit well after the client had already aborted and
   * silently reverted the UI, so /api/plan gets its own, much larger
   * budget instead of racing the server. Default 600_000ms (10 minutes).
   */
  planTimeoutMs?: number;
}

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface ThemeServiceStatus {
  signedIn: boolean;
  email?: string;
  displayName?: string;
  role?: string;
  credits?: number;
  locked?: boolean;
  strikes?: number;
}

export interface ThemeServicePack {
  id: string;
  label?: string;
  credits: number;
  bonusCredits?: number;
  priceCents: number;
  currency: string;
}

export interface ThemeServicePricing {
  attemptCostByBoardType: Record<string, number>;
  /** Credit cost of one /api/plan attempt (either `kind`); see docs/theme-service-api.md "Plan / description generation". */
  planCost: number;
  typicalTheme: { min: number; max: number; typical?: number };
  packs: ThemeServicePack[];
}

export interface CheckoutSession {
  url: string;
}

/**
 * v3.4 structured /api/generate request (docs/theme-service-api.md
 * "Generation", ~line 197): the client sends theme/board data only — no
 * free-text `prompt` field — and the service assembles the model prompt
 * server-side from {@link StructuredGenerateRequest}'s fields, which this
 * extends with the wire-only `idempotencyKey` and `size`.
 */
export type GenerateAttemptRequest = StructuredGenerateRequest & {
  idempotencyKey: string;
  size: string;
};

export interface GenerateAttemptResponse {
  image: string;
  attemptCost: number;
  credits: number;
  refunded: boolean;
  /** Template version the service actually used to assemble the prompt (may differ from the request's if the service has moved on). */
  promptTemplateVersion?: string;
  /** sha256 hex digest of the server-assembled prompt text, for client-side drift detection against the local preview. */
  assembledPromptSha256?: string;
}

/**
 * Request body for POST /api/plan — see docs/theme-service-api.md "Plan /
 * description generation". `kind` distinguishes a full theme plan from a
 * descriptions-only re-derive; `input` carries the already-built prompt
 * text (and any other structured fields the caller needs) so the service
 * never has to reconstruct it.
 */
export interface PlanRequest {
  idempotencyKey: string;
  kind: "plan" | "descriptions";
  input: Record<string, unknown>;
}

export interface PlanRequestResponse {
  output: Record<string, unknown>;
  attemptCost: number;
  credits: number;
  refunded: boolean;
}

export interface GoogleSignInStart {
  browserUrl: string;
  codeVerifier: string;
}

/**
 * Client-side format for a referral code (docs/theme-service-api.md v3.5,
 * "POST /api/account/referral"): `[A-Za-z0-9-]{1,32}`. Exported so the host
 * layers can validate a typed/pre-filled code before even showing it as
 * "pending" without duplicating the pattern.
 */
export const REFERRAL_CODE_PATTERN = /^[A-Za-z0-9-]{1,32}$/;

export interface ApplyReferralResult {
  applied: boolean;
  reason?: string;
}

export interface ThemeServiceClient {
  requestMagicLink(email: string): Promise<ThemeServiceResult<void>>;
  verifyMagicLink(email: string, code: string): Promise<ThemeServiceResult<void>>;
  startGoogleSignIn(input: { redirectTo: string }): Promise<ThemeServiceResult<GoogleSignInStart>>;
  /** p87: the raw (unvalidated) authLandingUrl from GET /api/auth-config, or undefined when absent. */
  getAuthLandingUrl(): Promise<ThemeServiceResult<string | undefined>>;
  completeGoogleSignIn(input: { authCode: string; codeVerifier: string }): Promise<ThemeServiceResult<void>>;
  /** p83-t1: implicit-flow completion (fragment access_token/refresh_token, no code). */
  completeGoogleSignInImplicit(input: {
    accessToken: string;
    refreshToken: string;
    expiresIn?: number;
  }): Promise<ThemeServiceResult<void>>;
  refreshSession(): Promise<ThemeServiceResult<void>>;
  signOut(): Promise<ThemeServiceResult<void>>;
  getStatus(): Promise<ThemeServiceResult<ThemeServiceStatus>>;
  getPricing(): Promise<ThemeServiceResult<ThemeServicePricing>>;
  createCheckoutSession(pack: string): Promise<ThemeServiceResult<CheckoutSession>>;
  generateAttempt(req: GenerateAttemptRequest): Promise<ThemeServiceResult<GenerateAttemptResponse>>;
  planRequest(req: PlanRequest): Promise<ThemeServiceResult<PlanRequestResponse>>;
  /**
   * POST /api/account/referral (v3.5) — see docs/theme-service-api.md
   * "Referral". Called once, immediately after a device's first sign-in.
   * Validates `code` against {@link REFERRAL_CODE_PATTERN} client-side and
   * returns `{ applied: false, reason: "invalid_format" }` WITHOUT calling
   * the service when it doesn't match — the service never sees a
   * malformed code. On a network/server failure this returns the usual
   * `ok: false` result; the caller decides how to surface that (never a
   * blocker to the sign-in that just completed).
   */
  applyReferralCode(code: string): Promise<ThemeServiceResult<ApplyReferralResult>>;
  /**
   * p92: true iff the token store holds a well-formed session, WITHOUT
   * validating it against the service (no network call) — lets a host tell
   * "no session at all" (show Sign in) apart from "a session exists but the
   * status fetch just failed/timed out" (show a waking/retry state, never
   * Sign in) when a definitive signedIn can't be determined.
   */
  hasStoredSession(): Promise<boolean>;
  /**
   * Follow-up fix: a display-only, best-effort user id for the stored
   * session, decoded from the JWT access token's payload — NO signature
   * verification (this is never trusted for anything security-sensitive,
   * only to seed which account's cached balance may be shown before the
   * first status fetch resolves). Same no-network posture as
   * {@link hasStoredSession}. Returns undefined when there's no stored
   * session, the token doesn't parse, or it carries neither an `email` nor
   * a `sub` claim. Never logs the token itself.
   */
  getStoredIdentity(): Promise<string | undefined>;
  /**
   * Follow-up: the stored session's Supabase account id (the JWT `sub`
   * claim only — never falls back to email, unlike {@link getStoredIdentity}),
   * for display in support reports. Same unverified, no-network,
   * never-logged posture as {@link getStoredIdentity}. Returns undefined
   * when there's no stored session, the token doesn't parse, or it carries
   * no `sub` claim.
   */
  getStoredUserId(): Promise<string | undefined>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function invalidResponse(message: string): ThemeServiceError {
  return { kind: "invalid_response", message };
}

/**
 * Follow-up fix: decodes a JWT's payload segment WITHOUT verifying its
 * signature, purely to read a display-only identity claim (email, falling
 * back to sub) — see {@link ThemeServiceClient.getStoredIdentity}'s doc
 * comment for why unverified is acceptable here. Never throws; any
 * malformed/unexpected shape yields undefined. Never logs the token.
 */
function decodeJwtIdentityUnsafe(token: string): string | undefined {
  const payload = decodeJwtPayloadUnsafe(token);
  if (!payload) return undefined;
  if (typeof payload.email === "string" && payload.email.length > 0) return payload.email;
  if (typeof payload.sub === "string" && payload.sub.length > 0) return payload.sub;
  return undefined;
}

/** Same decode as {@link decodeJwtIdentityUnsafe}, but the `sub` claim only
 * (the Supabase account id) — never falls back to email. */
function decodeJwtSubUnsafe(token: string): string | undefined {
  const payload = decodeJwtPayloadUnsafe(token);
  if (!payload) return undefined;
  return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : undefined;
}

function decodeJwtPayloadUnsafe(token: string): Record<string, unknown> | undefined {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return undefined;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const jsonStr = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("utf8");
    const payload: unknown = JSON.parse(jsonStr);
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

// ---- base64url + PKCE (no node:crypto — Web Crypto only, with a pure-TS
// SHA-256 fallback for hosts without `crypto.subtle`) ----

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function secureRandomBytes(length: number): Uint8Array | null {
  const g: { getRandomValues?: (a: Uint8Array) => Uint8Array } | undefined = (globalThis as unknown as {
    crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
  }).crypto;
  if (!g?.getRandomValues) return null;
  const bytes = new Uint8Array(length);
  g.getRandomValues(bytes);
  return bytes;
}

// No Math.random fallback here on purpose: a PKCE verifier needs
// cryptographically secure randomness. When neither `crypto.getRandomValues`
// nor an injected `createCodeVerifier` is available, startGoogleSignIn
// returns an error instead of silently generating a guessable verifier.
function defaultCreateCodeVerifier(): string | null {
  const bytes = secureRandomBytes(32);
  return bytes ? base64UrlEncode(bytes) : null;
}

// Pure-TS SHA-256 (FIPS 180-4), used only when `crypto.subtle` is
// unavailable. No external deps, no `node:crypto` import.
function sha256Fallback(message: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ]);
  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a,
    h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;

  const bitLen = message.length * 8;
  const withOne = new Uint8Array(((message.length + 9 + 63) & ~63) as number);
  withOne.set(message);
  withOne[message.length] = 0x80;
  const dv = new DataView(withOne.buffer);
  dv.setUint32(withOne.length - 4, bitLen >>> 0, false);
  dv.setUint32(withOne.length - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < withOne.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const outDv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => outDv.setUint32(i * 4, v, false));
  return out;
}

async function sha256(message: Uint8Array): Promise<Uint8Array> {
  const subtle: { digest?: (algo: string, data: Uint8Array) => Promise<ArrayBuffer> } | undefined = (
    globalThis as unknown as { crypto?: { subtle?: { digest?: (algo: string, data: Uint8Array) => Promise<ArrayBuffer> } } }
  ).crypto?.subtle;
  if (subtle?.digest) {
    const digest = await subtle.digest("SHA-256", message);
    return new Uint8Array(digest);
  }
  return sha256Fallback(message);
}

async function codeChallengeFor(verifier: string): Promise<string> {
  const bytes = new TextEncoder().encode(verifier);
  const digest = await sha256(bytes);
  return base64UrlEncode(digest);
}

/**
 * Build the client. Every method returns a discriminated-union result and
 * NEVER throws: fetch rejections become `unreachable`, malformed/missing
 * JSON fields become `invalid_response`, and HTTP status codes map per
 * docs/theme-service-api.md § Error shape. The session is read from
 * `opts.tokenStore` on every authenticated call and is never logged or
 * placed anywhere but the `Authorization` header.
 */
export function createThemeServiceClient(opts: ThemeServiceClientOptions): ThemeServiceClient {
  const fetchImpl = opts.fetch ?? fetch;
  const endpoint = opts.endpoint ?? THEME_SERVICE_ENDPOINT;
  const tokenStore = opts.tokenStore;
  const now = opts.now ?? (() => Date.now());
  const createCodeVerifier: () => string | null = opts.createCodeVerifier ?? defaultCreateCodeVerifier;
  const clientVersion = opts.clientVersion;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 200_000;
  const statusTimeoutMs = opts.statusTimeoutMs ?? 10_000;
  const planTimeoutMs = opts.planTimeoutMs ?? 600_000;
  // Shorter than requestTimeoutMs on purpose — this is a small, cacheable
  // config GET the Theme Service should answer fast; it must not stall
  // sign-in as long as the 180s generation-request budget.
  const AUTH_CONFIG_TIMEOUT_MS = 30_000;

  // Lazy, in-memory, per-client-instance auth config. Test overrides
  // (opts.supabaseUrl + opts.supabaseAnonKey) bypass the fetch entirely.
  // A single in-flight promise coalesces concurrent callers (authRequest,
  // startGoogleSignIn, signOut) so the service only ever sees one GET.
  let authConfigPromise: Promise<ThemeServiceResult<ThemeServiceAuthConfig>> | null = null;

  async function fetchAuthConfig(): Promise<ThemeServiceResult<ThemeServiceAuthConfig>> {
    const timeoutController = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timeoutHandle = timeoutController
      ? setTimeout(() => timeoutController.abort(), AUTH_CONFIG_TIMEOUT_MS)
      : undefined;
    let res: Response;
    try {
      res = await fetchImpl(`${endpoint}/api/auth-config`, { method: "GET", signal: timeoutController?.signal });
    } catch {
      const timedOut = timeoutController?.signal.aborted === true;
      return {
        ok: false,
        error: timedOut
          ? { kind: "timeout", message: "sign-in configuration unavailable" }
          : { kind: "server_error", message: "sign-in configuration unavailable" },
      };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
    let json: unknown;
    try {
      const text = await res.text();
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      return { ok: false, error: { kind: "server_error", message: "sign-in configuration unavailable" } };
    }
    if (
      !res.ok ||
      !isRecord(json) ||
      typeof json.supabaseUrl !== "string" ||
      typeof json.supabasePublishableKey !== "string" ||
      json.supabasePublishableKey.length === 0 ||
      typeof json.promptTemplateVersion !== "string" ||
      typeof json.contractVersion !== "string"
    ) {
      return { ok: false, error: { kind: "server_error", message: "sign-in configuration unavailable" } };
    }
    // Review fix (p65-t2): supabaseUrl must be a well-formed https URL with
    // no query/fragment — a server-controlled value that's about to be used
    // to build request URLs and the OAuth authorize redirect, so it gets
    // the same scrutiny as resolveThemeServiceEndpoint's override validation.
    let parsedSupabaseUrl: URL;
    try {
      parsedSupabaseUrl = new URL(json.supabaseUrl);
    } catch {
      return { ok: false, error: { kind: "server_error", message: "sign-in configuration unavailable" } };
    }
    if (parsedSupabaseUrl.protocol !== "https:" || parsedSupabaseUrl.search || parsedSupabaseUrl.hash) {
      return { ok: false, error: { kind: "server_error", message: "sign-in configuration unavailable" } };
    }
    const supabaseUrl = `${parsedSupabaseUrl.protocol}//${parsedSupabaseUrl.host}${parsedSupabaseUrl.pathname.replace(/\/+$/, "")}`;
    // p87: authLandingUrl is optional and passed through as-is (raw string,
    // typeof-checked only) — full https/length validation happens in
    // themeServiceHost, which has a logger to record a rejection.
    const authLandingUrl = typeof json.authLandingUrl === "string" && json.authLandingUrl.length > 0 ? json.authLandingUrl : undefined;
    return {
      ok: true,
      value: {
        supabaseUrl,
        supabaseAnonKey: json.supabasePublishableKey,
        promptTemplateVersion: json.promptTemplateVersion,
        contractVersion: json.contractVersion,
        authLandingUrl,
      },
    };
  }

  async function getAuthConfig(): Promise<ThemeServiceResult<ThemeServiceAuthConfig>> {
    if (opts.supabaseUrl && opts.supabaseAnonKey) {
      return {
        ok: true,
        value: {
          supabaseUrl: opts.supabaseUrl,
          supabaseAnonKey: opts.supabaseAnonKey,
          promptTemplateVersion: "",
          contractVersion: "",
        },
      };
    }
    if (!authConfigPromise) {
      authConfigPromise = fetchAuthConfig().then((res) => {
        // Only cache a success; a failed fetch must be retried on the next call.
        if (!res.ok) authConfigPromise = null;
        return res;
      });
    }
    return authConfigPromise;
  }

  // Review fix: concurrent 401 callers (authRequest) must share ONE
  // refetch, not each independently null-out authConfigPromise and issue
  // their own GET — that would multiply /api/auth-config calls under
  // concurrency the same way doRefreshSession's refreshInFlight guard
  // (below) coalesces concurrent session refreshes.
  let authConfigRefreshInFlight: Promise<ThemeServiceResult<ThemeServiceAuthConfig>> | null = null;

  async function refreshAuthConfig(): Promise<ThemeServiceResult<ThemeServiceAuthConfig>> {
    if (opts.supabaseUrl && opts.supabaseAnonKey) {
      return getAuthConfig();
    }
    if (authConfigRefreshInFlight) return authConfigRefreshInFlight;
    authConfigPromise = null;
    const attempt = fetchAuthConfig().then((res) => {
      authConfigPromise = res.ok ? Promise.resolve(res) : null;
      return res;
    });
    authConfigRefreshInFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (authConfigRefreshInFlight === attempt) authConfigRefreshInFlight = null;
    }
  }

  async function loadSession(): Promise<StoredSession | null> {
    let raw: string | null;
    try {
      raw = await tokenStore.get();
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        isRecord(parsed) &&
        typeof parsed.accessToken === "string" &&
        typeof parsed.refreshToken === "string" &&
        typeof parsed.expiresAt === "number"
      ) {
        return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresAt: parsed.expiresAt };
      }
      return null;
    } catch {
      return null;
    }
  }

  async function saveSession(session: StoredSession): Promise<void> {
    await tokenStore.set(JSON.stringify(session));
  }

  async function clearSession(): Promise<void> {
    try {
      await tokenStore.clear();
    } catch {
      /* best-effort */
    }
  }

  function parseGoTrueSession(json: unknown, nowMs: number): StoredSession | null {
    if (
      !isRecord(json) ||
      typeof json.access_token !== "string" ||
      typeof json.refresh_token !== "string" ||
      typeof json.expires_in !== "number"
    ) {
      return null;
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: nowMs + json.expires_in * 1000,
    };
  }

  async function authRequestOnce(
    path: string,
    body: unknown,
    bearer: string | undefined,
    config: ThemeServiceAuthConfig
  ): Promise<{ status: number; result: ThemeServiceResult<unknown> }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      apikey: config.supabaseAnonKey,
    };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    let res: Response;
    try {
      res = await fetchImpl(`${config.supabaseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (err) {
      return {
        status: 0,
        result: { ok: false, error: { kind: "unreachable", message: err instanceof Error ? err.message : String(err) } },
      };
    }
    let json: unknown = undefined;
    if (res.status !== 204) {
      try {
        const text = await res.text();
        json = text.length > 0 ? JSON.parse(text) : undefined;
      } catch (err) {
        return {
          status: res.status,
          result: {
            ok: false,
            error: invalidResponse(`failed to parse auth response JSON: ${err instanceof Error ? err.message : String(err)}`),
          },
        };
      }
    }
    if (res.ok) return { status: res.status, result: { ok: true, value: json } };
    const errBody = isRecord(json) ? json : {};
    const errorField =
      typeof errBody.error === "string"
        ? errBody.error
        : typeof errBody.error_description === "string"
          ? errBody.error_description
          : typeof errBody.msg === "string"
            ? errBody.msg
            : undefined;
    if (res.status === 401 || res.status === 400) {
      return {
        status: res.status,
        result: { ok: false, error: { kind: "not_signed_in", status: res.status, message: errorField ?? "auth failed" } },
      };
    }
    if (res.status === 429) {
      return {
        status: res.status,
        result: { ok: false, error: { kind: "rate_limited", status: 429, message: errorField ?? "rate limited" } },
      };
    }
    return {
      status: res.status,
      result: {
        ok: false,
        error: { kind: "server_error", status: res.status, message: errorField ?? `unexpected status ${res.status}` },
      },
    };
  }

  /**
   * Review fix (p65-t2): a 401 from a Supabase auth call can mean the
   * fetched auth config is stale (rotated project/anon key) as much as it
   * can mean bad credentials. On a 401, the cached config is dropped and
   * the SAME request is retried exactly once against a freshly fetched
   * config; if it still 401s, the original (first) error is returned
   * unchanged — never an infinite loop, never masking a real "wrong
   * password"-style failure behind a config refetch loop.
   */
  // Fix: when the caller supplies a static supabaseUrl+supabaseAnonKey
  // (test-only override, see ThemeServiceClientOptions), there is no
  // fetched config that can be stale — retrying against it is a no-op that
  // only doubles the network call (and, for a refresh_token grant, POSTs
  // the same possibly-single-use token twice). Only real fetched config
  // (from GET /api/auth-config) is ever worth refetching-and-retrying.
  const usesStaticAuthConfig = Boolean(opts.supabaseUrl && opts.supabaseAnonKey);

  async function authRequest(path: string, body: unknown, bearer?: string): Promise<ThemeServiceResult<unknown>> {
    const configRes = await getAuthConfig();
    if (!configRes.ok) return configRes;
    const first = await authRequestOnce(path, body, bearer, configRes.value);
    if (first.status !== 401 || usesStaticAuthConfig) return first.result;
    const retryConfigRes = await refreshAuthConfig();
    if (!retryConfigRes.ok) return first.result;
    const second = await authRequestOnce(path, body, bearer, retryConfigRes.value);
    return second.status === 401 ? first.result : second.result;
  }

  async function doRefreshSessionUncoordinated(): Promise<ThemeServiceResult<void>> {
    const session = await loadSession();
    if (!session) return { ok: false, error: { kind: "not_signed_in", message: "no session to refresh" } };
    const res = await authRequest(`/auth/v1/token?grant_type=refresh_token`, { refresh_token: session.refreshToken });
    if (!res.ok) {
      return res as ThemeServiceResult<void>;
    }
    const parsed = parseGoTrueSession(res.value, now());
    if (!parsed) {
      return { ok: false, error: invalidResponse("malformed refresh response") };
    }
    await saveSession(parsed);
    return { ok: true, value: undefined };
  }

  // Single-flight guard: concurrent 401s (or a proactive check racing a
  // retry) must not each POST the same stale refresh_token — Supabase
  // rotates it, so the second call would invalidate the first's freshly
  // saved session. All concurrent callers await the one in-flight refresh;
  // the session is cleared only when that single shared refresh fails.
  let refreshInFlight: Promise<ThemeServiceResult<void>> | null = null;

  async function doRefreshSession(): Promise<ThemeServiceResult<void>> {
    if (refreshInFlight) return refreshInFlight;
    const attempt = doRefreshSessionUncoordinated().then(async (res) => {
      // Bug fix: only a DEFINITIVE rejection of the refresh token itself
      // (kind "not_signed_in" — Supabase's /token?grant_type=refresh_token
      // returning 400/401, or no session to refresh at all) proves the
      // session is actually invalid. Every other failure kind here
      // ("unreachable", "timeout", "server_error", "rate_limited",
      // "invalid_response", ...) is a TRANSIENT problem reaching the auth
      // server — most plausibly right after a Render cold start, exactly
      // like the account-fetch "timeout" that preceded this call — and
      // must never destroy a session that may still be perfectly valid.
      // Previously ANY failure here cleared the session, so a brief
      // network/server hiccup immediately after a genuine, successful
      // sign-in silently and permanently signed the user back out: the
      // next getStatus() correctly reported signedIn:false (the session
      // really was gone from local storage), and the webview correctly
      // rendered Sign-in for what looked to the user like an ignored
      // login.
      if (!res.ok && res.error.kind === "not_signed_in") await clearSession();
      return res;
    });
    refreshInFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (refreshInFlight === attempt) refreshInFlight = null;
    }
  }

  /** GET/POST against the Theme Service itself, with bearer auth + one 401 refresh-and-retry. */
  async function serviceRequest(
    path: string,
    init: {
      method: "GET" | "POST";
      body?: unknown;
      auth: boolean;
      timeoutMs?: number;
      /**
       * p83-t2: sends this bearer token instead of the stored session, and
       * never touches loadSession/doRefreshSession/tokenStore — used only
       * to VALIDATE a candidate access token (implicit-flow completion)
       * before it is ever persisted. Never combined with `auth: true`.
       */
      bearerOverride?: string;
    }
  ): Promise<ThemeServiceResult<unknown>> {
    // Clock-skew margin: refresh a little before actual expiry so a token
    // that is about to lapse mid-flight doesn't round-trip as a 401.
    const EXPIRY_SKEW_MS = 30_000;
    // Set when the proactive refresh below is attempted and fails, so the
    // 401 handler further down knows not to retry a refresh that already
    // failed for this same session.
    let proactiveRefreshFailed = false;
    // Bug fix: the actual error a refresh attempt (proactive or reactive,
    // below) failed with, so a transient one (network/server hiccup —
    // "unreachable"/"timeout"/"server_error"/"rate_limited"/
    // "invalid_response") can be reported as-is instead of being collapsed
    // into a hardcoded "not_signed_in" the caller (getStatus) treats as a
    // DEFINITIVE sign-out. Only a real "not_signed_in" refresh rejection
    // (doRefreshSession's own definitive-kind check) should ever produce
    // that kind here.
    let refreshFailureError: ThemeServiceError | undefined;

    async function once(): Promise<{ status: "ok"; value: unknown } | { status: "unauthorized" } | { status: "error"; error: ThemeServiceError }> {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (clientVersion) headers["X-Tycoon-Client"] = clientVersion;
      if (init.bearerOverride) {
        headers.Authorization = `Bearer ${init.bearerOverride}`;
      } else if (init.auth) {
        let session = await loadSession();
        if (!session) return { status: "unauthorized" };
        if (session.expiresAt - EXPIRY_SKEW_MS <= now()) {
          const refreshed = await doRefreshSession();
          if (!refreshed.ok) {
            proactiveRefreshFailed = true;
            refreshFailureError = refreshed.error;
            return { status: "unauthorized" };
          }
          session = await loadSession();
          if (!session) return { status: "unauthorized" };
        }
        headers.Authorization = `Bearer ${session.accessToken}`;
      }
      let res: Response;
      // Bounded request timeout (v3.4): the client previously had none, so a
      // hung connection to the service could stall a caller indefinitely.
      const effectiveTimeoutMs = init.timeoutMs ?? requestTimeoutMs;
      const timeoutController = typeof AbortController !== "undefined" ? new AbortController() : undefined;
      const timeoutHandle = timeoutController
        ? setTimeout(() => timeoutController.abort(), effectiveTimeoutMs)
        : undefined;
      try {
        res = await fetchImpl(`${endpoint}${path}`, {
          method: init.method,
          headers,
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: timeoutController?.signal,
        });
      } catch (err) {
        const timedOut = timeoutController?.signal.aborted === true;
        return {
          status: "error",
          error: timedOut
            ? { kind: "timeout", message: `request timed out after ${effectiveTimeoutMs}ms` }
            : { kind: "unreachable", message: err instanceof Error ? err.message : String(err) },
        };
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
      let json: unknown = undefined;
      if (res.status !== 204) {
        try {
          const text = await res.text();
          json = text.length > 0 ? JSON.parse(text) : undefined;
        } catch (err) {
          return {
            status: "error",
            error: invalidResponse(`failed to parse response JSON: ${err instanceof Error ? err.message : String(err)}`),
          };
        }
      }
      if (res.ok) return { status: "ok", value: json };
      if (res.status === 401) return { status: "unauthorized" };
      const errBody = isRecord(json) ? json : {};
      const errorField = typeof errBody.error === "string" ? sanitizeImageProviderText(errBody.error) : undefined;
      const credits = typeof errBody.credits === "number" ? errBody.credits : undefined;
      const refunded = typeof errBody.refunded === "boolean" ? errBody.refunded : undefined;
      const codeField = typeof errBody.code === "string" ? errBody.code : undefined;
      switch (res.status) {
        case 400:
          // p85: the backend sends { error: "bad_request", code?: "..." }
          // (src/json.mjs sendError) for a malformed body — this previously
          // fell into the `default` branch below as a generic "server_error",
          // which the UI rendered as "Theme Service unavailable — no credits
          // were charged" even though the request was simply rejected and no
          // attempt (and no charge) was ever made.
          return {
            status: "error",
            error: {
              kind: "bad_request",
              status: 400,
              code: codeField,
              message: codeField
                ? `The Theme Service rejected this request (${codeField}). No credits were charged.`
                : "The Theme Service rejected this request. No credits were charged.",
            },
          };
        case 402:
          return {
            status: "error",
            error: { kind: "insufficient_credits", status: 402, message: errorField ?? "insufficient credits", credits },
          };
        case 403:
          return {
            status: "error",
            error: { kind: "account_locked", status: 403, message: errorField ?? "account locked" },
          };
        case 422: {
          // p94: the likeness/IP precheck block (src/attempt.mjs, screen.mjs
          // in the theme service backend) sends a singular `category: "likeness"
          // | "ip"` string, not the plural `categories` array the moderation
          // pre-screen block sends — an older client here read only
          // `categories`, so a likeness/IP block silently fell back to the
          // generic "blocked by content screening" copy with no category
          // named. Fold the singular field into the same categories array
          // the UI already renders from.
          const categoriesArray = Array.isArray(errBody.categories)
            ? errBody.categories.filter((c): c is string => typeof c === "string")
            : undefined;
          const singleCategory = typeof errBody.category === "string" ? errBody.category : undefined;
          const categories = categoriesArray && categoriesArray.length > 0
            ? categoriesArray
            : (singleCategory ? [singleCategory] : undefined);
          const fields = Array.isArray(errBody.fields)
            ? errBody.fields.filter((f): f is string => typeof f === "string")
            : undefined;
          return {
            status: "error",
            error: {
              kind: "content_blocked",
              status: 422,
              message: errorField ?? "content blocked",
              refunded,
              categories: categories && categories.length > 0 ? categories : undefined,
              fields: fields && fields.length > 0 ? fields : undefined,
            },
          };
        }
        case 429: {
          // v3.6 backend (not yet deployed everywhere): { error: "rate_limited",
          // scope: "minute"|"day"|"provider", limit?, retryAfterSeconds? } plus
          // a Retry-After header. All fields are parsed defensively — an
          // older backend's bare { error: "rate_limited" } (no scope/limit/
          // retryAfterSeconds, no header) still works exactly as before.
          const scope = errBody.scope === "minute" || errBody.scope === "day" || errBody.scope === "provider"
            ? errBody.scope
            : undefined;
          const limit = typeof errBody.limit === "number" && Number.isFinite(errBody.limit) ? errBody.limit : undefined;
          let retryAfterSeconds = typeof errBody.retryAfterSeconds === "number" && Number.isFinite(errBody.retryAfterSeconds) && errBody.retryAfterSeconds >= 0
            ? errBody.retryAfterSeconds
            : undefined;
          if (retryAfterSeconds === undefined) {
            const headerVal = res.headers.get("Retry-After");
            const parsedHeader = headerVal !== null ? Number(headerVal) : NaN;
            if (Number.isFinite(parsedHeader) && parsedHeader >= 0) retryAfterSeconds = parsedHeader;
          }
          return {
            status: "error",
            error: {
              kind: "rate_limited",
              status: 429,
              message: buildRateLimitedMessage(scope, limit, retryAfterSeconds),
              scope,
              limit,
              retryAfterSeconds,
            },
          };
        }
        case 502:
          return {
            status: "error",
            error: { kind: "provider_failed", status: 502, message: errorField ?? "provider failed", refunded, credits },
          };
        case 503:
          // p83-t1: the backend's `error` field for a 503 can be the bare
          // short code "unavailable" (not a readable sentence) — that
          // verbatim text was rendered straight into the sign-in UI. Always
          // use a fixed, readable message here instead of trusting
          // `errorField`; nothing about the raw field is lost since callers
          // only ever consult `kind` for behavior.
          return {
            status: "error",
            error: {
              kind: "unavailable",
              status: 503,
              message: "Theme Service unavailable (503). No credits were charged. If you started several generations at once, try fewer at a time.",
            },
          };
        default:
          return {
            status: "error",
            error: { kind: "server_error", status: res.status, message: errorField ?? `unexpected status ${res.status}` },
          };
      }
    }

    if (!init.auth) {
      const r = await once();
      if (r.status === "ok") return { ok: true, value: r.value };
      if (r.status === "unauthorized") {
        return { ok: false, error: { kind: "not_signed_in", status: 401, message: "not signed in" } };
      }
      return { ok: false, error: r.error };
    }

    let r = await once();
    if (r.status === "unauthorized" && !proactiveRefreshFailed) {
      const refreshed = await doRefreshSession();
      if (!refreshed.ok) {
        // Bug fix: only report "not_signed_in" (which callers treat as a
        // definitive, permanent sign-out) when the refresh itself was
        // definitively rejected. A transient refresh failure (network
        // hiccup, backend still warming after a cold start, ...) is
        // reported with its real kind instead, so a signed-in status fetch
        // that follows a genuine, successful sign-in never gets
        // misreported as "you're signed out" just because one refresh
        // attempt hit a flaky backend.
        return refreshed.error.kind === "not_signed_in"
          ? { ok: false, error: { kind: "not_signed_in", status: 401, message: "not signed in" } }
          : { ok: false, error: refreshed.error };
      }
      r = await once();
    }
    if (r.status === "ok") return { ok: true, value: r.value };
    if (r.status === "unauthorized") {
      if (!proactiveRefreshFailed) await clearSession();
      // Same fix as above: a proactive refresh that failed transiently
      // (refreshFailureError set, session left intact) must not be
      // reported as a definitive sign-out.
      if (proactiveRefreshFailed && refreshFailureError && refreshFailureError.kind !== "not_signed_in") {
        return { ok: false, error: refreshFailureError };
      }
      return { ok: false, error: { kind: "not_signed_in", status: 401, message: "not signed in" } };
    }
    return { ok: false, error: r.error };
  }

  return {
    async hasStoredSession() {
      return (await loadSession()) !== null;
    },

    async getStoredIdentity() {
      const session = await loadSession();
      if (!session) return undefined;
      return decodeJwtIdentityUnsafe(session.accessToken);
    },

    async getStoredUserId() {
      const session = await loadSession();
      if (!session) return undefined;
      return decodeJwtSubUnsafe(session.accessToken);
    },

    async requestMagicLink(email) {
      const res = await authRequest("/auth/v1/otp", { email, create_user: true });
      if (!res.ok) return res as ThemeServiceResult<void>;
      return { ok: true, value: undefined };
    },

    async verifyMagicLink(email, code) {
      const res = await authRequest("/auth/v1/verify", { type: "email", email, token: code });
      if (!res.ok) return res as ThemeServiceResult<void>;
      const parsed = parseGoTrueSession(res.value, now());
      if (!parsed) return { ok: false, error: invalidResponse("malformed verify response") };
      await saveSession(parsed);
      return { ok: true, value: undefined };
    },

    async getAuthLandingUrl() {
      const configRes = await getAuthConfig();
      if (!configRes.ok) return configRes;
      return { ok: true, value: configRes.value.authLandingUrl };
    },

    async startGoogleSignIn({ redirectTo }) {
      const configRes = await getAuthConfig();
      if (!configRes.ok) return configRes;
      const { supabaseUrl } = configRes.value;
      const codeVerifier = createCodeVerifier();
      if (codeVerifier === null) {
        return { ok: false, error: { kind: "server_error", message: "secure random unavailable" } };
      }
      const codeChallenge = await codeChallengeFor(codeVerifier);
      const url = new URL(`${supabaseUrl}/auth/v1/authorize`);
      url.searchParams.set("provider", "google");
      url.searchParams.set("redirect_to", redirectTo);
      url.searchParams.set("code_challenge", codeChallenge);
      // p83-t1: uppercase "S256" per RFC 7636 (Supabase's GoTrue accepts the
      // RFC-standard spelling; the previous lowercase "s256" was non-
      // standard and risked the challenge method not being recognized).
      url.searchParams.set("code_challenge_method", "S256");
      return { ok: true, value: { browserUrl: url.toString(), codeVerifier } };
    },

    async completeGoogleSignIn({ authCode, codeVerifier }) {
      const res = await authRequest(`/auth/v1/token?grant_type=pkce`, { auth_code: authCode, code_verifier: codeVerifier });
      if (!res.ok) return res as ThemeServiceResult<void>;
      const parsed = parseGoTrueSession(res.value, now());
      if (!parsed) return { ok: false, error: invalidResponse("malformed pkce token response") };
      await saveSession(parsed);
      return { ok: true, value: undefined };
    },

    // p83-t1: completes Google sign-in from the implicit-flow fragment
    // (#access_token=...&refresh_token=...) instead of a PKCE code exchange
    // — used when the callback URL carries tokens directly rather than a
    // `code`. Stores the session exactly as the code-exchange path does; no
    // network request is made (there is nothing left to exchange).
    async completeGoogleSignInImplicit({ accessToken, refreshToken, expiresIn }) {
      if (!accessToken || !refreshToken) {
        return { ok: false, error: invalidResponse("missing access/refresh token") };
      }
      // p83-t2 review fix: validate the candidate access token against the
      // service BEFORE persisting anything — a crafted callback carrying a
      // bogus token pair must never reach the token store, even transiently.
      const verify = await serviceRequest("/api/account", {
        method: "GET",
        auth: false,
        bearerOverride: accessToken,
        timeoutMs: statusTimeoutMs,
      });
      if (!verify.ok) return { ok: false, error: verify.error };
      await saveSession({
        accessToken,
        refreshToken,
        expiresAt: now() + (expiresIn ?? 3600) * 1000,
      });
      return { ok: true, value: undefined };
    },

    async refreshSession() {
      return doRefreshSession();
    },

    async signOut() {
      const session = await loadSession();
      if (session) {
        const doLogout = async (config: ThemeServiceAuthConfig): Promise<number | undefined> => {
          try {
            const res = await fetchImpl(`${config.supabaseUrl}/auth/v1/logout`, {
              method: "POST",
              headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${session.accessToken}` },
            });
            return res.status;
          } catch {
            /* best-effort */
            return undefined;
          }
        };
        const configRes = await getAuthConfig();
        if (configRes.ok) {
          const status = await doLogout(configRes.value);
          // Review fix (p65-t2): a stale cached config can 401 even for a
          // best-effort logout — retry once against a freshly fetched one.
          if (status === 401 && !usesStaticAuthConfig) {
            const retryConfigRes = await refreshAuthConfig();
            if (retryConfigRes.ok) await doLogout(retryConfigRes.value);
          }
        }
      }
      await clearSession();
      return { ok: true, value: undefined };
    },

    async getStatus() {
      const session = await loadSession();
      if (!session) return { ok: true, value: { signedIn: false } };
      const res = await serviceRequest("/api/account", { method: "GET", auth: true, timeoutMs: statusTimeoutMs });
      if (!res.ok) {
        if (res.error.kind === "not_signed_in") return { ok: true, value: { signedIn: false } };
        return res;
      }
      const json = res.value;
      if (!isRecord(json) || typeof json.email !== "string" || typeof json.role !== "string" || typeof json.credits !== "number") {
        return { ok: false, error: invalidResponse("malformed /api/account response") };
      }
      return {
        ok: true,
        value: {
          signedIn: true,
          email: json.email,
          displayName: typeof json.displayName === "string" ? json.displayName : undefined,
          role: json.role,
          credits: json.credits,
          locked: typeof json.locked === "boolean" ? json.locked : undefined,
          strikes: typeof json.strikes === "number" ? json.strikes : undefined,
        },
      };
    },

    async getPricing() {
      const res = await serviceRequest("/api/pricing", { method: "GET", auth: false, timeoutMs: statusTimeoutMs });
      if (!res.ok) return res;
      const json = res.value;
      if (
        !isRecord(json) ||
        !isRecord(json.attemptCostByBoardType) ||
        typeof json.planCost !== "number" ||
        !isRecord(json.typicalTheme) ||
        typeof json.typicalTheme.min !== "number" ||
        typeof json.typicalTheme.max !== "number" ||
        !Array.isArray(json.packs)
      ) {
        return { ok: false, error: invalidResponse("malformed /api/pricing response") };
      }
      const attemptCostByBoardType: Record<string, number> = {};
      for (const [k, v] of Object.entries(json.attemptCostByBoardType)) {
        if (typeof v !== "number") return { ok: false, error: invalidResponse("malformed attemptCostByBoardType entry") };
        attemptCostByBoardType[k] = v;
      }
      const packs: ThemeServicePack[] = [];
      for (const p of json.packs) {
        if (
          !isRecord(p) ||
          typeof p.id !== "string" ||
          typeof p.credits !== "number" ||
          typeof p.priceCents !== "number" ||
          typeof p.currency !== "string"
        ) {
          return { ok: false, error: invalidResponse("malformed pack entry") };
        }
        packs.push({
          id: p.id,
          label: typeof p.label === "string" ? p.label : undefined,
          credits: p.credits,
          bonusCredits: typeof p.bonusCredits === "number" ? p.bonusCredits : undefined,
          priceCents: p.priceCents,
          currency: p.currency,
        });
      }
      return {
        ok: true,
        value: {
          attemptCostByBoardType,
          planCost: json.planCost,
          typicalTheme: {
            min: json.typicalTheme.min,
            max: json.typicalTheme.max,
            typical: typeof json.typicalTheme.typical === "number" ? json.typicalTheme.typical : undefined,
          },
          packs,
        },
      };
    },

    async createCheckoutSession(pack) {
      const res = await serviceRequest("/api/store/checkout", { method: "POST", body: { pack }, auth: true });
      if (!res.ok) return res;
      const json = res.value;
      if (!isRecord(json) || typeof json.url !== "string") {
        return { ok: false, error: invalidResponse("malformed checkout response") };
      }
      return { ok: true, value: { url: json.url } };
    },

    async generateAttempt(req) {
      const res = await serviceRequest("/api/generate", { method: "POST", body: req, auth: true });
      if (!res.ok) return res;
      const json = res.value;
      if (
        !isRecord(json) ||
        typeof json.image !== "string" ||
        typeof json.attemptCost !== "number" ||
        typeof json.credits !== "number" ||
        typeof json.refunded !== "boolean"
      ) {
        return { ok: false, error: invalidResponse("malformed /api/generate response") };
      }
      return {
        ok: true,
        value: {
          image: json.image,
          attemptCost: json.attemptCost,
          credits: json.credits,
          refunded: json.refunded,
          promptTemplateVersion: typeof json.promptTemplateVersion === "string" ? json.promptTemplateVersion : undefined,
          assembledPromptSha256: typeof json.assembledPromptSha256 === "string" ? json.assembledPromptSha256 : undefined,
        },
      };
    },

    async applyReferralCode(code) {
      if (!REFERRAL_CODE_PATTERN.test(code)) {
        return { ok: true, value: { applied: false, reason: "invalid_format" } };
      }
      const res = await serviceRequest("/api/account/referral", { method: "POST", body: { referralCode: code }, auth: true });
      if (!res.ok) return res;
      const json = res.value;
      if (!isRecord(json) || typeof json.applied !== "boolean") {
        return { ok: false, error: invalidResponse("malformed /api/account/referral response") };
      }
      return {
        ok: true,
        value: { applied: json.applied, reason: typeof json.reason === "string" ? json.reason : undefined },
      };
    },

    async planRequest(req) {
      const res = await serviceRequest("/api/plan", { method: "POST", body: req, auth: true, timeoutMs: planTimeoutMs });
      if (!res.ok) return res;
      const json = res.value;
      if (
        !isRecord(json) ||
        !isRecord(json.output) ||
        typeof json.attemptCost !== "number" ||
        typeof json.credits !== "number" ||
        typeof json.refunded !== "boolean"
      ) {
        return { ok: false, error: invalidResponse("malformed /api/plan response") };
      }
      return {
        ok: true,
        value: { output: json.output, attemptCost: json.attemptCost, credits: json.credits, refunded: json.refunded },
      };
    },
  };
}
