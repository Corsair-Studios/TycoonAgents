// TycoonAgents standalone — theme GENERATION message handlers (project-plan
// task pC-t1 step 2: "wire the five theme generation messages into the
// standalone host so it drives the real extension generation pipeline").
//
// Routes PLAN_THEME / GENERATE_THEME / RETRY_THEME_IMAGE / RESLICE_THEME_IMAGE
// / NORMALIZE_THEME_CHARACTER against the REAL themeService.ts generation
// functions via themeGenerationBridge.mjs (require()d from the compiled
// out/src/extension/themeService.js — see that bridge's module header for
// why this is safe with zero 'vscode' on the standalone path, UNLIKE
// themeMessages.mjs's pB-t1 handlers, which reimplement their four
// operations because themeService.ts used to be unrequireable).
//
// Each handler replicates EXACTLY what src/host/vscode/panel.ts's matching
// `message.type === MSG.*` branch posts back to the webview (same outbound
// wire message types/shapes — media/main.js is unmodified and already
// listens for these), substituting broadcast('message', {type, payload})
// (SSE -> every connected browser tab) for panel.ts's
// `this._panel.webview.postMessage(...)`.
//
// GATE STATE (mirrors panel.ts's TycoonPanel instance fields, but
// module-level here since one standalone process serves one active
// generation at a time — same one-generation-at-a-time invariant panel.ts
// enforces per-webview-instance):
//   themeGenerationActive / themeGenerationAbortController /
//   themeGenerationGateRetryActive / themePauseForReview /
//   themeGenerationReviewGate — see _waitForThemeImageAcceptance in panel.ts
//   for the authoritative version this module's waitForThemeImageAcceptance
//   mirrors line-for-line.
//
// MINIMAL SUPPORT MESSAGES (SET_THEME_IMAGE_REVIEW_STATUS /
// SET_THEME_PAUSE_FOR_REVIEW / CANCEL_THEME_GENERATION): these are NOT among
// the five primary generation messages this task was scoped to wire, but are
// included here because GENERATE_THEME's pause-for-review gate — the
// DEFAULT state of the unmodified UI's "Pause after each image for
// approval" checkbox (media/main.js's #theme-pause-for-review, checked by
// default) — would otherwise never resolve: the webview's existing "Keep"
// button (media/main.js ~line 3960) already posts SET_THEME_IMAGE_REVIEW_STATUS
// unconditionally, with no standalone-specific gate. Without a handler for
// it, a default-settings GENERATE_THEME call would hang forever after its
// first review item. Each of these three is a thin, low-risk addition that
// reuses the same already-required bridge — no new generation logic.
//
// Node built-ins only. No 'vscode' import, direct or transitive (see
// themeGenerationBridge.mjs's header for the load-time guarantee this relies
// on).

import fsSync from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as genBridge from './themeGenerationBridge.mjs';
import { MSG_WIRE, handleGetThemeImageReview, listThemesFromStore } from './themeMessages.mjs';

// ── imageModels.ts bridge (out/src/extension/imageModels.js) ───────────────
// Same lazy-createRequire posture as themeGenerationBridge.mjs/server.mjs's
// imageModelsModule() (see their module headers): this module never touches
// 'out/' at import time, only the first call that actually needs
// resolveImageQuality() pays the require() cost. Reused here (rather than
// reimplementing the low/medium/high allowlist) so buildImageOptions()'s
// quality validation can never drift from imageClient.ts's
// generateThemeImage()/resolveImageQuality() — the same function the VS Code
// extension host calls.
const __themeGenMsgFilename = fileURLToPath(import.meta.url);
const __themeGenMsgDirname = path.dirname(__themeGenMsgFilename);
const REPO_ROOT = path.resolve(__themeGenMsgDirname, '..', '..');
const IMAGE_MODELS_JS = path.join(REPO_ROOT, 'out', 'src', 'extension', 'imageModels.js');
const requireCompiledModule = createRequire(import.meta.url);

let _imageModelsModule;
function imageModelsModule() {
  if (!_imageModelsModule) {
    if (!fsSync.existsSync(IMAGE_MODELS_JS)) {
      throw new Error(
        `[tycoonagents-standalone] themeGenerationMessages: out/src/extension/imageModels.js not found at ${IMAGE_MODELS_JS}. ` +
          'The compiled `out/` directory is missing or stale — run `npx tsc -p .` from the repo root first, then ' +
          'restart the standalone server.',
      );
    }
    _imageModelsModule = requireCompiledModule(IMAGE_MODELS_JS);
  }
  return _imageModelsModule;
}

