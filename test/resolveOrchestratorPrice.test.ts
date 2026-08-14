/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for the resolveOrchestratorPrice() fix (2026-08-13, see
// docs/KNOWN-BUG-orchestrator-price-fallback.md): the function used to
// silently fall back to Opus pricing ($10/Mtok) whenever the orchestrator's
// model could not be determined, fabricating a price and inflating every
// "Nx cheaper" / "% saved" figure derived from it. It now returns `null` in
// that case, and every caller must render an honest unknown state instead
// of computing a ratio against a fabricated baseline.
//
// This file boots the REAL media/main.js source via readFileSync + node:vm,
// the same technique test/orchestratorModelWarning.test.ts and
// test/webviewSmoke.test.ts already use — media/main.js is a plain untyped
// browser IIFE with no exported symbols, so driving it through DOM
// observation + posted messages is the only viable strategy (see that
// file's "Loading strategy chosen" comment for the full rationale). Nothing
// here reimplements resolveOrchestratorPrice, modelPricePerMtok, or the
// rendering logic — every assertion reads the real rendered DOM.
//
// Contract pinned (verified against the shipped code, not re-derived):
//   1. resolveOrchestratorPrice(metrics) (media/main.js ~13516-13520) finds
//      the metrics entry with id "orchestrator", resolves its price via
//      modelPricePerMtok(orch.model), and returns that price or `null` —
//      never MODEL_PRICE_PER_MTOK.opus as a silent default.
//   2. The Delegation tab's hero savings stat (renderDelegationStats,
//      media/main.js ~13955-13990) renders ".delegation-hero-num" (e.g.
//      "~40%") + ".delegation-hero-sub" when priced, or ONLY
//      ".delegation-hero-label" with no ".delegation-hero-num" when
//      orchestratorPrice is null — the text must read as an unknown state,
//      not an error, and must never contain "Opus" (that would mean the
//      code regressed into showing a fallback-derived figure).
//   3. The per-agent Settings "vs. orch." stat chip (media/main.js
//      ~15868-15884) renders "—" when resolveOrchestratorPrice is null,
//      never a ratio computed against 0/Infinity/NaN.

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
  win.acquireVsCodeApi = () => ({
    postMessage: () => {},
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

  return { win, doc, dispatch, getState: () => stateStore, errors };
}

function agentsPayload() {
  return {
    hook: { installed: true, lastActivityAt: null },
    agents: [
      { id: "orchestrator", name: "Orchestrator", model: null, isOrchestrator: true, keywords: "" },
      { id: "coding-specialist", name: "Coding Specialist", model: "sonnet", isOrchestrator: false, keywords: "" },
    ],
    delegation_mode: "direct",
    delegationHealth: {},
    hookHealth: { healthy: true, issueCount: 0 },
    contextBudget: null,
  };
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

/** Opens the Delegation tab and returns its rendered hero DOM. */
function openDelegationTab(doc: any) {
  const btn = doc.getElementById("delegation-tab-btn");
  assert.ok(btn, "delegation-tab-btn should exist");
  btn.dispatchEvent(new (doc.defaultView as any).MouseEvent("click", { bubbles: true }));
  const body = doc.getElementById("delegation-stats");
  assert.ok(body, "#delegation-stats body should exist");
  return body;
}

// ---------------------------------------------------------------------------
// (a) Detected Opus orchestrator -> savings figure still renders as before.
// ---------------------------------------------------------------------------

test("delegation hero: detected Opus orchestrator renders a priced savings percentage (no regression)", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const body = openDelegationTab(doc);
  const heroNum = body.querySelector(".delegation-hero-num");
  const heroLabel = body.querySelector(".delegation-hero-label");
  const heroSub = body.querySelector(".delegation-hero-sub");

  assert.ok(heroNum, "a priced Opus orchestrator should render a hero percentage");
  assert.match(heroNum.textContent, /^~\d+%$/, `hero num should look like "~NN%", got "${heroNum.textContent}"`);
  assert.ok(heroLabel && /avoided by delegating/i.test(heroLabel.textContent), "label should describe cost avoided");
  assert.ok(heroSub && heroSub.textContent.length > 0, "sub-line should render");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (b) NO orchestrator entry -> savings figure absent, unknown-state text
//     renders instead. Also covers an orchestrator entry with an unpriced
//     model (null), the other path resolveOrchestratorPrice floors to null.
// ---------------------------------------------------------------------------

test("delegation hero: NEGATIVE ANCHOR -- no orchestrator metrics entry -> no percentage, unknown-state text, never 'Opus'", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const body = openDelegationTab(doc);
  const heroNum = body.querySelector(".delegation-hero-num");
  const heroLabel = body.querySelector(".delegation-hero-label");

  assert.equal(heroNum, null, "no orchestrator entry must NOT render a percentage figure");
  assert.ok(heroLabel, "an explanatory label must render instead");
  assert.match(heroLabel.textContent, /savings unavailable/i, `expected an "unavailable" explanation, got "${heroLabel.textContent}"`);
  assert.doesNotMatch(String(heroLabel.textContent), /opus/i, "unknown state must never mention Opus (no fabricated fallback price)");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("delegation hero: NEGATIVE ANCHOR -- orchestrator entry present but model unpriced (null) -> unknown-state text, no NaN/Infinity", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: null, tokens: 500, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const body = openDelegationTab(doc);
  const heroNum = body.querySelector(".delegation-hero-num");
  const heroLabel = body.querySelector(".delegation-hero-label");

  assert.equal(heroNum, null, "unpriced orchestrator model must NOT render a percentage figure");
  assert.ok(heroLabel && /savings unavailable/i.test(heroLabel.textContent));
  assert.doesNotMatch(String(body.textContent), /nan|infinity/i, "hero body must never leak NaN/Infinity text");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (c) No NaN/Infinity leaks anywhere in rendered output when price is null —
//     covers the Settings "vs. orch." stat chip and the Metrics table's
//     per-row "vs. orch." status-bar label too.
// ---------------------------------------------------------------------------

test("settings 'vs. orch.' stat chip: NEGATIVE ANCHOR -- no orchestrator metrics entry -> chip renders '—', never a computed ratio/NaN/Infinity", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const rows = [...doc.querySelectorAll(".agent-stats")];
  assert.ok(rows.length > 0, "at least one agent stats row should render");
  const chipTexts = rows.map((r: any) => r.textContent || "");
  const hasDash = chipTexts.some((t: string) => /vs\. orch\.\s*—/.test(t));
  assert.ok(hasDash, `expected a "vs. orch. —" chip somewhere, got: ${JSON.stringify(chipTexts)}`);
  for (const t of chipTexts) {
    assert.doesNotMatch(t, /nan|infinity/i, `stat chip text must never contain NaN/Infinity, got "${t}"`);
  }
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("metrics table row: NEGATIVE ANCHOR -- no orchestrator metrics entry -> 'vs. orch.' status-bar label renders '—', never NaN/Infinity", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const labels = [...doc.querySelectorAll("#metrics-tbody .status-bar-label")];
  assert.ok(labels.length > 0, "at least one metrics row status-bar label should render");
  const texts = labels.map((l: any) => l.textContent || "");
  assert.ok(texts.some((t: string) => t === "—"), `expected a "—" label somewhere, got: ${JSON.stringify(texts)}`);
  for (const t of texts) {
    assert.doesNotMatch(t, /nan|infinity/i, `status-bar label must never contain NaN/Infinity, got "${t}"`);
  }
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});
