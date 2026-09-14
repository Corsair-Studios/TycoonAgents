// Transport intentionally uses Node's built-in fetch so theme planning stays
// provider-neutral and does not add another runtime SDK dependency.

import type { ThemeManifest } from '../shared/types';
/**
 * Local, text-LLM-only settings type (p43-t1). Previously imported from
 * imageClient.ts, which was deleted when direct-provider IMAGE generation
 * moved to the Corsair Theme Service — theme planning/description generation
 * here still calls the OpenAI/Gemini chat-completions endpoints directly
 * (unaffected by that migration; see docs/theme-service-api.md's Generation
 * section, which only covers image attempts), so this keeps its own
 * provider/apiKey/model shape rather than sharing themeService.ts's
 * (image-only) ThemeImageGenerationOptions.
 */
export interface ThemeImageGenerationOptions {
  provider?: 'gemini' | 'openai';
  apiKey?: string;
  model?: string;
  quality?: string;
}
import {
  FIXED_EXPRESSION_LABELS,
  normalizeThemePlan,
  themePlanCreativeDirection,
  themePlanToManifest,
} from './themePlan';
import type { ThemePlan } from './themePlan';

interface PlannerModelOutput {
  display_name?: string;
  creative_direction?: string;
  characters?: unknown;
  character_descriptions?: unknown;
  environment?: string;
  objects?: unknown;
  object_motion_hints?: unknown;
  object_descriptions?: unknown;
  crate_description?: string;
  poof_description?: string;
  projectile_description?: string;
  decor?: unknown;
  decor_descriptions?: unknown;
  enemies?: unknown;
  enemy_attack_styles?: unknown;
  enemy_descriptions?: unknown;
  expressions?: unknown;
  expression_descriptions?: unknown;
  achievements?: unknown;
  achievement_descriptions?: unknown;
}

/**
 * Build the provider-neutral theme-planning prompt (same text sent to both
 * OpenAI and Gemini). Extracted to a pure function so it's unit-testable
 * without a network call.
 */
