/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p102-t2: the "Claude limit reached" banner (media/main.js's
// showOrchestratorLimitBanner). Boots the REAL media/main.js in jsdom (same
// technique as test/vsOrchRawRateBadge.test.ts) and drives it with `state`
// pushes carrying state.orchestratorLimit. Time is controlled by overriding
// the page's Date.now and by capturing the banner's 30s re-evaluation timer.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require("jsdom");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vm = require("vm");

const MAIN_JS_PATH = join(process.cwd(), "media", "main.js");
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

const openWindows: any[] = [];
after(() => {
  for (const w of openWindows.splice(0)) {
    try {
      w.close();
    } catch {
      /* best-effort */
    }
  }
});

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
      return prop in t ? t[prop] : () => {};
    },
    set(t, prop: string, value) {
      t[prop] = value;
      return true;
    },
  });
}

function boot() {
  const src = readFileSync(MAIN_JS_PATH, "utf8");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "https://webview.local/",
  });
  const win: any = dom.window;
  openWindows.push(win);
  const doc = win.document;

  const ids = new Set<string>();
  const re = /getElementById\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) ids.add(m[1]);
  const runtimeCreated = new Set(["rebirth-announce", "rebirth-panel", "menu-edit-stage", "settings-modal-close", "stage-edit-panel"]);
  for (const id of ids) {
    if (runtimeCreated.has(id) || doc.getElementById(id)) continue;
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

  let stateStore: any = {};
  const posted: any[] = [];
  win.acquireVsCodeApi = () => ({
    postMessage: (msg: any) => {
      posted.push(msg);
    },
    getState: () => stateStore,
    setState: (s: any) => {
      stateStore = s;
    },
  });
  win.requestAnimationFrame = () => 1;
  win.cancelAnimationFrame = () => {};
  win.Image = class {
    set src(_v: string) {}
    addEventListener() {}
    removeEventListener() {}
  };
  win.HTMLCanvasElement.prototype.getContext = function (this: any) {
    if (!this.__ctxStub) this.__ctxStub = makeCtxStub(this);
    return this.__ctxStub;
  };
  win.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,iVBORw0KGgo=";

  // Capture only the banner's 30s re-evaluation timer; everything else is real.
  const limitTimers: Array<() => void> = [];
  const realSetInterval = win.setInterval.bind(win);
  win.setInterval = (fn: () => void, delay?: number, ...rest: unknown[]) => {
    if (delay === 30000) {
      limitTimers.push(fn);
      return 0;
    }
    return realSetInterval(fn, delay, ...rest);
  };

  let now = T0;
  win.Date.now = () => now;

  const errors: any[] = [];
  win.addEventListener("error", (e: any) => errors.push(e && (e.error || e.message) ? e.error || e.message : e));
  vm.runInContext(src, dom.getInternalVMContext(), { filename: "media/main.js" });
  assert.equal(errors.length, 0, "main.js booted without throwing");

  const dispatchState = (orchestratorLimit?: any, agentMetrics: any[] = []) =>
    win.dispatchEvent(
      new win.MessageEvent("message", {
        data: {
          type: "state",
          state: {
            sessionActive: true,
            completedTasks: 0,
            idleFreezeMs: 180000,
            sanityCapMs: 900000,
            workers: {},
            agentMetrics,
            ...(orchestratorLimit ? { orchestratorLimit } : {}),
          },
        },
      })
    );
  const banner = () => doc.getElementById("orchestrator-limit-banner");
  return {
    win,
    doc,
    posted,
    banner,
    dispatchState,
    advance(ms: number) {
      now += ms;
    },
    tickTimer() {
      assert.ok(limitTimers.length > 0, "banner registered its 30s re-evaluation timer");
      for (const fn of limitTimers) fn();
    },
    getState: () => stateStore,
  };
}

test("quota limit with resetAt shows title, local reset time and informational options only", () => {
  const h = boot();
  h.dispatchState({ kind: "quota", at: T0, resetAt: T0 + 3 * HOUR });
  const b = h.banner();
  assert.ok(b, "banner visible while the limit is active");
  assert.match(b.textContent, /Claude usage limit reached/);
  assert.match(b.textContent, /Resets at \d{1,2}:\d{2}/);
  const items = [...b.querySelectorAll("li")].map((li: any) => li.textContent);
  assert.equal(items.length, 2, "backup-harness option omitted until p103 configures one");
  assert.match(items[0], /\/model/);
  assert.match(items[1], /extra usage or an API key/);
  assert.match(items[1], /your choice in Claude Code/);
  assert.doesNotMatch(b.textContent, /backup harness/i);
});

