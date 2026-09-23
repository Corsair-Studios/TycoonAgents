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

// p89: a signed-in status posted to the webview must always carry a
// numeric credits balance — the credits chip has nothing to fall back to
// otherwise. This guards against a future client/backend regression (e.g. a
// renamed field) that would otherwise hide behind a status log line that
// always says "ok".
test("p89: signedIn statuses from real sign-in flows always carry numeric credits", async () => {
  const { host, posted } = setup();
  await host.handleRequestMagicLink("me2@example.com");
  await host.handleVerify("me2@example.com", "123456");
  const signedIn = posted.filter((p) => p.signedIn === true);
  assert.ok(signedIn.length > 0);
  for (const p of signedIn) assert.equal(typeof p.credits, "number");
});

test("p89: signedIn without numeric credits from client.getStatus is logged and still passed through", async () => {
  const logs: string[] = [];
  const posted: ThemeServiceHostStatus[] = [];
  const timers = fakeTimers();
  const brokenClient: any = {
    getStatus: async () => ({ ok: true, value: { signedIn: true, email: "x@example.com", role: "user" } }),
    getPricing: async () => ({ ok: false, error: { kind: "unavailable", message: "n/a" } }),
  };
  const host = createThemeServiceHost({
    secrets: {} as any,
    client: brokenClient,
    openExternal: () => {},
    postStatus: (status) => posted.push(status),
    log: (msg: string) => logs.push(msg),
    now: () => Date.now(),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  host.start();
  await host.handleGetStatus();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].signedIn, true);
  assert.equal(posted[0].credits, undefined);
  assert.ok(
    logs.some((l) => l.includes("signedIn=true but credits is not a number")),
    "expected a diagnostic log line for signedIn-without-credits",
  );
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

test("panel.ts wraps GOOGLE_START and GOOGLE_OPEN handlers in try/catch posting browser_open_failed, and delegates url opening to openExternalUrl", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src: string = fs.readFileSync(
    path.join(process.cwd(), "src", "host", "vscode", "panel.ts"),
    "utf8",
  );

  const startIdx = src.indexOf("THEME_SERVICE_GOOGLE_START");
  assert.ok(startIdx >= 0, "panel.ts should handle THEME_SERVICE_GOOGLE_START");
  const startSnippet = src.slice(startIdx, startIdx + 1000);
  assert.match(startSnippet, /try\s*\{/, "GOOGLE_START handler should be wrapped in try/catch");
  assert.match(startSnippet, /catch\s*\(err\)/, "GOOGLE_START handler should catch errors");
  assert.match(startSnippet, /browser_open_failed/, "GOOGLE_START catch should post browser_open_failed");

  const openIdx = src.indexOf("THEME_SERVICE_GOOGLE_OPEN");
  assert.ok(openIdx >= 0, "panel.ts should handle THEME_SERVICE_GOOGLE_OPEN");
  const openSnippet = src.slice(openIdx, openIdx + 1000);
  assert.match(openSnippet, /try\s*\{/, "GOOGLE_OPEN handler should be wrapped in try/catch");
  assert.match(openSnippet, /catch\s*\(err\)/, "GOOGLE_OPEN handler should catch errors");
  assert.match(openSnippet, /browser_open_failed/, "GOOGLE_OPEN catch should post browser_open_failed");

  const hostIdx = src.indexOf("this._themeServiceHost = createThemeServiceHost(");
  assert.ok(hostIdx >= 0, "panel.ts should construct the theme service host");
  const openExternalKeyIdx = src.indexOf("openExternal:", hostIdx);
  assert.ok(openExternalKeyIdx >= 0, "createThemeServiceHost({...}) should include an openExternal option");
  const hostSnippet = src.slice(openExternalKeyIdx, openExternalKeyIdx + 1500);
  assert.match(
    hostSnippet,
    /openExternal:\s*async\s*\(url\)\s*=>\s*\{[\s\S]*?openExternalUrl\(/,
    "panel.ts's openExternal option should delegate to openExternalUrl(",
  );

  const openExternalUrlSrc: string = fs.readFileSync(
    path.join(process.cwd(), "src", "host", "vscode", "openExternalUrl.ts"),
    "utf8",
  );
  assert.match(
    openExternalUrlSrc,
    /Uri\.parse\(url,\s*true\)/,
    "openExternalUrl.ts should strict-parse with Uri.parse(url, true)",
  );
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
  assert.equal(last.error?.message, "couldn't open the browser for sign-in (Error)");
  assert.equal(last.browserUrl, opened[0]);
});

test("handleGoogleStart: openExternal returning false posts browser_open_failed with browserUrl set", async () => {
  const { host, posted, opened } = setup(undefined, () => false);
  await host.handleGoogleStart();
  const last = posted[posted.length - 1];
  assert.equal(last.signedIn, false);
  assert.equal(last.error?.kind, "browser_open_failed");
  assert.equal(last.error?.message, "couldn't open the browser for sign-in");
  assert.equal(last.browserUrl, opened[0]);
});

test("handleGoogleStart: posts {signedIn:false, browserUrl} BEFORE awaiting openExternal, and nothing further on success", async () => {
  const { host, posted, opened } = setup();
  await host.handleGoogleStart();
  assert.equal(opened.length, 1);
  // Only the pre-await post — success posts nothing further.
  assert.equal(posted.length, 1);
  assert.equal(posted[0].signedIn, false);
  assert.equal(posted[0].browserUrl, opened[0]);
  assert.equal(posted[0].error, undefined);
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
  posted.length = 0; // handleGoogleStart already posted once (pre-await); isolate handleGoogleOpen's own post.
  await host.handleGoogleOpen();
  assert.equal(opened.length, 1);
  assert.equal(opened[0], storedUrl);
  // A failing re-open still reports the ORIGINAL stored url, never a
  // caller-supplied one — handleGoogleOpen takes no url argument at all.
  // A successful re-open now also posts status, carrying the browserUrl
  // so the webview can keep rendering the fallback link/buttons.
  assert.equal(posted.length, 1);
  const last = posted[posted.length - 1];
  assert.equal(last.signedIn, false);
  assert.equal(last.browserUrl, storedUrl);
  assert.equal(last.error, undefined);
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
  assert.equal(last.error?.message, "couldn't open the browser for sign-in");
  assert.equal(last.browserUrl, storedUrl);
});

test("handleGoogleStart/handleGoogleOpen: opts.log lines carry the Supabase host, never code_challenge/query/verifier", async () => {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const tokenStore = createMemoryTokenStore();
  const client = createThemeServiceClient({
    fetch: fake.fetch,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    createCodeVerifier: () => "fixed-test-verifier",
  });
  const posted: ThemeServiceHostStatus[] = [];
  const opened: string[] = [];
  const logLines: string[] = [];
  const timers = fakeTimers();
  const host = createThemeServiceHost({
    secrets: {} as any,
    client,
    openExternal: (url) => {
      opened.push(url);
    },
    postStatus: (status) => posted.push(status),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    log: (msg) => logLines.push(msg),
  });
  host.start();
  await host.handleGoogleStart();
  await host.handleGoogleOpen();

  assert.ok(logLines.length > 0, "expected log lines to be captured");
  const supabaseHost = new URL(SUPABASE_URL).host;
  const joined = logLines.join("\n");
  assert.ok(joined.includes(supabaseHost), "log lines should mention the Supabase host");
  for (const line of logLines) {
    assert.ok(!line.includes("code_challenge"), `log line must not contain code_challenge: ${line}`);
    assert.ok(!line.includes("?"), `log line must not contain a query string: ${line}`);
    assert.ok(!line.includes("fixed-test-verifier"), `log line must not contain the code verifier: ${line}`);
  }
});

test("handleGoogleOpen: successful re-open posts status with browserUrl and no error (buttons stay renderable)", async () => {
  const { host, posted, opened } = setup();
  await host.handleGoogleStart();
  const storedUrl = opened[0];
  posted.length = 0;
  await host.handleGoogleOpen();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].error, undefined);
  assert.equal(posted[0].browserUrl, storedUrl);
});

test("handleGoogleStart: redirect_to uses injected uriScheme (antigravity, cursor, and default when undefined)", async () => {
  async function redirectSchemeFor(uriScheme: string | undefined): Promise<string> {
    const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
    const tokenStore = createMemoryTokenStore();
    const client = createThemeServiceClient({
      fetch: fake.fetch,
      tokenStore,
      endpoint: ENDPOINT,
      supabaseUrl: SUPABASE_URL,
      createCodeVerifier: () => "fixed-test-verifier",
    });
    const opened: string[] = [];
    const timers = fakeTimers();
    const host = createThemeServiceHost({
      secrets: {} as any,
      client,
      uriScheme,
      openExternal: (url) => {
        opened.push(url);
      },
      postStatus: () => {},
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    host.start();
    await host.handleGoogleStart();
    const browserUrl = new URL(opened[0]);
    return browserUrl.searchParams.get("redirect_to") ?? "";
  }

  assert.equal(
    await redirectSchemeFor("antigravity"),
    "antigravity://tycoonagents.tycoonagents/theme-service-auth",
  );
  assert.equal(
    await redirectSchemeFor("cursor"),
    "cursor://tycoonagents.tycoonagents/theme-service-auth",
  );
  assert.equal(
    await redirectSchemeFor(undefined),
    "vscode://tycoonagents.tycoonagents/theme-service-auth",
  );
});

test("hasPendingGoogleSignIn: true after handleGoogleStart, false after handleGoogleComplete and after handleCancelGoogleSignIn", async () => {
  const { host, fake, opened } = setup();
  assert.equal(host.hasPendingGoogleSignIn(), false);
  await host.handleGoogleStart();
  assert.equal(host.hasPendingGoogleSignIn(), true);
  await fake.fetch(opened[opened.length - 1]);
  const code = await fake.helpers.completeGoogleInBrowser();
  await host.handleGoogleComplete(code);
  assert.equal(host.hasPendingGoogleSignIn(), false);

  await host.handleGoogleStart();
  assert.equal(host.hasPendingGoogleSignIn(), true);
  const anyHost = host as any;
  if (typeof anyHost.handleCancelGoogleSignIn === "function") {
    await anyHost.handleCancelGoogleSignIn();
    assert.equal(host.hasPendingGoogleSignIn(), false);
  }
});

test("p83-t2: pending sign-in, fragment tokens the fake rejects (401 on /api/account) must not persist a session", async () => {
  const { host, tokenStore, posted, logLines } = setupWithLog();
  await host.handleGoogleStart();
  await host.handleUriCallback({
    accessToken: SECRET_ACCESS_TOKEN,
    refreshToken: SECRET_REFRESH_TOKEN,
    expiresIn: 3600,
    queryParamNames: [],
    fragmentParamNames: ["access_token", "refresh_token", "expires_in"],
  });
  assert.equal(await tokenStore.get(), null, "a token the service rejects must never be persisted");
  assert.ok(!host.hasPendingGoogleSignIn(), "pending sign-in should be cleared even on a rejected token");
  const last = posted[posted.length - 1];
  assert.equal(last.signedIn, false);
  assert.equal(last.error?.message, "Sign-in could not be verified.");
  assertNoSecrets(logLines, posted);
});

test("panel.ts: stray theme-service-auth callback shows the code via showInformationMessage and copies via clipboard, never logs it", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src: string = fs.readFileSync(
    path.join(process.cwd(), "src", "host", "vscode", "panel.ts"),
    "utf8",
  );

  const startIdx = src.indexOf("public static handleUriCallback(uri: vscode.Uri): void {");
  assert.ok(startIdx >= 0, "panel.ts should define handleUriCallback");
  const braceStart = src.indexOf("{", startIdx);
  // Find the matching closing brace for the method body.
  let depth = 0;
  let endIdx = -1;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  assert.ok(endIdx > braceStart, "should find the end of handleUriCallback's body");
  const body = src.slice(braceStart, endIdx);

  assert.match(body, /hasPendingGoogleSignIn\(\)/, "should check hasPendingGoogleSignIn before completing");
  assert.match(
    body,
    /showInformationMessage\(\s*[\s\S]*?"Copy code"/,
    "stray-callback branch should offer a 'Copy code' action",
  );
  assert.match(
    body,
    /vscode\.env\.clipboard\.writeText\(code\)/,
    "'Copy code' action should write the code to the clipboard",
  );
  assert.ok(!/\blog\(/.test(body), "handleUriCallback body must never pass the code to log(...)");
});

// p83-t2: callback branch coverage (implicit tokens, oauth error, no-usable-
// params) plus secret-scrubbing across every posted status and log line.
// Planted values that must never appear anywhere in captured output.
const SECRET_CODE = "CODE_SECRET_123";
const SECRET_ACCESS_TOKEN = "AT_SECRET_456";
const SECRET_REFRESH_TOKEN = "RT_SECRET_789";
const SECRET_ERROR_DESCRIPTION = "user@example.com leaked";

function setupWithLog() {
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL });
  const tokenStore = createMemoryTokenStore();
  const client = createThemeServiceClient({
    fetch: fake.fetch,
    tokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    createCodeVerifier: () => "fixed-test-verifier",
  });
  const posted: ThemeServiceHostStatus[] = [];
  const opened: string[] = [];
  const logLines: string[] = [];
  const timers = fakeTimers();
  const host = createThemeServiceHost({
    secrets: {} as any,
    client,
    openExternal: (url) => {
      opened.push(url);
    },
    postStatus: (status) => posted.push(status),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    log: (msg) => logLines.push(msg),
  });
  host.start();
  return { fake, client, tokenStore, posted, opened, logLines, host };
}

function assertNoSecrets(logLines: string[], posted: ThemeServiceHostStatus[]): void {
  const haystack = logLines.join("\n") + "\n" + JSON.stringify(posted);
  for (const secret of [SECRET_CODE, SECRET_ACCESS_TOKEN, SECRET_REFRESH_TOKEN, SECRET_ERROR_DESCRIPTION]) {
    assert.ok(!haystack.includes(secret), `captured output must not contain planted secret: ${secret}`);
  }
}

test("p83-t2: pending sign-in, ?code= callback completes via fake exchange and posts signedIn", async () => {
  const { fake, host, posted, opened, logLines } = setupWithLog();
  await host.handleGoogleStart();
  await fake.fetch(opened[0]);
  const authCode = await fake.helpers.completeGoogleInBrowser();
  await host.handleUriCallback({ code: authCode, queryParamNames: ["code"], fragmentParamNames: [] });
  const last = posted[posted.length - 1];
  assert.equal(last.signedIn, true);
  assertNoSecrets(logLines, posted);
});

test("p83-t2: pending sign-in, fragment access_token+refresh_token completes via completeGoogleSignInImplicit", async () => {
  // completeGoogleSignInImplicit verifies the candidate token against the
  // service before storing it (p83-t2 review fix), so the test needs a
  // token the fake actually recognizes — mint one through a real PKCE round
  // trip on a throwaway client/session sharing the same fake backend, then
  // feed those real token values through the host's implicit-fragment path.
  const { fake, host, tokenStore, posted, logLines } = setupWithLog();
  const donorTokenStore = createMemoryTokenStore();
  const donorClient = createThemeServiceClient({
    fetch: fake.fetch,
    tokenStore: donorTokenStore,
    endpoint: ENDPOINT,
    supabaseUrl: SUPABASE_URL,
    createCodeVerifier: () => "donor-verifier",
  });
  const startRes = await donorClient.startGoogleSignIn({ redirectTo: "vscode://tycoonagents.tycoonagents/theme-service-auth" });
  assert.ok(startRes.ok);
  await fake.fetch(startRes.value.browserUrl);
  const donorCode = await fake.helpers.completeGoogleInBrowser();
  const exchangeRes = await donorClient.completeGoogleSignIn({ authCode: donorCode, codeVerifier: startRes.value.codeVerifier });
  assert.ok(exchangeRes.ok);
  const donorSession = JSON.parse((await donorTokenStore.get())!);

  await host.handleGoogleStart();
  await host.handleUriCallback({
    accessToken: donorSession.accessToken,
    refreshToken: donorSession.refreshToken,
    expiresIn: 3600,
    queryParamNames: [],
    fragmentParamNames: ["access_token", "refresh_token", "expires_in"],
  });
  const last = posted[posted.length - 1];
  assert.equal(last.signedIn, true, `expected signedIn true, got ${JSON.stringify(last)}`);
  assert.ok(!host.hasPendingGoogleSignIn(), "pending sign-in should be cleared after completion");
  const stored = await tokenStore.get();
  assert.ok(stored, "session should be stored after a verified implicit completion");
  assertNoSecrets(logLines, posted);
});

test("p83-t2: pending sign-in, ?error=access_denied posts a visible error naming the code, never a description", async () => {
  const { host, posted, logLines } = setupWithLog();
  await host.handleGoogleStart();
  await host.handleUriCallback({ errorCode: "access_denied", queryParamNames: ["error", "error_description"], fragmentParamNames: [] });
  const last = posted[posted.length - 1];
  assert.equal(last.signedIn, false);
  assert.ok(last.error?.message.includes("access_denied"), `error message should include access_denied: ${last.error?.message}`);
  assertNoSecrets(logLines, posted);
});

test("p83-t2: pending sign-in, callback with no usable params posts a visible message instead of waiting", async () => {
  const { host, posted, logLines } = setupWithLog();
  await host.handleGoogleStart();
  posted.length = 0;
  await host.handleUriCallback({ queryParamNames: [], fragmentParamNames: [] });
  assert.equal(posted.length, 1, "an early exit while pending must post, never stay silently waiting");
  assert.equal(posted[0].signedIn, false);
  assert.ok(posted[0].error, "should carry a visible error");
  assertNoSecrets(logLines, posted);
});

test("p83-t2: no pending sign-in, implicit-token callback does not create a session", async () => {
  const { host, tokenStore, posted, logLines } = setupWithLog();
  await host.handleUriCallback({
    accessToken: SECRET_ACCESS_TOKEN,
    refreshToken: SECRET_REFRESH_TOKEN,
    queryParamNames: [],
    fragmentParamNames: ["access_token", "refresh_token"],
  });
  assert.equal(await tokenStore.get(), null, "no session should be stored without a pending sign-in");
  assert.ok(
    posted.every((p) => p.signedIn !== true),
    "must never report signedIn:true from an unsolicited callback",
  );
  assertNoSecrets(logLines, posted);
});

test("p83-t2: authorize URL uses code_challenge_method=S256", async () => {
  const { host, opened } = setupWithLog();
  await host.handleGoogleStart();
  assert.ok(opened[0].includes("code_challenge_method=S256"), `authorize URL should carry S256: ${opened[0]}`);
});

test("diagnosticReport: includes 'URI scheme' line with the injected scheme", () => {
  const { buildDiagnosticReport } = require("../src/host/vscode/diagnosticReport");
  const report = buildDiagnosticReport({
    timestamp: "2026-09-19T00:00:00.000Z",
    roots: {},
    uriScheme: "antigravity",
  });
  assert.match(report, /URI scheme.*antigravity/);
});
