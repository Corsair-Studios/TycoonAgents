/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p19-t3: density selection for the Agents modal (formerly Routing; the
// menu id #menu-routing is kept, its visible label is now "Agents" — see
// renderRoutingModal, media/main.js ~18087-18260). Density is computed from
// `lastSettings.routing.visible`:
//   - `visible: false` -> "simple" density: no "Default for all agents"
//     section, no per-agent slot/fallback editor, and the fixed footer
//     shows ONLY the Close button (Save/Revert/Clear stay hidden).
//   - `visible: true` (or the field absent, media/main.js:18106) -> "full"
//     density: the "Default for all agents" section appears, and the
//     footer shows Save (Revert/Clear too; Close stays hidden).
//
// This boots the REAL media/main.js via readFileSync + node:vm, the same
// technique test/routingView.test.ts and test/resolveOrchestratorPrice.test.ts
// use (media/main.js is an untyped browser IIFE with no exported symbols —
// DOM observation is the only viable strategy). Nothing here reimplements
// the density decision; every assertion reads the real rendered DOM.

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

  return { win, doc, dispatch, errors };
}

function agentsPayload(routingVisible: boolean) {
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
    routing: { visible: routingVisible, reason: routingVisible ? "toggle" : "hidden", useMultipleLlms: routingVisible, profileActive: false, routedAgentCount: 0 },
  };
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

/** Opens the Agents modal (formerly Routing; #menu-routing kept, label now "Agents") via a settings + routing payload pair, at the given routing.visible density. */
function openAgentsModalAtDensity(doc: any, dispatch: (d: any) => void, routingVisible: boolean) {
  const menuRoutingBtn = doc.getElementById("menu-routing");
  assert.ok(menuRoutingBtn, "the DOM fixture should carry a static #menu-routing element");
  menuRoutingBtn.click();
  dispatch({ type: "settings", payload: agentsPayload(routingVisible) });
  dispatch({ type: "routing", payload: routingPayloadFixture() });
}

test("Agents modal density: routing.visible === false renders simple density (no defaults section, no slot editor, footer shows only Close)", () => {
  const { doc, dispatch, errors } = bootMainJs();
  openAgentsModalAtDensity(doc, dispatch, false);

  const modal = doc.getElementById("routing-modal");
  assert.ok(modal, "Agents modal should render");
  assert.notEqual(modal.hasAttribute("hidden"), true, "Agents modal should be visible after open");

  const sections = [...doc.querySelectorAll("#routing-modal-body .settings-heading")];
  const sectionTitles = sections.map((s: any) => s.textContent);
  assert.ok(
    !sectionTitles.some((t: string) => /default for all agents/i.test(t || "")),
    `simple density must NOT render a "Default for all agents" section, got sections: ${JSON.stringify(sectionTitles)}`,
  );

  // No per-agent slot editor (vendor/transport/model selects) in simple density.
  assert.equal(doc.querySelectorAll(".routing-slot-fields").length, 0, "simple density must not render any slot editor fields");
  assert.equal(doc.querySelectorAll(".routing-fallback-details").length, 0, "simple density must not render any fallback-chain editor");

  // Footer: Close only.
  const closeBtn = doc.getElementById("routing-footer-close-btn");
  const saveBtn = doc.getElementById("routing-save-btn");
  const revertBtn = doc.getElementById("routing-revert-btn");
  const clearBtn = doc.getElementById("routing-clear-btn");
  assert.ok(closeBtn, "#routing-footer-close-btn should render");
  assert.equal(closeBtn.hidden, false, "Close button must be visible in simple density");
  assert.equal(saveBtn.hidden, true, "Save button must be hidden in simple density");
  assert.equal(revertBtn.hidden, true, "Revert button must be hidden in simple density");
  assert.equal(clearBtn.hidden, true, "Clear button must be hidden in simple density");

  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("Agents modal density: routing.visible === true renders full density (defaults section present, Save present)", () => {
  const { doc, dispatch, errors } = bootMainJs();
  openAgentsModalAtDensity(doc, dispatch, true);

  const modal = doc.getElementById("routing-modal");
  assert.ok(modal, "Agents modal should render");
  assert.notEqual(modal.hasAttribute("hidden"), true, "Agents modal should be visible after open");

  const sections = [...doc.querySelectorAll("#routing-modal-body .settings-heading")];
  const sectionTitles = sections.map((s: any) => s.textContent);
  assert.ok(
    sectionTitles.some((t: string) => /default for all agents/i.test(t || "")),
    `full density must render a "Default for all agents" section, got sections: ${JSON.stringify(sectionTitles)}`,
  );

  // At least one slot editor renders (orchestrator + defaults + per-agent).
  assert.ok(doc.querySelectorAll(".routing-slot-fields").length > 0, "full density must render slot editor fields");

  const closeBtn = doc.getElementById("routing-footer-close-btn");
  const saveBtn = doc.getElementById("routing-save-btn");
  const revertBtn = doc.getElementById("routing-revert-btn");
  const clearBtn = doc.getElementById("routing-clear-btn");
  assert.equal(closeBtn.hidden, true, "Close button must be hidden in full density");
  assert.equal(saveBtn.hidden, false, "Save button must be visible in full density");
  assert.equal(revertBtn.hidden, false, "Revert button must be visible in full density");
  assert.equal(clearBtn.hidden, false, "Clear button must be visible in full density");

  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test('Agents modal: the menu entry that opens it (#menu-routing) is present, and the modal title reads "Agents"', () => {
  const { doc, dispatch, errors } = bootMainJs();
  openAgentsModalAtDensity(doc, dispatch, true);
  const title = doc.getElementById("routing-modal-title");
  assert.ok(title, "#routing-modal-title should render");
  assert.equal(title.textContent, "Agents", '#menu-routing kept its id but the modal it opens must be titled "Agents"');
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});
