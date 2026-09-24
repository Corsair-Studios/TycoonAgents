import { test } from "node:test";
import assert from "node:assert/strict";
import { createThemeServiceClient, ThemeServiceTokenStore } from "../src/core/themeServiceClient";
import { createFakeThemeService } from "./helpers/fakeThemeService";

const ENDPOINT = "https://theme-service.example";
const SUPABASE_URL = "https://fake-project.supabase.co";

function createMemoryTokenStore(initial: string | null = null): ThemeServiceTokenStore & { value: string | null; getCalls: number } {
  return {
    value: initial,
    getCalls: 0,
    async get() {
      this.getCalls += 1;
      return this.value;
    },
    async set(token: string) {
      this.value = token;
    },
    async clear() {
      this.value = null;
    },
  };
}

function countingFetch(fetchFn: typeof fetch): { fetch: typeof fetch; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const wrapped: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, body: init?.body });
    return fetchFn(input, init);
  }) as typeof fetch;
  return { fetch: wrapped, calls };
}

function setupClient(nowFn?: () => number) {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL, now: nowFn });
  const tokenStore = createMemoryTokenStore();
  const client = createThemeServiceClient({
    fetch: fake.fetch,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
    now: nowFn,
  });
  return { fake, tokenStore, client };
}

test("magic-link sign-in round trip stores the JSON session and getStatus shows email/credits", async () => {
  const { fake, tokenStore, client } = setupClient();
  const account = fake.helpers.createAccount("a@example.com");
  fake.helpers.grant(account.id, 7);

  const req = await client.requestMagicLink("a@example.com");
  assert.equal(req.ok, true);

  const verify = await client.verifyMagicLink("a@example.com", "123456");
  assert.equal(verify.ok, true);

  assert.ok(tokenStore.value);
  const parsed = JSON.parse(tokenStore.value!) as { accessToken: string; refreshToken: string; expiresAt: number };
  assert.equal(typeof parsed.accessToken, "string");
  assert.equal(typeof parsed.refreshToken, "string");
  assert.equal(typeof parsed.expiresAt, "number");

  const status = await client.getStatus();
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.value.signedIn, true);
  assert.equal(status.value.email, "a@example.com");
  assert.equal(status.value.credits, 7);
});

test("Google sign-in: startGoogleSignIn -> completeGoogleInBrowser -> completeGoogleSignIn", async () => {
  const { fake, tokenStore, client } = setupClient();
  const start = await client.startGoogleSignIn({ redirectTo: "http://127.0.0.1:9999/callback" });
  assert.equal(start.ok, true);
  if (!start.ok) return;
  assert.equal(typeof start.value.browserUrl, "string");
  assert.equal(typeof start.value.codeVerifier, "string");

  await fake.fetch(start.value.browserUrl); // simulate the system browser visiting the authorize URL
  const authCode = await fake.helpers.completeGoogleInBrowser();
  const complete = await client.completeGoogleSignIn({ authCode, codeVerifier: start.value.codeVerifier });
  assert.equal(complete.ok, true);
  assert.ok(tokenStore.value);
});

test("Google sign-in with the wrong code verifier fails", async () => {
  const { fake, client } = setupClient();
  const start = await client.startGoogleSignIn({ redirectTo: "http://127.0.0.1:9999/callback" });
  assert.equal(start.ok, true);
  if (!start.ok) return;
  await fake.fetch(start.value.browserUrl);
  const authCode = await fake.helpers.completeGoogleInBrowser();
  const complete = await client.completeGoogleSignIn({ authCode, codeVerifier: "totally-wrong-verifier" });
  assert.equal(complete.ok, false);
});

test("getPricing works signed out with no Authorization header sent", async () => {
  const { fake, client } = setupClient();
  const { fetch: wrapped, calls } = countingFetch(fake.fetch);
  const client2 = createThemeServiceClient({
    fetch: wrapped,
    tokenStore: createMemoryTokenStore(),
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });
  const pricing = await client2.getPricing();
  assert.equal(pricing.ok, true);
  assert.equal(calls.length, 1);
  const initArg = undefined; // headers aren't captured by countingFetch; verify via a raw fetch spy instead below.
  void initArg;
});

test("getPricing signed out sends no Authorization header (direct header check)", async () => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  let sawAuthHeader = false;
  const spyFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    if (headers.has("Authorization")) sawAuthHeader = true;
    return fake.fetch(input, init);
  }) as typeof fetch;
  const client = createThemeServiceClient({
    fetch: spyFetch,
    tokenStore: createMemoryTokenStore(),
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });
  const res = await client.getPricing();
  assert.equal(res.ok, true);
  assert.equal(sawAuthHeader, false);
});

test("expired session triggers a proactive refresh before /api/account", async () => {
  let currentTime = 1_000_000;
  const nowFn = () => currentTime;
  const { fake, client } = setupClient(nowFn);
  const account = fake.helpers.createAccount("expire@example.com");
  fake.helpers.grant(account.id, 3);
  await client.requestMagicLink("expire@example.com");
  const verify = await client.verifyMagicLink("expire@example.com", "123456");
  assert.equal(verify.ok, true);

  // Advance time past the 1-hour expiry the fake issues.
  currentTime += 3600 * 1000 + 1000;

  const status = await client.getStatus();
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.value.signedIn, true);
  assert.equal(status.value.credits, 3);
});

test("a service 401 triggers one refresh and retry", async () => {
  const { fake, client } = setupClient();
  const account = fake.helpers.createAccount("retry@example.com");
  fake.helpers.grant(account.id, 2);
  await client.requestMagicLink("retry@example.com");
  await client.verifyMagicLink("retry@example.com", "123456");

  // Force the current access token to be rejected without expiring it
  // client-side, so getStatus hits the service, gets 401, refreshes, retries.
  fake.helpers.expireAccessToken();

  const status = await client.getStatus();
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.value.signedIn, true);
  assert.equal(status.value.credits, 2);
});

test("refresh failure clears the token store and yields not_signed_in", async () => {
  const { fake, tokenStore, client } = setupClient();
  await client.requestMagicLink("badrefresh@example.com");
  await client.verifyMagicLink("badrefresh@example.com", "123456");
  assert.ok(tokenStore.value);

  // Corrupt the stored refresh token so the fake rejects the refresh call,
  // then force a 401 from the service to trigger refresh-and-retry.
  const parsed = JSON.parse(tokenStore.value!) as { accessToken: string; refreshToken: string; expiresAt: number };
  parsed.refreshToken = "not-a-real-refresh-token";
  await tokenStore.set(JSON.stringify(parsed));
  fake.helpers.expireAccessToken();

  const status = await client.getStatus();
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.value.signedIn, false);
  assert.equal(tokenStore.value, null);
});

