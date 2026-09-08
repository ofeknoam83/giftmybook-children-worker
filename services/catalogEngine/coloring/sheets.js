/**
 * The line-art sheets (cb-1, docs/COLORING_BOOK_V2_PLAN.md §4.3) — identity
 * as LINE ART, pinned once:
 *
 *  1. HERO LINE SHEET — the elected colour character model sheet redrawn as
 *     coloring-book line art (same three views, same outfit garment by
 *     garment, no shading, no text), best-of-N candidates each measured
 *     (metrics.js) and judged against the colour sheet (pageQa.js
 *     checkLineSheet), elected per anchor + colour-sheet hash in GCS with
 *     the character sheet's create-if-absent single-winner discipline.
 *     REQUIRED by default: no passing candidate throws
 *     `coloring_identity_failed` (CATALOG_COLORING_SHEET_REQUIRED=0 lets the
 *     caller degrade to the colour sheet with an advisory).
 *  2. COMPANION LINE SHEET — the companion's colour sheet redrawn the same
 *     way, pinned per theme + companion hash. Fail-open (null).
 *  3. BORDER PLATE — a decorative frame of the theme's world motifs, empty
 *     centre, pinned per theme + prompt hash. Fail-open (null).
 *
 * Every sheet's hash folds into the plan hash, so a re-elected sheet
 * re-keys every page. A sheet nothing verified is never elected.
 */

const { callGeminiImageParts } = require('../../illustrationGenerator');
const { downloadBuffer, uploadBuffer, uploadBufferIfAbsent } = require('../../gcsStorage');
const { COLORING_VERSION } = require('../versions');
const { fnv1a } = require('../selection');
const { getWorldCard } = require('../worldCards');
const flags = require('../flags');
const { measureLineArt, cleanLineArt } = require('./metrics');
const { checkLineSheet } = require('./pageQa');
const { renderLineRulesBlock, NO_TEXT_BLOCK, resolveLineRules } = require('./lineRules');
const { imageModelKey, stripColourWords } = require('./render');
const { inert } = require('./moments');

/**
 * Garment lettering in LINE ART (2026-09-08): the colour sheet may carry a
 * logo, patch, badge, name or number on a garment (an astronaut suit's
 * emblem and flag patch); the line sheet keeps the SHAPE — a blank outline
 * to colour — and drops the letters, so the pages that copy it never carry
 * readable text and the outfit still matches garment by garment.
 */
const GARMENT_LETTERING_LINE_ART_RULE = 'GARMENT LETTERING: a logo, patch, badge, label, name or number on a garment in REFERENCE IMAGE 1 keeps its OUTLINE SHAPE (the patch, the badge, the label — a blank shape to colour) and loses its letters; that blank shape is the same garment, never readable text, and never invent lettering.';
const SHEET_TIMEOUT_MS = 180000;
const SHEET_ASPECT = '16:9';
const BORDER_ASPECT = '3:4';
const FAILURE_CODE = 'coloring_identity_failed';
const CACHE_MAX = 16;
const _cache = new Map();
const _inFlight = new Map();

/** Deterministic paths. */
function heroLineSheetPath(anchorHash, sheetHash) { return `catalog-assets/coloring-sheets/${COLORING_VERSION}/${anchorHash}-${String(sheetHash || 'nosheet').slice(0, 8)}.png`; }
function companionLineSheetPath(themeId, hash) { return `catalog-assets/coloring-companions/${COLORING_VERSION}/${themeId}-${hash}.png`; }
function borderPlatePath(themeId, hash) { return `catalog-assets/coloring-borders/${COLORING_VERSION}/${themeId}-${hash}.png`; }
const sidecarPath = png => png.replace(/\.png$/, '.json');

/** @param {string} key @returns {object|null} LRU get */
function cacheGet(key) {
  if (!_cache.has(key)) return null;
  const v = _cache.get(key);
  _cache.delete(key);
  _cache.set(key, v);
  return v;
}
/** @param {string} key @param {object} value LRU set */
function cacheSet(key, value) {
  _cache.delete(key);
  _cache.set(key, value);
  while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
}
/** Tests only. */
function resetSheetCache() { _cache.clear(); _inFlight.clear(); }

