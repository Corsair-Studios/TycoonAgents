/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// macOS robustness: a Dock-launched VS Code has PATH=/usr/bin:/bin:/usr/sbin:/sbin, so CLI and node
// discovery must also look in the usual install dirs and ask the login shell. Every probe here uses
// injected platform/env/fs/spawn seams, so nothing depends on the host OS or touches the real disk.

import { test } from "node:test";
import assert from "node:assert/strict";

import { discoverCodexBinary, CodexDiscoveryError } from "../src/providers/codex/codexDiscovery";
import { samePath } from "../src/providers/codex/installCodexHooks";
import { NODE_NOT_FOUND_WARNING, isBareNodeCommand, resolveNodeBinary } from "../src/providers/codex/resolveNodeBinary";
import { loginShellLookup, parseLastAbsolutePath, posixSearchDirs } from "../src/providers/codex/posixBinDiscovery";

const bin = require("../../hooks/binDiscovery.cjs") as {
  findBinary: (name: string, opts: Record<string, unknown>) => { bin: string | null; tried: string[] };
  posixSearchDirs: (opts: Record<string, unknown>) => string[];
  loginShellLookup: (name: string, opts: Record<string, unknown>) => string | null;
  parseLastAbsolutePath: (s: string) => string | null;
};
const adapters = require("../../hooks/dispatcherAdapters.cjs") as {
  codexSandboxFailure: (stderr: string, platform?: string) => { error: string; kind: string } | null;
};
const rollout = require("../../hooks/codexRollout.cjs") as {
  normalizePathForCompare: (p: string, opts?: { platform?: string; realpath?: (p: string) => string; cache?: Map<string, string> }) => string;
};

const HOME = "/Users/me";
const MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function fakeFs(files: string[], nvmVersions: string[] = []) {
  const set = new Set(files);
  return {
    existsSync: (p: string) => set.has(p),
    statSync: (p: string) => ({ isFile: () => set.has(p) }),
    readdirSync: (p: string) => {
      if (p === `${HOME}/.nvm/versions/node`) return nvmVersions;
      throw new Error("ENOENT");
    },
  };
}

function fakeSpawn(stdout: string, status = 0) {
  const calls: Array<{ cmd: string; args: string[]; opts?: Record<string, unknown> }> = [];
  const fn = (cmd: string, args: string[], opts?: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    return { status, stdout };
  };
  return { fn, calls };
}

test("posixSearchDirs: order is Claude installer, ~/.local/bin, Homebrew, /usr/local, npm-global, volta, newest nvm", () => {
  const dirs = bin.posixSearchDirs({ home: HOME, fs: fakeFs([], ["v18.19.0", "v20.11.1", "v9.0.0"]) });
  assert.deepEqual(dirs, [
    `${HOME}/.claude/local`,
    `${HOME}/.local/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${HOME}/.npm-global/bin`,
    `${HOME}/.volta/bin`,
    `${HOME}/.nvm/versions/node/v20.11.1/bin`,
  ]);
});

test("findBinary(claude): minimal PATH still finds the binary in each ladder rung", () => {
  const cases: Array<[string, string]> = [
    [`${HOME}/.claude/local/claude`, "claude installer"],
    [`${HOME}/.local/bin/claude`, "local bin"],
    ["/opt/homebrew/bin/claude", "homebrew"],
    ["/usr/local/bin/claude", "usr local"],
    [`${HOME}/.npm-global/bin/claude`, "npm-global"],
    [`${HOME}/.volta/bin/claude`, "volta"],
    [`${HOME}/.nvm/versions/node/v20.11.1/bin/claude`, "nvm"],
  ];
  for (const [file, label] of cases) {
    const r = bin.findBinary("claude", {
      platform: "darwin",
      env: { PATH: MINIMAL_PATH },
      home: HOME,
      fs: fakeFs([file], ["v18.19.0", "v20.11.1"]),
      spawnSync: () => {
        throw new Error("login shell must not run once a dir rung hits");
      },
      cache: new Map(),
    });
    assert.equal(r.bin, file, label);
  }
});

