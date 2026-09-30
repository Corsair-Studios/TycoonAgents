/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { hasMcpServer, mergeMcpServer, removeMcpServer, resolveConfigForPlatform } from "../src/host/vscode/mcpCatalog";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

test("removeMcpServer deletes the target server", () => {
  const input: Record<string, unknown> = { mcpServers: { github: cfg } };
  const result = removeMcpServer(input, "github");
  assert.equal(hasMcpServer(result, "github"), false);
});

test("removeMcpServer preserves other servers", () => {
  const playwrightCfg = { command: "npx", args: ["-y", "@playwright/mcp@latest"] };
  const input: Record<string, unknown> = { mcpServers: { github: cfg, playwright: playwrightCfg } };
  const result = removeMcpServer(input, "github");
  const servers = result.mcpServers as Record<string, unknown>;
  assert.equal(hasMcpServer(result, "github"), false);
  assert.deepEqual(servers["playwright"], playwrightCfg, "unrelated server must be preserved");
});

test("removeMcpServer keeps { mcpServers: {} } shape when emptied", () => {
  const input: Record<string, unknown> = { mcpServers: { github: cfg } };
  const result = removeMcpServer(input, "github");
  assert.deepEqual(result.mcpServers, {}, "mcpServers must remain an empty object");
});

test("removeMcpServer preserves unrelated top-level keys", () => {
  const input: Record<string, unknown> = { mcpServers: { github: cfg }, someOtherKey: 42 };
  const result = removeMcpServer(input, "github");
  assert.equal(result.someOtherKey, 42, "top-level keys must be preserved");
});

test("removeMcpServer is a no-op for a missing server", () => {
  const input: Record<string, unknown> = { mcpServers: { playwright: {} } };
  const result = removeMcpServer(input, "github");
  assert.deepEqual(result.mcpServers, { playwright: {} });
});

test("removeMcpServer tolerates missing mcpServers", () => {
  const result = removeMcpServer({}, "github");
  assert.deepEqual(result.mcpServers, {});
});

test("removeMcpServer does not mutate input", () => {
  const input: Record<string, unknown> = { mcpServers: { github: cfg } };
  const originalRef = input.mcpServers;
  removeMcpServer(input, "github");
  assert.equal(input.mcpServers, originalRef, "input.mcpServers reference must not change");
  assert.equal(hasMcpServer(input, "github"), true, "input must still contain the server");
});

const platformEntry = {
  id: "demo",
  config: { type: "stdio" },
  platforms: {
    win32: { command: "cmd.exe", args: ["/c", "x.bat"] },
    darwin: { command: "/mac/bin" },
  },
};

test("resolveConfigForPlatform merges the platform override over the base config", () => {
  const r = resolveConfigForPlatform(platformEntry, "win32");
  assert.deepEqual(r, { ok: true, config: { type: "stdio", command: "cmd.exe", args: ["/c", "x.bat"] } });
  const m = resolveConfigForPlatform(platformEntry, "darwin");
  assert.deepEqual(m, { ok: true, config: { type: "stdio", command: "/mac/bin", args: [] } });
});

test("resolveConfigForPlatform falls back to base config when there is no override but the base is usable", () => {
  const e = { id: "b", config: { command: "npx", args: ["-y", "x"] }, platforms: { win32: { command: "cmd.exe" } } };
  assert.deepEqual(resolveConfigForPlatform(e, "linux"), { ok: true, config: e.config });
  const plain = { id: "p", config: { command: "node" } };
  assert.deepEqual(resolveConfigForPlatform(plain, "linux"), { ok: true, config: plain.config });
});

test("resolveConfigForPlatform reports an explicit unsupported result when no override and no usable base", () => {
  const r = resolveConfigForPlatform(platformEntry, "linux");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /demo.*not supported on this OS \(linux\)/);
});

test("catalog: roblox-studio is unsupported on linux and unity-ai-assistant has no ~ or drive path", () => {
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "media", "mcp", "catalog.json"), "utf8"));
  const roblox = cat.find((e: { id: string }) => e.id === "roblox-studio");
  assert.equal(resolveConfigForPlatform(roblox, "linux").ok, false);
  assert.equal(resolveConfigForPlatform(roblox, "win32").ok, true);
  const unity = cat.find((e: { id: string }) => e.id === "unity-ai-assistant");
  for (const p of ["win32", "darwin", "linux"]) {
    const r = resolveConfigForPlatform(unity, p);
    assert.equal(r.ok, true);
    if (r.ok) assert.doesNotMatch(String((r.config as { command: string }).command), /^~|^[A-Za-z]:[\\/]/);
  }
});

test("simulated install path skips an unsupported OS with a message and never writes .mcp.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcpPlatform-"));
  const mcpPath = path.join(root, ".mcp.json");
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "media", "mcp", "catalog.json"), "utf8"));
  const entry = cat.find((e: { id: string }) => e.id === "roblox-studio");
  // Mirrors panel.ts/standalone: resolve first, skip with message when unsupported.
  const res = resolveConfigForPlatform(entry, "linux");
  let message: string | undefined;
  if (!res.ok) {
    message = res.error;
  } else {
    fs.writeFileSync(mcpPath, JSON.stringify(mergeMcpServer({}, entry.id, res.config)));
  }
  assert.match(message ?? "", /roblox-studio is not supported on this OS/);
  assert.equal(fs.existsSync(mcpPath), false);
  fs.rmSync(root, { recursive: true, force: true });
});
