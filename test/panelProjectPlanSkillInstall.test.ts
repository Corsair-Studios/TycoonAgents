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

// Same module-stubbing technique as test/panelAgentFileInstall.test.ts:
// panel.ts does `import * as vscode from "vscode"` at module scope, but
// `_installProjectPlanSkill` only ever touches `this._extensionUri.fsPath`
// (a plain string, never a real vscode.Uri method) plus pure fs/path calls —
// verified by reading the method (panel.ts ~3221-3268). Stub the module
// loader so requiring panel.js resolves under plain `node --test`, and
// exercise the REAL production method.
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

// Repo root — from the compiled test's location (out/test/*.test.js) this is
// two levels up. `media/` is excluded from tsc's outDir (see tsconfig.json
// "exclude"), so the shipped skill source only exists at this real path, not
// under out/.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SKILL_SRC = path.join(REPO_ROOT, "media", "skills", "project-plan");

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "panelProjectPlanSkillInstall-"));
}

// `_installProjectPlanSkill` only reads `this._extensionUri.fsPath` (a plain
// string used with path.join — never a real vscode.Uri method), so a minimal
// receiver carrying just that field is enough to invoke the real method
// under test without constructing a full TycoonPanel.
// `_installProjectPlanSkill` now returns `{ ok, failed }` (per-file failures
// surfaced explicitly, see its doc comment) rather than a bare boolean.
type InstallResult = { ok: boolean; failed: { path: string; error: string }[] };

function callInstallProjectPlanSkill(root: string): InstallResult {
  const fakeThis = {
    _extensionUri: { fsPath: REPO_ROOT },
  };
  return (TycoonPanel.prototype as any)._installProjectPlanSkill.call(fakeThis, root);
}

function destDir(root: string): string {
  return path.join(root, ".claude", "skills", "project-plan");
}

test("_installProjectPlanSkill copies the shipped skill files into .claude/skills/project-plan", () => {
  const root = tmpRoot();
  try {
    const result = callInstallProjectPlanSkill(root);
    assert.equal(result.ok, true, "should report success");
    assert.deepEqual(result.failed, [], "a clean install must report zero per-file failures");

    const shippedFiles = fs.readdirSync(SKILL_SRC, { withFileTypes: true }).filter((e) => e.isFile());
    assert.ok(shippedFiles.length > 0, "sanity: shipped skill source must have at least one file");

    for (const entry of shippedFiles) {
      const srcPath = path.join(SKILL_SRC, entry.name);
      const destPath = path.join(destDir(root), entry.name);
      assert.ok(fs.existsSync(destPath), `${entry.name} must be copied`);
      assert.equal(
        fs.readFileSync(destPath, "utf8"),
        fs.readFileSync(srcPath, "utf8"),
        `${entry.name} content must match shipped source`
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_installProjectPlanSkill is idempotent and refreshes a modified dest file back to shipped content", () => {
  const root = tmpRoot();
  try {
    const firstResult = callInstallProjectPlanSkill(root);
    assert.equal(firstResult.ok, true);
    assert.deepEqual(firstResult.failed, []);

    const skillMdDest = path.join(destDir(root), "SKILL.md");
    const shipped = fs.readFileSync(path.join(SKILL_SRC, "SKILL.md"), "utf8");
    assert.equal(fs.readFileSync(skillMdDest, "utf8"), shipped);

    // Calling again with already-current content must not throw and must
    // leave content matching shipped (idempotent).
    assert.doesNotThrow(() => callInstallProjectPlanSkill(root));
    assert.equal(fs.readFileSync(skillMdDest, "utf8"), shipped);

    // Simulate local drift, then confirm a re-call refreshes it — this
    // directory is 100% ours (no ownership/tier check, unlike agent .md
    // files), so any content difference is corrected unconditionally.
    fs.writeFileSync(skillMdDest, "LOCALLY MODIFIED CONTENT\n");
    callInstallProjectPlanSkill(root);
    assert.equal(fs.readFileSync(skillMdDest, "utf8"), shipped, "modified dest file must be refreshed to shipped content");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Project Plan is default ON: the panel-open auto-heal must restore a missing
// or damaged skill without any user action (this is why the "Reinstall /
// Repair skill" button was removed).
function callEnsureFresh(root: string, hooksInstalled: boolean): void {
  const fakeThis = {
    _extensionUri: { fsPath: REPO_ROOT },
    _projectRoot: () => root,
    _hooksInstalledForRoot: () => hooksInstalled,
    _installProjectPlanSkill: (r: string) => callInstallProjectPlanSkill(r),
  };
  (TycoonPanel.prototype as any)._ensureProjectPlanSkillFresh.call(fakeThis);
}

function writeExec(root: string, body: unknown): void {
  const dir = path.join(root, ".claude", "tycoon");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "execution.json"), JSON.stringify(body));
}

test("auto-heal (default ON, flag never set, hooks installed): installs a missing skill and restores a truncated SKILL.md", () => {
  const root = tmpRoot();
  try {
    callEnsureFresh(root, true);
    const skillMd = path.join(destDir(root), "SKILL.md");
    const shipped = fs.readFileSync(path.join(SKILL_SRC, "SKILL.md"), "utf8");
    assert.equal(fs.readFileSync(skillMd, "utf8"), shipped, "missing skill installed");
    fs.writeFileSync(skillMd, shipped.slice(0, 10));
    callEnsureFresh(root, true);
    assert.equal(fs.readFileSync(skillMd, "utf8"), shipped, "truncated SKILL.md restored with no repair button");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-heal: an explicit projectPlanEnabled:false is respected (nothing installed)", () => {
  const root = tmpRoot();
  try {
    writeExec(root, { projectPlanEnabled: false });
    callEnsureFresh(root, true);
    assert.equal(fs.existsSync(destDir(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-heal: flag never set and no hooks installed leaves the project untouched; explicit true still installs", () => {
  const root = tmpRoot();
  try {
    callEnsureFresh(root, false);
    assert.equal(fs.existsSync(destDir(root)), false);
    writeExec(root, { projectPlanEnabled: true });
    callEnsureFresh(root, false);
    assert.equal(fs.existsSync(path.join(destDir(root), "SKILL.md")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
