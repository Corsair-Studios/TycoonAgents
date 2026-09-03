// TycoonAgents standalone — tests for cli.mjs's `watch --provider` flag
// (plan p5-t1). Spawns cli.mjs as a real child process (not an in-process
// import) so we exercise the actual argv → env.TYCOON_PROVIDER → resolved-id
// log path exactly as a user would invoke it. Uses --no-open so no browser
// launch is attempted, and sends SIGINT shortly after startup so the process
// exits cleanly instead of hanging the test.
//
// Node built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'src', 'cli.mjs');

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-provider-test-'));
}

/**
 * Spawns `node cli.mjs watch <dir> --no-open --provider <id>`, waits for
 * either the "using provider" log line or process exit, then sends SIGINT
 * (on platforms that support it) so the server shuts down cleanly.
 */
function runWatch(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, 'watch', ...args], {
      env: {
        ...process.env,
        TYCOON_STANDALONE_NO_OPEN: '1',
        // Root cause of the prior flakiness: without these, this spawned
        // CLI binds the real default port (4173) and writes to the real
        // user app-data dir — on a machine that already has something
        // bound to 4173 (e.g. a dev server), startServer() rejects with
        // ServerStartError before ever logging "using provider", so the
        // test only ever saw the safety-timeout kill. TYCOON_STANDALONE_PORT
        // '0' binds an ephemeral, collision-free port (matching every other
        // suite's convention — see server.test.mjs/cli.test.mjs) and
        // TYCOON_STANDALONE_DATA_DIR isolates app-data to a temp dir.
        TYCOON_STANDALONE_PORT: '0',
        TYCOON_STANDALONE_DATA_DIR: mkTempDir(),
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (/using provider/.test(stdout) && process.platform !== 'win32') {
        child.kill('SIGINT');
      } else if (/using provider/.test(stdout)) {
        // Windows: SIGINT to a child isn't reliably delivered; kill directly.
        child.kill();
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => finish(code ?? 0));
    // Safety timeout so a hang doesn't stall the suite — this should now
    // only ever fire on a genuine hang, not on the port collision above.
    setTimeout(() => {
      if (!settled) child.kill();
    }, 8000).unref();
  });
}

test('watch --provider opencode: startup log names opencode', async () => {
  const dir = mkTempDir();
  const { stdout } = await runWatch(['--no-open', '--provider', 'opencode', dir]);
  assert.match(stdout, /using provider "opencode"/);
});

test('watch --provider bogus: exits non-zero, names valid ids, never starts a server', async () => {
  const dir = mkTempDir();
  const { code, stderr, stdout } = await runWatch(['--no-open', '--provider', 'bogus', dir]);
  assert.notEqual(code, 0);
  assert.match(stderr, /bogus/);
  assert.match(stderr, /claude-code/);
  assert.match(stderr, /opencode/);
  assert.doesNotMatch(stdout, /watching\. Open/);
});

test('watch with TYCOON_PROVIDER env set overrides --provider flag', async () => {
  const dir = mkTempDir();
  const { stdout } = await runWatch(['--no-open', '--provider', 'opencode', dir], {
    TYCOON_PROVIDER: 'claude-code',
  });
  assert.match(stdout, /using provider "claude-code"/);
});
