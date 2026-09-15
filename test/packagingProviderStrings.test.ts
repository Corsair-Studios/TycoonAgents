// test/packagingProviderStrings.test.ts
//
// Unit tests for findForbiddenProviderStrings (p45-t5), exercised against
// in-memory fixtures rather than a built VSIX.

import { test } from "node:test";
import assert from "node:assert/strict";
import { findForbiddenProviderStrings } from "./packagingManifest.check";

test("flags the OpenAI hostname with path and pattern named", () => {
  const findings = findForbiddenProviderStrings([
    { path: "extension/out/src/foo.js", text: 'fetch("https://api.openai.com/v1/chat")' },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, "extension/out/src/foo.js");
  assert.equal(findings[0].pattern, "hostname:api.openai.com");
});

test("flags the Google GenAI hostname", () => {
  const findings = findForbiddenProviderStrings([
    { path: "extension/out/src/bar.js", text: "generativelanguage.googleapis.com/v1" },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "hostname:generativelanguage.googleapis.com");
});

test("flags a shipped node_modules/openai package path", () => {
  const findings = findForbiddenProviderStrings([
    { path: "extension/node_modules/openai/index.js", text: "module.exports = {}" },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "package:node_modules/openai/");
});

test("flags a shipped node_modules/@google/generative-ai package path", () => {
  const findings = findForbiddenProviderStrings([
    { path: "extension/node_modules/@google/generative-ai/index.js", text: "" },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "package:node_modules/@google/generative-ai/");
});

test("flags a shipped node_modules/@google/genai package path", () => {
  const findings = findForbiddenProviderStrings([
    { path: "extension/node_modules/@google/genai/index.js", text: "" },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "package:node_modules/@google/genai/");
});

test("flags a require() of a forbidden SDK in shipped JS", () => {
  const findings = findForbiddenProviderStrings([
    { path: "extension/out/src/x.js", text: 'const { OpenAI } = require("openai");' },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "import:openai");
});

test("flags an import of @google/generative-ai in shipped JS", () => {
  const findings = findForbiddenProviderStrings([
    { path: "extension/out/src/y.js", text: 'import { GoogleGenerativeAI } from "@google/generative-ai";' },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "import:@google/generative-ai");
});

test("flags an OpenAI-style key (sk- + 20+ chars)", () => {
  const key = "sk-" + "A".repeat(25);
  const findings = findForbiddenProviderStrings([
    { path: "extension/out/src/secret.js", text: `const k = "${key}";` },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "key:openai(sk-)");
  assert.equal(findings[0].match, key);
});

test("does not flag a sk- prefix shorter than 20 chars", () => {
  const findings = findForbiddenProviderStrings([
    { path: "extension/out/src/modelid.js", text: 'const model = "sk-short-id";' },
  ]);
  assert.deepEqual(findings, []);
});

test("flags a Google-style API key (AIza + 35 chars)", () => {
  const key = "AIza" + "B".repeat(35);
  const findings = findForbiddenProviderStrings([
    { path: "extension/out/src/gsecret.js", text: `key=${key}` },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "key:google(AIza)");
  assert.equal(findings[0].match, key);
});

test("a clean fixture passes with no findings", () => {
  const findings = findForbiddenProviderStrings([
    { path: "extension/out/src/clean.js", text: 'const routingUrl = "https://example.com/api";' },
    { path: "extension/package.json", text: '{"name":"tycoonagents"}' },
  ]);
  assert.deepEqual(findings, []);
});

test("multiple findings across entries are all reported", () => {
  const findings = findForbiddenProviderStrings([
    { path: "a.js", text: "api.openai.com" },
    { path: "b.js", text: "AIza" + "C".repeat(35) },
  ]);
  assert.equal(findings.length, 2);
});
