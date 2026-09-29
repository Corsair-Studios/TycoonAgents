import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LATEST_MODEL_IDS, MODEL_ALIASES, resolveModelAlias } from "../src/core/modelAliases";

const hookSrc = readFileSync(join(process.cwd(), "hooks", "tycoon-claude-hook.cjs"), "utf8");

test("fable alias resolves through LATEST_MODEL_IDS; opus/sonnet/haiku stay bare aliases", () => {
  assert.equal(MODEL_ALIASES.fable, LATEST_MODEL_IDS.fable);
  assert.equal(resolveModelAlias("fable"), "claude-fable-5-1");
  for (const a of ["opus", "sonnet", "haiku"]) assert.equal(resolveModelAlias(a), a);
});

test("the hook's legacy SHORTHAND_MODEL fallback copy matches modelAliases.ts", () => {
  const block = /const SHORTHAND_MODEL = \{([\s\S]*?)\};/.exec(hookSrc);
  assert.ok(block, "SHORTHAND_MODEL not found in hook");
  const entries = [...block[1].matchAll(/"(\w+)":\s*"([^"]+)"/g)];
  const table = Object.fromEntries(entries.map((m) => [m[1], m[2]]));
  assert.deepEqual(table, { ...MODEL_ALIASES });
});

test("the hook's MODEL_DEFAULTS pin no model version", () => {
  const block = /const MODEL_DEFAULTS = \{([\s\S]*?)\};/.exec(hookSrc);
  assert.ok(block, "MODEL_DEFAULTS not found in hook");
  for (const m of block[1].matchAll(/"[\w-]+":\s*"([^"]+)"/g)) {
    assert.ok(["opus", "sonnet", "haiku", "fable"].includes(m[1]), `default ${m[1]} must be an alias`);
  }
});
