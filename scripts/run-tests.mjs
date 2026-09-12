// Cross-platform, cross-Node-version test runner entrypoint.
//
// `node --test "out/test/**/*.test.js"` relies on shell glob expansion,
// which Node 20/22 CLIs don't do themselves (glob support in the test
// runner's own file resolution arrived later). This script walks
// out/test itself, collects every *.test.js file, and passes the
// explicit file list to `node --test`, so behavior is identical on
// Node 20, 22, and 24 and on any shell (bash, PowerShell, cmd).
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const testDir = path.join(root, 'out', 'test');

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

const files = collect(testDir).sort();

if (files.length === 0) {
  console.error(`No *.test.js files found under ${testDir}`);
  process.exit(1);
}

const extraArgs = process.argv.slice(2);
const result = spawnSync(process.execPath, ['--test', ...extraArgs, ...files], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
