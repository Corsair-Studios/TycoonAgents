import { test } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';
import { sliceAndNormalizeAtlas, detectOuterFrame, findBestHorizontalShift } from '../src/extension/slicer';
import { CHARACTER_TARGET_CONTENT_HEIGHT } from '../src/extension/themeAssetPrompts';

// The slicer's own magenta chroma-key test, mirrored here so detectOuterFrame
// tests exercise the exact background predicate the production call passes in.
const isChromaMagentaBg = (r: number, g: number, b: number): boolean =>
  r >= 180 && b >= 180 && g <= 90 && r - g >= 120 && b - g >= 120 && Math.abs(r - b) <= 80;

test('slicer removes all chroma magenta including enclosed regions surrounded by the sprite', async () => {
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
  // 0xea10e8 passes the strict isChromaMagenta test (r=234, g=16, b=232), so the
  // global removal pass clears even the pixel fully enclosed by the dark sprite.
  assert.equal(opaqueMagenta, 0);
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

test('slicer covers all pixels in a 512px-tall 4x5 logical grid', async () => {
  const atlas = new Jimp(512, 512, 0xff00ffff);
  atlas.setPixelColor(0x1950a0ff, 500, 511);
  const result = await sliceAndNormalizeAtlas(
    await atlas.getBufferAsync(Jimp.MIME_PNG),
    {},
    { columns: 4, rows: 5 },
  );
  assert.equal(result.slots.length, 20);
  assert.ok(result.slots[19].meta.opaqueCount > 0);
});

test('grouped normalization keeps a stationary object body anchored across moving parts', async () => {
  const cellSize = 100;
  const atlas = new Jimp(cellSize * 4, cellSize * 5, 0xff00ffff);
  for (let column = 0; column < 4; column++) {
    const cellX = column * cellSize;
    atlas.scan(cellX + 40, 55, 20, 35, function (_x, _y, idx) {
      this.bitmap.data.writeUInt32BE(0x1950a0ff, idx);
    });
    const appendageX = [20, 30, 60, 70][column];
    atlas.scan(cellX + appendageX, 45, 10, 8, function (_x, _y, idx) {
      this.bitmap.data.writeUInt32BE(0xc82828ff, idx);
    });
  }
  const result = await sliceAndNormalizeAtlas(
    await atlas.getBufferAsync(Jimp.MIME_PNG),
    {},
    { columns: 4, rows: 5, normalizationGroups: [[0, 1, 2, 3]] },
  );
  const bodyLeftEdges: number[] = [];
  for (const slot of result.slots.slice(0, 4)) {
    const frame = await Jimp.read(Buffer.from(slot.data.split(',')[1], 'base64'));
    let minBlueX = Infinity;
    frame.scan(0, 0, 128, 128, function (x, _y, idx) {
      if (this.bitmap.data.readUInt32BE(idx) === 0x1950a0ff) minBlueX = Math.min(minBlueX, x);
    });
    bodyLeftEdges.push(minBlueX);
  }
  assert.deepEqual(bodyLeftEdges, [54, 54, 54, 54]);
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

test('slicer produces identical frames for a transparent-background atlas and its magenta twin', async () => {
  // OpenAI's native `background: "transparent"` output has no magenta chroma
  // key at all — every unused pixel is already alpha 0. The chroma-key step
  // must no-op harmlessly on that input, and content-bbox/normalization/spill
  // removal (all alpha-driven already) must produce the exact same frames as
  // the legacy magenta-keyed board with identical sprite content.
  const cellSize = 20;
  const buildAtlas = (backgroundColor: number) => {
    const atlas = new Jimp(cellSize * 5, cellSize * 4, backgroundColor);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 5; col++) {
        const x = col * cellSize;
        const y = row * cellSize;
        atlas.scan(x + 6, y + 5, 8, 12, function (_px, _py, idx) {
          this.bitmap.data[idx] = 25;
          this.bitmap.data[idx + 1] = 80;
          this.bitmap.data[idx + 2] = 160;
          this.bitmap.data[idx + 3] = 255;
        });
      }
    }
    return atlas.getBufferAsync(Jimp.MIME_PNG);
  };

  const [magentaResult, transparentResult] = await Promise.all([
    sliceAndNormalizeAtlas(await buildAtlas(0xff00ffff), {}),
    sliceAndNormalizeAtlas(await buildAtlas(0x00000000), {}),
  ]);

  assert.equal(transparentResult.slots.length, magentaResult.slots.length);
  for (let i = 0; i < magentaResult.slots.length; i++) {
    assert.equal(transparentResult.slots[i].data, magentaResult.slots[i].data, `slot ${i} should match its magenta twin byte-for-byte`);
    assert.deepEqual(transparentResult.slots[i].meta, magentaResult.slots[i].meta);
  }
});

test('rival board (5 uneven columns) does not overflow the source buffer when grouped', async () => {
  // 512 / 5 columns does not divide evenly, so proportional slicing produces
  // column widths of 102, 102, 103, 102, 103. Row-wide normalizationGroups (as
  // used by the rival board) union minX/maxX/minY/maxY across all five cells in
  // a row. A pixel at the atlas's rightmost edge lands at local index 102 inside
  // a 103-wide column, but a 102-wide column in the same group only has valid
  // local indices 0-101 - applying the group's unioned bounds directly as a crop
  // rectangle previously read one column (4 bytes) past that narrower cell's own
  // bitmap and threw a Buffer offset-out-of-range error.
  const atlas = new Jimp(512, 512, 0xff00ffff);
  for (let row = 0; row < 4; row++) {
    const y = row * 128 + 10;
    atlas.setPixelColor(0x1950a0ff, 0, y);
    atlas.setPixelColor(0xc82828ff, 511, y);
  }
  const rowGroups = Array.from({ length: 4 }, (_row, rowIndex) =>
    Array.from({ length: 5 }, (_col, colIndex) => rowIndex * 5 + colIndex),
  );

  const result = await sliceAndNormalizeAtlas(
    await atlas.getBufferAsync(Jimp.MIME_PNG),
    {},
    {
      columns: 5,
      rows: 4,
      scaleReferenceSlots: Array.from({ length: 20 }, (_unused, cell) => cell),
      maxContentExtent: 120,
      normalizationGroups: rowGroups,
    },
  );
  assert.equal(result.slots.length, 20);
  assert.ok(result.slots[0].meta.opaqueCount > 0);
  assert.ok(result.slots[4].meta.opaqueCount > 0);
});

test('despill desaturates a magenta-tinted fringe over a black outline instead of deleting it', async () => {
  // Simulates the reported bug: the image model anti-aliases a subject's black
  // outline into the #FF00FF backdrop, leaving a thin, low-luminance
  // magenta-tinted rim that survives the existing chroma-key and erase-based
  // de-fringe passes because it is too dark to read as "magenta-dominant".
  const cellWidth = 20;
  const cellHeight = 20;
  const atlas = new Jimp(cellWidth * 5, cellHeight * 4, 0xff00ffff);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      const x = col * cellWidth;
      const y = row * cellHeight;
      // A 1px dim magenta-tinted "fringe" ring around a solid black outline.
      atlas.scan(x + 5, y + 4, 10, 14, function (_px, _py, idx) {
        this.bitmap.data[idx] = 70;
        this.bitmap.data[idx + 1] = 20;
        this.bitmap.data[idx + 2] = 70;
        this.bitmap.data[idx + 3] = 255;
      });
      atlas.scan(x + 6, y + 5, 8, 12, function (_px, _py, idx) {
        this.bitmap.data[idx] = 20;
        this.bitmap.data[idx + 1] = 20;
        this.bitmap.data[idx + 2] = 20;
        this.bitmap.data[idx + 3] = 255;
      });
      // One extreme, still low-luminance spill pixel on the ring to exercise the
      // despill pass's "extreme spill -> fully transparent" branch too.
      // 0x690469ff = rgb(105, 4, 105) at full alpha.
      atlas.setPixelColor(0x690469ff, x + 9, y + 4);
    }
  }

  const result = await sliceAndNormalizeAtlas(
    await atlas.getBufferAsync(Jimp.MIME_PNG),
    {},
  );
  const first = await Jimp.read(Buffer.from(result.slots[0].data.split(',')[1], 'base64'));

  let fringedPixels = 0;
  let blackOutlinePixels = 0;
  first.scan(0, 0, first.bitmap.width, first.bitmap.height, function (_x, _y, idx) {
    const r = this.bitmap.data[idx];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    const a = this.bitmap.data[idx + 3];
    if (a === 0) return;
    if (r > g + 40 && b > g + 40) fringedPixels++;
    if (r === 20 && g === 20 && b === 20) blackOutlinePixels++;
  });

  // No pixel in the final sprite still reads as magenta-fringed...
  assert.equal(fringedPixels, 0);
  // ...and despill clamped color rather than deleting pixels, so the black
  // outline silhouette survives intact rather than being thinned away.
  assert.ok(blackOutlinePixels > 0);
});

