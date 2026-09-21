// TycoonAgents standalone — Theme Service integration tests (p44-t4).
//
// Exercises standalone/src/themeServiceHost.mjs's createThemeServiceHost
// against test/helpers/fakeThemeService.ts (compiled to
// out/test/helpers/fakeThemeService.js), same fake used by
// test/themeServiceEndToEnd.test.ts. Most scenarios call the host factory
// directly (deterministic, no real timers, no startServer overhead); the
// sign-in round trip also runs once through server.mjs's startServer() +
// POST /message + SSE /events, proving themeServiceHostOptions/dispatch
// wiring end to end (server.mjs:3910 themeServiceHostOptions param,
// server.mjs:1237-1257 THEME_SERVICE_* dispatch cases).
//
// No real network beyond 127.0.0.1 (the Google loopback listener the host
// itself opens); no real timers beyond short awaits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createThemeServiceHost } from '../src/themeServiceHost.mjs';
import { startServer } from '../src/server.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE_THEME_SERVICE_JS = path.join(REPO_ROOT, 'out', 'test', 'helpers', 'fakeThemeService.js');
const { createFakeThemeService } = require(FAKE_THEME_SERVICE_JS);

function mkTempAppData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-themesvc-'));
}

// Collects every postStatus() payload; also spies on console output so the
// secrets test (below) can assert nothing sensitive was logged.
function makeStatusCollector() {
  const statuses = [];
  return { statuses, postStatus: (status) => statuses.push(status) };
}

function makeConsoleCapture() {
  const lines = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => {
    lines.push(args.map(String).join(' '));
  };
  console.error = (...args) => {
    lines.push(args.map(String).join(' '));
  };
  return {
    lines,
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

// Registers t.after(() => host.dispose() + temp-dir cleanup) so a test
// never leaves a real setInterval (handleBuyCredits's checkout poll) or an
// open loopback HTTP listener alive past its own test — either would keep
// the node --test process alive indefinitely (no output flush, apparent
// hang) since none of these run on injectable fake timers.
function newHost(t, fake, extra = {}) {
  const appDataDir = mkTempAppData();
  const collector = makeStatusCollector();
  const openExternalCalls = [];
  const host = createThemeServiceHost({
    appDataDir,
    fetch: fake.fetch,
    endpoint: 'https://theme-service.example',
    supabaseUrl: 'https://fake-project.supabase.co',
    supabaseAnonKey: 'anon-key',
    postStatus: collector.postStatus,
    openExternal: (url) => openExternalCalls.push(url),
    ...extra,
  });
  host.start();
  t.after(() => {
    host.dispose();
    fs.rmSync(appDataDir, { recursive: true, force: true });
  });
  return { host, appDataDir, statuses: collector.statuses, openExternalCalls };
}

function tokenFilePath(appDataDir) {
  return path.join(appDataDir, 'secrets', 'THEME_SERVICE_DEVICE_TOKEN');
}

test('sign-in round trip: magic link posts signedIn status; OPEN_THEME_BUILDER-shaped snapshot matches', async (t) => {
  const fake = createFakeThemeService();
  fake.helpers.createAccount('dev@example.com');
  fake.helpers.grant(fake.state.accountsByEmail.get('dev@example.com'), 42);
  const { host, appDataDir, statuses } = newHost(t, fake);

  await host.handleRequestMagicLink('dev@example.com');
  await host.handleVerify('dev@example.com', '123456');

  const last = statuses[statuses.length - 1];
  assert.equal(last.signedIn, true);
  assert.equal(last.email, 'dev@example.com');
  assert.equal(last.credits, 42);
  assert.ok(last.pricing, 'pricing must be attached to the status');
  assert.equal(last.pendingCheckout, false);

  const snapshot = await host.getStatusSnapshot();
  assert.equal(snapshot.signedIn, true);
  assert.equal(snapshot.email, 'dev@example.com');
  assert.equal(snapshot.credits, 42);
  assert.equal(snapshot.pendingCheckout, false);
});

test('sign-in round trip through startServer: OPEN_THEME_BUILDER replies THEME_BUILDER_OPENED with the signed-in snapshot', async () => {
  const fake = createFakeThemeService();
  fake.helpers.createAccount('panel@example.com');
  fake.helpers.grant(fake.state.accountsByEmail.get('panel@example.com'), 7);

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-themesvc-server-'));
  const appDataDir = mkTempAppData();
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: appDataDir },
    cwd: projectRoot,
    themeServiceHostOptions: {
      fetch: fake.fetch,
      endpoint: 'https://theme-service.example',
      supabaseUrl: 'https://fake-project.supabase.co',
      supabaseAnonKey: 'anon-key',
    },
  });
  const controller = new AbortController();
  try {
    const res = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
    const reader = res.body.getReader();
    let buffer = '';
    async function nextOfType(matchType, predicate = () => true, maxChunks = 100) {
      for (let i = 0; i < maxChunks; i++) {
        let sepIndex;
        while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          const dataLine = rawEvent.split('\n').find((line) => line.startsWith('data: '));
          if (dataLine) {
            const data = JSON.parse(dataLine.slice('data: '.length));
            if (data.type === matchType && predicate(data)) return data;
          }
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += Buffer.from(value).toString('utf8');
      }
      throw new Error(`no matching "${matchType}" event within ${maxChunks} reads`);
    }
    // Wait for the initial boot handshake chunk before posting.
    await reader.read();

    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
      // p67-t1: postThemeService() posts flat { type, ...fields }, not
      // { type, payload }; server.mjs's dispatch reads msg.email directly.
      body: JSON.stringify({ type: 'THEME_SERVICE_REQUEST_MAGIC_LINK', email: 'panel@example.com' }),
    });
    // handleRequestMagicLink's own postFreshStatus() lands first (signedIn
    // false — not verified yet); wait for it before sending VERIFY so the
    // two dispatch calls can't race each other on the server side (both are
    // fired with `void`, not awaited by the message handler).
    await nextOfType('THEME_SERVICE_STATUS', (d) => d.payload.signedIn === false);

    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'THEME_SERVICE_VERIFY', email: 'panel@example.com', code: '123456' }),
    });
    const signedInStatus = await nextOfType('THEME_SERVICE_STATUS', (d) => d.payload.signedIn === true);
    assert.equal(signedInStatus.payload.signedIn, true);
    assert.equal(signedInStatus.payload.email, 'panel@example.com');
    assert.equal(signedInStatus.payload.credits, 7);

    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'OPEN_THEME_BUILDER' }),
    });
    const opened = await nextOfType('THEME_BUILDER_OPENED');
    assert.equal(opened.payload.signedIn, true);
    assert.equal(opened.payload.email, 'panel@example.com');
    assert.equal(opened.payload.credits, 7);
  } finally {
    controller.abort();
    await runtime.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(appDataDir, { recursive: true, force: true });
  }
});

