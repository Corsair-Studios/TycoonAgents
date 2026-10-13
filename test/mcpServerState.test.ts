import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never let a test reach the real Claude config (~/.claude.json) or the real `claude` binary.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-claude-cfg-"));
process.env.TYCOON_CLAUDE_BIN = "none";

import { BRIDGE_PACK_ID, buildBridgePicker, describeBackendSetup, mcpServerState } from "../src/core/bridgeSetup";
import type { PackAgent } from "../src/host/vscode/packCatalog";

/*
 * mcpServerState is the single rule for "is this MCP server installed": on the Claude Code
 * harness only a Claude local-scope registration counts, a server found only in .mcp.json is
 * "pending"; on other harnesses .mcp.json membership alone means installed.
 */

const REPO = process.cwd();
const PACK = (JSON.parse(fs.readFileSync(path.join(REPO, "media", "packs", "catalog.json"), "utf8")) as any[]).find((p) => p.id === BRIDGE_PACK_ID);
const PACK_AGENTS: PackAgent[] = PACK.agents;
const CODEX_AGENT = PACK_AGENTS.find((a) => a.id === "codex-reviewer")!;

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-state-"));
}
function writeMcpJson(root: string, ids: string[]): void {
  fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(ids.map((i) => [i, { command: "node", args: [] }])) }));
}
/** Register servers at Claude local scope for `root` in the temp CLAUDE_CONFIG_DIR. */
function registerLocalScope(root: string, ids: string[]): void {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR as string, ".claude.json");
  const cfg = { projects: { [root.split(String.fromCharCode(92)).join("/")]: { mcpServers: Object.fromEntries(ids.map((i) => [i, { command: "node", args: [] }])) } } };
  fs.writeFileSync(file, JSON.stringify(cfg));
}
function clearLocalScope(): void {
  fs.rmSync(path.join(process.env.CLAUDE_CONFIG_DIR as string, ".claude.json"), { force: true });
}

test("claude-code: local scope only means installed", () => {
  const root = tmpProject();
  try {
    registerLocalScope(root, ["playwright"]);
    assert.equal(mcpServerState(root, "claude-code", "playwright"), "installed");
  } finally {
    clearLocalScope();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("claude-code: present only in .mcp.json means pending", () => {
  const root = tmpProject();
  try {
    clearLocalScope();
    writeMcpJson(root, ["playwright"]);
    assert.equal(mcpServerState(root, "claude-code", "playwright"), "pending");
    // Another server registered locally does not make this one installed.
    registerLocalScope(root, ["codex"]);
    assert.equal(mcpServerState(root, "claude-code", "playwright"), "pending");
  } finally {
    clearLocalScope();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("claude-code: present in neither means absent (including a missing or invalid .mcp.json)", () => {
  const root = tmpProject();
  try {
    clearLocalScope();
    assert.equal(mcpServerState(root, "claude-code", "playwright"), "absent");
    fs.writeFileSync(path.join(root, ".mcp.json"), "{ not json");
    assert.equal(mcpServerState(root, "claude-code", "playwright"), "absent");
    writeMcpJson(root, ["other"]);
    assert.equal(mcpServerState(root, "claude-code", "playwright"), "absent");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("claude-code: present in both local scope and .mcp.json means installed", () => {
  const root = tmpProject();
  try {
    writeMcpJson(root, ["playwright"]);
    registerLocalScope(root, ["playwright"]);
    assert.equal(mcpServerState(root, "claude-code", "playwright"), "installed");
  } finally {
    clearLocalScope();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("claude-code: a supplied fileConfig is used instead of reading .mcp.json", () => {
  const root = tmpProject();
  try {
    clearLocalScope();
    assert.equal(mcpServerState(root, "claude-code", "playwright", { mcpServers: { playwright: {} } }), "pending");
    writeMcpJson(root, ["playwright"]);
    assert.equal(mcpServerState(root, "claude-code", "playwright", {}), "absent");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("codex and opencode: .mcp.json membership means installed and local scope is ignored", () => {
  for (const harness of ["codex", "opencode"]) {
    const root = tmpProject();
    try {
      clearLocalScope();
      writeMcpJson(root, ["playwright"]);
      assert.equal(mcpServerState(root, harness, "playwright"), "installed", harness);
      assert.equal(mcpServerState(root, harness, "missing-one"), "absent", harness);
      // Local scope alone does not count off the Claude Code harness, and "pending" never occurs.
      fs.rmSync(path.join(root, ".mcp.json"));
      registerLocalScope(root, ["playwright"]);
      assert.equal(mcpServerState(root, harness, "playwright"), "absent", harness);
    } finally {
      clearLocalScope();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("describeBackendSetup: a pending server needs setup and is neither installed nor missing", () => {
  const root = tmpProject();
  try {
    clearLocalScope();
    writeMcpJson(root, ["codex"]);
    const ctx = { root, harness: "claude-code", env: {} as NodeJS.ProcessEnv, probe: () => ({}) };
    const pending = describeBackendSetup(CODEX_AGENT.backend, ctx)!;
    assert.equal(pending.server, "codex");
    assert.equal(pending.serverState, "pending");
    assert.equal(pending.needsSetup, true);
    assert.match(pending.reasons.join(" "), /not enabled in Claude Code/);

    registerLocalScope(root, ["codex"]);
    const installed = describeBackendSetup(CODEX_AGENT.backend, ctx)!;
    assert.equal(installed.serverState, "installed");
    assert.equal(installed.needsSetup, false);

    // The codex harness uses the dispatcher: never pending.
    clearLocalScope();
    assert.equal(describeBackendSetup(CODEX_AGENT.backend, { ...ctx, harness: "codex" })!.serverState, "dispatcher");
  } finally {
    clearLocalScope();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildBridgePicker: a pending server marks the model as needing setup, not enabled", () => {
  const root = tmpProject();
  try {
    clearLocalScope();
    writeMcpJson(root, ["codex"]);
    fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "agents", "codex-reviewer.md"), "---\nname: codex-reviewer\n---\n");
    const p = buildBridgePicker(PACK_AGENTS, { root, harness: "claude-code", env: {}, probe: () => ({}) });
    const codex = p.models.find((m) => m.agentId === "codex-reviewer")!;
    assert.equal(codex.installed, true, "agent file exists");
    assert.equal(codex.setup!.serverState, "pending");
    assert.equal(codex.setup!.needsSetup, true);

    registerLocalScope(root, ["codex"]);
    const after = buildBridgePicker(PACK_AGENTS, { root, harness: "claude-code", env: {}, probe: () => ({}) });
    assert.equal(after.models.find((m) => m.agentId === "codex-reviewer")!.setup!.serverState, "installed");
  } finally {
    clearLocalScope();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
