import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isModerationBlockedCode,
  isUserCorrectableImageGenerationError,
  parseOpenAIImageError,
} from '../src/extension/imageGenerationError';

test('OpenAI moderation failures retain structured recovery details', () => {
  const error = parseOpenAIImageError(400, JSON.stringify({
    error: {
      message: 'Your request was rejected by the safety system. Request ID body-request-id.',
      type: 'image_generation_user_error',
      code: 'moderation_blocked',
      moderation_details: {
        moderation_stage: 'input',
        categories: ['violence'],
      },
    },
  }), 'header-request-id');

  assert.equal(error.message, 'OpenAI blocked this image request. Revise the prompt or input images, then retry.');
  assert.equal(error.code, 'moderation_blocked');
  assert.equal(error.requestId, 'header-request-id');
  assert.deepEqual(error.moderationDetails, {
    moderation_stage: 'input',
    categories: ['violence'],
  });
  assert.equal(isUserCorrectableImageGenerationError(error), true);
  assert.equal(error.retryable, false);
});

test('OpenAI transient failures are retryable but not user-correctable', () => {
  const error = parseOpenAIImageError(503, 'temporarily unavailable');
  assert.equal(error.retryable, true);
  assert.equal(error.userCorrectable, false);
  assert.match(error.message, /temporarily unavailable/);
});

test('recognizes the legacy truncated moderation code spelling', () => {
  assert.equal(isModerationBlockedCode('moderation_block'), true);
});
