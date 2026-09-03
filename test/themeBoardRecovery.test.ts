import { test } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';
import { composeRecoveredBoardImages, recoveryBoardGridForKind } from '../src/extension/themeBoardRecovery';

async function dataUri(width: number, height: number, color: number): Promise<string> {
  const buffer = await new Jimp(width, height, color).getBufferAsync(Jimp.MIME_PNG);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

const MAGENTA = 0xff00ffff;

test('recoveryBoardGridForKind mirrors the fixed board grids and the variable rival grid', () => {
  assert.deepEqual(recoveryBoardGridForKind({ kind: 'character_atlas' }), { columns: 5, rows: 4 });
  assert.deepEqual(recoveryBoardGridForKind({ kind: 'object_atlas' }), { columns: 4, rows: 4 });
  assert.deepEqual(recoveryBoardGridForKind({ kind: 'background_decor_atlas' }), { columns: 4, rows: 4 });
  assert.deepEqual(recoveryBoardGridForKind({ kind: 'expression_atlas' }), { columns: 4, rows: 2 });
  assert.deepEqual(recoveryBoardGridForKind({ kind: 'achievement_atlas' }), { columns: 5, rows: 5 });
  assert.equal(recoveryBoardGridForKind({ kind: 'environment' }), undefined);
  assert.equal(recoveryBoardGridForKind({ kind: 'rival_atlas' }), undefined);
  assert.deepEqual(
    recoveryBoardGridForKind({ kind: 'rival_atlas', rival_rows: [{}, {}] }),
    { columns: 5, rows: 2 },
  );
});

test('composeRecoveredBoardImages composes a grid board on flat magenta with filled cells placed by slot', async () => {
  const files = await composeRecoveredBoardImages(
    [{
      kind: 'object_atlas',
      filename: 'objects_01.png',
      frame_keys: ['obj_a', 'obj_b', 'obj_c'],
    }],
    {
      obj_a: [await dataUri(128, 128, 0x00ff00ff)],
      obj_b: [await dataUri(128, 128, 0x0000ffff)],
      obj_c: [await dataUri(128, 128, 0xffff00ff)],
    },
  );

  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'objects_01.png');
  const board = await Jimp.read(files[0].data);
  // object_atlas grid is 4 columns x 4 rows of 128px cells.
  assert.equal(board.bitmap.width, 4 * 128);
  assert.equal(board.bitmap.height, 4 * 128);

  // Filled cells (slots 0-2) carry their frame's pixel color.
  assert.equal(board.getPixelColor(64, 64), 0x00ff00ff);
  assert.equal(board.getPixelColor(64 + 128, 64), 0x0000ffff);
  assert.equal(board.getPixelColor(64 + 256, 64), 0xffff00ff);

  // An unfilled cell (slot 3 onward) stays flat magenta.
  assert.equal(board.getPixelColor(64 + 384, 64), MAGENTA);
  assert.equal(board.getPixelColor(64, 64 + 128), MAGENTA);
});

test('composeRecoveredBoardImages skips a board with no stored frames for any of its keys', async () => {
  const files = await composeRecoveredBoardImages(
    [{ kind: 'object_atlas', filename: 'objects_01.png', frame_keys: ['obj_a'] }],
    {},
  );
  assert.equal(files.length, 0);
});

test('composeRecoveredBoardImages resizes a character board to the fixed 512x512 review canvas', async () => {
  const files = await composeRecoveredBoardImages(
    [{ kind: 'character_atlas', filename: 'agent_01_hero.png', frame_keys: ['agent_0'] }],
    { agent_0: [await dataUri(128, 128, 0x123456ff)] },
  );
  assert.equal(files.length, 1);
  const board = await Jimp.read(files[0].data);
  assert.equal(board.bitmap.width, 512);
  assert.equal(board.bitmap.height, 512);
});

test('composeRecoveredBoardImages decodes a single environment frame verbatim, without gridding', async () => {
  const files = await composeRecoveredBoardImages(
    [{ kind: 'environment', filename: 'environment.png', frame_keys: ['environment_background'] }],
    { environment_background: [await dataUri(37, 19, 0xabcdefff)] },
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'environment.png');
  const image = await Jimp.read(files[0].data);
  assert.equal(image.bitmap.width, 37);
  assert.equal(image.bitmap.height, 19);
});