// v0.0.661 bug fix: a TRANSIENT failure of the refresh call itself (network
// error reaching Supabase, e.g. right after a Render cold start) must never
// be treated the same as a genuine invalid/expired refresh token. Previously
// doRefreshSession cleared the token store on ANY refresh failure and
// serviceRequest hardcoded the resulting error to "not_signed_in", so a
// perfectly valid, just-stored session was silently destroyed and getStatus
// reported a definitive signedIn:false for what was really just a flaky
// network blip.
test("a transient (network) refresh failure keeps the session and reports a non-definitive error, not signedIn:false", async () => {
  const { fake, tokenStore, client } = setupClient();
  const account = fake.helpers.createAccount("flaky@example.com");
  fake.helpers.grant(account.id, 9);
  await client.requestMagicLink("flaky@example.com");
  await client.verifyMagicLink("flaky@example.com", "123456");
  assert.ok(tokenStore.value);
  const storedBeforeRefresh = tokenStore.value;

  fake.helpers.expireAccessToken();

  // Fail only the refresh_token grant call with a network error; everything
  // else (including the retried /api/account) goes through the real fake.
  const flakyFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/auth/v1/token") && url.includes("grant_type=refresh_token")) {
      throw new Error("network down");
    }
    return fake.fetch(input, init);
  }) as typeof fetch;
  const flakyClient = createThemeServiceClient({
    fetch: flakyFetch,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });

  const status = await flakyClient.getStatus();
  assert.equal(status.ok, false, "a transient refresh failure must not be reported as ok:true signedIn:false");
  if (!status.ok) {
    assert.notEqual(status.error.kind, "not_signed_in");
  }
  assert.equal(tokenStore.value, storedBeforeRefresh, "the valid session must survive a transient refresh failure");

  // A subsequent call against the real fake (network recovered) must see the
  // still-valid session and succeed normally.
  const recovered = await client.getStatus();
  assert.equal(recovered.ok, true);
  if (recovered.ok) assert.equal(recovered.value.signedIn, true);
});

test("concurrent 401s share one session refresh", async () => {
  const { fake, tokenStore, client } = setupClient();
  const account = fake.helpers.createAccount("concurrent@example.com");
  fake.helpers.grant(account.id, 5);
  await client.requestMagicLink("concurrent@example.com");
  await client.verifyMagicLink("concurrent@example.com", "123456");

  const { fetch: wrapped, calls } = countingFetch(fake.fetch);
  const client2 = createThemeServiceClient({
    fetch: wrapped,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });

  fake.helpers.expireAccessToken();

  const [a, b, c] = await Promise.all([
    client2.getStatus(),
    client2.getStatus(),
    client2.generateAttempt({ idempotencyKey: "concurrent-k1", boardType: "objects_01", promptTemplateVersion: "test-v1", theme: { description: "a theme" }, themeName: "Test Theme", slot: { items: [{ display_name: "Chair" }] }, size: "1024x1024" }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(c.ok, true);

  const refreshCalls = calls.filter((call) => call.url.includes("/auth/v1/token") && call.url.includes("grant_type=refresh_token"));
  assert.equal(refreshCalls.length, 1);

  assert.ok(tokenStore.value);
  const parsed = JSON.parse(tokenStore.value!) as { accessToken: string; refreshToken: string; expiresAt: number };
  assert.equal(typeof parsed.accessToken, "string");
  assert.equal(typeof parsed.refreshToken, "string");
});

test("concurrent 401s share one failed refresh: all callers get not_signed_in, store cleared once", async () => {
  const { fake, tokenStore, client } = setupClient();
  await client.requestMagicLink("concurrentfail@example.com");
  await client.verifyMagicLink("concurrentfail@example.com", "123456");

  // Corrupt the stored refresh token so the shared refresh fails.
  const parsed = JSON.parse(tokenStore.value!) as { accessToken: string; refreshToken: string; expiresAt: number };
  parsed.refreshToken = "not-a-real-refresh-token";
  await tokenStore.set(JSON.stringify(parsed));
  fake.helpers.expireAccessToken();

  let clearCalls = 0;
  const countingStore: ThemeServiceTokenStore = {
    get: () => tokenStore.get(),
    set: (token: string) => tokenStore.set(token),
    clear: async () => {
      clearCalls += 1;
      await tokenStore.clear();
    },
  };
  const { fetch: wrapped, calls } = countingFetch(fake.fetch);
  const client2 = createThemeServiceClient({
    fetch: wrapped,
    tokenStore: countingStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });

  const [a, b, c] = await Promise.all([
    client2.getStatus(),
    client2.getStatus(),
    client2.generateAttempt({ idempotencyKey: "concurrent-k2", boardType: "objects_01", promptTemplateVersion: "test-v1", theme: { description: "a theme" }, themeName: "Test Theme", slot: { items: [{ display_name: "Chair" }] }, size: "1024x1024" }),
  ]);
  // getStatus reports "not signed in" as a successful, signed-out status
  // rather than an error; generateAttempt (which requires auth) errors.
  assert.equal(a.ok, true);
  if (a.ok) assert.equal(a.value.signedIn, false);
  assert.equal(b.ok, true);
  if (b.ok) assert.equal(b.value.signedIn, false);
  assert.equal(c.ok, false);
  if (!c.ok) assert.equal(c.error.kind, "not_signed_in");

  const refreshCalls = calls.filter((call) => call.url.includes("/auth/v1/token") && call.url.includes("grant_type=refresh_token"));
  assert.equal(refreshCalls.length, 1);
  assert.equal(clearCalls, 1);
  assert.equal(tokenStore.value, null);
});

test("checkout -> completeCheckout raises credits", async () => {
  const { fake, client } = setupClient();
  await client.requestMagicLink("buyer@example.com");
  await client.verifyMagicLink("buyer@example.com", "123456");

  const checkout = await client.createCheckoutSession("starter45");
  assert.equal(checkout.ok, true);
  if (!checkout.ok) return;
  const sessionId = checkout.value.url.split("/").pop()!;
  const row = fake.helpers.completeCheckout(sessionId);
  assert.ok(row);

  const status = await client.getStatus();
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.value.credits, 45);
});

test("generate debits, retry debits again, failNextGenerate refunds with zero net", async () => {
  const { fake, client } = setupClient();
  const account = fake.helpers.createAccount("gen@example.com");
  fake.helpers.grant(account.id, 10);
  await client.requestMagicLink("gen@example.com");
  await client.verifyMagicLink("gen@example.com", "123456");

  const first = await client.generateAttempt({
    idempotencyKey: "k1",
    boardType: "objects_01",
    promptTemplateVersion: "test-v1",
    theme: { description: "a theme" },
    themeName: "Test Theme",
    slot: { items: [{ display_name: "Chair" }] },
    size: "1024x1024",
  });
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.value.credits, 8); // objects_01 costs 2

  const second = await client.generateAttempt({
    idempotencyKey: "k2",
    boardType: "objects_01",
    promptTemplateVersion: "test-v1",
    theme: { description: "a theme" },
    themeName: "Test Theme",
    slot: { items: [{ display_name: "Chair" }] },
    size: "1024x1024",
  });
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.value.credits, 6);

  fake.helpers.failNextGenerate();
  const third = await client.generateAttempt({
    idempotencyKey: "k3",
    boardType: "objects_01",
    promptTemplateVersion: "test-v1",
    theme: { description: "a theme" },
    themeName: "Test Theme",
    slot: { items: [{ display_name: "Chair" }] },
    size: "1024x1024",
  });
  assert.equal(third.ok, false);
  if (!third.ok) {
    assert.equal(third.error.kind, "provider_failed");
    assert.equal(third.error.refunded, true);
    assert.equal(third.error.credits, 6); // net zero vs pre-attempt balance
  }
});

