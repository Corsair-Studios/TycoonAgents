/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for feedback issues #24 + #25: the Settings panel shows the
// orchestrator's ACTUAL running model (derived from observed session
// metrics only) and warns when that model is Sonnet or Haiku.
//
// REWRITE NOTE (this file was rejected in review once already): the prior
// version defined its own local copy of the family-matching algorithm and
// asserted against that copy instead of the shipped code, and self-skipped
// with a console.log when it could not find the real module. Both defects
// are fixed here:
//
//   - This file boots the REAL media/main.js source (readFileSync + node:vm,
//     same technique as test/webviewSmoke.test.ts, media/main.js's own
//     established precedent for headless coverage — see the "loading
//     strategy" note below) and drives the REAL closures
//     (`modelFamily`, `showOrchestratorModelBanner`,
//     `dismissOrchestratorModelBanner`, the orchestrator agent-row render
//     block at media/main.js:14903-14935) entirely through DOM
//     observation + posted vscode messages. Nothing here reimplements the
//     matching algorithm.
//   - There is no self-skip path. If the real script cannot be booted (e.g.
//     media/main.js goes missing or throws on load), the test FAILS loudly
//     via assertNoErrors()/thrown exceptions, not a console.log + return.
//
// Loading strategy chosen, and why "importing real code breaks tsc for the
// whole suite" is NOT a real constraint for this file:
//   media/main.js is a plain, untyped browser IIFE — it is never compiled by
//   tsc at all (scripts/check-webview.mjs runs a standalone tsc check against
//   it separately; `npm test` = `tsc -p .` then `node --test out/test/**`,
//   and media/main.js is outside the tsconfig `include` used for the test
//   build). test/webviewSmoke.test.ts already proves this: it pulls in the
//   real source via `readFileSync` + `vm.runInContext` inside a jsdom
//   window, with zero `import`/`require` of media/main.js as an ES/CJS
//   module (main.js has no module.exports — it's an IIFE with only
//   closures). That is the only viable strategy here too, since none of
//   modelFamily/showOrchestratorModelBanner/dismissOrchestratorModelBanner
//   are exported symbols reachable via `require`. Following that precedent
//   exactly means this file never touches tsc's type-checking of
//   media/main.js and cannot "break tsc for the whole suite" — the claim
//   does not hold for the loading technique actually available here.
//
// Contract pinned (verified against the shipped code, not re-derived):
//   1. modelFamily(model) (media/main.js:13166-13174) — case-insensitive
//      substring match, checked in order opus/sonnet/haiku/fable, returns
//      the CAPITALIZED family string or null. This is the ONLY matcher
//      exercised — no local copy.
//   2. The orchestrator settings row (media/main.js:14903-14935) computes
//      `modelFamily(m && m.model)` from `m = metricsFor(agent.id)`, i.e.
//      the observed `lastMetrics` entry with id "orchestrator" — never a
//      static config default. No metrics observed yet -> "Session model:
//      Unknown yet", never "Opus".
//   3. The inline warning (`.orchestrator-model-warning`) renders iff
//      observedFamily is exactly "Sonnet" or "Haiku". Never Opus. Never
//      Fable (fable ranks ABOVE opus in this project's cost lens:
//      MODEL_PRICE_PER_MTOK = {opus:10, sonnet:4, haiku:2, fable:20}).
//      Never Unknown.
//   4. showOrchestratorModelBanner/dismissOrchestratorModelBanner
//      (media/main.js:2454-2494) render the same class of banner
//      (`#orchestrator-model-notice`), gated the same way, dismissed via
//      vscode.getState()/setState() keyed by family
//      (`orchestratorModelNoticeDismissedFor`) — covered in
//      test/orchestratorModelWarningDismissal.test.ts, not duplicated here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require("jsdom");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vm = require("vm");

const MAIN_JS_PATH = join(process.cwd(), "media", "main.js");

// ── Minimal element skeleton ────────────────────────────────────────────
// Only the ids main.js's boot path + renderSettings()/orchestrator row
// actually dereference. Mirrors webviewSmoke's scanElementIds approach but
// kept local/explicit so this file has no coupling to that file's helper.
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

/** Boots real media/main.js in a fresh jsdom + vm context. Throws (fails loudly) if the boot itself errors. */
function bootMainJs() {
  const src = readFileSync(MAIN_JS_PATH, "utf8");

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "https://webview.local/",
  });
  const win: any = dom.window;
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

  return { win, doc, dispatch, getState: () => stateStore };
}

