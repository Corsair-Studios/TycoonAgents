// test/packagingPoseGuides.check.ts
//
// Extends the packagingManifest.check.ts pattern (VSIX content checks,
// requires dist/tycoonagents-<version>.vsix + unzip on PATH) to the p58
// walk-pose-guide PNGs: when media/pose-guides/*.png exist in the repo, the
// packaged VSIX must ship them at extension/media/pose-guides/<name>. The
// real PNGs are not on disk yet (README.md is the only file currently in
// media/pose-guides), so this check SKIPS with a visible message rather than
// failing, keeping CI green until the user saves the files.
//
// Never registered from a unit-test entrypoint at import time (0.0.615
// incident) — this file is run only via `npm run verify:vsix-contents`
// (node --test against the compiled out/test/*.check.js file directly), same
// as packagingManifest.check.ts. Pure comparison logic lives in
// test/packagingPoseGuidesHelper.ts so it can be unit-tested without a VSIX.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { checkPoseGuidesPackaged } from "./packagingPoseGuidesHelper";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const POSE_GUIDES_DIR = path.join(REPO_ROOT, "media", "pose-guides");

function findVsix(): string {
  const distDir = path.join(REPO_ROOT, "dist");
  if (!fs.existsSync(distDir)) {
    throw new Error(
      `dist/ not found at ${distDir} — run "npm run package" before this test.`
    );
  }
  const vsixFiles = fs
    .readdirSync(distDir)
    .filter((f) => f.endsWith(".vsix"))
    .map((f) => path.join(distDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (vsixFiles.length === 0) {
    throw new Error(
      `No .vsix file found in ${distDir} — run "npm run package" before this test.`
    );
  }
  return vsixFiles[0];
}

function listVsixEntries(vsixPath: string): string[] {
  const output = execFileSync("unzip", ["-Z1", vsixPath], {
    encoding: "utf8",
  });
  return output.split(/\r?\n/).filter(Boolean);
}

test("packaged VSIX ships every media/pose-guides/*.png present in the repo", () => {
  let repoFiles: string[] = [];
  try {
    repoFiles = fs.readdirSync(POSE_GUIDES_DIR);
  } catch {
    repoFiles = [];
  }

  const pngs = repoFiles.filter((f) => f.toLowerCase().endsWith(".png"));
  if (pngs.length === 0) {
    console.log(
      "[packagingPoseGuides.check] SKIPPED: no media/pose-guides/*.png in " +
        "the repo yet (walk pose-guide PNGs not saved) — nothing to verify."
    );
    return;
  }

  const vsixPath = findVsix();
  const entries = listVsixEntries(vsixPath);
  const result = checkPoseGuidesPackaged(pngs, entries);

  assert.ok(result.ran, "expected the check to run since PNGs are present");
  assert.deepEqual(
    result.missingFromVsix,
    [],
    `VSIX ${path.basename(vsixPath)} is missing pose-guide PNG(s): ` +
      `${result.missingFromVsix.join(", ")} — see media/pose-guides/README.md ` +
      `and src/extension/poseGuides.ts's POSE_GUIDE_FILES.`
  );
});