/**
 * Package elected bytes.
 * @param {Buffer} buffer @param {string} storageKey @param {object} meta
 * @returns {object}
 */
function toSheet(buffer, storageKey, meta = {}) {
  const base64 = buffer.toString('base64');
  return { base64, mimeType: 'image/png', hash: fnv1a(base64).toString(36), storageKey, likeness: meta.likeness ?? null, candidates: meta.candidates ?? null, advisories: Array.isArray(meta.advisories) ? meta.advisories : [] };
}

/** Parse a sidecar we wrote (still data). @param {Buffer|null} raw @returns {object} */
function parseSidecar(raw) {
  if (!raw) return {};
  try {
    const j = JSON.parse(raw.toString('utf8'));
    if (!j || typeof j !== 'object') return {};
    const out = {};
    if (typeof j.likeness === 'number' && Number.isFinite(j.likeness)) out.likeness = Math.min(1, Math.max(0, j.likeness));
    if (Number.isInteger(j.candidates) && j.candidates > 0) out.candidates = j.candidates;
    return out;
  } catch (err) { return {}; }
}

/**
 * Resolve an elected asset: cache → GCS → produce + create-if-absent.
 * @param {{key: string, pngPath: string, produce: () => Promise<{buffer: Buffer, likeness: number|null, candidates: number, advisories: Array<object>}>, log: Function}} p
 * @returns {Promise<object>} sheet record
 */
async function electAsset({ key, pngPath, produce, log }) {
  const hit = cacheGet(key);
  if (hit) return { ...hit, advisories: hit.advisories.map(a => ({ ...a })) };
  if (_inFlight.has(key)) return _inFlight.get(key);
  const task = (async () => {
    try {
      const cached = await downloadBuffer(pngPath).catch(() => null);
      if (cached && cached.length > 0) {
        const meta = parseSidecar(await downloadBuffer(sidecarPath(pngPath)).catch(() => null));
        const sheet = toSheet(cached, pngPath, meta);
        cacheSet(key, sheet);
        return sheet;
      }
      const produced = await produce();
      let buffer = produced.buffer;
      let meta = { likeness: produced.likeness, candidates: produced.candidates, advisories: produced.advisories };
      const { created } = await uploadBufferIfAbsent(buffer, pngPath, 'image/png');
      if (created) {
        await uploadBuffer(Buffer.from(JSON.stringify({ hash: fnv1a(buffer.toString('base64')).toString(36), likeness: meta.likeness, candidates: meta.candidates, coloringVersion: COLORING_VERSION, electedAt: new Date().toISOString() })), sidecarPath(pngPath), 'application/json').catch(err => log('warn', `sheet sidecar write failed (${err.message})`));
      } else {
        log('info', `${key}: created concurrently — adopting the winning object`);
        buffer = await downloadBuffer(pngPath);
        meta = { ...parseSidecar(await downloadBuffer(sidecarPath(pngPath)).catch(() => null)), advisories: [...meta.advisories, { stage: 'coloringSheet', note: 'adopted the concurrently elected sheet' }] };
      }
      const sheet = toSheet(buffer, pngPath, meta);
      cacheSet(key, sheet);
      return sheet;
    } finally {
      _inFlight.delete(key);
    }
  })();
  _inFlight.set(key, task);
  return task;
}

/**
 * Render one sheet candidate through the shared transport.
 * @param {{prompt: string, references: Array<{label: string, base64: string, mimeType?: string}>, aspectRatio: string, imageSize: string|null, costTracker?: object, label: string}} p
 * @returns {Promise<Buffer>}
 */
async function renderSheetCandidate(p) {
  const parts = [{ text: p.prompt }];
  p.references.forEach((r, i) => {
    parts.push({ text: `REFERENCE IMAGE ${i + 1} — ${r.label}` });
    parts.push({ inline_data: { mimeType: r.mimeType || 'image/png', data: r.base64 } });
  });
  const buffer = await callGeminiImageParts(parts, { aspectRatio: p.aspectRatio, imageSize: p.imageSize, timeoutMs: SHEET_TIMEOUT_MS, label: p.label });
  if (p.costTracker) p.costTracker.addImageGeneration(imageModelKey(p.imageSize), 1);
  return buffer;
}

