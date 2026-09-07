/**
 * Line-art metrics (cb-1 §4.6) on synthetic PNGs built with sharp: a
 * clean-line page passes, a grey wash fails `grey shading`, a solid disc
 * fails `solid black fills`, a hairline page reads a low stroke ratio, a
 * framed page trips the ring, cleanLineArt leaves the anti-aliasing band
 * untouched and removes specks, and checkAspect rejects a square.
 */

const sharp = require('sharp');
const { measureLineArt, cleanLineArt, checkAspect, THRESHOLDS, components } = require('../../../../services/catalogEngine/coloring/metrics');
const { LINE_RULES_BY_BAND } = require('../../../../services/catalogEngine/coloring/lineRules');

const W = 300;
const H = 400;
const rules = LINE_RULES_BY_BAND['4-5'];

/** Render an SVG to a PNG buffer. @param {string} body @returns {Promise<Buffer>} */
async function svgPng(body, width = W, height = H) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#ffffff"/>${body}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const STROKE = Math.round(W * rules.primaryStrokePercent / 100); // ≈ 3 px

/** A clean line-art page: a few closed outlines at the band's stroke, well inside the margins. */
const cleanPage = () => svgPng(`
  <circle cx="150" cy="150" r="70" fill="none" stroke="#000" stroke-width="${STROKE}"/>
  <rect x="60" y="250" width="180" height="90" rx="12" fill="none" stroke="#000" stroke-width="${STROKE}"/>
  <path d="M 90 300 Q 150 260 210 300" fill="none" stroke="#000" stroke-width="${STROKE}"/>
  <circle cx="130" cy="140" r="4" fill="#000"/><circle cx="170" cy="140" r="4" fill="#000"/>`);

describe('measureLineArt', () => {
  test('a clean line page has little grey, in-band ink, no fills, an on-spec stroke and no defects', async () => {
    const m = await measureLineArt(await cleanPage(), { rules });
    expect(m.width).toBe(W);
    expect(m.grayRatio).toBeLessThan(THRESHOLDS.GRAY_ADVISORY);
    expect(m.inkRatio).toBeGreaterThan(0);
    expect(m.solidFill).toBe(false);
    expect(m.strokeRatio).toBeGreaterThan(THRESHOLDS.STROKE_LOW_RATIO);
    expect(m.strokeRatio).toBeLessThan(THRESHOLDS.STROKE_HIGH_RATIO);
    expect(m.blocking).toEqual([]);
    expect(m.advisory.filter(a => !/sparse/.test(a))).toEqual([]);
  });
  test('a grey wash is BLOCKING grey shading', async () => {
    const png = await svgPng(`<rect x="40" y="40" width="220" height="320" fill="#9a9a9a"/><circle cx="150" cy="150" r="60" fill="none" stroke="#000" stroke-width="${STROKE}"/>`);
    const m = await measureLineArt(png, { rules });
    expect(m.grayRatio).toBeGreaterThan(THRESHOLDS.GRAY_BLOCKING);
    expect(m.blocking.some(d => d.startsWith('grey shading present'))).toBe(true);
  });
  test('a solid black disc is BLOCKING solid fills', async () => {
    const png = await svgPng(`<circle cx="150" cy="200" r="50" fill="#000"/><rect x="40" y="40" width="220" height="320" fill="none" stroke="#000" stroke-width="${STROKE}"/>`);
    const m = await measureLineArt(png, { rules });
    expect(m.solidFill).toBe(true);
    expect(m.largestSolid.solidity).toBeGreaterThan(THRESHOLDS.SOLID_MIN_SOLIDITY);
    expect(m.blocking.some(d => d.startsWith('solid black fills'))).toBe(true);
  });
  test('a hairline page reads a low stroke ratio (advisory)', async () => {
    // At 600 px the band's stroke is ≈ 5 px; a 1-px hairline measures ≈ 2 px
    // (every pixel of a 1-px line is boundary — the 2A/P floor).
    const png = await svgPng('<circle cx="300" cy="300" r="160" fill="none" stroke="#000" stroke-width="1"/><rect x="100" y="500" width="400" height="200" fill="none" stroke="#000" stroke-width="1"/>', 600, 800);
    const m = await measureLineArt(png, { rules });
    expect(m.strokeRatio).toBeLessThan(THRESHOLDS.STROKE_LOW_RATIO);
    expect(m.advisory.some(a => a.startsWith('stroke weight off spec'))).toBe(true);
    expect(m.blocking).toEqual([]);
  });
  test('a drawn frame trips the ring and the margin', async () => {
    const inset = Math.round(Math.min(W, H) * 0.025);
    const png = await svgPng(`<rect x="${inset}" y="${inset}" width="${W - 2 * inset}" height="${H - 2 * inset}" fill="none" stroke="#000" stroke-width="${STROKE}"/><circle cx="150" cy="200" r="50" fill="none" stroke="#000" stroke-width="${STROKE}"/>`);
    const m = await measureLineArt(png, { rules });
    expect(m.frameRing).toBeGreaterThanOrEqual(THRESHOLDS.FRAME_RING_DENSITY);
    expect(m.advisory).toContain('frame drawn around the page');
    expect(m.advisory.some(a => a.startsWith('ink inside the edge margin'))).toBe(true);
  });
  test('an undecodable buffer measures null without throwing', async () => {
    const m = await measureLineArt(Buffer.from('not an image'), { rules });
    expect(m.grayRatio).toBeNull();
    expect(m.blocking).toEqual([]);
  });
});

