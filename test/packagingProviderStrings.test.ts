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
  stripDataUriPayloads,
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

const FAKE_GOOGLE_KEY = "AIza" + "SyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q";

test("provider key scan: real-looking AIza key is flagged in env and JSON text", () => {
  const findings = findForbiddenProviderStrings([
    { path: "a/.env", text: `KEY=${FAKE_GOOGLE_KEY}
` },
    { path: "a/c.json", text: `{"k": "${FAKE_GOOGLE_KEY}"}` },
    { path: "a/d.txt", text: `key: ${FAKE_GOOGLE_KEY}` },
  ]);
  assert.equal(findings.filter((f) => f.pattern === "key:google(AIza)").length, 3);
});

test("provider key scan: key-shaped chars inside base64 runs or data URIs are not flagged", () => {
  const run = "iVBORw0KGgoAAAANSUhEUgAAAKloO" + FAKE_GOOGLE_KEY + "AAAA/+zz";
  const findings = findForbiddenProviderStrings([
    { path: "a/frames.json", text: JSON.stringify({ img: run }) },
    { path: "a/uri.json", text: JSON.stringify({ img: `data:image/png;base64,${FAKE_GOOGLE_KEY}AAAA` }) },
    { path: "a/sk.json", text: JSON.stringify({ img: "QUJD" + "sk-abcdefghijklmnopqrstuvwx" }) },
  ]);
  assert.deepEqual(findings, []);
  assert.equal(stripDataUriPayloads("x data:image/png;base64,AAAA y"), "x data:image/png;base64, y");
});