test('despill leaves a legitimately purple interior region untouched', async () => {
  // A purple/pink region deep inside the sprite (far from any cut edge) must
  // never be mistaken for magenta spill, even though it satisfies the same
  // red/blue-over-green channel test the despill pass uses at edges.
  const cellWidth = 20;
  const cellHeight = 20;
  const atlas = new Jimp(cellWidth * 5, cellHeight * 4, 0xff00ffff);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      const x = col * cellWidth;
      const y = row * cellHeight;
      // A large solid black block, comfortably clear of the cell's magenta
      // background on all sides.
      atlas.scan(x + 3, y + 3, 14, 14, function (_px, _py, idx) {
        this.bitmap.data[idx] = 20;
        this.bitmap.data[idx + 1] = 20;
        this.bitmap.data[idx + 2] = 20;
        this.bitmap.data[idx + 3] = 255;
      });
      // A 2x2 purple interior patch at the block's center, 6+ px from any
      // transparent pixel — well outside the despill pass's edge radius.
      atlas.scan(x + 9, y + 9, 2, 2, function (_px, _py, idx) {
        this.bitmap.data[idx] = 150;
        this.bitmap.data[idx + 1] = 50;
        this.bitmap.data[idx + 2] = 180;
        this.bitmap.data[idx + 3] = 255;
      });
    }
  }

  const result = await sliceAndNormalizeAtlas(
    await atlas.getBufferAsync(Jimp.MIME_PNG),
    {},
  );
  const first = await Jimp.read(Buffer.from(result.slots[0].data.split(',')[1], 'base64'));

  let purplePixels = 0;
  first.scan(0, 0, first.bitmap.width, first.bitmap.height, function (_x, _y, idx) {
    const r = this.bitmap.data[idx];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    const a = this.bitmap.data[idx + 3];
    if (a === 255 && r === 150 && g === 50 && b === 180) purplePixels++;
  });

  // The interior purple patch (4 source pixels) survives byte-for-byte.
  assert.equal(purplePixels, 4);
});

test('row-overflow reclamation moves a spilled base into the upper cell, keeping the complete tapered subject', async () => {
  // A 100px cell, so the ~20% reclaim window covers 20px below the boundary.
  const cellSize = 100;
  const atlas = new Jimp(cellSize * 2, cellSize * 2, 0xff00ffff);
  const BLUE = 0x1950a0ff;
  const RED = 0xc82828ff;

  // The subject's torso (slot 0, row0/col0): solid, touching the cell's own
  // bottom row (y=99) — this is what would previously produce a flat-cut base.
  atlas.scan(30, 10, 40, 90, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(BLUE, idx);
  });
  // The subject's tapering base actually drawn by the model 15 rows into the
  // cell below (slot 2, row1/col0), connected to the torso across the
  // boundary and narrowing row by row (never a flat cut).
  for (let y = 0; y < 15; y++) {
    atlas.scan(30 + y, cellSize + y, 40 - 2 * y, 1, function (_x, _y2, idx) {
      this.bitmap.data.writeUInt32BE(BLUE, idx);
    });
  }
  // The lower cell's own unrelated subject, well below the reclaim window and
  // spatially separate from the base, so it must be left untouched.
  atlas.scan(70, cellSize + 50, 20, 40, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(RED, idx);
  });

  const result = await sliceAndNormalizeAtlas(
    await atlas.getBufferAsync(Jimp.MIME_PNG),
    {},
    { columns: 2, rows: 2 },
  );

  const torsoFrame = await Jimp.read(Buffer.from(result.slots[0].data.split(',')[1], 'base64'));
  let minY = Infinity;
  let maxY = -1;
  const rowWidth = new Map<number, number>();
  torsoFrame.scan(0, 0, 128, 128, function (_x, y, idx) {
    if (this.bitmap.data[idx + 3] === 0) return;
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    rowWidth.set(y, (rowWidth.get(y) ?? 0) + 1);
  });

  // The reclaimed base extends the sliced content by the full drawn height
  // (90-row torso + 15-row base), rather than being flat-cut at the boundary.
  assert.equal(maxY - minY + 1, 105);
  const topRowWidth = rowWidth.get(minY)!;
  const bottomRowWidth = rowWidth.get(maxY)!;
  assert.equal(topRowWidth, 40);
  // The bottom row is the narrow end of the taper (12px), not a flat 40px cut.
  assert.equal(bottomRowWidth, 12);
  assert.ok(bottomRowWidth < topRowWidth);
});

