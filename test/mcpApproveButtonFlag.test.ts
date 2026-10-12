/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Same vscode-stub technique as test/panelUrcIgnore.test.ts: drive the REAL
// panel methods on a bare prototype instance.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("module");
const originalLoad = NodeModule._load;
let flagValue: unknown = undefined;
function makeVscodeStub(): any {
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === "__esModule") return true;
      if (!(prop in target)) target[prop] = new Proxy(function stub() {}, handler);
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

vscodeStub.workspace.getConfiguration = () => ({ get: (_k: string, d: unknown) => (flagValue === undefined ? d : flagValue) });

function fakePanel(root: string): { self: any; posted: any[] } {
  const posted: any[] = [];
  const proto: any = (TycoonPanel as any).prototype;
  const self: any = Object.create(proto);
  self._panel = { webview: { postMessage: (m: unknown) => { posted.push(m); return Promise.resolve(true); } } };
  self._projectRoot = () => root;
  self._handleGetSettings = () => {};
  self._extensionUri = { fsPath: process.cwd() };
  return { self, posted };
}

test("package.json declares tycoonagents.mcp.approveButton as a boolean defaulting to false", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const prop = pkg.contributes.configuration.properties["tycoonagents.mcp.approveButton"];
  assert.equal(prop.type, "boolean");
  assert.equal(prop.default, false);
  assert.equal(prop.description, "Experimental: show a button that approves TycoonAgents' own MCP servers for the current project.");
});

test("flag off (default): host rejects approve requests and sends no approval slice", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "approve-flag-"));
  try {
    flagValue = undefined;
    const { self, posted } = fakePanel(root);
    self._handleApproveTycoonMcp(["tycoon"], false);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].action, "approve");
    assert.equal(posted[0].ok, false);
    assert.match(posted[0].error, /turned off/);
    assert.equal(self._buildMcpApprovalSlice(root), undefined);
    assert.equal(fs.existsSync(path.join(root, ".claude", "settings.local.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("flag on: the approve request is processed by the approval core instead of the flag gate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "approve-flag-"));
  try {
    flagValue = true;
    const { self, posted } = fakePanel(root);
    self._resolveEffectiveHarness = () => "claude-code";
    self._handleApproveTycoonMcp(["tycoon"], false);
    assert.equal(posted[0].ok, false);
    assert.doesNotMatch(posted[0].error ?? "", /turned off/);
    flagValue = undefined;
  } finally {
    flagValue = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
