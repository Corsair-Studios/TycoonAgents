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
// module loader (same technique as test/panelUrcIgnore.test.ts) so this
// file's require of panel.js resolves under plain `node --test`, and we
// exercise the REAL production `_stageUefnBridgeAllTargets` /
// `_resolveUefnContentDirEvidence` / `_healDuplicateUefnBridgeStaging`
// methods rather than reimplementations of them.
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

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVproject(vprojectPath: string, sourceDir: string, name: string): void {
  fs.mkdirSync(path.dirname(vprojectPath), { recursive: true });
  fs.writeFileSync(
    vprojectPath,
    JSON.stringify({
      packages: [
        { desc: { name, dirPath: sourceDir, settings: { role: "Source" } } },
        { desc: { name: "SomeExternalPkg", settings: { role: "External" } } },
      ],
    })
  );
}

function writeShippedBridge(bridgeDir: string, versionStamp: string): void {
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, "uefn_bridge.py"), "# uefn_bridge (shipped)");
  fs.writeFileSync(path.join(bridgeDir, "init_unreal.py"), "# init_unreal (shipped)");
  fs.writeFileSync(path.join(bridgeDir, "bridge_version.py"), `BRIDGE_VERSION = "${versionStamp}"\n`);
  fs.writeFileSync(path.join(bridgeDir, "trashbyrd_40x40.png"), "fake-png-bytes");
  // Must never be staged into Content/Python -- Node MCP server only.
  fs.writeFileSync(path.join(bridgeDir, "uefn-server.mjs"), "// node mcp server, never staged");
}

function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      const full = path.join(dir, e);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (fs.statSync(full).isDirectory()) {
        out.push(`${rel}/`);
        walk(full);
      } else {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out;
}

// `_stageUefnBridgeAllTargets` calls a cluster of real prototype methods
// (the evidence ladder + staging + auto-heal) plus two engine-discovery
// methods that, in production, scan the real machine for a Fortnite/Epic
// install -- stubbed here to keep every fixture fully isolated from
// whatever happens to be installed on the machine running the tests (see
// CLAUDE.md's Path & Environment Discovery: never assume machine state).
function stage(root: string, extensionRoot: string) {
  const fakeThis = {
    _extensionUri: { fsPath: extensionRoot },
    _resolveUefnContentDirEvidence: (TycoonPanel.prototype as any)._resolveUefnContentDirEvidence,
    _findMatchingVprojectContentDirs: (TycoonPanel.prototype as any)._findMatchingVprojectContentDirs,
    _plausibleContentDirCandidates: (TycoonPanel.prototype as any)._plausibleContentDirCandidates,
    _confirmedContentDirItself: (TycoonPanel.prototype as any)._confirmedContentDirItself,
    _canonPath: (TycoonPanel.prototype as any)._canonPath,
    _stageBridgeTo: (TycoonPanel.prototype as any)._stageBridgeTo,
    _healDuplicateUefnBridgeStaging: (TycoonPanel.prototype as any)._healDuplicateUefnBridgeStaging,
    // No real Fortnite engine install in any of these fixtures.
    _findFortnitePythonDirs: () => [] as string[],
    _findFortniteEngineBridgeDir: () => null as string | null,
    _refreshEngineBridgeCopy: () => {
      throw new Error("must not be called -- _findFortniteEngineBridgeDir returned null in every fixture here");
    },
  };
  return (TycoonPanel.prototype as any)._stageUefnBridgeAllTargets.call(fakeThis, root);
}

// ---------------------------------------------------------------------------
// The field failure: Plugins-layout project, workspace opened AT the
// plugin's Content dir, a stale Python/ already there, and a bogus nested
// Content/Content/Python left behind by an earlier buggy install.
// ---------------------------------------------------------------------------

