/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * Pure client for the Corsair Theme Service — see docs/theme-service-api.md
 * for the full contract. No `vscode` import, no Node-only modules: usable
 * from the extension, the standalone app, and the webview build alike. All
 * host-specific glue (SecretStorage, app-data secrets/, browser open, deep
 * links) is the caller's job via {@link ThemeServiceClientOptions}.
 */

// Canonical production endpoint (docs/theme-service-api.md, Conventions),
// same pattern as FEEDBACK_ENDPOINT in src/host/vscode/feedbackSubmit.ts:36.
// Baked into every shipped release; repointable server-side without a
// client update, never a throwaway subdomain. Do not change this to a
// test/staging URL in a commit that ships.
export const THEME_SERVICE_ENDPOINT = "https://theme.corsairstudios.com";

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
  balance?: number;
}

export type ThemeServiceResult<T> = { ok: true; value: T } | { ok: false; error: ThemeServiceError };

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
  /** Injectable clock; unused today but kept for future retry/backoff logic. */
  now?: () => number;
}

export type ThemeServiceAccountProvider = "email" | "google";

export interface ThemeServiceAccount {
  id: string;
  email: string;
  provider: ThemeServiceAccountProvider;
}

export interface ThemeServiceBalance {
  credits: number;
}

export interface ThemeServiceAuthResult {
  deviceToken: string;
  account: ThemeServiceAccount;
}

export interface ThemeServiceStatus {
  signedIn: boolean;
  account?: ThemeServiceAccount;
  balance?: ThemeServiceBalance;
}

export interface GoogleSignInStart {
  sessionId: string;
  browserUrl: string;
}

export type GoogleSignInComplete = { sessionId: string } | { code: string };

export interface ThemeServicePack {
  sku: string;
  credits: number;
  priceCents: number;
  currency: string;
}

export interface ThemeServicePricing {
  attemptCostByBoardType: Record<string, number>;
  typicalTheme: { min: number; max: number };
  packs: ThemeServicePack[];
}

export interface CheckoutSession {
  url: string;
  sessionId: string;
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
  balance: number;
  refunded: boolean;
}

export interface ThemeServiceClient {
  requestMagicLink(email: string): Promise<ThemeServiceResult<void>>;
  verifyMagicLink(email: string, code: string): Promise<ThemeServiceResult<ThemeServiceAuthResult>>;
  startGoogleSignIn(): Promise<ThemeServiceResult<GoogleSignInStart>>;
  completeGoogleSignIn(input: GoogleSignInComplete): Promise<ThemeServiceResult<ThemeServiceAuthResult>>;
  signOut(): Promise<ThemeServiceResult<void>>;
  getStatus(): Promise<ThemeServiceResult<ThemeServiceStatus>>;
  getPricing(): Promise<ThemeServiceResult<ThemeServicePricing>>;
  createCheckoutSession(sku: string): Promise<ThemeServiceResult<CheckoutSession>>;
  generateAttempt(req: GenerateAttemptRequest): Promise<ThemeServiceResult<GenerateAttemptResponse>>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isAccount(v: unknown): v is ThemeServiceAccount {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.email === "string" &&
    (v.provider === "email" || v.provider === "google")
  );
}

function invalidResponse(message: string): ThemeServiceError {
  return { kind: "invalid_response", message };
}

/**
 * Build the client. Every method returns a discriminated-union result and
 * NEVER throws: fetch rejections become `unreachable`, malformed/missing
 * JSON fields become `invalid_response`, and HTTP status codes map per
 * docs/theme-service-api.md § Error Codes. The device token is read from
 * `opts.tokenStore` on every authenticated call and is never logged or
 * placed anywhere but the `Authorization` header.
 */
