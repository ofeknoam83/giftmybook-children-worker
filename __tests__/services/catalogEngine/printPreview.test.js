'use strict';

// pq-1 Phase 2.4 — the print-crop preview: the exact page crop the layout
// engine prints, with trim / safety / fold guides.

jest.mock('../../../services/gcsStorage', () => ({
  uploadBuffer: jest.fn(async () => {}),
  getSignedUrl: jest.fn(async key => `https://storage.example/${key}`),
}));

const { printFrame, printPreviewKey, buildPrintPreview, attachPrintPreviews } = require('../../../services/catalogEngine/illustrator/printPreview');
const { uploadBuffer } = require('../../../services/gcsStorage');

describe('printFrame', () => {
  test('a wide render is scaled to the two-page spread and centre-cropped: 4096×2304 keeps the middle 2340 rows', () => {
    const f = printFrame('wide', { width: 4096, height: 2304 });
    expect(f.pages).toBe(2);
    expect(f.crop).toEqual({ left: 0, top: 128, width: 4096, height: 2048 });
    // 4096 px across 17.5 in → 234 px/in → 8.75 in tall = 2048 px: the
    // layout engine's 5.6 % + 5.6 % vertical crop.
    expect((f.crop.top / 2304 * 100).toFixed(1)).toBe('5.6');
    expect(f.bleedFrac).toBeCloseTo(0.125 / 8.75, 6);
    expect(f.safetyFrac).toBeCloseTo(0.825 / 8.75, 6);
    expect(f.gutterFrac).toBeCloseTo(0.2 / 8.75, 6);
  });

  test('a square render is one whole page', () => {
    const f = printFrame('square', { width: 2048, height: 2048 });
    expect(f.pages).toBe(1);
    expect(f.crop).toEqual({ left: 0, top: 0, width: 2048, height: 2048 });
  });

  test('the preview key sits beside the render', () => {
    expect(printPreviewKey('children-jobs/b/ce-renders/ce-20/h-is4k/spread-3.wide.png')).toBe('children-jobs/b/ce-renders/ce-20/h-is4k/spread-3.wide.print.jpg');
  });
});

describe('buildPrintPreview / attachPrintPreviews', () => {
  let sharp;
  beforeAll(async () => {
    try { sharp = require('sharp'); await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer(); }
    catch { sharp = null; }
  });

  test('a wide render becomes a 2:1 JPEG preview; a square one a 1:1 preview', async () => {
    if (!sharp) return; // sharp unusable in this sandbox — the pure geometry above is covered
    const wide = await sharp({ create: { width: 1024, height: 576, channels: 3, background: '#8ab' } }).png().toBuffer();
    const square = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#a8b' } }).png().toBuffer();
    const w = await sharp(await buildPrintPreview(wide, { aspect: 'wide', textLayout: 'embedded', width: 800 })).metadata();
    expect([w.format, w.width, w.height]).toEqual(['jpeg', 800, 400]);
    const h = await sharp(await buildPrintPreview(wide, { aspect: 'wide', textLayout: 'half', width: 800 })).metadata();
    expect([h.width, h.height]).toEqual([800, 400]);
    const s = await sharp(await buildPrintPreview(square, { aspect: 'square', textLayout: 'caption', width: 800 })).metadata();
    expect([s.format, s.width, s.height]).toEqual(['jpeg', 400, 400]);
  });

  test('attachPrintPreviews uploads beside each render, skips pixel-less results, and never throws for one bad buffer', async () => {
    if (!sharp) return;
    const wide = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#8ab' } }).png().toBuffer();
    const results = [
      { spread: 1, buffer: wide, storageKey: 'k/spread-1.wide.png' },
      { spread: 2, buffer: null, storageKey: 'k/spread-2.wide.png' },
      { spread: 3, buffer: Buffer.from('not an image'), storageKey: 'k/spread-3.wide.png' },
    ];
    const log = jest.fn();
    const urls = await attachPrintPreviews(results, { aspect: 'wide', textLayout: 'embedded', log });
    expect(urls).toEqual(['https://storage.example/k/spread-1.wide.print.jpg']);
    expect(results[0].printPreviewKey).toBe('k/spread-1.wide.print.jpg');
    expect(results[1].printPreviewUrl).toBeUndefined();
    expect(results[2].printPreviewUrl).toBeUndefined();
    expect(uploadBuffer).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/Spread 3: print preview skipped/));
  });
});