test('Google loopback: browserUrl redirects to 127.0.0.1:getLoopbackPort(), completing it via a real loopback GET signs in, then the listener closes', async (t) => {
  const fake = createFakeThemeService();
  const { host, appDataDir, statuses, openExternalCalls } = newHost(t, fake);

  await host.handleGoogleStart();
  assert.equal(openExternalCalls.length, 1, 'must open exactly one browser URL, never launch a real browser itself');
  const browserUrl = openExternalCalls[0];
  const port = host.getLoopbackPort();
  assert.ok(port > 0, 'a loopback listener must be open after handleGoogleStart');

  const parsedBrowserUrl = new URL(browserUrl);
  const redirectTo = parsedBrowserUrl.searchParams.get('redirect_to');
  assert.match(redirectTo, new RegExp(`^http://127\\.0\\.0\\.1:${port}/`), 'redirectTo must point at the open loopback port');

  // Simulate the browser: GET the fake's authorize URL (never a real
  // browser — this is a direct fetch against the fake's fetch-shaped
  // handler), follow its redirect to the loopback listener ourselves.
  const authorizeRes = await fake.fetch(browserUrl, { redirect: 'manual' });
  assert.ok([301, 302, 303, 307, 308].includes(authorizeRes.status), 'the fake authorize endpoint must redirect');
  const location = authorizeRes.headers.get('location');
  assert.ok(location, 'authorize response must carry a Location header with the issued code');
  const loopbackRes = await fetch(location);
  assert.equal(loopbackRes.status, 200);

  // handleGoogleComplete fires asynchronously off the loopback request;
  // poll briefly for the resulting status broadcast.
  for (let i = 0; i < 50 && statuses[statuses.length - 1]?.signedIn !== true; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const last = statuses[statuses.length - 1];
  assert.equal(last.signedIn, true, 'status after loopback completion must be signed in');

  for (let i = 0; i < 50 && host.getLoopbackPort() !== undefined; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(host.getLoopbackPort(), undefined, 'loopback listener must close after completion');
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`), 'the closed port must refuse new connections');
});

test('Google pasted-code fallback: THEME_SERVICE_GOOGLE_COMPLETE-equivalent (handleGoogleComplete) signs in without a loopback GET', async (t) => {
  const fake = createFakeThemeService();
  const { host, appDataDir, statuses, openExternalCalls } = newHost(t, fake);

  await host.handleGoogleStart();
  const browserUrl = openExternalCalls[0];

  // Visit the real browserUrl ourselves (simulating the browser tab, with
  // the host's actual PKCE code_challenge) so the fake registers a pending
  // Google auth code, then extract the issued code from the redirect
  // Location WITHOUT ever GETting the loopback listener — this exercises
  // the pasted-code fallback path (THEME_SERVICE_GOOGLE_COMPLETE) exactly
  // as handleGoogleComplete is invoked from server.mjs's
  // THEME_SERVICE_GOOGLE_COMPLETE_WIRE case.
  const authorizeRes = await fake.fetch(browserUrl, { redirect: 'manual' });
  const location = authorizeRes.headers.get('location');
  const pastedCode = new URL(location).searchParams.get('code');
  assert.ok(pastedCode, 'authorize response must carry the issued code');

  await host.handleGoogleComplete(pastedCode);

  const last = statuses[statuses.length - 1];
  assert.equal(last.signedIn, true, 'pasted-code completion must sign in identically to the loopback path');
});

// p83-t2: loopback onError/onEmpty paths (standalone/src/themeServiceHost.mjs
// startGoogleLoopbackListener onError/onEmpty callbacks) must post a visible
// status rather than leaving the modal on "waiting" forever.
test('Google loopback: a GET with ?error=access_denied posts a visible oauth_error status', async (t) => {
  const fake = createFakeThemeService();
  const { host, statuses, openExternalCalls } = newHost(t, fake);

  await host.handleGoogleStart();
  const port = host.getLoopbackPort();
  assert.ok(port > 0, 'a loopback listener must be open after handleGoogleStart');
  assert.equal(openExternalCalls.length, 1);

  const before = statuses.length;
  const res = await fetch(`http://127.0.0.1:${port}/?error=access_denied&error_description=user%40example.com%20leaked`);
  assert.equal(res.status, 200);

  for (let i = 0; i < 50 && statuses.length === before; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const last = statuses[statuses.length - 1];
  assert.equal(last.signedIn, false);
  assert.equal(last.error?.kind, 'oauth_error');
  assert.ok(last.error?.message.includes('access_denied'), `expected access_denied in message: ${last.error?.message}`);
  const dump = JSON.stringify(statuses);
  assert.ok(!dump.includes('leaked'), 'error_description text must never be posted');
});

test('Google loopback: a GET with neither code nor error posts a visible status instead of leaving the modal waiting', async (t) => {
  const fake = createFakeThemeService();
  const { host, statuses } = newHost(t, fake);

  await host.handleGoogleStart();
  const port = host.getLoopbackPort();
  assert.ok(port > 0);

  const before = statuses.length;
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);

  for (let i = 0; i < 50 && statuses.length === before; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(statuses.length > before, 'a no-usable-params callback while pending must post a visible status, not stay silent');
  const last = statuses[statuses.length - 1];
  assert.equal(last.signedIn, false);
  assert.ok(last.error, 'should carry a visible error rather than leaving the caller to infer failure');
});

// p65-t4: standalone equivalents of the VS Code host's handleGoogleOpen
// no-op/pending coverage (src/host/vscode/themeServiceHost.ts ~422).
test('handleGoogleOpen: no-ops (opens nothing) when there is no pending Google browser URL', async (t) => {
  const fake = createFakeThemeService();
  const { host, openExternalCalls } = newHost(t, fake);
  await host.handleGoogleOpen();
  assert.equal(openExternalCalls.length, 0);
});

test('handleGoogleOpen: re-opens the exact URL stored from the matching handleGoogleStart, ignoring any caller-supplied argument', async (t) => {
  const fake = createFakeThemeService();
  const { host, openExternalCalls } = newHost(t, fake);
  await host.handleGoogleStart();
  assert.equal(openExternalCalls.length, 1);
  const storedUrl = openExternalCalls[0];
  // handleGoogleOpen takes no url argument at all — passing one here proves
  // it is ignored (a webview-supplied payload is advisory only per p65-t2).
  await host.handleGoogleOpen('https://attacker.example/not-the-real-url');
  assert.equal(openExternalCalls.length, 2);
  assert.equal(openExternalCalls[1], storedUrl);
});

// p66-t2: review fix ordering — {signedIn:false, browserUrl} is posted
// BEFORE openExternal is invoked, and success posts nothing further.
test('handleGoogleStart: posts {signedIn:false, browserUrl} before openExternal, nothing further on success', async (t) => {
  const fake = createFakeThemeService();
  const { host, statuses, openExternalCalls } = newHost(t, fake);
  await host.handleGoogleStart();
  assert.equal(openExternalCalls.length, 1);
  assert.equal(statuses.length, 1, 'success path must post exactly once (the pre-await post)');
  assert.equal(statuses[0].signedIn, false);
  assert.equal(statuses[0].browserUrl, openExternalCalls[0]);
  assert.equal(statuses[0].error, undefined);
});

test('handleGoogleStart: openExternal throwing posts browser_open_failed with the fixed scrubbed message', async (t) => {
  const fake = createFakeThemeService();
  const appDataDir = mkTempAppData();
  const collector = makeStatusCollector();
  const host = createThemeServiceHost({
    appDataDir,
    fetch: fake.fetch,
    endpoint: 'https://theme-service.example',
    supabaseUrl: 'https://fake-project.supabase.co',
    supabaseAnonKey: 'anon-key',
    postStatus: collector.postStatus,
    openExternal: () => {
      throw new Error('no browser available');
    },
  });
  host.start();
  t.after(() => {
    host.dispose();
    fs.rmSync(appDataDir, { recursive: true, force: true });
  });
  await host.handleGoogleStart();
  const last = collector.statuses[collector.statuses.length - 1];
  assert.equal(last.signedIn, false);
  assert.equal(last.error?.kind, 'browser_open_failed');
  assert.match(last.error?.message, /^couldn't open the browser for sign-in \(Error\)$/);
});

test('handleGoogleStart/handleGoogleOpen: log lines carry the Supabase host, never code_challenge/query/tokens, and console output has no leak', async (t) => {
  const fake = createFakeThemeService();
  const appDataDir = mkTempAppData();
  const consoleCapture = makeConsoleCapture();
  const collector = makeStatusCollector();
  const logLines = [];
  const openExternalCalls = [];
  const host = createThemeServiceHost({
    appDataDir,
    fetch: fake.fetch,
    endpoint: 'https://theme-service.example',
    supabaseUrl: 'https://fake-project.supabase.co',
    supabaseAnonKey: 'anon-key',
    postStatus: collector.postStatus,
    openExternal: (url) => openExternalCalls.push(url),
    log: (msg) => logLines.push(msg),
  });
  host.start();
  t.after(() => {
    consoleCapture.restore();
    host.dispose();
    fs.rmSync(appDataDir, { recursive: true, force: true });
  });
  try {
    await host.handleGoogleStart();
    await host.handleGoogleOpen();
  } finally {
    consoleCapture.restore();
  }
  assert.ok(logLines.length > 0, 'expected log lines to be captured');
  const joined = logLines.join('\n');
  assert.ok(joined.includes('fake-project.supabase.co'), 'log lines should mention the Supabase host');
  for (const line of logLines) {
    assert.ok(!line.includes('code_challenge'), `log line must not contain code_challenge: ${line}`);
    assert.ok(!line.includes('?'), `log line must not contain a query string: ${line}`);
  }
  for (const line of consoleCapture.lines) {
    assert.ok(!line.includes('code_challenge'), `console output must not contain code_challenge: ${line}`);
  }
});

test('balance and buy: BUY_CREDITS opens checkout, status shows pendingCheckout true, completeCheckout raises the balance', async (t) => {
  const fake = createFakeThemeService();
  fake.helpers.createAccount('buyer@example.com');
  const { host, appDataDir, statuses, openExternalCalls } = newHost(t, fake);

  await host.handleRequestMagicLink('buyer@example.com');
  await host.handleVerify('buyer@example.com', '123456');
  const beforeCredits = statuses[statuses.length - 1].credits;
  assert.equal(beforeCredits, 0);

  await host.handleBuyCredits('starter45');
  assert.equal(openExternalCalls.length, 1);
  const checkoutUrl = openExternalCalls[0];
  assert.match(checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);
  const pendingStatus = statuses[statuses.length - 1];
  assert.equal(pendingStatus.pendingCheckout, true);

  const sessionId = checkoutUrl.split('/').pop();
  const ledgerRow = fake.helpers.completeCheckout(sessionId);
  assert.ok(ledgerRow, 'fake completeCheckout must find the pending session');

  const snapshotAfter = await host.getStatusSnapshot();
  assert.equal(snapshotAfter.credits, 45, 'balance must reflect the completed checkout (starter45 pack)');
});

test('generate debits per attempt via client.generateAttempt; failNextGenerate refunds with error_kind; insufficient credits reports error_kind insufficient_credits', async (t) => {
  const fake = createFakeThemeService();
  const accountId = fake.helpers.createAccount('gen@example.com').id;
  fake.helpers.grant(accountId, 5);
  const { host, appDataDir } = newHost(t, fake);
  try {
    await host.handleRequestMagicLink('gen@example.com');
    await host.handleVerify('gen@example.com', '123456');
    const client = host.getClient();

    const objectsCost = fake.state.pricing.attemptCostByBoardType.objects_01;
    const before = (await client.getStatus()).value.credits;
    const ok = await client.generateAttempt({
      idempotencyKey: 'attempt-1',
      boardType: 'objects_01',
      input: {},
    });
    assert.equal(ok.ok, true, 'first generate attempt must succeed');
    const afterOk = (await client.getStatus()).value.credits;
    assert.equal(before - afterOk, objectsCost, 'balance must debit exactly attemptCostByBoardType.objects_01');

    fake.helpers.failNextGenerate();
    const beforeFail = afterOk;
    const failed = await client.generateAttempt({
      idempotencyKey: 'attempt-2',
      boardType: 'objects_01',
      input: {},
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.error.kind, 'provider_failed');
    assert.equal(failed.error.refunded, true);
    const afterFail = (await client.getStatus()).value.credits;
    assert.equal(afterFail, beforeFail, 'a refunded failed attempt must leave the balance unchanged (debit then refund nets to zero)');

    // Drain remaining credits (down to less than one attempt's cost), then
    // attempt with insufficient balance left.
    while ((await client.getStatus()).value.credits >= objectsCost) {
      const key = `drain-${(await client.getStatus()).value.credits}`;
      // eslint-disable-next-line no-await-in-loop
      await client.generateAttempt({ idempotencyKey: key, boardType: 'objects_01', input: {} });
    }
    const insufficient = await client.generateAttempt({
      idempotencyKey: 'attempt-insufficient',
      boardType: 'objects_01',
      input: {},
    });
    assert.equal(insufficient.ok, false);
    assert.equal(insufficient.error.kind, 'insufficient_credits');
  } finally {
    fs.rmSync(appDataDir, { recursive: true, force: true });
  }
});

test('re-slice from raw makes no Theme Service call', async (t) => {
  const fake = createFakeThemeService();
  const accountId = fake.helpers.createAccount('reslice@example.com').id;
  fake.helpers.grant(accountId, 10);
  const { host, appDataDir } = newHost(t, fake);
  try {
    await host.handleRequestMagicLink('reslice@example.com');
    await host.handleVerify('reslice@example.com', '123456');

    const { resliceThemeImageFromRaw, configureThemeFileStore } = await import('../src/themeGenerationBridge.mjs');
    const { createFsThemeFileStore } = await import('../src/themeFileStoreFs.mjs');
    const themeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-reslice-'));
    const store = createFsThemeFileStore(themeRoot);
    configureThemeFileStore(store);

    const requestsBefore = fake.state.generateRequests.length + fake.state.planRequests.length;
    const result = await resliceThemeImageFromRaw('theme-store-root', 'nonexistent-theme', 'item-1');
    assert.equal(result.ok, false, 'reslicing a nonexistent theme item must fail locally (no such theme on disk)');
    const requestsAfter = fake.state.generateRequests.length + fake.state.planRequests.length;
    assert.equal(requestsAfter, requestsBefore, 're-slice-from-raw must never call the Theme Service');

    fs.rmSync(themeRoot, { recursive: true, force: true });
  } finally {
    fs.rmSync(appDataDir, { recursive: true, force: true });
  }
});

test('secrets: no broadcast payload or console output ever contains the fake-issued access/refresh tokens', async (t) => {
  const fake = createFakeThemeService();
  fake.helpers.createAccount('secret@example.com');
  fake.helpers.grant(fake.state.accountsByEmail.get('secret@example.com'), 10);
  const { host, appDataDir, statuses, openExternalCalls } = newHost(t, fake);

  const capture = makeConsoleCapture();
  try {
    await host.handleRequestMagicLink('secret@example.com');
    await host.handleVerify('secret@example.com', '123456');
    await host.handleBuyCredits('starter45');
    await host.handleGoogleStart();
    await host.handleSignOut();
  } finally {
    capture.restore();
  }

  const issuedTokens = [...fake.state.accessTokens.keys(), ...fake.state.refreshTokens.keys()];
  assert.ok(issuedTokens.length > 0, 'the fake must have issued at least one token during this run');

  const statusText = JSON.stringify(statuses);
  const openText = openExternalCalls.join('\n');
  const consoleText = capture.lines.join('\n');
  for (const token of issuedTokens) {
    assert.ok(!statusText.includes(token), `postStatus payloads must never contain token ${token}`);
    assert.ok(!openText.includes(token), `openExternal URLs must never contain token ${token}`);
    assert.ok(!consoleText.includes(token), `console output must never contain token ${token}`);
  }
});

test('token file: exists after sign-in under app-data secrets/, is owner-only on posix, cleared after sign-out', async (t) => {
  const fake = createFakeThemeService();
  fake.helpers.createAccount('token@example.com');
  const { host, appDataDir } = newHost(t, fake);

  const file = tokenFilePath(appDataDir);
  assert.equal(fs.existsSync(file), false, 'no token file before sign-in');

  await host.handleRequestMagicLink('token@example.com');
  await host.handleVerify('token@example.com', '123456');
  assert.equal(fs.existsSync(file), true, 'token file must exist after sign-in');

  if (process.platform === 'win32') {
    console.log('[themeServiceStandalone.test.mjs] skipping 0o600 mode assertion on win32 (POSIX-only)');
  } else {
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, 'token file must be owner-read/write only');
  }

  await host.handleSignOut();
  assert.equal(fs.existsSync(file), false, 'token file must be cleared after sign-out');
});

// p46-t5: content screening / strikes / account lock via the standalone
// host + fake (lockAccount/blockNextPrompt added in 9387e21).
test('status carries locked/strikes after lockAccount; generateAttempt while locked returns account_locked; blockNextPrompt leaves the balance unchanged', async (t) => {
  const fake = createFakeThemeService();
  const accountId = fake.helpers.createAccount('locked-standalone@example.com').id;
  fake.helpers.grant(accountId, 10);
  const { host, statuses } = newHost(t, fake);

  await host.handleRequestMagicLink('locked-standalone@example.com');
  await host.handleVerify('locked-standalone@example.com', '123456');
  const client = host.getClient();

  fake.helpers.lockAccount('locked-standalone@example.com');
  statuses.length = 0;
  await host.handleGetStatus();
  const lockedStatus = statuses[statuses.length - 1];
  assert.equal(lockedStatus.locked, true);
  assert.equal(typeof lockedStatus.strikes, 'number');

  const lockedAttempt = await client.generateAttempt({
    idempotencyKey: 'locked-attempt-1',
    boardType: 'objects_01',
    input: {},
  });
  assert.equal(lockedAttempt.ok, false);
  assert.equal(lockedAttempt.error.kind, 'account_locked');

  fake.helpers.unlockAccount('locked-standalone@example.com');
  const beforeBlock = (await client.getStatus()).value.credits;
  fake.helpers.blockNextPrompt();
  const blocked = await client.generateAttempt({
    idempotencyKey: 'blocked-attempt-1',
    boardType: 'objects_01',
    input: {},
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.kind, 'content_blocked');
  const afterBlock = (await client.getStatus()).value.credits;
  assert.equal(afterBlock, beforeBlock, 'a blocked prompt must never change the balance');
});

// p62-t3: device-state file location + Google-loopback notifySignInSucceeded wiring.

test('referral: device-state file is created under the app-data root (not the project) on first sign-in', async (t) => {
  const fake = createFakeThemeService();
  fake.helpers.createAccount('devicestate@example.com');
  const { host, appDataDir } = newHost(t, fake);

  const stateFile = path.join(appDataDir, 'theme-service-device-state.json');
  assert.equal(fs.existsSync(stateFile), false, 'device-state file must not exist before any sign-in');

  await host.handleRequestMagicLink('devicestate@example.com');
  await host.handleVerify('devicestate@example.com', '123456');

  assert.ok(fs.existsSync(stateFile), 'device-state file must exist under appDataDir after first sign-in');
  assert.ok(
    path.resolve(stateFile).startsWith(path.resolve(appDataDir)),
    'device-state file must live under the app-data root',
  );
  assert.equal(
    path.resolve(stateFile).startsWith(path.resolve(process.cwd())),
    false,
    'device-state file must not land in the project working directory',
  );
  const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(parsed.hasSignedIn, true);
});

// The outer standalone host object (themeServiceHost.mjs:298-315) does not
// re-expose notifySignInSucceeded, so it cannot be stubbed/spied from
// outside the module (see report open issues). This instead observes its
// one side effect through the device-state file it writes via
// deviceState.markSignedIn() (module doc at themeServiceHost.mjs:255-262:
// the Google-loopback path calls inner.notifySignInSucceeded() explicitly
// because it bypasses inner.handleGoogleComplete).
test('referral: Google-loopback completion runs the first-sign-in bookkeeping exactly once (observed via the device-state file)', async (t) => {
  const fake = createFakeThemeService();
  const { host, appDataDir, statuses, openExternalCalls } = newHost(t, fake);
  const stateFile = path.join(appDataDir, 'theme-service-device-state.json');

  assert.equal(fs.existsSync(stateFile), false, 'no device-state file before any sign-in');

  await host.handleGoogleStart();
  const browserUrl = openExternalCalls[0];
  const authorizeRes = await fake.fetch(browserUrl, { redirect: 'manual' });
  const location = authorizeRes.headers.get('location');
  const loopbackRes = await fetch(location);
  assert.equal(loopbackRes.status, 200);

  for (let i = 0; i < 50 && statuses[statuses.length - 1]?.signedIn !== true; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(statuses[statuses.length - 1]?.signedIn, true);

  assert.ok(fs.existsSync(stateFile), 'device-state file must exist after the loopback completes signed-in');
  const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(parsed.hasSignedIn, true, 'markSignedIn must have run exactly once via notifySignInSucceeded');
});

// p64-t2: THEME_SERVICE_ENDPOINT env var (read when opts.endpoint is not
// explicitly supplied — themeServiceHost.mjs:205) plumbed through
// resolveThemeServiceEndpoint() into getEffectiveEndpointHost() / the
// endpointHost field on postStatus() payloads.

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

test('env: THEME_SERVICE_ENDPOINT is honored when opts.endpoint is not supplied', async (t) => {
  await withEnv('THEME_SERVICE_ENDPOINT', 'https://override.example.com/', async () => {
    const appDataDir = mkTempAppData();
    const collector = makeStatusCollector();
    const host = createThemeServiceHost({
      appDataDir,
      fetch: async () => {
        throw new Error('no network expected in this test');
      },
      supabaseUrl: 'https://fake-project.supabase.co',
      supabaseAnonKey: 'anon-key',
      postStatus: collector.postStatus,
      openExternal: () => {},
    });
    t.after(() => {
      host.dispose();
      fs.rmSync(appDataDir, { recursive: true, force: true });
    });
    assert.equal(host.getEffectiveEndpointHost(), 'override.example.com');
    const snapshot = await host.getStatusSnapshot();
    assert.equal(snapshot.endpointHost, 'override.example.com');
  });
});

test('env: invalid THEME_SERVICE_ENDPOINT falls back to production, endpointHost stays undefined', async (t) => {
  await withEnv('THEME_SERVICE_ENDPOINT', 'not-a-url', async () => {
    const appDataDir = mkTempAppData();
    const collector = makeStatusCollector();
    const host = createThemeServiceHost({
      appDataDir,
      fetch: async () => {
        throw new Error('no network expected in this test');
      },
      supabaseUrl: 'https://fake-project.supabase.co',
      supabaseAnonKey: 'anon-key',
      postStatus: collector.postStatus,
      openExternal: () => {},
    });
    t.after(() => {
      host.dispose();
      fs.rmSync(appDataDir, { recursive: true, force: true });
    });
    assert.equal(host.getEffectiveEndpointHost(), undefined);
    const snapshot = await host.getStatusSnapshot();
    assert.equal(snapshot.endpointHost, undefined);
  });
});

// p67-t2: proves handleBrowserMessage's THEME_SERVICE_* cases read email/
// code/pack off the flat message (server.mjs:663-667 themeServicePayload =
// msg), not a nested `payload` — and that a nested-payload message is
// rejected as missing the field, which is what would have caught the p67-t1
// bug before it was fixed.
async function newServerWithFakeAccount(email) {
  const fake = createFakeThemeService();
  fake.helpers.createAccount(email);
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-themesvc-flatbuy-'));
  const appDataDir = mkTempAppData();
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: appDataDir },
    cwd: projectRoot,
    themeServiceHostOptions: {
      fetch: fake.fetch,
      endpoint: 'https://theme-service.example',
      supabaseUrl: 'https://fake-project.supabase.co',
      supabaseAnonKey: 'anon-key',
    },
  });
  return {
    fake,
    runtime,
    cleanup: async () => {
      await runtime.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(appDataDir, { recursive: true, force: true });
    },
  };
}

async function readSse(runtime) {
  const controller = new AbortController();
  const res = await fetch(`${runtime.url}/events?token=${runtime.sessionToken}`, { signal: controller.signal });
  const reader = res.body.getReader();
  let buffer = '';
  async function nextOfType(matchType, predicate = () => true, maxChunks = 100) {
    for (let i = 0; i < maxChunks; i++) {
      let sepIndex;
      while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        const dataLine = rawEvent.split('\n').find((line) => line.startsWith('data: '));
        if (dataLine) {
          const data = JSON.parse(dataLine.slice('data: '.length));
          if (data.type === matchType && predicate(data)) return data;
        }
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += Buffer.from(value).toString('utf8');
    }
    return undefined;
  }
  await reader.read(); // boot handshake
  return { nextOfType, abort: () => controller.abort() };
}

test('dispatch: THEME_SERVICE_BUY_CREDITS reads pack from the flat message and starts checkout', async () => {
  const { fake, runtime, cleanup } = await newServerWithFakeAccount('flatbuy@example.com');
  try {
    const sse = await readSse(runtime);
    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'THEME_SERVICE_REQUEST_MAGIC_LINK', email: 'flatbuy@example.com' }),
    });
    await sse.nextOfType('THEME_SERVICE_STATUS', (d) => d.payload.signedIn === false);
    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'THEME_SERVICE_VERIFY', email: 'flatbuy@example.com', code: '123456' }),
    });
    await sse.nextOfType('THEME_SERVICE_STATUS', (d) => d.payload.signedIn === true);

    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'THEME_SERVICE_BUY_CREDITS', pack: 'starter45' }),
    });
    const pending = await sse.nextOfType('THEME_SERVICE_STATUS', (d) => d.payload.pendingCheckout === true);
    assert.ok(pending, 'flat `pack` field must reach handleBuyCredits and start a real checkout (pendingCheckout true)');
    sse.abort();
  } finally {
    await cleanup();
  }
});

