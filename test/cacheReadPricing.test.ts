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
// (a) Metrics table TOKENS column: billable and cache-read tokens are shown
// SEPARATELY (spec p63-t3/p63-t5) -- the main figure is billable-only
// (input + output + cache-creation), never combined with cache-read tokens,
// which render only in a distinct " + Xk cached" span alongside it.
// ---------------------------------------------------------------------------

test("metrics table TOKENS column: shows billable tokens only in the main figure, cache-read tokens only in a separate cached span", () => {
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
  // Cache reads are never folded into the displayed total: the combined
  // magnitude (500k) must never appear anywhere in the column.
  assert.ok(
    !texts.some((t: string) => /500k/i.test(t)),
    `TOKENS column must never show a combined 500k figure (cache reads are not folded into totals), got: ${JSON.stringify(texts)}`,
  );
  // The billable-only figure (100k) must appear, in its own main span.
  assert.ok(
    texts.some((t: string) => /^100k/i.test(t.trim())),
    `expected a TOKENS cell showing the billable-only 100k figure, got: ${JSON.stringify(texts)}`,
  );
  // The cache-read amount is still visible, but only via the separate
  // " + 400k cached" span, never merged into the main figure.
  assert.ok(
    texts.some((t: string) => /\+\s*400k\s*cached/i.test(t)),
    `expected a TOKENS cell showing "+ 400k cached" separately, got: ${JSON.stringify(texts)}`,
  );
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (b) Delegation hero savings: cache-read tokens must be priced at ~0.1x,
// not at face value, and not ignored entirely.
// ---------------------------------------------------------------------------

test("delegation hero: cache-read tokens are counted into the Metered token total, not shown as a dollar figure", () => {
  const { doc, dispatch, errors } = bootMainJs();
  // Orchestrator: opus, no cache reads (isolates the agent side).
  // Delegated agent: sonnet, 0 billable tokens, 1,000,000 cache-read tokens.
  // The dollar-free rewrite (p60-t2) removed every $ figure from the
  // Metrics/Delegation tabs: the Metered row now shows only the token
  // total (billable + cache-read, still priced internally at 0.1x for the
  // relative-ratio math, but never rendered as USD), and the ratio line
  // built from fmtRatio replaces the old three-line counterfactual/billed/
  // avoided block.
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
  assert.equal(body.querySelector(".delegation-hero-num"), null, "the headline percent was removed 2026-09-07");
  const text = String(body.textContent);
  assert.match(text, /Metered \(API\):\s*1M tokens/i, `expected the Metered row to report 1M tokens (billable + cache-read), got: ${text}`);
  assert.doesNotMatch(text, /\$/, "the Metrics/Delegation tabs render no dollar figures");
  assert.doesNotMatch(text, /nan|infinity/i, "hero body must never leak NaN/Infinity text");
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
  assert.equal(body.querySelector(".delegation-hero-num"), null, "zero billable and zero cache-read tokens must not render a percentage");
  const text = String(body.textContent);
  assert.match(text, /Metered \(API\): no tokens yet/i, `expected the Metered row to report "no tokens yet", got: ${text}`);
  assert.doesNotMatch(text, /nan|infinity/i, "hero body must never leak NaN/Infinity text");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (c) Per-agent "vs. orch." status-bar label (Metrics table) now compares
// RAW model rates, deliberately independent of cache-read volume. Blending
// cache reads into an "effective" rate here (as this section used to test)
// was the bug: the orchestrator runs ~97% cache reads in production, so its
// effective rate collapsed and Sonnet workers rendered as pricier instead of
// cheaper. See resolveOrchestratorModelRate (media/main.js:13619) and the
// badge computation (media/main.js ~13875-13897). The correct behavior is
// pinned in test/vsOrchRawRateBadge.test.ts across a range of cache-read
// volumes -- do not reintroduce a cache-read blend into this badge.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (d) Footer disclaimer text: both occurrences (Metrics tab caption,
// Delegation tab caption) must be textually IDENTICAL and must not claim a
// real API bill runs "well below" the shown total (removed as part of this
// fix, since cache reads are no longer counted at face value).
// ---------------------------------------------------------------------------

test("pricing disclaimer footer: Metrics tab and Delegation tab captions are textually identical and state badges are relative-only, informational", () => {
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
  const delegationPricingCaption = delegationCaptions.find((c: any) => /Relative cost badges/i.test(c.textContent || ""));
  assert.ok(delegationPricingCaption, "Delegation tab pricing caption should exist");

  assert.equal(
    metricsCaption.textContent,
    delegationPricingCaption.textContent,
    "both footer occurrences must be textually identical",
  );
  assert.equal(
    String(metricsCaption.textContent),
    "Relative cost badges compare published list rates and are informational only.",
    "the dollar-free rewrite (p60-t2) replaced the pricing footnote with this exact relative-cost-only disclaimer",
  );
  assert.doesNotMatch(String(metricsCaption.textContent), /nan|infinity|\$/i);
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});
