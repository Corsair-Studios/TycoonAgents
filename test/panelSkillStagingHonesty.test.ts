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

// Coverage for the foreign-machine install-hardening batch's staging-honesty
// fix: `_stageSkillTree` / `_installProjectPlanSkill` now return per-file
// `failed: {path, error}[]` (see panel.ts ~4825-4834, ~4915-4921) instead of
// collapsing a partial copy into a bare boolean, and
// `_ensureInstalledPacksFresh` (panel.ts ~6123-6146) only advances its
// top-level `pack-staging.json` version stamp when `failed.length === 0`
// across the whole run — so a genuinely failed copy is retried on the next
// panel open instead of being silently marked "done".
//
// Same module-stubbing technique as the sibling panel.ts test files (e.g.
// test/panelPackStampBridgeVerify.test.ts, test/panelMcpPathHeal.test.ts).
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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildAgentMarkdown } = require("../src/host/vscode/packCatalog") as typeof import("../src/host/vscode/packCatalog");

// Repo root — from the compiled test's location (out/test/*.test.js) this is
// two levels up, same derivation as test/panelProjectPlanSkillInstall.test.ts.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SKILL_SRC = path.join(REPO_ROOT, "media", "skills", "project-plan");

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

type FileFailure = { path: string; error: string };

// ---------------------------------------------------------------------------
// (b1) _stageSkillTree: a destination-file collision (dest path already
// exists as a DIRECTORY where a file is expected -- the "read-only/locked
// destination" case simulated per the task brief: pre-create the dest, then
// let the real copy attempt fail against it) must be surfaced as a non-empty
// `failed` entry naming that exact file, never a silent partial success.
// ---------------------------------------------------------------------------

function stageSkillTree(
  skillId: string,
  root: string,
  extensionRoot: string
): { staged: number; updated: number; unchanged: number; failed: FileFailure[] } {
  const fakeThis = { _extensionUri: { fsPath: extensionRoot } };
  return (TycoonPanel.prototype as any)._stageSkillTree.call(fakeThis, skillId, root);
}

