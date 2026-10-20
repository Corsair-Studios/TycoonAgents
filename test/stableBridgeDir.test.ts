import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Never let a test reach the real Claude config or the real `claude` binary.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-claude-cfg-"));
process.env.TYCOON_CLAUDE_BIN = "none";

import {
  STABLE_STAMP_FILE,
  compareVersions,
  installStableBridges,
  isInStableBridgeDir,
  isTrustedStableScript,
  resolveStableBridgeDir,
} from "../src/core/stableBridgeDir";
import { claudeProjectKey, readLocalMcpServers, registerLocalMcpServer, replaceLocalMcpEntrySafely } from "../src/core/claudeLocalMcp";
import type { LocalMcpOptions } from "../src/core/claudeLocalMcp";
import { installKindOf, isOurLocalEntry, repointLocalMcpEntries, stableLocalMcp } from "../src/core/claudeLocalMcpSync";
import { MCP_BRIDGE_HOOK_FILES } from "../src/host/vscode/hookInstall";
import { detectCodexDispatcherState, mergeDispatcherIntoConfigToml } from "../src/providers/codex/installCodexDispatcher";

const fwd = (p: string): string => p.replace(/\\/g, "/");
const sha = (p: string): string => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

interface Fx {
  dir: string;
  src: string;
  stable: string;
  cfgFile: string;
  root: string;
  opts: LocalMcpOptions;
}

function fx(files: string[] = ["codex-mcp-launcher.cjs", "bridge-result.cjs"]): Fx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stable-bridge-"));
  const src = path.join(dir, "ext", "tycoonagents.tycoonagents-1.0.0", "hooks");
  fs.mkdirSync(src, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(src, f), `// ${f} v1\n`);
  const cfgDir = path.join(dir, "cfg");
  fs.mkdirSync(cfgDir);
  const root = path.join(dir, "proj");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(dir, "ext", "tycoonagents.tycoonagents-1.0.0", "package.json"), JSON.stringify({ name: "tycoonagents", version: "1.0.0" }));
  const home = path.join(dir, "home");
  const stable = fwd(path.join(home, ".tycoonagents", "bin"));
  return {
    dir,
    src,
    stable,
    cfgFile: path.join(cfgDir, ".claude.json"),
    root,
    opts: { env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir }, homedir: home, binary: null, platform: "win32", verifyDelayMs: 0 },
  };
}
const done = (f: Fx): void => fs.rmSync(f.dir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Location ladder
// ---------------------------------------------------------------------------

test("stable dir is <home>/.tycoonagents/bin and no environment variable can move it", () => {
  const saved = process.env.TYCOON_BRIDGE_DIR;
  process.env.TYCOON_BRIDGE_DIR = "/evil/dir";
  try {
    assert.equal(resolveStableBridgeDir({ platform: "linux", homedir: "/home/u" }).dir, "/home/u/.tycoonagents/bin");
    assert.equal(isInStableBridgeDir("/evil/dir/codex-mcp-launcher.cjs", { platform: "linux", homedir: "/home/u" }), false);
    assert.equal(isInStableBridgeDir("/home/u/.tycoonagents/bin/codex-mcp-launcher.cjs", { platform: "linux", homedir: "/home/u" }), true);
    const none = resolveStableBridgeDir({ homedir: "" });
    assert.equal(none.dir, undefined);
    assert.match(none.error ?? "", /home folder/);
  } finally {
    if (saved === undefined) delete process.env.TYCOON_BRIDGE_DIR;
    else process.env.TYCOON_BRIDGE_DIR = saved;
  }
});

test("a repo-set TYCOON_BRIDGE_DIR does not change trust classification of local entries", () => {
  const f = fx();
  const saved = process.env.TYCOON_BRIDGE_DIR;
  try {
    installStableBridges(f.src, { ...f.opts, version: "1.0.0" });
    const evil = fwd(path.join(f.dir, "evil"));
    fs.mkdirSync(evil);
    fs.writeFileSync(path.join(evil, "codex-mcp-launcher.cjs"), "// evil\n");
    process.env.TYCOON_BRIDGE_DIR = evil;
    const o = { ...f.opts, env: { ...f.opts.env, TYCOON_BRIDGE_DIR: evil } };
    assert.equal(installKindOf(`${evil}/codex-mcp-launcher.cjs`, o), "standalone");
    assert.equal(isTrustedStableScript(`${evil}/codex-mcp-launcher.cjs`, o), false);
    assert.equal(isTrustedStableScript(`${f.stable}/codex-mcp-launcher.cjs`, o), true);
  } finally {
    if (saved === undefined) delete process.env.TYCOON_BRIDGE_DIR;
    else process.env.TYCOON_BRIDGE_DIR = saved;
    done(f);
  }
});

test("prerelease-aware compare: 1.0.0 > 1.0.0-beta.2 > 1.0.0-beta.1; 1.0.10 > 1.0.9", () => {
  assert.ok(compareVersions("1.0.0", "1.0.0-beta.2") > 0);
  assert.ok(compareVersions("1.0.0-beta.2", "1.0.0-beta.1") > 0);
  assert.ok(compareVersions("1.0.0-beta.10", "1.0.0-beta.9") > 0);
  assert.ok(compareVersions("1.0.10", "1.0.9") > 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("install is a no-op ('skipped') without an injected home or activation, and refuses a source that is not TycoonAgents", () => {
  const f = fx();
  try {
    assert.equal(installStableBridges(f.src, { version: "1.0.0" }).status, "skipped");
    fs.writeFileSync(path.join(f.src, "..", "package.json"), JSON.stringify({ name: "other", version: "1.0.0" }));
    const r = installStableBridges(f.src, { ...f.opts });
    assert.equal(r.status, "error");
    assert.match(r.errors.join(" "), /not a TycoonAgents install folder/);
    assert.equal(fs.existsSync(f.stable), false);
  } finally {
    done(f);
  }
});

// ---------------------------------------------------------------------------
// Copy: atomic, hash-verified, write-only-on-change, never downgrades
// ---------------------------------------------------------------------------

test("install copies the closure, adds the CommonJS marker and a stamp, and leaves no temp files", () => {
  const f = fx();
  try {
    const r = installStableBridges(f.src, { ...f.opts, version: "1.0.0" });
    assert.equal(r.status, "installed", r.errors.join(";"));
    for (const n of ["codex-mcp-launcher.cjs", "bridge-result.cjs"]) assert.equal(sha(path.join(f.stable, n)), sha(path.join(f.src, n)));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.stable, "package.json"), "utf8")), { type: "commonjs" });
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.stable, STABLE_STAMP_FILE), "utf8")).version, "1.0.0");
    assert.deepEqual(fs.readdirSync(f.stable).filter((n) => n.endsWith(".tmp")), []);
  } finally {
    done(f);
  }
});

