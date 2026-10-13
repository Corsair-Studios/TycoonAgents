import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { compareVersions, copiesFromNewerInstall, discoverSiblingExtensions, extensionHookSource } from "../src/host/vscode/installedExtensions";
import { MCP_BRIDGE_HOOK_FILES, RUNTIME_HOOK_FILES } from "../src/host/vscode/hookInstall";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "installed-ext-"));
}
function makeExt(dir: string, pkg: object | string, withHooks = true): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), typeof pkg === "string" ? pkg : JSON.stringify(pkg));
  if (withHooks) fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
  return dir;
}
const OURS = (version: string) => ({ name: "tycoonagents", publisher: "tycoonagents", version });

test("discovery via TYCOON_EXTENSION_DIRS accepts by package.json content, not folder name", () => {
  const base = tmp();
  const self = makeExt(path.join(base, "self"), OURS("1.0.0"));
  const a = makeExt(path.join(base, "totally-unrelated-name"), OURS("1.2.0"));
  const env = { TYCOON_EXTENSION_DIRS: a } as NodeJS.ProcessEnv;
  const found = discoverSiblingExtensions(self, env, path.join(base, "nohome"));
  assert.deepEqual(found, [{ dir: a, version: "1.2.0" }]);
});

test("override entries may be extension roots (children scanned) and selfDir is excluded", () => {
  const base = tmp();
  const root = path.join(base, "extensions");
  const self = makeExt(path.join(root, "self"), OURS("1.0.0"));
  const other = makeExt(path.join(root, "other"), OURS("0.9.0"));
  const found = discoverSiblingExtensions(self, { TYCOON_EXTENSION_DIRS: root } as NodeJS.ProcessEnv, path.join(base, "nohome"));
  assert.deepEqual(found.map((e) => e.dir), [other]);
});

test("dirs whose package.json name/publisher is not ours, or lack hooks, are ignored", () => {
  const base = tmp();
  const self = makeExt(path.join(base, "self"), OURS("1.0.0"));
  const wrongName = makeExt(path.join(base, "a"), { name: "other", publisher: "tycoonagents", version: "9.0.0" });
  const wrongPub = makeExt(path.join(base, "b"), { name: "tycoonagents", publisher: "evil", version: "9.0.0" });
  const noHooks = makeExt(path.join(base, "c"), OURS("9.0.0"), false);
  const bad = makeExt(path.join(base, "d"), "{not json");
  const noVersion = makeExt(path.join(base, "e"), { name: "tycoonagents", publisher: "tycoonagents" });
  const good = makeExt(path.join(base, "f"), OURS("2.0.0"));
  const override = [wrongName, wrongPub, noHooks, bad, noVersion, good, path.join(base, "missing")].join(path.delimiter);
  const found = discoverSiblingExtensions(self, { TYCOON_EXTENSION_DIRS: override } as NodeJS.ProcessEnv, path.join(base, "nohome"));
  assert.deepEqual(found.map((e) => e.dir), [good]);
});

test("without an override, the parent dir and editor roots under home are scanned; duplicates collapse", () => {
  const base = tmp();
  const self = makeExt(path.join(base, "parent", "self"), OURS("1.0.0"));
  const sib = makeExt(path.join(base, "parent", "sib"), OURS("1.1.0"));
  const home = path.join(base, "home");
  const cursor = makeExt(path.join(home, ".cursor", "extensions", "x"), OURS("1.3.0"));
  const found = discoverSiblingExtensions(self, {} as NodeJS.ProcessEnv, home);
  assert.deepEqual(found.map((e) => e.dir).sort(), [cursor, sib].sort());
  // Empty override falls back to the ladder.
  assert.equal(discoverSiblingExtensions(self, { TYCOON_EXTENSION_DIRS: "  " } as NodeJS.ProcessEnv, home).length, 2);
});

test("compareVersions orders numerically", () => {
  assert.ok(compareVersions("0.0.730", "0.0.99") > 0);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.ok(compareVersions("1.2.3", "1.10.0") < 0);
});

function projectWithCopies(ext: string, opts: { tamper?: boolean } = {}): string {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude", "hooks"), { recursive: true });
  for (const f of RUNTIME_HOOK_FILES) {
    const s = extensionHookSource(ext, f);
    if (s) fs.copyFileSync(s, path.join(root, ".claude", "tycoon", f));
  }
  for (const f of MCP_BRIDGE_HOOK_FILES) {
    const s = extensionHookSource(ext, f);
    if (s) fs.copyFileSync(s, path.join(root, ".claude", "hooks", f));
  }
  if (opts.tamper) fs.appendFileSync(path.join(root, ".claude", "tycoon", "tycoon-claude-hook.cjs"), "\n//tampered\n");
  return root;
}
function extWithHooks(version: string, tweak = ""): string {
  const ext = makeExt(path.join(tmp(), "ext"), OURS(version));
  for (const f of new Set([...RUNTIME_HOOK_FILES, ...MCP_BRIDGE_HOOK_FILES])) {
    fs.writeFileSync(path.join(ext, "hooks", f), `// ${f}\n${tweak}`);
  }
  return ext;
}

test("copiesFromNewerInstall: true only for byte-identical copies of a NEWER install", () => {
  const newer = extWithHooks("2.0.0");
  const root = projectWithCopies(newer);
  const sibs = [{ dir: newer, version: "2.0.0" }];
  assert.equal(copiesFromNewerInstall(root, "1.0.0", sibs), true);
  assert.equal(copiesFromNewerInstall(root, "2.0.0", sibs), false, "same version is not newer");
  assert.equal(copiesFromNewerInstall(root, "3.0.0", sibs), false, "older sibling");
  assert.equal(copiesFromNewerInstall(root, null, sibs), false, "unknown self version");
  assert.equal(copiesFromNewerInstall(root, "1.0.0", []), false, "no siblings");
});

test("copiesFromNewerInstall: tampered, different-content, or absent copies are false", () => {
  const newer = extWithHooks("2.0.0");
  const sibs = [{ dir: newer, version: "2.0.0" }];
  assert.equal(copiesFromNewerInstall(projectWithCopies(newer, { tamper: true }), "1.0.0", sibs), false, "one copy diverges");
  const other = extWithHooks("2.0.0", "// different build");
  assert.equal(copiesFromNewerInstall(projectWithCopies(other), "1.0.0", sibs), false, "matches a different install");
  assert.equal(copiesFromNewerInstall(tmp(), "1.0.0", sibs), false, "no copies at all");
});