/**
 * Produce, measure, judge and elect N candidates. Returns the winner or
 * throws an Error carrying every candidate's outcome in `advisories`.
 * @param {object} p {kind, prompt, references, aspectRatio, rules, reference (for the judge), outfitSpecText, companion, costTracker, log, label}
 * @returns {Promise<{buffer: Buffer, likeness: number, candidates: number, advisories: Array<object>}>}
 */
async function produceElected(p) {
  const n = flags.coloringSheetCandidates();
  const imageSize = flags.coloringImageSize();
  const results = await Promise.all(Array.from({ length: n }, async (_, i) => {
    const idx = i + 1;
    let raw;
    try {
      raw = await renderSheetCandidate({ prompt: p.prompt, references: p.references, aspectRatio: p.aspectRatio, imageSize, costTracker: p.costTracker, label: `${p.label}:c${idx}` });
    } catch (err) {
      return { idx, error: err.message };
    }
    const cleaned = await cleanLineArt(raw, { despeckle: flags.coloringDespeckleEnabled() });
    const metrics = await measureLineArt(cleaned.buffer, { rules: p.rules });
    if (metrics.blocking.length > 0) return { idx, buffer: cleaned.buffer, rejected: metrics.blocking.join('; ') };
    const verdict = await checkLineSheet(cleaned.buffer, { kind: p.kind, reference: p.reference, outfitSpecText: p.outfitSpecText, companion: p.companion, label: `${p.label}:qa${idx}`, costTracker: p.costTracker });
    if (verdict.unverifiable) return { idx, buffer: cleaned.buffer, unverifiable: verdict.unverifiable };
    if (!verdict.pass) return { idx, buffer: cleaned.buffer, rejected: verdict.defects.join('; '), likeness: verdict.likeness };
    return { idx, buffer: cleaned.buffer, likeness: verdict.likeness, pass: true };
  }));
  const advisories = [];
  for (const r of results) {
    if (r.error) { p.log('warn', `${p.label} candidate ${r.idx}: generation failed (${r.error})`); advisories.push({ stage: 'coloringSheet', note: `${p.kind} sheet candidate ${r.idx} generation failed: ${r.error}` }); }
    else if (r.unverifiable) { p.log('warn', `${p.label} candidate ${r.idx}: UNVERIFIABLE (${r.unverifiable})`); advisories.push({ stage: 'coloringSheet', note: `${p.kind} sheet candidate ${r.idx} unverifiable: ${r.unverifiable}` }); }
    else if (r.rejected) { p.log('info', `${p.label} candidate ${r.idx}: REJECTED (${r.rejected})`); advisories.push({ stage: 'coloringSheet', note: `${p.kind} sheet candidate ${r.idx} rejected: ${r.rejected}` }); }
    else p.log('info', `${p.label} candidate ${r.idx}: PASS (likeness ${r.likeness.toFixed(2)})`);
  }
  const passing = results.filter(r => r.pass);
  if (passing.length === 0) {
    const err = new Error(`${p.kind} line sheet failed: no candidate passed (${advisories.map(a => a.note).join(' | ') || 'no candidates'})`);
    err.failureCode = FAILURE_CODE;
    err.advisories = advisories;
    throw err;
  }
  const winner = passing.reduce((best, r) => (r.likeness > best.likeness ? r : best), passing[0]);
  return { buffer: winner.buffer, likeness: winner.likeness, candidates: n, advisories };
}

/**
 * The hero line-sheet prompt.
 * @param {{outfitSpecText: string|null, name: string, rules: object}} p
 * @returns {string}
 */
function buildHeroSheetPrompt(p) {
  const spec = stripColourWords(p.outfitSpecText);
  return [
    `Redraw REFERENCE IMAGE 1 — the CHARACTER MODEL SHEET of the child ${inert(p.name, 40) || 'hero'} — as a clean coloring-book LINE-ART model sheet of the SAME child.`,
    'Keep EXACTLY: the same THREE full-body views side by side in the same order (front, three-quarter, back), the same proportions and apparent age, the same face, the same hair shape and length, feet and shoes fully visible, and the same complete outfit in every view, garment by garment' + (spec ? `: ${spec}` : '.'),
    'Keep the two small head insets. Flat, pure-white background — no scene, no floor line, no shadow, no frame.',
    'REFERENCE IMAGE 2 (when present) is the approved cover — an identity aid only; never copy its scene.',
    GARMENT_LETTERING_LINE_ART_RULE,
    '',
    renderLineRulesBlock(p.rules),
    '',
    NO_TEXT_BLOCK,
    'LANDSCAPE 16:9 sheet.',
  ].join('\n');
}