test("install writes only when content differs (second run touches nothing; one changed file rewrites only it)", () => {
  const f = fx();
  try {
    installStableBridges(f.src, { ...f.opts, version: "1.0.0" });
    const before = fs.statSync(path.join(f.stable, "bridge-result.cjs")).mtimeMs;
    const again = installStableBridges(f.src, { ...f.opts, version: "1.0.0" });
    assert.equal(again.status, "current");
    assert.deepEqual(again.written, []);
    assert.equal(fs.statSync(path.join(f.stable, "bridge-result.cjs")).mtimeMs, before);
    fs.writeFileSync(path.join(f.src, "bridge-result.cjs"), "// v1.1\n");
    const upd = installStableBridges(f.src, { ...f.opts, version: "1.0.1" });
    assert.deepEqual(upd.written, ["bridge-result.cjs"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.stable, STABLE_STAMP_FILE), "utf8")).version, "1.0.1");
  } finally {
    done(f);
  }
});

test("equal versions never ping-pong: existing files are kept, only missing ones are filled in", () => {
  const f = fx();
  try {
    installStableBridges(f.src, { ...f.opts, version: "1.0.0" });
    fs.writeFileSync(path.join(f.stable, "codex-mcp-launcher.cjs"), "// other editor same version\n");
    fs.unlinkSync(path.join(f.stable, "bridge-result.cjs"));
    const r = installStableBridges(f.src, { ...f.opts, version: "1.0.0" });
    assert.deepEqual(r.written, ["bridge-result.cjs"]);
    assert.equal(fs.readFileSync(path.join(f.stable, "codex-mcp-launcher.cjs"), "utf8"), "// other editor same version\n");
    // A higher version does overwrite it.
    assert.deepEqual(installStableBridges(f.src, { ...f.opts, version: "1.0.1" }).written, ["codex-mcp-launcher.cjs"]);
  } finally {
    done(f);
  }
});

