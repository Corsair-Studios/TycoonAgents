import { test } from "node:test";
import assert from "node:assert/strict";
import { createThemeServiceClient, ThemeServiceTokenStore, REFERRAL_CODE_PATTERN } from "../src/core/themeServiceClient";
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

function setup(nowFn?: () => number, openExternalOverride?: (url: string) => void | boolean | Promise<void | boolean>) {
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
      if (openExternalOverride) return openExternalOverride(url);
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

// p62-t3: at-most-once referral apply (afterSignInSucceeded, src/host/vscode/themeServiceHost.ts:175-197).
function makeMemoryDeviceState() {
  let signedIn = false;
  return {
    async hasEverSignedIn() {
      return signedIn;
    },
    async markSignedIn() {
      signedIn = true;
    },
    _setSignedIn(v: boolean) {
      signedIn = v;
    },
  };
}

function setupWithReferral(deviceState: ReturnType<typeof makeMemoryDeviceState>) {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const tokenStore = createMemoryTokenStore();
  const realClient = createThemeServiceClient({
    fetch: fake.fetch,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: "anon-key",
  });
  const referralCalls: string[] = [];
  const client = {
    ...realClient,
    async applyReferralCode(code: string) {
      referralCalls.push(code);
      return { ok: true as const, value: { applied: true } };
    },
  };
  const posted: ThemeServiceHostStatus[] = [];
  const host = createThemeServiceHost({
    secrets: {} as any,
    client,
    deviceState,
    openExternal: () => {},
    postStatus: (status) => posted.push(status),
  });
  host.start();
  return { fake, host, posted, referralCalls };
}

test("referral: fresh device with pending code applies exactly once on first sign-in", async () => {
  const deviceState = makeMemoryDeviceState();
  const { fake, host, posted, referralCalls } = setupWithReferral(deviceState);
  fake.helpers.createAccount("first@example.com");

  host.handleSetReferralCode("PARTNER-1");
  await host.handleRequestMagicLink("first@example.com");
  await host.handleVerify("first@example.com", "123456");

  assert.deepEqual(referralCalls, ["PARTNER-1"]);
  assert.equal(await deviceState.hasEverSignedIn(), true);
  const last = posted[posted.length - 1];
  assert.equal(last.referralMessage, "Referral applied.");

  // Pending code is cleared after apply — a subsequent status build shows no prefill.
  const status = await host.getStatusSnapshot();
  assert.equal(status.referralCodePrefill, undefined);
});

test("referral: second sign-in on a device that already signed in makes zero apply calls", async () => {
  const deviceState = makeMemoryDeviceState();
  deviceState._setSignedIn(true); // device already signed in once before
  const { fake, host, referralCalls } = setupWithReferral(deviceState);
  fake.helpers.createAccount("second@example.com");

  host.handleSetReferralCode("PARTNER-2");
  await host.handleRequestMagicLink("second@example.com");
  await host.handleVerify("second@example.com", "123456");

  assert.deepEqual(referralCalls, []);
});

test("referral: device that had signed in before any code entered shows no field and makes no calls", async () => {
  const deviceState = makeMemoryDeviceState();
  deviceState._setSignedIn(true);
  const { host, referralCalls } = setupWithReferral(deviceState);

  const status = await host.getStatusSnapshot();
  assert.equal(status.showReferralField, false);
  assert.deepEqual(referralCalls, []);
});

test("referral: deep link handleSetReferralCode surfaces referralCodePrefill while signed out", async () => {
  const deviceState = makeMemoryDeviceState();
  const { host } = setupWithReferral(deviceState);

  host.handleSetReferralCode("ABC-123");
  const status = await host.getStatusSnapshot();
  assert.equal(status.referralCodePrefill, "ABC-123");
});

// p62-t3: static check of panel.ts's TycoonPanel.handleUriCallback /sign-in
// branch (deep-link ref pre-fill; panel.ts imports `vscode` so it cannot be
// loaded directly in a Node unit test — see open issues in the report).
test("panel.ts /sign-in URI handler parses the ref query param, validates it against REFERRAL_CODE_PATTERN, and forwards a valid code (e.g. ABC-123) to handleSetReferralCode", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src: string = fs.readFileSync(path.join(process.cwd(), "src", "host", "vscode", "panel.ts"), "utf8");
  assert.match(
    src,
    /import\s*\{\s*REFERRAL_CODE_PATTERN\s*\}\s*from\s*"\.\.\/\.\.\/core\/themeServiceClient"/,
    "panel.ts should import REFERRAL_CODE_PATTERN from core/themeServiceClient",
  );
  const idx = src.indexOf('uri.path === "/sign-in"');
  assert.ok(idx >= 0, "panel.ts should register a /sign-in URI branch");
  const snippet = src.slice(idx, idx + 300);
  assert.match(snippet, /URLSearchParams\(uri\.query\)\.get\("ref"\)/, "should read the ref query param");
  assert.match(snippet, /REFERRAL_CODE_PATTERN\.test\(ref\)/, "should validate ref against REFERRAL_CODE_PATTERN before forwarding");
  assert.match(snippet, /_themeServiceHost\.handleSetReferralCode\(ref\)/, "should forward a valid ref to handleSetReferralCode");
  // ABC-123 matches the pattern, so the deep-link branch would forward it.
  assert.ok(REFERRAL_CODE_PATTERN.test("ABC-123"), "ABC-123 should be accepted by REFERRAL_CODE_PATTERN");
});