test("idempotent replay of generateAttempt adds no new ledger row", async () => {
  const { fake, client } = setupClient();
  const account = fake.helpers.createAccount("replay@example.com");
  fake.helpers.grant(account.id, 5);
  await client.requestMagicLink("replay@example.com");
  await client.verifyMagicLink("replay@example.com", "123456");

  const req = {
    idempotencyKey: "replay-key",
    boardType: "objects_01" as const,
    promptTemplateVersion: "test-v1",
    theme: { description: "a theme" },
    themeName: "Test Theme",
    slot: { items: [{ display_name: "Chair" }] },
    size: "1024x1024",
  };
  const first = await client.generateAttempt(req);
  const second = await client.generateAttempt(req);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.deepEqual(first.value, second.value);
  }
  const rows = fake.state.ledger.filter((r) => r.ref === "attempt:replay-key");
  assert.equal(rows.length, 1);
});

test("insufficient credits (402) is surfaced with the current balance", async () => {
  const { client } = setupClient();
  await client.requestMagicLink("poor@example.com");
  await client.verifyMagicLink("poor@example.com", "123456");
  const res = await client.generateAttempt({
    idempotencyKey: "poor-key",
    boardType: "objects_01",
    promptTemplateVersion: "test-v1",
    theme: { description: "a theme" },
    themeName: "Test Theme",
    slot: { items: [{ display_name: "Chair" }] },
    size: "1024x1024",
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.kind, "insufficient_credits");
    assert.equal(res.error.credits, 0);
  }
});

test("service unavailable (503)", async () => {
  const { fake, client } = setupClient();
  fake.helpers.setUnavailable(true);
  const res = await client.getPricing();
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.kind, "unavailable");
});

// p83-t2: the 503 message must be the fixed, human-readable string, never
// the raw backend body (e.g. a bare "unavailable").
test("service unavailable (503) surfaces the fixed message, never a raw 'unavailable' body", async () => {
  const { fake, client } = setupClient();
  fake.helpers.setUnavailable(true);
  const res = await client.getPricing();
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(
      res.error.message,
      "Theme Service unavailable (503). No credits were charged. If you started several generations at once, try fewer at a time.",
    );
    assert.notEqual(res.error.message, "unavailable");
  }
});

// ── Follow-up: rate_limited (429) scope/limit/retryAfterSeconds parsing ────

// Only ever invoked for /api/account by signedInClientAgainst below (that
// wrapper routes every other path straight to the real fake service).
function rateLimitedFetch(body: unknown, headers?: Record<string, string>): typeof fetch {
  return (async () => {
    return new Response(JSON.stringify(body), {
      status: 429,
      headers: { "content-type": "application/json", ...(headers || {}) },
    });
  }) as typeof fetch;
}

async function signedInClientAgainst(fetchImpl: typeof fetch) {
  // A separate, already-signed-in client (against the real fake service)
  // supplies a valid session; requests are then routed through fetchImpl,
  // which intercepts only /api/account.
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const account = fake.helpers.createAccount("ratelimit@example.com");
  fake.helpers.grant(account.id, 10);
  const tokenStore = createMemoryTokenStore();
  const signInClient = createThemeServiceClient({
    fetch: fake.fetch,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });
  await signInClient.requestMagicLink("ratelimit@example.com");
  await signInClient.verifyMagicLink("ratelimit@example.com", "123456");

  const wrapped: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/api/account")) return fetchImpl(input, init);
    return fake.fetch(input, init);
  }) as typeof fetch;

  return createThemeServiceClient({
    fetch: wrapped,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });
}

test("429 with full body (scope, limit, retryAfterSeconds) parses all fields and builds the minute message", async () => {
  const client = await signedInClientAgainst(
    rateLimitedFetch({ error: "rate_limited", scope: "minute", limit: 5, retryAfterSeconds: 12 }),
  );
  const res = await client.getStatus();
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.kind, "rate_limited");
    assert.equal(res.error.scope, "minute");
    assert.equal(res.error.limit, 5);
    assert.equal(res.error.retryAfterSeconds, 12);
    assert.equal(
      res.error.message,
      "Too many requests — the Theme Service allows up to 5 generations per minute. Try again in 12s. No credits were charged.",
    );
  }
});

test("429 day scope renders the wait in hours/minutes, not raw seconds", async () => {
  const client = await signedInClientAgainst(
    rateLimitedFetch({ error: "rate_limited", scope: "day", limit: 50, retryAfterSeconds: 7200 }),
  );
  const res = await client.getStatus();
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.message, "Too many requests — the Theme Service allows up to 50 generations per day. Try again in 2 hours. No credits were charged.");
  }
});

