/**
 * The coloring book's SET gates (cb-1, docs/COLORING_BOOK_V2_PLAN.md §4.7)
 * — the pages held to each other after every page passed on its own:
 *
 *  1. CONTACT-SHEET GATE: the child crops of every child-bearing page tiled
 *     beside the hero LINE-ART model sheet in one image (the illustrator's
 *     contactSheet.js tiler), judged for pages whose child reads as a
 *     different character (hair shape/length, proportions, outfit cut — no
 *     colours exist here); the same for the companion crops beside the
 *     companion line sheet. Flagged pages re-render once (the caller).
 *  2. STROKE-WEIGHT GATE: every page's measured stroke width vs the book's
 *     OWN median (the ce-18 ink-set-gate shape applied to line weight) —
 *     outliers beyond the tolerance re-render with a note restating the
 *     target. Pure arithmetic over metrics.js numbers.
 *
 * Both fail open: an unavailable judge or fewer than two pages is a null
 * verdict, never a failed book.
 */

const sharp = require('sharp');
const { buildContactSheet } = require('../illustrator/contactSheet');
const { cropBbox } = require('../illustrator/metrics');
const flags = require('../flags');
const { judgeJson, qaData } = require('./pageQa');

const STROKE_TOLERANCE = 0.35;
const MAX_TILES = 24;
const MAX_FLAGGED_NOTE = 160;
const CONTACT_DEFECTS = Object.freeze({ hero: 'character_rendering', companion: 'companion_rendering' });

/**
 * The child (or companion) tile for one page: the bbox crop when the
 * verdict gave one, else the whole page (flagged `cropped: false`).
 * @param {Buffer} buffer
 * @param {object|null} bbox
 * @returns {Promise<{buffer: Buffer, cropped: boolean}|null>}
 */
async function tileFor(buffer, bbox) {
  if (!Buffer.isBuffer(buffer)) return null;
  const crop = bbox ? await cropBbox(buffer, bbox, { pad: 0.06, size: 512 }) : null;
  if (crop) return { buffer: crop, cropped: true };
  try {
    const whole = await sharp(buffer).resize({ width: 512, height: 512, fit: 'inside' }).png().toBuffer();
    return { buffer: whole, cropped: false };
  } catch (err) {
    return null;
  }
}

/**
 * The contact-sheet judge prompt for one subject.
 * @param {{subject: 'hero'|'companion', pages: number[], name: string, outfitSpecText?: string|null, columns: number}} o
 * @returns {string}
 */
function contactPrompt(o) {
  const who = o.subject === 'hero' ? `the child hero "${qaData(o.name, 40)}"` : `the companion "${qaData(o.name, 40)}"`;
  return [
    `You are checking CONSISTENCY across the pages of a children's COLORING BOOK (black line art on white). The image is a contact sheet, ${o.columns} tiles per row, each tile labelled: the first tile is the LINE-ART REFERENCE SHEET of ${who}; the other tiles are crops of ${who} from pages ${o.pages.join(', ')} (a tile labelled FULL is the whole page).`,
    o.subject === 'hero'
      ? `Flag a page ONLY when its child clearly reads as a DIFFERENT character than the reference: a different hair shape or length, different face or proportions or apparent age, or a different outfit cut, garment set or pattern${o.outfitSpecText ? ` (the fixed outfit, colours removed: "${qaData(o.outfitSpecText, 500)}")` : ''}. Colours do not exist in line art — never flag colour. Pose, expression and setting differ by design.`
      : 'Flag a page ONLY when its companion clearly reads as a DIFFERENT design than the reference: different proportions, features, markings or outfit. Pose and setting differ by design.',
    '',
    'Answer STRICT JSON only:',
    `{ "pages": [ ${o.pages.map(p => `{ "page": ${p}, "flag": true|false, "note": "…" }`).join(', ')} ] }`,
  ].join('\n');
}

/**
 * One contact check (hero or companion).
 * @param {object} o {subject, tiles:[{page, buffer, cropped}], reference:{buffer}, name, outfitSpecText, label, costTracker}
 * @returns {Promise<{pass: boolean, flagged: Array<{page: number, defect: string, note: string}>, checked: number, qaUnavailable?: string}|null>}
 */
async function runContactCheck(o) {
  const tiles = (o.tiles || []).filter(t => t && Number.isInteger(t.page) && Buffer.isBuffer(t.buffer)).sort((a, b) => a.page - b.page).slice(0, MAX_TILES);
  if (tiles.length < 2) return null;
  if (!o.reference || !Buffer.isBuffer(o.reference.buffer)) return { pass: true, flagged: [], checked: tiles.length, qaUnavailable: 'reference sheet unavailable' };
  const pages = tiles.map(t => t.page);
  try {
    const sheet = await buildContactSheet(tiles.map(t => ({ label: t.cropped ? `PAGE ${t.page}` : `PAGE ${t.page} (FULL)`, buffer: t.buffer })), { reference: { label: 'REFERENCE', buffer: o.reference.buffer } });
    const jpeg = await sharp(sheet).jpeg({ quality: 88 }).toBuffer();
    const answer = await judgeJson([{ text: contactPrompt({ subject: o.subject, pages, name: o.name, outfitSpecText: o.outfitSpecText, columns: 4 }) }, { inline_data: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }], { label: o.label, costTracker: o.costTracker });
    if (answer.unavailable) return { pass: true, flagged: [], checked: tiles.length, qaUnavailable: answer.unavailable };
    const list = Array.isArray(answer.json.pages) ? answer.json.pages : null;
    if (!list) return { pass: true, flagged: [], checked: tiles.length, qaUnavailable: 'contact QA returned a malformed verdict' };
    const flagged = [];
    for (const e of list) {
      if (!e || typeof e !== 'object' || !Number.isInteger(e.page) || !pages.includes(e.page) || e.flag !== true) continue;
      if (flagged.some(f => f.page === e.page)) continue;
      flagged.push({ page: e.page, defect: CONTACT_DEFECTS[o.subject], note: qaData(e.note, MAX_FLAGGED_NOTE) });
    }
    return { pass: flagged.length === 0, flagged, checked: tiles.length };
  } catch (err) {
    return { pass: true, flagged: [], checked: tiles.length, qaUnavailable: `contact QA errored: ${err.message}` };
  }
}