// ── Module-level generation state (single in-flight generation, mirrors
// panel.ts's per-panel-instance fields — see module header) ────────────────
let themeGenerationActive = false;
let themeGenerationAbortController;
let themeGenerationGateRetryActive = false;
let themePauseForReview = true;
/** @type {{
 *   themeId: string,
 *   itemId: string,
 *   requiresReplacement: boolean,
 *   generatedReplacementReady: boolean,
 *   replacement?: { manifest: object, frames: Record<string, string[]> },
 *   accept(): void,
 *   cancel(): void,
 * } | undefined} */
let themeGenerationReviewGate;

/** Mirrors panel.ts's `_buildThemeInitPayload` — same simplification as
 * themeMessages.mjs's handleSelectTheme: no per-theme badge/rebirth/
 * build-progress persistence in the standalone yet, so these always report
 * the safe defaults (see that module's header for the full rationale). */
function buildThemeInitPayload(manifest, frames, isEditorMode) {
  return {
    manifest,
    frames,
    is_editor_mode: isEditorMode,
    unlocked_badge_ids: [],
    rebirth_state: null,
    savedBuildProgress: 0,
  };
}

/**
 * Translates server.mjs's getThemeImageConfig() output
 * (`{ provider, openaiApiKey, geminiApiKey }`, matching imageClient.ts's
 * `ThemeImageConfig`) into the shape themeService.ts's generation functions
 * actually accept (`ThemeImageGenerationOptions`: `{ provider, apiKey, ... }`
 * — see src/extension/imageClient.ts). This is the wire-shape ambiguity the
 * task brief flagged: panel.ts never passes ThemeImageConfig directly either
 * — it resolves a single provider+apiKey pair via resolveThemeImageSettings
 * first. `requestedProvider` (a message payload's optional `image_provider`
 * field) overrides the configured default, same as panel.ts's
 * `resolveThemeImageSettings(secrets, payload?.image_provider)`.
 *
 * Also resolves the OpenAI-only `quality` field (mirrors panel.ts's
 * `resolveThemeImageSettings()` -> `imageOptions.quality = imageSettings.quality`
 * — see src/host/vscode/panel.ts's GENERATE_THEME branch): 'low' | 'medium' |
 * 'high', validated via the same resolveImageQuality() the extension uses
 * (never reimplemented), and left `undefined` for 'gemini' since Gemini has
 * no `quality` parameter and must never receive one.
 *
 * @param {() => { provider: 'openai'|'gemini', openaiApiKey?: string, geminiApiKey?: string, openaiQuality?: string }} getThemeImageConfig
 * @param {unknown} requestedProvider
 * @param {object} [extra] merged in last (e.g. `{ signal }`)
 */
function buildImageOptions(getThemeImageConfig, requestedProvider, extra = {}) {
  const config = getThemeImageConfig();
  const provider = requestedProvider === 'gemini' || requestedProvider === 'openai' ? requestedProvider : config.provider;
  const apiKey = provider === 'gemini' ? config.geminiApiKey : config.openaiApiKey;
  const quality = provider === 'openai' ? imageModelsModule().resolveImageQuality(config.openaiQuality) : undefined;
  return { provider, apiKey, quality, ...extra };
}

function requireApiKey(imageOptions) {
  if (imageOptions.apiKey) return;
  const label = imageOptions.provider === 'openai' ? 'OpenAI' : 'Google Gemini';
  throw new Error(
    `No ${label} API key found. Set TYCOON_OPENAI_API_KEY or TYCOON_GEMINI_API_KEY in the standalone's ` +
      'environment (see README.md).',
  );
}

/** Mirrors panel.ts's `_waitForThemeImageAcceptance` exactly (same
 * gate/accept/cancel mechanics), substituting nothing host-specific — the
 * gate itself has no vscode dependency in panel.ts either. */
function waitForThemeImageAcceptance(themeId, itemId, signal, options) {
  if (themeGenerationReviewGate) themeGenerationReviewGate.cancel();
  if (signal.aborted) return Promise.reject(new Error('Generation cancelled by user'));

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener('abort', cancel);
      if (themeGenerationReviewGate === gate) themeGenerationReviewGate = undefined;
      return true;
    };
    const accept = () => {
      if (gate.requiresReplacement && !gate.generatedReplacementReady) return;
      if (cleanup()) resolve(gate.replacement);
    };
    const cancel = () => {
      if (cleanup()) reject(new Error('Generation cancelled by user'));
    };
    const gate = {
      themeId,
      itemId,
      requiresReplacement: Boolean(options?.requiresReplacement),
      generatedReplacementReady: false,
      accept,
      cancel,
    };
    themeGenerationReviewGate = gate;
    signal.addEventListener('abort', cancel, { once: true });
  });
}

