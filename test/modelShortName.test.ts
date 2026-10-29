/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// modelShortName (media/main.js) is the single mapping behind the Metrics MODEL
// pill: model family only, never the company or a billing label. media/main.js
// is an untyped browser IIFE with no exports, so the function is lifted out of
// the shipped source by brace matching and run in isolation (it is
// self-contained by design).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function loadModelShortName(): (id: unknown) => string {
  const src = readFileSync(join(process.cwd(), "media", "main.js"), "utf8");
  const start = src.indexOf("function modelShortName(");
  assert.ok(start >= 0, "modelShortName must exist in media/main.js");
  const open = src.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > 0, "unbalanced braces");
  // eslint-disable-next-line no-new-func
  return new Function(src.slice(start, end) + "\nreturn modelShortName;")() as (id: unknown) => string;
}

const short = loadModelShortName();

test("modelShortName: Claude families", () => {
  assert.equal(short("claude-opus-5-5"), "Opus");
  assert.equal(short("claude-sonnet-5-5"), "Sonnet");
  assert.equal(short("claude-haiku-4-5-20251001"), "Haiku");
  assert.equal(short("fable"), "Fable");
  assert.equal(short("claude-mythos-1"), "Mythos");
  assert.equal(short("anthropic/Opus"), "Opus");
});

test("modelShortName: OpenAI/Codex tiers", () => {
  assert.equal(short("gpt-6-astra"), "Astra");
  assert.equal(short("gpt-6.1-sol"), "Sol");
  assert.equal(short("gpt-6-sol"), "Sol");
  assert.equal(short("gpt-6.1-terra"), "Terra");
  assert.equal(short("gpt-5.6-terra"), "Terra");
  assert.equal(short("gpt-6-luna"), "Luna");
  assert.equal(short("gpt-5.6-luna"), "Luna");
  assert.equal(short("openai/gpt-6.1-sol"), "Sol");
});

test("modelShortName: tier words only match as whole tokens", () => {
  assert.notEqual(short("solar-10b"), "Sol");
  assert.notEqual(short("lunatic-1"), "Luna");
});

test("modelShortName: Google and Moonshot", () => {
  assert.equal(short("gemini-3.5-pro"), "Gemini Pro");
  assert.equal(short("google/gemini-2.5-flash"), "Gemini Flash");
  assert.equal(short("gemini-3.5-flash (Antigravity)"), "Gemini Flash");
  assert.equal(short("gemini-ultra"), "Gemini");
  assert.equal(short("kimi-k2"), "Kimi K2");
  assert.equal(short("moonshot/kimi-k2-0905"), "Kimi K2");
});

test("modelShortName: other and local models keep a short bare name", () => {
  assert.equal(short("ollama-choy-cloud/qwen3.8:27b"), "qwen3.8:27b");
  assert.equal(short("mistral-large-latest"), "mistral-lar…");
  assert.ok(short("some-extremely-long-model-name-xyz").length <= 12);
});

test("modelShortName: unknown or empty is a dash", () => {
  for (const v of ["", "   ", null, undefined]) assert.equal(short(v), "—");
});

test("modelShortName: Claude names only map for Claude ids", () => {
  assert.notEqual(short("qwen-sonnet-ft"), "Sonnet");
  assert.notEqual(short("my-haiku-model"), "Haiku");
  assert.equal(short("opus[1m]"), "Opus");
});
