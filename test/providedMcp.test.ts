import { test } from "node:test";
import * as assert from "node:assert/strict";
import { providedMcpConfirmDetail, sanitizeProvidedMcpEntry } from "../src/core/providedMcp";

const good = { command: "node", args: ["C:/pt/uefn-server.mjs"], env: { UEFN_BRIDGE_DIR: "C:/tmp/bridge" } };

test("benign Power Tools entry passes unchanged", () => {
  const r = sanitizeProvidedMcpEntry("uefn-bridge", good);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.config, good);
});

test("explicit stdio type is dropped from the registered config", () => {
  const r = sanitizeProvidedMcpEntry("uefn-bridge", { type: "stdio", ...good });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.config, good);
});

test("refusal cases", () => {
  const bad: Array<[string, unknown, RegExp]> = [
    ["url", { url: "http://x" }, /url/],
    ["url+command", { url: "http://x", command: "node" }, /both/],
    ["type http", { type: "http", command: "node" }, /not stdio/],
    ["headers", { command: "node", headers: { a: "b" } }, /headers/],
    ["cwd", { command: "node", cwd: "/tmp" }, /cwd/],
    ["unknown key", { command: "node", foo: 1 }, /foo/],
    ["no command", { args: [] }, /no command/],
    ["newline", { command: "node", args: ["a\nb"] }, /control/],
    ["control char", { command: "no\u0007de" }, /control/],
    ["NODE_OPTIONS", { command: "node", env: { NODE_OPTIONS: "--require x" } }, /NODE_OPTIONS/],
    ["NODE_PATH", { command: "node", env: { NODE_PATH: "x" } }, /NODE_PATH/],
    ["LD_PRELOAD", { command: "node", env: { LD_PRELOAD: "x" } }, /LD_PRELOAD/],
    ["LD_LIBRARY_PATH", { command: "node", env: { LD_LIBRARY_PATH: "x" } }, /LD_LIBRARY_PATH/],
    ["DYLD_", { command: "node", env: { DYLD_INSERT_LIBRARIES: "x" } }, /DYLD_/],
    ["PYTHONPATH", { command: "node", env: { PYTHONPATH: "x" } }, /PYTHONPATH/],
    ["PYTHONSTARTUP", { command: "node", env: { PYTHONSTARTUP: "x" } }, /PYTHONSTARTUP/],
    ["PATH", { command: "node", env: { Path: "x" } }, /Path/],
    ["COMSPEC", { command: "node", env: { ComSpec: "x" } }, /ComSpec/],
    ["npm_config_", { command: "node", env: { npm_config_prefix: "x" } }, /npm_config_prefix/],
    ["oversize", { command: "node", args: ["x".repeat(2100)] }, /longer/],
    ["not object", "node", /not an object/],
  ];
  for (const [name, entry, re] of bad) {
    const r = sanitizeProvidedMcpEntry("uefn-bridge", entry);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.match(r.error, re, name);
  }
});

test("dialog detail contains exactly the registered config JSON", () => {
  const r = sanitizeProvidedMcpEntry("uefn-bridge", { ...good, type: "stdio" });
  assert.ok(r.ok);
  if (r.ok) assert.ok(providedMcpConfirmDetail("uefn-bridge", r.config).includes(JSON.stringify(r.config, null, 2)));
});

