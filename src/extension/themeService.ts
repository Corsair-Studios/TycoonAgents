import type {
  AgentConfig,
  BuildableObject,
  EnemyConfig,
  RivalConfig,
  ThemeManifest,
  ViewportConfig,
} from '../shared/types';
import { expandThemePlan, regenerateThemeDescriptionsFromPlan } from './translator';
import type { ThemeImageGenerationOptions as ThemeTextGenerationOptions } from './translator';
import { buildDefaultBadges, upgradeThemeManifest } from './themeMigration';
import { validateThemeIntegrity } from './themeHealth';
import {
  boardBackgroundPaddingAdjective,
  buildAchievementAtlasPrompt,
  buildAchievementAtlasRequest,
  buildBackgroundDecorPrompt,
  buildBackgroundDecorRequest,
  buildCharacterAtlasPrompt,
  buildCharacterAtlasRequest,
  buildEmoteAtlasPrompt,
  buildEmoteAtlasRequest,
  buildEnvironmentPrompt,
  buildEnvironmentRequest,
  buildExpressionAtlasPrompt,
  buildExpressionAtlasRequest,
  buildObjectAtlasPrompt,
  buildObjectAtlasRequest,
  CHARACTER_TARGET_CONTENT_HEIGHT,
  CHARACTER_TARGET_CONTENT_PERCENT,
  CHARACTER_QUADRUPED_TARGET_CONTENT_WIDTH,
  buildRivalAtlasPrompt,
  buildRivalAtlasRequest,
  createDecorBoardRows,
  createObjectBoard1Rows,
  createObjectBoard2Rows,
  createRivalBoardRows,
  decorBoardFrameKeys,
  objectBoardFrameKeys,
  OBJECT_ANIMATED_COUNT,
  OBJECT_BOARD1_STATIC_COUNT,
  OBJECT_BOARD2_STATIC_COUNT,
  OBJECT_STATIC_COUNT,
  rivalBoardFrameKeys,
} from './themeAssetPrompts';
import type { BoardBackgroundMode, ThemeObjectPromptSpec, ThemeRivalPromptSpec } from './themeAssetPrompts';
import type { StructuredGenerateRequest } from '../core/themePromptTemplates';
import { assembleThemePrompt } from '../core/themePromptTemplates';
import { createHash } from 'node:crypto';
import { THEME_SERVICE_HOST_SESSION_ID } from './themeServiceHostSession';
import {
  isUserCorrectableImageGenerationError,
  type ImageGenerationApiError,
} from './imageGenerationError';
import type {
  ThemeServiceClient,
  ThemeServiceError,
  ThemeServiceErrorKind,
} from '../core/themeServiceClient';
import { compositeBoardFromFrameKeys, sliceAndNormalizeAtlas } from './slicer';
import type { AtlasGrid } from './slicer';
import {
  optimizeSpriteBoard,
  optimizeSpriteBoardCanvas,
  resizeSpriteBoardCanvas,
} from './spriteBoardOptimizer';
import { recoverReviewImages } from './themeReviewImages';
import { composeRecoveredBoardImages, type RecoveredBoardFile } from './themeBoardRecovery';
import { createEnvironmentShapeGuide, normalizeEnvironmentImage } from './environmentAsset';
import { inferBodyPlan } from '../core/bodyPlan';
import type { BodyPlan } from '../core/bodyPlan';
import {
  acceptAllThemeImageReviewItems,
  clearThemeImageReviewItemError,
  inferLegacyReviewItem,
  initializeThemeImageReviewDocument,
  loadThemeImageReviewDocument,
  recordAttemptCharge,
  setThemeImageGenerationError,
  themeCreditsSpent,
  setThemeImageReviewErrorKind,
  setThemeImageReviewStatus,
  setThemeGenerationStatus,
  upsertThemeImageReviewItem,
} from './themeImageReviewState';
import type {
  ThemeDecorBoardRow,
  ThemeGenerationRunState,
  ThemeImageKind,
  ThemeImageReviewDocument,
  ThemeImageReviewItem,
  ThemeImageReviewStatus,
  ThemeObjectBoardRow,
  ThemeRivalBoardRow,
} from './themeImageReviewState';
import { isThemeGenerationItemComplete } from './themeGenerationState';
import { parseThemeArchive } from './themeArchive';
import type { ThemeArchiveContents } from './themeArchive';
import { exportThemeArchiveFromStore, importThemeArchiveToStore } from './themeArchiveOps';
import { summarizeThemeApproval } from './themeApproval';
import type { ThemeApprovalSummary } from './themeApproval';
import { selectThemeImageRetryPrompt } from './themeImageRetry';
import type { ThemeImageRetryMode } from './themeImageRetry';
import {
  ATLAS_CLIPS,
  manifestToPlanSeed,
  normalizeThemePlan,
  THEME_ACHIEVEMENT_COUNT,
  THEME_EXPRESSION_COUNT,
  THEME_OBJECT_COUNT,
  themePlanCreativeDirection,
  themePlanToManifest,
  toSafeAssetId,
  uniqueIds,
} from './themePlan';
import type { ThemePlan } from './themePlan';
import { resolveThemeFileStore } from './themeFileStore';
import type { ThemeFileHandle, ThemeFileStore, ThemeFileStoreEntry, ThemeStorageRoot } from './themeFileStore';
import {
  themeDirectoryPath,
  themeFramesPath,
  themeImagesDirectoryPath,
  themeManifestPath,
  themePlanPath,
  themeRawImagesDirectoryPath,
  themesDirectoryPath,
  legacyFramesPath,
  legacyImageReviewPath,
  legacyImagesDirectoryPath,
  legacyManifestPath,
  legacyPlanPath,
  legacyReviewPath,
  joinThemePath,
} from './themeFileStore';

/**
 * Generation options threaded through every board-image call (p43-t1). No
 * `provider`/`apiKey`/`model`/`quality` fields anymore — the Corsair Theme
 * Service (see docs/theme-service-api.md v2) owns provider/model selection
 * entirely; the client only ever supplies the prompt, reference images, and
 * requested size/aspect ratio. Reference images are converted to
 * `data:` URIs at the call boundary (see referenceImagesToDataUris below).
 */
export interface ThemeImageGenerationOptions {
  aspectRatio?: '1:1' | '3:4';
  /** Cancels the in-flight Theme Service request when a theme generation is stopped. */
  signal?: AbortSignal;
  referenceImages?: Array<{
    data: Buffer;
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    filename: string;
  }>;
}

/**
 * One generation attempt against the Corsair Theme Service. Mirrors
 * ThemeServiceClient['generateAttempt'] exactly (docs/theme-service-api.md
 * "Generation") so {@link createServiceImageGenerator} is a thin adapter, not
 * a translation layer — see p43-t1.
 */
/**
 * p59-t3: v3.4 structured request — mirrors GenerateAttemptRequest
 * (src/core/themeServiceClient.ts) exactly, no free-text `prompt` field.
 */
export type ThemeImageGenerateRequest = StructuredGenerateRequest & {
  idempotencyKey: string;
  size: string;
};

export interface ThemeImageGenerateValue {
  image: Buffer;
  attemptCost: number;
  credits: number;
  refunded: boolean;
  promptTemplateVersion?: string;
  assembledPromptSha256?: string;
}

export type ThemeImageGenerateResult =
  | { ok: true; value: ThemeImageGenerateValue }
  | { ok: false; error: ThemeServiceError };

/** Injectable seam (p43-t1) so themeService.ts never imports a provider SDK or `vscode` directly. */
export interface ThemeImageGenerator {
  generate(req: ThemeImageGenerateRequest): Promise<ThemeImageGenerateResult>;
}

/** Build a {@link ThemeImageGenerator} backed by a real ThemeServiceClient's generateAttempt. */
export interface ThemeImageGeneratorBalanceHooks {
  /** Called when an attempt starts; the returned token (account + start order) is handed back to `credits` so the host can drop a stale-account or out-of-order balance. */
  begin?: () => unknown;
  /** Called with a response's authoritative post-attempt balance (success or an error response that carries one) so the host can refresh its balance immediately. */
  credits?: (credits: number, token: unknown) => void;
}

export function createServiceImageGenerator(
  client: ThemeServiceClient,
  hooks?: ThemeImageGeneratorBalanceHooks,
): ThemeImageGenerator {
  return {
    async generate(req) {
      let token: unknown;
      try {
        token = hooks?.begin?.();
      } catch {
        token = undefined;
      }
      const res = await client.generateAttempt(req);
      const reported = res.ok ? res.value.credits : res.error.credits;
      if (typeof reported === 'number') {
        try {
          hooks?.credits?.(reported, token);
        } catch {
          // a balance-refresh failure must never change the attempt's outcome
        }
      }
      if (!res.ok) return res;
      const base64 = res.value.image.includes(',') ? res.value.image.slice(res.value.image.indexOf(',') + 1) : res.value.image;
      return {
        ok: true,
        value: {
          image: Buffer.from(base64, 'base64'),
          attemptCost: res.value.attemptCost,
          credits: res.value.credits,
          refunded: res.value.refunded,
          promptTemplateVersion: res.value.promptTemplateVersion,
          assembledPromptSha256: res.value.assembledPromptSha256,
        },
      };
    },
  };
}

let currentThemeImageGenerator: ThemeImageGenerator | undefined;
let currentAttemptCostResolver: ((boardType: string) => number | undefined) | undefined;

/** Host wiring point: resolves the quoted attempt cost for a board type (the same pricing the "This attempt costs N credits" line uses), so a charged-but-not-refunded failure can be counted. */
export function setThemeAttemptCostResolver(resolver: ((boardType: string) => number | undefined) | undefined): void {
  currentAttemptCostResolver = resolver;
}

/** Host wiring point (panel.ts, standalone) — call once at startup with `createServiceImageGenerator(themeServiceHost.getClient())`; tests inject a fake directly. */
export function setThemeImageGenerator(generator: ThemeImageGenerator | undefined): void {
  currentThemeImageGenerator = generator;
}

/** Thrown by generateBoardImage on any non-ok ThemeServiceClient result, or when no generator has been configured. `kind` mirrors ThemeServiceErrorKind exactly so callers can surface a distinct, non-generic message per docs/theme-service-api.md's error table. */
export class ThemeGenerationServiceError extends Error {
  readonly kind: ThemeServiceErrorKind;
  readonly refunded?: boolean;
  readonly credits?: number;
  readonly code?: string;
  readonly status?: number;
  readonly categories?: string[];
  readonly fields?: string[];
  constructor(error: { kind: ThemeServiceErrorKind; message: string; refunded?: boolean; credits?: number; code?: string; status?: number; categories?: string[]; fields?: string[] }) {
    super(error.message);
    this.name = 'ThemeGenerationServiceError';
    this.kind = error.kind;
    this.refunded = error.refunded;
    this.credits = error.credits;
    this.code = error.code;
    this.status = error.status;
    this.categories = error.categories;
    this.fields = error.fields;
  }
}

export function isThemeGenerationServiceError(error: unknown): error is ThemeGenerationServiceError {
  return error instanceof ThemeGenerationServiceError;
}

function sizeForOptions(options: ThemeImageGenerationOptions | undefined): string {
  return options?.aspectRatio === '3:4' ? '1024x1440' : '1024x1024';
}