test("_stageSkillTree reports a non-empty failed[] naming the file when the destination is a directory blocking the copy", () => {
  const extensionRoot = tmpDir("skillStagingHonesty-stage-ext-");
  const root = tmpDir("skillStagingHonesty-stage-root-");
  try {
    const skillId = "demoskill";
    const shippedDir = path.join(extensionRoot, "media", "skills", skillId);
    fs.mkdirSync(shippedDir, { recursive: true });
    fs.writeFileSync(path.join(shippedDir, "hello.txt"), "shipped content\n");

    // Collision: the destination file's own path already exists as a
    // DIRECTORY, so writing the actual file to it must fail.
    const destDir = path.join(root, ".claude", "skills", skillId);
    fs.mkdirSync(path.join(destDir, "hello.txt"), { recursive: true });

    const result = stageSkillTree(skillId, root, extensionRoot);

    assert.ok(result.failed.length > 0, "a blocked copy must be reported, not swallowed");
    const hit = result.failed.find((f) => f.path.includes("hello.txt"));
    assert.ok(hit, `failed[] must name the actual file (${JSON.stringify(result.failed)})`);
    assert.equal(typeof hit!.error, "string");
    assert.ok(hit!.error.length > 0, "error text must be non-empty (describeFsError-classified)");
    assert.equal(result.staged, 0, "the blocked file must never be counted as staged");
  } finally {
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (b2) _installProjectPlanSkill: same collision shape, against the REAL
// shipped project-plan skill source (mirrors test/panelProjectPlanSkillInstall.test.ts's
// convention of exercising the actual shipped files rather than a fixture).
// ---------------------------------------------------------------------------

function installProjectPlanSkill(root: string): { ok: boolean; failed: FileFailure[] } {
  const fakeThis = { _extensionUri: { fsPath: REPO_ROOT } };
  return (TycoonPanel.prototype as any)._installProjectPlanSkill.call(fakeThis, root);
}

test("_installProjectPlanSkill reports ok:false and a non-empty failed[] naming the file when SKILL.md's destination is a directory", () => {
  const root = tmpDir("skillStagingHonesty-ppskill-root-");
  try {
    const shippedFiles = fs.readdirSync(SKILL_SRC, { withFileTypes: true }).filter((e) => e.isFile());
    assert.ok(shippedFiles.some((e) => e.name === "SKILL.md"), "sanity: shipped project-plan skill must have SKILL.md");

    const destDir = path.join(root, ".claude", "skills", "project-plan");
    fs.mkdirSync(path.join(destDir, "SKILL.md"), { recursive: true }); // collision: directory where a file belongs

    const result = installProjectPlanSkill(root);

    assert.equal(result.ok, false, "a partial copy must never report ok:true");
    assert.ok(result.failed.length > 0);
    const hit = result.failed.find((f) => f.path.includes("SKILL.md"));
    assert.ok(hit, `failed[] must name SKILL.md specifically (${JSON.stringify(result.failed)})`);
    assert.ok(hit!.error.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (b3) _ensureInstalledPacksFresh: an injected failing skill copy must NOT
// advance the top-level pack-staging.json version stamp -- otherwise the
// gate at the top of the method (`stamp.version === currentVersion`) would
// short-circuit on the NEXT panel open and the failed file would never be
// retried (the exact field bug this batch fixes).
// ---------------------------------------------------------------------------

const BUNDLED_VERSION = "0.0.999";
const MARKER_AGENT = {
  id: "staging-honesty-marker",
  name: "Staging Honesty Marker",
  model: "sonnet",
  role: "Test-only marker agent for pack-staging honesty coverage.",
  keywords: "test",
};

function writeExtensionFixture(extensionRoot: string, skillId: string, stageSkillFiles: boolean): void {
  fs.writeFileSync(path.join(extensionRoot, "package.json"), JSON.stringify({ version: BUNDLED_VERSION }));
  const packsDir = path.join(extensionRoot, "media", "packs");
  fs.mkdirSync(packsDir, { recursive: true });
  fs.writeFileSync(
    path.join(packsDir, "catalog.json"),
    JSON.stringify([{ id: "brokenpack", agents: [MARKER_AGENT], skills: [skillId] }])
  );
  if (stageSkillFiles) {
    const skillDir = path.join(extensionRoot, "media", "skills", skillId);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "one.txt"), "shipped\n");
  }
  // Deliberately NOT writing media/skills/<skillId> when stageSkillFiles is
  // false -- _stageSkillTree's initial readdirSync(srcDir) then fails with
  // ENOENT, which is the "injected failing skill copy" fixture.
}

function writeProjectFixture(root: string): void {
  const agentPath = path.join(root, ".claude", "agents", `${MARKER_AGENT.id}.md`);
  fs.mkdirSync(path.dirname(agentPath), { recursive: true });
  fs.writeFileSync(agentPath, buildAgentMarkdown(MARKER_AGENT, "brokenpack"));
}

function ensurePacksFresh(root: string, extensionRoot: string): void {
  const fakeThis = {
    _extensionUri: { fsPath: extensionRoot },
    _projectRoot: () => root,
    _hooksInstalledForRoot: () => true,
    _currentExtensionVersion: (TycoonPanel.prototype as any)._currentExtensionVersion,
    _stageSkillTree: (TycoonPanel.prototype as any)._stageSkillTree,
    _installPackCommands: (TycoonPanel.prototype as any)._installPackCommands,
  };
  (TycoonPanel.prototype as any)._ensureInstalledPacksFresh.call(fakeThis);
}

function readStamp(root: string): { version?: string; packs?: Record<string, string> } {
  return JSON.parse(fs.readFileSync(path.join(root, ".claude", "tycoon", "pack-staging.json"), "utf8"));
}

test("_ensureInstalledPacksFresh does NOT advance the version stamp when a pack's skill copy fails", () => {
  const projectRoot = tmpDir("skillStagingHonesty-stamp-root-");
  const extensionRoot = tmpDir("skillStagingHonesty-stamp-ext-");
  try {
    writeExtensionFixture(extensionRoot, "brokenskill", /* stageSkillFiles */ false);
    writeProjectFixture(projectRoot);

    ensurePacksFresh(projectRoot, extensionRoot);

    const stamp = readStamp(projectRoot);
    assert.notEqual(stamp.version, BUNDLED_VERSION, "a run with a real per-file failure must never advance the gating version");
    assert.equal(stamp.version, undefined, "no prior stamp existed, so the version field must stay absent, not backfilled");
    assert.deepEqual(stamp.packs ?? {}, {}, "the failed pack must not be recorded as staged to the current version");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
});

test("_ensureInstalledPacksFresh retries and advances the stamp once the previously-failing skill is fixed", () => {
  const projectRoot = tmpDir("skillStagingHonesty-retry-root-");
  const extensionRoot = tmpDir("skillStagingHonesty-retry-ext-");
  try {
    writeExtensionFixture(extensionRoot, "fixableskill", /* stageSkillFiles */ false);
    writeProjectFixture(projectRoot);

    ensurePacksFresh(projectRoot, extensionRoot);
    assert.equal(readStamp(projectRoot).version, undefined, "sanity: first run must fail to stage and not advance");

    // Fix the "failing" shipped skill (simulates the file becoming
    // available -- e.g. a locked file freed up, or a real reinstall).
    const skillDir = path.join(extensionRoot, "media", "skills", "fixableskill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "one.txt"), "shipped\n");

    ensurePacksFresh(projectRoot, extensionRoot);

    const stamp = readStamp(projectRoot);
    assert.equal(stamp.version, BUNDLED_VERSION, "once the pack genuinely stages clean, the version stamp must advance");
    assert.equal(stamp.packs?.brokenpack, BUNDLED_VERSION);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
});
