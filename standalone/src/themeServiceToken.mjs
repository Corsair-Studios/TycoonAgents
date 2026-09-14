// TycoonAgents standalone — device token store for the Corsair Theme Service
// client (src/core/themeServiceClient.ts's ThemeServiceTokenStore contract).
//
// Reuses src/core/localEnvStore.ts's compiled output (out/src/core/localEnvStore.js)
// for the actual read/write/clear + owner-only permission logic, the same
// requireCompiled-from-out/ bridge pattern standalone/src/sharedLogic.mjs
// uses for state.js etc. — no permission logic is forked here. The token is
// stored under the name THEME_SERVICE_DEVICE_TOKEN in the shared per-user
// app-data secrets/ directory (never in a project file, message payload, or
// log).
//
// Node built-ins only.

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// standalone/src -> standalone -> repo root -> out/src/core/localEnvStore.js
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOCAL_ENV_STORE_JS = path.join(REPO_ROOT, 'out', 'src', 'core', 'localEnvStore.js');

const require = createRequire(import.meta.url);

let _localEnvStoreModule;
function localEnvStoreModule() {
  if (!_localEnvStoreModule) {
    if (!fs.existsSync(LOCAL_ENV_STORE_JS)) {
      throw new Error(
        `[tycoonagents-standalone] themeServiceToken: out/src/core/localEnvStore.js not found at ${LOCAL_ENV_STORE_JS}. ` +
          'The compiled `out/` directory is missing or stale — run `npx tsc -p .` from the repo root first, ' +
          'then restart the standalone server.',
      );
    }
    _localEnvStoreModule = require(LOCAL_ENV_STORE_JS);
  }
  return _localEnvStoreModule;
}

export const THEME_SERVICE_TOKEN_NAME = 'THEME_SERVICE_DEVICE_TOKEN';

/**
 * @param {{ appDataDir?: string }} [options]
 * @returns {import('../../src/core/themeServiceClient').ThemeServiceTokenStore}
 */
export function createStandaloneThemeServiceTokenStore(options = {}) {
  const { getValue, setValue, clearValue } = localEnvStoreModule();
  /** @type {import('../../src/core/localEnvStore').LocalEnvStoreOptions} */
  const storeOpts = options.appDataDir
    ? { env: { ...process.env, TYCOON_STANDALONE_DATA_DIR: options.appDataDir } }
    : {};

  return {
    async get() {
      const value = getValue(THEME_SERVICE_TOKEN_NAME, storeOpts);
      return value === undefined ? null : value;
    },
    async set(token) {
      setValue(THEME_SERVICE_TOKEN_NAME, token, storeOpts);
    },
    async clear() {
      clearValue(THEME_SERVICE_TOKEN_NAME, storeOpts);
    },
  };
}
