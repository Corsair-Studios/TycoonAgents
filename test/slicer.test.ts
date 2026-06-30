import { test } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';
import { sliceAndNormalizeAtlas } from '../src/extension/slicer';
import { CHARACTER_TARGET_CONTENT_HEIGHT } from '../src/extension/themeAssetPrompts';

test('slicer removes border-connected imperfect magenta but preserves enclosed magenta details', async () => {
  const cellWidth = 20;
  const cellHeight = 20;
  const atlas = new Jimp(cellWidth * 5, cellHeight * 4, 0xea10e8ff);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      const x = col * cellWidth;
      const y = row * cellHeight;
      atlas.scan(x + 6, y + 5, 8, 12, function (_px, _py, idx) {
        this.bitmap.data[idx] = 20;
        this.bitmap.data[idx + 1] = 20;
        this.bitmap.data[idx + 2] = 20;
        this.bitmap.data[idx + 3] = 255;
      });
      atlas.setPixelColor(0xea10e8ff, x + 9, y + 9);
    }
  }

  const result = await sliceAndNormalizeAtlas(
    await atlas.getBufferAsync(Jimp.MIME_PNG),
    {},
  );
  const first = await Jimp.read(Buffer.from(result.slots[0].data.split(',')[1], 'base64'));
  let opaqueMagenta = 0;
  let transparent = 0;
  first.scan(0, 0, first.bitmap.width, first.bitmap.height, function (_x, _y, idx) {
    const r = this.bitmap.data[idx];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    const a = this.bitmap.data[idx + 3];
    if (a === 0) transparent++;
    if (a === 255 && r === 0xea && g === 0x10 && b === 0xe8) opaqueMagenta++;
  });
  assert.ok(transparent > 0);
  assert.equal(opaqueMagenta, 1);
});

test('slicer supports the 4x3 object board contract', async () => {
  const atlas = new Jimp(80, 60, 0xff00ffff);
  const result = await sliceAndNormalizeAtlas(
    await atlas.getBufferAsync(Jimp.MIME_PNG),
    {},
    { columns: 4, rows: 3 },
  );
  assert.equal(result.slots.length, 12);
  assert.equal(result.slots[11].slot_id, 11);
});

test('slicer removes minor sprite fragments that spill across a row boundary', async () => {
  const cellSize = 20;
  const atlas = new Jimp(cellSize * 5, cellSize * 4, 0xff00ffff);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      const cellX = col * cellSize;
      const cellY = row * cellSize;
      atlas.scan(cellX + 7, cellY + 7, 6, 11, function (_x, _y, idx) {
        this.bitmap.data.writeUInt32BE(0x1950a0ff, idx);
      });
    }
  }

  // The first sprite touches its cell bottom and leaves a disconnected boot
  // fragment across the boundary in slot 5.
  atlas.scan(7, 18, 3, 2, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(0xc82828ff, idx);
  });
  atlas.scan(7, cellSize, 3, 3, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(0xc82828ff, idx);
  });

  const result = await sliceAndNormalizeAtlas(await atlas.getBufferAsync(Jimp.MIME_PNG), {});
  const secondRowCell = await Jimp.read(Buffer.from(result.slots[5].data.split(',')[1], 'base64'));
  let redPixels = 0;
  let bluePixels = 0;
  secondRowCell.scan(0, 0, 128, 128, function (_x, _y, idx) {
    const color = this.bitmap.data.readUInt32BE(idx);
    if (color === 0xc82828ff) redPixels++;
    if (color === 0x1950a0ff) bluePixels++;
  });
  assert.equal(redPixels, 0);
  assert.ok(bluePixels > 0);
});

test('slicer preserves a primary sprite that reaches a cell top', async () => {
  const cellSize = 20;
  const atlas = new Jimp(cellSize * 5, cellSize * 4, 0xff00ffff);
  atlas.scan(7, 17, 6, 3, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(0x1950a0ff, idx);
  });
  atlas.scan(7, cellSize, 6, 12, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(0xc82828ff, idx);
  });

  const result = await sliceAndNormalizeAtlas(await atlas.getBufferAsync(Jimp.MIME_PNG), {});
  const secondRowCell = await Jimp.read(Buffer.from(result.slots[5].data.split(',')[1], 'base64'));
  let opaquePixels = 0;
  secondRowCell.scan(0, 0, 128, 128, function (_x, _y, idx) {
    if (this.bitmap.data[idx + 3] !== 0) opaquePixels++;
  });
  assert.ok(opaquePixels > 0);
});

test('character board normalization makes differently framed boards the same standing height', async () => {
  const makeAtlas = async (spriteWidth: number, spriteHeight: number) => {
    const cellSize = 64;
    const atlas = new Jimp(cellSize * 5, cellSize * 4, 0xff00ffff);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 5; col++) {
        const left = col * cellSize + Math.floor((cellSize - spriteWidth) / 2);
        const top = row * cellSize + cellSize - spriteHeight;
        atlas.scan(left, top, spriteWidth, spriteHeight, function (_x, _y, idx) {
          this.bitmap.data[idx] = 25;
          this.bitmap.data[idx + 1] = 80;
          this.bitmap.data[idx + 2] = 160;
          this.bitmap.data[idx + 3] = 255;
        });
      }
    }
    return atlas.getBufferAsync(Jimp.MIME_PNG);
  };
  const grid = {
    columns: 5,
    rows: 4,
    scaleReferenceSlots: [0, 1, 2, 3, 4, 16],
    targetContentHeight: CHARACTER_TARGET_CONTENT_HEIGHT,
    maxContentExtent: 120,
    rebuildBoard: true,
  };
  const [smallBoard, largeBoard] = await Promise.all([
    sliceAndNormalizeAtlas(await makeAtlas(18, 30), {}, grid),
    sliceAndNormalizeAtlas(await makeAtlas(30, 48), {}, grid),
  ]);
  const opaqueHeight = async (dataUri: string) => {
    const image = await Jimp.read(Buffer.from(dataUri.split(',')[1], 'base64'));
    let minY = Infinity;
    let maxY = -1;
    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (_x, y, idx) {
      if (this.bitmap.data[idx + 3] !== 0) {
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    });
    return maxY - minY + 1;
  };

  assert.equal(await opaqueHeight(smallBoard.slots[0].data), CHARACTER_TARGET_CONTENT_HEIGHT);
  assert.equal(await opaqueHeight(largeBoard.slots[0].data), CHARACTER_TARGET_CONTENT_HEIGHT);
  const rebuilt = await Jimp.read(smallBoard.board!);
  assert.equal(rebuilt.bitmap.width, 640);
  assert.equal(rebuilt.bitmap.height, 512);
});

test('character review board can remain square around a 5x4 grid', async () => {
  const atlas = new Jimp(500, 500, 0xff00ffff);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      atlas.scan(col * 100 + 40, row * 125 + 35, 20, 70, function (_x, _y, idx) {
        this.bitmap.data.writeUInt32BE(0x1950a0ff, idx);
      });
    }
  }

  const result = await sliceAndNormalizeAtlas(
    await atlas.getBufferAsync(Jimp.MIME_PNG),
    {},
    { columns: 5, rows: 4, rebuildBoard: true, squareReviewBoard: true },
  );
  const rebuilt = await Jimp.read(result.board!);
  assert.equal(rebuilt.bitmap.width, 640);
  assert.equal(rebuilt.bitmap.height, 640);

  // The 128px normalized frame is centered within each 160px-tall review cell.
  assert.equal(rebuilt.getPixelColor(64, 0), 0xff00ffff);
  assert.equal(rebuilt.getPixelColor(64, 159), 0xff00ffff);
});
