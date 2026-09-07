/**
 * qa-13 — the drawn lettering template, HELD TO. `templateConformance`
 * measures the share of the template's glyph pixels the render painted in
 * place (against the surrounding scenery, never an absolute threshold) and
 * reads the painted ink at those pixels. Deterministic pixel maths on
 * synthetic pages: a preserved template scores ~1, a re-typeset block near
 * 0, a dark scene with no text 0, and an inverted fill is still "in place"
 * with its polarity reported. Fail-open on garbage.
 */

const sharp = require('sharp');
const {
  templateConformance, deltaE, TEMPLATE_CONFORMANCE_BLOCKING, TEMPLATE_CONFORMANCE_ADVISORY,
} = require('../../../services/catalogEngine/illustrator/metrics');

const W = 1600;
const H = 900;
const INK = [42, 28, 18]; // #2A1C12
const IVORY = [255, 244, 222];

/** Rows of small "glyph" rectangles in a right-hand column — text-block shaped. */
function glyphMask(dx = 0, dy = 0, scale = 1) {
  const cells = [];
  const rows = 8;
  const pitch = Math.round(H * 0.03 * scale);
  const cap = Math.round(H * 0.014 * scale);
  const x0 = Math.round(W * 0.66) + dx;
  const y0 = Math.round(H * 0.22) + dy;
  for (let r = 0; r < rows; r += 1) {
    const words = 3 + (r % 3);
    let x = x0;
    for (let w = 0; w < words; w += 1) {
      const len = Math.round(W * (0.03 + ((r + w) % 3) * 0.012) * scale);
      cells.push({ x, y: y0 + r * pitch, w: len, h: cap });
      x += len + Math.round(W * 0.008 * scale);
    }
  }
  return cells;
}

/** A transparent RGBA canvas with the mask's cells filled in `fill`. */
async function templatePng(cells, fill = INK) {
  const d = Buffer.alloc(W * H * 4, 0);
  for (const c of cells) {
    for (let y = c.y; y < Math.min(H, c.y + c.h); y += 1) {
      for (let x = c.x; x < Math.min(W, c.x + c.w); x += 1) {
        const p = (y * W + x) * 4;
        d[p] = fill[0]; d[p + 1] = fill[1]; d[p + 2] = fill[2]; d[p + 3] = 255;
      }
    }
  }
  return sharp(d, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

/** A textured mid-tone scene (gradient + checker) — realistic ring contrast. */
async function scenePng({ dark = false } = {}) {
  const d = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const p = (y * W + x) * 3;
      const base = dark ? 40 : 150 + Math.round(60 * (x / W));
      const tex = ((Math.floor(x / 9) + Math.floor(y / 9)) % 2) * (dark ? 6 : 18);
      d[p] = Math.min(255, base + tex); d[p + 1] = Math.min(255, base + tex - (dark ? 0 : 10)); d[p + 2] = Math.min(255, base + tex - (dark ? 4 : 30));
    }
  }
  return sharp(d, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

const paint = async (scene, cells, fill = INK) => sharp(scene).composite([{ input: await templatePng(cells, fill) }]).png().toBuffer();

// Native-resolution pixel maths on 1600×900 pages: the scenes are built
// once, and each measurement gets more than the 5 s default.
jest.setTimeout(60000);
let SCENE;
let DARK_SCENE;
beforeAll(async () => {
  SCENE = await scenePng();
  DARK_SCENE = await scenePng({ dark: true });
});

test('a preserved template measures ~1.0 in place, dark polarity, the pinned ink', async () => {
  const cells = glyphMask();
  const template = { base64: (await templatePng(cells)).toString('base64') };
  const r = await templateConformance(await paint(SCENE, cells), template);
  expect(r).not.toBeNull();
  expect(r.ratio).toBeGreaterThanOrEqual(0.95);
  expect(r.polarity).toBe('dark');
  expect(deltaE(r.hex, '#2A1C12')).toBeLessThan(6);
  expect(r.inkPixels).toBeGreaterThan(1000);
  expect(r.block.x).toBeCloseTo(0.66, 1);
});

test('a small placement jitter is absorbed; a re-typeset block elsewhere is a departure', async () => {
  const cells = glyphMask();
  const template = { base64: (await templatePng(cells)).toString('base64') };
  const jittered = await templateConformance(await paint(SCENE, glyphMask(2, 2)), template);
  expect(jittered.ratio).toBeGreaterThanOrEqual(0.9);
  // The ace1cc29 failure: the same words re-typeset lower, larger, centred.
  const retypeset = await templateConformance(await paint(SCENE, glyphMask(-160, 140, 1.6)), template);
  expect(retypeset.ratio).toBeLessThan(TEMPLATE_CONFORMANCE_BLOCKING);
  expect(retypeset.ratio).toBeLessThan(jittered.ratio);
});

test('a dark scene with NO text scores 0 — contrast against the scenery, never an absolute threshold', async () => {
  const cells = glyphMask();
  const template = { base64: (await templatePng(cells)).toString('base64') };
  const r = await templateConformance(DARK_SCENE, template);
  expect(r.ratio).toBe(0);
  expect(r.hex).toBeNull();
});

test('an inverted fill is still IN PLACE — reported as light polarity with its ivory hex (the ink check owns the colour)', async () => {
  const cells = glyphMask();
  const template = { base64: (await templatePng(cells)).toString('base64') };
  const r = await templateConformance(await paint(SCENE, cells, IVORY), template);
  expect(r.polarity).toBe('light');
  expect(r.ratio).toBeGreaterThanOrEqual(0.9);
  expect(deltaE(r.hex, '#fff4de')).toBeLessThan(6);
});

test('the thresholds are ordered and the measurement fails open on garbage', async () => {
  expect(TEMPLATE_CONFORMANCE_BLOCKING).toBeLessThan(TEMPLATE_CONFORMANCE_ADVISORY);
  const cells = glyphMask();
  const template = { base64: (await templatePng(cells)).toString('base64') };
  expect(await templateConformance(Buffer.from('not an image'), template)).toBeNull();
  expect(await templateConformance(SCENE, null)).toBeNull();
  expect(await templateConformance(SCENE, { base64: '' })).toBeNull();
  // A template with no glyphs at all has nothing to hold the render to.
  expect(await templateConformance(SCENE, { base64: (await templatePng([])).toString('base64') })).toBeNull();
});

test('a render at a different size is measured on its own grid (the template is resampled, never cropped)', async () => {
  const cells = glyphMask();
  const template = { base64: (await templatePng(cells)).toString('base64') };
  const painted = await paint(SCENE, cells);
  const smaller = await sharp(painted).resize(Math.round(W * 0.6)).png().toBuffer();
  const r = await templateConformance(smaller, template);
  expect(r.ratio).toBeGreaterThanOrEqual(0.9);
  expect(r.polarity).toBe('dark');
});
