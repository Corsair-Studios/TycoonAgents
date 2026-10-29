/*
 * Metrics tab: live time hint for in-progress runs and the Codex/Gemini
 * bridge token marker. Boots the real media/main.js (same harness as
 * vsOrchRawRateBadge.test.ts) and reads the rendered DOM.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { creditedElapsed } from "../src/core/state";
// Rates come from the shipped PRICE_TABLE (media/main.js), not literals, so a
// price refresh never silently invalidates these ratio pins.
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
      workers: {},
      agentMetrics,
    },
  });
}


function routingWith(agentBackend: any) {
  const p = routingPayloadFixture();
  p.agents = [{ id: "coding-specialist", name: "coding-specialist", backend: agentBackend, source: "default" } as any];
  return p;
}

function setup(backend: any, harness?: string) {
  const ctx = bootMainJs();
  const menu = ctx.doc.getElementById("menu-routing");
  if (menu) menu.click();
  ctx.dispatch({ type: "routing", payload: routingWith(backend) });
  const settings: any = agentsPayload();
  if (harness) settings.harness = { effective: harness };
  ctx.dispatch({ type: "settings", payload: settings });
  return ctx;
}

function worker(over: any) {
  return { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 5000, cacheReadTokens: 0, activeMs: 0, taskCount: 1, ...over };
}
const ORCH = { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 };

function timeText(doc: any): string {
  const row = [...doc.querySelectorAll("#metrics-tbody tr")].find((r: any) => /Coding Specialist/.test(r.textContent));
  return row.querySelector(".col-time").textContent;
}
function tokensCell(doc: any): any {
  const row = [...doc.querySelectorAll("#metrics-tbody tr")].find((r: any) => /Coding Specialist/.test(r.textContent));
  return row.querySelector(".col-tokens");
}
const CLAUDE_NATIVE = { vendor: "anthropic", transport: "claude-native", model: "sonnet", costModelClass: "subscription" };
const T0 = 1_800_000_000_000;

test("live time: active run shows completed total plus elapsed, advancing with the clock", () => {
  const { win, doc, dispatch } = setup(CLAUDE_NATIVE);
  let now = T0;
  win.Date.now = () => now;
  const active = worker({ status: "active", activeMs: 60_000, workStartAt: T0 - 30_000, lastActivityAt: T0 });
  dispatchMetrics(dispatch, [ORCH, active]);
  assert.equal(timeText(doc), "1m 30s");
  now = T0 + 20_000;
  win.Date.now = () => now;
  dispatchMetrics(dispatch, [ORCH, { ...active, lastActivityAt: now }]);
  assert.equal(timeText(doc), "1m 50s");
});

test("live time: no double count after the run ends (stored total takes over)", () => {
  const { win, doc, dispatch } = setup(CLAUDE_NATIVE);
  let now = T0 + 40_000;
  win.Date.now = () => now;
  dispatchMetrics(dispatch, [ORCH, worker({ status: "active", activeMs: 60_000, workStartAt: T0, lastActivityAt: now })]);
  const before = timeText(doc);
  assert.equal(before, "1m 40s");
  // SubagentStop: host credits 40s into activeMs and clears workStartAt.
  dispatchMetrics(dispatch, [ORCH, worker({ status: "idle", activeMs: 100_000, workStartAt: null, lastActivityAt: now })]);
  assert.equal(timeText(doc), before);
  now += 30_000;
  win.Date.now = () => now;
  dispatchMetrics(dispatch, [ORCH, worker({ status: "idle", activeMs: 100_000, workStartAt: null, lastActivityAt: now - 30_000 })]);
  assert.equal(timeText(doc), before, "idle time must not keep advancing");
});

test("live time: a stalled in-progress run is labelled as paused in the time tooltip", () => {
  const { win, doc, dispatch } = setup(CLAUDE_NATIVE);
  win.Date.now = () => T0 + 600_000;
  dispatchMetrics(dispatch, [ORCH, worker({ status: "active", activeMs: 0, workStartAt: T0, lastActivityAt: T0 })]);
  const row = [...doc.querySelectorAll("#metrics-tbody tr")].find((r: any) => /Coding Specialist/.test(r.textContent));
  assert.match(row.querySelector(".col-time").title, /Paused \u2014 no activity for 3 min/);
});

test("live time: no per-run cap, a 40 minute run with fresh activity shows 40 minutes", () => {
  const { win, doc, dispatch } = setup(CLAUDE_NATIVE);
  const now = T0 + 40 * 60_000;
  win.Date.now = () => now;
  dispatchMetrics(dispatch, [ORCH, worker({ status: "active", activeMs: 0, workStartAt: T0, lastActivityAt: now })]);
  assert.equal(timeText(doc), "40m 0s");
});

test("live time: an in-flight MCP call keeps accruing, then pauses after 30 minutes with its own tooltip", () => {
  const { win, doc, dispatch } = setup(CLAUDE_NATIVE);
  const callAt = T0 + 60_000;
  const call = { tool: "mcp__roblox-studio__multi_edit", at: callAt };
  const row = () => [...doc.querySelectorAll("#metrics-tbody tr")].find((r: any) => /Coding Specialist/.test(r.textContent));
  win.Date.now = () => callAt + 10 * 60_000;
  dispatchMetrics(dispatch, [ORCH, worker({ status: "active", activeMs: 0, workStartAt: T0, lastActivityAt: callAt, inFlightCalls: [call] })]);
  assert.equal(timeText(doc), "11m 0s");
  assert.doesNotMatch(row().querySelector(".col-time").title, /Paused/);
  win.Date.now = () => callAt + 45 * 60_000;
  dispatchMetrics(dispatch, [ORCH, worker({ status: "active", activeMs: 0, workStartAt: T0, lastActivityAt: callAt, inFlightCalls: [call] })]);
  assert.equal(timeText(doc), "31m 0s");
  assert.match(row().querySelector(".col-time").title, /Paused \u2014 tool call running over 30 min/);
});

test("live time: webview total matches the host's creditedElapsed at SubagentStop (no backward jump)", () => {
  const { win, doc, dispatch } = setup(CLAUDE_NATIVE);
  const callAt = T0 + 60_000;
  const stopAt = callAt + 45 * 60_000;
  win.Date.now = () => stopAt;
  dispatchMetrics(dispatch, [ORCH, worker({ status: "active", activeMs: 0, workStartAt: T0, lastActivityAt: callAt, inFlightCalls: [{ tool: "mcp__x__y", at: callAt }] })]);
  const live = timeText(doc);
  const credited = creditedElapsed(T0, callAt, stopAt, 180_000, [{ at: callAt }]);
  dispatchMetrics(dispatch, [ORCH, worker({ status: "idle", activeMs: credited, workStartAt: null, lastActivityAt: callAt })]);
  assert.equal(timeText(doc), live);
});

test("running hint: present in TOKENS cell only while the agent is active", () => {
  const { win, doc, dispatch } = setup(CLAUDE_NATIVE);
  win.Date.now = () => T0;
  dispatchMetrics(dispatch, [ORCH, worker({ status: "active", workStartAt: T0, lastActivityAt: T0 })]);
  const hint = tokensCell(doc).querySelector(".col-tokens-running");
  assert.ok(hint);
  assert.equal(hint.title, "Tokens are added when this run finishes");
  assert.match(hint.textContent, /running/);
  dispatchMetrics(dispatch, [ORCH, worker({ status: "idle", workStartAt: null })]);
  assert.equal(tokensCell(doc).querySelector(".col-tokens-running"), null);
});

test("bridge marker: codex and gemini MCP bridged rows carry the dagger, with the number intact", () => {
  for (const backend of [
    { vendor: "openai", transport: "mcp", mcpServer: "codex", model: "openai/gpt-6.1-sol", costModelClass: "subscription" },
    { vendor: "openai", transport: "mcp", mcpServer: "codex-write", model: "openai/gpt-6.1-sol", costModelClass: "subscription" },
    { vendor: "google", transport: "mcp", mcpServer: "gemini", model: "google/gemini-2.5-pro", costModelClass: "metered" },
  ]) {
    const { doc, dispatch } = setup(backend);
    dispatchMetrics(dispatch, [ORCH, worker({ vendor: backend.vendor, model: backend.model })]);
    const cell = tokensCell(doc);
    const mark = cell.querySelector(".col-tokens-bridge-note");
    assert.ok(mark, "marker for " + backend.mcpServer);
    assert.match(mark.title, /Provider tokens not reported by Codex\/Gemini/);
    assert.match(cell.textContent, /5(\.0)?k|5,?000/);
  }
});

test("bridge marker: absent for openai-compatible, claude-native, claude-cli and fallback rows", () => {
  const cases: any[] = [
    [{ vendor: "xai", transport: "openai-compatible", model: "grok-4.7", costModelClass: "metered" }, {}],
    [CLAUDE_NATIVE, {}],
    [{ vendor: "anthropic", transport: "mcp", mcpServer: "claude-cli", model: "sonnet", costModelClass: "subscription" }, {}],
    [{ vendor: "openai", transport: "mcp", mcpServer: "codex", model: "openai/gpt-6.1-sol", costModelClass: "subscription" }, { vendor: "openai", fallbackOf: "coding-specialist" }],
  ];
  for (const [backend, over] of cases) {
    const { doc, dispatch } = setup(backend);
    dispatchMetrics(dispatch, [ORCH, worker(over)]);
    assert.equal(tokensCell(doc).querySelector(".col-tokens-bridge-note"), null, JSON.stringify(backend));
  }
});

const FOREIGN = { vendor: "openai", cli: "codex", model: "gpt-6.1-terra" };
function workerRow(doc: any): any {
  return [...doc.querySelectorAll("#metrics-tbody tr")].find((r: any) => /Coding Specialist/.test(r.textContent));
}

test("foreign CLI call: row lights light blue while the call is in flight, shows the model, MCP tooltip and dagger", () => {
  const { win, doc, dispatch } = setup(CLAUDE_NATIVE);
  win.Date.now = () => T0;
  dispatchMetrics(dispatch, [ORCH, worker({
    status: "active", workStartAt: T0, lastActivityAt: T0, mcpCount: 2, foreignCliCalls: 2,
    inFlightCalls: [{ id: "t1", tool: "Bash", at: T0, foreign: FOREIGN }], lastForeignCli: FOREIGN,
  })]);
  const row = workerRow(doc);
  assert.ok(row.querySelector(".agent-accent-foreign"), "name accent while in flight");
  assert.equal(row.querySelector(".status-bar-label").textContent, "Terra");
  assert.ok(row.querySelector(".status-bar-track").title.split("\n").includes("via Codex CLI · gpt-6.1-terra"));
  assert.equal(row.querySelector(".agent-foreign-cli"), null, "the via line lives in the model tooltip, not under the name");
  assert.match(row.querySelector(".col-mcp").title, /Includes 2 calls to other LLMs via their CLI/);
  assert.ok(row.querySelector(".col-tokens-bridge-note"), "tokens dagger");

  // Call finished: accent and the in-flight model go away, count and dagger stay.
  dispatchMetrics(dispatch, [ORCH, worker({ status: "active", workStartAt: T0, lastActivityAt: T0, mcpCount: 2, foreignCliCalls: 2, lastForeignCli: FOREIGN })]);
  const after = workerRow(doc);
  assert.equal(after.querySelector(".agent-accent-foreign"), null);
  assert.equal(after.querySelector(".status-bar-label").textContent, "Terra", "an active run keeps showing the model of its last foreign call; only the blue accent is in-flight only");
  assert.ok(after.querySelector(".col-tokens-bridge-note"));
});

test("foreign CLI call: the amber fallback accent still wins over light blue", () => {
  const { win, doc, dispatch } = setup(CLAUDE_NATIVE);
  win.Date.now = () => T0;
  dispatchMetrics(dispatch, [ORCH, worker({
    status: "active", workStartAt: T0, lastActivityAt: T0, fallbackOf: "coding-specialist", foreignCliCalls: 1,
    inFlightCalls: [{ id: "t1", tool: "Bash", at: T0, foreign: FOREIGN }],
  })]);
  const row = workerRow(doc);
  assert.equal(row.querySelector(".agent-accent-foreign"), null);
  assert.ok(row.querySelector(".agent-accent-fallback"));
});