test("install never downgrades: an older editor leaves a newer editor's files and stamp alone (two editors, one home)", () => {
  const newer = fx();
  try {
    installStableBridges(newer.src, { ...newer.opts, version: "2.0.0" });
    // A second editor still on 1.0.0 with different bytes.
    const olderSrc = path.join(newer.dir, "ext", "tycoonagents.tycoonagents-1.0.0-old", "hooks");
    fs.mkdirSync(olderSrc, { recursive: true });
    fs.writeFileSync(path.join(olderSrc, "..", "package.json"), JSON.stringify({ name: "tycoonagents", version: "1.0.0" }));
    for (const n of ["codex-mcp-launcher.cjs", "bridge-result.cjs"]) fs.writeFileSync(path.join(olderSrc, n), `// OLD ${n}\n`);
    const before = ["codex-mcp-launcher.cjs", "bridge-result.cjs", STABLE_STAMP_FILE].map((n) => fs.readFileSync(path.join(newer.stable, n), "utf8"));
    const r = installStableBridges(olderSrc, { ...newer.opts, version: "1.0.0" });
    assert.equal(r.status, "newer");
    assert.deepEqual(r.written, []);
    const after = ["codex-mcp-launcher.cjs", "bridge-result.cjs", STABLE_STAMP_FILE].map((n) => fs.readFileSync(path.join(newer.stable, n), "utf8"));
    assert.deepEqual(after, before);
    // And a numeric (not lexical) comparison: 1.0.10 > 1.0.9.
    const dir2 = fx();
    try {
      installStableBridges(dir2.src, { ...dir2.opts, version: "1.0.10" });
      assert.equal(installStableBridges(dir2.src, { ...dir2.opts, version: "1.0.9" }).status, "newer");
    } finally {
      done(dir2);
    }
  } finally {
    done(newer);
  }
});

test("install reports an error (not a throw) when the source has no bridge scripts or the folder is unwritable", () => {
  const f = fx([]);
  try {
    const r = installStableBridges(f.src, { ...f.opts, version: "1.0.0" });
    assert.equal(r.status, "error");
    assert.match(r.errors.join(" "), /No bridge scripts/);
    const blocker = path.join(f.dir, "blocker");
    fs.writeFileSync(blocker, "x");
    fs.mkdirSync(path.join(f.dir, "home2"));
    fs.writeFileSync(path.join(f.dir, "home2", ".tycoonagents"), "x");
    const r2 = installStableBridges(f.src, { homedir: path.join(f.dir, "home2"), version: "1.0.0" });
    assert.equal(r2.status, "error");
  } finally {
    done(f);
  }
});

test("stableLocalMcp returns ops bound to the stable dir and an error when no home exists", () => {
  const f = fx();
  try {
    const ok = stableLocalMcp(f.opts);
    assert.equal(ok.error, undefined);
    assert.equal(ok.ops.hooksDir, f.stable);
    const bad = stableLocalMcp({ homedir: "" });
    assert.match(bad.error ?? "", /home folder/);
  } finally {
    done(f);
  }
});

// ---------------------------------------------------------------------------
// Trust checks
// ---------------------------------------------------------------------------

test("trust: the stable dir is canonical; project dirs, versioned dirs and look-alike paths are not", () => {
  const f = fx();
  try {
    installStableBridges(f.src, { ...f.opts, version: "1.0.0" });
    const good = `${f.stable}/codex-mcp-launcher.cjs`;
    assert.equal(isInStableBridgeDir(good, f.opts), true);
    assert.equal(installKindOf(good, f.opts), "stable");
    assert.equal(isTrustedStableScript(good, f.opts), true);
    assert.equal(isOurLocalEntry({ command: "node", args: [good] }, f.opts), true);
    const lookAlikes = [
      `${f.stable}-evil/codex-mcp-launcher.cjs`,
      `${f.stable}/sub/codex-mcp-launcher.cjs`,
      `${fwd(f.root)}/.claude/hooks/codex-mcp-launcher.cjs`,
      `${fwd(f.root)}/.tycoonagents/bin/codex-mcp-launcher.cjs`,
      `C:/x/tycoonagents.tycoonagents-1.0.0/hooks/codex-mcp-launcher.cjs`,
    ];
    for (const p of lookAlikes) {
      assert.equal(isInStableBridgeDir(p, f.opts), false, p);
      assert.equal(isTrustedStableScript(p, f.opts), false, p);
    }
    // A name that is not one of our bridges is never "ours", even inside the stable dir.
    assert.equal(isOurLocalEntry({ command: "node", args: [`${f.stable}/evil.cjs`] }, f.opts), false);
    // Missing file is not trusted.
    assert.equal(isTrustedStableScript(`${f.stable}/gemini-mcp-wrapper.cjs`, f.opts), false);
  } finally {
    done(f);
  }
});

