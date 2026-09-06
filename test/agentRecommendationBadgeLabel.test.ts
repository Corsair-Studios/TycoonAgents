/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Regression coverage for the recommendation badge's "Apply" mislabeling bug
// (2026-08-17): the per-agent Settings recommendation badge
// (recommendationFor(), media/main.js ~14512; rendered ~16042-16077) shows a
// button next to the model radio group whenever the configured model
// outranks that agent's SUGGESTED_MAX floor. That button used to read the
// bare word "Apply" while sitting in the exact row the user just clicked a
// radio in -- every UI convention makes "Apply" read as "confirm the
// selection I just made", but the button actually does the opposite: it
// OVERRIDES the user's pick with the system's cheaper suggestion, silently
// discarding their explicit choice. The fix renames the button to name the
// destination model explicitly ("Switch to <Model>"), so the action is
// self-describing regardless of which agent/model it renders for, and adds
// a short-window suppression so the badge does not render at all on the
// render immediately following the user's own explicit pick for that agent.
//
// This boots the REAL media/main.js via readFileSync + node:vm, the same
// technique test/resolveOrchestratorPrice.test.ts uses (see that file's
// header for the full rationale -- media/main.js is an untyped browser IIFE
// with no exported symbols, so DOM observation is the only viable strategy).
// Nothing here reimplements recommendationFor() or the render loop; every
// assertion reads the real rendered DOM/attributes.

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

/**
 * Fixture routing payload for agentsPayloadWithOverModelAgent()'s fixed
 * agent set (orchestrator + search-retrieval). The per-agent recommendation
 * badge (.rec-apply, buildUnifiedAgentCard, media/main.js ~17925-17936) now
 * lives inside the Agents modal (renderRoutingModal, media/main.js
 * ~18087-18260) and only renders once BOTH a "settings" and a "routing"
 * message have landed and the modal is open (see media/main.js:12534-12545)
 * — mirrors test/routingView.test.ts's buildRoutingPayload.
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
        id: "search-retrieval",
        name: "search-retrieval",
        backend: { vendor: "anthropic", transport: "claude-native", model: "sonnet", costModelClass: "subscription" },
        source: "default",
      },
    ],
    envProbe: {},
    presets: { vendors: ["anthropic"], models: [] },
    lastApplied: {},
  };
}

/** Opens the Agents modal (formerly Routing; #menu-routing kept, label now "Agents"), feeds it a routing payload, then pushes the given settings payload — required before any `.rec-apply` badge query. */
function pushSettings(doc: any, dispatch: (d: any) => void, payload: any) {
  // Only open the modal (and re-push the routing payload) once per boot: a
  // second click re-runs openRoutingModal()'s own renderRoutingModal() call,
  // which would consume the one-render `justSetAgentModelId` suppression
  // flag (media/main.js ~18232) a beat early and mask the real assertion
  // under test in the suppression-window spec below.
  const modal = doc.getElementById("routing-modal");
  if (!modal || modal.hasAttribute("hidden")) {
    const menuRoutingBtn = doc.getElementById("menu-routing");
    if (menuRoutingBtn) menuRoutingBtn.click();
  }
  if (!doc.__routingPayloadPushed) {
    doc.__routingPayloadPushed = true;
    dispatch({ type: "routing", payload: routingPayloadFixture() });
  }
  dispatch({ type: "settings", payload });
}

/** Settings payload with an agent whose model outranks its SUGGESTED_MAX floor. */
function agentsPayloadWithOverModelAgent() {
  return {
    hook: { installed: true, lastActivityAt: null },
    agents: [
      { id: "orchestrator", name: "Orchestrator", model: null, isOrchestrator: true, keywords: "" },
      // search-retrieval's SUGGESTED_MAX floor is "haiku" (media/main.js
      // ~14477) -- configuring it above that floor triggers the "Could run
      // on Haiku" recommendation deterministically, independent of the
      // testing-specialist fix under test elsewhere.
      { id: "search-retrieval", name: "Search Retrieval", model: "sonnet", isOrchestrator: false, keywords: "search|find" },
    ],
    delegation_mode: "direct",
    delegationHealth: {},
    hookHealth: { healthy: true, issueCount: 0 },
    contextBudget: null,
  };
}

test("recommendation badge button: visible label names the destination model, never the bare word 'Apply'", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatch({
    type: "state",
    state: {
      sessionActive: true,
      completedTasks: 1,
      idleFreezeMs: 180000,
      sanityCapMs: 900000,
      workers: {},
      agentMetrics: [
        { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, activeMs: 1000, taskCount: 1 },
        { id: "search-retrieval", name: "Search Retrieval", status: "idle", model: "sonnet", tokens: 5000, activeMs: 1000, taskCount: 3 },
      ],
    },
  });
  pushSettings(doc, dispatch, agentsPayloadWithOverModelAgent());

  const applyBtn = doc.querySelector(".rec-apply");
  assert.ok(applyBtn, "expected a recommendation apply button to render for an agent above its SUGGESTED_MAX floor");
  const label = String(applyBtn.textContent || "").trim();

  assert.notEqual(label, "Apply", `button must not read as bare "Apply" (reads as confirming the user's own pick, not an override) — got "${label}"`);
  assert.match(label, /haiku/i, `visible label must name the destination model ("haiku") so the action is self-describing — got "${label}"`);
  // Accessible name must mirror the visible label: no separate aria-label
  // that could drift from what's actually printed on the button.
  const ariaLabel = applyBtn.getAttribute("aria-label");
  if (ariaLabel) {
    assert.match(ariaLabel, /haiku/i, `if an aria-label is present it must also name the destination model — got "${ariaLabel}"`);
  }
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("recommendation badge: suppressed for one render immediately after the user explicitly sets that agent's model via its radio", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatch({
    type: "state",
    state: {
      sessionActive: true,
      completedTasks: 1,
      idleFreezeMs: 180000,
      sanityCapMs: 900000,
      workers: {},
      agentMetrics: [
        { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, activeMs: 1000, taskCount: 1 },
        { id: "search-retrieval", name: "Search Retrieval", status: "idle", model: "sonnet", tokens: 5000, activeMs: 1000, taskCount: 3 },
      ],
    },
  });
  pushSettings(doc, dispatch, agentsPayloadWithOverModelAgent());

  // Sanity: badge renders on a normal (non-just-picked) settings render.
  assert.ok(doc.querySelector(".rec-apply"), "recommendation should render before the user touches the radio");

  // Simulate the user clicking the Sonnet radio for search-retrieval, which
  // sets justSetAgentModelId and posts setAgentModel (postMessage is a no-op
  // stub here, so the host round-trip is irrelevant to this DOM-only check).
  const sonnetRadio = doc.querySelector('input[type="radio"][name="model-search-retrieval"][value="sonnet"]');
  assert.ok(sonnetRadio, "expected a Sonnet radio for search-retrieval");
  sonnetRadio.checked = true;
  sonnetRadio.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));

  // Host re-pushes settings right after (same shape -- model unchanged in
  // this stub since postMessage is a no-op, but that's fine: the point is
  // the flag suppresses the render regardless of the resulting model).
  pushSettings(doc, dispatch, agentsPayloadWithOverModelAgent());
  assert.equal(doc.querySelector(".rec-apply"), null, "recommendation badge must be suppressed on the render immediately following the user's own explicit pick");

  // And it must return on the NEXT render after that (flag is read-once).
  pushSettings(doc, dispatch, agentsPayloadWithOverModelAgent());
  assert.ok(doc.querySelector(".rec-apply"), "recommendation should reappear on the render after the suppressed one");

  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});
