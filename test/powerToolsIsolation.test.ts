/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/*
 * Guards the Power Tools decoupling (see media/power-tools-decoupled.md /
 * MEMORY.md): TycoonAgents ships without Trashbyrd's Power Tools bundled or
 * installed — it never writes into a Power Tools / Content/Python tree, and
 * the uefn-bridge MCP catalog entry stays a disclosed third-party pointer
 * with a placeholder the user fills in themselves (see .mcp.json.example).
 */

const REPO_ROOT = process.cwd();

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

// Bare mentions (comments, an ignore-list literal like "Content/Python/",
// disclosure strings) are fine — what's forbidden is code that actually
// references a removed install/heal symbol, or writes/deletes/copies into a
// Power Tools-owned path.
const FORBIDDEN_SYMBOL = /powertools|trashbyrds|installPowerTools|POWERTOOLS_DIR|legacyBridgeCleanup|mcpHeal/i;
const CONTENT_PYTHON_PATH = /Content[\\/]Python/i;
const WRITE_OR_DELETE_CALL = /(fs\.(write|unlink|rm|copy|mkdir|rename)\w*|writeFile\w*|copyFile\w*|unlink\w*)/;

// The one module that owns the recognised server key names ("powertools"), the override names and the
// read-only discovery. It may say "powertools"; it may not write (checked by its own test below).
const KEY_OWNER_FILES = new Set(["src/core/providedMcp.ts"]);

// The read-only helper names the panel imports from the key-owner module. Only panel.ts may use them, and
// the key literal itself is never allowed outside the key-owner module.
const PANEL_READONLY_HELPERS = /discoverPowerTools|buildPowerToolsConfig|describePowerToolsChoice/g;

function findViolations(file: string, content: string): string[] {
  const violations: string[] = [];
  const lines = content.split(/\r?\n/);
  const keyOwner = KEY_OWNER_FILES.has(file.replace(/\\/g, "/"));
  lines.forEach((line, idx) => {
    if (!keyOwner && FORBIDDEN_SYMBOL.test(file.replace(/\\/g, "/") === "src/host/vscode/panel.ts" ? line.replace(PANEL_READONLY_HELPERS, "") : line)) {
      violations.push(`${file}:${idx + 1}: forbidden symbol reference: ${line.trim()}`);
    }
    if (CONTENT_PYTHON_PATH.test(line) && WRITE_OR_DELETE_CALL.test(line)) {
      violations.push(`${file}:${idx + 1}: write/delete/copy against a Content/Python path: ${line.trim()}`);
    }
  });
  return violations;
}

function scanTree(root: string): string[] {
  const violations: string[] = [];
  for (const file of listFilesRecursive(root)) {
    if (root.endsWith(path.join("", "src")) && !file.endsWith(".ts")) continue;
    const content = fs.readFileSync(file, "utf8");
    violations.push(...findViolations(path.relative(REPO_ROOT, file), content));
  }
  return violations;
}

test("no src/**/*.ts or hooks/** file references removed Power Tools install/heal machinery or writes into Content/Python", () => {
  const srcRoot = path.join(REPO_ROOT, "src");
  const hooksRoot = path.join(REPO_ROOT, "hooks");
  const violations = [...scanTree(srcRoot), ...scanTree(hooksRoot)];
  assert.deepEqual(violations, [], `unexpected Power Tools coupling:\n${violations.join("\n")}`);
});

