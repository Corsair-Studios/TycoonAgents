#!/usr/bin/env node
// Builds dist/tycoonagents-standalone-<version>.zip: the minimal runtime
// file set needed to unzip and run the standalone host without cloning the
// repo or installing build tooling. Version is read from the repo root
// package.json (kept in lockstep with the VSIX release).
//
// Included:
//   - out/                 compiled TS output the standalone require()s
//                           (src/core/state.js, mappingRegistry.js,
//                           providers/claude-code/index.js, extension/
//                           themeService.js, host/vscode/hookInstall.js,
//                           host/vscode/projectPlan.js, etc.)
//   - standalone/src/       the standalone server/CLI sources
//   - standalone/package.json, standalone/README.md
//   - media/                served in place by server.mjs (main.js,
//                           style.css, handbook, sprites, themes, ...)
//   - hooks/                tycoon-claude-hook.cjs + OpenCode plugin files,
//                           referenced by absolute path from installHook.mjs
//   - package.json          root manifest, trimmed to name/version/engines/
//                           dependencies (jimp) so `npm install --omit=dev`
//                           works standalone if the theme pipeline needs it
//   - README-STANDALONE.md  quick-start instructions for the zip
//
// Excluded: node_modules (see README-STANDALONE.md — run `npm install
// --omit=dev` after unzipping if theme image generation is needed),
// standalone/test, standalone/spike, .git, src/ (TS sources; out/ ships the
// compiled JS instead), test/, dist/.
//
// Usage: node scripts/package-standalone.mjs (run from repo root; requires
// `npm run build` to have produced out/ first — see docs/BUILDING.md).

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = rootPkg.version;
if (!version) {
  throw new Error('package.json has no version field');
}

if (!existsSync(join(ROOT, 'out', 'extension.js')) && !existsSync(join(ROOT, 'out', 'src'))) {
  throw new Error('out/ is missing or incomplete — run `npm run build` first (see docs/BUILDING.md).');
}

const stageDir = join(ROOT, 'dist', `.standalone-stage-${version}`);
const distDir = join(ROOT, 'dist');
const zipName = `tycoonagents-standalone-${version}.zip`;
const zipPath = join(distDir, zipName);

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
mkdirSync(distDir, { recursive: true });

function copy(src, dest, opts = {}) {
  cpSync(join(ROOT, src), join(stageDir, dest), { recursive: true, ...opts });
}

// out/ — compiled JS the standalone require()s at runtime.
copy('out', 'out');

// standalone/ — server/CLI sources + manifest + docs, no test/spike/node_modules.
mkdirSync(join(stageDir, 'standalone'), { recursive: true });
copy('standalone/src', 'standalone/src');
copy('standalone/package.json', 'standalone/package.json');
if (existsSync(join(ROOT, 'standalone/README.md'))) {
  copy('standalone/README.md', 'standalone/README.md');
}

// media/ — served in place, unmodified, by server.mjs.
copy('media', 'media');

// hooks/ — installHook.mjs references these by absolute path into the repo.
copy('hooks', 'hooks');

// Root package.json trimmed to what the standalone actually needs
// (name/version/engines + the jimp runtime dependency the theme pipeline
// require()s via out/src/extension/*). No devDependencies, no scripts that
// assume a full dev checkout.
// fflate is listed under root devDependencies but out/src/extension/themeArchive.js
// require()s it eagerly at server startup (theme export/import), so it must
// ship as a runtime dependency here even though it's dev-only at the repo root.
const RUNTIME_DEVDEPS = ['fflate'];
const trimmedPkg = {
  name: rootPkg.name,
  version: rootPkg.version,
  private: true,
  engines: rootPkg.engines,
  dependencies: {
    ...(rootPkg.dependencies || {}),
    ...Object.fromEntries(
      RUNTIME_DEVDEPS.filter((d) => rootPkg.devDependencies?.[d]).map((d) => [d, rootPkg.devDependencies[d]])
    ),
  },
};
writeFileSync(join(stageDir, 'package.json'), JSON.stringify(trimmedPkg, null, 2) + '\n');

// README-STANDALONE.md
const readme = `# TycoonAgents Standalone — ${version}

Run the TycoonAgents live agent visualization without VS Code.

## Where to install

Unzip this into its own permanent folder outside any project (for example a
tools folder) — one install then serves every project on the machine.
\`install-hook\` registers an absolute path to this folder's
\`hooks/tycoon-claude-hook.cjs\` in each project, so if you move or rename
the folder afterwards, run \`install-hook\` again in each project.

## Run it

\`\`\`sh
npm install --omit=dev   # required — the theme pipeline (jimp, fflate) loads at server startup
cd standalone
node src/cli.mjs install-hook <path-to-your-project>
node src/cli.mjs watch <path-to-your-project>
\`\`\`

This opens a browser tab serving the same panel as the VS Code extension.
Pass \`--no-open\` (or set \`TYCOON_STANDALONE_NO_OPEN=1\`) on a headless
machine. \`watch\` accepts several project paths at once. See
\`standalone/README.md\` in this zip for environment variables,
multi-directory watching, and the OpenCode provider flag.

## Requirements

- Node.js >= 18.
- No build step required — \`out/\` ships pre-compiled.
`;
writeFileSync(join(stageDir, 'README-STANDALONE.md'), readme);

// Zip it — pure Node via fflate, keyed by forward-slash relative paths so the
// archive is portable across Windows/macOS/Linux unzip tools (PowerShell's
// Compress-Archive writes backslash-separated entry names, which macOS
// Archive Utility and some Linux tools then extract as literal files named
// "a\b\c" instead of nested directories).
const STORE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.zip']);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, files);
    } else if (stat.isFile()) {
      files.push(full);
    }
  }
  return files;
}

rmSync(zipPath, { force: true });

const zipEntries = {};
for (const filePath of walk(stageDir)) {
  const relPath = relative(stageDir, filePath).split('\\').join('/');
  const data = readFileSync(filePath);
  const ext = extname(filePath).toLowerCase();
  zipEntries[relPath] = STORE_EXTS.has(ext) ? [data, { level: 0 }] : data;
}

const zipped = zipSync(zipEntries, { level: 6 });
writeFileSync(zipPath, zipped);

rmSync(stageDir, { recursive: true, force: true });
console.log(`Wrote ${zipPath}`);
