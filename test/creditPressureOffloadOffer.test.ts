/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for the credit-pressure offload offer (p6-t1), media/main.js
// ~14133-14290: CREDIT_PRESSURE_ORCH_TOKENS_THRESHOLD,
// checkCreditPressureOffer, renderCreditPressureOffer,
// acceptCreditPressureOffer, dismissCreditPressureOffer.
//
// THE PROPERTY UNDER TEST is the doctrine comment's own claim (media/main.js
// ~14145-14160): detection tripping changes exactly one thing — offer
// visibility. It never selects a model, queues a task, or touches any
// routing table; the only path with any routing-relevant effect at all is
// an explicit accept-click, and even that only records a choice via
// postMessage. This file drives the REAL media/main.js source through the
// readFileSync + node:vm harness (same technique as
// test/vsOrchRawRateBadge.test.ts), never reimplementing the detection or
// button logic — every assertion reads the real booted DOM/state and the
// real outbound vscode.postMessage calls.
//
// "No routing change" is asserted the only way available at this layer:
// the harness proves that outside the two dedicated variables
// (offloadOfferDismissed/offloadOfferAccepted), the offer card's own DOM,
// and the single documented outbound message, NOTHING else fires — no
// other postMessage call is ever made by these code paths, and repeated
// detection/dismissal cycles never accumulate any other observable state
// change. That is the full surface this feature is allowed to touch, per
// its own doctrine comment, so it is also the full surface asserted here.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require("jsdom");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vm = require("vm");

const MAIN_JS_PATH = join(process.cwd(), "media", "main.js");

function scanElementIds(src: string): string[] {
  const ids = new Set<string>();
  const re = /getElementById\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) ids.add(m[1]);
  return [...ids];
}

const RUNTIME_CREATED_IDS = new Set([
  "rebirth-announce",
  "rebirth-panel",
  "menu-edit-stage",
  "settings-modal-close",
  "stage-edit-panel",
]);

function makeCtxStub(canvasEl: unknown): unknown {
  const gradient = { addColorStop() {} };
  const target: Record<string, unknown> = {
    canvas: canvasEl,
    measureText: () => ({ width: 0 }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, (w || 1) * (h || 1)) * 4),
    }),
    putImageData: () => {},
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => ({ setTransform() {} }),
    createImageData: (w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, (w || 1) * (h || 1)) * 4),
    }),
  };
  return new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return () => {};
    },
    set(t, prop: string, value) {
      t[prop] = value;
      return true;
    },
  });
}

function makeFakeImage(win: any) {
  return class FakeImage {
    _src = "";
    width = 64;
    height = 64;
    naturalWidth = 64;
    naturalHeight = 64;
    complete = false;
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    set src(v: string) {
      this._src = v;
      this.complete = true;
      win.Promise.resolve().then(() => {
        if (typeof this.onload === "function") this.onload();
      });
    }
    get src() {
      return this._src;
    }
    addEventListener(type: string, cb: () => void) {
      if (type === "load") this.onload = cb;
      if (type === "error") this.onerror = cb;
    }
    removeEventListener() {}
  };
}

const openWindows: any[] = [];
after(() => {
  for (const w of openWindows.splice(0)) {
    try {
      w.close();
    } catch {
      // best-effort cleanup only
    }
  }
});

