/**
 * imageClient.ts — Zero-dependency image generation client.
 * Selects the Theme Builder provider at call time.
 * Uses the global fetch available in Node 18+ (same pattern as translator.ts).
 */

import * as vscode from 'vscode';
import { findGeminiInlineImage, summarizeGeminiImageResponse } from './geminiImageResponse';
import { parseOpenAIImageError } from './imageGenerationError';
import type { ThemeImageProvider } from './themeImageSettings';

export interface ThemeImageGenerationOptions {
  provider?: ThemeImageProvider;
  apiKey?: string;
  aspectRatio?: '1:1' | '3:4';
  /** Cancels the in-flight provider request when a theme generation is stopped. */
  signal?: AbortSignal;
  referenceImages?: Array<{
    data: Buffer;
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    filename: string;
  }>;
}

/**
 * Generate a theme image using the configured AI image provider.
 * Uses the explicitly selected provider and falls back to extension settings
 * or environment variables for backwards compatibility.
 */
export async function generateThemeImage(
  prompt: string,
  options: ThemeImageGenerationOptions = {},
): Promise<Buffer> {
  const config = vscode.workspace.getConfiguration('tycoonagents');
  const provider = options.provider
    ?? (config.get<string>('themeImageProvider', 'openai') === 'gemini' ? 'gemini' : 'openai');
  const apiKey = options.apiKey || (provider === 'openai'
    ? config.get<string>('openaiApiKey') || process.env.OPENAI_API_KEY
    : config.get<string>('geminiApiKey') || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

  if (!apiKey) {
    const label = provider === 'openai' ? 'OpenAI' : 'Google Gemini';
    throw new Error(`No ${label} API key found. Add one in Themes > Theme Builder.`);
  }

  return provider === 'openai'
    ? generateWithOpenAI(prompt, apiKey, options)
    : generateWithImagen3(prompt, apiKey, options);
}

async function generateWithImagen3(
  prompt: string,
  apiKey: string,
  options: ThemeImageGenerationOptions,
): Promise<Buffer> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${apiKey}`;
  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          ...(options.referenceImages ?? []).map((image) => ({
            inline_data: {
              mime_type: image.mimeType,
              data: image.data.toString('base64'),
            },
          })),
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: {
        aspectRatio: options.aspectRatio ?? '1:1',
        imageSize: '1K',
      },
    },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (err) {
    if (options.signal?.aborted) throw new Error('Generation cancelled by user');
    throw new Error(`Gemini Image network error: ${String(err)}`);
  }

  if (!response.ok) {
    let errBody = '';
    try {
      errBody = await response.text();
    } catch {
      // ignore
    }
    throw new Error(
      `Gemini Image API error ${response.status}: ${errBody.slice(0, 300)}`,
    );
  }

  let json: unknown;
  let rawText = '';
  try {
    rawText = await response.text();
    json = JSON.parse(rawText);
  } catch {
    throw new Error(
      `Gemini Image: failed to parse JSON response. Body: ${rawText.slice(0, 300)}`,
    );
  }

  const image = findGeminiInlineImage(json);
  if (!image) {
    throw new Error(
      `Gemini Image: response contained no image data (${summarizeGeminiImageResponse(json)}).`,
    );
  }

  return Buffer.from(image.data, 'base64');
}

async function generateWithOpenAI(
  prompt: string,
  apiKey: string,
  options: ThemeImageGenerationOptions,
): Promise<Buffer> {
  const hasReferences = (options.referenceImages?.length ?? 0) > 0;
  const url = hasReferences
    ? 'https://api.openai.com/v1/images/edits'
    : 'https://api.openai.com/v1/images/generations';
  const size = options.aspectRatio === '3:4' ? '1024x1440' : '1024x1024';
  const body = {
    model: 'gpt-image-2',
    prompt,
    n: 1,
    size,
    quality: 'medium',
    background: 'opaque',
  };

  let response: Response;
  try {
    if (hasReferences) {
      const form = new FormData();
      form.append('model', body.model);
      form.append('prompt', body.prompt);
      form.append('n', String(body.n));
      form.append('size', body.size);
      form.append('quality', body.quality);
      form.append('background', body.background);
      for (const image of options.referenceImages ?? []) {
        form.append(
          'image[]',
          new Blob([new Uint8Array(image.data)], { type: image.mimeType }),
          image.filename,
        );
      }
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: options.signal,
      });
    } else {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    }
  } catch (err) {
    if (options.signal?.aborted) throw new Error('Generation cancelled by user');
    throw new Error(`OpenAI GPT Image network error: ${String(err)}`);
  }

  if (!response.ok) {
    let errBody = '';
    try {
      errBody = await response.text();
    } catch {
      // ignore
    }
    throw parseOpenAIImageError(
      response.status,
      errBody,
      response.headers.get('x-request-id'),
    );
  }

  let json: unknown;
  let rawText = '';
  try {
    rawText = await response.text();
    json = JSON.parse(rawText);
  } catch {
    throw new Error(
      `OpenAI GPT Image: failed to parse JSON response. Body: ${rawText.slice(0, 300)}`,
    );
  }

  const data = (json as { data?: Array<{ b64_json?: string }> }).data;
  if (!Array.isArray(data) || data.length === 0 || !data[0].b64_json) {
    throw new Error('OpenAI GPT Image: no b64_json in response data.');
  }

  return Buffer.from(data[0].b64_json, 'base64');
}
