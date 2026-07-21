// TycoonAgents standalone — end-to-end authoring-loop coverage for the theme
// GENERATION handlers (project-plan tasks pC-t3, extended by pD-t3 with the
// EXPORT step): PLAN -> GENERATE -> EDIT -> APPROVE -> EXPORT, driven
// against the REAL themeService.ts pipeline (via themeGenerationBridge.mjs's
// createRequire out/ bridge — same posture as themeEditorMessages.test.mjs /
// themeMessages.test.mjs) with a MOCKED image (and planning-LLM) provider so
// the test is deterministic and makes zero real network calls. The EXPORT
// step (pD-t3) reuses this exact fixture rather than re-running a second
// 23-image generation, and additionally proves the exported archive excludes
// images/raw/ (the 0.0.371 rule) by calling exportThemeArchiveFromStore()
// directly and parsing the resulting zip with the same parseThemeArchive()
// themeExportImportHttp.test.mjs uses for the HTTP-layer route.
//
// WHY A MOCKED FETCH IS SAFE HERE: generateTheme's real pipeline always
// pads a requested plan up to the fixed per-theme counts (16 characters, 4
// enemies packed into 1 rival board, 9 decor, 21 objects across 2 boards, 8
// expressions, 25 achievements — see src/extension/themePlan.ts's
// normalizeThemePlan/normalizeNames/reserveRangedWeaponRackSlot), so there is
// no smaller plan shape to request — every full generation produces the same
// fixed 23-item board set (1 environment + 16 character + 1 rival + 1 decor +
// 2 object + 1 expression + 1 achievement). What keeps this test fast and
// simple is that a single flat, contentless magenta chroma-key PNG (Jimp
// buildAtlasBuffer below) is a real, Jimp-decodable atlas that
// sliceAndNormalizeAtlas/optimizeSpriteBoardCanvas/normalizeEnvironmentImage
// all process successfully for EVERY board kind without needing sprite
// content: with zero opaque pixels, slicer.ts's scaleReferenceSlots/
// normalizationGroups filters (`.filter((cell) => Boolean(cell?.count))`)
// simply find no reference cells and fall back to boardScale=1 (see
// test/slicer.test.ts's "4x3 object board contract" case, which already
// proves this for a plain magenta canvas) — so one mock response buffer
// covers character/rival/object/decor/expression/achievement/environment
// boards alike, and every resulting frames.json entry is non-empty (a real,
// if visually blank, sliced/cropped PNG data URI per cell).
//
// globalThis.fetch is stubbed for the DURATION of each test only (restored in
// `finally`) and dispatches on request URL: theme PLANNING goes through
// translator.ts's OpenAI chat-completions endpoint (returns a minimal planner
// JSON envelope — normalizeThemePlan pads every array field itself, so an
// almost-empty planner reply is a valid, fully-formed plan); image GENERATION
// goes through imageClient.ts's OpenAI images/generations endpoint (returns
// the magenta atlas as a base64 b64_json, matching the real API's response
// envelope exactly like test/themeResumeResliceRecovery.test.ts already
// does). No real timers, no network.
//
// Every board's pause-for-review gate is disabled via
// GENERATE_THEME's payload.pause_for_review: false (mirrors unchecking the
// webview's "Pause after each image for approval" checkbox) so
// handleGenerateTheme's promise resolves on its own once every one of the 23
// boards has generated — no manual per-item accept needed to avoid a hang
// (see themeGenerationMessages.mjs's module header for why the gate exists at
// all: media/main.js's default-checked pause-for-review checkbox).
//
// Deterministic: one shared temp dir per test (fs.mkdtempSync, removed in
// `finally`), the SAME magenta buffer for every fetch call, no Math.random/
// Date.now()-dependent assertions. Node built-ins + Jimp (already a root
// devDependency used by test/slicer.test.ts and
// test/themeResumeResliceRecovery.test.ts; resolves via Node's directory
// walk-up since standalone/package.json ships zero of its own deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Jimp from 'jimp';
import {
  createFsThemeFileStore,
  themeManifestPath,
  themeFramesPath,
  themePlanPath,
  themeReviewPath,
  themeImagesDirectoryPath,
  themeRawImagesDirectoryPath,
} from '../src/themeFileStoreFs.mjs';
import { configureThemeFileStore } from '../src/themeGenerationBridge.mjs';
import { exportThemeArchiveFromStore } from '../src/themeArchive.mjs';
import {
  handlePlanTheme,
  handleGenerateTheme,
  handleSetThemeCreativeDirection,
  handleApproveAllThemeImages,
  resetThemeGenerationStateForTests,
} from '../src/themeGenerationMessages.mjs';

