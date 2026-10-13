import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never let a test reach the real Claude config (~/.claude.json) or the real `claude` binary.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-claude-cfg-"));
process.env.TYCOON_CLAUDE_BIN = "none";

import { BRIDGE_PACK_ID, installBridgeSelection, installMcpEntry } from "../src/core/bridgeSetup";
import type { McpInstallOutcome, OtherAgentSpec } from "../src/core/bridgeSetup";
import { createLocalMcpOps, readLocalMcpServers } from "../src/core/claudeLocalMcp";
import type { LocalMcpOps, LocalMcpOptions } from "../src/core/claudeLocalMcp";
import { isHookWriteActive } from "../src/core/hookWriteGate";
import type { PackAgent } from "../src/host/vscode/packCatalog";

/*
 * Local-scope installs through installMcpEntry / installBridgeSelection: the
 * server is registered at Claude local scope (not .mcp.json), unticking a model
 * removes servers nothing else needs, and the hook-write gate is held for the
 * whole async install.
 */

const REPO = process.cwd();
const PACK = (JSON.parse(fs.readFileSync(path.join(REPO, "media", "packs", "catalog.json"), "utf8")) as any[]).find((p) => p.id === BRIDGE_PACK_ID);
const PACK_AGENTS: PackAgent[] = PACK.agents;
const MCP_CATALOG: any[] = JSON.parse(fs.readFileSync(path.join(REPO, "media", "mcp", "catalog.json"), "utf8"));

interface Fx {
  dir: string;
  root: string;
  hooks: string;
  opts: LocalMcpOptions;
  file: string;
}

function fx(): Fx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-local-"));
  const root = path.join(dir, "proj");
  const hooks = path.join(dir, "ext", "hooks");
  const cfgDir = path.join(dir, "cfg");
  fs.mkdirSync(root);
  fs.mkdirSync(hooks, { recursive: true });
  fs.mkdirSync(cfgDir);
  for (const n of ["codex-mcp-launcher.cjs", "gemini-mcp-wrapper.cjs", "openai-compatible-mcp.cjs", "localEnvStore.js", "claude-cli-mcp.cjs"]) fs.writeFileSync(path.join(hooks, n), "// stub\n");
  return { dir, root, hooks, file: path.join(cfgDir, ".claude.json"), opts: { env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir }, binary: null, platform: "win32" } };
}

function deps(f: Fx, over: Record<string, unknown> = {}, ops?: LocalMcpOps): any {
  return {
    platform: "win32",
    resolveTokens: (c: unknown) => c,
    finalize: (_id: string, c: unknown) => c,
    afterWrite: () => { throw new Error("afterWrite must not run for a local-scope install"); },
    local: ops ?? createLocalMcpOps(f.hooks, f.opts),
    ...over,
  };
}

