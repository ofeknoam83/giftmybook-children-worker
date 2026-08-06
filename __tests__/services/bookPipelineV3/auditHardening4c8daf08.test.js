/**
 * 2026-07-28 audit hardening (book 4c8daf08 "Amit and the Mystery of
 * Planet X") — unit coverage for the new deterministic checks:
 *
 *   mockupFrameCheck      — wide renders shipped as photos of an open book
 *   findPaletteIslands    — a warm-tan temple spread inside a cool night book
 *   wearableGearLint      — "behind his visor" prose over bare-headed art
 *   applyEmbeddedLayoutBudget — 55-75-word captions scrimmed over the art
 */

const sharp = require('sharp');

const { mockupFrameCheck, MOCKUP_WHITE_FRAC } = require('../../../services/bookPipelineV3/illustrator/qa/deterministicChecks');
const { findPaletteIslands, hueDistance } = require('../../../services/bookPipelineV3/illustrator/bookPass/paletteCheck');
const { wearableGearLint } = require('../../../services/bookPipelineV3/gate/checks/bookLints');
const { applyEmbeddedLayoutBudget, getAgeProfile, EMBEDDED_MAX_WORDS_PER_SPREAD } = require('../../../services/bookPipelineV3/ageProfiles');

/** Solid-color test image with an optional near-white strip on one edge. */
async function makeImage({ width = 256, height = 256, stripSide = null, stripFrac = 0.06 }) {
  const scene = { r: 40, g: 45, b: 90 }; // cool night blue, like the audit book
  const base = sharp({ create: { width, height, channels: 3, background: scene } });
  if (!stripSide) return (await base.png().toBuffer()).toString('base64');
  const stripW = Math.round(width * stripFrac);
  const strip = await sharp({ create: { width: stripW, height, channels: 3, background: { r: 245, g: 244, b: 240 } } }).png().toBuffer();
  const composed = await base
    .composite([{ input: strip, left: stripSide === 'left' ? 0 : width - stripW, top: 0 }])
    .png()
    .toBuffer();
  return composed.toString('base64');
}

describe('mockupFrameCheck (open-book photo borders)', () => {
  test('fails a render with a white page-stack strip on the left edge', async () => {
    const base64 = await makeImage({ stripSide: 'left' });
    const r = await mockupFrameCheck({ base64 });
    expect(r.pass).toBe(false);
    expect(r.defects[0]).toMatch(/book-mockup frame detected/);
    expect(r.defects[0]).toMatch(/left edge/);
  });

  test('fails a render with the strip on the right edge', async () => {
    const base64 = await makeImage({ stripSide: 'right' });
    const r = await mockupFrameCheck({ base64 });
    expect(r.pass).toBe(false);
    expect(r.defects[0]).toMatch(/right edge/);
  });

  test('passes a clean full-bleed render', async () => {
    const base64 = await makeImage({ stripSide: null });
    const r = await mockupFrameCheck({ base64 });
    expect(r.pass).toBe(true);
    expect(Math.max(r.edgeWhiteFrac.left, r.edgeWhiteFrac.right)).toBeLessThan(MOCKUP_WHITE_FRAC);
  });

  test('never throws on an undecodable candidate', async () => {
    const r = await mockupFrameCheck({ base64: 'bm90IGFuIGltYWdl' });
    expect(r.pass).toBe(true); // integrityCheck owns decode failures
  });
});

