/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureTycoonGitignore, tycoonGitignoreEntries, GITIGNORE_BEGIN, GITIGNORE_END } from "../src/core/tycoonGitignore";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-gi-"));
}

test("no .git means no .gitignore is created", () => {
  const root = tmp();
  try {
    assert.equal(ensureTycoonGitignore(root), "no-git");
    assert.equal(fs.existsSync(path.join(root, ".gitignore")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writes one managed block, keeps user lines, and is idempotent", () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\nmy-secret.txt");
    assert.equal(ensureTycoonGitignore(root), "written");
    const first = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    assert.ok(first.startsWith("node_modules/\nmy-secret.txt\n"));
    assert.equal(first.split(GITIGNORE_BEGIN).length, 2);
    assert.ok(first.includes(".claude/tycoon/activity.jsonl"));
    assert.ok(first.includes(".claude/hooks/tycoon-dispatcher-mcp.cjs"));
    assert.equal(ensureTycoonGitignore(root), "unchanged");
    assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("creates .gitignore when .git exists and none does", () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, ".git"));
    assert.equal(ensureTycoonGitignore(root), "written");
    assert.ok(fs.existsSync(path.join(root, ".gitignore")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shared project files are never ignored", () => {
  const entries = tycoonGitignoreEntries();
  for (const shared of ["plan.json", "routing.json", "agent-keywords.json", "execution.json", "team-setup-applied.json"]) {
    assert.ok(!entries.includes(`.claude/tycoon/${shared}`), shared);
  }
  assert.ok(!entries.some((e) => e === ".claude/" || e === ".claude/tycoon/" || e === ".claude/hooks/" || e.includes("plans")));
  assert.ok(entries.includes(".claude/tycoon/*.bak") && entries.includes(".claude/tycoon/hooks-changed.json"));
});

test("a stale managed block is refreshed in place without touching surrounding lines", () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, ".gitignore"), `a\n${GITIGNORE_BEGIN}\n.claude/old\n${GITIGNORE_END}\nz\n`);
    assert.equal(ensureTycoonGitignore(root), "written");
    const out = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    assert.ok(out.startsWith("a\n") && out.endsWith("\nz\n"));
    assert.ok(!out.includes(".claude/old"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
