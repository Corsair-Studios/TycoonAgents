/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shortFromModelId,
  modelIdFromShort,
  setFrontmatterModel,
  setKeywordPattern,
} from "../src/host/vscode/agentConfig";

test("shortFromModelId maps known ids and rejects others", () => {
  assert.equal(shortFromModelId("claude-opus-4-6"), "opus");
  assert.equal(shortFromModelId("claude-sonnet-4-6"), "sonnet");
  assert.equal(shortFromModelId("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(shortFromModelId("claude-fable-5"), "fable");
  assert.equal(shortFromModelId("CLAUDE-OPUS-4-6"), "opus"); // case-insensitive
  assert.equal(shortFromModelId("gpt"), undefined);
  assert.equal(shortFromModelId(undefined), undefined);
});

test("modelIdFromShort round-trips and rejects unknown", () => {
  assert.equal(modelIdFromShort("opus"), "claude-opus-4-6");
  assert.equal(modelIdFromShort("sonnet"), "claude-sonnet-4-6");
  assert.equal(modelIdFromShort("haiku"), "claude-haiku-4-5-20251001");
  assert.equal(modelIdFromShort("fable"), "claude-fable-5");
  assert.equal(modelIdFromShort("gpt"), undefined);

  // round-trip: short -> id -> short
  for (const s of ["opus", "sonnet", "haiku", "fable"] as const) {
    assert.equal(shortFromModelId(modelIdFromShort(s)), s);
  }
});

test("setFrontmatterModel replaces an existing model line", () => {
  const input = "---\nname: foo\nmodel: claude-haiku-4-5-20251001\n---\nBody here.";
  const out = setFrontmatterModel(input, "claude-opus-4-6");
  assert.equal(
    out,
    "---\nname: foo\nmodel: claude-opus-4-6\n---\nBody here."
  );
});

test("setFrontmatterModel inserts model when frontmatter lacks it", () => {
  const input = "---\nname: foo\n---\nBody here.";
  const out = setFrontmatterModel(input, "claude-sonnet-4-6");
  assert.equal(
    out,
    "---\nmodel: claude-sonnet-4-6\nname: foo\n---\nBody here."
  );
});

test("setFrontmatterModel creates frontmatter when absent", () => {
  const input = "Just a body, no frontmatter.";
  const out = setFrontmatterModel(input, "claude-opus-4-6");
  assert.equal(
    out,
    "---\nmodel: claude-opus-4-6\n---\nJust a body, no frontmatter."
  );
});

test("setFrontmatterModel preserves body text exactly", () => {
  const body = "Line one.\nLine two with: colons and # hashes.\nLine three.";
  const input = "---\nmodel: claude-haiku-4-5-20251001\n---\n" + body;
  const out = setFrontmatterModel(input, "claude-sonnet-4-6");
  assert.ok(out.endsWith(body), "body must be preserved verbatim");
});

test("setFrontmatterModel does not mangle a CRLF document", () => {
  const input = "---\r\nname: foo\r\nmodel: claude-haiku-4-5-20251001\r\n---\r\nBody\r\nMore.";
  const out = setFrontmatterModel(input, "claude-opus-4-6");
  assert.equal(
    out,
    "---\r\nname: foo\r\nmodel: claude-opus-4-6\r\n---\r\nBody\r\nMore."
  );
  // No stray lone \n (every \n must be preceded by \r).
  assert.equal(
    /(?<!\r)\n/.test(out),
    false,
    "CRLF document must not contain lone \\n"
  );
});

test("setKeywordPattern updates an existing agent", () => {
  const config = { agents: { foo: { pattern: "old" } } };
  const out = setKeywordPattern(config, "foo", "new");
  assert.equal(out.agents.foo.pattern, "new");
});

test("setKeywordPattern creates a missing agent and agents map", () => {
  const fromEmpty = setKeywordPattern({}, "bar", "p");
  assert.equal(fromEmpty.agents.bar.pattern, "p");

  const fromExisting = setKeywordPattern(
    { agents: { foo: { pattern: "x" } } },
    "bar",
    "p"
  );
  assert.equal(fromExisting.agents.bar.pattern, "p");
});

test("setKeywordPattern preserves other agents and top-level keys", () => {
  const config = {
    fallback_agent: "claude",
    agents: { foo: { pattern: "x" }, baz: { pattern: "y" } },
  };
  const out = setKeywordPattern(config, "foo", "z");
  assert.equal(out.fallback_agent, "claude");
  assert.equal(out.agents.foo.pattern, "z");
  assert.equal(out.agents.baz.pattern, "y");
});

test("setKeywordPattern does not mutate the input object", () => {
  const config = {
    fallback_agent: "claude",
    agents: { foo: { pattern: "x" } },
  };
  const clonedBefore = structuredClone(config);
  setKeywordPattern(config, "foo", "changed");
  assert.deepEqual(config, clonedBefore, "input must not be mutated");
});
