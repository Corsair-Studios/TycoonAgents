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

// Same module-stubbing technique as test/panelProjectPlanSkillInstall.test.ts
// and test/panelAgentFileInstall.test.ts: panel.ts does
// `import * as vscode from "vscode"` at module scope, but the function under
// test here, `seedProjectPlanEnabledDefault` (panel.ts ~214-226), is pure fs
// (reads/writes .claude/tycoon/execution.json via the module-level
// `writeProjectPlanEnabled` helper) and never touches vscode at runtime.
// Stub the module loader so requiring panel.js resolves under plain
// `node --test`, and exercise the REAL exported production function.
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
const { seedProjectPlanEnabledDefault } = require("../src/host/vscode/panel") as typeof import("../src/host/vscode/panel");

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "seedProjectPlanEnabledDefault-"));
}

function executionConfigPath(root: string): string {
  return path.join(root, ".claude", "tycoon", "execution.json");
}

function readExecutionConfig(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(executionConfigPath(root), "utf8"));
}

function writeExecutionConfig(root: string, contents: Record<string, unknown>): void {
  const configPath = executionConfigPath(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(contents, null, 2));
}

test("seedProjectPlanEnabledDefault: no execution.json at all -> creates it with projectPlanEnabled true", () => {
  const root = tmpRoot();
  try {
    assert.ok(!fs.existsSync(executionConfigPath(root)), "sanity: no execution.json should exist yet");
    seedProjectPlanEnabledDefault(root);
    const config = readExecutionConfig(root);
    assert.equal(config.projectPlanEnabled, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seedProjectPlanEnabledDefault: execution.json exists without the projectPlanEnabled key -> defaults it to true, preserving other fields (no-clobber)", () => {
  const root = tmpRoot();
  try {
    writeExecutionConfig(root, { delegation_mode: "team", reviewEnabled: false });
    seedProjectPlanEnabledDefault(root);
    const config = readExecutionConfig(root);
    assert.equal(config.projectPlanEnabled, true);
    assert.equal(config.delegation_mode, "team", "delegation_mode must be preserved, not clobbered");
    assert.equal(config.reviewEnabled, false, "reviewEnabled must be preserved, not clobbered");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seedProjectPlanEnabledDefault: explicit projectPlanEnabled=false is preserved (an opt-out is never re-enabled), other fields intact", () => {
  const root = tmpRoot();
  try {
    writeExecutionConfig(root, { delegation_mode: "flat", reviewEnabled: true, projectPlanEnabled: false });
    seedProjectPlanEnabledDefault(root);
    const config = readExecutionConfig(root);
    assert.equal(config.projectPlanEnabled, false, "an explicit opt-out must stay false, not be re-enabled to true");
    assert.equal(config.delegation_mode, "flat");
    assert.equal(config.reviewEnabled, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seedProjectPlanEnabledDefault: explicit projectPlanEnabled=true is preserved, other fields intact", () => {
  const root = tmpRoot();
  try {
    writeExecutionConfig(root, { delegation_mode: "flat", reviewEnabled: true, projectPlanEnabled: true });
    seedProjectPlanEnabledDefault(root);
    const config = readExecutionConfig(root);
    assert.equal(config.projectPlanEnabled, true);
    assert.equal(config.delegation_mode, "flat");
    assert.equal(config.reviewEnabled, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
