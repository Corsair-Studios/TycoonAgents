/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for the split cache-read pricing fix (2026-08-16): the hook layer
// now emits `cacheReadTokens` separately from `tokens` on SubagentStop/Stop
// records (see .claude/tycoon/tycoon-claude-hook.cjs), threaded through
// core/events.ts and core/state.ts's AgentMetric.cacheReadTokens /
// cacheReadModelBreakdown. This file verifies media/main.js's pricing math
// actually applies the ~0.1x cache-read discount rather than pricing cache
// reads at face value (the previous, admittedly-false behavior the footer
// used to describe).
//
// This file boots the REAL media/main.js source via readFileSync + node:vm,
// same technique as test/resolveOrchestratorPrice.test.ts — media/main.js is
// a plain untyped browser IIFE with no exported symbols, so driving it
// through DOM observation + posted messages is the only viable strategy.
// Nothing here reimplements estCostUSDWithCache, resolveOrchestratorPrice, or
// the rendering logic — every assertion reads the real rendered DOM.
//
// MODEL_PRICE_PER_MTOK (media/main.js ~13442): opus=10, sonnet=4, haiku=2,
// fable=20 $/Mtok. Cache reads price at price*0.1.

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
// (a) Metrics table TOKENS column: displays billable + cache-read combined.
// ---------------------------------------------------------------------------