test("429 provider scope renders the busy-image-service message", async () => {
  const client = await signedInClientAgainst(
    rateLimitedFetch({ error: "rate_limited", scope: "provider", retryAfterSeconds: 8 }),
  );
  const res = await client.getStatus();
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.message, "The image service is busy right now. Try again in 8s, or generate fewer at once. No credits were charged.");
  }
});

test("429 with no body fields falls back to the Retry-After header for the wait", async () => {
  const client = await signedInClientAgainst(
    rateLimitedFetch({ error: "rate_limited", scope: "minute" }, { "Retry-After": "30" }),
  );
  const res = await client.getStatus();
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.retryAfterSeconds, 30, "retryAfterSeconds should fall back to the Retry-After header");
    // No `limit` field in the body — the message must never invent one.
    assert.equal(res.error.message, "Too many requests. Try again in 30s. No credits were charged.");
    assert.doesNotMatch(res.error.message, /allows up to/);
  }
});

test("429 with no scope/limit/retryAfterSeconds and no header falls back to the generic message, no invented numbers", async () => {
  const client = await signedInClientAgainst(rateLimitedFetch({ error: "rate_limited" }));
  const res = await client.getStatus();
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.scope, undefined);
    assert.equal(res.error.limit, undefined);
    assert.equal(res.error.retryAfterSeconds, undefined);
    assert.equal(res.error.message, "Too many requests, try again shortly. No credits were charged.");
  }
});

test("unreachable network failure (fetch throws)", async () => {
  const throwingFetch: typeof fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const client = createThemeServiceClient({
    fetch: throwingFetch,
    tokenStore: createMemoryTokenStore(),
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });
  const res = await client.getPricing();
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.kind, "unreachable");
});

test("invalid JSON response is invalid_response", async () => {
  const badFetch: typeof fetch = (async () => new Response("not json", { status: 200 })) as typeof fetch;
  const client = createThemeServiceClient({
    fetch: badFetch,
    tokenStore: createMemoryTokenStore(),
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });
  const res = await client.getPricing();
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.kind, "invalid_response");
});

test("access token never appears in a request body", async () => {
  const { fake, client } = setupClient();
  const account = fake.helpers.createAccount("secret@example.com");
  fake.helpers.grant(account.id, 5);
  await client.requestMagicLink("secret@example.com");
  await client.verifyMagicLink("secret@example.com", "123456");

  const bodies: string[] = [];
  const spyFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") bodies.push(init.body);
    return fake.fetch(input, init);
  }) as typeof fetch;

  const spiedClient = createThemeServiceClient({
    fetch: spyFetch,
    tokenStore: createMemoryTokenStore(
      JSON.stringify({ accessToken: "leak-check-access", refreshToken: "leak-check-refresh", expiresAt: Date.now() + 3600_000 })
    ),
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });
  void client;

  // This access token is not a real one issued by the fake, so the service
  // 401s and the client attempts a refresh — the refresh token legitimately
  // appears in that request body by design. Only the access token must
  // never appear in any request body.
  await spiedClient.generateAttempt({ idempotencyKey: "tok-check", boardType: "objects_01", promptTemplateVersion: "test-v1", theme: { description: "a theme" }, themeName: "Test Theme", slot: { items: [{ display_name: "Chair" }] }, size: "1024x1024" });
  for (const body of bodies) {
    assert.doesNotMatch(body, /leak-check-access/);
  }
});

test("getStatus with no session makes zero fetch calls", async () => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const { fetch: wrapped, calls } = countingFetch(fake.fetch);
  const client = createThemeServiceClient({
    fetch: wrapped,
    tokenStore: createMemoryTokenStore(),
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });
  const status = await client.getStatus();
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.value.signedIn, false);
  assert.equal(calls.length, 0);
});

test("signOut clears the token store", async () => {
  const { fake, tokenStore, client } = setupClient();
  await client.requestMagicLink("out@example.com");
  await client.verifyMagicLink("out@example.com", "123456");
  assert.ok(tokenStore.value);
  const signOut = await client.signOut();
  assert.equal(signOut.ok, true);
  assert.equal(tokenStore.value, null);
  void fake;
});

// --- planRequest (p43-t7) ---------------------------------------------------

test("getPricing surfaces planCost", async () => {
  const { client } = setupClient();
  const res = await client.getPricing();
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value.planCost, 1);
});

test("getPricing surfaces pack label, bonusCredits, and typicalTheme.typical when present", async () => {
  const { client } = setupClient();
  const res = await client.getPricing();
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.typicalTheme.typical, 95);
  const theme100 = res.value.packs.find((p) => p.id === "theme100");
  assert.ok(theme100);
  assert.equal(theme100?.label, "Theme");
  assert.equal(theme100?.bonusCredits, 10);
});