describe('cleanLineArt', () => {
  test('flattens near-white, snaps near-black, keeps the anti-aliasing band and removes specks', async () => {
    const raw = Buffer.alloc(40 * 40, 240); // near-white paper
    raw[0] = 30; // near-black → 0, but isolated ⇒ a speck ⇒ removed
    raw[2] = 250; // near-white → 255
    raw[20 * 40 + 20] = 10; // an isolated 1-px speck → removed
    // a 4-px block (survives the ≤ 3 px despeckle) with an anti-aliased
    // edge pixel attached to it — the band value must survive untouched.
    raw[30 * 40 + 5] = 0; raw[30 * 40 + 6] = 0; raw[31 * 40 + 5] = 0; raw[31 * 40 + 6] = 0;
    raw[30 * 40 + 7] = 120;
    const png = await sharp(raw, { raw: { width: 40, height: 40, channels: 1 } }).png().toBuffer();
    const r = await cleanLineArt(png, { despeckle: true });
    expect(r.changed).toBe(true);
    expect(r.specks).toBe(2); // raw[0] and the lone speck at (20,20)
    const { data } = await sharp(r.buffer).grayscale().raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBe(255);
    expect(data[2]).toBe(255);
    expect(data[3]).toBe(255);
    expect(data[20 * 40 + 20]).toBe(255);
    expect(data[30 * 40 + 5]).toBe(0);
    expect(data[31 * 40 + 6]).toBe(0);
    expect(data[30 * 40 + 7]).toBe(120);
  });
  test('despeckle off keeps every speck', async () => {
    const raw = Buffer.alloc(20 * 20, 255);
    raw[5 * 20 + 5] = 0;
    const png = await sharp(raw, { raw: { width: 20, height: 20, channels: 1 } }).png().toBuffer();
    const r = await cleanLineArt(png, { despeckle: false });
    const { data } = await sharp(r.buffer).grayscale().raw().toBuffer({ resolveWithObject: true });
    expect(data[5 * 20 + 5]).toBe(0);
    expect(r.specks).toBe(0);
  });
  test('an undecodable buffer comes back unchanged', async () => {
    const bad = Buffer.from('nope');
    const r = await cleanLineArt(bad);
    expect(r.buffer).toBe(bad);
    expect(r.specks).toBeNull();
  });
});

describe('checkAspect + components', () => {
  test('3:4 passes, square fails, never resizes', async () => {
    expect((await checkAspect(await cleanPage())).ok).toBe(true);
    const square = await svgPng('', 200, 200);
    const r = await checkAspect(square);
    expect(r.ok).toBe(false);
    expect(r.ratio).toBe(1);
    expect((await checkAspect(Buffer.from('x'))).ok).toBe(false);
  });
  test('components finds 4-connected blobs with bboxes', () => {
    const mask = new Uint8Array([
      1, 1, 0, 0,
      1, 0, 0, 1,
      0, 0, 0, 1,
    ]);
    const c = components(mask, 4, 3);
    expect(c.length).toBe(2);
    expect(c[0]).toEqual({ area: 3, minX: 0, minY: 0, maxX: 1, maxY: 1 });
    expect(c[1]).toEqual({ area: 2, minX: 3, minY: 1, maxX: 3, maxY: 2 });
  });
});
