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
  removeKeywordPattern,
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

test("modelIdFromShort writes auto-latest aliases (opus/sonnet/haiku) and canonical fable id", () => {
  // opus/sonnet/haiku write the BARE ALIAS so Claude Code resolves the latest
  // model of each family automatically (never goes stale). Fable has no alias.
  assert.equal(modelIdFromShort("opus"), "opus");
  assert.equal(modelIdFromShort("sonnet"), "sonnet");
  assert.equal(modelIdFromShort("haiku"), "haiku");
  assert.equal(modelIdFromShort("fable"), "claude-fable-5");
  assert.equal(modelIdFromShort("gpt"), undefined);

  // round-trip: short -> written value -> short. Bare aliases must map back.
  for (const s of ["opus", "sonnet", "haiku", "fable"] as const) {
    assert.equal(shortFromModelId(modelIdFromShort(s)), s);
  }
});

test("shortFromModelId maps bare aliases back to their short label", () => {
  assert.equal(shortFromModelId("opus"), "opus");
  assert.equal(shortFromModelId("sonnet"), "sonnet");
  assert.equal(shortFromModelId("haiku"), "haiku");
  assert.equal(shortFromModelId("fable"), "fable");
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

test("removeKeywordPattern removes an existing agent entry", () => {
  const config = { agents: { foo: { pattern: "x" }, bar: { pattern: "y" } } };
  const out = removeKeywordPattern(config, "foo");
  assert.equal("foo" in out.agents, false);
  assert.equal(out.agents.bar.pattern, "y");
});

test("removeKeywordPattern preserves other agents and top-level keys", () => {
  const config = {
    fallback_agent: "claude",
    agents: { foo: { pattern: "x" }, baz: { pattern: "y" } },
  };
  const out = removeKeywordPattern(config, "foo");
  assert.equal(out.fallback_agent, "claude");
  assert.equal("foo" in out.agents, false);
  assert.equal(out.agents.baz.pattern, "y");
});

test("removeKeywordPattern is a no-op (returns config unchanged) when the agent id is absent", () => {
  const config = { agents: { bar: { pattern: "y" } } };
  const out = removeKeywordPattern(config, "foo");
  assert.deepEqual(out, config);
});

test("removeKeywordPattern is a no-op when agents is missing or malformed", () => {
  assert.deepEqual(removeKeywordPattern({}, "foo"), {});
  assert.deepEqual(removeKeywordPattern({ agents: null }, "foo"), { agents: null });
  assert.deepEqual(removeKeywordPattern({ agents: "not-an-object" }, "foo"), { agents: "not-an-object" });
});

test("removeKeywordPattern does not mutate the input object", () => {
  const config = {
    fallback_agent: "claude",
    agents: { foo: { pattern: "x" }, bar: { pattern: "y" } },
  };
  const clonedBefore = structuredClone(config);
  removeKeywordPattern(config, "foo");
  assert.deepEqual(config, clonedBefore, "input must not be mutated");
});

test("setKeywordPattern then removeKeywordPattern round-trips back to the original agents map", () => {
  const config = { agents: { bar: { pattern: "y" } } };
  const added = setKeywordPattern(config, "build-lead", "lead|team|coordinate");
  const removed = removeKeywordPattern(added, "build-lead");
  assert.deepEqual(removed, config);
});