// ── PLAN_THEME -> THEME_PLAN_READY | THEME_PLAN_ERROR ──────────────────────
// Mirrors panel.ts's MSG.PLAN_THEME branch.
export async function handlePlanTheme(store, broadcast, getThemeImageConfig, payload) {
  try {
    if (themeGenerationActive) {
      throw new Error('Wait for the current theme generation to finish before planning another theme.');
    }
    const prompt = (payload?.prompt ?? '').trim();
    if (!prompt) throw new Error('Enter a theme name or description first.');
    const imageOptions = buildImageOptions(getThemeImageConfig, payload?.image_provider);
    requireApiKey(imageOptions);
    const plan = await genBridge.planTheme(prompt, imageOptions);
    broadcast('message', { type: MSG_WIRE.THEME_PLAN_READY, payload: { plan } });
  } catch (err) {
    broadcast('message', { type: MSG_WIRE.THEME_PLAN_ERROR, payload: { message: String(err) } });
  }
}

// ── GENERATE_THEME -> THEME_GENERATION_PROGRESS* / THEME_REVIEW_READY* /
//    THEME_INITIALIZED | THEME_GENERATION_CANCELLED | THEME_GENERATION_ERROR
// Mirrors panel.ts's MSG.GENERATE_THEME branch, including the resume_theme_id
// path (resumeThemeGeneration) and the pause-for-review waitForReview gate.
// Fire-and-forget from the caller's perspective — server.mjs's dispatcher
// already `.catch()`s this the same way it does every other handler, and
// every intermediate step streams over SSE via broadcast() rather than
// blocking the POST /message response.
export async function handleGenerateTheme(store, broadcast, getThemeImageConfig, payload) {
  if (themeGenerationActive) {
    broadcast('message', {
      type: MSG_WIRE.THEME_GENERATION_ERROR,
      payload: { message: 'A theme generation is already running.' },
    });
    return;
  }
  let generatedThemeId = '';
  const abortController = new AbortController();
  themeGenerationAbortController = abortController;
  themeGenerationActive = true;
  try {
    const resumeThemeId = payload?.resume_theme_id ?? '';
    const plan = payload?.plan;
    if (!plan && !resumeThemeId) {
      throw new Error('Create and review the theme plan before generating images.');
    }
    if (resumeThemeId) generatedThemeId = resumeThemeId;
    themePauseForReview = payload?.pause_for_review !== false;
    const imageOptions = buildImageOptions(getThemeImageConfig, payload?.image_provider, {
      signal: abortController.signal,
    });
    requireApiKey(imageOptions);

    const onProgress = (msg) =>
      broadcast('message', { type: MSG_WIRE.THEME_GENERATION_PROGRESS, payload: { message: msg } });
    const onReviewReady = (themeId) => {
      generatedThemeId = themeId;
      broadcast('message', { type: MSG_WIRE.THEME_REVIEW_READY, payload: { theme_id: themeId } });
    };
    const waitForReview = async (themeId, itemId, reviewOptions) =>
      themePauseForReview || reviewOptions?.requiresReplacement
        ? waitForThemeImageAcceptance(themeId, itemId, abortController.signal, reviewOptions)
        : undefined;

    const r = resumeThemeId
      ? await genBridge.resumeThemeGeneration(
          store,
          resumeThemeId,
          onProgress,
          () => abortController.signal.aborted,
          onReviewReady,
          imageOptions,
          waitForReview,
        )
      : await genBridge.generateTheme(
          store,
          plan,
          onProgress,
          () => abortController.signal.aborted,
          onReviewReady,
          imageOptions,
          waitForReview,
        );
    broadcast('message', {
      type: MSG_WIRE.THEME_INITIALIZED,
      payload: buildThemeInitPayload(r.manifest, r.frames, true),
    });
  } catch (err) {
    if (abortController.signal.aborted) {
      broadcast('message', {
        type: MSG_WIRE.THEME_GENERATION_CANCELLED,
        payload: {
          theme_id: generatedThemeId,
          message: "Generation stopped. Completed images were retained; resume whenever you're ready.",
        },
      });
    } else {
      broadcast('message', { type: MSG_WIRE.THEME_GENERATION_ERROR, payload: { message: String(err) } });
    }
  } finally {
    themeGenerationActive = false;
    themeGenerationGateRetryActive = false;
    if (themeGenerationAbortController === abortController) themeGenerationAbortController = undefined;
    if (generatedThemeId) await handleGetThemeImageReview(store, broadcast, generatedThemeId);
  }
}

