/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Pure unit tests for test/packagingProviderStrings.ts against in-memory
// fixtures — no dist/ or VSIX build required. See
// test/packagingManifest.check.ts for the real-VSIX integration checks.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findForbiddenProviderStrings,
  findForbiddenManifestContent,
  isBinaryPath,
} from "./packagingProviderStrings";

test("findForbiddenProviderStrings: flags OpenAI/Google hostnames, package imports, and key-shaped strings", () => {
  const findings = findForbiddenProviderStrings([
    { path: "extension/out/foo.js", text: "fetch('https://api.openai.com/v1/x')" },
    { path: "extension/out/bar.js", text: "const k = 'sk-abcdefghijklmnopqrstuvwx';" },
    { path: "extension/out/clean.js", text: "console.log('hello world');" },
  ]);
  const patterns = findings.map((f) => f.pattern);
  assert.ok(patterns.includes("hostname:api.openai.com"));
  assert.ok(patterns.includes("key:openai(sk-)"));
  assert.equal(findings.filter((f) => f.path === "extension/out/clean.js").length, 0);
});

test("findForbiddenManifestContent: a bundled tycoon-team.json fails, naming the path", () => {
  const findings = findForbiddenManifestContent([
    { path: "extension/.claude/tycoon-team.json", text: '{"roster":[]}' },
    { path: "extension/out/src/host/vscode/teamSetupHost.js", text: "export function exportTeamSetup() {}" },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, "extension/.claude/tycoon-team.json");
  assert.equal(findings[0].pattern, "forbidden-manifest");
});

test("findForbiddenManifestContent: a bundled team-setup-applied.json also fails", () => {
  const findings = findForbiddenManifestContent([
    { path: "extension/.claude/tycoon/team-setup-applied.json", text: '{"exportedAt":"2026-01-01"}' },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, "extension/.claude/tycoon/team-setup-applied.json");
});

test("findForbiddenManifestContent: a manifest with a drive-letter path also fails on abs-path", () => {
  const findings = findForbiddenManifestContent([
    {
      path: "extension/.claude/tycoon-team.json",
      text: '{"note":"C:\\\\Users\\\\someone\\\\project\\\\out"}',
    },
  ]);
  const patterns = findings.map((f) => f.pattern);
  assert.ok(patterns.includes("forbidden-manifest"));
  assert.ok(patterns.includes("abs-path"));
});

test("findForbiddenManifestContent: a clean tree with no manifest basenames passes", () => {
  const findings = findForbiddenManifestContent([
    { path: "extension/out/src/core/teamSetup.js", text: "export function buildTeamManifest() {}" },
    { path: "extension/package.json", text: '{"name":"tycoonagents"}' },
  ]);
  assert.deepEqual(findings, []);
});

test("isBinaryPath: recognizes known binary extensions and rejects text ones", () => {
  assert.equal(isBinaryPath("extension/media/icon.png"), true);
  assert.equal(isBinaryPath("extension/dist/tycoonagents-0.0.1.vsix"), true);
  assert.equal(isBinaryPath("extension/out/src/core/teamSetup.js"), false);
});
