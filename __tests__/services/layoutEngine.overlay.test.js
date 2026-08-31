'use strict';

const {
  assemblePdf,
  analyzeZoneBand,
  computeOverlayPlacement,
  computeCaptionBlock,
  contrastRatio,
  overlayContrastRatio,
  pickOverlayTone,
  OVERLAY,
} = require('./../../services/layoutEngine');

// Embedded-overlay hardening (2026-07-18): the tone/halo decision and the
// placement bounds are pure functions so they can be exercised without sharp
// (the sandbox sharp binary is incompatible — same constraint as
// layoutEngine.captionMode.test.js). Page geometry below matches the
// picture-book trim: 612pt + 2×9pt bleed = 630pt square.
const PW = 630;
const PH = 630;

const seg = (luminance, stdev = 0) => ({ luminance, stdev });

describe('analyzeZoneBand (segment-based tone + halo decision)', () => {
  test('uniform light band → dark ink, normal halo', () => {
    const r = analyzeZoneBand([seg(210, 10), seg(205, 12), seg(215, 8), seg(200, 9)]);
    expect(r.tone).toBe('dark-text');
    expect(r.busy).toBe(false);
    expect(r.haloStrength).toBe('normal');
  });

  test('uniform dark band → light text, normal halo', () => {
    const r = analyzeZoneBand([seg(40, 10), seg(50, 12), seg(45, 8), seg(55, 9)]);
    expect(r.tone).toBe('light-text');
    expect(r.haloStrength).toBe('normal');
  });

  test('busy band (stdev above threshold) escalates to a strong halo', () => {
    const r = analyzeZoneBand([seg(120, 20), seg(130, 80), seg(125, 20), seg(128, 15)]);
    expect(r.busy).toBe(true);
    expect(r.haloStrength).toBe('strong');
  });

  test('stdev exactly at the threshold is NOT busy (strictly greater)', () => {
    const r = analyzeZoneBand([seg(120, OVERLAY.BUSY_STDEV)]);
    expect(r.busy).toBe(false);
  });

  test('tone follows the segments under the text block, not the full width', () => {
    // Bright outer segments, dark middle. A narrow centered text block sits
    // only over the dark middle → light text, even though the full-width
    // average would say dark ink.
    const segments = [seg(250, 5), seg(30, 5), seg(35, 5), seg(250, 5)];
    const narrow = analyzeZoneBand(segments, { textWidthFrac: 0.4 });
    expect(narrow.tone).toBe('light-text');
    const full = analyzeZoneBand(segments, { textWidthFrac: 1 });
    expect(full.tone).toBe(pickOverlayTone((250 + 30 + 35 + 250) / 4));
  });

  test('busy detection only counts segments under the text block', () => {
    // The chaos lives at the outer edges; the centered narrow block sits on
    // calm pixels → normal halo.
    const segments = [seg(120, 90), seg(120, 10), seg(120, 12), seg(120, 95)];
    expect(analyzeZoneBand(segments, { textWidthFrac: 0.4 }).busy).toBe(false);
    expect(analyzeZoneBand(segments, { textWidthFrac: 1 }).busy).toBe(true);
  });

  test('empty input degrades to the safe default (light text, normal halo)', () => {
    expect(analyzeZoneBand([])).toMatchObject({ tone: 'light-text', busy: false, haloStrength: 'normal', luminance: null });
    expect(analyzeZoneBand(null)).toMatchObject({ tone: 'light-text', haloStrength: 'normal' });
  });
});

describe('computeOverlayPlacement (gutter + safe bounds)', () => {
  test('left-page zones keep the fold (right edge) margin clear', () => {
    for (const zone of ['left-top', 'left-bottom', 'left']) {
      const p = computeOverlayPlacement({ pw: PW, ph: PH, zone, pad: 22 });
      expect(p.gutterSide).toBe('right');
      expect(p.xMax).toBeLessThanOrEqual(PW - PW * OVERLAY.GUTTER_FRAC);
      expect(p.xMin).toBeGreaterThanOrEqual(59); // SAFE(59) — outer bleed side stays in the safe area
    }
  });

  test('right-page zones keep the fold (left edge) margin clear', () => {
    for (const zone of ['right-top', 'right-bottom', 'right']) {
      const p = computeOverlayPlacement({ pw: PW, ph: PH, zone, pad: 22 });
      expect(p.gutterSide).toBe('left');
      expect(p.xMin).toBeGreaterThanOrEqual(PW * OVERLAY.GUTTER_FRAC);
      expect(p.xMax).toBeLessThanOrEqual(PW - 59);
    }
  });

  test('block height is capped at 55% of the page height from the anchor edge', () => {
    const p = computeOverlayPlacement({ pw: PW, ph: PH, zone: 'left-bottom', pad: 12 });
    expect(p.maxBlockH).toBeLessThanOrEqual(PH * OVERLAY.MAX_BLOCK_FRAC);
    expect(p.maxBlockH).toBeGreaterThan(0);
  });

  test('vertical anchor follows the zone', () => {
    expect(computeOverlayPlacement({ pw: PW, ph: PH, zone: 'right-bottom', pad: 22 }).vertical).toBe('bottom');
    expect(computeOverlayPlacement({ pw: PW, ph: PH, zone: 'left-top', pad: 22 }).vertical).toBe('top');
    expect(computeOverlayPlacement({ pw: PW, ph: PH, zone: null, pad: 22 }).vertical).toBe('top');
  });
});