export function buildThemePlanningPrompt(userPrompt: string): string {
  const expressionLabelList = FIXED_EXPRESSION_LABELS
    .map((label, i) => `${i + 1}. ${label}`)
    .join(', ');

  return [
    'You are planning a cohesive visual asset pack for a tycoon game.',
    'Return STRICT JSON only: no markdown, comments, commentary, or extra keys.',
    '',
    `Requested theme: ${userPrompt}`,
    '',
    'Use what you know about the requested theme to fill every value with a specific, visually distinct suggestion.',
    'Return exactly this JSON shape and exact array lengths:',
    '{',
    '  "display_name": "short theme name",',
    '  "creative_direction": "art style, palette, materials, lighting, camera, and unifying visual language",',
    '  "characters": ["16 named character or worker designs"],',
    '  "character_descriptions": ["16 concrete visual-appearance specs, one per character in the same order"],',
    '  "environment": "one detailed isometric environment description",',
    '  "objects": ["EXACTLY 21 named props or buildable objects — never fewer, never omit or merge entries (1 ranged-weapons rack + 20 more); the FIRST entry MUST be a themed rack of RANGED weapons (e.g. a laser-rifle rack, a missile rack, a crossbow rack) — pick a ranged weapon type that fits the setting and name it as a rack/stand of those weapons; the LAST 2 entries are the only ones that will be animated, so make them naturally motion-friendly (e.g. a machine with blinking lights, a spinning device)"],',
    '  "object_motion_hints": ["EXACTLY 21 SHORT idle-motion phrases, one per object in the same order and same count as \\"objects\\" — never fewer (e.g. \\"radar dish slowly rotates\\", \\"reactor core pulses\\"); only the LAST 2 objects are actually animated in-game, so focus these hints there — describe one subtle looping motion or light cycle per object"],',
    '  "object_descriptions": ["EXACTLY 21 concrete visual-appearance specs, one per object in the same order and same count as \\"objects\\" — never fewer, and never leave any entry (including the rack) blank"],',
    '  "crate_description": "a concrete visual-appearance spec for the single build CRATE that appears while an object is under construction — the shipping/supply crate prop, themed to fit the pack",',
    '  "poof_description": "a concrete visual-appearance spec for the single build-completion POOF effect — the burst/reveal FX that plays when an object finishes building, themed to fit the pack",',
    '  "projectile_description": "a concrete visual-appearance spec for the single ranged-combat PROJECTILE fired during combat — the bolt/effect look itself (e.g. a laser bolt, an arrow, a fireball, a plasma blast), themed to fit the pack; note it animates as a 4-frame sequence: muzzle flash at launch, in-flight travelling, impact hit, then a blast/burst",',
    '  "decor": ["9 background decor names: first 4 are sittable seats, next 4 are static scenery props, last 1 is a subtly animated scenery item"],',
    '  "decor_descriptions": ["9 concrete visual-appearance specs, one per decor item in the same order"],',
    '  "enemies": ["4 named enemy designs"],',
    '  "enemy_attack_styles": [<one of "melee" or "ranged" for EACH enemy, SAME ORDER as "enemies"; "ranged" if that enemy fights primarily with a gun, bow, thrown weapon, or energy/projectile weapon at a distance; "melee" if it fights hand-to-hand or with a close-contact weapon (fists, claws, blade, club, spear)>],',
    '  "enemy_descriptions": ["4 concrete visual-appearance specs, one per enemy in the same order"],',
    `  "expression_descriptions": ["EXACTLY 8 concrete visual specs, one per FIXED expression slot IN THIS EXACT ORDER: ${expressionLabelList}. These slot NAMES/MEANINGS are fixed and MUST NOT be renamed or reordered. Each description must depict a single BOLD SYMBOLIC ICON or pictogram for that emotion — explicitly NOT a character, face, head, or body of any kind; describe only the icon/symbol itself. It may be theme-flavored (this pack's colors, materials, motifs) but must stay a clean, simple, instantly-readable symbol even at very small size. Examples: Love = a heart icon; Idea = a lightbulb or spark icon; Anger = a scowl/anger mark or a clenched-fist symbol; Team rally = a raised-fists or rally-banner icon; Thumbs up = a thumbs-up icon; Music = a music note icon; Sleep = \\"zzz\\" marks; Dazed/hit = stars or a bandage icon."],`,
    '  "achievements": ["25 short achievement badge design names"],',
    '  "achievement_descriptions": ["25 concrete visual-appearance specs, one per achievement badge in the same order as \\"achievements\\" — the badge\'s icon/emblem look, not its unlock rule"]',
    '}',
    '',
    'Achievements are visual concepts only; do not define unlock rules yet.',
    '',
    'Every "*_descriptions" array is a concise (1-2 sentence) CONCRETE visual spec for the matching entry at the same index: overall silhouette/form, primary + accent colors, key materials/finish, and 1-2 signature identifying features. Every entry in every "*_descriptions" array is REQUIRED and must be a non-empty, concrete spec — never leave a slot blank, and return exactly the required count for each array.',
    '"crate_description", "poof_description", and "projectile_description" are the same kind of concise CONCRETE visual spec, but each is a single string (not an array) — there is exactly one build crate, one build-completion poof effect, and one ranged-combat projectile per theme.',
    'Each description must be consistent with "creative_direction" and coherent across the whole set (shared palette, materials, and art language).',
    'If the named item corresponds to a recognizable, well-known design (a famous character, vehicle, building, weapon, logo, etc.), describe THAT specific design faithfully — accuracy over generic invention is the whole point of these fields.',
  ].join('\n');
}

/**
 * Expand a short theme request into the complete, editable pre-generation
 * plan shown in the Theme Builder.
 */