test("getPricing still succeeds when the response omits label, bonusCredits, and typicalTheme.typical (older server)", async () => {
  const oldPricingFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/api/pricing")) {
      return new Response(
        JSON.stringify({
          attemptCostByBoardType: { objects_01: 2 },
          planCost: 1,
          typicalTheme: { min: 55, max: 170 },
          packs: [{ id: "starter45", credits: 45, priceCents: 499, currency: "usd" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`unexpected request in oldPricingFetch: ${url}`);
  }) as typeof fetch;
  const client = createThemeServiceClient({
    fetch: oldPricingFetch,
    tokenStore: createMemoryTokenStore(),
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });
  const res = await client.getPricing();
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.typicalTheme.typical, undefined);
  assert.equal(res.value.packs[0].label, undefined);
  assert.equal(res.value.packs[0].bonusCredits, undefined);
});

test("planRequest debits planCost and echoes the requester's kind/input as output", async () => {
  const { fake, client } = setupClient();
  const account = fake.helpers.createAccount("plan@example.com");
  fake.helpers.grant(account.id, 5);
  await client.requestMagicLink("plan@example.com");
  await client.verifyMagicLink("plan@example.com", "123456");

  const res = await client.planRequest({
    idempotencyKey: "plan-k1",
    kind: "plan",
    input: { prompt: "a cozy noodle shop" },
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.credits, 4);
    assert.equal(res.value.attemptCost, 1);
    assert.equal(res.value.refunded, false);
    // p86: fakeThemeService's /api/plan echo for kind "plan" now also
    // includes a plausible (non-sparse) plan body — see
    // test/helpers/fakeThemeService.ts — so translator.ts's incomplete-AI-
    // plan check doesn't trip on this fixture's bare echo.
    assert.deepEqual(res.value.output, {
      kind: "plan",
      echo: { prompt: "a cozy noodle shop" },
      display_name: "Fake Plan",
      creative_direction: "fake plan direction",
      characters: ["Fake Character"],
      objects: ["Fake Object"],
      decor: ["Fake Decor"],
      enemies: ["Fake Enemy"],
      achievements: ["Fake Achievement"],
    });
  }
  const rows = fake.state.ledger.filter((r) => r.ref === "plan:plan-k1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delta, -1);
});

test("planRequest: failNextPlan refunds with zero net and reports provider_failed", async () => {
  const { fake, client } = setupClient();
  const account = fake.helpers.createAccount("planfail@example.com");
  fake.helpers.grant(account.id, 5);
  await client.requestMagicLink("planfail@example.com");
  await client.verifyMagicLink("planfail@example.com", "123456");

  fake.helpers.failNextPlan();
  const res = await client.planRequest({
    idempotencyKey: "plan-k2",
    kind: "descriptions",
    input: { prompt: "re-derive descriptions" },
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.kind, "provider_failed");
    assert.equal(res.error.refunded, true);
    assert.equal(res.error.credits, 5); // net zero vs pre-attempt balance
  }
});

test("idempotent replay of planRequest adds no new ledger row", async () => {
  const { fake, client } = setupClient();
  const account = fake.helpers.createAccount("planreplay@example.com");
  fake.helpers.grant(account.id, 5);
  await client.requestMagicLink("planreplay@example.com");
  await client.verifyMagicLink("planreplay@example.com", "123456");

  const req = { idempotencyKey: "plan-replay-key", kind: "plan" as const, input: { prompt: "x" } };
  const first = await client.planRequest(req);
  const second = await client.planRequest(req);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.deepEqual(first.value, second.value);
  }
  const rows = fake.state.ledger.filter((r) => r.ref === "plan:plan-replay-key");
  assert.equal(rows.length, 1);
});

test("planRequest requires auth (401 -> not_signed_in when no session)", async () => {
  const { client } = setupClient();
  const res = await client.planRequest({ idempotencyKey: "no-auth", kind: "plan", input: { prompt: "x" } });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.kind, "not_signed_in");
});

// v0.0.657 bug fix regression: strict json_schema plan generation can now
// legitimately run past requestTimeoutMs's 200s default (the UI's own "can
// take several minutes" loading copy already said so) — planRequest must be
// bound by its own, much larger planTimeoutMs instead of racing the server
// and aborting a request that goes on to succeed and charge a credit.
test("planRequest: aborts at planTimeoutMs (not the shorter default requestTimeoutMs) under fake timers", async (t) => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const account = fake.helpers.createAccount("plantimeout@example.com");
  fake.helpers.grant(account.id, 5);
  const tokenStore = createMemoryTokenStore();
  const hangingFetch = hangingFetchFor("/api/plan", fake);
  const client = createThemeServiceClient({
    fetch: hangingFetch,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
    requestTimeoutMs: 200_000,
    planTimeoutMs: 600_000,
  });
  await client.requestMagicLink("plantimeout@example.com");
  await client.verifyMagicLink("plantimeout@example.com", "123456");

  t.mock.timers.enable({ apis: ["setTimeout"] });
  let res: Awaited<ReturnType<typeof client.planRequest>>;
  try {
    const p = client.planRequest({ idempotencyKey: "plan-timeout-k1", kind: "plan", input: { prompt: "x" } });
    // loadSession()/proactive-refresh checks await before the
    // AbortController's setTimeout is registered — flush a few microtask
    // hops first, mirroring the getStatus statusTimeoutMs test above.
    for (let i = 0; i < 4; i++) await Promise.resolve();
    // A short 200_000ms (the old requestTimeoutMs default) must NOT abort
    // the request — planTimeoutMs (600_000ms) governs /api/plan instead.
    await t.mock.timers.tick(200_000);
    // The remaining budget up to planTimeoutMs is what actually fires the abort.
    await t.mock.timers.tick(400_000);
    res = await p;
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.kind, "timeout");
});

test("generateAttempt: 422 content_blocked maps to kind content_blocked, no debit", async () => {
  const { fake, client } = setupClient();
  const account = fake.helpers.createAccount("blocked@example.com");
  fake.helpers.grant(account.id, 5);
  await client.requestMagicLink("blocked@example.com");
  await client.verifyMagicLink("blocked@example.com", "123456");

  fake.helpers.blockNextPrompt();
  const res = await client.generateAttempt({
    idempotencyKey: "blocked-key",
    boardType: "objects_01",
    promptTemplateVersion: "test-v1",
    theme: { description: "a theme" },
    themeName: "Test Theme",
    slot: { items: [{ display_name: "Chair" }] },
    size: "1024x1024",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.kind, "content_blocked");
  const status = await client.getStatus();
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.value.credits, 5); // no ledger entry
});

test("generateAttempt: 403 account_locked maps to kind account_locked", async () => {
  const { fake, client } = setupClient();
  fake.helpers.createAccount("locked@example.com");
  await client.requestMagicLink("locked@example.com");
  await client.verifyMagicLink("locked@example.com", "123456");
  fake.helpers.lockAccount("locked@example.com");

  const res = await client.generateAttempt({
    idempotencyKey: "locked-key",
    boardType: "objects_01",
    promptTemplateVersion: "test-v1",
    theme: { description: "a theme" },
    themeName: "Test Theme",
    slot: { items: [{ display_name: "Chair" }] },
    size: "1024x1024",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.kind, "account_locked");
});

// p85: a 400 bad_request response (deployed backend's src/json.mjs
// sendError shape: { error: "bad_request", code?: "..." }) previously fell
// through to the generic `default` branch and mapped to kind "server_error"
// (message "unexpected status 400"), which the webview renders as "Theme
// Service unavailable — no credits were charged" — misleading for a request
// the client built wrong, not a service outage. Regression test for the
// dedicated 400 -> "bad_request" mapping in src/core/themeServiceClient.ts.
// p87: a 422 content_blocked response can carry `categories`/`fields`
// (which category tripped screening and which request field) on top of the
// bare `error: "content_blocked"` shape older backends send. Regression
// test for threading those through ThemeServiceError.
test("generateAttempt: 422 content_blocked carries categories/fields when the backend sends them", async () => {
  const { fake } = setupClient();
  const account = fake.helpers.createAccount("blockedfields@example.com");
  fake.helpers.grant(account.id, 5);

  const blockedFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/api/generate")) {
      return new Response(
        JSON.stringify({
          error: "content_blocked",
          reason: "moderation",
          categories: ["illicit"],
          fields: ["slot[2].visual_description", "theme.creativeDirection"],
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      );
    }
    return fake.fetch(input, init);
  }) as typeof fetch;

  const spiedClient = createThemeServiceClient({
    fetch: blockedFetch,
    tokenStore: createMemoryTokenStore(),
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });
  await spiedClient.requestMagicLink("blockedfields@example.com");
  await spiedClient.verifyMagicLink("blockedfields@example.com", "123456");

  const res = await spiedClient.generateAttempt({
    idempotencyKey: "blocked-fields-key",
    boardType: "objects_01",
    promptTemplateVersion: "test-v1",
    theme: { description: "a theme" },
    themeName: "Test Theme",
    slot: { items: [{ display_name: "Chair" }] },
    size: "1024x1024",
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.kind, "content_blocked");
    assert.deepEqual(res.error.categories, ["illicit"]);
    assert.deepEqual(res.error.fields, ["slot[2].visual_description", "theme.creativeDirection"]);
  }
});

