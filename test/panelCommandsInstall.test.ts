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

// Same module-stubbing technique as test/panelAgentFileInstall.test.ts and
// test/panelProjectPlanSkillInstall.test.ts: panel.ts does
// `import * as vscode from "vscode"` at module scope, but `_installPackCommands`
// only ever touches `this._extensionUri.fsPath` (a plain string) plus pure
// fs/path calls — verified by reading the method (panel.ts, just above
// `_handleInstallPack`). Stub the module loader so requiring panel.js resolves
// under plain `node --test`, and exercise the REAL production method.
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
// "exclude"), so the shipped command source only exists at this real path,
// not under out/.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const COMMAND_SRC = path.join(REPO_ROOT, "media", "commands", "uefn-moderation-scan.md");

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "panelCommandsInstall-"));
}

// `_installPackCommands` only reads `this._extensionUri.fsPath` (a plain
// string used with path.join), so a minimal receiver carrying just that field
// is enough to invoke the real method under test without constructing a full
// TycoonPanel.
function callInstallPackCommands(
  root: string,
  commandIds: string[]
): Array<{ id: string; status: "installed" | "updated" | "unchanged" | "error"; error?: string }> {
  const fakeThis = {
    _extensionUri: { fsPath: REPO_ROOT },
  };
  return (TycoonPanel.prototype as any)._installPackCommands.call(fakeThis, root, commandIds);
}

function commandsDir(root: string): string {
  return path.join(root, ".claude", "commands");
}

test("sanity: media/commands/uefn-moderation-scan.md exists and ships real content", () => {
  assert.ok(fs.existsSync(COMMAND_SRC), "shipped command source must exist");
  const content = fs.readFileSync(COMMAND_SRC, "utf8");
  assert.ok(content.length > 0, "shipped command file must not be empty");
  assert.ok(content.includes("uefn_moderation_scan"), "must reference the uefn_moderation_scan MCP tool");
  assert.ok(content.includes("uefn_moderation_report"), "must reference the uefn_moderation_report MCP tool");
});

test("_installPackCommands creates .claude/commands/uefn-moderation-scan.md with content matching the shipped source", () => {
  const root = tmpRoot();
  try {
    const results = callInstallPackCommands(root, ["uefn-moderation-scan"]);
    assert.deepEqual(results, [{ id: "uefn-moderation-scan", status: "installed" }]);

    const dest = path.join(commandsDir(root), "uefn-moderation-scan.md");
    assert.ok(fs.existsSync(dest), "command file must be created");
    assert.equal(
      fs.readFileSync(dest, "utf8"),
      fs.readFileSync(COMMAND_SRC, "utf8"),
      "installed content must match shipped source byte-for-byte"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_installPackCommands is idempotent — a second run with unchanged content is a no-op, and content that has drifted from the shipped source is refreshed forward (content-diff, mirroring _stageSkillTree/_stageBridgeTo)", () => {
  const root = tmpRoot();
  try {
    assert.deepEqual(callInstallPackCommands(root, ["uefn-moderation-scan"]), [
      { id: "uefn-moderation-scan", status: "installed" },
    ]);

    const dest = path.join(commandsDir(root), "uefn-moderation-scan.md");
    const shipped = fs.readFileSync(dest, "utf8");

    // A second run with byte-identical content is a true no-op.
    assert.deepEqual(callInstallPackCommands(root, ["uefn-moderation-scan"]), [
      { id: "uefn-moderation-scan", status: "unchanged" },
    ]);

    // Simulate the destination drifting from the shipped source — either a
    // stale copy from an older release, or a local edit. Per this
    // codebase's established convention for pack-owned content
    // (_ensureHookScriptFresh, _installProjectPlanSkill, _stageBridgeTo:
    // "differs from bundled = staleness to refresh forward"), a content
    // mismatch is corrected, not silently preserved — the old skip-if-exists
    // behavior was the bug (an extension update could never re-stage a
    // pack's commands into an already-installed project).
    fs.writeFileSync(dest, "LOCALLY MODIFIED CONTENT\n");

    const second = callInstallPackCommands(root, ["uefn-moderation-scan"]);
    assert.deepEqual(second, [{ id: "uefn-moderation-scan", status: "updated" }]);
    assert.equal(
      fs.readFileSync(dest, "utf8"),
      shipped,
      "a drifted command file must be refreshed forward to match the shipped source"
    );

    // A third call (now byte-identical again) is back to a no-op status.
    assert.deepEqual(callInstallPackCommands(root, ["uefn-moderation-scan"]), [
      { id: "uefn-moderation-scan", status: "unchanged" },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_installPackCommands with an empty commands array creates no .claude/commands/ directory (a pack without `commands` installs fine)", () => {
  const root = tmpRoot();
  try {
    const results = callInstallPackCommands(root, []);
    assert.deepEqual(results, [], "no ids means no results");
    assert.equal(fs.existsSync(commandsDir(root)), false, ".claude/commands must not be created when a pack ships no commands");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_installPackCommands reports status 'error' (not a thrown exception) for an id with no shipped source file, without touching sibling ids", () => {
  const root = tmpRoot();
  try {
    const results = callInstallPackCommands(root, ["uefn-moderation-scan", "does-not-exist"]);
    assert.equal(results.length, 2);
    assert.equal(results[0].status, "installed");
    assert.equal(results[1].id, "does-not-exist");
    assert.equal(results[1].status, "error");
    assert.ok(typeof results[1].error === "string" && results[1].error.length > 0, "error id must carry an error message");

    // The valid sibling id must still have been installed despite the other failing.
    assert.ok(fs.existsSync(path.join(commandsDir(root), "uefn-moderation-scan.md")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
