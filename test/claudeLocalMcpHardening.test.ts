import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never let a test reach the real Claude config (~/.claude.json) or the real `claude` binary.
const CFG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-claude-cfg-"));
process.env.CLAUDE_CONFIG_DIR = CFG_DIR;
process.env.TYCOON_CLAUDE_BIN = "none";

import { readProjectMcpConfig } from "../src/core/bridgeSetup";
import { claudeProjectKey, readLocalMcpServers, registerLocalMcpServer } from "../src/core/claudeLocalMcp";
import type { CliRunResult, LocalMcpOptions } from "../src/core/claudeLocalMcp";
import { installKindOf, repointLocalMcpEntries } from "../src/core/claudeLocalMcpSync";

/*
 * Local-scope MCP hardening: rollback after a failed replace, symlinked and
 * lossy .claude.json handling, install-kind rules for repoint, harness gating
 * of local-scope reads, and "no migration from .mcp.json".
 */

const fwd = (p: string): string => p.replace(/\\/g, "/");

interface Fx { dir: string; file: string; root: string; key: string; opts: LocalMcpOptions }

function fx(extra: Partial<LocalMcpOptions> = {}): Fx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-hard-"));
  const root = path.join(dir, "proj");
  const cfgDir = path.join(dir, "cfg");
  fs.mkdirSync(root);
  fs.mkdirSync(cfgDir);
  return { dir, file: path.join(cfgDir, ".claude.json"), root, key: claudeProjectKey(root), opts: { env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir }, binary: null, ...extra } };
}

const cleanup = (f: Fx): void => fs.rmSync(f.dir, { recursive: true, force: true });
const readCfg = (f: Fx): any => JSON.parse(fs.readFileSync(f.file, "utf8"));
const OLD = { command: "node", args: ["/ext/old/hooks/codex-mcp-launcher.cjs"], env: { A: "1" } };
const NEW = { command: "node", args: ["/ext/new/hooks/codex-mcp-launcher.cjs"], env: { A: "2" } };

// ---------------------------------------------------------------------------
// (a) rollback after a failed replace
// ---------------------------------------------------------------------------

interface Call { args: string[] }

/** Fake claude: remove deletes the entry in the file; add-json of NEW always fails; add-json of OLD fails when restoreFails. */
function replaceFake(f: Fx, calls: Call[], restoreFails: boolean): NonNullable<LocalMcpOptions["run"]> {
  return (_bin, args, cwd) => {
    calls.push({ args });
    const cfg = readCfg(f);
    const servers = cfg.projects[claudeProjectKey(cwd)].mcpServers;
    if (args[1] === "remove") {
      delete servers[args[2]];
      fs.writeFileSync(f.file, JSON.stringify(cfg, null, 2));
      return { status: 0 } as CliRunResult;
    }
    const given = JSON.parse(args[5]);
    if (JSON.stringify(given) === JSON.stringify(NEW) || restoreFails) return { status: 1, stderr: "add failed" } as CliRunResult;
    servers[args[4]] = given;
    fs.writeFileSync(f.file, JSON.stringify(cfg, null, 2));
    return { status: 0 } as CliRunResult;
  };
}

/** Make the first n atomic renames (the file fallback's write) fail; Infinity = all. */
function failRenames(n: number): () => void {
  const real = fs.renameSync;
  let left = n;
  (fs as any).renameSync = (a: string, b: string): void => {
    if (left > 0 && String(a).endsWith(".tmp")) {
      left--;
      throw new Error("EPERM: simulated rename failure");
    }
    return real(a, b);
  };
  return () => { (fs as any).renameSync = real; };
}

test("failed replace: CLI restore of the previous entry works and the error says restored", async () => {
  const f = fx({ binary: "/fake/claude" });
  const calls: Call[] = [];
  f.opts.run = replaceFake(f, calls, false);
  fs.writeFileSync(f.file, JSON.stringify({ projects: { [f.key]: { mcpServers: { srv: OLD } } } }, null, 2));
  const undo = failRenames(1);
  try {
    const r = await registerLocalMcpServer(f.root, "srv", NEW, f.opts);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /The previous entry was restored\./);
    assert.match(r.error ?? "", /add failed/);
    assert.deepEqual(calls.map((c) => c.args[1]), ["remove", "add-json", "add-json"]);
    assert.deepEqual(JSON.parse(calls[2].args[5]), OLD, "CLI restore is tried first with the previous config");
    assert.deepEqual(readCfg(f).projects[f.key].mcpServers.srv, OLD);
  } finally {
    undo();
    cleanup(f);
  }
});

