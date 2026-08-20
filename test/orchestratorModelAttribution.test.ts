/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Regression pin for the orchestrator model-attribution bug (2026-08-19): the
// user ran `/model fable` in Claude Code for over an hour; the metrics panel
// kept showing "Opus" for the orchestrator row. Root cause chain:
//   1. hooks/tycoon-claude-hook.cjs correctly wrote observed model
//      "claude-fable-5" into agentMetrics records.
//   2. panel.ts's _stampRosterModels() (src/host/vscode/panel.ts ~5615)
//      unconditionally overwrote agentMetrics[].model with the roster
//      frontmatter value (.claude/agents/orchestrator.md declares
//      `model: opus`), demoting the real observation to `observedModel`.
//   3. media/main.js's prettyModel() (~13887) only lets `observedModel` win
//      when its family matches the roster family — fable != opus, so the
//      row rendered "Opus" regardless of what actually ran.
//
// Design ruling (recorded in CLAUDE.md task brief, not re-litigated here):
// the orchestrator has NO model selector anywhere in settings — its roster
// frontmatter is advisory documentation, not a configured choice — so for
// the orchestrator ONLY, a well-formed observed model wins outright,
// including across families. Subagents keep the family guard byte-identical
// (their model IS user-configured via roster/settings radios, so roster-wins
// remains correct anti-fabrication there).
//
// This file boots the REAL media/main.js source via readFileSync + node:vm,
// the same technique test/vsOrchRawRateBadge.test.ts uses (bootMainJs is
// duplicated here rather than imported, matching that file's own precedent
// of a self-contained harness per test file).

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

  return { win, doc, dispatch, errors };
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
      modeStats: [],
    },
  });
}

/** Reads the orchestrator/agent row's `title` attribute (name-cell tooltip) from #metrics-tbody. */
function rowNameTitle(doc: any, displayName: string): string | null {
  const rows = [...doc.querySelectorAll("#metrics-tbody tr")];
  for (const row of rows) {
    const nameTd = row.querySelector(".col-name");
    if (!nameTd) continue;
    if (nameTd.textContent && nameTd.textContent.toLowerCase().includes(displayName.toLowerCase())) {
      return nameTd.title;
    }
  }
  return null;
}

