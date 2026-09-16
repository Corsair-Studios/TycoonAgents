/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for p61-t2 (test half): commit caa1e71 added step "7a3" inside
// `_handleInstallHooks` (panel.ts ~6305-6330, gate at ~6398 via
// `_ensureProjectPlanSkillFresh`) — when `readProjectPlanEnabled(root)` is
// true after `seedProjectPlanEnabledDefault(root)`, a fresh install/repair
// now calls `_installProjectPlanSkill(root)` and
// `_stageSkillTree("design-doc", root)` in the SAME pass, instead of
// waiting for the next panel-open auto-heal.
//
// COVERAGE LIMIT: `_handleInstallHooks` itself is NOT reachable from this
// (or any existing) harness. It calls `vscode.Uri.joinPath(...).fsPath`
// and `this._panel.webview.postMessage(...)` before step 7a3 ever runs; the
// module-stubbing technique used here and in the sibling test files (see
// test/panelProjectPlanSkillInstall.test.ts, test/panelSkillStagingHonesty.test.ts)
// makes `vscode` a Proxy whose `.fsPath` is itself a function-Proxy, not a
// string, so `path.join`/`fs.existsSync` against it throws before reaching
// the project-plan gating logic. Per the task brief, this file instead
// drives the next-outermost reachable functions the fix is built from:
// `seedProjectPlanEnabledDefault` (exported, panel.ts ~386) for the
// on-by-default / preserve-explicit-choice gate, and the same
// `_installProjectPlanSkill` / `_stageSkillTree` prototype methods step 7a3
// calls (same invocation pattern as the harnesses above), composed the same
// way step 7a3 composes them. The `if (readProjectPlanEnabled(root))`
// branch itself inside `_handleInstallHooks` is therefore exercised here
// only by replicating its (private, one-line) condition against the same
// execution.json the production code reads — not by executing that literal
// line of panel.ts.

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
const { TycoonPanel, seedProjectPlanEnabledDefault } =
  require("../src/host/vscode/panel") as typeof import("../src/host/vscode/panel");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "panelInstallHooksProjectPlanGating-"));
}

function execConfigPath(root: string): string {
  return path.join(root, ".claude", "tycoon", "execution.json");
}

// Mirrors panel.ts's private `readProjectPlanEnabled` (panel.ts ~233) —
// not exported, so replicated verbatim here (single ternary-free read).
function readProjectPlanEnabled(root: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(execConfigPath(root), "utf8"));
    return parsed !== null && typeof parsed === "object" && parsed.projectPlanEnabled === true;
  } catch {
    return false;
  }
}

function installProjectPlanSkill(root: string): { ok: boolean; failed: { path: string; error: string }[] } {
  const fakeThis = { _extensionUri: { fsPath: REPO_ROOT } };
  return (TycoonPanel.prototype as any)._installProjectPlanSkill.call(fakeThis, root);
}

function stageSkillTree(
  skillId: string,
  root: string
): { staged: number; updated: number; unchanged: number; failed: { path: string; error: string }[] } {
  const fakeThis = { _extensionUri: { fsPath: REPO_ROOT } };
  return (TycoonPanel.prototype as any)._stageSkillTree.call(fakeThis, skillId, root);
}

// Same composition as _handleInstallHooks step 7a3.
function runStep7a3(root: string): void {
  seedProjectPlanEnabledDefault(root);
  if (readProjectPlanEnabled(root)) {
    installProjectPlanSkill(root);
    stageSkillTree("design-doc", root);
  }
}

test("fresh install (default-on) seeds project-plan AND design-doc skills in the same pass", () => {
  const root = tmpRoot();
  try {
    runStep7a3(root);

    assert.equal(readProjectPlanEnabled(root), true, "Project Plan defaults to enabled on a fresh install");

    const ppSkill = path.join(root, ".claude", "skills", "project-plan", "SKILL.md");
    const ddSkill = path.join(root, ".claude", "skills", "design-doc", "SKILL.md");
    assert.ok(fs.existsSync(ppSkill), "project-plan/SKILL.md must be seeded");
    assert.ok(fs.existsSync(ddSkill), "design-doc/SKILL.md must be seeded");

    const templatesDir = path.join(root, ".claude", "skills", "design-doc", "templates");
    const shippedTemplates = fs
      .readdirSync(path.join(REPO_ROOT, "media", "skills", "design-doc", "templates"))
      .filter((f) => f.endsWith(".md"));
    assert.ok(shippedTemplates.length > 0, "sanity: shipped design-doc must have template .md files");
    for (const f of shippedTemplates) {
      assert.ok(fs.existsSync(path.join(templatesDir, f)), `design-doc/templates/${f} must be seeded`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("projectPlanEnabled pre-set false in execution.json seeds neither skill", () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.dirname(execConfigPath(root)), { recursive: true });
    fs.writeFileSync(execConfigPath(root), JSON.stringify({ projectPlanEnabled: false }));

    runStep7a3(root);

    assert.equal(readProjectPlanEnabled(root), false, "explicit prior false must be preserved by the seed");
    assert.equal(fs.existsSync(path.join(root, ".claude", "skills", "project-plan")), false);
    assert.equal(fs.existsSync(path.join(root, ".claude", "skills", "design-doc")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a project-plan SKILL.md already matching shipped content is left byte-identical (content-diff no-op)", () => {
  const root = tmpRoot();
  try {
    const shipped = fs.readFileSync(
      path.join(REPO_ROOT, "media", "skills", "project-plan", "SKILL.md"),
      "utf8"
    );
    const destDir = path.join(root, ".claude", "skills", "project-plan");
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, "SKILL.md");
    fs.writeFileSync(destPath, shipped);
    const statBefore = fs.statSync(destPath);

    runStep7a3(root);

    assert.equal(fs.readFileSync(destPath, "utf8"), shipped, "already-current SKILL.md must stay byte-identical");
    const statAfter = fs.statSync(destPath);
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs, "content-diff must skip the write entirely when unchanged");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