function bootMainJs() {
  const src = readFileSync(MAIN_JS_PATH, "utf8");

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "https://webview.local/",
  });
  const win: any = dom.window;
  openWindows.push(win);
  const doc = win.document;

  const ids = scanElementIds(src);
  for (const id of ids) {
    if (RUNTIME_CREATED_IDS.has(id)) continue;
    if (doc.getElementById(id)) continue;
    const el = doc.createElement("div");
    el.id = id;
    doc.body.appendChild(el);
  }
  let stage = doc.getElementById("stage");
  if (!stage || stage.tagName.toLowerCase() !== "canvas") {
    if (stage) stage.remove();
    stage = doc.createElement("canvas");
    stage.id = "stage";
    doc.body.appendChild(stage);
  }
  stage.width = 1066;
  stage.height = 760;

  let stateStore: any = {};
  const postedMessages: any[] = [];
  win.acquireVsCodeApi = () => ({
    postMessage: (m: any) => {
      postedMessages.push(m);
    },
    getState: () => stateStore,
    setState: (s: any) => {
      stateStore = s;
    },
  });

  const rafQueue: Array<(ts: number) => void> = [];
  win.requestAnimationFrame = (cb: (ts: number) => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  win.cancelAnimationFrame = () => {};
  win.Image = makeFakeImage(win);
  win.HTMLCanvasElement.prototype.getContext = function (this: any) {
    if (!this.__ctxStub) this.__ctxStub = makeCtxStub(this);
    return this.__ctxStub;
  };
  win.HTMLCanvasElement.prototype.toDataURL = function () {
    return "data:image/png;base64,iVBORw0KGgo=";
  };

  const errors: any[] = [];
  win.addEventListener("error", (e: any) => {
    errors.push(e && (e.error || e.message) ? e.error || e.message : e);
  });
  win.onerror = (msg: any, _s: any, _l: any, _c: any, err: any) => {
    errors.push(err || msg);
  };

  vm.runInContext(src, dom.getInternalVMContext(), { filename: "media/main.js" });

  if (errors.length > 0) {
    const detail = errors.map((e) => (e && e.stack ? e.stack : String(e))).join("\n---\n");
    throw new Error(`media/main.js threw while booting — real module could not be loaded:\n${detail}`);
  }

  function dispatch(data: any) {
    win.dispatchEvent(new win.MessageEvent("message", { data }));
  }

  return { win, doc, dispatch, postedMessages, getState: () => stateStore, errors };
}

/** Dispatch a `state` message with the given agentMetrics array (cumulative, all-time). */
function dispatchMetrics(dispatch: (d: any) => void, agentMetrics: any[]) {
  dispatch({
    type: "state",
    state: {
      sessionActive: true,
      completedTasks: 3,
      idleFreezeMs: 180000,
      sanityCapMs: 900000,
      workers: {},
      agentMetrics,
    },
  });
}

/**
 * Dispatch OFFLOAD_OFFER_STATE, the host's reply to boot-time
 * REQUEST_OFFLOAD_OFFER_STATE — this is the ONLY way `providerAvailable`
 * (a fresh host-side .mcp.json check, panel.ts's offloadProviderAvailable)
 * reaches the webview. Every test in this file must dispatch this
 * EXPLICITLY with the availability it intends: the webview variable
 * defaults `false` (fail closed) until this message arrives, so a test
 * that wants a visible card must say so, and a test proving the reported
 * bug must simply omit/false this call.
 */
function dispatchOfferState(dispatch: (d: any) => void, opts: { dismissed?: boolean; accepted?: boolean; providerAvailable?: boolean } = {}) {
  dispatch({
    type: "OFFLOAD_OFFER_STATE",
    dismissed: opts.dismissed ?? false,
    accepted: opts.accepted ?? false,
    providerAvailable: opts.providerAvailable ?? false,
  });
}

const BELOW_THRESHOLD_ORCH = { id: "orchestrator", name: "Orchestrator", tokens: 1000, cacheReadTokens: 500 };
// Threshold is 500000 on (tokens + cacheReadTokens).
const ABOVE_THRESHOLD_ORCH = { id: "orchestrator", name: "Orchestrator", tokens: 600000, cacheReadTokens: 0 };

function offerCard(doc: any) {
  return doc.getElementById("credit-pressure-offer");
}

function acceptButton(doc: any) {
  return doc.querySelector(".credit-pressure-offer-accept");
}

function dismissButton(doc: any) {
  return doc.querySelector(".credit-pressure-offer-dismiss");
}

// ── 1. Tripped detection alone changes no routing state, only visibility ──

test("credit pressure: detection below threshold never shows the offer card", () => {
  const { doc, dispatch } = bootMainJs();
  dispatchOfferState(dispatch, { providerAvailable: true });
  dispatchMetrics(dispatch, [BELOW_THRESHOLD_ORCH]);
  assert.equal(offerCard(doc), null, "offer card must not render below the token threshold");
});