/**
 * The companion line-sheet prompt.
 * @param {{companion: {name: string, type?: string, specText?: string|null, human?: boolean}, rules: object}} p
 * @returns {string}
 */
function buildCompanionSheetPrompt(p) {
  const c = p.companion;
  const spec = stripColourWords(c.specText);
  return [
    `Redraw REFERENCE IMAGE 1 — the reference sheet of ${inert(c.name, 40)}, a ${inert(c.type, 60) || 'companion'} — as a clean coloring-book LINE-ART reference sheet of the SAME ${c.human ? 'person' : 'character'}.`,
    `Keep EXACTLY the same views, design, proportions${c.human ? ', face, hair shape and length, and the same complete outfit garment by garment' : ' and markings'}${spec ? ` — fixed look (data): ${spec}` : ''}. No child, no scene; flat pure-white background.`,
    GARMENT_LETTERING_LINE_ART_RULE,
    '',
    renderLineRulesBlock(p.rules),
    '',
    NO_TEXT_BLOCK,
    'LANDSCAPE 16:9 sheet.',
  ].join('\n');
}

/**
 * The border-plate prompt.
 * @param {{theme: object, rules: object}} p
 * @returns {string}
 */
function buildBorderPrompt(p) {
  const theme = p.theme || {};
  const card = (getWorldCard(theme.theme_id) || []).filter(l => !/^\s*palette/i.test(l));
  return [
    `A decorative coloring-book BORDER FRAME for the story world "${inert(theme.world_name, 60)}"${theme.display_name ? ` (${inert(theme.display_name, 40)})` : ''}: a rectangular frame of the world's motifs — its plants, objects, tools, buildings and small creatures${theme.companion && theme.companion.type ? ` (a ${inert(theme.companion.type, 60)} may appear as a small motif)` : ''} — repeating evenly around ALL FOUR edges of a portrait page, about one tenth of the page wide.`,
    'The CENTRE of the page is completely EMPTY white — nothing drawn there. No people, no child. No scene.',
    ...(card.length ? ['World facts (fixed): ', ...card.map(l => `- ${l}`)] : []),
    '',
    renderLineRulesBlock(p.rules),
    '',
    NO_TEXT_BLOCK,
    'PORTRAIT 3:4 page.',
  ].join('\n');
}

/**
 * The hero line sheet for one anchor (REQUIRED by default).
 * @param {object} p
 * @param {string} p.anchorHash the identity anchor's path hash
 * @param {{base64: string, mimeType?: string, hash: string}} p.colourSheet the elected character model sheet
 * @param {{base64: string, mimeType?: string}|null} [p.cover] the approved cover bytes
 * @param {string|null} [p.outfitSpecText]
 * @param {{name?: string}} [p.profile]
 * @param {string} [p.ageBand]
 * @param {object} [p.costTracker]
 * @param {(level: string, msg: string) => void} [p.log]
 * @returns {Promise<object>} sheet record
 * @throws {Error} `failureCode = 'coloring_identity_failed'` (+ advisories) when no candidate passes
 */
