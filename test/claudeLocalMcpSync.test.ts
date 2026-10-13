import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never let a test reach the real Claude config (~/.claude.json) or the real `claude` binary.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-claude-cfg-"));
process.env.TYCOON_CLAUDE_BIN = "none";

import { claudeProjectKey, readLocalMcpServers, registerLocalMcpServer } from "../src/core/claudeLocalMcp";
import type { LocalMcpOptions } from "../src/core/claudeLocalMcp";
import {
  isOurLocalEntry,
  installKindOf,
  repointLocalMcpEntries,
} from "../src/core/claudeLocalMcpSync";

/*
 * Keeping local-scope registrations current: isOurLocalEntry recognises only
 * node launchers running our bridge scripts, and repoint never downgrades,
 * never crosses install kinds and never touches foreign entries.
 */

function tmp(prefix = "local-sync-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Fx {
  dir: string;
  file: string;
  root: string;
  opts: LocalMcpOptions;
}

function fx(): Fx {
  const dir = tmp();
  const root = path.join(dir, "proj");
  fs.mkdirSync(root);
  const cfgDir = path.join(dir, "cfg");
  fs.mkdirSync(cfgDir);
  return { dir, file: path.join(cfgDir, ".claude.json"), root, opts: { env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir }, binary: null, platform: "win32" } };
}

function cfg(f: Fx): any {
  return JSON.parse(fs.readFileSync(f.file, "utf8"));
}

function localServers(f: Fx): Record<string, any> {
  return readLocalMcpServers(f.root, f.opts) as Record<string, any>;
}

