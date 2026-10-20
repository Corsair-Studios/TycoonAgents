/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Pins for the worker-report rendering feature (0.0.562): AgentMetric.lastReport
// (src/core/state.ts ~123) is captured on the hook/state side already; this file
// pins that it actually reaches the DOM in the Metrics table, safely.
//
// Boots the REAL media/main.js via readFileSync + node:vm, same technique as
// test/vsOrchRawRateBadge.test.ts (bootMainJs/dispatch/agentsPayload reused
// verbatim below).

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

function findRow(doc: any, displayName: string): any {
  const rows = [...doc.querySelectorAll("#metrics-tbody tr")];
  return rows.find(
    (r: any) => r.textContent && r.textContent.toLowerCase().includes(displayName.toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// (a) Agent WITH a report: the toggle affordance is present, clicking it
// reveals the report text, and the text is reachable in the DOM.
// ---------------------------------------------------------------------------

test("agent with a captured lastReport renders a report-toggle affordance, and clicking it reveals the report text", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, activeMs: 1000, taskCount: 1 },
    {
      id: "coding-specialist",
      name: "Coding Specialist",
      status: "idle",
      model: "sonnet",
      tokens: 100000,
      activeMs: 5000,
      taskCount: 4,
      lastReport: "Fixed foo.ts:12, verified with tsc.",
    },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const row = findRow(doc, "Coding Specialist");
  assert.ok(row, "expected to find the Coding Specialist row");
  const toggle = row.querySelector(".report-toggle");
  assert.ok(toggle, "expected a .report-toggle affordance on an agent with a captured report");

  // No disclosure row before click.
  assert.equal(Boolean(row.nextElementSibling && row.nextElementSibling.classList.contains("report-disclosure-row")), false);

  toggle.dispatchEvent(new doc.defaultView.MouseEvent("click", { bubbles: true }));

  const disclosure = row.nextElementSibling;
  assert.ok(disclosure && disclosure.classList.contains("report-disclosure-row"), "expected a disclosure row after click");
  const textEl = disclosure.querySelector(".report-disclosure-text");
  assert.ok(textEl, "expected report text container");
  assert.equal(textEl.textContent, "Fixed foo.ts:12, verified with tsc.");

  // Click again collapses it.
  toggle.dispatchEvent(new doc.defaultView.MouseEvent("click", { bubbles: true }));
  assert.equal(Boolean(row.nextElementSibling && row.nextElementSibling.classList.contains("report-disclosure-row")), false);

  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (b) Agent WITHOUT a report: no new affordance at all -- no toggle, no
// caret, no placeholder text such as "no report" anywhere in the row.
// ---------------------------------------------------------------------------

test("agent with no lastReport renders no new affordance -- no toggle, no placeholder, row looks exactly as before", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const row = findRow(doc, "Coding Specialist");
  assert.ok(row, "expected to find the Coding Specialist row");
  assert.equal(row.querySelector(".report-toggle"), null, "no report-toggle should render when lastReport is absent");
  assert.doesNotMatch(
    String(row.textContent),
    /no report/i,
    "an agent with no report must never render a misleading 'no report' placeholder",
  );
  assert.equal(
    Boolean(row.nextElementSibling && row.nextElementSibling.classList && row.nextElementSibling.classList.contains("report-disclosure-row")),
    false,
    "no disclosure row should exist for an agent with no report",
  );
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (c) Empty-string lastReport treated the same as absent -- no affordance.
// ---------------------------------------------------------------------------

test("agent with an empty-string lastReport renders no new affordance", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4, lastReport: "" },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const row = findRow(doc, "Coding Specialist");
  assert.ok(row, "expected to find the Coding Specialist row");
  assert.equal(row.querySelector(".report-toggle"), null, "empty-string report must not render an affordance");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (d) SAFETY: markup-bearing report text renders as literal text via
// textContent, never innerHTML -- no injected element, no attribute-based
// script execution.
// ---------------------------------------------------------------------------

test("SAFETY: a report containing HTML-ish text renders as literal text and does not create an injected element", () => {
  const { doc, dispatch, errors } = bootMainJs();
  const malicious = '<img src=x onerror=alert(1)>Report body <b>bold</b> text.';
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4, lastReport: malicious },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const row = findRow(doc, "Coding Specialist");
  const toggle = row.querySelector(".report-toggle");
  assert.ok(toggle);
  toggle.dispatchEvent(new doc.defaultView.MouseEvent("click", { bubbles: true }));

  const disclosure = row.nextElementSibling;
  const textEl = disclosure.querySelector(".report-disclosure-text");

  // The literal markup string must be preserved verbatim as text.
  assert.equal(textEl.textContent, malicious);

  // Absence of an injected node is the load-bearing assertion, not just the
  // string content: no <img>, no <b> element must exist anywhere in the
  // disclosure subtree.
  assert.equal(textEl.querySelector("img"), null, "must not create an <img> element from report text");
  assert.equal(textEl.querySelector("b"), null, "must not create a <b> element from report text");
  // Exactly td > div, nothing else injected underneath the text container.
  assert.equal(textEl.children.length, 0, "the report text container must have no child elements — text only");
  assert.equal(disclosure.querySelectorAll("*").length, 2, "disclosure row must contain exactly td + its text container div, nothing injected");

  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (e) TRUNCATION VISIBILITY: the "… [truncated]" marker the capture side
// appends survives to the reader unmodified.
// ---------------------------------------------------------------------------

test("truncation marker '… [truncated]' survives to the rendered report text", () => {
  const { doc, dispatch, errors } = bootMainJs();
  const truncated = "A".repeat(2000) + "… [truncated]";
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4, lastReport: truncated },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const row = findRow(doc, "Coding Specialist");
  const toggle = row.querySelector(".report-toggle");
  toggle.dispatchEvent(new doc.defaultView.MouseEvent("click", { bubbles: true }));

  const disclosure = row.nextElementSibling;
  const textEl = disclosure.querySelector(".report-disclosure-text");
  assert.ok(textEl.textContent.endsWith("… [truncated]"), "truncation marker must survive to the rendered text unmodified");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (f) The disclosure row does not break the existing 6-column layout: its
// cell spans all columns rather than shifting any sibling cell.
// ---------------------------------------------------------------------------

test("disclosure row spans the full column width rather than shifting the table layout", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4, lastReport: "short report" },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  // This harness's #metrics-table placeholder carries no <thead> markup
  // (that HTML lives in panel.ts and is not loaded here — see bootMainJs),
  // so the expected column count is pinned against panel.ts's static
  // <thead> (6 columns: Agent, Tokens/min, Tasks, MCP, Time, Tokens) rather
  // than queried from this DOM.
  const EXPECTED_COLUMN_COUNT = 6;
  const row = findRow(doc, "Coding Specialist");
  const toggle = row.querySelector(".report-toggle");
  toggle.dispatchEvent(new doc.defaultView.MouseEvent("click", { bubbles: true }));

  const disclosure = row.nextElementSibling;
  const cell = disclosure.querySelector("td.report-disclosure-cell");
  assert.ok(cell);
  assert.equal(cell.colSpan, EXPECTED_COLUMN_COUNT, "disclosure cell colspan must match panel.ts's 6-column <thead>");
  assert.equal(disclosure.querySelectorAll("td").length, 1, "disclosure row must have exactly one cell");

  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});
