/**
 * LINE_RULES — the pinned line-art spec of the coloring book (cb-1,
 * docs/COLORING_BOOK_V2_PLAN.md §4.4), the TEXT_RULES pattern applied to
 * strokes: one frozen spec per age band stating the stroke weight, the
 * detail floor, the subject count, the background density, the smallest
 * colourable area and the inner margin in the model's own terms, rendered
 * into FIXED prompt blocks that ride every page render and every line-sheet
 * render. The same numbers are what metrics.js measures against, so prompt
 * and check can never disagree.
 *
 * Editing anything here changes pixels ⇒ bump COLORING_VERSION (versions.js).
 * Pure module: no I/O, no model calls.
 */

const { fnv1a } = require('../selection');

/** Catalog band keys the spec is pinned for. */
const BANDS = ['1-3', '4-5', '6-7', '8-10'];

/**
 * The spec per band. Strokes are percentages of the IMAGE WIDTH (the unit
 * an image model perceives); `inkMin`/`inkMax` are the black-pixel fraction
 * bounds metrics.js holds a page to; `margin` is the clear inner band
 * nothing may cross (also the layout's crop protection).
 */
const LINE_RULES_BY_BAND = Object.freeze({
  '1-3': Object.freeze({ band: '1-3', primaryStrokePercent: 1.1, detailStrokePercent: 0.7, subjects: 'ONE subject', background: 'almost no background — at most one or two large, simple shapes', smallestAreaPercent: 4, marginPercent: 6, inkMin: 0.03, inkMax: 0.14 }),
  '4-5': Object.freeze({ band: '4-5', primaryStrokePercent: 0.9, detailStrokePercent: 0.55, subjects: 'one or two subjects', background: 'a few large, simple background shapes', smallestAreaPercent: 2, marginPercent: 5, inkMin: 0.03, inkMax: 0.14 }),
  '6-7': Object.freeze({ band: '6-7', primaryStrokePercent: 0.7, detailStrokePercent: 0.4, subjects: 'two or three subjects', background: 'a simple full scene', smallestAreaPercent: 1, marginPercent: 5, inkMin: 0.04, inkMax: 0.16 }),
  '8-10': Object.freeze({ band: '8-10', primaryStrokePercent: 0.55, detailStrokePercent: 0.3, subjects: 'three or more subjects', background: 'a detailed scene', smallestAreaPercent: 0.5, marginPercent: 4, inkMin: 0.04, inkMax: 0.16 }),
});

/**
 * Resolve the spec for a band (unknown/missing ⇒ the 4-5 spec, the
 * middle of the catalog — never a throw: a pinned legacy definition still
 * gets a coloring book).
 * @param {string|null|undefined} band catalog band key
 * @returns {object} frozen spec
 */
function resolveLineRules(band) {
  return LINE_RULES_BY_BAND[band] || LINE_RULES_BY_BAND['4-5'];
}

/**
 * The fixed LINE ART RULES block for one band.
 * @param {object} rules resolveLineRules(band)
 * @returns {string}
 */
function renderLineRulesBlock(rules) {
  const r = rules || resolveLineRules(null);
  return [
    'LINE ART RULES (fixed for every page of this coloring book):',
    `- Clean, confident INK LINE ART for a premium children's coloring book: smooth, continuous outlines of even weight — about ${r.primaryStrokePercent}% of the image width (a young child colours with a crayon), never hairlines.`,
    `- A few lighter interior lines (never thinner than ${r.detailStrokePercent}% of the image width) give each area character: a fold, an eye, a leaf vein — then stop.`,
    '- EVERY shape is CLOSED so colour cannot leak; no gaps in outlines.',
    '- PURE BLACK lines on PURE WHITE paper. NO shading, hatching, cross-hatching, stippling, screentone, grey, gradient, texture, wash, or soft edge anywhere.',
    '- NO solid black areas except tiny accents (pupils). Hair, fur, dark clothing, shadows and night skies are drawn as OUTLINED shapes left WHITE inside.',
    `- Large colourable areas: no colourable region smaller than about ${r.smallestAreaPercent}% of the page; ${r.subjects}; ${r.background}.`,
    '- Rounded, friendly storybook proportions that match the reference character exactly (same head-to-body ratio, same hair shape and length, same outfit cut).',
  ].join('\n');
}