test('dispatch: a nested { payload: { pack } } message (the old, broken shape) is dropped as missing pack, never starting checkout', async () => {
  const { runtime, cleanup } = await newServerWithFakeAccount('nestedbuy@example.com');
  try {
    const sse = await readSse(runtime);
    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'THEME_SERVICE_REQUEST_MAGIC_LINK', email: 'nestedbuy@example.com' }),
    });
    await sse.nextOfType('THEME_SERVICE_STATUS', (d) => d.payload.signedIn === false);
    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'THEME_SERVICE_VERIFY', email: 'nestedbuy@example.com', code: '123456' }),
    });
    await sse.nextOfType('THEME_SERVICE_STATUS', (d) => d.payload.signedIn === true);

    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'THEME_SERVICE_BUY_CREDITS', payload: { pack: 'starter45' } }),
    });
    const pending = await sse.nextOfType('THEME_SERVICE_STATUS', (d) => d.payload.pendingCheckout === true, 15);
    assert.equal(pending, undefined, 'a nested payload.pack must NOT reach handleBuyCredits — proves the flat-read is load-bearing');
    sse.abort();
  } finally {
    await cleanup();
  }
});

// ── p75-t3: builder-first open flow — OPEN_THEME_BUILDER never awaits a
// network call, THEME_BUILDER_CLOSED cancels the background retry, and
// requestThemeServiceStatus re-triggers it ──────────────────────────────────

