import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never let a test reach the real Claude config (~/.claude.json) or the real `claude` binary.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-claude-cfg-"));
process.env.TYCOON_CLAUDE_BIN = "none";

import { installMcpEntry } from "../src/core/bridgeSetup";
import { renderDelegationDoctrine } from "../src/host/vscode/delegationDoctrine";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HIDDEN_IDS = ["codex", "claude-cli", "gemini", "openai-compatible", "tycoon"];

function loadCatalog(): any[] {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "media", "mcp", "catalog.json"), "utf8"));
}

test("the five bridge servers are flagged hidden in the MCP catalog and nothing else is", () => {
  const hidden = loadCatalog().filter((e) => e.hidden === true).map((e) => e.id).sort();
  assert.deepEqual(hidden, [...HIDDEN_IDS].sort());
});

test("_handleGetMcp (panel.ts) and buildMcpPayload (standalone) both filter hidden entries before mapping", () => {
  const panel = fs.readFileSync(path.join(REPO_ROOT, "src", "host", "vscode", "panel.ts"), "utf8");
  const handler = panel.slice(panel.indexOf("private _handleGetMcp(): void"));
  const handlerBody = handler.slice(0, handler.indexOf("MSG.MCP, servers }"));
  assert.match(handlerBody, /catalog\.filter\(\(e\) => e\.hidden !== true\)\.map\(/);

  const server = fs.readFileSync(path.join(REPO_ROOT, "standalone", "src", "server.mjs"), "utf8");
  const fn = server.slice(server.indexOf("function buildMcpPayload()"));
  const fnBody = fn.slice(0, fn.indexOf("function buildPacksPayload()"));
  assert.match(fnBody, /catalog\.filter\(\(e\) => e && e\.hidden !== true\)\.map\(/);
});

test("the hidden-id filter used by both hosts leaves no bridge id in the visible list", () => {
  const visible = loadCatalog().filter((e) => e.hidden !== true).map((e) => e.id);
  for (const id of HIDDEN_IDS) assert.ok(!visible.includes(id), `${id} must not be listed`);
  assert.ok(visible.includes("github"));
});

test("an Agents-screen bridge install still resolves a hidden catalog entry", async () => {
  const catalog = loadCatalog();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hidden-bridge-"));
  try {
    for (const id of HIDDEN_IDS) {
      const out: any = await installMcpEntry(root, id, catalog, {
        platform: "win32",
        resolveTokens: (c: unknown) => c,
        finalize: (_i: string, c: unknown) => c,
        afterWrite: () => {},
      } as any);
      const err = typeof out === "object" && out ? String(out.error ?? "") : "";
      assert.ok(!/catalog entry not found/.test(err), `${id} must resolve from the catalog, got: ${JSON.stringify(out)}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no visible MCP entry summary exceeds 200 characters", () => {
  for (const e of loadCatalog().filter((x) => x.hidden !== true)) {
    assert.ok(typeof e.summary === "string" && e.summary.length > 0 && e.summary.length <= 200, `${e.id} summary length ${e.summary?.length}`);
  }
});

test("doctrine worker rules forbid background tests and builds, in both modes", () => {
  const rule = "Never start tests, builds, or other long commands in the background.";
  for (const mode of ["flat", "team_leads"] as const) {
    const out = renderDelegationDoctrine(mode).replace(/\s+/g, " ");
    assert.ok(out.includes(rule), `${mode} doctrine must contain the background rule`);
    assert.ok(out.includes("split longer work into sequential foreground calls"), `${mode} doctrine must contain the split clause`);
  }
});
