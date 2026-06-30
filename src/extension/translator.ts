// Transport intentionally uses Node's built-in fetch so theme planning stays
// provider-neutral and does not add another runtime SDK dependency.

import * as vscode from 'vscode';
import type { ThemeManifest } from '../shared/types';
import type { ThemeImageGenerationOptions } from './imageClient';
import {
  normalizeThemePlan,
  themePlanCreativeDirection,
  themePlanToManifest,
} from './themePlan';
import type { ThemePlan } from './themePlan';

interface PlannerModelOutput {
  display_name?: string;
  creative_direction?: string;
  characters?: unknown;
  environment?: string;
  objects?: unknown;
  enemies?: unknown;
  expressions?: unknown;
  achievements?: unknown;
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

  const planningPrompt = [
    'You are planning a cohesive visual asset pack for a tycoon game.',
    'Return STRICT JSON only: no markdown, comments, commentary, or extra keys.',
    '',
    `Requested theme: ${rawUserInput}`,
    '',
    'Use what you know about the requested theme to fill every value with a specific, visually distinct suggestion.',
    'Return exactly this JSON shape and exact array lengths:',
    '{',
    '  "display_name": "short theme name",',
    '  "creative_direction": "art style, palette, materials, lighting, camera, and unifying visual language",',
    '  "characters": ["16 named character or worker designs"],',
    '  "environment": "one detailed isometric environment description",',
    '  "objects": ["12 named props or buildable objects"],',
    '  "enemies": ["3 named enemy designs"],',
    '  "expressions": ["16 short, visually distinct expression names"],',
    '  "achievements": ["20 short achievement badge design names"]',
    '}',
    '',
    'Achievements are visual concepts only; do not define unlock rules yet.',
  ].join('\n');

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
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
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
    environment: model.environment,
    objects: Array.isArray(model.objects) ? model.objects as string[] : [],
    enemies: Array.isArray(model.enemies) ? model.enemies as string[] : [],
    expressions: Array.isArray(model.expressions) ? model.expressions as string[] : [],
    achievements: Array.isArray(model.achievements) ? model.achievements as string[] : [],
  }, rawUserInput);
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

function resolvePlannerSettings(options: ThemeImageGenerationOptions): {
  provider: 'gemini' | 'openai';
  apiKey?: string;
} {
  const config = vscode.workspace.getConfiguration('tycoonagents');
  const provider = options.provider
    ?? (config.get<string>('themeImageProvider', 'gemini') === 'openai' ? 'openai' : 'gemini');
  const apiKey = options.apiKey || (provider === 'openai'
    ? config.get<string>('openaiApiKey') || process.env.OPENAI_API_KEY
    : config.get<string>('geminiApiKey') || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
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