test('row-overflow reclamation leaves the lower cell\'s own subject untouched', async () => {
  const cellSize = 100;
  const atlas = new Jimp(cellSize * 2, cellSize * 2, 0xff00ffff);
  const BLUE = 0x1950a0ff;
  const RED = 0xc82828ff;

  atlas.scan(30, 10, 40, 90, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(BLUE, idx);
  });
  for (let y = 0; y < 15; y++) {
    atlas.scan(30 + y, cellSize + y, 40 - 2 * y, 1, function (_x, _y2, idx) {
      this.bitmap.data.writeUInt32BE(BLUE, idx);
    });
  }
  // The lower cell's own subject: 20 x 40 = 800px, far from the boundary.
  atlas.scan(70, cellSize + 50, 20, 40, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(RED, idx);
  });

  const result = await sliceAndNormalizeAtlas(
    await atlas.getBufferAsync(Jimp.MIME_PNG),
    {},
    { columns: 2, rows: 2 },
  );

  const lowerFrame = await Jimp.read(Buffer.from(result.slots[2].data.split(',')[1], 'base64'));
  let redPixels = 0;
  let bluePixels = 0;
  lowerFrame.scan(0, 0, 128, 128, function (_x, _y, idx) {
    const color = this.bitmap.data.readUInt32BE(idx);
    if (color === RED) redPixels++;
    if (color === BLUE) bluePixels++;
  });

  // Its own 800px subject survives with none of the reclaimed base's pixels.
  assert.equal(redPixels, 800);
  assert.equal(bluePixels, 0);
});

test('row-overflow reclamation does not affect a board with no boundary-touching content (regression guard)', async () => {
  const cellSize = 100;
  const buildAtlas = async (lowerCellHasUnrelatedContent: boolean) => {
    const atlas = new Jimp(cellSize * 2, cellSize * 2, 0xff00ffff);
    // Well clear of the row boundary (stops 20px short of the cell bottom).
    atlas.scan(30, 10, 40, 70, function (_x, _y, idx) {
      this.bitmap.data.writeUInt32BE(0x1950a0ff, idx);
    });
    if (lowerCellHasUnrelatedContent) {
      atlas.scan(10, cellSize + 50, 10, 10, function (_x, _y, idx) {
        this.bitmap.data.writeUInt32BE(0xc82828ff, idx);
      });
    }
    return atlas.getBufferAsync(Jimp.MIME_PNG);
  };

  const [withoutLowerContent, withLowerContent] = await Promise.all([
    sliceAndNormalizeAtlas(await buildAtlas(false), {}, { columns: 2, rows: 2 }),
    sliceAndNormalizeAtlas(await buildAtlas(true), {}, { columns: 2, rows: 2 }),
  ]);

  // Content that never touches the row boundary is untouched by reclamation
  // regardless of what exists in the cell below — byte-identical to the
  // pre-reclamation slice of the same upper-cell content.
  assert.equal(withoutLowerContent.slots[0].data, withLowerContent.slots[0].data);
  assert.deepEqual(withoutLowerContent.slots[0].meta, withLowerContent.slots[0].meta);
});

test('row-overflow reclamation only claims pixels connected to the upper subject when two subjects touch the same strip', async () => {
  const cellSize = 100;
  const atlas = new Jimp(cellSize * 2, cellSize * 2, 0xff00ffff);
  const BLUE = 0x1950a0ff;
  const GREEN = 0x2ecc40ff;

  // Upper cell (slot 0): a body plus a narrow leg that touches the cell's
  // bottom row only at x=20..29.
  atlas.scan(20, 10, 50, 70, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(BLUE, idx);
  });
  atlas.scan(20, 80, 10, 20, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(BLUE, idx);
  });

  // Lower cell (slot 2) top strip: Blob A continues the leg (connected,
  // x=20..29) and Blob B is an unrelated subject also touching the top of
  // the strip (x=70..89) but with no adjacency to the upper cell's content.
  atlas.scan(20, cellSize, 10, 10, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(BLUE, idx);
  });
  atlas.scan(70, cellSize, 20, 10, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(GREEN, idx);
  });

  const result = await sliceAndNormalizeAtlas(
    await atlas.getBufferAsync(Jimp.MIME_PNG),
    {},
    { columns: 2, rows: 2 },
  );

  const lowerFrame = await Jimp.read(Buffer.from(result.slots[2].data.split(',')[1], 'base64'));
  let bluePixels = 0;
  let greenPixels = 0;
  lowerFrame.scan(0, 0, 128, 128, function (_x, _y, idx) {
    const color = this.bitmap.data.readUInt32BE(idx);
    if (color === BLUE) bluePixels++;
    if (color === GREEN) greenPixels++;
  });

  // Blob A (100px, connected to the leg) is reclaimed into the upper cell;
  // Blob B (200px, unconnected) is left exactly as drawn in the lower cell.
  assert.equal(bluePixels, 0);
  assert.equal(greenPixels, 200);
});

// Shared measurables for the feet-anchor cases below. A single 1x1 cell keeps
// the row/column boundary-spill passes out of the picture (they only run for
// row>0 / col>0), and with no targetContentHeight/maxContentExtent the board
// scale is exactly 1, so the sliced content is bottom-justified WITHOUT any
// resize — output pixel rows map to source rows exactly (destY = 128 - bh).
const FEET_BLUE = 0x1950a0ff; // dense body block
const FEET_RED = 0xc82828ff; // thin below-feet drag (a cape tip)