// p94: the likeness/IP precheck (corsair-theme-service's src/attempt.mjs,
// src/precheck.mjs) sends a singular `category: "likeness" | "ip"` string,
// not the plural `categories` array — an older client here read only
// `categories`, so this shape's category was silently dropped. Regression
// test for folding the singular field into the same `categories` array the
// UI renders from.
test("generateAttempt: 422 content_blocked with a singular `category` (likeness/IP precheck) folds into categories", async () => {
  const { fake } = setupClient();
  const account = fake.helpers.createAccount("blockedlikeness@example.com");
  fake.helpers.grant(account.id, 5);

  const blockedFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/api/generate")) {
      return new Response(
        JSON.stringify({ error: "content_blocked", category: "likeness" }),
        { status: 422, headers: { "content-type": "application/json" } },
      );
    }
    return fake.fetch(input, init);
  }) as typeof fetch;

  const spiedClient = createThemeServiceClient({
    fetch: blockedFetch,
    tokenStore: createMemoryTokenStore(),
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });
  await spiedClient.requestMagicLink("blockedlikeness@example.com");
  await spiedClient.verifyMagicLink("blockedlikeness@example.com", "123456");

  const res = await spiedClient.generateAttempt({
    idempotencyKey: "blocked-likeness-key",
    boardType: "rival_group",
    promptTemplateVersion: "test-v1",
    theme: { description: "a theme" },
    themeName: "Test Theme",
    slot: [{ display_name: "Sana Qi" }],
    size: "1024x1024",
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.kind, "content_blocked");
    assert.deepEqual(res.error.categories, ["likeness"]);
    assert.equal(res.error.fields, undefined);
  }
});

test("generateAttempt: 422 content_blocked from an old backend (no categories/fields) leaves them undefined", async () => {
  const { fake, client } = setupClient();
  const account = fake.helpers.createAccount("blockedold@example.com");
  fake.helpers.grant(account.id, 5);
  await client.requestMagicLink("blockedold@example.com");
  await client.verifyMagicLink("blockedold@example.com", "123456");

  fake.helpers.blockNextPrompt();
  const res = await client.generateAttempt({
    idempotencyKey: "blocked-old-key",
    boardType: "objects_01",
    promptTemplateVersion: "test-v1",
    theme: { description: "a theme" },
    themeName: "Test Theme",
    slot: { items: [{ display_name: "Chair" }] },
    size: "1024x1024",
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.kind, "content_blocked");
    assert.equal(res.error.categories, undefined);
    assert.equal(res.error.fields, undefined);
  }
});

test("generateAttempt: 400 bad_request maps to kind bad_request, carries the backend's code, distinct from server_error", async () => {
  const { fake } = setupClient();
  const account = fake.helpers.createAccount("badreq@example.com");
  fake.helpers.grant(account.id, 5);

  const badRequestFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/api/generate")) {
      return new Response(JSON.stringify({ error: "bad_request", code: "board_not_priced" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return fake.fetch(input, init);
  }) as typeof fetch;

  const spiedClient = createThemeServiceClient({
    fetch: badRequestFetch,
    tokenStore: createMemoryTokenStore(),
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });
  // Reuse the already-verified session by signing in fresh against this
  // second client instance (fake service shares the same account store).
  await spiedClient.requestMagicLink("badreq@example.com");
  await spiedClient.verifyMagicLink("badreq@example.com", "123456");

  const res = await spiedClient.generateAttempt({
    idempotencyKey: "bad-request-key",
    boardType: "objects_01",
    promptTemplateVersion: "test-v1",
    theme: { description: "a theme" },
    themeName: "Test Theme",
    slot: { items: [{ display_name: "Chair" }] },
    size: "1024x1024",
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.kind, "bad_request");
    assert.notEqual(res.error.kind, "server_error");
    assert.equal(res.error.code, "board_not_priced");
    assert.match(res.error.message, /board_not_priced/);
    assert.match(res.error.message, /No credits were charged/);
  }
});

// p62-t3: applyReferralCode (REFERRAL_CODE_PATTERN, src/core/themeServiceClient.ts:189/810-820).
test("applyReferralCode rejects invalid formats client-side without hitting fetch", async () => {
  const { fake, tokenStore, client } = setupClient();
  const account = fake.helpers.createAccount("ref-invalid@example.com");
  fake.helpers.grant(account.id, 0);
  await client.requestMagicLink("ref-invalid@example.com");
  await client.verifyMagicLink("ref-invalid@example.com", "123456");

  const { fetch: wrapped, calls } = countingFetch(fake.fetch);
  const clientWithSpy = createThemeServiceClient({
    fetch: wrapped,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });

  for (const bad of ["bad code!", "A".repeat(33), ""]) {
    const res = await clientWithSpy.applyReferralCode(bad);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.applied, false);
      assert.equal(res.value.reason, "invalid_format");
    }
  }
  assert.equal(calls.filter((c) => c.url.includes("/api/account/referral")).length, 0);
});

