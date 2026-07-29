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

// panel.ts does `import * as vscode from "vscode"` at module scope. Stub the
// module loader (same technique as test/panelAgentFileInstall.test.ts) so
// this file's require of panel.js resolves under plain `node --test`, and we
// exercise the REAL production `_handleAddGitignoreEntries` /
// `_appendIgnoreEntries` methods rather than a reimplementation of them.
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

// `_uefnEffectiveRoot`'s evidence ladder (rung 1) reads real
// `%LOCALAPPDATA%\UnrealEditorFortnite\Saved\VerseProject` by default —
// point it at an empty scratch dir for the whole file so these tests never
// depend on whatever UEFN project data happens to exist on the machine
// running them (see CLAUDE.md's Path & Environment Discovery: fixtures
// build their own temp trees, never real machine state).
process.env.UEFN_VERSE_PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "panelUrcIgnore-noverseproject-"));

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "panelUrcIgnore-"));
}

// Give the tmp root a UEFN signal (`detectUefnProject` looks for a
// `*.uproject`/`*.uefnproject` file at the root) so
// `_handleAddGitignoreEntries`'s UEFN branch fires.
function markAsUefnProject(root: string): void {
  fs.writeFileSync(path.join(root, "project.uproject"), "{}");
}

// Give the tmp root a git signal (`detectIgnoreTargets` looks for a `.git`
// dir, or an existing `.gitignore`, at the plain project root) so the
// `.gitignore` target fires without a UEFN marker present.
function markAsGitProject(root: string): void {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
}

// `_handleAddGitignoreEntries` calls `this._projectRoot()`,
// `this._appendIgnoreEntries(...)`, and `this._uefnEffectiveRoot(...)` (plus
// the globally-stubbed `vscode.window.showInformationMessage`).
// `_uefnEffectiveRoot` in turn delegates to `_resolveUefnContentDirEvidence`
// (the evidence ladder: matching .vproject Source dirPath, then an existing
// Python/init_unreal.py, then documented layout rules), which calls
// `_findMatchingVprojectContentDirs`, `_plausibleContentDirCandidates`, and
// `_canonPath` — all of these need to be present on the receiver for the
// real call chain to run rather than throw. None of these tmp roots are
// named "Content" and none have a nearby `.vproject`/layout match, so the
// evidence ladder is a no-op passthrough here (effRoot === root) — the
// ladder's own redirect behavior is covered by
// test/panelBridgeStaleness.test.ts.
function callAddGitignoreEntries(root: string): void {
  const fakeThis = {
    _projectRoot: () => root,
    _appendIgnoreEntries: (TycoonPanel.prototype as any)._appendIgnoreEntries,
    _uefnEffectiveRoot: (TycoonPanel.prototype as any)._uefnEffectiveRoot,
    _resolveUefnContentDirEvidence: (TycoonPanel.prototype as any)._resolveUefnContentDirEvidence,
    _findMatchingVprojectContentDirs: (TycoonPanel.prototype as any)._findMatchingVprojectContentDirs,
    _plausibleContentDirCandidates: (TycoonPanel.prototype as any)._plausibleContentDirCandidates,
    _confirmedContentDirItself: (TycoonPanel.prototype as any)._confirmedContentDirItself,
    _canonPath: (TycoonPanel.prototype as any)._canonPath,
  };
  (TycoonPanel.prototype as any)._handleAddGitignoreEntries.call(fakeThis);
}

test("_handleAddGitignoreEntries creates .urcignore for a UEFN project with the comprehensive artifact list", () => {
  const root = tmpRoot();
  try {
    markAsUefnProject(root);
    callAddGitignoreEntries(root);

    const urcPath = path.join(root, ".urcignore");
    assert.ok(fs.existsSync(urcPath), ".urcignore must be created");
    const urc = fs.readFileSync(urcPath, "utf8");
    for (const entry of [
      ".claude/",
      "CLAUDE.md",
      ".mcp.json",
      "*.cjs",
      ".agents/",
      ".codex/",
      "AGENTS.md",
      "*.json",
      "*.md",
      "*.jsonl",
      "*.mjs",
      "*.py",
      "Content/Python/",
      "Python/",
    ]) {
      assert.ok(urc.includes(entry), `.urcignore must contain "${entry}"`);
    }
    // Content/-anchored duplicate (URC honors only the root .urcignore, but
    // UEFN nests a second project root under Content/).
    assert.ok(urc.includes("Content/.claude/"), ".urcignore must contain the Content/-anchored duplicate");

    // .p4ignore gets the same comprehensive list (URC-via-Perforce parity).
    const p4Path = path.join(root, ".p4ignore");
    const p4 = fs.readFileSync(p4Path, "utf8");
    for (const entry of [
      ".claude/",
      "CLAUDE.md",
      ".mcp.json",
      "*.cjs",
      "AGENTS.md",
      "*.json",
      "*.md",
      "*.jsonl",
      "*.mjs",
      "*.py",
      "Content/Python/",
      "Python/",
    ]) {
      assert.ok(p4.includes(entry), `.p4ignore must contain "${entry}"`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Contract (see `detectIgnoreTargets` in panel.ts): targets are
// evidence-detected only — a `.git` dir (or existing `.gitignore`) for
// `.gitignore`, an existing Perforce marker or a detected UEFN project for
// `.p4ignore`, an existing `.urcignore` or a detected UEFN project for
// `.urcignore`. No evidence for a given target means that file is never
// written, and a project with NO evidence for any of the three gets no
// writes at all — never a guessed VCS.

test("_handleAddGitignoreEntries writes only .gitignore (minimal list) for a git-only, non-UEFN project", () => {
  const root = tmpRoot();
  try {
    markAsGitProject(root);
    callAddGitignoreEntries(root);

    assert.ok(!fs.existsSync(path.join(root, ".urcignore")), "git-only, non-UEFN project must not get a .urcignore");
    assert.ok(!fs.existsSync(path.join(root, ".p4ignore")), "git-only, non-UEFN project must not get a .p4ignore");

    const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    assert.ok(gitignore.includes(".claude/tycoon/"));
    assert.ok(!gitignore.includes("CLAUDE.md"), "non-UEFN .gitignore must keep its minimal list, not the UEFN one");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_handleAddGitignoreEntries writes nothing for a project with no git, no UEFN, and no existing ignore/marker files", () => {
  const root = tmpRoot();
  try {
    callAddGitignoreEntries(root);

    assert.ok(!fs.existsSync(path.join(root, ".gitignore")), "must never guess .gitignore with zero evidence");
    assert.ok(!fs.existsSync(path.join(root, ".urcignore")), "must never guess .urcignore with zero evidence");
    assert.ok(!fs.existsSync(path.join(root, ".p4ignore")), "must never guess .p4ignore with zero evidence");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_handleAddGitignoreEntries is idempotent — a second run does not duplicate .urcignore/.p4ignore lines", () => {
  const root = tmpRoot();
  try {
    markAsUefnProject(root);
    callAddGitignoreEntries(root);
    callAddGitignoreEntries(root);

    for (const file of [".urcignore", ".p4ignore"]) {
      const contents = fs.readFileSync(path.join(root, file), "utf8");
      const claudeLines = contents.split(/\r?\n/).filter((l) => l.trim() === ".claude/");
      assert.equal(claudeLines.length, 1, `${file} must not duplicate the ".claude/" line on a second run`);
      const claudeMdLines = contents.split(/\r?\n/).filter((l) => l.trim() === "CLAUDE.md");
      assert.equal(claudeMdLines.length, 1, `${file} must not duplicate the "CLAUDE.md" line on a second run`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
