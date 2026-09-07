/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Regression for the VS Code host bug: opening the Agents modal (menu id
// #menu-routing, see media/src/main/010-modals-badges-rebirth.js's
// openRoutingModal) used to post only ROUTING_MSG.GET, never "getSettings".
// The Agents card list's per-agent .keyword-input value comes from
// lastSettings (settingsAgentsById in renderRoutingModal,
// media/src/main/100-slot-editor-settings.js ~1409-1441) — never populated
// until a "settings" reply lands. The VS Code host only ever sends
// "settings" in reply to a "getSettings" message (unlike the standalone
// server, which broadcasts it eagerly), so opening Agents from the
// hamburger without visiting Settings first left every Keywords input
// blank. Fix: openRoutingModal() now also posts "getSettings" on open, and
// the existing "settings" handler (060-theme-image-review.js ~2276-2286)
// already re-renders the routing modal when it's open and a routing
// payload has already landed.
//
// This spec dispatches ONLY the "routing" payload first (mirroring the bug
// scenario: routing replies before any settings ever arrive), asserts the
// keyword inputs are present but blank, then dispatches "settings" and
// asserts they fill in from it — without the fix, the "settings" payload
// would never even be requested and the input stays blank forever.
//
// Boots the real media/main.js via readFileSync + node:vm, same technique
// as test/agentsModalDensity.test.ts.

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
  "routing-modal",
  "routing-backdrop",
  "routing-dialog",
  "routing-modal-close",
  "routing-modal-title",
  "routing-modal-body",
]);

function makeCtxStub(canvasEl: unknown): unknown {
  const gradient = { addColorStop() {} };
  return {
    canvas: canvasEl,
    save() {},
    restore() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    fill() {},
    stroke() {},
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    setTransform() {},
    translate() {},
    scale() {},
    rotate() {},
    measureText: () => ({ width: 0 }),
    fillText() {},
    drawImage() {},
  };
}

function makeFakeImage(win: any) {
  return class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private _src = "";
    set src(v: string) {
      this._src = v;
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
    postMessage: (m: any) => posted.push(m),
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

  return { win, doc, dispatch, errors, posted };
}

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

function settingsPayloadWithKeywords() {
  return {
    hook: { installed: true, lastActivityAt: null },
    agents: [
      { id: "orchestrator", name: "Orchestrator", model: null, isOrchestrator: true, keywords: "" },
      {
        id: "coding-specialist",
        name: "Coding Specialist",
        model: "sonnet",
        isOrchestrator: false,
        keywords: "implement|code|fix|bug|refactor",
      },
    ],
    delegation_mode: "direct",
    delegationHealth: {},
    hookHealth: { healthy: true, issueCount: 0 },
    contextBudget: null,
    harness: { effective: "claude-code" },
    routing: {
      visible: false,
      reason: "hidden",
      useMultipleLlms: false,
      profileActive: false,
      routedAgentCount: 0,
    },
  };
}

test("Agents modal: keyword inputs fill in from a 'settings' payload that arrives after 'routing' — even though the settings payload had not landed at open time", () => {
  const { doc, dispatch, errors, posted } = bootMainJs();

  const menuRoutingBtn = doc.getElementById("menu-routing");
  assert.ok(menuRoutingBtn, "the DOM fixture should carry a static #menu-routing element");

  // Open the Agents modal — this is the exact scenario the VS Code host bug
  // occurred in: no prior visit to Settings, no "settings" payload has ever
  // arrived. Only click; do NOT pre-seed a settings payload.
  menuRoutingBtn.click();

  // The fix requires openRoutingModal() to ask for settings itself.
  assert.ok(
    posted.some((m) => m && m.type === "getSettings"),
    `opening the Agents modal must post "getSettings" so keywords aren't stuck waiting on a Settings-screen visit; posted: ${JSON.stringify(posted)}`
  );

  // Simulate the routing reply landing before the settings reply (the race
  // that produced blank inputs pre-fix, since renderRoutingModal is driven
  // by the routing payload).
  dispatch({ type: "routing", payload: routingPayloadFixture() });

  let kwInput = doc.querySelector('#routing-modal-body .keyword-input') as HTMLInputElement | null;
  assert.ok(kwInput, "keyword input should render once the routing payload lands, even with no settings yet");
  assert.equal(kwInput!.value, "", "keyword input has nothing to show before any settings payload has arrived");

  // Now the settings reply lands.
  dispatch({ type: "settings", payload: settingsPayloadWithKeywords() });

  kwInput = doc.querySelector('#routing-modal-body .keyword-input') as HTMLInputElement | null;
  assert.ok(kwInput, "keyword input should still be present after the settings payload triggers a re-render");
  assert.equal(
    kwInput!.value,
    "implement|code|fix|bug|refactor",
    "keyword input must populate from the settings payload once it arrives, without requiring the modal to be reopened"
  );

  assert.equal(errors.length, 0, `media/main.js should not throw: ${JSON.stringify(errors)}`);
});

function routingPayloadFixtureTwoAgents() {
  const fixture = routingPayloadFixture();
  fixture.agents.push({
    id: "testing-specialist",
    name: "testing-specialist",
    backend: { vendor: "anthropic", transport: "claude-native", model: "sonnet", costModelClass: "subscription" },
    source: "default",
  });
  return fixture;
}

function settingsPayloadWithKeywordsTwoAgents() {
  const payload = settingsPayloadWithKeywords();
  payload.agents.push({
    id: "testing-specialist",
    name: "Testing Specialist",
    model: "sonnet",
    isOrchestrator: false,
    keywords: "test|spec|vitest|jest|coverage|unit",
  });
  return payload;
}

test("Agents modal: in-progress typing in a keyword input survives a 'settings' payload landing mid-edit, while other inputs still fill in", () => {
  const { doc, dispatch, errors } = bootMainJs();

  doc.getElementById("menu-routing")!.click();
  dispatch({ type: "routing", payload: routingPayloadFixtureTwoAgents() });

  const codingInput = doc.querySelector(
    '#routing-modal-body [data-agent-id="coding-specialist"].keyword-input'
  ) as HTMLInputElement | null;
  assert.ok(codingInput, "coding-specialist keyword input should be present after the routing payload");

  // Simulate the user typing into the Keywords box before the settings
  // reply (which triggers a full renderRoutingModal rebuild) lands.
  codingInput!.value = "custom|words";
  codingInput!.dispatchEvent(new (doc.defaultView as any).Event("input", { bubbles: true }));

  dispatch({ type: "settings", payload: settingsPayloadWithKeywordsTwoAgents() });

  const codingInputAfter = doc.querySelector(
    '#routing-modal-body [data-agent-id="coding-specialist"].keyword-input'
  ) as HTMLInputElement | null;
  assert.ok(codingInputAfter, "coding-specialist keyword input should still be present after the rebuild");
  assert.equal(
    codingInputAfter!.value,
    "custom|words",
    "typed-but-unsaved keyword text must survive a settings-triggered rebuild"
  );

  const testingInput = doc.querySelector(
    '#routing-modal-body [data-agent-id="testing-specialist"].keyword-input'
  ) as HTMLInputElement | null;
  assert.ok(testingInput, "testing-specialist keyword input should be present");
  assert.equal(
    testingInput!.value,
    "test|spec|vitest|jest|coverage|unit",
    "an untouched agent's keyword input should still fill in from the settings payload"
  );

  assert.equal(errors.length, 0, `media/main.js should not throw: ${JSON.stringify(errors)}`);
});
