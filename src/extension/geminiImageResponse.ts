interface GeminiImagePart {
  text?: string;
  inlineData?: {
    data?: string;
    mimeType?: string;
  };
  // Accept the wire-format spelling too, in case a proxy does not normalize it.
  inline_data?: {
    data?: string;
    mime_type?: string;
  };
}

interface GeminiImageCandidate {
  content?: {
    parts?: GeminiImagePart[];
  };
  finishReason?: string;
}

interface GeminiImageResponse {
  candidates?: GeminiImageCandidate[];
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
  };
}

export interface GeminiInlineImage {
  data: string;
  mimeType?: string;
}

/** Find the first image across every candidate and part in a Gemini response. */
export function findGeminiInlineImage(response: unknown): GeminiInlineImage | undefined {
  const candidates = (response as GeminiImageResponse | undefined)?.candidates;
  if (!Array.isArray(candidates)) return undefined;

  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      const inlineData = part?.inlineData;
      if (typeof inlineData?.data === 'string' && inlineData.data.length > 0) {
        return { data: inlineData.data, mimeType: inlineData.mimeType };
      }

      const wireInlineData = part?.inline_data;
      if (typeof wireInlineData?.data === 'string' && wireInlineData.data.length > 0) {
        return { data: wireInlineData.data, mimeType: wireInlineData.mime_type };
      }
    }
  }

  return undefined;
}

/** Produce a short, non-secret diagnostic when Gemini returns no image. */
export function summarizeGeminiImageResponse(response: unknown): string {
  const envelope = response as GeminiImageResponse | undefined;
  const blockReason = envelope?.promptFeedback?.blockReason;
  const blockMessage = envelope?.promptFeedback?.blockReasonMessage;
  if (blockReason) {
    return `prompt blocked: ${blockReason}${blockMessage ? ` (${blockMessage})` : ''}`;
  }

  const candidates = envelope?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return 'no candidates';

  const finishReasons = candidates
    .map((candidate) => candidate?.finishReason)
    .filter((reason): reason is string => typeof reason === 'string' && reason.length > 0);
  const partCount = candidates.reduce(
    (total, candidate) => total + (Array.isArray(candidate?.content?.parts) ? candidate.content.parts.length : 0),
    0,
  );

  return `${candidates.length} candidate(s), ${partCount} part(s)` +
    (finishReasons.length > 0 ? `, finish reason(s): ${finishReasons.join(', ')}` : '');
}
