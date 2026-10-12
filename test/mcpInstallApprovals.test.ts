import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { isUnpinnedMcpConfig, mergeMcpServer } from "../src/host/vscode/mcpCatalog";

test("isUnpinnedMcpConfig flags @latest and bare npx/uvx packages only", () => {
  assert.equal(isUnpinnedMcpConfig({ command: "npx", args: ["-y", "@playwright/mcp@latest"] }), true);
  assert.equal(isUnpinnedMcpConfig({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] }), true);
  assert.equal(isUnpinnedMcpConfig({ command: "npx.cmd", args: ["-y", "left-pad"] }), true);
  assert.equal(isUnpinnedMcpConfig({ command: "npx", args: ["-y", "@playwright/mcp@0.0.83"] }), false);
  assert.equal(isUnpinnedMcpConfig({ command: "uvx", args: ["blender-mcp"] }), true);
  assert.equal(isUnpinnedMcpConfig({ command: "uvx", args: ["--from", "git+https://x/y.git@v1.0.3#subdirectory=mcp", "blender-mcp"] }), false);
  assert.equal(isUnpinnedMcpConfig({ command: "node", args: ["hooks/x.cjs"] }), false);
  assert.equal(isUnpinnedMcpConfig(undefined), false);
});

test("installing an MCP server never writes approval keys", () => {
  const out = mergeMcpServer({}, "playwright", { command: "npx", args: ["-y", "@playwright/mcp@0.0.83"] });
  assert.deepEqual(Object.keys(out), ["mcpServers"]);
  // Source guard: host install paths must not reference Claude Code approval keys.
  for (const rel of ["src/host/vscode/panel.ts", "src/host/vscode/hookInstall.ts", "src/host/vscode/mcpCatalog.ts", "standalone/src/server.mjs"]) {
    const text = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    assert.ok(!/enabledMcpjsonServers|enableAllProjectMcpServers/.test(text), `${rel} must not write MCP approvals`);
  }
});
