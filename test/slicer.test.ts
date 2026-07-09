import { test } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';
import { sliceAndNormalizeAtlas } from '../src/extension/slicer';
import { CHARACTER_TARGET_CONTENT_HEIGHT } from '../src/extension/themeAssetPrompts';

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
