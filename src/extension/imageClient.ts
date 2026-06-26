/**
 * imageClient.ts — Zero-dependency image generation client.
 * Selects provider based on environment variables at call time.
 * Uses the global fetch available in Node 18+ (same pattern as translator.ts).
 */

/**
 * Generate a theme image using the configured AI image provider.
 * Checks GEMINI_API_KEY first, then OPENAI_API_KEY.
 * Throws if neither key is set or if the API call fails.
 */
export async function generateThemeImage(prompt: string): Promise<Buffer> {
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (geminiKey) {
    return generateWithImagen3(prompt, geminiKey);
  } else if (openaiKey) {
    return generateWithDallE3(prompt, openaiKey);
  } else {
    throw new Error('No image API key found. Set GEMINI_API_KEY or OPENAI_API_KEY.');
  }
}

async function generateWithImagen3(prompt: string, apiKey: string): Promise<Buffer> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${apiKey}`;
  const body = {
    instances: [{ prompt }],
    parameters: { sampleCount: 1, aspectRatio: '1:1' },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Imagen 3 network error: ${String(err)}`);
  }

  if (!response.ok) {
    let errBody = '';
    try {
      errBody = await response.text();
    } catch {
      // ignore
    }
    throw new Error(
      `Imagen 3 API error ${response.status}: ${errBody.slice(0, 300)}`,
    );
  }

  let json: unknown;
  let rawText = '';
  try {
    rawText = await response.text();
    json = JSON.parse(rawText);
  } catch {
    throw new Error(
      `Imagen 3: failed to parse JSON response. Body: ${rawText.slice(0, 300)}`,
    );
  }

  const predictions = (json as { predictions?: unknown[] }).predictions;
  if (!Array.isArray(predictions) || predictions.length === 0) {
    throw new Error('Imagen 3: no predictions in response.');
  }

  const pred = predictions[0] as Record<string, unknown>;
  // Defensive: try multiple field paths
  const b64 =
    (pred.bytesBase64Encoded as string | undefined) ??
    ((pred.image as Record<string, string> | undefined)?.imageBytes) ??
    (pred.bytesBase64Encoded as string | undefined);

  if (!b64) {
    throw new Error('Imagen 3: could not locate base64 image data in response.');
  }

  return Buffer.from(b64, 'base64');
}

async function generateWithDallE3(prompt: string, apiKey: string): Promise<Buffer> {
  const url = 'https://api.openai.com/v1/images/generations';
  const body = {
    model: 'dall-e-3',
    prompt,
    n: 1,
    size: '1024x1024',
    response_format: 'b64_json',
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`DALL·E 3 network error: ${String(err)}`);
  }

  if (!response.ok) {
    let errBody = '';
    try {
      errBody = await response.text();
    } catch {
      // ignore
    }
    throw new Error(
      `DALL·E 3 API error ${response.status}: ${errBody.slice(0, 300)}`,
    );
  }

  let json: unknown;
  let rawText = '';
  try {
    rawText = await response.text();
    json = JSON.parse(rawText);
  } catch {
    throw new Error(
      `DALL·E 3: failed to parse JSON response. Body: ${rawText.slice(0, 300)}`,
    );
  }

  const data = (json as { data?: Array<{ b64_json?: string }> }).data;
  if (!Array.isArray(data) || data.length === 0 || !data[0].b64_json) {
    throw new Error('DALL·E 3: no b64_json in response data.');
  }

  return Buffer.from(data[0].b64_json, 'base64');
}
