/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeThemeService } from "./helpers/fakeThemeService";

const ENDPOINT = "https://theme-service.example";

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function signIn(fetchFn: typeof fetch, email: string) {
  await fetchFn(`${ENDPOINT}/auth/magic-link`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  const res = await fetchFn(`${ENDPOINT}/auth/verify`, {
    method: "POST",
    body: JSON.stringify({ email, code: "123456" }),
  });
  const body = (await res.json()) as {
    deviceToken: string;
    account: { id: string; email: string; provider: string };
  };
  return body;
}

test("sign-in round trip issues a device token and account", async () => {
  const { fetch: fakeFetch } = createFakeThemeService({ endpoint: ENDPOINT });
  const { deviceToken, account } = await signIn(fakeFetch, "a@example.com");
  assert.ok(deviceToken);
  assert.equal(account.email, "a@example.com");
  assert.equal(account.provider, "email");

  const meRes = await fakeFetch(`${ENDPOINT}/me`, { headers: authHeaders(deviceToken) });
  assert.equal(meRes.status, 200);
  const me = (await meRes.json()) as { account: { id: string }; balance: { credits: number } };
  assert.equal(me.account.id, account.id);
  assert.equal(me.balance.credits, 0);
});

test("admin grant increases balance", async () => {
  const { fetch: fakeFetch, state, helpers } = createFakeThemeService({ endpoint: ENDPOINT });
  const { deviceToken, account } = await signIn(fakeFetch, "b@example.com");
  helpers.grant(account.id, 10);

  const balRes = await fakeFetch(`${ENDPOINT}/me/balance`, { headers: authHeaders(deviceToken) });
  const bal = (await balRes.json()) as { credits: number };
  assert.equal(bal.credits, 10);
  assert.equal(state.ledger.filter((r) => r.kind === "grant").length, 1);
});

test("generate debits the ledger and returns an image", async () => {
  const { fetch: fakeFetch, helpers } = createFakeThemeService({ endpoint: ENDPOINT });
  const { deviceToken, account } = await signIn(fakeFetch, "c@example.com");
  helpers.grant(account.id, 5);

  const res = await fakeFetch(`${ENDPOINT}/generate`, {
    method: "POST",
    headers: authHeaders(deviceToken),
    body: JSON.stringify({
      idempotencyKey: "key-1",
      boardType: "objects_01",
      prompt: "a chair",
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { image: string; attemptCost: number; balance: number; refunded: boolean };
  assert.ok(body.image.startsWith("data:image/png"));
  assert.equal(body.attemptCost, 1);
  assert.equal(body.balance, 4);
  assert.equal(body.refunded, false);
});

test("failed generate refunds with zero net ledger effect", async () => {
  const { fetch: fakeFetch, state, helpers } = createFakeThemeService({ endpoint: ENDPOINT });
  const { deviceToken, account } = await signIn(fakeFetch, "d@example.com");
  helpers.grant(account.id, 5);
  helpers.failNextGenerate();

  const res = await fakeFetch(`${ENDPOINT}/generate`, {
    method: "POST",
    headers: authHeaders(deviceToken),
    body: JSON.stringify({ idempotencyKey: "key-fail", boardType: "character", prompt: "x" }),
  });
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string; refunded: boolean; balance: number };
  assert.equal(body.error, "provider_failed");
  assert.equal(body.refunded, true);
  assert.equal(body.balance, 5); // net zero — balance restored

  const rows = state.ledger.filter((r) => r.attemptId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, "spend");
  assert.equal(rows[1].kind, "refund");
  assert.equal(rows[0].credits, rows[1].credits);
});

test("repeated idempotencyKey replays the original response without a new debit", async () => {
  const { fetch: fakeFetch, state, helpers } = createFakeThemeService({ endpoint: ENDPOINT });
  const { deviceToken, account } = await signIn(fakeFetch, "e@example.com");
  helpers.grant(account.id, 5);

  const body1 = { idempotencyKey: "same-key", boardType: "environment", prompt: "x" };
  const res1 = await fakeFetch(`${ENDPOINT}/generate`, {
    method: "POST",
    headers: authHeaders(deviceToken),
    body: JSON.stringify(body1),
  });
  const parsed1 = (await res1.json()) as { balance: number };

  const res2 = await fakeFetch(`${ENDPOINT}/generate`, {
    method: "POST",
    headers: authHeaders(deviceToken),
    body: JSON.stringify(body1),
  });
  const parsed2 = (await res2.json()) as { balance: number };

  assert.equal(parsed1.balance, parsed2.balance);
  assert.equal(state.ledger.filter((r) => r.kind === "spend").length, 1);
});

test("checkout completion grants the pack's credits", async () => {
  const { fetch: fakeFetch, helpers } = createFakeThemeService({ endpoint: ENDPOINT });
  const { deviceToken, account } = await signIn(fakeFetch, "f@example.com");

  const res = await fakeFetch(`${ENDPOINT}/checkout/session`, {
    method: "POST",
    headers: authHeaders(deviceToken),
    body: JSON.stringify({ sku: "pack_m" }),
  });
  const { sessionId } = (await res.json()) as { sessionId: string; url: string };

  const grantRow = helpers.completeCheckout(sessionId);
  assert.ok(grantRow);
  assert.equal(grantRow?.credits, 50);

  const balRes = await fakeFetch(`${ENDPOINT}/me/balance`, { headers: authHeaders(deviceToken) });
  const bal = (await balRes.json()) as { credits: number };
  assert.equal(bal.credits, 50);

  // completing twice does nothing further
  const second = helpers.completeCheckout(sessionId);
  assert.equal(second, undefined);
});

test("missing or invalid token returns 401", async () => {
  const { fetch: fakeFetch } = createFakeThemeService({ endpoint: ENDPOINT });
  const res = await fakeFetch(`${ENDPOINT}/me`, { headers: authHeaders("bogus-token") });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "not_signed_in");
});

test("insufficient balance returns 402 with balance", async () => {
  const { fetch: fakeFetch } = createFakeThemeService({ endpoint: ENDPOINT });
  const { deviceToken } = await signIn(fakeFetch, "g@example.com");

  const res = await fakeFetch(`${ENDPOINT}/generate`, {
    method: "POST",
    headers: authHeaders(deviceToken),
    body: JSON.stringify({ idempotencyKey: "k", boardType: "character", prompt: "x" }),
  });
  assert.equal(res.status, 402);
  const body = (await res.json()) as { error: string; balance: number };
  assert.equal(body.error, "insufficient_credits");
  assert.equal(body.balance, 0);
});

test("setUnavailable(true) returns 503 for any request", async () => {
  const { fetch: fakeFetch, helpers } = createFakeThemeService({ endpoint: ENDPOINT });
  helpers.setUnavailable(true);
  const res = await fakeFetch(`${ENDPOINT}/me/balance`, { headers: authHeaders("whatever") });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "unavailable");
});

test("google sign-in requires browser completion before /auth/google/complete succeeds", async () => {
  const { fetch: fakeFetch, helpers } = createFakeThemeService({ endpoint: ENDPOINT });
  const startRes = await fakeFetch(`${ENDPOINT}/auth/google/start`, { method: "POST", body: "{}" });
  const { sessionId } = (await startRes.json()) as { sessionId: string; browserUrl: string };

  const tooEarly = await fakeFetch(`${ENDPOINT}/auth/google/complete`, {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
  assert.equal(tooEarly.status, 401);

  helpers.completeGoogleInBrowser(sessionId);
  const completeRes = await fakeFetch(`${ENDPOINT}/auth/google/complete`, {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
  assert.equal(completeRes.status, 200);
  const body = (await completeRes.json()) as { account: { provider: string } };
  assert.equal(body.account.provider, "google");
});

test("pricing exposes deterministic defaults", async () => {
  const { fetch: fakeFetch } = createFakeThemeService({ endpoint: ENDPOINT });
  const { deviceToken } = await signIn(fakeFetch, "h@example.com");
  const res = await fakeFetch(`${ENDPOINT}/pricing`, { headers: authHeaders(deviceToken) });
  const body = (await res.json()) as {
    attemptCostByBoardType: Record<string, number>;
    typicalTheme: { min: number; max: number };
    packs: Array<{ sku: string; credits: number }>;
  };
  assert.equal(body.attemptCostByBoardType.objects_01, 1);
  assert.equal(body.typicalTheme.min, 14);
  assert.equal(body.typicalTheme.max, 40);
  assert.equal(body.packs.length, 5);
});
