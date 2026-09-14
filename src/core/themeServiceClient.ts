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

// Canonical production endpoints (docs/theme-service-api.md, Conventions),
// same pattern as FEEDBACK_ENDPOINT in src/host/vscode/feedbackSubmit.ts:36.
// Baked into every shipped release; repointable server-side without a
// client update, never a throwaway subdomain. Do not change these to
// test/staging values in a commit that ships.
export const THEME_SERVICE_ENDPOINT = "https://theme.corsairstudios.com";
export const SUPABASE_URL = "https://REPLACE_WITH_PROJECT.supabase.co";
// Supabase's anon key is public by design (it's meant to ship client-side,
// same as SUPABASE_URL above) — this placeholder is set to the real
// project anon key at release time, not a secret to protect at build time.
export const SUPABASE_ANON_KEY = "REPLACE_WITH_PROJECT_ANON_KEY";

export type ThemeServiceErrorKind =
  | "not_signed_in"
  | "insufficient_credits"
  | "rate_limited"
  | "provider_failed"
  | "unavailable"
  | "unreachable"
  | "server_error"
  | "invalid_response";

export interface ThemeServiceError {
  kind: ThemeServiceErrorKind;
  status?: number;
  message: string;
  refunded?: boolean;
  credits?: number;
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
  /** Overrides {@link SUPABASE_URL}; for tests only. */
  supabaseUrl?: string;
  /** Overrides {@link SUPABASE_ANON_KEY}; for tests only. */
  supabaseAnonKey?: string;
  /** Injectable clock (ms epoch); defaults to `Date.now`. */
  now?: () => number;
  /** Injectable PKCE code-verifier generator; for deterministic tests. */
  createCodeVerifier?: () => string;
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
}

export interface ThemeServicePack {
  id: string;
  credits: number;
  priceCents: number;
  currency: string;
}

export interface ThemeServicePricing {
  attemptCostByBoardType: Record<string, number>;
  /** Credit cost of one /api/plan attempt (either `kind`); see docs/theme-service-api.md "Plan / description generation". */
  planCost: number;
  typicalTheme: { min: number; max: number };
  packs: ThemeServicePack[];
}

export interface CheckoutSession {
  url: string;
}

export interface GenerateAttemptRequest {
  idempotencyKey: string;
  boardType: string;
  prompt: string;
  referenceImages?: string[];
  size: string;
}

