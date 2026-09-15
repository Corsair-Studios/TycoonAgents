import { test } from "node:test";
import assert from "node:assert/strict";
import { createThemeServiceClient, ThemeServiceTokenStore } from "../src/core/themeServiceClient";
import { createFakeThemeService } from "./helpers/fakeThemeService";
import { createThemeServiceHost, type ThemeServiceHostStatus } from "../src/host/vscode/themeServiceHost";

const ENDPOINT = "https://theme-service.example";
const SUPABASE_URL = "https://fake-project.supabase.co";

function createMemoryTokenStore(): ThemeServiceTokenStore {
  let value: string | null = null;
  return {
    async get() {
      return value;
    },
    async set(token: string) {
      value = token;
    },
    async clear() {
      value = null;
    },
  };
}

function fakeTimers() {
  const handles = new Map<number, { fn: () => void; ms: number }>();
  let nextHandle = 1;
  return {
    setInterval(fn: () => void, ms: number): number {
      const h = nextHandle++;
      handles.set(h, { fn, ms });
      return h;
    },
    clearInterval(h: unknown): void {
      handles.delete(h as number);
    },
    tick(): void {
      for (const { fn } of Array.from(handles.values())) fn();
    },
    activeCount(): number {
      return handles.size;
    },
  };
}

function setup(nowFn?: () => number) {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL, now: nowFn });
  const tokenStore = createMemoryTokenStore();
  const client = createThemeServiceClient({
    fetch: fake.fetch,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    now: nowFn,
    createCodeVerifier: () => "fixed-test-verifier",
  });
  const posted: ThemeServiceHostStatus[] = [];
  const opened: string[] = [];
  const timers = fakeTimers();
  let now = nowFn ? nowFn() : Date.now();
  const host = createThemeServiceHost({
    secrets: {} as any,
    client,
    openExternal: (url) => {
      opened.push(url);
    },
    postStatus: (status) => {
      posted.push(status);
    },
    now: () => now,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  host.start();
  return { fake, client, posted, opened, timers, host, advanceTime: (ms: number) => (now += ms) };
}

function assertNoTokenLeak(posted: ThemeServiceHostStatus[]): void {
  for (const p of posted) {
    const json = JSON.stringify(p);
    assert.ok(!json.includes("accessToken"), "posted payload must not contain accessToken");
    assert.ok(!json.includes("refreshToken"), "posted payload must not contain refreshToken");
  }
}

test("GET_STATUS when signed out posts signedIn:false", async () => {
  const { host, posted } = setup();
  await host.handleGetStatus();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].signedIn, false);
  assertNoTokenLeak(posted);
});

test("magic link request + verify posts signedIn true with email/credits", async () => {
  const { host, posted } = setup();
  await host.handleRequestMagicLink("me@example.com");
  await host.handleVerify("me@example.com", "123456");
  const last = posted[posted.length - 1];
  assert.equal(last.signedIn, true);
  assert.equal(last.email, "me@example.com");
  assert.equal(typeof last.credits, "number");
  assertNoTokenLeak(posted);
});

test("Google start opens browser URL, complete via code yields signedIn", async () => {
  const { fake, host, posted, opened } = setup();
  await host.handleGoogleStart();
  assert.equal(opened.length, 1);
  assert.ok(opened[0].includes("code_challenge="));
  // Simulate the browser visiting the authorize URL (GoTrue redirects with ?code=).
  await fake.fetch(opened[0]);
  const authCode = await fake.helpers.completeGoogleInBrowser();
  await host.handleUriCallback(authCode);
  const last = posted[posted.length - 1];
  assert.equal(last.signedIn, true);
  assertNoTokenLeak(posted);
});

test("Google pasted-code fallback completes sign-in the same way", async () => {
  const { fake, host, posted, opened } = setup();
  await host.handleGoogleStart();
  await fake.fetch(opened[0]);
  const authCode = await fake.helpers.completeGoogleInBrowser();
  await host.handleGoogleComplete(authCode);
  const last = posted[posted.length - 1];
  assert.equal(last.signedIn, true);
  assertNoTokenLeak(posted);
});

test("BUY_CREDITS opens checkout URL and polling stops after credits rise", async () => {
  const now = 1_000_000;
  const { fake, host, posted, opened, timers, advanceTime } = setup(() => now);
  // sign in first
  await host.handleRequestMagicLink("buyer@example.com");
  await host.handleVerify("buyer@example.com", "123456");
  posted.length = 0;

  await host.handleBuyCredits("starter45");
  assert.equal(opened.length, 1);
  assert.ok(opened[0].startsWith("https://checkout.stripe.com/"));
  assert.equal(timers.activeCount(), 1);

  // simulate the checkout completing externally, then tick the poll
  const sessionId = opened[0].split("/").pop()!;
  fake.helpers.completeCheckout(sessionId);
  advanceTime(5_000);
  await timers.tick();
  // allow the async pollTick's awaited getStatus to resolve before asserting
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(timers.activeCount(), 0, "poll must stop once credits rose");
  assertNoTokenLeak(posted);
});

