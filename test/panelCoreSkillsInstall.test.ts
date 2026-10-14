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

// Coverage for the tycoon-ready-test / tycoon-diagnose skills shipping by
// default (2026-09-06 decision): they must stage into `.claude/skills/<id>`
// via the SAME content-diff `_stageSkillTree` copy `project-plan` uses (see
// panel.ts `CORE_SKILL_IDS` / `_ensureCoreSkillsFresh` / `_handleInstallHooks`
// step "6c"), unconditionally — no opt-in flag, unlike project-plan.
//
// Same module-stubbing technique as test/panelProjectPlanSkillInstall.test.ts.
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

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "panelCoreSkillsInstall-"));
}

function stageSkillTree(
  skillId: string,
  root: string
): { staged: number; updated: number; unchanged: number; failed: { path: string; error: string }[] } {
  const fakeThis = { _extensionUri: { fsPath: REPO_ROOT } };
  return (TycoonPanel.prototype as any)._stageSkillTree.call(fakeThis, skillId, root);
}

test("CORE_SKILL_IDS names tycoon-ready-test and tycoon-diagnose", () => {
  const ids = (TycoonPanel as any).CORE_SKILL_IDS as readonly string[];
  assert.deepEqual([...ids].sort(), ["tycoon-diagnose", "tycoon-ready-test"]);
});

for (const skillId of ["tycoon-ready-test", "tycoon-diagnose"]) {
  test(`_stageSkillTree copies media/skills/${skillId} byte-identically into .claude/skills/${skillId}`, () => {
    const root = tmpRoot();
    try {
      const srcDir = path.join(REPO_ROOT, "media", "skills", skillId);
      const result = stageSkillTree(skillId, root);
      assert.deepEqual(result.failed, [], `clean stage of ${skillId} must report zero per-file failures`);
      assert.ok(result.staged > 0, `${skillId} should have staged at least one file`);

      const shippedFiles = fs.readdirSync(srcDir, { withFileTypes: true }).filter((e) => e.isFile());
      assert.ok(shippedFiles.length > 0, `sanity: media/skills/${skillId} must have at least one file`);

      const destDir = path.join(root, ".claude", "skills", skillId);
      for (const entry of shippedFiles) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        assert.ok(fs.existsSync(destPath), `${skillId}/${entry.name} must be copied`);
        assert.ok(
          fs.readFileSync(srcPath).equals(fs.readFileSync(destPath)),
          `${skillId}/${entry.name} content must match shipped source byte-for-byte`
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("_stageSkillTree refreshes a locally-modified core skill file back to shipped content", () => {
  const root = tmpRoot();
  try {
    stageSkillTree("tycoon-ready-test", root);
    const destPath = path.join(root, ".claude", "skills", "tycoon-ready-test", "SKILL.md");
    const shipped = fs.readFileSync(destPath);
    fs.writeFileSync(destPath, "LOCALLY MODIFIED CONTENT\n");
    const result = stageSkillTree("tycoon-ready-test", root);
    assert.equal(result.updated, 1, "modified file should be reported as updated");
    assert.ok(fs.readFileSync(destPath).equals(shipped), "modified dest file must be refreshed to shipped content");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tycoon-ready-test skill spawns agents under their own subagent_type and pings bridges", () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, "media", "skills", "tycoon-ready-test", "SKILL.md"), "utf8");
  assert.match(text, /subagent_type[^\n]*agent's name/);
  assert.match(text, /Never use `general-purpose` or `Explore` as a stand-in/);
  assert.match(text, /Bridge ping/);
  assert.match(text, /ONE route before calling/);
  assert.match(text, /no retry on another route/);
  assert.match(text, /make no tool calls and reply in one line/);
  assert.match(text, /X passed, W warnings, Y failed/);
  assert.match(text, /keyword routing/);
  assert.doesNotMatch(text, /## ## /);
  assert.match(text, /bridge not installed/);
  assert.match(text, /key or login missing/);
  assert.match(text, /answered by <vendor\/model>/);
  assert.match(text, /Claude Code harness/);
  assert.match(text, /Codex harness has no Task tool/);
  // .claude/ is gitignored (a developer-local copy); absent on CI checkouts.
  const devPath = path.join(REPO_ROOT, ".claude", "skills", "tycoon-ready-test", "SKILL.md");
  if (fs.existsSync(devPath)) assert.equal(fs.readFileSync(devPath, "utf8"), text, "repo .claude copy must match shipped copy");
});
