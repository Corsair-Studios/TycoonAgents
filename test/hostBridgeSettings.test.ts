import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildHostBridgeInfo,
  describeExternalSettings,
  readGeminiBackend,
  readMcpJson,
  setGeminiBackend,
} from "../src/core/hostBridgeSettings";
import { buildRoutingView } from "../src/core/routingHostOps";
import { isFallbackTargetDispatchable } from "../src/core/fallbackTargets";

function tmpProject(mcp?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hostbridge-"));
  if (mcp !== undefined) fs.writeFileSync(path.join(root, ".mcp.json"), mcp);
  return root;
}

const BASE = {
  mcpServers: {
    codex: { command: "node", args: ["a.cjs"], env: { CODEX_MCP_TIMEOUT_MS: "900000" } },
    gemini: { command: "node", args: ["g.cjs"] },
    other: { command: "x" },
  },
};

test("readGeminiBackend: absent means agy (wrapper default); set value is read back", () => {
  const root = tmpProject(JSON.stringify(BASE, null, 2));
  assert.deepEqual(readGeminiBackend(readMcpJson(root)), { serverPresent: true, value: "agy", source: "default" });
  assert.equal(setGeminiBackend(root, "gemini").ok, true);
  assert.deepEqual(readGeminiBackend(readMcpJson(root)), { serverPresent: true, value: "gemini", source: "mcp-json" });
  assert.equal(readGeminiBackend(readMcpJson(tmpProject())).serverPresent, false);
});

test("setGeminiBackend changes only GEMINI_MCP_BACKEND and keeps indent, order, CRLF and trailing newline", () => {
  const text = JSON.stringify(BASE, null, "\t").replace(/\n/g, "\r\n") + "\r\n";
  const root = tmpProject(text);
  assert.equal(setGeminiBackend(root, "gemini").ok, true);
  const after = fs.readFileSync(path.join(root, ".mcp.json"), "utf8");
  assert.ok(after.endsWith("}\r\n"), "CRLF + trailing newline kept");
  assert.ok(/\r\n\t"mcpServers"/.test(after), "tab indent kept");
  const parsed = JSON.parse(after);
  assert.equal(parsed.mcpServers.gemini.env.GEMINI_MCP_BACKEND, "gemini");
  delete parsed.mcpServers.gemini.env;
  assert.deepEqual(parsed, BASE, "everything else identical");
  assert.deepEqual(Object.keys(parsed.mcpServers), ["codex", "gemini", "other"]);

  fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { gemini: { env: { KEEP: "1" } } } }, null, 2));
  assert.equal(setGeminiBackend(root, "agy").ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")).mcpServers.gemini.env, { KEEP: "1", GEMINI_MCP_BACKEND: "agy" });
});

test("setGeminiBackend refuses bad values, a missing gemini server and invalid JSON without writing", () => {
  assert.equal(setGeminiBackend(tmpProject(JSON.stringify(BASE)), "nope").ok, false);
  const noGem = tmpProject(JSON.stringify({ mcpServers: { codex: {} } }));
  const r = setGeminiBackend(noGem, "gemini");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /gemini/);
  const bad = tmpProject("{ not json");
  assert.equal(setGeminiBackend(bad, "gemini").ok, false);
  assert.equal(fs.readFileSync(path.join(bad, ".mcp.json"), "utf8"), "{ not json");
  assert.equal(setGeminiBackend(tmpProject(), "gemini").ok, false);
});

test("describeExternalSettings: default, environment and .mcp.json sources with server names", () => {
  const root = tmpProject(JSON.stringify(BASE));
  const list = describeExternalSettings(readMcpJson(root), { TYCOON_AGY_PATH: "C:/agy.exe", TYCOON_BRIDGE_TIMEOUT_MS: "1000" });
  const by = Object.fromEntries(list.map((s) => [s.name, s]));
  assert.deepEqual(
    list.map((s) => s.name),
    ["TYCOON_BRIDGE_TIMEOUT_MS", "TYCOON_DISPATCH_STEP_TIMEOUT_MS", "CODEX_MCP_TIMEOUT_MS", "TYCOON_CODEX_BACKEND", "CODEX_REASONING_EFFORT", "TYCOON_AGY_PATH"]
  );
  assert.equal(by["CODEX_MCP_TIMEOUT_MS"].source, "mcp-json");
  assert.equal(by["CODEX_MCP_TIMEOUT_MS"].server, "codex");
  assert.equal(by["CODEX_MCP_TIMEOUT_MS"].value, "900000");
  assert.equal(by["TYCOON_BRIDGE_TIMEOUT_MS"].source, "environment");
  assert.equal(by["TYCOON_BRIDGE_TIMEOUT_MS"].value, "1000");
  assert.equal(by["TYCOON_DISPATCH_STEP_TIMEOUT_MS"].source, "default");
  assert.equal(by["TYCOON_DISPATCH_STEP_TIMEOUT_MS"].value, "180000");
  assert.equal(by["TYCOON_CODEX_BACKEND"].value, "auto");
  assert.ok(by["CODEX_MCP_TIMEOUT_MS"].where.includes("mcpServers.codex.env"));
  assert.ok(!list.some((s) => /KEY|TOKEN|SECRET/.test(s.name)), "no secret-named settings");
});

