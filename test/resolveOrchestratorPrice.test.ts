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
// Rates come from the shipped PRICE_TABLE (media/main.js), not literals, so a
// price refresh never silently invalidates the ratio pins below.
const MAIN_JS_SRC_FOR_RATES = readFileSync(join(process.cwd(), "media", "main.js"), "utf8");
function tableRate(key: string): number {
  const m = new RegExp(`"${key}": *\\{ *perMtok: *([0-9.]+)`).exec(MAIN_JS_SRC_FOR_RATES);
  assert.ok(m, "no PRICE_TABLE row for " + key);
  return Number(m[1]);
}
function fmtR(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
function assertRatioLine(text: string, ratio: number): void {
  const want = `delegated work ran at ${fmtR(ratio)}× cheaper than running the same billable tokens on the orchestrator's model`;
  assert.ok(text.toLowerCase().includes(want), `expected "${want}", got: ${text}`);
}


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

/**
 * Fixture routing payload for agentsPayload()'s fixed agent set (orchestrator
 * + coding-specialist). The per-agent "vs. orch." settings chip
 * (buildUnifiedAgentCard's .agent-stats, media/main.js ~17894) now lives
 * inside the Agents modal (renderRoutingModal, media/main.js ~18087-18260)
 * and only renders once BOTH a "settings" and a "routing" message have
 * landed and the modal is open (see media/main.js:12534-12545) — mirrors
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
    agents: [
      {
        id: "coding-specialist",
        name: "coding-specialist",
        backend: { vendor: "anthropic", transport: "claude-native", model: "sonnet", costModelClass: "subscription" },
        source: "default",
      },
    ],
    envProbe: {},
    presets: { vendors: ["anthropic"], models: [] },
    lastApplied: {},
  };
}

/** Opens the Agents modal (formerly Routing; #menu-routing kept, label now "Agents") and feeds it a routing payload — required before any `.agent-stats`/vs-orch chip query. */
function openAgentsModal(doc: any, dispatch: (d: any) => void) {
  const menuRoutingBtn = doc.getElementById("menu-routing");
  if (menuRoutingBtn) menuRoutingBtn.click();
  dispatch({ type: "routing", payload: routingPayloadFixture() });
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
// (a) Detected Opus orchestrator -> savings figure still renders as before.
// ---------------------------------------------------------------------------

test("delegation hero: detected Opus orchestrator renders the honest ledger (counterfactual/billed/avoided, no headline percent)", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const body = openDelegationTab(doc);
  assert.equal(body.querySelector(".delegation-hero-num"), null, "the fabricated headline percent must be gone");
  const text = String(body.textContent);
  // Opus counterfactual on 100000 billable tokens: 100000/1e6*10 = 1.00.
  // Sonnet actual billed: 100000/1e6*4 = 0.40. ratio = 1.00/0.40 = 2.5 ->
  // fmtRatio(2.5) = "2.5". No dollar figures render (p60-t2 dollar-free
  // rewrite): the ledger is now token-only plus this one ratio line.
  assertRatioLine(text, tableRate("anthropic/opus") / tableRate("anthropic/sonnet"));
  assert.match(text, /Where delegated work ran/i);
  assert.match(text, /Metered \(API\)/i);
  assert.match(text, /Subscription:.*quota, not billed per token/is);
  assert.match(text, /Local:.*runs on your hardware/is);
  assert.doesNotMatch(text, /\$/, "the Metrics/Delegation tabs render no dollar figures");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (b) NO orchestrator entry -> savings figure absent, unknown-state text
//     renders instead. Also covers an orchestrator entry with an unpriced
//     model (null), the other path resolveOrchestratorPrice floors to null.
// ---------------------------------------------------------------------------

test("delegation hero: NEGATIVE ANCHOR -- no orchestrator metrics entry -> no percentage, no counterfactual $ figure, never 'Opus'", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const body = openDelegationTab(doc);
  assert.equal(body.querySelector(".delegation-hero-num"), null, "no orchestrator entry must NOT render a percentage figure");
  const text = String(body.textContent);
  assert.match(text, /rate not detected yet/i, `expected the "rate not detected yet" unknown state, got: ${text}`);
  assert.doesNotMatch(text, /opus/i, "unknown state must never mention Opus (no fabricated fallback price)");
  assert.doesNotMatch(text, /\$/, "the Metrics/Delegation tabs render no dollar figures");
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
  assert.equal(body.querySelector(".delegation-hero-num"), null, "unpriced orchestrator model must NOT render a percentage figure");
  assert.match(String(body.textContent), /rate not detected yet/i);
  assert.doesNotMatch(String(body.textContent), /nan|infinity/i, "hero body must never leak NaN/Infinity text");
  assert.doesNotMatch(String(body.textContent), /\$/, "the Metrics/Delegation tabs render no dollar figures");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (c) No NaN/Infinity leaks anywhere in rendered output when price is null —
//     covers the Settings "vs. orch." stat chip and the Metrics table's
//     per-row "vs. orch." status-bar label too.
// ---------------------------------------------------------------------------

test("settings 'vs. orch.' stat chip: NEGATIVE ANCHOR -- no orchestrator metrics entry -> chip renders '—', never a computed ratio/NaN/Infinity", () => {
  const { doc, dispatch, errors } = bootMainJs();
  openAgentsModal(doc, dispatch);
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

// ---------------------------------------------------------------------------
// (d) modelBreakdown token-weighted average pricing (2026-08-16 addition).
// MODEL_PRICE_PER_MTOK (media/main.js ~13442): opus=10, sonnet=4, haiku=2,
// fable=20 $/Mtok. resolveOrchestratorPrice (~13529) computes
// sum(tokens_i * price_i) / sum(tokens_i) over priced entries in
// orch.modelBreakdown, skipping unpriced models from both sums, and falls
// back to modelPricePerMtok(orch.model) when the breakdown is absent, empty,
// or fully unpriced.
// ---------------------------------------------------------------------------

test("delegation hero: modelBreakdown {opus:1000, sonnet:1000} blends to a token-weighted price between the opus-only and sonnet-only edges", () => {
  const { doc, dispatch, errors } = bootMainJs();
  // Blended price = (1000*10 + 1000*4) / 2000 = 7 $/Mtok (halfway between
  // opus=10 and sonnet=4). Delegated agent: coding-specialist, sonnet,
  // 100000 tokens -> actual cost = 0.4, counterfactual = 0.7 at price 7 ->
  // savedPct = round((1 - 0.4/0.7) * 100) = 43%. Pure-opus (price 10) on the
  // same agent numbers yields 60% (see test (a)) and pure-sonnet (price 4)
  // yields 0% savings (actual == counterfactual, falls to the "not enough"
  // branch) -- 43% must land strictly below the opus edge, proving the
  // blend actually moved the price rather than ignoring modelBreakdown.
  dispatchMetrics(dispatch, [
    {
      id: "orchestrator",
      name: "Orchestrator",
      status: "idle",
      model: "opus",
      tokens: 2000,
      activeMs: 1000,
      taskCount: 1,
      modelBreakdown: { opus: 1000, sonnet: 1000 },
    },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const body = openDelegationTab(doc);
  assert.equal(body.querySelector(".delegation-hero-num"), null, "no headline percent should ever render");
  const text = String(body.textContent);
  // Blended price 7 $/Mtok: counterfactual = 0.70, billed = 0.40, ratio =
  // 0.70/0.40 = 1.75 -> fmtRatio(1.75) = "1.8".
  assertRatioLine(text, ((tableRate("anthropic/opus") + tableRate("anthropic/sonnet")) / 2) / tableRate("anthropic/sonnet"));
  assert.doesNotMatch(text, /nan|infinity/i, "hero body must never leak NaN/Infinity text");
  assert.doesNotMatch(text, /\$/, "the Metrics/Delegation tabs render no dollar figures");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("delegation hero: modelBreakdown {} (empty) behaves identically to no modelBreakdown at all, falling back to scalar model", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    {
      id: "orchestrator",
      name: "Orchestrator",
      status: "idle",
      model: "opus",
      tokens: 2000,
      activeMs: 1000,
      taskCount: 1,
      modelBreakdown: {},
    },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const body = openDelegationTab(doc);
  assert.equal(body.querySelector(".delegation-hero-num"), null, "no headline percent should ever render");
  const text = String(body.textContent);
  // Empty breakdown falls back to scalar opus price 10 — same ratio as test (a): 2.5×.
  assertRatioLine(text, tableRate("anthropic/opus") / tableRate("anthropic/sonnet"));
  assert.doesNotMatch(text, /nan|infinity/i, "hero body must never leak NaN/Infinity text");
  assert.doesNotMatch(text, /\$/, "the Metrics/Delegation tabs render no dollar figures");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("delegation hero: modelBreakdown with a genuinely unrecognized model prices it via DEFAULT_PRICE_KEY (not excluded/null), blending toward that default", () => {
  const { doc, dispatch, errors } = bootMainJs();
  // { opus: 1000, "some-unknown-model-xyz": 5000 } -- post pricing-refactor,
  // "some-unknown-model-xyz" is NOT excluded from the blend: it resolves to
  // DEFAULT_PRICE_KEY ("unknown/metered", $3/Mtok, media/main.js
  // ~13539-13541) and is priced and counted like any other entry. This is
  // the documented intent of the DEFAULT_PRICE_KEY design (never silently
  // treat an unrecognized-but-metered model as free/excluded), not a
  // regression. Blended price = (1000*10 + 5000*3) / 6000 = 4.1667 $/Mtok.
  // Delegated agent: sonnet, 100000 tokens -> actual cost 0.4, counterfactual
  // 0.41667 -> savedPct = round((1 - 0.4/0.41667) * 100) = 4%.
  dispatchMetrics(dispatch, [
    {
      id: "orchestrator",
      name: "Orchestrator",
      status: "idle",
      model: "opus",
      tokens: 6000,
      activeMs: 1000,
      taskCount: 1,
      modelBreakdown: { opus: 1000, "some-unknown-model-xyz": 5000 },
    },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const body = openDelegationTab(doc);
  assert.equal(body.querySelector(".delegation-hero-num"), null, "no headline percent should ever render");
  const text = String(body.textContent);
  // Blended price 4.1667 $/Mtok: counterfactual ≈ 0.4167, billed = 0.40,
  // ratio ≈ 1.0417 — below the 1.05 "roughly the same rate" threshold, so
  // no ratio multiplier renders.
  assert.match(text, /Delegated work ran at roughly the same rate as the orchestrator's model/i, `expected the "roughly the same rate" line, got: ${text}`);
  assert.doesNotMatch(text, /nan|infinity/i, "hero body must never leak NaN/Infinity text");
  assert.doesNotMatch(text, /\$/, "the Metrics/Delegation tabs render no dollar figures");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("delegation hero: modelBreakdown of entirely unrecognized models still prices via DEFAULT_PRICE_KEY, never null/NaN, even when that price beats the delegated agent's (no savings to show)", () => {
  const { doc, dispatch, errors } = bootMainJs();
  // { "unknown-a": 500, "unknown-b": 500 } -- both entries resolve to
  // DEFAULT_PRICE_KEY ($3/Mtok), NOT excluded and NOT a fallback to the
  // scalar "opus" model. Blended orchestrator price = 3 $/Mtok, which is
  // CHEAPER than the delegated sonnet worker's 4 $/Mtok -- delegating here
  // costs more than the orchestrator's own (default-priced) rate, so the
  // hero renders the "not enough priced delegated work" unknown-state label
  // rather than a fabricated/negative percentage. The property under test
  // is still honesty: no NaN/Infinity, and no null price silently treated
  // as "unpriced" now that DEFAULT_PRICE_KEY prices everything metered.
  dispatchMetrics(dispatch, [
    {
      id: "orchestrator",
      name: "Orchestrator",
      status: "idle",
      model: "opus",
      tokens: 1000,
      activeMs: 1000,
      taskCount: 1,
      modelBreakdown: { "unknown-a": 500, "unknown-b": 500 },
    },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const body = openDelegationTab(doc);
  assert.equal(body.querySelector(".delegation-hero-num"), null, "no headline percent should ever render");
  const text = String(body.textContent);
  // DEFAULT_PRICE_KEY (3 $/Mtok) prices the orchestrator cheaper than the
  // sonnet worker (4 $/Mtok) -- counterfactual (0.30) < billed (0.40), ratio
  // 0.75 is below the 1.05 threshold, so no cheaper-multiplier renders and
  // no negative figure ever appears.
  // 0.75 is below the same-rate band: the hero must make no cheaper/same-rate claim at all.
  assert.doesNotMatch(text, /roughly the same rate|cheaper than running/i, `no relative-cost claim expected, got: ${text}`);
  assert.doesNotMatch(text, /nan|infinity/i, "hero body must never leak NaN/Infinity text");
  assert.doesNotMatch(text, /-\$|\$/, "avoided must never render as a negative dollar figure, and no dollar figures render at all");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});
