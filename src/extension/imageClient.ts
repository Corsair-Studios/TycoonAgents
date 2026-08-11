/**
 * imageClient.ts — Zero-dependency image generation client.
 * Selects the Theme Builder provider at call time.
 * Uses the global fetch available in Node 18+ (same pattern as translator.ts).
 */

import { findGeminiInlineImage, summarizeGeminiImageResponse } from './geminiImageResponse';
import { parseOpenAIImageError } from './imageGenerationError';
import { resolveImageModel, resolveImageQuality } from './imageModels';
import type { ThemeImageProvider } from './themeImageSettings';

/**
 * Vscode-free settings used to resolve a provider + API key when the caller's
 * {@link ThemeImageGenerationOptions} doesn't already specify one. Hosts (the
 * VS Code extension, the standalone app) build this from their own secret
 * storage / settings and pass it into {@link generateThemeImage} — imageClient
 * itself never reads secrets or extension configuration directly, so it has
 * no dependency on the 'vscode' module and can run in either host.
 */
export interface ThemeImageConfig {
  /** Default provider when options.provider is not set. Defaults to 'openai'. */
  provider?: ThemeImageProvider;
  openaiApiKey?: string;
  geminiApiKey?: string;
  /**
   * Model override to use when options.model is not set. Empty/unset means
   * "use the latest recommended model" — see imageModels.ts for the
   * per-provider model lists and the default-resolution rule.
   */
  geminiModel?: string;
  openaiModel?: string;
  /**
   * OpenAI image `quality` override to use when options.quality is not set.
   * Empty/unset means "medium" — see imageModels.ts's IMAGE_QUALITY_OPTIONS.
   * OpenAI-only; Gemini has no equivalent parameter.
   */
  openaiImageQuality?: string;
}

export interface ThemeImageGenerationOptions {
  provider?: ThemeImageProvider;
  apiKey?: string;
  /**
   * Model id override, e.g. 'gemini-3-pro-image' or 'gpt-image-1-mini'. Takes
   * precedence over {@link ThemeImageConfig.geminiModel}/`openaiModel`. Empty/
   * unset falls back to the config-level override, then the latest
   * recommended model for the resolved provider — see imageModels.ts.
   */
  model?: string;
  /**
   * OpenAI image `quality` override ('low' | 'medium' | 'high'). Takes
   * precedence over {@link ThemeImageConfig.openaiImageQuality}. Empty/unset
   * falls back to the config-level override, then 'medium' — see
   * imageModels.ts's resolveImageQuality. OpenAI-only; the Gemini request
   * path ignores this entirely (Gemini has no `quality` parameter).
   */
  quality?: string;
  aspectRatio?: '1:1' | '3:4';
  /** Cancels the in-flight provider request when a theme generation is stopped. */
  signal?: AbortSignal;
  referenceImages?: Array<{
    data: Buffer;
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    filename: string;
  }>;
  /**
   * Override for the watchdog timeout (ms). Internal/test use only — leave
   * unset in production so the default {@link WATCHDOG_TIMEOUT_MS} applies.
   */
  watchdogMs?: number;
  /**
   * Request a native alpha-transparent background instead of an opaque one.
   * Only meaningful for {@link generateWithOpenAI} (gpt-image-1/2 supports
   * `background: "transparent"`); the Gemini path has no alpha equivalent and
   * ignores this flag, relying on the magenta chroma-key contract instead.
   * Callers should only set this for the magenta/transparent-keyed sprite-board
   * prompts — never for the opaque environment/scenery board.
   */
  transparentBackground?: boolean;
}

/**
 * Independent watchdog timeout for provider HTTP requests, in addition to
 * the caller-supplied AbortSignal (the user's Cancel button). Without this a
 * stalled upstream (dropped connection, provider hang) would leave the
 * request pending forever. Image generation is legitimately slow — large
 * multi-reference edits can take well over a minute — so this is
 * intentionally generous. Do not lower it.
 */
const WATCHDOG_TIMEOUT_MS = 180_000;

/**
 * Compose the caller's AbortSignal with an independent watchdog timer, since
 * `AbortSignal.any` requires Node 20+ and this extension host is bundled for
 * node18 (esbuild `--target=node18`). Returns a signal that aborts when
 * EITHER the caller signal aborts OR the timer expires, a `clear()` that
 * MUST be called on completion (success or failure) so the timer handle
 * never dangles, and `timedOut()` so callers can raise a clear timeout error
 * instead of a generic AbortError.
 */
function withWatchdog(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; clear: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let didTimeOut = false;
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = (): void => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener('abort', onCallerAbort);
    }
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
    timedOut: () => didTimeOut,
  };
}

/**
 * Generate a theme image using the configured AI image provider.
 * Uses the explicitly selected provider (options.provider) and falls back to
 * the caller-supplied {@link ThemeImageConfig} or environment variables for
 * backwards compatibility. Callers (the VS Code extension host via
 * vscode.secrets/settings, the standalone host via its own store) are
 * responsible for resolving secrets and passing them in — this function
 * never reads them itself.
 */