function mkHooks(base: string, name: string, files: string[]): string {
  const hooks = path.join(base, "ext", name, "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  for (const n of files) fs.writeFileSync(path.join(hooks, n), "// stub\n");
  return hooks;
}

const fwd = (p: string): string => p.replace(/\\/g, "/");

// ---------------------------------------------------------------------------
// isOurLocalEntry
// ---------------------------------------------------------------------------

test("isOurLocalEntry accepts node launchers running one of our bridge scripts", () => {
  assert.equal(isOurLocalEntry({ command: "node", args: ["/ext/hooks/codex-mcp-launcher.cjs", "-c", "x"] }), true);
  assert.equal(isOurLocalEntry({ command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\ext\\hooks\\gemini-mcp-wrapper.cjs"], env: { A: "1" }, type: "stdio" }), true);
  assert.equal(isOurLocalEntry({ command: "/usr/local/bin/node", args: ["/ext/hooks/tycoon-dispatcher-mcp.cjs"] }), true);
});

test("isOurLocalEntry rejects foreign commands, scripts and shapes", () => {
  const bad: unknown[] = [
    null,
    "node",
    [],
    { command: "npx", args: ["/ext/hooks/codex-mcp-launcher.cjs"] },
    { command: "python", args: ["/ext/hooks/codex-mcp-launcher.cjs"] },
    { command: "/tmp/evil/node-evil", args: ["/ext/hooks/codex-mcp-launcher.cjs"] },
    { command: "C:\\evil\\node.exe.bat", args: ["/ext/hooks/codex-mcp-launcher.cjs"] },
    { command: "bash", args: ["-c", "node /ext/hooks/codex-mcp-launcher.cjs"] },
    { command: "node", args: ["/ext/hooks/evil.cjs"] },
    { command: "node", args: ["codex-mcp-launcher.cjs"] },
    { command: "node", args: ["/ext/notahooks/codex-mcp-launcher.cjs"] },
    { command: "node", args: ["--require", "/x.js", "/ext/hooks/codex-mcp-launcher.cjs"] },
    { command: "node", args: [] },
    { command: "node" },
    { command: "node", args: [42] },
    { command: "node", args: ["/ext/hooks/codex-mcp-launcher.cjs"], cwd: "/tmp" },
    { command: "node", args: ["/ext/hooks/codex-mcp-launcher.cjs"], url: "https://x.test" },
    { type: "http", url: "https://x.test/mcp" },
  ];
  for (const e of bad) assert.equal(isOurLocalEntry(e), false, JSON.stringify(e));
});

// ---------------------------------------------------------------------------
// repointLocalMcpEntries
// ---------------------------------------------------------------------------

function entryAt(hooks: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: "node", args: [fwd(path.join(hooks, "codex-mcp-launcher.cjs")), "-c", "model=x"], env: { KEEP: "1" }, ...extra };
}

test("repoint moves our entry from an older install to the current one, keeping other args and env", async () => {
  const f = fx();
  try {
    const oldHooks = mkHooks(f.dir, "tycoonagents.tycoonagents-1.0.1", ["codex-mcp-launcher.cjs"]);
    const newHooks = mkHooks(f.dir, "tycoonagents.tycoonagents-1.0.5", ["codex-mcp-launcher.cjs"]);
    await registerLocalMcpServer(f.root, "codex", entryAt(oldHooks), f.opts);
    const r = await repointLocalMcpEntries(f.root, newHooks, ["codex"], f.opts);
    assert.deepEqual(r, { repointed: ["codex"], errors: [] });
    const e = localServers(f)["codex"];
    assert.equal(e.args[0], fwd(path.join(newHooks, "codex-mcp-launcher.cjs")));
    assert.deepEqual(e.args.slice(1), ["-c", "model=x"]);
    assert.deepEqual(e.env, { KEEP: "1" });
    assert.equal(e.command, "node");
    // Running again is a no-op.
    const again = await repointLocalMcpEntries(f.root, newHooks, ["codex"], f.opts);
    assert.deepEqual(again, { repointed: [], errors: [] });
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("repoint never downgrades an entry that points at a newer extension version that still exists", async () => {
  const f = fx();
  try {
    const newer = mkHooks(f.dir, "tycoonagents.tycoonagents-2.0.0", ["codex-mcp-launcher.cjs"]);
    const older = mkHooks(f.dir, "tycoonagents.tycoonagents-1.0.0", ["codex-mcp-launcher.cjs"]);
    await registerLocalMcpServer(f.root, "codex", entryAt(newer), f.opts);
    const before = fs.readFileSync(f.file, "utf8");
    const r = await repointLocalMcpEntries(f.root, older, ["codex"], f.opts);
    assert.deepEqual(r, { repointed: [], errors: [] });
    assert.equal(fs.readFileSync(f.file, "utf8"), before);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("repoint leaves foreign entries, unlisted ids and unrecognised launchers untouched", async () => {
  const f = fx();
  try {
    const oldHooks = mkHooks(f.dir, "tycoonagents.tycoonagents-1.0.1", ["codex-mcp-launcher.cjs"]);
    const newHooks = mkHooks(f.dir, "tycoonagents.tycoonagents-1.0.5", ["codex-mcp-launcher.cjs"]);
    const foreign = { command: "npx", args: ["-y", "third-party@1.0.0"] };
    const forged = { command: "evil", args: [fwd(path.join(oldHooks, "codex-mcp-launcher.cjs"))] };
    const ours = entryAt(oldHooks);
    fs.writeFileSync(f.file, JSON.stringify({ keepMe: 1, projects: { [claudeProjectKey(f.root)]: { mcpServers: { foreign, forged, other: ours, codex: ours } } } }));
    const before = fs.readFileSync(f.file, "utf8");
    const r = await repointLocalMcpEntries(f.root, newHooks, ["foreign", "forged", "missing-id"], f.opts);
    assert.deepEqual(r, { repointed: [], errors: [] });
    assert.equal(fs.readFileSync(f.file, "utf8"), before, "ids not in ourIds (other, codex) and foreign ones are untouched");
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("repoint reports an error and leaves the entry when the new install lacks the script", async () => {
  const f = fx();
  try {
    const oldHooks = mkHooks(f.dir, "tycoonagents.tycoonagents-1.0.1", ["codex-mcp-launcher.cjs"]);
    const emptyNew = mkHooks(f.dir, "tycoonagents.tycoonagents-1.0.5", []);
    const entry = entryAt(oldHooks);
    await registerLocalMcpServer(f.root, "codex", entry, f.opts);
    const r = await repointLocalMcpEntries(f.root, emptyNew, ["codex"], f.opts);
    assert.equal(r.repointed.length, 0);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /^codex: codex-mcp-launcher\.cjs is missing/);
    assert.deepEqual(localServers(f)["codex"], entry);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("repoint swaps a vanished absolute interpreter for the discovered one even when the script is current", async () => {
  const f = fx();
  try {
    const hooks = mkHooks(f.dir, "tycoonagents.tycoonagents-1.0.5", ["codex-mcp-launcher.cjs"]);
    const gone = path.join(f.dir, "gone", "node.exe");
    await registerLocalMcpServer(f.root, "codex", entryAt(hooks, { command: gone }), f.opts);
    const r = await repointLocalMcpEntries(f.root, hooks, ["codex"], f.opts);
    assert.deepEqual(r.repointed, ["codex"]);
    assert.equal(localServers(f)["codex"].command, "node");
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});


test("installKindOf classifies extension, project and standalone script paths", () => {
  assert.equal(installKindOf("C:/Users/u/.vscode/extensions/tycoonagents.tycoonagents-1.0.5/hooks/codex-mcp-launcher.cjs"), "vscode-extension");
  assert.equal(installKindOf(String.raw`C:\Users\u\.vscode\extensions\tycoonagents.tycoonagents-1.0.5\hooks\x.cjs`), "vscode-extension");
  assert.equal(installKindOf("/proj/.claude/hooks/codex-mcp-launcher.cjs"), "project");
  assert.equal(installKindOf("/opt/tycoon-standalone/hooks/codex-mcp-launcher.cjs"), "standalone");
});

test("repoint never crosses install kinds and never rewrites a project-relative entry", async () => {
  const f = fx();
  try {
    const extHooks = mkHooks(f.dir, "tycoonagents.tycoonagents-1.0.5", ["codex-mcp-launcher.cjs"]);
    const standaloneHooks = path.join(f.dir, "standalone", "hooks");
    fs.mkdirSync(standaloneHooks, { recursive: true });
    fs.writeFileSync(path.join(standaloneHooks, "codex-mcp-launcher.cjs"), "//");
    const projectEntry = { command: "node", args: [fwd(path.join(f.root, ".claude", "hooks", "codex-mcp-launcher.cjs"))] };
    await registerLocalMcpServer(f.root, "codex", projectEntry, f.opts);
    const before = fs.readFileSync(f.file, "utf8");
    assert.deepEqual(await repointLocalMcpEntries(f.root, extHooks, ["codex"], f.opts), { repointed: [], errors: [] });
    assert.deepEqual(await repointLocalMcpEntries(f.root, standaloneHooks, ["codex"], f.opts), { repointed: [], errors: [] });
    assert.equal(fs.readFileSync(f.file, "utf8"), before);

    // A standalone entry is not rewritten by an extension window...
    const sEntry = { command: "node", args: [fwd(path.join(standaloneHooks, "codex-mcp-launcher.cjs"))] };
    await registerLocalMcpServer(f.root, "codex", sEntry, f.opts);
    assert.deepEqual((await repointLocalMcpEntries(f.root, extHooks, ["codex"], f.opts)).repointed, []);
    assert.deepEqual(localServers(f)["codex"], sEntry);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("repoint moves a standalone entry only once its old script is gone", async () => {
  const f = fx();
  try {
    const oldRoot = path.join(f.dir, "old-standalone", "hooks");
    const newRoot = path.join(f.dir, "new-standalone", "hooks");
    for (const d of [oldRoot, newRoot]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "codex-mcp-launcher.cjs"), "//");
    }
    await registerLocalMcpServer(f.root, "codex", { command: "node", args: [fwd(path.join(oldRoot, "codex-mcp-launcher.cjs"))] }, f.opts);
    assert.deepEqual((await repointLocalMcpEntries(f.root, newRoot, ["codex"], f.opts)).repointed, [], "old script still exists");
    fs.rmSync(path.join(oldRoot, "codex-mcp-launcher.cjs"));
    assert.deepEqual((await repointLocalMcpEntries(f.root, newRoot, ["codex"], f.opts)).repointed, ["codex"]);
    assert.equal(localServers(f)["codex"].args[0], fwd(path.join(newRoot, "codex-mcp-launcher.cjs")));
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
