/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// panel.ts does `import * as vscode from "vscode"` at module scope. Stub the
// module loader (same technique as test/panelUrcIgnore.test.ts) so this
// file's require of panel.js resolves under plain `node --test`. Unlike that
// file's fully-generic stub, `vscode.Uri.joinPath` and `vscode.env.openExternal`
// need REAL (not proxy-stub) behavior here so the test can assert on the
// resolved URI and capture the open call.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("module");
const originalLoad = NodeModule._load;

const openExternalCalls: string[] = [];

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
  const target: Record<string, unknown> = {
    Uri: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      joinPath(base: any, ...segments: string[]) {
        const fsPath = [base?.fsPath ?? "", ...segments].join("/");
        return { fsPath, scheme: "file", toString: () => `file://${fsPath}` };
      },
    },
    env: {
      openExternal(uri: { fsPath?: string; toString(): string }) {
        openExternalCalls.push(uri?.fsPath ?? String(uri));
        return Promise.resolve(true);
      },
    },
  };
  return new Proxy(target, handler);
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TycoonPanel } = require("../src/host/vscode/panel") as typeof import("../src/host/vscode/panel");

test("_handleOpenHandbook opens the shipped handbook via vscode.env.openExternal", async () => {
  openExternalCalls.length = 0;
  const fakeThis = { _extensionUri: { fsPath: "/fake/ext/root" } };
  await (TycoonPanel.prototype as any)._handleOpenHandbook.call(fakeThis);

  assert.equal(openExternalCalls.length, 1, "openExternal must be called exactly once");
  const opened = openExternalCalls[0].replace(/\\/g, "/");
  assert.ok(
    opened.endsWith("media/handbook/index.html"),
    `opened URI should end with media/handbook/index.html, got: ${opened}`,
  );
  assert.ok(opened.startsWith("/fake/ext/root"), `opened URI should be rooted at the extension URI, got: ${opened}`);
});