test("trust: a symlinked script or a symlinked stable folder is rejected", (t) => {
  const f = fx();
  try {
    installStableBridges(f.src, { ...f.opts, version: "1.0.0" });
    const elsewhere = path.join(f.dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "gemini-mcp-wrapper.cjs"), "// evil\n");
    try {
      fs.symlinkSync(path.join(elsewhere, "gemini-mcp-wrapper.cjs"), path.join(f.stable, "gemini-mcp-wrapper.cjs"));
    } catch {
      t.skip("cannot create symlinks here (EPERM)");
      return;
    }
    assert.equal(isTrustedStableScript(`${f.stable}/gemini-mcp-wrapper.cjs`, f.opts), false);
  } finally {
    done(f);
  }
});

test("trust: a stable folder that is a junction/symlink to another folder is rejected", () => {
  const f = fx();
  try {
    const elsewhere = path.join(f.dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "codex-mcp-launcher.cjs"), "// x\n");
    const home3 = path.join(f.dir, "home3");
    fs.mkdirSync(path.join(home3, ".tycoonagents"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(home3, ".tycoonagents", "bin"), "junction");
    const script = `${fwd(home3)}/.tycoonagents/bin/codex-mcp-launcher.cjs`;
    assert.equal(isInStableBridgeDir(script, { homedir: home3 }), true, "lexically inside");
    assert.equal(isTrustedStableScript(script, { homedir: home3 }), false);
    const r = installStableBridges(f.src, { homedir: home3, version: "1.0.0" });
    assert.equal(r.status, "error", "install refuses to write through a link");
  } finally {
    done(f);
  }
});

// The dispatcher spawns only its own copy; a request that resolves into the stable folder is accepted
// as canonical, a same-named file anywhere else (a project dir, a look-alike folder) is not.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require("../../hooks/dispatcherBridgeClient.cjs") as {
  resolveTrustedBridge: (server: string, entry: unknown, projectDir: string, hooksDir: string) => { error?: string; kind?: string; args?: string[] };
};

test("dispatcher resolveTrustedBridge: <os.homedir()>/.tycoonagents/bin is canonical; env, project and look-alike locations are untrusted", () => {
  const f = fx(["gemini-mcp-wrapper.cjs"]);
  const saved = { up: process.env.USERPROFILE, home: process.env.HOME, bd: process.env.TYCOON_BRIDGE_DIR };
  const home = path.join(f.dir, "home");
  try {
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    installStableBridges(f.src, { ...f.opts, version: "1.0.0" });
    const own = f.src;
    const entry = (script: string): unknown => ({ command: "node", args: [script] });
    const ok = client.resolveTrustedBridge("gemini", entry(`${f.stable}/gemini-mcp-wrapper.cjs`), f.root, own);
    assert.equal(ok.error, undefined);
    assert.equal(path.basename((ok.args ?? [""])[0]), "gemini-mcp-wrapper.cjs");
    // Same name in a project dir.
    const proj = path.join(f.root, ".claude", "hooks");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, "gemini-mcp-wrapper.cjs"), "// forged\n");
    assert.equal(client.resolveTrustedBridge("gemini", entry(".claude/hooks/gemini-mcp-wrapper.cjs"), f.root, own).kind, "bridge_untrusted");
    // Look-alike sibling folder.
    const sib = `${f.stable}-evil`;
    fs.mkdirSync(sib, { recursive: true });
    fs.writeFileSync(path.join(sib, "gemini-mcp-wrapper.cjs"), "// forged\n");
    assert.equal(client.resolveTrustedBridge("gemini", entry(`${sib}/gemini-mcp-wrapper.cjs`), f.root, own).kind, "bridge_untrusted");
    // A repo-set TYCOON_BRIDGE_DIR cannot make another folder trusted.
    process.env.TYCOON_BRIDGE_DIR = sib;
    assert.equal(client.resolveTrustedBridge("gemini", entry(`${sib}/gemini-mcp-wrapper.cjs`), f.root, own).kind, "bridge_untrusted");
    // A stable folder that is a junction is untrusted, even for a file that exists.
    delete process.env.TYCOON_BRIDGE_DIR;
    const real = path.join(f.dir, "real-bin");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "gemini-mcp-wrapper.cjs"), "// x\n");
    fs.rmSync(f.stable, { recursive: true, force: true });
    fs.symlinkSync(real, f.stable, "junction");
    assert.equal(client.resolveTrustedBridge("gemini", entry(`${f.stable}/gemini-mcp-wrapper.cjs`), f.root, own).kind, "bridge_untrusted");
  } finally {
    for (const [k, v] of [["USERPROFILE", saved.up], ["HOME", saved.home], ["TYCOON_BRIDGE_DIR", saved.bd]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    done(f);
  }
});

