// test/packagingManifest.test.ts
//
// Guards against a repeat of the 0.0.576 packaging bug: the Routing
// screen's Save spawns `node <extensionInstallPath>/scripts/<name>.mjs`
// (src/core/routingHostOps.ts -> resolveGeneratorScripts), so the VSIX
// must ship those two scripts plus the compiled modules they
// createRequire() at runtime, and must never ship this machine's local
// opencode.json.
//
// Requires dist/tycoonagents-<version>.vsix to already exist (built via
// `npm run package`) and `unzip` on PATH.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const REQUIRED_ENTRIES = [
  "extension/scripts/apply-routing-profile.mjs",
  "extension/scripts/generate-opencode-config.mjs",
  "extension/out/src/core/agentBackend.js",
  "extension/out/src/core/modelAliases.js",
  "extension/out/src/core/routingProfile.js",
  "extension/out/src/core/localEnvStore.js",
  // p23-t11: panel.ts's INSTALL_CODEX_HOOKS/INSTALL_CODEX_DISPATCHER
  // handlers require these at runtime, and copy the two scripts they pass
  // as hookScriptPath/serverScriptPath from hooks/.
  "extension/out/src/providers/codex/installCodexHooks.js",
  "extension/out/src/providers/codex/installCodexDispatcher.js",
  "extension/hooks/tycoon-codex-hook.cjs",
  "extension/hooks/tycoon-dispatcher-mcp.cjs",
];

const FORBIDDEN_ENTRIES = [
  "extension/opencode.json",
];

// Stray untracked working-tree dirs that must never ship (found leaking into
// 0.0.603's VSIX). Any entry under these prefixes fails the check, except
// paths explicitly whitelisted as intentionally shipped below.
const FORBIDDEN_PREFIXES = [
  "extension/.codex/",
  "extension/.vitest/",
  "extension/Microsoft/",
  "extension/node_modules/",
  "extension/.claude/",
];

// .claude/skills/tycoon-diagnose is force-added and ships on purpose.
const FORBIDDEN_PREFIX_WHITELIST = [
  "extension/.claude/skills/tycoon-diagnose/",
];

function findVsix(): string {
  const distDir = path.join(REPO_ROOT, "dist");
  if (!fs.existsSync(distDir)) {
    throw new Error(
      `dist/ not found at ${distDir} — run "npm run package" before this test.`
    );
  }
  const vsixFiles = fs
    .readdirSync(distDir)
    .filter((f) => f.endsWith(".vsix"))
    .map((f) => path.join(distDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (vsixFiles.length === 0) {
    throw new Error(
      `No .vsix file found in ${distDir} — run "npm run package" before this test.`
    );
  }
  return vsixFiles[0];
}

function listVsixEntries(vsixPath: string): string[] {
  const output = execFileSync("unzip", ["-Z1", vsixPath], {
    encoding: "utf8",
  });
  return output.split(/\r?\n/).filter(Boolean);
}

// p45-t5: release checklist provider-key grep. Guards against a shipped
// VSIX leaking an OpenAI/Google API hostname, SDK package, or a live
// provider key pattern (this project talks to those providers only via
// user-configured routing, never a bundled key/hostname).
export interface Finding {
  path: string;
  pattern: string;
  match: string;
}

const FORBIDDEN_HOSTNAMES = [
  "api.openai.com",
  "generativelanguage.googleapis.com",
];

const FORBIDDEN_PACKAGE_DIRS = [
  "node_modules/openai/",
  "node_modules/@google/generative-ai/",
  "node_modules/@google/genai/",
];

const FORBIDDEN_PACKAGE_IMPORTS = [
  {
    pattern: "openai",
    regex: /(?:require\(\s*["']openai["']\s*\)|from\s+["']openai["']|import\(\s*["']openai["']\s*\))/,
  },
  {
    pattern: "@google/generative-ai",
    regex: /(?:require\(\s*["']@google\/generative-ai["']\s*\)|from\s+["']@google\/generative-ai["']|import\(\s*["']@google\/generative-ai["']\s*\))/,
  },
  {
    pattern: "@google/genai",
    regex: /(?:require\(\s*["']@google\/genai["']\s*\)|from\s+["']@google\/genai["']|import\(\s*["']@google\/genai["']\s*\))/,
  },
];

// OpenAI-style keys ("sk-" + 20+ alnum/_/- chars) and Google-style API keys
// ("AIza" + 35 alnum/_/- chars). The 20-char OpenAI bound is deliberate: it
// clears benign short "sk-..." model-id-shaped strings that are not keys.
const OPENAI_KEY_RE = /sk-[A-Za-z0-9_-]{20,}/;
const GOOGLE_KEY_RE = /AIza[0-9A-Za-z_-]{35}/;

export const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".woff",
  ".woff2",
  ".ttf",
  ".vsix",
  ".zip",
  ".webp",
  ".mp3",
  ".ogg",
]);

