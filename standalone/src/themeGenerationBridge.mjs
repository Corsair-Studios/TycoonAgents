// TycoonAgents standalone — vscode-free bridge onto the REAL theme
// generation pipeline (project-plan task pC-t1 step 2, "wire the five theme
// generation messages into the standalone host").
//
// WHY THIS EXISTS: src/extension/themeService.ts is the single source of
// truth for theme generation (planTheme/generateTheme/retryThemeImage/
// resliceThemeImageFromRaw/normalizeThemeCharacterAtlas/...). Its compiled
// output (out/src/extension/themeService.js) became require()-able from a
// bare Node process as of pC-t1 step 1 (release 0.0.393) — themeService.ts no
// longer imports 'vscode' at load time; it reads/writes files exclusively
// through the vscode-free ThemeFileStore (src/extension/themeFileStore.ts,
// resolveThemeFileStore/configureThemeFileStore) and resolves API keys from
// the caller-supplied ThemeImageGenerationOptions instead of vscode.SecretStorage.
// So — UNLIKE themeMessages.mjs (pB-t1), which REIMPLEMENTS its four
// operations against the ThemeFileStore interface because themeService.ts
// used to be unrequireable — this module requires the REAL themeService.js
// directly. No duplicated generation logic exists anywhere in the standalone.
//
// Same lazy-createRequire posture as themeFileStoreFs.mjs / themeMessages.mjs
// (see their module headers): importing this .mjs file itself never touches
// 'out/' or throws — only calling one of the exported functions does, and
// only the FIRST call pays the require() cost. This keeps the module safe to
// import unconditionally from server.mjs even before `out/` has been built.
//
// Node built-ins only (node:fs, node:path, node:module, node:url). No
// 'vscode' import, direct or transitive — confirmed by this module never
// requiring anything outside out/src/extension/*.js, which pC-t1 step 1
// verified is vscode-free at load time.

import fsSync from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// standalone/src -> standalone -> repo root -> out/src/extension/*.js
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const THEME_SERVICE_JS = path.join(REPO_ROOT, 'out', 'src', 'extension', 'themeService.js');
const THEME_FILE_STORE_JS = path.join(REPO_ROOT, 'out', 'src', 'extension', 'themeFileStore.js');
const THEME_IMAGE_RETRY_JS = path.join(REPO_ROOT, 'out', 'src', 'extension', 'themeImageRetry.js');

const require = createRequire(import.meta.url);

function requireCompiled(modulePath, label) {
  if (!fsSync.existsSync(modulePath)) {
    throw new Error(
      `[tycoonagents-standalone] themeGenerationBridge: ${label} not found at ${modulePath}. The compiled ` +
        '`out/` directory is missing or stale — run `npx tsc -p .` from the repo root first, then restart the ' +
        'standalone server.',
    );
  }
  return require(modulePath);
}

let _themeServiceModule;
function themeServiceModule() {
  if (!_themeServiceModule) {
    _themeServiceModule = requireCompiled(THEME_SERVICE_JS, 'out/src/extension/themeService.js');
  }
  return _themeServiceModule;
}

let _themeFileStoreModule;
function themeFileStoreModule() {
  if (!_themeFileStoreModule) {
    _themeFileStoreModule = requireCompiled(THEME_FILE_STORE_JS, 'out/src/extension/themeFileStore.js');
  }
  return _themeFileStoreModule;
}

let _themeImageRetryModule;
function themeImageRetryModule() {
  if (!_themeImageRetryModule) {
    _themeImageRetryModule = requireCompiled(THEME_IMAGE_RETRY_JS, 'out/src/extension/themeImageRetry.js');
  }
  return _themeImageRetryModule;
}

/**
 * Injects `store` (an fs-backed ThemeFileStore — see themeFileStoreFs.mjs) as
 * the store every themeService.ts generation function below resolves via
 * `resolveThemeFileStore`, regardless of whatever `ThemeStorageRoot` value a
 * given call happens to pass positionally (that param is IGNORED once a
 * store has been configured — see themeFileStore.ts's resolveThemeFileStore
 * doc comment). Call this EXACTLY ONCE, at server startup, right after
 * server.mjs constructs its `themeStore`.
 */
export function configureThemeFileStore(store) {
  themeFileStoreModule().configureThemeFileStore(store);
}

