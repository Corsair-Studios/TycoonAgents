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
      dispatch({ type: "settings", payload: agentsPayload() });

      const text = rowBadgeText(doc, "Coding Specialist");
      assert.equal(
        text,
        "2.5× cheaper",
        `orchCache=${orchCache}, workerCache=${workerCache}: expected '2.5× cheaper' (raw 10/4 opus/sonnet rate ratio), got '${text}'`,
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
    dispatch({ type: "settings", payload: agentsPayload() });

    const text = rowBadgeText(doc, "Coding Specialist");
    assert.equal(
      text,
      "5× cheaper",
      `orchCache=${orchCache}: expected '5× cheaper' (raw 10/2 opus/haiku rate ratio), got '${text}'`,
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
    dispatch({ type: "settings", payload: agentsPayload() });

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
    dispatch({ type: "settings", payload: agentsPayload() });

    const text = rowBadgeText(doc, "Coding Specialist");
    assert.equal(text, "2× pricier", `cache=${cache}: expected '2× pricier' (raw 20/10 fable/opus rate ratio), got '${text}'`);
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
    dispatch({ type: "settings", payload: agentsPayload() });

    const text = rowBadgeText(doc, "Orchestrator");
    assert.equal(text, "baseline", `cache=${cache}: orchestrator's own row must always read 'baseline', got '${text}'`);
    assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
  }
});

// ---------------------------------------------------------------------------
// (e) Unpriced/unknown model: renders "—", never a fabricated ratio.
// ---------------------------------------------------------------------------

test("metrics row badge: NEGATIVE ANCHOR -- unpriced/unknown worker model renders '—', never a fabricated ratio", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "some-unknown-model-xyz", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const text = rowBadgeText(doc, "Coding Specialist");
  assert.equal(text, "—", `expected '—' for an unpriced model, got '${text}'`);
  assert.doesNotMatch(String(text), /cheaper|pricier|nan|infinity/i, "unpriced model must never render a fabricated ratio word");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("metrics row badge: NEGATIVE ANCHOR -- unpriced orchestrator model renders '—' for the worker row, never a fabricated ratio", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: null, tokens: 500, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

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

test("metrics row badge: Sonnet orchestrator + Haiku worker crosses the >=1.05 branch ('2x cheaper'), independent of cache-read volume", () => {
  for (const cache of CACHE_READ_VOLUMES) {
    const { doc, dispatch, errors } = bootMainJs();
    dispatchMetrics(dispatch, [
      { id: "orchestrator", name: "Orchestrator", status: "idle", model: "sonnet", tokens: 2000, cacheReadTokens: cache, activeMs: 1000, taskCount: 1 },
      { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "haiku", tokens: 100000, cacheReadTokens: cache, activeMs: 5000, taskCount: 4 },
    ]);
    dispatch({ type: "settings", payload: agentsPayload() });

    const text = rowBadgeText(doc, "Coding Specialist");
    assert.equal(text, "2× cheaper", `cache=${cache}: expected '2× cheaper' (raw 4/2 sonnet/haiku ratio, >=1.05 branch), got '${text}'`);
    assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
  }
});

test("metrics row badge: Haiku orchestrator + Sonnet worker crosses the <=0.95 branch ('2x pricier'), independent of cache-read volume", () => {
  for (const cache of CACHE_READ_VOLUMES) {
    const { doc, dispatch, errors } = bootMainJs();
    dispatchMetrics(dispatch, [
      { id: "orchestrator", name: "Orchestrator", status: "idle", model: "haiku", tokens: 2000, cacheReadTokens: cache, activeMs: 1000, taskCount: 1 },
      { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, cacheReadTokens: cache, activeMs: 5000, taskCount: 4 },
    ]);
    dispatch({ type: "settings", payload: agentsPayload() });

    const text = rowBadgeText(doc, "Coding Specialist");
    assert.equal(text, "2× pricier", `cache=${cache}: expected '2× pricier' (raw 2/4 haiku/sonnet ratio, <=0.95 branch), got '${text}'`);
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
    dispatch({ type: "settings", payload: agentsPayload() });

    const text = chipVsOrchText(doc, "Coding Specialist");
    assert.equal(
      text,
      "2.5× cheaper",
      `orchCache=${orchCache}: expected '2.5× cheaper' (raw 10/4 opus/sonnet rate ratio), got '${text}'`,
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
  dispatch({ type: "settings", payload: agentsPayload() });

  const text = chipVsOrchText(doc, "Orchestrator");
  assert.equal(text, "baseline", `expected 'baseline' for the orchestrator's own chip, got '${text}'`);
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("settings 'vs. orch.' chip: NEGATIVE ANCHOR -- unpriced worker model renders '—', never a fabricated ratio", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "some-unknown-model-xyz", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const text = chipVsOrchText(doc, "Coding Specialist");
  assert.equal(text, "—", `expected '—' for an unpriced model, got '${text}'`);
  assert.doesNotMatch(String(text), /cheaper|pricier|nan|infinity/i, "unpriced model must never render a fabricated ratio word");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});