export function isBinaryPath(entryPath: string): boolean {
  const ext = path.extname(entryPath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export function findForbiddenProviderStrings(
  entries: { path: string; text: string }[]
): Finding[] {
  const findings: Finding[] = [];

  for (const { path: entryPath, text } of entries) {
    for (const dir of FORBIDDEN_PACKAGE_DIRS) {
      if (entryPath.includes(dir)) {
        findings.push({ path: entryPath, pattern: `package:${dir}`, match: entryPath });
      }
    }

    for (const host of FORBIDDEN_HOSTNAMES) {
      if (text.includes(host)) {
        findings.push({ path: entryPath, pattern: `hostname:${host}`, match: host });
      }
    }

    for (const { pattern, regex } of FORBIDDEN_PACKAGE_IMPORTS) {
      const match = text.match(regex);
      if (match) {
        findings.push({ path: entryPath, pattern: `import:${pattern}`, match: match[0] });
      }
    }

    const openaiMatch = text.match(OPENAI_KEY_RE);
    if (openaiMatch) {
      findings.push({ path: entryPath, pattern: "key:openai(sk-)", match: openaiMatch[0] });
    }

    const googleMatch = text.match(GOOGLE_KEY_RE);
    if (googleMatch) {
      findings.push({ path: entryPath, pattern: "key:google(AIza)", match: googleMatch[0] });
    }
  }

  return findings;
}

test("packaged VSIX ships the routing generator scripts and their runtime modules", () => {
  const vsixPath = findVsix();
  const entries = new Set(listVsixEntries(vsixPath));

  for (const required of REQUIRED_ENTRIES) {
    assert.ok(
      entries.has(required),
      `VSIX ${path.basename(vsixPath)} is missing "${required}" — the ` +
        `Routing screen's Save cannot run node <scriptsDir>/scripts/*.mjs ` +
        `without it. See src/core/routingHostOps.ts resolveGeneratorScripts.`
    );
  }
});

test("packaged VSIX does not ship a local opencode.json", () => {
  const vsixPath = findVsix();
  const entries = new Set(listVsixEntries(vsixPath));

  for (const forbidden of FORBIDDEN_ENTRIES) {
    assert.ok(
      !entries.has(forbidden),
      `VSIX ${path.basename(vsixPath)} ships "${forbidden}" — this is a ` +
        `machine-local managed provider config and must be excluded via ` +
        `.vscodeignore.`
    );
  }
});

test("packaged VSIX does not ship media/src (source parts for media/main.js)", () => {
  const vsixPath = findVsix();
  const entries = listVsixEntries(vsixPath);

  const leaked = entries.filter((e) => e.startsWith("extension/media/src/"));
  assert.deepEqual(
    leaked,
    [],
    `VSIX ${path.basename(vsixPath)} ships media/src/* source parts — these ` +
      `are build-time-only inputs concatenated into media/main.js (plan ` +
      `p21-t1) and must be excluded via .vscodeignore.`
  );
});

test("packaged VSIX does not ship stray untracked working-tree dirs (.codex, .vitest, Microsoft, node_modules, .claude)", () => {
  const vsixPath = findVsix();
  const entries = listVsixEntries(vsixPath);

  const leaked = entries.filter(
    (e) =>
      FORBIDDEN_PREFIXES.some((prefix) => e.startsWith(prefix)) &&
      !FORBIDDEN_PREFIX_WHITELIST.some((allowed) => e.startsWith(allowed))
  );
  assert.deepEqual(
    leaked,
    [],
    `VSIX ${path.basename(vsixPath)} ships stray entries under a forbidden ` +
      `prefix (.codex/.vitest/Microsoft/node_modules/.claude): ` +
      `${leaked.join(", ")} — exclude these via .vscodeignore.`
  );
});

test("packaged VSIX's compiled Codex installer modules export their install symbols (p23-t11)", () => {
  const vsixPath = findVsix();
  const hooksJs = execFileSync(
    "unzip",
    ["-p", vsixPath, "extension/out/src/providers/codex/installCodexHooks.js"],
    { encoding: "utf8" }
  );
  assert.ok(
    hooksJs.includes("installCodexHooks") && hooksJs.includes("uninstallCodexHooks"),
    `VSIX ${path.basename(vsixPath)}'s installCodexHooks.js is missing the ` +
      `installCodexHooks/uninstallCodexHooks symbols panel.ts's ` +
      `INSTALL_CODEX_HOOKS/UNINSTALL_CODEX_HOOKS handlers require().`
  );

  const dispatcherJs = execFileSync(
    "unzip",
    ["-p", vsixPath, "extension/out/src/providers/codex/installCodexDispatcher.js"],
    { encoding: "utf8" }
  );
  assert.ok(
    dispatcherJs.includes("installCodexDispatcher") && dispatcherJs.includes("uninstallCodexDispatcher"),
    `VSIX ${path.basename(vsixPath)}'s installCodexDispatcher.js is missing ` +
      `the installCodexDispatcher/uninstallCodexDispatcher symbols panel.ts's ` +
      `INSTALL_CODEX_DISPATCHER/UNINSTALL_CODEX_DISPATCHER handlers require().`
  );
});

test("packaged VSIX does not ship OpenAI/Google provider hostnames, SDKs, or key-shaped strings (p45-t5)", () => {
  const vsixPath = findVsix();
  const allEntries = listVsixEntries(vsixPath);
  // unzip treats [ ] ? * as shell-style wildcards in the member-name
  // argument and can't be made to match them literally on this platform's
  // build; the only entry that hits this is the package-manager-generated
  // "[Content_Types].xml" manifest, which carries no source text, so skip
  // wildcard-charactered names rather than flag them as unreadable.
  const textEntries = allEntries.filter(
    (e) => !isBinaryPath(e) && !/[[\]?*]/.test(e)
  );

  const entriesWithText = textEntries.map((entryPath) => {
    const text = execFileSync("unzip", ["-p", vsixPath, entryPath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
    });
    return { path: entryPath, text };
  });

  const findings = findForbiddenProviderStrings(entriesWithText);
  assert.deepEqual(
    findings,
    [],
    `VSIX ${path.basename(vsixPath)} ships forbidden provider strings: ` +
      findings
        .map((f) => `${f.path} [${f.pattern}] "${f.match}"`)
        .join("; ")
  );
});
