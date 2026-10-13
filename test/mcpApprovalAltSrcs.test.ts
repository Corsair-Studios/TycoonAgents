import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { tycoonServerDefsFromMedia, hookClosureMatchesInstalled } from "../src/core/mcpApproval";
import type { ApprovalEnv } from "../src/core/mcpApproval";
import { bridgeFilesForConfig } from "../src/host/vscode/hookInstall";
import { resolveConfigForPlatform, withDispatcherProjectDir } from "../src/host/vscode/mcpCatalog";

const REPO = process.cwd();
const DEFS = tycoonServerDefsFromMedia(path.join(REPO, "media"));
const CATALOG: any[] = JSON.parse(fs.readFileSync(path.join(REPO, "media", "mcp", "catalog.json"), "utf8"));
const ID = "claude-cli";
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "altsrc-home-"));

function tmp(p: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}
function cfg(root: string): unknown {
  const r = resolveConfigForPlatform(CATALOG.find((e) => e.id === ID), process.platform) as any;
  return withDispatcherProjectDir(ID, r.config, root);
}
/** A project whose .claude/hooks copies come from `srcDir`. */
function project(srcDir: string): { root: string; files: string[] } {
  const root = tmp("altsrc-proj-");
  const files = bridgeFilesForConfig(cfg(root));
  fs.mkdirSync(path.join(root, ".claude", "hooks"), { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(srcDir, f), path.join(root, ".claude", "hooks", f));
  fs.writeFileSync(path.join(root, ".claude", "hooks", "package.json"), JSON.stringify({ type: "commonjs" }) + "\n");
  return { root, files };
}
/** A second "installed extension" hooks dir: the repo hooks, with one file's bytes changed. */
function otherInstall(files: string[], changed?: string): string {
  const dir = tmp("altsrc-other-");
  for (const f of files) {
    fs.copyFileSync(path.join(REPO, "hooks", f), path.join(dir, f));
    if (f === changed) fs.appendFileSync(path.join(dir, f), "\n// other build\n");
  }
  return dir;
}
function env(altDirs: string[] | undefined): ApprovalEnv {
  return {
    homeDir: HOME,
    resolveSrc: (f) => {
      const p = path.join(REPO, "hooks", f);
      return fs.existsSync(p) ? p : undefined;
    },
    altSrcs: altDirs ? (f) => altDirs.map((d) => path.join(d, f)).filter((p) => fs.existsSync(p)) : undefined,
  };
}

test("baseline: copies identical to the running extension match", () => {
  const { root, files } = project(path.join(REPO, "hooks"));
  assert.ok(files.length > 0);
  assert.equal(hookClosureMatchesInstalled(root, ID, DEFS[ID], env(undefined)), true);
});

test("copies identical to another installed extension's hooks count as ours", () => {
  const files = bridgeFilesForConfig(cfg("x"));
  const victim = files.find((f) => f.endsWith(".cjs"))!;
  const other = otherInstall(files, victim);
  const { root } = project(other); // made by the OTHER install; differs from the running one in `victim`
  assert.equal(hookClosureMatchesInstalled(root, ID, DEFS[ID], env(undefined)), false, "without altSrcs it is foreign");
  assert.equal(hookClosureMatchesInstalled(root, ID, DEFS[ID], env([])), false);
  assert.equal(hookClosureMatchesInstalled(root, ID, DEFS[ID], env([other])), true);
});

test("tampered copies are revoked even when a forged hook-copy-version.json exists", () => {
  const files = bridgeFilesForConfig(cfg("x"));
  const other = otherInstall(files);
  const { root } = project(other);
  const victim = files.find((f) => f.endsWith(".cjs"))!;
  fs.appendFileSync(path.join(root, ".claude", "hooks", victim), "\nrequire('child_process').exec('evil');\n");
  fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "tycoon", "hook-copy-version.json"), JSON.stringify({ version: "99.0.0", extensionVersion: "99.0.0" }));
  assert.equal(hookClosureMatchesInstalled(root, ID, DEFS[ID], env([other])), false);
  assert.equal(hookClosureMatchesInstalled(root, ID, DEFS[ID], env(undefined)), false);
});

test("copies matching no install are revoked", () => {
  const files = bridgeFilesForConfig(cfg("x"));
  const victim = files.find((f) => f.endsWith(".cjs"))!;
  const a = otherInstall(files, victim); // differs from the running one
  const b = tmp("altsrc-b-");
  for (const f of files) fs.copyFileSync(path.join(REPO, "hooks", f), path.join(b, f));
  fs.appendFileSync(path.join(b, victim), "\n// yet another\n");
  const { root } = project(b);
  assert.equal(hookClosureMatchesInstalled(root, ID, DEFS[ID], env([a])), false);
  assert.equal(hookClosureMatchesInstalled(root, ID, DEFS[ID], env([])), false);
});

test("an alt install that lacks a file does not make a mismatching copy pass", () => {
  const files = bridgeFilesForConfig(cfg("x"));
  const victim = files.find((f) => f.endsWith(".cjs"))!;
  const other = otherInstall(files, victim);
  const { root } = project(other);
  fs.rmSync(path.join(other, victim));
  assert.equal(hookClosureMatchesInstalled(root, ID, DEFS[ID], env([other])), false);
});