// ── RETRY_THEME_IMAGE -> THEME_IMAGE_RETRY_STATE* / THEME_IMAGE_REVIEW /
//    THEME_INITIALIZED
// Mirrors panel.ts's MSG.RETRY_THEME_IMAGE branch, including the
// optional character_name rename and the retry-during-active-generation gate
// interplay (replacement / generatedReplacementReady / auto-accept when
// pause-for-review is off).
export async function handleRetryThemeImage(store, broadcast, getThemeImageConfig, payload) {
  const themeId = payload?.theme_id ?? '';
  const itemId = payload?.item_id ?? '';
  if (!/^[a-z0-9_]+$/.test(themeId) || !/^[a-z0-9_-]+$/.test(itemId)) return;

  const activeGate = themeGenerationReviewGate;
  const retryingDuringActiveGeneration =
    themeGenerationActive && activeGate?.themeId === themeId && activeGate.itemId === itemId;
  if (themeGenerationActive && !retryingDuringActiveGeneration) {
    broadcast('message', {
      type: MSG_WIRE.THEME_IMAGE_RETRY_STATE,
      payload: {
        item_id: itemId,
        error: 'Wait until this image reaches the review step before generating a replacement.',
      },
    });
    return;
  }
  if (retryingDuringActiveGeneration && themeGenerationGateRetryActive) return;
  if (retryingDuringActiveGeneration) themeGenerationGateRetryActive = true;

  try {
    const imageOptions = buildImageOptions(getThemeImageConfig, payload?.image_provider, {
      signal: retryingDuringActiveGeneration ? themeGenerationAbortController?.signal : undefined,
    });
    requireApiKey(imageOptions);

    const retryMode =
      payload?.mode === 'replace'
        ? 'replace'
        : payload?.mode === 'retry'
          ? 'retry'
          : payload?.mode === 'custom'
            ? 'custom'
            : 'augment';

    let retryFeedback = payload?.feedback ?? '';
    let retryNotesTrimmed = false;
    if (retryMode === 'custom') {
      if (!retryFeedback.trim()) throw new Error('Custom mode needs a prompt.');
    } else if (retryMode !== 'retry') {
      const sanitized = genBridge.sanitizeRetryNotes(payload?.feedback ?? '');
      retryFeedback = sanitized.notes;
      retryNotesTrimmed = sanitized.trimmed;
    }

    broadcast('message', {
      type: MSG_WIRE.THEME_IMAGE_RETRY_STATE,
      payload: {
        item_id: itemId,
        busy: true,
        message: 'Generating replacement...',
        ...(retryNotesTrimmed
          ? {
              warning:
                'Your notes looked like a full prompt — only the creative-direction section was used. ' +
                "Row items come from the theme's object list.",
            }
          : {}),
      },
    });

    if (payload?.character_name?.trim()) {
      const renamed = await genBridge.renameThemeCharacter(store, themeId, itemId, payload.character_name);
      if (retryingDuringActiveGeneration && themeGenerationReviewGate?.themeId === themeId) {
        themeGenerationReviewGate.replacement = renamed;
      }
    }

    const result = await genBridge.retryThemeImage(
      store,
      themeId,
      itemId,
      retryFeedback,
      retryMode,
      imageOptions,
      (msg) =>
        broadcast('message', {
          type: MSG_WIRE.THEME_IMAGE_RETRY_STATE,
          payload: { item_id: itemId, busy: true, message: msg },
        }),
    );

    if (retryingDuringActiveGeneration && themeGenerationReviewGate?.themeId === themeId) {
      themeGenerationReviewGate.replacement = result;
      if (themeGenerationReviewGate.itemId === itemId) {
        themeGenerationReviewGate.generatedReplacementReady = true;
      }
    }
    await handleGetThemeImageReview(store, broadcast, themeId);
    broadcast('message', {
      type: MSG_WIRE.THEME_IMAGE_RETRY_STATE,
      payload: { item_id: itemId, busy: false, message: 'Replacement ready for review.' },
    });
    if (!retryingDuringActiveGeneration) {
      broadcast('message', {
        type: MSG_WIRE.THEME_INITIALIZED,
        payload: buildThemeInitPayload(result.manifest, result.frames, true),
      });
    }
  } catch (err) {
    await handleGetThemeImageReview(store, broadcast, themeId);
    broadcast('message', {
      type: MSG_WIRE.THEME_IMAGE_RETRY_STATE,
      payload: { item_id: itemId, busy: false, error: String(err?.message ?? err) },
    });
  } finally {
    if (retryingDuringActiveGeneration) {
      themeGenerationGateRetryActive = false;
      if (!themePauseForReview && themeGenerationReviewGate?.themeId === themeId) {
        themeGenerationReviewGate.accept();
      }
    }
  }
}

