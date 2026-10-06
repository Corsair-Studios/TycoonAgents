import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom');

// themeBuilder.ts is a webview module that references `window`/`document` at
// module scope (window.initThemeBuilder = ...) even though the emote
// resolver itself is pure. Stand up a minimal jsdom global before requiring
// it, mirroring test/sceneFitScale.test.ts's approach for media/main.js.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
(global as any).window = dom.window;
(global as any).document = dom.window.document;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveEmoteFrameKey, frameCache } = require('../src/webview/themeBuilder');

const FRAMES_PATH = path.join(
  process.cwd(),
  'media',
  'themes',
  'catopia',
  'frames.json'
);

test('resolveEmoteFrameKey maps legacy emote keys onto real bundled frames.json expression keys', () => {
  const frames = JSON.parse(fs.readFileSync(FRAMES_PATH, 'utf8'));
  const frameKeys: string[] = Object.keys(frames);

  frameCache.clear();
  for (const key of frameKeys) {
    // Only presence in the cache matters for resolution; contents are irrelevant here.
    frameCache.set(key, [{ image: {} as any }]);
  }

  const expectedTargets: Record<string, string> = {
    emote_smile: 'expression_4', // Thumbs up
    emote_idea: 'expression_1', // Idea / discovery spark
    emote_sleep: 'expression_6', // Sleep / low-energy zzz
    emote_team: 'expression_3', // Team action / rally
  };

  for (const [emote, expected] of Object.entries(expectedTargets)) {
    const resolved = resolveEmoteFrameKey(emote, frameCache);
    assert.equal(
      resolved,
      expected,
      `expected ${emote} to resolve to ${expected}, got ${resolved}`
    );
    assert.ok(
      frameCache.has(resolved as string),
      `resolved key ${resolved} for ${emote} must exist in frameCache`
    );
  }

  assert.equal(resolveEmoteFrameKey(null, frameCache), null);
  assert.equal(resolveEmoteFrameKey('emote_unknown', frameCache), null);
});
