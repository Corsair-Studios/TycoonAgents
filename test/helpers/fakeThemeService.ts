/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// In-memory fake emulating BOTH a Supabase GoTrue auth base (`supabaseUrl`)
// and the Corsair Theme Service itself (`endpoint`) per docs/theme-service-api.md
// (v2). Routes are distinguished purely by URL prefix so a single injectable
// `fetch`-shaped function can back `createThemeServiceClient({ fetch,
// tokenStore, endpoint, supabaseUrl, supabaseAnonKey })` in tests without any
// network or real timers. Deterministic: no randomness unless seeded via
// `now`, no setTimeout/setInterval.

export interface PricingPack {
  id: string;
  credits: number;
  priceCents: number;
  currency: string;
}

export interface Pricing {
  attemptCostByBoardType: Record<string, number>;
  typicalTheme: { min: number; max: number };
  packs: PricingPack[];
}

export interface Account {
  id: string;
  email: string;
  role: string;
}

export interface LedgerRow {
  userId: string;
  delta: number;
  reason: string;
  ref: string | null;
}

interface GenerateRecord {
  ref: string;
  response: { status: number; body: unknown };
}

export interface FakeThemeServiceState {
  accounts: Map<string, Account>; // accountId -> Account
  accountsByEmail: Map<string, string>;
  balances: Map<string, number>;
  ledger: LedgerRow[];
  // auth
  accessTokens: Map<string, string>; // access token -> accountId
  refreshTokens: Map<string, string>; // refresh token -> accountId
  revokedAccessTokens: Set<string>;
  pendingOtps: Map<string, string>; // email -> code
  pendingGoogleChallenges: Map<string, { challenge: string; accountId: string }>; // authCode -> ...
  // checkout
  checkoutSessions: Map<string, { accountId: string; pack: string; completed: boolean }>;
  generateRequests: GenerateRecord[];
  pricing: Pricing;
}

export interface FakeThemeServiceOptions {
  endpoint?: string;
  supabaseUrl?: string;
  pricing?: Partial<Pricing>;
  now?: () => number;
}

const DEFAULT_PRICING: Pricing = {
  attemptCostByBoardType: {
    roster_agent: 1,
    rival_group: 1,
    objects_01: 1,
    objects_02: 1,
    environment: 1,
    expressions: 1,
    achievements: 1,
  },
  typicalTheme: { min: 12, max: 30 },
  packs: [
    { id: "mini30", credits: 30, priceCents: 299, currency: "usd" },
    { id: "standard250", credits: 250, priceCents: 1999, currency: "usd" },
    { id: "bulk750", credits: 750, priceCents: 4999, currency: "usd" },
    { id: "whale2000", credits: 2000, priceCents: 9999, currency: "usd" },
  ],
};

const DEFAULT_OTP_CODE = "123456";
const ACCESS_TOKEN_TTL_SECONDS = 3600;

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

