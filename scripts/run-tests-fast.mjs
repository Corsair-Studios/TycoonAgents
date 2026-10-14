// Fast subset test runner (p87 JOB 2b): `npm run test:fast -- <pattern>`
// compiles incrementally (reusing out/.tsbuildinfo, see tsconfig.json's
// incremental/tsBuildInfoFile) instead of the full `tsc -p .` npm test
// does, then runs only the compiled *.test.js files whose path contains
// <pattern> (case-insensitive substring match) through the same hardened
// `node --test` invocation as scripts/run-tests.mjs. `npm test` stays the
// full, authoritative tier — this is a contributor convenience for
// iterating on one area without paying for the whole suite every time.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const testDir = path.join(root, 'out', 'test');
const require = createRequire(import.meta.url);

const pattern = process.argv[2];
if (!pattern) {
  console.error('Usage: npm run test:fast -- <pattern>');
  console.error('  <pattern> matches (case-insensitively) against the compiled test file path.');
  process.exit(1);
}

const compile = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', '.'], {
  stdio: 'inherit',
  cwd: root,
});
if (compile.status !== 0) {
  console.error('Incremental compile failed.');
  process.exit(compile.status ?? 1);
}

function collect(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...collect(full));
    } else if (entry.endsWith('.test.js')) {
      files.push(full);
    }
  }
  return files;
}

const needle = pattern.toLowerCase();
const files = collect(testDir)
  .filter((f) => f.toLowerCase().includes(needle))
  .sort();

if (files.length === 0) {
  console.error(`No *.test.js files under ${testDir} match "${pattern}".`);
  process.exit(1);
}

console.error(`test:fast running ${files.length} file(s) matching "${pattern}":`);
for (const f of files) console.error(`  ${path.relative(root, f)}`);

// No test may touch the real ~/.claude.json or `claude` binary (same as scripts/run-tests.mjs).
const claudeSandbox = mkdtempSync(path.join(os.tmpdir(), 'tycoon-test-claude-'));
const result = spawnSync(
  process.execPath,
  ['--test', '--test-timeout=60000', '--test-force-exit', ...files],
  { stdio: 'inherit', env: { ...process.env, CLAUDE_CONFIG_DIR: claudeSandbox, TYCOON_CLAUDE_BIN: 'none' } },
);
try { rmSync(claudeSandbox, { recursive: true, force: true }); } catch { /* best effort */ }

process.exit(result.status ?? 1);
