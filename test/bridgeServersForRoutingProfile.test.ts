import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never let a test reach the real Claude config (~/.claude.json) or the real `claude` binary.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-claude-cfg-"));
process.env.TYCOON_CLAUDE_BIN = "none";

import { bridgeServersForRoutingProfile, harnessUsesMcpJson } from "../src/core/bridgeSetup";

/*
 * bridgeServersForRoutingProfile(profile, previous): which bridge MCP servers a Save newly needs.
 * Only slots whose vendor/model/route differs from the previously saved profile count.
 */

const codex = (model = "openai/gpt-x") => ({ vendor: "openai", transport: "mcp", model, costModelClass: "subscription" });
const gemini = (model = "google/gemini-x") => ({ vendor: "google", transport: "mcp", model, costModelClass: "subscription" });
const native = (model = "sonnet") => ({ vendor: "anthropic", transport: "claude-native", model, costModelClass: "subscription" });

test("a slot changed to a bridge vendor is returned", () => {
  const previous = { version: 1, agents: { reviewer: native() } };
  const profile = { version: 1, agents: { reviewer: codex() } };
  assert.deepEqual(bridgeServersForRoutingProfile(profile, previous), ["codex"]);
  // A model change within the same vendor is a changed route too.
  const prev2 = { version: 1, agents: { reviewer: codex("openai/a") } };
  const prof2 = { version: 1, agents: { reviewer: codex("openai/b") } };
  assert.deepEqual(bridgeServersForRoutingProfile(prof2, prev2), ["codex"]);
});

test("an unchanged slot is not returned; only the changed slot is, deduplicated", () => {
  const previous = { version: 1, agents: { a: codex(), b: native() } };
  const profile = { version: 1, agents: { a: codex(), b: gemini(), c: gemini() } };
  assert.deepEqual(bridgeServersForRoutingProfile(profile, previous), ["gemini"]);
  assert.deepEqual(bridgeServersForRoutingProfile({ version: 1, agents: { a: codex() } }, previous), []);
});

test("an unrelated field change (defaultFallback, costModelClass) returns nothing", () => {
  const previous = { version: 1, agents: { a: codex(), b: gemini() } };
  const profile = {
    version: 1,
    defaultFallback: [{ vendor: "google", model: "google/gemini-x" }],
    agents: { a: { ...codex(), costModelClass: "metered" }, b: gemini() },
  };
  assert.deepEqual(bridgeServersForRoutingProfile(profile, previous), []);
});

test("a deliberately removed server is not re-registered on an unrelated Save", () => {
  // The slot already points at codex in the saved profile; the user removed the codex server.
  // An unrelated Save (another agent edited) must not bring it back.
  const previous = { version: 1, agents: { reviewer: codex(), worker: native("sonnet") } };
  const profile = { version: 1, agents: { reviewer: codex(), worker: native("opus") } };
  assert.deepEqual(bridgeServersForRoutingProfile(profile, previous), []);
});

test("a native vendor needs nothing, even when newly chosen", () => {
  const previous = { version: 1, agents: { a: codex() } };
  const profile = { version: 1, agents: { a: native("opus") } };
  assert.deepEqual(bridgeServersForRoutingProfile(profile, previous), []);
  assert.deepEqual(bridgeServersForRoutingProfile({ version: 1, agents: { a: native() } }), []);
});

test("with no previous profile, only slots that actually need a bridge are returned", () => {
  const profile = {
    version: 1,
    agents: {
      n: native(),
      r: codex(),
      g: gemini(),
      k: { vendor: "moonshot", transport: "openai-compatible", model: "moonshot/kimi-k2" },
      u: { vendor: "mystery", transport: "claude-native", model: "mystery/x" }, // no bridge mapping
    },
  };
  const out = bridgeServersForRoutingProfile(profile, undefined);
  assert.deepEqual([...out].sort(), ["codex", "gemini", "openai-compatible"]);
  assert.deepEqual(bridgeServersForRoutingProfile(profile, null), out);
});

test("malformed input never throws and returns nothing", () => {
  assert.deepEqual(bridgeServersForRoutingProfile(null), []);
  assert.deepEqual(bridgeServersForRoutingProfile({}), []);
  assert.deepEqual(bridgeServersForRoutingProfile({ agents: { a: null, b: 5 } }, "x"), []);
});

test("the Codex and OpenCode harnesses never register (the save paths gate on harnessUsesMcpJson)", () => {
  assert.equal(harnessUsesMcpJson("claude-code"), true);
  assert.equal(harnessUsesMcpJson("codex"), false);
  assert.equal(harnessUsesMcpJson("opencode"), false);
});
