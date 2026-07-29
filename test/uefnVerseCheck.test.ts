/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';

/*
 * Regression + behavior coverage for `uefn_verse_check`
 * (uefn-bridge/uefn-server.ts, registered ~line 1142). Unlike every other
 * uefn_* tool it does NOT go through the bridge/IPC to a live UEFN editor —
 * it spawns media/skills/uefn/verse_lsp_check.py directly as a local
 * subprocess and does not require UEFN to be running at all.
 *
 * Same constraint as test/uefnModerationExternalLink.test.ts: uefn-server.ts
 * is a standalone MCP server (excluded from the tsc project, bundled by
 * esbuild) whose tail (`const server = new McpServer(...)` onward) calls
 * `await server.connect(new StdioServerTransport())` at module scope — simply
 * importing/requiring the file would attach real stdio listeners and hang.
 *
 * That sibling test solves this by slicing everything BEFORE
 * `const server = new McpServer(` (all of that section is side-effect-free).
 * uefn_verse_check's own helpers (locateVerseCheckScript,
 * locatePythonInterpreter, diagnosticFileMatches, verseCheckError, etc.) and
 * its handler body are defined AFTER that anchor (interleaved with other
 * tools' server.registerTool(...) calls), so this file additionally slices
 * out two more self-contained regions of the REAL source text:
 *   1. everything from `const execFileAsync = promisify(execFile);` up to
 *      (not including) `server.registerTool("uefn_verse_check", ...)` — the
 *      constants/interfaces/helper functions, none of which reference the
 *      `server` object.
 *   2. the literal handler function body (`async (args) => { ... }`) passed
 *      as the third argument to that registerTool call, turned into a plain
 *      `const verseCheckHandler = async (args) => { ... }` so it can be
 *      exported and invoked directly.
 * Both slices are concatenated onto the same pure prefix, type-stripped with
 * esbuild's programmatic transform (already a devDependency), and evaluated
 * with `new Function(...)` exactly like the sibling test — this exercises
 * the REAL production source text, not a reimplementation.
 *
 * Two lines in the extracted text cannot survive that transform/eval
 * unmodified, and are patched by exact string replacement (asserted present
 * verbatim first, so any drift in the real source fails loudly rather than
 * silently testing stale text):
 *   - `SERVER_FILE_DIR = path.dirname(fileURLToPath(import.meta.url))` uses
 *     `import.meta.url`, which esbuild's cjs-format transform replaces with
 *     `{}.url` (i.e. `undefined`) since there is no real module context —
 *     `fileURLToPath(undefined)` throws. Patched to a controlled fake
 *     directory so the "extension's bundled copy" ladder candidate is
 *     deterministic and test-writable.
 *   - `VERSE_CHECK_SUBPROCESS_TIMEOUT_MS = 170_000` (170s) is patched down to
 *     a small value so the timeout test actually finishes in test time. The
 *     unmodified value is still asserted present in the raw, unpatched source
 *     by a separate guard test below.
 */

const SERVER_TS_PATH = join(process.cwd(), 'uefn-bridge', 'uefn-server.ts');

const PURE_PREFIX_END = 'const server = new McpServer(';
const REGION2_START = 'const execFileAsync = promisify(execFile);';
const REGION2_END = 'server.registerTool(\n  "uefn_verse_check",';
const HANDLER_START = 'async (args) => {\n    const requestedSeverities = args.severity';
const HANDLER_END_SCAN = '\n// ── Start';
const SERVER_FILE_DIR_LINE = 'const SERVER_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));';
const TIMEOUT_LINE = 'const VERSE_CHECK_SUBPROCESS_TIMEOUT_MS = 170_000;';

interface UefnVerseCheckInternals {
  verseCheckHandler: (args: {
    project_root?: string;
    files?: string[];
    severity?: string[];
    max_diagnostics?: number;
    max_auto_files?: number;
  }) => Promise<{ content: [{ type: 'text'; text: string }] }>;
  locateVerseCheckScript: (projectRoot: string) => {
    chosen: string | null;
    tried: { label: string; path: string }[];
    overrideInvalid?: { label: string; path: string };
  };
  locatePythonInterpreter: () => Promise<{
    chosen: { cmd: string; version: string } | null;
    tried: string[];
  }>;
  diagnosticFileMatches: (diagnosticPath: string, filters: string[]) => boolean;
  verseCheckError: (tier: string, detail: Record<string, unknown>, nextRequiredAction: string) => Record<string, unknown>;
  existsAsFile: (p: string) => boolean;
  existsAsDir: (p: string) => boolean;
  readUefnPathsJsonKey: (projectRoot: string, key: string) => string | undefined;
  VERSE_CHECK_SCRIPT_ENV_VAR: string;
  VERSE_CHECK_DEFAULT_MAX_DIAGNOSTICS: number;
  VERSE_CHECK_DEFAULT_SEVERITIES: string[];
  VERSE_CHECK_SUBPROCESS_TIMEOUT_MS: number;
}

// The extracted source's transpiled `import ... from "../src/shared/X"`
// becomes `require("../src/shared/X")`, resolved via a `require` scoped to
// SERVER_TS_PATH's directory (uefn-bridge/) so node_modules imports
// (@modelcontextprotocol/sdk, zod) still resolve as if this code lived at
// its real source path. That scoping breaks for `../src/shared/*` imports
// specifically: `src/shared/*.ts` has no compiled sibling `.js` next to the
// `.ts` source (only under `out/src/shared/*.js`, tsc's outDir) — a plain
// `require("../src/shared/bridgeVersion")` from uefn-bridge/ throws
// MODULE_NOT_FOUND, even though the real product code (bundled by esbuild
// into uefn-server.mjs) resolves this import fine. This shim intercepts
// exactly that one pattern and redirects it to the compiled `out/` copy;
// everything else still goes through the real scoped require unchanged.
// Stays robust to future `../src/shared/*` imports — no per-module literal
// needed, just the directory pattern.
function shimSharedRequire(baseRequire: NodeJS.Require): NodeJS.Require {
  const shimmed = ((id: string) => {
    const match = /^\.\.\/src\/shared\/(.+)$/.exec(id);
    if (match) {
      const compiledPath = join(process.cwd(), 'out', 'src', 'shared', `${match[1]}.js`);
      return baseRequire(compiledPath);
    }
    return baseRequire(id);
  }) as NodeJS.Require;
  return Object.assign(shimmed, baseRequire);
}

function requireAnchorOnce(fullSource: string, label: string, needle: string): number {
  const idx = fullSource.indexOf(needle);
  assert.ok(idx > 0, `uefn-server.ts layout changed: could not find "${label}" anchor — update it in this test`);
  const count = fullSource.split(needle).length - 1;
  assert.equal(count, 1, `uefn-server.ts layout changed: "${label}" anchor expected exactly once, found ${count}`);
  return idx;
}

