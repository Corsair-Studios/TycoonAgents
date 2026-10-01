// Root cause guard: the THEME_IMAGE_REVIEW payload the webview renders its
// "Spent on this theme so far" line from must carry `creditsSpent`. Both
// hosts built the payload without it, so the line always read 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const read = (...parts: string[]) => readFileSync(path.join(process.cwd(), ...parts), 'utf8').replace(/\r\n/g, '\n');

test('panel.ts _postThemeImageReview forwards review.creditsSpent in the THEME_IMAGE_REVIEW payload', () => {
  const src = read('src', 'host', 'vscode', 'panel.ts');
  const post = src.indexOf('type: MSG.THEME_IMAGE_REVIEW,\n        payload: {\n          theme_id: review.theme_id');
  assert.ok(post >= 0, 'expected the full THEME_IMAGE_REVIEW post');
  assert.match(src.slice(post, post + 2600), /creditsSpent:\s*review\.creditsSpent/);
});

test('panel.ts wires the generator so a successful attempt refreshes the balance immediately', () => {
  const src = read('src', 'host', 'vscode', 'panel.ts');
  assert.match(src, /createServiceImageGenerator\(this\._themeServiceHost\.getClient\(\), \{[\s\S]{0,200}applyCreditsFromAttempt\(credits, token\)/);
  assert.match(src, /setThemeAttemptCostResolver\(\(boardType\) => this\._themeServiceHost\?\.getQuotedAttemptCost\(boardType\)\)/);
});

test('standalone mirrors both: creditsSpent in the review payload and the onCredits wiring', () => {
  const messages = read('standalone', 'src', 'themeMessages.mjs');
  assert.match(messages, /creditsSpent:\s*outItems\.reduce\(/);
  const server = read('standalone', 'src', 'server.mjs');
  assert.match(server, /wireThemeServiceGeneration\(\s*themeServiceHostInstance\.getClient\(\),[\s\S]{0,300}applyCreditsFromAttempt\?\.\(credits, token\)[\s\S]{0,200}getQuotedAttemptCost/);
});