test("metrics table TOKENS column: includes cache-read tokens in the displayed total", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 1000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    {
      id: "coding-specialist",
      name: "Coding Specialist",
      status: "idle",
      model: "sonnet",
      tokens: 100000,
      cacheReadTokens: 400000,
      activeMs: 5000,
      taskCount: 4,
    },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const tokenCells = [...doc.querySelectorAll("#metrics-tbody .col-tokens")];
  const texts = tokenCells.map((c: any) => c.textContent || "");
  // 100000 billable + 400000 cache-read = 500000 total -> fmtTokens (~L13389)
  // renders values <1e6 as "Nk", so this should render "500k"; assert the
  // combined magnitude appears, not the billable-only 100000 ("100k") figure.
  assert.ok(
    texts.some((t: string) => /500k/i.test(t)),
    `expected a TOKENS cell showing the combined 500k total, got: ${JSON.stringify(texts)}`,
  );
  assert.ok(
    !texts.some((t: string) => /^100k$/i.test(t.trim())),
    `TOKENS column must not show billable-only 100k when cache reads exist, got: ${JSON.stringify(texts)}`,
  );
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (b) Delegation hero savings: cache-read tokens must be priced at ~0.1x,
// not at face value, and not ignored entirely.
// ---------------------------------------------------------------------------

test("delegation hero: cache-read tokens are priced at ~0.1x, not face value or zero", () => {
  const { doc, dispatch, errors } = bootMainJs();
  // Orchestrator: opus (10 $/Mtok), no cache reads (isolates the agent side).
  // Delegated agent: sonnet (4 $/Mtok), 0 billable tokens, 1,000,000
  // cache-read tokens. If cache reads were priced at face value, actual cost
  // would be 4.0 (== counterfactual 10.0 at the orchestrator price scaled
  // the same way) -> some savings. If cache reads were ignored (cost=0/null),
  // no hero renders at all. At the correct 0.1x weighting: actual =
  // (1e6/1e6)*4*0.1 = 0.4, counterfactual = (1e6/1e6)*10*0.1 = 1.0 ->
  // savedPct = round((1 - 0.4/1.0)*100) = 60%, IDENTICAL to the pure-billable
  // opus/sonnet baseline in resolveOrchestratorPrice.test.ts test (a) —
  // proving cache reads and billable tokens are weighted consistently at the
  // same relative discount on both sides of the ratio.
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    {
      id: "coding-specialist",
      name: "Coding Specialist",
      status: "idle",
      model: "sonnet",
      tokens: 0,
      cacheReadTokens: 1000000,
      activeMs: 5000,
      taskCount: 4,
    },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const body = openDelegationTab(doc);
  const heroNum = body.querySelector(".delegation-hero-num");

  assert.ok(heroNum, "cache-read-only delegated work must still render a priced hero percentage");
  assert.match(heroNum.textContent, /^~\d+%$/, `hero num should look like "~NN%", got "${heroNum.textContent}"`);
  const pct = Number(heroNum.textContent.replace(/[^\d]/g, ""));
  assert.equal(pct, 60, `cache reads priced at 0.1x on both sides should match the pure-billable 60% baseline, got ${pct}%`);
  assert.doesNotMatch(String(body.textContent), /nan|infinity/i, "hero body must never leak NaN/Infinity text");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("delegation hero: NEGATIVE ANCHOR -- billable=0 and cacheReadTokens=0 is skipped, never treated as priceable zero-cost work", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 0, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const body = openDelegationTab(doc);
  const heroNum = body.querySelector(".delegation-hero-num");
  const heroLabel = body.querySelector(".delegation-hero-label");

  assert.equal(heroNum, null, "zero billable and zero cache-read tokens must not render a percentage");
  assert.ok(heroLabel && /not enough priced/i.test(heroLabel.textContent), `expected a "not enough" explanation, got "${heroLabel && heroLabel.textContent}"`);
  assert.doesNotMatch(String(body.textContent), /nan|infinity/i, "hero body must never leak NaN/Infinity text");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (c) Per-agent "vs. orch." status-bar label (Metrics table) blends
// billable + cache-read into an effective rate before computing the ratio.
// ---------------------------------------------------------------------------

test("metrics table row 'vs. orch.': heavy cache-read usage makes an agent look cheaper than billable-only pricing would suggest", () => {
  const { doc, dispatch, errors } = bootMainJs();
  // Orchestrator: opus (10 $/Mtok). Agent: sonnet (4 $/Mtok raw), but with
  // 9x more cache-read tokens than billable ones, its EFFECTIVE rate should
  // sit well below the raw 4 $/Mtok sonnet rate (since 90% of its tokens are
  // priced at 0.1x), so the "cheaper" ratio must be visibly larger than the
  // billable-only opus/sonnet ratio (10/4 = 2.5x).
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    {
      id: "coding-specialist",
      name: "Coding Specialist",
      status: "idle",
      model: "sonnet",
      tokens: 100000,
      cacheReadTokens: 900000,
      activeMs: 5000,
      taskCount: 4,
    },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const labels = [...doc.querySelectorAll("#metrics-tbody .status-bar-label")];
  const texts = labels.map((l: any) => l.textContent || "");
  const cheaperLabel = texts.find((t: string) => /cheaper/.test(t));
  assert.ok(cheaperLabel, `expected a "...x cheaper" label, got: ${JSON.stringify(texts)}`);
  const ratio = Number(cheaperLabel.replace(/[^\d.]/g, ""));
  // Effective sonnet rate = (100000*4 + 900000*0.4) / 1000000 = 0.76 $/Mtok.
  // Ratio vs opus(10) = 10 / 0.76 ≈ 13.16x -- must be well above the
  // billable-only 2.5x (10/4) baseline.
  assert.ok(ratio > 5, `cache-read-heavy agent should show a much larger cheaper-ratio than the billable-only 2.5x baseline, got ${ratio}x`);
  for (const t of texts) {
    assert.doesNotMatch(t, /nan|infinity/i, `status-bar label must never contain NaN/Infinity, got "${t}"`);
  }
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (d) Footer disclaimer text: both occurrences (Metrics tab caption,
// Delegation tab caption) must be textually IDENTICAL and must not claim a
// real API bill runs "well below" the shown total (removed as part of this
// fix, since cache reads are no longer counted at face value).
// ---------------------------------------------------------------------------

test("pricing disclaimer footer: Metrics tab and Delegation tab captions are textually identical and describe split cache-read pricing accurately", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 500, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, cacheReadTokens: 5000, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const metricsCaption = doc.getElementById("metrics-stats-caption");
  assert.ok(metricsCaption, "Metrics tab pricing caption should exist");

  openDelegationTab(doc);
  const delegationBody = doc.getElementById("delegation-stats");
  const delegationCaptions = [...delegationBody.querySelectorAll(".delegation-stats-caption")];
  const delegationPricingCaption = delegationCaptions.find((c: any) => /Anthropic API token rates/i.test(c.textContent || ""));
  assert.ok(delegationPricingCaption, "Delegation tab pricing caption should exist");

  assert.equal(
    metricsCaption.textContent,
    delegationPricingCaption.textContent,
    "both footer occurrences must be textually identical",
  );
  assert.doesNotMatch(
    String(metricsCaption.textContent),
    /well below what raw totals suggest/i,
    "footer must not claim a real bill runs well below the shown total now that cache reads are priced (not ignored)",
  );
  assert.doesNotMatch(String(metricsCaption.textContent), /nan|infinity/i);
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});
