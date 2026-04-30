'use strict';

const sharp = require('sharp');
const { splitSpreadImage } = require('../../services/layoutEngine');

describe('splitSpreadImage', () => {
  test('2:1 strip on portrait page trim scales up without throwing (quad short-side case)', async () => {
    const w = 1200;
    const h = 600;
    const buf = await sharp({
      create: {
        width: w,
        height: h,
        channels: 3,
        background: { r: 100, g: 150, b: 200 },
      },
    })
      .jpeg()
      .toBuffer();

    const bleed = 9;
    const portraitTrimW = 432;
    const portraitTrimH = 648;
    const pw = portraitTrimW + bleed * 2;
    const ph = portraitTrimH + bleed * 2;

    const { leftBuf, rightBuf } = await splitSpreadImage(buf, pw, ph);
    expect(leftBuf.length).toBeGreaterThan(500);
    expect(rightBuf.length).toBeGreaterThan(500);
    const leftMeta = await sharp(leftBuf).metadata();
    const rightMeta = await sharp(rightBuf).metadata();
    expect(leftMeta.width).toBe(rightMeta.width);
    expect(leftMeta.height).toBe(rightMeta.height);
  });

  test('2:1 strip on square trim splits cleanly (early reader / picture book)', async () => {
    const buf = await sharp({
      create: {
        width: 1000,
        height: 500,
        channels: 3,
        background: { r: 50, g: 80, b: 120 },
      },
    })
      .jpeg()
      .toBuffer();

    const bleed = 9;
    const pw = 612 + bleed * 2;
    const ph = 612 + bleed * 2;

    const { leftBuf, rightBuf } = await splitSpreadImage(buf, pw, ph);
    expect(leftBuf.length).toBeGreaterThan(300);
    expect(rightBuf.length).toBeGreaterThan(300);
  });
});
