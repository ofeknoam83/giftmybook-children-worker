'use strict';

/**
 * 2026-09-07: the print path encodes a page ONCE. An embedded spread used to
 * reach the PDF through three JPEG generations (split canvas at 93, each
 * half re-encoded at sharp's default 80 by the format-preserving extract,
 * the page embed at 93) with 4:2:0 chroma — the split now stays lossless
 * and a text-bearing page encodes at quality 95 with full 4:4:4 chroma.
 */

const sharp = require('sharp');
const { splitSpreadImage, encodeFullBleedJpeg, PAGE_JPEG, TEXT_PAGE_JPEG, applyShadowLift } = require('../../services/layoutEngine');

// A small 2" trim keeps the 300 DPI canvas quick (wp = 600 px).
const BLEED = 9;
const pw = 144 + BLEED * 2;
const ph = 144 + BLEED * 2;
const wp = Math.round(pw / 72 * 300);
const hp = Math.round(ph / 72 * 300);

const art = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 120, b: 200 } } }).png().toBuffer();

test('the split halves stay LOSSLESS (PNG) at the page size — no intermediate JPEG generation', async () => {
  const { leftBuf, rightBuf } = await splitSpreadImage(await art(1600, 900), pw, ph);
  for (const b of [leftBuf, rightBuf]) {
    const m = await sharp(b).metadata();
    expect(m.format).toBe('png');
    expect(m.width).toBe(wp);
    expect(m.height).toBe(hp);
  }
  // Shorter-than-page sources (the cover-resize branch) split the same way.
  const short = await splitSpreadImage(await art(1000, 200), pw, ph);
  expect((await sharp(short.rightBuf).metadata()).format).toBe('png');
});

test('a text-bearing page encodes once at quality 95 with 4:4:4 chroma; text-free art keeps 93 with 4:2:0', async () => {
  const { leftBuf } = await splitSpreadImage(await art(1600, 900), pw, ph);
  const text = await sharp(await encodeFullBleedJpeg(leftBuf, wp, hp, { text: true })).metadata();
  expect(text.format).toBe('jpeg');
  expect(text.chromaSubsampling).toBe('4:4:4');
  expect(text.width).toBe(wp);
  expect(text.height).toBe(hp);
  const plain = await sharp(await encodeFullBleedJpeg(leftBuf, wp, hp)).metadata();
  expect(plain.format).toBe('jpeg');
  expect(plain.chromaSubsampling).toBe('4:2:0');
  expect(TEXT_PAGE_JPEG).toEqual({ quality: 95, chromaSubsampling: '4:4:4' });
  expect(PAGE_JPEG).toEqual({ quality: 93, chromaSubsampling: '4:2:0' });
});

test('shadow lift leaves the alpha channel unchanged on RGBA inputs', () => {
  const data = Buffer.from([0, 32, 64, 17, 128, 160, 192, 34]);
  const out = applyShadowLift(Buffer.from(data), 0.1, 4);
  expect(out[3]).toBe(17);
  expect(out[7]).toBe(34);
  expect(out[0]).toBeGreaterThan(data[0]);
  expect(out[1]).toBeGreaterThan(data[1]);
});