let themeImageAttemptCounter = 0;
/** Backend's IDEMPOTENCY_KEY_RE (corsair-theme-service/src/validate.mjs) only allows `[A-Za-z0-9_-]{8,128}` — no colons, so themeId/itemId (which may contain arbitrary chars) are sanitized before joining (p85-t5). */
function sanitizeIdempotencyPart(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, '-');
}
/** `${themeId}-${itemId}-${attemptNumber}-${randomSuffix}` (sanitized, capped to 128 chars) (p43-t1/p85-t5) — generated once per attempt; a caller that retries the same HTTP request (not a new user-initiated retry) must reuse the same key, which is why this is computed once per generateBoardImage call and threaded through, never regenerated mid-request. */
function nextThemeImageIdempotencyKey(themeId: string, itemId: string, attemptNumber: number): string {
  themeImageAttemptCounter += 1;
  const suffix = `${Date.now().toString(36)}${themeImageAttemptCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const key = `${sanitizeIdempotencyPart(themeId)}-${sanitizeIdempotencyPart(itemId)}-${attemptNumber}-${suffix}`;
  return key.length > 128 ? key.slice(key.length - 128) : key;
}

/** Maps a review item to the Theme Service's boardType pricing key (docs/theme-service-api.md's `attemptCostByBoardType`). */
/** Maps a review item to the Theme Service's boardType pricing key (docs/theme-service-api.md's `attemptCostByBoardType`) — exported (review fix) so getThemeImageReview's payload and its tests can compute/assert the same value the webview's cost line looks up. */
export function boardTypeForItem(item: { kind: ThemeImageKind; id: string }): string {
  switch (item.kind) {
    case 'character_atlas': return 'roster_agent';
    case 'rival_atlas': return 'rival_group';
    case 'environment': return 'environment';
    case 'object_atlas': return item.id === 'objects_02' ? 'objects_02' : 'objects_01';
    case 'background_decor_atlas': return 'objects_01';
    case 'expression_atlas': return 'expressions';
    case 'achievement_atlas': return 'achievements';
    case 'emote_atlas': return 'expressions';
    default: return item.kind;
  }
}

/**
 * p59-t3: regroups a flat `decor_rows` array (as persisted on
 * ThemeImageReviewItem, see createDecorReviewItem's `rows.flat()`) back into
 * the four row-groups buildBackgroundDecorRequest expects: 4 seats, 4
 * statics, 1 animated, 1 projectile.
 */
function regroupDecorRows(rows: ThemeDecorBoardRow[]): ThemeDecorBoardRow[][] {
  return [rows.slice(0, 4), rows.slice(4, 8), rows.slice(8, 9), rows.slice(9, 10)];
}

/**
 * p59-t3: rebuilds the v3.4 StructuredGenerateRequest for a review item from
 * its own persisted fields (rival_rows/object_rows/decor_rows,
 * expression/achievement names+descriptions, character_description/body_plan)
 * — the same fields createReviewItems used to build item.prompt in the first
 * place — so the server-side prompt assembly gets the identical structured
 * data the local preview was built from. `plan` is used only for
 * `plan.display_name`/`plan.creative_direction` (theme name / creative
 * direction text) and, for character boards, to resolve the effective body
 * plan for the agent slot.
 */
export function structuredRequestForItem(
  item: ThemeImageReviewItem | Omit<ThemeImageReviewItem, 'updated_at'>,
  plan: ThemePlan,
  creativeDirection: string,
  background: BoardBackgroundMode,
  manifest?: ThemeManifest,
): StructuredGenerateRequest {
  switch (item.kind) {
    case 'character_atlas': {
      const characterCreativeDirection = `Creative direction: ${plan.creative_direction}`;
      const agentSlotId = agentSlotIdFromFrameKey(item.frame_keys[0] ?? item.id);
      const bodyPlan = agentSlotId !== undefined ? effectiveCharacterBodyPlan(plan, agentSlotId) : (item.body_plan ?? 'biped');
      return buildCharacterAtlasRequest(
        characterCreativeDirection,
        item.subject ?? item.label,
        plan.display_name,
        background,
        resolveCharacterDescription(item.character_description, item.subject ?? item.label),
        { walkPoseGuide: bodyPlan },
      );
    }
    case 'rival_atlas':
      // Rebuild rows from the current plan so a failed review-item resync can't
      // leave a stale body plan in the request; stored rows are the fallback.
      return buildRivalAtlasRequest(
        creativeDirection, plan.display_name,
        manifest ? rivalRowsForItem(item, manifest, plan) : (item.rival_rows ?? []),
        background,
      );
    case 'object_atlas':
      return buildObjectAtlasRequest(creativeDirection, plan.display_name, item.object_rows ?? [], background);
    case 'background_decor_atlas':
      return buildBackgroundDecorRequest(
        creativeDirection, plan.display_name, regroupDecorRows(item.decor_rows ?? []), background, item.projectile_description,
      );
    case 'expression_atlas':
      return buildExpressionAtlasRequest(
        creativeDirection, plan.display_name, item.expression_names ?? [], background, item.expression_descriptions,
      );
    case 'achievement_atlas':
      return buildAchievementAtlasRequest(
        creativeDirection, plan.display_name, item.achievement_names ?? [], background, item.achievement_descriptions,
      );
    case 'emote_atlas':
      return buildEmoteAtlasRequest(creativeDirection, plan.display_name, background);
    case 'environment':
    default:
      return buildEnvironmentRequest(creativeDirection, plan.display_name);
  }
}

/**
 * p59-t3: set by the host (panel.ts) so generateBoardImage can surface a
 * one-line notice to the webview when the server assembled the prompt from a
 * newer template than the local preview used. Never throws from within the
 * notifier's own call site; a missing/absent notifier just skips the notice.
 */
let promptMismatchNotifier: ((message: string, templateVersion?: string) => void) | undefined;

export function setThemePromptMismatchNotifier(
  notifier: ((message: string, templateVersion?: string) => void) | undefined,
): void {
  promptMismatchNotifier = notifier;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Single choke point for every board-image call (p43-t1) — replaces the
 * removed direct-provider `generateThemeImage` (imageClient.ts, deleted).
 * Routes through the injected {@link ThemeImageGenerator} (real: Corsair
 * Theme Service via createServiceImageGenerator; tests: a fake counting
 * generator). Throws {@link ThemeGenerationServiceError} on any failure so
 * callers keep their existing try/catch shape.
 *
 * p59-t3: sends the v3.4 structured request (no free-text `prompt` field).
 * `localPreviewPrompt` is the client's own assembleThemePrompt output for the
 * same request — never sent to the server — used only to sha256-compare
 * against the response's `assembledPromptSha256` and warn via
 * {@link setThemePromptMismatchNotifier} on drift.
 */
async function generateBoardImage(
  themeId: string,
  item: { id: string; kind: ThemeImageKind; revision: number },
  structuredRequest: StructuredGenerateRequest,
  options: ThemeImageGenerationOptions | undefined,
  localPreviewPrompt?: string,
): Promise<ThemeImageGenerateValue> {
  if (!currentThemeImageGenerator) {
    throw new ThemeGenerationServiceError({ kind: 'unavailable', message: 'Theme Service is not configured.' });
  }
  const idempotencyKey = nextThemeImageIdempotencyKey(themeId, item.id, item.revision);
  // p85: the deployed backend's /api/generate validator rejects any request
  // body that even carries a `userReferenceImages` key (contract v3.4 "text
  // only, no reference images" decision) with 400 bad_request — so this key
  // must never be sent, not merely left undefined. Every retry ("Retry
  // image") was failing 400 before this fix.
  const { userReferenceImages: _droppedUserReferenceImages, ...structuredRequestWithoutReferenceImages } = structuredRequest;
  void _droppedUserReferenceImages;
  const result = await currentThemeImageGenerator.generate({
    ...structuredRequestWithoutReferenceImages,
    idempotencyKey,
    size: sizeForOptions(options),
  });
  if (!result.ok) throw new ThemeGenerationServiceError(result.error);
  if (result.value.assembledPromptSha256 && localPreviewPrompt) {
    const localHash = sha256Hex(localPreviewPrompt);
    if (localHash !== result.value.assembledPromptSha256) {
      const version = result.value.promptTemplateVersion ?? 'a newer version';
      promptMismatchNotifier?.(
        `The service used a newer prompt template (${version}); your preview may differ.`,
        result.value.promptTemplateVersion,
      );
    }
  }
  return result.value;
}

/**
 * Best-effort persist of the RAW pre-slice atlas buffer alongside its normalized
 * review image. Enables a future re-slice-without-regenerate path; a failure here
 * must NEVER break generation, so we only log a `[raw-atlas]` warning.
 */
async function persistRawAtlas(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  filename: string,
  generated: Buffer,
): Promise<void> {
  try {
    // Inlined from the former themeStorage.ts saveRawAtlas: WRITE-ONLY, no
    // consumer yet — enables a future "re-slice without re-paying the image
    // API" path. Kept local so themeService.ts doesn't need to import
    // themeStorage.ts (which imports the VS Code editor API at module scope).
    const store = resolveThemeFileStore(globalStorageUri);
    const rawDirectoryPath = themeRawImagesDirectoryPath(themeId);
    await store.mkdirp(rawDirectoryPath);
    await store.writeFile(`${rawDirectoryPath}/${filename}`, generated);
  } catch (err) {
    console.warn('TycoonAgents [raw-atlas]: failed to persist raw atlas', filename, err);
  }
}

export interface ThemeReviewImages {
  directoryUri: ThemeFileHandle;
  imageUris: ThemeFileHandle[];
  recovered: boolean;
}

export interface ThemeImageReviewEntry {
  item: ThemeImageReviewItem;
  imageUri?: ThemeFileHandle;
  generated: boolean;
}

export interface ThemeImageReview {
  theme_id: string;
  display_name: string;
  /** Sum of every entry's item.attemptCost (successful Theme Service attempts only; undefined attemptCost counts as 0) — p43-t1. Webview surfacing is p43-t2. */
  creditsSpent: number;
  entries: ThemeImageReviewEntry[];
  /** Durable AI batch-generation run state (p80), undefined when the review document has none yet (treat as "idle"). */
  generation?: ThemeGenerationRunState;
}

/** Re-exported so both hosts (panel.ts and the standalone bridge, which requires this compiled module directly) call one function to record batch-generation run status (p80). */
export { setThemeGenerationStatus };

export interface ThemeImageReviewWaitOptions {
  requiresReplacement?: boolean;
}

type ThemeGenerationResult = { manifest: ThemeManifest; frames: Record<string, string[]> };
type WaitForThemeImageReview = (
  themeId: string,
  itemId: string,
  options?: ThemeImageReviewWaitOptions,
) => Promise<ThemeGenerationResult | void>;

/** Every independently-regenerable board of a theme. */
export type BoardKind =
  | 'environment'
  | 'agents'
  | 'enemy'
  | 'decor'
  | 'objects'
  | 'expressions'
  | 'achievements';

/**
 * Maps the image provider that will actually run generation to the sprite-board
 * background mode its prompts should request. All providers currently use the
 * legacy magenta chroma-key contract.
 *
 * Magenta #FF00FF is the only background ever requested; image providers
 * (gpt-image-2 in particular) reject or mishandle transparent backgrounds.
 */
export function boardBackgroundModeForProvider(): BoardBackgroundMode {
  return 'magenta';
}

/**
 * Passes generation options through for a
 * magenta-keyed sprite board call (agents, rivals, decor, objects,
 * expressions, achievements, and their retries). The environment board is
 * opaque scenery and must never set this — its own call sites build their
 * options separately and never pass through this helper.
 */
function spriteBoardOptions(
  options: ThemeImageGenerationOptions | undefined,
): ThemeImageGenerationOptions | undefined {
  if (!options) return options;
  return {
    ...options,
  };
}

export async function planTheme(
  prompt: string,
  textGenerationOptions?: ThemeTextGenerationOptions,
): Promise<ThemePlan> {
  return expandThemePlan(prompt, textGenerationOptions);
}

export async function listThemes(
  globalStorageUri: ThemeStorageRoot,
): Promise<
  Array<
    { theme_id: string; display_name: string; size_bytes: number; hasBoards: boolean; boardCount: number } & ThemeApprovalSummary
  >
> {
  const store = resolveThemeFileStore(globalStorageUri);
  const results = new Map<string, { theme_id: string; display_name: string }>();
  try {
    const entries = await store.readdir(themesDirectoryPath());
    for (const entry of entries) {
      if (!entry.isDirectory || !isThemeId(entry.name)) continue;
      const manifest = await readJson<Partial<ThemeManifest>>(store, themeManifestPath(entry.name));
      if (manifest) results.set(entry.name, { theme_id: entry.name, display_name: manifest.display_name ?? entry.name });
    }
  } catch (error) {
    // The themes directory is created on first generation.
    console.warn(`TycoonAgents: listThemes: themesDirectoryPath() readdir failed (expected on first run): ${String(error)}`);
  }

  // Preserve access to themes produced by versions that used flat storage.
  try {
    const entries = await store.readdir('');
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith('_manifest.json')) continue;
      const themeId = entry.name.replace(/_manifest\.json$/, '');
      if (results.has(themeId)) continue;
      const manifest = await readJson<Partial<ThemeManifest>>(store, entry.name);
      if (manifest) results.set(themeId, { theme_id: themeId, display_name: manifest.display_name ?? themeId });
    }
  } catch (error) {
    // Global storage may not exist yet.
    console.warn(`TycoonAgents: listThemes: flat-root readdir failed: ${String(error)}`);
  }
  console.info(
    `TycoonAgents: listThemes: root=${String(globalStorageUri)} count=${results.size} ids=[${[...results.keys()].join(', ')}]`,
  );
  const sorted = [...results.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
  return Promise.all(sorted.map(async (theme) => {
    const [approval, sizeBytes, boardCounts] = await Promise.all([
      getThemeApprovalSummary(globalStorageUri, theme.theme_id),
      getThemeDiskSize(globalStorageUri, theme.theme_id),
      getThemeBoardCounts(globalStorageUri, theme.theme_id),
    ]);
    return { ...theme, ...approval, size_bytes: sizeBytes, ...boardCounts };
  }));
}

export interface ThemeUpgradeResult {
  theme_id: string;
  changed: string[];
}

/**
 * Scans every installed theme (modern per-directory storage under
 * `themes/<theme_id>/manifest.json`) and applies `upgradeThemeManifest` to
 * bring legacy manifests up to the current data contract. Missing art is
 * intentionally left alone here — the migration only fills in structural
 * fields (decor_objects, crate/poof/projectile assets, enemy_config); the
 * webview renders labeled placeholders for any asset that isn't generated.
 *
 * For each theme whose manifest actually changes, the original file is
 * backed up (non-destructively) alongside it before the upgraded manifest is
 * written back. A theme whose manifest is already current is still included
 * in the returned results with an empty `changed` list. A single bad
 * manifest never aborts the scan of the remaining themes.
 */
export async function upgradeInstalledThemes(
  globalStorageUri: ThemeStorageRoot,
): Promise<ThemeUpgradeResult[]> {
  const results: ThemeUpgradeResult[] = [];
  const store = resolveThemeFileStore(globalStorageUri);

  let entries: ThemeFileStoreEntry[] = [];
  try {
    entries = await store.readdir(themesDirectoryPath());
  } catch {
    // The themes directory is created on first generation; nothing to upgrade.
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory || !isThemeId(entry.name)) continue;
    const themeId = entry.name;
    try {
      const manifestPath = themeManifestPath(themeId);
      const raw = await store.readFile(manifestPath);
      const manifest = JSON.parse(Buffer.from(raw).toString('utf8')) as ThemeManifest;
      const { manifest: upgraded, changed } = upgradeThemeManifest(manifest);
      results.push({ theme_id: themeId, changed });

      if (changed.length > 0) {
        const backupPath = joinThemePath(themeDirectoryPath(themeId), `manifest.json.${Date.now()}.bak`);
        try {
          // Never clobber an existing backup with the same name.
          await store.stat(backupPath);
        } catch {
          await store.writeFile(backupPath, Buffer.from(raw));
        }
        await store.writeFile(manifestPath, jsonBuffer(upgraded));
      }
    } catch (error) {
      console.error(`[TycoonAgents] Failed to upgrade theme "${themeId}":`, error);
    }
  }

  return results;
}

// seedBundledThemes was relocated to src/host/vscode/bundledThemeSeeds.ts
// (project-plan task pC-t1) — it's the only themeService caller that needed
// a second (extensionUri) editor-Uri root and raw editor filesystem reads of
// the extension's shipped media/themes/* assets, outside the ThemeFileStore
// abstraction. See extension.ts for its (unchanged) call site.

export async function getThemeApprovalSummary(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
): Promise<ThemeApprovalSummary> {
  if (!isThemeId(themeId)) return summarizeThemeApproval(undefined);
  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  return summarizeThemeApproval(document?.items);
}

/**
 * Cheap board-presence check (p77-t2): counts frames.json entries — every
 * generated OR uploaded board writes its slot into frames.json (see
 * uploadThemeImage / regenerateThemeBoardImage), so a key count there is a
 * single-file read that answers "does this theme have anything to review"
 * without a directory scan. Callers that already hold a loaded theme's
 * `frames` object (loadTheme / saveThemePlan / regenerate handlers) should
 * use `themeBoardCountsFromFrames` instead of re-reading the file.
 */
export async function getThemeBoardCounts(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
): Promise<{ hasBoards: boolean; boardCount: number }> {
  if (!isThemeId(themeId)) return { hasBoards: false, boardCount: 0 };
  const store = resolveThemeFileStore(globalStorageUri);
  const frames = await readJson<Record<string, string[]>>(store, themeFramesPath(themeId));
  return themeBoardCountsFromFrames(frames);
}

/** Same computation as `getThemeBoardCounts`, from an already-loaded frames object. */
export function themeBoardCountsFromFrames(frames: Record<string, string[]> | undefined | null): {
  hasBoards: boolean;
  boardCount: number;
} {
  const boardCount = frames ? Object.keys(frames).length : 0;
  return { hasBoards: boardCount > 0, boardCount };
}

/** Delete a saved theme, including sidecars created by legacy releases. */
export async function deleteTheme(globalStorageUri: ThemeStorageRoot, themeId: string): Promise<void> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');
  const store = resolveThemeFileStore(globalStorageUri);

  const targets: Array<{ path: string; recursive: boolean }> = [
    { path: themeDirectoryPath(themeId), recursive: true },
    { path: legacyManifestPath(themeId), recursive: false },
    { path: legacyFramesPath(themeId), recursive: false },
    { path: legacyPlanPath(themeId), recursive: false },
    { path: legacyReviewPath(themeId), recursive: false },
    { path: legacyImageReviewPath(themeId), recursive: false },
    { path: legacyImagesDirectoryPath(themeId), recursive: true },
  ];

  for (const target of targets) {
    try {
      await store.remove(target.path, { recursive: target.recursive });
    } catch (error) {
      if ((error as { code?: string } | undefined)?.code !== 'FileNotFound') throw error;
    }
  }
}

/**
 * Package a saved theme and all of its retained assets into a portable zip.
 * Thin wrapper: resolve this extension's ThemeFileStore and delegate the
 * actual (host-framework-free) logic to themeArchiveOps.ts, which the standalone
 * host also calls directly via its own fs-backed store.
 */
export async function exportThemeArchive(globalStorageUri: ThemeStorageRoot, themeId: string): Promise<Uint8Array> {
  const store = resolveThemeFileStore(globalStorageUri);
  return exportThemeArchiveFromStore(store, themeId);
}

export function readThemeArchive(data: Uint8Array): ThemeArchiveContents {
  return parseThemeArchive(data);
}

/**
 * Validate and install a theme archive. Existing themes require explicit
 * replacement. Thin wrapper: resolve this extension's ThemeFileStore and
 * delegate the actual (host-framework-free) logic to themeArchiveOps.ts.
 */
export async function importThemeArchive(
  globalStorageUri: ThemeStorageRoot,
  data: Uint8Array | ThemeArchiveContents,
  replace = false,
): Promise<{ theme_id: string; display_name: string; replaced: boolean }> {
  const store = resolveThemeFileStore(globalStorageUri);
  return importThemeArchiveToStore(store, data, replace);
}

// Console-only diagnostic fired on every loadTheme() call (a hot path used far
// beyond the health-check button), so it intentionally does NOT load the
// review document to gate "no frames" issues by acceptance status — that
// would add an extra fs read to every theme load for a log-only path. The
// user-facing RUN_THEME_HEALTH_CHECK handler (panel.ts) is the generation-aware
// version and already passes acceptedFrameKeys from the loaded review doc; this
// console path stays best-effort/ungated as before.
function logThemeIntegrityIssues(themeId: string, manifest: ThemeManifest, frames: Record<string, string[]>): void {
  try {
    const issues = validateThemeIntegrity(manifest, frames);
    for (const issue of issues) {
      const logger = issue.severity === 'error' ? console.error : console.warn;
      logger(`[theme-health] TycoonAgents: ${themeId}: ${issue.message}`);
    }
  } catch (error) {
    console.warn(`[theme-health] TycoonAgents: failed to validate theme integrity for ${themeId}:`, error);
  }
}

export async function loadTheme(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> } | undefined> {
  const store = resolveThemeFileStore(globalStorageUri);
  const modernManifest = await readJson<ThemeManifest>(store, themeManifestPath(themeId));
  const modernFrames = await readJson<Record<string, string[]>>(store, themeFramesPath(themeId));
  if (modernManifest && modernFrames) {
    const { manifest: upgradedModern } = upgradeThemeManifest(modernManifest);
    logThemeIntegrityIssues(themeId, upgradedModern, modernFrames);
    return { manifest: upgradedModern, frames: modernFrames };
  }

  const legacyManifest = await readJson<ThemeManifest>(store, legacyManifestPath(themeId));
  const legacyFrames = await readJson<Record<string, string[]>>(store, legacyFramesPath(themeId));
  if (legacyManifest && legacyFrames) {
    const { manifest: upgradedLegacy } = upgradeThemeManifest(legacyManifest);
    logThemeIntegrityIssues(themeId, upgradedLegacy, legacyFrames);
    return { manifest: upgradedLegacy, frames: legacyFrames };
  }
  return undefined;
}

export async function saveThemeTuning(
  globalStorageUri: ThemeStorageRoot,
  tuning: {
    theme_id: string;
    walkable_nav_polygon: [number, number][];
    character_scale: number;
    object_scale: number;
    character_scale_overrides: Record<string, number>;
    object_scale_overrides: Record<string, number>;
    object_anchor_overrides?: Record<string, [number, number]>;
    decor_anchor_overrides?: Record<string, [number, number]>;
    decor_flip_overrides?: Record<string, boolean>;
    object_flip_overrides?: Record<string, boolean>;
    decor_hidden?: string[];
    overall_scale?: number;
    enemy_config?: EnemyConfig;
    rival_scale?: number;
    rival_scale_overrides?: Record<string, number>;
    decor_scale?: number;
    decor_scale_overrides?: Record<string, number>;
  },
): Promise<boolean> {
  try {
    const loaded = await loadTheme(globalStorageUri, tuning.theme_id);
    if (!loaded) return false;
    const { manifest, frames } = loaded;
    manifest.viewport.walkable_nav_polygon = tuning.walkable_nav_polygon;
    manifest.viewport.character_scale = tuning.character_scale;
    manifest.viewport.object_scale = tuning.object_scale;
    manifest.viewport.character_scale_overrides = tuning.character_scale_overrides;
    manifest.viewport.object_scale_overrides = tuning.object_scale_overrides;
    // Position overrides set by the Stage Editor. Keep only well-formed
    // id -> [x, y] entries; the [-1,-1] sentinel (hidden decor) is preserved.
    const sanitizeAnchors = (raw: unknown): Record<string, [number, number]> | undefined => {
      if (!raw || typeof raw !== 'object') return undefined;
      const out: Record<string, [number, number]> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(v) && v.length >= 2 && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))) {
          out[k] = [Number(v[0]), Number(v[1])];
        }
      }
      return out;
    };
    const objAnchors = sanitizeAnchors(tuning.object_anchor_overrides);
    if (objAnchors) manifest.viewport.object_anchor_overrides = objAnchors;
    const decorAnchors = sanitizeAnchors(tuning.decor_anchor_overrides);
    if (decorAnchors) manifest.viewport.decor_anchor_overrides = decorAnchors;
    // Horizontal-flip overrides set by the Stage Editor. Keep only entries
    // that are strictly `true`; drop `false`/non-boolean values.
    const sanitizeFlips = (raw: unknown): Record<string, boolean> | undefined => {
      if (!raw || typeof raw !== 'object') return undefined;
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v === true) out[k] = true;
      }
      return out;
    };
    const decorFlips = sanitizeFlips(tuning.decor_flip_overrides);
    if (decorFlips) manifest.viewport.decor_flip_overrides = decorFlips;
    const objFlips = sanitizeFlips(tuning.object_flip_overrides);
    if (objFlips) manifest.viewport.object_flip_overrides = objFlips;
    // Non-destructive HIDE list for decor, set by the Stage Editor's H hotkey
    // / Hide button. Keep only well-formed string ids.
    if (Array.isArray(tuning.decor_hidden)) {
      manifest.viewport.decor_hidden = tuning.decor_hidden.filter((id): id is string => typeof id === 'string');
    }
    if (tuning.overall_scale !== undefined) {
      const overall = Number(tuning.overall_scale);
      if (Number.isFinite(overall) && overall > 0) {
        manifest.viewport.overall_scale = overall;
      }
    }
    if (tuning.rival_scale !== undefined) {
      const rival = Number(tuning.rival_scale);
      if (Number.isFinite(rival) && rival > 0) {
        manifest.viewport.rival_scale = rival;
      }
    }
    if (tuning.rival_scale_overrides && typeof tuning.rival_scale_overrides === 'object') {
      manifest.viewport.rival_scale_overrides = tuning.rival_scale_overrides;
    }
    if (tuning.decor_scale !== undefined) {
      const decor = Number(tuning.decor_scale);
      if (Number.isFinite(decor) && decor > 0) {
        manifest.viewport.decor_scale = decor;
      }
    }
    if (tuning.decor_scale_overrides && typeof tuning.decor_scale_overrides === 'object') {
      manifest.viewport.decor_scale_overrides = tuning.decor_scale_overrides;
    }
    if (tuning.enemy_config && typeof tuning.enemy_config === 'object') {
      const sanitized: EnemyConfig = { ...manifest.viewport.enemy_config };
      const interval = Number(tuning.enemy_config.spawn_interval_seconds);
      if (Number.isFinite(interval) && interval > 0) {
        sanitized.spawn_interval_seconds = interval;
      }
      if (tuning.enemy_config.count_mode === 'all' || tuning.enemy_config.count_mode === 'random') {
        sanitized.count_mode = tuning.enemy_config.count_mode;
      }
      manifest.viewport.enemy_config = sanitized;
    }
    await writeThemeFiles(globalStorageUri, manifest, frames);
    return true;
  } catch {
    return false;
  }
}

export async function replaceThemeBackground(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  imageBytes: Uint8Array,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> } | undefined> {
  try {
    const loaded = await loadTheme(globalStorageUri, themeId);
    if (!loaded) return undefined;
    const { manifest, frames } = loaded;
    frames["environment_background"] = [dataUri(Buffer.from(imageBytes))];
    await writeThemeFiles(globalStorageUri, manifest, frames);
    return { manifest, frames };
  } catch {
    return undefined;
  }
}

/**
 * Uploads a user-supplied image to replace a theme's review/manifest asset.
 *
 * Reuses the same item resolver as `retryThemeImage`/`normalizeThemeCharacterAtlas`:
 * the saved `ThemeImageReviewDocument` is loaded and the item's `kind` decides
 * whether the image is sliced as a multi-frame character/rival atlas or stored
 * as a single image (background/object/badge/etc.).
 */
export async function uploadThemeImage(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  itemId: string,
  imageBytes: Uint8Array,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> } | undefined> {
  try {
    const loaded = await loadTheme(globalStorageUri, themeId);
    if (!loaded) return undefined;
    const { manifest, frames } = loaded;

    const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
    const item = document?.items.find((candidate) => candidate.id === itemId);
    const buffer = Buffer.from(imageBytes);
    let output: Buffer = buffer;
    let frameKeys = item?.frame_keys ?? [];

    if (item?.kind === 'character_atlas') {
      const characterAtlas = await processCharacterAtlas(buffer, manifest, item.body_plan ?? 'biped');
      output = characterAtlas.output;
      const spritePackage = characterAtlas.spritePackage;
      const frameKey = item.frame_keys[0] || item.id;
      frames[frameKey] = spritePackage.slots.map((slot) => slot.data);
      frameKeys = [frameKey];
    } else if (item?.kind === 'rival_atlas') {
      const rows = rivalRowsForItem(item, manifest);
      const rivalAtlas = await processRivalAtlas(buffer, manifest, rows);
      output = rivalAtlas.output;
      frameKeys = applyRivalBoardFrames(frames, rivalAtlas.spritePackage.slots, rows);
    } else if (item?.kind === 'object_atlas' && item.object_rows?.length) {
      const objectAtlas = await processObjectAtlas(buffer, manifest, item.object_rows);
      output = objectAtlas.output;
      frameKeys = applyObjectBoardFrames(frames, objectAtlas.spritePackage.slots, item.object_rows);
    } else if (item?.kind === 'object_atlas') {
      output = await optimizeSpriteBoardCanvas(buffer, 4, 3);
      const spritePackage = await sliceAndNormalizeAtlas(output, manifest, { columns: 4, rows: 3 });
      // Prefer the CURRENT manifest's object roster over the item's saved legacy
      // specs, so an upload against a theme whose roster changed slices/labels
      // frames against the current objects instead of a stale saved set.
      const manifestObjectSpecs = themeObjectSpecs(manifest).slice(0, 12);
      const specs = manifestObjectSpecs.length
        ? manifestObjectSpecs
        : (item.object_specs?.length ? item.object_specs : []);
      frameKeys = applyLegacyObjectFrames(frames, spritePackage.slots, specs);
    } else if (item?.kind === 'background_decor_atlas') {
      const rows = decorRowsForItem(item, manifest);
      const decorAtlas = await processDecorAtlas(buffer, manifest);
      output = decorAtlas.output;
      frameKeys = applyDecorBoardFrames(frames, decorAtlas.spritePackage.slots, rows);
      manifest.viewport.projectile_asset = 'frames.json#projectile';
    } else {
      const frameKey = item?.frame_keys[0] || itemId;
      frames[frameKey] = [dataUri(buffer)];
      frameKeys = [frameKey];
    }

    if (item && document) {
      const store = resolveThemeFileStore(globalStorageUri);
      const reviewDirectoryPath = themeImagesDirectoryPath(themeId);
      await store.mkdirp(reviewDirectoryPath);
      await store.writeFile(`${reviewDirectoryPath}/${item.filename}`, output);
      // Keep the raw pre-slice atlas so this board can be re-sliced later without regenerating.
      await persistRawAtlas(globalStorageUri, themeId, item.filename, buffer);
      await upsertThemeImageReviewItem(globalStorageUri, themeId, document.display_name, {
        ...item,
        status: 'pending',
        generation_error: undefined,
        revision: item.revision + 1,
        frame_keys: frameKeys,
        updated_at: new Date().toISOString(),
      });
    }

    // Merge-safe write (see writeThemeFiles): scope the frames.json write to
    // just the keys this upload owns, so it can't revert a concurrently
    // in-flight board retry's already-saved frames for other keys.
    await writeThemeFiles(globalStorageUri, manifest, frames, [
      ...new Set([...frameKeys, ...(item?.frame_keys ?? [])]),
    ]);
    return { manifest, frames };
  } catch {
    return undefined;
  }
}

/** The bundled starter theme preferred when no user theme is installed. */
export const DEFAULT_THEME_ID = 'survivors_vs_zombies';

/**
 * theme_ids shipped under `media/themes/` and seeded on first run. Declared
 * here rather than imported from bundledThemeSeeds.ts because that module
 * imports 'vscode' and themeService.ts must stay require-able from a bare
 * Node process. Keep in sync with the directories under media/themes/.
 */
export const BUNDLED_THEME_IDS: readonly string[] = [DEFAULT_THEME_ID];

/**
 * Load the theme to show by default, in order: (1) the user's own themes —
 * anything not in BUNDLED_THEME_IDS — by newest manifest mtime, so a
 * user-generated theme always wins even when the bundled seed was written
 * later; (2) DEFAULT_THEME_ID when installed, so a fresh install opens on a
 * real stage; (3) newest mtime over whatever remains.
 */
export async function loadLatestTheme(
  globalStorageUri: ThemeStorageRoot,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> } | undefined> {
  const store = resolveThemeFileStore(globalStorageUri);
  const allThemes = await listThemes(globalStorageUri);

  const userThemes = allThemes.filter((t) => !BUNDLED_THEME_IDS.includes(t.theme_id));
  if (userThemes.length === 0 && allThemes.some((t) => t.theme_id === DEFAULT_THEME_ID)) {
    const preferred = await loadTheme(globalStorageUri, DEFAULT_THEME_ID);
    if (preferred) return preferred;
  }
  const themes = userThemes.length > 0 ? userThemes : allThemes;

  let newestId: string | undefined;
  let newestMtime = -1;
  for (const theme of themes) {
    let mtime = 0;
    try {
      mtime = (await store.stat(themeManifestPath(theme.theme_id))).mtimeMs;
    } catch {
      try {
        mtime = (await store.stat(legacyManifestPath(theme.theme_id))).mtimeMs;
      } catch {
        continue;
      }
    }
    if (mtime > newestMtime) {
      newestMtime = mtime;
      newestId = theme.theme_id;
    }
  }
  return newestId ? loadTheme(globalStorageUri, newestId) : undefined;
}

async function loadThemeManifest(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
): Promise<ThemeManifest | undefined> {
  const store = resolveThemeFileStore(globalStorageUri);
  return (await readJson<ThemeManifest>(store, themeManifestPath(themeId)))
    ?? (await readJson<ThemeManifest>(store, legacyManifestPath(themeId)));
}

/**
 * Regenerating an existing theme must not clobber Stage Editor viewport tuning
 * the user has already dialed in. Carry forward each of these fields from the
 * OLD manifest's viewport onto the freshly generated one, but only when the old
 * value is present and the new manifest doesn't already carry an explicit value.
 * Mutates `newViewport` in place.
 */
function preserveViewportTuning(newViewport: ViewportConfig, oldViewport: ViewportConfig | undefined): void {
  if (!oldViewport) return;
  newViewport.character_scale = oldViewport.character_scale ?? newViewport.character_scale;
  newViewport.object_scale = oldViewport.object_scale ?? newViewport.object_scale;
  newViewport.character_scale_overrides = oldViewport.character_scale_overrides ?? newViewport.character_scale_overrides;
  newViewport.object_scale_overrides = oldViewport.object_scale_overrides ?? newViewport.object_scale_overrides;
  newViewport.object_anchor_overrides = oldViewport.object_anchor_overrides ?? newViewport.object_anchor_overrides;
  newViewport.decor_anchor_overrides = oldViewport.decor_anchor_overrides ?? newViewport.decor_anchor_overrides;
  newViewport.decor_flip_overrides = oldViewport.decor_flip_overrides ?? newViewport.decor_flip_overrides;
  newViewport.object_flip_overrides = oldViewport.object_flip_overrides ?? newViewport.object_flip_overrides;
  newViewport.decor_hidden = oldViewport.decor_hidden ?? newViewport.decor_hidden;
  newViewport.enemy_config = oldViewport.enemy_config ?? newViewport.enemy_config;
}

/**
 * Resolve a ThemeFileHandle for `relativePath` via the store's optional
 * `resolveHandle`. Every store the real extension ever configures
 * (createVscodeThemeFileStore) implements this; only asserted non-null here
 * because ThemeFileStore's interface keeps it optional for implementations
 * (e.g. a future standalone adapter) that have no such consumer.
 */
function resolveFileHandle(store: ThemeFileStore, relativePath: string): ThemeFileHandle {
  if (!store.resolveHandle) {
    throw new Error('TycoonAgents: the active ThemeFileStore does not support resolveHandle().');
  }
  return store.resolveHandle(relativePath);
}

/** Return retained originals, reconstructing legacy review boards if needed. */
export async function ensureThemeReviewImages(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
): Promise<ThemeReviewImages> {
  const store = resolveThemeFileStore(globalStorageUri);
  const directoryPath = themeImagesDirectoryPath(themeId);
  await store.mkdirp(directoryPath);
  const existingImages = await listReviewImageUris(store, directoryPath);
  if (existingImages.length > 0) {
    return { directoryUri: resolveFileHandle(store, directoryPath), imageUris: existingImages, recovered: false };
  }

  const legacyDirectoryPath = legacyImagesDirectoryPath(themeId);
  try {
    const legacyImages = await listReviewImageUris(store, legacyDirectoryPath);
    if (legacyImages.length > 0) {
      return {
        directoryUri: resolveFileHandle(store, legacyDirectoryPath),
        imageUris: legacyImages,
        recovered: false,
      };
    }
  } catch {
    // No legacy review directory.
  }

  const loaded = await loadTheme(globalStorageUri, themeId);
  if (loaded) {
    try {
      // Prefer board-shaped recovery: when this theme has a manifest + a
      // saved plan, rebuild the SAME board contract a generated theme would
      // show (one magenta sprite sheet per character/rival/object/decor
      // board, matching frame_slots/edit menus) instead of one loose
      // transparent atlas per frame key. Falls through to the old per-key
      // recovery below for any theme without a usable plan (pre-plan
      // legacy themes keep their previous behavior unchanged).
      const boardRecovered = await recoverBoardAlignedReviewImages(globalStorageUri, themeId, loaded);
      if (boardRecovered) {
        for (const file of boardRecovered.files) {
          await store.writeFile(`${directoryPath}/${file.filename}`, file.data);
        }
        // Only the frame keys NOT owned by any board in the current contract
        // (e.g. stale data from a superseded/legacy shape) fall back to a
        // loose per-key atlas, so nothing with a stored frame is silently
        // dropped from review even if it no longer maps to a board.
        const unmatchedFrames = Object.fromEntries(
          Object.entries(loaded.frames).filter(([key]) => !boardRecovered.knownKeys.has(key)),
        );
        const fallbackFiles = await recoverReviewImages(unmatchedFrames);
        for (const file of fallbackFiles) {
          await store.writeFile(`${directoryPath}/${file.filename}`, file.data);
        }
        // Only write review.json when none exists yet — if a review
        // document is already present (e.g. images were removed
        // out-of-band while accept/reject state survives), preserve the
        // user's existing statuses instead of clobbering them. Matches the
        // standalone guard in themeMessages.mjs's handleGetThemeImageReview.
        const existingReviewDoc = await loadThemeImageReviewDocument(globalStorageUri, themeId);
        if (!existingReviewDoc) {
          await initializeThemeImageReviewDocument(
            globalStorageUri,
            themeId,
            loaded.manifest.display_name,
            boardRecovered.items,
          );
        }
      } else {
        const recoveredFiles = await recoverReviewImages(loaded.frames);
        for (const file of recoveredFiles) {
          await store.writeFile(`${directoryPath}/${file.filename}`, file.data);
        }
      }
    } catch (err) {
      console.warn(`TycoonAgents: Could not recover review images for ${themeId}:`, err);
    }
  }
  return {
    directoryUri: resolveFileHandle(store, directoryPath),
    imageUris: await listReviewImageUris(store, directoryPath),
    recovered: true,
  };
}

/**
 * Board-aligned recovery helper for ensureThemeReviewImages: synthesizes the
 * CURRENT board contract for this manifest (createReviewItems — the same
 * source of truth full generation and per-board regeneration use, using the
 * theme's saved plan.json when one exists, or an all-defaults synthetic plan
 * otherwise — see the synthetic-plan comment below) and composes one board
 * PNG per item from the theme's stored frames.json data
 * (composeRecoveredBoardImages). Returns undefined only when createReviewItems
 * itself throws (e.g. a manifest whose rosters are too malformed to build a
 * board contract at all), telling the caller to fall back to the old per-key
 * recovery.
 */
async function recoverBoardAlignedReviewImages(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  loaded: { manifest: ThemeManifest; frames: Record<string, string[]> },
): Promise<{
  items: Array<Omit<ThemeImageReviewItem, 'updated_at'>>;
  files: RecoveredBoardFile[];
  knownKeys: Set<string>;
} | undefined> {
  try {
    // The board CONTRACT (ids/filenames/frame_keys) createReviewItems derives
    // is sourced from the MANIFEST's rosters (roster_agents/roster_rivals/
    // buildable_objects/decor_objects), not from the plan's text fields — the
    // plan only supplies prompt/description copy, which the review UI always
    // recomputes fresh from the CURRENT plan+manifest for display anyway (see
    // panel.ts's _postThemeImageReview currentPrompt) rather than trusting a
    // saved item.prompt. So a theme with a manifest but NO saved plan.json —
    // e.g. the bundled sample theme, which ships manifest.json+frames.json
    // only — still gets the full board-shaped recovery via a synthetic
    // all-defaults plan, instead of falling through to loose per-key atlases.
    const savedPlan = await loadCurrentThemePlan(globalStorageUri, themeId, loaded.manifest.display_name);
    const plan = savedPlan ?? normalizeThemePlan({}, loaded.manifest.display_name);
    const creativeDirection = themePlanCreativeDirection(plan);
    const items = createReviewItems(plan, loaded.manifest, creativeDirection);
    const files = await composeRecoveredBoardImages(items, loaded.frames);
    const knownKeys = new Set(items.flatMap((item) => item.frame_keys ?? []));
    return { items, files, knownKeys };
  } catch (err) {
    console.warn(`TycoonAgents: Could not synthesize board-aligned review for ${themeId}:`, err);
    return undefined;
  }
}

/**
 * Merge a freshly-synthesized `expected` review item into its `saved` counterpart
 * for DISPLAY: keep the saved item's generation state (status / revision / updated_at /
 * generation_error / filename / image association) but refresh the STRUCTURAL per-slot
 * metadata that drives the inline Names editor + prompt (label + object_rows / object_specs /
 * rival_rows / decor_rows / achievement_names / expression_names) from `expected`, which is
 * built from the CURRENT manifest/plan. Without this, a theme generated before the v2 object
 * board shape (or before these row fields existed) keeps stale/absent rows on disk, so the
 * Names editor shows nothing for its object/rival/decor boards even though the current
 * manifest defines every slot. Each field is only overridden when `expected` actually
 * carries it (so a board kind that has no such field is never wiped). Exported for unit testing.
 */
export function refreshSavedReviewItemMetadata(
  saved: ThemeImageReviewItem,
  expected: Omit<ThemeImageReviewItem, 'updated_at'>,
): ThemeImageReviewItem {
  return {
    ...saved,
    label: expected.label,
    ...(expected.object_rows !== undefined ? { object_rows: expected.object_rows } : {}),
    ...(expected.object_specs !== undefined ? { object_specs: expected.object_specs } : {}),
    ...(expected.rival_rows !== undefined ? { rival_rows: expected.rival_rows } : {}),
    ...(expected.decor_rows !== undefined ? { decor_rows: expected.decor_rows } : {}),
    ...(expected.achievement_names !== undefined ? { achievement_names: expected.achievement_names } : {}),
    ...(expected.achievement_descriptions !== undefined ? { achievement_descriptions: expected.achievement_descriptions } : {}),
    ...(expected.expression_names !== undefined ? { expression_names: expected.expression_names } : {}),
    ...(expected.expression_descriptions !== undefined ? { expression_descriptions: expected.expression_descriptions } : {}),
  };
}

/**
 * Merge the freshly-synthesized `expected` board set (the CURRENT contract's
 * boards from createReviewItems) with the saved review items. Each expected
 * board keeps its saved generation state when a saved counterpart exists (via
 * refreshSavedReviewItemMetadata, which refreshes structural metadata without
 * downgrading status/revision/prompt), otherwise it becomes a pending
 * placeholder. Saved items whose id is NOT in the expected set are DROPPED:
 * they are orphans left over from a superseded board contract (e.g. an old
 * animated-objects board replaced by the v3 objects_02) and must never surface
 * as a stale review card.
 */
export function mergeExpectedReviewItems(
  expectedItems: Array<Omit<ThemeImageReviewItem, 'updated_at'>>,
  savedItems: ThemeImageReviewItem[],
): ThemeImageReviewItem[] {
  return expectedItems.map((expected) => {
    const saved = savedItems.find((candidate) => candidate.id === expected.id);
    return saved
      ? refreshSavedReviewItemMetadata(saved, expected)
      : { ...expected, updated_at: new Date(0).toISOString() };
  });
}

export async function getThemeImageReview(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
): Promise<ThemeImageReview> {
  const reviewImages = await ensureThemeReviewImages(globalStorageUri, themeId);
  const manifest = await loadThemeManifest(globalStorageUri, themeId);
  const displayName = manifest?.display_name ?? themeId;
  let document = await loadThemeImageReviewDocument(globalStorageUri, themeId);

  if (!document) {
    for (const imageUri of reviewImages.imageUris) {
      const filename = basename(imageUri);
      if (!filename) continue;
      const inferred = inferLegacyReviewItem(filename);
      if (inferred.kind === 'character_atlas' && manifest) matchLegacyCharacter(inferred, filename, manifest);
      document = await upsertThemeImageReviewItem(globalStorageUri, themeId, displayName, inferred);
    }
  }

  // Add the old emote board entry when reviewing a pre-plan theme. The old
  // buildable-objects entry is intentionally not synthesized: generated themes
  // already retain their static `objects` board or animated `objects_XX` boards.
  if (manifest && document) {
    if (!document.items.some((item) => item.id === 'emote_icons')
        && !document.items.some((item) => item.kind === 'expression_atlas')) {
      document = await upsertThemeImageReviewItem(globalStorageUri, themeId, displayName, {
        id: 'emote_icons',
        filename: 'emotes_atlas.png',
        label: 'Animated emotes',
        kind: 'emote_atlas',
        status: 'pending',
        prompt: '',
        revision: 0,
        frame_keys: [],
      });
    }
  }

  // Replace the saved review items with the FULL expected item set for this
  // theme's plan, so boards that were never generated still show up as
  // pending "placeholder" cards instead of being silently absent, AND boards
  // from a superseded contract no longer surface as stale cards. This is
  // display-time only: a saved item's generation STATE is preserved (never
  // downgraded to pending), but its per-slot row/name metadata is refreshed
  // from the current manifest/plan (see refreshSavedReviewItemMetadata) so the
  // Names editor reflects the live board shape; the on-disk review document is
  // left untouched. Only runs when a plan exists (so `expected` can be
  // synthesized) — plan-less legacy themes keep their saved items unchanged.
  let items = document?.items ?? [];
  if (manifest) {
    try {
      const store = resolveThemeFileStore(globalStorageUri);
      const savedPlan = (await readJson<ThemePlan>(store, themePlanPath(themeId)))
        ?? (await readJson<ThemePlan>(store, legacyPlanPath(themeId)));
      if (savedPlan) {
        const plan = normalizeThemePlan(savedPlan, manifest.display_name);
        if (plan.theme_id !== themeId) throw new Error('Saved plan does not match this theme.');
        const creativeDirection = themePlanCreativeDirection(plan);
        const expectedItems = createReviewItems(plan, manifest, creativeDirection);
        const savedItems = document?.items ?? [];
        // Show EXACTLY the current contract's boards. Saved boards whose id is
        // not in the current contract are dropped as orphans from a superseded
        // board contract, so no stale review card (e.g. an old animated-objects
        // board) lingers after the board layout changes.
        items = mergeExpectedReviewItems(expectedItems, savedItems);
      }
    } catch {
      // No usable saved plan for this theme (e.g. a very old theme, or a
      // mismatched/renamed plan) — fall back to saved items only.
    }
  }

  const imagesByFilename = new Map(reviewImages.imageUris.map((imageUri) => [basename(imageUri), imageUri]));
  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  return {
    theme_id: themeId,
    display_name: document?.display_name ?? displayName,
    creditsSpent: themeCreditsSpent(items),
    generation: document?.generation,
    entries: items.map((item) => {
      const imageUri = imagesByFilename.get(item.filename);
      // Backfill boardType onto the live payload regardless of what the
      // stored document carries (fresh, resumed, or a legacy document
      // predating this field) — boardTypeForItem is the single source of
      // truth, so the webview's cost line always resolves against the same
      // key the Theme Service was actually billed under (review fix).
      const itemWithBoardType: ThemeImageReviewItem = { ...item, boardType: boardTypeForItem(item) };
      return {
        item: itemWithBoardType,
        imageUri,
        generated: isThemeGenerationItemComplete(item, Boolean(imageUri), loadedTheme?.frames ?? {}),
      };
    }),
  };
}

/**
 * The set of frame keys whose owning board the user has ACCEPTED in review —
 * for src/extension/themeHealth.ts's generation-aware `acceptedFrameKeys`
 * gate (an accepted-but-frameless board must still be flagged; a
 * still-pending one must not).
 *
 * Deliberately sources each accepted board's keys from the CURRENT plan's
 * EXPECTED board contract (createReviewItems), NOT from the accepted item's
 * own saved `frame_keys` field. Reason: mergeExpectedReviewItems's display
 * merge (refreshSavedReviewItemMetadata) treats frame_keys as generation
 * state and never overwrites it from `expected` — correct for its own
 * purpose, but a LEGACY pre-review theme's inferred review item
 * (inferLegacyReviewItem, themeImageReviewState.ts) persists frame_keys: []
 * for every non-character board. If this function read the merged item's own
 * frame_keys, an accepted legacy object/expression/badge board would
 * contribute NO keys, permanently and silently suppressing its "no frames"
 * issue — reintroducing the 0.0.384 accepted-but-frameless bug for exactly
 * that population. Reading the EXPECTED keys instead is correct because they
 * are what that board is defined to own right now, independent of whatever
 * its saved item happened to persist historically.
 *
 * READ-ONLY: unlike getThemeImageReview, this never calls
 * upsertThemeImageReviewItem — it must not persist anything as a side effect
 * of a health check. No saved review document or no saved/normalizable plan
 * (very old / plan-less themes) falls back to each accepted saved item's own
 * frame_keys, mirroring getThemeImageReview's own no-plan fallback.
 */
export async function acceptedFrameKeysForHealthCheck(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
): Promise<Set<string>> {
  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  const savedItems = document?.items ?? [];
  const savedFrameKeysFallback = () =>
    new Set(
      savedItems
        .filter((item) => item.status === 'accepted')
        .flatMap((item) => item.frame_keys ?? []),
    );

  const manifest = await loadThemeManifest(globalStorageUri, themeId);
  if (!manifest) return savedFrameKeysFallback();

  try {
    const store = resolveThemeFileStore(globalStorageUri);
    const savedPlan = (await readJson<ThemePlan>(store, themePlanPath(themeId)))
      ?? (await readJson<ThemePlan>(store, legacyPlanPath(themeId)));
    if (!savedPlan) return savedFrameKeysFallback();
    const plan = normalizeThemePlan(savedPlan, manifest.display_name);
    if (plan.theme_id !== themeId) return savedFrameKeysFallback();

    const creativeDirection = themePlanCreativeDirection(plan);
    const expectedItems = createReviewItems(plan, manifest, creativeDirection);
    const expectedById = new Map(expectedItems.map((item) => [item.id, item]));
    const merged = mergeExpectedReviewItems(expectedItems, savedItems);

    const keys = new Set<string>();
    for (const item of merged) {
      if (item.status !== 'accepted') continue;
      const expected = expectedById.get(item.id);
      for (const key of expected?.frame_keys ?? item.frame_keys ?? []) keys.add(key);
    }
    return keys;
  } catch {
    return savedFrameKeysFallback();
  }
}

export async function updateThemeImageReviewStatus(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  itemId: string,
  status: ThemeImageReviewStatus,
): Promise<ThemeImageReviewDocument | undefined> {
  return setThemeImageReviewStatus(globalStorageUri, themeId, itemId, status);
}

/** Rename one agent or rival without changing its stable frame key. */
export async function renameThemeCharacter(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  itemId: string,
  requestedName: string,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> }> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');
  const characterName = requestedName.trim().replace(/\s+/g, ' ');
  if (!characterName) throw new Error('Enter a character name.');
  if (characterName.length > 80) throw new Error('Character names must be 80 characters or fewer.');

  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  const item = document?.items.find((candidate) => candidate.id === itemId);
  if (!document || !item) throw new Error('Review image metadata was not found.');
  if (item.kind !== 'character_atlas') throw new Error('Only character images can be renamed.');

  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) throw new Error('The saved theme is incomplete and cannot be renamed.');
  const { manifest, frames } = loadedTheme;
  const frameKey = item.frame_keys[0] || item.id;
  const agentMatch = /^agent_(\d+)$/.exec(frameKey);
  const agent = agentMatch
    ? manifest.roster_agents.find((candidate) => candidate.slot_id === Number(agentMatch[1]))
    : undefined;
  const rival = agent
    ? undefined
    : manifest.roster_rivals.find((candidate) => candidate.rival_id === frameKey || candidate.rival_id === item.id);
  const character = agent ?? rival;
  if (!character) throw new Error('The character linked to this image was not found.');

  const previousName = item.subject ?? item.label ?? character.name;
  character.name = characterName;
  item.label = characterName;
  item.subject = characterName;
  item.prompt = renameCharacterInPrompt(item.prompt, previousName, characterName);

  const renameStore = resolveThemeFileStore(globalStorageUri);
  const plan = (await readJson<ThemePlan>(renameStore, themePlanPath(themeId)))
    ?? (await readJson<ThemePlan>(renameStore, legacyPlanPath(themeId)));
  if (plan) {
    if (agent && Array.isArray(plan.characters)) {
      plan.characters[agent.slot_id] = characterName;
    } else if (rival && Array.isArray(plan.enemies)) {
      const rivalIndex = manifest.roster_rivals.indexOf(rival);
      if (rivalIndex >= 0) plan.enemies[rivalIndex] = characterName;
    }
    await renameStore.writeFile(themePlanPath(themeId), jsonBuffer(plan));
  }
  if (!item.prompt) {
    const direction = plan
      ? themePlanCreativeDirection(plan)
      : `Match the existing visual direction for ${manifest.display_name}.`;
    const description = agent
      ? (plan?.character_descriptions?.[agent.slot_id] ?? '').trim() || undefined
      : undefined;
    item.prompt = buildCharacterAtlasPrompt(direction, characterName, manifest.display_name, 'magenta', description);
  }

  await writeThemeFiles(globalStorageUri, manifest, frames);
  await upsertThemeImageReviewItem(globalStorageUri, themeId, document.display_name, {
    ...item,
    updated_at: new Date().toISOString(),
  });
  return { manifest, frames };
}

/** One row of the theme-review "Names" editor's batched Apply. */
export interface ThemeItemNameChange {
  item_kind: 'object' | 'decor' | 'character' | 'rival' | 'badge';
  id: string;
  name: string;
}

export interface ThemeItemNameChangeResult {
  applied: ThemeItemNameChange[];
  rejected: Array<{ item_kind: string; id: string; reason: string }>;
}

/**
 * Pure core of the theme-review "Names" editor's batched Apply: mutates
 * `manifest` in place, applying every valid change and collecting the rest as
 * rejections (unknown id, empty/whitespace name, name over 60 chars) without
 * touching the manifest for those. Kept manifest-only and side-effect-free
 * (no VS Code/file IO) so it's directly unit-testable — mirrors the
 * "manifest wins" policy objectRowsForItem/decorRowsForItem/rivalRowsForItem
 * already enforce for board regeneration prompts: every regenerate mode
 * (including 'retry'/'augment', as of the retryThemeImage fresh-base rebuild —
 * see selectThemeImageRetryPrompt) now reconstructs board rows/prompt from the
 * CURRENT manifest at generation time. The caller (renameThemeItemsBatch)
 * still resyncs the saved review-item prompt/rows right after this runs (see
 * resyncRenamedReviewItems) so the on-disk prompt/rows reflect the rename
 * immediately, without waiting for the next retry. Exported for unit testing.
 */
export function applyThemeItemNameChanges(
  manifest: ThemeManifest,
  changes: ThemeItemNameChange[],
): ThemeItemNameChangeResult {
  const applied: ThemeItemNameChange[] = [];
  const rejected: Array<{ item_kind: string; id: string; reason: string }> = [];
  for (const change of changes) {
    const name = (change.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) {
      rejected.push({ item_kind: change.item_kind, id: change.id, reason: 'Name is empty.' });
      continue;
    }
    if (name.length > 60) {
      rejected.push({ item_kind: change.item_kind, id: change.id, reason: 'Name is longer than 60 characters.' });
      continue;
    }
    if (change.item_kind === 'object') {
      const object = manifest.buildable_objects?.find((candidate) => candidate.object_id === change.id);
      if (!object) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown object "${change.id}".` });
        continue;
      }
      object.display_name = name;
    } else if (change.item_kind === 'decor') {
      const decor = manifest.decor_objects?.find((candidate) => candidate.decor_id === change.id);
      if (!decor) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown decor item "${change.id}".` });
        continue;
      }
      decor.display_name = name;
    } else if (change.item_kind === 'character') {
      const agentMatch = /^agent_(\d+)$/.exec(change.id);
      const agent = agentMatch
        ? manifest.roster_agents?.find((candidate) => candidate.slot_id === Number(agentMatch[1]))
        : undefined;
      if (!agent) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown character "${change.id}".` });
        continue;
      }
      agent.name = name;
    } else if (change.item_kind === 'rival') {
      // rival_rows sent by the webview carry rival_id with the `rival_` prefix
      // STRIPPED (see themeRivalSpecs, which strips it so frame keys built as
      // `rival_<id>` don't double-prefix), but manifest.roster_rivals[].rival_id
      // keeps the full prefixed id (see themePlan.ts). Match either form so a
      // rename lands regardless of which shape the id arrives in.
      const rival = manifest.roster_rivals?.find((candidate) => (
        candidate.rival_id === change.id || candidate.rival_id === `rival_${change.id}`
      ));
      if (!rival) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown rival "${change.id}".` });
        continue;
      }
      rival.name = name;
    } else if (change.item_kind === 'badge') {
      // Badge slots are positional: rowId is `achievement_<index>` (see themeReviewNameRows).
      // manifest.badges carry the universal default labels; set this theme's badge label to the
      // themed name here, and mirror it into plan.achievements in resyncRenamedBoardPrompts (the
      // themed source of truth) so it survives reopen and the achievement-icon prompt.
      const badgeMatch = /^achievement_(\d+)$/.exec(change.id);
      const badgeIndex = badgeMatch ? Number(badgeMatch[1]) : -1;
      const badge = badgeIndex >= 0 ? manifest.badges?.[badgeIndex] : undefined;
      if (!badge) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown badge "${change.id}".` });
        continue;
      }
      badge.display_name = name;
    } else {
      rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown item kind "${change.item_kind}".` });
      continue;
    }
    applied.push({ item_kind: change.item_kind, id: change.id, name });
  }
  return { applied, rejected };
}

/**
 * Thin IO wrapper around applyThemeItemNameChanges: loads the theme once,
 * applies the whole batch, writes once. Rename affordance for the theme
 * review screen's per-board "Names" editor — buildable-object, decor, and
 * rival display names have no per-row image-review entry of their own; they
 * live inside a whole-board item's object_rows/decor_rows/rival_rows. Every
 * regenerate mode rebuilds its prompt fresh from the CURRENT manifest at
 * generation time (see buildReplacementPrompt and retryThemeImage's
 * freshBasePrompt), so a rename is picked up on the very next retry either
 * way — but this still calls resyncRenamedBoardPrompts after the manifest
 * write so the saved review-item prompt/rows reflect the rename immediately,
 * for anything that reads them before the next generation (e.g. the review
 * screen's "view prompt" display). Character changes mirror what
 * renameThemeCharacter does to the manifest (agent.name), but skip that
 * resync — the review screen's existing single-character rename flow
 * (RENAME_THEME_CHARACTER) still owns that fuller semantics for character
 * boards.
 */
export async function renameThemeItemsBatch(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  changes: ThemeItemNameChange[],
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]>; result: ThemeItemNameChangeResult }> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');
  if (!changes.length) throw new Error('No name changes were provided.');

  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) throw new Error('The saved theme is incomplete and cannot be renamed.');
  const { manifest, frames } = loadedTheme;

  const result = applyThemeItemNameChanges(manifest, changes);
  if (result.applied.length) {
    await writeThemeFiles(globalStorageUri, manifest, frames);
    // Refresh the SAVED review-item prompt/rows for every board a renamed row
    // belongs to, so a later 'retry'/'augment' regeneration (which replays the
    // saved prompt verbatim/appended, not a fresh rebuild) draws the new name
    // instead of the one baked into the stale saved prompt. See
    // resyncRenamedReviewItems for the full rationale.
    await resyncRenamedBoardPrompts(globalStorageUri, themeId, manifest, result.applied);
  }
  return { manifest, frames, result };
}

/**
 * Pure core of SET_THEME_OBJECT_TURRET: flips ONE buildable object's
 * manifest `is_turret` flag in place. Phase 2 groundwork only — this task
 * (p2-t1) is opt-in MARKING; nothing auto-fires yet. Mirrors
 * applyThemeItemNameChanges's shape (manifest-only, no IO, directly
 * unit-testable) but for a single boolean field on a single object instead
 * of a batched rename. An unknown object_id is a silent no-op (returns
 * false) rather than throwing — matches the additive/opt-in contract: a
 * stale/removed id from the webview should never crash the write path.
 * Exported for unit testing.
 */
export function applyThemeObjectTurretFlag(
  manifest: ThemeManifest,
  objectId: string,
  isTurret: boolean,
): boolean {
  const object = manifest.buildable_objects?.find((candidate) => candidate.object_id === objectId);
  if (!object) return false;
  object.is_turret = !!isTurret;
  return true;
}

/**
 * Thin IO wrapper around applyThemeObjectTurretFlag: loads the theme once,
 * flips the flag, writes once. Backs the theme review screen's per-animated-
 * object "Acts as turret" checkbox (SET_THEME_OBJECT_TURRET — see panel.ts).
 * Unlike renameThemeItemsBatch this is single-object and not batched, and
 * needs no resyncRenamedBoardPrompts: is_turret never appears in an image
 * prompt, so no saved review prompt/rows go stale from this write.
 */
export async function setThemeObjectTurret(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  objectId: string,
  isTurret: boolean,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]>; changed: boolean }> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');
  if (!objectId) throw new Error('Object ID is required.');

  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) throw new Error('The saved theme is incomplete and cannot be updated.');
  const { manifest, frames } = loadedTheme;

  const changed = applyThemeObjectTurretFlag(manifest, objectId, isTurret);
  if (changed) {
    await writeThemeFiles(globalStorageUri, manifest, frames);
  }
  return { manifest, frames, changed };
}

/**
 * Restore every badge's canonical default TITLE (buildDefaultBadges
 * display_name, matched by badge_id) while PRESERVING any custom title the user
 * typed: before overwriting a changed title, if that badge has no appearance
 * description yet, the current custom title is moved into
 * plan.achievement_descriptions[idx] so it still drives the badge ART
 * (buildAchievementAtlasPrompt). This fixes the failure mode where a user typed
 * appearance text into the badge NAME (which both titled the badge AND drew its
 * art), breaking the titles. Reuses the rename path's persistence + resync
 * (writeThemeFiles + resyncRenamedBoardPrompts) so the achievement board
 * prompt/review refresh exactly as a batched badge rename would. Returns the
 * loaded manifest/frames plus the count of badges reset.
 */
/**
 * Pure core of resetThemeBadgeNames: mutates `manifest` (badge display_names)
 * and `plan` (achievements + achievement_descriptions) in place, restoring every
 * badge whose title drifted from its canonical default (buildDefaultBadges,
 * matched by badge_id) while PRESERVING the custom title by moving it into that
 * badge's appearance description — but only when the description is empty, so an
 * existing appearance spec is never clobbered. Side-effect-free (no IO) so it's
 * directly unit-testable. Returns the applied badge name changes (id
 * `achievement_<index>`) for the caller's resync; an empty array means every
 * badge was already at its canonical title (nothing to persist). Exported for
 * unit testing.
 */
export function applyBadgeNameReset(
  manifest: ThemeManifest,
  plan: ThemePlan,
): ThemeItemNameChange[] {
  const canonicalByBadgeId = new Map(buildDefaultBadges().map((badge) => [badge.badge_id, badge.display_name]));
  const applied: ThemeItemNameChange[] = [];
  const badges = manifest.badges ?? [];
  for (let idx = 0; idx < badges.length; idx += 1) {
    const badge = badges[idx];
    if (!badge) continue;
    const canonical = canonicalByBadgeId.get(badge.badge_id);
    // Only reset badges the user actually renamed away from their canonical title.
    if (!canonical || badge.display_name === canonical) continue;
    // Preserve the user's typed appearance text: only backfill the description
    // when it's empty, so a real description already present is never clobbered.
    const existing = (plan.achievement_descriptions?.[idx] ?? '').trim();
    if (!existing) {
      plan.achievement_descriptions = setPlanDescriptionAt(plan.achievement_descriptions, idx, badge.display_name);
    }
    badge.display_name = canonical;
    if (idx < plan.achievements.length) plan.achievements[idx] = canonical;
    applied.push({ item_kind: 'badge', id: `achievement_${idx}`, name: canonical });
  }
  return applied;
}

export async function resetThemeBadgeNames(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]>; changed: number }> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');

  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) throw new Error('The saved theme is incomplete and cannot be updated.');
  const { manifest, frames } = loadedTheme;

  const badgeStore = resolveThemeFileStore(globalStorageUri);
  const savedPlan = (await readJson<ThemePlan>(badgeStore, themePlanPath(themeId)))
    ?? (await readJson<ThemePlan>(badgeStore, legacyPlanPath(themeId)));
  if (!savedPlan) throw new Error('This theme has no saved plan — badge names require plan.json.');
  const plan = normalizeThemePlan(savedPlan, manifest.display_name);
  if (plan.theme_id !== themeId) throw new Error('Saved plan does not match this theme.');

  const applied = applyBadgeNameReset(manifest, plan);

  if (applied.length) {
    // Persist the plan (migrated appearance text + canonical achievements) BEFORE
    // the resync, which reloads plan.json from disk to rebuild the board prompt.
    await badgeStore.writeFile(themePlanPath(themeId), jsonBuffer(plan));
    await writeThemeFiles(globalStorageUri, manifest, frames);
    await resyncRenamedBoardPrompts(globalStorageUri, themeId, manifest, applied);
  }
  return { manifest, frames, changed: applied.length };
}

/** One row of the theme-review "Descriptions" editor's batched Apply.
 * 'character' IS included (unlike the Names editor, which intentionally leaves
 * character boards to RENAME_THEME_CHARACTER). 'crate' and 'poof' address the
 * single required build-crate / build-poof rows (object board 2) —
 * description-only, id is not looked up against any roster (there is exactly one
 * of each per theme). 'badge' writes plan.achievement_descriptions[idx]
 * (positional, id `achievement_<index>`) — the badge's appearance field, kept
 * separate from its display-name/title. */
export interface ThemeItemDescriptionChange {
  item_kind: 'object' | 'decor' | 'character' | 'rival' | 'crate' | 'poof' | 'projectile' | 'badge' | 'expression' | 'environment';
  id: string;
  description: string;
  /**
   * 'character' and 'rival' rows only (p58-t2): explicit user-set body plan for this
   * roster slot or rival (plan.enemy_body_plans), from the webview's slot-edit payload (snake_case to match
   * the sibling `item_kind`/`description` wire fields). `undefined` leaves
   * the slot's stored body plan untouched — the webview sends `undefined`
   * (Reset to auto) explicitly when the user clears it, but a change entry
   * that never mentions body_plan at all also leaves it untouched. See
   * src/extension/themePlan.ts's `character_body_plans` and
   * src/core/bodyPlan.ts's inferBodyPlan for the fallback when unset.
   */
  body_plan?: 'biped' | 'quadruped';
}

export interface ThemeItemDescriptionChangeResult {
  applied: ThemeItemDescriptionChange[];
  rejected: Array<{ item_kind: string; id: string; reason: string }>;
}

/** Pad `list` (or start a new array) so index `index` exists, then set it. Never
 * mutates the input array in place — callers assign the return value back onto
 * the plan field, keeping `plan` safe to hand to multiple call sites. */
function setPlanDescriptionAt(list: string[] | undefined, index: number, value: string): string[] {
  const arr = list ? [...list] : [];
  while (arr.length <= index) arr.push('');
  arr[index] = value;
  return arr;
}

/** Same padding/set pattern as setPlanDescriptionAt, for the positional
 * character_body_plans array (p58-t2). */
function setPlanBodyPlanAt(
  list: Array<'biped' | 'quadruped' | undefined> | undefined,
  index: number,
  value: 'biped' | 'quadruped' | undefined,
): Array<'biped' | 'quadruped' | undefined> {
  const arr = list ? [...list] : [];
  while (arr.length <= index) arr.push(undefined);
  arr[index] = value;
  return arr;
}

/** Effective body plan for a character slot (p58-t2): the user-set
 * plan.character_body_plans[slotId] always wins; otherwise infer from the
 * slot's plan.character_descriptions[slotId] text. */
export function effectiveCharacterBodyPlan(plan: Pick<ThemePlan, 'character_body_plans' | 'character_descriptions'>, slotId: number): BodyPlan {
  const explicit = plan.character_body_plans?.[slotId];
  if (explicit === 'biped' || explicit === 'quadruped') return explicit;
  return inferBodyPlan(plan.character_descriptions?.[slotId]);
}

/** Effective body plan for a rival: the user-set plan.enemy_body_plans[index]
 * always wins; otherwise infer from the rival's name plus its description,
 * else two-legged. A plan with no enemy_body_plans at all means auto. */
export function effectiveRivalBodyPlan(
  explicit: BodyPlan | undefined,
  name: string,
  description: string | undefined,
): BodyPlan {
  if (explicit === 'biped' || explicit === 'quadruped') return explicit;
  return inferBodyPlan(`${name} ${description ?? ''}`);
}

/**
 * Pure core of the theme-review "Descriptions" editor's batched Apply: mutates
 * `plan` in place (never `manifest` — descriptions are prompt-layer text that
 * lives in plan.json's `character_descriptions` / `object_descriptions` /
 * `decor_descriptions` / `enemy_descriptions` arrays, or (for 'crate'/'poof')
 * the single `crate_description` / `poof_description` strings, NOT the shared
 * manifest contract; see applyThemeItemNameChanges for the contrasting
 * manifest-display-name path this deliberately does NOT follow). `manifest` is
 * read-only here, used only to resolve each row id to its positional index in
 * the matching plan array (object/decor/rival indices mirror
 * manifest.buildable_objects/decor_objects/roster_rivals order — see
 * themeObjectSpecs/themeDecorSpecs/themeRivalSpecs; character index is
 * the agent's slot_id, matching plan.character_descriptions[agent.slot_id] as read
 * in createReviewItems/buildCharacterAtlasPrompt).
 *
 * An empty (or whitespace-only) description is a valid, applied change — it CLEARS
 * that row's description, unlike applyThemeItemNameChanges which rejects an empty
 * name. Only an unknown id is rejected. Exported for unit testing.
 */
export function applyThemeItemDescriptionChanges(
  manifest: ThemeManifest,
  plan: ThemePlan,
  changes: ThemeItemDescriptionChange[],
): ThemeItemDescriptionChangeResult {
  const applied: ThemeItemDescriptionChange[] = [];
  const rejected: Array<{ item_kind: string; id: string; reason: string }> = [];
  for (const change of changes) {
    const description = (change.description ?? '').trim();
    if (change.item_kind === 'object') {
      const index = manifest.buildable_objects?.findIndex((candidate) => candidate.object_id === change.id) ?? -1;
      if (index < 0) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown object "${change.id}".` });
        continue;
      }
      plan.object_descriptions = setPlanDescriptionAt(plan.object_descriptions, index, description);
    } else if (change.item_kind === 'decor') {
      const index = manifest.decor_objects?.findIndex((candidate) => candidate.decor_id === change.id) ?? -1;
      if (index < 0) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown decor item "${change.id}".` });
        continue;
      }
      plan.decor_descriptions = setPlanDescriptionAt(plan.decor_descriptions, index, description);
    } else if (change.item_kind === 'rival') {
      // Same stripped/full rival_id matching as applyThemeItemNameChanges — the
      // webview's rival_rows carry the `rival_` prefix stripped (see themeRivalSpecs).
      const index = manifest.roster_rivals?.findIndex((candidate) => (
        candidate.rival_id === change.id || candidate.rival_id === `rival_${change.id}`
      )) ?? -1;
      if (index < 0) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown rival "${change.id}".` });
        continue;
      }
      plan.enemy_descriptions = setPlanDescriptionAt(plan.enemy_descriptions, index, description);
      // Same presence-means-touched rule as the character branch below.
      if (Object.prototype.hasOwnProperty.call(change, 'body_plan')) {
        plan.enemy_body_plans = setPlanBodyPlanAt(plan.enemy_body_plans, index, change.body_plan);
      }
    } else if (change.item_kind === 'character') {
      const agentMatch = /^agent_(\d+)$/.exec(change.id);
      const slotId = agentMatch ? Number(agentMatch[1]) : -1;
      const agent = slotId >= 0 ? manifest.roster_agents?.find((candidate) => candidate.slot_id === slotId) : undefined;
      if (!agent) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown character "${change.id}".` });
        continue;
      }
      plan.character_descriptions = setPlanDescriptionAt(plan.character_descriptions, agent.slot_id, description);
      // Only touch character_body_plans when the change actually carries a
      // body_plan key — the webview omits the key entirely for a
      // description-only edit (see themeService.ts's ThemeItemDescriptionChange
      // doc comment), and includes it (possibly as literal `undefined`, "Reset
      // to auto") only when the user's body-plan control changed.
      if (Object.prototype.hasOwnProperty.call(change, 'body_plan')) {
        plan.character_body_plans = setPlanBodyPlanAt(plan.character_body_plans, agent.slot_id, change.body_plan);
      }
    } else if (change.item_kind === 'badge') {
      // Badge/achievement descriptions are POSITIONAL: rowId is
      // `achievement_<index>` (see themeReviewDescriptionRows), aligning to
      // plan.achievement_descriptions[idx] / plan.achievements[idx]. Mirror the
      // object branch: pad the array to the badge index and set it.
      const badgeMatch = /^achievement_(\d+)$/.exec(change.id);
      const badgeIndex = badgeMatch ? Number(badgeMatch[1]) : -1;
      if (badgeIndex < 0 || badgeIndex >= THEME_ACHIEVEMENT_COUNT) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown badge "${change.id}".` });
        continue;
      }
      plan.achievement_descriptions = setPlanDescriptionAt(plan.achievement_descriptions, badgeIndex, description);
    } else if (change.item_kind === 'expression') {
      // Expression descriptions are POSITIONAL: rowId is `expression_<index>`
      // (see themeReviewDescriptionRows), aligning to
      // plan.expression_descriptions[idx] / plan.expressions[idx]. Mirror the
      // badge branch: pad the array to the expression index and set it. The
      // expression LABELS are fixed (FIXED_EXPRESSION_LABELS) and never edited;
      // only the per-cell appearance text lives here.
      const expressionMatch = /^expression_(\d+)$/.exec(change.id);
      const expressionIndex = expressionMatch ? Number(expressionMatch[1]) : -1;
      if (expressionIndex < 0 || expressionIndex >= THEME_EXPRESSION_COUNT) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: `Unknown expression "${change.id}".` });
        continue;
      }
      plan.expression_descriptions = setPlanDescriptionAt(plan.expression_descriptions, expressionIndex, description);
    } else if (change.item_kind === 'crate') {
      // Single field, not an indexed array — exactly one crate per theme.
      plan.crate_description = description;
    } else if (change.item_kind === 'poof') {
      // Single field, not an indexed array — exactly one poof per theme.
      plan.poof_description = description;
    } else if (change.item_kind === 'projectile') {
      // Single field, not an indexed array — exactly one ranged-combat projectile
      // per theme (background decor board, row 4 — see ThemeDecorBoardRow's
      // `projectile` kind, which carries no decor_id).
      plan.projectile_description = description;
    } else if (change.item_kind === 'environment') {
      // Single field, not an indexed array — exactly one environment per theme.
      // Unlike crate/poof/projectile (optional appearance specs), plan.environment
      // is REQUIRED (themePlan.ts's normalizeThemePlan falls back to a generated
      // default when blank, and themePlanCreativeDirection embeds it into every
      // board's "Environment direction" line) — so a blank edit here is rejected
      // rather than silently clearing it, unlike the other scalar description kinds.
      if (!description) {
        rejected.push({ item_kind: change.item_kind, id: change.id, reason: 'Environment description cannot be blank.' });
        continue;
      }
      plan.environment = description;
    } else {
      const unknownKind = (change as { item_kind: string }).item_kind;
      rejected.push({ item_kind: unknownKind, id: change.id, reason: `Unknown item kind "${unknownKind}".` });
      continue;
    }
    applied.push({ item_kind: change.item_kind, id: change.id, description });
  }
  return { applied, rejected };
}

