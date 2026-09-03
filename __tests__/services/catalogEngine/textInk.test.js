/**
 * ce-18 — the painted text's INK colour, measured. `textInkColour` isolates
 * the glyph fill from the background inside the judged text bbox and reports
 * the polarity the model actually painted; `inkSetOutliers` holds a book's
 * spreads to their own median ink. Both are deterministic pixel/Lab maths —
 * no model, no I/O — and fail open on anything unmeasurable.
 */

const sharp = require('sharp');
const {
  textInkColour, inkSetOutliers, DEFAULT_INK_DELTA_E_THRESHOLD, INK_SET_DELTA_E_THRESHOLD,
} = require('../../../services/catalogEngine/illustrator/metrics');

const BOOK_INK = '#2A1C12';
const FULL = { x: 0, y: 0, w: 1, h: 1 };

/**
 * A text-block-shaped strip: `bg` ground with thin `ink` rows every 10th
 * line — glyphs are a minority of a real text bbox, which is the whole
 * reason the measurement cannot just average the crop.
 */
async function strip(bg, ink, { rows = 10 } = {}) {
  const W = 300;
  const H = 120;
  const d = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    const c = y % rows === 0 ? ink : bg;
    for (let x = 0; x < W; x += 1) {
      const p = (y * W + x) * 3;
      [d[p], d[p + 1], d[p + 2]] = c;
    }
  }
  return sharp(d, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

const TAN = [230, 215, 180];
const GRASS = [120, 95, 60];
const INK = [42, 28, 18];
const WHITE = [250, 250, 250];

test('the book ink on light ground measures as itself: dark polarity, ΔE ~0, pass', async () => {
  const r = await textInkColour(await strip(TAN, INK), FULL, { targetHex: BOOK_INK });
  expect(r.polarity).toBe('dark');
  expect(r.hex).toBe('#2a1c12');
  expect(r.deltaE).toBeLessThan(2);
  expect(r.pass).toBe(true);
  expect(r.pixels).toBeGreaterThan(0);
});

test('an inverted block is caught however legible it looks: light polarity, a huge ΔE, fail', async () => {
  const r = await textInkColour(await strip(GRASS, WHITE), FULL, { targetHex: BOOK_INK });
  expect(r.polarity).toBe('light');
  expect(r.deltaE).toBeGreaterThan(60);
  expect(r.pass).toBe(false);
});

test('a retint to the scene fails too — the check is the colour, not the polarity', async () => {
  const r = await textInkColour(await strip(TAN, [90, 60, 130]), FULL, { targetHex: BOOK_INK });
  expect(r.pass).toBe(false);
  expect(r.deltaE).toBeGreaterThan(DEFAULT_INK_DELTA_E_THRESHOLD);
});

test('the glyph FILL wins over its pale hairline — the thin edge never decides the polarity', async () => {
  // Dark rows (the fill) with twice-as-rare pale rows (the hairline).
  const W = 300;
  const H = 120;
  const d = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    const c = y % 10 === 0 ? INK : (y % 21 === 0 ? WHITE : TAN);
    for (let x = 0; x < W; x += 1) {
      const p = (y * W + x) * 3;
      [d[p], d[p + 1], d[p + 2]] = c;
    }
  }
  const buf = await sharp(d, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const r = await textInkColour(buf, FULL, { targetHex: BOOK_INK });
  expect(r.polarity).toBe('dark');
  expect(r.pass).toBe(true);
});

test('unmeasurable input is fail-open null, never a verdict', async () => {
  expect(await textInkColour(await strip(TAN, TAN), FULL, { targetHex: BOOK_INK })).toBeNull(); // flat: no glyphs
  expect(await textInkColour(Buffer.from('not an image'), FULL, { targetHex: BOOK_INK })).toBeNull();
  expect(await textInkColour(await strip(TAN, INK), null, { targetHex: BOOK_INK })).toBeNull();
  expect(await textInkColour(await strip(TAN, INK), { x: 0, y: 0, w: 2, h: 1 }, { targetHex: BOOK_INK })).toBeNull();
  // Measured but with no target to compare against: a colour, no verdict.
  const noTarget = await textInkColour(await strip(TAN, INK), FULL);
  expect(noTarget.hex).toBe('#2a1c12');
  expect(noTarget.deltaE).toBeNull();
  expect(noTarget.pass).toBeNull();
});

test('the measurement reads the bbox only — ink outside it never counts', async () => {
  // Dark ink in the TOP half only; a bbox over the bottom half is flat.
  const W = 200;
  const H = 200;
  const d = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    const c = (y < H / 2 && y % 10 === 0) ? INK : TAN;
    for (let x = 0; x < W; x += 1) {
      const p = (y * W + x) * 3;
      [d[p], d[p + 1], d[p + 2]] = c;
    }
  }
  const buf = await sharp(d, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  expect(await textInkColour(buf, { x: 0, y: 0, w: 1, h: 0.5 }, { targetHex: BOOK_INK }).then(r => r.pass)).toBe(true);
  expect(await textInkColour(buf, { x: 0, y: 0.5, w: 1, h: 0.5 }, { targetHex: BOOK_INK })).toBeNull();
});

describe('inkSetOutliers — every spread against the book\'s OWN median ink', () => {
  test('the odd spread out is flagged; the family that agrees is the reference', () => {
    const r = inkSetOutliers([
      { spread: 1, hex: '#2A1C12' },
      { spread: 2, hex: '#2E2015' },
      { spread: 3, hex: '#F5F0E6' }, // inverted
      { spread: 4, hex: '#291B11' },
    ]);
    expect(r.referenceHex.toLowerCase()).toMatch(/^#2[0-9a-f]{5}$/);
    expect(r.flagged).toEqual([{ spread: 3, hex: '#F5F0E6', deltaE: expect.any(Number) }]);
    expect(r.flagged[0].deltaE).toBeGreaterThan(INK_SET_DELTA_E_THRESHOLD);
  });

  test('relative drift inside the per-spread tolerance is still caught — the gap the absolute check permits', () => {
    // Both would pass a ΔE-26 check against the pinned ink, in opposite
    // directions; against each other they are a visible mismatch.
    const r = inkSetOutliers([
      { spread: 1, hex: '#2A1C12' }, { spread: 2, hex: '#2B1D13' }, { spread: 3, hex: '#4A3A6A' },
    ]);
    expect(r.flagged.map(f => f.spread)).toEqual([3]);
  });

  test('a consistent book flags nothing', () => {
    expect(inkSetOutliers([
      { spread: 1, hex: '#2A1C12' }, { spread: 2, hex: '#2B1D13' }, { spread: 3, hex: '#291B11' },
    ]).flagged).toEqual([]);
  });

  test('under THREE measurements nothing is compared — two cannot establish a majority', () => {
    // The dangerous case: with one correct and one inverted block, a
    // two-sample median elects a SIDE, and electing the light one would
    // flag the CORRECT spread for re-render. The absolute per-spread check
    // against the pinned ink owns this case instead.
    expect(inkSetOutliers([{ spread: 1, hex: '#2A1C12' }, { spread: 2, hex: '#F5F0E6' }]))
      .toEqual({ referenceHex: null, flagged: [] });
    expect(inkSetOutliers([{ spread: 1, hex: '#F5F0E6' }, { spread: 2, hex: '#2A1C12' }]))
      .toEqual({ referenceHex: null, flagged: [] });
    expect(inkSetOutliers([{ spread: 1, hex: '#2A1C12' }])).toEqual({ referenceHex: null, flagged: [] });
    expect(inkSetOutliers([])).toEqual({ referenceHex: null, flagged: [] });
  });

  test('malformed entries are dropped, never coerced — and they do not count toward the three', () => {
    const r = inkSetOutliers([
      { spread: 1, hex: '#2A1C12' }, { spread: 2, hex: 'brown' }, { spread: 3.5, hex: '#2A1C12' },
      { spread: 4, hex: '#fff' }, null, { spread: 5, hex: '#2B1D13' }, { spread: 6, hex: '#291B11' },
    ]);
    expect(r.flagged).toEqual([]);
    expect(r.referenceHex).toBeTruthy();
    // The same list minus one VALID entry falls under the three-sample floor.
    expect(inkSetOutliers([
      { spread: 1, hex: '#2A1C12' }, { spread: 2, hex: 'brown' }, { spread: 4, hex: '#fff' }, { spread: 5, hex: '#2B1D13' },
    ])).toEqual({ referenceHex: null, flagged: [] });
  });
});
