/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for the "codex" entry added to media/mcp/catalog.json (~132-146).
// This is a static data file, not a compiled module, so it's read directly
// off disk with fs.readFileSync/JSON.parse the way other catalog tests
// (test/mcpCatalog.test.ts) exercise catalog-shaped data.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const CATALOG_PATH = path.join(process.cwd(), "media", "mcp", "catalog.json");
const MCP_JSON_EXAMPLE_PATH = path.join(process.cwd(), ".mcp.json.example");

interface CatalogEntry {
  id: string;
  network?: boolean;
  thirdParty?: boolean;
  dataNote?: string;
  config?: { command?: string; args?: string[] };
  [key: string]: unknown;
}

function loadCatalog(): CatalogEntry[] {
  const raw = fs.readFileSync(CATALOG_PATH, "utf8");
  return JSON.parse(raw) as CatalogEntry[];
}

test("media/mcp/catalog.json parses as valid JSON", () => {
  assert.doesNotThrow(() => loadCatalog(), "catalog.json must be valid JSON");
});

test("codex entry exists with network:true, thirdParty:true, and a non-empty dataNote", () => {
  const catalog = loadCatalog();
  const entry = catalog.find((e) => e.id === "codex");
  assert.ok(entry, "catalog must contain an entry with id \"codex\"");
  assert.equal(entry!.network, true, "codex entry must declare network:true — it calls out to OpenAI");
  assert.equal(entry!.thirdParty, true, "codex entry must declare thirdParty:true — non-Anthropic vendor");
  assert.equal(typeof entry!.dataNote, "string");
  assert.ok(entry!.dataNote!.trim().length > 0, "dataNote must be non-empty");
});

test("codex entry's config.args include an explicit model/config override mechanism", () => {
  const catalog = loadCatalog();
  const entry = catalog.find((e) => e.id === "codex");
  assert.ok(entry, "catalog must contain an entry with id \"codex\"");
  const args = entry!.config?.args ?? [];

  // Assert on the PRESENCE of the override mechanism (a "-c" flag followed
  // by a model= assignment), not the specific model slug, so this test
  // survives the slug changing later.
  const hasConfigOverrideFlag = args.some((a) => a === "-c");
  assert.ok(hasConfigOverrideFlag, "config.args must include a \"-c\" config-override flag");

  const hasModelOverrideValue = args.some((a) => /^model\s*=/.test(a));
  assert.ok(
    hasModelOverrideValue,
    "config.args must include a model=... override value alongside a \"-c\" flag",
  );
});

test("codex entry's config.command/args launch node .claude/hooks/codex-mcp-launcher.cjs (the bridge, not the removed `codex mcp-server` subcommand)", () => {
  const catalog = loadCatalog();
  const entry = catalog.find((e) => e.id === "codex");
  assert.ok(entry, "catalog must contain an entry with id \"codex\"");
  assert.equal(entry!.config?.command, "node", "must launch via node, not a bare `codex` invocation");
  const args = entry!.config?.args ?? [];
  assert.equal(args[0], ".claude/hooks/codex-mcp-launcher.cjs", "first arg must be the project-relative launcher script path");
});

test(".mcp.json.example's codex server entry also launches .claude/hooks/codex-mcp-launcher.cjs", () => {
  const raw = fs.readFileSync(MCP_JSON_EXAMPLE_PATH, "utf8");
  const parsed = JSON.parse(raw) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
  const servers = parsed.mcpServers ?? {};
  const codexServer = servers["codex"];
  assert.ok(codexServer, ".mcp.json.example must define a \"codex\" mcpServers entry");
  assert.equal(codexServer!.command, "node");
  assert.ok(
    (codexServer!.args ?? []).some((a) => a.includes("codex-mcp-launcher.cjs")),
    ".mcp.json.example's codex entry must launch codex-mcp-launcher.cjs",
  );
});
