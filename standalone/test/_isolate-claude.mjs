// Preload for `npm run test:standalone` (node --import): no test may touch the real
// ~/.claude.json or the real `claude` binary. Mirrors scripts/run-tests.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-test-claude-'));
process.env.CLAUDE_CONFIG_DIR = dir;
process.env.TYCOON_CLAUDE_BIN = 'none';
process.on('exit', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});