describe('computeCaptionBlock size ladder', () => {
  // Width-proportional stub font — no pdf-lib needed for the pure math.
  const stubFont = { widthOfTextAtSize: (t, s) => t.length * s * 0.5 };
  const fonts = { helv: stubFont };
  const LONG = Array.from({ length: 8 }, (_, i) => `A rather long caption line number ${i}`).join('\n');

  test('keeps the primary size when the block fits', () => {
    const block = computeCaptionBlock(fonts, 'Short line.', 400, { maxH: 400 });
    expect(block.size).toBe(22);
  });

  test('steps the size down until a tall block fits maxH instead of overflowing', () => {
    const roomy = computeCaptionBlock(fonts, LONG, 400, { maxH: 10000 });
    const tight = computeCaptionBlock(fonts, LONG, 400, { maxH: roomy.blockH * 0.6 });
    expect(tight.size).toBeLessThan(roomy.size);
    expect(tight.blockH).toBeLessThan(roomy.blockH);
  });
});

describe('overlay contrast (WCAG-inspired advisory)', () => {
  test('contrastRatio is symmetric and ≥ 1', () => {
    expect(contrastRatio(255, 0)).toBeCloseTo(21, 0);
    expect(contrastRatio(0, 255)).toBeCloseTo(21, 0);
    expect(contrastRatio(128, 128)).toBeCloseTo(1, 5);
  });

  test('white type on a mid-gray band falls below the 4.5:1 floor', () => {
    expect(overlayContrastRatio('light-text', 128)).toBeLessThan(OVERLAY.MIN_CONTRAST);
  });

  test('white type on a dark band and dark ink on a light band both clear the floor', () => {
    expect(overlayContrastRatio('light-text', 40)).toBeGreaterThanOrEqual(OVERLAY.MIN_CONTRAST);
    expect(overlayContrastRatio('dark-text', 200)).toBeGreaterThanOrEqual(OVERLAY.MIN_CONTRAST);
  });
});

describe('assemblePdf overlayReport plumbing', () => {
  test('embedded entries report their overlay decision (buffer-less: defaults, not flagged)', async () => {
    const overlayReport = [];
    await assemblePdf([
      { type: 'spread', spread: 1, illustrationAspect: 'wide', textLayout: 'embedded', captionText: 'One.', textZone: 'right-bottom' },
      { type: 'spread', spread: 2, illustrationAspect: 'square', captionText: 'Caption page.' },
    ], 'picture_book', { title: 'T', childName: 'A', minPages: 2, overlayReport });
    // Only the embedded spread reports; without an art buffer the sampled
    // metrics stay null and the spread is not contrast-flagged.
    expect(overlayReport).toHaveLength(1);
    expect(overlayReport[0]).toMatchObject({
      spread: 1, zone: 'right-bottom', tone: 'light-text', haloStrength: 'normal', belowContrast: false,
    });
    expect(overlayReport[0].contrastRatio).toBeNull();
  });
});