// ── RESLICE_THEME_IMAGE -> THEME_IMAGE_RETRY_STATE* / THEME_IMAGE_REVIEW /
//    THEME_INITIALIZED
// Mirrors panel.ts's MSG.RESLICE_THEME_IMAGE branch. No image API call (pure
// re-slice from the stored raw atlas), so no imageGenerationOptions needed.
export async function handleResliceThemeImage(store, broadcast, payload) {
  const themeId = payload?.theme_id ?? '';
  const itemId = payload?.item_id ?? '';
  if (!/^[a-z0-9_]+$/.test(themeId) || !/^[a-z0-9_-]+$/.test(itemId)) return;

  if (themeGenerationActive) {
    broadcast('message', {
      type: MSG_WIRE.THEME_IMAGE_RETRY_STATE,
      payload: { item_id: itemId, error: 'Wait until theme generation finishes before re-slicing a board.' },
    });
    return;
  }

  try {
    broadcast('message', {
      type: MSG_WIRE.THEME_IMAGE_RETRY_STATE,
      payload: { item_id: itemId, busy: true, message: 'Re-slicing from saved original...' },
    });
    const result = await genBridge.resliceThemeImageFromRaw(store, themeId, itemId);
    if (!result.ok) {
      await handleGetThemeImageReview(store, broadcast, themeId);
      broadcast('message', {
        type: MSG_WIRE.THEME_IMAGE_RETRY_STATE,
        payload: { item_id: itemId, busy: false, error: result.reason },
      });
    } else {
      await handleGetThemeImageReview(store, broadcast, themeId);
      broadcast('message', {
        type: MSG_WIRE.THEME_IMAGE_RETRY_STATE,
        payload: { item_id: itemId, busy: false, message: 'Re-sliced and ready for review.' },
      });
      broadcast('message', {
        type: MSG_WIRE.THEME_INITIALIZED,
        payload: buildThemeInitPayload(result.manifest, result.frames, true),
      });
    }
  } catch (err) {
    await handleGetThemeImageReview(store, broadcast, themeId);
    broadcast('message', {
      type: MSG_WIRE.THEME_IMAGE_RETRY_STATE,
      payload: { item_id: itemId, busy: false, error: String(err?.message ?? err) },
    });
  }
}