function neverResolvingFetch(matchPath, fallback) {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes(matchPath)) {
      return new Promise((_resolve, reject) => {
        const signal = init && init.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }
    return fallback(input, init);
  };
}

test('OPEN_THEME_BUILDER: THEME_BUILDER_OPENED arrives before the /api/account call resolves (no client call awaited)', async () => {
  const fake = createFakeThemeService();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-themesvc-openflow-'));
  const appDataDir = mkTempAppData();
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: appDataDir },
    cwd: projectRoot,
    themeServiceHostOptions: {
      // /api/account (getStatus) never resolves — proves OPEN_THEME_BUILDER's
      // THEME_BUILDER_OPENED reply cannot be waiting on it.
      fetch: neverResolvingFetch('/api/account', fake.fetch),
      endpoint: 'https://theme-service.example',
      supabaseUrl: 'https://fake-project.supabase.co',
      supabaseAnonKey: 'anon-key',
    },
  });
  try {
    const sse = await readSse(runtime);
    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'OPEN_THEME_BUILDER' }),
    });
    const opened = await nextWithRaceTimeout(sse, 'THEME_BUILDER_OPENED', 5_000);
    assert.ok(opened, 'THEME_BUILDER_OPENED must arrive promptly, without waiting on the hung /api/account call');
    assert.equal(opened.payload.signedIn, false);
    assert.equal(opened.payload.pending, true, 'no snapshot has ever resolved yet, so pending:true');
    sse.abort();
  } finally {
    await runtime.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(appDataDir, { recursive: true, force: true });
  }
});

