'use strict';

/**
 * P4 (always-on, auto-strengthened caption scrim) + P5 (non-text halo so
 * pdftotext extracts each caption line exactly once) — 2026-07-23 audit
 * regressions from "Amit's Star Map Adventure" (washed-out captions; every
 * caption word extracted twice because the halo copies were selectable text).
 *
 * These exercise the pure helpers and drawCaptionOverlay against a spy page,
 * so they run without sharp (the sandbox sharp binary is incompatible — same
 * constraint as the other layoutEngine suites).
 */

const { PDFDocument, StandardFonts } = require('pdf-lib');
const {
  shouldScrim,
  scrimOpacityFor,
  drawCaptionOverlay,
  loadFonts,
  OVERLAY,
} = require('../../services/layoutEngine');

const PW = 630;
const PH = 630;

describe('P4 scrim enforcement', () => {
  test('shouldScrim is now always true (scrim always composited)', () => {
    expect(shouldScrim(null)).toBe(true);
    expect(shouldScrim({ busy: false, contrastRatio: 21 })).toBe(true);
    expect(shouldScrim({ busy: false, contrastRatio: 1.1 })).toBe(true);
  });

  test('scrimOpacityFor holds the FLOOR when the band already clears MIN_CONTRAST', () => {
    // light ink over a dark band, and dark ink over a bright band, are the
    // tone-picker's normal case — the floor scrim already suffices.
    expect(scrimOpacityFor('light-text', 26)).toBeCloseTo(0.32, 5);
    expect(scrimOpacityFor('dark-text', 232)).toBeCloseTo(0.32, 5);
  });

  test('scrimOpacityFor auto-strengthens toward the ceiling on low-contrast bands', () => {
    const weak = scrimOpacityFor('light-text', 220); // white ink over a bright band
    expect(weak).toBeGreaterThan(0.32);
    expect(weak).toBeLessThanOrEqual(0.85);
    expect(scrimOpacityFor('light-text', 255)).toBeGreaterThan(weak);
  });

  test('an unsampled band (NaN) falls back to the FLOOR, never below', () => {
    expect(scrimOpacityFor('light-text', NaN)).toBeGreaterThanOrEqual(0.32);
    expect(OVERLAY.MIN_CONTRAST).toBe(4.5);
  });
});

describe('P5 caption halo is non-text (single extractable copy)', () => {
  async function countDraws(captionText, opts = {}) {
    const doc = await PDFDocument.create();
    const fonts = await loadFonts(doc);
    const page = doc.addPage([PW, PH]);
    let textDraws = 0;
    let svgDraws = 0;
    const realText = page.drawText.bind(page);
    const realSvg = page.drawSvgPath.bind(page);
    page.drawText = (...a) => { textDraws += 1; return realText(...a); };
    page.drawSvgPath = (...a) => { svgDraws += 1; return realSvg(...a); };
    drawCaptionOverlay(page, fonts, captionText, 'left-top', { pw: PW, ph: PH, tone: 'light-text', scrimAlpha: 0.32, ...opts });
    return { textDraws, svgDraws, fonts };
  }

  test('a one-line caption draws the fill text EXACTLY once; the halo is vector paths', async () => {
    const { textDraws, svgDraws, fonts } = await countDraws('Amit found the map');
    // If the bundled font loaded, the halo/shadow are outlines (svg), not text.
    expect(fonts._fk.bubblegum).toBeTruthy();
    expect(textDraws).toBe(1);          // only the readable fill is selectable text
    expect(svgDraws).toBeGreaterThan(0); // halo ring + shadow rendered as outlines
  });

  test('a three-line caption draws exactly three fill texts (one per line)', async () => {
    const { textDraws } = await countDraws('Amit found the ancient map\nglowing in the dark\nunder the old oak');
    expect(textDraws).toBe(3);
  });

  test('drawGlyphOutlineRun emits one drawSvgPath per non-space glyph and no text', async () => {
    const { drawGlyphOutlineRun } = require('../../services/layoutEngine');
    const fontkit = require('@pdf-lib/fontkit');
    const fs = require('fs');
    const path = require('path');
    const ttf = path.join(__dirname, '..', '..', 'fonts', 'BubblegumSans-Regular.ttf');
    const fk = fontkit.create(fs.readFileSync(ttf));
    const calls = [];
    const page = { drawSvgPath: (d, o) => calls.push({ d, o }), drawText: () => { throw new Error('halo must not draw text'); } };
    drawGlyphOutlineRun(page, fk, 'Hi', 10, 20, 24, { type: 'RGB', red: 0, green: 0, blue: 0 }, 0.7);
    expect(calls.length).toBe(2); // 'H' and 'i', no space
    expect(calls[1].o.x).toBeGreaterThan(calls[0].o.x); // pen advances left→right
  });
});