async function measureFeetFrame(dataUri: string): Promise<{ blueMaxY: number; redCount: number; footY: number }> {
  const frame = await Jimp.read(Buffer.from(dataUri.split(',')[1], 'base64'));
  let blueMaxY = -1;
  let redCount = 0;
  let footY = -1;
  frame.scan(0, 0, 128, 128, function (_x, y, idx) {
    const color = this.bitmap.data.readUInt32BE(idx);
    if (this.bitmap.data[idx + 3] !== 0) footY = Math.max(footY, y);
    if (color === FEET_BLUE) blueMaxY = Math.max(blueMaxY, y);
    if (color === FEET_RED) redCount++;
  });
  return { blueMaxY, redCount, footY };
}

test('feetAnchorMinWidthRatio bottom-justifies to the body feet, trimming a thin below-feet cape', async () => {
  // A 100x100 cell: a dense 40px-wide body (rows 10..69) with a thin 4px-wide
  // tail (rows 70..79) dragging straight down from it — a simulated cape tip.
  const atlas = new Jimp(100, 100, 0xff00ffff);
  atlas.scan(40, 10, 40, 60, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(FEET_BLUE, idx);
  });
  atlas.scan(58, 70, 4, 10, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(FEET_RED, idx);
  });
  const buffer = await atlas.getBufferAsync(Jimp.MIME_PNG);

  const [without, withAnchor] = await Promise.all([
    sliceAndNormalizeAtlas(buffer, {}, { columns: 1, rows: 1 }),
    sliceAndNormalizeAtlas(buffer, {}, { columns: 1, rows: 1, feetAnchorMinWidthRatio: 0.2 }),
  ]);

  const noField = await measureFeetFrame(without.slots[0].data);
  const anchored = await measureFeetFrame(withAnchor.slots[0].data);

  // Without the field the whole bbox (body + tail) is bottom-justified, so the
  // TAIL sits on the frame floor and the body's feet float 10px above it.
  assert.equal(noField.footY, 127);
  assert.equal(noField.blueMaxY, 117);
  assert.equal(noField.redCount, 40); // 4px x 10 rows of tail survive

  // With the field the below-feet tail is trimmed off the bbox bottom, so the
  // BODY's feet are what bottom-justify to the frame floor, and the tail is gone.
  assert.equal(anchored.blueMaxY, 127);
  assert.equal(anchored.redCount, 0);
  // Concrete anchor shift: the body feet dropped a full 10px onto the floor.
  assert.equal(anchored.blueMaxY - noField.blueMaxY, 10);
});

test('feetAnchorMinWidthRatio survives horizontal registration re-scan (register->recompute ordering)', async () => {
  // Regression for the ordering bug: the feet-anchor trim used to run during the
  // per-cell scan, but registerGroupHorizontally runs AFTER it and re-scans every
  // shifted member via recomputeCellBounds — which OVERWROTE the trimmed maxY back
  // to the cape-inclusive bottom. The 1x1 feet tests never triggered registration,
  // so they missed it. Here two cells form ONE registration+normalization group,
  // each drawing the SAME body+tail but at DIFFERENT horizontal offsets so
  // registration WILL shift the second member (dx !== 0) and fire recomputeCellBounds.
  const cellSize = 100;
  const atlas = new Jimp(cellSize * 2, cellSize, 0xff00ffff);

  // Slot 0 (reference): dense 40px body (rows 10..69) + a thin 4px tail (rows 70..79).
  atlas.scan(30, 10, 40, 60, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(FEET_BLUE, idx);
  });
  atlas.scan(48, 70, 4, 10, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(FEET_RED, idx);
  });

  // Slot 1 (col 1): the identical body+tail shifted +12px right within its cell —
  // the drawn drift registration must cancel. 12 < REGISTRATION_MAX_SHIFT(16), so
  // it registers cleanly to dx=-12 rather than clamping.
  atlas.scan(cellSize + 42, 10, 40, 60, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(FEET_BLUE, idx);
  });
  atlas.scan(cellSize + 60, 70, 4, 10, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(FEET_RED, idx);
  });

  const result = await sliceAndNormalizeAtlas(await atlas.getBufferAsync(Jimp.MIME_PNG), {}, {
    columns: 2,
    rows: 1,
    normalizationGroups: [[0, 1]],
    registrationGroups: [[0, 1]],
    feetAnchorMinWidthRatio: 0.2,
  });

  // Registration cancelled the 12px drift, so both frames share one content left edge —
  // proof the register->recompute path actually fired on slot 1.
  assert.equal(result.slots[0].meta.left, result.slots[1].meta.left);

  // Feet-anchor STILL applied after registration: the shared (grouped) union bbox
  // anchored to the BODY's feet, so both frames put the body's feet on the floor and
  // the below-feet tail is gone. On the old ordering recomputeCellBounds reverted the
  // shifted cell's maxY to the cape tip, unioning the tail back in — the body would
  // float at y=117 and 40 tail pixels would survive in each frame.
  for (const slot of result.slots) {
    const anchored = await measureFeetFrame(slot.data);
    assert.equal(anchored.blueMaxY, 127);
    assert.equal(anchored.redCount, 0);
  }
});

test('feetAnchorMinWidthRatio is a no-op when nothing thin trails below the feet', async () => {
  // Just the dense body block — its lowest row is as dense as the densest row,
  // so the feet line never moves and the slice must be byte-identical with vs
  // without the field.
  const atlas = new Jimp(100, 100, 0xff00ffff);
  atlas.scan(40, 10, 40, 60, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(FEET_BLUE, idx);
  });
  const buffer = await atlas.getBufferAsync(Jimp.MIME_PNG);

  const [without, withAnchor] = await Promise.all([
    sliceAndNormalizeAtlas(buffer, {}, { columns: 1, rows: 1 }),
    sliceAndNormalizeAtlas(buffer, {}, { columns: 1, rows: 1, feetAnchorMinWidthRatio: 0.2 }),
  ]);

  assert.equal(withAnchor.slots[0].data, without.slots[0].data);
  assert.deepEqual(withAnchor.slots[0].meta, without.slots[0].meta);
});