test("Plugins-layout field failure: vproject evidence resolves the REAL Python dir, refreshes the stale bridge, and cleans up the misplaced Content/Content copy", () => {
  const projectRoot = tmpDir("panelUefnStaging-plugins-");
  const verseProjectRoot = tmpDir("panelUefnStaging-plugins-vproj-");
  const extensionRoot = tmpDir("panelUefnStaging-plugins-ext-");
  const savedOverride = process.env.UEFN_VERSE_PROJECT_DIR;
  try {
    // "<...>\MyIsland_\Plugins\PluginA\Content\" -- the real content
    // dir, confirmed by the vproject's Source dirPath below.
    const realContentDir = path.join(projectRoot, "Plugins", "PluginA", "Content");
    fs.mkdirSync(realContentDir, { recursive: true });

    // Stale June bridge already staged directly in the real content dir.
    const stalePythonDir = path.join(realContentDir, "Python");
    fs.mkdirSync(stalePythonDir, { recursive: true });
    fs.writeFileSync(path.join(stalePythonDir, "uefn_bridge.py"), "# STALE June bridge");
    fs.writeFileSync(path.join(stalePythonDir, "init_unreal.py"), "# STALE June init_unreal");
    fs.writeFileSync(path.join(stalePythonDir, "bridge_version.py"), 'BRIDGE_VERSION = "1.0.0"\n');

    // The bug's fabricated nested copy: realContentDir/Content/Python,
    // carrying OUR bridge's filenames (what the buggy fresh install wrote).
    const bogusNestedPythonDir = path.join(realContentDir, "Content", "Python");
    fs.mkdirSync(bogusNestedPythonDir, { recursive: true });
    fs.writeFileSync(path.join(bogusNestedPythonDir, "uefn_bridge.py"), "# bogus nested copy");
    fs.writeFileSync(path.join(bogusNestedPythonDir, "init_unreal.py"), "# bogus nested copy");
    fs.writeFileSync(path.join(bogusNestedPythonDir, "bridge_version.py"), 'BRIDGE_VERSION = "2.0.0"\n');
    fs.writeFileSync(path.join(bogusNestedPythonDir, "trashbyrd_40x40.png"), "fake-png-bytes");

    // The .vproject UEFN wrote for this project: its Source package
    // dirPath IS realContentDir -- the strongest evidence, confirmed
    // content, not name/layout guessing.
    writeVproject(
      path.join(verseProjectRoot, "PluginA", "vproject", "PluginA.vproject"),
      realContentDir,
      "PluginA"
    );

    // Shipped bridge fixture (stands in for media/uefn-bridge/), newer than
    // the stale staged copy.
    const bridgeDir = path.join(extensionRoot, "media", "uefn-bridge");
    writeShippedBridge(bridgeDir, "2.1.0");

    process.env.UEFN_VERSE_PROJECT_DIR = verseProjectRoot;

    console.log("BEFORE:", listTree(projectRoot));

    // Workspace opened directly at the plugin's Content dir -- the exact
    // shape of the field failure.
    const result = stage(realContentDir, extensionRoot);

    console.log("AFTER:", listTree(projectRoot));

    const projectLocation = result.locations.find((l: any) => l.label === "project");
    assert.ok(projectLocation, "a project location must be reported");
    assert.equal(projectLocation.error, undefined, "project staging must not report an error");
    // Resolves to the REAL Python dir -- never a fabricated Content/Content.
    assert.equal(projectLocation.dir, stalePythonDir);
    assert.ok(!projectLocation.dir.includes(path.join("Content", "Content")), "must never stage into a doubled Content/Content path");

    // The stale files were refreshed in place with the shipped content.
    assert.equal(
      fs.readFileSync(path.join(stalePythonDir, "uefn_bridge.py"), "utf8"),
      "# uefn_bridge (shipped)"
    );
    assert.equal(
      fs.readFileSync(path.join(stalePythonDir, "bridge_version.py"), "utf8"),
      'BRIDGE_VERSION = "2.1.0"\n'
    );
    // The Node MCP server must never land in Content/Python.
    assert.ok(!fs.existsSync(path.join(stalePythonDir, "uefn-server.mjs")));

    // The misplaced nested copy was cleaned up: its bridge-owned files are
    // gone, and the now-empty Python + Content/Content dirs were removed
    // entirely, leaving only the real Content dir behind.
    assert.ok(!fs.existsSync(bogusNestedPythonDir), "the bogus nested Content/Content/Python dir must be removed");
    assert.ok(!fs.existsSync(path.join(realContentDir, "Content")), "the emptied Content/Content parent must be removed");
    assert.ok(fs.existsSync(realContentDir), "the real content dir itself must survive");
  } finally {
    if (savedOverride === undefined) delete process.env.UEFN_VERSE_PROJECT_DIR;
    else process.env.UEFN_VERSE_PROJECT_DIR = savedOverride;
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(verseProjectRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rung 2: no vproject evidence available, but an existing Python bridge
// under a plausible content dir -- refresh in place, don't guess elsewhere.
// ---------------------------------------------------------------------------

test("no vproject evidence, existing Python/init_unreal.py under the workspace root: refreshes in place, never appends another Content", () => {
  const tmp = tmpDir("panelUefnStaging-existing-");
  // Workspace opened directly at a real UEFN content dir -- always literally
  // named "Content" by Unreal/UEFN convention (every downstream consumer of
  // the resolved dir assumes this; see `_resolveUefnContentDirEvidence`'s
  // `isNamedContentDir` safety net).
  const root = path.join(tmp, "Content");
  const verseProjectRoot = tmpDir("panelUefnStaging-existing-vproj-");
  const extensionRoot = tmpDir("panelUefnStaging-existing-ext-");
  const savedOverride = process.env.UEFN_VERSE_PROJECT_DIR;
  try {
    // Already has a bridge staged from a previous install, but NO matching
    // .vproject exists anywhere (VerseProject root below is present but
    // empty).
    fs.mkdirSync(path.join(root, "Python"), { recursive: true });
    fs.writeFileSync(path.join(root, "Python", "init_unreal.py"), "# existing init_unreal");
    fs.writeFileSync(path.join(root, "Python", "bridge_version.py"), 'BRIDGE_VERSION = "1.0.0"\n');

    const bridgeDir = path.join(extensionRoot, "media", "uefn-bridge");
    writeShippedBridge(bridgeDir, "2.1.0");

    process.env.UEFN_VERSE_PROJECT_DIR = verseProjectRoot; // exists, empty -- zero vproject matches

    const result = stage(root, extensionRoot);

    const projectLocation = result.locations.find((l: any) => l.label === "project");
    assert.equal(projectLocation.error, undefined);
    assert.equal(projectLocation.dir, path.join(root, "Python"));
    assert.equal(
      fs.readFileSync(path.join(root, "Python", "bridge_version.py"), "utf8"),
      'BRIDGE_VERSION = "2.1.0"\n'
    );
    assert.ok(!fs.existsSync(path.join(root, "Content")), "must never fabricate a Content/Python under a workspace already AT the content dir");
  } finally {
    if (savedOverride === undefined) delete process.env.UEFN_VERSE_PROJECT_DIR;
    else process.env.UEFN_VERSE_PROJECT_DIR = savedOverride;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(verseProjectRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Reviewer repro: a workspace opened directly at a REAL content dir (real
// `.verse` files present), no vproject evidence yet (user hasn't relaunched
// UEFN since being bitten by the original bug), and a leftover bogus
// `Content/Python` from that original bug still on disk. The confirmed real
// root must win outright -- the bogus sibling's only "evidence" is bridge
// files THIS extension staged there in the first place, which must never
// out-rank the real root. The leftover must be healed, not re-fed.
// ---------------------------------------------------------------------------

test("confirmed real content dir (real .verse files, no vproject) outranks a bogus nested Content/Python left by the original bug: stages into the real root and heals the leftover, never re-feeds it", () => {
  const tmp = tmpDir("panelUefnStaging-confirmed-");
  // Real content dir -- named "Content" per UEFN convention, with a real
  // .verse file directly inside it (the actual, confirming evidence).
  const root = path.join(tmp, "Content");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "MyDevice.verse"), "using { /Verse.org/Simulation }\n");

  const verseProjectRoot = tmpDir("panelUefnStaging-confirmed-vproj-");
  const extensionRoot = tmpDir("panelUefnStaging-confirmed-ext-");
  const savedOverride = process.env.UEFN_VERSE_PROJECT_DIR;
  try {
    // Leftover bogus nested copy from the ORIGINAL bug: root/Content/Python,
    // carrying our own bridge filenames -- the exact shape that could
    // out-"evidence" the real root if init_unreal.py presence were treated
    // as primary evidence instead of corroboration.
    const bogusNestedPythonDir = path.join(root, "Content", "Python");
    fs.mkdirSync(bogusNestedPythonDir, { recursive: true });
    fs.writeFileSync(path.join(bogusNestedPythonDir, "uefn_bridge.py"), "# bogus leftover copy");
    fs.writeFileSync(path.join(bogusNestedPythonDir, "init_unreal.py"), "# bogus leftover copy");
    fs.writeFileSync(path.join(bogusNestedPythonDir, "bridge_version.py"), 'BRIDGE_VERSION = "2.0.0"\n');
    fs.writeFileSync(path.join(bogusNestedPythonDir, "trashbyrd_40x40.png"), "fake-png-bytes");

    const bridgeDir = path.join(extensionRoot, "media", "uefn-bridge");
    writeShippedBridge(bridgeDir, "2.1.0");

    // No matching .vproject anywhere -- VerseProject root exists but empty,
    // reproducing "user hasn't relaunched UEFN since being bitten".
    process.env.UEFN_VERSE_PROJECT_DIR = verseProjectRoot;

    const result = stage(root, extensionRoot);

    const projectLocation = result.locations.find((l: any) => l.label === "project");
    assert.ok(projectLocation, "a project location must be reported");
    assert.equal(projectLocation.error, undefined, "must not report success for a wrong-dir write, nor an error for the CORRECT one");
    // Resolves into the REAL root's own Python dir -- never the bogus nested one.
    assert.equal(projectLocation.dir, path.join(root, "Python"));
    assert.ok(fs.existsSync(path.join(root, "Python", "uefn_bridge.py")), "the real root must receive the staged bridge");
    assert.equal(
      fs.readFileSync(path.join(root, "Python", "bridge_version.py"), "utf8"),
      'BRIDGE_VERSION = "2.1.0"\n'
    );

    // The leftover bogus copy was healed (removed), not re-fed with fresh files.
    assert.ok(!fs.existsSync(bogusNestedPythonDir), "the bogus nested Content/Python dir must be healed away");
    assert.ok(!fs.existsSync(path.join(root, "Content")), "the emptied Content parent must be removed too");
    assert.ok(fs.existsSync(root), "the real content dir itself must survive");
  } finally {
    if (savedOverride === undefined) delete process.env.UEFN_VERSE_PROJECT_DIR;
    else process.env.UEFN_VERSE_PROJECT_DIR = savedOverride;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(verseProjectRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// No evidence at all: must surface the failure explicitly, never guess.
// ---------------------------------------------------------------------------

test("no vproject match, no existing bridge, no plausible layout: surfaces an explicit error and writes nothing", () => {
  const root = tmpDir("panelUefnStaging-none-");
  const verseProjectRoot = tmpDir("panelUefnStaging-none-vproj-");
  const extensionRoot = tmpDir("panelUefnStaging-none-ext-");
  const savedOverride = process.env.UEFN_VERSE_PROJECT_DIR;
  try {
    // A bare, empty workspace: not named Content, no .verse files, no
    // Content subdir, no Plugins subdir, no existing Python bridge.
    const bridgeDir = path.join(extensionRoot, "media", "uefn-bridge");
    writeShippedBridge(bridgeDir, "2.1.0");
    process.env.UEFN_VERSE_PROJECT_DIR = verseProjectRoot; // exists, empty

    const result = stage(root, extensionRoot);

    const projectLocation = result.locations.find((l: any) => l.label === "project");
    assert.ok(projectLocation, "a project location must still be reported");
    assert.equal(projectLocation.dir, "(unresolved)");
    assert.ok(typeof projectLocation.error === "string" && projectLocation.error.length > 0, "must carry an explicit, non-empty error");
    assert.ok(projectLocation.error.includes("UEFN_VERSE_PROJECT_DIR"), "the error must name the override variable to set");

    // Nothing was written anywhere under the workspace root.
    assert.deepEqual(listTree(root), [], "no files may be written when no staging target can be resolved");
  } finally {
    if (savedOverride === undefined) delete process.env.UEFN_VERSE_PROJECT_DIR;
    else process.env.UEFN_VERSE_PROJECT_DIR = savedOverride;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(verseProjectRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
});