export function createThemeServiceClient(opts: ThemeServiceClientOptions): ThemeServiceClient {
  const fetchImpl = opts.fetch ?? fetch;
  const endpoint = opts.endpoint ?? THEME_SERVICE_ENDPOINT;
  const tokenStore = opts.tokenStore;

  async function request(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; auth?: boolean }
  ): Promise<ThemeServiceResult<unknown>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Theme-Service-Version": "1",
    };
    if (init.auth) {
      let token: string | null = null;
      try {
        token = await tokenStore.get();
      } catch {
        token = null;
      }
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    let res: Response;
    try {
      res = await fetchImpl(`${endpoint}${path}`, {
        method: init.method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (err) {
      return {
        ok: false,
        error: { kind: "unreachable", message: err instanceof Error ? err.message : String(err) },
      };
    }

    if (res.status === 204) {
      return { ok: true, value: undefined };
    }

    let json: unknown = undefined;
    const hasBody = res.status !== 202;
    if (hasBody) {
      try {
        const text = await res.text();
        json = text.length > 0 ? JSON.parse(text) : undefined;
      } catch (err) {
        return {
          ok: false,
          error: invalidResponse(`failed to parse response JSON: ${err instanceof Error ? err.message : String(err)}`),
        };
      }
    }

    if (res.ok) {
      return { ok: true, value: json };
    }

    const errBody = isRecord(json) ? json : {};
    const errorField = typeof errBody.error === "string" ? errBody.error : undefined;
    const balance = typeof errBody.balance === "number" ? errBody.balance : undefined;
    const refunded = typeof errBody.refunded === "boolean" ? errBody.refunded : undefined;

    switch (res.status) {
      case 401: {
        try {
          await tokenStore.clear();
        } catch {
          /* best-effort */
        }
        return { ok: false, error: { kind: "not_signed_in", status: 401, message: errorField ?? "not signed in" } };
      }
      case 402:
        return {
          ok: false,
          error: { kind: "insufficient_credits", status: 402, message: errorField ?? "insufficient credits", balance },
        };
      case 429:
        return { ok: false, error: { kind: "rate_limited", status: 429, message: errorField ?? "rate limited" } };
      case 502:
        return {
          ok: false,
          error: { kind: "provider_failed", status: 502, message: errorField ?? "provider failed", refunded, balance },
        };
      case 503:
        return { ok: false, error: { kind: "unavailable", status: 503, message: errorField ?? "service unavailable" } };
      default:
        return {
          ok: false,
          error: { kind: "server_error", status: res.status, message: errorField ?? `unexpected status ${res.status}` },
        };
    }
  }

  function parseAuthResult(json: unknown): ThemeServiceResult<ThemeServiceAuthResult> {
    if (!isRecord(json) || typeof json.deviceToken !== "string" || !isAccount(json.account)) {
      return { ok: false, error: invalidResponse("malformed auth response") };
    }
    return { ok: true, value: { deviceToken: json.deviceToken, account: json.account } };
  }

  return {
    async requestMagicLink(email) {
      const res = await request("/auth/magic-link", { method: "POST", body: { email } });
      if (!res.ok) return res;
      return { ok: true, value: undefined };
    },

    async verifyMagicLink(email, code) {
      const res = await request("/auth/verify", { method: "POST", body: { email, code } });
      if (!res.ok) return res;
      const parsed = parseAuthResult(res.value);
      if (parsed.ok) {
        try {
          await tokenStore.set(parsed.value.deviceToken);
        } catch (err) {
          return {
            ok: false,
            error: invalidResponse(`failed to store device token: ${err instanceof Error ? err.message : String(err)}`),
          };
        }
      }
      return parsed;
    },

    async startGoogleSignIn() {
      const res = await request("/auth/google/start", { method: "POST", body: {} });
      if (!res.ok) return res;
      const json = res.value;
      if (!isRecord(json) || typeof json.sessionId !== "string" || typeof json.browserUrl !== "string") {
        return { ok: false, error: invalidResponse("malformed google sign-in start response") };
      }
      return { ok: true, value: { sessionId: json.sessionId, browserUrl: json.browserUrl } };
    },

    async completeGoogleSignIn(input) {
      const res = await request("/auth/google/complete", { method: "POST", body: input });
      if (!res.ok) return res;
      const parsed = parseAuthResult(res.value);
      if (parsed.ok) {
        try {
          await tokenStore.set(parsed.value.deviceToken);
        } catch (err) {
          return {
            ok: false,
            error: invalidResponse(`failed to store device token: ${err instanceof Error ? err.message : String(err)}`),
          };
        }
      }
      return parsed;
    },

    async signOut() {
      const res = await request("/auth/sign-out", { method: "POST", body: {}, auth: true });
      try {
        await tokenStore.clear();
      } catch {
        /* best-effort */
      }
      if (!res.ok) return res;
      return { ok: true, value: undefined };
    },

    async getStatus() {
      let token: string | null = null;
      try {
        token = await tokenStore.get();
      } catch {
        token = null;
      }
      if (!token) {
        return { ok: true, value: { signedIn: false } };
      }
      const res = await request("/me", { method: "GET", auth: true });
      if (!res.ok) {
        if (res.error.kind === "not_signed_in") {
          return { ok: true, value: { signedIn: false } };
        }
        return res;
      }
      const json = res.value;
      if (
        !isRecord(json) ||
        !isAccount(json.account) ||
        !isRecord(json.balance) ||
        typeof json.balance.credits !== "number"
      ) {
        return { ok: false, error: invalidResponse("malformed /me response") };
      }
      return {
        ok: true,
        value: { signedIn: true, account: json.account, balance: { credits: json.balance.credits } },
      };
    },

    async getPricing() {
      const res = await request("/pricing", { method: "GET" });
      if (!res.ok) return res;
      const json = res.value;
      if (
        !isRecord(json) ||
        !isRecord(json.attemptCostByBoardType) ||
        !isRecord(json.typicalTheme) ||
        typeof json.typicalTheme.min !== "number" ||
        typeof json.typicalTheme.max !== "number" ||
        !Array.isArray(json.packs)
      ) {
        return { ok: false, error: invalidResponse("malformed /pricing response") };
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
          typeof p.sku !== "string" ||
          typeof p.credits !== "number" ||
          typeof p.priceCents !== "number" ||
          typeof p.currency !== "string"
        ) {
          return { ok: false, error: invalidResponse("malformed pack entry") };
        }
        packs.push({ sku: p.sku, credits: p.credits, priceCents: p.priceCents, currency: p.currency });
      }
      return {
        ok: true,
        value: {
          attemptCostByBoardType,
          typicalTheme: { min: json.typicalTheme.min, max: json.typicalTheme.max },
          packs,
        },
      };
    },

    async createCheckoutSession(sku) {
      const res = await request("/checkout/session", { method: "POST", body: { sku }, auth: true });
      if (!res.ok) return res;
      const json = res.value;
      if (!isRecord(json) || typeof json.url !== "string" || typeof json.sessionId !== "string") {
        return { ok: false, error: invalidResponse("malformed checkout session response") };
      }
      return { ok: true, value: { url: json.url, sessionId: json.sessionId } };
    },

    async generateAttempt(req) {
      const res = await request("/generate", { method: "POST", body: req, auth: true });
      if (!res.ok) return res;
      const json = res.value;
      if (
        !isRecord(json) ||
        typeof json.image !== "string" ||
        typeof json.attemptCost !== "number" ||
        typeof json.balance !== "number" ||
        typeof json.refunded !== "boolean"
      ) {
        return { ok: false, error: invalidResponse("malformed /generate response") };
      }
      return {
        ok: true,
        value: { image: json.image, attemptCost: json.attemptCost, balance: json.balance, refunded: json.refunded },
      };
    },
  };
}
