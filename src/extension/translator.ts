// Transport: plain fetch (Node 18+ global) rather than the @google/genai SDK.
// Reason: avoids an extra dependency, keeps the package lean, and the REST API
// is stable — one POST with a JSON body covers everything we need here.

import type { ThemeManifest, AgentConfig, RivalConfig, ViewportConfig } from '../shared/types';

// ---------------------------------------------------------------------------
// Internal shape returned by Gemini
// ---------------------------------------------------------------------------

interface GeminiAgentRow {
  name: string;
  pose: string;
}

interface GeminiRivalRow {
  rival_id: string;
  name: string;
}

interface GeminiModelOutput {
  creative_direction: string;
  display_name: string;
  agents: GeminiAgentRow[];
  rivals: GeminiRivalRow[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_POSES = ['pose_crossed', 'pose_down', 'pose_up'] as const;
type ValidPose = typeof VALID_POSES[number];

const WALKABLE_NAV_POLYGON: [number, number][] = [
  [0.50, 0.15],
  [0.88, 0.38],
  [0.88, 0.82],
  [0.50, 0.95],
  [0.12, 0.82],
  [0.12, 0.38],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coercePose(raw: string): ValidPose {
  if ((VALID_POSES as readonly string[]).includes(raw)) {
    return raw as ValidPose;
  }
  return 'pose_crossed';
}

function padOrTruncateAgents(agents: GeminiAgentRow[], count: number): GeminiAgentRow[] {
  const result = agents.slice(0, count);
  while (result.length < count) {
    result.push({ name: `Agent_${result.length}`, pose: 'pose_crossed' });
  }
  return result;
}

function padOrTruncateRivals(rivals: GeminiRivalRow[], count: number): GeminiRivalRow[] {
  const result = rivals.slice(0, count);
  while (result.length < count) {
    const n = result.length;
    result.push({ rival_id: `rival_${n}`, name: `Rival ${n}` });
  }
  return result;
}

function stripMarkdownFences(raw: string): string {
  // Strip leading ```json or ``` and trailing ```
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Calls Gemini to expand a raw user theme prompt into a structured system
 * prompt (for sprite-sheet generation) and a partial ThemeManifest that can
 * be merged into a full manifest by the caller.
 *
 * @param rawUserInput - Free-form theme description from the user.
 * @returns An object with `systemPrompt` (image-gen instruction string) and
 *          `suggestedManifest` (Partial<ThemeManifest> ready for merging).
 */
export async function expandThemePrompt(
  rawUserInput: string,
): Promise<{ systemPrompt: string; suggestedManifest: Partial<ThemeManifest> }> {
  // ── 0. Resolve API key ───────────────────────────────────────────────────
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY environment variable is required');
  }

  // ── 1. Call Gemini ───────────────────────────────────────────────────────
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: [
              `You are a game-theme designer. Given a raw theme prompt, return STRICT JSON only — no markdown, no commentary, no extra keys.`,
              ``,
              `Theme prompt: "${rawUserInput}"`,
              ``,
              `Return exactly this JSON shape:`,
              `{`,
              `  "creative_direction": "<string — expanded theme description, colour palette, tone>",`,
              `  "display_name": "<string — short friendly name for the theme>",`,
              `  "agents": [`,
              `    { "name": "<string>", "pose": "<pose_crossed|pose_down|pose_up>" }`,
              `    // exactly 16 entries covering roles: Orchestrator, Heavy Coders, Researchers, Bug Slayers`,
              `  ],`,
              `  "rivals": [`,
              `    { "rival_id": "<string>", "name": "<string>" }`,
              `    // exactly 2 entries`,
              `  ]`,
              `}`,
            ].join('\n'),
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
    },
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  const rawBody = await response.text();

  if (!response.ok) {
    // Attempt to surface the error message from the response body
    let detail = rawBody;
    try {
      const parsed = JSON.parse(rawBody) as { error?: { message?: string } };
      if (parsed.error?.message) {
        detail = parsed.error.message;
      }
    } catch {
      // keep rawBody as detail
    }
    throw new Error(`Gemini API error ${response.status}: ${detail}`);
  }

  // ── 2. Parse response ────────────────────────────────────────────────────
  // Gemini wraps the JSON content inside the candidates structure
  let modelText: string;
  try {
    const envelope = JSON.parse(rawBody) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    modelText = envelope.candidates?.[0]?.content?.parts?.[0]?.text ?? rawBody;
  } catch {
    // If the outer envelope itself isn't JSON, treat the raw body as the payload
    modelText = rawBody;
  }

  const cleaned = stripMarkdownFences(modelText);

  let model: GeminiModelOutput;
  try {
    model = JSON.parse(cleaned) as GeminiModelOutput;
  } catch (err) {
    throw new Error(
      `Failed to parse Gemini model output as JSON. ` +
      `Parse error: ${(err as Error).message}. ` +
      `Raw text (first 500 chars): ${cleaned.slice(0, 500)}`,
    );
  }

  // ── 3. Validate & coerce arrays ──────────────────────────────────────────
  const rawAgents: GeminiAgentRow[] = Array.isArray(model.agents) ? model.agents : [];
  const rawRivals: GeminiRivalRow[] = Array.isArray(model.rivals) ? model.rivals : [];

  const normalizedAgents = padOrTruncateAgents(rawAgents, 16);
  const normalizedRivals = padOrTruncateRivals(rawRivals, 2);

  // ── 4. Assemble systemPrompt (hardcoded rules, not model-generated) ──────
  const systemPrompt = [
    `=== SPRITE SHEET GENERATION INSTRUCTIONS ===`,
    ``,
    `Theme: ${model.display_name}`,
    `Creative direction: ${model.creative_direction}`,
    ``,
    `LAYOUT RULES (non-negotiable):`,
    `• 5 × 4 character atlas — 5 columns × 4 rows = 20 cells total.`,
    `• Each character CENTERED HORIZONTALLY within its grid cell.`,
    `• Each character's FEET TOUCHING THE BOTTOM BORDER of its cell.`,
    `• Paint the entire atlas over a SOLID MAGENTA (#FF00FF) background for chroma keying.`,
    ``,
    `THEME CONTENT:`,
    `Render characters that embody the following creative direction:`,
    model.creative_direction,
    ``,
    `The theme display name is: ${model.display_name}`,
  ].join('\n');

  // ── 5. Assemble suggestedManifest ────────────────────────────────────────
  const rosterAgents: AgentConfig[] = normalizedAgents.map((a, i) => ({
    slot_id: i,
    name: a.name,
    atlas_asset: `atlas_slot_${i}.png`,
    preferred_idle_pose: coercePose(a.pose),
  }));

  const rosterRivals: RivalConfig[] = normalizedRivals.map((r) => ({
    rival_id: r.rival_id,
    name: r.name,
    atlas_asset: `rival_${r.rival_id}.png`,
  }));

  const viewport: ViewportConfig = {
    native_width: 1280,
    native_height: 720,
    background_asset: 'background.png',
    walkable_nav_polygon: WALKABLE_NAV_POLYGON,
  };

  const suggestedManifest: Partial<ThemeManifest> = {
    display_name: model.display_name,
    roster_agents: rosterAgents,
    roster_rivals: rosterRivals,
    viewport,
  };

  return { systemPrompt, suggestedManifest };
}

/**
 * Builds an image-model prompt for a single character's 5×4 (20-frame) animation atlas.
 * Incorporates the creative direction from Gate 1's system prompt.
 */
export function buildCharacterAtlasPrompt(
  layoutSystemPrompt: string,
  characterName: string,
  themeName: string,
): string {
  return [
    `Render a 5-column × 4-row (20-cell) sprite atlas sheet on a solid magenta (#FF00FF) background.`,
    `The atlas contains ONLY the single character "${characterName}" from the "${themeName}" theme.`,
    `Show the SAME character across all 20 distinct animation frames and poses, in this order:`,
    `Row 1 (cells 1-5): walk cycle — 5 walking frames from left to right.`,
    `Row 2 (cells 6-10): build & work — holding tool, swinging tool, placing object, inspecting, idle with tool.`,
    `Row 3 (cells 11-15): combat — melee attack wind-up, melee attack, ranged attack wind-up, ranged attack, block/dodge.`,
    `Row 4 (cells 16-20): social — sitting, idle stand, dancing frame 1, dancing frame 2, victory pose.`,
    `Spatial rules: In every cell the character must be centered horizontally and their feet must rest on the cell's bottom border. Every cell has a solid magenta #FF00FF background for chroma-keying — no gradients, no shadows, no background scenery.`,
    `Character art style and creative direction (carry these into the atlas):`,
    layoutSystemPrompt,
  ].join('\n');
}

/**
 * Builds an image-model prompt for a single themed top-down/isometric environment background.
 */
export function buildEnvironmentPrompt(
  layoutSystemPrompt: string,
  themeName: string,
): string {
  return [
    `Render a single top-down / isometric environment background floor-plan image for the "${themeName}" theme.`,
    `The image should be a wide, navigable play area: show floors, terrain, structures, and props consistent with the theme.`,
    `No characters, no UI elements, no HUD overlays. The image will be used as a scrollable game background.`,
    `Creative direction and art style (carry these into the environment):`,
    layoutSystemPrompt,
  ].join('\n');
}