test("findBinary(claude): PATH wins over install dirs; Homebrew wins over npm-global", () => {
  const both = fakeFs(["/opt/homebrew/bin/claude", `${HOME}/.npm-global/bin/claude`, "/custom/claude"]);
  assert.equal(
    bin.findBinary("claude", { platform: "darwin", env: { PATH: "/custom" }, home: HOME, fs: both, cache: new Map() }).bin,
    "/custom/claude",
  );
  assert.equal(
    bin.findBinary("claude", { platform: "darwin", env: { PATH: MINIMAL_PATH }, home: HOME, fs: both, cache: new Map() }).bin,
    "/opt/homebrew/bin/claude",
  );
});

test("findBinary(claude): login shell is the last rung, parsed from the last absolute-path line, spawned once and cached", () => {
  const spawn = fakeSpawn("Welcome to zsh\nsome banner\n/Users/me/weird/claude\n");
  const cache = new Map();
  const opts = {
    platform: "darwin",
    env: { PATH: MINIMAL_PATH, SHELL: "/bin/zsh" },
    home: HOME,
    fs: fakeFs(["/Users/me/weird/claude"]),
    spawnSync: spawn.fn,
    cache,
  };
  assert.equal(bin.findBinary("claude", opts).bin, "/Users/me/weird/claude");
  assert.equal(bin.findBinary("claude", opts).bin, "/Users/me/weird/claude");
  assert.equal(spawn.calls.length, 1, "cached after the first lookup");
  assert.equal(spawn.calls[0].cmd, "/bin/zsh");
  assert.deepEqual(spawn.calls[0].args, ["-ilc", "command -v claude"]);
  assert.equal(spawn.calls[0].opts?.killSignal, "SIGKILL", "interactive shells ignore SIGTERM");
  assert.ok(typeof spawn.calls[0].opts?.timeout === "number");
});

test("findBinary(claude): login-shell failure is ignored and the error lists what was tried", () => {
  const spawn = fakeSpawn("", 1);
  const r = bin.findBinary("claude", {
    platform: "darwin",
    env: { PATH: MINIMAL_PATH, SHELL: "/bin/zsh" },
    home: HOME,
    fs: fakeFs([]),
    spawnSync: spawn.fn,
    cache: new Map(),
  });
  assert.equal(r.bin, null);
  assert.ok(r.tried.some((t) => t.includes("/opt/homebrew/bin/claude")));
  assert.ok(r.tried.some((t) => t.includes("login shell")));
});

test("loginShellLookup: never runs on win32, never with a relative $SHELL or an unsafe name", () => {
  const spawn = fakeSpawn("/x/claude");
  assert.equal(bin.loginShellLookup("claude", { platform: "win32", env: { SHELL: "/bin/zsh" }, spawnSync: spawn.fn, cache: new Map() }), null);
  assert.equal(bin.loginShellLookup("claude", { platform: "darwin", env: { SHELL: "zsh" }, spawnSync: spawn.fn, cache: new Map() }), null);
  assert.equal(bin.loginShellLookup("claude; rm -rf /", { platform: "darwin", env: { SHELL: "/bin/zsh" }, spawnSync: spawn.fn, cache: new Map() }), null);
  assert.equal(spawn.calls.length, 0);
});

test("findBinary on win32: PATH and extra dirs only, no login shell", () => {
  const spawn = fakeSpawn("/x/claude");
  const r = bin.findBinary("claude", {
    platform: "win32",
    env: { PATH: "C:\\Windows" },
    home: "C:\\Users\\me",
    fs: fakeFs(["C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"]),
    names: ["claude.cmd", "claude.exe", "claude"],
    extraDirs: ["C:\\Users\\me\\AppData\\Roaming\\npm"],
    spawnSync: spawn.fn,
    cache: new Map(),
  });
  assert.equal(r.bin, "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd");
  assert.equal(spawn.calls.length, 0);
});

test("parseLastAbsolutePath (cjs and ts twins): ignores banners, takes the last absolute line", () => {
  const out = "hello\n/first/claude\nnoise\n/last/claude\nprompt$ ";
  assert.equal(bin.parseLastAbsolutePath(out), "/last/claude");
  assert.equal(parseLastAbsolutePath(out), "/last/claude");
  assert.equal(parseLastAbsolutePath("claude: aliased\n"), undefined);
});

