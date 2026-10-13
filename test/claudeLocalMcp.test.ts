import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never let a test reach the real Claude config (~/.claude.json) or the real `claude` binary.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-claude-cfg-"));
process.env.TYCOON_CLAUDE_BIN = "none";

import {
  claudeConfigFilePath,
  claudeProjectKey,
  createLocalMcpOps,
  discoverClaudeBinary,
  hasLocalMcpServer,
  installedBridgeScript,
  localizeMcpConfig,
  readLocalMcpServers,
  registerLocalMcpServer,
  removeLocalMcpServer,
  withLocalMcpServers,
} from "../src/core/claudeLocalMcp";
import type { CliRunResult, LocalMcpOptions } from "../src/core/claudeLocalMcp";

/*
 * Claude Code local-scope MCP registration: project keys, the ~/.claude.json
 * file fallback (touches only projects[key].mcpServers[id]), the CLI path,
 * binary discovery order and config localisation. Every test uses a temp
 * CLAUDE_CONFIG_DIR / injected homedir; the CLI is faked through the `run` seam.
 */

function tmp(prefix = "local-mcp-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Fx {
  dir: string;
  file: string;
  root: string;
  key: string;
  opts: LocalMcpOptions;
}

/** A temp config dir + project root, options forcing the file path unless `binary` is given. */
function fx(extra: Partial<LocalMcpOptions> = {}): Fx {
  const dir = tmp();
  const root = path.join(dir, "proj");
  fs.mkdirSync(root);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  return { dir, file: path.join(dir, ".claude.json"), root, key: claudeProjectKey(root), opts: { env, binary: null, ...extra } };
}

function writeCfg(f: Fx, obj: unknown, text?: string): string {
  const out = text ?? JSON.stringify(obj, null, 2) + "\n";
  fs.writeFileSync(f.file, out);
  return out;
}

function readCfg(f: Fx): any {
  return JSON.parse(fs.readFileSync(f.file, "utf8"));
}

const CFG = { command: "node", args: ["/ext/hooks/codex-mcp-launcher.cjs"], env: { A: "1" } };

// ---------------------------------------------------------------------------
// Keys and paths
// ---------------------------------------------------------------------------

test("claudeProjectKey uses forward slashes and drops trailing separators", () => {
  assert.equal(claudeProjectKey("D:\\ACode\\TycoonAgents"), "D:/ACode/TycoonAgents");
  assert.equal(claudeProjectKey("D:\\ACode\\TycoonAgents\\"), "D:/ACode/TycoonAgents");
  assert.equal(claudeProjectKey("D:/ACode/x//"), "D:/ACode/x");
});

test("claudeProjectKey keeps POSIX paths and the filesystem root", () => {
  assert.equal(claudeProjectKey("/home/u/proj"), "/home/u/proj");
  assert.equal(claudeProjectKey("/home/u/proj/"), "/home/u/proj");
  assert.equal(claudeProjectKey("/"), "/");
  assert.equal(claudeProjectKey(""), "/");
});

test("claudeConfigFilePath honours CLAUDE_CONFIG_DIR, else the injected home", () => {
  assert.equal(claudeConfigFilePath({ env: { CLAUDE_CONFIG_DIR: "/cfg" } }), path.join("/cfg", ".claude.json"));
  assert.equal(claudeConfigFilePath({ env: { CLAUDE_CONFIG_DIR: "   " }, homedir: "/home/u" }), path.join("/home/u", ".claude.json"));
  assert.equal(claudeConfigFilePath({ env: {}, homedir: "/home/u" }), path.join("/home/u", ".claude.json"));
});

// ---------------------------------------------------------------------------
// Drive-letter case variants
// ---------------------------------------------------------------------------

