import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThemeServiceClient, ThemeServiceTokenStore } from '../src/core/themeServiceClient';
import { createFakeThemeService } from './helpers/fakeThemeService';

function createMemoryTokenStore(initial: string | null = null): ThemeServiceTokenStore & { value: string | null } {
  return {
    value: initial,
    async get() {
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

// The fake defaults its endpoint to https://theme-service.example, but the
// client defaults to THEME_SERVICE_ENDPOINT — they must be pointed at the
// same value explicitly.
function setupClient() {
  const endpoint = 'https://theme-service.example';
  const fake = createFakeThemeService({ endpoint });
  const tokenStore = createMemoryTokenStore();
  const client = createThemeServiceClient({ fetch: fake.fetch, tokenStore, endpoint });
  return { fake, tokenStore, client };
}

test('magic-link sign-in round trip stores a token and getStatus reports signedIn', async () => {
  const { fake, tokenStore, client } = setupClient();
  fake.helpers.createAccount('a@example.com');
  fake.helpers.setMagicLinkCode('a@example.com', '111111');

  const req = await client.requestMagicLink('a@example.com');
  assert.equal(req.ok, true);

  const verify = await client.verifyMagicLink('a@example.com', '111111');
  assert.equal(verify.ok, true);
  if (!verify.ok) return;
  assert.equal(verify.value.account.email, 'a@example.com');
  assert.equal(tokenStore.value, verify.value.deviceToken);

  const status = await client.getStatus();
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.value.signedIn, true);
  assert.equal(status.value.account?.email, 'a@example.com');
  assert.equal(status.value.balance?.credits, 0);
});

test('Google sign-in: browser completion then completeGoogleSignIn by sessionId', async () => {
  const { fake, tokenStore, client } = setupClient();
  const start = await client.startGoogleSignIn();
  assert.equal(start.ok, true);
  if (!start.ok) return;
  assert.equal(typeof start.value.browserUrl, 'string');
  assert.equal(typeof start.value.sessionId, 'string');

  fake.helpers.completeGoogleInBrowser(start.value.sessionId);
  const complete = await client.completeGoogleSignIn({ sessionId: start.value.sessionId });
  assert.equal(complete.ok, true);
  if (!complete.ok) return;
  assert.equal(complete.value.account.provider, 'google');
  assert.equal(tokenStore.value, complete.value.deviceToken);
});

test('Google sign-in: pasted-code completion path', async () => {
  const { fake, client } = setupClient();
  const start = await client.startGoogleSignIn();
  assert.equal(start.ok, true);
  if (!start.ok) return;
  fake.helpers.completeGoogleInBrowser(start.value.sessionId);
  const session = fake.state.pendingGoogleSessions.get(start.value.sessionId);
  assert.ok(session);
  const complete = await client.completeGoogleSignIn({ code: session!.code });
  assert.equal(complete.ok, true);
  if (!complete.ok) return;
  assert.equal(complete.value.account.provider, 'google');
});

// KNOWN CLIENT/FAKE MISMATCH (reported, not fixed here per the brief):
// docs/theme-service-api.md places `GET /pricing` under its own "Pricing"
// section (not "Account"), and src/core/themeServiceClient.ts:355 calls
// `request("/pricing", { method: "GET" })` with no `auth: true` — so the
// client never sends an Authorization header for it, signed in or not.
// But fakeThemeService.ts routes `/pricing` below its "everything below
// requires auth" gate (line ~330), so it 401s every client.getPricing()
// call regardless of sign-in state. This test documents the fake's actual
// (auth-required) behavior rather than asserting the docs' intended
// (public) contract, since neither src nor the helper may be edited here.
test('getPricing: fake requires auth, so an unauthenticated client call gets not_signed_in', async () => {
  const { fake, client } = setupClient();
  await signIn(client, fake, 'pricing@example.com', '777777');
  const pricing = await client.getPricing();
  assert.equal(pricing.ok, false);
  if (pricing.ok) return;
  assert.equal(pricing.error.kind, 'not_signed_in');
});

test('getPricing: fake pricing data itself has five packs and a typicalTheme range', async () => {
  const { fake } = setupClient();
  assert.equal(fake.state.pricing.packs.length, 5);
  assert.equal(typeof fake.state.pricing.typicalTheme.min, 'number');
  assert.equal(typeof fake.state.pricing.typicalTheme.max, 'number');
});

test('checkout: createCheckoutSession returns a url, completeCheckout raises balance', async () => {
  const { fake, tokenStore, client } = setupClient();
  const account = fake.helpers.createAccount('buyer@example.com');
  // sign in via magic link to get a real token
  fake.helpers.setMagicLinkCode('buyer@example.com', '222222');
  await client.requestMagicLink('buyer@example.com');
  const verify = await client.verifyMagicLink('buyer@example.com', '222222');
  assert.equal(verify.ok, true);

  const checkout = await client.createCheckoutSession('pack_s');
  assert.equal(checkout.ok, true);
  if (!checkout.ok) return;
  assert.equal(typeof checkout.value.url, 'string');

  const before = await client.getStatus();
  assert.equal(before.ok, true);
  if (!before.ok) return;
  const beforeBalance = before.value.balance?.credits ?? 0;

  fake.helpers.completeCheckout(checkout.value.sessionId);

  const after = await client.getStatus();
  assert.equal(after.ok, true);
  if (!after.ok) return;
  assert.ok((after.value.balance?.credits ?? 0) > beforeBalance);
  assert.equal(account.id, fake.state.accountsByEmail.get('buyer@example.com'));
});

async function signIn(client: ReturnType<typeof setupClient>['client'], fake: ReturnType<typeof createFakeThemeService>, email: string, code: string) {
  fake.helpers.createAccount(email);
  fake.helpers.setMagicLinkCode(email, code);
  await client.requestMagicLink(email);
  const verify = await client.verifyMagicLink(email, code);
  assert.equal(verify.ok, true);
  return verify;
}

test('generateAttempt debits credits, retries, refund on provider failure, and idempotent replay', async () => {
  const { fake, client } = setupClient();
  await signIn(client, fake, 'gen@example.com', '333333');
  const accountId = fake.state.accountsByEmail.get('gen@example.com')!;
  fake.helpers.grant(accountId, 10);

  const req1 = {
    idempotencyKey: 'key-1',
    boardType: 'character',
    prompt: 'a hero',
    size: '512x512',
  };
  const first = await client.generateAttempt(req1);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const spendRowsAfterFirst = fake.state.ledger.filter((r) => r.kind === 'spend' && r.accountId === accountId);
  assert.equal(spendRowsAfterFirst.length, 1);

  const req2 = { ...req1, idempotencyKey: 'key-2' };
  const second = await client.generateAttempt(req2);
  assert.equal(second.ok, true);
  const spendRowsAfterSecond = fake.state.ledger.filter((r) => r.kind === 'spend' && r.accountId === accountId);
  assert.equal(spendRowsAfterSecond.length, 2);

  const balanceBeforeFail = second.ok ? second.value.balance : 0;
  fake.helpers.failNextGenerate();
  const req3 = { ...req1, idempotencyKey: 'key-3' };
  const failed = await client.generateAttempt(req3);
  assert.equal(failed.ok, false);
  if (failed.ok) return;
  assert.equal(failed.error.kind, 'provider_failed');
  assert.equal(failed.error.refunded, true);
  assert.equal(failed.error.balance, balanceBeforeFail);

  const spendRowsAfterFail = fake.state.ledger.filter((r) => r.kind === 'spend' && r.accountId === accountId);
  const refundRows = fake.state.ledger.filter((r) => r.kind === 'refund' && r.accountId === accountId);
  assert.equal(spendRowsAfterFail.length, 3);
  assert.equal(refundRows.length, 1);

  // replay with same idempotencyKey returns ok with no new spend row
  const replay = await client.generateAttempt(req3);
  assert.equal(replay.ok, false);
  const spendRowsAfterReplay = fake.state.ledger.filter((r) => r.kind === 'spend' && r.accountId === accountId);
  assert.equal(spendRowsAfterReplay.length, 3);
});

test('generateAttempt: insufficient balance returns insufficient_credits with balance', async () => {
  const { fake, client } = setupClient();
  await signIn(client, fake, 'poor@example.com', '444444');
  const result = await client.generateAttempt({
    idempotencyKey: 'poor-1',
    boardType: 'character',
    prompt: 'a hero',
    size: '512x512',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, 'insufficient_credits');
  assert.equal(result.error.balance, 0);
});

test('setUnavailable makes every call fail with kind unavailable', async () => {
  const { fake, client } = setupClient();
  fake.helpers.setUnavailable(true);
  const result = await client.getPricing();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, 'unavailable');
});

test('a fetch that throws yields kind unreachable', async () => {
  const tokenStore = createMemoryTokenStore();
  const throwingFetch = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  const client = createThemeServiceClient({ fetch: throwingFetch, tokenStore, endpoint: 'https://theme-service.example' });
  const result = await client.getPricing();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, 'unreachable');
});

test('a bogus token causes 401 -> not_signed_in and clears the token store', async () => {
  const endpoint = 'https://theme-service.example';
  const fake = createFakeThemeService({ endpoint });
  const tokenStore = createMemoryTokenStore('bogus-token');
  const client = createThemeServiceClient({ fetch: fake.fetch, tokenStore, endpoint });

  const result = await client.createCheckoutSession('pack_s');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, 'not_signed_in');
  assert.equal(tokenStore.value, null);
});