// ---------------------------------------------------------------------------
// Migration: versioned -> stable, verify-and-retry, warning when missing
// ---------------------------------------------------------------------------

function versionedEntry(f: Fx): Record<string, unknown> {
  return { command: "node", args: [fwd(path.join(f.src, "codex-mcp-launcher.cjs")), "-c", "model=x"], env: { KEEP: "1" } };
}

function readCfg(f: Fx): any {
  return JSON.parse(fs.readFileSync(f.cfgFile, "utf8"));
}

test("migration rewrites a versioned entry once, keeps a stable entry byte-identical afterwards, and preserves the rest of the file", async () => {
  const f = fx();
  try {
    installStableBridges(f.src, { ...f.opts, version: "1.0.0" });
    fs.writeFileSync(f.cfgFile, JSON.stringify({ userID: "keep", projects: { [claudeProjectKey(f.root)]: { allowedTools: ["x"], mcpServers: { codex: versionedEntry(f), other: { command: "npx", args: ["y"] } } } } }, null, 2));
    const r = await repointLocalMcpEntries(f.root, f.stable, ["codex"], f.opts);
    assert.deepEqual(r, { repointed: ["codex"], errors: [], missing: [] });
    const cfg = readCfg(f);
    assert.equal(cfg.userID, "keep");
    const proj = cfg.projects[claudeProjectKey(f.root)];
    assert.deepEqual(proj.allowedTools, ["x"]);
    assert.deepEqual(proj.mcpServers.other, { command: "npx", args: ["y"] });
    assert.equal(proj.mcpServers.codex.args[0], `${f.stable}/codex-mcp-launcher.cjs`);
    assert.deepEqual(proj.mcpServers.codex.args.slice(1), ["-c", "model=x"]);
    const bytes = fs.readFileSync(f.cfgFile, "utf8");
    // An "update" to a new extension version (stable files change, entry does not).
    fs.writeFileSync(path.join(f.src, "codex-mcp-launcher.cjs"), "// v2\n");
    installStableBridges(f.src, { ...f.opts, version: "1.0.1" });
    assert.deepEqual(await repointLocalMcpEntries(f.root, f.stable, ["codex"], f.opts), { repointed: [], errors: [], missing: [] });
    assert.equal(fs.readFileSync(f.cfgFile, "utf8"), bytes);
  } finally {
    done(f);
  }
});

test("migration keeps the existing entry when the rewrite cannot be written (never removes first)", async () => {
  const f = fx();
  try {
    installStableBridges(f.src, { ...f.opts, version: "1.0.0" });
    const entry = versionedEntry(f);
    // An unexpected "mcpServers" shape in a sibling-cased key makes the edit refuse; the entry must stay.
    fs.writeFileSync(f.cfgFile, JSON.stringify({ projects: { [claudeProjectKey(f.root)]: { mcpServers: { codex: entry } }, [claudeProjectKey(f.root).toUpperCase()]: { mcpServers: "bad" } } }));
    const before = fs.readFileSync(f.cfgFile, "utf8");
    const r = await repointLocalMcpEntries(f.root, f.stable, ["codex"], f.opts);
    assert.deepEqual(r.repointed, []);
    assert.deepEqual(r.missing, []);
    assert.equal(r.errors.length, 1);
    assert.equal(fs.readFileSync(f.cfgFile, "utf8"), before);
  } finally {
    done(f);
  }
});