test("win32: a differently-cased drive letter key is read", () => {
  const f = fx({ platform: "win32" });
  try {
    writeCfg(f, { projects: { "d:/ACode/Proj": { mcpServers: { a: CFG } } } });
    assert.deepEqual(readLocalMcpServers("D:\\ACode\\Proj", f.opts), { a: CFG });
    assert.equal(hasLocalMcpServer("D:\\ACode\\Proj\\", "a", f.opts), true);
    assert.equal(hasLocalMcpServer("D:\\ACode\\Proj", "b", f.opts), false);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("posix: case differences are different projects", () => {
  const f = fx({ platform: "linux" });
  try {
    writeCfg(f, { projects: { "/Home/U/Proj": { mcpServers: { a: CFG } } } });
    assert.deepEqual(readLocalMcpServers("/home/u/proj", f.opts), {});
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("win32: a write goes into the existing differently-cased key, not a new one, and mirrors onto every variant", async () => {
  const f = fx({ platform: "win32" });
  try {
    writeCfg(f, { projects: { "d:/ACode/Proj": { mcpServers: {} }, "D:/ACode/Proj": { mcpServers: { keep: { command: "x" } } } } });
    const r = await registerLocalMcpServer("D:\\ACode\\Proj", "srv", CFG, f.opts);
    assert.deepEqual(r, { ok: true, via: "file" });
    const cfg = readCfg(f);
    assert.deepEqual(Object.keys(cfg.projects).sort(), ["D:/ACode/Proj", "d:/ACode/Proj"]);
    assert.deepEqual(cfg.projects["d:/ACode/Proj"].mcpServers, { srv: CFG });
    assert.deepEqual(cfg.projects["D:/ACode/Proj"].mcpServers, { keep: { command: "x" }, srv: CFG });
    // Removal sweeps both variants.
    const rm = await removeLocalMcpServer("d:\\ACode\\Proj", "srv", f.opts);
    assert.equal(rm.ok, true);
    const after = readCfg(f);
    assert.deepEqual(after.projects["d:/ACode/Proj"].mcpServers, {});
    assert.deepEqual(after.projects["D:/ACode/Proj"].mcpServers, { keep: { command: "x" } });
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a new key is written with forward slashes and no trailing slash", async () => {
  const f = fx({ platform: "win32" });
  try {
    const r = await registerLocalMcpServer("D:\\ACode\\New\\", "srv", CFG, f.opts);
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(readCfg(f).projects), ["D:/ACode/New"]);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// File fallback
// ---------------------------------------------------------------------------

test("file fallback creates a missing file with only projects[key].mcpServers[id]", async () => {
  const f = fx();
  try {
    assert.equal(fs.existsSync(f.file), false);
    const r = await registerLocalMcpServer(f.root, "srv", CFG, f.opts);
    assert.deepEqual(r, { ok: true, via: "file" });
    assert.deepEqual(readCfg(f), { projects: { [f.key]: { mcpServers: { srv: CFG } } } });
    assert.deepEqual(readLocalMcpServers(f.root, f.opts), { srv: CFG });
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("file fallback preserves every other top-level and project key and formatting", async () => {
  const f = fx();
  try {
    const original = {
      numStartups: 7,
      oauthAccount: { emailAddress: "x@example.test" },
      cachedGrowthBookFeatures: { a: [1, 2, { b: null }] },
      projects: {
        "/other/project": { allowedTools: ["Bash"], mcpServers: { x: { command: "y" } }, history: [1] },
        [f.key]: { allowedTools: ["Read"], hasTrustDialogAccepted: true, mcpServers: { keep: { command: "k" } }, custom: { n: 1 } },
      },
    };
    writeCfg(f, original, JSON.stringify(original, null, "\t") + "\n");
    const r = await registerLocalMcpServer(f.root, "srv", CFG, f.opts);
    assert.equal(r.ok, true);
    const after = readCfg(f);
    const expected = JSON.parse(JSON.stringify(original));
    expected.projects[f.key].mcpServers.srv = CFG;
    assert.deepEqual(after, expected);
    const text = fs.readFileSync(f.file, "utf8");
    assert.ok(text.includes('\n\t"numStartups"'), "tab indent kept");
    assert.ok(text.endsWith("}\n"), "trailing newline kept");
    // Remove only the one id.
    assert.equal((await removeLocalMcpServer(f.root, "srv", f.opts)).ok, true);
    assert.deepEqual(readCfg(f), original);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("file fallback keeps CRLF line endings", async () => {
  const f = fx();
  try {
    writeCfg(f, null, JSON.stringify({ a: 1, projects: {} }, null, 2).replace(/\n/g, "\r\n"));
    assert.equal((await registerLocalMcpServer(f.root, "srv", CFG, f.opts)).ok, true);
    const text = fs.readFileSync(f.file, "utf8");
    assert.ok(text.includes("\r\n"));
    assert.equal(/[^\r]\n/.test(text), false, "no bare LF");
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a missing project in an existing file is created without touching the rest", async () => {
  const f = fx();
  try {
    const original = { theme: "dark", projects: { "/other": { mcpServers: { z: { command: "z" } } } } };
    writeCfg(f, original);
    assert.equal((await registerLocalMcpServer(f.root, "srv", CFG, f.opts)).ok, true);
    const after = readCfg(f);
    assert.deepEqual(after.projects["/other"], original.projects["/other"]);
    assert.equal(after.theme, "dark");
    assert.deepEqual(after.projects[f.key], { mcpServers: { srv: CFG } });
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("an existing project without mcpServers gets only that key added", async () => {
  const f = fx();
  try {
    writeCfg(f, { projects: { [f.key]: { allowedTools: ["Read"] } } });
    assert.equal((await registerLocalMcpServer(f.root, "srv", CFG, f.opts)).ok, true);
    assert.deepEqual(readCfg(f).projects[f.key], { allowedTools: ["Read"], mcpServers: { srv: CFG } });
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("invalid JSON is refused and left byte-for-byte untouched", async () => {
  const f = fx();
  try {
    const bad = '{ "projects": { "a": ';
    fs.writeFileSync(f.file, bad);
    const r = await registerLocalMcpServer(f.root, "srv", CFG, f.opts);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not valid JSON/);
    assert.equal(fs.readFileSync(f.file, "utf8"), bad);
    assert.deepEqual(fs.readdirSync(f.dir).filter((n) => n.endsWith(".tmp")), []);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a non-object file, a non-object projects and a non-object mcpServers are all refused untouched", async () => {
  const cases: string[] = [
    "[1,2,3]",
    '"just a string"',
    JSON.stringify({ projects: "nope" }),
    JSON.stringify({ projects: [] }),
  ];
  const f = fx();
  try {
    for (const text of cases) {
      fs.writeFileSync(f.file, text);
      const r = await registerLocalMcpServer(f.root, "srv", CFG, f.opts);
      assert.equal(r.ok, false, text);
      assert.equal(fs.readFileSync(f.file, "utf8"), text);
    }
    const bad = JSON.stringify({ projects: { [f.key]: { mcpServers: ["x"] } } });
    fs.writeFileSync(f.file, bad);
    const r = await registerLocalMcpServer(f.root, "srv", CFG, f.opts);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /mcpServers/);
    assert.equal(fs.readFileSync(f.file, "utf8"), bad);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("removing from invalid JSON, a missing file or a missing project is a successful no-op", async () => {
  const f = fx();
  try {
    assert.deepEqual(await removeLocalMcpServer(f.root, "srv", f.opts), { ok: true, via: "unchanged" });
    assert.equal(fs.existsSync(f.file), false, "remove never creates the file");
    fs.writeFileSync(f.file, "{oops");
    assert.deepEqual(await removeLocalMcpServer(f.root, "srv", f.opts), { ok: true, via: "unchanged" });
    assert.equal(fs.readFileSync(f.file, "utf8"), "{oops");
    const other = JSON.stringify({ projects: { "/other": { mcpServers: { srv: CFG } } } });
    fs.writeFileSync(f.file, other);
    assert.deepEqual(await removeLocalMcpServer(f.root, "srv", f.opts), { ok: true, via: "unchanged" });
    assert.equal(fs.readFileSync(f.file, "utf8"), other);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("registering an identical entry is a no-op that does not rewrite the file", async () => {
  const f = fx();
  try {
    assert.equal((await registerLocalMcpServer(f.root, "srv", CFG, f.opts)).via, "file");
    const before = fs.readFileSync(f.file, "utf8");
    const mtime = fs.statSync(f.file).mtimeMs;
    assert.deepEqual(await registerLocalMcpServer(f.root, "srv", CFG, f.opts), { ok: true, via: "unchanged" });
    assert.equal(fs.readFileSync(f.file, "utf8"), before);
    assert.equal(fs.statSync(f.file).mtimeMs, mtime);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a changed entry replaces the old one and leaves no temp files", async () => {
  const f = fx();
  try {
    await registerLocalMcpServer(f.root, "srv", CFG, f.opts);
    const next = { ...CFG, args: ["/ext2/hooks/codex-mcp-launcher.cjs"] };
    assert.equal((await registerLocalMcpServer(f.root, "srv", next, f.opts)).ok, true);
    assert.deepEqual(readCfg(f).projects[f.key].mcpServers.srv, next);
    assert.deepEqual(fs.readdirSync(f.dir).filter((n) => n.endsWith(".tmp")), []);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("invalid server ids and non-object configs are rejected before anything runs", async () => {
  const f = fx({ binary: "/fake/claude" });
  let runs = 0;
  f.opts.run = () => { runs++; return { status: 0 }; };
  try {
    for (const id of ["", "--scope", "-x", "a/b", "a b", "a\\b", "x".repeat(65), "a;b"]) {
      assert.equal((await registerLocalMcpServer(f.root, id, CFG, f.opts)).ok, false, id);
      assert.equal((await removeLocalMcpServer(f.root, id, f.opts)).ok, false, id);
    }
    assert.equal((await registerLocalMcpServer(f.root, "ok", null, f.opts)).ok, false);
    assert.equal((await registerLocalMcpServer(f.root, "ok", [1], f.opts)).ok, false);
    assert.equal((await registerLocalMcpServer(f.root, "ok", "str", f.opts)).ok, false);
    assert.equal(runs, 0);
    assert.equal(fs.existsSync(f.file), false);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("withLocalMcpServers merges local over .mcp.json and returns the same object when none", async () => {
  const f = fx();
  try {
    const base = { mcpServers: { a: { command: "a" }, b: { command: "b" } }, other: 1 };
    assert.equal(withLocalMcpServers(base, f.root, f.opts), base);
    await registerLocalMcpServer(f.root, "b", CFG, f.opts);
    await registerLocalMcpServer(f.root, "c", CFG, f.opts);
    const merged = withLocalMcpServers(base, f.root, f.opts) as any;
    assert.deepEqual(merged.mcpServers, { a: { command: "a" }, b: CFG, c: CFG });
    assert.equal(merged.other, 1);
    assert.deepEqual(base.mcpServers.b, { command: "b" }, "input not mutated");
    const noServers = withLocalMcpServers({}, f.root, f.opts) as any;
    assert.deepEqual(Object.keys(noServers.mcpServers).sort(), ["b", "c"]);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the default options honour TYCOON_CLAUDE_BIN=none and CLAUDE_CONFIG_DIR (never the real home)", async () => {
  const f = fx();
  try {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: f.dir, TYCOON_CLAUDE_BIN: "none" };
    const r = await registerLocalMcpServer(f.root, "srv", CFG, { env, homedir: path.join(f.dir, "no-home") });
    assert.deepEqual(r, { ok: true, via: "file" });
    assert.equal(fs.existsSync(f.file), true);
    assert.equal(fs.existsSync(path.join(f.dir, "no-home")), false);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI path
// ---------------------------------------------------------------------------

interface Call { bin: string; args: string[]; cwd: string }

/** A fake `claude` that applies add-json / remove to the config file like the real CLI would. */
function fakeClaude(f: Fx, calls: Call[], mode: { writes?: boolean; status?: number; stderr?: string } = {}): NonNullable<LocalMcpOptions["run"]> {
  return (bin, args, cwd) => {
    calls.push({ bin, args, cwd });
    const status = mode.status ?? 0;
    if (status === 0 && mode.writes !== false) {
      const cfg = fs.existsSync(f.file) ? JSON.parse(fs.readFileSync(f.file, "utf8")) : {};
      cfg.projects ??= {};
      const key = claudeProjectKey(cwd);
      cfg.projects[key] ??= {};
      cfg.projects[key].mcpServers ??= {};
      if (args[1] === "add-json") cfg.projects[key].mcpServers[args[4]] = JSON.parse(args[5]);
      if (args[1] === "remove") delete cfg.projects[key].mcpServers[args[2]];
      fs.writeFileSync(f.file, JSON.stringify(cfg, null, 2));
    }
    return { status, stderr: mode.stderr } as CliRunResult;
  };
}

test("CLI add uses `mcp add-json --scope local <id> <json>` with cwd = project", async () => {
  const f = fx({ binary: "/fake/claude" });
  const calls: Call[] = [];
  f.opts.run = fakeClaude(f, calls);
  try {
    const r = await registerLocalMcpServer(f.root, "srv", CFG, f.opts);
    assert.deepEqual(r, { ok: true, via: "cli" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, "/fake/claude");
    assert.deepEqual(calls[0].args, ["mcp", "add-json", "--scope", "local", "srv", JSON.stringify(CFG)]);
    assert.equal(calls[0].cwd, f.root);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("CLI replace of a different existing entry removes first, then adds", async () => {
  const f = fx({ binary: "/fake/claude" });
  const calls: Call[] = [];
  f.opts.run = fakeClaude(f, calls);
  try {
    writeCfg(f, { projects: { [f.key]: { mcpServers: { srv: { command: "old" } } } } });
    const r = await registerLocalMcpServer(f.root, "srv", CFG, f.opts);
    assert.equal(r.via, "cli");
    assert.deepEqual(calls.map((c) => c.args.slice(0, 2)), [["mcp", "remove"], ["mcp", "add-json"]]);
    assert.deepEqual(calls[0].args, ["mcp", "remove", "srv", "--scope", "local"]);
    assert.deepEqual(readCfg(f).projects[f.key].mcpServers.srv, CFG);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("an async run seam is awaited", async () => {
  const f = fx({ binary: "/fake/claude" });
  const calls: Call[] = [];
  const inner = fakeClaude(f, calls);
  f.opts.run = async (...a) => {
    await new Promise((r) => setTimeout(r, 5));
    return inner(...a);
  };
  try {
    assert.equal((await registerLocalMcpServer(f.root, "srv", CFG, f.opts)).via, "cli");
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("CLI exit 0 that did not actually register falls back to the file", async () => {
  const f = fx({ binary: "/fake/claude" });
  const calls: Call[] = [];
  f.opts.run = fakeClaude(f, calls, { writes: false });
  try {
    const r = await registerLocalMcpServer(f.root, "srv", CFG, f.opts);
    assert.deepEqual(r, { ok: true, via: "file" });
    assert.deepEqual(readCfg(f).projects[f.key].mcpServers.srv, CFG);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("CLI nonzero exit falls back to the file write", async () => {
  const f = fx({ binary: "/fake/claude" });
  const calls: Call[] = [];
  f.opts.run = fakeClaude(f, calls, { status: 1, stderr: "boom" });
  try {
    const r = await registerLocalMcpServer(f.root, "srv", CFG, f.opts);
    assert.deepEqual(r, { ok: true, via: "file" });
    assert.equal(calls.length, 1);
    assert.deepEqual(readCfg(f).projects[f.key].mcpServers.srv, CFG);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("CLI failure plus an unwritable file reports both errors", async () => {
  const f = fx({ binary: "/fake/claude" });
  f.opts.run = () => ({ status: 2, stderr: "  boom happened  " });
  try {
    fs.writeFileSync(f.file, "{bad");
    const r = await registerLocalMcpServer(f.root, "srv", CFG, f.opts);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not valid JSON/);
    assert.match(r.error ?? "", /claude CLI: boom happened/);
    assert.equal(fs.readFileSync(f.file, "utf8"), "{bad");
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a run seam that throws, rejects or reports an error is treated as a CLI failure", async () => {
  const runs: Array<NonNullable<LocalMcpOptions["run"]>> = [
    () => { throw new Error("spawn exploded"); },
    () => Promise.reject(new Error("spawn rejected")),
    () => ({ status: null, error: new Error("ENOENT") }),
  ];
  for (const run of runs) {
    const f = fx({ binary: "/fake/claude", run });
    try {
      fs.writeFileSync(f.file, "{bad");
      const r = await registerLocalMcpServer(f.root, "srv", CFG, f.opts);
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /claude CLI: /);
      // And with a good file the same failure still ends in a file write.
      fs.writeFileSync(f.file, "{}");
      assert.equal((await registerLocalMcpServer(f.root, "srv", CFG, f.opts)).via, "file");
    } finally {
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

test("binary: null never calls the CLI", async () => {
  const f = fx({ binary: null });
  let runs = 0;
  f.opts.run = () => { runs++; return { status: 0 }; };
  try {
    assert.equal((await registerLocalMcpServer(f.root, "srv", CFG, f.opts)).via, "file");
    assert.equal((await removeLocalMcpServer(f.root, "srv", f.opts)).via, "file");
    assert.equal(runs, 0);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("CLI remove uses `mcp remove <id> --scope local` and reports cli; absent ids never call it", async () => {
  const f = fx({ binary: "/fake/claude" });
  const calls: Call[] = [];
  f.opts.run = fakeClaude(f, calls);
  try {
    assert.deepEqual(await removeLocalMcpServer(f.root, "srv", f.opts), { ok: true, via: "unchanged" });
    assert.equal(calls.length, 0);
    writeCfg(f, { projects: { [f.key]: { mcpServers: { srv: CFG } } } });
    assert.deepEqual(await removeLocalMcpServer(f.root, "srv", f.opts), { ok: true, via: "cli" });
    assert.deepEqual(calls[0].args, ["mcp", "remove", "srv", "--scope", "local"]);
    assert.equal(calls[0].cwd, f.root);
    assert.equal(hasLocalMcpServer(f.root, "srv", f.opts), false);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a failing CLI remove still removes the entry through the file sweep", async () => {
  const f = fx({ binary: "/fake/claude" });
  f.opts.run = () => ({ status: 1, stderr: "nope" });
  try {
    writeCfg(f, { projects: { [f.key]: { mcpServers: { srv: CFG, keep: CFG } } } });
    const r = await removeLocalMcpServer(f.root, "srv", f.opts);
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(readCfg(f).projects[f.key].mcpServers), ["keep"]);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("CLI timeout kills the child and ends in an error result", async () => {
  const f = fx();
  const hang = path.join(f.dir, "hang.js");
  const pidFile = path.join(f.dir, "pid.txt");
  fs.writeFileSync(hang, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`);
  try {
    fs.writeFileSync(f.file, "{bad"); // forces an error result after the CLI fails
    const env = { ...process.env, CLAUDE_CONFIG_DIR: f.dir, NODE_OPTIONS: `--require ${JSON.stringify(hang.replace(/\\/g, "/"))}` };
    const r = await registerLocalMcpServer(f.root, "srv", CFG, { env, binary: process.execPath, timeoutMs: 2500 });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /timed out/);
    assert.equal(fs.readFileSync(f.file, "utf8"), "{bad");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(pid > 0);
    let alive = true;
    for (let i = 0; i < 60 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((res) => setTimeout(res, 100));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "child was killed");
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a real process exiting nonzero is a CLI failure (default run, stderr trimmed in the error)", async () => {
  const f = fx();
  try {
    fs.writeFileSync(f.file, "{bad");
    const env = { ...process.env, CLAUDE_CONFIG_DIR: f.dir, NODE_OPTIONS: "" };
    const r = await registerLocalMcpServer(f.root, "srv", CFG, { env, binary: process.execPath, timeoutMs: 5000 });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /claude CLI: /);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("createLocalMcpOps wires has/set/remove to the same options", async () => {
  const f = fx();
  try {
    const ops = createLocalMcpOps("/hooks", f.opts);
    assert.equal(ops.hooksDir, "/hooks");
    assert.equal(ops.has(f.root, "srv"), false);
    assert.equal((await ops.set(f.root, "srv", CFG)).ok, true);
    assert.equal(ops.has(f.root, "srv"), true);
    assert.equal((await ops.remove(f.root, "srv")).ok, true);
    assert.equal(ops.has(f.root, "srv"), false);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// discoverClaudeBinary
// ---------------------------------------------------------------------------

test("discover: TYCOON_CLAUDE_BIN wins over PATH and the extension", () => {
  const env = { TYCOON_CLAUDE_BIN: "/opt/custom/claude", PATH: "/usr/bin" };
  const present = new Set(["/opt/custom/claude", "/usr/bin/claude"]);
  const r = discoverClaudeBinary({ env, platform: "linux", homedir: "/home/u", isFile: (p) => present.has(p), readdir: () => [] });
  assert.equal(r.bin, "/opt/custom/claude");
  assert.deepEqual(r.tried, ["TYCOON_CLAUDE_BIN"]);
});

test("discover: a TYCOON_CLAUDE_BIN that is not a file falls through to PATH", () => {
  const env = { TYCOON_CLAUDE_BIN: "/missing/claude", PATH: "/a:/b" };
  const r = discoverClaudeBinary({ env, platform: "linux", homedir: "/home/u", isFile: (p) => p === "/b/claude", readdir: () => [] });
  assert.equal(r.bin, "/b/claude");
  assert.deepEqual(r.tried.slice(0, 2), ["TYCOON_CLAUDE_BIN", "PATH"]);
});

test("discover: TYCOON_CLAUDE_BIN=none (any case) finds nothing even when claude is on PATH", () => {
  for (const v of ["none", " NONE "]) {
    const r = discoverClaudeBinary({ env: { TYCOON_CLAUDE_BIN: v, PATH: "/usr/bin" }, platform: "linux", homedir: "/h", isFile: () => true, readdir: () => ["anthropic.claude-code-2.0.0"] });
    assert.equal(r.bin, undefined);
    assert.deepEqual(r.tried, ["TYCOON_CLAUDE_BIN=none"]);
  }
});

test("discover: PATH beats the bundled extension binary (win32, claude.exe only)", () => {
  const env = { PATH: '"C:\\tools";C:\\bin' };
  const present = new Set(["C:\\bin\\claude.exe", "C:\\tools\\claude.cmd"]);
  const r = discoverClaudeBinary({ env, platform: "win32", homedir: "C:\\Users\\u", isFile: (p) => present.has(p), readdir: () => ["anthropic.claude-code-9.9.9"] });
  assert.equal(r.bin, "C:\\bin\\claude.exe");
});

test("discover: bundled extension binary is the last resort and the newest version wins", () => {
  const home = "C:\\Users\\u";
  const names: Record<string, string[]> = {
    [path.win32.join(home, ".vscode", "extensions")]: ["anthropic.claude-code-2.0.9-win32-x64", "anthropic.claude-code-2.0.10-win32-x64", "other.ext-1"],
    [path.win32.join(home, ".cursor", "extensions")]: ["anthropic.claude-code-1.9.0"],
  };
  const r = discoverClaudeBinary({
    env: { PATH: "" },
    platform: "win32",
    homedir: home,
    isFile: (p) => p.endsWith("claude.exe") && p.includes("native-binary"),
    readdir: (d) => {
      if (!names[d]) throw new Error("ENOENT");
      return names[d];
    },
  });
  assert.equal(r.bin, path.win32.join(home, ".vscode", "extensions", "anthropic.claude-code-2.0.10-win32-x64", "resources", "native-binary", "claude.exe"));
  assert.ok(r.tried.includes("Claude Code editor extension (resources/native-binary)"));
});

test("discover: nothing found returns no bin and a tried list", () => {
  const r = discoverClaudeBinary({ env: { PATH: "" }, platform: "win32", homedir: "C:\\Users\\u", isFile: () => false, readdir: () => { throw new Error("x"); } });
  assert.equal(r.bin, undefined);
  assert.ok(r.tried.length >= 2);
});

test("discover: win32 native installer location is probed before the extension", () => {
  const native = path.win32.join("C:\\Users\\u", ".local", "bin", "claude.exe");
  const r = discoverClaudeBinary({ env: { PATH: "" }, platform: "win32", homedir: "C:\\Users\\u", isFile: (p) => p === native, readdir: () => ["anthropic.claude-code-1.0.0"] });
  assert.equal(r.bin, native);
});

// ---------------------------------------------------------------------------
// localizeMcpConfig
// ---------------------------------------------------------------------------

function hooksDirWith(files: string[]): { dir: string; hooks: string } {
  const dir = tmp("local-hooks-");
  const hooks = path.join(dir, "ext", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  for (const n of files) fs.writeFileSync(path.join(hooks, n), "// stub\n");
  return { dir, hooks };
}

test("localizeMcpConfig points relative and absolute project hook args at the installed hooks dir", () => {
  const { dir, hooks } = hooksDirWith(["codex-mcp-launcher.cjs"]);
  try {
    const rel = { command: "node", args: [".claude/hooks/codex-mcp-launcher.cjs", "-c", 'model="x"'], env: { GEMINI_API_KEY: "" } };
    const out = localizeMcpConfig(rel, hooks, { platform: "win32" });
    assert.equal(out.ok, true);
    const cfg = (out as any).config;
    assert.equal(cfg.args[0], installedBridgeScript(hooks, "codex-mcp-launcher.cjs"));
    assert.ok(cfg.args[0].includes("/"), "forward slashes");
    assert.equal(cfg.args[0].includes("\\"), false);
    assert.deepEqual(cfg.args.slice(1), ["-c", 'model="x"']);
    assert.equal(cfg.command, "node");
    assert.deepEqual(cfg.env, rel.env);
    assert.deepEqual(rel.args[0], ".claude/hooks/codex-mcp-launcher.cjs", "input not mutated");

    const abs = { command: "node", args: ["C:\\proj\\.claude\\hooks\\codex-mcp-launcher.cjs"] };
    const out2 = localizeMcpConfig(abs, hooks, { platform: "win32" }) as any;
    assert.equal(out2.config.args[0], installedBridgeScript(hooks, "codex-mcp-launcher.cjs"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("localizeMcpConfig fails when the script is missing from the install, and leaves non-bridge configs alone", () => {
  const { dir, hooks } = hooksDirWith([]);
  try {
    const miss = localizeMcpConfig({ command: "node", args: [".claude/hooks/codex-mcp-launcher.cjs"] }, hooks, { platform: "win32" });
    assert.equal(miss.ok, false);
    assert.match((miss as any).error, /codex-mcp-launcher\.cjs is missing/);

    const npx = { command: "npx", args: ["-y", "pkg@1.2.3"] };
    const o1 = localizeMcpConfig(npx, hooks, { platform: "win32" }) as any;
    assert.equal(o1.config, npx);
    const http = { type: "http", url: "https://example.test/mcp" };
    assert.equal((localizeMcpConfig(http, hooks) as any).config, http);
    // An unknown script under .claude/hooks is not rewritten.
    const unknown = { command: "node", args: [".claude/hooks/evil.cjs"] };
    assert.equal((localizeMcpConfig(unknown, hooks, { platform: "win32" }) as any).config, unknown);
    assert.equal((localizeMcpConfig("str", hooks) as any).config, "str");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("localised configs carry env var names only, never secret values", async () => {
  const { dir, hooks } = hooksDirWith(["gemini-mcp-wrapper.cjs"]);
  const f = fx();
  const SECRET = "sk-SECRET-VALUE-do-not-persist";
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = SECRET;
  try {
    // The catalog gemini entry: credentials are referenced by variable name (requiresEnv), not copied.
    const catalog = JSON.parse(fs.readFileSync(path.join(process.cwd(), "media", "mcp", "catalog.json"), "utf8")) as any[];
    const entry = catalog.find((e) => e.id === "gemini");
    assert.deepEqual(entry.requiresEnv, ["GEMINI_API_KEY"]);
    const out = localizeMcpConfig(entry.config, hooks, { platform: "win32" }) as any;
    assert.equal(out.ok, true);
    assert.equal(JSON.stringify(out.config).includes(SECRET), false);
    await registerLocalMcpServer(f.root, "gemini", out.config, f.opts);
    assert.equal(fs.readFileSync(f.file, "utf8").includes(SECRET), false);
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