test("title follows the limit kind", () => {
  const titles: Array<[string, RegExp]> = [
    ["quota", /Claude usage limit reached/],
    ["rate_limit", /Claude rate limit/],
    ["overloaded", /Claude is overloaded/],
    ["billing", /Billing issue/],
  ];
  for (const [kind, re] of titles) {
    const h = boot();
    h.dispatchState({ kind, at: T0 });
    assert.match(h.banner().querySelector(".orchestrator-limit-banner-title").textContent, re, kind);
  }
});

test("reset line: resetHint only reads 'Claude says: resets ...'; neither shows no reset line", () => {
  const hint = boot();
  hint.dispatchState({ kind: "quota", at: T0, resetHint: "3pm (America/Chicago)" });
  assert.equal(
    hint.banner().querySelector(".orchestrator-limit-banner-reset").textContent,
    "Claude says: resets 3pm (America/Chicago)"
  );

  const neither = boot();
  neither.dispatchState({ kind: "quota", at: T0 });
  assert.ok(neither.banner(), "still shown");
  assert.equal(neither.banner().querySelector(".orchestrator-limit-banner-reset"), null);

  const both = boot();
  both.dispatchState({ kind: "quota", at: T0, resetAt: T0 + HOUR, resetHint: "ignored when resetAt is known" });
  assert.match(both.banner().querySelector(".orchestrator-limit-banner-reset").textContent, /^Resets at /);
});

test("banner hides when the state clears", () => {
  const h = boot();
  h.dispatchState({ kind: "quota", at: T0, resetAt: T0 + HOUR });
  assert.ok(h.banner());
  h.dispatchState(undefined);
  assert.equal(h.banner(), null);
});

test("banner expires on the timer once resetAt passes, without a new state push", () => {
  const h = boot();
  h.dispatchState({ kind: "rate_limit", at: T0, resetAt: T0 + HOUR });
  assert.ok(h.banner());
  h.advance(HOUR - 1000);
  h.tickTimer();
  assert.ok(h.banner(), "still active just before resetAt");
  h.advance(2000);
  h.tickTimer();
  assert.equal(h.banner(), null, "gone after resetAt");
});

test("without resetAt the banner expires after the 6h fallback TTL", () => {
  const h = boot();
  h.dispatchState({ kind: "quota", at: T0 });
  h.advance(6 * HOUR - 1000);
  h.tickTimer();
  assert.ok(h.banner());
  h.advance(2000);
  h.tickTimer();
  assert.equal(h.banner(), null);
});

test("an already-expired limit is never shown", () => {
  const h = boot();
  h.dispatchState({ kind: "quota", at: T0 - 5 * HOUR, resetAt: T0 - HOUR });
  assert.equal(h.banner(), null);
});

test("dismiss hides it for that limit instance only; a new limit re-surfaces it", () => {
  const h = boot();
  const limit = { kind: "quota", at: T0, resetAt: T0 + 3 * HOUR };
  h.dispatchState(limit);
  h.banner().querySelector(".orchestrator-limit-banner-dismiss").click();
  assert.equal(h.banner(), null, "dismissed");
  h.dispatchState(limit); // the ~4s STATE push repeats the same limit
  assert.equal(h.banner(), null, "stays dismissed for the same instance");
  h.tickTimer();
  assert.equal(h.banner(), null, "timer does not resurrect it");
  assert.ok(h.getState().orchestratorLimitDismissedFor, "dismissal persisted in webview state");

  h.advance(HOUR);
  h.dispatchState({ kind: "quota", at: T0 + HOUR, resetAt: T0 + 5 * HOUR });
  assert.ok(h.banner(), "a new limit instance shows again");
});

test("banner is informational: one dismiss button, no routing nudge, posts nothing to the host", () => {
  const h = boot();
  h.dispatchState({ kind: "quota", at: T0, resetAt: T0 + HOUR });
  const b = h.banner();
  const buttons = [...b.querySelectorAll("button")];
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].getAttribute("aria-label"), "Dismiss");
  assert.doesNotMatch(b.textContent, /\b(route|reroute|offload|switch to|codex|gemini|opencode)\b/i);
  const before = h.posted.length;
  buttons[0].click();
  assert.equal(h.posted.length, before, "dismiss does not message the host");
});

test("the removed credit-pressure offer never renders even with a huge orchestrator token count", () => {
  const h = boot();
  h.dispatchState(undefined, [
    { id: "orchestrator", name: "Orchestrator", status: "active", taskCount: 0, mcpCount: 0, activeMs: 0, tokens: 9e9 },
  ]);
  assert.equal(h.doc.getElementById("credit-pressure-offer"), null);
  assert.ok(!h.posted.some((p: any) => p && /OFFLOAD_OFFER/.test(String(p.type))));
});