export async function expandThemePlan(
  rawUserInput: string,
  options: ThemeImageGenerationOptions = {},
): Promise<ThemePlan> {
  const { provider, apiKey } = resolvePlannerSettings(options);
  if (!apiKey) {
    const label = provider === 'openai' ? 'OpenAI' : 'Google Gemini';
    throw new Error(`${label} API key is required. Add one in Themes > Theme Builder.`);
  }

  const planningPrompt = buildThemePlanningPrompt(rawUserInput);

  const response = provider === 'openai'
    ? await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4.1-mini',
          messages: [{ role: 'user', content: planningPrompt }],
          response_format: { type: 'json_object' },
        }),
      })
    : await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: planningPrompt }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        },
      );

  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`${provider === 'openai' ? 'OpenAI' : 'Gemini'} API error ${response.status}: ${apiErrorDetail(rawBody)}`);
  }

  const modelText = extractModelText(rawBody, provider);
  let model: PlannerModelOutput;
  try {
    model = JSON.parse(stripMarkdownFences(modelText)) as PlannerModelOutput;
  } catch (err) {
    throw new Error(
      `Failed to parse ${provider === 'openai' ? 'OpenAI' : 'Gemini'} theme plan as JSON: ${(err as Error).message}`,
    );
  }

  return normalizeThemePlan({
    display_name: model.display_name,
    creative_direction: model.creative_direction,
    characters: Array.isArray(model.characters) ? model.characters as string[] : [],
    character_descriptions: Array.isArray(model.character_descriptions)
      ? model.character_descriptions as string[]
      : undefined,
    environment: model.environment,
    objects: Array.isArray(model.objects) ? model.objects as string[] : [],
    object_motion_hints: Array.isArray(model.object_motion_hints) ? model.object_motion_hints as string[] : [],
    object_descriptions: Array.isArray(model.object_descriptions)
      ? model.object_descriptions as string[]
      : undefined,
    crate_description: typeof model.crate_description === 'string' ? model.crate_description : undefined,
    poof_description: typeof model.poof_description === 'string' ? model.poof_description : undefined,
    projectile_description: typeof model.projectile_description === 'string' ? model.projectile_description : undefined,
    decor: Array.isArray(model.decor) ? model.decor as string[] : [],
    decor_descriptions: Array.isArray(model.decor_descriptions)
      ? model.decor_descriptions as string[]
      : undefined,
    enemies: Array.isArray(model.enemies) ? model.enemies as string[] : [],
    enemy_attack_styles: Array.isArray(model.enemy_attack_styles)
      ? (model.enemy_attack_styles as unknown[]).map(coerceAttackStyle)
      : undefined,
    enemy_descriptions: Array.isArray(model.enemy_descriptions)
      ? model.enemy_descriptions as string[]
      : undefined,
    expressions: Array.isArray(model.expressions) ? model.expressions as string[] : [],
    expression_descriptions: Array.isArray(model.expression_descriptions)
      ? model.expression_descriptions as string[]
      : undefined,
    achievements: Array.isArray(model.achievements) ? model.achievements as string[] : [],
    achievement_descriptions: Array.isArray(model.achievement_descriptions)
      ? model.achievement_descriptions as string[]
      : undefined,
    // Descriptions above were just generated under model.creative_direction
    // (falling back to the same default normalizeThemePlan will apply to
    // creative_direction itself when the model omitted it) — record it so
    // themeDescriptionsStale has a baseline to compare future edits against.
    descriptions_direction: model.creative_direction,
  }, rawUserInput);
}

/**
 * Focused re-derive prompt: given a plan's EXISTING names (characters,
 * objects, decor, enemies, expressions, achievements — never regenerated
 * here) and its CURRENT creative_direction, ask for fresh `*_descriptions`
 * only. Extracted as a pure function so it's unit-testable without a network
 * call, mirroring buildThemePlanningPrompt.
 */
export function buildThemeDescriptionsPrompt(plan: ThemePlan): string {
  const expressionLabelList = FIXED_EXPRESSION_LABELS
    .map((label, i) => `${i + 1}. ${label}`)
    .join(', ');
  return [
    'You are re-deriving ONLY the visual-appearance descriptions for an existing tycoon-game asset pack, under a (possibly updated) art direction.',
    'Return STRICT JSON only: no markdown, comments, commentary, or extra keys.',
    '',
    `Theme: ${plan.display_name}`,
    `Creative direction (this governs every description below): ${plan.creative_direction}`,
    `Environment: ${plan.environment}`,
    '',
    'Do NOT rename or reorder any item. For each list below, return exactly one description per name, in the SAME order.',
    `Characters (${plan.characters.length}): ${plan.characters.join(', ')}`,
    `Objects (${plan.objects.length}): ${plan.objects.join(', ')}`,
    `Decor (${plan.decor.length}): ${plan.decor.join(', ')}`,
    `Enemies (${plan.enemies.length}): ${plan.enemies.join(', ')}`,
    `Expressions (fixed slots, in this exact order: ${expressionLabelList})`,
    `Achievements (${plan.achievements.length}): ${plan.achievements.join(', ')}`,
    '',
    'Return exactly this JSON shape:',
    '{',
    `  "character_descriptions": [${plan.characters.length} concrete visual-appearance specs, one per character, same order],`,
    `  "object_descriptions": [${plan.objects.length} concrete visual-appearance specs, one per object, same order],`,
    '  "crate_description": "a concrete visual-appearance spec for the single build CRATE prop",',
    '  "poof_description": "a concrete visual-appearance spec for the single build-completion POOF effect",',
    '  "projectile_description": "a concrete visual-appearance spec for the single ranged-combat PROJECTILE effect",',
    `  "decor_descriptions": [${plan.decor.length} concrete visual-appearance specs, one per decor item, same order],`,
    `  "enemy_descriptions": [${plan.enemies.length} concrete visual-appearance specs, one per enemy, same order],`,
    '  "expression_descriptions": [EXACTLY 8 concrete visual specs, one per fixed expression slot in the exact order listed above — a single bold symbolic icon per slot, never a face/character],',
    `  "achievement_descriptions": [${plan.achievements.length} concrete visual-appearance specs, one per achievement badge, same order]`,
    '}',
    '',
    'Every description is a concise (1-2 sentence) CONCRETE visual spec: overall silhouette/form, primary + accent colors, key materials/finish, and 1-2 signature identifying features. Every entry is REQUIRED — never leave a slot blank, and return exactly the required count for each array. Every description must be consistent with the creative direction above and coherent across the whole set (shared palette, materials, and art language).',
  ].join('\n');
}