test("buildRoutingView carries bridge info and the Codex model presets", () => {
  const root = tmpProject(JSON.stringify(BASE));
  const view = buildRoutingView({ root, env: {} });
  assert.deepEqual(view.bridge.mcpServers, ["codex", "gemini", "other"]);
  assert.equal(view.bridge.gemini.value, "agy");
  const ids = view.presets.models.map((m) => m.id);
  assert.ok(ids.includes("openai/gpt-6.1-sol") && ids.includes("openai/gpt-6-astra") && ids.includes("openai/gpt-6-luna"));
  assert.ok(!ids.includes("openai/gpt-5.6-sol"), "retired id is no longer offered");
  assert.deepEqual(ids.filter((i) => i.startsWith("openai/")), ["openai/gpt-6-astra", "openai/gpt-6.1-sol", "openai/gpt-6-luna"], "most to least capable");
  assert.equal(buildHostBridgeInfo(tmpProject(), {}).mcpJsonPresent, false);
});

test("codex host skips Google with a non-blocking warning", () => {
  const r = isFallbackTargetDispatchable({ vendor: "google" }, "codex", { GEMINI_API_KEY: "x" });
  assert.equal(r.ok, true);
  assert.match(r.reason ?? "", /skipped on the Codex host/);
  assert.equal(isFallbackTargetDispatchable({ vendor: "google" }, "claude-code").ok, true);
});

test("setGeminiBackend: existing key is replaced textually, unrelated compact arrays stay byte-identical", () => {
  const text = '{\n  "mcpServers": {\n    "gemini": { "command": "node", "args": ["a","b"], "env": { "GEMINI_MCP_BACKEND": "agy", "X": "1" } },\n    "o": { "args":[1,2,3] }\n  }\n}\n';
  const root = tmpProject(text);
  assert.equal(setGeminiBackend(root, "gemini").ok, true);
  assert.equal(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"), text.replace('"agy"', '"gemini"'));
  assert.deepEqual(fs.readdirSync(root), [".mcp.json"], "no temp file left behind");
});

test("setGeminiBackend: a concurrent edit between read and write is not lost", () => {
  const root = tmpProject(JSON.stringify(BASE, null, 2));
  const file = path.join(root, ".mcp.json");
  const realFs = require("node:fs");
  const realRead = realFs.readFileSync;
  let reads = 0;
  realFs.readFileSync = (...a: any[]) => {
    const r = (realRead as any)(...a);
    if (a[0] === file && ++reads === 1) {
      const other = JSON.parse(String(r));
      other.mcpServers.extra = { command: "y" };
      fs.writeFileSync(file, JSON.stringify(other, null, 2));
    }
    return r;
  };
  try {
    assert.equal(setGeminiBackend(root, "gemini").ok, true);
  } finally {
    realFs.readFileSync = realRead;
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(parsed.mcpServers.extra, "concurrent addition kept");
  assert.equal(parsed.mcpServers.gemini.env.GEMINI_MCP_BACKEND, "gemini");
});

test("describeExternalSettings never surfaces secret-named settings, even if listed", () => {
  const mk = (name: string) => ({ name, defaultValue: "x", note: "n", servers: ["gemini"] });
  const list = describeExternalSettings(
    readMcpJson(tmpProject(JSON.stringify(BASE))),
    { MY_API_KEY: "s", GH_TOKEN: "s", APP_SECRET: "s" },
    [mk("MY_API_KEY"), mk("GH_TOKEN"), mk("APP_SECRET"), mk("SAFE_NAME")]
  );
  assert.deepEqual(list.map((s) => s.name), ["SAFE_NAME"]);
});