test("failed replace: CLI restore fails, the file restore puts the previous entry back", async () => {
  const f = fx({ binary: "/fake/claude" });
  const calls: Call[] = [];
  f.opts.run = replaceFake(f, calls, true);
  fs.writeFileSync(f.file, JSON.stringify({ projects: { [f.key]: { mcpServers: { srv: OLD, other: { command: "x" } } } } }, null, 2));
  const undo = failRenames(1);
  try {
    const r = await registerLocalMcpServer(f.root, "srv", NEW, f.opts);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /The previous entry was restored\./);
    assert.deepEqual(calls.map((c) => c.args[1]), ["remove", "add-json", "add-json"]);
    const servers = readCfg(f).projects[f.key].mcpServers;
    assert.deepEqual(servers.srv, OLD);
    assert.deepEqual(servers.other, { command: "x" }, "unrelated entries survive");
  } finally {
    undo();
    cleanup(f);
  }
});

test("failed replace: when nothing can restore it, the error says so", async () => {
  const f = fx({ binary: "/fake/claude" });
  const calls: Call[] = [];
  f.opts.run = replaceFake(f, calls, true);
  fs.writeFileSync(f.file, JSON.stringify({ projects: { [f.key]: { mcpServers: { srv: OLD } } } }, null, 2));
  const undo = failRenames(Infinity);
  try {
    const r = await registerLocalMcpServer(f.root, "srv", NEW, f.opts);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /The previous entry could not be restored; re-enable it from the panel\./);
    assert.equal(readCfg(f).projects[f.key].mcpServers.srv, undefined);
  } finally {
    undo();
    cleanup(f);
  }
});

test("failed first-time add (no previous entry) never reports a restore", async () => {
  const f = fx({ binary: "/fake/claude" });
  f.opts.run = () => ({ status: 1, stderr: "nope" }) as CliRunResult;
  const undo = failRenames(Infinity);
  try {
    const r = await registerLocalMcpServer(f.root, "srv", NEW, f.opts);
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.error ?? "", /previous entry/);
  } finally {
    undo();
    cleanup(f);
  }
});

// ---------------------------------------------------------------------------
// (b) symlinked .claude.json and lossy integer literals
// ---------------------------------------------------------------------------

test("a symlinked .claude.json stays a symlink after a write and the target is updated", async (t) => {
  const f = fx();
  try {
    const real = path.join(f.dir, "real-claude.json");
    fs.writeFileSync(real, JSON.stringify({ theme: "dark", projects: {} }, null, 2) + "\n");
    try {
      fs.symlinkSync(real, f.file, "file");
    } catch (e) {
      t.skip(`cannot create symlinks here (${(e as NodeJS.ErrnoException).code ?? String(e)}); enable Developer Mode or run elevated on Windows`);
      return;
    }
    const r = await registerLocalMcpServer(f.root, "srv", NEW, f.opts);
    assert.deepEqual(r, { ok: true, via: "file" });
    assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true, "link not replaced by a regular file");
    const target = JSON.parse(fs.readFileSync(real, "utf8"));
    assert.equal(target.theme, "dark");
    assert.deepEqual(target.projects[f.key].mcpServers.srv, NEW);
    assert.deepEqual(fs.readdirSync(f.dir).filter((n) => n.endsWith(".tmp")), []);
  } finally {
    cleanup(f);
  }
});

// editClaudeJson is expected to refuse (hasUnsafeIntegerLiteral) a file whose integers
// JSON.parse would round, so nothing is written and the CLI path is suggested instead.
test("the file fallback refuses a file with an unsafe integer literal and writes nothing", async () => {
  const f = fx();
  try {
    const text = `{\n  "bigId": 12345678901234567890,\n  "projects": {}\n}\n`;
    fs.writeFileSync(f.file, text);
    const r = await registerLocalMcpServer(f.root, "srv", NEW, f.opts);
    assert.equal(r.ok, false);
    assert.equal(fs.readFileSync(f.file, "utf8"), text, "file untouched byte for byte");
    assert.match(r.error ?? "", /claude CLI/);
    assert.deepEqual(fs.readdirSync(path.dirname(f.file)).filter((n) => n.endsWith(".tmp")), []);
  } finally {
    cleanup(f);
  }
});

