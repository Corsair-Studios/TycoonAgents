// test/packagingManifest.test.ts
//
// Guards against a repeat of the 0.0.576 packaging bug: the Routing
// screen's Save spawns `node <extensionInstallPath>/scripts/<name>.mjs`
// (src/core/routingHostOps.ts -> resolveGeneratorScripts), so the VSIX
// must ship those two scripts plus the compiled modules they
// createRequire() at runtime, and must never ship this machine's local
// opencode.json.
//
// Requires dist/tycoonagents-<version>.vsix to already exist (built via
// `npm run package`) and `unzip` on PATH.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const REQUIRED_ENTRIES = [
  "extension/scripts/apply-routing-profile.mjs",
  "extension/scripts/generate-opencode-config.mjs",
  "extension/out/src/core/agentBackend.js",
  "extension/out/src/core/modelAliases.js",
  "extension/out/src/core/routingProfile.js",
  "extension/out/src/core/localEnvStore.js",
];

const FORBIDDEN_ENTRIES = [
  "extension/opencode.json",
];

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

test("packaged VSIX ships the routing generator scripts and their runtime modules", () => {
  const vsixPath = findVsix();
  const entries = new Set(listVsixEntries(vsixPath));

  for (const required of REQUIRED_ENTRIES) {
    assert.ok(
      entries.has(required),
      `VSIX ${path.basename(vsixPath)} is missing "${required}" — the ` +
        `Routing screen's Save cannot run node <scriptsDir>/scripts/*.mjs ` +
        `without it. See src/core/routingHostOps.ts resolveGeneratorScripts.`
    );
  }
});

test("packaged VSIX does not ship a local opencode.json", () => {
  const vsixPath = findVsix();
  const entries = new Set(listVsixEntries(vsixPath));

  for (const forbidden of FORBIDDEN_ENTRIES) {
    assert.ok(
      !entries.has(forbidden),
      `VSIX ${path.basename(vsixPath)} ships "${forbidden}" — this is a ` +
        `machine-local managed provider config and must be excluded via ` +
        `.vscodeignore.`
    );
  }
});
