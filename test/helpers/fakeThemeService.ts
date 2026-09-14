/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// In-memory fake implementing the Corsair Theme Service client contract
// (docs/theme-service-api.md), exposed as an injectable fetch-shaped
// function so `createThemeServiceClient({ fetch, tokenStore, endpoint })`
// (src/core/themeServiceClient.ts, developed concurrently) can be pointed
// at it in tests without any network or timers. Deterministic: no
// randomness unless seeded via `now`, no setTimeout/setInterval.

export interface PricingPack {
  sku: string;
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
  provider: "email" | "google";
}

export type LedgerKind = "grant" | "spend" | "refund";

export interface LedgerRow {
  id: string;
  accountId: string;
  kind: LedgerKind;
  credits: number;
  attemptId?: string;
  sku?: string;
}

interface GenerateRecord {
  idempotencyKey: string;
  accountId: string;
  response: { status: number; body: unknown };
}

interface PendingGoogleSession {
  sessionId: string;
  code: string;
  accountId: string;
  completed: boolean;
}

interface CheckoutSession {
  sessionId: string;
  accountId: string;
  sku: string;
  completed: boolean;
}

export interface FakeThemeServiceState {
  accounts: Map<string, Account>;
  accountsByEmail: Map<string, string>;
  deviceTokens: Map<string, string>; // token -> accountId
  pendingMagicLinks: Map<string, { code: string; accountId: string }>; // email -> code/account
  pendingGoogleSessions: Map<string, PendingGoogleSession>;
  balances: Map<string, number>;
  ledger: LedgerRow[];
  checkoutSessions: Map<string, CheckoutSession>;
  generateRequests: GenerateRecord[];
  pricing: Pricing;
}

export interface FakeThemeServiceOptions {
  endpoint?: string;
  pricing?: Partial<Pricing>;
  now?: () => number;
}

const DEFAULT_PRICING: Pricing = {
  attemptCostByBoardType: {
    character: 1,
    rival: 1,
    environment: 1,
    objects_01: 1,
    objects_02: 1,
    expressions: 1,
    achievements: 1,
    emotes: 1,
    background: 1,
  },
  typicalTheme: { min: 14, max: 40 },
  packs: [
    { sku: "pack_s", credits: 20, priceCents: 500, currency: "usd" },
    { sku: "pack_m", credits: 50, priceCents: 1000, currency: "usd" },
    { sku: "pack_l", credits: 120, priceCents: 2000, currency: "usd" },
    { sku: "pack_xl", credits: 260, priceCents: 4000, currency: "usd" },
    { sku: "pack_xxl", credits: 600, priceCents: 8000, currency: "usd" },
  ],
};

const DEFAULT_MAGIC_LINK_CODE = "123456";

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

function accountView(account: Account): Account {
  return { id: account.id, email: account.email, provider: account.provider };
}

/**
 * Creates an in-memory fake of the Corsair Theme Service implementing every
 * endpoint in docs/theme-service-api.md. Returns a `fetch`-shaped function
 * for injection into `createThemeServiceClient`, plus introspectable
 * `state` and test `helpers`.
 */