/** Simulates a running Claude Code rewriting ~/.claude.json from its stale in-memory copy. */
function clobberAt(f: Fx, delaysMs: number[], snapshot: string): NodeJS.Timeout[] {
  return delaysMs.map((d) => setTimeout(() => fs.writeFileSync(f.cfgFile, snapshot), d));
}

test("migration retries once when Claude Code clobbers the first write", async () => {
  const f = fx();
  try {
    installStableBridges(f.src, { ...f.opts, version: "1.0.0" });
    const entry = versionedEntry(f);
    const snapshot = JSON.stringify({ projects: { [claudeProjectKey(f.root)]: { mcpServers: { codex: entry } } } }, null, 2);
    fs.writeFileSync(f.cfgFile, snapshot);
    const opts = { ...f.opts, verifyDelayMs: 60 };
    const timers = clobberAt(f, [25], snapshot);
    const r = await repointLocalMcpEntries(f.root, f.stable, ["codex"], opts);
    timers.forEach(clearTimeout);
    assert.deepEqual(r, { repointed: ["codex"], errors: [], missing: [] });
    assert.equal(readCfg(f).projects[claudeProjectKey(f.root)].mcpServers.codex.args[0], `${f.stable}/codex-mcp-launcher.cjs`);
  } finally {
    done(f);
  }
});

test("migration reports the server as missing (for the panel warning) when the entry is gone after the retry", async () => {
  const f = fx();
  try {
    installStableBridges(f.src, { ...f.opts, version: "1.0.0" });
    const entry = versionedEntry(f);
    fs.writeFileSync(f.cfgFile, JSON.stringify({ projects: { [claudeProjectKey(f.root)]: { mcpServers: { codex: entry } } } }, null, 2));
    const gone = JSON.stringify({ projects: { [claudeProjectKey(f.root)]: { mcpServers: {} } } }, null, 2);
    // Wide margins: clobber 1 lands before verify 1 (>=300ms); clobber 2 lands after the retry write but before
    // verify 2 (>=600ms), even when slow sync fs work under suite load delays the first verify pause.
    const opts = { ...f.opts, verifyDelayMs: 300 };
    const timers = clobberAt(f, [100, 450], gone);
    const r = await repointLocalMcpEntries(f.root, f.stable, ["codex"], opts);
    timers.forEach(clearTimeout);
    assert.deepEqual(r.repointed, []);
    assert.deepEqual(r.missing, ["codex"]);
    assert.equal(r.errors.length, 1);
  } finally {
    done(f);
  }
});

test("replaceLocalMcpEntrySafely leaves an entry the user changed meanwhile alone", async () => {
  const f = fx();
  try {
    const old = versionedEntry(f);
    const changed = { command: "node", args: ["/somewhere/else.cjs"] };
    fs.writeFileSync(f.cfgFile, JSON.stringify({ projects: { [claudeProjectKey(f.root)]: { mcpServers: { codex: changed } } } }));
    const r = await replaceLocalMcpEntrySafely(f.root, "codex", old, { command: "node", args: ["/new.cjs"] }, f.opts);
    assert.equal(r.outcome, "unchanged");
    assert.deepEqual(readLocalMcpServers(f.root, f.opts)["codex"], changed);
  } finally {
    done(f);
  }
});

test("registerLocalMcpServer restores the previous entry when the new one cannot be made to persist", async () => {
  const f = fx();
  try {
    const prev = versionedEntry(f);
    const snapshot = JSON.stringify({ projects: { [claudeProjectKey(f.root)]: { mcpServers: { codex: prev } } } }, null, 2);
    fs.writeFileSync(f.cfgFile, snapshot);
    const opts = { ...f.opts, verifyDelayMs: 300 };
    const timers = clobberAt(f, [100, 450], snapshot);
    const r = await registerLocalMcpServer(f.root, "codex", { command: "node", args: ["/new.cjs"] }, opts);
    timers.forEach(clearTimeout);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /previous entry was restored/);
    assert.deepEqual(readLocalMcpServers(f.root, f.opts)["codex"], prev);
  } finally {
    done(f);
  }
});

