/*
 * An invalid routing pattern (markdown/prose from older products, or a
 * non-string) must never break routing: the hook skips that one pattern and
 * the keyword lint reports it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeKeywordHealth } from "../src/core/keywordHealth";
import { matchAgentFromKeywords } from "../src/core/delegationEnforcement";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const codexRouting = require(require("node:path").join(process.cwd(), "hooks", "codexRouting.cjs"));

const PROSE =
  "**Primary:** search, find, look, where **Secondary:** file, pattern **Important:** The hooks route based on these keywords.";

const CONFIG = {
  fallback_agent: "primary-agent",
  agents: {
    "search-retrieval": { pattern: PROSE },
    "broken-agent": { pattern: 42 },
    "coding-specialist": { pattern: "implement|code|fix|bug" },
  },
};

test("hook: invalid patterns do not crash routing, the warning is logged once per agent, valid patterns still route", () => {
  const root = mkdtempSync(join(tmpdir(), "tycoon-invalid-pattern-"));
  try {
    const agentsDir = join(root, ".claude", "agents");
    const tycoonDir = join(root, ".claude", "tycoon");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(tycoonDir, { recursive: true });
    for (const id of ["search-retrieval", "coding-specialist", "broken-agent"]) {
      writeFileSync(join(agentsDir, `${id}.md`), `---\ndescription: ${id}\nmodel: sonnet\n---\nBody.\n`, "utf8");
    }
    writeFileSync(join(tycoonDir, "agent-keywords.json"), JSON.stringify(CONFIG), "utf8");

    const result = spawnSync(process.execPath, [join(process.cwd(), "hooks", "tycoon-claude-hook.cjs")], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: { subagent_type: "general-purpose", description: "fix the bug", prompt: "fix the bug" },
        session_id: "invalid-pattern-session",
      }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(result.status, 0, `hook exited non-zero: ${result.stderr}`);
    const warnings = result.stderr.split("\n").filter((l) => l.includes("routing pattern for"));
    assert.equal(warnings.filter((l) => l.includes('"search-retrieval"')).length, 1);
    assert.equal(warnings.filter((l) => l.includes('"broken-agent"')).length, 1);
    assert.equal(warnings.filter((l) => l.includes('"coding-specialist"')).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const MIXED = { agents: { a: { pattern: "**Primary:** x, y|code|fix" }, b: { pattern: "c++|code|fix" } } };

test("hook, core and codexRouting agree: c++ pattern and mixed markdown pattern still route on good words", () => {
  const plus = { agents: { b: { pattern: "c++|code|fix" } } };
  const mixed = { agents: { a: { pattern: "**Primary:** long prose here|code|fix" } } };
  for (const [cfg, text] of [[plus, "update the code"], [mixed, "fix it"]] as const) {
    const core = matchAgentFromKeywords(text, cfg as any);
    const codex = codexRouting.matchAgentFromKeywords(text, cfg);
    assert.ok(core && codex);
    assert.deepEqual(codex, core);
  }
  assert.equal(matchAgentFromKeywords("code", MIXED as any)!.agentId, "a");
});

test("matchAgentFromKeywords: skips invalid patterns and still matches a valid one", () => {
  const m = matchAgentFromKeywords("please fix this and search", CONFIG as any);
  assert.ok(m);
  assert.equal(m!.agentId, "coding-specialist");
});

test("computeKeywordHealth: reports markdown segments as invalid_pattern", () => {
  const config = {
    agents: {
      "search-retrieval": { pattern: PROSE },
      "bad-regex": { pattern: "foo|**Primary:** bar" },
      "coding-specialist": { pattern: "implement|code" },
    },
  };
  const ids = ["search-retrieval", "bad-regex", "coding-specialist"].map((id) => ({ id, keywords: "" }));
  const invalid = computeKeywordHealth(ids, config, {}).filter((f) => f.kind === "invalid_pattern");
  assert.deepEqual(invalid.map((f) => f.agentId).sort(), ["bad-regex", "search-retrieval"]);
  assert.match(invalid[0].detail, /ignore/);
});