export interface GenerateAttemptResponse {
  image: string;
  attemptCost: number;
  credits: number;
  refunded: boolean;
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

export interface ThemeServiceClient {
  requestMagicLink(email: string): Promise<ThemeServiceResult<void>>;
  verifyMagicLink(email: string, code: string): Promise<ThemeServiceResult<void>>;
  startGoogleSignIn(input: { redirectTo: string }): Promise<ThemeServiceResult<GoogleSignInStart>>;
  completeGoogleSignIn(input: { authCode: string; codeVerifier: string }): Promise<ThemeServiceResult<void>>;
  refreshSession(): Promise<ThemeServiceResult<void>>;
  signOut(): Promise<ThemeServiceResult<void>>;
  getStatus(): Promise<ThemeServiceResult<ThemeServiceStatus>>;
  getPricing(): Promise<ThemeServiceResult<ThemeServicePricing>>;
  createCheckoutSession(pack: string): Promise<ThemeServiceResult<CheckoutSession>>;
  generateAttempt(req: GenerateAttemptRequest): Promise<ThemeServiceResult<GenerateAttemptResponse>>;
  planRequest(req: PlanRequest): Promise<ThemeServiceResult<PlanRequestResponse>>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function invalidResponse(message: string): ThemeServiceError {
  return { kind: "invalid_response", message };
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
  const supabaseUrl = opts.supabaseUrl ?? SUPABASE_URL;
  const supabaseAnonKey = opts.supabaseAnonKey ?? SUPABASE_ANON_KEY;
  const tokenStore = opts.tokenStore;
  const now = opts.now ?? (() => Date.now());
  const createCodeVerifier: () => string | null = opts.createCodeVerifier ?? defaultCreateCodeVerifier;

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

  async function authRequest(path: string, body: unknown, bearer?: string): Promise<ThemeServiceResult<unknown>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      apikey: supabaseAnonKey,
    };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    let res: Response;
    try {
      res = await fetchImpl(`${supabaseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (err) {
      return { ok: false, error: { kind: "unreachable", message: err instanceof Error ? err.message : String(err) } };
    }
    let json: unknown = undefined;
    if (res.status !== 204) {
      try {
        const text = await res.text();
        json = text.length > 0 ? JSON.parse(text) : undefined;
      } catch (err) {
        return {
          ok: false,
          error: invalidResponse(`failed to parse auth response JSON: ${err instanceof Error ? err.message : String(err)}`),
        };
      }
    }
    if (res.ok) return { ok: true, value: json };
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
      return { ok: false, error: { kind: "not_signed_in", status: res.status, message: errorField ?? "auth failed" } };
    }
    if (res.status === 429) {
      return { ok: false, error: { kind: "rate_limited", status: 429, message: errorField ?? "rate limited" } };
    }
    return {
      ok: false,
      error: { kind: "server_error", status: res.status, message: errorField ?? `unexpected status ${res.status}` },
    };
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
      if (!res.ok) await clearSession();
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
    init: { method: "GET" | "POST"; body?: unknown; auth: boolean }
  ): Promise<ThemeServiceResult<unknown>> {
    // Clock-skew margin: refresh a little before actual expiry so a token
    // that is about to lapse mid-flight doesn't round-trip as a 401.
    const EXPIRY_SKEW_MS = 30_000;
    // Set when the proactive refresh below is attempted and fails, so the
    // 401 handler further down knows not to retry a refresh that already
    // failed for this same session.
    let proactiveRefreshFailed = false;

    async function once(): Promise<{ status: "ok"; value: unknown } | { status: "unauthorized" } | { status: "error"; error: ThemeServiceError }> {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (init.auth) {
        let session = await loadSession();
        if (!session) return { status: "unauthorized" };
        if (session.expiresAt - EXPIRY_SKEW_MS <= now()) {
          const refreshed = await doRefreshSession();
          if (!refreshed.ok) {
            proactiveRefreshFailed = true;
            return { status: "unauthorized" };
          }
          session = await loadSession();
          if (!session) return { status: "unauthorized" };
        }
        headers.Authorization = `Bearer ${session.accessToken}`;
      }
      let res: Response;
      try {
        res = await fetchImpl(`${endpoint}${path}`, {
          method: init.method,
          headers,
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
      } catch (err) {
        return { status: "error", error: { kind: "unreachable", message: err instanceof Error ? err.message : String(err) } };
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
      const errorField = typeof errBody.error === "string" ? errBody.error : undefined;
      const credits = typeof errBody.credits === "number" ? errBody.credits : undefined;
      const refunded = typeof errBody.refunded === "boolean" ? errBody.refunded : undefined;
      switch (res.status) {
        case 402:
          return {
            status: "error",
            error: { kind: "insufficient_credits", status: 402, message: errorField ?? "insufficient credits", credits },
          };
        case 429:
          return { status: "error", error: { kind: "rate_limited", status: 429, message: errorField ?? "rate limited" } };
        case 502:
          return {
            status: "error",
            error: { kind: "provider_failed", status: 502, message: errorField ?? "provider failed", refunded, credits },
          };
        case 503:
          return { status: "error", error: { kind: "unavailable", status: 503, message: errorField ?? "service unavailable" } };
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
        return { ok: false, error: { kind: "not_signed_in", status: 401, message: "not signed in" } };
      }
      r = await once();
    }
    if (r.status === "ok") return { ok: true, value: r.value };
    if (r.status === "unauthorized") {
      await clearSession();
      return { ok: false, error: { kind: "not_signed_in", status: 401, message: "not signed in" } };
    }
    return { ok: false, error: r.error };
  }

  return {
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

    async startGoogleSignIn({ redirectTo }) {
      const codeVerifier = createCodeVerifier();
      if (codeVerifier === null) {
        return { ok: false, error: { kind: "server_error", message: "secure random unavailable" } };
      }
      const codeChallenge = await codeChallengeFor(codeVerifier);
      const url = new URL(`${supabaseUrl}/auth/v1/authorize`);
      url.searchParams.set("provider", "google");
      url.searchParams.set("redirect_to", redirectTo);
      url.searchParams.set("code_challenge", codeChallenge);
      // Lowercase "s256" per Supabase's GoTrue docs (not the RFC 7636
      // uppercase "S256" some OAuth providers expect).
      url.searchParams.set("code_challenge_method", "s256");
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

    async refreshSession() {
      return doRefreshSession();
    },

    async signOut() {
      const session = await loadSession();
      if (session) {
        try {
          await fetchImpl(`${supabaseUrl}/auth/v1/logout`, {
            method: "POST",
            headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${session.accessToken}` },
          });
        } catch {
          /* best-effort */
        }
      }
      await clearSession();
      return { ok: true, value: undefined };
    },

    async getStatus() {
      const session = await loadSession();
      if (!session) return { ok: true, value: { signedIn: false } };
      const res = await serviceRequest("/api/account", { method: "GET", auth: true });
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
        },
      };
    },

    async getPricing() {
      const res = await serviceRequest("/api/pricing", { method: "GET", auth: false });
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
        packs.push({ id: p.id, credits: p.credits, priceCents: p.priceCents, currency: p.currency });
      }
      return {
        ok: true,
        value: {
          attemptCostByBoardType,
          planCost: json.planCost,
          typicalTheme: { min: json.typicalTheme.min, max: json.typicalTheme.max },
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
        value: { image: json.image, attemptCost: json.attemptCost, credits: json.credits, refunded: json.refunded },
      };
    },

    async planRequest(req) {
      const res = await serviceRequest("/api/plan", { method: "POST", body: req, auth: true });
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