test("local-scope install registers at local scope, runs the installed script, and never creates .mcp.json", async () => {
  const f = fx();
  try {
    const out = await installMcpEntry(f.root, "codex", MCP_CATALOG, deps(f));
    assert.equal(out, "installed");
    assert.equal(fs.existsSync(path.join(f.root, ".mcp.json")), false);
    const e = readLocalMcpServers(f.root, f.opts)["codex"] as any;
    assert.equal(e.args[0], path.join(f.hooks, "codex-mcp-launcher.cjs").replace(/\\/g, "/"));
    assert.equal(e.command, "node");
    assert.equal(fs.existsSync(path.join(f.root, ".claude", "hooks")), false, "no project hook copy");
    // Second install is idempotent.
    assert.equal(await installMcpEntry(f.root, "codex", MCP_CATALOG, deps(f)), "exists");
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("local-scope install stores env var names only, never values", async () => {
  const f = fx();
  const SECRET = "sk-SECRET-VALUE-do-not-persist";
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = SECRET;
  try {
    assert.equal(await installMcpEntry(f.root, "gemini", MCP_CATALOG, deps(f)), "installed");
    assert.equal(fs.readFileSync(f.file, "utf8").includes(SECRET), false);
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("local-scope install skips unknown ids, unresolved placeholders and unpinned launchers without registering", async () => {
  const f = fx();
  try {
    const unknown = await installMcpEntry(f.root, "nope", MCP_CATALOG, deps(f));
    assert.deepEqual(unknown, { status: "skipped", error: "MCP catalog entry not found for id: nope" });

    const placeholder = await installMcpEntry(f.root, "codex", MCP_CATALOG, deps(f, { resolveTokens: () => ({ command: "node", args: ["<path-to-server>"] }) }));
    assert.equal((placeholder as any).status, "skipped");
    assert.match((placeholder as any).error, /needs manual configuration/);

    const unpinned = await installMcpEntry(f.root, "codex", MCP_CATALOG, deps(f, { finalize: () => ({ command: "npx", args: ["-y", "some-pkg"] }) }));
    assert.equal((unpinned as any).status, "skipped");
    assert.match((unpinned as any).error, /not version-pinned/);

    assert.equal(fs.existsSync(f.file), false);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("local-scope install skips when the installed script is missing or the write fails", async () => {
  const f = fx();
  try {
    fs.rmSync(path.join(f.hooks, "codex-mcp-launcher.cjs"));
    const missing = await installMcpEntry(f.root, "codex", MCP_CATALOG, deps(f));
    assert.equal((missing as any).status, "skipped");
    assert.match((missing as any).error, /codex-mcp-launcher\.cjs is missing/);

    fs.writeFileSync(path.join(f.hooks, "codex-mcp-launcher.cjs"), "// stub\n");
    fs.writeFileSync(f.file, "{bad");
    const failed = await installMcpEntry(f.root, "codex", MCP_CATALOG, deps(f));
    assert.equal((failed as any).status, "skipped");
    assert.match((failed as any).error, /not valid JSON/);
    assert.equal(fs.readFileSync(f.file, "utf8"), "{bad", "no clobber");
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("without `local`, installMcpEntry still writes .mcp.json and calls afterWrite (legacy path)", async () => {
  const f = fx();
  try {
    let after = 0;
    const out = await installMcpEntry(f.root, "codex", MCP_CATALOG, {
      platform: "win32",
      resolveTokens: (c: unknown) => c,
      finalize: (_i: string, c: unknown) => c,
      afterWrite: () => { after++; },
    });
    assert.equal(out, "installed");
    assert.equal(after, 1);
    assert.ok(JSON.parse(fs.readFileSync(path.join(f.root, ".mcp.json"), "utf8")).mcpServers.codex);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

function pickerArgs(f: Fx, selected: string[], extra: Record<string, unknown> = {}): any {
  const ops = createLocalMcpOps(f.hooks, f.opts);
  return {
    root: f.root,
    packAgents: PACK_AGENTS,
    selectedAgentIds: selected,
    others: [] as OtherAgentSpec[],
    harness: "claude-code",
    claudeSubscriptionOptIn: true,
    installMcp: (id: string): Promise<McpInstallOutcome> => installMcpEntry(f.root, id, MCP_CATALOG, deps(f, {}, ops)),
    ...extra,
  };
}

test("picker: unticking a model calls removeMcp for its server and unregisters it; kept models stay", async () => {
  const f = fx();
  try {
    const first = await installBridgeSelection(pickerArgs(f, ["codex-reviewer", "gemini-reviewer"]));
    assert.equal(first.ok, true, first.errors.join(";"));
    assert.deepEqual(Object.keys(readLocalMcpServers(f.root, f.opts)).sort(), ["codex", "gemini"]);

    const ops = createLocalMcpOps(f.hooks, f.opts);
    const removed: string[] = [];
    const res = await installBridgeSelection(pickerArgs(f, ["codex-reviewer"], { removeMcp: async (id: string) => { removed.push(id); await ops.remove(f.root, id); } }));
    assert.equal(res.ok, true, res.errors.join(";"));
    assert.deepEqual(removed, ["gemini"]);
    assert.deepEqual(Object.keys(readLocalMcpServers(f.root, f.opts)), ["codex"]);
    assert.equal(fs.existsSync(path.join(f.root, ".claude", "agents", "gemini-reviewer.md")), true, "agent file left in place");
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("picker: a shared server is not removed while another installed model still needs it", async () => {
  const f = fx();
  try {
    await installBridgeSelection(pickerArgs(f, ["kimi-reviewer", "grok-reviewer"]));
    const removed: string[] = [];
    await installBridgeSelection(pickerArgs(f, ["grok-reviewer"], { removeMcp: (id: string) => { removed.push(id); } }));
    assert.deepEqual(removed, []);
    // Unticking the last user of the shared server removes it exactly once.
    const removed2: string[] = [];
    await installBridgeSelection(pickerArgs(f, ["codex-reviewer"], { removeMcp: (id: string) => { removed2.push(id); } }));
    assert.deepEqual(removed2, ["openai-compatible"]);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("picker: removeMcp is not called on first install, on a dispatcher harness, and a throwing removeMcp does not fail the install", async () => {
  const f = fx();
  try {
    const removed: string[] = [];
    await installBridgeSelection(pickerArgs(f, ["codex-reviewer", "gemini-reviewer"], { removeMcp: (id: string) => { removed.push(id); } }));
    assert.deepEqual(removed, [], "nothing was unticked");

    const removedCodex: string[] = [];
    await installBridgeSelection(pickerArgs(f, ["codex-reviewer"], { harness: "codex", removeMcp: (id: string) => { removedCodex.push(id); } }));
    assert.deepEqual(removedCodex, [], "codex harness never touches Claude local scope");

    const res = await installBridgeSelection(pickerArgs(f, ["codex-reviewer"], { removeMcp: () => { throw new Error("remove blew up"); } }));
    assert.equal(res.ok, true, res.errors.join(";"));
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("picker: the hook-write gate is held while the async installs run and released after, even on failure", async () => {
  const f = fx();
  try {
    const during: boolean[] = [];
    assert.equal(isHookWriteActive(), false);
    const res = await installBridgeSelection(
      pickerArgs(f, ["codex-reviewer", "gemini-reviewer"], {
        installMcp: async (id: string): Promise<McpInstallOutcome> => {
          await new Promise((r) => setTimeout(r, 5));
          during.push(isHookWriteActive());
          if (id === "gemini") throw new Error("install exploded");
          return "installed";
        },
      }),
    );
    assert.deepEqual(during, [true, true]);
    assert.equal(isHookWriteActive(), false);
    assert.equal((res.mcp["gemini"] as any).status, "skipped");
    assert.match((res.mcp["gemini"] as any).error, /install exploded/);
    assert.equal(res.mcp["codex"], "installed");
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
