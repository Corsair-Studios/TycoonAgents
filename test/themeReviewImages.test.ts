import { test } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';
import { recoverReviewImages } from '../src/extension/themeReviewImages';

async function dataUri(width: number, height: number, color: number): Promise<string> {
  const buffer = await new Jimp(width, height, color).getBufferAsync(Jimp.MIME_PNG);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

test('recoverReviewImages reassembles saved character frames into an atlas', async () => {
  const files = await recoverReviewImages({
    agent_0: [
      await dataUri(8, 6, 0xff0000ff),
      await dataUri(8, 6, 0x00ff00ff),
    ],
  });

  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'agent_0_recovered_atlas.png');
  const atlas = await Jimp.read(files[0].data);
  assert.equal(atlas.bitmap.width, 16);
  assert.equal(atlas.bitmap.height, 6);
});

test('recoverReviewImages preserves the environment as a standalone PNG', async () => {
  const files = await recoverReviewImages({
    environment_background: [await dataUri(12, 7, 0x123456ff)],
    invalid: ['not an image'],
  });

  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'environment_background.png');
  const environment = await Jimp.read(files[0].data);
  assert.equal(environment.bitmap.width, 12);
  assert.equal(environment.bitmap.height, 7);
});