test('signOut clears the token store', async () => {
  const { fake, tokenStore, client } = setupClient();
  await signIn(client, fake, 'out@example.com', '555555');
  assert.notEqual(tokenStore.value, null);
  const result = await client.signOut();
  assert.equal(result.ok, true);
  assert.equal(tokenStore.value, null);
});

test('a fetch returning malformed JSON yields invalid_response', async () => {
  const tokenStore = createMemoryTokenStore();
  const malformedFetch = (async () =>
    new Response('not json{{{', { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  const client = createThemeServiceClient({ fetch: malformedFetch, tokenStore, endpoint: 'https://theme-service.example' });
  const result = await client.getPricing();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, 'invalid_response');
});

test('Authorization header carries the token and the token never appears in the request body', async () => {
  const endpoint = 'https://theme-service.example';
  const fake = createFakeThemeService({ endpoint });
  const tokenStore = createMemoryTokenStore();
  const requests: { headers: Headers; body: string }[] = [];
  const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init);
    const bodyText = init?.body ? String(init.body) : '';
    requests.push({ headers: req.headers, body: bodyText });
    return fake.fetch(input, init);
  }) as unknown as typeof fetch;
  const client = createThemeServiceClient({ fetch: wrappedFetch, tokenStore, endpoint });

  await signIn(client, fake, 'hdr@example.com', '666666');
  const token = tokenStore.value!;
  assert.ok(token);

  requests.length = 0;
  await client.getStatus();
  const statusReq = requests.find((r) => true);
  assert.ok(statusReq);
  assert.equal(statusReq!.headers.get('Authorization'), `Bearer ${token}`);
  for (const r of requests) {
    assert.doesNotMatch(r.body, new RegExp(token));
  }
});

test('getStatus with no token returns signedIn false without calling the network', async () => {
  const endpoint = 'https://theme-service.example';
  const fake = createFakeThemeService({ endpoint });
  let calls = 0;
  const countingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    return fake.fetch(input, init);
  }) as unknown as typeof fetch;
  const tokenStore = createMemoryTokenStore();
  const client = createThemeServiceClient({ fetch: countingFetch, tokenStore, endpoint });

  const status = await client.getStatus();
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.value.signedIn, false);
  assert.equal(calls, 0);
});