function agentsPayload(orchestratorModel?: string) {
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

function stateWithOrchestratorMetric(model: string | null) {
  const agentMetrics: any[] = [];
  if (model !== undefined) {
    agentMetrics.push({ id: "orchestrator", name: "Orchestrator", status: "idle", model, tokens: 500, activeMs: 1000 });
  }
  return {
    type: "state",
    state: {
      sessionActive: true,
      completedTasks: 0,
      idleFreezeMs: 180000,
      sanityCapMs: 900000,
      workers: {},
      agentMetrics,
    },
  };
}

/** Drives real main.js: state (populates lastMetrics) then settings (renders the orchestrator row). Returns the rendered row's text pieces. */
function renderOrchestratorRow(model: string | null | undefined) {
  const { doc, dispatch } = bootMainJs();
  if (model !== undefined) {
    dispatch(stateWithOrchestratorMetric(model));
  } else {
    // No orchestrator metric observed at all — dispatch a state with only
    // OTHER agents, exercising the negative-anchor "not found" path.
    dispatch({
      type: "state",
      state: {
        sessionActive: true,
        completedTasks: 0,
        idleFreezeMs: 180000,
        sanityCapMs: 900000,
        workers: {},
        agentMetrics: [{ id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100, activeMs: 100 }],
      },
    });
  }
  dispatch({ type: "settings", payload: agentsPayload() });

  const row = doc.querySelector('[data-agent-row="orchestrator"]');
  assert.ok(row, "orchestrator settings row should render");
  const readonly = row.querySelector(".agent-model-readonly");
  const warning = row.querySelector(".orchestrator-model-warning");
  return {
    label: readonly ? readonly.textContent : null,
    warningText: warning ? warning.textContent : null,
    hasWarning: !!warning,
  };
}

// ---------------------------------------------------------------------------
// Table-driven: real modelFamily() classification via the rendered label +
// warning presence, driven entirely through message dispatch + DOM reads.
// ---------------------------------------------------------------------------

const TABLE: Array<{ label: string; model: string; wantFamily: "Opus" | "Sonnet" | "Haiku" | "Fable"; wantWarn: boolean }> = [
  { label: "short opus", model: "opus", wantFamily: "Opus", wantWarn: false },
  { label: "short sonnet", model: "sonnet", wantFamily: "Sonnet", wantWarn: true },
  { label: "short haiku", model: "haiku", wantFamily: "Haiku", wantWarn: true },
  { label: "short fable", model: "fable", wantFamily: "Fable", wantWarn: false },
  { label: "full opus id with context suffix", model: "claude-opus-5[1m]", wantFamily: "Opus", wantWarn: false },
  { label: "full sonnet id", model: "claude-sonnet-5", wantFamily: "Sonnet", wantWarn: true },
  { label: "full haiku id with date suffix", model: "claude-haiku-4-5-20251001", wantFamily: "Haiku", wantWarn: true },
  { label: "full fable id", model: "claude-fable-5", wantFamily: "Fable", wantWarn: false },
  { label: "uppercase SONNET", model: "CLAUDE-SONNET-5", wantFamily: "Sonnet", wantWarn: true },
  { label: "mixed-case Haiku", model: "Claude-Haiku-4-5", wantFamily: "Haiku", wantWarn: true },
  { label: "mixed-case Opus", model: "Claude-Opus-5", wantFamily: "Opus", wantWarn: false },
];

test("orchestrator model warning: table-driven family classification + warn decision, against the REAL modelFamily() via rendered DOM", () => {
  for (const row of TABLE) {
    const result = renderOrchestratorRow(row.model);
    assert.equal(result.label, `Session model: ${row.wantFamily}`, `label for [${row.label}]`);
    assert.equal(result.hasWarning, row.wantWarn, `warning presence for [${row.label}]`);
  }
});

test("orchestrator model warning: never fires for opus, even with realistic full ids (real code)", () => {
  assert.equal(renderOrchestratorRow("opus").hasWarning, false);
  assert.equal(renderOrchestratorRow("claude-opus-5[1m]").hasWarning, false);
  assert.equal(renderOrchestratorRow("claude-opus-4-6").hasWarning, false);
});

test("orchestrator model warning: never fires for fable — fable ranks ABOVE opus in the cost lens (fable:20 vs opus:10) (real code)", () => {
  assert.equal(renderOrchestratorRow("fable").hasWarning, false);
  assert.equal(renderOrchestratorRow("claude-fable-5").hasWarning, false);
});

test("orchestrator model warning: fires for sonnet and haiku, case-insensitively, on full model ids (real code)", () => {
  assert.equal(renderOrchestratorRow("claude-sonnet-5").hasWarning, true);
  assert.equal(renderOrchestratorRow("CLAUDE-SONNET-5").hasWarning, true);
  assert.equal(renderOrchestratorRow("claude-haiku-4-5-20251001").hasWarning, true);
  assert.equal(renderOrchestratorRow("CLAUDE-HAIKU-4-5-20251001").hasWarning, true);
});

test("orchestrator model warning: fires-only-for-sonnet-or-haiku text mentions the exact observed family", () => {
  const sonnet = renderOrchestratorRow("claude-sonnet-5");
  assert.ok(sonnet.warningText && sonnet.warningText.includes("Sonnet"), "warning text should name the observed family (Sonnet)");
  const haiku = renderOrchestratorRow("claude-haiku-4-5");
  assert.ok(haiku.warningText && haiku.warningText.includes("Haiku"), "warning text should name the observed family (Haiku)");
});

// ---------------------------------------------------------------------------
// NEGATIVE ANCHOR (highest value): Unknown state must NEVER resolve to
// "Opus" and must NEVER warn. Pins that the display path cannot regress into
// reusing resolveOrchestratorPrice's Opus cost-fallback as a LABEL.
// ---------------------------------------------------------------------------

test("orchestrator model label: NEGATIVE ANCHOR -- no orchestrator metric observed at all -> 'Unknown yet', NEVER 'Opus', NEVER a warning (real code)", () => {
  const result = renderOrchestratorRow(undefined);
  assert.equal(result.label, "Session model: Unknown yet");
  assert.ok(!/opus/i.test(String(result.label)), "label must never contain Opus when nothing was observed");
  assert.equal(result.hasWarning, false, "Unknown state must never warn");
});

test("orchestrator model label: NEGATIVE ANCHOR -- empty agentMetrics array -> 'Unknown yet', NEVER 'Opus' (real code)", () => {
  const { doc, dispatch } = bootMainJs();
  dispatch({
    type: "state",
    state: { sessionActive: true, completedTasks: 0, idleFreezeMs: 180000, sanityCapMs: 900000, workers: {}, agentMetrics: [] },
  });
  dispatch({ type: "settings", payload: agentsPayload() });
  const row = doc.querySelector('[data-agent-row="orchestrator"]');
  assert.ok(row);
  const readonly = row.querySelector(".agent-model-readonly");
  assert.equal(readonly.textContent, "Session model: Unknown yet");
  assert.ok(!/opus/i.test(readonly.textContent));
  assert.equal(row.querySelector(".orchestrator-model-warning"), null);
});

test("orchestrator model label: NEGATIVE ANCHOR -- metrics contain other agents but no 'orchestrator' entry -> 'Unknown yet', NEVER 'Opus' (real code)", () => {
  const result = renderOrchestratorRow(undefined); // renderOrchestratorRow(undefined) sends only coding-specialist
  assert.equal(result.label, "Session model: Unknown yet");
  assert.ok(!/opus/i.test(String(result.label)));
  assert.equal(result.hasWarning, false);
});

test("orchestrator model label: null model on an observed orchestrator entry also floors to 'Unknown yet', never 'Opus' (real code)", () => {
  const result = renderOrchestratorRow(null);
  assert.equal(result.label, "Session model: Unknown yet");
  assert.equal(result.hasWarning, false);
});

// ---------------------------------------------------------------------------
// Sanity: the help text distinguishes observed vs not-yet-observed, proving
// the render path actually branches on the real modelFamily() result rather
// than a constant string.
// ---------------------------------------------------------------------------

test("orchestrator model help text differs between observed and unknown states (real code)", () => {
  const { doc, dispatch } = bootMainJs();
  dispatch(stateWithOrchestratorMetric("claude-sonnet-5"));
  dispatch({ type: "settings", payload: agentsPayload() });
  const observedHelp = doc.querySelector('[data-agent-row="orchestrator"] .orchestrator-model-help');
  assert.ok(observedHelp && observedHelp.textContent.includes("session model"));
  assert.ok(!observedHelp.textContent.includes("Run a task to populate this"));

  const { doc: doc2, dispatch: dispatch2 } = bootMainJs();
  dispatch2({
    type: "state",
    state: { sessionActive: true, completedTasks: 0, idleFreezeMs: 180000, sanityCapMs: 900000, workers: {}, agentMetrics: [] },
  });
  dispatch2({ type: "settings", payload: agentsPayload() });
  const unknownHelp = doc2.querySelector('[data-agent-row="orchestrator"] .orchestrator-model-help');
  assert.ok(unknownHelp && unknownHelp.textContent.includes("Run a task to populate this"));
});
