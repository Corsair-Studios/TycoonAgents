import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bridgeFilesForConfig, RUNTIME_HOOK_FILES } from "../src/host/vscode/hookInstall";
import { resolveConfigForPlatform, withDispatcherProjectDir } from "../src/host/vscode/mcpCatalog";
import { readHooksChangedAt } from "../src/host/vscode/hookWait";

/* The guard host imports "vscode"; stub it (injected seam) before requiring the module. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("module");
const originalLoad = NodeModule._load;
const state = { trusted: true, folders: [] as string[], popups: 0, logs: [] as string[] };
const vscodeStub = {
  __esModule: true,
  workspace: {
    get isTrusted() {
      return state.trusted;
    },
    get workspaceFolders() {
      return state.folders.map((f) => ({ uri: { fsPath: f } }));
    },
  },
  window: {
    showWarningMessage: () => {
      state.popups++;
    },
    showInformationMessage: () => {
      state.popups++;
    },
    showErrorMessage: () => {
      state.popups++;
    },
    createOutputChannel: () => ({
      appendLine: (l: string) => {
        state.logs.push(l);
      },
      dispose: () => undefined,
    }),
  },
  Uri: { joinPath: (base: { fsPath: string }, ...p: string[]) => ({ fsPath: path.join(base.fsPath, ...p) }) },
};
NodeModule._load = function patched(request: string, parent: unknown, isMain: boolean) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runApprovalGuardSoon } = require("../src/host/vscode/mcpApprovalGuardHost") as typeof import("../src/host/vscode/mcpApprovalGuardHost");

const REPO = process.cwd();
const CATALOG: any[] = JSON.parse(fs.readFileSync(path.join(REPO, "media", "mcp", "catalog.json"), "utf8"));
const REAL_CLAUDE_JSON = path.join(os.homedir(), ".claude.json");

function projectKeys(): string[] {
  try {
    return Object.keys(JSON.parse(fs.readFileSync(REAL_CLAUDE_JSON, "utf8")).projects ?? {}).sort();
  } catch {
    return [];
  }
}

function makeExtension(version: string): string {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), "guardhost-ext-"));
  fs.writeFileSync(path.join(ext, "package.json"), JSON.stringify({ name: "tycoonagents", publisher: "tycoonagents", version }));
  fs.cpSync(path.join(REPO, "hooks"), path.join(ext, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(ext, "media", "packs"), { recursive: true });
  fs.cpSync(path.join(REPO, "media", "mcp"), path.join(ext, "media", "mcp"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "media", "packs", "catalog.json"), path.join(ext, "media", "packs", "catalog.json"));
  return ext;
}

const HOOK_CMD = "node D:/p/.claude/tycoon/tycoon-claude-hook.cjs";
function settingsWithHooks(): object {
  return { enabledMcpjsonServers: ["claude-cli"], hooks: { PreToolUse: [{ matcher: "Task", hooks: [{ type: "command", command: HOOK_CMD }] }] } };
}

/** Project with claude-cli approved, hooks copied from the repo; optional tycoon runtime copy and hook wiring. */
function makeProject(opts: { hooksWired: boolean; staleRuntime?: boolean }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guardhost-proj-"));
  const r = resolveConfigForPlatform(CATALOG.find((e) => e.id === "claude-cli"), process.platform) as any;
  const cfg = withDispatcherProjectDir("claude-cli", r.config, root);
  fs.mkdirSync(path.join(root, ".claude", "hooks"), { recursive: true });
  for (const f of bridgeFilesForConfig(cfg)) fs.copyFileSync(path.join(REPO, "hooks", f), path.join(root, ".claude", "hooks", f));
  fs.writeFileSync(path.join(root, ".claude", "hooks", "package.json"), JSON.stringify({ type: "commonjs" }) + "\n");
  fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { "claude-cli": cfg } }));
  fs.writeFileSync(
    path.join(root, ".claude", "settings.local.json"),
    JSON.stringify(opts.hooksWired ? settingsWithHooks() : { enabledMcpjsonServers: ["claude-cli"] }),
  );
  if (opts.staleRuntime) {
    fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "tycoon", RUNTIME_HOOK_FILES[0]), "// stale copy\n");
  }
  return root;
}

const runtimeCopy = (root: string): string => fs.readFileSync(path.join(root, ".claude", "tycoon", RUNTIME_HOOK_FILES[0]), "utf8");
const approved = (root: string): string[] => JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8")).enabledMcpjsonServers ?? [];

async function run(root: string, ext: string, trusted: boolean): Promise<string[]> {
  state.trusted = trusted;
  state.folders = [root];
  state.logs.length = 0;
  state.popups = 0;
  // Injected clock: the guard's recheck sleep resolves immediately instead of waiting on a real timer.
  const realSetTimeout = global.setTimeout;
  (global as any).setTimeout = ((fn: () => void, ms?: number) => realSetTimeout(fn, (ms ?? 0) > 0 ? 0 : ms)) as typeof setTimeout;
  try {
    return await runApprovalGuardSoon({ fsPath: ext } as never);
  } finally {
    global.setTimeout = realSetTimeout;
  }
}

