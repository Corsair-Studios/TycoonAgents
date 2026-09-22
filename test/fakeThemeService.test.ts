/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeThemeService } from "./helpers/fakeThemeService";

const ENDPOINT = "https://theme-service.example";
const SUPABASE_URL = "https://fake-project.supabase.co";

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function signInByEmail(fetchFn: typeof fetch, email: string, code = "123456") {
  await fetchFn(`${SUPABASE_URL}/auth/v1/otp`, {
    method: "POST",
    body: JSON.stringify({ email, create_user: true }),
  });
  const res = await fetchFn(`${SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    body: JSON.stringify({ type: "email", email, token: code }),
  });
  const body = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    user: { id: string; email: string };
  };
  return { res, body };
}

test("/api/pricing is public — no auth required", async () => {
  const { fetch: fakeFetch } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const res = await fakeFetch(`${ENDPOINT}/api/pricing`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { packs: Array<{ id: string }> };
  assert.ok(body.packs.length > 0);
});

test("email OTP sign-in round trip issues a Supabase-shaped session", async () => {
  const { fetch: fakeFetch } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const { res, body } = await signInByEmail(fakeFetch, "a@example.com");
  assert.equal(res.status, 200);
  assert.ok(body.access_token);
  assert.ok(body.refresh_token);
  assert.equal(body.user.email, "a@example.com");

  const meRes = await fakeFetch(`${ENDPOINT}/api/account`, { headers: authHeaders(body.access_token) });
  assert.equal(meRes.status, 200);
  const me = (await meRes.json()) as { email: string; credits: number };
  assert.equal(me.email, "a@example.com");
  assert.equal(me.credits, 0);
});

test("wrong OTP code is rejected", async () => {
  const { fetch: fakeFetch, helpers } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  helpers.setOtpCode("bad@example.com", "111111");
  const res = await fakeFetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    body: JSON.stringify({ type: "email", email: "bad@example.com", token: "000000" }),
  });
  assert.equal(res.status, 401);
});

test("Google PKCE flow: authorize -> completeGoogleInBrowser -> pkce token exchange", async () => {
  const { fetch: fakeFetch, state } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const verifier = "test-verifier-1234567890";
  // Compute the challenge the same way the client does (sha256 base64url).
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  new Uint8Array(digest).forEach((b) => (binary += String.fromCharCode(b)));
  const challenge = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const authorizeUrl = new URL(`${SUPABASE_URL}/auth/v1/authorize`);
  authorizeUrl.searchParams.set("provider", "google");
  authorizeUrl.searchParams.set("redirect_to", "http://127.0.0.1:9999/callback");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  const authorizeRes = await fakeFetch(authorizeUrl.toString());
  assert.equal(authorizeRes.status, 302);
  const location = authorizeRes.headers.get("Location");
  assert.ok(location?.includes("code="));

  const authCode = new URL(location!).searchParams.get("code")!;
  const tokenRes = await fakeFetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    body: JSON.stringify({ auth_code: authCode, code_verifier: verifier }),
  });
  assert.equal(tokenRes.status, 200);
  const session = (await tokenRes.json()) as { access_token: string };
  assert.ok(session.access_token);
  assert.equal(state.pendingGoogleChallenges.size, 0);
});

test("pkce exchange with wrong verifier fails", async () => {
  const { fetch: fakeFetch } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const authorizeUrl = new URL(`${SUPABASE_URL}/auth/v1/authorize`);
  authorizeUrl.searchParams.set("provider", "google");
  authorizeUrl.searchParams.set("redirect_to", "http://127.0.0.1:9999/callback");
  authorizeUrl.searchParams.set("code_challenge", "some-challenge");
  const authorizeRes = await fakeFetch(authorizeUrl.toString());
  const location = authorizeRes.headers.get("Location")!;
  const authCode = new URL(location).searchParams.get("code")!;

  const tokenRes = await fakeFetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    body: JSON.stringify({ auth_code: authCode, code_verifier: "wrong-verifier" }),
  });
  assert.equal(tokenRes.status, 401);
});

test("refresh_token grant rotates tokens", async () => {
  const { fetch: fakeFetch } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const { body } = await signInByEmail(fakeFetch, "refresh@example.com");
  const refreshRes = await fakeFetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    body: JSON.stringify({ refresh_token: body.refresh_token }),
  });
  assert.equal(refreshRes.status, 200);
  const refreshed = (await refreshRes.json()) as { access_token: string; refresh_token: string };
  assert.notEqual(refreshed.access_token, body.access_token);

  // Old refresh token is now invalid.
  const replay = await fakeFetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    body: JSON.stringify({ refresh_token: body.refresh_token }),
  });
  assert.equal(replay.status, 401);
});

test("expireAccessToken makes the access token 401 from service routes", async () => {
  const { fetch: fakeFetch, helpers } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const { body } = await signInByEmail(fakeFetch, "expire@example.com");
  helpers.expireAccessToken();
  const res = await fakeFetch(`${ENDPOINT}/api/account`, { headers: authHeaders(body.access_token) });
  assert.equal(res.status, 401);
});

test("logout revokes the access token", async () => {
  const { fetch: fakeFetch } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const { body } = await signInByEmail(fakeFetch, "logout@example.com");
  const logoutRes = await fakeFetch(`${SUPABASE_URL}/auth/v1/logout`, {
    method: "POST",
    headers: authHeaders(body.access_token),
  });
  assert.equal(logoutRes.status, 204);
  const res = await fakeFetch(`${ENDPOINT}/api/account`, { headers: authHeaders(body.access_token) });
  assert.equal(res.status, 401);
});

test("checkout -> completeCheckout grants pack credits", async () => {
  const { fetch: fakeFetch, helpers } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const { body } = await signInByEmail(fakeFetch, "buyer@example.com");
  const res = await fakeFetch(`${ENDPOINT}/api/store/checkout`, {
    method: "POST",
    headers: authHeaders(body.access_token),
    body: JSON.stringify({ pack: "starter45" }),
  });
  assert.equal(res.status, 200);
  const { url } = (await res.json()) as { url: string };
  const sessionId = url.split("/").pop()!;
  const row = helpers.completeCheckout(sessionId);
  assert.ok(row);
  assert.equal(row?.delta, 45);
  assert.match(row!.ref!, /^stripe:.*:starter45$/);

  const meRes = await fakeFetch(`${ENDPOINT}/api/account`, { headers: authHeaders(body.access_token) });
  const me = (await meRes.json()) as { credits: number };
  assert.equal(me.credits, 45);

  // Replay-safe: completing again is a no-op.
  const replay = helpers.completeCheckout(sessionId);
  assert.equal(replay, undefined);
});

test("generate debits the ledger and returns an image", async () => {
  const { fetch: fakeFetch, helpers } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const account = helpers.createAccount("gen@example.com");
  const { body } = await signInByEmail(fakeFetch, "gen@example.com");
  helpers.grant(account.id, 5);

  const res = await fakeFetch(`${ENDPOINT}/api/generate`, {
    method: "POST",
    headers: authHeaders(body.access_token),
    body: JSON.stringify({ idempotencyKey: "key-1", boardType: "objects_01", prompt: "a chair" }),
  });
  assert.equal(res.status, 200);
  const gen = (await res.json()) as { image: string; attemptCost: number; credits: number; refunded: boolean };
  assert.ok(gen.image.startsWith("data:image/png"));
  assert.equal(gen.attemptCost, 2);
  assert.equal(gen.credits, 3);
  assert.equal(gen.refunded, false);
});

test("failed generate refunds with zero net ledger effect", async () => {
  const { fetch: fakeFetch, state, helpers } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const account = helpers.createAccount("fail@example.com");
  const { body } = await signInByEmail(fakeFetch, "fail@example.com");
  helpers.grant(account.id, 5);
  helpers.failNextGenerate();

  const res = await fakeFetch(`${ENDPOINT}/api/generate`, {
    method: "POST",
    headers: authHeaders(body.access_token),
    body: JSON.stringify({ idempotencyKey: "key-fail", boardType: "roster_agent", prompt: "x" }),
  });
  assert.equal(res.status, 502);
  const respBody = (await res.json()) as { error: string; refunded: boolean; credits: number };
  assert.equal(respBody.error, "provider_failed");
  assert.equal(respBody.refunded, true);
  assert.equal(respBody.credits, 5); // net zero — balance restored

  const rows = state.ledger.filter((r) => r.ref?.includes("key-fail"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].reason, "spend-theme-attempt");
  assert.equal(rows[1].reason, "refund-theme-attempt");
});

test("idempotent generate replay returns the original response with no new ledger row", async () => {
  const { fetch: fakeFetch, state, helpers } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const account = helpers.createAccount("replay@example.com");
  const { body } = await signInByEmail(fakeFetch, "replay@example.com");
  helpers.grant(account.id, 5);

  const req = () =>
    fakeFetch(`${ENDPOINT}/api/generate`, {
      method: "POST",
      headers: authHeaders(body.access_token),
      body: JSON.stringify({ idempotencyKey: "replay-key", boardType: "objects_01", prompt: "x" }),
    });

  const first = await req();
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  const second = await req();
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.deepEqual(firstBody, secondBody);

  const rows = state.ledger.filter((r) => r.ref === "attempt:replay-key");
  assert.equal(rows.length, 1);
});

test("insufficient credits returns 402", async () => {
  const { fetch: fakeFetch } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const { body } = await signInByEmail(fakeFetch, "poor@example.com");
  const res = await fakeFetch(`${ENDPOINT}/api/generate`, {
    method: "POST",
    headers: authHeaders(body.access_token),
    body: JSON.stringify({ idempotencyKey: "poor-key", boardType: "objects_01", prompt: "x" }),
  });
  assert.equal(res.status, 402);
  const respBody = (await res.json()) as { error: string; credits: number };
  assert.equal(respBody.error, "insufficient_credits");
  assert.equal(respBody.credits, 0);
});

test("setUnavailable makes service routes return 503", async () => {
  const { fetch: fakeFetch, helpers } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  helpers.setUnavailable(true);
  const res = await fakeFetch(`${ENDPOINT}/api/pricing`);
  assert.equal(res.status, 503);
});


// --- /api/plan (p43-t7) -----------------------------------------------------

test("plan debits planCost and echoes kind/input as output", async () => {
  const { fetch: fakeFetch, helpers } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const account = helpers.createAccount("plan@example.com");
  const { body } = await signInByEmail(fakeFetch, "plan@example.com");
  helpers.grant(account.id, 5);

  const res = await fakeFetch(`${ENDPOINT}/api/plan`, {
    method: "POST",
    headers: authHeaders(body.access_token),
    body: JSON.stringify({ idempotencyKey: "plan-key-1", kind: "plan", input: { prompt: "a chair shop" } }),
  });
  assert.equal(res.status, 200);
  const planBody = (await res.json()) as { output: unknown; attemptCost: number; credits: number; refunded: boolean };
  // p86: /api/plan's fake "plan" output also includes a plausible
  // (non-sparse) plan body now — see test/helpers/fakeThemeService.ts.
  assert.deepEqual(planBody.output, {
    kind: "plan",
    echo: { prompt: "a chair shop" },
    display_name: "Fake Plan",
    creative_direction: "fake plan direction",
    characters: ["Fake Character"],
    objects: ["Fake Object"],
    decor: ["Fake Decor"],
    enemies: ["Fake Enemy"],
    achievements: ["Fake Achievement"],
  });
  assert.equal(planBody.attemptCost, 1);
  assert.equal(planBody.credits, 4);
  assert.equal(planBody.refunded, false);
});

test("failed plan refunds with zero net ledger effect", async () => {
  const { fetch: fakeFetch, state, helpers } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const account = helpers.createAccount("planfail@example.com");
  const { body } = await signInByEmail(fakeFetch, "planfail@example.com");
  helpers.grant(account.id, 5);
  helpers.failNextPlan();

  const res = await fakeFetch(`${ENDPOINT}/api/plan`, {
    method: "POST",
    headers: authHeaders(body.access_token),
    body: JSON.stringify({ idempotencyKey: "plan-key-fail", kind: "descriptions", input: { prompt: "x" } }),
  });
  assert.equal(res.status, 502);
  const respBody = (await res.json()) as { error: string; refunded: boolean; credits: number };
  assert.equal(respBody.error, "provider_failed");
  assert.equal(respBody.refunded, true);
  assert.equal(respBody.credits, 5); // net zero — balance restored

  const rows = state.ledger.filter((r) => r.ref?.includes("plan-key-fail"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].reason, "spend-theme-attempt");
  assert.equal(rows[1].reason, "refund-theme-attempt");
});

test("idempotent plan replay returns the original response with no new ledger row", async () => {
  const { fetch: fakeFetch, state, helpers } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const account = helpers.createAccount("planreplay@example.com");
  const { body } = await signInByEmail(fakeFetch, "planreplay@example.com");
  helpers.grant(account.id, 5);

  const req = () =>
    fakeFetch(`${ENDPOINT}/api/plan`, {
      method: "POST",
      headers: authHeaders(body.access_token),
      body: JSON.stringify({ idempotencyKey: "plan-replay-key", kind: "plan", input: { prompt: "x" } }),
    });

  const first = await req();
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  const second = await req();
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.deepEqual(firstBody, secondBody);

  const rows = state.ledger.filter((r) => r.ref === "plan:plan-replay-key");
  assert.equal(rows.length, 1);
});

test("plan insufficient credits returns 402", async () => {
  const { fetch: fakeFetch } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const { body } = await signInByEmail(fakeFetch, "planpoor@example.com");
  const res = await fakeFetch(`${ENDPOINT}/api/plan`, {
    method: "POST",
    headers: authHeaders(body.access_token),
    body: JSON.stringify({ idempotencyKey: "plan-poor-key", kind: "plan", input: { prompt: "x" } }),
  });
  assert.equal(res.status, 402);
  const respBody = (await res.json()) as { error: string; credits: number };
  assert.equal(respBody.error, "insufficient_credits");
  assert.equal(respBody.credits, 0);
});

test("plan requires auth", async () => {
  const { fetch: fakeFetch } = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const res = await fakeFetch(`${ENDPOINT}/api/plan`, {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: "no-auth", kind: "plan", input: { prompt: "x" } }),
  });
  assert.equal(res.status, 401);
});
