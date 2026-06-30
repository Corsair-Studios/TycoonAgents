export interface ImageModerationDetails {
  moderation_stage?: string;
  categories?: string[];
}

export interface ImageGenerationFailureDetails {
  provider: 'openai';
  status: number;
  type?: string;
  code?: string;
  requestId?: string;
  moderationDetails?: ImageModerationDetails;
  apiMessage?: string;
}

export class ImageGenerationApiError extends Error {
  readonly provider = 'openai' as const;
  readonly status: number;
  readonly type?: string;
  readonly code?: string;
  readonly requestId?: string;
  readonly moderationDetails?: ImageModerationDetails;
  readonly apiMessage?: string;
  readonly userCorrectable: boolean;
  readonly retryable: boolean;

  constructor(details: ImageGenerationFailureDetails) {
    const moderationBlocked = isModerationBlockedCode(details.code);
    const message = moderationBlocked
      ? 'OpenAI blocked this image request. Revise the prompt or input images, then retry.'
      : details.apiMessage
        ? `OpenAI GPT Image API error ${details.status}: ${details.apiMessage}`
        : `OpenAI GPT Image API error ${details.status}.`;
    super(message);
    this.name = 'ImageGenerationApiError';
    this.status = details.status;
    this.type = details.type;
    this.code = details.code;
    this.requestId = details.requestId;
    this.moderationDetails = details.moderationDetails;
    this.apiMessage = details.apiMessage;
    this.userCorrectable = details.type === 'image_generation_user_error' || moderationBlocked;
    this.retryable = details.status === 429 || details.status >= 500;
  }
}

export function parseOpenAIImageError(
  status: number,
  responseBody: string,
  responseRequestId?: string | null,
): ImageGenerationApiError {
  let error: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
    moderation_details?: unknown;
  } = {};
  try {
    const parsed = JSON.parse(responseBody) as { error?: typeof error };
    if (parsed?.error && typeof parsed.error === 'object') error = parsed.error;
  } catch {
    // Preserve a bounded plain-text response below when the body is not JSON.
  }

  const apiMessage = typeof error.message === 'string'
    ? error.message
    : responseBody.trim().slice(0, 1_000) || undefined;
  const requestId = responseRequestId || extractRequestId(apiMessage);
  return new ImageGenerationApiError({
    provider: 'openai',
    status,
    type: typeof error.type === 'string' ? error.type : undefined,
    code: typeof error.code === 'string' ? error.code : undefined,
    requestId: requestId || undefined,
    moderationDetails: parseModerationDetails(error.moderation_details),
    apiMessage,
  });
}

export function isUserCorrectableImageGenerationError(
  error: unknown,
): error is ImageGenerationApiError {
  return error instanceof ImageGenerationApiError && error.userCorrectable;
}

export function isModerationBlockedCode(code: string | undefined): boolean {
  return code === 'moderation_blocked' || code === 'moderation_block';
}

function extractRequestId(message: string | undefined): string | undefined {
  if (!message) return undefined;
  return /request ID\s+([a-z0-9-]+)/i.exec(message)?.[1];
}

function parseModerationDetails(value: unknown): ImageModerationDetails | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { moderation_stage?: unknown; categories?: unknown };
  const moderationStage = typeof raw.moderation_stage === 'string'
    ? raw.moderation_stage
    : undefined;
  const categories = Array.isArray(raw.categories)
    ? raw.categories.filter((category): category is string => typeof category === 'string')
    : undefined;
  if (!moderationStage && !categories?.length) return undefined;
  return { moderation_stage: moderationStage, categories };
}