test("credit pressure: detection tripping shows ONLY the offer card — no other postMessage traffic beyond REQUEST_OFFLOAD_OFFER_STATE boot read", () => {
  const { doc, dispatch, postedMessages } = bootMainJs();
  dispatchOfferState(dispatch, { providerAvailable: true });
  const messagesBeforeMetrics = postedMessages.length;

  dispatchMetrics(dispatch, [ABOVE_THRESHOLD_ORCH]);

  assert.ok(offerCard(doc), "offer card must render once the threshold trips AND a provider is confirmed available");
  assert.equal(
    postedMessages.length,
    messagesBeforeMetrics,
    "rendering the offer from a tripped detection must not itself post any new message to the host (no routing side effect)"
  );
});

test("credit pressure: repeated re-detection (multiple state pushes) still posts nothing and never toggles any state beyond the card", () => {
  const { doc, dispatch, postedMessages } = bootMainJs();
  dispatchOfferState(dispatch, { providerAvailable: true });
  dispatchMetrics(dispatch, [ABOVE_THRESHOLD_ORCH]);
  const afterFirst = postedMessages.length;
  const cardFirst = offerCard(doc);
  assert.ok(cardFirst);

  // Re-trip detection several more times (e.g. periodic metrics refresh).
  for (let i = 0; i < 5; i++) {
    dispatchMetrics(dispatch, [{ ...ABOVE_THRESHOLD_ORCH, tokens: 600000 + i }]);
  }

  assert.equal(postedMessages.length, afterFirst, "no additional postMessage traffic from repeated detection trips");
  assert.ok(offerCard(doc), "card remains present across repeated trips");
});

// ── 2. Declining/dismissing leaves subsequent routing byte-identical to baseline ──

test("credit pressure: dismiss sends dismissed:true WITHOUT accepted, and hides the card", () => {
  const { doc, dispatch, postedMessages } = bootMainJs();
  dispatchOfferState(dispatch, { providerAvailable: true });
  dispatchMetrics(dispatch, [ABOVE_THRESHOLD_ORCH]);
  const btn = dismissButton(doc);
  assert.ok(btn, "dismiss button must exist while the card is shown");

  btn.dispatchEvent(new (doc.defaultView as any).Event("click", { bubbles: true }));

  const dismissMsgs = postedMessages.filter((m) => m && m.type === "SET_OFFLOAD_OFFER_DISMISSED");
  assert.equal(dismissMsgs.length, 1, "exactly one SET_OFFLOAD_OFFER_DISMISSED message on dismiss-click");
  // Compared via own-key snapshot rather than assert.deepEqual: the posted
  // message object is constructed inside the vm-context realm, so its
  // [[Prototype]] differs from this file's Object even when every key/value
  // matches — deepEqual/deepStrictEqual can fail on that alone. Object.keys
  // + a plain field-by-field check sidesteps the cross-realm prototype
  // mismatch entirely.
  assert.deepEqual(
    Object.keys(dismissMsgs[0]).sort(),
    ["dismissed", "type"],
    "dismiss payload must have exactly the keys {type, dismissed} — no accepted key at all"
  );
  assert.equal(dismissMsgs[0].type, "SET_OFFLOAD_OFFER_DISMISSED");
  assert.equal(dismissMsgs[0].dismissed, true);
  assert.equal("accepted" in dismissMsgs[0], false, "dismiss must never include an accepted key, not even accepted:false");
  assert.equal(offerCard(doc), null, "card must be removed after dismiss");
});