// ── NORMALIZE_THEME_CHARACTER -> THEME_CHARACTER_NORMALIZE_STATE* /
//    THEME_IMAGE_REVIEW / THEME_INITIALIZED
// Mirrors panel.ts's MSG.NORMALIZE_THEME_CHARACTER branch.
export async function handleNormalizeThemeCharacter(store, broadcast, getThemeImageConfig, payload) {
  const themeId = payload?.theme_id ?? '';
  const itemId = payload?.item_id ?? '';
  if (!/^[a-z0-9_]+$/.test(themeId) || !/^[a-z0-9_-]+$/.test(itemId)) return;

  const activeGate = themeGenerationReviewGate;
  const normalizingDuringActiveGeneration =
    themeGenerationActive && activeGate?.themeId === themeId && activeGate.itemId === itemId;
  if (themeGenerationActive && !normalizingDuringActiveGeneration) {
    broadcast('message', {
      type: MSG_WIRE.THEME_CHARACTER_NORMALIZE_STATE,
      payload: {
        item_id: itemId,
        error: 'Only the character currently waiting for review can be normalized.',
      },
    });
    return;
  }
  if (normalizingDuringActiveGeneration && themeGenerationGateRetryActive) return;
  if (normalizingDuringActiveGeneration) themeGenerationGateRetryActive = true;

  try {
    const imageOptions = buildImageOptions(getThemeImageConfig, payload?.image_provider, {
      signal: normalizingDuringActiveGeneration ? themeGenerationAbortController?.signal : undefined,
    });
    if (!imageOptions.apiKey) throw new Error('The selected image provider has no saved API key.');

    broadcast('message', {
      type: MSG_WIRE.THEME_CHARACTER_NORMALIZE_STATE,
      payload: { item_id: itemId, busy: true, message: 'Regenerating at the standard character scale...' },
    });
    const result = await genBridge.normalizeThemeCharacterAtlas(store, themeId, itemId, imageOptions, (msg) =>
      broadcast('message', {
        type: MSG_WIRE.THEME_CHARACTER_NORMALIZE_STATE,
        payload: { item_id: itemId, busy: true, message: msg },
      }),
    );
    if (
      normalizingDuringActiveGeneration &&
      themeGenerationReviewGate?.themeId === themeId &&
      themeGenerationReviewGate.itemId === itemId
    ) {
      themeGenerationReviewGate.replacement = result;
      themeGenerationReviewGate.generatedReplacementReady = true;
    }
    await handleGetThemeImageReview(store, broadcast, themeId);
    broadcast('message', {
      type: MSG_WIRE.THEME_CHARACTER_NORMALIZE_STATE,
      payload: { item_id: itemId, busy: false, message: 'Regenerated and normalized character ready for review.' },
    });
    if (!normalizingDuringActiveGeneration) {
      broadcast('message', {
        type: MSG_WIRE.THEME_INITIALIZED,
        payload: buildThemeInitPayload(result.manifest, result.frames, true),
      });
    }
  } catch (err) {
    await handleGetThemeImageReview(store, broadcast, themeId);
    broadcast('message', {
      type: MSG_WIRE.THEME_CHARACTER_NORMALIZE_STATE,
      payload: { item_id: itemId, busy: false, error: String(err?.message ?? err) },
    });
  } finally {
    if (normalizingDuringActiveGeneration) themeGenerationGateRetryActive = false;
  }
}

// ── Minimal support handlers (see module header) ────────────────────────

/** Mirrors panel.ts's MSG.SET_THEME_IMAGE_REVIEW_STATUS branch — the
 * existing "Keep" button in media/main.js already posts this unconditionally
 * (it predates this task and is not itself one of the 5 generation
 * messages), so it must resolve the review gate the same way panel.ts does
 * or a default (pause-for-review=true) GENERATE_THEME can never advance. */
export async function handleSetThemeImageReviewStatus(store, broadcast, payload) {
  const themeId = payload?.theme_id ?? '';
  const itemId = payload?.item_id ?? '';
  const status = payload?.status;
  if (!/^[a-z0-9_]+$/.test(themeId) || !/^[a-z0-9_-]+$/.test(itemId)) return;
  if (status !== 'accepted' && status !== 'rejected' && status !== 'pending') return;

  const gate = themeGenerationReviewGate;
  const isCurrentGate = gate?.themeId === themeId && gate.itemId === itemId;
  if (isCurrentGate && themeGenerationGateRetryActive) {
    broadcast('message', {
      type: MSG_WIRE.THEME_IMAGE_RETRY_STATE,
      payload: { item_id: itemId, busy: true, message: 'Wait for the replacement to finish before keeping it.' },
    });
    return;
  }
  const document = await genBridge.updateThemeImageReviewStatus(store, themeId, itemId, status);
  if (document && status === 'accepted' && isCurrentGate) gate.accept();
  await handleGetThemeImageReview(store, broadcast, themeId);
}

/** Mirrors panel.ts's MSG.SET_THEME_PAUSE_FOR_REVIEW branch. */
export function handleSetThemePauseForReview(payload) {
  if (typeof payload?.pause_for_review !== 'boolean') return;
  themePauseForReview = payload.pause_for_review;
  if (!themePauseForReview && themeGenerationReviewGate && !themeGenerationGateRetryActive) {
    themeGenerationReviewGate.accept();
  }
}

/** Mirrors panel.ts's MSG.CANCEL_THEME_GENERATION branch. */
export function handleCancelThemeGeneration(broadcast) {
  const controller = themeGenerationAbortController;
  if (themeGenerationActive && controller && !controller.signal.aborted) {
    controller.abort();
    broadcast('message', { type: MSG_WIRE.THEME_GENERATION_PROGRESS, payload: { message: 'Stopping generation...' } });
  }
}