test("the module that names the powertools key and discovers the folder only reads: no write, copy, delete or spawn call", () => {
  const file = path.join(REPO_ROOT, "src", "core", "providedMcp.ts");
  const code = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(!/fs\.(write|append|unlink|rm|rmdir|copy|mkdir|rename|chmod|symlink|truncate)\w*/.test(code), "providedMcp.ts must not write to the file system");
  assert.ok(!/child_process|spawn\(|exec\w*\(/.test(code), "providedMcp.ts must not run processes");
});

test("the literal ignore-list entry Content/Python/ (no write/delete call on the line) passes the guard", () => {
  const sample = '  "Content/Python/",\n  "Python/",\n';
  assert.deepEqual(findViolations("sample.ts", sample), []);
});

test("a write call against a Content/Python path fails the guard (regex sanity check)", () => {
  const sample = 'fs.writeFileSync(path.join(root, "Content/Python/x.py"), "");';
  const violations = findViolations("sample.ts", sample);
  assert.ok(violations.length > 0, "expected the guard to flag a write into Content/Python");
});

test(".mcp.json.example parses, has no absolute-path args for powertools, and carries the <POWER_TOOLS_DIR> placeholder", () => {
  const examplePath = path.join(REPO_ROOT, ".mcp.json.example");
  const parsed = JSON.parse(fs.readFileSync(examplePath, "utf8"));
  assert.equal(parsed.mcpServers["uefn-bridge"], undefined, "the example uses Power Tools' own key, powertools");
  const entry = parsed.mcpServers && parsed.mcpServers["powertools"];
  assert.ok(entry, ".mcp.json.example must declare a powertools server");
  assert.deepEqual(entry.args, ["<POWER_TOOLS_DIR>/uefn-server.mjs"]);
  assert.equal(entry.command, "node");
  assert.equal(entry.env, undefined, "Power Tools' INSTALL.md sets no env");
  const args: string[] = entry.args ?? [];
  for (const arg of args) {
    assert.ok(
      !/^[A-Za-z]:[\\/]/.test(arg) && !arg.startsWith("/"),
      `.mcp.json.example uefn-bridge arg must not be an absolute path: ${arg}`
    );
  }
  assert.ok(
    args.some((a) => a.includes("<POWER_TOOLS_DIR>")),
    ".mcp.json.example uefn-bridge args must contain the <POWER_TOOLS_DIR> placeholder"
  );
});

test("a local .mcp.json (if present) has no absolute path in its powertools / uefn-bridge args", () => {
  const localPath = path.join(REPO_ROOT, ".mcp.json");
  if (!fs.existsSync(localPath)) {
    return; // nothing to check — gitignored and not present on this machine
  }
  const parsed = JSON.parse(fs.readFileSync(localPath, "utf8"));
  const entry = parsed.mcpServers && (parsed.mcpServers["powertools"] ?? parsed.mcpServers["uefn-bridge"]);
  if (!entry) return; // not configured locally
  const args: string[] = entry.args ?? [];
  for (const arg of args) {
    assert.ok(
      !/^[A-Za-z]:[\\/]/.test(arg) && !arg.startsWith("/"),
      `local .mcp.json uefn-bridge arg must not be an absolute path: ${arg}`
    );
  }
});

test("media/mcp/catalog.json's uefn-bridge entry is disclosed thirdParty with no absolute path baked in", () => {
  const catalogPath = path.join(REPO_ROOT, "media", "mcp", "catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const entry = (catalog as Array<{ id: string; thirdParty?: boolean }>).find((e) => e.id === "uefn-bridge");
  assert.ok(entry, "catalog.json must contain a uefn-bridge entry");
  assert.equal(entry!.thirdParty, true, "uefn-bridge catalog entry must be thirdParty: true");
  const serialized = JSON.stringify(entry);
  // A real drive path is a bare single letter immediately preceded by a
  // quote/backtick/whitespace (never part of a longer word like "https:").
  const windowsDrivePath = /(^|["'`\s])[A-Za-z]:[\\/]/;
  // A real absolute unix-style path starts a quoted JSON string value.
  const unixAbsolutePath = /"\/[A-Za-z][^"<>]*"/;
  assert.ok(
    !windowsDrivePath.test(serialized) && !unixAbsolutePath.test(serialized),
    `catalog.json uefn-bridge entry must not bake in an absolute path: ${serialized}`
  );
});

// --- Install-time refusal ------------------------------------------------
//
// NodeModule stub for `vscode`, matching the technique in
// test/panelUrcIgnore.test.ts, except `window.showWarningMessage` resolves
// "Install" so the third-party confirm gate in `_handleInstallMcp` is
// cleared and the test reaches the placeholder-refusal branch beneath it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("module");
const originalLoad = NodeModule._load;
// Test seams for the panel stub: what the modal answers, what it was shown, and the powerTools.dir setting.
let warnAnswer: "Install" | "Enable" | "Cancel" = "Install";
const warnings: Array<{ message: string; options: { detail?: string }; items: Array<{ title: string; isCloseAffordance?: boolean }> }> = [];
let dirSetting: string | undefined;
function makeVscodeStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === "__esModule") return true;
      if (prop === "window") {
        return {
          showWarningMessage: async (message: string, options: { detail?: string }, ...items: Array<{ title: string; isCloseAffordance?: boolean } | string>) => {
            warnings.push({ message, options, items: items.filter((i): i is { title: string } => typeof i !== "string") });
            if (warnAnswer === "Install") return "Install";
            return items.find((i) => typeof i !== "string" && i.title === warnAnswer);
          },
        };
      }
      if (prop === "workspace") {
        return { getConfiguration: () => ({ get: () => dirSetting }) };
      }
      if (!(prop in target)) {
        target[prop] = new Proxy(function stub() {}, handler);
      }
      return target[prop];
    },
    apply() {
      return new Proxy({}, handler);
    },
    construct() {
      return new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler);
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TycoonPanel } = require("../src/host/vscode/panel") as typeof import("../src/host/vscode/panel");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MSG } = require("../src/host/vscode/messages") as typeof import("../src/host/vscode/messages");

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(require("node:os").tmpdir(), "powerToolsIsolation-"));
}