describe('findPaletteIslands (world-coherence advisory)', () => {
  const cool = { hue: 230, sat: 0.5, luma: 0.3 }; // night blue
  const warm = { hue: 30, sat: 0.5, luma: 0.5 }; // tan temple

  test('flags a warm island between cool neighbors (the spread-10 case)', () => {
    const rows = [
      { spread: 9, stats: cool },
      { spread: 10, stats: warm },
      { spread: 11, stats: cool },
    ];
    const advisories = findPaletteIslands(rows);
    expect(advisories).toHaveLength(1);
    expect(advisories[0].spread).toBe(10);
    expect(advisories[0].note).toMatch(/palette island/);
  });

  test('does not flag a planned arc shift (neighbors move together)', () => {
    const rows = [
      { spread: 9, stats: cool },
      { spread: 10, stats: warm },
      { spread: 11, stats: { ...warm, hue: 40 } }, // next spread stays warm
    ];
    expect(findPaletteIslands(rows)).toHaveLength(0);
  });

  test('skips near-grey spreads where hue is meaningless', () => {
    const grey = { hue: 0, sat: 0.05, luma: 0.4 };
    const rows = [
      { spread: 1, stats: cool },
      { spread: 2, stats: grey },
      { spread: 3, stats: cool },
    ];
    expect(findPaletteIslands(rows)).toHaveLength(0);
  });

  test('hueDistance is circular', () => {
    expect(hueDistance(350, 10)).toBe(20);
    expect(hueDistance(0, 180)).toBe(180);
  });
});

describe('wearableGearLint (text-vs-art gear reconciliation)', () => {
  test('flags visor/glove prose with per-spread detail', () => {
    const manuscript = {
      spreads: [
        { spread: 2, text: 'Amit walks slowly now, eyes wide behind his visor.' },
        { spread: 3, text: 'He traces the pulse with one gloved finger.' },
        { spread: 4, text: 'The bridge hums low in the dark.' },
      ],
    };
    const lints = wearableGearLint(manuscript);
    expect(lints).toHaveLength(1);
    expect(lints[0].code).toBe('wearable_gear');
    expect(lints[0].spreads).toEqual([2, 3]);
    expect(lints[0].message).toMatch(/visor/);
    expect(lints[0].message).toMatch(/gloved/);
  });

  test('silent on gear-free prose', () => {
    const manuscript = { spreads: [{ spread: 1, text: 'The quiet night feels full of stories.' }] };
    expect(wearableGearLint(manuscript)).toHaveLength(0);
  });
});

describe('applyEmbeddedLayoutBudget (caption word cap)', () => {
  test('clamps the early-reader budget for embedded books', () => {
    const profile = getAgeProfile('PB_EARLY_READER'); // 40-70, target 55
    applyEmbeddedLayoutBudget(profile, 'embedded');
    const wps = profile.narrativeConstraints.wordsPerSpread;
    expect(wps.max).toBe(EMBEDDED_MAX_WORDS_PER_SPREAD);
    expect(wps.target).toBeLessThanOrEqual(wps.max);
    expect(wps.min).toBeLessThanOrEqual(wps.max);
  });

  test('embedded clamp narrows the whole-book window to what the spread cap can reach', () => {
    const profile = getAgeProfile('PB_EARLY_READER'); // book window 600-900
    applyEmbeddedLayoutBudget(profile, 'embedded');
    const { totalBookWords: tb, wordsPerSpread: wps, spreadCount } = profile.narrativeConstraints;
    expect(tb.max).toBe(wps.max * spreadCount); // 50 × 13 = 650
    expect(tb.min).toBeLessThanOrEqual(tb.max);
    expect(tb.target).toBeLessThanOrEqual(tb.max);
  });

  test('caption layout keeps the band budget untouched', () => {
    const profile = getAgeProfile('PB_EARLY_READER');
    const before = { ...profile.narrativeConstraints.wordsPerSpread };
    applyEmbeddedLayoutBudget(profile, 'caption');
    expect(profile.narrativeConstraints.wordsPerSpread).toEqual(before);
  });

  test('bands already under the cap are unchanged', () => {
    const profile = getAgeProfile('PB_TODDLER'); // 5-15
    const before = { ...profile.narrativeConstraints.wordsPerSpread };
    applyEmbeddedLayoutBudget(profile, 'embedded');
    expect(profile.narrativeConstraints.wordsPerSpread).toEqual(before);
  });
});