test("resolveNodeBinary: Electron on macOS with a minimal PATH finds Homebrew node, then login shell, else bare node", () => {
  const base = { env: { PATH: MINIMAL_PATH, SHELL: "/bin/zsh" }, execPath: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron", isElectron: true, platform: "darwin" as const };
  assert.equal(
    resolveNodeBinary({ ...base, isFile: (p) => p === "/opt/homebrew/bin/node", posixDirs: { home: HOME, readdir: () => [] }, loginShell: { cache: new Map(), spawn: () => ({ status: 1, stdout: "" }) } }),
    "/opt/homebrew/bin/node",
  );
  assert.equal(
    resolveNodeBinary({
      ...base,
      isFile: (p) => p === "/Users/me/.asdf/shims/node",
      posixDirs: { home: HOME, readdir: () => [] },
      loginShell: { cache: new Map(), spawn: () => ({ status: 0, stdout: "banner\n/Users/me/.asdf/shims/node\n" }) },
    }),
    "/Users/me/.asdf/shims/node",
  );
  const bare = resolveNodeBinary({ ...base, isFile: () => false, posixDirs: { home: HOME, readdir: () => [] }, loginShell: { cache: new Map(), spawn: () => ({ status: 1, stdout: "" }) } });
  assert.equal(bare, "node");
  assert.ok(isBareNodeCommand(bare));
  assert.match(NODE_NOT_FOUND_WARNING, /TYCOON_NODE_PATH/);
});

test("resolveNodeBinary: TYCOON_NODE_PATH still wins over every rung", () => {
  assert.equal(
    resolveNodeBinary({ env: { TYCOON_NODE_PATH: "/mine/node", PATH: MINIMAL_PATH }, isElectron: true, platform: "darwin", isFile: () => true }),
    "/mine/node",
  );
});

test("posixSearchDirs and loginShellLookup (ts twin) match the cjs ladder", () => {
  const readdir = () => ["v20.1.0", "v22.0.0"];
  assert.deepEqual(posixSearchDirs({ home: HOME, readdir }), bin.posixSearchDirs({ home: HOME, fs: fakeFs([], ["v20.1.0", "v22.0.0"]) }));
  const spawn = fakeSpawn("/a/b/codex\n");
  assert.equal(loginShellLookup("codex", { platform: "darwin", env: { SHELL: "/bin/bash" }, spawn: spawn.fn, cache: new Map() }), "/a/b/codex");
  assert.equal(loginShellLookup("codex", { platform: "win32", env: { SHELL: "/bin/bash" }, spawn: spawn.fn, cache: new Map() }), undefined);
});

test("discoverCodexBinary: finds codex in an npm-global dir the minimal PATH misses (macOS)", () => {
  const target = `${HOME}/.npm-global/bin/codex`;
  const found = discoverCodexBinary({
    platform: "darwin",
    posixDirs: () => posixSearchDirs({ home: HOME, readdir: () => [] }),
    loginShell: () => undefined,
    exec: (cmd) => {
      if (cmd === target) return "codex-cli 0.153.0";
      throw new Error("not found");
    },
  });
  assert.equal(found, target);
});

test("discoverCodexBinary: login shell is the last rung and is verified by content", () => {
  const viaShell = "/Users/me/somewhere/codex";
  const exec = (cmd: string): string => {
    if (cmd === viaShell) return "codex-cli 0.153.0";
    throw new Error("not found");
  };
  assert.equal(discoverCodexBinary({ platform: "darwin", posixDirs: () => [], loginShell: () => viaShell, exec }), viaShell);
  assert.throws(
    () => discoverCodexBinary({ platform: "darwin", posixDirs: () => [], loginShell: () => undefined, exec }),
    (err: unknown) => {
      assert.ok(err instanceof CodexDiscoveryError);
      assert.ok(err.triedLocations.some((t) => t.includes("login shell")));
      assert.match(err.message, /CODEX_BINARY_PATH/);
      return true;
    },
  );
});

test("discoverCodexBinary: win32 never consults the login shell", () => {
  let asked = false;
  assert.throws(() =>
    discoverCodexBinary({
      platform: "win32",
      loginShell: () => {
        asked = true;
        return "/x/codex";
      },
      exec: () => {
        throw new Error("nope");
      },
    }),
  );
  assert.equal(asked, false);
});

test("codex sandbox: macOS sandbox-exec / sandbox_apply log lines map to sandbox_unavailable with a settings-are-yours message", () => {
  const stderr = "2026-10-09T10:00:00Z ERROR exec_command failed: sandbox-exec: sandbox_apply: Operation not permitted";
  const res = adapters.codexSandboxFailure(stderr, "darwin");
  assert.ok(res);
  assert.equal(res.kind, "sandbox_unavailable");
  assert.match(res.error, /macOS sandbox/);
  assert.match(res.error, /~\/\.codex\/config\.toml/);
  assert.match(res.error, /does not change them/);
});

test("codex sandbox: ordinary 'Operation not permitted' from the user's code is not a sandbox failure", () => {
  assert.equal(adapters.codexSandboxFailure("2026-10-09T10:00:00Z ERROR rm: /etc/hosts: Operation not permitted", "darwin"), null);
  assert.equal(adapters.codexSandboxFailure("chmod: changing permissions of 'x': Operation not permitted", "darwin"), null);
});

test("codex sandbox: the macOS signature needs a Codex log line and darwin; the Windows signature is unchanged", () => {
  const line = "sandbox-exec: sandbox_apply: Operation not permitted";
  assert.equal(adapters.codexSandboxFailure(line, "darwin"), null, "not an ERROR/WARN log line");
  assert.equal(adapters.codexSandboxFailure(`ERROR ${line}`, "linux"), null, "other platforms keep their own behavior");
  const win = adapters.codexSandboxFailure("ERROR Failed to create unified exec process: setup refresh had errors", "linux");
  assert.ok(win);
  assert.match(win.error, /Windows sandbox/);
});

test("samePath on darwin: case, trailing separators and symlinked prefixes compare equal", () => {
  const realpath = (p: string): string => p.replace(/^\/var\//, "/private/var/").replace(/^\/tmp\//, "/private/tmp/");
  const opts = { platform: "darwin" as const, realpath };
  assert.equal(samePath("/Users/Me/Proj/hook.cjs", "/users/me/proj/hook.cjs", opts), true);
  assert.equal(samePath("/Users/me/proj/", "/Users/me/proj", opts), true);
  assert.equal(samePath("/var/folders/x/hook.cjs", "/private/var/folders/x/hook.cjs", opts), true);
  assert.equal(samePath("/tmp/a/hook.cjs", "/private/tmp/a/hook.cjs", opts), true);
  assert.equal(samePath("/Users/me/a", "/Users/me/b", opts), false);
  const missing = { platform: "darwin" as const, realpath: () => { throw new Error("ENOENT"); } };
  assert.equal(samePath("/Users/Me/x", "/users/me/x/", missing), true);
});

test("samePath on linux stays case-sensitive", () => {
  assert.equal(samePath("/home/Me/x", "/home/me/x", { platform: "linux" }), false);
  assert.equal(samePath("/home/me/x", "/home/me/x", { platform: "linux" }), true);
});

test("rollout cwd compare: darwin lowercases, strips trailing separators and resolves symlinks", () => {
  const realpath = (p: string): string => p.replace(/^\/tmp\//, "/private/tmp/");
  const n = (p: string) => rollout.normalizePathForCompare(p, { platform: "darwin", realpath });
  assert.equal(n("/Users/Me/Proj/"), n("/users/me/proj"));
  assert.equal(n("/tmp/work"), n("/private/tmp/work"));
  const linux = (p: string) => rollout.normalizePathForCompare(p, { platform: "linux", realpath });
  assert.notEqual(linux("/Users/Me/Proj"), linux("/users/me/proj"));
  assert.equal(rollout.normalizePathForCompare("C:\\Proj\\", { platform: "win32" }), "c:/proj");
});

test("rollout cwd compare: darwin realpath is cached per path, and missing paths still fall back", () => {
  let calls = 0;
  const cache = new Map<string, string>();
  const realpath = (p: string): string => {
    calls++;
    return p.replace(/^\/tmp\//, "/private/tmp/");
  };
  const opts = { platform: "darwin", realpath, cache };
  assert.equal(rollout.normalizePathForCompare("/tmp/Work", opts), "/private/tmp/work");
  assert.equal(rollout.normalizePathForCompare("/tmp/Work", opts), "/private/tmp/work");
  assert.equal(calls, 1, "second compare is a cache hit");
  const missing = { platform: "darwin", realpath: () => { throw new Error("ENOENT"); }, cache: new Map<string, string>() };
  assert.equal(rollout.normalizePathForCompare("/Gone/Dir/", missing), "/gone/dir");
});
