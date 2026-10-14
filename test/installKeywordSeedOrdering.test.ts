/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Regression for the 0.0.599 bug report: on a brand-new project, right
// after Install, the Agents panel rendered every card's Keywords field as
// the empty "kw1|kw2|kw3" placeholder except the reviewer, and a window
// reload fixed it. Root cause: _handleInstallHooks used to call
// _ensureAgentKeywordsSeeded() (the auto-heal that fills agent-keywords.json
// from each `.claude/agents/*.md` file) BEFORE _installWorkerAgents wrote
// the worker roster's .md files to disk, so the seed pass saw an
// incomplete/empty agents dir and produced no entries for them. The
// reviewer agent was unaffected because _installAgentFiles sets its keyword
// pattern directly at install time, independent of the seed pass. Reopening
// the panel re-ran the constructor's own _ensureAgentKeywordsSeeded call,
// which finally saw the full roster and fixed it — hence "reload fixes it".
//
// Fix: the seed call now runs AFTER _installWorkerAgents/_installLeadAgents/
// _installReviewerAgent in _handleInstallHooks. This spec reproduces the
// exact prior ordering bug and proves the fixed ordering populates keywords
// for the whole worker roster in one pass, using the real production
// methods (same vscode-stub technique as test/panelAgentFileInstall.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "installKeywordSeedOrdering-"));
}

function writeHookSettings(root: string): void {
  const dir = path.join(root, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "settings.local.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "tycoon-claude-hook.cjs" }] }] } }, null, 2)
  );
}

// Minimal receiver exposing only the real bound methods the two auto-heal
// calls under test actually touch (verified pure fs/path, no other `this.*`
// beyond what's stubbed here) — same technique panelAgentFileInstall.test.ts
// uses to invoke production code without constructing a full TycoonPanel.
function makeFakeThis(root: string) {
  return {
    _projectRoot: () => root,
    _hooksInstalledForRoot: (TycoonPanel.prototype as any)._hooksInstalledForRoot,
    _settingsReferencesHook: (TycoonPanel.prototype as any)._settingsReferencesHook,
    _readKeywordsConfig: (TycoonPanel.prototype as any)._readKeywordsConfig,
    _installWorkerAgents: (TycoonPanel.prototype as any)._installWorkerAgents,
    _isUefnPackInstalled: (TycoonPanel.prototype as any)._isUefnPackInstalled,
  };
}

function agentKeywords(root: string, id: string): string {
  const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
  const cfg = JSON.parse(fs.readFileSync(keywordsPath, "utf8"));
  return cfg?.agents?.[id]?.pattern ?? "";
}

test("BUGGY ordering: seeding keywords before installing worker agent files leaves them without entries", () => {
  const root = tmpRoot();
  writeHookSettings(root);
  const fakeThis = makeFakeThis(root);

  // Reproduces the pre-fix call order: seed runs while .claude/agents/ is
  // still empty (no worker files exist yet).
  (TycoonPanel.prototype as any)._ensureAgentKeywordsSeeded.call(fakeThis);
  (fakeThis as any)._installWorkerAgents.call(fakeThis, root);

  const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
  const codingKw = fs.existsSync(keywordsPath) ? agentKeywords(root, "coding-specialist") : "";
  assert.equal(
    codingKw,
    "",
    "demonstrates the bug: seeding before file install produces no keyword entry for coding-specialist"
  );
});

test("FIXED ordering: seeding keywords after installing worker agent files populates the whole roster", () => {
  const root = tmpRoot();
  writeHookSettings(root);
  const fakeThis = makeFakeThis(root);

  // Mirrors the corrected _handleInstallHooks order: agent files exist on
  // disk before the seed pass runs.
  (fakeThis as any)._installWorkerAgents.call(fakeThis, root);
  (TycoonPanel.prototype as any)._ensureAgentKeywordsSeeded.call(fakeThis);

  for (const id of ["search-retrieval", "primary-agent", "coding-specialist", "testing-specialist", "ux-ui-designer"]) {
    const agentFile = path.join(root, ".claude", "agents", `${id}.md`);
    if (!fs.existsSync(agentFile)) continue; // e.g. UEFN-only exclusions
    assert.notEqual(
      agentKeywords(root, id),
      "",
      `${id} must have a non-empty keyword pattern once seeding runs after its file is installed`
    );
  }
});