const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, DIRS: process.env.TYCOON_EXTENSION_DIRS, PROJ: process.env.CLAUDE_PROJECT_DIR };
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "guardhost-home-"));
const keysBefore = projectKeys();
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
process.env.TYCOON_EXTENSION_DIRS = path.join(fakeHome, "no-siblings");
delete process.env.CLAUDE_PROJECT_DIR;

test.after(() => {
  NodeModule._load = originalLoad;
  for (const [k, v] of [["USERPROFILE", saved.USERPROFILE], ["HOME", saved.HOME], ["TYCOON_EXTENSION_DIRS", saved.DIRS], ["CLAUDE_PROJECT_DIR", saved.PROJ]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  assert.deepEqual(projectKeys(), keysBefore, "real ~/.claude.json projects key names unchanged");
});

test("guard always runs, even with no hooks wired: a tampered approved server is revoked", async () => {
  const ext = makeExtension("1.0.0");
  const root = makeProject({ hooksWired: false });
  assert.deepEqual(await run(root, ext, true), []);
  fs.appendFileSync(path.join(root, ".claude", "hooks", "claudePermissionMode.cjs"), "\n//x\n");
  assert.deepEqual(await run(root, ext, true), ["claude-cli"]);
  assert.deepEqual(approved(root), []);
});

test("untrusted workspace: heal skipped, guard still runs; revocation logs and shows no popup", async () => {
  const ext = makeExtension("1.0.0");
  const root = makeProject({ hooksWired: true, staleRuntime: true });
  fs.appendFileSync(path.join(root, ".claude", "hooks", "claudePermissionMode.cjs"), "\n//x\n");
  const revoked = await run(root, ext, false);
  assert.deepEqual(revoked, ["claude-cli"], "guard ran and revoked");
  assert.equal(runtimeCopy(root), "// stale copy\n", "heal did not touch the runtime copy");
  assert.equal(readHooksChangedAt(root), null);
  assert.equal(state.popups, 0, "no user popup");
  assert.ok(state.logs.some((l) => /removed legacy approval for claude-cli/.test(l)), "logged");
});

test("trusted + Tycoon hook commands in settings.local.json: heal runs first and stamps a change", async () => {
  const ext = makeExtension("1.0.0");
  const root = makeProject({ hooksWired: true, staleRuntime: true });
  assert.deepEqual(await run(root, ext, true), []);
  assert.equal(runtimeCopy(root), fs.readFileSync(path.join(ext, "hooks", RUNTIME_HOOK_FILES[0]), "utf8"), "stale copy refreshed from the extension");
  assert.notEqual(readHooksChangedAt(root), null, "real content change records a hooks change");
});

test("heal also repairs a tampered bridge copy before the guard, so nothing is revoked", async () => {
  const ext = makeExtension("1.0.0");
  const root = makeProject({ hooksWired: true });
  fs.appendFileSync(path.join(root, ".claude", "hooks", "claudePermissionMode.cjs"), "\n//x\n");
  assert.deepEqual(await run(root, ext, true), []);
  assert.deepEqual(approved(root), ["claude-cli"]);
});

test("no Tycoon hook commands (Codex-only project): heal does not run", async () => {
  const ext = makeExtension("1.0.0");
  const root = makeProject({ hooksWired: false, staleRuntime: true });
  await run(root, ext, true);
  assert.equal(runtimeCopy(root), "// stale copy\n");
  assert.equal(readHooksChangedAt(root), null);
});

test("a version change without a content change records nothing", async () => {
  const ext = makeExtension("2.0.0");
  const root = makeProject({ hooksWired: true, staleRuntime: true });
  fs.copyFileSync(path.join(ext, "hooks", RUNTIME_HOOK_FILES[0]), path.join(root, ".claude", "tycoon", RUNTIME_HOOK_FILES[0]));
  await run(root, ext, true);
  assert.equal(readHooksChangedAt(root), null);
});

test("heal is skipped when the project copies come from a NEWER installed extension", async () => {
  const newer = makeExtension("3.0.0");
  fs.writeFileSync(path.join(newer, "hooks", RUNTIME_HOOK_FILES[0]), "// newer build\n");
  const ext = makeExtension("1.0.0");
  const root = makeProject({ hooksWired: true });
  fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
  for (const f of RUNTIME_HOOK_FILES) {
    const s = path.join(newer, "hooks", f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(root, ".claude", "tycoon", f));
  }
  for (const f of fs.readdirSync(path.join(root, ".claude", "hooks"))) {
    const s = path.join(newer, "hooks", f);
    if (f !== "package.json" && fs.existsSync(s)) fs.copyFileSync(s, path.join(root, ".claude", "hooks", f));
  }
  process.env.TYCOON_EXTENSION_DIRS = newer;
  try {
    await run(root, ext, true);
  } finally {
    process.env.TYCOON_EXTENSION_DIRS = path.join(fakeHome, "no-siblings");
  }
  assert.equal(runtimeCopy(root), "// newer build\n", "older install did not overwrite newer copies");
  assert.equal(readHooksChangedAt(root), null);
});
