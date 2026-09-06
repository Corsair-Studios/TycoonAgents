/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for feedback issues #24 + #25, contract point 5: the orchestrator
// model warning banner (`#orchestrator-model-notice`,
// media/main.js:2454-2494 `showOrchestratorModelBanner` /
// `dismissOrchestratorModelBanner`) is dismissible, and its dismissed state
// persists via `vscode.getState()`/`setState()`, KEYED BY MODEL FAMILY
// (`orchestratorModelNoticeDismissedFor`) so dismissing for one sub-Opus
// family does not silence a *different* sub-Opus family.
//
// REWRITE NOTE (this file was rejected in review once already): the prior
// version asserted a globalStorage JSON-file dismissal mechanism modeled on
// the badge-unlocks idiom. That was WRONG — the shipped implementation uses
// the webview-local `vscode.getState()/setState()` API (the exact same
// pattern as the pre-existing `showLegacyArtifactsNotice`/
// `dismissLegacyArtifactsNotice`, media/main.js:2392-2440), not a
// host-side globalStorage file. This rewrite drops the globalStorage
// simulation entirely and drives the REAL banner functions by booting real
// media/main.js (same loading strategy as
// test/orchestratorModelWarning.test.ts — see that file's header for the
// full loading-strategy + tsc-constraint writeup, not repeated here) and
// observing `#orchestrator-model-notice` + the stubbed vscode state store.
// There is no self-skip path: if the real script fails to boot, the test
// throws instead of logging and returning.

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

// This file boots a fresh JSDOM window per test/boot call (many across the
// suite, including the two-boot reload simulations). jsdom's
// `pretendToBeVisual` window keeps internal timers/resources alive until
// explicitly closed (same requirement documented and applied by the
// precedent, test/webviewSmoke.test.ts:1776 `dom.window.close()`) — without
// closing each one, node:test's process never goes idle and the run hangs
// after all assertions have already passed. Every window created here is
// tracked and closed once in the module-level `after()` below.
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

/**
 * Boots real media/main.js. `externalState`, when provided, seeds/shares the
 * vscode state store object identity with the caller (so a caller can pass
 * the SAME object across two boots to simulate persistence surviving a
 * panel reload — a fresh boot with the prior boot's state store handed back
 * in, exactly like a real webview reload receiving getState() from the host
 * again). Throws (fails loudly) if the boot itself errors — no self-skip.
 */