// parseThemeArchive is the same compiled-out/ zip reader
// themeExportImportHttp.test.mjs uses to independently verify exported zip
// bytes — pulled in directly here (rather than re-exported through
// themeArchive.mjs, which only wraps the export/import bridge functions
// themselves) so the EXPORT step below can assert on the archive's actual
// entry list, not just that export "didn't throw".
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const { parseThemeArchive } = require(path.join(REPO_ROOT, 'out', 'src', 'extension', 'themeArchive.js'));

function mkTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-fullloop-'));
}

function fakeBroadcast(calls) {
  return (eventName, data) => {
    calls.push({ eventName, data });
  };
}

async function readJson(store, relativePath) {
  return JSON.parse(Buffer.from(await store.readFile(relativePath)).toString('utf8'));
}

function callsOfType(calls, type) {
  return calls.filter((c) => c.data?.type === type);
}

/** A plain contentless magenta chroma-key canvas — see this file's header for
 * why the slicer accepts this for every board kind. Small on purpose so
 * Jimp's decode/slice/resize work stays fast across all 23 boards. */
async function buildMagentaAtlasBase64() {
  const atlas = new Jimp(240, 180, 0xff00ffff);
  const buffer = await atlas.getBufferAsync(Jimp.MIME_PNG);
  return buffer.toString('base64');
}

/** Stubs globalThis.fetch for BOTH calls the pipeline makes:
 *  - translator.ts's planning call (POST .../v1/chat/completions) — returns
 *    an OpenAI chat-completion envelope whose message content is a minimal
 *    planner JSON object; normalizeThemePlan pads every array field itself.
 *  - imageClient.ts's image-generation call (POST .../v1/images/generations)
 *    — returns an OpenAI images envelope with the shared magenta atlas as
 *    `b64_json`, mirroring test/themeResumeResliceRecovery.test.ts.
 * Any other URL is a test bug (real network) and throws loudly. */
