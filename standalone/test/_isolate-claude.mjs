// Preload for `npm run test:standalone` (node --import): no test may touch the real
// ~/.claude.json or the real `claude` binary. Mirrors scripts/run-tests.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-test-claude-'));
process.env.CLAUDE_CONFIG_DIR = dir;
process.env.TYCOON_CLAUDE_BIN = 'none';
// The stable launcher folder (~/.tycoonagents/bin) must never be written by a test: sandbox the home folder.
process.env.USERPROFILE = path.join(dir, 'home');
process.env.HOME = path.join(dir, 'home');
process.env.TYCOON_TEST_HOME_SANDBOX = '1';
process.env.TYCOON_MCP_VERIFY_DELAY_MS = '0';
process.on('exit', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});