// ── Theme review-EDITOR handlers (project-plan task pC-t2) ─────────────────
// Each mirrors panel.ts's matching `message.type === MSG.*` branch EXACTLY —
// same themeService.ts call, same outbound wire message type(s)/shape(s) —
// substituting broadcast('message', {...}) for
// `this._panel.webview.postMessage(...)`. RENAME_THEME_CHARACTER reuses this
// module's existing gate state (themeGenerationActive/
// themeGenerationReviewGate/themeGenerationGateRetryActive — see the module
// header) the same way handleRetryThemeImage/handleNormalizeThemeCharacter
// already do, since a rename can also target the character currently
// waiting for review during an active generation.
// RESTORE_PLAN_BACKUP is NOT here — despite being grouped with these as a
// "recovery" message in the task brief, it is the unrelated Project Plan
// (phase/task) feature's MSG.RESTORE_PLAN_BACKUP (confirmed by reading
// panel.ts: it operates on `.claude/tycoon/plan.json`/`.bak` via
// projectPlanFilePath/projectPlanBackupFilePath, not on any theme's
// plan.json under the theme store) — see standalone/src/projectPlanMessages.mjs.

/** Mirrors panel.ts's MSG.SET_THEME_ITEM_NAMES branch. */
export async function handleSetThemeItemNames(store, broadcast, payload) {
  const themeId = payload?.theme_id ?? '';
  const boardId = payload?.board_id ?? '';
  if (!/^[a-z0-9_]+$/.test(themeId)) return;
  const changes = Array.isArray(payload?.changes) ? payload.changes : [];
  try {
    const { manifest, frames, result } = await genBridge.renameThemeItemsBatch(store, themeId, changes);
    if (result.applied.length) {
      // renameThemeItemsBatch also resyncs the affected boards' saved
      // review-item prompt/rows — post the refreshed review BEFORE the
      // result message below (same ordering as panel.ts).
      await handleGetThemeImageReview(store, broadcast, themeId);
    }
    broadcast('message', {
      type: MSG_WIRE.THEME_ITEM_NAMES_RESULT,
      payload: {
        ok: result.rejected.length === 0,
        theme_id: themeId,
        board_id: boardId,
        applied: result.applied,
        rejected: result.rejected,
      },
    });
    if (result.applied.length) {
      broadcast('message', {
        type: MSG_WIRE.THEME_INITIALIZED,
        payload: buildThemeInitPayload(manifest, frames, true),
      });
    }
  } catch (err) {
    broadcast('message', {
      type: MSG_WIRE.THEME_ITEM_NAMES_RESULT,
      payload: { ok: false, theme_id: themeId, board_id: boardId, error: String(err?.message ?? err) },
    });
  }
}

/** Mirrors panel.ts's MSG.SET_THEME_ITEM_DESCRIPTIONS branch. `item_kind` includes
 * 'crate'/'poof'/'projectile'/'badge'/'expression' (single/positional plan fields) in
 * addition to 'object'/'decor'/'character'/'rival' — see
 * applyThemeItemDescriptionChanges in themeService.ts. No THEME_INITIALIZED repost
 * here (descriptions never touch the manifest, only plan.json). */
export async function handleSetThemeItemDescriptions(store, broadcast, payload) {
  const themeId = payload?.theme_id ?? '';
  const boardId = payload?.board_id ?? '';
  if (!/^[a-z0-9_]+$/.test(themeId)) return;
  const changes = Array.isArray(payload?.changes) ? payload.changes : [];
  try {
    const result = await genBridge.updateThemeItemDescriptionsBatch(store, themeId, changes);
    if (result.applied.length) {
      await handleGetThemeImageReview(store, broadcast, themeId);
    }
    broadcast('message', {
      type: MSG_WIRE.THEME_ITEM_DESCRIPTIONS_RESULT,
      payload: {
        ok: result.rejected.length === 0,
        theme_id: themeId,
        board_id: boardId,
        applied: result.applied,
        rejected: result.rejected,
      },
    });
  } catch (err) {
    broadcast('message', {
      type: MSG_WIRE.THEME_ITEM_DESCRIPTIONS_RESULT,
      payload: { ok: false, theme_id: themeId, board_id: boardId, error: String(err?.message ?? err) },
    });
  }
}

/** Mirrors panel.ts's MSG.SET_THEME_CREATIVE_DIRECTION branch. No review resync —
 * retries always rebuild their prompt fresh from the current plan at retry time. */
