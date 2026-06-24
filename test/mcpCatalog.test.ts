/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { hasMcpServer, mergeMcpServer } from "../src/host/vscode/mcpCatalog";

const cfg = { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] };

test("mergeMcpServer adds server to empty object", () => {
  const result = mergeMcpServer({}, "github", cfg);
  const servers = result.mcpServers as Record<string, unknown>;
  assert.deepEqual(servers["github"], cfg);
});

test("mergeMcpServer preserves existing unrelated server", () => {
  const existingCfg = { command: "npx", args: ["-y", "@playwright/mcp@latest"] };
  const input: Record<string, unknown> = { mcpServers: { playwright: existingCfg } };
  const result = mergeMcpServer(input, "github", cfg);
  const servers = result.mcpServers as Record<string, unknown>;
  assert.deepEqual(servers["playwright"], existingCfg, "existing server must be preserved");
  assert.deepEqual(servers["github"], cfg, "new server must be added");
});

test("mergeMcpServer does not mutate input object", () => {
  const input: Record<string, unknown> = {};
  mergeMcpServer(input, "github", cfg);
  assert.equal(input.mcpServers, undefined, "input must not gain mcpServers");
});

test("mergeMcpServer does not mutate input.mcpServers reference", () => {
  const existingServers = { playwright: { command: "npx" } };
  const input: Record<string, unknown> = { mcpServers: existingServers };
  const originalRef = input.mcpServers;
  mergeMcpServer(input, "github", cfg);
  assert.equal(input.mcpServers, originalRef, "input.mcpServers reference must not be replaced");
  assert.deepEqual(input.mcpServers, existingServers, "original mcpServers must be unchanged");
});

test("hasMcpServer: true when present", () => {
  const input: Record<string, unknown> = { mcpServers: { github: cfg } };
  assert.equal(hasMcpServer(input, "github"), true);
});

test("hasMcpServer: false when absent", () => {
  const input: Record<string, unknown> = { mcpServers: { playwright: {} } };
  assert.equal(hasMcpServer(input, "github"), false);
});

test("hasMcpServer: false when mcpServers missing", () => {
  assert.equal(hasMcpServer({}, "github"), false);
});
