/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// p43-t7: theme planning/description generation now routes through the
// Corsair Theme Service's POST /api/plan — no direct OpenAI/Gemini call and
// no provider API key handling should remain in the files this task owns.
// Scoped to those files (not a repo-wide grep) because board-IMAGE
// generation config in standalone/src/server.mjs is a separate, still-open
// migration (plan p44) outside this task's ownership.
//
// Compiled test files run from out/test/ (see scripts/run-tests.mjs), so
// this reads the ORIGINAL .ts/.mjs sources from process.cwd() (the repo
// root the test runner is invoked from) rather than __dirname, which would
// resolve into out/ where only compiled .js exists.
const REPO_ROOT = process.cwd();
const FILES = [
  path.join(REPO_ROOT, 'src', 'extension', 'translator.ts'),
  path.join(REPO_ROOT, 'src', 'host', 'vscode', 'panel.ts'),
  path.join(REPO_ROOT, 'standalone', 'src', 'themeGenerationMessages.mjs'),
  path.join(REPO_ROOT, 'src', 'core', 'themeServiceClient.ts'),
];

const FORBIDDEN = [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'resolveThemeImageApiKey',
  'resolveThemeImageSettings',
  'saveThemeImageSettings',
];

test('translator.ts / panel.ts / themeServiceClient.ts contain no provider API key reads or direct provider endpoints', () => {
  for (const file of FILES.filter((f) => !f.endsWith('themeGenerationMessages.mjs'))) {
    const contents = fs.readFileSync(file, 'utf8');
    for (const needle of FORBIDDEN) {
      assert.equal(
        contents.includes(needle),
        false,
        `expected ${path.basename(file)} to contain no occurrence of "${needle}"`,
      );
    }
  }
});

// themeGenerationMessages.mjs still reads TYCOON_OPENAI_API_KEY/
// TYCOON_GEMINI_API_KEY for board-IMAGE generation (a separate call path,
// plan p44, out of this task's scope — see requireApiKey/buildImageOptions
// used by handleGenerateTheme/handleRetryThemeImage). Only the TEXT
// endpoints this task owns (handlePlanTheme, handleRegenerateThemeDescriptions)
// must be free of any API-key resolution.
function extractFunctionBody(source: string, functionName: string): string {
  const start = source.indexOf(`export async function ${functionName}(`);
  assert.notEqual(start, -1, `expected to find function ${functionName}`);
  // Naive brace-matching from the function's opening brace.
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(braceStart, i + 1);
}

test('themeGenerationMessages.mjs: handlePlanTheme and handleRegenerateThemeDescriptions read no provider API key and call no direct provider endpoint', () => {
  const file = path.join(REPO_ROOT, 'standalone', 'src', 'themeGenerationMessages.mjs');
  const contents = fs.readFileSync(file, 'utf8');
  for (const fn of ['handlePlanTheme', 'handleRegenerateThemeDescriptions']) {
    const body = extractFunctionBody(contents, fn);
    for (const needle of [...FORBIDDEN, 'requireApiKey', 'buildImageOptions', 'TYCOON_OPENAI_API_KEY', 'TYCOON_GEMINI_API_KEY']) {
      assert.equal(body.includes(needle), false, `expected ${fn} to contain no occurrence of "${needle}"`);
    }
  }
});

test('src/extension/themeImageSettings.ts no longer exists (deleted once resolveThemeImageSettings became unused)', () => {
  const removed = path.join(REPO_ROOT, 'src', 'extension', 'themeImageSettings.ts');
  assert.equal(fs.existsSync(removed), false);
});