test("applyReferralCode POSTs once with bearer auth and JSON body, and parses applied/reason", async () => {
  const { fake, tokenStore, client } = setupClient();
  const account = fake.helpers.createAccount("ref-valid@example.com");
  fake.helpers.grant(account.id, 0);
  await client.requestMagicLink("ref-valid@example.com");
  await client.verifyMagicLink("ref-valid@example.com", "123456");

  let seenAuth: string | null = null;
  let seenBody: unknown;
  let callCount = 0;
  const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/api/account/referral")) {
      callCount += 1;
      seenAuth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? null;
      seenBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(JSON.stringify({ applied: false, reason: "unknown_code" }), { status: 200 });
    }
    return fake.fetch(input, init);
  }) as typeof fetch;

  const spiedClient = createThemeServiceClient({
    fetch: stubFetch,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });

  const res = await spiedClient.applyReferralCode("PARTNER-CODE");
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.applied, false);
    assert.equal(res.value.reason, "unknown_code");
  }
  assert.equal(callCount, 1);
  assert.ok(seenAuth !== null && (seenAuth as string).startsWith("Bearer "));
  assert.deepEqual(seenBody, { referralCode: "PARTNER-CODE" });
});

test("getStatus surfaces locked and strikes from /api/account", async () => {
  const { fake, client } = setupClient();
  fake.helpers.createAccount("strikes@example.com");
  await client.requestMagicLink("strikes@example.com");
  await client.verifyMagicLink("strikes@example.com", "123456");
  fake.helpers.lockAccount("strikes@example.com");

  const status = await client.getStatus();
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.value.locked, true);
    assert.equal(typeof status.value.strikes, "number");
  }
});

// ---- fetchAuthConfig / getAuthConfig (p65-t4) ----
// setupClientNoOverride builds a client WITHOUT opts.supabaseUrl/supabaseAnonKey
// so getAuthConfig must go through fetchAuthConfig against the fake's
// GET /api/auth-config route.
function setupClientNoOverride(fetchFn?: typeof fetch) {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const tokenStore = createMemoryTokenStore();
  const client = createThemeServiceClient({
    fetch: fetchFn ?? fake.fetch,
    tokenStore,
    endpoint: ENDPOINT,
  });
  return { fake, tokenStore, client };
}

test("fetchAuthConfig: concurrent callers share one in-flight GET /api/auth-config", async () => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const { fetch: wrapped, calls } = countingFetch(fake.fetch);
  const { client } = setupClientNoOverride(wrapped);
  // Two calls that each internally need auth config, fired concurrently.
  const [a, b] = await Promise.all([
    client.requestMagicLink("concurrentcfg@example.com"),
    client.requestMagicLink("concurrentcfg2@example.com"),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const configCalls = calls.filter((c) => c.url.includes("/api/auth-config"));
  assert.equal(configCalls.length, 1);
});

test("fetchAuthConfig: a failed fetch is not cached, next call retries", async () => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  fake.helpers.failNextAuthConfig();
  const { fetch: wrapped, calls } = countingFetch(fake.fetch);
  const { client } = setupClientNoOverride(wrapped);

  const first = await client.requestMagicLink("retrycfg@example.com");
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.error.kind, "server_error");

  const second = await client.requestMagicLink("retrycfg@example.com");
  assert.equal(second.ok, true);

  const configCalls = calls.filter((c) => c.url.includes("/api/auth-config"));
  assert.equal(configCalls.length, 2);
});

test("fetchAuthConfig: malformed body (missing supabasePublishableKey) is rejected as server_error", async () => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  fake.helpers.malformNextAuthConfig();
  const { client } = setupClientNoOverride(fake.fetch);

  const res = await client.requestMagicLink("malformed@example.com");
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.kind, "server_error");
});

test("fetchAuthConfig: non-https supabaseUrl in the response is rejected", async () => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const insecureFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/api/auth-config")) {
      return new Response(
        JSON.stringify({
          supabaseUrl: "http://not-secure.example",
          supabasePublishableKey: "key",
          promptTemplateVersion: "v1",
          contractVersion: "v2",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return fake.fetch(input, init);
  }) as typeof fetch;
  const { client } = setupClientNoOverride(insecureFetch);

  const res = await client.requestMagicLink("insecure@example.com");
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.kind, "server_error");
});

test("fetchAuthConfig: a URL with query/fragment is rejected", async () => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const dirtyFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/api/auth-config")) {
      return new Response(
        JSON.stringify({
          supabaseUrl: `${SUPABASE_URL}/?x=1`,
          supabasePublishableKey: "key",
          promptTemplateVersion: "v1",
          contractVersion: "v2",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return fake.fetch(input, init);
  }) as typeof fetch;
  const { client } = setupClientNoOverride(dirtyFetch);

  const res = await client.requestMagicLink("dirtyurl@example.com");
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.kind, "server_error");
});

test("fetchAuthConfig: timeout maps to kind timeout", async (t) => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const hangingFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/api/auth-config")) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }
    return fake.fetch(input, init);
  }) as typeof fetch;
  const tokenStore = createMemoryTokenStore();
  const client = createThemeServiceClient({
    fetch: hangingFetch,
    tokenStore,
    endpoint: ENDPOINT,
  });
  // AUTH_CONFIG_TIMEOUT_MS is a fixed 30_000ms internal to the client (not
  // configurable via opts.requestTimeoutMs); fast-forward it with fake timers
  // rather than waiting 30s of wall-clock time.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let res: Awaited<ReturnType<typeof client.requestMagicLink>>;
  try {
    const p = client.requestMagicLink("timeoutcfg@example.com");
    await t.mock.timers.tick(30_000);
    res = await p;
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.kind, "timeout");
});

test("fetchAuthConfig: opts.supabaseUrl + supabaseAnonKey bypass the fetch entirely", async () => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const { fetch: wrapped, calls } = countingFetch(fake.fetch);
  const tokenStore = createMemoryTokenStore();
  const client = createThemeServiceClient({
    fetch: wrapped,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });
  const res = await client.requestMagicLink("bypass@example.com");
  assert.equal(res.ok, true);
  const configCalls = calls.filter((c) => c.url.includes("/api/auth-config"));
  assert.equal(configCalls.length, 0);
});

test("authRequest: a 401 triggers exactly one refetch of auth config and one retry", async () => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const { fetch: wrapped, calls } = countingFetch(fake.fetch);
  const { client, tokenStore } = setupClientNoOverride(wrapped);

  await client.requestMagicLink("retrytoken@example.com");
  await client.verifyMagicLink("retrytoken@example.com", "123456");
  fake.helpers.expireAccessToken();
  const parsed = JSON.parse(tokenStore.value!) as { accessToken: string; refreshToken: string; expiresAt: number };
  parsed.refreshToken = "not-a-real-refresh-token";
  await tokenStore.set(JSON.stringify(parsed));

  calls.length = 0; // only count calls from here
  const status = await client.getStatus();
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.value.signedIn, false);

  const configCalls = calls.filter((c) => c.url.includes("/api/auth-config"));
  // First getAuthConfig (cached from earlier verify) was cleared by the
  // caller's own 401 handling once — exactly one additional fetch here.
  assert.equal(configCalls.length, 1);
});