/** Closed shot-size vocabulary for the coloring pages (shotPlan's shape). */
const SHOTS = ['wide', 'medium', 'close'];
/** Band 1-3 menu: no wide scenes (one big subject, big shapes). */
const SHOTS_YOUNG = ['medium', 'close'];
/** Closed placement vocabulary. */
const PLACEMENTS = ['centred', 'in the left third', 'in the right third'];

const SHOT_TEXT = Object.freeze({
  wide: 'a WIDE view — the whole setting visible, the subject small enough to show the place around it',
  medium: 'a MEDIUM view — the subject seen full-length, head to toe, filling most of the page height',
  close: 'a CLOSE view — the subject large and near, filling the page, only a hint of setting behind it',
});

/**
 * The fixed PAGE COMPOSITION block: the assigned shot size + placement,
 * the inner margin, and the no-frame rule.
 * @param {{shot: string, placement: string, rules: object}} p
 * @returns {string}
 */
function renderCompositionBlock({ shot, placement, rules }) {
  const r = rules || resolveLineRules(null);
  const shotLine = SHOT_TEXT[shot] || SHOT_TEXT.medium;
  const place = PLACEMENTS.includes(placement) ? placement : PLACEMENTS[0];
  return [
    'PAGE COMPOSITION (assigned — do not choose another):',
    `- ${shotLine}; the main subject ${place}.`,
    '- ONE clear main subject; the environment simple; nothing crowded; nothing cut off by the edges.',
    `- Keep about ${r.marginPercent}% clear inside EVERY edge — no line touches the border of the image.`,
    '- No drawn frame, border, vignette, or panel around the picture; the drawing sits on open white paper.',
    '- PORTRAIT page, 3:4 — taller than wide.',
  ].join('\n');
}

/** The fixed NO TEXT block. */
const NO_TEXT_BLOCK = [
  'NO TEXT: absolutely no letters, words, numbers, signs, labels, logos, speech bubbles or writing of any kind anywhere in the image — a sign, banner, book or screen in the scene is BLANK.',
].join('\n');

/** The fixed FINAL CHECK block — the four things the judge measures. */
const FINAL_CHECK_BLOCK = [
  'FINAL CHECK before you finish: (1) black lines on white only — no grey, no shading, no fills; (2) every shape closed; (3) no text or letters anywhere; (4) the reference character\'s face, hair and outfit exactly as the LINE-ART MODEL SHEET.',
].join('\n');

/**
 * Content hash of the whole spec (every band + every fixed block) — folded
 * into the plan hash so a spec edit re-keys every page even before the
 * version bump lands.
 * @returns {string}
 */
function lineRulesHash() {
  const blocks = BANDS.map(b => renderLineRulesBlock(LINE_RULES_BY_BAND[b]) + renderCompositionBlock({ shot: 'medium', placement: PLACEMENTS[0], rules: LINE_RULES_BY_BAND[b] }));
  return fnv1a(JSON.stringify({ spec: LINE_RULES_BY_BAND, blocks, NO_TEXT_BLOCK, FINAL_CHECK_BLOCK })).toString(36);
}

module.exports = {
  BANDS,
  LINE_RULES_BY_BAND,
  SHOTS,
  SHOTS_YOUNG,
  PLACEMENTS,
  SHOT_TEXT,
  NO_TEXT_BLOCK,
  FINAL_CHECK_BLOCK,
  resolveLineRules,
  renderLineRulesBlock,
  renderCompositionBlock,
  lineRulesHash,
};
