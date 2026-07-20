// TycoonAgents standalone — theme export/import bridge (project-plan task
// pB-t2, "Standalone theme host: export/import").
//
// WHY THIS FILE EXISTS: src/extension/themeService.ts (and its siblings)
// `import * as vscode from 'vscode'` at module load time, so `require()`ing
// their COMPILED out/ JS from this vscode-less process throws immediately —
// see themeFileStoreFs.mjs's module header for the same constraint on the
// file storage layer. src/extension/themeArchiveOps.ts is the vscode-free
// extraction of the export/import LOGIC (moved out of themeService.ts) that
// both this bridge and the real extension call — no zip/archive logic is
// duplicated here, only lazily `require()`d via the same createRequire
// pattern themeFileStoreFs.mjs and themeMessages.mjs already established.
//
// Node built-ins only. No vscode import, direct or transitive.

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fsSync from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// standalone/src -> standalone -> repo root -> out/src/extension/themeArchiveOps.js
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const THEME_ARCHIVE_OPS_JS = path.join(REPO_ROOT, 'out', 'src', 'extension', 'themeArchiveOps.js');

const require = createRequire(import.meta.url);

let _themeArchiveOpsModule;
function themeArchiveOpsModule() {
  if (!_themeArchiveOpsModule) {
    if (!fsSync.existsSync(THEME_ARCHIVE_OPS_JS)) {
      throw new Error(
        `[tycoonagents-standalone] themeArchive: out/src/extension/themeArchiveOps.js not found at ` +
          `${THEME_ARCHIVE_OPS_JS}. The compiled \`out/\` directory is missing or stale — run \`npx tsc -p .\` ` +
          'from the repo root first, then restart the standalone server.',
      );
    }
    _themeArchiveOpsModule = require(THEME_ARCHIVE_OPS_JS);
  }
  return _themeArchiveOpsModule;
}

/**
 * Package a saved theme and all of its retained assets into a portable zip.
 * Mirrors src/extension/themeService.ts's exportThemeArchive() exactly (same
 * underlying themeArchiveOps.ts logic), including the 0.0.371 `images/raw/`
 * exclusion and the export-readiness (all-images-approved) gate.
 *
 * @param {import('../../src/extension/themeFileStore').ThemeFileStore} store
 * @param {string} themeId
 * @returns {Promise<Uint8Array>}
 */
export async function exportThemeArchiveFromStore(store, themeId) {
  return themeArchiveOpsModule().exportThemeArchiveFromStore(store, themeId);
}

/**
 * Validate and install a theme archive. Existing themes require explicit
 * replacement. Mirrors src/extension/themeService.ts's importThemeArchive()
 * exactly (same underlying themeArchiveOps.ts logic).
 *
 * @param {import('../../src/extension/themeFileStore').ThemeFileStore} store
 * @param {Uint8Array} data
 * @param {boolean} [replace]
 * @returns {Promise<{ theme_id: string, display_name: string, replaced: boolean }>}
 */
export async function importThemeArchiveToStore(store, data, replace = false) {
  return themeArchiveOpsModule().importThemeArchiveToStore(store, data, replace);
}
