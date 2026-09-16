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
    assert.deepEqual(res.value.output, { kind: "plan", echo: { prompt: "a cozy noodle shop" } });
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