export function createFakeThemeService(options: FakeThemeServiceOptions = {}): {
  fetch: typeof fetch;
  state: FakeThemeServiceState;
  helpers: {
    grant(accountId: string, credits: number): LedgerRow;
    failNextGenerate(): void;
    setUnavailable(unavailable: boolean): void;
    completeGoogleInBrowser(sessionId: string): void;
    completeCheckout(sessionId: string): LedgerRow | undefined;
    setMagicLinkCode(email: string, code: string): void;
    createAccount(email: string, provider?: "email" | "google"): Account;
  };
} {
  const endpoint = options.endpoint ?? "https://theme-service.example";
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
    deviceTokens: new Map(),
    pendingMagicLinks: new Map(),
    pendingGoogleSessions: new Map(),
    balances: new Map(),
    ledger: [],
    checkoutSessions: new Map(),
    generateRequests: [],
    pricing,
  };

  let unavailable = false;
  let failNextGenerateOnce = false;

  function getOrCreateAccountByEmail(email: string, provider: "email" | "google"): Account {
    const existingId = state.accountsByEmail.get(email);
    if (existingId) {
      const existing = state.accounts.get(existingId)!;
      return existing;
    }
    const account: Account = { id: nextId("acct"), email, provider };
    state.accounts.set(account.id, account);
    state.accountsByEmail.set(email, account.id);
    state.balances.set(account.id, 0);
    return account;
  }

  function issueDeviceToken(accountId: string): string {
    const token = nextId("tok");
    state.deviceTokens.set(token, accountId);
    return token;
  }

  function recordLedger(row: Omit<LedgerRow, "id">): LedgerRow {
    const full: LedgerRow = { id: nextId("ledger"), ...row };
    state.ledger.push(full);
    return full;
  }

  function balanceOf(accountId: string): number {
    return state.balances.get(accountId) ?? 0;
  }

  function applyLedger(row: Omit<LedgerRow, "id">): LedgerRow {
    const current = balanceOf(row.accountId);
    const delta = row.kind === "spend" ? -row.credits : row.credits;
    state.balances.set(row.accountId, current + delta);
    return recordLedger(row);
  }

  function authenticate(req: Request): Account | undefined {
    const header = req.headers.get("Authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return undefined;
    const accountId = state.deviceTokens.get(match[1]);
    if (!accountId) return undefined;
    return state.accounts.get(accountId);
  }

  async function readJson(req: Request): Promise<any> {
    try {
      const text = await req.text();
      if (!text) return {};
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  const helpers = {
    grant(accountId: string, credits: number): LedgerRow {
      return applyLedger({ accountId, kind: "grant", credits });
    },
    failNextGenerate(): void {
      failNextGenerateOnce = true;
    },
    setUnavailable(value: boolean): void {
      unavailable = value;
    },
    completeGoogleInBrowser(sessionId: string): void {
      const session = state.pendingGoogleSessions.get(sessionId);
      if (session) session.completed = true;
    },
    completeCheckout(sessionId: string): LedgerRow | undefined {
      const session = state.checkoutSessions.get(sessionId);
      if (!session || session.completed) return undefined;
      session.completed = true;
      const pack = state.pricing.packs.find((p) => p.sku === session.sku);
      if (!pack) return undefined;
      return applyLedger({ accountId: session.accountId, kind: "grant", credits: pack.credits, sku: pack.sku });
    },
    setMagicLinkCode(email: string, code: string): void {
      const existing = state.pendingMagicLinks.get(email);
      const accountId = existing?.accountId ?? getOrCreateAccountByEmail(email, "email").id;
      state.pendingMagicLinks.set(email, { code, accountId });
    },
    createAccount(email: string, provider: "email" | "google" = "email"): Account {
      return getOrCreateAccountByEmail(email, provider);
    },
  };

  async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const req = input instanceof Request ? input : new Request(url, init);
    const path = url.startsWith(endpoint) ? url.slice(endpoint.length) : new URL(url).pathname;

    if (unavailable) {
      return jsonResponse(503, { error: "unavailable" });
    }

    const method = (req.method || "GET").toUpperCase();

    // --- Auth ---
    if (path === "/auth/magic-link" && method === "POST") {
      const body = await readJson(req);
      const email = body.email as string;
      const account = getOrCreateAccountByEmail(email, "email");
      const existing = state.pendingMagicLinks.get(email);
      const code = existing?.code ?? DEFAULT_MAGIC_LINK_CODE;
      state.pendingMagicLinks.set(email, { code, accountId: account.id });
      return emptyResponse(202);
    }

    if (path === "/auth/verify" && method === "POST") {
      const body = await readJson(req);
      const email = body.email as string;
      const code = body.code as string;
      const pending = state.pendingMagicLinks.get(email);
      if (!pending || pending.code !== code) {
        return jsonResponse(401, { error: "not_signed_in" });
      }
      state.pendingMagicLinks.delete(email);
      const account = state.accounts.get(pending.accountId)!;
      const deviceToken = issueDeviceToken(account.id);
      return jsonResponse(200, { deviceToken, account: accountView(account) });
    }

    if (path === "/auth/google/start" && method === "POST") {
      const sessionId = nextId("sess");
      const account = getOrCreateAccountByEmail(`${sessionId}@google.example`, "google");
      const code = nextId("gcode").toUpperCase();
      state.pendingGoogleSessions.set(sessionId, { sessionId, code, accountId: account.id, completed: false });
      return jsonResponse(200, {
        sessionId,
        browserUrl: `${endpoint}/oauth/google?session=${sessionId}`,
      });
    }

    if (path === "/auth/google/complete" && method === "POST") {
      const body = await readJson(req);
      let session: PendingGoogleSession | undefined;
      if (body.sessionId) {
        session = state.pendingGoogleSessions.get(body.sessionId);
      } else if (body.code) {
        session = [...state.pendingGoogleSessions.values()].find((s) => s.code === body.code);
      }
      if (!session || !session.completed) {
        return jsonResponse(401, { error: "not_signed_in" });
      }
      const account = state.accounts.get(session.accountId)!;
      const deviceToken = issueDeviceToken(account.id);
      return jsonResponse(200, { deviceToken, account: accountView(account) });
    }

    if (path === "/auth/sign-out" && method === "POST") {
      const header = req.headers.get("Authorization") ?? "";
      const match = /^Bearer (.+)$/.exec(header);
      if (match) state.deviceTokens.delete(match[1]);
      return emptyResponse(204);
    }

    // --- Everything below requires auth ---
    const account = authenticate(req);
    if (!account) {
      return jsonResponse(401, { error: "not_signed_in" });
    }

    if (path === "/me" && method === "GET") {
      return jsonResponse(200, { account: accountView(account), balance: { credits: balanceOf(account.id) } });
    }

    if (path === "/me/balance" && method === "GET") {
      return jsonResponse(200, { credits: balanceOf(account.id) });
    }

    if (path === "/pricing" && method === "GET") {
      return jsonResponse(200, state.pricing);
    }

    if (path === "/checkout/session" && method === "POST") {
      const body = await readJson(req);
      const sku = body.sku as string;
      const pack = state.pricing.packs.find((p) => p.sku === sku);
      if (!pack) {
        return jsonResponse(400, { error: "invalid_sku" });
      }
      const sessionId = nextId("cs_test");
      state.checkoutSessions.set(sessionId, { sessionId, accountId: account.id, sku, completed: false });
      return jsonResponse(200, { url: `https://checkout.stripe.com/c/pay/${sessionId}`, sessionId });
    }

    if (path === "/generate" && method === "POST") {
      const body = await readJson(req);
      const idempotencyKey = body.idempotencyKey as string;
      const boardType = body.boardType as string;

      const existing = state.generateRequests.find(
        (r) => r.idempotencyKey === idempotencyKey && r.accountId === account.id,
      );
      if (existing) {
        return jsonResponse(existing.response.status, existing.response.body);
      }

      const cost = state.pricing.attemptCostByBoardType[boardType] ?? 1;

      if (failNextGenerateOnce) {
        failNextGenerateOnce = false;
        if (balanceOf(account.id) < cost) {
          const response = { status: 402, body: { error: "insufficient_credits", balance: balanceOf(account.id) } };
          state.generateRequests.push({ idempotencyKey, accountId: account.id, response });
          return jsonResponse(response.status, response.body);
        }
        const attemptId = nextId("attempt");
        applyLedger({ accountId: account.id, kind: "spend", credits: cost, attemptId });
        applyLedger({ accountId: account.id, kind: "refund", credits: cost, attemptId });
        const response = {
          status: 502,
          body: { error: "provider_failed", refunded: true, balance: balanceOf(account.id) },
        };
        state.generateRequests.push({ idempotencyKey, accountId: account.id, response });
        return jsonResponse(response.status, response.body);
      }

      if (balanceOf(account.id) < cost) {
        const response = { status: 402, body: { error: "insufficient_credits", balance: balanceOf(account.id) } };
        state.generateRequests.push({ idempotencyKey, accountId: account.id, response });
        return jsonResponse(response.status, response.body);
      }

      const attemptId = nextId("attempt");
      applyLedger({ accountId: account.id, kind: "spend", credits: cost, attemptId });
      const response = {
        status: 200,
        body: {
          image: "data:image/png;base64,ZmFrZQ==",
          attemptCost: cost,
          balance: balanceOf(account.id),
          refunded: false,
        },
      };
      state.generateRequests.push({ idempotencyKey, accountId: account.id, response });
      return jsonResponse(response.status, response.body);
    }

    return jsonResponse(404, { error: "not_found" });
  }

  return { fetch: fakeFetch as unknown as typeof fetch, state, helpers };
}
