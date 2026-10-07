/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

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
function _unusedAssertRatioLine(text: string, ratio: number): void {
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

function routingWith(agents: any[]) {
  const p: any = routingPayloadFixture();
  p.agents = agents;
  return p;
}

function bridgedFixture() {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", rosterModel: "opus", tokens: 2000000, activeMs: 1000, taskCount: 0 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4 },
    { id: "grok-reviewer", name: "Grok Reviewer", status: "idle", model: "haiku", vendor: "xai", costModelClass: "metered", tokens: 20000, activeMs: 5000, taskCount: 1 },
    { id: "codex-reviewer", name: "Codex Reviewer", status: "idle", model: "haiku", vendor: "openai", costModelClass: "subscription", tokens: 10000, activeMs: 5000, taskCount: 1 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });
  dispatch({
    type: "routing",
    payload: routingWith([
      { id: "coding-specialist", name: "coding-specialist", backend: { vendor: "anthropic", transport: "claude-native", model: "sonnet", costModelClass: "subscription" }, source: "default" },
      { id: "grok-reviewer", name: "grok-reviewer", backend: { vendor: "xai", transport: "openai-compatible", model: "grok-4.7", costModelClass: "metered" }, source: "default" },
      { id: "codex-reviewer", name: "codex-reviewer", backend: { vendor: "openai", transport: "codex-cli", model: "gpt-5.6-sol", costModelClass: "subscription" }, source: "default" },
    ]),
  });
  const body = openDelegationTab(doc);
  return { body, errors };
}

function rowFor(body: any, name: string) {
  const rows = [...body.querySelectorAll(".delegation-agent-table tbody tr")];
  const r = rows.find((x: any) => x.querySelector(".col-name")?.textContent === name);
  assert.ok(r, "row for " + name);
  return r as any;
}

test("delegation table: bridged agents show the backend model, not the Haiku relay wrapper (1a)", () => {
  const { body, errors } = bridgedFixture();
  const grok = rowFor(body, "Grok Reviewer").querySelector(".col-model").textContent;
  assert.match(grok, /grok-4\.7/);
  assert.doesNotMatch(grok, /haiku/i);
  assert.match(grok, /Xai/);
  const codex = rowFor(body, "Codex Reviewer").querySelector(".col-model").textContent;
  assert.match(codex, /gpt-5\.6-sol/);
  assert.match(codex, /OpenAI, quota/);
  assert.match(rowFor(body, "Coding Specialist").querySelector(".col-model").textContent, /Sonnet/);
  assert.equal(errors.length, 0);
});

test("delegation table: cross-vendor agents show em dash share; same-vendor shares sum over same-vendor only; header is 'Share' (1b)", () => {
  const { body } = bridgedFixture();
  assert.equal(rowFor(body, "Grok Reviewer").querySelector(".col-share").textContent, "—");
  assert.equal(rowFor(body, "Codex Reviewer").querySelector(".col-share").textContent, "—");
  assert.equal(rowFor(body, "Coding Specialist").querySelector(".col-share").textContent, "100%");
  const heads = [...body.querySelectorAll(".delegation-agent-table th")].map((t: any) => t.textContent);
  assert.ok(heads.includes("Share"));
  assert.ok(!heads.includes("Cost share"));
});

test("delegation coordination row names the orchestrator and model (1c)", () => {
  const { body } = bridgedFixture();
  const text = String(body.textContent);
  assert.match(text, /Orchestrator \(Opus\) · 0 tasks/);
  assert.doesNotMatch(text, /^\s*· 0 tasks/m);
});

test("delegation hero: never claims 'same rate' when the ratio is below 0.95 or unknown (1d)", () => {
  const { doc, dispatch } = bootMainJs();
  // Orchestrator is ~all cache reads (0.1x blended rate) so it looks cheaper than Sonnet workers.
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 1000, cacheReadTokens: 9000000, modelBreakdown: { opus: 1000 }, cacheReadModelBreakdown: { opus: 9000000 }, activeMs: 1000, taskCount: 0 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });
  const text = String(openDelegationTab(doc).textContent);
  assert.doesNotMatch(text, /roughly the same rate/);
  assert.doesNotMatch(text, /cheaper than running the same billable tokens/);
});

test("delegation tiers: foreign agents group by backend model in a separate group, Claude tiers exclude them (1e)", () => {
  const { body } = bridgedFixture();
  const text = String(body.textContent);
  const tierNames = [...body.querySelectorAll(".delegation-tier-name")].map((n: any) => n.textContent);
  assert.ok(tierNames.includes("Sonnet"));
  assert.ok(tierNames.includes("grok-4.7"));
  assert.ok(tierNames.includes("gpt-5.6-sol"));
  assert.ok(!tierNames.includes("Haiku"));
  assert.match(text, /Other vendors \(not compared\)/);
  const sonnetMeta = [...body.querySelectorAll(".delegation-tier-row")].find((r: any) => r.querySelector(".delegation-tier-name").textContent === "Sonnet");
  assert.match(sonnetMeta.textContent, /100%/);
  const grokRow = [...body.querySelectorAll(".delegation-tier-row")].find((r: any) => r.querySelector(".delegation-tier-name").textContent === "grok-4.7");
  assert.doesNotMatch(grokRow.textContent, /%/);
});

function geminiFixture(geminiValue: string) {
  const { doc, dispatch } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", rosterModel: "opus", tokens: 2000000, activeMs: 1000, taskCount: 0 },
    { id: "gemini-reviewer", name: "Gemini Reviewer", status: "idle", model: "haiku", vendor: "google", tokens: 10000, activeMs: 5000, taskCount: 1 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });
  const payload: any = routingWith([
    { id: "gemini-reviewer", name: "gemini-reviewer", backend: { vendor: "google", transport: "mcp", model: "gemini-2.5-pro", costModelClass: "metered" }, source: "default" },
  ]);
  payload.bridge = { gemini: { serverPresent: true, value: geminiValue }, mcpServers: [] };
  dispatch({ type: "routing", payload });
  return openDelegationTab(doc);
}

test("delegation table: Gemini on Antigravity shows gemini-3.5-flash, not the routing model", () => {
  const body = geminiFixture("agy");
  const cell = rowFor(body, "Gemini Reviewer").querySelector(".col-model").textContent;
  assert.match(cell, /gemini-3\.5-flash \(Antigravity\)/);
  assert.doesNotMatch(cell, /2\.5-pro/);
  const tierNames = [...body.querySelectorAll(".delegation-tier-name")].map((n: any) => n.textContent);
  assert.ok(tierNames.includes("gemini-3.5-flash (Antigravity)"));
});

test("delegation table: Gemini on the paid gemini backend keeps the routing model", () => {
  const body = geminiFixture("gemini");
  const cell = rowFor(body, "Gemini Reviewer").querySelector(".col-model").textContent;
  assert.match(cell, /gemini-2\.5-pro/);
  assert.doesNotMatch(cell, /Antigravity/);
});