// nextOfType returns undefined only after exhausting maxChunks reads, which
// can itself take a while against a real (never-resolving) SSE stream if
// nothing else is pushed; race it against a short real-timer deadline so a
// regression (an accidental await on the hung fetch) fails fast instead of
// hanging the whole run.
async function nextWithRaceTimeout(sse, matchType, ms) {
  return Promise.race([
    sse.nextOfType(matchType, () => true, 5),
    new Promise((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

test('THEME_BUILDER_CLOSED cancels the background retry; requestThemeServiceStatus re-triggers it', async () => {
  const fake = createFakeThemeService();
  fake.helpers.createAccount('closedflow@example.com');
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-themesvc-closedflow-'));
  const appDataDir = mkTempAppData();
  // Every /api/account and /api/pricing call fails with 503 ("waking") once
  // signed in, which would otherwise schedule an internal retry timer.
  let signedIn = false;
  const flakyFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (signedIn && (url.includes('/api/account') || url.includes('/api/pricing'))) {
      return new Response(JSON.stringify({ error: 'service unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return fake.fetch(input, init);
  };
  const runtime = await startServer({
    argv: [projectRoot],
    env: { TYCOON_STANDALONE_PORT: '0', TYCOON_STANDALONE_DATA_DIR: appDataDir },
    cwd: projectRoot,
    themeServiceHostOptions: {
      fetch: flakyFetch,
      endpoint: 'https://theme-service.example',
      supabaseUrl: 'https://fake-project.supabase.co',
      supabaseAnonKey: 'anon-key',
    },
  });
  try {
    const sse = await readSse(runtime);
    // Sign in first (magic-link auth endpoints are never intercepted by
    // flakyFetch), so the subsequent /api/account call has a session to send
    // and actually reaches (and is failed by) flakyFetch.
    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'THEME_SERVICE_REQUEST_MAGIC_LINK', email: 'closedflow@example.com' }),
    });
    await sse.nextOfType('THEME_SERVICE_STATUS', (d) => d.payload.signedIn === false);
    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'THEME_SERVICE_VERIFY', email: 'closedflow@example.com', code: '123456' }),
    });
    await sse.nextOfType('THEME_SERVICE_STATUS', (d) => d.payload.signedIn === true);
    signedIn = true;

    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'OPEN_THEME_BUILDER' }),
    });
    const opened = await sse.nextOfType('THEME_BUILDER_OPENED');
    assert.ok(opened, 'expected THEME_BUILDER_OPENED');
    const waking = await sse.nextOfType('THEME_SERVICE_STATUS', (d) => d.payload.error && d.payload.error.kind === 'waking', 20);
    assert.ok(waking, 'expected the background refresh to post a waking status');

    // Cancel the retry — a bare-message THEME_BUILDER_CLOSED (empty payload).
    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'THEME_BUILDER_CLOSED' }),
    });

    // requestThemeServiceStatus re-triggers a fresh background refresh, which
    // posts another waking status — proving cancel actually stopped the
    // scheduled retry rather than it merely coinciding with a later post.
    await fetch(`${runtime.url}/message`, {
      method: 'POST',
      headers: { 'X-Tycoon-Token': runtime.sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'requestThemeServiceStatus' }),
    });
    const wakingAgain = await sse.nextOfType('THEME_SERVICE_STATUS', (d) => d.payload.error && d.payload.error.kind === 'waking', 20);
    assert.ok(wakingAgain, 'requestThemeServiceStatus must re-trigger a background refresh after THEME_BUILDER_CLOSED cancelled the prior one');
    sse.abort();
  } finally {
    await runtime.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(appDataDir, { recursive: true, force: true });
  }
});

test('env: THEME_SERVICE_ENDPOINT unset falls back to production, endpointHost stays undefined', async (t) => {
  await withEnv('THEME_SERVICE_ENDPOINT', undefined, async () => {
    const appDataDir = mkTempAppData();
    const collector = makeStatusCollector();
    const host = createThemeServiceHost({
      appDataDir,
      fetch: async () => {
        throw new Error('no network expected in this test');
      },
      supabaseUrl: 'https://fake-project.supabase.co',
      supabaseAnonKey: 'anon-key',
      postStatus: collector.postStatus,
      openExternal: () => {},
    });
    t.after(() => {
      host.dispose();
      fs.rmSync(appDataDir, { recursive: true, force: true });
    });
    assert.equal(host.getEffectiveEndpointHost(), undefined);
  });
});