// ── Generation entry points (out/src/extension/themeService.js) ───────────
// Every export below is a thin, lazily-bound pass-through — see this
// module's header for why calling one of these on the standalone path never
// touches 'vscode': themeService.ts resolves its store via
// resolveThemeFileStore (vscode-free) and its API key via the caller-passed
// ThemeImageGenerationOptions (never vscode.SecretStorage) once a store has
// been configured via configureThemeFileStore above.

export function planTheme(prompt, imageGenerationOptions) {
  return themeServiceModule().planTheme(prompt, imageGenerationOptions);
}

export function generateTheme(
  storageRoot,
  requestedPlan,
  onProgress,
  isCancelled,
  onReviewReady,
  imageGenerationOptions,
  waitForReview,
) {
  return themeServiceModule().generateTheme(
    storageRoot,
    requestedPlan,
    onProgress,
    isCancelled,
    onReviewReady,
    imageGenerationOptions,
    waitForReview,
  );
}

export function resumeThemeGeneration(
  storageRoot,
  themeId,
  onProgress,
  isCancelled,
  onReviewReady,
  imageGenerationOptions,
  waitForReview,
) {
  return themeServiceModule().resumeThemeGeneration(
    storageRoot,
    themeId,
    onProgress,
    isCancelled,
    onReviewReady,
    imageGenerationOptions,
    waitForReview,
  );
}

export function retryThemeImage(storageRoot, themeId, itemId, feedback, mode, imageGenerationOptions, onProgress) {
  return themeServiceModule().retryThemeImage(
    storageRoot,
    themeId,
    itemId,
    feedback,
    mode,
    imageGenerationOptions,
    onProgress,
  );
}

export function resliceThemeImageFromRaw(storageRoot, themeId, itemId) {
  return themeServiceModule().resliceThemeImageFromRaw(storageRoot, themeId, itemId);
}

export function normalizeThemeCharacterAtlas(storageRoot, themeId, itemId, imageGenerationOptions, onProgress) {
  return themeServiceModule().normalizeThemeCharacterAtlas(
    storageRoot,
    themeId,
    itemId,
    imageGenerationOptions,
    onProgress,
  );
}

export function updateThemeImageReviewStatus(storageRoot, themeId, itemId, status) {
  return themeServiceModule().updateThemeImageReviewStatus(storageRoot, themeId, itemId, status);
}

export function renameThemeCharacter(storageRoot, themeId, itemId, requestedName) {
  return themeServiceModule().renameThemeCharacter(storageRoot, themeId, itemId, requestedName);
}

// ── Review-EDITOR + recovery entry points (project-plan task pC-t2) ────────
// Same thin lazily-bound pass-through posture as every export above — these
// back panel.ts's SET_THEME_ITEM_NAMES / SET_THEME_ITEM_DESCRIPTIONS /
// SET_THEME_CREATIVE_DIRECTION / APPROVE_ALL_THEME_IMAGES handlers (see
// standalone/src/themeGenerationMessages.mjs for the callers that mirror
// panel.ts's exact outbound wire shapes).

/** Batched rename from the theme review screen's "Names" editor. `changes`
 * is an array of `{ item_kind, id, name }` rows. */
export function renameThemeItemsBatch(storageRoot, themeId, changes) {
  return themeServiceModule().renameThemeItemsBatch(storageRoot, themeId, changes);
}

/** Batched description edit from the theme review screen's "Descriptions"
 * editor. `changes` is an array of `{ item_kind, id, description }` rows —
 * item_kind includes 'projectile' (single plan field, no manifest lookup). */
export function updateThemeItemDescriptionsBatch(storageRoot, themeId, changes) {
  return themeServiceModule().updateThemeItemDescriptionsBatch(storageRoot, themeId, changes);
}

/** Post-generation Creative Direction editor — overwrites plan.creative_direction. */
export function updateThemeCreativeDirection(storageRoot, themeId, creativeDirection) {
  return themeServiceModule().updateThemeCreativeDirection(storageRoot, themeId, creativeDirection);
}

/** Approves every reviewable image at once; throws if any image is still missing. */
export function approveAllThemeImages(storageRoot, themeId) {
  return themeServiceModule().approveAllThemeImages(storageRoot, themeId);
}

/** Pure text helper (no store, no I/O) — see panel.ts's RETRY_THEME_IMAGE
 * handler for the same call, guarding against a pasted full generation
 * prompt landing in the retry-notes box for 'augment'/'replace' modes. */
export function sanitizeRetryNotes(notes) {
  return themeImageRetryModule().sanitizeRetryNotes(notes);
}