test('feetAnchorMinWidthRatio keeps the original bottom when the trim would exceed 25% of the bbox height (safety fallback)', async () => {
  // Body 40 rows (10..49) plus a thin 30-row tail (50..79). Trimming to the
  // first dense row would remove 30 of the 70px bbox height (>25%), which the
  // safety guard rejects — so the output must stay identical to the no-field
  // slice rather than gutting the (legitimately) narrow-bottomed content.
  const atlas = new Jimp(100, 100, 0xff00ffff);
  atlas.scan(40, 10, 40, 40, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(FEET_BLUE, idx);
  });
  atlas.scan(58, 50, 4, 30, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(FEET_RED, idx);
  });
  const buffer = await atlas.getBufferAsync(Jimp.MIME_PNG);

  const [without, withAnchor] = await Promise.all([
    sliceAndNormalizeAtlas(buffer, {}, { columns: 1, rows: 1 }),
    sliceAndNormalizeAtlas(buffer, {}, { columns: 1, rows: 1, feetAnchorMinWidthRatio: 0.2 }),
  ]);

  // Safety fallback engaged: the tail is retained and the frame is unchanged.
  assert.equal(withAnchor.slots[0].data, without.slots[0].data);
  assert.deepEqual(withAnchor.slots[0].meta, without.slots[0].meta);
  const anchored = await measureFeetFrame(withAnchor.slots[0].data);
  assert.ok(anchored.redCount > 0, 'the tail must be retained under the safety fallback');
});

// --- Outer-frame trim -------------------------------------------------------

const OF_BLACK = 0x000000ff;
const OF_MAGENTA = 0xff00ffff;
const OF_BLUE = 0x1950a0ff; // sprite in cell (0,0)
const OF_RED = 0xc82828ff;  // sprites in every other cell

// Draws a 200x160 magenta interior with a distinguishable centered sprite block
// per 5x4 grid cell, at (offsetX, offsetY) within `atlas`. Cell (0,0) is blue,
// the rest red, so trimmed slices can be checked for grid alignment.
function drawFramedInterior(atlas: Jimp, offsetX: number, offsetY: number): void {
  const cell = 40;
  atlas.scan(offsetX, offsetY, cell * 5, cell * 4, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(OF_MAGENTA, idx);
  });
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      const color = row === 0 && col === 0 ? OF_BLUE : OF_RED;
      atlas.scan(offsetX + col * cell + 12, offsetY + row * cell + 12, 16, 16, function (_x, _y, idx) {
        this.bitmap.data.writeUInt32BE(color, idx);
      });
    }
  }
}

test('detectOuterFrame finds a uniform black border and trim restores grid alignment', async () => {
  const K = 8;
  // 200x160 interior wrapped in a solid black K-px border on all four sides.
  const framed = new Jimp(200 + 2 * K, 160 + 2 * K, OF_BLACK);
  drawFramedInterior(framed, K, K);

  const inset = detectOuterFrame(framed, isChromaMagentaBg, {});
  assert.deepEqual(inset, { top: K, left: K, right: K, bottom: K });

  // Slicing the framed board must produce byte-identical slots to slicing an
  // unframed magenta twin with the same sprite layout — proof the trim put the
  // grid back exactly where it belongs (a known blue block in cell 0, etc.).
  const twin = new Jimp(200, 160, OF_MAGENTA);
  drawFramedInterior(twin, 0, 0);
  const [framedResult, twinResult] = await Promise.all([
    sliceAndNormalizeAtlas(await framed.getBufferAsync(Jimp.MIME_PNG), {}),
    sliceAndNormalizeAtlas(await twin.getBufferAsync(Jimp.MIME_PNG), {}),
  ]);
  assert.equal(framedResult.slots.length, twinResult.slots.length);
  for (let i = 0; i < twinResult.slots.length; i++) {
    assert.equal(framedResult.slots[i].data, twinResult.slots[i].data, `slot ${i} should match its unframed twin`);
  }
  // The blue cell-0 sprite survives (grid-aligned) while the red cells differ.
  assert.ok(framedResult.slots[0].meta.opaqueCount > 0);
});

test('detectOuterFrame returns zero inset for a magenta sheet with no frame (no regression)', () => {
  const sheet = new Jimp(200, 160, OF_MAGENTA);
  drawFramedInterior(sheet, 0, 0);
  const inset = detectOuterFrame(sheet, isChromaMagentaBg, {});
  assert.deepEqual(inset, { top: 0, left: 0, right: 0, bottom: 0 });
});

test('detectOuterFrame peels an asymmetric frame with the correct per-side inset', () => {
  const top = 6;
  const bottom = 10;
  const left = 4;
  const right = 12;
  const framed = new Jimp(200 + left + right, 160 + top + bottom, OF_BLACK);
  drawFramedInterior(framed, left, top);
  const inset = detectOuterFrame(framed, isChromaMagentaBg, {});
  assert.deepEqual(inset, { top, left, right, bottom });
});

// --- clipWidthOverflow (character-board same-size poses) --------------------

const CWO_BLUE = 0x1950a0ff;

// Reads the opaque-content bounding box of a normalized 128px frame plus which
// vertical frame edges its content touches.
async function readFrameBox(dataUri: string): Promise<{
  height: number;
  width: number;
  minY: number;
  touchesLeft: boolean;
  touchesRight: boolean;
}> {
  const img = await Jimp.read(Buffer.from(dataUri.split(',')[1], 'base64'));
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  let touchesLeft = false;
  let touchesRight = false;
  img.scan(0, 0, 128, 128, function (x, y, idx) {
    if (this.bitmap.data[idx + 3] === 0) return;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    if (x === 0) touchesLeft = true;
    if (x === 127) touchesRight = true;
  });
  return { height: maxY - minY + 1, width: maxX - minX + 1, minY, touchesLeft, touchesRight };
}

// Builds a 5x4 atlas whose row-0 reference slots (0..4) fix the board height
// (a 20x40 body -> boardScale 1 at targetContentHeight 40) and whose row-1
// normalization group [5,6] pairs a very WIDE frame A (160px, slot 5) with a
// NORMAL frame B (20px, slot 6) at the same 40px height. Without clipWidthOverflow
// the group's 160px union width trips the width caps and shrinks BOTH members.
async function buildCascadeAtlas(): Promise<Buffer> {
  const CW = 200;
  const CH = 64;
  const atlas = new Jimp(CW * 5, CH * 4, 0xff00ffff);
  // Reference bodies, slots 0..4 (row 0): 20 wide x 40 tall.
  for (let col = 0; col < 5; col++) {
    atlas.scan(col * CW + 90, 20, 20, 40, function (_x, _y, idx) {
      this.bitmap.data.writeUInt32BE(CWO_BLUE, idx);
    });
  }
  // Frame A (slot 5, row 1 col 0): 160 wide x 40 tall.
  atlas.scan(20, CH + 20, 160, 40, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(CWO_BLUE, idx);
  });
  // Frame B (slot 6, row 1 col 1): 20 wide x 40 tall.
  atlas.scan(CW + 90, CH + 20, 20, 40, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(CWO_BLUE, idx);
  });
  return atlas.getBufferAsync(Jimp.MIME_PNG);
}