// timeoutMs/serverFileDir let individual tests control the two patched
// constants; defaults are the "don't care" values used by tests that never
// exercise the timeout or bundled-copy ladder branch.
function loadUefnVerseCheckInternals(opts: { timeoutMs?: number; serverFileDir?: string } = {}): UefnVerseCheckInternals {
  const fullSource = readFileSync(SERVER_TS_PATH, 'utf8');

  const prefixEndIdx = requireAnchorOnce(fullSource, 'PURE_PREFIX_END', PURE_PREFIX_END);
  const region2StartIdx = requireAnchorOnce(fullSource, 'REGION2_START', REGION2_START);
  const region2EndIdx = requireAnchorOnce(fullSource, 'REGION2_END', REGION2_END);
  const handlerStartIdx = requireAnchorOnce(fullSource, 'HANDLER_START', HANDLER_START);
  const handlerEndScanIdx = requireAnchorOnce(fullSource, 'HANDLER_END_SCAN', HANDLER_END_SCAN);

  const purePrefix = fullSource.slice(0, prefixEndIdx);
  const region2 = fullSource.slice(region2StartIdx, region2EndIdx);

  const handlerRegionRaw = fullSource.slice(handlerStartIdx, handlerEndScanIdx);
  const lastCloseParenIdx = handlerRegionRaw.lastIndexOf(');');
  assert.ok(lastCloseParenIdx > 0, 'could not find the closing ");" of the uefn_verse_check registerTool(...) call');
  // Everything up to (not including) that final "});" is the arrow function
  // literal itself ("async (args) => { ... }"); the ");" belongs to the
  // enclosing server.registerTool(...) call, not the function.
  const handlerBody = handlerRegionRaw.slice(0, lastCloseParenIdx).replace(/\s+$/, '');

  assert.ok(region2.includes(SERVER_FILE_DIR_LINE), 'SERVER_FILE_DIR line not found verbatim — source layout changed, update this test');
  const fakeServerDir = opts.serverFileDir ?? join(tmpdir(), 'uefn-verse-check-test-unused-server-dir');
  let patchedRegion2 = region2.replace(SERVER_FILE_DIR_LINE, `const SERVER_FILE_DIR = ${JSON.stringify(fakeServerDir)};`);

  assert.ok(patchedRegion2.includes(TIMEOUT_LINE), 'VERSE_CHECK_SUBPROCESS_TIMEOUT_MS=170_000 line not found verbatim — source layout changed, update this test');
  const timeoutMs = opts.timeoutMs ?? 170_000;
  patchedRegion2 = patchedRegion2.replace(TIMEOUT_LINE, `const VERSE_CHECK_SUBPROCESS_TIMEOUT_MS = ${timeoutMs};`);

  const footer = `
export {
  verseCheckHandler,
  locateVerseCheckScript,
  locatePythonInterpreter,
  diagnosticFileMatches,
  verseCheckError,
  existsAsFile,
  existsAsDir,
  readUefnPathsJsonKey,
  VERSE_CHECK_SCRIPT_ENV_VAR,
  VERSE_CHECK_DEFAULT_MAX_DIAGNOSTICS,
  VERSE_CHECK_DEFAULT_SEVERITIES,
  VERSE_CHECK_SUBPROCESS_TIMEOUT_MS,
};
`;
  const verseCheckHandlerDecl = `\nconst verseCheckHandler = ${handlerBody};\n`;

  const combined = purePrefix + patchedRegion2 + verseCheckHandlerDecl + footer;
  const { code } = transformSync(combined, { loader: 'ts', format: 'cjs', target: 'node18' });

  const mod = { exports: {} as Record<string, unknown> };
  const runModule = new Function('module', 'exports', 'require', code) as (
    module: unknown,
    exports: unknown,
    require: unknown
  ) => void;
  // Resolve node_modules ("@modelcontextprotocol/sdk", "zod" — pulled in by
  // the pure-prefix imports even though unused here) as if this code lived
  // at the real source path, not this test file's own location.
  const scopedRequire = createRequire(SERVER_TS_PATH);
  runModule(mod, mod.exports, shimSharedRequire(scopedRequire));
  return mod.exports as unknown as UefnVerseCheckInternals;
}

// ── shared fake-interpreter fixture ─────────────────────────────────────────
//
// The tool probes `python`/`python3`/`py` via `execFileAsync(cmd, ["--version"])`
// with no `shell: true` — on Windows, Node's own child_process PATH search
// for a bare command name only resolves real Win32 executables (.exe), not
// .cmd/.bat batch-file shims, when spawned this way. So the fake interpreter
// has to be a genuine executable: a copy of the CURRENT node.exe renamed to
// python.exe. node.exe ignores the file extension of a script argv and runs
// it as JS regardless, so the ".py" fixture "scripts" below are plain JS —
// this is what drives every subprocess-shaped test deterministically, with
// no real Python, no real verse-lsp.exe, and no network. Built once and
// reused (copying node.exe per-test would be wasteful); cleaned up in
// `after()`.
const FAKE_PY_DIR = mkdtempSync(join(tmpdir(), 'uefn-verse-check-fakepy-'));
copyFileSync(process.execPath, join(FAKE_PY_DIR, 'python.exe'));

after(() => {
  rmSync(FAKE_PY_DIR, { recursive: true, force: true });
});

async function withPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env.PATH;
  process.env.PATH = dir + delimiter + (old ?? '');
  try {
    return await fn();
  } finally {
    process.env.PATH = old;
  }
}

async function withEmptyPath<T>(fn: () => Promise<T>): Promise<T> {
  const emptyDir = mkdtempSync(join(tmpdir(), 'uefn-verse-check-emptypath-'));
  const old = process.env.PATH;
  process.env.PATH = emptyDir;
  try {
    return await fn();
  } finally {
    process.env.PATH = old;
    rmSync(emptyDir, { recursive: true, force: true });
  }
}

function tmpProjectRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeStagedScript(projectRoot: string, jsBody: string): string {
  const dir = join(projectRoot, '.claude', 'skills', 'uefn');
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, 'verse_lsp_check.py');
  writeFileSync(scriptPath, jsBody);
  return scriptPath;
}

function okJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'ok',
    lsp_path: 'C:/fake/verse-lsp.exe',
    lsp_version: '1.2.3-fake',
    vproject_path: 'C:/fake/proj/Foo.vproject',
    content_dir: 'C:/fake/proj/Content',
    opened_files: [],
    version_note: null,
    diagnostics: [],
    summary: { total: 0, by_severity: {} },
    ...overrides,
  });
}