test("the file fallback still writes when large digits only appear inside strings or as safe integers", async () => {
  const f = fx();
  try {
    fs.writeFileSync(f.file, `{\n  "note": "id 12345678901234567890",\n  "n": 9007199254740991,\n  "projects": {}\n}\n`);
    const r = await registerLocalMcpServer(f.root, "srv", NEW, f.opts);
    assert.equal(r.ok, true);
    assert.equal(readCfg(f).n, 9007199254740991);
  } finally {
    cleanup(f);
  }
});

// ---------------------------------------------------------------------------
// (c) install kinds and repoint
// ---------------------------------------------------------------------------

function hooksDir(base: string, name: string, files = ["codex-mcp-launcher.cjs"]): string {
  const hooks = path.join(base, name, "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  for (const n of files) fs.writeFileSync(path.join(hooks, n), "//");
  return hooks;
}

test("installKindOf: a digit must follow the extension id; casing and separators do not matter", () => {
  assert.equal(installKindOf("C:/x/Tycoonagents.TycoonAgents-0.0.728/hooks/a.cjs"), "vscode-extension");
  assert.equal(installKindOf("/x/tycoonagents.tycoonagents-win32-x64-1.2.3/hooks/a.cjs"), "standalone");
  assert.equal(installKindOf("D:\\proj\\.claude\\hooks\\a.cjs"), "project");
  assert.equal(installKindOf("hooks/a.cjs"), "standalone");
});

test("repoint: extension -> newer extension moves, extension -> standalone never does, never back to older", async () => {
  const f = fx({ platform: "win32" });
  try {
    const v1 = hooksDir(f.dir, "ext/tycoonagents.tycoonagents-0.0.1");
    const v2 = hooksDir(f.dir, "ext/tycoonagents.tycoonagents-0.0.2");
    const standalone = hooksDir(f.dir, "standalone-root");
    await registerLocalMcpServer(f.root, "codex", { command: "node", args: [fwd(path.join(v1, "codex-mcp-launcher.cjs"))] }, f.opts);
    assert.deepEqual((await repointLocalMcpEntries(f.root, standalone, ["codex"], f.opts)).repointed, []);
    assert.deepEqual((await repointLocalMcpEntries(f.root, v2, ["codex"], f.opts)).repointed, ["codex"]);
    assert.equal((readLocalMcpServers(f.root, f.opts) as any).codex.args[0], fwd(path.join(v2, "codex-mcp-launcher.cjs")));
    assert.deepEqual((await repointLocalMcpEntries(f.root, v1, ["codex"], f.opts)).repointed, []);
  } finally {
    cleanup(f);
  }
});

test("repoint: an extension entry whose folder was deleted is repointed even to an older version", async () => {
  const f = fx({ platform: "win32" });
  try {
    const gone = path.join(f.dir, "ext", "tycoonagents.tycoonagents-2.0.0", "hooks");
    const v1 = hooksDir(f.dir, "ext/tycoonagents.tycoonagents-1.0.0");
    await registerLocalMcpServer(f.root, "codex", { command: "node", args: [fwd(path.join(gone, "codex-mcp-launcher.cjs"))] }, f.opts);
    assert.deepEqual((await repointLocalMcpEntries(f.root, v1, ["codex"], f.opts)).repointed, ["codex"]);
  } finally {
    cleanup(f);
  }
});

// ---------------------------------------------------------------------------
// (d) readProjectMcpConfig reads local scope only on the Claude Code harness
// ---------------------------------------------------------------------------

function projectWithLocal(): { root: string; undo: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rpmc-proj-"));
  fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { fromFile: { command: "a" } } }));
  const file = path.join(CFG_DIR, ".claude.json");
  const prior = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  // Vary the size so the module's mtime+size read cache cannot serve a stale parse.
  fs.writeFileSync(file, JSON.stringify({ padding: "x".repeat(1 + Math.floor(Math.random() * 5000)), projects: { [claudeProjectKey(root)]: { mcpServers: { fromLocal: { command: "b" } } } } }));
  return {
    root,
    undo: () => {
      if (prior === undefined) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, prior);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("readProjectMcpConfig merges ~/.claude.json local scope for claude-code (and the empty default)", () => {
  const p = projectWithLocal();
  try {
    for (const h of ["claude-code", "Claude-Code", ""]) {
      const servers = (readProjectMcpConfig(p.root, h) as any).mcpServers;
      assert.deepEqual(Object.keys(servers).sort(), ["fromFile", "fromLocal"], `harness "${h}"`);
    }
  } finally {
    p.undo();
  }
});

test("readProjectMcpConfig ignores local scope for codex and opencode", () => {
  const p = projectWithLocal();
  try {
    for (const h of ["codex", "opencode", "gemini"]) {
      const servers = (readProjectMcpConfig(p.root, h) as any).mcpServers;
      assert.deepEqual(Object.keys(servers), ["fromFile"], `harness "${h}"`);
    }
  } finally {
    p.undo();
  }
});

test("readProjectMcpConfig without .mcp.json: local entries only on claude-code, {} elsewhere", () => {
  const p = projectWithLocal();
  try {
    fs.rmSync(path.join(p.root, ".mcp.json"));
    assert.deepEqual(Object.keys((readProjectMcpConfig(p.root, "claude-code") as any).mcpServers), ["fromLocal"]);
    assert.deepEqual(readProjectMcpConfig(p.root, "codex"), {});
  } finally {
    p.undo();
  }
});

// ---------------------------------------------------------------------------
// (e) no migration from .mcp.json contents
// ---------------------------------------------------------------------------

test("repoint and config reads never add anything to local scope from a repo's .mcp.json or .claude/hooks copies", async () => {
  const f = fx({ platform: "win32" });
  try {
    const hooksCopy = path.join(f.root, ".claude", "hooks");
    fs.mkdirSync(hooksCopy, { recursive: true });
    for (const n of ["codex-mcp-launcher.cjs", "gemini-mcp-wrapper.cjs"]) fs.writeFileSync(path.join(hooksCopy, n), "//");
    fs.writeFileSync(path.join(f.root, ".mcp.json"), JSON.stringify({
      mcpServers: {
        codex: { command: "node", args: [".claude/hooks/codex-mcp-launcher.cjs"] },
        gemini: { command: "node", args: [fwd(path.join(hooksCopy, "gemini-mcp-wrapper.cjs"))] },
      },
    }));
    const installed = hooksDir(f.dir, "ext/tycoonagents.tycoonagents-1.0.0", ["codex-mcp-launcher.cjs", "gemini-mcp-wrapper.cjs"]);

    // The panel-open path: reads plus a repoint pass over the canonical ids.
    readProjectMcpConfig(f.root, "claude-code");
    const r = await repointLocalMcpEntries(f.root, installed, ["codex", "gemini"], f.opts);
    assert.deepEqual(r, { repointed: [], errors: [] });
    assert.deepEqual(readLocalMcpServers(f.root, f.opts), {});
    assert.equal(fs.existsSync(f.file), false, "no ~/.claude.json was created");

    // A project-path entry already in local scope is left alone and nothing else appears.
    await registerLocalMcpServer(f.root, "codex", { command: "node", args: [fwd(path.join(hooksCopy, "codex-mcp-launcher.cjs"))] }, f.opts);
    const before = fs.readFileSync(f.file, "utf8");
    const r2 = await repointLocalMcpEntries(f.root, installed, ["codex", "gemini"], f.opts);
    assert.deepEqual(r2, { repointed: [], errors: [] });
    assert.equal(fs.readFileSync(f.file, "utf8"), before);
    assert.deepEqual(Object.keys(readLocalMcpServers(f.root, f.opts)), ["codex"]);
  } finally {
    cleanup(f);
  }
});

test("only the install paths in src call local-scope registration (no migration code path exists)", () => {
  const callers: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mjs)$/.test(e.name) && /registerLocalMcpServer\(|createLocalMcpOps\(/.test(fs.readFileSync(p, "utf8"))) callers.push(fwd(path.relative(process.cwd(), p)));
    }
  };
  walk(path.join(process.cwd(), "src"));
  assert.deepEqual(callers.sort(), ["src/core/claudeLocalMcp.ts", "src/core/claudeLocalMcpSync.ts", "src/host/vscode/panel.ts"].sort());
  const src = fs.readFileSync(path.join(process.cwd(), "src", "core", "claudeLocalMcp.ts"), "utf8");
  assert.doesNotMatch(src, /migrat/i);
});
