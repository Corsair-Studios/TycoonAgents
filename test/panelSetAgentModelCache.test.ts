/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Regression coverage for the "Sonnet radio reverts to haiku after the agent
// runs" bug (build 0.0.553). Root cause: `_handleSetAgentModel` wrote the new
// model into `.claude/agents/<id>.md` on disk correctly, but never
// invalidated `this._rosterModelCache` — the Map built once by
// `_getRosterModelMap()` and reused by `_stampRosterModels()` on every
// subsequent activity-driven MSG.STATE push. Every OTHER roster-mutating
// handler (`_handleRemoveAgent`, `_handleResetMetrics`) already clears this
// cache after writing; `_handleSetAgentModel` was the one omission. Because
// the cache was never cleared, the very next hook event re-stamped the
// panel's displayed agentMetrics with the STALE pre-change model, making a
// just-applied "Sonnet" choice appear to silently revert to "haiku" the
// moment the agent was dispatched again — even though the file on disk was
// already correct the whole time.
//
// Also covers the companion fix: `_handleSetAgentModel`'s success path now
// re-invokes `_handleGetSettings()` (mirroring `_handleRemoveAgent`) so the
// panel reflects the change immediately instead of only on next reopen.
//
// Same require-time vscode stub technique as
// test/panelDelegationHealthLive.test.ts / test/panelAgentFileInstall.test.ts
// so this exercises the REAL production method, not a reimplementation.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("module");
const originalLoad = NodeModule._load;
function makeVscodeStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === "__esModule") return true;
      if (!(prop in target)) {
        target[prop] = new Proxy(function stub() {}, handler);
      }
      return target[prop];
    },
    apply() {
      return new Proxy({}, handler);
    },
    construct() {
      return new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler);
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TycoonPanel } = require("../src/host/vscode/panel") as typeof import("../src/host/vscode/panel");

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "panelSetAgentModelCache-"));
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  return root;
}

function writeAgentFile(root: string, id: string, model: string): string {
  const p = path.join(root, ".claude", "agents", `${id}.md`);
  fs.writeFileSync(
    p,
    `---\nname: ${id}\ndescription: "test"\nmodel: ${model}\n---\n\n# Test\n`,
    "utf8"
  );
  return p;
}

// `_handleSetAgentModel` only dereferences `this._projectRoot`,
// `this._panel.webview.postMessage`, `this._rosterModelCache`, and
// `this._handleGetSettings` — a minimal receiver carrying those is enough to
// invoke the real production method.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakePanel(root: string): any {
  return {
    _projectRoot: () => root,
    _panel: { webview: { postMessage: () => {} } },
    _rosterModelCache: new Map([["testing-specialist", "some-stale-cached-value"]]),
    _handleGetSettings: () => {},
  };
}

test("_handleSetAgentModel invalidates _rosterModelCache on a successful write", () => {
  const root = tmpRoot();
  writeAgentFile(root, "testing-specialist", "haiku");
  const fake = makeFakePanel(root);

  assert.ok(fake._rosterModelCache, "sanity: cache is primed with a stale entry before the call");

  (TycoonPanel.prototype as any)._handleSetAgentModel.call(fake, "testing-specialist", "sonnet");

  assert.equal(
    fake._rosterModelCache,
    undefined,
    "a successful model write must invalidate _rosterModelCache so the next _stampRosterModels() rereads the roster instead of re-serving the pre-change value"
  );

  // Cross-check the actual regression symptom: the file on disk is correct...
  const written = fs.readFileSync(path.join(root, ".claude", "agents", "testing-specialist.md"), "utf8");
  assert.match(written, /^model: sonnet$/m, "the file itself must carry the new model");
});

test("_handleSetAgentModel: success path invokes _handleGetSettings exactly once (fresh roster reaches the webview immediately)", () => {
  const root = tmpRoot();
  writeAgentFile(root, "testing-specialist", "haiku");
  let calls = 0;
  const fake = {
    _projectRoot: () => root,
    _panel: { webview: { postMessage: () => {} } },
    _rosterModelCache: new Map([["testing-specialist", "haiku"]]),
    _handleGetSettings: () => { calls++; },
  };

  (TycoonPanel.prototype as any)._handleSetAgentModel.call(fake, "testing-specialist", "sonnet");

  assert.equal(calls, 1, "_handleGetSettings must be called exactly once on a successful model write");
});

test("_handleSetAgentModel: on failure (unreadable file), does NOT call _handleGetSettings and does not clear an already-undefined cache incorrectly", () => {
  const root = tmpRoot(); // no agent file written -> readFileSync throws
  let calls = 0;
  const fake = {
    _projectRoot: () => root,
    _panel: { webview: { postMessage: () => {} } },
    _rosterModelCache: new Map([["testing-specialist", "haiku"]]),
    _handleGetSettings: () => { calls++; },
  };

  (TycoonPanel.prototype as any)._handleSetAgentModel.call(fake, "testing-specialist", "sonnet");

  assert.equal(calls, 0, "a failed write must not trigger a settings refresh");
});