export async function generateThemeImage(
  prompt: string,
  options: ThemeImageGenerationOptions = {},
  config: ThemeImageConfig = {},
): Promise<Buffer> {
  const provider = options.provider ?? config.provider ?? 'openai';
  const apiKey = options.apiKey || (provider === 'openai'
    ? config.openaiApiKey || process.env.OPENAI_API_KEY
    : config.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

  if (!apiKey) {
    const label = provider === 'openai' ? 'OpenAI' : 'Google Gemini';
    throw new Error(`No ${label} API key found. Add one in Themes > Theme Builder.`);
  }

  const model = resolveImageModel(
    provider,
    options.model || (provider === 'gemini' ? config.geminiModel : config.openaiModel),
  );

  if (provider === 'openai') {
    const quality = resolveImageQuality(options.quality || config.openaiImageQuality);
    return generateWithOpenAI(prompt, apiKey, options, model, quality);
  }
  return generateWithImagen3(prompt, apiKey, options, model);
}

/**
 * Gemini ("Nano Banana") transcribes frame-label words from the prompt
 * (e.g. "CONTACT", "ready stance", "forward swing") directly onto the
 * generated sprite art as visible text. OpenAI GPT Image does not do this,
 * so this directive is appended ONLY to the prompt sent to Gemini — it must
 * never reach the shared `prompt` variable or the OpenAI request body.
 */
const GEMINI_NO_TEXT_DIRECTIVE =
  'CRITICAL OUTPUT RULE: Render ONLY the artwork. Do NOT draw any text, letters, words, numbers, labels, frame names, captions, annotations, callouts, titles, watermarks, or signage anywhere in the image, and do NOT place any text boxes, banners, or colored rectangles behind or beneath the art. The pose, animation, and frame names in the description above (for example words like CONTACT, PASSING, RECOVERY, ready stance, wind-up, forward swing, follow-through, walk cycle) are INSTRUCTIONS DESCRIBING WHAT TO DRAW — they must never appear as visible pixels. Every non-subject pixel must be flat solid #FF00FF magenta with nothing written on it.';

/**
 * Gemini ("Nano Banana") anti-aliases the boundary between the subject and
 * the flat magenta background, leaving faint dark fringe/contour pixels
 * around character outlines that survive magenta keying. OpenAI GPT Image
 * does not do this, so this directive is appended ONLY to the prompt sent
 * to Gemini — it must never reach the shared `prompt` variable or the
 * OpenAI request body.
 */
const GEMINI_EDGE_DIRECTIVE =
  'EDGE RULE: Use hard-edged pixel-art rendering. The boundary between any subject and the background must be a single crisp transition — each edge pixel is either fully subject-colored or fully flat #FF00FF magenta, with NO anti-aliasing, feathering, blur, gradient, glow, halo, drop shadow, or semi-transparent/dark contour pixels ringing the subject or its outline. Do NOT draw any soft dark fringe, outer glow, or shadow where the subject meets the magenta. The subject\'s own dark outline stroke is allowed, but it must have a hard edge directly against the flat magenta — never a blended or anti-aliased dark halo outside it. Every non-subject pixel is pure flat #FF00FF magenta.';

async function generateWithImagen3(
  prompt: string,
  apiKey: string,
  options: ThemeImageGenerationOptions,
  model: string,
): Promise<Buffer> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const geminiPrompt = `${prompt}\n\n${GEMINI_NO_TEXT_DIRECTIVE}\n\n${GEMINI_EDGE_DIRECTIVE}`;
  const body = {
    contents: [
      {
        parts: [
          { text: geminiPrompt },
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

  const timeoutMs = options.watchdogMs ?? WATCHDOG_TIMEOUT_MS;
  const watchdog = withWatchdog(options.signal, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: watchdog.signal,
      });
    } catch (err) {
      if (options.signal?.aborted) throw new Error('Generation cancelled by user');
      if (watchdog.timedOut()) {
        throw new Error(`Gemini Image request timed out after ${timeoutMs / 1000}s`);
      }
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
  } finally {
    watchdog.clear();
  }
}

async function generateWithOpenAI(
  prompt: string,
  apiKey: string,
  options: ThemeImageGenerationOptions,
  model: string,
  quality: string,
): Promise<Buffer> {
  const hasReferences = (options.referenceImages?.length ?? 0) > 0;
  const url = hasReferences
    ? 'https://api.openai.com/v1/images/edits'
    : 'https://api.openai.com/v1/images/generations';
  const size = options.aspectRatio === '3:4' ? '1024x1440' : '1024x1024';
  const body = {
    model,
    prompt,
    n: 1,
    size,
    quality,
    background: options.transparentBackground ? 'transparent' : 'opaque',
  };

  const timeoutMs = options.watchdogMs ?? WATCHDOG_TIMEOUT_MS;
  const watchdog = withWatchdog(options.signal, timeoutMs);
  try {
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
          signal: watchdog.signal,
        });
      } else {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: watchdog.signal,
        });
      }
    } catch (err) {
      if (options.signal?.aborted) throw new Error('Generation cancelled by user');
      if (watchdog.timedOut()) {
        throw new Error(`OpenAI GPT Image request timed out after ${timeoutMs / 1000}s`);
      }
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
  } finally {
    watchdog.clear();
  }
}