async function getHeroLineSheet(p) {
  const log = p.log || (() => {});
  if (!p.colourSheet || !p.colourSheet.base64) {
    const err = new Error('hero line sheet: the colour character model sheet is required');
    err.failureCode = FAILURE_CODE;
    err.advisories = [{ stage: 'coloringSheet', note: 'no character model sheet to derive the line sheet from' }];
    throw err;
  }
  const rules = resolveLineRules(p.ageBand);
  const pngPath = heroLineSheetPath(p.anchorHash, p.colourSheet.hash);
  return electAsset({
    key: `hero:${pngPath}`,
    pngPath,
    log,
    produce: () => produceElected({
      kind: 'hero',
      prompt: buildHeroSheetPrompt({ outfitSpecText: p.outfitSpecText || null, name: p.profile && p.profile.name, rules }),
      references: [
        { label: 'CHARACTER MODEL SHEET (the child to redraw as line art — identity ground truth)', base64: p.colourSheet.base64, mimeType: p.colourSheet.mimeType },
        ...(p.cover && p.cover.base64 ? [{ label: 'APPROVED COVER (identity aid only)', base64: p.cover.base64, mimeType: p.cover.mimeType }] : []),
      ],
      aspectRatio: SHEET_ASPECT,
      rules,
      reference: { base64: p.colourSheet.base64, mimeType: p.colourSheet.mimeType },
      outfitSpecText: p.outfitSpecText || null,
      costTracker: p.costTracker,
      log,
      label: 'coloringHeroSheet',
    }),
  });
}

/**
 * The companion line sheet (fail-open null).
 * @param {object} p
 * @param {object} p.theme catalog theme
 * @param {{name: string, type?: string, specText?: string|null, human?: boolean, base64: string, mimeType?: string, hash: string}} p.companion the Bible's companion record
 * @param {string} [p.ageBand]
 * @param {object} [p.costTracker]
 * @param {(level: string, msg: string) => void} [p.log]
 * @returns {Promise<object|null>}
 */
async function getCompanionLineSheet(p) {
  const log = p.log || (() => {});
  try {
    if (!p.companion || !p.companion.base64 || !p.companion.name) return null;
    const rules = resolveLineRules(p.ageBand);
    const themeId = String(p.theme && p.theme.theme_id || 'theme').replace(/[^A-Za-z0-9_-]/g, '');
    const prompt = buildCompanionSheetPrompt({ companion: p.companion, rules });
    const hash = fnv1a(`${p.companion.hash}|${prompt}`).toString(36);
    const pngPath = companionLineSheetPath(themeId, hash);
    return await electAsset({
      key: `companion:${pngPath}`,
      pngPath,
      log,
      produce: () => produceElected({
        kind: 'companion',
        prompt,
        references: [{ label: `COMPANION REFERENCE SHEET (${inert(p.companion.name, 40)} — the design to redraw as line art)`, base64: p.companion.base64, mimeType: p.companion.mimeType }],
        aspectRatio: SHEET_ASPECT,
        rules,
        reference: { base64: p.companion.base64, mimeType: p.companion.mimeType },
        companion: { name: p.companion.name, type: p.companion.type, specText: p.companion.specText || null },
        costTracker: p.costTracker,
        log,
        label: 'coloringCompanionSheet',
      }),
    });
  } catch (err) {
    log('warn', `companion line sheet unavailable (${err.message}) — the companion renders from its colour sheet`);
    return null;
  }
}

/**
 * The theme's border plate (fail-open null).
 * @param {object} p {theme, ageBand, costTracker, log}
 * @returns {Promise<object|null>}
 */
async function getBorderPlate(p) {
  const log = p.log || (() => {});
  try {
    if (!p.theme || !p.theme.theme_id) return null;
    const rules = resolveLineRules(p.ageBand);
    const themeId = String(p.theme.theme_id).replace(/[^A-Za-z0-9_-]/g, '');
    const prompt = buildBorderPrompt({ theme: p.theme, rules });
    const hash = fnv1a(prompt).toString(36);
    const pngPath = borderPlatePath(themeId, hash);
    return await electAsset({
      key: `border:${pngPath}`,
      pngPath,
      log,
      produce: () => produceElected({ kind: 'border', prompt, references: [], aspectRatio: BORDER_ASPECT, rules, reference: null, costTracker: p.costTracker, log, label: 'coloringBorderPlate' }),
    });
  } catch (err) {
    log('warn', `border plate unavailable (${err.message}) — the layout uses a typeset rule frame`);
    return null;
  }
}

module.exports = {
  FAILURE_CODE,
  heroLineSheetPath,
  companionLineSheetPath,
  borderPlatePath,
  buildHeroSheetPrompt,
  buildCompanionSheetPrompt,
  buildBorderPrompt,
  electAsset,
  produceElected,
  getHeroLineSheet,
  getCompanionLineSheet,
  getBorderPlate,
  resetSheetCache,
  toSheet,
};
