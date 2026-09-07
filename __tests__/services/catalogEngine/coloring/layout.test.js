/**
 * The printed object (cb-1 §4.8) against Lulu's rules: every interior page
 * trim + bleed, the count a multiple of 4 (≥ 4), the art box crop (never a
 * stretch) and the 300 PPI floor, captions as PDF type, the cover wrap one
 * page at 17.25 × 11.25 in with the approved cover's own pixels, the
 * palette ink choice, the preflight report, previews and the thumbnail.
 */

const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const {
  LULU_SPEC, GEOMETRY, prepareArt, paletteFor, buildInteriorPdf, buildCoverWrapPdf, renderCoverThumbnail, renderPreviews, preflightLulu, wrapText,
} = require('../../../../services/catalogEngine/coloring/layout');

const png = (w, h, bg = '#ffffff') => sharp({ create: { width: w, height: h, channels: 3, background: bg } }).png().toBuffer();
const linePage = async (w = 600, h = 800) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><circle cx="${w / 2}" cy="${h / 2}" r="${w / 4}" fill="none" stroke="#000" stroke-width="6"/></svg>`)).png().toBuffer();

describe('geometry', () => {
  test('the page is trim + bleed on every side and the cover is the no-spine wrap', () => {
    expect(GEOMETRY.PAGE_W).toBe((8.5 + 0.25) * 72);
    expect(GEOMETRY.PAGE_H).toBe((11 + 0.25) * 72);
    expect(GEOMETRY.COVER_W).toBe((17 + 0.25) * 72);
    expect(GEOMETRY.COVER_H).toBe(GEOMETRY.PAGE_H);
    expect(GEOMETRY.SAFE).toBe(LULU_SPEC.layoutSafetyIn * 72);
    expect(LULU_SPEC.layoutSafetyIn).toBeGreaterThanOrEqual(LULU_SPEC.safetyMarginIn);
    // The art box sits inside the safety margin on every side.
    expect(GEOMETRY.ART.x).toBeGreaterThanOrEqual(GEOMETRY.BLEED + GEOMETRY.SAFE);
    expect(GEOMETRY.ART.x + GEOMETRY.ART.w).toBeLessThanOrEqual(GEOMETRY.PAGE_W - GEOMETRY.BLEED - GEOMETRY.SAFE);
    expect(GEOMETRY.ART.y).toBeGreaterThanOrEqual(GEOMETRY.BLEED + GEOMETRY.SAFE);
    expect(GEOMETRY.ART.y + GEOMETRY.ART.h).toBeLessThanOrEqual(GEOMETRY.PAGE_H - GEOMETRY.BLEED - GEOMETRY.SAFE);
    expect(GEOMETRY.CAPTION_SIZE).toBeGreaterThanOrEqual(LULU_SPEC.minTextPt);
  });
});

describe('prepareArt', () => {
  test('crops a 3:4 render to the box ratio from the centre and upscales to the 300 PPI floor', async () => {
    const r = await prepareArt(await linePage(600, 800));
    expect(Math.abs(r.width / r.height - GEOMETRY.ART_RATIO)).toBeLessThan(0.01);
    expect(r.upscaled).toBe(true);
    expect(r.ppi).toBe(LULU_SPEC.targetPpi);
    expect(r.width).toBe(Math.round(LULU_SPEC.targetPpi * 7.5));
    const meta = await sharp(r.png).metadata();
    expect(meta.channels).toBe(1);
  });
  test('a render at or above the floor keeps its native size', async () => {
    const r = await prepareArt(await linePage(2400, 3200));
    expect(r.upscaled).toBe(false);
    expect(r.ppi).toBe(320);
    expect(r.width).toBe(2400);
    expect(r.height).toBe(Math.round(2400 / GEOMETRY.ART_RATIO));
  });
  test('an undecodable render throws', async () => {
    await expect(prepareArt(Buffer.from('nope'))).rejects.toThrow(/decodable/);
  });
});

describe('buildInteriorPdf + preflightLulu', () => {
  test('title page, meet page, coloring pages, draw-your-own, colored-by, padded to a multiple of 4, every page trim + bleed', async () => {
    const pages = [{ index: 1, kind: 'meet', buffer: await linePage(640, 360), title: 'Meet Emma' }];
    for (let i = 2; i <= 3; i++) pages.push({ index: i, kind: 'between', buffer: await linePage(), title: `Page ${i}` });
    const r = await buildInteriorPdf({ pages, title: 'Emma and the Little Chick', childName: 'Emma', borderPlate: null, captions: true });
    // 1 title + 3 coloring + 2 matter = 6 → padded to 8
    expect(r.pageCount).toBe(8);
    expect(r.coloringPageCount).toBe(3);
    expect(r.pages.length).toBe(3);
    expect(r.pages.slice(1).every(p => p.ppi === LULU_SPEC.targetPpi && p.upscaled)).toBe(true);
    const doc = await PDFDocument.load(r.buffer);
    expect(doc.getPageCount()).toBe(8);
    for (const pg of doc.getPages()) {
      expect(pg.getWidth()).toBeCloseTo(GEOMETRY.PAGE_W, 3);
      expect(pg.getHeight()).toBeCloseTo(GEOMETRY.PAGE_H, 3);
    }
    const cover = await buildCoverWrapPdf({ coverArt: await png(800, 800, '#3355aa'), title: 'Emma and the Little Chick', childName: 'Emma', worldName: 'Sunnybrook Farm', coloringPageCount: 3, vignette: await linePage(640, 360) });
    const pre = await preflightLulu({ interior: r.buffer, cover: cover.buffer, pageReport: r.pages });
    expect(pre.errors).toEqual([]);
    expect(pre.ok).toBe(true);
    expect(pre.interior.pages).toBe(8);
    expect(pre.cover.pages).toBe(1);
    expect(pre.minPpi).toBe(LULU_SPEC.targetPpi);
  }, 60000);
  test('the preflight names a wrong page size, a bad count, and a low PPI', async () => {
    const bad = await PDFDocument.create();
    for (let i = 0; i < 5; i++) bad.addPage([612, 792]);
    const badCover = await PDFDocument.create();
    badCover.addPage([612, 792]);
    badCover.addPage([612, 792]);
    const pre = await preflightLulu({ interior: Buffer.from(await bad.save()), cover: Buffer.from(await badCover.save()), pageReport: [{ index: 1, ppi: 120 }] });
    expect(pre.ok).toBe(false);
    expect(pre.errors.join(' | ')).toMatch(/not a multiple of 4/);
    expect(pre.errors.join(' | ')).toMatch(/expected 630×810/);
    expect(pre.errors.join(' | ')).toMatch(/cover has 2 pages/);
    expect(pre.errors.join(' | ')).toMatch(/120 PPI/);
  });
  test('a border plate is embedded on the matter pages and captions can be switched off', async () => {
    const pages = [{ index: 1, kind: 'meet', buffer: await linePage(640, 360), title: 'Meet Emma' }, { index: 2, kind: 'between', buffer: await linePage(), title: 'On the way' }];
    const r = await buildInteriorPdf({ pages, title: 'T', childName: 'Emma', borderPlate: await linePage(600, 800), captions: false });
    expect(r.pageCount).toBe(8); // 1 + 2 + 2 = 5 → 8
    expect(Buffer.isBuffer(r.buffer)).toBe(true);
  }, 60000);
});

describe('cover + palette + previews', () => {
  test('the palette clamps to a printable band and picks the ink by luminance', async () => {
    const dark = await paletteFor(await png(40, 40, '#101020'));
    expect(dark.ink).toBe('light');
    expect(0.2126 * dark.r + 0.7152 * dark.g + 0.0722 * dark.b).toBeGreaterThanOrEqual(0.17);
    const light = await paletteFor(await png(40, 40, '#fdfdf0'));
    expect(light.ink).toBe('dark');
    expect(0.2126 * light.r + 0.7152 * light.g + 0.0722 * light.b).toBeLessThanOrEqual(0.73);
    const fallback = await paletteFor(Buffer.from('nope'));
    expect(fallback.r).toBeGreaterThan(0);
  });
  test('the cover wrap is one 1242×810 pt page and the thumbnail / previews render', async () => {
    const art = await png(900, 900, '#cc4444');
    const cover = await buildCoverWrapPdf({ coverArt: art, title: 'T', childName: 'Emma', worldName: 'W', coloringPageCount: 20, vignette: null });
    const doc = await PDFDocument.load(cover.buffer);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPages()[0].getWidth()).toBeCloseTo(1242, 3);
    expect(doc.getPages()[0].getHeight()).toBeCloseTo(810, 3);
    const thumb = await renderCoverThumbnail({ coverArt: art, childName: 'Emma', palette: cover.palette });
    const tm = await sharp(thumb).metadata();
    expect([tm.width, tm.height]).toEqual([600, 776]);
    const previews = await renderPreviews([{ buffer: await linePage() }, { buffer: Buffer.from('bad') }, { buffer: await linePage() }], 4, 200);
    expect(previews.length).toBe(2);
    expect((await sharp(previews[0]).metadata()).width).toBe(200);
  }, 60000);
  test('wrapText wraps to the width', () => {
    const font = { widthOfTextAtSize: (t, s) => t.length * s * 0.5 };
    expect(wrapText('one two three four five', font, 10, 60)).toEqual(['one two', 'three four', 'five']);
  });
});