/**
 * Pure core of the description-driven prompt resync — the "Descriptions" editor's
 * counterpart to resyncRenamedReviewItems. Unlike renaming, a character description
 * edit has NO other sync path (RENAME_THEME_CHARACTER only handles the character's
 * NAME), so character_atlas boards are included here — the one difference from
 * resyncRenamedReviewItems's affected-board detection, which deliberately excludes
 * them. Exported for unit testing.
 */
export function resyncDescriptionReviewItems(
  document: Pick<ThemeImageReviewDocument, 'items'>,
  manifest: ThemeManifest,
  plan: ThemePlan,
  applied: ThemeItemDescriptionChange[],
): ThemeImageReviewItem[] {
  const affectedIds = new Set(applied.map((change) => change.id));
  if (!affectedIds.size) return [];
  // crate/poof descriptions are single plan fields (not row-indexed), so they
  // always affect the fixed 'objects_02' board rather than a specific row id.
  const crateOrPoofChanged = applied.some((change) => change.item_kind === 'crate' || change.item_kind === 'poof');
  // Projectile description is likewise a single plan field (plan.projectile_description),
  // not a row-indexed one — the `projectile` decor row carries no decor_id (see
  // ThemeDecorBoardRow) so it can never match affectedIds by id below. Mirrors
  // crateOrPoofChanged: any projectile change always affects the single
  // 'background_decor' board.
  const projectileChanged = applied.some((change) => change.item_kind === 'projectile');
  // Badge descriptions are positional plan fields (achievement_<index>), so any
  // badge change affects the single fixed 'achievements' board rather than a
  // roster-matched row id.
  const badgeChanged = applied.some((change) => change.item_kind === 'badge');
  // Expression descriptions are positional plan fields (expression_<index>), so
  // any expression change affects the single fixed 'expressions' board rather
  // than a roster-matched row id (mirrors the badge/achievements case).
  const expressionChanged = applied.some((change) => change.item_kind === 'expression');
  // Environment description is a single plan field (plan.environment), not a
  // row-indexed one — mirrors crateOrPoofChanged/projectileChanged/badgeChanged.
  const environmentChanged = applied.some((change) => change.item_kind === 'environment');

  const affectedBoardIds = new Set<string>();
  if (environmentChanged) affectedBoardIds.add('environment');
  for (const item of document.items) {
    if (item.kind === 'object_atlas' && (item.object_rows?.some(
      (row) => (row.kind === 'object_static' || row.kind === 'object_anim') && affectedIds.has(row.object_id),
    ) || (crateOrPoofChanged && item.id === 'objects_02'))) {
      affectedBoardIds.add(item.id);
    } else if (item.kind === 'background_decor_atlas' && ((item.decor_rows?.some(
      (row) => row.kind !== 'projectile' && affectedIds.has(row.decor_id),
    )) || (projectileChanged && item.id === 'background_decor'))) {
      affectedBoardIds.add(item.id);
    } else if (item.kind === 'rival_atlas' && item.rival_rows?.some(
      (row) => affectedIds.has(row.rival_id) || affectedIds.has(`rival_${row.rival_id}`),
    )) {
      affectedBoardIds.add(item.id);
    } else if (item.kind === 'character_atlas' && affectedIds.has(item.id)) {
      affectedBoardIds.add(item.id);
    } else if (item.kind === 'achievement_atlas' && badgeChanged) {
      affectedBoardIds.add(item.id);
    } else if (item.kind === 'expression_atlas' && expressionChanged) {
      affectedBoardIds.add(item.id);
    }
  }
  if (!affectedBoardIds.size) return [];

  const expectedItems = createReviewItems(
    plan,
    manifest,
    themePlanCreativeDirection(plan),
    boardBackgroundModeForProvider(),
  ).filter((item) => affectedBoardIds.has(item.id));
  const savedItems = document.items.filter((item) => affectedBoardIds.has(item.id));

  return mergeResumedReviewItems(expectedItems, savedItems) as ThemeImageReviewItem[];
}

/**
 * Thin IO wrapper around applyThemeItemDescriptionChanges: loads the theme's
 * manifest (read-only, for id resolution) and its saved plan.json, applies the
 * batch, and writes ONLY the plan back — descriptions never touch the manifest
 * (contrast renameThemeItemsBatch, which writes the manifest). Mirrors the
 * badge-rename branch of resyncRenamedBoardPrompts (plan write + resync), never
 * the manifest-display-name path the rest of that function follows for object/
 * decor/character/rival renames.
 */