test("registerLocalMcpServer after a CLI remove+failed add always puts the previous entry back and verifies it", async () => {
  const f = fx();
  try {
    const prev = versionedEntry(f);
    fs.writeFileSync(f.cfgFile, JSON.stringify({ projects: { [claudeProjectKey(f.root)]: { mcpServers: { codex: prev } } } }, null, 2));
    // Fake CLI: remove deletes the entry, add-json of the new config fails, add-json of the previous works.
    const run: NonNullable<LocalMcpOptions["run"]> = (_bin, args) => {
      const cfg = readCfg(f);
      const servers = cfg.projects[claudeProjectKey(f.root)].mcpServers;
      if (args[1] === "remove") {
        delete servers.codex;
        fs.writeFileSync(f.cfgFile, JSON.stringify(cfg));
        return { status: 0 };
      }
      const given = JSON.parse(args[args.length - 1]);
      if (given.args[0] === "/new.cjs") return { status: 1, stderr: "boom" };
      servers.codex = given;
      fs.writeFileSync(f.cfgFile, JSON.stringify(cfg));
      return { status: 0 };
    };
    // Make the file fallback fail too (unexpected shape in a sibling-cased key) so only the CLI restore can work.
    const cfg0 = readCfg(f);
    cfg0.projects[claudeProjectKey(f.root).toUpperCase()] = { mcpServers: "bad" };
    fs.writeFileSync(f.cfgFile, JSON.stringify(cfg0));
    const r = await registerLocalMcpServer(f.root, "codex", { command: "node", args: ["/new.cjs"] }, { ...f.opts, binary: "claude", run });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /previous entry was restored/);
    assert.deepEqual(readLocalMcpServers(f.root, f.opts)["codex"], prev);
  } finally {
    done(f);
  }
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("hosts register against the stable dir: panel and standalone never bind local-scope ops to a versioned/hooks folder", () => {
  const panel = fs.readFileSync(path.join(process.cwd(), "src", "host", "vscode", "panel.ts"), "utf8");
  assert.doesNotMatch(panel, /createLocalMcpOps\(/);
  assert.match(panel, /stableLocalMcp\(/);
  const server = fs.readFileSync(path.join(process.cwd(), "standalone", "src", "server.mjs"), "utf8");
  assert.doesNotMatch(server, /createLocalMcpOps\(/);
  assert.match(server, /stableLocalMcp\(/);
  const ext = fs.readFileSync(path.join(process.cwd(), "src", "host", "vscode", "extension.ts"), "utf8");
  assert.match(ext, /installStableBridges\(/);
});

test("the whole bridge closure (MCP_BRIDGE_HOOK_FILES) is what gets copied from the real hooks folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stable-real-"));
  try {
    const stable = fwd(path.join(dir, ".tycoonagents", "bin"));
    const real = path.join(process.cwd(), "hooks");
    const r = installStableBridges(real, { homedir: dir, version: "9.9.9" });
    assert.notEqual(r.status, "error", r.errors.join(";"));
    for (const n of MCP_BRIDGE_HOOK_FILES) {
      if (fs.existsSync(path.join(real, n))) assert.equal(sha(path.join(stable, n)), sha(path.join(real, n)), n);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("codex dispatcher entry: a versioned script is stale against the stable folder; the stable script is installed; hosts use the stable folder", () => {
  const stableScript = "/home/u/.tycoonagents/bin/tycoon-dispatcher-mcp.cjs";
  const versioned = "/home/u/.vscode/extensions/tycoonagents.tycoonagents-0.0.744/hooks/tycoon-dispatcher-mcp.cjs";
  const mk = (script: string): string => mergeDispatcherIntoConfigToml(undefined, { nodePath: "node", serverScriptPath: script, envVarNames: ["A"] }).text;
  const exists = (): boolean => true;
  assert.equal(detectCodexDispatcherState(mk(versioned), stableScript, exists, ["A"]), "stale");
  assert.equal(detectCodexDispatcherState(mk(stableScript), stableScript, exists, ["A"]), "installed");
  const panel = fs.readFileSync(path.join(process.cwd(), "src", "host", "vscode", "panel.ts"), "utf8");
  assert.match(panel, /_codexDispatcherScriptPath\(\): string \{\s*return path\.join\(resolveStableBridgeDir\(\)/);
  const server = fs.readFileSync(path.join(process.cwd(), "standalone", "src", "server.mjs"), "utf8");
  assert.match(server, /serverScriptPath: codexDispatcherScriptPath\(\)/);
  assert.doesNotMatch(server, /CODEX_DISPATCHER_SCRIPT_PATH/);
});