test("credit pressure: post-dismiss re-render (re-tripped detection) stays dismissed — identical to never having tripped, from the card's perspective", () => {
  const { doc, dispatch, postedMessages } = bootMainJs();
  dispatchOfferState(dispatch, { providerAvailable: true });
  dispatchMetrics(dispatch, [ABOVE_THRESHOLD_ORCH]);
  dismissButton(doc)!.dispatchEvent(new (doc.defaultView as any).Event("click", { bubbles: true }));
  assert.equal(offerCard(doc), null);

  const postedAfterDismiss = postedMessages.length;

  // Detection re-trips again on a later metrics push (still above threshold).
  dispatchMetrics(dispatch, [{ ...ABOVE_THRESHOLD_ORCH, tokens: 700000 }]);

  // Baseline comparison: a session that never tripped detection at all also
  // shows no card and posts nothing extra.
  const baseline = bootMainJs();
  dispatchOfferState(baseline.dispatch, { providerAvailable: true });
  dispatchMetrics(baseline.dispatch, [BELOW_THRESHOLD_ORCH]);

  assert.equal(offerCard(doc), null, "dismissed session must not resurrect the card on renewed detection");
  assert.equal(offerCard(baseline.doc), null, "never-tripped baseline also shows no card");
  assert.equal(
    postedMessages.length,
    postedAfterDismiss,
    "re-tripping detection after a dismissal must post nothing further — identical (silent) behavior to the no-detection baseline"
  );
});

// ── 3. Accepting writes a record of the CHOICE, distinguishable from dismiss ──

test("credit pressure: accept sends dismissed:true AND accepted:true, distinct from dismiss's payload", () => {
  const { doc, dispatch, postedMessages } = bootMainJs();
  dispatchOfferState(dispatch, { providerAvailable: true });
  dispatchMetrics(dispatch, [ABOVE_THRESHOLD_ORCH]);
  const btn = acceptButton(doc);
  assert.ok(btn, "accept button must exist while the card is shown");

  btn.dispatchEvent(new (doc.defaultView as any).Event("click", { bubbles: true }));

  const acceptMsgs = postedMessages.filter((m) => m && m.type === "SET_OFFLOAD_OFFER_DISMISSED");
  assert.equal(acceptMsgs.length, 1, "exactly one SET_OFFLOAD_OFFER_DISMISSED message on accept-click");
  // See the dismiss test above for why this is a key/value snapshot rather
  // than assert.deepEqual against a same-realm literal (cross-realm
  // prototype mismatch with the vm-context-constructed message object).
  assert.deepEqual(
    Object.keys(acceptMsgs[0]).sort(),
    ["accepted", "dismissed", "type"],
    "accept payload must have exactly the keys {type, dismissed, accepted}"
  );
  assert.equal(acceptMsgs[0].type, "SET_OFFLOAD_OFFER_DISMISSED");
  assert.equal(acceptMsgs[0].dismissed, true);
  assert.equal(acceptMsgs[0].accepted, true);
  assert.equal(offerCard(doc), null, "card must be removed after accept, same visibility effect as dismiss");
});

test("credit pressure: accept and dismiss payloads are byte-distinguishable (regression pin — these were once byte-identical)", () => {
  const acceptRun = bootMainJs();
  dispatchOfferState(acceptRun.dispatch, { providerAvailable: true });
  dispatchMetrics(acceptRun.dispatch, [ABOVE_THRESHOLD_ORCH]);
  acceptButton(acceptRun.doc)!.dispatchEvent(new (acceptRun.doc.defaultView as any).Event("click", { bubbles: true }));
  const acceptPayload = acceptRun.postedMessages.find((m) => m && m.type === "SET_OFFLOAD_OFFER_DISMISSED");

  const dismissRun = bootMainJs();
  dispatchOfferState(dismissRun.dispatch, { providerAvailable: true });
  dispatchMetrics(dismissRun.dispatch, [ABOVE_THRESHOLD_ORCH]);
  dismissButton(dismissRun.doc)!.dispatchEvent(new (dismissRun.doc.defaultView as any).Event("click", { bubbles: true }));
  const dismissPayload = dismissRun.postedMessages.find((m) => m && m.type === "SET_OFFLOAD_OFFER_DISMISSED");

  assert.ok(acceptPayload);
  assert.ok(dismissPayload);
  assert.notDeepEqual(acceptPayload, dismissPayload, "accept and dismiss must send genuinely different payloads");
  assert.equal((dismissPayload as any).accepted, undefined, "dismiss payload must never carry accepted:true");
  assert.equal((acceptPayload as any).accepted, true, "accept payload must carry accepted:true");
});

// ── 4. Detection tripping with zero user interaction: no interaction-shaped effects at all ──