/** Reads the Delegation tab's "Coordination (not delegated work)" line text, if rendered. */
function coordinationLineText(doc: any): string | null {
  const sections = [...doc.querySelectorAll("#delegation-stats .delegation-section")];
  for (const section of sections) {
    const heading = section.querySelector(".delegation-stats-heading");
    if (heading && heading.textContent === "Coordination (not delegated work)") {
      const row = section.querySelector(".delegation-stats-row");
      return row ? row.textContent : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// (a) THE USER'S EXACT SCENARIO: orchestrator roster/configured "opus",
// observed "claude-fable-5" -> renders Fable, not Opus, on both surfaces.
//
// Fixture shape mirrors panel.ts's ACTUAL _stampRosterModels() output for
// the orchestrator entry (src/host/vscode/panel.ts ~5656): `model` carries
// the hook-OBSERVED value (untrusted), `rosterModel` carries the roster/
// frontmatter (trusted config) value, and `observedModel` mirrors `model`
// for symmetry with subagent entries. A first version of this test set
// `model: "opus", observedModel: "claude-fable-5"` directly -- the INVERSE
// of what panel.ts produces -- which passed by accident: prettyModel's
// isOrchestratorRow branch requires a truthy `observedModel` to fire, that
// field was actually undefined for the orchestrator pre-fix, and the
// fall-through read the untrusted `model` string as if it were trusted
// roster data. Codex's cross-vendor review caught this; these fixtures now
// match the real wire shape so the intended branch actually executes.
// ---------------------------------------------------------------------------

test("orchestrator row: rosterModel 'opus' + observed well-formed 'claude-fable-5' renders Fable (name tooltip), not Opus", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "claude-fable-5", observedModel: "claude-fable-5", rosterModel: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const title = rowNameTitle(doc, "Orchestrator");
  assert.ok(title, "expected a title on the orchestrator row's name cell");
  assert.match(String(title), /Fable/, `expected the orchestrator tooltip to mention Fable, got '${title}'`);
  assert.doesNotMatch(String(title), /Opus/, `orchestrator tooltip must NOT show Opus when observed model is a well-formed Fable id, got '${title}'`);
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("orchestrator: rosterModel 'opus' + observed well-formed 'claude-fable-5' renders Fable in the Delegation tab's Coordination line", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "claude-fable-5", observedModel: "claude-fable-5", rosterModel: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const text = coordinationLineText(doc);
  assert.ok(text, "expected the Coordination (not delegated work) line to render");
  assert.match(String(text), /Fable/, `expected the coordination line to mention Fable, got '${text}'`);
  assert.doesNotMatch(String(text), /Opus/, `coordination line must NOT show Opus when observed model is a well-formed Fable id, got '${text}'`);
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (b) SUBAGENT FAMILY GUARD UNCHANGED: subagent roster 'sonnet' + observed
// well-formed 'claude-fable-5' (family mismatch) still renders Sonnet, never
// Fable. Anti-fabrication for user-configured subagent models must hold.
// ---------------------------------------------------------------------------

test("subagent row: roster 'sonnet' + observed well-formed 'claude-fable-5' (family mismatch) still renders Sonnet, not Fable -- family guard unchanged", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", observedModel: "claude-fable-5", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const title = rowNameTitle(doc, "Coding Specialist");
  assert.ok(title, "expected a title on the subagent row's name cell");
  assert.match(String(title), /Sonnet/, `expected the subagent tooltip to show Sonnet (roster-authoritative), got '${title}'`);
  assert.doesNotMatch(String(title), /Fable/, `subagent tooltip must NOT show Fable despite a well-formed observed id -- family guard must hold, got '${title}'`);
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (c) MALFORMED OBSERVED IDS NEVER RENDER RAW -- both row types.
// ---------------------------------------------------------------------------

test("orchestrator row: malformed observed model string falls back to rosterModel family (Opus), never rendered raw", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "<script>not-a-real-model</script>", observedModel: "<script>not-a-real-model</script>", rosterModel: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const title = rowNameTitle(doc, "Orchestrator");
  assert.ok(title, "expected a title on the orchestrator row's name cell");
  assert.match(String(title), /Opus/, `expected fallback to rosterModel family Opus when observed id is malformed, got '${title}'`);
  assert.doesNotMatch(String(title), /not-a-real-model|<script>/, `malformed observed id must never render raw, got '${title}'`);
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// THE CASE THAT WOULD HAVE CAUGHT THE BUG: no rosterModel at all (so the
// only signal prettyModel has is the untrusted, malformed observed value).
// Before the fix, call sites passed `agent.model` (the untrusted hook
// string, "not-a-model-id-<script>") to prettyModel's TRUSTED first
// parameter, and `isWellFormedClaudeModelId's floor was bypassed entirely
// on that path because `if (!family) return String(rosterModel)` treats
// its first argument as pre-validated config -- so the malformed string
// rendered raw into the DOM. This must now be impossible: the malformed
// value must fail isWellFormedClaudeModelId, the isOrchestratorRow branch
// must decline it, and with no rosterModel to fall back to, the result
// must be the empty string -- never the raw malformed text.
test("orchestrator row: NEGATIVE ANCHOR -- malformed observed model with NO rosterModel never renders raw, falls back to empty/dash rather than String(unvalidated)", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "not-a-model-id-<script>", observedModel: "not-a-model-id-<script>", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const title = rowNameTitle(doc, "Orchestrator");
  assert.ok(title !== null, "expected a title (possibly with no model segment) on the orchestrator row's name cell");
  assert.doesNotMatch(String(title), /not-a-model-id|<script>/, `malformed observed id with no rosterModel must NEVER render raw, got '${title}'`);
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);

  const coordText = coordinationLineText(doc);
  if (coordText !== null) {
    assert.doesNotMatch(String(coordText), /not-a-model-id|<script>/, `Coordination line must NEVER render a malformed observed id raw, got '${coordText}'`);
  }
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

test("subagent row: malformed observed model string falls back to roster family (Sonnet), never rendered raw", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", observedModel: "totally-bogus-not-a-model-id", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const title = rowNameTitle(doc, "Coding Specialist");
  assert.ok(title, "expected a title on the subagent row's name cell");
  assert.match(String(title), /Sonnet/, `expected fallback to roster family Sonnet when observed id is malformed, got '${title}'`);
  assert.doesNotMatch(String(title), /totally-bogus-not-a-model-id/, `malformed observed id must never render raw, got '${title}'`);
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});

// ---------------------------------------------------------------------------
// (d) No observed model at all -- orchestrator falls back to roster family
// cleanly (no crash, no blank), matching pre-fix behavior for that case.
// ---------------------------------------------------------------------------

test("orchestrator row: no observedModel present renders rosterModel family (Opus) cleanly", () => {
  const { doc, dispatch, errors } = bootMainJs();
  dispatchMetrics(dispatch, [
    { id: "orchestrator", name: "Orchestrator", status: "idle", model: "opus", rosterModel: "opus", tokens: 2000, cacheReadTokens: 0, activeMs: 1000, taskCount: 1 },
    { id: "coding-specialist", name: "Coding Specialist", status: "idle", model: "sonnet", tokens: 100000, cacheReadTokens: 0, activeMs: 5000, taskCount: 4 },
  ]);
  dispatch({ type: "settings", payload: agentsPayload() });

  const title = rowNameTitle(doc, "Orchestrator");
  assert.ok(title, "expected a title on the orchestrator row's name cell");
  assert.match(String(title), /Opus/, `expected rosterModel family Opus with no observed model, got '${title}'`);
  assert.equal(errors.length, 0, `no boot/render errors: ${errors.map(String).join("; ")}`);
});