// ---------------------------------------------------------------------------
// Key aliases, discovery and state (both "powertools" and "uefn-bridge")
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  POWER_TOOLS_DIR_ENV,
  POWER_TOOLS_MCP_MISSING,
  POWER_TOOLS_REPO_URL,
  buildPowerToolsConfig,
  describePowerToolsChoice,
  discoverPowerTools,
  findProvidedMcpKey,
  isPowerToolsServerEntry,
  providedMcpKeys,
} from "../src/core/providedMcp";
import { mcpServerState } from "../src/core/bridgeSetup";
import { claudeProjectKey } from "../src/core/claudeLocalMcp";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A fake Power Tools folder: a Node script (never an .exe) plus an INSTALL.md carrying the product's repo URL. */
function fakePowerTools(dir: string, version: string, opts: { identified?: boolean; mtime?: number } = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  const server = path.join(dir, "uefn-server.mjs");
  fs.writeFileSync(server, "// fake MCP server\nprocess.exit(0);\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "trashbyrds-uefn-power-tools", version }));
  // a name alone is not an identity: only the repository URL in INSTALL.md / README.md is
  fs.writeFileSync(path.join(dir, "INSTALL.md"), opts.identified === false ? "# Power Tools\n" : `# Power Tools\n${POWER_TOOLS_REPO_URL}/blob/main/INSTALL.md\n`);
  if (opts.mtime !== undefined) fs.utimesSync(server, opts.mtime, opts.mtime);
  return dir;
}

/** root nested two levels deep so the parent and grandparent searches stay inside one temp tree. */
function hermeticLayout(): { base: string; root: string; home: string } {
  const base = tmp("providedMcp-");
  const root = path.join(base, "a", "b", "ws");
  const home = path.join(base, "home");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { base, root, home };
}

const PT_ENTRY = { command: "node", args: ["C:/pt/uefn-server.mjs"] };
const UNRELATED_ENTRY = { command: "python", args: ["-m", "something_else"] };

test("both server keys are recognised in a parsed .mcp.json, flat or nested, only when they launch uefn-server.mjs", () => {
  assert.deepEqual(providedMcpKeys("uefn-bridge"), ["powertools", "uefn-bridge"]);
  assert.deepEqual(providedMcpKeys("playwright"), ["playwright"]);
  assert.equal(findProvidedMcpKey({ mcpServers: { powertools: PT_ENTRY } }, "uefn-bridge"), "powertools");
  assert.equal(findProvidedMcpKey({ mcpServers: { "uefn-bridge": PT_ENTRY } }, "uefn-bridge"), "uefn-bridge");
  assert.equal(findProvidedMcpKey({ powertools: PT_ENTRY }, "uefn-bridge"), "powertools");
  assert.equal(findProvidedMcpKey({ mcpServers: { other: PT_ENTRY } }, "uefn-bridge"), undefined);
  assert.equal(findProvidedMcpKey({ mcpServers: { powertools: UNRELATED_ENTRY } }, "uefn-bridge"), undefined, "an unrelated entry of the same name is ignored");
  assert.equal(findProvidedMcpKey(null, "uefn-bridge"), undefined);
  assert.equal(isPowerToolsServerEntry({ command: "node", args: ["D:\\x\\uefn-server.mjs"] }), true);
  assert.equal(isPowerToolsServerEntry({ command: "node", args: ["not-uefn-server.mjs"] }), false);
  assert.equal(isPowerToolsServerEntry({ command: "node" }), false);
});

test("mcpServerState treats either key as the catalog server: pending from .mcp.json, installed from local scope; unrelated entries are ignored", () => {
  const { base, root } = hermeticLayout();
  const cfgDir = path.join(base, "claude-config");
  fs.mkdirSync(cfgDir, { recursive: true });
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfgDir; // temp config only: the real ~/.claude.json is never read or written
  const local = (entry: unknown, key: string): void => {
    fs.writeFileSync(path.join(cfgDir, ".claude.json"), JSON.stringify({ projects: { [claudeProjectKey(root)]: { mcpServers: { [key]: entry } } } }));
  };
  try {
    assert.equal(mcpServerState(root, "claude-code", "uefn-bridge"), "absent");
    for (const key of ["powertools", "uefn-bridge"]) {
      fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { [key]: PT_ENTRY } }));
      assert.equal(mcpServerState(root, "claude-code", "uefn-bridge"), "pending", `${key} in .mcp.json only`);
      assert.equal(mcpServerState(root, "codex", "uefn-bridge"), "installed", `${key} on a harness that reads .mcp.json`);
      fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { [key]: UNRELATED_ENTRY } }));
      assert.equal(mcpServerState(root, "claude-code", "uefn-bridge"), "absent", `${key} unrelated entry in .mcp.json`);
    }
    fs.rmSync(path.join(root, ".mcp.json"));
    for (const key of ["powertools", "uefn-bridge"]) {
      local(PT_ENTRY, key);
      assert.equal(mcpServerState(root, "claude-code", "uefn-bridge"), "installed", `${key} at local scope`);
      local(UNRELATED_ENTRY, key);
      assert.equal(mcpServerState(root, "claude-code", "uefn-bridge"), "absent", `${key} unrelated entry at local scope`);
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("discovery: the setting wins over the env var, which wins over the search; a bad override is an explicit error", () => {
  const { base, root, home } = hermeticLayout();
  try {
    fakePowerTools(path.join(base, "a", "b", "found-by-search"), "9.9.9");
    const viaSetting = fakePowerTools(path.join(base, "set"), "0.1.0");
    const viaEnv = fakePowerTools(path.join(base, "envdir"), "0.2.0");
    const env = { [POWER_TOOLS_DIR_ENV]: viaEnv };

    const a = discoverPowerTools({ root, settingDir: viaSetting, env, homeDir: home });
    assert.ok(a.ok);
    if (a.ok) {
      assert.equal(a.source, "setting");
      assert.equal(a.dir, path.resolve(viaSetting));
    }
    const b = discoverPowerTools({ root, env, homeDir: home });
    assert.ok(b.ok);
    if (b.ok) {
      assert.equal(b.source, "env");
      assert.equal(b.dir, path.resolve(viaEnv));
    }
    const c = discoverPowerTools({ root, settingDir: path.join(viaSetting, "uefn-server.mjs"), env: {}, homeDir: home });
    assert.ok(c.ok && c.dir === path.resolve(viaSetting));
    const d = discoverPowerTools({ root, settingDir: path.join(base, "nope"), env: {}, homeDir: home });
    assert.equal(d.ok, false);
    if (!d.ok) assert.match(d.error, /powerTools\.dir.*does not contain uefn-server\.mjs/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("discovery: a workspace fake is excluded (also through a link), even with version 999 and the newest file", () => {
  const { base, root, home } = hermeticLayout();
  try {
    const inside = fakePowerTools(path.join(root, "tools", "evil"), "999.0.0", { mtime: Date.now() / 1000 + 1000 });
    const real = fakePowerTools(path.join(base, "a", "b", "real"), "0.1.6", { mtime: 1_000_000 });
    // a sibling-level link that resolves into the workspace must not smuggle it back in
    let linked = false;
    try {
      fs.symlinkSync(inside, path.join(base, "a", "b", "linked"), "junction");
      linked = true;
    } catch {
      /* links not permitted here: the real-path rule is still covered by the direct case */
    }
    // a workspace that is itself a sibling-level folder holding a server file (what a cloned repo could ship)
    fakePowerTools(path.join(base, "a", "b", "ws"), "999.0.0");
    const r = discoverPowerTools({ root, workspaceFolders: [root], env: {}, homeDir: home });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.dir, path.resolve(real));
      assert.deepEqual(r.others, [], `workspace content never listed (linked=${linked})`);
    }
    // a second open workspace folder is excluded as well
    const second = path.join(base, "a", "b", "real");
    const r2 = discoverPowerTools({ root, workspaceFolders: [root, second], env: {}, homeDir: home });
    assert.equal(r2.ok, false, "the only install is under another open workspace folder");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("discovery: ranking ignores package.json versions: siblings beat home, then the newest file wins", () => {
  const { base, root, home } = hermeticLayout();
  try {
    const realSibling = fakePowerTools(path.join(base, "a", "b", "real-sibling"), "0.1.6", { mtime: 1_000_000 });
    const olderSibling = fakePowerTools(path.join(base, "a", "older"), "0.1.5", { mtime: 500_000 });
    const fakeInHome = fakePowerTools(path.join(home, "version-999"), "999.0.0", { mtime: Date.now() / 1000 });
    fakePowerTools(path.join(base, "a", "b", "decoy"), "99.0.0", { identified: false }); // name only: not an identity
    const r = discoverPowerTools({ root, env: {}, homeDir: home });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.source, "discovered");
      assert.equal(r.dir, path.resolve(realSibling), "version 999 in the home folder loses to a real sibling install");
      assert.deepEqual(r.others, [path.resolve(olderSibling), path.resolve(fakeInHome)]);
      assert.match(r.reason, /searched before|most recently modified/);
      const says = describePowerToolsChoice(r);
      for (const p of [realSibling, olderSibling, fakeInHome]) assert.ok(says.includes(path.resolve(p)), `lists ${p}`);
      assert.ok(says.includes(`> ${path.resolve(realSibling)}`) && says.includes("because"), "says which one is used and why");
    }
    // within one location the newest server file beats a higher version number
    const newer = fakePowerTools(path.join(base, "a", "b", "newer-lowver"), "0.0.1", { mtime: 2_000_000 });
    const r2 = discoverPowerTools({ root, env: {}, homeDir: home });
    assert.ok(r2.ok && r2.dir === path.resolve(newer));
    // an INSTALL.md-less folder identified by a README that carries the repo URL
    const readmeOnly = path.join(home, "pt-readme");
    fs.mkdirSync(readmeOnly);
    fs.writeFileSync(path.join(readmeOnly, "uefn-server.mjs"), "//");
    fs.writeFileSync(path.join(readmeOnly, "README.md"), `see ${POWER_TOOLS_REPO_URL}\n`);
    const r3 = discoverPowerTools({ root: path.join(base, "x", "y", "elsewhere"), env: {}, homeDir: home });
    assert.ok(r3.ok && r3.others.includes(path.resolve(fakeInHome)) && [r3.dir, ...r3.others].includes(path.resolve(readmeOnly)));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("discovery: nothing found is an explicit error naming where it looked, the repo and both overrides", () => {
  const { base, root, home } = hermeticLayout();
  try {
    const r = discoverPowerTools({ root, env: {}, homeDir: home });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.error.includes(path.dirname(root)) && r.error.includes(home), "lists the folders searched");
      assert.ok(r.error.includes(POWER_TOOLS_REPO_URL));
      assert.ok(r.error.includes(POWER_TOOLS_DIR_ENV) && r.error.includes("powerTools.dir"));
    }
    assert.ok(POWER_TOOLS_MCP_MISSING.includes(POWER_TOOLS_REPO_URL) && POWER_TOOLS_MCP_MISSING.includes(POWER_TOOLS_DIR_ENV));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("discovery caps children per folder and skips node_modules and dot folders", () => {
  const { base, root, home } = hermeticLayout();
  try {
    const parent = path.dirname(root);
    fakePowerTools(path.join(parent, "node_modules"), "1.0.0");
    fakePowerTools(path.join(parent, ".git"), "1.0.0");
    for (let i = 0; i < 205; i++) fs.mkdirSync(path.join(parent, `aaa-${String(i).padStart(3, "0")}`));
    fakePowerTools(path.join(parent, "zzz-beyond-the-cap"), "1.0.0");
    const r = discoverPowerTools({ root, env: {}, homeDir: home });
    assert.equal(r.ok, false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("discovery never writes: the Power Tools folder is unchanged afterwards", () => {
  const { base, root, home } = hermeticLayout();
  try {
    const dir = fakePowerTools(path.join(base, "a", "pt"), "1.0.0");
    const snap = (): string =>
      fs.readdirSync(dir).sort().map((f) => `${f}:${fs.readFileSync(path.join(dir, f), "utf8")}:${fs.statSync(path.join(dir, f)).mtimeMs}`).join("|");
    const before = snap();
    discoverPowerTools({ root, env: {}, homeDir: home });
    discoverPowerTools({ root, settingDir: dir, env: {}, homeDir: home });
    assert.equal(snap(), before);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the built entry is node + absolute server path with no env, survives the sanitizer, and the dialog shows exactly it", () => {
  const server = path.join(path.resolve("pt-dir"), "uefn-server.mjs");
  const built = buildPowerToolsConfig(server, process.execPath);
  assert.equal(built.command, process.execPath);
  assert.deepEqual(built.args, [server.replace(/\\/g, "/")]);
  assert.ok(path.isAbsolute(built.args[0]));
  assert.equal("env" in built, false);
  const sane = sanitizeProvidedMcpEntry("powertools", built);
  assert.ok(sane.ok);
  if (sane.ok) {
    assert.deepEqual(sane.config, built);
    const detail = providedMcpConfirmDetail("powertools", sane.config, "https://example.test", "Using Power Tools 1.0.0 at X.");
    assert.ok(detail.includes(JSON.stringify(sane.config, null, 2)));
    assert.ok(detail.startsWith("Using Power Tools 1.0.0 at X."));
    assert.ok(detail.includes('Registers "powertools"'));
  }
});
