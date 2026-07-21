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

// `_resolveReviewAgentId` is a private TycoonPanel method, but (like
// `_installAgentFiles` in test/panelAgentFileInstall.test.ts) it only touches
// `loadAgentRoster` — pure fs/path, no other `this.*` access and no vscode
// API. Stub the module loader so requiring panel.js resolves under plain
// `node --test`, and exercise the REAL production method rather than a
// reimplementation of it (same technique test/panelAgentFileInstall.test.ts
// and test/reviewSynthesis.test.ts already use).
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "panelReviewAgentId-"));
}

function callResolveReviewAgentId(root: string): string | undefined {
  const fakeThis = {};
  return (TycoonPanel.prototype as any)._resolveReviewAgentId.call(fakeThis, root);
}

function writeAgentFile(root: string, id: string): void {
  const agentsDir = path.join(root, ".claude", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, `${id}.md`), `---\nmodel: sonnet\n---\n\n# ${id}\n`);
}

test("_resolveReviewAgentId returns 'reviewer' when reviewer.md is installed", () => {
  const root = tmpRoot();
  try {
    writeAgentFile(root, "reviewer");
    writeAgentFile(root, "coding-specialist");
    assert.equal(callResolveReviewAgentId(root), "reviewer");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_resolveReviewAgentId returns 'uefn-auditor' when only uefn-auditor.md is installed (UEFN project)", () => {
  const root = tmpRoot();
  try {
    writeAgentFile(root, "uefn-auditor");
    writeAgentFile(root, "verse-expert");
    assert.equal(callResolveReviewAgentId(root), "uefn-auditor");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_resolveReviewAgentId prefers 'reviewer' over 'uefn-auditor' when both files somehow exist", () => {
  const root = tmpRoot();
  try {
    writeAgentFile(root, "reviewer");
    writeAgentFile(root, "uefn-auditor");
    assert.equal(callResolveReviewAgentId(root), "reviewer");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_resolveReviewAgentId returns undefined when neither reviewer nor uefn-auditor is installed", () => {
  const root = tmpRoot();
  try {
    writeAgentFile(root, "coding-specialist");
    writeAgentFile(root, "search-retrieval");
    assert.equal(callResolveReviewAgentId(root), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_resolveReviewAgentId returns undefined when the agents directory doesn't exist", () => {
  const root = tmpRoot();
  try {
    assert.equal(callResolveReviewAgentId(root), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
