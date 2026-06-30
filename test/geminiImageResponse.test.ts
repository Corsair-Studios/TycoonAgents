import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findGeminiInlineImage,
  summarizeGeminiImageResponse,
} from '../src/extension/geminiImageResponse';

test('findGeminiInlineImage finds image data after a leading text part', () => {
  const response = {
    candidates: [{
      content: {
        parts: [
          { text: 'Here is the generated image.' },
          { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
        ],
      },
      finishReason: 'STOP',
    }],
  };

  assert.deepEqual(findGeminiInlineImage(response), {
    data: 'aW1hZ2U=',
    mimeType: 'image/png',
  });
});

test('findGeminiInlineImage searches all candidates and accepts wire-format inline_data', () => {
  const response = {
    candidates: [
      { content: { parts: [{ text: 'No image in this candidate.' }] } },
      { content: { parts: [{ inline_data: { mime_type: 'image/jpeg', data: 'anBlZw==' } }] } },
    ],
  };

  assert.deepEqual(findGeminiInlineImage(response), {
    data: 'anBlZw==',
    mimeType: 'image/jpeg',
  });
});

test('summarizeGeminiImageResponse reports useful no-image diagnostics', () => {
  assert.equal(
    summarizeGeminiImageResponse({
      candidates: [{ content: { parts: [{ text: 'Unable to generate.' }] }, finishReason: 'SAFETY' }],
    }),
    '1 candidate(s), 1 part(s), finish reason(s): SAFETY',
  );

  assert.equal(
    summarizeGeminiImageResponse({ promptFeedback: { blockReason: 'SAFETY' } }),
    'prompt blocked: SAFETY',
  );
});