async function callHandler(
  internals: UefnVerseCheckInternals,
  args: Parameters<UefnVerseCheckInternals['verseCheckHandler']>[0]
): Promise<Record<string, unknown>> {
  const result = await internals.verseCheckHandler(args);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ── extraction canary ───────────────────────────────────────────────────────

test('extraction produces all expected exports (canary for source-layout drift)', () => {
  const internals = loadUefnVerseCheckInternals();
  assert.equal(typeof internals.verseCheckHandler, 'function');
  assert.equal(typeof internals.locateVerseCheckScript, 'function');
  assert.equal(typeof internals.locatePythonInterpreter, 'function');
  assert.equal(typeof internals.diagnosticFileMatches, 'function');
  assert.equal(typeof internals.verseCheckError, 'function');
  assert.equal(internals.VERSE_CHECK_SCRIPT_ENV_VAR, 'VERSE_LSP_CHECK_SCRIPT');
  assert.deepEqual(internals.VERSE_CHECK_DEFAULT_SEVERITIES, ['error', 'warning']);
  assert.equal(internals.VERSE_CHECK_DEFAULT_MAX_DIAGNOSTICS, 100);
});

test('guard: raw source still has the two lines this test patches, verbatim (catches silent drift)', () => {
  const fullSource = readFileSync(SERVER_TS_PATH, 'utf8');
  assert.ok(fullSource.includes(SERVER_FILE_DIR_LINE), 'SERVER_FILE_DIR line changed — update SERVER_FILE_DIR_LINE and the patch in this test');
  assert.ok(fullSource.includes(TIMEOUT_LINE), 'VERSE_CHECK_SUBPROCESS_TIMEOUT_MS=170_000 changed — update TIMEOUT_LINE and the patch in this test (and re-check the real 170s value is still sane)');
});

// ── pure function: verseCheckError ──────────────────────────────────────────

test('verseCheckError always returns status:"error" with next_required_action as the terminal key', () => {
  const internals = loadUefnVerseCheckInternals();
  const result = internals.verseCheckError('some_tier', { detail: 'x' }, 'do the thing');
  assert.equal(result.status, 'error');
  assert.equal(result.exit_code, null);
  assert.equal(result.tier, 'some_tier');
  assert.equal(result.next_required_action, 'do the thing');
  assert.ok(!('diagnostics' in result), 'an error shape must never carry a diagnostics key — that is what makes it look like a clean success');
  const keys = Object.keys(result);
  assert.equal(keys[keys.length - 1], 'next_required_action');
});

// ── pure function: diagnosticFileMatches ────────────────────────────────────

test('diagnosticFileMatches: exact, suffix (path-boundary), and bare-filename matches all succeed', () => {
  const internals = loadUefnVerseCheckInternals();
  assert.equal(internals.diagnosticFileMatches('C:/proj/Content/MyDevice/Foo.verse', ['C:/proj/Content/MyDevice/Foo.verse']), true, 'exact match');
  assert.equal(internals.diagnosticFileMatches('C:/proj/Content/MyDevice/Foo.verse', ['MyDevice/Foo.verse']), true, 'path-boundary suffix match');
  assert.equal(internals.diagnosticFileMatches('C:/proj/Content/MyDevice/Foo.verse', ['Foo.verse']), true, 'bare filename match');
});

test('diagnosticFileMatches: rejects a substring match with no boundary (FooBar.verse must not match Bar.verse)', () => {
  const internals = loadUefnVerseCheckInternals();
  assert.equal(internals.diagnosticFileMatches('C:/proj/Content/FooBar.verse', ['Bar.verse']), false);
  assert.equal(internals.diagnosticFileMatches('C:/proj/Content/OtherDevice/Foo.verse', ['MyDevice/Foo.verse']), false, 'suffix match still needs the real path boundary');
});

// ── pure function: readUefnPathsJsonKey ─────────────────────────────────────

test('readUefnPathsJsonKey: absent file, malformed JSON, and non-string value all resolve to undefined without throwing', () => {
  const internals = loadUefnVerseCheckInternals();
  const missingRoot = tmpProjectRoot('uefn-verse-check-json-missing-');
  try {
    assert.equal(internals.readUefnPathsJsonKey(missingRoot, 'VERSE_LSP_CHECK_SCRIPT'), undefined);

    const tycoonDir = join(missingRoot, '.claude', 'tycoon');
    mkdirSync(tycoonDir, { recursive: true });
    writeFileSync(join(tycoonDir, 'uefn-paths.json'), '{ not valid json');
    assert.doesNotThrow(() => internals.readUefnPathsJsonKey(missingRoot, 'VERSE_LSP_CHECK_SCRIPT'));
    assert.equal(internals.readUefnPathsJsonKey(missingRoot, 'VERSE_LSP_CHECK_SCRIPT'), undefined);

    writeFileSync(join(tycoonDir, 'uefn-paths.json'), JSON.stringify({ VERSE_LSP_CHECK_SCRIPT: 42 }));
    assert.equal(internals.readUefnPathsJsonKey(missingRoot, 'VERSE_LSP_CHECK_SCRIPT'), undefined, 'a non-string value must not be returned as a path');
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
  }
});

// ── script-path discovery ladder (item 1) ───────────────────────────────────

test('script ladder: with all four candidates present, env var wins over json override, staged copy, and bundled copy', () => {
  const projectRoot = tmpProjectRoot('uefn-verse-check-ladder-');
  // Nested one level so `join(fakeServerDir, '..', ...)` lands in a directory
  // unique to this test — SERVER_FILE_DIR's real value is always the
  // installed extension's uefn-bridge/ dir, i.e. one level below the
  // extension root the bundled copy is resolved relative to; a bare tmpdir
  // as fakeServerDir would make every test's "bundled copy" collide at the
  // same <os tmpdir>/skills/uefn/ path.
  const fakeServerRoot = tmpProjectRoot('uefn-verse-check-ladder-serverroot-');
  const fakeServerDir = join(fakeServerRoot, 'uefn-bridge');
  try {
    // bundled copy
    const bundledDir = join(fakeServerDir, '..', 'skills', 'uefn');
    mkdirSync(bundledDir, { recursive: true });
    writeFileSync(join(bundledDir, 'verse_lsp_check.py'), 'bundled');
    // staged copy
    writeStagedScript(projectRoot, 'staged');
    // json override
    const tycoonDir = join(projectRoot, '.claude', 'tycoon');
    mkdirSync(tycoonDir, { recursive: true });
    const jsonOverrideDir = tmpProjectRoot('uefn-verse-check-ladder-jsonov-');
    const jsonOverrideScript = join(jsonOverrideDir, 'json_override.py');
    writeFileSync(jsonOverrideScript, 'json-override');
    writeFileSync(join(tycoonDir, 'uefn-paths.json'), JSON.stringify({ VERSE_LSP_CHECK_SCRIPT: jsonOverrideScript }));
    // env override
    const envOverrideDir = tmpProjectRoot('uefn-verse-check-ladder-envov-');
    const envOverrideScript = join(envOverrideDir, 'env_override.py');
    writeFileSync(envOverrideScript, 'env-override');

    const internals = loadUefnVerseCheckInternals({ serverFileDir: fakeServerDir });

    // env var not set yet: json override should win over staged/bundled.
    const withJsonOverride = internals.locateVerseCheckScript(projectRoot);
    assert.equal(withJsonOverride.chosen, jsonOverrideScript, 'json override must win over staged/bundled when no env var is set');

    const oldEnv = process.env.VERSE_LSP_CHECK_SCRIPT;
    process.env.VERSE_LSP_CHECK_SCRIPT = envOverrideScript;
    try {
      const withEnvOverride = internals.locateVerseCheckScript(projectRoot);
      assert.equal(withEnvOverride.chosen, envOverrideScript, 'env var override must win over json override, staged copy, and bundled copy');
    } finally {
      if (oldEnv === undefined) delete process.env.VERSE_LSP_CHECK_SCRIPT;
      else process.env.VERSE_LSP_CHECK_SCRIPT = oldEnv;
    }

    // Remove the json override; staged copy should now win over bundled.
    rmSync(join(tycoonDir, 'uefn-paths.json'), { force: true });
    const withStagedOnly = internals.locateVerseCheckScript(projectRoot);
    assert.equal(withStagedOnly.chosen, join(projectRoot, '.claude', 'skills', 'uefn', 'verse_lsp_check.py'), 'staged copy must win over bundled copy once json override is gone');

    // Remove the staged copy too; bundled copy is the last resort.
    rmSync(join(projectRoot, '.claude', 'skills'), { recursive: true, force: true });
    const withBundledOnly = internals.locateVerseCheckScript(projectRoot);
    assert.equal(withBundledOnly.chosen, join(bundledDir, 'verse_lsp_check.py'), 'bundled copy must be chosen once nothing else is present');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(fakeServerRoot, { recursive: true, force: true });
  }
});

test('script ladder: an env var pointing at a nonexistent file is a hard failure — never silently falls through to json/staged/bundled', () => {
  const projectRoot = tmpProjectRoot('uefn-verse-check-ladder-envbad-');
  try {
    const tycoonDir = join(projectRoot, '.claude', 'tycoon');
    mkdirSync(tycoonDir, { recursive: true });
    const validOverrideDir = tmpProjectRoot('uefn-verse-check-ladder-envbad-json-');
    const validOverrideScript = join(validOverrideDir, 'would_have_worked.py');
    writeFileSync(validOverrideScript, 'x');
    writeFileSync(join(tycoonDir, 'uefn-paths.json'), JSON.stringify({ VERSE_LSP_CHECK_SCRIPT: validOverrideScript }));

    const internals = loadUefnVerseCheckInternals();
    const oldEnv = process.env.VERSE_LSP_CHECK_SCRIPT;
    process.env.VERSE_LSP_CHECK_SCRIPT = 'Z:/definitely/does/not/exist/verse_lsp_check.py';
    try {
      const result = internals.locateVerseCheckScript(projectRoot);
      assert.equal(result.chosen, null, 'an invalid env override must not resolve to any script, not even a valid json-override fallback');
      assert.equal(result.overrideInvalid?.label, 'VERSE_LSP_CHECK_SCRIPT env override');
      assert.equal(result.overrideInvalid?.path, 'Z:/definitely/does/not/exist/verse_lsp_check.py');
    } finally {
      if (oldEnv === undefined) delete process.env.VERSE_LSP_CHECK_SCRIPT;
      else process.env.VERSE_LSP_CHECK_SCRIPT = oldEnv;
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('script ladder: a json override pointing at a nonexistent file is also a hard failure, not a silent fallthrough', () => {
  const projectRoot = tmpProjectRoot('uefn-verse-check-ladder-jsonbad-');
  try {
    const tycoonDir = join(projectRoot, '.claude', 'tycoon');
    mkdirSync(tycoonDir, { recursive: true });
    writeFileSync(join(tycoonDir, 'uefn-paths.json'), JSON.stringify({ VERSE_LSP_CHECK_SCRIPT: 'Z:/nope/nope.py' }));
    // staged copy present too — must NOT be used as a fallback.
    writeStagedScript(projectRoot, 'staged');

    const internals = loadUefnVerseCheckInternals();
    const result = internals.locateVerseCheckScript(projectRoot);
    assert.equal(result.chosen, null);
    assert.equal(result.overrideInvalid?.label, 'uefn-paths.json override');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('script ladder: nothing present anywhere reports script_not_found with every location tried', () => {
  const projectRoot = tmpProjectRoot('uefn-verse-check-ladder-none-');
  const fakeServerRoot = tmpProjectRoot('uefn-verse-check-ladder-none-serverroot-');
  const fakeServerDir = join(fakeServerRoot, 'uefn-bridge');
  try {
    const internals = loadUefnVerseCheckInternals({ serverFileDir: fakeServerDir });
    const result = internals.locateVerseCheckScript(projectRoot);
    assert.equal(result.chosen, null);
    assert.equal(result.tried.length, 2, 'with no env/json override set, only staged-copy and bundled-copy are tried');
    assert.equal(result.tried[0].label, "project's staged copy");
    assert.equal(result.tried[1].label, "extension's bundled copy");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(fakeServerRoot, { recursive: true, force: true });
  }
});

// ── python interpreter probing (item 2) ─────────────────────────────────────

test('locatePythonInterpreter finds the fake interpreter when it is first on PATH', async () => {
  const internals = loadUefnVerseCheckInternals();
  const result = await withPath(FAKE_PY_DIR, () => internals.locatePythonInterpreter());
  assert.ok(result.chosen);
  assert.equal(result.chosen?.cmd, 'python');
  assert.ok(result.chosen?.version.length > 0);
});

test('locatePythonInterpreter: none of python/python3/py available is an explicit, actionable precondition error — not a clean/empty result', async () => {
  const internals = loadUefnVerseCheckInternals();
  const result = await withEmptyPath(() => internals.locatePythonInterpreter());
  assert.equal(result.chosen, null);
  assert.deepEqual(result.tried, ['python', 'python3', 'py']);
});

test('uefn_verse_check end-to-end: no python interpreter on PATH yields a structured precondition error, never a clean result', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-nopy-');
  writeStagedScript(projectRoot, 'process.exit(0);');
  try {
    const parsed = await withEmptyPath(() => callHandler(internals, { project_root: projectRoot }));
    assert.equal(parsed.status, 'error');
    assert.equal(parsed.tier, 'python_not_found');
    assert.ok(!('diagnostics' in parsed), 'must not look like a clean/empty diagnostics result');
    assert.equal(typeof parsed.next_required_action, 'string');
    assert.match(parsed.next_required_action as string, /Install Python 3/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ── exit-code mapping (item 3) ───────────────────────────────────────────────

test('exit 0: clean run maps to status ok, tier clean, zero diagnostics', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-exit0-');
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(okJson())}); process.exit(0);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.exit_code, 0);
    assert.equal(parsed.tier, 'clean');
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal((parsed.counts as Record<string, unknown>).returned, 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('exit 1: diagnostics found maps to status ok, tier diagnostics_found, non-empty diagnostics', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-exit1-');
  const diagnostics = [
    { path: 'C:/proj/Content/DeviceA/FileA.verse', line: 3, character: 1, severity: 1, severity_word: 'Error', code: 'E001', message: 'boom' },
  ];
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(okJson({ diagnostics, summary: { total: 1, by_severity: { error: 1 } } }))}); process.exit(1);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.exit_code, 1);
    assert.equal(parsed.tier, 'diagnostics_found');
    assert.equal((parsed.diagnostics as unknown[]).length, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('exit 2: usage error is handled specially because the script prints NO JSON even with --json', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-exit2-');
  writeStagedScript(
    projectRoot,
    `process.stderr.write("error: project_root does not resolve to a UEFN project\\n"); process.exit(2);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    assert.equal(parsed.status, 'error');
    assert.equal(parsed.exit_code, 2);
    assert.equal(parsed.tier, 'usage_error');
    assert.ok(!('diagnostics' in parsed), 'exit 2 must not be reported as a clean/empty diagnostics result');
    assert.match(parsed.stderr as string, /does not resolve/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('exit 3: preconditions not met is never a clean pass even though no diagnostics are listed', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-exit3-');
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(
      JSON.stringify({ status: 'precondition_failed', reason: 'missing_extension', messages: ["Install the 'epicgames.verse' extension"] })
    )}); process.exit(3);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    assert.equal(parsed.status, 'error');
    assert.equal(parsed.exit_code, 3);
    assert.equal(parsed.tier, 'precondition_failed');
    assert.equal(parsed.reason, 'missing_extension');
    assert.deepEqual(parsed.messages, ["Install the 'epicgames.verse' extension"]);
    assert.ok(!('diagnostics' in parsed), 'exit 3 must not read as a clean/zero-diagnostic result');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ── max_diagnostics truncation is never silent (item 4) ─────────────────────

test('max_diagnostics truncation reports omitted_by_max_diagnostics and says so in next_required_action', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-truncate-');
  const diagnostics = Array.from({ length: 6 }, (_, i) => ({
    path: 'C:/proj/Content/DeviceA/FileA.verse',
    line: i,
    character: 0,
    severity: 1,
    severity_word: 'Error',
    code: 'E001',
    message: `err ${i}`,
  }));
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(okJson({ diagnostics, summary: { total: 6, by_severity: { error: 6 } } }))}); process.exit(1);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot, max_diagnostics: 2 }));
    const counts = parsed.counts as Record<string, unknown>;
    assert.equal(counts.returned, 2);
    assert.equal(counts.omitted_by_max_diagnostics, 4, 'must state exactly how many were omitted');
    assert.match(parsed.next_required_action as string, /truncated the list — 4 diagnostic\(s\) in scope were/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('no truncation (result fits under max_diagnostics) reports omitted_by_max_diagnostics: 0', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-notruncate-');
  const diagnostics = [
    { path: 'C:/proj/Content/DeviceA/FileA.verse', line: 1, character: 0, severity: 1, severity_word: 'Error', code: 'E001', message: 'x' },
  ];
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(okJson({ diagnostics, summary: { total: 1, by_severity: { error: 1 } } }))}); process.exit(1);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    const counts = parsed.counts as Record<string, unknown>;
    assert.equal(counts.omitted_by_max_diagnostics, 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ── files scoping: positive match and correct exclusion (item 5) ────────────

test('files scoping: only diagnostics matching `files` are returned, others are excluded', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-filescope-');
  const diagnostics = [
    { path: 'C:/proj/Content/DeviceA/FileA.verse', line: 1, character: 0, severity: 1, severity_word: 'Error', code: 'E001', message: 'inA' },
    { path: 'C:/proj/Content/DeviceB/FileB.verse', line: 1, character: 0, severity: 1, severity_word: 'Error', code: 'E002', message: 'inB' },
  ];
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(okJson({ diagnostics, summary: { total: 2, by_severity: { error: 2 } } }))}); process.exit(1);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot, files: ['FileA.verse'] }));
    const returned = parsed.diagnostics as { file: string; message: string }[];
    assert.equal(returned.length, 1, 'only the FileA diagnostic should survive the files filter');
    assert.equal(returned[0].message, 'inA');
    assert.ok(!returned.some((d) => d.message === 'inB'), 'the FileB diagnostic must be excluded, not just deprioritized');
    assert.equal((parsed.counts as Record<string, unknown>).after_files_scope, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('files scoping that matches nothing still reports the underlying scan tier honestly, scoped explicitly to "requested scope"', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-filescope-empty-');
  const diagnostics = [
    { path: 'C:/proj/Content/DeviceA/FileA.verse', line: 1, character: 0, severity: 1, severity_word: 'Error', code: 'E001', message: 'inA' },
  ];
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(okJson({ diagnostics, summary: { total: 1, by_severity: { error: 1 } } }))}); process.exit(1);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot, files: ['NoSuchFile.verse'] }));
    assert.equal((parsed.counts as Record<string, unknown>).after_files_scope, 0);
    assert.deepEqual(parsed.diagnostics, []);
    assert.match(parsed.next_required_action as string, /requested scope/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ── project_root invalid (item 6) ────────────────────────────────────────────

test('an explicit project_root that does not exist on disk is a hard structured error, never silently swapped for a default', async () => {
  const internals = loadUefnVerseCheckInternals();
  const parsed = await callHandler(internals, { project_root: 'Z:/definitely/does/not/exist/uefn-verse-check-xyz' });
  assert.equal(parsed.status, 'error');
  assert.equal(parsed.tier, 'project_root_invalid');
  assert.equal(parsed.given, 'Z:/definitely/does/not/exist/uefn-verse-check-xyz');
  assert.ok(!('diagnostics' in parsed));
});

// ── malformed JSON, spawn failure, timeout (item 7) ─────────────────────────

test('unparseable stdout JSON (exit 0) yields a distinct honest error, not a success shape', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-malformed-');
  writeStagedScript(projectRoot, `process.stdout.write("not actually json {{{"); process.exit(0);`);
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    assert.equal(parsed.status, 'error');
    assert.equal(parsed.tier, 'unparseable_output');
    assert.ok(!('diagnostics' in parsed));
    assert.match(parsed.stdout_tail as string, /not actually json/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('a subprocess that hangs past the timeout is killed and reported as tier "timeout", not a clean pass', async () => {
  // VERSE_CHECK_SUBPROCESS_TIMEOUT_MS is patched to 1200ms for this instance
  // only — the real 170_000ms value is asserted unmodified in the source by
  // the guard test above; nobody actually waits 170s in a test.
  const internals = loadUefnVerseCheckInternals({ timeoutMs: 1200 });
  const projectRoot = tmpProjectRoot('uefn-verse-check-timeout-');
  writeStagedScript(projectRoot, `setTimeout(() => {}, 60000);`);
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    assert.equal(parsed.status, 'error');
    assert.equal(parsed.tier, 'timeout');
    assert.equal(parsed.exit_code, null);
    assert.ok(!('diagnostics' in parsed), 'a killed/timed-out run must never be reported as a clean pass');
    assert.match(parsed.next_required_action as string, /NOT a clean pass/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

/*
 * NOT covered, and stated plainly rather than faked: a genuine OS-level
 * "spawn_failed" (the `else` branch after ruling out timeout/killed and a
 * numeric exit code — e.g. the resolved python binary vanishing or losing
 * permissions between locatePythonInterpreter's successful probe and the
 * very next spawn call a few lines later) cannot be produced deterministically
 * without a real timing race: both calls resolve the same bare command name
 * ("python"/"python3"/"py") off the same PATH, so if the probe finds an
 * interpreter, the immediately-following spawn will resolve the exact same
 * way in this hermetic setup. Reaching the `else` branch requires either
 * genuinely racing a file deletion against the internal implementation (flaky
 * by construction, and this test file does not have a seam to hook between
 * those two internal awaits) or mocking child_process.execFile below the
 * handler, which would stop exercising real spawn semantics and prove
 * nothing about the actual code path. The branch was verified by code review
 * only: `uefn-bridge/uefn-server.ts` around the `spawn_failed` tier — the
 * `else` arm after `if (typeof err.code === "number")` — correctly falls
 * through to `verseCheckError("spawn_failed", ...)` for any rejection whose
 * `.code` isn't a number, which matches Node's own documented shape for a
 * launch-time (as opposed to exit-time) child_process error.
 */

// ── next_required_action is present and terminal (item 9) ───────────────────

test('next_required_action is present and is the terminal key across every result shape (success and every error tier)', async () => {
  const internals = loadUefnVerseCheckInternals();
  const roots: string[] = [];

  function assertTerminalKey(parsed: Record<string, unknown>, label: string) {
    assert.equal(typeof parsed.next_required_action, 'string', `${label}: next_required_action missing or not a string`);
    const keys = Object.keys(parsed);
    assert.equal(keys[keys.length - 1], 'next_required_action', `${label}: expected next_required_action last, got: ${keys.join(', ')}`);
    // The model reads the serialized JSON text, not the JS object — assert
    // the literal tail too (mirrors uefnModerationExternalLink.test.ts).
    const serialized = JSON.stringify(parsed);
    assert.ok(serialized.endsWith(`"next_required_action":${JSON.stringify(parsed.next_required_action)}}`), `${label}: serialized tail did not end with next_required_action`);
  }

  try {
    // success, clean
    const cleanRoot = tmpProjectRoot('uefn-verse-check-terminal-clean-');
    roots.push(cleanRoot);
    writeStagedScript(cleanRoot, `process.stdout.write(${JSON.stringify(okJson())}); process.exit(0);`);
    assertTerminalKey(await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: cleanRoot })), 'exit 0 clean');

    // success, diagnostics
    const diagRoot = tmpProjectRoot('uefn-verse-check-terminal-diag-');
    roots.push(diagRoot);
    const diagnostics = [{ path: 'C:/proj/Content/A.verse', line: 1, character: 0, severity: 1, severity_word: 'Error', code: 'E1', message: 'x' }];
    writeStagedScript(diagRoot, `process.stdout.write(${JSON.stringify(okJson({ diagnostics, summary: { total: 1, by_severity: { error: 1 } } }))}); process.exit(1);`);
    assertTerminalKey(await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: diagRoot })), 'exit 1 diagnostics');

    // error: project_root_invalid
    assertTerminalKey(await callHandler(internals, { project_root: 'Z:/nope-terminal-key-test' }), 'project_root_invalid');

    // error: precondition_failed
    const precondRoot = tmpProjectRoot('uefn-verse-check-terminal-precond-');
    roots.push(precondRoot);
    writeStagedScript(
      precondRoot,
      `process.stdout.write(${JSON.stringify(JSON.stringify({ status: 'precondition_failed', reason: 'x', messages: ['y'] }))}); process.exit(3);`
    );
    assertTerminalKey(await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: precondRoot })), 'precondition_failed');

    // error: python_not_found
    const nopyRoot = tmpProjectRoot('uefn-verse-check-terminal-nopy-');
    roots.push(nopyRoot);
    writeStagedScript(nopyRoot, `process.exit(0);`);
    assertTerminalKey(await withEmptyPath(() => callHandler(internals, { project_root: nopyRoot })), 'python_not_found');
  } finally {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  }
});

// ── version_note WARNING passthrough (bonus real-logic coverage) ────────────

test('a version_note starting with "WARNING" is prepended to next_required_action', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-versionwarn-');
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(okJson({ version_note: 'WARNING: verse-lsp.exe version mismatch' }))}); process.exit(0);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    assert.match(parsed.next_required_action as string, /^WARNING: verse-lsp\.exe version mismatch — /);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

/*
 * ── --target / exit-4 / auto_open_capped regression coverage ───────────────
 *
 * Coverage for docs/VERSE-LSP-CHECK-TARGETING.md: `files` used to be a pure
 * OUTPUT filter over whatever verse_lsp_check.py's small auto-discovery
 * sample happened to open, so a `files` entry outside that sample came back
 * as an empty diagnostics list -- indistinguishable from "checked and
 * clean". `files` is now passed through as --target (a targeting
 * guarantee), the underlying script gained exit code 4 for
 * "requested target not analyzed", and a capped auto-discovery run now
 * discloses itself via `auto_open_capped`/`total_verse_files`. The tests
 * below drive the REAL extracted handler exactly as the existing exit-code
 * tests above do; the only new technique is capturing the literal argv the
 * handler hands to execFileAsync, via a staged fixture "script" (really JS,
 * per the FAKE_PY_DIR trick above) that writes process.argv to a file on
 * disk before producing its own stdout result.
 */

function writeArgvCaptureScript(
  projectRoot: string,
  capturePath: string,
  resultJson: string,
  exitCode: number
): string {
  return writeStagedScript(
    projectRoot,
    `require('fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)));\n` +
      `process.stdout.write(${JSON.stringify(resultJson)});\n` +
      `process.exit(${exitCode});\n`
  );
}

test('files: produces repeated --target argv entries in the ACTUAL spawned command, not just an output filter', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-argv-target-');
  const capturePath = join(projectRoot, 'argv-capture.json');
  writeArgvCaptureScript(projectRoot, capturePath, okJson(), 0);
  try {
    await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot, files: ['FileA.verse', 'FileB.verse'] }));
    const argv = JSON.parse(readFileSync(capturePath, 'utf8')) as string[];
    assert.deepEqual(argv, [projectRoot, '--json', '--target', 'FileA.verse', '--target', 'FileB.verse']);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('max_auto_files reaches the spawned command as --max-auto-files', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-argv-maxauto-');
  const capturePath = join(projectRoot, 'argv-capture.json');
  writeArgvCaptureScript(projectRoot, capturePath, okJson(), 0);
  try {
    await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot, max_auto_files: 7 }));
    const argv = JSON.parse(readFileSync(capturePath, 'utf8')) as string[];
    assert.deepEqual(argv, [projectRoot, '--json', '--max-auto-files', '7']);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('files and max_auto_files together: --target entries precede --max-auto-files in the real argv', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-argv-both-');
  const capturePath = join(projectRoot, 'argv-capture.json');
  writeArgvCaptureScript(projectRoot, capturePath, okJson(), 0);
  try {
    await withPath(FAKE_PY_DIR, () =>
      callHandler(internals, { project_root: projectRoot, files: ['Only.verse'], max_auto_files: 0 })
    );
    const argv = JSON.parse(readFileSync(capturePath, 'utf8')) as string[];
    assert.deepEqual(argv, [projectRoot, '--json', '--target', 'Only.verse', '--max-auto-files', '0']);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('exit 4: target_not_analyzed maps to status error with NO diagnostics key -- never a clean/empty-diagnostics shape', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-exit4-');
  const raw = JSON.stringify({
    status: 'target_not_analyzed',
    lsp_path: 'C:/fake/verse-lsp.exe',
    lsp_version: '1.2.3-fake',
    vproject_path: 'C:/fake/proj/Foo.vproject',
    content_dir: 'C:/fake/proj/Content',
    opened_files: ['C:/proj/Content/Other.verse'],
    total_verse_files: 3,
    target_files: ['Missing.verse'],
    unreadable_files: [],
    auto_open_capped: false,
    max_auto_files: 3,
    targets_not_analyzed: ['Missing.verse'],
    version_note: null,
    diagnostics: [],
    summary: { total: 0, by_severity: {} },
  });
  writeStagedScript(projectRoot, `process.stdout.write(${JSON.stringify(raw)}); process.exit(4);`);
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot, files: ['Missing.verse'] }));
    assert.equal(parsed.status, 'error');
    assert.equal(parsed.exit_code, 4);
    assert.equal(parsed.tier, 'target_not_analyzed');
    assert.ok(
      !('diagnostics' in parsed),
      'exit 4 must never carry a diagnostics key -- that key presence is exactly what would make this read as a clean/zero-diagnostics pass'
    );
    assert.deepEqual(parsed.targets_not_analyzed, ['Missing.verse']);
    assert.match(parsed.next_required_action as string, /UNKNOWN status, NOT clean/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('exit 4 also fires from parsed.status alone (belt-and-suspenders: the script could exit 4 without stdout matching, or vice versa)', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-exit4-statusonly-');
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(okJson({ status: 'target_not_analyzed', targets_not_analyzed: ['X.verse'] }))}); process.exit(0);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    assert.equal(parsed.status, 'error');
    assert.equal(parsed.tier, 'target_not_analyzed');
    assert.ok(!('diagnostics' in parsed));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('auto_open_capped true surfaces an explicit PARTIAL RUN disclosure in next_required_action', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-capped-');
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(
      okJson({ auto_open_capped: true, total_verse_files: 50, opened_files: ['a.verse', 'b.verse', 'c.verse'], max_auto_files: 3 })
    )}); process.exit(0);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    assert.equal(parsed.auto_open_capped, true);
    assert.match(parsed.next_required_action as string, /PARTIAL RUN/);
    assert.match(parsed.next_required_action as string, /3 of 50/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('a capped run can never be mistaken for a full clean pass: PARTIAL RUN disclosure appears iff auto_open_capped is true', async () => {
  const internals = loadUefnVerseCheckInternals();
  const cappedRoot = tmpProjectRoot('uefn-verse-check-nofalseclean-capped-');
  const fullRoot = tmpProjectRoot('uefn-verse-check-nofalseclean-full-');
  try {
    writeStagedScript(
      cappedRoot,
      `process.stdout.write(${JSON.stringify(
        okJson({ auto_open_capped: true, total_verse_files: 10, opened_files: ['a.verse', 'b.verse', 'c.verse'], max_auto_files: 3 })
      )}); process.exit(0);`
    );
    writeStagedScript(
      fullRoot,
      `process.stdout.write(${JSON.stringify(
        okJson({ auto_open_capped: false, total_verse_files: 3, opened_files: ['a.verse', 'b.verse', 'c.verse'], max_auto_files: 3 })
      )}); process.exit(0);`
    );

    const capped = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: cappedRoot }));
    const full = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: fullRoot }));

    assert.equal(capped.status, 'ok');
    assert.equal(capped.tier, 'clean');
    assert.equal(capped.auto_open_capped, true);
    assert.match(capped.next_required_action as string, /PARTIAL RUN/);

    assert.equal(full.status, 'ok');
    assert.equal(full.tier, 'clean');
    assert.equal(full.auto_open_capped, false);
    assert.ok(
      !/PARTIAL RUN/.test(full.next_required_action as string),
      'an uncapped, genuinely complete run must not carry the partial-run disclosure text'
    );
  } finally {
    rmSync(cappedRoot, { recursive: true, force: true });
    rmSync(fullRoot, { recursive: true, force: true });
  }
});

/*
 * ── origin classification passthrough (project / epic-generated / other) ────
 *
 * Coverage for the field evidence that drove this: a real project scan found
 * the user's OWN code analyzer-clean while ALL 152 diagnostics sat inside
 * Epic auto-generated files (digests + the project's own .vproject) -- not
 * creator-actionable, since UEFN regenerates those on every open. A human had
 * to work that out by hand; verse_lsp_check.py now labels every diagnostic
 * with `origin`, and uefn_verse_check passes it through per-diagnostic, adds
 * a project-vs-Epic-generated split to `counts`/`origin_summary`, and folds
 * it into `next_required_action`.
 */

test('origin passes through per-diagnostic in the returned result', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-origin-passthrough-');
  const diagnostics = [
    { path: 'C:/proj/Content/FileA.verse', line: 1, character: 0, severity: 1, severity_word: 'Error', code: 'E001', message: 'project err', origin: 'project' },
    { path: 'C:/verseproject/Verse.digest.verse', line: 1, character: 0, severity: 1, severity_word: 'Error', code: 'E002', message: 'digest err', origin: 'epic-generated' },
  ];
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(
      okJson({
        diagnostics,
        summary: { total: 2, by_severity: { error: 2 }, by_origin: { project: 1, 'epic-generated': 1, other: 0 }, origin_line: '1 in project code, 1 in Epic-generated files (digests/vproject -- not creator-actionable), 0 other.' },
      })
    )}); process.exit(1);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    const returned = parsed.diagnostics as { message: string; origin: string }[];
    const byMessage = Object.fromEntries(returned.map((d) => [d.message, d.origin]));
    assert.equal(byMessage['project err'], 'project');
    assert.equal(byMessage['digest err'], 'epic-generated');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('origin defaults to "other" when the underlying script omits the field (older cached copy)', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-origin-missing-');
  const diagnostics = [
    { path: 'C:/proj/Content/FileA.verse', line: 1, character: 0, severity: 1, severity_word: 'Error', code: 'E001', message: 'no origin field' },
  ];
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(okJson({ diagnostics, summary: { total: 1, by_severity: { error: 1 } } }))}); process.exit(1);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    const returned = parsed.diagnostics as { message: string; origin: string }[];
    assert.equal(returned[0].origin, 'other');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('counts.by_origin_in_scope, counts.by_origin_total, and origin_summary all reflect the project/Epic-generated split', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-origin-counts-');
  const diagnostics = [
    { path: 'C:/proj/Content/FileA.verse', line: 1, character: 0, severity: 1, severity_word: 'Error', code: '', message: 'p1', origin: 'project' },
    { path: 'C:/proj/Content/FileB.verse', line: 1, character: 0, severity: 1, severity_word: 'Error', code: '', message: 'p2', origin: 'project' },
    { path: 'C:/verseproject/Verse.digest.verse', line: 1, character: 0, severity: 1, severity_word: 'Error', code: '', message: 'd1', origin: 'epic-generated' },
  ];
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(
      okJson({
        diagnostics,
        summary: { total: 3, by_severity: { error: 3 }, by_origin: { project: 2, 'epic-generated': 1, other: 0 }, origin_line: '2 in project code, 1 in Epic-generated files (digests/vproject -- not creator-actionable), 0 other.' },
      })
    )}); process.exit(1);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    const counts = parsed.counts as Record<string, unknown>;
    assert.deepEqual(counts.by_origin_total, { project: 2, 'epic-generated': 1, other: 0 });
    assert.deepEqual(counts.by_origin_in_scope, { project: 2, 'epic-generated': 1, other: 0 });
    assert.match(parsed.origin_summary as string, /2 in project code/);
    assert.match(parsed.origin_summary as string, /1 in Epic-generated files/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('when EVERY diagnostic in scope is Epic-generated, next_required_action says plainly that project code is analyzer-clean', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-origin-allepic-');
  const diagnostics = Array.from({ length: 3 }, (_, i) => ({
    path: 'C:/verseproject/Verse.digest.verse',
    line: i,
    character: 0,
    severity: 1,
    severity_word: 'Error',
    code: '',
    message: `digest err ${i}`,
    origin: 'epic-generated',
  }));
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(
      okJson({ diagnostics, summary: { total: 3, by_severity: { error: 3 }, by_origin: { project: 0, 'epic-generated': 3, other: 0 } } })
    )}); process.exit(1);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    const action = parsed.next_required_action as string;
    assert.match(action, /analyzer-clean/);
    assert.match(action, /Epic-generated/);
    assert.match(action, /0 in project code, 3 in Epic-generated files/);
    assert.ok(!/^Fix the/.test(action), 'must not tell the creator to "Fix" baseline files they do not own');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('when project-origin diagnostics exist alongside Epic-generated ones, next_required_action focuses on the project-origin count', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-origin-mixed-');
  const diagnostics = [
    { path: 'C:/proj/Content/FileA.verse', line: 1, character: 0, severity: 1, severity_word: 'Error', code: '', message: 'p1', origin: 'project' },
    { path: 'C:/verseproject/Verse.digest.verse', line: 1, character: 0, severity: 1, severity_word: 'Error', code: '', message: 'd1', origin: 'epic-generated' },
    { path: 'C:/verseproject/Verse.digest.verse', line: 2, character: 0, severity: 1, severity_word: 'Error', code: '', message: 'd2', origin: 'epic-generated' },
  ];
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(
      okJson({ diagnostics, summary: { total: 3, by_severity: { error: 3 }, by_origin: { project: 1, 'epic-generated': 2, other: 0 } } })
    )}); process.exit(1);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    const action = parsed.next_required_action as string;
    assert.match(action, /Fix the 1 project-origin diagnostic/);
    assert.ok(!/analyzer-clean/.test(action), 'must not claim analyzer-clean when project-origin diagnostics exist');
    // Every diagnostic (including Epic-origin) must still be present -- never dropped or hidden.
    assert.equal((parsed.diagnostics as unknown[]).length, 3);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('severity/files filters still apply exactly as before with origin present -- Epic-origin diagnostics are never specially hidden by an origin-based filter', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-origin-filters-');
  const diagnostics = [
    { path: 'C:/proj/Content/FileA.verse', line: 1, character: 0, severity: 1, severity_word: 'Error', code: '', message: 'project error', origin: 'project' },
    { path: 'C:/verseproject/Verse.digest.verse', line: 1, character: 0, severity: 1, severity_word: 'Error', code: '', message: 'digest error', origin: 'epic-generated' },
    { path: 'C:/verseproject/Verse.digest.verse', line: 2, character: 0, severity: 2, severity_word: 'Warning', code: '', message: 'digest warning', origin: 'epic-generated' },
  ];
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(
      okJson({ diagnostics, summary: { total: 3, by_severity: { error: 2, warning: 1 } } })
    )}); process.exit(1);`
  );
  try {
    // Default severity filter (error+warning), no files filter: both origins, both severities present.
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    const messages = (parsed.diagnostics as { message: string }[]).map((d) => d.message);
    assert.ok(messages.includes('digest error'), 'Epic-origin diagnostics matching the severity filter must not be dropped');
    assert.ok(messages.includes('digest warning'));
    assert.ok(messages.includes('project error'));

    // severity: ["error"] only -- must exclude the digest WARNING (a severity-filter effect), not any origin-filter effect.
    const errorsOnly = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot, severity: ['error'] }));
    const errorMessages = (errorsOnly.diagnostics as { message: string }[]).map((d) => d.message);
    assert.ok(errorMessages.includes('digest error'), 'an Epic-origin ERROR must still pass a severity:["error"] filter');
    assert.ok(!errorMessages.includes('digest warning'));

    // files: only the project file -- excludes both digest diagnostics via the FILES filter, not an origin filter.
    const filesOnly = await withPath(FAKE_PY_DIR, () =>
      callHandler(internals, { project_root: projectRoot, files: ['FileA.verse'] })
    );
    const filesMessages = (filesOnly.diagnostics as { message: string }[]).map((d) => d.message);
    assert.deepEqual(filesMessages, ['project error']);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('next_required_action remains the terminal key when origin fields (counts.by_origin_*, origin_summary) are present', async () => {
  const internals = loadUefnVerseCheckInternals();
  const projectRoot = tmpProjectRoot('uefn-verse-check-origin-terminal-');
  const diagnostics = [
    { path: 'C:/proj/Content/FileA.verse', line: 1, character: 0, severity: 1, severity_word: 'Error', code: '', message: 'p1', origin: 'project' },
  ];
  writeStagedScript(
    projectRoot,
    `process.stdout.write(${JSON.stringify(okJson({ diagnostics, summary: { total: 1, by_severity: { error: 1 } } }))}); process.exit(1);`
  );
  try {
    const parsed = await withPath(FAKE_PY_DIR, () => callHandler(internals, { project_root: projectRoot }));
    const keys = Object.keys(parsed);
    assert.equal(keys[keys.length - 1], 'next_required_action');
    assert.ok(keys.includes('origin_summary'));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