// The deep-link /sign-in branch now guards handleSetReferralCode with
// REFERRAL_CODE_PATTERN ([A-Za-z0-9-]{1,32}); a script-like value or an
// oversized (40-char) value fails that check, so panel.ts silently ignores
// them (no prefill, no message) rather than forwarding them to the host.
test("referral: a script-like ref and a 40-char ref both fail REFERRAL_CODE_PATTERN, so the /sign-in deep link produces no prefill for either", () => {
  assert.equal(REFERRAL_CODE_PATTERN.test("<script>alert(1)</script>"), false);
  assert.equal(REFERRAL_CODE_PATTERN.test("A".repeat(40)), false);
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

test("handleGoogleStart: openExternal throwing posts browser_open_failed with browserUrl set", async () => {
  const { host, posted, opened } = setup(undefined, () => {
    throw new Error("no browser available");
  });
  await host.handleGoogleStart();
  assert.equal(opened.length, 1);
  const last = posted[posted.length - 1];
  assert.equal(last.signedIn, false);
  assert.equal(last.error?.kind, "browser_open_failed");
  assert.equal(last.browserUrl, opened[0]);
});

test("handleGoogleStart: openExternal returning false posts browser_open_failed with browserUrl set", async () => {
  const { host, posted, opened } = setup(undefined, () => false);
  await host.handleGoogleStart();
  const last = posted[posted.length - 1];
  assert.equal(last.signedIn, false);
  assert.equal(last.error?.kind, "browser_open_failed");
  assert.equal(last.browserUrl, opened[0]);
});

test("handleGoogleOpen: no-ops (posts nothing, opens nothing) when there is no pending Google browser URL", async () => {
  const { host, posted, opened } = setup();
  await host.handleGoogleOpen();
  assert.equal(opened.length, 0);
  assert.equal(posted.length, 0);
});

test("handleGoogleOpen: re-opens the stored URL from the matching handleGoogleStart, ignoring any webview-supplied payload", async () => {
  const { host, posted, opened } = setup();
  await host.handleGoogleStart();
  assert.equal(opened.length, 1);
  const storedUrl = opened[0];
  opened.length = 0;
  await host.handleGoogleOpen();
  assert.equal(opened.length, 1);
  assert.equal(opened[0], storedUrl);
  // A failing re-open still reports the ORIGINAL stored url, never a
  // caller-supplied one — handleGoogleOpen takes no url argument at all.
  assert.equal(posted.length, 0);
});

test("handleGoogleOpen: a failing re-open posts browser_open_failed with the stored browserUrl", async () => {
  let openCount = 0;
  const { host, posted, opened } = setup(undefined, () => {
    openCount += 1;
    return openCount === 1 ? true : false;
  });
  await host.handleGoogleStart();
  const storedUrl = opened[0];
  await host.handleGoogleOpen();
  const last = posted[posted.length - 1];
  assert.equal(last.signedIn, false);
  assert.equal(last.error?.kind, "browser_open_failed");
  assert.equal(last.browserUrl, storedUrl);
});