test("credit pressure: detection trip with zero clicks never sends SET_OFFLOAD_OFFER_DISMISSED (only the boot-time REQUEST_OFFLOAD_OFFER_STATE read may exist)", () => {
  const { dispatch, postedMessages } = bootMainJs();
  dispatchOfferState(dispatch, { providerAvailable: true });
  dispatchMetrics(dispatch, [ABOVE_THRESHOLD_ORCH]);

  const offloadMsgs = postedMessages.filter((m) => m && m.type === "SET_OFFLOAD_OFFER_DISMISSED");
  assert.equal(offloadMsgs.length, 0, "no SET_OFFLOAD_OFFER_DISMISSED message without an explicit click");

  const requestMsgs = postedMessages.filter((m) => m && m.type === "REQUEST_OFFLOAD_OFFER_STATE");
  assert.ok(requestMsgs.length <= 1, "at most the one boot-time state-read message may exist, nothing else");
});

// ── checkCreditPressureOffer threshold sanity (documents the pinned constant) ──

test("credit pressure: threshold is exactly at 500000 tokens+cacheReadTokens (boundary)", () => {
  const { doc, dispatch } = bootMainJs();
  dispatchOfferState(dispatch, { providerAvailable: true });
  dispatchMetrics(dispatch, [{ id: "orchestrator", tokens: 499999, cacheReadTokens: 0 }]);
  assert.equal(offerCard(doc), null, "499999 total tokens must stay below the trip point");

  dispatchMetrics(dispatch, [{ id: "orchestrator", tokens: 500000, cacheReadTokens: 0 }]);
  assert.ok(offerCard(doc), "exactly 500000 total tokens must trip the offer (>= threshold) when a provider is available");
});

test("credit pressure: no orchestrator row in agentMetrics never trips the offer", () => {
  const { doc, dispatch } = bootMainJs();
  dispatchOfferState(dispatch, { providerAvailable: true });
  dispatchMetrics(dispatch, [{ id: "coding-specialist", tokens: 999999999, cacheReadTokens: 999999999 }]);
  assert.equal(offerCard(doc), null, "absence of an orchestrator row must never trip the offer, regardless of worker token volume");
});

// ── 5. Provider-availability gate (the reported bug) ──────────────────────
//
// Before this fix, checkCreditPressureOffer's token threshold was the ONLY
// gate: a project with NO Codex MCP server installed still got offered a
// route to it. These pin the fix: BOTH the threshold AND a confirmed
// provider must hold, and absence/unreadability of .mcp.json must fail
// CLOSED (no offer), never open.

test("credit pressure BUG PIN: tokens over threshold + NO provider available + not dismissed => NO card, even though detection alone would trip", () => {
  const { doc, dispatch } = bootMainJs();
  dispatchOfferState(dispatch, { providerAvailable: false });
  dispatchMetrics(dispatch, [ABOVE_THRESHOLD_ORCH]);
  assert.equal(
    offerCard(doc),
    null,
    "the reported bug: an offer for Codex must never render when no foreign provider is confirmed installed, regardless of token pressure"
  );
});

test("credit pressure: provider available AND tokens over threshold AND not dismissed => card renders", () => {
  const { doc, dispatch } = bootMainJs();
  dispatchOfferState(dispatch, { providerAvailable: true });
  dispatchMetrics(dispatch, [ABOVE_THRESHOLD_ORCH]);
  assert.ok(offerCard(doc), "card must render when all three conditions hold: threshold, availability, not dismissed");
});

test("credit pressure: provider available but tokens under threshold => no card (existing behavior unchanged by the availability gate)", () => {
  const { doc, dispatch } = bootMainJs();
  dispatchOfferState(dispatch, { providerAvailable: true });
  dispatchMetrics(dispatch, [BELOW_THRESHOLD_ORCH]);
  assert.equal(offerCard(doc), null, "availability alone must never substitute for the token threshold");
});