function cascadeGrid(clipWidthOverflow?: boolean) {
  return {
    columns: 5,
    rows: 4,
    scaleReferenceSlots: [0, 1, 2, 3, 4],
    targetContentHeight: 40,
    maxContentExtent: 120,
    normalizationGroups: [[5, 6]],
    ...(clipWidthOverflow !== undefined ? { clipWidthOverflow } : {}),
  };
}

test('clipWidthOverflow keeps a normal pose at board scale when its clip-mate is very wide (cascade fixed)', async () => {
  const buffer = await buildCascadeAtlas();
  const [clipped, unclipped] = await Promise.all([
    sliceAndNormalizeAtlas(buffer, {}, cascadeGrid(true)),
    sliceAndNormalizeAtlas(buffer, {}, cascadeGrid(false)),
  ]);

  const reference = await readFrameBox(clipped.slots[0].data);
  assert.equal(reference.height, 40, 'reference walk cell renders at board scale');

  // Flag TRUE: frame B (the normal pose) is NOT shrunk by its wide clip-mate —
  // it renders at the same board height as the reference cell.
  const frameBClipped = await readFrameBox(clipped.slots[6].data);
  assert.equal(frameBClipped.height, reference.height);

  // Flag FALSE (old/object behavior): the 160px union width shrinks the whole
  // clip, so frame B renders SMALLER than the reference cell.
  const frameBUnclipped = await readFrameBox(unclipped.slots[6].data);
  assert.equal(frameBUnclipped.height, 30);
  assert.ok(frameBUnclipped.height < reference.height);
});

test('clipWidthOverflow lets a wide pose clip at the frame edge instead of shrinking the clip', async () => {
  const buffer = await buildCascadeAtlas();
  const [clipped, unclipped] = await Promise.all([
    sliceAndNormalizeAtlas(buffer, {}, cascadeGrid(true)),
    sliceAndNormalizeAtlas(buffer, {}, cascadeGrid(false)),
  ]);

  // Flag TRUE: frame A scales to board scale (160px wide > 128px frame) so its
  // horizontal overflow is clipped by the frame on BOTH sides.
  const frameAClipped = await readFrameBox(clipped.slots[5].data);
  assert.ok(frameAClipped.touchesLeft, 'wide pose overflows the left frame edge');
  assert.ok(frameAClipped.touchesRight, 'wide pose overflows the right frame edge');

  // Flag FALSE: the pair scaled down instead, so frame A fits with margin and
  // touches neither vertical edge.
  const frameAUnclipped = await readFrameBox(unclipped.slots[5].data);
  assert.ok(!frameAUnclipped.touchesLeft);
  assert.ok(!frameAUnclipped.touchesRight);
});

test('clipWidthOverflow still applies the height cap so a tall pose is not top-clipped', async () => {
  const CW = 200;
  const CH = 200;
  const atlas = new Jimp(CW * 2, CH * 2, 0xff00ffff);
  // Reference body slot 0 (row0 col0): 20 wide x 40 tall -> boardScale 1.
  atlas.scan(90, 20, 20, 40, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(CWO_BLUE, idx);
  });
  // Tall pose slot 3 (row1 col1): 20 wide x 160 tall (exceeds maxContentExtent 120
  // and the 128px frame), clear of every cell boundary.
  atlas.scan(CW + 90, CH + 20, 20, 160, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(CWO_BLUE, idx);
  });

  const result = await sliceAndNormalizeAtlas(await atlas.getBufferAsync(Jimp.MIME_PNG), {}, {
    columns: 2,
    rows: 2,
    scaleReferenceSlots: [0],
    targetContentHeight: 40,
    maxContentExtent: 120,
    clipWidthOverflow: true,
  });

  const tall = await readFrameBox(result.slots[3].data);
  // The height cap (maxContentExtent/bh) shrank 160px -> 120px, so the content
  // fits inside the frame and its top is preserved (minY > 0, not clipped at 0).
  assert.equal(tall.height, 120);
  assert.ok(tall.minY > 0, 'tall pose top is protected, not clipped at the frame top');
});

test('clipWidthOverflow unset is byte-identical to the pre-change scale path (object/decor no-regression)', async () => {
  const buffer = await buildCascadeAtlas();
  const [omitted, explicitFalse] = await Promise.all([
    sliceAndNormalizeAtlas(buffer, {}, cascadeGrid(undefined)),
    sliceAndNormalizeAtlas(buffer, {}, cascadeGrid(false)),
  ]);

  assert.equal(omitted.slots.length, explicitFalse.slots.length);
  for (let i = 0; i < omitted.slots.length; i++) {
    assert.equal(omitted.slots[i].data, explicitFalse.slots[i].data, `slot ${i} unchanged when the flag is unset`);
  }
  // And the wide-clip member is still shrunk on the default path (old behavior).
  const frameB = await readFrameBox(omitted.slots[6].data);
  assert.equal(frameB.height, 30);
});

// --- shape-only registration (in-place lighting animations) -----------------

// Builds a small frame with one solid opaque rectangle (alpha 255, opaque to the
// registration threshold) at a given x offset and RGB brightness; the rest is
// fully transparent background. Used to feed findBestHorizontalShift directly.
function solidRectFrame(rectX: number, brightness: number): Jimp {
  const frame = new Jimp(40, 20, 0x00000000);
  frame.scan(rectX, 5, 8, 10, function (_x, _y, idx) {
    this.bitmap.data[idx] = brightness;
    this.bitmap.data[idx + 1] = brightness;
    this.bitmap.data[idx + 2] = brightness;
    this.bitmap.data[idx + 3] = 255;
  });
  return frame;
}