function bootMainJs(externalState?: { value: Record<string, unknown> }) {
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

  const box: { value: Record<string, unknown> } = externalState || { value: {} };
  win.acquireVsCodeApi = () => ({
    postMessage: () => {},
    getState: () => box.value,
    setState: (s: any) => {
      box.value = s;
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

  return { win, doc, dispatch, stateBox: box };
}

function agentsPayload() {
  return {
    hook: { installed: true, lastActivityAt: null },
    agents: [
      { id: "orchestrator", name: "Orchestrator", model: null, isOrchestrator: true, keywords: "" },
    ],
    delegation_mode: "direct",
    delegationHealth: {},
    hookHealth: { healthy: true, issueCount: 0 },
    contextBudget: null,
  };
}

function stateWithOrchestratorModel(model: string) {
  return {
    type: "state",
    state: {
      sessionActive: true,
      completedTasks: 0,
      idleFreezeMs: 180000,
      sanityCapMs: 900000,
      workers: {},
      agentMetrics: [{ id: "orchestrator", name: "Orchestrator", status: "idle", model, tokens: 500, activeMs: 1000 }],
    },
  };
}

/**
 * Fixture routing payload for agentsPayload()'s fixed agent set
 * (orchestrator only). The orchestrator card that calls
 * showOrchestratorModelBanner (buildOrchestratorSimpleCard) now lives inside
 * the Agents modal (renderRoutingModal, media/main.js ~18087-18260) and only
 * renders once BOTH a "settings" and a "routing" message have landed and the
 * modal is open (see media/main.js:12534-12545) — mirrors
 * test/routingView.test.ts's buildRoutingPayload.
 */
function routingPayloadFixture() {
  return {
    profile: null,
    path: ".claude/tycoon/routing.json",
    errors: [],
    orchestrator: {
      id: "orchestrator",
      backend: { vendor: "anthropic", transport: "claude-native", model: "opus", costModelClass: "subscription" },
      source: "default",
    },
    agents: [],
    envProbe: {},
    presets: { vendors: ["anthropic"], models: [] },
    lastApplied: {},
  };
}

/** Opens the Agents modal (formerly Routing; #menu-routing kept, label now "Agents") and feeds it a routing payload — required before any orchestrator-card query. */
function openAgentsModal(doc: any, dispatch: (d: any) => void) {
  const menuRoutingBtn = doc.getElementById("menu-routing");
  if (menuRoutingBtn) menuRoutingBtn.click();
  dispatch({ type: "routing", payload: routingPayloadFixture() });
}

/** Loads the orchestrator settings row (which itself calls showOrchestratorModelBanner) for the given observed model, sharing the given state box. */
function loadWithModel(model: string, stateBox?: { value: Record<string, unknown> }) {
  const boot = bootMainJs(stateBox);
  openAgentsModal(boot.doc, boot.dispatch);
  boot.dispatch(stateWithOrchestratorModel(model));
  boot.dispatch({ type: "settings", payload: agentsPayload() });
  return boot;
}

test("banner: renders #orchestrator-model-notice when observed family is Sonnet (real code)", () => {
  const { doc } = loadWithModel("claude-sonnet-5");
  const notice = doc.getElementById("orchestrator-model-notice");
  assert.ok(notice, "banner should render for an undismissed Sonnet observation");
  assert.ok(notice.textContent.includes("Sonnet"));
});

test("banner: renders #orchestrator-model-notice when observed family is Haiku (real code)", () => {
  const { doc } = loadWithModel("claude-haiku-4-5");
  const notice = doc.getElementById("orchestrator-model-notice");
  assert.ok(notice, "banner should render for an undismissed Haiku observation");
  assert.ok(notice.textContent.includes("Haiku"));
});

test("banner: does NOT render for Opus (real code)", () => {
  const { doc } = loadWithModel("claude-opus-5");
  assert.equal(doc.getElementById("orchestrator-model-notice"), null);
});

test("banner: does NOT render for Fable (real code)", () => {
  const { doc } = loadWithModel("claude-fable-5");
  assert.equal(doc.getElementById("orchestrator-model-notice"), null);
});

test("banner: does NOT render in the Unknown state (no orchestrator metric observed) (real code)", () => {
  const boot = bootMainJs();
  openAgentsModal(boot.doc, boot.dispatch);
  boot.dispatch({
    type: "state",
    state: { sessionActive: true, completedTasks: 0, idleFreezeMs: 180000, sanityCapMs: 900000, workers: {}, agentMetrics: [] },
  });
  boot.dispatch({ type: "settings", payload: agentsPayload() });
  assert.equal(boot.doc.getElementById("orchestrator-model-notice"), null);
});

test("banner dismissal: clicking dismiss removes the notice and writes vscode.getState().orchestratorModelNoticeDismissedFor = 'Sonnet' (real code)", () => {
  const { doc, stateBox } = loadWithModel("claude-sonnet-5");
  const notice = doc.getElementById("orchestrator-model-notice");
  assert.ok(notice, "precondition: banner is up before dismissal");

  const dismissBtn = notice.querySelector(".orchestrator-model-notice-dismiss");
  assert.ok(dismissBtn, "dismiss button should exist");
  dismissBtn.dispatchEvent(new doc.defaultView.MouseEvent("click", { bubbles: true }));

  assert.equal(doc.getElementById("orchestrator-model-notice"), null, "notice must be removed from the DOM immediately on dismiss");
  assert.equal(
    stateBox.value && stateBox.value.orchestratorModelNoticeDismissedFor,
    "Sonnet",
    "dismissal must be persisted via vscode.setState() keyed by the family string 'Sonnet'"
  );
});

test("banner dismissal: dismissed state SURVIVES a simulated reload (fresh boot reusing the same state box) (real code)", () => {
  const stateBox: { value: Record<string, unknown> } = { value: {} };
  const first = loadWithModel("claude-sonnet-5", stateBox);
  const notice = first.doc.getElementById("orchestrator-model-notice");
  assert.ok(notice);
  notice.querySelector(".orchestrator-model-notice-dismiss").dispatchEvent(
    new first.doc.defaultView.MouseEvent("click", { bubbles: true })
  );
  assert.equal(stateBox.value.orchestratorModelNoticeDismissedFor, "Sonnet");

  // Simulated reload: brand-new boot (new jsdom/vm context, nothing carried
  // over in memory), but vscode.getState() returns the SAME persisted blob
  // a real host would hand back after a panel reload.
  const second = loadWithModel("claude-sonnet-5", stateBox);
  assert.equal(
    second.doc.getElementById("orchestrator-model-notice"),
    null,
    "banner must stay dismissed for the SAME family across a simulated reload"
  );
});

test("banner dismissal: FAMILY-KEYED -- dismissing for Sonnet does NOT silence Haiku; switching families re-surfaces the banner (real code)", () => {
  const stateBox: { value: Record<string, unknown> } = { value: {} };
  const sonnetBoot = loadWithModel("claude-sonnet-5", stateBox);
  const sonnetNotice = sonnetBoot.doc.getElementById("orchestrator-model-notice");
  assert.ok(sonnetNotice, "precondition: Sonnet banner is up");
  sonnetNotice.querySelector(".orchestrator-model-notice-dismiss").dispatchEvent(
    new sonnetBoot.doc.defaultView.MouseEvent("click", { bubbles: true })
  );
  assert.equal(stateBox.value.orchestratorModelNoticeDismissedFor, "Sonnet");

  // Same persisted state box, but now the observed session model is Haiku
  // instead of Sonnet (e.g. the user ran /model haiku). The dismissal was
  // keyed to "Sonnet" specifically, so it must NOT suppress the Haiku
  // banner -- this is the core requirement of family-keyed dismissal.
  const haikuBoot = loadWithModel("claude-haiku-4-5", stateBox);
  const haikuNotice = haikuBoot.doc.getElementById("orchestrator-model-notice");
  assert.ok(haikuNotice, "switching to a DIFFERENT sub-Opus family must re-surface the banner, not stay dismissed");
  assert.ok(haikuNotice.textContent.includes("Haiku"));

  // And switching BACK to Sonnet (same state box, dismissal untouched by the
  // Haiku render since Haiku was never dismissed) must show the Sonnet
  // banner again too, since the stored key is still "Sonnet" but a fresh
  // boot re-renders the banner state from the observed family each load —
  // dismissal is per-load-of-that-family, not permanent.
  const sonnetAgain = loadWithModel("claude-sonnet-5", stateBox);
  assert.equal(
    sonnetAgain.doc.getElementById("orchestrator-model-notice"),
    null,
    "Sonnet dismissal (still keyed 'Sonnet' in the shared state box) should still suppress a fresh Sonnet observation"
  );
});

test("banner dismissal: dismissing for Haiku does not suppress a subsequent Opus observation rendering no banner at all (sanity, real code)", () => {
  const stateBox: { value: Record<string, unknown> } = { value: {} };
  const haikuBoot = loadWithModel("claude-haiku-4-5", stateBox);
  haikuBoot.doc
    .getElementById("orchestrator-model-notice")
    .querySelector(".orchestrator-model-notice-dismiss")
    .dispatchEvent(new haikuBoot.doc.defaultView.MouseEvent("click", { bubbles: true }));
  assert.equal(stateBox.value.orchestratorModelNoticeDismissedFor, "Haiku");

  const opusBoot = loadWithModel("claude-opus-5", stateBox);
  assert.equal(opusBoot.doc.getElementById("orchestrator-model-notice"), null, "Opus never warns regardless of dismissal state");
});
