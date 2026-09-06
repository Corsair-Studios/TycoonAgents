/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p19-t3 / p20-t2: density selection for the Agents modal (formerly Routing;
// the menu id #menu-routing is kept, its visible label is now "Agents" — see
// renderRoutingModal, media/main.js ~18250-18260). Density is now keyed on
// `lastSettings.harness.effective`, not the old `routing.visible` toggle:
//   - harness.effective !== "opencode" (or harness absent) -> "simple"
//     density: no "Default for all agents" section, no per-agent slot/
//     fallback editor, and the fixed footer shows ONLY the Close button
//     (Save/Revert/Clear stay hidden).
//   - harness.effective === "opencode" -> "full" density: the "Default for
//     all agents" section appears, and the footer shows Save (Revert/Clear
//     too; Close stays hidden).
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

function agentsPayload(harnessEffective: string) {
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
    harness: { effective: harnessEffective },
    routing: {
      visible: harnessEffective === "opencode",
      reason: harnessEffective === "opencode" ? "harness-opencode" : "hidden",
      useMultipleLlms: false,
      profileActive: false,
      routedAgentCount: 0,
    },
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

/** Opens the Agents modal (formerly Routing; #menu-routing kept, label now "Agents") via a settings + routing payload pair, at the density implied by the given effective harness. */
function openAgentsModalAtDensity(doc: any, dispatch: (d: any) => void, harnessEffective: string) {
  const menuRoutingBtn = doc.getElementById("menu-routing");
  assert.ok(menuRoutingBtn, "the DOM fixture should carry a static #menu-routing element");
  menuRoutingBtn.click();
  dispatch({ type: "settings", payload: agentsPayload(harnessEffective) });
  dispatch({ type: "routing", payload: routingPayloadFixture() });
}

test("Agents modal density: harness.effective !== 'opencode' renders simple density (no defaults section, no slot editor, footer shows only Close)", () => {
  const { doc, dispatch, errors } = bootMainJs();
  openAgentsModalAtDensity(doc, dispatch, "claude");

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

test("Agents modal density: harness.effective === 'opencode' renders full density (defaults section present, Save present)", () => {
  const { doc, dispatch, errors } = bootMainJs();
  openAgentsModalAtDensity(doc, dispatch, "opencode");

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
  openAgentsModalAtDensity(doc, dispatch, "opencode");
  const title = doc.getElementById("routing-modal-title");
  assert.ok(title, "#routing-modal-title should render");
  assert.equal(title.textContent, "Agents", '#menu-routing kept its id but the modal it opens must be titled "Agents"');
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test('Agents modal header (2026-09-05): shows a read-only "Runs on ..." line with a "Change in Settings" link, and never a harness <select>', () => {
  const { doc, dispatch, errors } = bootMainJs();
  openAgentsModalAtDensity(doc, dispatch, "claude");

  const body = doc.getElementById("routing-modal-body");
  assert.ok(body, "#routing-modal-body should render");
  assert.equal(body.querySelectorAll("select").length, 0, "Agents modal must not render any harness <select> (harness is chosen only in Settings)");

  const harnessLine = [...body.querySelectorAll("p")].find((p: any) => /^Runs on /.test(p.textContent || ""));
  assert.ok(harnessLine, `Agents modal should show a "Runs on ..." line, got paragraphs: ${JSON.stringify([...body.querySelectorAll("p")].map((p: any) => p.textContent))}`);
  assert.match(harnessLine.textContent, /Runs on Claude Code/, 'harness line should name the effective harness');

  const changeBtn = [...body.querySelectorAll("button")].find((b: any) => /Change in Settings/.test(b.textContent || ""));
  assert.ok(changeBtn, 'a "Change in Settings" link-button should render in the harness line');

  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("Agents modal density: no harness field at all also renders simple density", () => {
  const { doc, dispatch, errors } = bootMainJs();
  const menuRoutingBtn = doc.getElementById("menu-routing");
  menuRoutingBtn.click();
  const payload = agentsPayload("claude");
  delete (payload as any).harness;
  dispatch({ type: "settings", payload });
  dispatch({ type: "routing", payload: routingPayloadFixture() });

  const saveBtn = doc.getElementById("routing-save-btn");
  const closeBtn = doc.getElementById("routing-footer-close-btn");
  assert.equal(saveBtn.hidden, true, "absent harness should fall back to simple density (Save hidden)");
  assert.equal(closeBtn.hidden, false, "absent harness should fall back to simple density (Close visible)");
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// Classic (simple) density: p20-t2's "Use another provider for this agent"
// checkbox — unchecked/frontmatter, checked+expanded/routed,
// checked+disabled/hand-written, and the orchestrator's read-only text.
// ---------------------------------------------------------------------------

function classicRoutingPayloadFixture() {
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
        id: "frontmatter-agent",
        name: "frontmatter-agent",
        backend: { vendor: "anthropic", transport: "claude-native", model: "sonnet", costModelClass: "subscription" },
        source: "frontmatter",
        routeSource: "frontmatter",
        handWrittenBackend: false,
      },
      {
        id: "routed-agent",
        name: "routed-agent",
        backend: { vendor: "anthropic", transport: "claude-native", model: "opus", costModelClass: "subscription" },
        source: "explicit",
        routeSource: "explicit",
        handWrittenBackend: false,
      },
      {
        id: "handwritten-agent",
        name: "handwritten-agent",
        backend: { vendor: "google", transport: "mcp", mcpServer: "gemini", model: "google/gemini-2.5-pro", costModelClass: "metered" },
        source: "frontmatter",
        routeSource: "frontmatter",
        handWrittenBackend: true,
      },
      {
        id: "default-agent",
        name: "default-agent",
        backend: { vendor: "moonshot", transport: "openai-compatible", model: "moonshot/kimi-k2", costModelClass: "local" },
        source: "default",
        routeSource: "default",
        handWrittenBackend: false,
      },
    ],
    envProbe: {},
    presets: { vendors: ["anthropic", "google"], models: [] },
    lastApplied: {},
  };
}

function classicSettingsPayload() {
  return {
    hook: { installed: true, lastActivityAt: null },
    agents: [
      { id: "orchestrator", name: "Orchestrator", model: null, isOrchestrator: true, keywords: "" },
      { id: "frontmatter-agent", name: "Frontmatter Agent", model: "sonnet", isOrchestrator: false, keywords: "" },
      { id: "routed-agent", name: "Routed Agent", model: "opus", isOrchestrator: false, keywords: "" },
      { id: "handwritten-agent", name: "Handwritten Agent", model: "google/gemini-2.5-pro", isOrchestrator: false, keywords: "", vendor: "google", handWrittenBackend: true },
      { id: "default-agent", name: "Default Agent", model: "moonshot/kimi-k2", isOrchestrator: false, keywords: "", vendor: "moonshot" },
    ],
    delegation_mode: "direct",
    delegationHealth: {},
    hookHealth: { healthy: true, issueCount: 0 },
    contextBudget: null,
    harness: { effective: "claude" },
    routing: { visible: true, reason: "per-agent", useMultipleLlms: false, profileActive: true, routedAgentCount: 1 },
  };
}

function openClassicAgentsModal(doc: any, dispatch: (d: any) => void) {
  const menuRoutingBtn = doc.getElementById("menu-routing");
  assert.ok(menuRoutingBtn, "the DOM fixture should carry a static #menu-routing element");
  menuRoutingBtn.click();
  dispatch({ type: "settings", payload: classicSettingsPayload() });
  dispatch({ type: "routing", payload: classicRoutingPayloadFixture() });
}

test("Classic density: frontmatter agent's provider checkbox renders unchecked, no editor", () => {
  const { doc, dispatch, errors } = bootMainJs();
  openClassicAgentsModal(doc, dispatch);

  const row = doc.querySelector('.provider-toggle-row[data-agent-id="frontmatter-agent"]');
  assert.ok(row, "frontmatter-agent provider-toggle-row should render");
  const checkbox = row.querySelector(".agent-provider-checkbox");
  assert.ok(checkbox, "checkbox should render");
  assert.equal(checkbox.checked, false, "frontmatter agent's checkbox must start unchecked");
  assert.equal(checkbox.disabled, false);

  const editor = doc.querySelector('.classic-provider-editor[data-agent-id="frontmatter-agent"]');
  assert.equal(editor, null, "no slot/fallback editor should render for an unchecked frontmatter agent");

  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("Classic density: routed agent's provider checkbox renders checked and expanded with the slot editor visible", () => {
  const { doc, dispatch, errors } = bootMainJs();
  openClassicAgentsModal(doc, dispatch);

  const row = doc.querySelector('.provider-toggle-row[data-agent-id="routed-agent"]');
  assert.ok(row, "routed-agent provider-toggle-row should render");
  const checkbox = row.querySelector(".agent-provider-checkbox");
  assert.equal(checkbox.checked, true, "a routed (non-frontmatter) agent's checkbox must start checked");
  assert.equal(checkbox.disabled, false);

  const editor = doc.querySelector('.classic-provider-editor[data-agent-id="routed-agent"]');
  assert.ok(editor, "the slot/fallback editor should render for an expanded routed agent");
  assert.ok(editor.querySelector(".routing-slot-fields"), "slot editor fields should render inside it");

  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("Classic density: hand-written-backend agent's checkbox renders checked and disabled with the MCP help text", () => {
  const { doc, dispatch, errors } = bootMainJs();
  openClassicAgentsModal(doc, dispatch);

  const row = doc.querySelector('.provider-toggle-row[data-agent-id="handwritten-agent"]');
  assert.ok(row, "handwritten-agent provider-toggle-row should render");
  const checkbox = row.querySelector(".agent-provider-checkbox");
  assert.equal(checkbox.checked, true, "a hand-written-backend agent's checkbox must render checked");
  assert.equal(checkbox.disabled, true, "a hand-written-backend agent's checkbox must be disabled");

  const helpText = row.querySelector(".delegation-mode-option-help");
  assert.ok(helpText, "help text should render");
  assert.match(helpText.textContent, /via MCP \(hand-written\)/, `expected hand-written MCP help text, got: "${helpText.textContent}"`);

  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("Classic density: checking the frontmatter agent's checkbox reveals the editor and Save/Revert become visible", () => {
  const { doc, dispatch, errors } = bootMainJs();
  openClassicAgentsModal(doc, dispatch);

  const row = doc.querySelector('.provider-toggle-row[data-agent-id="frontmatter-agent"]');
  const checkbox = row.querySelector(".agent-provider-checkbox");
  checkbox.checked = true;
  checkbox.dispatchEvent(new (doc.defaultView as any).Event("change", { bubbles: true }));

  const editor = doc.querySelector('.classic-provider-editor[data-agent-id="frontmatter-agent"]');
  assert.ok(editor, "checking the box should reveal the slot/fallback editor");

  const saveBtn = doc.getElementById("routing-save-btn");
  assert.equal(saveBtn.hidden, false, "Save must become visible once a classic-density card is expanded");

  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("Classic density: unchecking a routed agent's checkbox posts clearAgentRoute with its id", () => {
  const { doc, dispatch, errors, posted } = bootMainJs();
  openClassicAgentsModal(doc, dispatch);

  const row = doc.querySelector('.provider-toggle-row[data-agent-id="routed-agent"]');
  const checkbox = row.querySelector(".agent-provider-checkbox");
  assert.equal(checkbox.checked, true);
  checkbox.checked = false;
  checkbox.dispatchEvent(new (doc.defaultView as any).Event("change", { bubbles: true }));

  // Note: the card re-renders expanded again on this same tick, because
  // `routingAgent.routeSource` still reads "explicit" until a fresh
  // "routing" payload round-trips from the host after clearAgentRoute is
  // handled server-side — expansion falls back to `isRouted` once the local
  // routingExpandedAgents override is deleted (media/main.js's classic
  // checkbox change handler). The externally-observable effect of the
  // uncheck in THIS render pass is the posted message, asserted below.
  const clearMsg = posted.find((m) => m && m.type === "clearAgentRoute");
  assert.ok(clearMsg, `expected a clearAgentRoute message to be posted, got: ${JSON.stringify(posted)}`);
  assert.equal(clearMsg.agentId, "routed-agent");

  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("Classic density: an inherited-default agent shows an inherit note instead of a checkbox, with an override link", () => {
  const { doc, dispatch, errors } = bootMainJs();
  openClassicAgentsModal(doc, dispatch);

  const row = doc.querySelector('.provider-toggle-row[data-agent-id="default-agent"]');
  assert.ok(row, "default-agent provider-toggle-row should render");

  const checkbox = row.querySelector(".agent-provider-checkbox");
  assert.equal(checkbox, null, "an inherited-default agent must render no checkbox");

  assert.match(
    row.textContent,
    /Inherits the Default for all agents route/,
    `expected inherit note, got: "${row.textContent}"`
  );
  assert.match(row.textContent, /moonshot\/moonshot\/kimi-k2|moonshot/, "inherit note should name the vendor/model");
  assert.match(
    row.textContent,
    /clear the Default card/,
    `expected the stop-inheriting hint, got: "${row.textContent}"`
  );

  const overrideBtn = row.querySelector(".routing-override-btn");
  assert.ok(overrideBtn, "an 'Override for this agent' link should render");
  assert.match(overrideBtn.textContent, /Override for this agent/);

  const editor = doc.querySelector('.classic-provider-editor[data-agent-id="default-agent"]');
  assert.equal(editor, null, "no editor should render before Override is clicked");

  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("Classic density: clicking Override for an inherited-default agent expands the slot editor and posts no clearAgentRoute", () => {
  const { doc, dispatch, errors, posted } = bootMainJs();
  openClassicAgentsModal(doc, dispatch);

  const row = doc.querySelector('.provider-toggle-row[data-agent-id="default-agent"]');
  const overrideBtn = row.querySelector(".routing-override-btn") as any;
  overrideBtn.click();

  const editor = doc.querySelector('.classic-provider-editor[data-agent-id="default-agent"]');
  assert.ok(editor, "clicking Override should reveal the slot/fallback editor");
  assert.ok(editor.querySelector(".routing-slot-fields"), "slot editor fields should render inside it");

  const clearMsg = posted.find((m) => m && m.type === "clearAgentRoute");
  assert.equal(clearMsg, undefined, "overriding an inherited-default agent must never post clearAgentRoute");

  const saveBtn = doc.getElementById("routing-save-btn");
  assert.equal(saveBtn.hidden, false, "Save must become visible once the card is expanded");

  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("Settings harness section has exactly one 'Open Agents' link, and clicking it hides Settings and shows the Agents modal", () => {
  const { doc, dispatch, errors } = bootMainJs();

  const menuSettingsBtn = doc.getElementById("menu-settings");
  assert.ok(menuSettingsBtn, "the DOM fixture should carry a static #menu-settings element");
  menuSettingsBtn.click();
  // OpenCode + needsDefaultRoute true exercises the hint-carries-the-link path.
  dispatch({
    type: "settings",
    payload: { harness: { effective: "opencode", needsDefaultRoute: true } },
  });

  const setupViewEl = doc.getElementById("setup-view");
  assert.ok(setupViewEl, "#setup-view should exist");
  assert.equal(setupViewEl.hasAttribute("hidden"), false, "Settings should be visible after menu-settings click");

  const harnessSections = [...doc.querySelectorAll("#setup-config .settings-heading")].filter(
    (h: any) => /agent harness/i.test(h.textContent || ""),
  );
  assert.ok(harnessSections.length > 0, "expected an 'Agent harness' section to render");
  const harnessSection = harnessSections[0].closest(".settings-section") || harnessSections[0].parentElement;
  const openAgentsLinks = [...harnessSection.querySelectorAll("button")].filter(
    (b: any) => (b.textContent || "").trim() === "Open Agents",
  );
  assert.equal(openAgentsLinks.length, 1, `expected exactly one "Open Agents" link, got: ${openAgentsLinks.length}`);

  openAgentsLinks[0].click();
  dispatch({ type: "routing", payload: routingPayloadFixture() });

  assert.equal(setupViewEl.hasAttribute("hidden"), true, "Settings should be hidden after Open Agents is clicked");
  const modal = doc.getElementById("routing-modal");
  assert.ok(modal, "Agents modal should render");
  assert.notEqual(modal.hasAttribute("hidden"), true, "Agents modal should be visible after Open Agents is clicked");

  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("Classic density: orchestrator card shows the OpenCode-only routing note", () => {
  const { doc, dispatch, errors } = bootMainJs();
  openClassicAgentsModal(doc, dispatch);

  const orchestratorHelp = doc.querySelector(".orchestrator-model-help");
  assert.ok(orchestratorHelp, "orchestrator help text should render");
  assert.match(
    orchestratorHelp.textContent,
    /Routing the orchestrator applies only when OpenCode runs your agents\./,
    `expected the OpenCode-only routing note, got: "${orchestratorHelp.textContent}"`,
  );

  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});
