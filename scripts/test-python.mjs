#!/usr/bin/env node
// Build gate: run the stdlib-unittest suite for the UEFN bridge Python
// collectors (test/python/, discovered as test_*.py). See test/python/ for
// why this exists: every historical bug in the moderation-scanner feature
// (~19 releases' worth) lived in Python and was previously proven only by a
// throwaway scratchpad harness that died with the session.
//
// Interpreter-absent policy: if NO Python interpreter is found on this
// machine, that is an ENVIRONMENT condition, not a test failure — print a
// loud warning and exit 0 so packaging is never blocked by a missing dev
// tool. If an interpreter IS found and any test fails, exit non-zero and
// fail the release; a swallowed real failure here would repeat the exact
// antipattern this suite exists to end.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TEST_DIR = join(ROOT, 'test', 'python');

const CANDIDATES = [
  { cmd: 'python', args: ['--version'] },
  { cmd: 'py', args: ['-3', '--version'] },
  { cmd: 'python3', args: ['--version'] },
];

function findInterpreter() {
  for (const candidate of CANDIDATES) {
    const probe = spawnSync(candidate.cmd, candidate.args, { encoding: 'utf8', shell: true });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }
  return null;
}

if (!existsSync(TEST_DIR)) {
  console.error(`[test:python] Expected test directory at ${TEST_DIR}, not found.`);
  process.exit(1);
}

const interpreter = findInterpreter();

if (!interpreter) {
  console.warn(
    '\n' +
    '=============================================================\n' +
    '[test:python] WARNING: no Python interpreter found on PATH\n' +
    '(tried: python, py -3, python3). SKIPPING the UEFN bridge\n' +
    'Python test suite (test/python/) — this is an ENVIRONMENT\n' +
    'condition, not a test failure, so it does not block packaging.\n' +
    'Install Python and re-run `npm run test:python` to actually\n' +
    'exercise this suite before shipping a moderation-scanner change.\n' +
    '=============================================================\n',
  );
  process.exit(0);
}

console.log(`[test:python] Using interpreter: ${interpreter.cmd} ${interpreter.args.slice(0, -1).join(' ')}`.trim());

const runArgs = [...interpreter.args.slice(0, -1), '-m', 'unittest', 'discover', '-s', TEST_DIR, '-p', 'test_*.py', '-v'];
const result = spawnSync(interpreter.cmd, runArgs, {
  stdio: 'inherit',
  shell: true,
  cwd: ROOT,
});

if (result.error) {
  console.error('[test:python] Failed to run the interpreter:', result.error);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    `\n[test:python] FAILED — the UEFN bridge Python test suite reported failures ` +
    `(exit ${result.status}). Fix before packaging; do not bypass this gate.\n`,
  );
  process.exit(result.status || 1);
}

console.log('\n[test:python] OK — UEFN bridge Python test suite passed.');
process.exit(0);