export async function handleSetThemeCreativeDirection(store, broadcast, payload) {
  const themeId = payload?.theme_id ?? '';
  if (!/^[a-z0-9_]+$/.test(themeId)) return;
  const creativeDirection = payload?.creative_direction ?? '';
  try {
    const result = await genBridge.updateThemeCreativeDirection(store, themeId, creativeDirection);
    broadcast('message', {
      type: MSG_WIRE.THEME_CREATIVE_DIRECTION_RESULT,
      payload: { ...result, theme_id: themeId },
    });
  } catch (err) {
    broadcast('message', {
      type: MSG_WIRE.THEME_CREATIVE_DIRECTION_RESULT,
      payload: { ok: false, theme_id: themeId, error: String(err?.message ?? err) },
    });
  }
}

/** Mirrors panel.ts's MSG.RENAME_THEME_CHARACTER branch, including the
 * gate/busy-state dance shared with handleRetryThemeImage. */
export async function handleRenameThemeCharacter(store, broadcast, payload) {
  const themeId = payload?.theme_id ?? '';
  const itemId = payload?.item_id ?? '';
  if (!/^[a-z0-9_]+$/.test(themeId) || !/^[a-z0-9_-]+$/.test(itemId)) return;

  const activeGate = themeGenerationReviewGate;
  const renamingActiveGate =
    themeGenerationActive && activeGate?.themeId === themeId && activeGate.itemId === itemId;
  if (themeGenerationActive && !renamingActiveGate) {
    broadcast('message', {
      type: MSG_WIRE.THEME_CHARACTER_RENAME_STATE,
      payload: { item_id: itemId, error: 'Only the character currently waiting for review can be renamed.' },
    });
    return;
  }
  if (renamingActiveGate && themeGenerationGateRetryActive) return;
  if (renamingActiveGate) themeGenerationGateRetryActive = true;

  try {
    broadcast('message', {
      type: MSG_WIRE.THEME_CHARACTER_RENAME_STATE,
      payload: { item_id: itemId, busy: true, message: 'Saving character name...' },
    });
    const result = await genBridge.renameThemeCharacter(store, themeId, itemId, payload?.name ?? '');
    if (
      renamingActiveGate &&
      themeGenerationReviewGate?.themeId === themeId &&
      themeGenerationReviewGate.itemId === itemId
    ) {
      themeGenerationReviewGate.replacement = result;
    }
    await handleGetThemeImageReview(store, broadcast, themeId);
    broadcast('message', {
      type: MSG_WIRE.THEME_CHARACTER_RENAME_STATE,
      payload: { item_id: itemId, busy: false, message: 'Character name saved.' },
    });
    if (!renamingActiveGate) {
      broadcast('message', {
        type: MSG_WIRE.THEME_INITIALIZED,
        payload: buildThemeInitPayload(result.manifest, result.frames, true),
      });
    }
  } catch (err) {
    broadcast('message', {
      type: MSG_WIRE.THEME_CHARACTER_RENAME_STATE,
      payload: { item_id: itemId, busy: false, error: String(err?.message ?? err) },
    });
  } finally {
    if (renamingActiveGate) themeGenerationGateRetryActive = false;
  }
}

/** Mirrors panel.ts's MSG.APPROVE_ALL_THEME_IMAGES branch. */
export async function handleApproveAllThemeImages(store, broadcast, payload) {
  const themeId = payload?.theme_id ?? '';
  try {
    if (themeGenerationActive) {
      throw new Error('Wait for theme generation to finish before approving all images.');
    }
    await genBridge.approveAllThemeImages(store, themeId);
    await handleGetThemeImageReview(store, broadcast, themeId);
    const themes = await listThemesFromStore(store);
    broadcast('message', { type: MSG_WIRE.THEMES_LIST, payload: { themes } });
  } catch (err) {
    broadcast('message', {
      type: MSG_WIRE.THEME_APPROVE_ALL_RESULT,
      payload: { theme_id: themeId, error: String(err?.message ?? err) },
    });
  }
}

// ── Test-only introspection/reset ──────────────────────────────────────
// A generation test suite (a later task, pC-t3) needs to reset this
// module's singleton generation state between test cases — otherwise a
// prior test's `themeGenerationActive = true` (or a leftover abort
// controller/review gate) would leak into and silently break the next
// test's assertions. Exported ONLY for test use; server.mjs never calls this.
export function resetThemeGenerationStateForTests() {
  themeGenerationActive = false;
  themeGenerationAbortController = undefined;
  themeGenerationGateRetryActive = false;
  themePauseForReview = true;
  themeGenerationReviewGate = undefined;
}