interface DescriptionsOnlyModelOutput {
  character_descriptions?: unknown;
  object_descriptions?: unknown;
  crate_description?: string;
  poof_description?: string;
  projectile_description?: string;
  decor_descriptions?: unknown;
  enemy_descriptions?: unknown;
  expression_descriptions?: unknown;
  achievement_descriptions?: unknown;
}

/**
 * Re-derive ONLY the `*_descriptions` fields of an existing plan from its
 * CURRENT creative_direction, leaving every name array (characters, objects,
 * decor, enemies, expressions, achievements) untouched. Returns just the
 * updated description fields plus the direction they were generated under
 * (`descriptions_direction`) — callers (themeService.regenerateThemeDescriptions)
 * merge this onto the saved plan and snapshot the prior descriptions under
 * `previous_descriptions` for one-level undo.
 */
export async function regenerateThemeDescriptionsFromPlan(
  plan: ThemePlan,
  options: ThemeImageGenerationOptions = {},
): Promise<Pick<ThemePlan,
  | 'character_descriptions' | 'object_descriptions' | 'crate_description' | 'poof_description'
  | 'projectile_description' | 'decor_descriptions' | 'enemy_descriptions' | 'expression_descriptions'
  | 'achievement_descriptions' | 'descriptions_direction'
>> {
  const { provider, apiKey } = resolvePlannerSettings(options);
  if (!apiKey) {
    const label = provider === 'openai' ? 'OpenAI' : 'Google Gemini';
    throw new Error(`${label} API key is required. Add one in Themes > Theme Builder.`);
  }

  const descriptionsPrompt = buildThemeDescriptionsPrompt(plan);

  const response = provider === 'openai'
    ? await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4.1-mini',
          messages: [{ role: 'user', content: descriptionsPrompt }],
          response_format: { type: 'json_object' },
        }),
      })
    : await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: descriptionsPrompt }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        },
      );

  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`${provider === 'openai' ? 'OpenAI' : 'Gemini'} API error ${response.status}: ${apiErrorDetail(rawBody)}`);
  }

  const modelText = extractModelText(rawBody, provider);
  let model: DescriptionsOnlyModelOutput;
  try {
    model = JSON.parse(stripMarkdownFences(modelText)) as DescriptionsOnlyModelOutput;
  } catch (err) {
    throw new Error(
      `Failed to parse ${provider === 'openai' ? 'OpenAI' : 'Gemini'} description regeneration as JSON: ${(err as Error).message}`,
    );
  }

  return {
    character_descriptions: requireDescriptionsArray('character_descriptions', model.character_descriptions, plan.characters.length),
    object_descriptions: requireDescriptionsArray('object_descriptions', model.object_descriptions, plan.objects.length),
    crate_description: typeof model.crate_description === 'string' ? model.crate_description : undefined,
    poof_description: typeof model.poof_description === 'string' ? model.poof_description : undefined,
    projectile_description: typeof model.projectile_description === 'string' ? model.projectile_description : undefined,
    decor_descriptions: requireDescriptionsArray('decor_descriptions', model.decor_descriptions, plan.decor.length),
    enemy_descriptions: requireDescriptionsArray('enemy_descriptions', model.enemy_descriptions, plan.enemies.length),
    expression_descriptions: requireDescriptionsArray('expression_descriptions', model.expression_descriptions, plan.expressions.length),
    achievement_descriptions: requireDescriptionsArray('achievement_descriptions', model.achievement_descriptions, plan.achievements.length),
    descriptions_direction: plan.creative_direction,
  };
}