test('shape-only registration returns 0 for identical silhouettes at different brightness', () => {
  // The animated-object bug: two frames share an identical silhouette at the SAME
  // position but the animation changes lighting (frame B much dimmer). Shape-only
  // registration ignores per-pixel brightness, so it must not invent a shift.
  const bright = solidRectFrame(16, 220);
  const dim = solidRectFrame(16, 40);
  assert.equal(findBestHorizontalShift(bright, dim, true), 0);
});

test('shape-only registration cancels real drift despite a lighting change', () => {
  // Frame B has the same silhouette shifted +6px right AND a different brightness.
  // Shape-only must still align it back (dx = -6); the lighting must not prevent
  // correct drift cancellation.
  const reference = solidRectFrame(16, 220);
  const driftedDim = solidRectFrame(22, 40); // +6px right, dimmer
  assert.equal(findBestHorizontalShift(reference, driftedDim, true), -6);
});

test('RGB registration path is unchanged for a same-brightness drift (character path guard)', () => {
  // With shapeOnly false/undefined (the character/rival path) a +6px drift at the
  // same brightness still registers back to dx = -6, exactly as before the change.
  const reference = solidRectFrame(16, 220);
  const drifted = solidRectFrame(22, 220); // +6px right, same brightness
  assert.equal(findBestHorizontalShift(reference, drifted, false), -6);
  assert.equal(findBestHorizontalShift(reference, drifted), -6);
});

test('detectOuterFrame respects the per-side trim cap and never over-crops', () => {
  // A pathological all-black sheet (no magenta interior ever reached): every
  // ring is a uniform non-background color, so peeling would consume everything.
  // The 15% cap must stop it, and the min-region guard keeps it safe.
  const black = new Jimp(200, 160, OF_BLACK);
  const inset = detectOuterFrame(black, isChromaMagentaBg, { minRegionWidth: 20, minRegionHeight: 16 });
  assert.ok(inset.left <= Math.floor(200 * 0.15));
  assert.ok(inset.right <= Math.floor(200 * 0.15));
  assert.ok(inset.top <= Math.floor(160 * 0.15));
  assert.ok(inset.bottom <= Math.floor(160 * 0.15));
  assert.ok(200 - inset.left - inset.right >= 20);
  assert.ok(160 - inset.top - inset.bottom >= 16);
});

// --- noUpscale (small content must not be enlarged past its native size) ---

const NU_BLUE = 0x1950a0ff;
const NU_NATIVE_HEIGHT = 20;
const NU_TARGET_HEIGHT = 60;

// Reads the opaque-content bbox height of a normalized 128px frame.
async function opaqueContentHeight(dataUri: string): Promise<number> {
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
}

// A single 1x1-cell atlas whose only content is drawn well below
// targetContentHeight (20px content vs a 60px target), comfortably clear of
// the cell edges so no boundary-spill pass touches it.
async function buildSmallContentAtlas(): Promise<Buffer> {
  const cellSize = 100;
  const contentWidth = 10;
  const atlas = new Jimp(cellSize, cellSize, 0xff00ffff);
  atlas.scan(45, cellSize - NU_NATIVE_HEIGHT - 10, contentWidth, NU_NATIVE_HEIGHT, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(NU_BLUE, idx);
  });
  return atlas.getBufferAsync(Jimp.MIME_PNG);
}

test('baseline (no noUpscale): small content is enlarged toward the target height', async () => {
  const buffer = await buildSmallContentAtlas();
  // Built via an intermediate variable (not an inline literal) so this grid
  // object is structurally, not freshly, checked against AtlasGrid.
  const grid = {
    columns: 1,
    rows: 1,
    scaleReferenceSlots: [0],
    targetContentHeight: NU_TARGET_HEIGHT,
    maxContentExtent: 120,
  };
  const result = await sliceAndNormalizeAtlas(buffer, {}, grid);
  const height = await opaqueContentHeight(result.slots[0].data);
  // boardScale = 60 / 20 = 3x; nearest-neighbor rounding gives a little slop,
  // but the content must land near the 60px target and well past its native
  // 20px height, proving upscaling is the default behavior.
  assert.ok(height > NU_NATIVE_HEIGHT * 2, `expected enlargement well past native ${NU_NATIVE_HEIGHT}px, got ${height}`);
  assert.ok(Math.abs(height - NU_TARGET_HEIGHT) <= 2, `expected ~${NU_TARGET_HEIGHT}px scaled height, got ${height}`);
});

test('noUpscale:true clamps board scale to 1 so small content stays at native size (no enlargement)', async () => {
  const buffer = await buildSmallContentAtlas();
  const grid = {
    columns: 1,
    rows: 1,
    scaleReferenceSlots: [0],
    targetContentHeight: NU_TARGET_HEIGHT,
    maxContentExtent: 120,
    noUpscale: true,
  };
  const result = await sliceAndNormalizeAtlas(buffer, {}, grid);
  const height = await opaqueContentHeight(result.slots[0].data);
  // With noUpscale, boardScale is clamped to a max of 1, so content this small
  // must never be enlarged past its own native (drawn) height — a 1px
  // tolerance covers nearest-neighbor rounding, nothing more.
  assert.ok(height <= NU_NATIVE_HEIGHT + 1, `expected no enlargement (<=${NU_NATIVE_HEIGHT + 1}px), got ${height}`);
});

// --- removeStrayVerticalRowRuns (drop a leaked adjacent-row fragment without
// squishing the cell's real subject) ----------------------------------------
//
// A 1x1 grid (columns:1, rows:1) is used throughout so the row/column
// boundary-spill passes (which only run for row>0 / col>0) stay out of the
// picture, isolating removeStrayVerticalRowRuns exactly as the existing
// feet-anchor tests above do for their own pass.

const SVR_BLUE = 0x1950a0ff;  // main figure
const SVR_RED = 0xc82828ff;   // stray fragment: small + separated -> cleared
const SVR_GREEN = 0x2ecc40ff; // legit same-run or large gap-separated content