// ── p75-t1/t3: statusTimeoutMs applies to getStatus/getPricing only ────────

function hangingFetchFor(matchPath: string, fake: ReturnType<typeof createFakeThemeService>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes(matchPath)) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }
    return fake.fetch(input, init);
  }) as typeof fetch;
}

test("getStatus: aborts at statusTimeoutMs (not the default requestTimeoutMs) under fake timers", async (t) => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const account = fake.helpers.createAccount("statustimeout@example.com");
  fake.helpers.grant(account.id, 5);
  const tokenStore = createMemoryTokenStore();
  const hangingFetch = hangingFetchFor("/api/account", fake);
  const client = createThemeServiceClient({
    fetch: hangingFetch,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
    statusTimeoutMs: 10_000,
  });
  await client.requestMagicLink("statustimeout@example.com");
  await client.verifyMagicLink("statustimeout@example.com", "123456");

  t.mock.timers.enable({ apis: ["setTimeout"] });
  let res: Awaited<ReturnType<typeof client.getStatus>>;
  try {
    const p = client.getStatus();
    // getStatus awaits loadSession() before registering the AbortController's
    // setTimeout, so the timer isn't scheduled yet on this same microtask
    // turn — flush a few microtask hops before advancing the fake clock,
    // or tick(10_000) races ahead of the setTimeout call and never fires it.
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await t.mock.timers.tick(10_000);
    res = await p;
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.kind, "timeout");
});

test("getPricing: also bound by statusTimeoutMs under fake timers", async (t) => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const tokenStore = createMemoryTokenStore();
  const hangingFetch = hangingFetchFor("/api/pricing", fake);
  const client = createThemeServiceClient({
    fetch: hangingFetch,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
    statusTimeoutMs: 10_000,
  });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  let res: Awaited<ReturnType<typeof client.getPricing>>;
  try {
    const p = client.getPricing();
    await t.mock.timers.tick(10_000);
    res = await p;
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.kind, "timeout");
});

test("createCheckoutSession (a generation-shaped request) is NOT bound by statusTimeoutMs — a short statusTimeoutMs does not abort it early", async (t) => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const account = fake.helpers.createAccount("nogenetimeout@example.com");
  fake.helpers.grant(account.id, 5);
  const tokenStore = createMemoryTokenStore();
  // /api/account (status) hangs and would abort at 10ms; checkout must not
  // share that short budget.
  const hangingFetch = hangingFetchFor("/api/account", fake);
  const client = createThemeServiceClient({
    fetch: hangingFetch,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
    statusTimeoutMs: 10, // deliberately tiny so a shared-budget bug would show up immediately
  });
  await client.requestMagicLink("nogenetimeout@example.com");
  await client.verifyMagicLink("nogenetimeout@example.com", "123456");

  const res = await client.createCheckoutSession("starter45");
  assert.equal(res.ok, true, "checkout must succeed even though statusTimeoutMs is tiny");
});

// ── p87: authLandingUrl passthrough on GET /api/auth-config ────────────────

test("getAuthLandingUrl returns the raw authLandingUrl string when the backend sends one", async () => {
  const tokenStore = createMemoryTokenStore();
  const fetchImpl = async (url: string | URL) => {
    if (String(url).endsWith("/api/auth-config")) {
      return new Response(
        JSON.stringify({
          supabaseUrl: "https://fake-project.supabase.co",
          supabasePublishableKey: "fake-key",
          promptTemplateVersion: "v1",
          contractVersion: "v1",
          authLandingUrl: "https://landing.example/auth",
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  };
  const client = createThemeServiceClient({ fetch: fetchImpl as any, tokenStore, endpoint: "https://theme-service.example" });
  const res = await client.getAuthLandingUrl();
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value, "https://landing.example/auth");
});

test("getAuthLandingUrl returns undefined when the backend omits authLandingUrl (today's behavior)", async () => {
  const tokenStore = createMemoryTokenStore();
  const fetchImpl = async (url: string | URL) => {
    if (String(url).endsWith("/api/auth-config")) {
      return new Response(
        JSON.stringify({
          supabaseUrl: "https://fake-project.supabase.co",
          supabasePublishableKey: "fake-key",
          promptTemplateVersion: "v1",
          contractVersion: "v1",
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  };
  const client = createThemeServiceClient({ fetch: fetchImpl as any, tokenStore, endpoint: "https://theme-service.example" });
  const res = await client.getAuthLandingUrl();
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value, undefined);
});

// ── p92: hasStoredSession (no network call) ─────────────────────────────────

test("hasStoredSession is false with no stored token", async () => {
  const tokenStore = createMemoryTokenStore();
  const client = createThemeServiceClient({
    fetch: (async () => new Response("unused", { status: 500 })) as any,
    tokenStore,
    endpoint: "https://theme-service.example",
    supabaseUrl: "https://fake-project.supabase.co",
    supabaseAnonKey: "fake-key",
  });
  assert.equal(await client.hasStoredSession(), false);
});

test("hasStoredSession is true once a well-formed session is stored, without any network call", async () => {
  const tokenStore = createMemoryTokenStore();
  let fetchCalls = 0;
  const client = createThemeServiceClient({
    fetch: (async () => {
      fetchCalls++;
      return new Response("unused", { status: 500 });
    }) as any,
    tokenStore,
    endpoint: "https://theme-service.example",
    supabaseUrl: "https://fake-project.supabase.co",
    supabaseAnonKey: "fake-key",
  });
  await tokenStore.set(JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 60000 }));
  assert.equal(await client.hasStoredSession(), true);
  assert.equal(fetchCalls, 0, "hasStoredSession must not make a network call");
});

test("hasStoredSession is false for a malformed stored value", async () => {
  const tokenStore = createMemoryTokenStore();
  const client = createThemeServiceClient({
    fetch: (async () => new Response("unused", { status: 500 })) as any,
    tokenStore,
    endpoint: "https://theme-service.example",
    supabaseUrl: "https://fake-project.supabase.co",
    supabaseAnonKey: "fake-key",
  });
  await tokenStore.set("not-json");
  assert.equal(await client.hasStoredSession(), false);
});
