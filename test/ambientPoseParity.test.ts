import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  STAND_BACK_CHANCE,
  IDLE_RARE_CHANCE,
  IDLE_RARE_MINUTE_SECONDS,
  IDLE_RARE_DURATION_SECONDS,
} from '../src/webview/animationPlayback';

// media/main.js is a hand-edited browser file that embeds a copy of the
// ambient-idle-pose constants from src/webview/animationPlayback.ts (it
// can't import from src/ — it's loaded directly by the webview with no
// bundler). This mirrors test/webviewAtlasClips.test.ts so the four
// constants cannot drift between the two files.

function extractMainJsConstant(name: string): number {
  const mainPath = join(process.cwd(), 'media', 'main.js');
  const src = readFileSync(mainPath, 'utf8');
  const re = new RegExp(`const\\s+${name}\\s*=\\s*([0-9.]+)\\s*;`);
  const match = re.exec(src);
  assert.ok(match, `Could not find "const ${name} = ...;" in media/main.js`);
  return Number(match![1]);
}

test('media/main.js ambient idle pose constants match src/webview/animationPlayback.ts', () => {
  assert.equal(extractMainJsConstant('STAND_BACK_CHANCE'), STAND_BACK_CHANCE,
    'STAND_BACK_CHANCE has drifted between media/main.js and animationPlayback.ts');
  assert.equal(extractMainJsConstant('IDLE_RARE_CHANCE'), IDLE_RARE_CHANCE,
    'IDLE_RARE_CHANCE has drifted between media/main.js and animationPlayback.ts');
  assert.equal(extractMainJsConstant('IDLE_RARE_MINUTE_SECONDS'), IDLE_RARE_MINUTE_SECONDS,
    'IDLE_RARE_MINUTE_SECONDS has drifted between media/main.js and animationPlayback.ts');
  assert.equal(extractMainJsConstant('IDLE_RARE_DURATION_SECONDS'), IDLE_RARE_DURATION_SECONDS,
    'IDLE_RARE_DURATION_SECONDS has drifted between media/main.js and animationPlayback.ts');
});