export async function updateThemeItemDescriptionsBatch(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  changes: ThemeItemDescriptionChange[],
): Promise<ThemeItemDescriptionChangeResult> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');
  if (!changes.length) throw new Error('No description changes were provided.');

  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) throw new Error('The saved theme is incomplete and cannot be updated.');
  const { manifest } = loadedTheme;

  const descriptionsStore = resolveThemeFileStore(globalStorageUri);
  const savedPlan = (await readJson<ThemePlan>(descriptionsStore, themePlanPath(themeId)))
    ?? (await readJson<ThemePlan>(descriptionsStore, legacyPlanPath(themeId)));
  // Older themes (pre-dating AI plans) were never given a plan.json. Rather
  // than fail the save, synthesize a minimal valid plan from the theme's own
  // manifest (display names, character/enemy/object/decor/badge names) via
  // manifestToPlanSeed, then run it through the same normalizeThemePlan every
  // other plan goes through — this invents no content beyond what the
  // manifest already has; every other field gets normalizeThemePlan's usual
  // defaults, exactly as it would for a sparse AI-authored plan.
  const plan = normalizeThemePlan(savedPlan ?? manifestToPlanSeed(manifest), manifest.display_name);
  if (plan.theme_id !== themeId) throw new Error('Saved plan does not match this theme.');

  const result = applyThemeItemDescriptionChanges(manifest, plan, changes);
  if (result.applied.length) {
    const planBuffer = jsonBuffer(plan);
    await descriptionsStore.writeFile(themePlanPath(themeId), planBuffer);
    // Mirror every plan write into plan.json.bak, same as the plan writer
    // elsewhere backs up manifest.json — cheap insurance against a corrupt/
    // interrupted write on a theme's first-ever plan.json.
    try {
      await descriptionsStore.writeFile(`${themePlanPath(themeId)}.bak`, planBuffer);
    } catch (err) {
      console.warn('TycoonAgents: unable to write plan.json.bak:', err);
    }
    try {
      const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
      if (document) {
        const refreshed = resyncDescriptionReviewItems(document, manifest, plan, result.applied);
        for (const item of refreshed) {
          await upsertThemeImageReviewItem(globalStorageUri, themeId, document.display_name, item);
        }
      }
    } catch (err) {
      console.warn('TycoonAgents: unable to resync review-board prompts after description change:', err);
    }
  }
  return result;
}

/**
 * Post-generation editor for the whole-theme creative-direction art seed
 * (ThemePlan.creative_direction — the string themePlanCreativeDirection()
 * threads into every board's image prompt). Loads the saved plan.json,
 * overwrites creative_direction with the trimmed input, and writes the plan
 * back. Unlike updateThemeItemDescriptionsBatch, no saved review-item prompt
 * resync is needed: a retry/regenerate always rebuilds its prompt fresh from
 * the CURRENT plan at retry time (see selectThemeImageRetryPrompt's
 * freshBasePrompt in themeService.retryThemeImage), so every board picks up
 * the new direction on its next retry automatically — this call never
 * touches art that's already been generated.
 */
export async function updateThemeCreativeDirection(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  creativeDirection: string,
): Promise<{ ok: boolean; creative_direction?: string; error?: string }> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');

  const trimmed = creativeDirection.trim();
  if (!trimmed) return { ok: false, error: 'Creative direction cannot be empty.' };

  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) throw new Error('The saved theme is incomplete and cannot be updated.');
  const { manifest } = loadedTheme;

  const creativeDirectionStore = resolveThemeFileStore(globalStorageUri);
  const savedPlan = (await readJson<ThemePlan>(creativeDirectionStore, themePlanPath(themeId)))
    ?? (await readJson<ThemePlan>(creativeDirectionStore, legacyPlanPath(themeId)));
  if (!savedPlan) throw new Error('This theme has no saved plan — creative direction requires plan.json.');
  const plan = normalizeThemePlan(savedPlan, manifest.display_name);
  if (plan.theme_id !== themeId) throw new Error('Saved plan does not match this theme.');

  plan.creative_direction = trimmed;
  await creativeDirectionStore.writeFile(themePlanPath(themeId), jsonBuffer(plan));
  return { ok: true, creative_direction: trimmed };
}

/**
 * Re-derive every `*_descriptions` field from the plan's CURRENT
 * creative_direction (see themeDescriptionsStale in themePlan.ts), leaving
 * every name array untouched. Snapshots the prior descriptions under
 * plan.previous_descriptions (one-level undo) before overwriting, then
 * records descriptions_direction so the plan is no longer stale. Unlike
 * updateThemeCreativeDirection, this DOES resync saved review-item prompts —
 * descriptions feed directly into already-generated boards' prompts, so a
 * re-derive should refresh every board's prompt/rows immediately (mirrors
 * updateThemeItemDescriptionsBatch's resync, but for ALL boards at once since
 * every description slot changed).
 */
export async function regenerateThemeDescriptions(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  textGenerationOptions: ThemeTextGenerationOptions,
): Promise<{ plan: ThemePlan }> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');

  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) throw new Error('The saved theme is incomplete and cannot be updated.');
  const { manifest } = loadedTheme;

  const store = resolveThemeFileStore(globalStorageUri);
  const savedPlan = (await readJson<ThemePlan>(store, themePlanPath(themeId)))
    ?? (await readJson<ThemePlan>(store, legacyPlanPath(themeId)));
  if (!savedPlan) throw new Error('This theme has no saved plan — descriptions require plan.json.');
  const plan = normalizeThemePlan(savedPlan, manifest.display_name);
  if (plan.theme_id !== themeId) throw new Error('Saved plan does not match this theme.');

  const previous_descriptions: NonNullable<ThemePlan['previous_descriptions']> = {
    character_descriptions: plan.character_descriptions,
    object_descriptions: plan.object_descriptions,
    crate_description: plan.crate_description,
    poof_description: plan.poof_description,
    projectile_description: plan.projectile_description,
    decor_descriptions: plan.decor_descriptions,
    enemy_descriptions: plan.enemy_descriptions,
    expression_descriptions: plan.expression_descriptions,
    achievement_descriptions: plan.achievement_descriptions,
  };

  const fresh = await regenerateThemeDescriptionsFromPlan(plan, textGenerationOptions);

  plan.character_descriptions = fresh.character_descriptions;
  plan.object_descriptions = fresh.object_descriptions;
  plan.crate_description = fresh.crate_description;
  plan.poof_description = fresh.poof_description;
  plan.projectile_description = fresh.projectile_description;
  plan.decor_descriptions = fresh.decor_descriptions;
  plan.enemy_descriptions = fresh.enemy_descriptions;
  plan.expression_descriptions = fresh.expression_descriptions;
  plan.achievement_descriptions = fresh.achievement_descriptions;
  plan.descriptions_direction = fresh.descriptions_direction;
  plan.previous_descriptions = previous_descriptions;

  await store.writeFile(themePlanPath(themeId), jsonBuffer(plan));

  try {
    const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
    if (document) {
      const expectedItems = createReviewItems(
        plan,
        manifest,
        themePlanCreativeDirection(plan),
        boardBackgroundModeForProvider(),
      );
      const merged = mergeResumedReviewItems(expectedItems, document.items) as ThemeImageReviewItem[];
      for (const item of merged) {
        await upsertThemeImageReviewItem(globalStorageUri, themeId, document.display_name, item);
      }
    }
  } catch (err) {
    console.warn('TycoonAgents: unable to resync review-board prompts after description regeneration:', err);
  }

  return { plan };
}

/** Regenerate one character board, then fit its frames to production scale. */
export async function normalizeThemeCharacterAtlas(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  itemId: string,
  imageGenerationOptions: ThemeImageGenerationOptions,
  onProgress?: (message: string) => void,
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> }> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');

  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  const item = document?.items.find((candidate) => candidate.id === itemId);
  if (!document || !item) throw new Error('Review image metadata was not found.');
  if (item.kind !== 'character_atlas') {
    throw new Error('Only character sprite boards can be size-normalized.');
  }

  // Match the padding language of the board that will actually be regenerated
  // (the merged 'augment' prompt appends these notes onto the ORIGINAL saved
  // prompt, so contradicting its background contract — e.g. demanding magenta
  // padding on a board originally baked with a different background — would confuse
  // the model).
  const paddingAdjective = boardBackgroundPaddingAdjective(
    boardBackgroundModeForProvider(),
  );
  const notes = [
    'Regenerate this character sprite board at the universal production character scale.',
    'Use an exact 512 x 512 pixel generation canvas with the 5-column by 4-row layout from the original prompt.',
    `In every walking and neutral-standing cell, the complete character from head to feet must occupy exactly ${CHARACTER_TARGET_CONTENT_PERCENT}% of that cell height.`,
    `Override any earlier feet-on-edge guidance: leave visible ${paddingAdjective} padding above and below every sprite so no pixels touch or cross a horizontal row boundary.`,
    `Keep the complete fourth row, including every foot and piece of equipment, inside the canvas with ${paddingAdjective} padding below it.`,
    'Keep the same character identity, costume, colors, pixel-art style, poses, and cell order.',
  ].join(' ');

  return retryThemeImage(
    globalStorageUri,
    themeId,
    itemId,
    notes,
    'augment',
    { ...imageGenerationOptions, aspectRatio: '1:1' },
    onProgress,
  );
}

export async function approveAllThemeImages(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
): Promise<ThemeImageReviewDocument> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');
  const review = await getThemeImageReview(globalStorageUri, themeId);
  if (!review.entries.length) throw new Error('This theme has no reviewable images.');
  const missingCount = review.entries.filter((entry) => !entry.imageUri).length;
  if (missingCount > 0) {
    throw new Error(`Wait for all theme images to finish before approving all (${missingCount} missing).`);
  }
  const document = await acceptAllThemeImageReviewItems(globalStorageUri, themeId);
  if (!document) throw new Error('This theme has no reviewable images.');
  return document;
}

/**
 * Persist a hand-built (or partially hand-built) ThemePlan as a real, selectable
 * theme WITHOUT starting any generation: no image-generation calls, no theme
 * service credit check, no network at all. Mirrors the storage-setup half of
 * `generateTheme` (normalize plan, allocate a unique theme_id, derive the
 * manifest, write plan.json + manifest.json + an EMPTY frames.json, and seed a
 * fully-pending review document) but stops there instead of continuing into
 * `continueThemeGeneration`. This is what lets UPLOAD_THEME_IMAGE and
 * GET_THEME_IMAGE_REVIEW work immediately: every board shows up with no
 * generated frames and upload allowed.
 *
 * `requestedThemeId`, when given, must already be a valid slug
 * ([a-z0-9_]+) — an invalid explicit id is rejected outright rather than
 * silently slugified, so a caller-specified id is never silently rewritten.
 * An EXPLICIT id is also reused AS-IS (update in place, no uniqueness
 * remint): a second "Save theme" against an already-saved draft must land
 * on the SAME directory rather than minting `<id>_2` and orphaning the
 * first directory's uploaded boards. `resolveUniqueNewThemeId` only runs on
 * the create path (no id given), where the id is derived from
 * `plan.display_name` the same way `generateTheme` does.
 *
 * On the update path (an existing theme dir for this id), any frames.json
 * already on disk (e.g. boards a user already uploaded via
 * UPLOAD_THEME_IMAGE) are preserved rather than clobbered with an empty
 * object, and an existing review.json is left untouched rather than
 * re-seeded with fresh all-pending items — re-seeding would silently revert
 * an already-uploaded board's review status/frame_keys back to pending.
 */
export async function saveThemePlan(
  globalStorageUri: ThemeStorageRoot,
  requestedPlan: Partial<ThemePlan>,
  requestedThemeId?: string,
): Promise<{ theme_id: string; plan: ThemePlan }> {
  if (requestedThemeId !== undefined && !isThemeId(requestedThemeId)) {
    throw new Error('Invalid theme ID. Use lowercase letters, numbers, and underscores.');
  }
  const plan = normalizeThemePlan(requestedPlan, requestedPlan.display_name);
  const themeId = requestedThemeId ?? await resolveUniqueNewThemeId(globalStorageUri, plan.theme_id);
  plan.theme_id = themeId;
  const creativeDirection = themePlanCreativeDirection(plan);
  const suggestedManifest = themePlanToManifest(plan);
  const manifest: ThemeManifest = {
    manifest_version: '1.0.0',
    theme_id: themeId,
    display_name: plan.display_name,
    author: 'TycoonAgents Factory',
    viewport: suggestedManifest.viewport!,
    roster_agents: suggestedManifest.roster_agents!,
    roster_rivals: suggestedManifest.roster_rivals!,
    buildable_objects: suggestedManifest.buildable_objects!,
    decor_objects: suggestedManifest.decor_objects!,
    badges: buildDefaultBadges(),
    freed_frames: 'v2',
  };
  const store = resolveThemeFileStore(globalStorageUri);
  await store.mkdirp(themeDirectoryPath(themeId));
  await store.mkdirp(themeImagesDirectoryPath(themeId));

  // p79-t2: read the PREVIOUS plan (if any) before it gets overwritten below,
  // so an update-in-place save can tell which review items' prompts were
  // still tracking the plan's own descriptions (safe to resync) versus a
  // user-tweaked direction (must be left alone).
  const previousPlan = await readJson<ThemePlan>(store, themePlanPath(themeId));

  await store.writeFile(themePlanPath(themeId), jsonBuffer(plan));

  // Preserve any frames already on disk (uploaded boards) instead of
  // clobbering frames.json with an empty object on an update-in-place save.
  const existingFrames = await readJson<Record<string, string[]>>(store, themeFramesPath(themeId));
  await writeThemeFiles(globalStorageUri, manifest, existingFrames ?? {});

  // Only seed a fresh all-pending review document when this theme has none
  // yet — an existing review.json (e.g. one carrying an already-uploaded
  // board's accepted/pending status and frame_keys) is left exactly as is.
  const existingReview = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  if (!existingReview) {
    const reviewItems = createReviewItems(
      plan,
      manifest,
      creativeDirection,
      boardBackgroundModeForProvider(),
    );
    await initializeThemeImageReviewDocument(globalStorageUri, themeId, plan.display_name, reviewItems);
  } else {
    // p79-t2: an update-in-place save (including the redesigned builder's
    // autosave-after-every-upload) must make the board grid show any edited
    // board names/descriptions without clobbering review progress. Refresh
    // each existing item's display label from the new plan unconditionally
    // (labels are pure display text, never user-authored), and refresh its
    // generation prompt ONLY when the item is still pending AND its current
    // prompt still equals the prompt the PREVIOUS plan would have produced —
    // i.e. the user never tweaked that board's direction/prompt by hand.
    // Status/image/revision/frame_keys are always preserved from the saved
    // item. No image reads here — cheap and idempotent: re-saving the same
    // plan twice leaves every item's label/prompt unchanged (only updated_at
    // may move, and only on an item that actually changed).
    const nextExpected = createReviewItems(plan, manifest, creativeDirection, boardBackgroundModeForProvider());
    const previousExpected = previousPlan
      ? createReviewItems(
          normalizeThemePlan(previousPlan, previousPlan.display_name),
          manifest,
          themePlanCreativeDirection(normalizeThemePlan(previousPlan, previousPlan.display_name)),
          boardBackgroundModeForProvider(),
        )
      : undefined;
    for (const saved of existingReview.items) {
      const next = nextExpected.find((candidate) => candidate.id === saved.id);
      if (!next) continue;
      const prev = previousExpected?.find((candidate) => candidate.id === saved.id);
      const promptStillMatchesPreviousPlan = saved.status === 'pending' && !!prev && saved.prompt === prev.prompt;
      const nextLabel = next.label;
      const nextPrompt = promptStillMatchesPreviousPlan ? next.prompt : saved.prompt;
      if (nextLabel === saved.label && nextPrompt === saved.prompt) continue;
      await upsertThemeImageReviewItem(globalStorageUri, themeId, plan.display_name, {
        ...saved,
        label: nextLabel,
        prompt: nextPrompt,
        updated_at: new Date().toISOString(),
      });
    }
  }

  return { theme_id: themeId, plan };
}

export async function generateTheme(
  globalStorageUri: ThemeStorageRoot,
  requestedPlan: ThemePlan | string,
  onProgress: (message: string) => void,
  isCancelled?: () => boolean,
  onReviewReady?: (themeId: string) => void,
  imageGenerationOptions?: ThemeImageGenerationOptions,
  waitForReview?: WaitForThemeImageReview,
): Promise<ThemeGenerationResult> {
  onProgress(typeof requestedPlan === 'string' ? 'Planning theme...' : 'Preparing theme...');
  const plan = normalizeThemePlan(
    typeof requestedPlan === 'string'
      ? await expandThemePlan(requestedPlan, imageGenerationOptions as ThemeTextGenerationOptions | undefined)
      : requestedPlan,
    typeof requestedPlan === 'string' ? requestedPlan : requestedPlan.display_name,
  );
  const themeId = await resolveUniqueNewThemeId(globalStorageUri, plan.theme_id);
  plan.theme_id = themeId;
  const creativeDirection = themePlanCreativeDirection(plan);
  const suggestedManifest = themePlanToManifest(plan);
  const manifest: ThemeManifest = {
    manifest_version: '1.0.0',
    theme_id: themeId,
    display_name: plan.display_name,
    author: 'TycoonAgents Factory',
    viewport: suggestedManifest.viewport!,
    roster_agents: suggestedManifest.roster_agents!,
    roster_rivals: suggestedManifest.roster_rivals!,
    buildable_objects: suggestedManifest.buildable_objects!,
    decor_objects: suggestedManifest.decor_objects!,
    badges: buildDefaultBadges(),
    freed_frames: 'v2',
  };
  const frames: Record<string, string[]> = {};
  const generateStore = resolveThemeFileStore(globalStorageUri);
  await generateStore.mkdirp(themeDirectoryPath(themeId));
  await generateStore.mkdirp(themeImagesDirectoryPath(themeId));
  await generateStore.writeFile(themePlanPath(themeId), jsonBuffer(plan));

  // Regenerating an existing theme must not wipe out Stage Editor viewport
  // tuning the user already dialed in. A missing old manifest (brand-new
  // theme) is expected and must not fail generation.
  try {
    const oldManifest = await loadThemeManifest(globalStorageUri, themeId);
    if (oldManifest) preserveViewportTuning(manifest.viewport, oldManifest.viewport);
  } catch {
    // No existing manifest to preserve tuning from — proceed with the fresh one.
  }

  await writeThemeFiles(globalStorageUri, manifest, frames);

  const reviewItems = createReviewItems(
    plan,
    manifest,
    creativeDirection,
    boardBackgroundModeForProvider(),
  );
  await initializeThemeImageReviewDocument(globalStorageUri, themeId, plan.display_name, reviewItems);
  onReviewReady?.(themeId);

  return continueThemeGeneration(
    globalStorageUri,
    plan,
    manifest,
    frames,
    reviewItems,
    onProgress,
    isCancelled,
    onReviewReady,
    imageGenerationOptions,
    waitForReview,
  );
}

/** Continue an interrupted theme without replacing images and decisions already on disk. */
export async function resumeThemeGeneration(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  onProgress: (message: string) => void,
  isCancelled?: () => boolean,
  onReviewReady?: (themeId: string) => void,
  imageGenerationOptions?: ThemeImageGenerationOptions,
  waitForReview?: WaitForThemeImageReview,
): Promise<ThemeGenerationResult> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');
  onProgress('Loading interrupted generation...');

  const resumeStore = resolveThemeFileStore(globalStorageUri);
  const savedPlan = (await readJson<ThemePlan>(resumeStore, themePlanPath(themeId)))
    ?? (await readJson<ThemePlan>(resumeStore, legacyPlanPath(themeId)));
  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  if (!savedPlan || !loadedTheme || !document) {
    throw new Error('This theme does not contain enough saved generation state to resume.');
  }

  const plan = normalizeThemePlan(savedPlan, loadedTheme.manifest.display_name);
  if (plan.theme_id !== themeId) throw new Error('The saved theme plan does not match this theme.');
  const expectedItems = createReviewItems(
    plan,
    loadedTheme.manifest,
    themePlanCreativeDirection(plan),
    boardBackgroundModeForProvider(),
  );
  const reviewItems = mergeResumedReviewItems(expectedItems, document.items);

  // Repair any missing review rows while retaining statuses, prompts, revisions,
  // and timestamps for every item that survived the interrupted run.
  await initializeThemeImageReviewDocument(
    globalStorageUri,
    themeId,
    document.display_name,
    reviewItems,
  );
  onReviewReady?.(themeId);
  onProgress('Resuming unfinished image generations...');

  return continueThemeGeneration(
    globalStorageUri,
    plan,
    loadedTheme.manifest,
    loadedTheme.frames,
    reviewItems,
    onProgress,
    isCancelled,
    onReviewReady,
    imageGenerationOptions,
    waitForReview,
  );
}

async function continueThemeGeneration(
  globalStorageUri: ThemeStorageRoot,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  reviewItems: Array<Omit<ThemeImageReviewItem, 'updated_at'> & { updated_at?: string }>,
  onProgress: (message: string) => void,
  isCancelled?: () => boolean,
  onReviewReady?: (themeId: string) => void,
  imageGenerationOptions?: ThemeImageGenerationOptions,
  waitForReview?: WaitForThemeImageReview,
): Promise<ThemeGenerationResult> {
  const themeId = plan.theme_id;
  // `reviewDirectoryUri` is a vestigial pass-through param kept only for
  // call-site compatibility (see the comment on its receiving functions
  // below) — no editor Uri needs to be constructed here anymore.
  const reviewDirectoryUri: ThemeStorageRoot = themeImagesDirectoryPath(themeId);

  const environmentBoardIds = new Set(buildBoardItems(plan, manifest, 'environment').map((candidate) => candidate.id));
  const environmentItem = reviewItems.find((item) => environmentBoardIds.has(item.id))!;
  await runNonFatalBoardStep(environmentItem.label, onProgress, isCancelled, imageGenerationOptions?.signal, () =>
    generateOrResumeThemeItem(
      globalStorageUri, themeId, plan.display_name, environmentItem, manifest, frames,
      onProgress, isCancelled, onReviewReady, waitForReview,
      () => generateEnvironmentAsset(
        globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
        environmentItem, imageGenerationOptions, onProgress,
      ),
    ),
  );

  throwIfCancelled(isCancelled);
  const agentBoardIds = new Set(buildBoardItems(plan, manifest, 'agents').map((candidate) => candidate.id));
  const agentItems = reviewItems.filter((item) => agentBoardIds.has(item.id));

  for (let index = 0; index < agentItems.length; index++) {
    throwIfCancelled(isCancelled);
    const item = agentItems[index];
    const name = item.subject ?? item.label;
    onProgress(`${name} (${index + 1}/${agentItems.length})`);
    await runNonFatalBoardStep(name, onProgress, isCancelled, imageGenerationOptions?.signal, () =>
      generateOrResumeThemeItem(
        globalStorageUri,
        themeId,
        plan.display_name,
        item,
        manifest,
        frames,
        onProgress,
        isCancelled,
        onReviewReady,
        waitForReview,
        () => generateAgentAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
          item, imageGenerationOptions, onProgress,
        ),
      ),
    );
  }

  throwIfCancelled(isCancelled);
  const enemyBoardIds = new Set(buildBoardItems(plan, manifest, 'enemy').map((candidate) => candidate.id));
  const rivalItems = reviewItems.filter((item) => enemyBoardIds.has(item.id));
  for (let index = 0; index < rivalItems.length; index++) {
    throwIfCancelled(isCancelled);
    const rivalsItem = rivalItems[index];
    await runNonFatalBoardStep(rivalsItem.label, onProgress, isCancelled, imageGenerationOptions?.signal, () =>
      generateOrResumeThemeItem(
        globalStorageUri, themeId, plan.display_name, rivalsItem, manifest, frames,
        onProgress, isCancelled, onReviewReady, waitForReview,
        () => generateRivalAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
          rivalsItem, imageGenerationOptions, onProgress,
        ),
      ),
    );
  }

  throwIfCancelled(isCancelled);
  const decorBoardIds = new Set(buildBoardItems(plan, manifest, 'decor').map((candidate) => candidate.id));
  const decorItem = reviewItems.find((item) => decorBoardIds.has(item.id));
  if (decorItem) {
    await runNonFatalBoardStep(decorItem.label, onProgress, isCancelled, imageGenerationOptions?.signal, () =>
      generateOrResumeThemeItem(
        globalStorageUri, themeId, plan.display_name, decorItem, manifest, frames,
        onProgress, isCancelled, onReviewReady, waitForReview,
        () => generateDecorAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
          decorItem, imageGenerationOptions, onProgress,
        ),
      ),
    );
  }

  throwIfCancelled(isCancelled);
  const objectBoardIds = new Set(buildBoardItems(plan, manifest, 'objects').map((candidate) => candidate.id));
  const objectItems = reviewItems.filter((item) => objectBoardIds.has(item.id));
  for (let index = 0; index < objectItems.length; index++) {
    throwIfCancelled(isCancelled);
    const objectsItem = objectItems[index];
    await runNonFatalBoardStep(objectsItem.label, onProgress, isCancelled, imageGenerationOptions?.signal, () =>
      generateOrResumeThemeItem(
        globalStorageUri, themeId, plan.display_name, objectsItem, manifest, frames,
        onProgress, isCancelled, onReviewReady, waitForReview,
        () => generateObjectAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
          objectsItem, imageGenerationOptions, onProgress, 21 + index,
        ),
      ),
    );
  }

  throwIfCancelled(isCancelled);
  const expressionsBoardIds = new Set(buildBoardItems(plan, manifest, 'expressions').map((candidate) => candidate.id));
  const expressionsItem = reviewItems.find((item) => expressionsBoardIds.has(item.id))!;
  await runNonFatalBoardStep(expressionsItem.label, onProgress, isCancelled, imageGenerationOptions?.signal, () =>
    generateOrResumeThemeItem(
      globalStorageUri, themeId, plan.display_name, expressionsItem, manifest, frames,
      onProgress, isCancelled, onReviewReady, waitForReview,
      () => generateExpressionAsset(
        globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
        expressionsItem, imageGenerationOptions, onProgress,
      ),
    ),
  );

  throwIfCancelled(isCancelled);
  const achievementsBoardIds = new Set(buildBoardItems(plan, manifest, 'achievements').map((candidate) => candidate.id));
  const achievementsItem = reviewItems.find((item) => achievementsBoardIds.has(item.id))!;
  await runNonFatalBoardStep(achievementsItem.label, onProgress, isCancelled, imageGenerationOptions?.signal, () =>
    generateOrResumeThemeItem(
      globalStorageUri, themeId, plan.display_name, achievementsItem, manifest, frames,
      onProgress, isCancelled, onReviewReady, waitForReview,
      () => generateAchievementAsset(
        globalStorageUri, reviewDirectoryUri, plan, manifest, frames,
        achievementsItem, imageGenerationOptions, onProgress,
      ),
    ),
  );

  throwIfCancelled(isCancelled, imageGenerationOptions?.signal);
  await writeThemeFiles(globalStorageUri, manifest, frames);
  throwIfCancelled(isCancelled, imageGenerationOptions?.signal);
  return { manifest, frames };
}

/**
 * Regenerates a single board of an EXISTING theme (e.g. just the enemy
 * board) and merges only that board's frames into the theme's persisted
 * frames.json, leaving every other board untouched. Uses the same plan and
 * the same buildBoardItems selection as full generation, so the regenerated
 * board picks up current layout/prompt logic (e.g. a new enemy 2-walk/
 * 3-attack row layout) without requiring a full theme regen.
 */
export async function regenerateThemeBoard(
  globalStorageUri: ThemeStorageRoot,
  reviewDirectoryUri: ThemeStorageRoot,
  themeId: string,
  board: BoardKind,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
  itemId?: string,
): Promise<void> {
  if (!isThemeId(themeId)) throw new Error('Invalid theme ID.');

  const regenerateStore = resolveThemeFileStore(globalStorageUri);
  const savedPlan = (await readJson<ThemePlan>(regenerateStore, themePlanPath(themeId)))
    ?? (await readJson<ThemePlan>(regenerateStore, legacyPlanPath(themeId)));
  if (!savedPlan) {
    throw new Error(`No saved plan was found for theme "${themeId}". Regenerate the full theme first.`);
  }

  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) throw new Error(`Theme "${themeId}" was not found.`);
  const { manifest, frames } = loadedTheme;
  const plan = normalizeThemePlan(savedPlan, manifest.display_name);

  let items = buildBoardItems(plan, manifest, board, boardBackgroundModeForProvider());
  if (itemId) {
    items = items.filter((candidate) => candidate.id === itemId);
    if (!items.length) throw new Error(`No regenerable image with id "${itemId}" was found on board "${board}".`);
  }
  if (!items.length) throw new Error(`No regenerable images were found for board "${board}".`);

  // `reviewDirectoryUri` is accepted for call-site compatibility (panel.ts
  // already computes and passes it); the actual I/O below goes through the
  // injected ThemeFileStore using a path derived from `themeId` instead.
  void reviewDirectoryUri;
  await regenerateStore.mkdirp(themeImagesDirectoryPath(themeId));

  for (let index = 0; index < items.length; index++) {
    throwIfCancelled(undefined, options?.signal);
    const item = items[index];
    onProgress(`${item.label} (${index + 1}/${items.length})`);
    switch (board) {
      case 'agents':
        await generateAgentAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames, item, options, onProgress,
        );
        break;
      case 'enemy':
        await generateRivalAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames, item, options, onProgress,
        );
        break;
      case 'environment':
        await generateEnvironmentAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames, item, options, onProgress,
        );
        break;
      case 'decor':
        await generateDecorAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames, item, options, onProgress,
        );
        break;
      case 'objects':
        await generateObjectAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames, item, options, onProgress, index + 1,
        );
        break;
      case 'expressions':
        await generateExpressionAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames, item, options, onProgress,
        );
        break;
      case 'achievements':
        await generateAchievementAsset(
          globalStorageUri, reviewDirectoryUri, plan, manifest, frames, item, options, onProgress,
        );
        break;
      default:
        throw new Error(`Unsupported board type "${board}".`);
    }
  }

  throwIfCancelled(undefined, options?.signal);
  // Re-sync display names from the (normalized) plan so Edit Stage labels match
  // the regenerated art. themePlanToManifest assigns names by array index
  // (buildable_objects[i] <- plan.objects[i], decor_objects[i] <- plan.decor[i]);
  // mirror that exact positional mapping here. Guard length mismatches by only
  // syncing overlapping indices, and touch ONLY display_name so object_id /
  // decor_id / build_order / all other fields are preserved. Idempotent: a
  // no-op when names already match.
  if (board === 'objects' && manifest.buildable_objects) {
    const count = Math.min(manifest.buildable_objects.length, plan.objects.length);
    for (let i = 0; i < count; i++) {
      manifest.buildable_objects[i].display_name = plan.objects[i];
    }
  } else if (board === 'decor' && manifest.decor_objects) {
    const count = Math.min(manifest.decor_objects.length, plan.decor.length);
    for (let i = 0; i < count; i++) {
      manifest.decor_objects[i].display_name = plan.decor[i];
    }
  }
  await writeThemeFiles(globalStorageUri, manifest, frames);
  onProgress(`${board} board regenerated.`);
}

/**
 * Runs a single board-generation step without letting its failure abort the
 * rest of the pipeline. User cancellation (isCancelled() true or the abort
 * signal firing) is rethrown untouched so it still propagates. Any other
 * failure is logged via onProgress and swallowed, leaving that board's
 * manifest/frame entries absent so the webview falls back to a placeholder.
 */
