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

function findViolations(file: string, content: string): string[] {
  const violations: string[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (FORBIDDEN_SYMBOL.test(line)) {
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

test("the literal ignore-list entry Content/Python/ (no write/delete call on the line) passes the guard", () => {
  const sample = '  "Content/Python/",\n  "Python/",\n';
  assert.deepEqual(findViolations("sample.ts", sample), []);
});

test("a write call against a Content/Python path fails the guard (regex sanity check)", () => {
  const sample = 'fs.writeFileSync(path.join(root, "Content/Python/x.py"), "");';
  const violations = findViolations("sample.ts", sample);
  assert.ok(violations.length > 0, "expected the guard to flag a write into Content/Python");
});

test(".mcp.json.example parses, has no absolute-path args for uefn-bridge, and carries the <POWER_TOOLS_DIR> placeholder", () => {
  const examplePath = path.join(REPO_ROOT, ".mcp.json.example");
  const parsed = JSON.parse(fs.readFileSync(examplePath, "utf8"));
  const entry = parsed.mcpServers && parsed.mcpServers["uefn-bridge"];
  assert.ok(entry, ".mcp.json.example must declare a uefn-bridge server");
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

test("a local .mcp.json (if present) has no absolute path in its uefn-bridge args", () => {
  const localPath = path.join(REPO_ROOT, ".mcp.json");
  if (!fs.existsSync(localPath)) {
    return; // nothing to check — gitignored and not present on this machine
  }
  const parsed = JSON.parse(fs.readFileSync(localPath, "utf8"));
  const entry = parsed.mcpServers && parsed.mcpServers["uefn-bridge"];
  if (!entry) return; // uefn-bridge not configured locally
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
function makeVscodeStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === "__esModule") return true;
      if (prop === "window") {
        return { showWarningMessage: async () => "Install" };
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
