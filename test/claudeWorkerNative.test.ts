/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describeBackendSetup } from "../src/core/bridgeSetup";
import { healClaudeWorkerBody, buildAgentMarkdown, FOREIGN_LLM_AGENTS } from "../src/host/vscode/packCatalog";
import { reconcileAgentKeywords } from "../src/host/vscode/agentKeywordDefaults";
import { setKeywordPattern } from "../src/host/vscode/agentConfig";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const worker = FOREIGN_LLM_AGENTS.find((a) => a.id === "claude-worker")!;

// ---------------------------------------------------------------------------
// describeBackendSetup
// ---------------------------------------------------------------------------

function ctx(harness: string) {
  return { root: os.tmpdir(), harness, env: {} as NodeJS.ProcessEnv, probe: () => ({}), mcpConfig: {} };
}

test("describeBackendSetup: anthropic claude-worker on claude-code has no badge", () => {
  assert.equal(describeBackendSetup(worker.backend!, ctx("claude-code")), null);
  assert.equal(describeBackendSetup(worker.backend!, ctx("")), null);
});

test("describeBackendSetup: claude-worker keeps the claude-cli bridge requirement on codex and opencode", () => {
  for (const h of ["codex", "opencode"]) {
    const info = describeBackendSetup(worker.backend!, ctx(h));
    assert.ok(info, h);
    assert.equal(info!.server, "claude-cli", h);
  }
});

test("describeBackendSetup: foreign vendors on claude-code are unchanged", () => {
  for (const id of ["codex-reviewer", "gemini-reviewer", "kimi-reviewer"]) {
    const a = FOREIGN_LLM_AGENTS.find((x) => x.id === id)!;
    const info = describeBackendSetup(a.backend!, ctx("claude-code"));
    assert.ok(info, id);
  }
});

// ---------------------------------------------------------------------------
// healClaudeWorkerBody
// ---------------------------------------------------------------------------

function legacyBody(): string {
  return worker
    .body!.replace(/^## Which route\n[\s\S]*?(?=^## )/m, "")
    .replace("On the bridge route, use the `claude` tool. Always pass:", "Use the `claude` tool. Always pass:");
}

function installed(body: string, eol = "\n"): string {
  const md = buildAgentMarkdown(worker, "multi-llm");
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(md)![0];
  return (fm + `\n# ${worker.name}\n\n` + body).replace(/\r?\n/g, eol);
}

test("healClaudeWorkerBody: the exact previously shipped body heals to the current one", () => {
  const healed = healClaudeWorkerBody(installed(legacyBody()));
  assert.ok(healed);
  assert.match(healed!, /^## Which route/m);
  assert.equal(healed, installed(worker.body!));
  assert.equal(healClaudeWorkerBody(healed!), null);
});

test("healClaudeWorkerBody: CRLF input heals and stays CRLF", () => {
  const healed = healClaudeWorkerBody(installed(legacyBody(), "\r\n"));
  assert.ok(healed);
  assert.match(healed!, /^## Which route/m);
  assert.equal(healed!.replace(/\r\n/g, "\n").includes("\r"), false);
  assert.equal(healed, installed(worker.body!, "\r\n"));
});

test("healClaudeWorkerBody: user-edited, current, and unmarked bodies return null", () => {
  assert.equal(healClaudeWorkerBody(installed(legacyBody() + "\nMy own rule.\n")), null);
  assert.equal(healClaudeWorkerBody(installed(worker.body!)), null);
  assert.equal(healClaudeWorkerBody(installed(legacyBody()).replace(/^tycoon_pack: .*\r?\n/m, "")), null);
});

// ---------------------------------------------------------------------------
// generate-opencode-config.mjs
// ---------------------------------------------------------------------------

test("generate-opencode-config: claude-worker mcp agent drops 'Which route' and keeps the always-call-claude preamble", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-worker-gen-"));
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-worker-gen-cfg-"));
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "agents", "claude-worker.md"), buildAgentMarkdown(worker, "multi-llm"), "utf8");
  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "generate-opencode-config.mjs"), "--root", root], {
    encoding: "utf8",
    env: { ...process.env, OPENCODE_CONFIG_DIR: cfgDir, TYCOON_STANDALONE_DATA_DIR: cfgDir },
  });
  assert.equal(res.status, 0, res.stderr);
  const out = fs.readFileSync(path.join(root, ".opencode", "agents", "claude-worker.md"), "utf8");
  assert.doesNotMatch(out, /^## Which route/m);
  assert.doesNotMatch(out, /run natively as a normal Claude subagent/);
  assert.match(out, /This agent runs through the `claude-cli` MCP server\. Call its `claude` tool for every model request/);
  assert.match(out, /^## Calling the claude CLI/m);
});

// ---------------------------------------------------------------------------
// Keyword order: primary-agent stays last
// ---------------------------------------------------------------------------

test("reconcileAgentKeywords: newly added agents land before primary-agent", () => {
  const config = { agents: { a: { pattern: "x" }, "primary-agent": { pattern: "y" } } };
  const { config: out, added } = reconcileAgentKeywords(
    config,
    [{ id: "a", keywords: null }, { id: "primary-agent", keywords: null }, { id: "b", keywords: "bb" }, { id: "c", keywords: "cc" }],
    {}
  );
  assert.deepEqual(added, ["b", "c"]);
  const keys = Object.keys(out.agents);
  assert.equal(keys[keys.length - 1], "primary-agent");
  assert.deepEqual(keys.slice().sort(), ["a", "b", "c", "primary-agent"]);
});

test("setKeywordPattern: a new key lands before primary-agent; an existing key keeps its position", () => {
  const config = { agents: { a: { pattern: "x" }, "primary-agent": { pattern: "y" } } };
  const added = setKeywordPattern(config, "b", "bb");
  assert.deepEqual(Object.keys(added.agents), ["a", "b", "primary-agent"]);
  assert.equal(added.agents.b.pattern, "bb");
  const edited = setKeywordPattern(added, "a", "xx");
  assert.deepEqual(Object.keys(edited.agents), ["a", "b", "primary-agent"]);
  const noCatchAll = setKeywordPattern({ agents: { a: { pattern: "x" } } }, "b", "bb");
  assert.deepEqual(Object.keys(noCatchAll.agents), ["a", "b"]);
});