/**
 * Run both contact checks over the book's pages.
 * @param {object} p
 * @param {Array<{index: number, buffer: Buffer, childBbox?: object|null, companionBbox?: object|null, expectsChild: boolean, expectsCompanion: boolean}>} p.pages
 * @param {{buffer: Buffer}|null} p.heroLineSheet
 * @param {{buffer: Buffer}|null} [p.companionLineSheet]
 * @param {string} [p.name] child name
 * @param {string|null} [p.companionName]
 * @param {string|null} [p.outfitSpecText]
 * @param {object} [p.costTracker]
 * @returns {Promise<{hero: object|null, companion: object|null}>}
 */
async function runColoringContactGate(p) {
  if (!flags.coloringContactQaEnabled()) return { hero: null, companion: null };
  const heroTiles = [];
  const companionTiles = [];
  for (const pg of p.pages || []) {
    if (pg.expectsChild && pg.kind !== 'meet') {
      const t = await tileFor(pg.buffer, pg.childBbox || null);
      if (t) heroTiles.push({ page: pg.index, ...t });
    }
    if (pg.expectsCompanion) {
      const t = await tileFor(pg.buffer, pg.companionBbox || null);
      if (t) companionTiles.push({ page: pg.index, ...t });
    }
  }
  const hero = await runContactCheck({ subject: 'hero', tiles: heroTiles, reference: p.heroLineSheet, name: p.name || 'the child', outfitSpecText: p.outfitSpecText || null, label: 'coloringContact:hero', costTracker: p.costTracker });
  const companion = p.companionName && companionTiles.length >= 2
    ? await runContactCheck({ subject: 'companion', tiles: companionTiles, reference: p.companionLineSheet || null, name: p.companionName, label: 'coloringContact:companion', costTracker: p.costTracker })
    : null;
  return { hero, companion };
}

/**
 * The stroke-weight set gate. Pure.
 * @param {{pages: Array<{index: number, metrics: {strokeWidthPercent?: number|null}|null}>, tolerance?: number}} p
 * @returns {{pass: boolean, median: number|null, outliers: Array<{page: number, strokeWidthPercent: number, ratio: number}>, checked: number}|null}
 *   null when disabled or fewer than 3 measured pages
 */
function runStrokeGate(p) {
  if (!flags.coloringStrokeGateEnabled()) return null;
  const tol = typeof p.tolerance === 'number' && p.tolerance > 0 ? p.tolerance : STROKE_TOLERANCE;
  const measured = (p.pages || []).filter(pg => pg && pg.metrics && typeof pg.metrics.strokeWidthPercent === 'number' && Number.isFinite(pg.metrics.strokeWidthPercent) && pg.metrics.strokeWidthPercent > 0);
  if (measured.length < 3) return null;
  const sorted = measured.map(pg => pg.metrics.strokeWidthPercent).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const outliers = measured
    .map(pg => ({ page: pg.index, strokeWidthPercent: pg.metrics.strokeWidthPercent, ratio: Math.round((pg.metrics.strokeWidthPercent / median) * 100) / 100 }))
    .filter(o => Math.abs(o.ratio - 1) > tol)
    .sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1));
  return { pass: outliers.length === 0, median: Math.round(median * 10000) / 10000, outliers, checked: measured.length };
}

/**
 * The corrective suffix for a gate re-render (fixed template lines).
 * @param {{defect: string, note?: string, heroRef?: number|null, companionRef?: number|null, name?: string, companionName?: string|null, outfitSpecText?: string|null, medianStrokePercent?: number|null}} o
 * @returns {string}
 */
function gateRepairNote(o) {
  if (o.defect === 'character_rendering') {
    return `CONSISTENCY REPAIR: on the other pages of this book ${qaData(o.name || 'the child', 40)} is drawn EXACTLY as ${Number.isInteger(o.heroRef) ? `REFERENCE ${o.heroRef}` : 'the LINE-ART MODEL SHEET'} — the same hair shape and length, face, proportions and outfit cut${o.outfitSpecText ? ` ("${qaData(o.outfitSpecText, 400)}")` : ''}. Match them${o.note ? ` (the difference seen: ${qaData(o.note, 120)})` : ''}. Keep the scene otherwise identical.`;
  }
  if (o.defect === 'companion_rendering') {
    return `CONSISTENCY REPAIR: on the other pages ${qaData(o.companionName || 'the companion', 40)} is drawn EXACTLY as ${Number.isInteger(o.companionRef) ? `REFERENCE ${o.companionRef}` : 'its reference sheet'} — the same design, proportions and features. Match them${o.note ? ` (the difference seen: ${qaData(o.note, 120)})` : ''}. Keep the scene otherwise identical.`;
  }
  if (o.defect === 'stroke_weight') {
    return `STROKE REPAIR: the other pages of this book draw their main outlines at about ${Number(o.medianStrokePercent || 0).toFixed(2)}% of the image width — match that weight exactly: even, confident lines, not hairlines, not heavy marker. Keep the drawing otherwise identical.`;
  }
  return '';
}

module.exports = { STROKE_TOLERANCE, CONTACT_DEFECTS, tileFor, contactPrompt, runContactCheck, runColoringContactGate, runStrokeGate, gateRepairNote };