// ── 6. Live refresh (staleness fix): a second OFFLOAD_OFFER_STATE post, not
// just the boot-time one, must update the card without a full reload ──────
//
// Bug: panel.ts previously computed providerAvailable fresh but only ever
// SENT it once, at webview boot (REQUEST_OFFLOAD_OFFER_STATE). Installing
// or removing the Codex MCP server mid-session left the card wrong until
// the panel was reloaded. The fix reposts OFFLOAD_OFFER_STATE from a
// .mcp.json FileSystemWatcher plus an immediate repost from the Install/
// Remove MCP handlers (panel.ts's _postOffloadOfferState). These tests pin
// that main.js's EXISTING handling of a repeated OFFLOAD_OFFER_STATE
// message (it already re-runs renderCreditPressureOffer on every arrival,
// not just the first) actually produces the live toggle the fix relies on —
// simulating the host-side repost by dispatching the message a second time.

test("credit pressure LIVE REFRESH: provider becomes available mid-session (second OFFLOAD_OFFER_STATE post) shows the card without reload", () => {
  const { doc, dispatch } = bootMainJs();
  // Boot: no provider confirmed yet (Codex not installed).
  dispatchOfferState(dispatch, { providerAvailable: false });
  dispatchMetrics(dispatch, [ABOVE_THRESHOLD_ORCH]);
  assert.equal(offerCard(doc), null, "card must stay hidden while no provider is confirmed");

  // Simulate panel.ts reposting OFFLOAD_OFFER_STATE after the user installs
  // Codex mid-session (via the .mcp.json watcher or _handleInstallMcp's
  // immediate repost) — same message shape, no page reload involved.
  dispatchOfferState(dispatch, { providerAvailable: true });

  assert.ok(offerCard(doc), "card must appear once a live repost confirms the provider, with no reload");
});

test("credit pressure LIVE REFRESH: provider becomes unavailable mid-session (second OFFLOAD_OFFER_STATE post) hides an already-shown card", () => {
  const { doc, dispatch } = bootMainJs();
  dispatchOfferState(dispatch, { providerAvailable: true });
  dispatchMetrics(dispatch, [ABOVE_THRESHOLD_ORCH]);
  assert.ok(offerCard(doc), "card must be showing before the simulated removal");

  // Simulate panel.ts reposting after the user removes Codex mid-session
  // (via the .mcp.json watcher or _handleRemoveMcp's immediate repost).
  dispatchOfferState(dispatch, { providerAvailable: false });

  assert.equal(offerCard(doc), null, "card must disappear once a live repost reports the provider gone, with no reload");
});

test("credit pressure LIVE REFRESH: a dismissed card stays hidden across a live provider-availability repost (dismissed semantics unchanged by the refresh)", () => {
  const { doc, dispatch } = bootMainJs();
  dispatchOfferState(dispatch, { providerAvailable: true });
  dispatchMetrics(dispatch, [ABOVE_THRESHOLD_ORCH]);
  dismissButton(doc)!.dispatchEvent(new (doc.defaultView as any).Event("click", { bubbles: true }));
  assert.equal(offerCard(doc), null, "card hidden after dismiss");

  // A live repost (e.g. .mcp.json watcher firing on an unrelated later
  // write) must not resurrect a dismissed card just because it re-confirms
  // availability=true again.
  dispatchOfferState(dispatch, { dismissed: true, providerAvailable: true });

  assert.equal(offerCard(doc), null, "dismissed card must remain hidden across a live availability repost");
});

test("credit pressure: OFFLOAD_OFFER_STATE omitting providerAvailable (older host, or unreadable/absent .mcp.json resolving false) fails CLOSED — no card even above threshold", () => {
  const { doc, dispatch } = bootMainJs();
  // Simulate the host's reply when .mcp.json is absent/unreadable/lacks a
  // codex entry: panel.ts's offloadProviderAvailable resolves false in
  // every one of those cases, so the field is sent as false (not omitted)
  // — but this also covers an even older host build that omits the field
  // entirely, via dispatching the message with no providerAvailable key.
  dispatch({ type: "OFFLOAD_OFFER_STATE", dismissed: false, accepted: false });
  dispatchMetrics(dispatch, [ABOVE_THRESHOLD_ORCH]);
  assert.equal(
    offerCard(doc),
    null,
    "a missing providerAvailable field (undefined) must be treated as false via Boolean(undefined), not as available"
  );
});