async function runNonFatalBoardStep(
  label: string,
  onProgress: (message: string) => void,
  isCancelled: (() => boolean) | undefined,
  signal: AbortSignal | undefined,
  step: () => Promise<void>,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    if (isCancelled?.() || signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    onProgress(`${label} failed and was skipped: ${message}`);
  }
}

/**
 * Slice a raw atlas `buffer` for `item` into `frames`/`manifest`, write the
 * normalized review image, keep the raw pre-slice atlas, and persist the theme
 * files. Shared by retryThemeImage (buffer from the image API) and
 * resliceThemeImageFromRaw (buffer read back from disk, no API call) so both
 * paths use IDENTICAL slicing + persist behavior. Row metadata is reconstructed
 * from the CURRENT manifest via the *RowsForItem helpers. `persistRaw` (default
 * true) controls whether the raw pre-slice atlas is (re)written; pass false when
 * `buffer` IS the raw file already on disk (resliceThemeImageFromRaw) so re-slicing
 * never overwrites the pristine raw source with a processed/downsized copy. Returns
 * the normalized output plus the frame keys the caller should record on the review
 * item.
 */
async function applySlicedAtlasFromBuffer(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: ThemeImageReviewItem,
  buffer: Buffer,
  signal?: AbortSignal,
  persistRaw: boolean = true,
  // When true, skip this function's own frames.json/manifest write and just
  // return the sliced frameKeys, leaving `frames`/`manifest` mutated in
  // memory only. Used by retryThemeImage's partial-keep path: it needs to
  // merge the freshly-sliced keys with the pre-retry stored values BEFORE
  // anything touches disk, so there is exactly one mutex-protected write for
  // the whole retry instead of a full-board write followed by a corrective
  // merge write. All other callers (resliceThemeImageFromRaw, the
  // recover-by-reslice path in generateOrResumeThemeItem, and a full/no-slots
  // retry) leave this false and get the original write-here behavior.
  skipWrite: boolean = false,
): Promise<{ output: Buffer; frameKeys: string[] }> {
  let output = buffer;
  let frameKeys = item.frame_keys;
  // Captured before any branch reassigns frameKeys, so it always reflects
  // this item's frame keys as of the START of this (possibly slow) operation.
  // Used below to scope the final frames.json write to just the keys this
  // operation actually owns — see the writeThemeFiles call at the bottom.
  const previousFrameKeys = item.frame_keys;

  if (item.kind === 'character_atlas') {
    const characterAtlas = await processCharacterAtlas(buffer, manifest, item.body_plan ?? 'biped');
    output = characterAtlas.output;
    const spritePackage = characterAtlas.spritePackage;
    const frameKey = item.frame_keys[0] || item.id;
    frames[frameKey] = spritePackage.slots.map((slot) => slot.data);
    frameKeys = [frameKey];
  } else if (item.kind === 'rival_atlas') {
    const rows = rivalRowsForItem(item, manifest);
    item.rival_rows = rows;
    const rivalAtlas = await processRivalAtlas(buffer, manifest, rows);
    output = rivalAtlas.output;
    frameKeys = applyRivalBoardFrames(frames, rivalAtlas.spritePackage.slots, rows);
    removeStaleBoardFrameKeys(frames, previousFrameKeys, frameKeys);
  } else if (item.kind === 'environment') {
    output = await normalizeEnvironmentImage(buffer);
    frames.environment_background = [dataUri(output)];
    manifest.viewport.background_asset = 'frames.json#environment_background';
    frameKeys = ['environment_background'];
  } else if (item.kind === 'object_atlas') {
    // Reconstruct object_rows from the CURRENT manifest as the primary source
    // (see objectRowsForItem) so a roster change (e.g. objects added/renamed)
    // regenerates the correct board instead of reusing stale saved object_rows.
    const rows = objectRowsForItem(item, manifest);
    item.object_rows = rows;
    const objectAtlas = await processObjectAtlas(buffer, manifest, rows);
    output = objectAtlas.output;
    frameKeys = applyObjectBoardFrames(frames, objectAtlas.spritePackage.slots, rows);
    // Self-healing re-slice: if the roster shift means this board no longer owns
    // e.g. 'poof'/'crate' (they moved to a later board once the object count grew),
    // drop those stale keys from THIS board's own previous ownership so they don't
    // keep clobbering whatever board correctly owns them now — scoped strictly to
    // keys this item itself previously wrote, so other boards' keys are untouched
    // regardless of re-slice order.
    removeStaleBoardFrameKeys(frames, previousFrameKeys, frameKeys);
  } else if (item.kind === 'background_decor_atlas') {
    // Reconstruct decor_rows from the CURRENT manifest as the primary source
    // (see decorRowsForItem) so a decor roster change regenerates the correct
    // board instead of reusing stale saved decor_rows.
    const rows = decorRowsForItem(item, manifest);
    const decorAtlas = await processDecorAtlas(buffer, manifest);
    output = decorAtlas.output;
    frameKeys = applyDecorBoardFrames(frames, decorAtlas.spritePackage.slots, rows);
    manifest.viewport.projectile_asset = 'frames.json#projectile';
    item.decor_rows = rows;
  } else if (item.kind === 'expression_atlas') {
    output = await optimizeSpriteBoardCanvas(buffer, 4, 2);
    const spritePackage = await sliceAndNormalizeAtlas(output, manifest, { columns: 4, rows: 2 });
    frameKeys = applyExpressionFrames(frames, spritePackage.slots);
  } else if (item.kind === 'achievement_atlas') {
    output = await optimizeSpriteBoardCanvas(buffer, 5, 5);
    const spritePackage = await sliceAndNormalizeAtlas(output, manifest, { columns: 5, rows: 5 });
    frameKeys = applyAchievementFrames(frames, spritePackage.slots);
  } else {
    output = await optimizeSpriteBoard(buffer);
    const spritePackage = await sliceAndNormalizeAtlas(output, manifest);
    frameKeys = applyLegacyEmoteFrames(frames, spritePackage.slots);
  }

  throwIfCancelled(undefined, signal);
  const applySliceStore = resolveThemeFileStore(globalStorageUri);
  const reviewDirectoryPath = themeImagesDirectoryPath(themeId);
  await applySliceStore.mkdirp(reviewDirectoryPath);
  await applySliceStore.writeFile(`${reviewDirectoryPath}/${item.filename}`, output);
  // Keep the raw pre-slice atlas so this board can be re-sliced later without regenerating.
  // Skipped when re-slicing FROM that same raw file (persistRaw=false) — the buffer here
  // is already the pristine raw source, and re-slicing must never overwrite it with a
  // processed/downsized copy (see resliceThemeImageFromRaw).
  if (persistRaw) {
    await persistRawAtlas(globalStorageUri, themeId, item.filename, buffer);
  }
  // Merge-safe write: retryThemeImage/resliceThemeImageFromRaw load frames.json
  // once at the START of this operation, then this function runs a slow
  // image-generation API call before reaching this write. If a DIFFERENT
  // board's retry loaded its own frames.json snapshot in between and finishes
  // (and writes) before this one does, a blind overwrite here would silently
  // revert that other board's frames back to the stale snapshot this call
  // started with — e.g. a background-decor regen's new art getting reverted by
  // a slower, later-finishing object-board regen. Scoping the write to just
  // the keys THIS item owns (its new frame keys plus any it just dropped)
  // avoids that lost-update race; every other key defers to disk.
  //
  // Skipped when skipWrite is set: the caller (retryThemeImage's partial-keep
  // path) still needs this exact same key scope for ITS OWN single write, so
  // it recomputes the identical `[...new Set([...frameKeys, ...previousFrameKeys])]`
  // expression after merging — see retryThemeImage below.
  if (!skipWrite) {
    await writeThemeFiles(globalStorageUri, manifest, frames, [
      ...new Set([...frameKeys, ...previousFrameKeys]),
    ]);
  }
  return { output, frameKeys };
}

/** Sliceable atlas kinds that can be re-sliced from a saved raw atlas. */
const RESLICEABLE_ATLAS_KINDS: ReadonlySet<ThemeImageKind> = new Set([
  'character_atlas',
  'rival_atlas',
  'object_atlas',
  'background_decor_atlas',
  'expression_atlas',
  'achievement_atlas',
] as ThemeImageKind[]);

/**
 * Re-run slicing for a board using the RAW atlas already saved to disk, WITHOUT
 * calling the image API. This lets slicing fixes apply to existing themes for
 * free. Environment boards are not sliced (they normalize a single image) and so
 * cannot be re-sliced. Returns the updated manifest+frames on success, or a
 * `reason` the caller can surface to the user on failure.
 */
export async function resliceThemeImageFromRaw(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  itemId: string,
): Promise<{ ok: true; manifest: ThemeManifest; frames: Record<string, string[]> } | { ok: false; reason: string }> {
  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  const item = document?.items.find((candidate) => candidate.id === itemId);
  if (!document || !item) return { ok: false, reason: 'Item not found' };
  if (!RESLICEABLE_ATLAS_KINDS.has(item.kind)) {
    return { ok: false, reason: 'This board type cannot be re-sliced' };
  }
  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) return { ok: false, reason: 'The saved theme is incomplete and cannot be re-sliced yet.' };

  const resliceStore = resolveThemeFileStore(globalStorageUri);
  const rawPath = `${themeRawImagesDirectoryPath(themeId)}/${item.filename}`;
  if (!(await resliceStore.exists(rawPath))) {
    return {
      ok: false,
      reason: 'No saved original to re-slice — regenerate this board once to enable re-slicing',
    };
  }
  const rawBuffer = Buffer.from(await resliceStore.readFile(rawPath));

  const { manifest, frames } = loadedTheme;
  const { frameKeys } = await applySlicedAtlasFromBuffer(
    globalStorageUri,
    themeId,
    manifest,
    frames,
    item,
    rawBuffer,
    undefined,
    false,
  );
  await upsertThemeImageReviewItem(globalStorageUri, themeId, document.display_name, {
    ...item,
    status: 'pending',
    generation_error: undefined,
    revision: item.revision + 1,
    frame_keys: frameKeys,
    updated_at: new Date().toISOString(),
  });
  return { ok: true, manifest, frames };
}

/**
 * Load the theme's CURRENT plan.json (not a stale review-item snapshot) so
 * callers can rebuild a fresh prompt reflecting any plan/roster changes since
 * an item was first generated. Shared by retryThemeImage (the 'retry'/
 * 'augment' fresh-base prompt) and the image-review "current prompt" preview.
 * Falls back to undefined for legacy themes with no plan.json, or a plan
 * whose theme_id no longer matches (renamed/mismatched) — callers then fall
 * back to the item's stale saved prompt.
 */
export async function loadCurrentThemePlan(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  displayNameFallback: string,
): Promise<ThemePlan | undefined> {
  const currentPlanStore = resolveThemeFileStore(globalStorageUri);
  const savedPlan = (await readJson<ThemePlan>(currentPlanStore, themePlanPath(themeId)))
    ?? (await readJson<ThemePlan>(currentPlanStore, legacyPlanPath(themeId)));
  const normalizedPlan = savedPlan ? normalizeThemePlan(savedPlan, displayNameFallback) : undefined;
  return normalizedPlan?.theme_id === themeId ? normalizedPlan : undefined;
}

/**
 * Grid geometry (columns × rows of 128px cells) each sliceable board kind's
 * own process*Atlas function passes to sliceAndNormalizeAtlas — mirrored here
 * (not imported from there) because those grids are constructed inline per
 * kind with kind-specific normalization options; only the columns/rows shape
 * is needed to lay merged frame_keys back out in the same row-major cell
 * order for compositeBoardFromFrameKeys. Returns undefined for kinds that
 * cannot be recomposited this way (environment: single ungridded image).
 */
function reviewBoardGridForItemKind(item: ThemeImageReviewItem): { columns: number; rows: number } | undefined {
  switch (item.kind) {
    case 'character_atlas': return { columns: 5, rows: 4 };
    // Rival boards are a compact 5-column board whose row count is the
    // board's own rival_rows length (1-4 enemies per board — see
    // processRivalAtlas), not a fixed constant.
    case 'rival_atlas': return item.rival_rows?.length ? { columns: 5, rows: item.rival_rows.length } : undefined;
    case 'object_atlas': return { columns: 4, rows: 4 };
    case 'background_decor_atlas': return { columns: 4, rows: 4 };
    case 'expression_atlas': return { columns: 4, rows: 2 };
    case 'achievement_atlas': return { columns: 5, rows: 5 };
    case 'emote_atlas': return { columns: 5, rows: 4 };
    case 'environment': return undefined;
    default: return undefined;
  }
}

export async function retryThemeImage(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  itemId: string,
  feedback: string,
  mode: ThemeImageRetryMode,
  imageGenerationOptions: ThemeImageGenerationOptions,
  onProgress?: (message: string) => void,
  // Per-frame regeneration (feedback #18): indices of the frames the caller
  // wants to KEEP from the freshly-generated board. What an index addresses
  // depends on this item's stored shape (decided further down from
  // priorFrameKeys/priorFrames, never from item.kind, so it can't drift from
  // what was actually on disk):
  //   - multi-key boards (objects/decor/rivals): an index into item.frame_keys
  //     — the addressable unit is a whole KEY, because a key can hold a
  //     multi-frame clip that must not be split mid-animation.
  //   - single-key, multi-frame boards (character atlases: one frame_keys
  //     entry whose stored array holds all poses): an index WITHIN that
  //     key's frame array, i.e. a single pose.
  // A full board is ALWAYS generated either way — image models produce a
  // board atomically, there is no API to regenerate a single cell — this
  // only changes what gets kept afterward. Absent/empty is the regression
  // guarantee: behavior is then byte-identical to a full-board replace (see
  // the merge below, which is a pure no-op when `slots` is empty).
  slots?: readonly number[],
): Promise<{ manifest: ThemeManifest; frames: Record<string, string[]> }> {
  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  const item = document?.items.find((candidate) => candidate.id === itemId);
  if (!document || !item) throw new Error('Review image metadata was not found.');
  // Follow-up fix: clear this item's PREVIOUS error the moment a new
  // attempt starts (persisted, not just in the in-memory `item` used below)
  // — otherwise a reload mid-generation, or the webview's next
  // THEME_IMAGE_REVIEW before this attempt resolves, could still show the
  // old failure notice. Mirrors the in-memory clear on `item` itself so the
  // rest of this function (and its own success write further down) never
  // reads the stale fields either.
  if (item.generation_error || item.error_kind) {
    await clearThemeImageReviewItemError(globalStorageUri, themeId, itemId);
    item.generation_error = undefined;
    item.error_kind = undefined;
    item.error_code = undefined;
    item.error_categories = undefined;
    item.error_fields = undefined;
    item.error_session = undefined;
  }
  const loadedTheme = await loadTheme(globalStorageUri, themeId);
  if (!loadedTheme) throw new Error('The saved theme is incomplete and cannot be retried yet.');
  const notes = feedback.trim();

  // Snapshot the frame keys/data this item owns BEFORE regeneration. For
  // multi-key boards, frame_keys index is the addressable "slot" (a clip key
  // like "rival_x" holds several animation frames under one key; the whole
  // clip is the unit that gets kept or replaced, not individual frames
  // within it). For single-key multi-frame boards (character atlases), this
  // same snapshot instead supplies the prior POSE array that the within-key
  // merge branch below indexes into. Only meaningful when `slots` is
  // non-empty AND this item already has stored frames for its keys (first
  // generation has nothing to preserve, so partial-keep is meaningless there
  // — falls back to a full replace below).
  const priorFrameKeys = item.frame_keys ?? [];
  const priorFrames: Record<string, string[] | undefined> = {};
  for (const key of priorFrameKeys) priorFrames[key] = loadedTheme.frames[key];
  const hasPriorFrames = priorFrameKeys.some((key) => priorFrames[key]?.length);
  const requestedSlots = Array.from(new Set(slots ?? [])); // de-dupe indices

  // Legacy themes (pre-animated boards) stored object-atlas items without
  // object_rows. Reconstruct a 5-row animated board so every object-atlas retry
  // takes the animated buildObjectAtlasPrompt / processObjectAtlas path.
  if (item.kind === 'object_atlas' && !item.object_rows?.length) {
    item.object_rows = reconstructObjectRows(item, loadedTheme.manifest);
  }

  // Prefer the CURRENT saved plan's expression/achievement names over the review
  // item's saved names, so a retry after the plan's roster changed re-bakes the
  // current set instead of the stale one. Missing/unparsable plan.json is
  // non-fatal: buildReplacementPrompt falls back to the item's saved names, then
  // generic defaults.
  const currentPlan = await loadCurrentThemePlan(globalStorageUri, themeId, loadedTheme.manifest.display_name);
  const backgroundMode = boardBackgroundModeForProvider();

  // 'replace' explicitly swaps the theme's creative direction for the user's
  // typed notes — that is what "replace" means.
  const replacementPrompt = buildReplacementPrompt(
    item, notes, loadedTheme.manifest, currentPlan, backgroundMode, false,
  );
  // 'retry'/'augment' instead reroll the CURRENT template + manifest while
  // keeping the theme's OWN creative direction (from plan.json), not the
  // retry notes — a "reroll the current contract" refresh, not a content
  // swap. This is what makes retry/augment pick up prompt-template fixes
  // (e.g. a margin rule added in a later release) that shipped after this
  // item was first generated, instead of forever replaying whatever template
  // was current back then (see selectThemeImageRetryPrompt for the full
  // rationale). Falls back to the stale saved prompt only when plan.json is
  // missing/mismatched (rare) — no worse than the old always-stale behavior.
  const freshBasePrompt = currentPlan
    ? buildReplacementPrompt(item, themePlanCreativeDirection(currentPlan), loadedTheme.manifest, currentPlan, backgroundMode)
    : item.prompt;
  const prompt = selectThemeImageRetryPrompt(freshBasePrompt, replacementPrompt, feedback, mode);

  // p59-t3: structured counterpart of the string `prompt` selected above.
  // 'retry' rerolls the current contract unchanged; 'replace' swaps
  // theme.creativeDirection for the user's notes (mirrors replacementPrompt
  // exactly). 'augment'/'custom' instead carry the notes in
  // options.retryNotes (StructuredGenerateRequest, src/core/themePromptTemplates.ts)
  // — assembleThemePrompt appends it at the same place the old client-side
  // "REVISION NOTES" wrapper did, capped to 600 chars (docs/theme-service-api.md
  // options) since it rides the wire now instead of staying purely local.
  const fallbackPlan = { display_name: loadedTheme.manifest.display_name, creative_direction: '', environment: '' } as ThemePlan;
  const structuredCreativeDirection = mode === 'replace'
    ? notes
    : themePlanCreativeDirection(currentPlan ?? fallbackPlan);
  const structuredRequest = buildReplacementRequest(item, structuredCreativeDirection, loadedTheme.manifest, currentPlan, backgroundMode);
  if (mode === 'augment' || mode === 'custom') {
    const retryNotes = notes.slice(0, 600);
    if (retryNotes) {
      structuredRequest.options = { ...(structuredRequest.options ?? {}), retryNotes };
    }
  }
  // Partial-keep only applies when the caller asked for it AND there is
  // something on disk worth preserving. Honest framing: the full board is
  // generated either way (same cost/time as a full retry) — only what gets
  // KEPT afterward differs. Never imply this is cheaper or faster.
  const wantsPartialKeep = requestedSlots.length > 0 && hasPriorFrames;
  onProgress?.(
    wantsPartialKeep
      ? `Regenerating the full ${item.label} board (trying to keep the selected frame${requestedSlots.length === 1 ? '' : 's'} only)...`
      : `Regenerating ${item.label}...`,
  );

  // p59-t3: the walk pose-guide reference image is no longer attached
  // client-side — the service attaches its own pose-guide image for
  // roster_agent attempts server-side (docs/theme-service-api.md Migration).

  let generated: Buffer;
  let attempt: ThemeImageGenerateValue;
  try {
    attempt = item.kind === 'environment'
      ? await generateEnvironmentImage(themeId, item, structuredRequest, imageGenerationOptions, prompt)
      : await generateBoardImage(themeId, item, structuredRequest, spriteBoardOptions(imageGenerationOptions), prompt);
    generated = attempt.image;
  } catch (error) {
    await recordUserCorrectableGenerationError(globalStorageUri, themeId, item.id, error);
    throw error;
  }
  throwIfCancelled(undefined, imageGenerationOptions.signal);
  const { manifest, frames } = loadedTheme;
  // Captured before the slice call, same as applySlicedAtlasFromBuffer's own
  // `previousFrameKeys` — needed below to reproduce its merge-safe write key
  // scope once retryThemeImage takes over the write.
  const previousFrameKeys = item.frame_keys;
  // skipWrite: true whenever partial-keep was requested. At this point we
  // don't yet know if it's actually ELIGIBLE (that needs frameKeys, which
  // only exists after slicing) — but deferring the write is always safe: on
  // the ineligible path below we immediately perform the exact same
  // full-replace write applySlicedAtlasFromBuffer would have done itself, so
  // behavior there is unchanged. This is what closes the data-loss window:
  // the full new board is never persisted on its own; only the FINAL
  // (possibly merged) frame set ever reaches disk, in one mutex-protected
  // writeThemeFiles call.
  const { frameKeys } = await applySlicedAtlasFromBuffer(
    globalStorageUri,
    themeId,
    manifest,
    frames,
    item,
    generated,
    imageGenerationOptions.signal,
    true,
    wantsPartialKeep,
  );

  // Character atlases are the one board shape with exactly ONE frame_keys
  // entry whose stored array holds MANY frames (all poses under one key —
  // see applySlicedAtlasFromBuffer's character_atlas branch). For every
  // other kind, `frame_keys.length` keys each hold one clip, so a slot index
  // addresses a KEY (a clip is unsplittable — see the multi-key branch
  // below). Detected structurally from what was actually stored before this
  // retry (priorFrameKeys/priorFrames), never from item.kind, so this stays
  // correct even for legacy/edge-case documents.
  const singleKeyMultiFrame = wantsPartialKeep
    && priorFrameKeys.length === 1
    && (priorFrames[priorFrameKeys[0]]?.length ?? 0) > 1;

  // Merge step: restore either the non-selected WITHIN-KEY frames (character
  // boards) or the non-selected KEYS (every other board) to their pre-retry
  // stored values, keeping only the requested indices from the freshly-sliced
  // board, ALL IN MEMORY before anything is written.
  // Tracks whether the partial-keep merge actually applied (as opposed to
  // falling back to a full-board replace below because the regenerated
  // board's shape didn't match what was stored). Feeds the honesty check
  // right before the write, which corrects the optimistic up-front message
  // above when this stays false.
  let partialKeepApplied = false;
  if (singleKeyMultiFrame) {
    // Character path: index into the sole key's frame array, not into
    // frameKeys (which is always length 1 here and useless as an address).
    const key = priorFrameKeys[0];
    const priorPoses = priorFrames[key] ?? [];
    const newPoses = frames[key] ?? [];
    // Edge case: the freshly-sliced board didn't produce the same pose count
    // as what was stored (e.g. a slicing-contract change). Indices are only
    // meaningful when both pose arrays share the same shape, so fall back to
    // the full new board, same as an ordinary retry — matches the ordinary
    // key-count-mismatch fallback below.
    if (newPoses.length === priorPoses.length) {
      const keepIndices = new Set(requestedSlots.filter((index) => index >= 0 && index < newPoses.length));
      // Out-of-range indices are dropped by the filter above rather than
      // throwing, so one bad index from a stale client doesn't fail the
      // whole retry.
      const merged = newPoses.map((newPose, index) => (keepIndices.has(index) ? newPose : priorPoses[index]));
      frames[key] = merged;
      partialKeepApplied = true;
    }
  } else if (wantsPartialKeep && frameKeys.length === priorFrameKeys.length) {
    // Two edge cases fall back to a full replace:
    //   - !wantsPartialKeep (no slots requested, or first generation with
    //     nothing stored yet) — frames/frameKeys are left exactly as
    //     applySlicedAtlasFromBuffer produced them.
    //   - frameKeys.length !== priorFrameKeys.length (the new board sliced to
    //     a DIFFERENT key count than what was stored — a grid/manifest
    //     mismatch). Indices are only meaningful when both boards share the
    //     same shape, so treat this as unsafe to partially merge and keep the
    //     full new board instead, same as an ordinary retry.
    const keepIndices = new Set(requestedSlots.filter((index) => index >= 0 && index < frameKeys.length));
    // Out-of-range indices are dropped by the filter above (never touch a
    // key outside the board's own key list) rather than throwing, so one bad
    // index from a stale client doesn't fail the whole retry.
    for (let index = 0; index < frameKeys.length; index++) {
      if (keepIndices.has(index)) continue; // selected: keep the NEW slice already in `frames`
      const key = frameKeys[index];
      const priorValue = priorFrames[key];
      if (priorValue) frames[key] = priorValue;
      // else: this key had no prior stored value (shouldn't happen given
      // hasPriorFrames/length-match guards above) — leave the new slice in
      // place rather than deleting a key the board contract still expects.
    }
    partialKeepApplied = true;
  }
  // Honesty check for the optimistic up-front message above: partial-keep
  // was REQUESTED but neither merge branch's eligibility guard passed (a
  // pose-count or key-count mismatch against what was stored). The full new
  // board is still kept and written below — never silently discarded — but
  // the user was told their selected frames would survive, so say plainly
  // that they didn't.
  if (wantsPartialKeep && !partialKeepApplied) {
    onProgress?.(
      `Couldn't preserve the selected frame${requestedSlots.length === 1 ? '' : 's'} for ${item.label} — the `
      + 'regenerated board\'s frame layout did not match the previous one, so the whole board was replaced.',
    );
  }
  // The review board image at images/<filename>.png was written by
  // applySlicedAtlasFromBuffer above as the RAW freshly-generated board —
  // correct when the full board was kept, but stale when partialKeepApplied
  // just restored some of that board's cells back to their pre-retry values:
  // without this, the review UI would show an all-new board even though only
  // the requested slot(s) were actually adopted. Re-composite the on-disk
  // image from the FINAL merged `frames` so the preview matches what the
  // game will render. Never touches frames.json/the merge itself — display
  // only. Environment items are excluded (grid-less single 512×512 image,
  // never eligible for a grid recomposite).
  if (partialKeepApplied && item.kind !== 'environment') {
    const boardGrid = reviewBoardGridForItemKind(item);
    if (boardGrid) {
      const recomposited = await compositeBoardFromFrameKeys(frameKeys, frames, boardGrid.columns, boardGrid.rows);
      const reviewBoardBuffer = item.kind === 'character_atlas'
        ? await resizeSpriteBoardCanvas(recomposited, 512, 512)
        : recomposited;
      await saveReviewImage(globalStorageUri, themeId, item.filename, reviewBoardBuffer);
    }
  }
  // Single write for BOTH branches (merged partial-keep result, or the
  // untouched full new board when partial-keep wasn't requested/eligible) —
  // this is the one and only persist for the whole retry. Key scope matches
  // applySlicedAtlasFromBuffer's own merge-safe write exactly (new keys plus
  // anything this item just dropped), so the lost-update protection against a
  // concurrently-retrying different board is unchanged.
  if (wantsPartialKeep) {
    await writeThemeFiles(globalStorageUri, manifest, frames, [
      ...new Set([...frameKeys, ...previousFrameKeys]),
    ]);
  }

  await upsertThemeImageReviewItem(globalStorageUri, themeId, document.display_name, {
    ...item,
    status: 'pending',
    generation_error: undefined,
    error_kind: undefined,
    ...recordAttemptCharge(item, attempt),
    prompt,
    revision: item.revision + 1,
    frame_keys: frameKeys,
    updated_at: new Date().toISOString(),
  });
  onProgress?.(`${item.label} regenerated and ready for review.`);
  return { manifest, frames };
}

