#!/usr/bin/env node
// Build gate: run a standalone TypeScript checkJs pass over media/main.js and
// fail only on crash-class errors (undefined identifiers / TDZ violations).
//
// media/main.js is a ~7900-line untyped webview script, excluded from the
// main tsconfig.json build (see "exclude": ["media/**/*", ...]) and never
// typechecked. Running plain `tsc --checkJs` on it emits ~200+ harmless
// TS2339 "property does not exist" errors because the script has no type
// annotations. Those are noise. What actually matters — because it has
// caused real runtime ReferenceErrors in production — is:
//   TS2304  Cannot find name                        (undefined identifier)
//   TS2448  Block-scoped variable used before decl  (TDZ)
//   TS2454  Variable used before being assigned     (TDZ)
//   TS2451  Cannot redeclare block-scoped variable  (redeclaration)
// This script runs tsc against media/jsconfig.json and filters the output
// down to just those codes, so CI/local runs stay silent unless there is a
// real crash-class bug.
import { spawnSync } from 'node:child_process';

const CRASH_CODES = ['TS2304', 'TS2448', 'TS2451', 'TS2454'];
const CRASH_CODE_RE = new RegExp(`\\b(${CRASH_CODES.join('|')})\\b`);

const result = spawnSync('npx', ['tsc', '-p', 'media/jsconfig.json'], {
  encoding: 'utf8',
  // shell: true lets Node resolve `npx` (a .cmd shim on Windows) via PATH the
  // same way a terminal would; without it, spawnSync throws EINVAL on
  // Windows and the guardrail would silently see empty output and pass.
  shell: true,
});

if (result.error) {
  console.error('[check:webview] Failed to run tsc:', result.error);
  process.exit(1);
}

// tsc exits non-zero whenever ANY error is reported (including the expected
// ~200+ harmless TS2339 property errors from an untyped script), so the exit
// code is not a useful signal here — only the filtered output matters.
const output = `${result.stdout || ''}${result.stderr || ''}`;

const crashLines = output
  .split(/\r?\n/)
  .filter((line) => CRASH_CODE_RE.test(line));

if (crashLines.length > 0) {
  console.error(
    '\n[check:webview] Webview guardrail FAILED — undefined identifier / ' +
    'use-before-declaration in media/main.js:\n',
  );
  for (const line of crashLines) {
    console.error(`  ${line}`);
  }
  console.error(
    '\nThese error codes indicate real runtime-crash bugs (ReferenceError / ' +
    'TDZ), not harmless untyped-property noise:\n' +
    '  TS2304 Cannot find name\n' +
    '  TS2448/TS2454 block-scoped variable used before its declaration (TDZ)\n' +
    '  TS2451 cannot redeclare block-scoped variable\n' +
    'Fix media/main.js (or declare a legitimate injected global in ' +
    'media/globals.d.ts) before packaging.\n',
  );
  process.exit(1);
}

console.log(
  'check:webview OK — no undefined-identifier / TDZ errors in media/main.js',
);
process.exit(0);