test('removeStrayVerticalRowRuns is a no-op for a cell with a single contiguous content run', async () => {
  const atlas = new Jimp(100, 100, 0xff00ffff);
  // A single solid figure block: rows 10..69 (60 tall), x 30..69 (40 wide).
  atlas.scan(30, 10, 40, 60, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(SVR_BLUE, idx);
  });

  const result = await sliceAndNormalizeAtlas(await atlas.getBufferAsync(Jimp.MIME_PNG), {}, { columns: 1, rows: 1 });
  const frame = await Jimp.read(Buffer.from(result.slots[0].data.split(',')[1], 'base64'));
  let minY = Infinity;
  let maxY = -1;
  let opaqueCount = 0;
  frame.scan(0, 0, 128, 128, function (_x, y, idx) {
    if (this.bitmap.data[idx + 3] === 0) return;
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    opaqueCount++;
  });

  // Zero or one content run is a documented early-return no-op: the entire
  // 40x60 figure survives untouched, with its full drawn height intact.
  assert.equal(opaqueCount, 40 * 60);
  assert.equal(maxY - minY + 1, 60);
});

test('removeStrayVerticalRowRuns clears a small, separated stray fragment without squishing the main figure', async () => {
  const cellSize = 100;
  const buildAtlas = (includeFragment: boolean) => {
    const atlas = new Jimp(cellSize, cellSize, 0xff00ffff);
    // Main figure: rows 10..69 (60 tall), x 30..69 (40 wide) = 2400px area.
    atlas.scan(30, 10, 40, 60, function (_x, _y, idx) {
      this.bitmap.data.writeUInt32BE(SVR_BLUE, idx);
    });
    if (includeFragment) {
      // A stray fragment leaked from the adjacent grid row: rows 73..77 (5
      // tall), x 40..49 (10 wide) = 50px area (<25% of the figure's 2400px),
      // separated from the figure by a 3-row empty gap (rows 70..72) -- meets
      // both STRAY_RUN_MAX_AREA_RATIO and STRAY_RUN_MIN_GAP_ROWS.
      atlas.scan(40, 73, 10, 5, function (_x, _y, idx) {
        this.bitmap.data.writeUInt32BE(SVR_RED, idx);
      });
    }
    return atlas.getBufferAsync(Jimp.MIME_PNG);
  };

  const [withFragment, withoutFragment] = await Promise.all([
    sliceAndNormalizeAtlas(await buildAtlas(true), {}, { columns: 1, rows: 1 }),
    sliceAndNormalizeAtlas(await buildAtlas(false), {}, { columns: 1, rows: 1 }),
  ]);

  // removeStrayVerticalRowRuns runs before the bounding-box scan, so the cell
  // WITH the fragment must produce the exact same normalized frame as the
  // cell WITHOUT it -- proof the main figure is neither squished nor
  // otherwise distorted by the stray fragment's presence.
  assert.equal(withFragment.slots[0].data, withoutFragment.slots[0].data);
  assert.deepEqual(withFragment.slots[0].meta, withoutFragment.slots[0].meta);

  const frame = await Jimp.read(Buffer.from(withFragment.slots[0].data.split(',')[1], 'base64'));
  let redPixels = 0;
  let bluePixels = 0;
  frame.scan(0, 0, 128, 128, function (_x, _y, idx) {
    const color = this.bitmap.data.readUInt32BE(idx);
    if (color === SVR_RED) redPixels++;
    if (color === SVR_BLUE) bluePixels++;
  });
  assert.equal(redPixels, 0, 'the stray fragment is fully cleared');
  assert.equal(bluePixels, 40 * 60, 'the full main figure survives at native size');
});

test('removeStrayVerticalRowRuns preserves content sharing the main figure\'s row-run (feet/staff within the merge-gap tolerance)', async () => {
  const atlas = new Jimp(100, 100, 0xff00ffff);
  // Main figure: rows 10..69 (60 tall), x 30..69 (40 wide).
  atlas.scan(30, 10, 40, 60, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(SVR_BLUE, idx);
  });
  // A held staff/feet extension: rows 71..75, separated from the figure by
  // only a 1-row gap (row 70) -- within MERGE_GAP_ROWS(2), so it merges into
  // the SAME run as the figure and must never be evaluated for removal.
  atlas.scan(40, 71, 10, 5, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(SVR_GREEN, idx);
  });

  const result = await sliceAndNormalizeAtlas(await atlas.getBufferAsync(Jimp.MIME_PNG), {}, { columns: 1, rows: 1 });
  const frame = await Jimp.read(Buffer.from(result.slots[0].data.split(',')[1], 'base64'));
  let greenPixels = 0;
  let bluePixels = 0;
  frame.scan(0, 0, 128, 128, function (_x, _y, idx) {
    const color = this.bitmap.data.readUInt32BE(idx);
    if (color === SVR_GREEN) greenPixels++;
    if (color === SVR_BLUE) bluePixels++;
  });
  assert.equal(greenPixels, 10 * 5, 'the staff/feet extension survives fully');
  assert.equal(bluePixels, 40 * 60, 'the main figure survives fully');
});

test('removeStrayVerticalRowRuns never clears a gap-separated region that is not small relative to the dominant run (guard)', async () => {
  const atlas = new Jimp(100, 100, 0xff00ffff);
  // Dominant figure: rows 10..69 (60 tall), x 10..49 (40 wide) = 2400px area.
  atlas.scan(10, 10, 40, 60, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(SVR_BLUE, idx);
  });
  // A second region separated by a 3-row gap (meets STRAY_RUN_MIN_GAP_ROWS),
  // sharing the dominant's x-range (10..49) so the union content bbox stays
  // centered and well within the 128px output frame. Its 640px area is above
  // STRAY_RUN_MAX_AREA_RATIO(0.25) of the dominant's 2400px, so the "isSmall"
  // condition fails and it must be preserved even though it is separated.
  atlas.scan(10, 73, 40, 16, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(SVR_GREEN, idx);
  });

  const result = await sliceAndNormalizeAtlas(await atlas.getBufferAsync(Jimp.MIME_PNG), {}, { columns: 1, rows: 1 });
  const frame = await Jimp.read(Buffer.from(result.slots[0].data.split(',')[1], 'base64'));
  let greenPixels = 0;
  let bluePixels = 0;
  frame.scan(0, 0, 128, 128, function (_x, _y, idx) {
    const color = this.bitmap.data.readUInt32BE(idx);
    if (color === SVR_GREEN) greenPixels++;
    if (color === SVR_BLUE) bluePixels++;
  });
  assert.equal(greenPixels, 40 * 16, 'the large secondary region survives despite being gap-separated');
  assert.equal(bluePixels, 40 * 60, 'the dominant figure survives fully');
});