function installMockFetch(atlasBase64, plannerReply) {
  const original = globalThis.fetch;
  const calls = { planning: 0, image: 0 };
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/v1/chat/completions')) {
      calls.planning += 1;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(plannerReply) } }] }),
        { status: 200 },
      );
    }
    if (href.includes('/v1/images/generations') || href.includes('/v1/images/edits')) {
      calls.image += 1;
      return new Response(JSON.stringify({ data: [{ b64_json: atlasBase64 }] }), { status: 200 });
    }
    throw new Error(`installMockFetch: unexpected real-network URL in test: ${href}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function getThemeImageConfig() {
  return { provider: 'openai', openaiApiKey: 'test-key', geminiApiKey: undefined };
}

test('full authoring loop: PLAN -> GENERATE (mocked provider) -> EDIT (creative direction) -> APPROVE ALL -> EXPORT', async (t) => {
  const root = mkTempRoot();
  resetThemeGenerationStateForTests();
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);

  const atlasBase64 = await buildMagentaAtlasBase64();
  const plannerReply = {
    display_name: 'Cozy Pixel Bakery',
    creative_direction: 'warm pastel bakery vibes, soft lighting',
    environment: 'a cozy isometric bakery interior with wooden counters',
    // Every other planner field is intentionally omitted — normalizeThemePlan
    // pads characters/objects/decor/enemies/expressions/achievements to their
    // fixed counts on its own (see this file's header).
  };
  const mock = installMockFetch(atlasBase64, plannerReply);

  t.after(() => {
    mock.restore();
    resetThemeGenerationStateForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ── 1. PLAN ──────────────────────────────────────────────────────────
  const planCalls = [];
  await handlePlanTheme(store, fakeBroadcast(planCalls), getThemeImageConfig, {
    prompt: 'A cozy pixel-art bakery tycoon',
  });

  assert.equal(callsOfType(planCalls, 'THEME_PLAN_ERROR').length, 0, 'no plan error expected');
  const planReady = callsOfType(planCalls, 'THEME_PLAN_READY')[0];
  assert.ok(planReady, 'THEME_PLAN_READY broadcast');
  const plan = planReady.data.payload.plan;
  assert.equal(plan.display_name, 'Cozy Pixel Bakery');
  assert.equal(plan.characters.length, 16, 'normalizeThemePlan pads characters to the fixed count');
  assert.equal(plan.objects.length, 21);
  assert.equal(plan.decor.length, 9);
  assert.equal(plan.enemies.length, 4);
  assert.equal(plan.expressions.length, 8);
  assert.equal(plan.achievements.length, 25);
  assert.equal(mock.calls.planning, 1, 'planning called fetch exactly once');
  assert.equal(mock.calls.image, 0, 'planning must not call the image endpoint');

  // ── 2. GENERATE (pause-for-review OFF so the promise settles on its own) ─
  const genCalls = [];
  await handleGenerateTheme(store, fakeBroadcast(genCalls), getThemeImageConfig, {
    plan,
    pause_for_review: false,
    image_provider: 'openai',
  });

  assert.equal(callsOfType(genCalls, 'THEME_GENERATION_ERROR').length, 0, 'no generation error expected');
  assert.equal(callsOfType(genCalls, 'THEME_GENERATION_CANCELLED').length, 0, 'generation must not be cancelled');
  const reviewReady = callsOfType(genCalls, 'THEME_REVIEW_READY')[0];
  assert.ok(reviewReady, 'THEME_REVIEW_READY broadcast');
  const themeId = reviewReady.data.payload.theme_id;
  assert.ok(themeId, 'a theme_id was assigned');

  const initialized = callsOfType(genCalls, 'THEME_INITIALIZED').pop();
  assert.ok(initialized, 'terminal THEME_INITIALIZED broadcast');
  assert.equal(initialized.data.payload.manifest.theme_id, themeId);
  assert.equal(initialized.data.payload.is_editor_mode, true);
  assert.equal(typeof initialized.data.payload.savedBuildProgress, 'number');

  // Every board issued exactly one mocked image-generation call: 1 environment
  // + 16 characters + 1 rival board + 1 decor + 2 object boards + 1
  // expression + 1 achievement = 23.
  assert.equal(mock.calls.image, 23, 'expected exactly one image call per synthesized board');

  // On-disk store artifacts.
  assert.ok(await store.exists(themeManifestPath(themeId)), 'manifest.json written');
  assert.ok(await store.exists(themeFramesPath(themeId)), 'frames.json written');
  assert.ok(await store.exists(themePlanPath(themeId)), 'plan.json written');
  assert.ok(await store.exists(themeReviewPath(themeId)), 'review.json written');

  const manifest = await readJson(store, themeManifestPath(themeId));
  assert.equal(manifest.roster_agents.length, 16);

  const frames = await readJson(store, themeFramesPath(themeId));
  assert.ok(Array.isArray(frames.environment_background) && frames.environment_background.length > 0);
  assert.ok(Array.isArray(frames.agent_0) && frames.agent_0.length > 0, 'first character board sliced non-empty frames');

  const review = await readJson(store, themeReviewPath(themeId));
  assert.equal(review.items.length, 23, '1 environment + 16 characters + 1 rival + 1 decor + 2 objects + 1 expression + 1 achievement');
  assert.equal(review.items[0].id, 'environment', 'environment is generated FIRST, matching the extension pipeline order');
  assert.equal(review.items.filter((item) => item.kind === 'character_atlas').length, 16);
  assert.equal(review.items.filter((item) => item.kind === 'object_atlas').length, 2);
  for (const item of review.items) {
    assert.equal(item.status, 'pending', `item ${item.id} should still be pending before APPROVE ALL`);
    const imagePath = path.join(root, themeImagesDirectoryPath(themeId), item.filename);
    assert.ok(fs.existsSync(imagePath), `generated image file exists on disk for ${item.id}`);
  }

  // ── 3. EDIT (creative direction) ────────────────────────────────────────
  const editCalls = [];
  await handleSetThemeCreativeDirection(store, fakeBroadcast(editCalls), {
    theme_id: themeId,
    creative_direction: 'a moody neon-lit midnight bakery',
  });
  const editResult = callsOfType(editCalls, 'THEME_CREATIVE_DIRECTION_RESULT')[0];
  assert.ok(editResult, 'THEME_CREATIVE_DIRECTION_RESULT broadcast');
  assert.equal(editResult.data.payload.ok, true);

  // Fresh re-read off disk (new JSON.parse, not the in-memory `plan`/broadcast
  // objects above) proves the edit actually persisted.
  const planAfterEdit = await readJson(store, themePlanPath(themeId));
  assert.equal(planAfterEdit.creative_direction, 'a moody neon-lit midnight bakery');

  // ── 4. APPROVE ALL ───────────────────────────────────────────────────────
  const approveCalls = [];
  await handleApproveAllThemeImages(store, fakeBroadcast(approveCalls), { theme_id: themeId });

  assert.equal(callsOfType(approveCalls, 'THEME_APPROVE_ALL_RESULT').length, 0, 'no error result expected');
  const approvedReview = callsOfType(approveCalls, 'THEME_IMAGE_REVIEW')[0];
  assert.ok(approvedReview, 'THEME_IMAGE_REVIEW re-broadcast after approve-all');
  assert.equal(approvedReview.data.payload.items.length, 23);
  assert.ok(
    approvedReview.data.payload.items.every((item) => item.status === 'accepted'),
    'every outbound review item is accepted',
  );

  const themesList = callsOfType(approveCalls, 'THEMES_LIST')[0];
  assert.ok(themesList, 'THEMES_LIST re-broadcast after approve-all');
  const listedTheme = themesList.data.payload.themes.find((th) => th.theme_id === themeId);
  assert.ok(listedTheme, 'the generated theme appears in THEMES_LIST');

  // Fresh re-read off disk proves the approval actually persisted, not just
  // the broadcast payload.
  const reviewAfterApprove = await readJson(store, themeReviewPath(themeId));
  assert.equal(reviewAfterApprove.items.length, 23);
  for (const item of reviewAfterApprove.items) {
    assert.equal(item.status, 'accepted', `item ${item.id} should be accepted on disk`);
  }

  // ── 5. EXPORT ────────────────────────────────────────────────────────────
  // exportThemeArchiveFromStore() (standalone/src/themeArchive.mjs, the same
  // bridge into out/src/extension/themeArchiveOps.js the real
  // GET /theme-export/<id> HTTP route uses — see
  // themeExportImportHttp.test.mjs for the HTTP-layer coverage of that
  // route) requires every review item to be accepted first, which is exactly
  // the state APPROVE ALL just produced above.
  //
  // First confirm raw atlas files actually exist on disk (persistRawAtlas
  // runs once per generated board during GENERATE), so the raw-exclusion
  // assertion below is checking a real subtraction, not a vacuous one.
  const rawDir = themeRawImagesDirectoryPath(themeId);
  const rawEntries = await store.readdir(rawDir).catch(() => []);
  assert.ok(
    rawEntries.some((entry) => entry.isFile),
    'raw atlas files exist on disk pre-export (persisted once per generated board), so the exclusion check below is non-vacuous',
  );

  const archiveBytes = await exportThemeArchiveFromStore(store, themeId);
  assert.ok(archiveBytes instanceof Uint8Array && archiveBytes.length > 0, 'export produced a non-empty archive');

  const archive = parseThemeArchive(archiveBytes);
  assert.equal(archive.themeId, themeId, 'archive is tagged with the exported theme_id');
  const archivePaths = [...archive.files.keys()];
  assert.ok(archivePaths.includes('manifest.json'), 'archive contains manifest.json');
  assert.ok(archivePaths.includes('frames.json'), 'archive contains frames.json');
  assert.ok(archivePaths.includes('plan.json'), 'archive contains plan.json');
  assert.ok(
    archivePaths.some((p) => p.startsWith('images/') && !p.startsWith('images/raw/')),
    'archive contains at least one non-raw generated board image',
  );
  assert.ok(
    archivePaths.every((p) => p !== 'images/raw' && !p.startsWith('images/raw/')),
    `exported archive must exclude images/raw/* (0.0.371 rule); got: ${JSON.stringify(archivePaths)}`,
  );
});
