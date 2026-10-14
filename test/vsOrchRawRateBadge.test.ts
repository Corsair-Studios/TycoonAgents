/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Regression pin for the INVERTED "vs. orch." cost badge (2026-08-18): the
// badge previously blended billable + cache-read tokens into an "effective"
// $/Mtok rate on BOTH sides of the ratio, with cache reads priced at 0.1x.
// The orchestrator re-reads its large context every turn (~97% cache reads
// in the field), which collapsed its effective rate from 10 (raw opus) down
// toward ~1.27, while cold-start workers stayed near their raw model rate —
// inverting the comparison so Sonnet workers showed as "4x pricier" and
// Haiku as "2.1x pricier" than an Opus orchestrator, backwards. The fix
// compares RAW model rates only (MODEL_PRICE_PER_MTOK, media/main.js
// ~13442: opus=10, sonnet=4, haiku=2, fable=20), independent of either
// side's cache-read volume.
//
// This file boots the REAL media/main.js source via readFileSync + node:vm,
// the same technique test/resolveOrchestratorPrice.test.ts and
// test/cacheReadPricing.test.ts use — media/main.js is a plain untyped
// browser IIFE with no exported symbols, so driving it through DOM
// observation + posted messages is the only viable strategy. Nothing here
// reimplements modelPricePerMtok, fmtRatio, resolveOrchestratorModelRate, or
// the badge rendering logic — every assertion reads the real rendered DOM.
//
// Two independent render sites carry this badge and are both pinned here:
//   1. Metrics table row status-bar label (buildMetricsRow, media/main.js
//      ~13875-13897): `#metrics-tbody .status-bar-label` text.
//   2. Settings per-agent "vs. orch." stat chip (~16060-16103):
//      `.agent-stats .stat-chip` whose text starts with "vs. orch.".
//
// THE CRITICAL PROPERTY: the verdict must be INDEPENDENT of cache-read
// volume on both the orchestrator's and the worker's side. Each ratio test
// below runs across a table of cache-read volumes spanning 0 to ~2.1e9
// (mirroring the real-world screenshot's 2073.2M orchestrator tokens) and
// asserts the rendered text is IDENTICAL across every row. A test that only
// checked one cache profile would have passed while the bug was live.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Rates come from the shipped PRICE_TABLE (media/main.js), not literals, so a
// price refresh never silently invalidates these ratio pins.
const MAIN_JS_SRC_FOR_RATES = readFileSync(join(process.cwd(), "media", "main.js"), "utf8");
function tableRate(key: string): number {
  const m = new RegExp(`"${key}": *\\{ *perMtok: *([0-9.]+)`).exec(MAIN_JS_SRC_FOR_RATES);
  assert.ok(m, "no PRICE_TABLE row for " + key);
  return Number(m[1]);
}
const UNKNOWN_RATE = 3; // DEFAULT_PRICE_KEY row (media/main.js: unknown/metered)
function fmtR(n: number): string {
  return Number.isInteger(Math.round(n * 10) / 10) ? String(Math.round(n)) : (Math.round(n * 10) / 10).toFixed(1);
}
function cheaperLabel(orch: number, worker: number): string {
  return fmtR(orch / worker) + "× cheaper";
}
function pricierLabel(orch: number, worker: number): string {
  return fmtR(worker / orch) + "× pricier";
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
  const posted: any[] = [];
  win.acquireVsCodeApi = () => ({
    postMessage: (m: any) => { posted.push(m); },
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

  return { win, doc, dispatch, getState: () => stateStore, errors, posted };
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
 * Fixture routing payload for agentsPayload()'s fixed agent set (orchestrator +
 * coding-specialist). The per-agent "vs. orch." settings chip
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

/** Opens the Agents modal (formerly Routing; #menu-routing kept, label now "Agents"), feeds it a routing payload, then pushes the given settings payload — required before any `.agent-stats`/vs-orch chip query. */
function pushSettings(doc: any, dispatch: (d: any) => void, payload: any) {
  const menuRoutingBtn = doc.getElementById("menu-routing");
  if (menuRoutingBtn) menuRoutingBtn.click();
  dispatch({ type: "routing", payload: routingPayloadFixture() });
  dispatch({ type: "settings", payload });
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
 * Reads the metrics table row's "vs. orch." status-bar label text for the
 * row whose rendered text contains `displayName` (e.g. "Orchestrator",
 * "Coding Specialist"). Verified directly against the booted DOM: each
 * `#metrics-tbody tr`'s full textContent contains its display name
 * immediately followed by the `.status-bar-label` text (no other
 * separator), so a case-insensitive substring match on the row's
 * textContent unambiguously identifies the row for the two-agent rosters
 * used in this file.
 */
function rowBadgeText(doc: any, displayName: string): string | null {
  const rows = [...doc.querySelectorAll("#metrics-tbody tr")];
  for (const row of rows) {
    const label = row.querySelector(".status-bar-label");
    if (!label) continue;
    if (row.textContent && row.textContent.toLowerCase().includes(displayName.toLowerCase())) {
      return label.textContent;
    }
  }
  return null;
}

/**
 * Reads the Settings per-agent "vs. orch." stat chip text for the
 * `.agent-stats` block whose rendered text contains `displayName`.
 * Verified directly against the booted DOM: each `.agent-stats`
 * textContent is exactly "vs. orch. <value>tasks <n>MCP <n>" with no agent
 * name in the stats block itself, so disambiguation instead walks up one
 * level to the agent card container, which does render the display name
 * (via the name/head element built alongside the stats block).
 */
function chipVsOrchText(doc: any, displayName: string): string | null {
  const rows = [...doc.querySelectorAll(".agent-stats")];
  for (const stats of rows) {
    const chips = [...stats.querySelectorAll(".stat-chip")];
    const vsChip = chips.find((c: any) => /^vs\. orch\./.test(c.textContent || ""));
    if (!vsChip) continue;
    const container = stats.parentElement || stats;
    if (container.textContent && container.textContent.toLowerCase().includes(displayName.toLowerCase())) {
      return vsChip.textContent.replace(/^vs\. orch\.\s*/, "");
    }
  }
  return null;
}

/** Cache-read volumes spanning 0 to ~2.1e9, mirroring the real-world 2073.2M-token screenshot. */
const CACHE_READ_VOLUMES = [0, 1000, 1_000_000, 50_000_000, 500_000_000, 1_000_000_000, 2_073_200_000];

// ---------------------------------------------------------------------------
// (a) Metrics table row badge: Sonnet worker under Opus orchestrator reads
// "2.5x cheaper" regardless of cache-read volume on EITHER side.
// ---------------------------------------------------------------------------

test("metrics row badge: Sonnet worker under Opus orchestrator renders '2.5x cheaper' across the full cache-read-volume table (0 to ~2.1e9), on both orchestrator and worker sides", () => {
  for (const orchCache of CACHE_READ_VOLUMES) {
    for (const workerCache of [0, CACHE_READ_VOLUMES[CACHE_READ_VOLUMES.length - 1]]) {
      const { doc, dispatch, errors } = bootMainJs();
      dispatchMetrics(dispatch, [
        {
          id: "orchestrator",
          name: "Orchestrator",
          status: "idle",
          model: "opus",
          tokens: 2000,
          cacheReadTokens: orchCache,
          activeMs: 1000,
          taskCount: 1,
        },
        {
          id: "coding-specialist",
          name: "Coding Specialist",
          status: "idle",
          model: "sonnet",
          tokens: 100000,
          cacheReadTokens: workerCache,
          activeMs: 5000,
          taskCount: 4,
        },
      ]);
      pushSettings(doc, dispatch, agentsPayload());

      const text = rowBadgeText(doc, "Coding Specialist");
      assert.equal(
        text,
        cheaperLabel(tableRate("anthropic/opus"), tableRate("anthropic/sonnet")),
        `orchCache=${orchCache}, workerCache=${workerCache}: expected the (opus/sonnet table ratio), got '${text}'`,
      );
      assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
    }
  }
});

test("metrics row badge: Haiku worker under Opus orchestrator renders '5x cheaper' across the full cache-read-volume table, independent of cache volume", () => {
  for (const orchCache of CACHE_READ_VOLUMES) {
    const { doc, dispatch, errors } = bootMainJs();
    dispatchMetrics(dispatch, [
      {
        id: "orchestrator",
        name: "Orchestrator",
        status: "idle",
        model: "opus",
        tokens: 2000,
        cacheReadTokens: orchCache,
        activeMs: 1000,
        taskCount: 1,
      },
      {
        id: "coding-specialist",
        name: "Coding Specialist",
        status: "idle",
        model: "haiku",
        tokens: 100000,
        cacheReadTokens: orchCache,
        activeMs: 5000,
        taskCount: 4,
      },
    ]);
    pushSettings(doc, dispatch, agentsPayload());

    const text = rowBadgeText(doc, "Coding Specialist");
    assert.equal(
      text,
      cheaperLabel(tableRate("anthropic/opus"), tableRate("anthropic/haiku")),
      `orchCache=${orchCache}: expected the (opus/haiku table ratio), got '${text}'`,
    );
    assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
  }
});

// ---------------------------------------------------------------------------
// (b) Opus worker under Opus orchestrator: "same cost" (ratio == 1, inside
// the 0.95-1.05 dead zone), regardless of cache-read volume.
// ---------------------------------------------------------------------------

test("metrics row badge: Opus worker under Opus orchestrator renders 'same cost' across the cache-read-volume table", () => {
  for (const cache of CACHE_READ_VOLUMES) {
    const { doc, dispatch, errors } = bootMainJs();
    dispatchMetrics(dispatch, [
      { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: cache, activeMs: 1000, taskCount: 1 },
      { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "opus", tokens: 100000, cacheReadTokens: cache, activeMs: 5000, taskCount: 4 },
    ]);
    pushSettings(doc, dispatch, agentsPayload());

    const text = rowBadgeText(doc, "Coding Specialist");
    assert.equal(text, "same cost", `cache=${cache}: expected 'same cost' (ratio==1), got '${text}'`);
    assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
  }
});

// ---------------------------------------------------------------------------
// (c) Fable worker under Opus orchestrator: "2x pricier" (ratio well below
// 0.95), regardless of cache-read volume.
// ---------------------------------------------------------------------------

test("metrics row badge: Fable worker under Opus orchestrator renders '2x pricier' across the cache-read-volume table", () => {
  for (const cache of CACHE_READ_VOLUMES) {
    const { doc, dispatch, errors } = bootMainJs();
    dispatchMetrics(dispatch, [
      { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: cache, activeMs: 1000, taskCount: 1 },
      { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "fable", tokens: 100000, cacheReadTokens: cache, activeMs: 5000, taskCount: 4 },
    ]);
    pushSettings(doc, dispatch, agentsPayload());

    const text = rowBadgeText(doc, "Coding Specialist");
    assert.equal(text, pricierLabel(tableRate("anthropic/opus"), tableRate("anthropic/fable")), `cache=${cache}: expected the fable/opus rate ratio, got '${text}'`);
    assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
  }
});

// ---------------------------------------------------------------------------
// (d) Orchestrator's own row: always "baseline", never a computed ratio.
// ---------------------------------------------------------------------------

test("metrics row badge: orchestrator's own row always renders 'baseline', regardless of cache-read volume", () => {
  for (const cache of CACHE_READ_VOLUMES) {
    const { doc, dispatch, errors } = bootMainJs();
    dispatchMetrics(dispatch, [
      { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: cache, activeMs: 1000, taskCount: 1 },
      { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, cacheReadTokens: cache, activeMs: 5000, taskCount: 4 },
    ]);
    pushSettings(doc, dispatch, agentsPayload());

    const text = rowBadgeText(doc, "Orchestrator");
    assert.equal(text, "baseline", `cache=${cache}: orchestrator's own row must always read 'baseline', got '${text}'`);
    assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
  }
});

// ---------------------------------------------------------------------------
// (e) Unpriced/unknown model: renders "—", never a fabricated ratio.
// ---------------------------------------------------------------------------

test("metrics row badge: unknown worker model prices via DEFAULT_PRICE_KEY (unknown/metered, $3/Mtok) instead of rendering '—', never a NaN/Infinity ratio", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "some-unknown-model-xyz", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  pushSettings(doc, dispatch, agentsPayload());

  const text = rowBadgeText(doc, "Coding Specialist");
  // Post pricing-refactor: modelPricePerMtok never returns null for a
  // metered-but-unrecognized model — it resolves to DEFAULT_PRICE_KEY
  // ("unknown/metered", $3/Mtok, media/main.js ~13539-13541), so opus (10)
  // vs the $3 fallback renders as "3.3x cheaper", not "—". This is the
  // documented intent of the DEFAULT_PRICE_KEY design, not a regression.
  assert.equal(text, cheaperLabel(tableRate("anthropic/opus"), UNKNOWN_RATE), `expected the (opus/DEFAULT_PRICE_KEY table ratio), got '${text}'`);
  assert.doesNotMatch(String(text), /nan|infinity/i, "unpriced model must never render NaN/Infinity");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("metrics row badge: NEGATIVE ANCHOR -- unpriced orchestrator model renders '—' for the worker row, never a fabricated ratio", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: null, tokens: 500, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  pushSettings(doc, dispatch, agentsPayload());

  const text = rowBadgeText(doc, "Coding Specialist");
  assert.equal(text, "—", `expected '—' when the orchestrator model is unpriced, got '${text}'`);
  assert.doesNotMatch(String(text), /cheaper|pricier|nan|infinity/i, "unpriced orchestrator must never render a fabricated ratio word");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (f) Boundary branching: ratio thresholds at 1.05 and 0.95 exactly.
// MODEL_PRICE_PER_MTOK has no pair of models producing a ratio inside
// (0.95, 1.05) other than 1.0 itself (opus/opus, etc.), so the dead-zone
// ("same cost") and both flanks are pinned via same-model (ratio==1,
// verified in test (b)) plus the sharpest available real ratios: haiku vs.
// sonnet (2/4 = 0.5, well under 0.95 -> pricier) and sonnet vs. haiku (4/2 =
// 2, well over 1.05 -> cheaper). This exercises both branches of the >=1.05
// / <=0.95 conditional with the real fmtRatio()-formatted output.
// ---------------------------------------------------------------------------

test("metrics row badge: Sonnet orchestrator + Haiku worker crosses the >=1.05 branch (sonnet/haiku table ratio), independent of cache-read volume", () => {
  for (const cache of CACHE_READ_VOLUMES) {
    const { doc, dispatch, errors } = bootMainJs();
    dispatchMetrics(dispatch, [
      { id: "orchestrator", name: "Orchestrator", status: "idle", model: "sonnet", tokens: 2000, cacheReadTokens: cache, activeMs: 1000, taskCount: 1 },
      { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "haiku", tokens: 100000, cacheReadTokens: cache, activeMs: 5000, taskCount: 4 },
    ]);
    pushSettings(doc, dispatch, agentsPayload());

    const text = rowBadgeText(doc, "Coding Specialist");
    const want = cheaperLabel(tableRate("anthropic/sonnet"), tableRate("anthropic/haiku"));
    assert.equal(text, want, `cache=${cache}: expected '${want}' (raw sonnet/haiku table ratio, >=1.05 branch), got '${text}'`);
    assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
  }
});

test("metrics row badge: Haiku orchestrator + Sonnet worker crosses the <=0.95 branch (haiku/sonnet table ratio), independent of cache-read volume", () => {
  for (const cache of CACHE_READ_VOLUMES) {
    const { doc, dispatch, errors } = bootMainJs();
    dispatchMetrics(dispatch, [
      { id: "orchestrator", name: "Orchestrator", status: "idle", model: "haiku", tokens: 2000, cacheReadTokens: cache, activeMs: 1000, taskCount: 1 },
      { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, cacheReadTokens: cache, activeMs: 5000, taskCount: 4 },
    ]);
    pushSettings(doc, dispatch, agentsPayload());

    const text = rowBadgeText(doc, "Coding Specialist");
    const want = pricierLabel(tableRate("anthropic/haiku"), tableRate("anthropic/sonnet"));
    assert.equal(text, want, `cache=${cache}: expected '${want}' (raw haiku/sonnet table ratio, <=0.95 branch), got '${text}'`);
    assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
  }
});

// ---------------------------------------------------------------------------
// (g) Settings "vs. orch." stat chip — the same badge, second render site.
// Pinned with the same cache-read-volume table. This call site computes its
// ratio via resolveOrchestratorModelRate() (media/main.js ~16086), the same
// raw-rate helper the row badge uses — see resolveOrchestratorModelRate's
// doc comment for why it is deliberately kept separate from
// resolveOrchestratorPrice()'s blended rate.
// ---------------------------------------------------------------------------

test("settings 'vs. orch.' chip: Sonnet worker under Opus orchestrator renders '2.5x cheaper' across the cache-read-volume table, independent of cache volume on either side", () => {
  for (const orchCache of CACHE_READ_VOLUMES) {
    const { doc, dispatch, errors } = bootMainJs();
    dispatchMetrics(dispatch, [
      {
        id: "orchestrator",
        name: "Orchestrator",
        status: "idle",
        model: "opus",
        tokens: 2000,
        cacheReadTokens: orchCache,
        activeMs: 1000,
        taskCount: 1,
      },
      {
        id: "coding-specialist",
        name: "Coding Specialist",
        status: "idle",
        model: "sonnet",
        tokens: 100000,
        cacheReadTokens: orchCache,
        activeMs: 5000,
        taskCount: 4,
      },
    ]);
    pushSettings(doc, dispatch, agentsPayload());

    const text = chipVsOrchText(doc, "Coding Specialist");
    assert.equal(
      text,
      cheaperLabel(tableRate("anthropic/opus"), tableRate("anthropic/sonnet")),
      `orchCache=${orchCache}: expected the (opus/sonnet table ratio), got '${text}'`,
    );
    assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
  }
});

test("settings 'vs. orch.' chip: orchestrator's own card always renders 'baseline'", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 2_073_200_000, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  pushSettings(doc, dispatch, agentsPayload());

  const text = chipVsOrchText(doc, "Orchestrator");
  assert.equal(text, "baseline", `expected 'baseline' for the orchestrator's own chip, got '${text}'`);
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("settings 'vs. orch.' chip: unknown worker model prices via DEFAULT_PRICE_KEY instead of rendering '—', never a NaN/Infinity ratio", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "some-unknown-model-xyz", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  pushSettings(doc, dispatch, agentsPayload());

  const text = chipVsOrchText(doc, "Coding Specialist");
  // See the row-badge test above: DEFAULT_PRICE_KEY ($3/Mtok) now prices
  // unrecognized-but-metered models instead of returning null.
  assert.equal(text, cheaperLabel(tableRate("anthropic/opus"), UNKNOWN_RATE), `expected the (opus/DEFAULT_PRICE_KEY table ratio), got '${text}'`);
  assert.doesNotMatch(String(text), /nan|infinity/i, "unpriced model must never render NaN/Infinity");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// PHASE 3 PINS: costModelClass() + vsOrchLabel()'s subscription/local/unknown
// branches (media/main.js ~13716, ~13658), unified across both render sites.
// The critical risk phase 3 introduces is regressing the metered
// (Anthropic-vs-Anthropic) path while adding the foreign-model branches, so
// (h) below re-pins the exact known-correct metered values from commit
// 6f6ae6b as a standalone smoke test independent of the cache-read-volume
// sweep above, followed by the three foreign/unknown classes phase 3 adds.
// ---------------------------------------------------------------------------

test("PHASE 3 REGRESSION PIN: Anthropic-vs-Anthropic vs-orch values are unchanged (row badge) -- Sonnet '2.5x cheaper', Haiku '5x cheaper', Opus 'same cost', Fable '2x pricier'", () => {
  const expect = (workerModel: string, expected: string) => {
    const { doc, dispatch, errors } = bootMainJs();
    dispatchMetrics(dispatch, [
      { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
      { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: workerModel, tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
    ]);
    pushSettings(doc, dispatch, agentsPayload());
    const text = rowBadgeText(doc, "Coding Specialist");
    assert.equal(text, expected, `worker model=${workerModel}: expected '${expected}', got '${text}'`);
    assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
  };

  expect("sonnet", cheaperLabel(tableRate("anthropic/opus"), tableRate("anthropic/sonnet")));
  expect("haiku", cheaperLabel(tableRate("anthropic/opus"), tableRate("anthropic/haiku")));
  expect("opus", "same cost");
  expect("fable", pricierLabel(tableRate("anthropic/opus"), tableRate("anthropic/fable")));
});

test("PHASE 3 REGRESSION PIN: Anthropic-vs-Anthropic vs-orch values are unchanged (settings chip) -- Sonnet '2.5x cheaper', Haiku '5x cheaper', Opus 'same cost', Fable '2x pricier'", () => {
  const expect = (workerModel: string, expected: string) => {
    const { doc, dispatch, errors } = bootMainJs();
    dispatchMetrics(dispatch, [
      { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
      { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: workerModel, tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
    ]);
    pushSettings(doc, dispatch, agentsPayload());
    const text = chipVsOrchText(doc, "Coding Specialist");
    assert.equal(text, expected, `worker model=${workerModel}: expected '${expected}', got '${text}'`);
    assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
  };

  expect("sonnet", cheaperLabel(tableRate("anthropic/opus"), tableRate("anthropic/sonnet")));
  expect("haiku", cheaperLabel(tableRate("anthropic/opus"), tableRate("anthropic/haiku")));
  expect("opus", "same cost");
  expect("fable", pricierLabel(tableRate("anthropic/opus"), tableRate("anthropic/fable")));
});

// ---------------------------------------------------------------------------
// (i) Subscription-class model (gpt-*/codex-*): "flat-rate" qualitative
// label only, never a numeric ratio. Both render sites.
// ---------------------------------------------------------------------------

test("PHASE 3: subscription-class model (gpt-5.4-mini) never renders a numeric ratio badge -- row badge reads 'Sub' with no digit or '×'", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "gpt-5.4-mini", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  pushSettings(doc, dispatch, agentsPayload());

  const text = rowBadgeText(doc, "Coding Specialist");
  assert.equal(text, "Sub", `expected 'Sub' for foreign subscription-class model, got '${text}'`);
  assert.doesNotMatch(String(text), /\d|×/, "subscription-class badge must contain no digit and no × ratio symbol");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("PHASE 3: subscription-class model (codex-auto-review) never renders a numeric ratio badge -- settings chip reads 'Sub' with no digit or '×'", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "codex-auto-review", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  pushSettings(doc, dispatch, agentsPayload());

  const text = chipVsOrchText(doc, "Coding Specialist");
  assert.equal(text, "Sub", `expected 'Sub' for foreign subscription-class model, got '${text}'`);
  assert.doesNotMatch(String(text), /\d|×/, "subscription-class badge must contain no digit and no × ratio symbol");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("PHASE 3: subscription-class agent's row renders no dollar figure anywhere in the row", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "gpt-5.4-mini", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  pushSettings(doc, dispatch, agentsPayload());

  const rows = [...doc.querySelectorAll("#metrics-tbody tr")];
  const row = rows.find((r: any) => r.textContent && r.textContent.toLowerCase().includes("coding specialist"));
  assert.ok(row, "expected to find the Coding Specialist row");
  assert.doesNotMatch(String((row as any).textContent), /\$/, "subscription-class agent's row must never render a dollar figure");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (j) Local-class model (ollama:.../lmstudio.../local:... prefix): "local"
// qualitative label only, never a fabricated price or 0x/Infinity/NaN.
// ---------------------------------------------------------------------------

test("PHASE 3: local-class model (ollama:llama3) never renders a fabricated price or 0x/Infinity/NaN -- row badge reads 'Local'", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "ollama:llama3", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  pushSettings(doc, dispatch, agentsPayload());

  const text = rowBadgeText(doc, "Coding Specialist");
  assert.equal(text, "Local", `expected Local for local-class model, got '${text}'`);
  assert.doesNotMatch(String(text), /\d|×/, "local-class badge must contain no digit and no × ratio symbol");
  assert.doesNotMatch(String(text), /NaN|Infinity|0×|\$/, "local-class badge must never fabricate a price, 0×, NaN, or Infinity");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("PHASE 3: local-class model (lmstudio-qwen2.5) never renders a fabricated price or 0x/Infinity/NaN -- settings chip reads 'Local'", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "lmstudio-qwen2.5", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  pushSettings(doc, dispatch, agentsPayload());

  const text = chipVsOrchText(doc, "Coding Specialist");
  assert.equal(text, "Local", `expected Local for local-class model, got '${text}'`);
  assert.doesNotMatch(String(text), /\d|×/, "local-class badge must contain no digit and no × ratio symbol");
  assert.doesNotMatch(String(text), /NaN|Infinity|0×|\$/, "local-class badge must never fabricate a price, 0×, NaN, or Infinity");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (k) Genuinely unknown model (matches none of the classifiers): still
// renders "—" exactly as before phase 3 -- distinguishing "unknown" from
// "subscription"/"local" is the entire point of the phase.
// ---------------------------------------------------------------------------

test("PHASE 3: genuinely unknown model (zzz-7b, matches no classifier) prices via DEFAULT_PRICE_KEY, not misclassified as subscription/local -- row badge", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "zzz-7b", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  pushSettings(doc, dispatch, agentsPayload());

  const text = rowBadgeText(doc, "Coding Specialist");
  // DEFAULT_PRICE_KEY prices "metered but unrecognized" models rather than
  // treating them as unpriced; distinguishing this from subscription/local
  // (which still render "flat-rate"/"local") is the entire point of the
  // phase, so this must never collapse to those labels.
  assert.equal(text, cheaperLabel(tableRate("anthropic/opus"), UNKNOWN_RATE), `expected the (opus/DEFAULT_PRICE_KEY table ratio), got '${text}'`);
  assert.doesNotMatch(String(text), /flat-rate|local|nan|infinity/i, "unknown model must not be misclassified as subscription/local or render NaN/Infinity");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("PHASE 3: genuinely unknown model (zzz-7b, matches no classifier) prices via DEFAULT_PRICE_KEY, not misclassified as subscription/local -- settings chip", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "zzz-7b", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  pushSettings(doc, dispatch, agentsPayload());

  const text = chipVsOrchText(doc, "Coding Specialist");
  assert.equal(text, cheaperLabel(tableRate("anthropic/opus"), UNKNOWN_RATE), `expected the (opus/DEFAULT_PRICE_KEY table ratio), got '${text}'`);
  assert.doesNotMatch(String(text), /flat-rate|local|nan|infinity/i, "unknown model must not be misclassified as subscription/local or render NaN/Infinity");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});


// ---------------------------------------------------------------------------
// Cross-vendor badge: same-vendor keeps the multiplier; foreign vendors show a
// plain billing type with no multiplier and no $ amount.
// ---------------------------------------------------------------------------
const ORCH = { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 };
function foreignRow(extra: any) {
  return { id: "coding-specialist", name: "Coding Specialist", status: "idle", tokens: 0, cacheReadTokens: 0, activeMs: 0, taskCount: 0, ...extra };
}
function badgeFor(extra: any): string | null {
  const { doc, dispatch } = bootMainJs();
  dispatchMetrics(dispatch, [ORCH, foreignRow(extra)]);
  pushSettings(doc, dispatch, agentsPayload());
  return rowBadgeText(doc, "Coding Specialist");
}

test("CROSS-VENDOR: same-vendor (anthropic sonnet vs opus) keeps the 'N× cheaper' multiplier", () => {
  assert.equal(badgeFor({ model: "sonnet", vendor: "anthropic" }), cheaperLabel(tableRate("anthropic/opus"), tableRate("anthropic/sonnet")));
});

test("CROSS-VENDOR: same-vendor Claude subscription (Claude Worker) reads 'Sub'", () => {
  assert.equal(badgeFor({ model: "sonnet", vendor: "anthropic", costModelClass: "subscription" }), "Sub");
});

test("CROSS-VENDOR: foreign metered (moonshot, xai, mistral) read 'Pay per use (API)', never a multiplier, even at 0 tasks", () => {
  for (const [vendor, model] of [["moonshot", "kimi-k2"], ["xai", "xai/grok-4.7"], ["mistral", "mistral-large"]]) {
    const t = badgeFor({ model, vendor, costModelClass: "metered" });
    assert.equal(t, "API", `${vendor}: got '${t}'`);
    assert.doesNotMatch(String(t), /\d|×|\$/);
  }
});

test("CROSS-VENDOR: foreign subscription (codex, gemini via Antigravity) read 'Sub'", () => {
  assert.equal(badgeFor({ model: "gpt-5.6-sol", vendor: "openai", costModelClass: "subscription" }), "Sub");
  assert.equal(badgeFor({ model: "google/gemini-2.5-pro", vendor: "google", costModelClass: "subscription" }), "Sub");
});

test("CROSS-VENDOR: foreign local reads 'Local'", () => {
  assert.equal(badgeFor({ model: "ollama/qwen3", vendor: "ollama", costModelClass: "local" }), "Local");
});

test("CROSS-VENDOR: foreign vendor with unknown billing reads '—'", () => {
  assert.equal(badgeFor({ model: "acme/mystery-1", vendor: "acme" }), "—");
});

test("CROSS-VENDOR: foreign badge tooltip carries the token-counting disclaimer", () => {
  const { doc, dispatch } = bootMainJs();
  dispatchMetrics(dispatch, [ORCH, foreignRow({ model: "kimi-k2", vendor: "moonshot", costModelClass: "metered" })]);
  pushSettings(doc, dispatch, agentsPayload());
  const labels = Array.from(doc.querySelectorAll("#metrics-tbody .status-bar-label")) as any[];
  const titled = labels.map((l) => l.closest("td").title).find((t: string) => /Pay per use \(API key\)/.test(t));
  assert.ok(titled && titled.includes("Different vendors count tokens differently, so costs aren't directly comparable to Claude."), String(titled));
});

// ---------------------------------------------------------------------------
// Delegation tab headline: ratio over same-vendor agents only.
// ---------------------------------------------------------------------------
function delegationText(rows: any[]): string {
  const { doc, dispatch } = bootMainJs();
  dispatchMetrics(dispatch, [{ ...ORCH, tokens: 5000 }, ...rows]);
  pushSettings(doc, dispatch, agentsPayload());
  doc.getElementById("delegation-tab-btn").dispatchEvent(new (doc.defaultView as any).MouseEvent("click", { bubbles: true }));
  return String(doc.getElementById("delegation-stats").textContent);
}
const sonnetRow = () => foreignRow({ id: "w1", name: "W1", model: "sonnet", vendor: "anthropic", tokens: 100000, taskCount: 3 });
const kimiRow = () => foreignRow({ id: "w2", name: "W2", model: "kimi-k2", vendor: "moonshot", costModelClass: "metered", tokens: 100000, taskCount: 2 });

test("DELEGATION HEADLINE: same-vendor ratio kept and foreign agents excluded with a 'not compared' line", () => {
  const t = delegationText([sonnetRow(), kimiRow()]);
  assert.match(t, new RegExp(fmtR(tableRate("anthropic/opus") / tableRate("anthropic/sonnet")) + "× cheaper than running"));
  assert.match(t, /Plus 2 tasks on other vendors \(not compared\)\./);
});

test("DELEGATION HEADLINE: only foreign delegated agents -> no ratio, only the not-compared line", () => {
  const t = delegationText([kimiRow()]);
  assert.doesNotMatch(t, /× cheaper than running/);
  assert.match(t, /Plus 2 tasks on other vendors \(not compared\)\./);
});

test("DELEGATION HEADLINE: no foreign agents -> no 'other vendors' line", () => {
  const t = delegationText([sonnetRow()]);
  assert.doesNotMatch(t, /other vendors/);
});


// ---------------------------------------------------------------------------
// Backend-first vendor/billing: a wrapper subagent runs on Claude haiku but
// its backend (settings route fields) decides vendor and billing.
// ---------------------------------------------------------------------------
function badgeWithBackend(settingsAgent: any, geminiBackend?: string): string | null {
  const { doc, dispatch } = bootMainJs();
  dispatchMetrics(dispatch, [ORCH, foreignRow({ model: "haiku", costModelClass: "metered" })]);
  const menu = doc.getElementById("menu-routing");
  if (menu) menu.click();
  const rp: any = routingPayloadFixture();
  if (geminiBackend) rp.bridge = { mcpJsonPresent: true, mcpServers: ["gemini"], gemini: { serverPresent: true, value: geminiBackend, source: "mcp-json" }, externalSettings: [] };
  dispatch({ type: "routing", payload: rp });
  const payload: any = agentsPayload();
  payload.agents[1] = { ...payload.agents[1], ...settingsAgent };
  dispatch({ type: "settings", payload });
  return rowBadgeText(doc, "Coding Specialist");
}

test("BACKEND: wrapper on haiku with backend xai reads foreign 'API', not a multiplier", () => {
  assert.equal(badgeWithBackend({ vendor: "xai", costModelClass: "metered" }), "API");
});

test("BACKEND: wrapper on haiku with no backend vendor keeps the same-vendor multiplier", () => {
  assert.match(String(badgeWithBackend({})), /× cheaper/);
});

test("BACKEND: google + agy reads 'Sub'", () => {
  assert.equal(badgeWithBackend({ vendor: "google", costModelClass: "metered" }, "agy"), "Sub");
});

test("BACKEND: google + gemini backend reads 'API'", () => {
  assert.equal(badgeWithBackend({ vendor: "google", costModelClass: "subscription" }, "gemini"), "API");
});


test("BACKEND: first metrics render requests settings and routing payloads (so the badge is right without opening Agents)", () => {
  const { dispatch, posted } = bootMainJs();
  dispatchMetrics(dispatch, [ORCH, foreignRow({ model: "haiku" })]);
  const types = posted.map((m: any) => m && m.type);
  assert.ok(types.includes("getSettings"), "getSettings requested");
  assert.ok(types.includes("getRouting"), "getRouting requested");
  dispatchMetrics(dispatch, [ORCH, foreignRow({ model: "haiku" })]);
  assert.equal(posted.filter((m: any) => m && m.type === "getRouting").length, 1, "requested once");
});

test("BACKEND (testbed layout): wrappers on haiku whose backend lives only in .md frontmatter read foreign once settings carry the route fields; gemini with no GEMINI_MCP_BACKEND reads Sub", () => {
  assert.equal(badgeWithBackend({ vendor: "moonshot", costModelClass: "metered" }), "API");
  assert.equal(badgeWithBackend({ vendor: "mistral", costModelClass: "metered" }), "API");
  assert.equal(badgeWithBackend({ vendor: "google", costModelClass: "metered" }), "Sub");
});