// base64url SHA-256, matching the client's PKCE challenge derivation
// (base64url(sha256(verifier))), computed independently here (no shared
// code with src/) so the fake can verify the challenge on its own.
async function sha256Base64Url(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const subtle = (globalThis as unknown as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) throw new Error("crypto.subtle unavailable in test environment");
  const digest = await subtle.digest("SHA-256", bytes);
  let binary = "";
  const view = new Uint8Array(digest);
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  const b64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Creates an in-memory fake of Supabase GoTrue (at `supabaseUrl`) plus the
 * Corsair Theme Service (at `endpoint`), implementing every route in
 * docs/theme-service-api.md (v2). Returns a `fetch`-shaped function for
 * injection into `createThemeServiceClient`, plus introspectable `state`
 * and test `helpers`.
 */
export function createFakeThemeService(options: FakeThemeServiceOptions = {}): {
  fetch: typeof fetch;
  state: FakeThemeServiceState;
  helpers: {
    createAccount(email: string, role?: string): Account;
    grant(accountId: string, credits: number, ref?: string): LedgerRow | undefined;
    failNextGenerate(): void;
    setUnavailable(unavailable: boolean): void;
    completeGoogleInBrowser(): Promise<string>;
    completeCheckout(sessionId: string): LedgerRow | undefined;
    setOtpCode(email: string, code: string): void;
    expireAccessToken(): void;
  };
} {
  const endpoint = options.endpoint ?? "https://theme-service.example";
  const supabaseUrl = options.supabaseUrl ?? "https://fake-project.supabase.co";
  const now = options.now ?? (() => Date.now());
  const pricing: Pricing = {
    attemptCostByBoardType: {
      ...DEFAULT_PRICING.attemptCostByBoardType,
      ...(options.pricing?.attemptCostByBoardType ?? {}),
    },
    typicalTheme: { ...DEFAULT_PRICING.typicalTheme, ...(options.pricing?.typicalTheme ?? {}) },
    packs: options.pricing?.packs ?? DEFAULT_PRICING.packs,
  };

  const state: FakeThemeServiceState = {
    accounts: new Map(),
    accountsByEmail: new Map(),
    balances: new Map(),
    ledger: [],
    accessTokens: new Map(),
    refreshTokens: new Map(),
    revokedAccessTokens: new Set(),
    pendingOtps: new Map(),
    pendingGoogleChallenges: new Map(),
    checkoutSessions: new Map(),
    generateRequests: [],
    pricing,
  };

  let unavailable = false;
  let failNextGenerateOnce = false;
  // sessionId used by startGoogleSignIn's authorize call, held so
  // completeGoogleInBrowser (no args) can find the most recent one.
  let lastGoogleAuthCode: string | null = null;
  let lastGoogleRedirectTo: string | null = null;

  function getOrCreateAccountByEmail(email: string): Account {
    const existingId = state.accountsByEmail.get(email);
    if (existingId) return state.accounts.get(existingId)!;
    const account: Account = { id: nextId("acct"), email, role: "user" };
    state.accounts.set(account.id, account);
    state.accountsByEmail.set(email, account.id);
    state.balances.set(account.id, 0);
    return account;
  }

  function issueSession(accountId: string): { access_token: string; refresh_token: string; expires_in: number; user: { id: string; email: string } } {
    const accessToken = nextId("access");
    const refreshToken = nextId("refresh");
    state.accessTokens.set(accessToken, accountId);
    state.refreshTokens.set(refreshToken, accountId);
    const account = state.accounts.get(accountId)!;
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      user: { id: account.id, email: account.email },
    };
  }

  function recordLedger(row: LedgerRow): void {
    state.ledger.push(row);
  }

  function balanceOf(accountId: string): number {
    return state.balances.get(accountId) ?? 0;
  }

  function ledgerRefExists(ref: string): boolean {
    return state.ledger.some((r) => r.ref === ref);
  }

  function accountForBearer(authHeader: string | null): Account | null {
    if (!authHeader?.startsWith("Bearer ")) return null;
    const token = authHeader.slice("Bearer ".length);
    if (state.revokedAccessTokens.has(token)) return null;
    const accountId = state.accessTokens.get(token);
    if (!accountId) return null;
    return state.accounts.get(accountId) ?? null;
  }

  async function readJsonBody(init?: RequestInit): Promise<unknown> {
    if (!init?.body) return {};
    const text = typeof init.body === "string" ? init.body : String(init.body);
    if (text.length === 0) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
  }

  const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url);
    const fullUrl = url.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? {});

    // ---- Supabase GoTrue base ----
    if (fullUrl.startsWith(supabaseUrl)) {
      const path = url.pathname;

      if (path === "/auth/v1/otp" && method === "POST") {
        const body = await readJsonBody(init);
        if (!isRecord(body) || typeof body.email !== "string") return jsonResponse(400, { error: "invalid request" });
        state.pendingOtps.set(body.email, DEFAULT_OTP_CODE);
        getOrCreateAccountByEmail(body.email);
        return jsonResponse(200, {});
      }

      if (path === "/auth/v1/verify" && method === "POST") {
        const body = await readJsonBody(init);
        if (!isRecord(body) || typeof body.email !== "string" || typeof body.token !== "string") {
          return jsonResponse(400, { error: "invalid request" });
        }
        const expected = state.pendingOtps.get(body.email);
        if (!expected || expected !== body.token) {
          return jsonResponse(401, { error: "invalid or expired otp" });
        }
        state.pendingOtps.delete(body.email);
        const account = getOrCreateAccountByEmail(body.email);
        return jsonResponse(200, issueSession(account.id));
      }

      if (path === "/auth/v1/authorize" && method === "GET") {
        const redirectTo = url.searchParams.get("redirect_to") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        const authCode = nextId("authcode");
        const account = getOrCreateAccountByEmail("google-user@example.com");
        state.pendingGoogleChallenges.set(authCode, { challenge, accountId: account.id });
        lastGoogleAuthCode = authCode;
        lastGoogleRedirectTo = redirectTo;
        const location = `${redirectTo}${redirectTo.includes("?") ? "&" : "?"}code=${authCode}`;
        return new Response(null, { status: 302, headers: { Location: location } });
      }

      if (path === "/auth/v1/token" && method === "POST" && url.searchParams.get("grant_type") === "pkce") {
        const body = await readJsonBody(init);
        if (!isRecord(body) || typeof body.auth_code !== "string" || typeof body.code_verifier !== "string") {
          return jsonResponse(400, { error: "invalid request" });
        }
        const pending = state.pendingGoogleChallenges.get(body.auth_code);
        if (!pending) return jsonResponse(401, { error: "invalid auth code" });
        const computed = await sha256Base64Url(body.code_verifier);
        if (computed !== pending.challenge) {
          return jsonResponse(401, { error: "invalid code_verifier" });
        }
        state.pendingGoogleChallenges.delete(body.auth_code);
        return jsonResponse(200, issueSession(pending.accountId));
      }

      if (path === "/auth/v1/token" && method === "POST" && url.searchParams.get("grant_type") === "refresh_token") {
        const body = await readJsonBody(init);
        if (!isRecord(body) || typeof body.refresh_token !== "string") return jsonResponse(400, { error: "invalid request" });
        const accountId = state.refreshTokens.get(body.refresh_token);
        if (!accountId) return jsonResponse(401, { error: "invalid refresh token" });
        // Rotate: invalidate the old refresh token, issue a fresh session.
        state.refreshTokens.delete(body.refresh_token);
        return jsonResponse(200, issueSession(accountId));
      }

      if (path === "/auth/v1/logout" && method === "POST") {
        const token = headers.get("Authorization")?.replace(/^Bearer /, "") ?? null;
        if (token) state.revokedAccessTokens.add(token);
        return emptyResponse(204);
      }

      return jsonResponse(404, { error: "not_found" });
    }

    // ---- Theme Service ----
    if (fullUrl.startsWith(endpoint)) {
      const path = url.pathname;

      if (unavailable) {
        return jsonResponse(503, { error: "unavailable" });
      }

      if (path === "/api/health" && method === "GET") {
        return jsonResponse(200, { ok: true });
      }

      if (path === "/api/pricing" && method === "GET") {
        return jsonResponse(200, state.pricing);
      }

      if (path === "/api/account" && method === "GET") {
        const account = accountForBearer(headers.get("Authorization"));
        if (!account) return jsonResponse(401, { error: "not_signed_in" });
        return jsonResponse(200, { email: account.email, role: account.role, credits: balanceOf(account.id) });
      }

      if (path === "/api/store/checkout" && method === "POST") {
        const account = accountForBearer(headers.get("Authorization"));
        if (!account) return jsonResponse(401, { error: "not_signed_in" });
        const body = await readJsonBody(init);
        if (!isRecord(body) || typeof body.pack !== "string") return jsonResponse(400, { error: "invalid request" });
        const pack = state.pricing.packs.find((p) => p.id === body.pack);
        if (!pack) return jsonResponse(400, { error: "unknown pack" });
        const sessionId = nextId("cs");
        state.checkoutSessions.set(sessionId, { accountId: account.id, pack: pack.id, completed: false });
        return jsonResponse(200, { url: `https://checkout.stripe.com/c/pay/${sessionId}` });
      }

      if (path === "/api/generate" && method === "POST") {
        const account = accountForBearer(headers.get("Authorization"));
        if (!account) return jsonResponse(401, { error: "not_signed_in" });
        const body = await readJsonBody(init);
        if (!isRecord(body) || typeof body.idempotencyKey !== "string") {
          return jsonResponse(400, { error: "invalid request" });
        }
        const boardType = typeof body.boardType === "string" ? body.boardType : "";
        const attemptRef = `attempt:${body.idempotencyKey}`;
        const existing = state.generateRequests.find((r) => r.ref === attemptRef);
        if (existing) {
          return jsonResponse(existing.response.status, existing.response.body);
        }
        const cost = state.pricing.attemptCostByBoardType[boardType] ?? 1;
        const balance = balanceOf(account.id);
        if (balance < cost) {
          const respBody = { error: "insufficient_credits", credits: balance };
          state.generateRequests.push({ ref: attemptRef, response: { status: 402, body: respBody } });
          return jsonResponse(402, respBody);
        }
        // Debit.
        state.balances.set(account.id, balance - cost);
        recordLedger({ userId: account.id, delta: -cost, reason: "spend-theme-attempt", ref: attemptRef });

        if (failNextGenerateOnce) {
          failNextGenerateOnce = false;
          // Refund.
          const refunded = balanceOf(account.id) + cost;
          state.balances.set(account.id, refunded);
          const refundRef = `refund:${body.idempotencyKey}`;
          recordLedger({ userId: account.id, delta: cost, reason: "refund-theme-attempt", ref: refundRef });
          const respBody = { error: "provider_failed", refunded: true, credits: refunded };
          state.generateRequests.push({ ref: attemptRef, response: { status: 502, body: respBody } });
          return jsonResponse(502, respBody);
        }

        const newBalance = balanceOf(account.id);
        const respBody = {
          image: "data:image/png;base64,ZmFrZQ==",
          attemptCost: cost,
          credits: newBalance,
          refunded: false,
        };
        state.generateRequests.push({ ref: attemptRef, response: { status: 200, body: respBody } });
        return jsonResponse(200, respBody);
      }

      return jsonResponse(404, { error: "not_found" });
    }

    return jsonResponse(404, { error: "not_found" });
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    state,
    helpers: {
      createAccount(email, role = "user") {
        const account = getOrCreateAccountByEmail(email);
        if (role !== "user") account.role = role;
        return account;
      },
      grant(accountId, credits, ref) {
        const account = state.accounts.get(accountId);
        if (!account) return undefined;
        const grantRef = ref ?? nextId("stripe-ref");
        if (ledgerRefExists(grantRef)) return undefined; // replay-safe
        state.balances.set(accountId, balanceOf(accountId) + credits);
        const row: LedgerRow = { userId: accountId, delta: credits, reason: "grant", ref: grantRef };
        recordLedger(row);
        return row;
      },
      failNextGenerate() {
        failNextGenerateOnce = true;
      },
      setUnavailable(value) {
        unavailable = value;
      },
      async completeGoogleInBrowser() {
        if (!lastGoogleAuthCode) throw new Error("no pending Google sign-in — call startGoogleSignIn first");
        const code = lastGoogleAuthCode;
        lastGoogleAuthCode = null;
        lastGoogleRedirectTo = null;
        return code;
      },
      completeCheckout(sessionId) {
        const session = state.checkoutSessions.get(sessionId);
        if (!session || session.completed) return undefined;
        const pack = state.pricing.packs.find((p) => p.id === session.pack);
        if (!pack) return undefined;
        const eventId = nextId("evt");
        const ref = `stripe:${eventId}:${pack.id}`;
        if (ledgerRefExists(ref)) return undefined; // replay-safe
        session.completed = true;
        state.balances.set(session.accountId, balanceOf(session.accountId) + pack.credits);
        const row: LedgerRow = { userId: session.accountId, delta: pack.credits, reason: "grant", ref };
        recordLedger(row);
        return row;
      },
      setOtpCode(email, code) {
        state.pendingOtps.set(email, code);
        getOrCreateAccountByEmail(email);
      },
      expireAccessToken() {
        for (const token of state.accessTokens.keys()) {
          state.revokedAccessTokens.add(token);
        }
      },
    },
  };
}