async function generateOrResumeThemeItem(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  displayName: string,
  item: Omit<ThemeImageReviewItem, 'updated_at'> & { updated_at?: string },
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  onProgress: (message: string) => void,
  isCancelled: (() => boolean) | undefined,
  onReviewReady: ((themeId: string) => void) | undefined,
  waitForReview: WaitForThemeImageReview | undefined,
  generate: () => Promise<void>,
): Promise<void> {
  throwIfCancelled(isCancelled);
  const generateOrResumeStore = resolveThemeFileStore(globalStorageUri);
  const imagePath = `${themeImagesDirectoryPath(themeId)}/${item.filename}`;
  const complete = isThemeGenerationItemComplete(item, await generateOrResumeStore.exists(imagePath), frames);
  throwIfCancelled(isCancelled);

  // Completed items are the checkpoint. Resume advances directly to the first
  // unfinished item and never spends another provider request on earlier work.
  if (complete) return;

  // A safety-blocked item needs revised user direction, not an automatic replay
  // of the same request. Restore the same replacement gate used by a live run.
  if (item.generation_error) {
    const review = waitForReview?.(themeId, item.id, { requiresReplacement: true });
    onReviewReady?.(themeId);
    onProgress(`${item.label} still needs revised instructions before generation can continue.`);
    if (!review) throw new Error(`${item.label} needs revised instructions before generation can continue.`);
    const replacement = await review;
    if (!replacement) throw new Error(`${item.label} needs a generated replacement before generation can continue.`);
    applyThemeReplacement(manifest, frames, replacement);
    return;
  }

  // Recover frames by RE-SLICING the raw atlas already saved to disk, instead
  // of burning an AI call — e.g. a board that was ACCEPTED in review but whose
  // sliced frames.json entry was lost to a failed/raced persist. The art is
  // unchanged, so this must NOT touch item.status (an accepted board must stay
  // accepted). Only boards that support re-slicing and actually have a raw
  // image on disk take this path; anything else falls through to AI
  // generation exactly as before, including on any re-slice failure.
  if (RESLICEABLE_ATLAS_KINDS.has(item.kind)) {
    try {
      const rawPath = `${themeRawImagesDirectoryPath(themeId)}/${item.filename}`;
      if (await generateOrResumeStore.exists(rawPath)) {
        const rawBuffer = Buffer.from(await generateOrResumeStore.readFile(rawPath));
        const { frameKeys } = await applySlicedAtlasFromBuffer(
          globalStorageUri,
          themeId,
          manifest,
          frames,
          item as ThemeImageReviewItem,
          rawBuffer,
          undefined,
          false,
        );
        await upsertThemeImageReviewItem(globalStorageUri, themeId, displayName, {
          ...item,
          frame_keys: frameKeys,
          updated_at: new Date().toISOString(),
        });
        onProgress(`${item.label} frames recovered from the saved original — no regeneration needed.`);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onProgress(`${item.label} could not be re-sliced from its saved original (${message}); regenerating instead.`);
    }
  }

  await generateAndReviewThemeItem(
    globalStorageUri,
    themeId,
    displayName,
    item,
    manifest,
    frames,
    onProgress,
    onReviewReady,
    waitForReview,
    generate,
  );
}

async function generateAndReviewThemeItem(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  displayName: string,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  onProgress: (message: string) => void,
  onReviewReady: ((themeId: string) => void) | undefined,
  waitForReview: WaitForThemeImageReview | undefined,
  generate: () => Promise<void>,
): Promise<void> {
  try {
    await generate();
  } catch (error) {
    const recorded = await recordUserCorrectableGenerationError(
      globalStorageUri,
      themeId,
      item.id,
      error,
    );
    if (!recorded) throw error;

    const review = waitForReview?.(themeId, item.id, { requiresReplacement: true });
    onReviewReady?.(themeId);
    onProgress(
      isThemeGenerationServiceError(error)
        ? `${item.label} could not be generated (${error.kind.replace(/_/g, ' ')}). Resolve it, then retry.`
        : `${item.label} was blocked by the image safety check. Revise its instructions and retry to continue.`,
    );
    if (!review) throw error;
    const replacement = await review;
    if (!replacement) throw error;
    applyThemeReplacement(manifest, frames, replacement);
    return;
  }

  await reviewGeneratedImage(
    themeId,
    item,
    manifest,
    frames,
    onProgress,
    onReviewReady,
    waitForReview,
  );
}

/**
 * The review item's error_kind field surfaces the six distinct kinds
 * docs/theme-service-api.md's error table maps to their own client UI state
 * (not_signed_in, insufficient_credits, unavailable, unreachable,
 * provider_failed, rate_limited — "try again shortly", a different message
 * than unavailable's "Theme Service unavailable") — see p43-t1/p43 review
 * fix. Only `server_error`/`invalid_response` (no table entry of their own)
 * fold into `unavailable`.
 */
function mapToReviewErrorKind(kind: ThemeServiceErrorKind): NonNullable<ThemeImageReviewItem['error_kind']> {
  switch (kind) {
    case 'not_signed_in':
    case 'insufficient_credits':
    case 'content_blocked':
    case 'account_locked':
    case 'unavailable':
    case 'unreachable':
    case 'provider_failed':
    case 'rate_limited':
    case 'bad_request':
      return kind;
    default:
      return 'unavailable';
  }
}

export async function recordUserCorrectableGenerationError(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  itemId: string,
  error: unknown,
): Promise<boolean> {
  if (isThemeGenerationServiceError(error)) {
    // content_blocked and account_locked are pre-debit failures — the ledger
    // was never charged (no credit_ledger row at all, see docs/theme-service-api.md
    // "Content screening" / "Strikes and account lock"), so the attempt cost
    // recorded here is 0 and it is never a "refund" (nothing to refund).
    const isBlockedOrLocked = error.kind === 'content_blocked' || error.kind === 'account_locked';
    // refunded === false means the backend debited and did not (or could not)
    // refund; absent/true means nothing net was charged (pre-screen blocks
    // carry no refunded flag at all).
    let chargedCost: number | undefined;
    if (error.refunded === false) {
      const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
      const failedItem = document?.items.find((candidate) => candidate.id === itemId);
      const quoted = failedItem ? currentAttemptCostResolver?.(boardTypeForItem(failedItem)) : undefined;
      if (typeof quoted === 'number') chargedCost = quoted;
    }
    await setThemeImageReviewErrorKind(
      globalStorageUri,
      themeId,
      itemId,
      mapToReviewErrorKind(error.kind),
      isBlockedOrLocked ? false : error.refunded,
      isBlockedOrLocked ? 0 : undefined,
      error.code,
      error.categories,
      error.fields,
      // Review fix: stamps this run's session id so panel.ts's
      // _postThemeImageReview can tell this LIVE failure (covers both a
      // fresh first-time generation failure — generateAndReviewThemeItem,
      // no prior THEME_IMAGE_REVIEW post to gate on — and a retry failure)
      // from one merely loaded from disk after a reload/restart.
      THEME_SERVICE_HOST_SESSION_ID,
      chargedCost,
    );
    console.error('TycoonAgents: Theme Service generation attempt failed.', {
      themeId,
      itemId,
      kind: error.kind,
      code: error.code,
      refunded: error.refunded,
      credits: error.credits,
    });
    return true;
  }
  if (!isUserCorrectableImageGenerationError(error)) return false;
  const details = error as ImageGenerationApiError;
  await setThemeImageGenerationError(globalStorageUri, themeId, itemId, {
    provider: details.provider,
    code: details.code,
    message: details.message,
    request_id: details.requestId,
    moderation_stage: details.moderationDetails?.moderation_stage,
    categories: details.moderationDetails?.categories,
  });
  console.error('TycoonAgents: Image generation requires a revised request.', {
    themeId,
    itemId,
    status: details.status,
    code: details.code,
    requestId: details.requestId,
    moderationDetails: details.moderationDetails,
  });
  return true;
}

async function reviewGeneratedImage(
  themeId: string,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  onProgress: (message: string) => void,
  onReviewReady: ((themeId: string) => void) | undefined,
  waitForReview: WaitForThemeImageReview | undefined,
): Promise<void> {
  const review = waitForReview?.(themeId, item.id);
  onReviewReady?.(themeId);
  if (!review) return;

  onProgress(`${item.label} is ready. Keep it to continue.`);
  const replacement = await review;
  if (!replacement) return;
  applyThemeReplacement(manifest, frames, replacement);
}

function applyThemeReplacement(
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  replacement: ThemeGenerationResult,
): void {
  // A retry can replace the image while generation is paused. Carry that
  // updated theme state forward so the next generated asset cannot overwrite it.
  Object.assign(manifest, replacement.manifest);
  for (const key of Object.keys(frames)) delete frames[key];
  Object.assign(frames, replacement.frames);
}

/** Exported so tests can exercise the REAL production grid config (registration
 * groups, feet anchor, clipWidthOverflow) rather than a hand-rolled stand-in. */
export function characterAtlasGrid(rebuildBoard = false, bodyPlan: BodyPlan = 'biped') {
  const clipGroups = Object.values(ATLAS_CLIPS).map((clip) => clip.frames);
  // Melee's wind-up (frame 10, weapon coiled HIGH) and strike (frame 11, lunge LOW)
  // are DISTINCT poses; unioning them into one normalization bbox spans a tall
  // vertical range that trips the maxContentExtent cap and shrinks BOTH row-3 cells
  // below board scale. Normalize each melee cell to its OWN bbox (like the aim cells)
  // while keeping melee in registrationGroups for horizontal stability.
  const normalizationGroups = Object.entries(ATLAS_CLIPS)
    .filter(([name]) => name !== 'melee')
    .map(([, clip]) => clip.frames);
  const isQuadruped = bodyPlan === 'quadruped';
  return {
    columns: 5,
    rows: 4,
    // Walking and neutral-standing slots are stable body-height references.
    scaleReferenceSlots: [0, 1, 2, 3, 4, 16],
    // Four-legged bodies read wide rather than tall (body + tail + mid-stride
    // legs), so they're fit to a target WIDTH instead of height — sizing a
    // cat/dog by height alone left it visibly smaller than a biped at the
    // same body-height. Two-legged characters are unaffected (still height-fit).
    ...(isQuadruped
      ? { targetContentWidth: CHARACTER_QUADRUPED_TARGET_CONTENT_WIDTH }
      : { targetContentHeight: CHARACTER_TARGET_CONTENT_HEIGHT }),
    // Raised 120 -> 126 so characters fill ~92-98% of the 128px frame (less
    // downscaling of the 1024px source = sharper); still <= 128 so nothing clips.
    // Quadrupeds keep the tighter rival-style 120: their wide silhouette
    // (tail, mid-stride legs) sits closer to the frame edge than a biped's at
    // the same fit, so 126/128 would leave them almost no margin.
    maxContentExtent: isQuadruped ? 120 : 126,
    // Group each animation CLIP's frames so they share one union bbox/crop/anchor,
    // mirroring the rival/object row grouping. Prevents walk/build/shoot/dance
    // frames jumping horizontally as pose mass shifts. Single-frame clips (idle,
    // point, etc.) become harmless 1-member groups. Melee is EXCLUDED here (each
    // of its cells normalizes to its own bbox) but stays in registrationGroups.
    normalizationGroups,
    // Every clip (walk, melee, build, shoot, dance, ...) plays in place, so any
    // drawn side-to-side drift across its frames is unwanted and gets canceled.
    registrationGroups: clipGroups,
    // A flowing cape trailing BELOW the feet would otherwise inflate the content
    // bbox and lift the figure; trim the thin below-feet drag so scale + anchor
    // key to the dense feet row instead of the sparse cape tip. Also keeps
    // quadruped feet anchored to the same ground line as bipeds (destY is
    // always 128 - resizedHeight, so bottom-justification is automatic once
    // the bbox's bottom is the feet, not a trailing tail).
    feetAnchorMinWidthRatio: 0.2,
    // Character poses must all render at the same (board) height. A wide pose
    // (extended weapon/arms) would otherwise trip the width caps and shrink its
    // whole clip below board scale; clip the horizontal overflow at the frame
    // edge instead. Height caps stay in force so heads/feet are never clipped.
    // Quadrupeds are excluded: their boardScale is driven by targetContentWidth
    // (the whole point is a WIDTH budget, not a height one), so clipping width
    // overflow here would silently slice a tail/leg at the cell edge -- exactly
    // what the width budget exists to prevent. The width caps (maxContentExtent/
    // 128 on bw) apply to quadrupeds instead, same as any non-character grid.
    clipWidthOverflow: !isQuadruped,
    // Character atlases: nudge each interior grid cut into a nearby
    // background gap (alpha 0, or chroma-magenta on a magenta board — within
    // ~8% of the cell size) instead of always cutting exactly on the
    // proportional line. Enabled for ALL character boards, not only
    // four-legged ones: on a well-behaved biped board with no gap in the
    // search window it's a no-op (falls back to the proportional cut, see
    // AtlasGrid.snapGutterBoundaries doc), so there's no regression risk, and
    // it also helps any biped board whose weapon/cape strays slightly past
    // the nominal boundary. This mirrors how afbf825 enabled it
    // unconditionally for all rivals rather than gating it per-enemy-type.
    snapGutterBoundaries: true,
    gutterKeyColor: 'magenta',
    rebuildBoard,
    squareReviewBoard: rebuildBoard,
  } satisfies AtlasGrid;
}

async function processCharacterAtlas(
  generated: Buffer,
  manifest: ThemeManifest,
  bodyPlan: BodyPlan = 'biped',
): Promise<{ output: Buffer; spritePackage: Awaited<ReturnType<typeof sliceAndNormalizeAtlas>> }> {
  // Normalize from the provider's full-resolution output so undersized source
  // sprites retain as much detail as possible when fitted to the 128px cells.
  const normalized = await sliceAndNormalizeAtlas(generated, manifest, characterAtlasGrid(true, bodyPlan));
  // The retained/reviewed character canvas is an exact 512x512 artifact.
  // Frames stay at 128x128 and are not re-sliced from this presentation board.
  const output = await resizeSpriteBoardCanvas(normalized.board!, 512, 512);
  return { output, spritePackage: normalized };
}

/**
 * Slice one of the two fixed 4x4 (16-cell) object boards.
 *   - Board 1 (all `object_static` rows, length OBJECT_BOARD1_STATIC_COUNT):
 *     each cell is an independent single-frame object, normalized on its own
 *     (no grouping/registration needed since there is nothing to keep in
 *     sync across frames).
 *   - Board 2 (`[object_anim, object_anim, poof, object_static,
 *     object_static, object_static, crate]`): row 1 (cells 0-3) and row 2
 *     (cells 4-7) are each a 4-frame animated-object group; cells 8-11 are
 *     the 4-frame poof group (row 3); cells 12-14 are the three single-frame
 *     static objects (the first three cells of row 4); cell 15 is the
 *     single-frame crate (the last cell of row 4). Only the two
 *     animated-object groups are horizontally registered — poof is a
 *     one-shot FX whose frames are meant to differ, and the static/crate
 *     cells are single-frame, so registering any of them is a no-op at best.
 */
async function processObjectAtlas(
  generated: Buffer,
  manifest: ThemeManifest,
  rows: ThemeObjectBoardRow[],
): Promise<{ output: Buffer; spritePackage: Awaited<ReturnType<typeof sliceAndNormalizeAtlas>> }> {
  const isBoard2 = rows.some((row) => row.kind === 'object_anim' || row.kind === 'poof' || row.kind === 'crate');
  if (isBoard2) {
    if (rows.length !== OBJECT_ANIMATED_COUNT + OBJECT_BOARD2_STATIC_COUNT + 2) {
      throw new Error('Object board 2 requires exactly two animated objects, one poof entry, three static objects, and one crate entry.');
    }
    const animGroups = [[0, 1, 2, 3], [4, 5, 6, 7]];
    const poofGroup = [8, 9, 10, 11];
    const staticGroups = [[12], [13], [14]];
    const crateGroup = [15];
    const spritePackage = await sliceAndNormalizeAtlas(generated, manifest, {
      columns: 4,
      rows: 4,
      // Scale reference includes BOTH animated groups and the 3 new static
      // object cells (real buildable objects) — poof/crate are FX/props, not
      // objects, so they stay out of the reference set as before.
      scaleReferenceSlots: [...animGroups[0], ...animGroups[1], ...staticGroups.flat()],
      targetContentHeight: 104,
      maxContentExtent: 120,
      normalizationGroups: [...animGroups, poofGroup, ...staticGroups, crateGroup],
      registrationGroups: animGroups,
      // The 2 animated objects animate lighting/glow in place; brightness-based
      // registration gets fooled by the lighting change and bakes side-to-side
      // drift. Align by silhouette overlap only. Objects only — chars/rivals
      // keep RGB registration.
      registrationShapeOnly: true,
      // Never enlarge small drawn content beyond its native crop size — avoids
      // jagged nearest-neighbor upscaling when the image model draws an object
      // small in its cell.
      noUpscale: true,
      // Buildable-object boards resize with bicubic (smooth) instead of
      // nearest-neighbor; the black-background recolor below prevents magenta
      // bleed into the smoothed edges.
      smoothResize: true,
      // Object boards only: clear a stray fragment leaked in from the LEFT or
      // RIGHT neighbor cell so it never widens the per-cell bbox and pushes
      // the object into the neighboring cell.
      removeHorizontalStrayColumns: true,
    });
    const output = await optimizeSpriteBoardCanvas(generated, 4, 4, { resample: 'bicubic' });
    return { output, spritePackage };
  }
  if (rows.length !== OBJECT_BOARD1_STATIC_COUNT) {
    throw new Error(`Object board 1 requires exactly ${OBJECT_BOARD1_STATIC_COUNT} static-object cells.`);
  }
  const allSlots = Array.from({ length: OBJECT_BOARD1_STATIC_COUNT }, (_unused, index) => index);
  const spritePackage = await sliceAndNormalizeAtlas(generated, manifest, {
    columns: 4,
    rows: 4,
    scaleReferenceSlots: allSlots,
    targetContentHeight: 104,
    maxContentExtent: 120,
    normalizationGroups: allSlots.map((slot) => [slot]),
    // Never enlarge small drawn content beyond its native crop size — avoids
    // jagged nearest-neighbor upscaling when the image model draws an object
    // small in its cell.
    noUpscale: true,
    // Buildable-object boards resize with bicubic (smooth) instead of
    // nearest-neighbor; the black-background recolor below prevents magenta
    // bleed into the smoothed edges.
    smoothResize: true,
    // Object boards only: clear a stray fragment leaked in from the LEFT or
    // RIGHT neighbor cell so it never widens the per-cell bbox and pushes
    // the object into the neighboring cell.
    removeHorizontalStrayColumns: true,
  });
  const output = await optimizeSpriteBoardCanvas(generated, 4, 4, { resample: 'bicubic' });
  return { output, spritePackage };
}

/**
 * Slice a compact 5x4 rival board: each of the four ROWS is one enemy's 5-frame
 * mini-atlas ([walk0, walk1, walk2, attack0, attack1]). Group each row's five cells
 * so its frames share a common crop/anchor, mirroring the object-board approach.
 */
export async function processRivalAtlas(
  generated: Buffer,
  manifest: ThemeManifest,
  rows: ThemeRivalBoardRow[],
  backgroundMode: BoardBackgroundMode = boardBackgroundModeForProvider(),
): Promise<{ output: Buffer; spritePackage: Awaited<ReturnType<typeof sliceAndNormalizeAtlas>> }> {
  if (rows.length < 1 || rows.length > 4) throw new Error('Rival board carries one to four rows.');
  const rowGroups = Array.from({ length: rows.length }, (_row, rowIndex) =>
    Array.from({ length: 5 }, (_col, colIndex) => rowIndex * 5 + colIndex),
  );
  // Four-legged rows are fit by WIDTH exactly like four-legged characters
  // (characterAtlasGrid): their own shared scale, target and cap, applied to
  // the whole row including the attack frames. Two-legged rows keep the
  // height fit below; a board with no four-legged row is configured exactly
  // as before (no overrides).
  const quadrupedRowIndexes = rows
    .map((row, index) => (row.body_plan === 'quadruped' ? index : -1))
    .filter((index) => index >= 0);
  const spritePackage = await sliceAndNormalizeAtlas(generated, manifest, {
    columns: 5,
    rows: rows.length,
    ...(quadrupedRowIndexes.length
      ? {
        rowScaleOverrides: [{
          rows: quadrupedRowIndexes,
          targetContentWidth: CHARACTER_QUADRUPED_TARGET_CONTENT_WIDTH,
          maxContentExtent: 120,
        }],
      }
      : {}),
    scaleReferenceSlots: Array.from({ length: rows.length * 5 }, (_unused, cell) => cell),
    targetContentHeight: CHARACTER_TARGET_CONTENT_HEIGHT,
    // Lowered from the character/126 value to 120: rivals' wide appendages
    // (limbs, tentacles, particle trails) routinely push closer to the frame
    // edge than a character's silhouette does, so 126/128 left rivals almost
    // no margin before clipping. 120 restores a small buffer while still
    // filling most of the 128px frame.
    maxContentExtent: 120,
    normalizationGroups: rowGroups,
    // Each row's walk+attack frames are one rival animating in place, so any
    // drawn side-to-side drift across the row is unwanted and gets canceled.
    registrationGroups: rowGroups,
    // Same cape-drag guard as characters: trim thin below-feet content so scale +
    // bottom-justify anchor to the dense feet row, not a trailing cape tip.
    feetAnchorMinWidthRatio: 0.2,
    // Rival-only: nudge each interior grid cut into a nearby background gap
    // (alpha 0, or chroma-magenta on a magenta board — within ~8% of the
    // cell size) instead of always cutting exactly on the proportional line,
    // so a limb/tentacle that spills slightly past the nominal boundary is
    // less likely to be sliced. Production boards are magenta-keyed
    // (boardBackgroundModeForProvider), so gutterKeyColor must be passed
    // through or the gap search only ever finds alpha-0 pixels, which never
    // occur on a magenta board and make snapping a silent no-op. Never
    // enabled for other boards.
    snapGutterBoundaries: true,
    gutterKeyColor: 'magenta',
  });
  const output = await optimizeSpriteBoardCanvas(generated, 5, rows.length);
  return { output, spritePackage };
}

async function processDecorAtlas(
  generated: Buffer,
  manifest: ThemeManifest,
): Promise<{ output: Buffer; spritePackage: Awaited<ReturnType<typeof sliceAndNormalizeAtlas>> }> {
  // 4x4 board: rows 1-2 are four single-frame cells each; rows 3-4 are each one
  // four-frame animation. Group the two animation rows so their frames share a
  // common crop/anchor, while every static cell is normalized on its own.
  const staticGroups = Array.from({ length: 8 }, (_unused, cell) => [cell]);
  const animGroups = [[8, 9, 10, 11], [12, 13, 14, 15]];
  const spritePackage = await sliceAndNormalizeAtlas(generated, manifest, {
    columns: 4,
    rows: 4,
    scaleReferenceSlots: Array.from({ length: 16 }, (_unused, cell) => cell),
    targetContentHeight: 104,
    maxContentExtent: 120,
    normalizationGroups: [...staticGroups, ...animGroups],
    // Only the loopable animated decor row (8-11) plays in place; the
    // projectile row (12-15) is a one-shot launch-to-impact whose frames are
    // meant to differ, so it is excluded from horizontal registration.
    registrationGroups: [animGroups[0]],
  });
  const output = await optimizeSpriteBoardCanvas(generated, 4, 4);
  return { output, spritePackage };
}

/**
 * Map the 16 sliced cells to their frame keys:
 *   row 1 cells 0-3   → four single-frame seats (`decor_<id>`),
 *   row 2 cells 4-7   → four single-frame decor (`decor_<id>`),
 *   row 3 cells 8-11  → one four-frame animated decor (`decor_<id>`),
 *   row 4 cells 12-15 → the ranged-weapon-fire projectile FX (`projectile`, four frames).
 */
function applyDecorBoardFrames(
  frames: Record<string, string[]>,
  slots: Array<{ slot_id: number; data: string }>,
  rows: ThemeDecorBoardRow[],
): string[] {
  const keys: string[] = [];
  const seat = rows.filter((row) => row.kind === 'seat');
  const staticDecor = rows.filter((row) => row.kind === 'decor');
  const animated = rows.filter((row) => row.kind === 'decor_anim');
  const hasProjectile = rows.some((row) => row.kind === 'projectile');

  seat.forEach((row, index) => {
    const key = `decor_${row.decor_id}`;
    frames[key] = slots[index] ? [slots[index].data] : [];
    keys.push(key);
  });
  staticDecor.forEach((row, index) => {
    const key = `decor_${row.decor_id}`;
    frames[key] = slots[4 + index] ? [slots[4 + index].data] : [];
    keys.push(key);
  });
  animated.forEach((row, index) => {
    const key = `decor_${row.decor_id}`;
    const start = 8 + index * 4;
    frames[key] = slots.slice(start, start + 4).map((slot) => slot.data);
    keys.push(key);
  });
  if (hasProjectile) {
    // Row 4 (cells 12-15) is the one-shot projectile FX; keyed `projectile`.
    frames.projectile = slots.slice(12, 16).map((slot) => slot.data);
    keys.push('projectile');
  }
  return keys;
}

/** Regroup a flat decor-row list back into the 4x4 board's [seats, statics, [anim], [projectile]] shape. */
function decorRowsToBoard(rows: ThemeDecorBoardRow[]): ThemeDecorBoardRow[][] {
  const seats = rows.filter((row) => row.kind === 'seat');
  const statics = rows.filter((row) => row.kind === 'decor');
  const animated = rows.filter((row) => row.kind === 'decor_anim');
  const projectile = rows.find((row) => row.kind === 'projectile') ?? { kind: 'projectile' as const };
  return [seats, statics, [animated[0]], [projectile]];
}

function themeDecorSpecs(
  manifest: ThemeManifest,
  descriptions?: string[],
): Array<{ decor_id: string; display_name: string; visual_description?: string }> {
  return (manifest.decor_objects ?? []).slice(0, 9).map((decor, index) => {
    const description = (descriptions?.[index] ?? '').trim();
    return {
      decor_id: decor.decor_id,
      display_name: decor.display_name,
      ...(description ? { visual_description: description } : {}),
    };
  });
}

export function createReviewItems(
  plan: ThemePlan,
  manifest: ThemeManifest,
  creativeDirection: string,
  backgroundMode: BoardBackgroundMode = 'magenta',
): Array<Omit<ThemeImageReviewItem, 'updated_at'>> {
  const characterCreativeDirection = `Creative direction: ${plan.creative_direction}`;
  const characterItems = manifest.roster_agents.map((agent) => {
    const bodyPlan = effectiveCharacterBodyPlan(plan, agent.slot_id);
    // p59-t3: the service always attaches its own pose-guide reference image
    // for roster_agent attempts now, so the local preview always includes
    // the pose-guide paragraph too (see docs/theme-service-api.md Migration).
    const walkPoseGuide = bodyPlan;
    return {
      id: `agent_${agent.slot_id}`,
      filename: `agent_${String(agent.slot_id + 1).padStart(2, '0')}_${toSafeFileStem(agent.name)}.png`,
      label: agent.name,
      kind: 'character_atlas' as const,
      status: 'pending' as const,
      prompt: buildCharacterAtlasPrompt(
        characterCreativeDirection,
        agent.name,
        plan.display_name,
        backgroundMode,
        resolveCharacterDescription(plan.character_descriptions?.[agent.slot_id], agent.name),
        walkPoseGuide ? { walkPoseGuide } : undefined,
      ),
      revision: 0,
      frame_keys: [`agent_${agent.slot_id}`],
      subject: agent.name,
      character_description: (plan.character_descriptions?.[agent.slot_id] ?? '').trim() || undefined,
      body_plan: plan.character_body_plans?.[agent.slot_id],
    };
  });
  let enemyItems: Array<Omit<ThemeImageReviewItem, 'updated_at'>> = [];
  try {
    const rivalBoards = createRivalBoardRows(themeRivalSpecs(manifest, plan.enemy_descriptions, plan.enemy_body_plans));
    enemyItems = rivalBoards.map((rows, index) => {
      const firstEnemy = index * rows.length + 1;
      const lastEnemy = firstEnemy + rows.length - 1;
      return {
        id: `rivals_${String(index + 1).padStart(2, '0')}`,
        filename: `rivals_${String(index + 1).padStart(2, '0')}.png`,
        label: `Rivals ${firstEnemy}–${lastEnemy}`,
        kind: 'rival_atlas' as const,
        status: 'pending' as const,
        prompt: buildRivalAtlasPrompt(creativeDirection, plan.display_name, rows, backgroundMode),
        revision: 0,
        frame_keys: rivalBoardFrameKeys(rows),
        rival_rows: rows,
      };
    });
  } catch (err) {
    console.warn('TycoonAgents: skipping rival board items in review synthesis:', err);
    enemyItems = [];
  }
  let objectItems: Array<Omit<ThemeImageReviewItem, 'updated_at'>> = [];
  try {
    const objectSpecs = themeObjectSpecs(manifest, plan.object_motion_hints, plan.object_descriptions);
    const board1StaticSpecs = objectSpecs.slice(0, OBJECT_BOARD1_STATIC_COUNT);
    const board2StaticSpecs = objectSpecs.slice(OBJECT_BOARD1_STATIC_COUNT, OBJECT_STATIC_COUNT);
    const animatedSpecs = objectSpecs.slice(OBJECT_STATIC_COUNT, OBJECT_STATIC_COUNT + OBJECT_ANIMATED_COUNT);
    const board1Rows = createObjectBoard1Rows(board1StaticSpecs);
    const board2Rows = createObjectBoard2Rows(animatedSpecs, board2StaticSpecs, plan.poof_description, plan.crate_description);
    objectItems = [
      {
        id: 'objects_01',
        filename: 'objects_01.png',
        label: `Static objects 1–${OBJECT_BOARD1_STATIC_COUNT}`,
        kind: 'object_atlas' as const,
        status: 'pending' as const,
        prompt: buildObjectAtlasPrompt(creativeDirection, plan.display_name, board1Rows, backgroundMode),
        revision: 0,
        frame_keys: objectBoardFrameKeys(board1Rows),
        object_specs: board1StaticSpecs.map(({ object_id, display_name }) => ({ object_id, display_name })),
        object_rows: board1Rows,
      },
      {
        id: 'objects_02',
        filename: 'objects_02.png',
        label: `Objects ${OBJECT_BOARD1_STATIC_COUNT + 1}–${THEME_OBJECT_COUNT} (${OBJECT_BOARD2_STATIC_COUNT} static + ${OBJECT_ANIMATED_COUNT} animated) + build effects`,
        kind: 'object_atlas' as const,
        status: 'pending' as const,
        prompt: buildObjectAtlasPrompt(creativeDirection, plan.display_name, board2Rows, backgroundMode),
        revision: 0,
        frame_keys: objectBoardFrameKeys(board2Rows),
        object_specs: [...animatedSpecs, ...board2StaticSpecs].map(({ object_id, display_name }) => ({ object_id, display_name })),
        object_rows: board2Rows,
        crate_description: (plan.crate_description ?? '').trim() || undefined,
        poof_description: (plan.poof_description ?? '').trim() || undefined,
      },
    ];
  } catch (err) {
    console.warn('TycoonAgents: skipping object board items in review synthesis:', err);
    objectItems = [];
  }
  return [
    {
      id: 'environment',
      filename: 'environment.png',
      label: 'Environment',
      kind: 'environment',
      status: 'pending',
      prompt: buildEnvironmentPrompt(creativeDirection, plan.display_name),
      revision: 0,
      frame_keys: ['environment_background'],
      environment_description: (plan.environment ?? '').trim() || undefined,
    },
    ...characterItems,
    ...enemyItems,
    createDecorReviewItem(plan, manifest, creativeDirection, backgroundMode),
    ...objectItems,
    {
      id: 'expressions',
      filename: 'expressions.png',
      label: '8 expressions',
      kind: 'expression_atlas',
      status: 'pending',
      prompt: buildExpressionAtlasPrompt(
        creativeDirection,
        plan.display_name,
        plan.expressions,
        backgroundMode,
        plan.expression_descriptions,
      ),
      revision: 0,
      frame_keys: plan.expressions.map((_name, index) => `expression_${index}`),
      expression_names: plan.expressions,
      // Positional (index === expression cell) appearance text for the review
      // UI's Descriptions editor; may be absent (name-only prompt) — normalized
      // to a full-length array so each expression row always resolves cleanly.
      expression_descriptions: plan.expression_descriptions
        ? plan.expressions.map((_n, index) => plan.expression_descriptions?.[index] ?? '')
        : undefined,
    },
    {
      id: 'achievements',
      filename: 'achievements.png',
      label: '25 achievement badges',
      kind: 'achievement_atlas',
      status: 'pending',
      prompt: buildAchievementAtlasPrompt(
        creativeDirection,
        plan.display_name,
        plan.achievements,
        backgroundMode,
        plan.achievement_descriptions,
      ),
      revision: 0,
      frame_keys: plan.achievements.map((_name, index) => `achievement_${index}`),
      achievement_names: plan.achievements,
      // Positional (index === badge slot) appearance text for the review UI's
      // Descriptions editor; may be absent (name-only prompt) — normalized to
      // a full-length array so each badge row always resolves cleanly.
      achievement_descriptions: plan.achievement_descriptions
        ? plan.achievements.map((_n, index) => plan.achievement_descriptions?.[index] ?? '')
        : undefined,
    },
  ];
}

/**
 * Builds the review items for exactly one board type. Delegates to
 * createReviewItems — the single source of truth for prompts, filenames,
 * and frame-key/row metadata — so full theme generation and per-board
 * regeneration can never drift apart.
 */
export function buildBoardItems(
  plan: ThemePlan,
  manifest: ThemeManifest,
  board: BoardKind,
  backgroundMode: BoardBackgroundMode = 'magenta',
): Array<Omit<ThemeImageReviewItem, 'updated_at'>> {
  const creativeDirection = themePlanCreativeDirection(plan);
  const items = createReviewItems(plan, manifest, creativeDirection, backgroundMode);
  switch (board) {
    case 'agents':
      return items.filter((item) => item.kind === 'character_atlas');
    case 'enemy':
      return items.filter((item) => item.kind === 'rival_atlas');
    case 'environment':
      return items.filter((item) => item.id === 'environment');
    case 'decor':
      return items.filter((item) => item.id === 'background_decor');
    case 'objects':
      return items.filter((item) => item.kind === 'object_atlas');
    case 'expressions':
      return items.filter((item) => item.id === 'expressions');
    case 'achievements':
      return items.filter((item) => item.id === 'achievements');
    default:
      return [];
  }
}

function createDecorReviewItem(
  plan: ThemePlan,
  manifest: ThemeManifest,
  creativeDirection: string,
  backgroundMode: BoardBackgroundMode = 'magenta',
): Omit<ThemeImageReviewItem, 'updated_at'> {
  const specs = themeDecorSpecs(manifest, plan.decor_descriptions);
  const rows = createDecorBoardRows(specs);
  return {
    id: 'background_decor',
    filename: 'background_decor.png',
    label: 'Background decor',
    kind: 'background_decor_atlas',
    status: 'pending',
    prompt: buildBackgroundDecorPrompt(
      creativeDirection, plan.display_name, rows, backgroundMode, plan.projectile_description,
    ),
    revision: 0,
    frame_keys: decorBoardFrameKeys(rows),
    decor_rows: rows.flat(),
    projectile_description: (plan.projectile_description ?? '').trim() || undefined,
  };
}

/** Generates one character sprite board (an "agents" board item). */
async function generateAgentAsset(
  globalStorageUri: ThemeStorageRoot,
  reviewDirectoryUri: ThemeStorageRoot,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
): Promise<void> {
  const structuredRequest = structuredRequestForItem(
    item, plan, themePlanCreativeDirection(plan), boardBackgroundModeForProvider(),
  );
  const attempt = await generateBoardImage(plan.theme_id, item, structuredRequest, spriteBoardOptions(options), item.prompt);
  const generated = attempt.image;
  throwIfCancelled(undefined, options?.signal);
  const agentSlotId = agentSlotIdFromFrameKey(item.frame_keys[0] ?? item.id);
  const bodyPlan = agentSlotId !== undefined ? effectiveCharacterBodyPlan(plan, agentSlotId) : (item.body_plan ?? 'biped');
  const { output, spritePackage } = await processCharacterAtlas(generated, manifest, bodyPlan);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(globalStorageUri, plan.theme_id, item.filename, output);
  // Keep the raw pre-slice atlas so this board can be re-sliced later without regenerating.
  await persistRawAtlas(globalStorageUri, plan.theme_id, item.filename, generated);
  throwIfCancelled(undefined, options?.signal);
  const frameKey = item.frame_keys[0] ?? item.id;
  frames[frameKey] = spritePackage.slots.map((slot) => slot.data);
  await markGenerated(globalStorageUri, plan.theme_id, plan.display_name, item, attempt);
  await writeThemeFiles(globalStorageUri, manifest, frames);
}

async function generateEnvironmentAsset(
  globalStorageUri: ThemeStorageRoot,
  reviewDirectoryUri: ThemeStorageRoot,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
): Promise<void> {
  onProgress('Environment (20/25)');
  const structuredRequest = structuredRequestForItem(item, plan, themePlanCreativeDirection(plan), boardBackgroundModeForProvider());
  const attempt = await generateEnvironmentImage(plan.theme_id, item, structuredRequest, options, item.prompt);
  const generated = attempt.image;
  throwIfCancelled(undefined, options?.signal);
  const output = await normalizeEnvironmentImage(generated);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(globalStorageUri, plan.theme_id, item.filename, output);
  // Keep the raw pre-slice image so this board can be re-processed later without regenerating.
  await persistRawAtlas(globalStorageUri, plan.theme_id, item.filename, generated);
  frames.environment_background = [dataUri(output)];
  manifest.viewport.background_asset = 'frames.json#environment_background';
  await markGenerated(globalStorageUri, plan.theme_id, plan.display_name, item, attempt);
  await writeThemeFiles(globalStorageUri, manifest, frames);
}

async function generateDecorAsset(
  globalStorageUri: ThemeStorageRoot,
  reviewDirectoryUri: ThemeStorageRoot,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
): Promise<void> {
  onProgress('Background decor');
  const structuredRequest = structuredRequestForItem(item, plan, themePlanCreativeDirection(plan), boardBackgroundModeForProvider());
  const attempt = await generateBoardImage(plan.theme_id, item, structuredRequest, spriteBoardOptions(options), item.prompt);
  const generated = attempt.image;
  throwIfCancelled(undefined, options?.signal);
  const rows = decorRowsForItem(item, manifest);
  const decorAtlas = await processDecorAtlas(generated, manifest);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(globalStorageUri, plan.theme_id, item.filename, decorAtlas.output);
  // Keep the raw pre-slice atlas so this board can be re-sliced later without regenerating.
  await persistRawAtlas(globalStorageUri, plan.theme_id, item.filename, generated);
  throwIfCancelled(undefined, options?.signal);
  applyDecorBoardFrames(frames, decorAtlas.spritePackage.slots, rows);
  manifest.viewport.projectile_asset = 'frames.json#projectile';
  await markGenerated(globalStorageUri, plan.theme_id, plan.display_name, item, attempt);
  await writeThemeFiles(globalStorageUri, manifest, frames);
}

async function generateRivalAsset(
  globalStorageUri: ThemeStorageRoot,
  reviewDirectoryUri: ThemeStorageRoot,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
): Promise<void> {
  onProgress(item.label);
  const previousFrameKeys = await persistedFrameKeysFor(globalStorageUri, plan.theme_id, item.id);
  const structuredRequest = structuredRequestForItem(item, plan, themePlanCreativeDirection(plan), boardBackgroundModeForProvider(), manifest);
  const attempt = await generateBoardImage(plan.theme_id, item, structuredRequest, spriteBoardOptions(options), item.prompt);
  const generated = attempt.image;
  throwIfCancelled(undefined, options?.signal);
  const rows = rivalRowsForItem(item, manifest, plan);
  const rivalAtlas = await processRivalAtlas(generated, manifest, rows);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(globalStorageUri, plan.theme_id, item.filename, rivalAtlas.output);
  // Keep the raw pre-slice atlas so this board can be re-sliced later without regenerating.
  await persistRawAtlas(globalStorageUri, plan.theme_id, item.filename, generated);
  throwIfCancelled(undefined, options?.signal);
  const newFrameKeys = applyRivalBoardFrames(frames, rivalAtlas.spritePackage.slots, rows);
  removeStaleBoardFrameKeys(frames, previousFrameKeys, newFrameKeys);
  await markGenerated(globalStorageUri, plan.theme_id, plan.display_name, item, attempt);
  await writeThemeFiles(globalStorageUri, manifest, frames);
}

/**
 * Rival rows for a rival-board item. Reconstructs them from the CURRENT manifest
 * roster by the board's index (parsed from `rivals_NN`) as the primary source, so
 * a roster that grew (e.g. 3->4 rivals) regenerates the correct count instead of
 * reusing a stale saved `rival_rows` — which would slice the board at the wrong
 * row count and drop the new rival's frames (placeholder + mis-sliced neighbors).
 * Falls back to the item's stored `rival_rows` only if reconstruction fails/empty.
 */
function rivalRowsForItem(
  item: Pick<ThemeImageReviewItem, 'id' | 'rival_rows'>,
  manifest: ThemeManifest,
  plan?: Pick<ThemePlan, 'enemy_descriptions' | 'enemy_body_plans'>,
): ThemeRivalBoardRow[] {
  let boards: ThemeRivalBoardRow[][];
  try {
    boards = createRivalBoardRows(themeRivalSpecs(manifest, plan?.enemy_descriptions, plan?.enemy_body_plans));
  } catch (err) {
    console.warn('TycoonAgents: unable to reconstruct rival board rows:', err);
    return item.rival_rows?.length ? item.rival_rows : [];
  }
  const boardIndex = Math.max(0, (Number(/rivals_(\d+)/.exec(item.id || '')?.[1] ?? '1') || 1) - 1);
  let rows = boards[boardIndex] ?? boards[0] ?? [];
  if (!plan && item.rival_rows?.length) {
    // Slicing/re-slice paths have no plan in hand: carry each row's persisted
    // body plan over so the slicer applies the same per-row size budget the
    // board was generated under.
    const saved = new Map(item.rival_rows.map((row) => [row.rival_id, row]));
    rows = rows.map((row) => {
      const prior = saved.get(row.rival_id);
      if (!prior?.body_plan) return row;
      return {
        ...row,
        body_plan: prior.body_plan,
        ...(prior.explicit_body_plan ? { explicit_body_plan: prior.explicit_body_plan } : {}),
      };
    });
  }
  return rows.length ? rows : (item.rival_rows?.length ? item.rival_rows : []);
}

/**
 * Object rows for an object-atlas item. Mirrors rivalRowsForItem, but the v3
 * object pipeline always has exactly TWO fixed-shape boards (unlike rivals,
 * whose board count scales with roster size): `objects_01` is
 * createObjectBoard1Rows(the first OBJECT_BOARD1_STATIC_COUNT specs) and
 * `objects_02` is createObjectBoard2Rows(the next OBJECT_ANIMATED_COUNT
 * specs, the last OBJECT_BOARD2_STATIC_COUNT specs).
 *
 * When a `plan` is supplied, its object roster (`plan.objects` /
 * `plan.object_motion_hints`, via themeObjectSpecsFromPlan) is tried FIRST —
 * mirroring buildReplacementPrompt's existing preference for
 * plan.expressions/plan.achievements over saved item names. normalizeThemePlan
 * always pads/trims `plan.objects` to THEME_OBJECT_COUNT (21) on load, so this
 * lets a LEGACY manifest still stuck at a pre-v3 buildable_objects count (which
 * makes the manifest-based reconstruction below throw, since
 * createObjectBoard1Rows/2Rows require an exact 16/(2+3) split) still resolve to
 * the CURRENT 2-board contract instead of falling through to a stale board.
 * Reconstructing from the CURRENT manifest is the next fallback (so a roster
 * rename/reorder regenerates the correct board content even with no plan).
 * Falls back to the item's stored `object_rows`, then to a lenient legacy
 * reconstruction, only if both the plan-based and manifest-based
 * reconstructions are empty, throw, or (for plan) unavailable. Exported for
 * unit testing.
 */
export function objectRowsForItem(
  item: Pick<ThemeImageReviewItem, 'object_specs' | 'object_rows'> & Partial<Pick<ThemeImageReviewItem, 'id'>>,
  manifest: ThemeManifest,
  plan?: Pick<ThemePlan, 'objects' | 'object_motion_hints' | 'object_descriptions' | 'crate_description' | 'poof_description'>,
  // Independent of `plan`/preferPlanObjects above: descriptions are PROMPT-ONLY
  // text, not row geometry, so they can safely be merged onto the manifest-driven
  // rows below even when the caller intentionally keeps row RECONSTRUCTION
  // manifest-based (to stay consistent with manifest-based slicing). Callers that
  // have a plan available on the real (non-display) retry path should still pass
  // its object_descriptions here even when they pass `undefined` for `plan` itself.
  descriptions?: string[],
  // Same independence as `descriptions` above, but for the single crate/poof
  // appearance specs (plan.poof_description / plan.crate_description). Used
  // only for board 2 (createObjectBoard2Rows ignores extra args for board 1).
  poofDescription?: string,
  crateDescription?: string,
): ThemeObjectBoardRow[] {
  const boardNumber = Number(/objects_(\d+)/.exec(item.id ?? '')?.[1] ?? '1') || 1;
  if (plan?.objects?.length) {
    try {
      const planSpecs = themeObjectSpecsFromPlan(plan);
      const rows = boardNumber >= 2
        ? createObjectBoard2Rows(
          planSpecs.slice(OBJECT_STATIC_COUNT, OBJECT_STATIC_COUNT + OBJECT_ANIMATED_COUNT),
          planSpecs.slice(OBJECT_BOARD1_STATIC_COUNT, OBJECT_STATIC_COUNT),
          plan.poof_description,
          plan.crate_description,
        )
        : createObjectBoard1Rows(planSpecs.slice(0, OBJECT_BOARD1_STATIC_COUNT));
      if (rows.length) return rows;
    } catch (err) {
      console.warn('TycoonAgents: unable to reconstruct object board rows from plan:', err);
    }
  }
  try {
    const objectSpecs = themeObjectSpecs(manifest, undefined, descriptions);
    const rows = boardNumber >= 2
      ? createObjectBoard2Rows(
        objectSpecs.slice(OBJECT_STATIC_COUNT, OBJECT_STATIC_COUNT + OBJECT_ANIMATED_COUNT),
        objectSpecs.slice(OBJECT_BOARD1_STATIC_COUNT, OBJECT_STATIC_COUNT),
        poofDescription,
        crateDescription,
      )
      : createObjectBoard1Rows(objectSpecs.slice(0, OBJECT_BOARD1_STATIC_COUNT));
    if (rows.length) return rows;
  } catch (err) {
    console.warn('TycoonAgents: unable to reconstruct object board rows:', err);
  }
  if (item.object_rows?.length) return item.object_rows;
  try {
    const legacyRows = reconstructObjectRows(item, manifest);
    if (legacyRows.length) return legacyRows;
  } catch (err) {
    console.warn('TycoonAgents: unable to reconstruct legacy object board rows:', err);
  }
  return item.object_rows?.length ? item.object_rows : [];
}

/**
 * Flattened decor rows for a background-decor-atlas item. Reconstructs from the
 * CURRENT manifest's decor roster (via createDecorBoardRows) as the primary
 * source, so a decor roster change regenerates the correct board instead of
 * reusing stale saved `decor_rows`. Falls back to the item's stored `decor_rows`
 * only if reconstruction is empty or throws (e.g. the manifest doesn't have
 * exactly 9 decor entries). Exported for unit testing.
 */
export function decorRowsForItem(
  item: Pick<ThemeImageReviewItem, 'decor_rows'>,
  manifest: ThemeManifest,
  descriptions?: string[],
): ThemeDecorBoardRow[] {
  try {
    const rows = createDecorBoardRows(themeDecorSpecs(manifest, descriptions)).flat();
    return rows.length ? rows : (item.decor_rows?.length ? item.decor_rows : []);
  } catch (err) {
    console.warn('TycoonAgents: unable to reconstruct decor board rows:', err);
    return item.decor_rows?.length ? item.decor_rows : [];
  }
}

/**
 * Merge a resumed generation's freshly computed review items (`expected`, rebuilt
 * from the CURRENT plan/manifest) with whatever review document was saved before
 * the run was interrupted (`savedItems`). Preserves REVIEW PROGRESS from the saved
 * item — status/revision/updated_at/generation_error — but never lets a saved
 * item's board-row/prompt/frame-key metadata override the freshly computed
 * `expected` values. `expected` is rebuilt from the current plan/manifest every
 * resume, so if the object/rival/decor roster changed shape between the
 * interrupted run and this resume (e.g. the buildable-object count grew and
 * pushed poof/crate onto a later board), a naive `{ ...expected, ...saved }`
 * spread would silently let the OLD saved object_rows and prompt win — the next
 * `generateOrResumeThemeItem` call would then generate a board image using an
 * outdated roster shape, baking the wrong content (e.g. a real object rendered
 * where poof/crate belong) straight into the art itself, no slicing bug
 * required. This mirrors the manifest-wins policy already enforced by
 * objectRowsForItem/rivalRowsForItem for the re-slice path — this resume path
 * must enforce it too, since it runs BEFORE generation. Exported for unit testing.
 */
export function mergeResumedReviewItems(
  expectedItems: Array<Omit<ThemeImageReviewItem, 'updated_at'>>,
  savedItems: ReadonlyArray<ThemeImageReviewItem>,
): Array<Omit<ThemeImageReviewItem, 'updated_at'> & { updated_at?: string }> {
  return expectedItems.map((expected) => {
    const saved = savedItems.find((item) => item.id === expected.id);
    if (!saved) return expected;
    return {
      ...expected,
      status: saved.status,
      revision: saved.revision,
      updated_at: saved.updated_at,
      generation_error: saved.generation_error,
    };
  });
}

/**
 * Pure core of the rename-driven prompt resync (the "Names" editor's batched
 * Apply, applyThemeItemNameChanges/renameThemeItemsBatch). Renaming only ever
 * touched the manifest. Every regenerate mode — including 'retry'/'augment'
 * since retryThemeImage's freshBasePrompt rebuild — now reconstructs board
 * rows/prompt from the CURRENT manifest at generation time (see
 * selectThemeImageRetryPrompt in themeImageRetry.ts), so a rename is always
 * picked up on the next retry regardless of mode. This resync exists so the
 * saved on-disk prompt/rows reflect the rename immediately, without waiting
 * for the next generation.
 *
 * Given the review document as it stood before the rename, the manifest AFTER
 * applyThemeItemNameChanges wrote the new names into it, the theme's plan, and
 * the batch of applied changes, returns the review items whose board needs a
 * freshly-rebuilt prompt/rows so 'retry' and 'augment' inherit the new names
 * automatically from here on.
 *
 * Scoped to only the object/decor/rival boards that actually CONTAIN a renamed
 * row — every other board, including character/agent boards (the existing
 * single-character rename flow, RENAME_THEME_CHARACTER, already owns that
 * fuller plan/prompt-text sync), is left byte-for-byte as saved. Reuses
 * createReviewItems — the single source of truth for board prompts/rows — plus
 * mergeResumedReviewItems' merge semantics, so status/revision/updated_at/
 * generation_error survive the resync untouched: a rename must never bounce an
 * accepted board back to pending. Exported for unit testing.
 */
export function resyncRenamedReviewItems(
  document: Pick<ThemeImageReviewDocument, 'items'>,
  manifest: ThemeManifest,
  plan: ThemePlan,
  applied: ThemeItemNameChange[],
): ThemeImageReviewItem[] {
  // Character renames already have their own fuller sync path; nothing else
  // to resync if only character rows changed.
  const affectedIds = new Set(
    applied.filter((change) => change.item_kind !== 'character').map((change) => change.id),
  );
  if (!affectedIds.size) return [];

  const affectedBoardIds = new Set<string>();
  for (const item of document.items) {
    if (item.kind === 'object_atlas' && item.object_rows?.some(
      (row) => (row.kind === 'object_static' || row.kind === 'object_anim') && affectedIds.has(row.object_id),
    )) {
      affectedBoardIds.add(item.id);
    } else if (item.kind === 'background_decor_atlas' && item.decor_rows?.some(
      (row) => row.kind !== 'projectile' && affectedIds.has(row.decor_id),
    )) {
      affectedBoardIds.add(item.id);
    } else if (item.kind === 'rival_atlas' && item.rival_rows?.some(
      // rival_rows carry the STRIPPED rival_id (see themeRivalSpecs); match either
      // form since applyThemeItemNameChanges accepts both (see its rival branch).
      (row) => affectedIds.has(row.rival_id) || affectedIds.has(`rival_${row.rival_id}`),
    )) {
      affectedBoardIds.add(item.id);
    } else if (item.kind === 'achievement_atlas' && applied.some((change) => change.item_kind === 'badge')) {
      affectedBoardIds.add(item.id);
    }
  }
  if (!affectedBoardIds.size) return [];

  const expectedItems = createReviewItems(
    plan,
    manifest,
    themePlanCreativeDirection(plan),
    boardBackgroundModeForProvider(),
  ).filter((item) => affectedBoardIds.has(item.id));
  const savedItems = document.items.filter((item) => affectedBoardIds.has(item.id));

  // Every expected item here has a saved counterpart by construction
  // (affectedBoardIds was derived from document.items), so the merge always
  // carries a real updated_at through.
  return mergeResumedReviewItems(expectedItems, savedItems) as ThemeImageReviewItem[];
}

/**
 * IO wrapper around resyncRenamedReviewItems: loads the saved review document
 * and plan, computes the refreshed items, and persists each one. Silently
 * no-ops (logs a warning) if the review document or plan can't be loaded —
 * the manifest rename itself already succeeded and must not be rolled back
 * just because the resync convenience couldn't run; the next full
 * regenerate/resume still self-heals via mergeResumedReviewItems.
 */
async function resyncRenamedBoardPrompts(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  manifest: ThemeManifest,
  applied: ThemeItemNameChange[],
): Promise<void> {
  if (!applied.some((change) => change.item_kind !== 'character')) return;
  try {
    const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
    if (!document) return;
    const resyncStore = resolveThemeFileStore(globalStorageUri);
    const savedPlan = (await readJson<ThemePlan>(resyncStore, themePlanPath(themeId)))
      ?? (await readJson<ThemePlan>(resyncStore, legacyPlanPath(themeId)));
    if (!savedPlan) return;
    const plan = normalizeThemePlan(savedPlan, manifest.display_name);
    if (plan.theme_id !== themeId) return;

    // Badge (achievement) names are themed and live in plan.achievements — mirror the applied
    // badge renames into the plan and persist it so the achievement board rebuilds with the new
    // names (createReviewItems reads plan.achievements) and they survive theme reopen.
    const badgeChanges = applied.filter((change) => change.item_kind === 'badge');
    if (badgeChanges.length) {
      let planChanged = false;
      for (const change of badgeChanges) {
        const m = /^achievement_(\d+)$/.exec(change.id);
        const idx = m ? Number(m[1]) : -1;
        if (idx >= 0 && idx < plan.achievements.length) {
          plan.achievements[idx] = change.name;
          planChanged = true;
        }
      }
      if (planChanged) {
        await resyncStore.writeFile(themePlanPath(themeId), jsonBuffer(plan));
      }
    }

    const refreshed = resyncRenamedReviewItems(document, manifest, plan, applied);
    for (const item of refreshed) {
      await upsertThemeImageReviewItem(globalStorageUri, themeId, document.display_name, item);
    }
  } catch (err) {
    console.warn('TycoonAgents: unable to resync review-board prompts after rename:', err);
  }
}

/**
 * Look up the frame_keys this item owned in the LAST PERSISTED review document
 * (on disk), as opposed to the freshly-built `item` passed to a generate*Asset
 * function — which, when built via buildBoardItems/createReviewItems, already
 * targets the NEW correct key set and so is useless as a "previous ownership"
 * baseline. Without reading the persisted keys, a plain regenerate (not just a
 * re-slice) of a board whose row shape shrank (e.g. it no longer carries
 * poof/crate) would never purge the stale keys it wrote under its old shape —
 * only a re-slice (which starts from the on-disk item) would. Returns undefined
 * if the item has no prior persisted record (first-ever generation).
 */
async function persistedFrameKeysFor(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  itemId: string,
): Promise<string[] | undefined> {
  const document = await loadThemeImageReviewDocument(globalStorageUri, themeId);
  return document?.items.find((candidate) => candidate.id === itemId)?.frame_keys;
}

async function generateObjectAsset(
  globalStorageUri: ThemeStorageRoot,
  reviewDirectoryUri: ThemeStorageRoot,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
  progressIndex: number,
): Promise<void> {
  onProgress(`${item.label} (${progressIndex}/25)`);
  const previousFrameKeys = await persistedFrameKeysFor(globalStorageUri, plan.theme_id, item.id);
  const structuredRequest = structuredRequestForItem(item, plan, themePlanCreativeDirection(plan), boardBackgroundModeForProvider());
  const attempt = await generateBoardImage(plan.theme_id, item, structuredRequest, spriteBoardOptions(options), item.prompt);
  const generated = attempt.image;
  throwIfCancelled(undefined, options?.signal);
  if (!item.object_rows?.length) throw new Error(`${item.label} is missing object-board row metadata.`);
  const objectAtlas = await processObjectAtlas(generated, manifest, item.object_rows);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(globalStorageUri, plan.theme_id, item.filename, objectAtlas.output);
  // Keep the raw pre-slice atlas so this board can be re-sliced later without regenerating.
  await persistRawAtlas(globalStorageUri, plan.theme_id, item.filename, generated);
  throwIfCancelled(undefined, options?.signal);
  const newFrameKeys = applyObjectBoardFrames(frames, objectAtlas.spritePackage.slots, item.object_rows);
  // Self-healing regenerate: if this board's row shape shrank since it was last
  // PERSISTED (e.g. it no longer carries poof/crate because the roster grew and
  // pushed them onto a later board), drop the stale keys it used to own so they
  // can't keep clobbering the board that owns them now.
  removeStaleBoardFrameKeys(frames, previousFrameKeys, newFrameKeys);
  await markGenerated(globalStorageUri, plan.theme_id, plan.display_name, item, attempt);
  await writeThemeFiles(globalStorageUri, manifest, frames);
}

async function generateExpressionAsset(
  globalStorageUri: ThemeStorageRoot,
  reviewDirectoryUri: ThemeStorageRoot,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
): Promise<void> {
  onProgress('8-expression sprite sheet (24/25)');
  const structuredRequest = structuredRequestForItem(item, plan, themePlanCreativeDirection(plan), boardBackgroundModeForProvider());
  const attempt = await generateBoardImage(plan.theme_id, item, structuredRequest, spriteBoardOptions(options), item.prompt);
  const generated = attempt.image;
  throwIfCancelled(undefined, options?.signal);
  const output = await optimizeSpriteBoardCanvas(generated, 4, 2);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(globalStorageUri, plan.theme_id, item.filename, output);
  // Keep the raw pre-slice atlas so this board can be re-sliced later without regenerating.
  await persistRawAtlas(globalStorageUri, plan.theme_id, item.filename, generated);
  const spritePackage = await sliceAndNormalizeAtlas(output, manifest, { columns: 4, rows: 2 });
  throwIfCancelled(undefined, options?.signal);
  applyExpressionFrames(frames, spritePackage.slots);
  await markGenerated(globalStorageUri, plan.theme_id, plan.display_name, item, attempt);
  await writeThemeFiles(globalStorageUri, manifest, frames);
}

async function generateAchievementAsset(
  globalStorageUri: ThemeStorageRoot,
  reviewDirectoryUri: ThemeStorageRoot,
  plan: ThemePlan,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  options: ThemeImageGenerationOptions | undefined,
  onProgress: (message: string) => void,
): Promise<void> {
  onProgress('25 achievement badges (25/25)');
  const structuredRequest = structuredRequestForItem(item, plan, themePlanCreativeDirection(plan), boardBackgroundModeForProvider());
  const attempt = await generateBoardImage(plan.theme_id, item, structuredRequest, spriteBoardOptions(options), item.prompt);
  const generated = attempt.image;
  throwIfCancelled(undefined, options?.signal);
  const output = await optimizeSpriteBoardCanvas(generated, 5, 5);
  throwIfCancelled(undefined, options?.signal);
  await saveReviewImage(globalStorageUri, plan.theme_id, item.filename, output);
  // Keep the raw pre-slice atlas so this board can be re-sliced later without regenerating.
  await persistRawAtlas(globalStorageUri, plan.theme_id, item.filename, generated);
  const spritePackage = await sliceAndNormalizeAtlas(output, manifest, { columns: 5, rows: 5 });
  throwIfCancelled(undefined, options?.signal);
  applyAchievementFrames(frames, spritePackage.slots);
  await markGenerated(globalStorageUri, plan.theme_id, plan.display_name, item, attempt);
  await writeThemeFiles(globalStorageUri, manifest, frames);
}

async function generateEnvironmentImage(
  themeId: string,
  item: { id: string; kind: ThemeImageKind; revision: number },
  structuredRequest: StructuredGenerateRequest,
  options?: ThemeImageGenerationOptions,
  localPreviewPrompt?: string,
): Promise<ThemeImageGenerateValue> {
  const shapeGuide = await createEnvironmentShapeGuide();
  return generateBoardImage(themeId, item, structuredRequest, {
    ...options,
    aspectRatio: '3:4',
    referenceImages: [{
      data: shapeGuide,
      mimeType: 'image/png',
      filename: 'environment_shape_guide.png',
    }],
  }, localPreviewPrompt);
}

export function buildReplacementPrompt(
  item: ThemeImageReviewItem,
  creativeDirection: string,
  manifest: ThemeManifest,
  plan?: Pick<ThemePlan,
    | 'expressions' | 'achievements' | 'objects' | 'object_motion_hints'
    | 'character_descriptions' | 'character_body_plans' | 'object_descriptions' | 'decor_descriptions' | 'enemy_descriptions'
    | 'crate_description' | 'poof_description' | 'projectile_description'
  >,
  backgroundMode: BoardBackgroundMode = 'magenta',
  // DISPLAY-ONLY opt-in. When true, the object board rebuilds its rows from the
  // CURRENT plan's 21-object roster (via objectRowsForItem's plan path) so the
  // "Copy/View prompt" surface always reflects the latest 2-board contract even
  // for a legacy off-count manifest. It MUST stay false for any caller whose
  // prompt actually feeds image GENERATION: object slicing
  // (applySlicedAtlasFromBuffer) is still manifest-based, so a plan-derived
  // prompt paired with manifest-based slicing would produce a mismatched retry
  // for a legacy object board. Only the panel's _postThemeImageReview display
  // loop sets this true.
  preferPlanObjects = false,
): string {
  if (item.kind === 'environment') return buildEnvironmentPrompt(creativeDirection, manifest.display_name);
  if (item.kind === 'object_atlas') {
    // Reconstruct from the CURRENT manifest (see objectRowsForItem), falling
    // back to the item's stale saved object_rows / legacy reconstruction — this
    // matches applySlicedAtlasFromBuffer's manifest-based slicing so a real
    // Retry stays consistent. Only the DISPLAY path (preferPlanObjects) also
    // tries the current plan's 21-object roster first, so "Copy/View prompt"
    // reflects the v3 contract even for a legacy off-count manifest.
    // `plan?.object_descriptions` (and the crate/poof descriptions below) are
    // passed unconditionally (independent of preferPlanObjects): descriptions
    // are prompt-only text, not row geometry, so a REAL retry can safely pick
    // up plan-authored appearance guidance on the manifest-driven rows
    // without disturbing manifest-based slicing consistency.
    const rows = objectRowsForItem(
      item,
      manifest,
      preferPlanObjects ? plan : undefined,
      plan?.object_descriptions,
      plan?.poof_description,
      plan?.crate_description,
    );
    return buildObjectAtlasPrompt(creativeDirection, manifest.display_name, rows, backgroundMode);
  }
  if (item.kind === 'background_decor_atlas') {
    // Reconstruct from the CURRENT manifest as the primary source (see
    // decorRowsForItem) so a decor roster change regenerates the correct board
    // instead of reusing stale saved decor_rows.
    const rows = decorRowsToBoard(decorRowsForItem(item, manifest, plan?.decor_descriptions));
    return buildBackgroundDecorPrompt(
      creativeDirection, manifest.display_name, rows, backgroundMode, plan?.projectile_description,
    );
  }
  if (item.kind === 'expression_atlas') {
    // Prefer the CURRENT plan's expression names over the item's saved names,
    // falling back to the saved names, then generic defaults.
    const names = plan?.expressions?.length
      ? plan.expressions
      : (item.expression_names?.length ? item.expression_names : defaultNames('Expression', 8));
    return buildExpressionAtlasPrompt(creativeDirection, manifest.display_name, names, backgroundMode);
  }
  if (item.kind === 'achievement_atlas') {
    // Prefer the CURRENT plan's achievement names over the item's saved names,
    // falling back to the saved names, then generic defaults.
    const names = plan?.achievements?.length
      ? plan.achievements
      : (item.achievement_names?.length ? item.achievement_names : defaultNames('Achievement Badge', 25));
    return buildAchievementAtlasPrompt(creativeDirection, manifest.display_name, names, backgroundMode);
  }
  if (item.kind === 'emote_atlas') return buildEmoteAtlasPrompt(creativeDirection, manifest.display_name, backgroundMode);
  if (item.kind === 'rival_atlas') {
    const rows = rivalRowsForItem(item, manifest, plan);
    return buildRivalAtlasPrompt(creativeDirection, manifest.display_name, rows, backgroundMode);
  }
  const agentSlotId = agentSlotIdFromFrameKey(item.frame_keys[0] || item.id);
  const characterDescription = agentSlotId !== undefined
    ? (plan?.character_descriptions?.[agentSlotId] ?? '').trim() || undefined
    : undefined;
  // p59-t3: the service always attaches its own pose-guide reference image
  // for roster_agent attempts now, so the preview always includes the guide
  // paragraph too.
  const walkPoseGuide = agentSlotId !== undefined && plan ? effectiveCharacterBodyPlan(plan, agentSlotId) : undefined;
  return buildCharacterAtlasPrompt(
    creativeDirection,
    item.subject ?? item.label,
    manifest.display_name,
    backgroundMode,
    characterDescription,
    walkPoseGuide ? { walkPoseGuide } : undefined,
  );
}

/**
 * p59-t3: StructuredGenerateRequest counterpart of {@link buildReplacementPrompt},
 * same reconstruction logic and parameters, used by retryThemeImage to send
 * the v3.4 structured request. The pose-guide paragraph is always requested
 * for character boards (`{ walkPoseGuide: bodyPlan }`) — the service now
 * always attaches its own guide image server-side (see docs/theme-service-api.md
 * Migration), so the local preview assumes attachment too; any resulting
 * template drift is caught by generateBoardImage's sha256 mismatch check.
 */
export function buildReplacementRequest(
  item: ThemeImageReviewItem,
  creativeDirection: string,
  manifest: ThemeManifest,
  plan?: Pick<ThemePlan,
    | 'expressions' | 'achievements' | 'objects' | 'object_motion_hints'
    | 'character_descriptions' | 'character_body_plans' | 'object_descriptions' | 'decor_descriptions' | 'enemy_descriptions'
    | 'crate_description' | 'poof_description' | 'projectile_description'
  >,
  backgroundMode: BoardBackgroundMode = 'magenta',
  preferPlanObjects = false,
): StructuredGenerateRequest {
  if (item.kind === 'environment') return buildEnvironmentRequest(creativeDirection, manifest.display_name);
  if (item.kind === 'object_atlas') {
    const rows = objectRowsForItem(
      item, manifest, preferPlanObjects ? plan : undefined,
      plan?.object_descriptions, plan?.poof_description, plan?.crate_description,
    );
    return buildObjectAtlasRequest(creativeDirection, manifest.display_name, rows, backgroundMode);
  }
  if (item.kind === 'background_decor_atlas') {
    const rows = decorRowsToBoard(decorRowsForItem(item, manifest, plan?.decor_descriptions));
    return buildBackgroundDecorRequest(creativeDirection, manifest.display_name, rows, backgroundMode, plan?.projectile_description);
  }
  if (item.kind === 'expression_atlas') {
    const names = plan?.expressions?.length ? plan.expressions : (item.expression_names?.length ? item.expression_names : defaultNames('Expression', 8));
    return buildExpressionAtlasRequest(creativeDirection, manifest.display_name, names, backgroundMode);
  }
  if (item.kind === 'achievement_atlas') {
    const names = plan?.achievements?.length ? plan.achievements : (item.achievement_names?.length ? item.achievement_names : defaultNames('Achievement Badge', 25));
    return buildAchievementAtlasRequest(creativeDirection, manifest.display_name, names, backgroundMode);
  }
  if (item.kind === 'emote_atlas') return buildEmoteAtlasRequest(creativeDirection, manifest.display_name, backgroundMode);
  if (item.kind === 'rival_atlas') {
    const rows = rivalRowsForItem(item, manifest, plan);
    return buildRivalAtlasRequest(creativeDirection, manifest.display_name, rows, backgroundMode);
  }
  const agentSlotId = agentSlotIdFromFrameKey(item.frame_keys[0] || item.id);
  const characterName = item.subject ?? item.label;
  const rawDescription = agentSlotId !== undefined ? plan?.character_descriptions?.[agentSlotId] : undefined;
  const fallbackDescription = resolveCharacterDescription(rawDescription, characterName);
  const bodyPlan = agentSlotId !== undefined && plan ? effectiveCharacterBodyPlan(plan, agentSlotId) : 'biped';
  return buildCharacterAtlasRequest(
    creativeDirection, characterName, manifest.display_name, backgroundMode, fallbackDescription, { walkPoseGuide: bodyPlan },
  );
}

/** Extract the roster_agents slot_id from a character frame key like `agent_3`, or undefined if it doesn't match. */
function agentSlotIdFromFrameKey(frameKey: string): number | undefined {
  const match = /^agent_(\d+)$/.exec(frameKey);
  return match ? Number(match[1]) : undefined;
}

// Mirrors corsair-theme-service src/validate.mjs's roster_agent slot.description
// checkString({ maxLen: 600 }) limit exactly — see resolveCharacterDescription.
const ROSTER_AGENT_DESCRIPTION_MAX_LEN = 600;

/**
 * Every roster_agent StructuredGenerateRequest builder (buildReplacementRequest,
 * createReviewItems, structuredRequestForItem) MUST send a non-empty
 * slot.description: the backend's validateSlot('roster_agent') requires the
 * field (validate.mjs), but the character card's own hint tells the user a
 * blank description is fine locally, so a legacy theme (no plan.json) or a
 * plan with a blank character_descriptions entry must never omit the key.
 * Prefers the plan's own description; falls back to the character's display
 * name (always non-empty). Trimmed and truncated to the backend's exact
 * 600-char limit either way, so the fallback can never itself trip
 * slot.description:max_len. Single shared helper so the three call sites
 * can't drift apart.
 */
function resolveCharacterDescription(description: string | undefined, characterName: string): string {
  const trimmedDescription = (description ?? '').trim();
  const fallback = trimmedDescription || characterName.trim() || 'Character';
  return fallback.slice(0, ROSTER_AGENT_DESCRIPTION_MAX_LEN);
}

function renameCharacterInPrompt(prompt: string, previousName: string, characterName: string): string {
  if (!prompt || !previousName || previousName === characterName) return prompt;
  const quotedName = `"${previousName}"`;
  const index = prompt.indexOf(quotedName);
  if (index < 0) return '';
  return `${prompt.slice(0, index)}"${characterName}"${prompt.slice(index + quotedName.length)}`;
}

/**
 * Lenient legacy fallback for an object-atlas review item whose board can't be
 * reconstructed from the current manifest via createObjectBoard1Rows /
 * createObjectBoard2Rows (e.g. a manifest whose buildable_objects count
 * doesn't match the current 21-object / 16-static-plus-2-animated-plus-3-static
 * contract). Uses the item's stored object specs (falling back to the
 * manifest), padding with synthetic placeholders rather than throwing, so a
 * retry never crashes even against a malformed/legacy roster. `objects_02`
 * (or any board number >= 2) reconstructs board 2's [animA, animB, poof,
 * staticA, staticB, staticC, crate] shape from the LAST OBJECT_ANIMATED_COUNT
 * + OBJECT_BOARD2_STATIC_COUNT specs (animated pair first, in row order);
 * every other id reconstructs board 1's OBJECT_BOARD1_STATIC_COUNT static
 * cells from the first OBJECT_BOARD1_STATIC_COUNT specs.
 */
function reconstructObjectRows(
  item: Pick<ThemeImageReviewItem, 'object_specs'> & Partial<Pick<ThemeImageReviewItem, 'id'>>,
  manifest: ThemeManifest,
): ThemeObjectBoardRow[] {
  const boardNumber = Number(/objects_(\d+)/.exec(item.id ?? '')?.[1] ?? '1') || 1;
  const specs = (item.object_specs?.length ? item.object_specs : themeObjectSpecs(manifest))
    .map((spec) => ({ object_id: spec.object_id, display_name: spec.display_name }));
  if (boardNumber >= 2) {
    const animated = specs.slice(Math.max(0, specs.length - OBJECT_ANIMATED_COUNT));
    const animRows: ThemeObjectBoardRow[] = animated.map((spec) => ({ kind: 'object_anim' as const, ...spec }));
    while (animRows.length < OBJECT_ANIMATED_COUNT) {
      animRows.push({
        kind: 'object_anim' as const,
        object_id: `object_${animRows.length + 1}`,
        display_name: `Object ${animRows.length + 1}`,
      });
    }
    const boardTwoStatics = specs.slice(
      Math.max(0, specs.length - OBJECT_ANIMATED_COUNT - OBJECT_BOARD2_STATIC_COUNT),
      Math.max(0, specs.length - OBJECT_ANIMATED_COUNT),
    );
    const staticRows: ThemeObjectBoardRow[] = boardTwoStatics.map((spec) => ({ kind: 'object_static' as const, ...spec }));
    while (staticRows.length < OBJECT_BOARD2_STATIC_COUNT) {
      const n = OBJECT_BOARD1_STATIC_COUNT + staticRows.length + 1;
      staticRows.push({
        kind: 'object_static' as const,
        object_id: `object_${n}`,
        display_name: `Object ${n}`,
      });
    }
    return [
      ...animRows.slice(0, OBJECT_ANIMATED_COUNT),
      { kind: 'poof' },
      ...staticRows.slice(0, OBJECT_BOARD2_STATIC_COUNT),
      { kind: 'crate' },
    ];
  }
  const staticRows: ThemeObjectBoardRow[] = specs.slice(0, OBJECT_BOARD1_STATIC_COUNT).map((spec) => ({
    kind: 'object_static' as const,
    ...spec,
  }));
  while (staticRows.length < OBJECT_BOARD1_STATIC_COUNT) {
    staticRows.push({
      kind: 'object_static' as const,
      object_id: `object_${staticRows.length + 1}`,
      display_name: `Object ${staticRows.length + 1}`,
    });
  }
  return staticRows;
}

function themeObjectSpecs(
  manifest: ThemeManifest,
  motionHints?: string[],
  descriptions?: string[],
): ThemeObjectPromptSpec[] {
  const specs: ThemeObjectPromptSpec[] = manifest.buildable_objects
    .slice(0, THEME_OBJECT_COUNT)
    .map((object, index) => {
      // build_order 0 is the themed ranged-weapon rack (see themePlan.ts); it gets
      // dedicated rack visual guidance and ignores any planner motion hint.
      const isRangedRack = index === 0;
      const hint = !isRangedRack ? (motionHints?.[index] ?? '').trim() : '';
      const description = (descriptions?.[index] ?? '').trim();
      return {
        object_id: object.object_id,
        display_name: object.display_name,
        ...(isRangedRack ? { is_ranged_rack: true } : {}),
        ...(hint ? { motion_hint: hint } : {}),
        ...(description ? { visual_description: description } : {}),
      };
    });
  // Pad legacy / pre-v3 manifests (fewer than THEME_OBJECT_COUNT buildable_objects)
  // up to the fixed 21-slot v3 contract so board 1 always resolves its 16 static
  // cells and board 2 its 2 animated + 3 static cells. Without this, an existing
  // theme whose manifest still carries a pre-v3 object count makes
  // createObjectBoard1Rows/createObjectBoard2Rows and processObjectAtlas throw
  // "requires exactly 16 static-object cells" during review-item re-synthesis and
  // on Re-slice, blocking object replacement on existing themes. Placeholders
  // mirror reconstructObjectRows.
  while (specs.length < THEME_OBJECT_COUNT) {
    const n = specs.length + 1;
    specs.push({ object_id: `object_${n}`, display_name: `Object ${n}` });
  }
  return specs;
}

/**
 * Same shape as themeObjectSpecs, but sourced from a ThemePlan's `objects` /
 * `object_motion_hints` (rather than a ThemeManifest's `buildable_objects`).
 * Used by objectRowsForItem to prefer the CURRENT plan's roster over a
 * possibly-stale/off-count manifest. object_ids are derived with the same
 * uniqueIds(names, 'object') scheme themePlanToManifest uses when it actually
 * bakes a plan into a manifest, so ids here match what generation would
 * eventually assign. Index 0 is always the reserved ranged-weapon rack slot
 * (see reserveRangedWeaponRackSlot in themePlan.ts's normalizeThemePlan).
 */
function themeObjectSpecsFromPlan(
  plan: Pick<ThemePlan, 'objects' | 'object_motion_hints' | 'object_descriptions'>,
): ThemeObjectPromptSpec[] {
  const objects = plan.objects.slice(0, THEME_OBJECT_COUNT);
  const ids = uniqueIds(objects, 'object');
  return objects.map((displayName, index) => {
    const isRangedRack = index === 0;
    const hint = !isRangedRack ? (plan.object_motion_hints?.[index] ?? '').trim() : '';
    const description = (plan.object_descriptions?.[index] ?? '').trim();
    return {
      object_id: ids[index],
      display_name: displayName,
      ...(isRangedRack ? { is_ranged_rack: true } : {}),
      ...(hint ? { motion_hint: hint } : {}),
      ...(description ? { visual_description: description } : {}),
    };
  });
}

function themeRivalSpecs(
  manifest: ThemeManifest,
  descriptions?: string[],
  bodyPlans?: Array<BodyPlan | undefined>,
): ThemeRivalPromptSpec[] {
  return manifest.roster_rivals.map((rival, index) => {
    const description = (descriptions?.[index] ?? '').trim();
    const explicit = bodyPlans?.[index];
    return {
      body_plan: effectiveRivalBodyPlan(explicit, rival.name, description),
      ...(explicit ? { explicit_body_plan: explicit } : {}),
      // rival_id already carries the `rival_` prefix (see themePlan.ts); strip it so
      // frame keys built as `rival_<id>` don't double-prefix.
      rival_id: rival.rival_id.replace(/^rival_/, ''),
      display_name: rival.name,
      ...(description ? { visual_description: description } : {}),
    };
  });
}

/**
 * Map one 5x4 rival board's sliced cells to frame keys. Each row r → `rival_<id>`
 * holds that row's five cells (indices r*5 .. r*5+4) = [walk0, walk1, walk2, attack0, attack1].
 */
function applyRivalBoardFrames(
  frames: Record<string, string[]>,
  slots: Array<{ slot_id: number; data: string }>,
  rows: ThemeRivalBoardRow[],
): string[] {
  const keys: string[] = [];
  rows.forEach((row, rowIndex) => {
    const key = `rival_${row.rival_id}`;
    frames[key] = slots.slice(rowIndex * 5, rowIndex * 5 + 5).map((slot) => slot.data);
    keys.push(key);
  });
  return keys;
}

/**
 * Writes one object board's frames into `frames`.
 *   - Board 1 (all `object_static` rows): cell i -> `object_<id>`, 1 frame.
 *   - Board 2 (`[object_anim, object_anim, poof, object_static,
 *     object_static, object_static, crate]`): row 1 (slots 0-3) and row 2
 *     (slots 4-7) -> `object_<id>`, 4 frames each; slots 8-11 -> `poof`, 4
 *     frames; slots 12-14 -> `object_<id>`, 1 frame each (the three row-4
 *     static objects); slot 15 -> `crate`, 1 frame.
 * Exported for unit testing multi-board mappings (see objectRowsForItem).
 */
export function applyObjectBoardFrames(
  frames: Record<string, string[]>,
  slots: Array<{ slot_id: number; data: string }>,
  rows: ThemeObjectBoardRow[],
): string[] {
  const isBoard2 = rows.some((row) => row.kind === 'object_anim' || row.kind === 'poof' || row.kind === 'crate');
  const keys: string[] = [];
  const sliceData = (start: number, end: number) => slots.slice(start, end).map((slot) => slot.data);
  if (isBoard2) {
    const [rowA, rowB, poofRow, staticC, staticD, staticE, crateRow] = rows;
    if (rowA?.kind === 'object_anim') {
      const key = `object_${rowA.object_id}`;
      frames[key] = sliceData(0, 4);
      keys.push(key);
    }
    if (rowB?.kind === 'object_anim') {
      const key = `object_${rowB.object_id}`;
      frames[key] = sliceData(4, 8);
      keys.push(key);
    }
    if (poofRow?.kind === 'poof') {
      frames.poof = sliceData(8, 12);
      keys.push('poof');
    }
    ([[staticC, 12], [staticD, 13], [staticE, 14]] as const).forEach(([row, slotIndex]) => {
      if (row?.kind !== 'object_static') return;
      const key = `object_${row.object_id}`;
      const slot = slots[slotIndex];
      frames[key] = slot ? [slot.data] : [];
      keys.push(key);
    });
    if (crateRow?.kind === 'crate') {
      frames.crate = sliceData(15, 16);
      keys.push('crate');
    }
    return keys;
  }
  rows.forEach((row, index) => {
    if (row.kind !== 'object_static') return;
    const key = `object_${row.object_id}`;
    frames[key] = slots[index] ? [slots[index].data] : [];
    keys.push(key);
  });
  return keys;
}

/**
 * Delete any frame key a board USED TO write (per its previously saved
 * `frame_keys`) that it no longer writes after this (re)generation/re-slice
 * (`newFrameKeys`). This is what makes a re-slice self-healing regardless of
 * board-processing order: without it, a board whose row composition shrank
 * (e.g. it lost the 'poof'/'crate' rows because the object roster grew and
 * pushed them onto a later board) would leave its OLD 'poof'/'crate' values
 * sitting in frames.json forever, and if that same board is ever reprocessed
 * again for any reason, it would silently re-clobber whichever board now
 * legitimately owns those keys. Deletion is scoped strictly to keys THIS
 * item previously owned, so it can never remove another board's frames.
 * Exported for unit testing.
 */
export function removeStaleBoardFrameKeys(
  frames: Record<string, string[]>,
  previousFrameKeys: readonly string[] | undefined,
  newFrameKeys: readonly string[],
): void {
  if (!previousFrameKeys?.length) return;
  const stillOwned = new Set(newFrameKeys);
  for (const staleKey of previousFrameKeys) {
    if (!stillOwned.has(staleKey)) delete frames[staleKey];
  }
}

function applyLegacyObjectFrames(
  frames: Record<string, string[]>,
  slots: Array<{ slot_id: number; data: string }>,
  objects: Array<{ object_id: string; display_name: string }>,
): string[] {
  return objects.slice(0, 12).map((object, index) => {
    const key = `object_${object.object_id}`;
    frames[key] = slots[index] ? [slots[index].data] : [];
    return key;
  });
}

function applyExpressionFrames(
  frames: Record<string, string[]>,
  slots: Array<{ slot_id: number; data: string }>,
): string[] {
  // No legacy 'emote_smile'/'emote_sleep'/'emote_idea'/'emote_team' alias here:
  // those strings are body-clip STATE labels used only by themeBuilder.ts /
  // theme-builder.js (current_emote -> point/sit/dance/signal clip selection),
  // never keys read out of the `frames` image map. Writing them here produced
  // dead frame-image entries nobody consumed. See the distinct expression-icon
  // bubble system (expression_0..7) vs. body point/signal clips note.
  return slots.slice(0, 8).map((slot, index) => {
    const key = `expression_${index}`;
    frames[key] = [slot.data];
    return key;
  });
}

function applyAchievementFrames(
  frames: Record<string, string[]>,
  slots: Array<{ slot_id: number; data: string }>,
): string[] {
  // The board is 5×5 = 25 cells, and all 25 default badges claim
  // achievement_0..24 (the rebirth_5 badge claims the formerly-spare cell 24).
  // Persist exactly the 25 claimed frames, upholding the "persist == claimed"
  // invariant so every drawn cell maps to a badge and Theme Health's orphan
  // pass stays clean.
  return slots.slice(0, 25).map((slot, index) => {
    const key = `achievement_${index}`;
    frames[key] = [slot.data];
    return key;
  });
}

function applyLegacyEmoteFrames(
  frames: Record<string, string[]>,
  slots: Array<{ slot_id: number; data: string }>,
): string[] {
  const keys = ['emote_smile', 'emote_sleep', 'emote_idea', 'emote_team'];
  keys.forEach((key, row) => {
    frames[key] = slots.slice(row * 5, row * 5 + 5).map((slot) => slot.data);
  });
  return keys;
}

async function markGenerated(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  displayName: string,
  item: Omit<ThemeImageReviewItem, 'updated_at'>,
  attempt?: { attemptCost: number; refunded: boolean },
): Promise<void> {
  await upsertThemeImageReviewItem(globalStorageUri, themeId, displayName, {
    ...item,
    status: 'pending',
    updated_at: new Date().toISOString(),
    ...(attempt ? { ...recordAttemptCharge(item, attempt), error_kind: undefined } : {}),
  });
}

/**
 * Writes manifest.json and frames.json for a theme.
 *
 * `ownedFrameKeys`, when provided, makes the frames.json write MERGE-SAFE: the
 * current on-disk frames.json is re-read immediately before writing, and only
 * the given keys are overlaid from `frames` onto that fresh copy (a key absent
 * from `frames` is deleted, matching removeStaleBoardFrameKeys semantics) —
 * every OTHER key defers to whatever is currently on disk instead of this
 * call's in-memory snapshot. This matters because board regeneration is slow
 * (an image-generation API call sits between the frames.json read and this
 * write), so several boards can be retried concurrently; each retry loads its
 * own frames.json snapshot before its slow call, and a blind overwrite here
 * would let a later-finishing retry silently revert an earlier, faster
 * retry's already-saved frames back to stale art.
 *
 * Omit `ownedFrameKeys` to keep the previous full-overwrite behavior, which
 * is still correct for callers where `frames` is the one continuously-updated
 * in-memory copy for the whole synchronous operation (e.g. the initial
 * full-theme generation pass, tuning/rename saves).
 */
/**
 * Pure merge step behind writeThemeFiles' merge-safe frames.json write (see
 * that function's doc comment for the full race it closes). Exported so the
 * merge algorithm itself can be unit-tested without mocking the VS Code
 * filesystem API: given whatever is CURRENTLY on disk plus this operation's
 * in-memory `frames` and the keys it owns, returns the object that should be
 * written — every non-owned key comes from disk, every owned key comes from
 * `frames` (or is dropped if `frames` no longer has it, matching
 * removeStaleBoardFrameKeys semantics).
 */
export function mergeOwnedFrames(
  onDiskFrames: Record<string, string[]> | undefined,
  frames: Record<string, string[]>,
  ownedFrameKeys: readonly string[],
): Record<string, string[]> {
  const merged = { ...(onDiskFrames ?? frames) };
  for (const key of ownedFrameKeys) {
    if (key in frames) merged[key] = frames[key];
    else delete merged[key];
  }
  return merged;
}

/**
 * Per-theme_id async serialization queue backing writeThemeFiles' critical
 * section (see that function's doc comment for the race this closes: two
 * concurrent board retries for the SAME theme can each read a frames.json
 * snapshot before the other has written, so the second write silently
 * reverts the first). Chaining onto the tail promise per key gives strict
 * FIFO exclusivity per theme_id while leaving different themes fully
 * parallel. The tail is settle-guarded (its own .then swallows rejection)
 * so a failed write does not wedge the queue for subsequent callers, and the
 * map entry is deleted once the chain drains back to empty so it never
 * leaks entries for themes that are no longer being written.
 */
const themeWriteQueues = new Map<string, Promise<unknown>>();

function runExclusivePerTheme<T>(themeId: string, task: () => Promise<T>): Promise<T> {
  const tail = themeWriteQueues.get(themeId) ?? Promise.resolve();
  const result = tail.then(() => task(), () => task());
  const newTail = result.then(
    () => undefined,
    () => undefined,
  );
  themeWriteQueues.set(themeId, newTail);
  newTail.then(() => {
    if (themeWriteQueues.get(themeId) === newTail) {
      themeWriteQueues.delete(themeId);
    }
  });
  return result;
}

export async function writeThemeFiles(
  globalStorageUri: ThemeStorageRoot,
  manifest: ThemeManifest,
  frames: Record<string, string[]>,
  ownedFrameKeys?: readonly string[],
): Promise<void> {
  return runExclusivePerTheme(manifest.theme_id, async () => {
    const store = resolveThemeFileStore(globalStorageUri);
    await store.mkdirp(themeDirectoryPath(manifest.theme_id));
    await store.writeFile(themeManifestPath(manifest.theme_id), jsonBuffer(manifest));

    let framesToWrite = frames;
    if (ownedFrameKeys) {
      const onDiskFrames = await readJson<Record<string, string[]>>(
        store,
        themeFramesPath(manifest.theme_id),
      );
      framesToWrite = mergeOwnedFrames(onDiskFrames, frames, ownedFrameKeys);
    }
    await store.writeFile(themeFramesPath(manifest.theme_id), jsonBuffer(framesToWrite));
  });
}

async function saveReviewImage(
  globalStorageUri: ThemeStorageRoot,
  themeId: string,
  filename: string,
  data: Buffer,
): Promise<void> {
  const store = resolveThemeFileStore(globalStorageUri);
  await store.writeFile(`${themeImagesDirectoryPath(themeId)}/${filename}`, data);
}

async function listReviewImageUris(
  store: ThemeFileStore,
  directoryPath: string,
): Promise<ThemeFileHandle[]> {
  const entries = await store.readdir(directoryPath);
  return entries
    .filter((entry) => entry.isFile && /\.(?:png|jpe?g|webp)$/i.test(entry.name))
    .map((entry) => resolveFileHandle(store, `${directoryPath}/${entry.name}`))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function getThemeDiskSize(globalStorageUri: ThemeStorageRoot, themeId: string): Promise<number> {
  const store = resolveThemeFileStore(globalStorageUri);
  const targets = [
    themeDirectoryPath(themeId),
    legacyManifestPath(themeId),
    legacyFramesPath(themeId),
    legacyPlanPath(themeId),
    legacyReviewPath(themeId),
    legacyImageReviewPath(themeId),
    legacyImagesDirectoryPath(themeId),
  ];
  const sizes = await Promise.all(targets.map((path) => diskUsage(store, path)));
  return sizes.reduce((total, size) => total + size, 0);
}

// Directory-name segments never counted toward a theme's reported disk size.
// `raw` (images/raw/, and its legacy-layout equivalent) holds pre-slice raw
// atlases — intermediate build artifacts that are never shipped, never
// exported, and irrelevant to what the theme actually costs a user. Matched
// against the bare directory-entry name (not a substring of the full path),
// so a theme id that happens to contain "raw" is never affected. Do not
// remove this exclusion without re-checking the reported sizes against real
// themes — restoring it silently reintroduces the "raw inflates the number"
// bug.
const DISK_USAGE_EXCLUDED_DIRECTORY_NAMES = new Set(['raw']);

// File-name patterns never counted: `.bak` backups (see the
// `manifest.json.<timestamp>.bak` writer above) and `.tmp` in-progress
// writes. Neither reflects real shippable content.
const DISK_USAGE_EXCLUDED_FILE_PATTERN = /\.(?:bak|tmp)$/i;

async function diskUsage(store: ThemeFileStore, path: string): Promise<number> {
  try {
    const stat = await store.stat(path);
    if (stat.isFile) return stat.size;
    if (!stat.isDirectory) return 0;
    const entries = await store.readdir(path);
    const countedEntries = entries.filter((entry) => {
      if (entry.isDirectory && DISK_USAGE_EXCLUDED_DIRECTORY_NAMES.has(entry.name)) return false;
      if (entry.isFile && DISK_USAGE_EXCLUDED_FILE_PATTERN.test(entry.name)) return false;
      return true;
    });
    const sizes = await Promise.all(countedEntries.map((entry) => diskUsage(store, `${path}/${entry.name}`)));
    return sizes.reduce((total, size) => total + size, 0);
  } catch {
    return 0;
  }
}

function matchLegacyCharacter(item: ThemeImageReviewItem, filename: string, manifest: ThemeManifest): void {
  const stem = filename.replace(/\.[^.]+$/, '').replace(/_recovered_atlas$|_atlas$/, '');
  const rival = manifest.roster_rivals.find((candidate) =>
    stem === candidate.rival_id || stem.startsWith(`${candidate.rival_id}_`),
  );
  if (rival) {
    item.id = rival.rival_id;
    item.frame_keys = [rival.rival_id];
    item.subject = rival.name;
    item.label = rival.name;
    return;
  }
  const agentMatch = /^(agent_(\d+))/.exec(stem);
  const agent = agentMatch
    ? manifest.roster_agents.find((candidate) => candidate.slot_id === Number(agentMatch[2]))
    : undefined;
  if (agent && agentMatch) {
    item.id = agentMatch[1];
    item.frame_keys = [agentMatch[1]];
    item.subject = agent.name;
    item.label = agent.name;
  }
}

async function readJson<T>(store: ThemeFileStore, relativePath: string): Promise<T | undefined> {
  try {
    const bytes = await store.readFile(relativePath);
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

function throwIfCancelled(isCancelled?: () => boolean, signal?: AbortSignal): void {
  if (isCancelled?.() || signal?.aborted) throw new Error('Generation cancelled by user');
}

function basename(uri: ThemeFileHandle): string {
  return uri.path.split('/').pop() ?? '';
}

function dataUri(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2));
}

function toSafeFileStem(value: string): string {
  return toSafeAssetId(value) || 'image';
}

function isThemeId(value: string): boolean {
  return /^[a-z0-9_]+$/.test(value);
}

/**
 * Ensures a brand-new theme never collides with an existing theme's storage
 * folder / per-theme progress key. `theme_id` is a plain slug of the display
 * name (toSafeThemeId, no dedup), so two themes with similar names — or a
 * fresh "Start generation" that happens to reuse a prior name — would
 * otherwise resolve to the SAME `themes/<theme_id>/` directory and the same
 * `${projectScopeKey}|<theme_id>` progress key, silently overwriting the
 * older theme's manifest/frames and leaking its rebirth/badge/build state.
 *
 * Only called from the CREATE-a-new-theme path (generateTheme). Regenerating
 * an existing theme in place goes through resumeThemeGeneration with an
 * already-known theme_id and never calls this — so an intentional in-place
 * regeneration is never renamed/orphaned by this check.
 *
 * Mirrors the numeric-suffix dedup style of `uniqueIds()` in themePlan.ts:
 * append _2, _3, ... to the base slug until no existing theme folder matches.
 */
export async function resolveUniqueNewThemeId(globalStorageUri: ThemeStorageRoot, baseThemeId: string): Promise<string> {
  const existing = new Set<string>();
  try {
    const store = resolveThemeFileStore(globalStorageUri);
    const entries = await store.readdir(themesDirectoryPath());
    for (const entry of entries) {
      if (entry.isDirectory) existing.add(entry.name);
    }
  } catch {
    // The themes directory doesn't exist yet (first-ever theme) — nothing to collide with.
  }
  if (!existing.has(baseThemeId)) return baseThemeId;
  let suffix = 2;
  let candidate = `${baseThemeId}_${suffix}`;
  while (existing.has(candidate)) {
    suffix += 1;
    candidate = `${baseThemeId}_${suffix}`;
  }
  return candidate;
}

function defaultNames(label: string, count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${label} ${index + 1}`);
}