/**
 * Validate a single `*_descriptions` array from the description-regeneration
 * model response against the corresponding name array's length on the plan
 * being re-derived. Unlike expandThemePlan's initial full-plan generation
 * (where name arrays don't exist yet and normalizeThemePlan pads/truncates
 * freely), a regenerate call must produce descriptions that align 1:1 by
 * INDEX with the plan's EXISTING, already-fixed name arrays — a count
 * mismatch here would silently misalign description i with name j once
 * written through by themeService.regenerateThemeDescriptions. So this
 * throws rather than padding/truncating, leaving the saved plan untouched.
 * `expectedCount === 0` (e.g. a plan with no decor) treats an absent/empty
 * array as valid — undefined is returned so the field is omitted, matching
 * normalizeThemePlan's existing "no description data" convention.
 */
function requireDescriptionsArray(kind: string, value: unknown, expectedCount: number): string[] | undefined {
  if (expectedCount === 0 && (value === undefined || (Array.isArray(value) && value.length === 0))) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Description regeneration response for "${kind}" was not an array.`);
  }
  if (value.length !== expectedCount) {
    throw new Error(
      `Description regeneration response for "${kind}" returned ${value.length} entries, but the plan has ${expectedCount} — descriptions must align 1:1 with the plan's existing names.`,
    );
  }
  if (!value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)) {
    throw new Error(`Description regeneration response for "${kind}" contains a blank or non-string entry.`);
  }
  return value as string[];
}

/**
 * Coerce a single raw planner value into a strict 'melee' | 'ranged' attack
 * style, or undefined for anything else (missing, wrong type, unrecognized
 * string). Never defaults to 'ranged' — unclassified entries stay undefined
 * so the render layer's legacy default (melee, no projectile) applies.
 */
function coerceAttackStyle(value: unknown): 'melee' | 'ranged' | undefined {
  const lowered = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return lowered === 'melee' || lowered === 'ranged' ? lowered : undefined;
}

/** Backward-compatible adapter for callers that still request a manifest. */
export async function expandThemePrompt(
  rawUserInput: string,
  options: ThemeImageGenerationOptions = {},
): Promise<{ systemPrompt: string; suggestedManifest: Partial<ThemeManifest> }> {
  const plan = await expandThemePlan(rawUserInput, options);
  return {
    systemPrompt: themePlanCreativeDirection(plan),
    suggestedManifest: themePlanToManifest(plan),
  };
}

/**
 * Resolve which image provider/API key to use for a planning call.
 *
 * Pre-pC-t1 this fell back to reading `tycoonagents.themeImageProvider` /
 * `openaiApiKey` / `geminiApiKey` straight out of the VS Code settings API
 * when `options` didn't carry an explicit value. That was the only reason
 * this module needed a load-time editor-API import. It is DEAD CODE for
 * every real call path today: the extension host (panel.ts) always resolves
 * provider/apiKey
 * itself first — via `resolveThemeImageSettings` in themeImageSettings.ts,
 * which already checks the SAME settings keys (plus SecretStorage, checked
 * first) — and passes them in explicitly before calling `planTheme` /
 * `generateTheme`. So dropping the VS Code settings read here changes
 * nothing in practice; the env-var fallback (unaffected by VS Code) is kept.
 * Flagged as a behavior note in case some future caller invoked
 * `expandThemePlan`/`planTheme` with no explicit provider/apiKey while
 * relying purely on raw VS Code settings outside `resolveThemeImageSettings`.
 */
function resolvePlannerSettings(options: ThemeImageGenerationOptions): {
  provider: 'gemini' | 'openai';
  apiKey?: string;
} {
  const provider = options.provider ?? 'openai';
  const apiKey = options.apiKey || (provider === 'openai'
    ? process.env.OPENAI_API_KEY
    : process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  return { provider, apiKey };
}

function extractModelText(rawBody: string, provider: 'gemini' | 'openai'): string {
  try {
    if (provider === 'openai') {
      const envelope = JSON.parse(rawBody) as { choices?: Array<{ message?: { content?: string } }> };
      return envelope.choices?.[0]?.message?.content ?? rawBody;
    }
    const envelope = JSON.parse(rawBody) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return envelope.candidates?.[0]?.content?.parts?.[0]?.text ?? rawBody;
  } catch {
    return rawBody;
  }
}

function apiErrorDetail(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: string } };
    return parsed.error?.message ?? rawBody;
  } catch {
    return rawBody;
  }
}

function stripMarkdownFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}