test("_handleInstallMcp refuses the uefn-bridge catalog entry (unresolved <POWER_TOOLS_DIR> placeholder) and never writes .mcp.json", async () => {
  const root = tmpRoot();
  try {
    const posted: unknown[] = [];
    const fakeThis = {
      _loadMcpCatalog: (TycoonPanel.prototype as any)._loadMcpCatalog,
      _readMcpConfig: (TycoonPanel.prototype as any)._readMcpConfig,
      _useLocalMcp: () => false,
      _enableProvidedMcp: (TycoonPanel.prototype as any)._enableProvidedMcp,
      _resolveConfigTokens: (TycoonPanel.prototype as any)._resolveConfigTokens,
      _buildMcpConfirmMessage: (TycoonPanel.prototype as any)._buildMcpConfirmMessage,
      _projectRoot: () => root,
      _extensionUri: { fsPath: REPO_ROOT },
      _panel: { webview: { postMessage: async (msg: unknown) => { posted.push(msg); return true; } } },
    };
    await (TycoonPanel.prototype as any)._handleInstallMcp.call(fakeThis, "uefn-bridge", true);

    assert.ok(!fs.existsSync(path.join(root, ".mcp.json")), "must not write .mcp.json for the refused install");
    const result = posted.find((m: any) => m && m.type === MSG.MCP_INSTALLED) as
      | { ok: boolean; error?: string }
      | undefined;
    assert.ok(result, "expected an MCP_INSTALLED reply");
    assert.equal(result!.ok, false, "install of the unresolved placeholder entry must not report ok:true");
    assert.match(String(result!.error), /Power Tools|separately/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Enable MCP: both keys, discovery, exact-JSON confirm, never writing --------------------------

import * as os from "node:os";
import { resolveNodeBinary } from "../src/providers/codex/resolveNodeBinary";

interface Harness {
  root: string;
  base: string;
  home: string;
  sets: Array<{ root: string; id: string; config: unknown }>;
  posted: any[];
  fake: any;
}

const PT_ENTRY = { command: "node", args: ["C:/pt/uefn-server.mjs"] };
const UNRELATED_ENTRY = { command: "python", args: ["-m", "something_else"] };

function enableHarness(opts: { local?: Record<string, unknown>; failRemove?: Set<string> } = {}): Harness & { removed: string[] } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ptEnable-"));
  const root = path.join(base, "a", "b", "ws");
  const home = path.join(base, "home");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const sets: Harness["sets"] = [];
  const posted: any[] = [];
  const local = opts.local ?? {};
  const removed: string[] = [];
  const ops = {
    has: (_r: string, id: string) => Object.prototype.hasOwnProperty.call(local, id),
    get: (_r: string, id: string) => local[id],
    remove: async (_r: string, id: string) => {
      removed.push(id);
      if (opts.failRemove?.has(id)) return { ok: false, error: `could not remove ${id}` };
      delete local[id];
      return { ok: true };
    },
    set: async (r: string, id: string, config: unknown) => {
      sets.push({ root: r, id, config });
      return { ok: true };
    },
  };
  const fake = {
    _useLocalMcp: () => true,
    _localMcpOps: () => ops,
    _providedLocalKey: (TycoonPanel.prototype as any)._providedLocalKey,
    _readMcpConfig: (TycoonPanel.prototype as any)._readMcpConfig,
    _panel: { webview: { postMessage: async (m: unknown) => { posted.push(m); return true; } } },
  };
  return { root, base, home, sets, posted, fake, removed };
}

const CATALOG_ENTRY = { name: "UEFN Bridge (Trashbyrd's Power Tools)", providedBy: "power-tools", homepage: "https://example.test/pt" };

function snapshotTree(dir: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(`${f}:${fs.readFileSync(f, "utf8")}:${fs.statSync(f).mtimeMs}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function fakePt(dir: string, version = "0.1.6"): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "uefn-server.mjs"), "// fake\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "trashbyrds-uefn-power-tools", version }));
  fs.writeFileSync(path.join(dir, "INSTALL.md"), "https://github.com/Corsair-Studios/trashbyrds-uefn-power-tools/blob/main/INSTALL.md\n");
  return dir;
}

function slash(p: string): string {
  return p.replace(/\\/g, "/");
}

function enable(h: Harness, env: Record<string, string | undefined>): Promise<void> {
  return withEnv({ USERPROFILE: h.home, HOME: h.home, ...env }, () =>
    (TycoonPanel.prototype as any)._enableProvidedMcp.call(h.fake, h.root, "uefn-bridge", CATALOG_ENTRY)
  );
}

test("Enable MCP with no entry anywhere: discovers Power Tools, shows the exact JSON (Cancel default), registers it as powertools, writes nothing else", async () => {
  const h = enableHarness();
  try {
    const pt = fakePt(path.join(h.base, "a", "b", "some-checkout"));
    const ptBefore = snapshotTree(pt);
    warnings.length = 0;
    warnAnswer = "Enable";
    dirSetting = undefined;
    await enable(h, { TYCOON_POWER_TOOLS_DIR: undefined });
    assert.equal(h.sets.length, 1);
    assert.equal(h.sets[0].id, "powertools");
    const cfg = h.sets[0].config as { command: string; args: string[]; env?: unknown };
    assert.equal(cfg.command, resolveNodeBinary());
    assert.deepEqual(cfg.args, [slash(path.join(path.resolve(pt), "uefn-server.mjs"))]);
    assert.equal(cfg.env, undefined, "no env, per INSTALL.md");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].options.detail!.includes(JSON.stringify(cfg, null, 2)), "the dialog shows exactly the registered JSON");
    assert.ok(warnings[0].options.detail!.includes(path.resolve(pt)), "names which Power Tools folder is used");
    assert.equal(warnings[0].items[0].title, "Cancel");
    assert.equal(warnings[0].items[0].isCloseAffordance, true);
    assert.deepEqual(h.posted.at(-1), { type: MSG.MCP_INSTALLED, id: "uefn-bridge", ok: true, alreadyExisted: false, newChatHint: true });
    assert.ok(!fs.existsSync(path.join(h.root, ".mcp.json")), "never writes .mcp.json");
    assert.equal(snapshotTree(pt), ptBefore, "never touches a Power Tools file");
  } finally {
    fs.rmSync(h.base, { recursive: true, force: true });
  }
});

test("Enable MCP: Cancel registers nothing; the setting beats the env override beats the search", async () => {
  const h = enableHarness();
  try {
    const viaSetting = fakePt(path.join(h.base, "setting-pt"));
    const viaEnv = fakePt(path.join(h.base, "env-pt"));
    fakePt(path.join(h.base, "a", "b", "searched-pt"), "9.0.0");
    warnAnswer = "Cancel";
    dirSetting = viaSetting;
    await enable(h, { TYCOON_POWER_TOOLS_DIR: viaEnv });
    assert.equal(h.sets.length, 0, "cancel must not register");
    assert.equal(h.posted.at(-1).cancelled, true);

    warnAnswer = "Enable";
    await enable(h, { TYCOON_POWER_TOOLS_DIR: viaEnv });
    assert.deepEqual((h.sets[0].config as any).args, [slash(path.join(path.resolve(viaSetting), "uefn-server.mjs"))]);

    dirSetting = undefined;
    h.sets.length = 0;
    await enable(h, { TYCOON_POWER_TOOLS_DIR: viaEnv });
    assert.deepEqual((h.sets[0].config as any).args, [slash(path.join(path.resolve(viaEnv), "uefn-server.mjs"))]);
  } finally {
    dirSetting = undefined;
    fs.rmSync(h.base, { recursive: true, force: true });
  }
});

test("Enable MCP with nothing to find: plain message with the repo link, no dialog, nothing registered", async () => {
  const h = enableHarness();
  try {
    warnings.length = 0;
    dirSetting = undefined;
    await enable(h, { TYCOON_POWER_TOOLS_DIR: undefined });
    assert.equal(warnings.length, 0);
    assert.equal(h.sets.length, 0);
    const reply = h.posted.at(-1);
    assert.equal(reply.ok, false);
    assert.match(reply.error, /No Power Tools folder/);
    assert.match(reply.error, /github\.com\/Corsair-Studios\/trashbyrds-uefn-power-tools/);
    assert.match(reply.error, /TYCOON_POWER_TOOLS_DIR/);
  } finally {
    fs.rmSync(h.base, { recursive: true, force: true });
  }
});

test("Enable MCP copies an existing .mcp.json entry under either key, keeps its key, and never rewrites .mcp.json", async () => {
  for (const key of ["powertools", "uefn-bridge"]) {
    const h = enableHarness();
    try {
      const mcpPath = path.join(h.root, ".mcp.json");
      const fileText = JSON.stringify({ mcpServers: { [key]: { type: "stdio", command: "node", args: ["C:/pt/uefn-server.mjs"] } } }, null, 1);
      fs.writeFileSync(mcpPath, fileText);
      const stBefore = fs.statSync(mcpPath).mtimeMs;
      warnings.length = 0;
      warnAnswer = "Enable";
      await enable(h, { TYCOON_POWER_TOOLS_DIR: undefined });
      assert.equal(h.sets.length, 1);
      assert.equal(h.sets[0].id, key);
      assert.deepEqual(h.sets[0].config, { command: "node", args: ["C:/pt/uefn-server.mjs"] });
      assert.ok(warnings[0].options.detail!.includes(JSON.stringify(h.sets[0].config, null, 2)));
      assert.equal(fs.readFileSync(mcpPath, "utf8"), fileText);
      assert.equal(fs.statSync(mcpPath).mtimeMs, stBefore);
    } finally {
      fs.rmSync(h.base, { recursive: true, force: true });
    }
  }
});

test("Enable MCP reports already-registered when either key is at local scope", async () => {
  for (const key of ["powertools", "uefn-bridge"]) {
    const h = enableHarness({ local: { [key]: PT_ENTRY } });
    try {
      await (TycoonPanel.prototype as any)._enableProvidedMcp.call(h.fake, h.root, "uefn-bridge", CATALOG_ENTRY);
      assert.equal(h.sets.length, 0);
      assert.equal(h.posted.at(-1).alreadyExisted, true);
    } finally {
      fs.rmSync(h.base, { recursive: true, force: true });
    }
  }
});

test("the MCP tab and Packs label this server Enable MCP, never Install", () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, "media", "src", "main", "070-catalog-notices.js"), "utf8");
  assert.match(src, /const enableLabel = pendingEnable \|\| !!server\.providedBy;/);
  assert.match(src, /enableLabel \? "Enable MCP" : "Install"/);
  assert.match(src, /function packMcpEnableable/);
  const click = fs.readFileSync(path.join(REPO_ROOT, "media", "src", "main", "010-modals-badges-rebirth.js"), "utf8");
  assert.match(click, /server && server\.providedBy \? "Enabling…" : "Installing…"/);
});

test("Enable MCP ignores an unrelated powertools entry (local scope and .mcp.json) and goes on to discovery", async () => {
  const h = enableHarness({ local: { powertools: UNRELATED_ENTRY } });
  try {
    const pt = fakePt(path.join(h.base, "a", "b", "real-pt"));
    fs.writeFileSync(path.join(h.root, ".mcp.json"), JSON.stringify({ mcpServers: { "uefn-bridge": UNRELATED_ENTRY } }));
    warnings.length = 0;
    warnAnswer = "Enable";
    dirSetting = undefined;
    await enable(h, { TYCOON_POWER_TOOLS_DIR: undefined });
    assert.equal(h.sets.length, 1, "not reported as already registered");
    assert.equal(h.sets[0].id, "powertools");
    assert.deepEqual((h.sets[0].config as any).args, [slash(path.join(path.resolve(pt), "uefn-server.mjs"))]);
  } finally {
    fs.rmSync(h.base, { recursive: true, force: true });
  }
});

test("removing the Power Tools server removes only entries that launch uefn-server.mjs, tries every key, and reports failures", async () => {
  const removeLocal = (TycoonPanel.prototype as any)._removeLocalMcpConfig;
  // unrelated entry under one alias, Power Tools' own under the other
  const a = enableHarness({ local: { powertools: UNRELATED_ENTRY, "uefn-bridge": PT_ENTRY } });
  try {
    const err = await removeLocal.call(a.fake, a.root, "uefn-bridge");
    assert.equal(err, undefined);
    assert.deepEqual(a.removed, ["uefn-bridge"], "the unrelated powertools entry is not removed");
  } finally {
    fs.rmSync(a.base, { recursive: true, force: true });
  }
  // both are Power Tools' own and the first removal fails: the second is still attempted and the failure reported
  const b = enableHarness({ local: { powertools: PT_ENTRY, "uefn-bridge": PT_ENTRY }, failRemove: new Set(["powertools"]) });
  try {
    const err = await removeLocal.call(b.fake, b.root, "uefn-bridge");
    assert.deepEqual(b.removed, ["powertools", "uefn-bridge"]);
    assert.match(String(err), /could not remove powertools/);
  } finally {
    fs.rmSync(b.base, { recursive: true, force: true });
  }
  // an ordinary single-key server is removed as before
  const c = enableHarness({ local: { playwright: UNRELATED_ENTRY } });
  try {
    assert.equal(await removeLocal.call(c.fake, c.root, "playwright"), undefined);
    assert.deepEqual(c.removed, ["playwright"]);
  } finally {
    fs.rmSync(c.base, { recursive: true, force: true });
  }
});