test("SIGN_OUT posts signedIn false", async () => {
  const { fake, host, posted } = setup();
  await host.handleRequestMagicLink("out@example.com");
  await host.handleVerify("out@example.com", "123456");
  posted.length = 0;
  await host.handleSignOut();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].signedIn, false);
  assertNoTokenLeak(posted);
});

test("dispose clears timers", async () => {
  const now = 1_000_000;
  const { fake, host, timers, advanceTime } = setup(() => now);
  await host.handleRequestMagicLink("d@example.com");
  await host.handleVerify("d@example.com", "123456");
  await host.handleBuyCredits("starter45");
  assert.equal(timers.activeCount(), 1);
  host.dispose();
  assert.equal(timers.activeCount(), 0);
  void advanceTime;
});

test("pending-checkout polling stops on dispose and posts nothing further", async () => {
  const now = 1_000_000;
  const { host, posted, timers, advanceTime } = setup(() => now);
  await host.handleRequestMagicLink("stopper@example.com");
  await host.handleVerify("stopper@example.com", "123456");
  await host.handleBuyCredits("starter45");
  assert.equal(timers.activeCount(), 1);

  host.dispose();
  posted.length = 0;
  advanceTime(60_000);
  await timers.tick(); // no-op: dispose() cleared the handle map
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(timers.activeCount(), 0, "poll handle must be gone after dispose");
  assert.equal(posted.length, 0, "no further status should post once disposed");
});

test("posted payloads never contain accessToken/refreshToken across the full sign-in + checkout flow", async () => {
  const now = 1_000_000;
  const { fake, host, posted, opened, timers, advanceTime } = setup(() => now);
  await host.handleGetStatus();
  await host.handleRequestMagicLink("secure@example.com");
  await host.handleVerify("secure@example.com", "123456");
  await host.handleGoogleStart();
  await fake.fetch(opened[opened.length - 1]);
  const authCode = await fake.helpers.completeGoogleInBrowser();
  await host.handleGoogleComplete(authCode);
  await host.handleBuyCredits("starter45");
  advanceTime(5_000);
  await timers.tick();
  await new Promise((r) => setTimeout(r, 0));
  await host.handleSignOut();

  assert.ok(posted.length > 0);
  assertNoTokenLeak(posted);
});

// onDidChangeViewState wiring (src/host/vscode/panel.ts ~958-964) refreshes
// status whenever the webview panel becomes visible again. panel.ts is a
// vscode-dependent host file not importable in this unit-test harness, so
// this is a source guard on the exact wiring rather than a live mock —
// guards against the visible-refresh call being dropped or misplaced.
// p46-t5: THEME_SERVICE_STATUS carries locked/strikes; a checkout attempt
// while locked posts account_locked without starting the pending-checkout poll.
test("THEME_SERVICE_STATUS payload carries locked and strikes", async () => {
  const { fake, host, posted } = setup();
  await host.handleRequestMagicLink("locked@example.com");
  await host.handleVerify("locked@example.com", "123456");
  fake.helpers.lockAccount("locked@example.com");
  posted.length = 0;
  await host.handleGetStatus();
  const last = posted[posted.length - 1];
  assert.equal(last.locked, true);
  assert.equal(typeof last.strikes, "number");
  assertNoTokenLeak(posted);
});

test("BUY_CREDITS while locked posts account_locked with pendingCheckout false", async () => {
  const { fake, host, posted, timers } = setup();
  await host.handleRequestMagicLink("lockedbuyer@example.com");
  await host.handleVerify("lockedbuyer@example.com", "123456");
  fake.helpers.lockAccount("lockedbuyer@example.com");
  posted.length = 0;
  await host.handleBuyCredits("starter45");
  const last = posted[posted.length - 1];
  assert.equal(last.error?.kind, "account_locked");
  assert.equal(last.pendingCheckout, false);
  assert.equal(timers.activeCount(), 0, "a locked checkout attempt must never start the pending-checkout poll");
  assertNoTokenLeak(posted);
});

test("panel.ts wires onDidChangeViewState(visible) to themeServiceHost.handleGetStatus", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src: string = fs.readFileSync(
    path.join(process.cwd(), "src", "host", "vscode", "panel.ts"),
    "utf8",
  );
  const idx = src.indexOf("onDidChangeViewState");
  assert.ok(idx >= 0, "panel.ts should register an onDidChangeViewState listener");
  const snippet = src.slice(idx, idx + 300);
  assert.match(snippet, /webviewPanel\.visible/, "listener should check webviewPanel.visible");
  assert.match(snippet, /_themeServiceHost\.handleGetStatus\(\)/, "visible branch should call themeServiceHost.handleGetStatus()");
});