describe('wrapTextBalanced (orphan control, 2026-07-18 print audit)', () => {
  const { wrapTextBalanced } = require('./../../services/layoutEngine');
  // 1 char = size*0.5 wide → at size 10, maxW 100 fits 20 chars per line.
  const stubFont = { widthOfTextAtSize: (t, s) => t.length * s * 0.5 };

  test('pulls a companion word down for a one-word orphan line', () => {
    // Greedy wrap of this at 20 chars/line ends in a single-word line.
    const lines = wrapTextBalanced('a map that hums green and gold', stubFont, 10, 100);
    expect(lines.length).toBeGreaterThan(1);
    const last = lines[lines.length - 1];
    expect(last.split(' ').length).toBeGreaterThanOrEqual(2);
    // No words lost or duplicated.
    expect(lines.join(' ')).toBe('a map that hums green and gold');
  });

  test('single-line input passes through untouched', () => {
    expect(wrapTextBalanced('short line', stubFont, 10, 1000)).toEqual(['short line']);
  });

  test('balances instead of stranding an orphan when the donor has only two words', () => {
    // Greedy would produce ["aaaaaaaaa bbbbbbbbb", "cc"]; the balanced DP
    // prefers the even split with no orphan at all.
    const lines = wrapTextBalanced('aaaaaaaaa bbbbbbbbb cc', stubFont, 10, 100);
    expect(lines).toEqual(['aaaaaaaaa', 'bbbbbbbbb cc']);
  });

  // Audit #2 T1: greedy wrapping left a short centered stub under nearly
  // every long line ("…spreads the star / map wide."). The DP must split
  // wrapped lines into near-equal widths.
  test('wrapped lines come out near-equal instead of full-then-stub', () => {
    const text = 'He sits on a flat rock and spreads the star map wide.';
    // 27 chars per line at size 10 / maxW 135.
    const lines = wrapTextBalanced(text, stubFont, 10, 135);
    expect(lines.length).toBeGreaterThan(1);
    const widths = lines.map((l) => stubFont.widthOfTextAtSize(l, 10));
    expect(Math.max(...widths)).toBeLessThanOrEqual(135);
    // No line is less than half the width of the widest line — the
    // staircase shape is gone.
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(Math.max(...widths) * 0.5);
    expect(lines.join(' ')).toBe(text);
  });

  test('never exceeds maxW and preserves all words', () => {
    const text = 'On his lap rests a star map with one blank spot ready';
    for (const maxW of [80, 110, 150, 400]) {
      const lines = wrapTextBalanced(text, stubFont, 10, maxW);
      for (const l of lines) expect(stubFont.widthOfTextAtSize(l, 10)).toBeLessThanOrEqual(Math.max(maxW, stubFont.widthOfTextAtSize(l.split(' ')[0], 10)));
      expect(lines.join(' ')).toBe(text);
    }
  });

  // 2026-07-28 audit (book 4c8daf08): the evenness-only DP shipped breaks
  // after articles/possessives — "His / robot rolls", "above the / hills" —
  // that stumble when read aloud. Real captions from that book: no wrapped
  // line may end with a function word.
  describe('function-word break penalty (2026-07-28 audit)', () => {
    const badEndings = require('./../../services/layoutEngine').BREAK_AVOID_WORDS;
    const shippedBadBreaks = [
      'His backpack bumps his shoulders. His robot rolls beside him, map lit green.',
      'A ringed planet hangs huge above the hills, bright enough to paint shadows.',
      'Now Amit understands the bridge hum and the leaf that folded shut.',
      'He does not find one message. He finds many, layered and bright and gentle.',
    ];
    for (const text of shippedBadBreaks) {
      test(`no line ends with a function word: "${text.slice(0, 40)}…"`, () => {
        for (const maxW of [120, 160, 200]) {
          const lines = wrapTextBalanced(text, stubFont, 10, maxW);
          expect(lines.join(' ')).toBe(text);
          // Every line except the last must not end on a glue word.
          for (const line of lines.slice(0, -1)) {
            const lastWord = line.split(' ').pop().toLowerCase().replace(/[^a-z']/g, '');
            expect(badEndings.has(lastWord)).toBe(false);
          }
        }
      });
    }

    test('an impossible measure still wraps (penalty is finite)', () => {
      // Only 4 chars per line: every word must sit alone, including "the".
      const lines = wrapTextBalanced('to the moon', stubFont, 10, 20);
      expect(lines.join(' ')).toBe('to the moon');
    });
  });
});

describe('chooseOverlayZone (subject-aware caption placement)', () => {
  const { chooseOverlayZone, zoneHeroOverlap } = require('./../../services/layoutEngine');

  test('no hero box → planned zone stands', () => {
    expect(chooseOverlayZone('left-top', null)).toMatchObject({ zone: 'left-top', relocated: false });
    expect(chooseOverlayZone('left-top', { x: NaN, y: 0, w: 0.2, h: 0.4 }).relocated).toBe(false);
  });

  test('hero clear of the planned band → planned zone stands', () => {
    // Hero on the right page, bottom half; caption planned left-top.
    const heroBox = { x: 0.6, y: 0.5, w: 0.2, h: 0.5 };
    const r = chooseOverlayZone('left-top', heroBox);
    expect(r.zone).toBe('left-top');
    expect(r.relocated).toBe(false);
  });

  test('hero filling the planned band relocates the caption (audit page 4: text across the face)', () => {
    // Hero centered on the left page, head in the top band.
    const heroBox = { x: 0.15, y: 0.05, w: 0.25, h: 0.85 };
    const r = chooseOverlayZone('left-top', heroBox);
    expect(r.relocated).toBe(true);
    expect(zoneHeroOverlap(r.zone, heroBox)).toBeLessThanOrEqual(zoneHeroOverlap('left-top', heroBox));
    // The chosen band must be tolerable, not merely better.
    expect(zoneHeroOverlap(r.zone, heroBox)).toBeLessThanOrEqual(OVERLAY.HERO_OVERLAP_MAX + 0.35);
  });

  test('relocation prefers the planned page half on an overlap tie', () => {
    // Hero occupies the whole TOP band across both pages — both bottom
    // bands are equally clear; the left (planned) page must win.
    const heroBox = { x: 0, y: 0, w: 1, h: OVERLAY.BAND_FRAC };
    const r = chooseOverlayZone('left-top', heroBox);
    expect(r.relocated).toBe(true);
    expect(r.zone).toBe('left-bottom');
  });

  test('bare "left"/"right" zones behave as their -top variants', () => {
    const heroBox = { x: 0, y: 0, w: 0.5, h: 0.4 }; // fills left-top band
    const r = chooseOverlayZone('left', heroBox);
    expect(r.relocated).toBe(true);
  });
});

// Book 36e79635 readability round: rounded upright overlay font, larger
// overlay size ladder, and an auto-scrim on busy/low-contrast bands.
describe('caption readability treatment (2026-07-20)', () => {
  const { shouldScrim } = require('./../../services/layoutEngine');
  const stub = (name) => ({ name, widthOfTextAtSize: (t, s) => t.length * s * 0.5 });

  // P4 (2026-07-23 audit): the scrim is now ALWAYS composited for embedded
  // captions (opacity auto-strengthens via scrimOpacityFor); shouldScrim is
  // true for every band, including the calm/unsampled cases.
  test('shouldScrim: always true (scrim always composited, opacity auto-strengthens)', () => {
    expect(shouldScrim({ busy: true, contrastRatio: 10 })).toBe(true);
    expect(shouldScrim({ busy: false, contrastRatio: OVERLAY.MIN_CONTRAST - 0.1 })).toBe(true);
    expect(shouldScrim({ busy: false, contrastRatio: OVERLAY.MIN_CONTRAST + 0.1 })).toBe(true);
    expect(shouldScrim(null)).toBe(true);
    expect(shouldScrim({ busy: false })).toBe(true);
  });

  test('overlay font priority prefers the rounded upright face; caption pages keep the serif', () => {
    const fonts = { bubblegum: stub('bubblegum'), playfair: stub('playfair'), playfairItalic: stub('playfairItalic'), helv: stub('helv') };
    const overlay = computeCaptionBlock(fonts, 'Hello there.', 400, { fontPriority: 'overlay' });
    expect(overlay.font.name).toBe('bubblegum');
    const captionPage = computeCaptionBlock(fonts, 'Hello there.', 400);
    expect(captionPage.font.name).toBe('playfairItalic');
  });

  test('sizes opt drives the ladder (overlay runs one notch larger)', () => {
    const fonts = { helv: stub('helv') };
    const big = computeCaptionBlock(fonts, 'Short.', 400, { sizes: [24, 20, 18, 16] });
    expect(big.size).toBe(24);
    const dflt = computeCaptionBlock(fonts, 'Short.', 400);
    expect(dflt.size).toBe(22);
  });
});

describe('textEmbeddedInArt (ce-2: Gemini-painted story text)', () => {
  const { buildEmbeddedPreviewPdf } = require('./../../services/layoutEngine');

  test('a flagged entry embeds art only — no overlay planning, no typeset caption', async () => {
    const { buffer, report } = await buildEmbeddedPreviewPdf([
      { type: 'spread', spread: 5, textLayout: 'embedded', captionText: 'Hello.', textEmbeddedInArt: true, spreadIllustrationBuffer: null },
      { type: 'spread', spread: 7, textLayout: 'embedded', captionText: 'World.', spreadIllustrationBuffer: null },
    ]);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(report).toHaveLength(2);
    expect(report[0]).toEqual({ spread: 5, textEmbeddedInArt: true });
    // The unflagged control entry still runs the full overlay pass.
    expect(report[1].spread).toBe(7);
    expect(report[1].zone).toBeDefined();
    expect(report[1].textEmbeddedInArt).toBeUndefined();
  });
});
