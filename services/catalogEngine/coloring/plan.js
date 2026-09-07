/**
 * The coloring-book scene plan (cb-1, docs/COLORING_BOOK_V2_PLAN.md §4.1) —
 * a CLOSED grammar of "beside-the-story" scene kinds assigned
 * deterministically from pinned inputs: the catalog book definition (12
 * beats, learning lines), the theme (world, companion), the story's
 * personalization evidence (the comfort object), the age band, the emotion
 * plan (the peak spread) and a seed. Same inputs → the same plan, byte for
 * byte; the plan hash is a cache dimension.
 *
 * Every kind is NON-PLOT by definition — a portrait, a transition, a
 * prologue/epilogue, a parallel moment. The planner never chooses an event
 * and never quotes a beat: it decides WHICH kind sits WHERE (the book reads
 * in story order without retelling it), which page carries the child, the
 * companion and the carried comfort object, and the assigned composition
 * (shot size + placement rotated from closed vocabularies, no adjacent
 * repeats, a restricted menu for band 1-3). The moment writer (moments.js)
 * phrases each slot afterwards, behind a duplication gate.
 *
 * Pure: no I/O, no model calls.
 */

const Ajv = require('ajv');
const { fnv1a } = require('../selection');
const { companionOnSpread } = require('../illustrator/scenes');
const { pickStorySpreads } = require('../video/plan');
const { SHOTS, SHOTS_YOUNG, PLACEMENTS } = require('./lineRules');
const { COLORING_VERSION } = require('../versions');

/** The closed kind enum, in the fixed tie-break order. */
const KINDS = ['meet', 'before', 'hero_portrait', 'between', 'world_portrait', 'companion_portrait', 'cast_portrait', 'quiet_parallel', 'prop_still_life', 'pattern', 'after'];

/** Coloring pages per band (front/back matter excluded). */
const PAGES_BY_BAND = Object.freeze({ '1-3': 16, '4-5': 20, '6-7': 20, '8-10': 20 });

/** Kind quotas per band (each row sums to PAGES_BY_BAND). */
const QUOTAS_BY_BAND = Object.freeze({
  '1-3': Object.freeze({ meet: 1, hero_portrait: 2, companion_portrait: 2, world_portrait: 2, cast_portrait: 3, between: 5, before: 0, after: 0, quiet_parallel: 0, prop_still_life: 1, pattern: 0 }),
  '4-5': Object.freeze({ meet: 1, hero_portrait: 1, companion_portrait: 1, world_portrait: 2, cast_portrait: 2, between: 9, before: 1, after: 1, quiet_parallel: 1, prop_still_life: 1, pattern: 0 }),
  '6-7': Object.freeze({ meet: 1, hero_portrait: 1, companion_portrait: 1, world_portrait: 2, cast_portrait: 2, between: 9, before: 1, after: 1, quiet_parallel: 1, prop_still_life: 1, pattern: 0 }),
  '8-10': Object.freeze({ meet: 1, hero_portrait: 1, companion_portrait: 1, world_portrait: 2, cast_portrait: 2, between: 8, before: 1, after: 1, quiet_parallel: 1, prop_still_life: 1, pattern: 1 }),
});

/** Kinds band 1-3 never gets (a toddler's book has no prologue/epilogue/parallel/pattern pages). */
const YOUNG_EXCLUDED = new Set(['before', 'after', 'quiet_parallel', 'pattern']);

/** Kinds that carry the child. */
const CHILD_KINDS = new Set(['meet', 'hero_portrait', 'between', 'before', 'after', 'quiet_parallel']);

/** Fixed shot per portrait-class kind; the rest rotate. */
const FIXED_SHOT = Object.freeze({ hero_portrait: 'medium', companion_portrait: 'medium', world_portrait: 'wide', cast_portrait: 'close', prop_still_life: 'close' });

/** Fallback anchors for portrait kinds (spread numbers), in slot order. */
const WORLD_ANCHORS = [2, 9, 5, 11];
const COMPANION_ANCHORS = [3, 10];
const HERO_ANCHORS = [1, 12];
const CAST_FALLBACK_ANCHORS = [4, 7, 8, 9, 5];
const MIN_PAGES = 8;
const MAX_PAGES = 28;
const MAX_GAPS = 11;

/** mulberry32 — a tiny seeded PRNG (the selector's tie-break style). @param {number} seed @returns {() => number} */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates on a copy with the given rng. @param {Array} arr @param {() => number} rng @returns {Array} */
function seededShuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Resolve the band's quotas to an exact page count: the band table first,
 * then the difference absorbed by `between` (up to the 11 gaps), then
 * world portraits, then cast portraits; a shortfall is taken in the reverse
 * order (never below one of each). `meet` is always exactly one.
 * @param {string} band
 * @param {number} pageCount
 * @returns {Object<string, number>}
 */
function resolveQuotas(band, pageCount) {
  const base = QUOTAS_BY_BAND[band] || QUOTAS_BY_BAND['4-5'];
  const q = { ...base };
  const sum = () => Object.values(q).reduce((a, b) => a + b, 0);
  const growOrder = ['between', 'world_portrait', 'cast_portrait', 'hero_portrait', 'companion_portrait'];
  const caps = { between: MAX_GAPS, world_portrait: 6, cast_portrait: 5, hero_portrait: 3, companion_portrait: 3 };
  let guard = 0;
  while (sum() < pageCount && guard++ < 64) {
    const k = growOrder.find(kind => q[kind] < caps[kind]);
    if (!k) break;
    q[k] += 1;
  }
  const shrinkOrder = ['between', 'world_portrait', 'cast_portrait', 'hero_portrait', 'companion_portrait', 'quiet_parallel', 'pattern', 'after', 'before', 'prop_still_life'];
  const floors = { between: 2, world_portrait: 1, cast_portrait: 1, hero_portrait: 1, companion_portrait: 1, quiet_parallel: 0, pattern: 0, after: 0, before: 0, prop_still_life: 0 };
  guard = 0;
  while (sum() > pageCount && guard++ < 64) {
    const k = shrinkOrder.find(kind => q[kind] > floors[kind]);
    if (!k) break;
    q[k] -= 1;
  }
  return q;
}

/**
 * The comfort object the story introduced visually (the ONE carry-through
 * prop class — scenes.js's rule): `{value, spread}` or null.
 * @param {object[]} evidence personalization_evidence
 * @returns {{value: string, spread: number}|null}
 */
function objectEvidence(evidence) {
  const hit = (Array.isArray(evidence) ? evidence : []).find(ev => ev && ev.visual_required === true && ev.moment_type === 'object_presence' && ev.source_field === 'object' && typeof ev.source_value === 'string' && ev.source_value.trim() && Number.isInteger(ev.spread));
  return hit ? { value: hit.source_value.trim(), spread: hit.spread } : null;
}

/**
 * Anchors for the cast portraits: the `learning[]` lines that name a
 * spread ("Count three chicks on spread 5"), then beats naming a count
 * ("exactly three", "two"), then a fixed fallback — distinct, in slot
 * order.
 * @param {object} book
 * @param {number} n
 * @returns {number[]}
 */
function castAnchors(book, n) {
  const out = [];
  const push = s => { if (Number.isInteger(s) && s >= 1 && s <= 12 && !out.includes(s)) out.push(s); };
  for (const line of Array.isArray(book.learning) ? book.learning : []) {
    const m = /spread\s+(\d{1,2})/i.exec(String(line || ''));
    if (m) push(Number(m[1]));
  }
  for (const b of book.beats || []) {
    if (/\b(exactly|two|three|four|five|six|several|many|a pair of)\b/i.test(String(b.beat || ''))) push(b.spread);
  }
  for (const s of CAST_FALLBACK_ANCHORS) push(s);
  return out.slice(0, n);
}

/**
 * Build the plan.
 * @param {object} p
 * @param {object} p.book catalog book definition (beats, learning, safety)
 * @param {object} p.theme catalog theme ({theme_id, display_name, world_name, companion})
 * @param {{spreads?: Array<{spread: number, text: string}>, personalization_evidence?: object[]}} p.story validated writer response
 * @param {{name: string, age?: number}} p.profile normalized profile
 * @param {string} p.ageBand catalog band key
 * @param {Object<number, {emotion: string, intensity: string}>|null} [p.emotionPlan]
 * @param {string} p.seedBasis the story fingerprint (never a folded cache key)
 * @param {number} [p.pageCount] coloring pages (default by band)
 * @returns {{version: string, band: string, pageCount: number, kinds: Object<string, number>, peakSpread: number|null, object: {value: string, spread: number}|null, pages: Array<object>}}
 */
function buildColoringPlan(p) {
  const band = PAGES_BY_BAND[p.ageBand] ? p.ageBand : '4-5';
  const requested = Number.isInteger(p.pageCount) ? p.pageCount : PAGES_BY_BAND[band];
  const pageCount = Math.max(MIN_PAGES, Math.min(MAX_PAGES, requested));
  const quotas = resolveQuotas(band, pageCount);
  const theme = p.theme || {};
  const companion = theme.companion && theme.companion.name ? theme.companion : null;
  const object = objectEvidence(p.story && p.story.personalization_evidence);
  const beats = new Map((p.book.beats || []).map(b => [b.spread, String(b.beat || '')]));
  const texts = new Map(((p.story && p.story.spreads) || []).map(s => [s.spread, String(s.text || '')]));
  const childName = p.profile && p.profile.name ? String(p.profile.name) : '';

  // Substitutions the inputs force (a slot never disappears — it becomes a world portrait).
  if (!object && quotas.prop_still_life > 0) { quotas.world_portrait += quotas.prop_still_life; quotas.prop_still_life = 0; }
  if (!companion && quotas.companion_portrait > 0) { quotas.world_portrait += quotas.companion_portrait; quotas.companion_portrait = 0; }
  if (band === '1-3') for (const k of YOUNG_EXCLUDED) { if (quotas[k] > 0) { quotas.between += quotas[k]; quotas[k] = 0; } }

  const peak = pickStorySpreads(Array.from({ length: 12 }, (_, i) => i + 1), p.emotionPlan || null).picks.peak;
  const rng = mulberry32(fnv1a(`${p.seedBasis || ''}|${COLORING_VERSION}|${band}|${pageCount}`));
  const gaps = seededShuffle(Array.from({ length: MAX_GAPS }, (_, i) => i + 1), rng).slice(0, quotas.between).sort((a, b) => a - b);
  const companionAt = (s) => !!companion && companionOnSpread({ beat: beats.get(s) || '' }, texts.get(s) || '', companion, { theme, childName });
  const carriedAt = (s) => (object && object.spread <= s ? [object.value] : []);
  const beatText = (s) => beats.get(s) || '';

  const items = [];
  items.push({ kind: 'meet', key: 0, anchor: null, hasChild: true, companion: false, props: [], beats: [] });
  if (quotas.before > 0) items.push({ kind: 'before', key: 0.5, anchor: { spread: 1 }, hasChild: true, companion: false, props: carriedAt(1), beats: [beatText(1)] });
  for (const k of gaps) {
    items.push({ kind: 'between', key: k + 0.5, anchor: { spreads: [k, k + 1] }, hasChild: true, companion: companionAt(k) || companionAt(k + 1), props: carriedAt(k), beats: [beatText(k), beatText(k + 1)] });
  }
  for (let i = 0; i < quotas.hero_portrait; i++) {
    const s = HERO_ANCHORS[i] ?? HERO_ANCHORS[HERO_ANCHORS.length - 1];
    items.push({ kind: 'hero_portrait', key: s + 0.25, anchor: { spread: s }, hasChild: true, companion: false, props: carriedAt(s), beats: [beatText(s)] });
  }
  for (let i = 0; i < quotas.world_portrait; i++) {
    const s = WORLD_ANCHORS[i] ?? WORLD_ANCHORS[WORLD_ANCHORS.length - 1];
    items.push({ kind: 'world_portrait', key: s + 0.25, anchor: { spread: s }, hasChild: false, companion: false, props: [], beats: [beatText(s)] });
  }
  for (let i = 0; i < quotas.companion_portrait; i++) {
    const s = COMPANION_ANCHORS[i] ?? COMPANION_ANCHORS[COMPANION_ANCHORS.length - 1];
    items.push({ kind: 'companion_portrait', key: s + 0.25, anchor: { spread: s }, hasChild: false, companion: true, props: [], beats: [beatText(s)] });
  }
  for (const s of castAnchors(p.book, quotas.cast_portrait)) {
    items.push({ kind: 'cast_portrait', key: s + 0.3, anchor: { spread: s }, hasChild: false, companion: false, props: [], beats: [beatText(s)] });
  }
  if (quotas.quiet_parallel > 0 && Number.isInteger(peak)) {
    items.push({ kind: 'quiet_parallel', key: peak + 0.35, anchor: { spread: peak }, hasChild: true, companion: companionAt(peak), props: carriedAt(peak), beats: [beatText(peak)] });
  }
  if (quotas.prop_still_life > 0 && object) {
    items.push({ kind: 'prop_still_life', key: object.spread + 0.75, anchor: { spread: object.spread }, hasChild: false, companion: false, props: [object.value], beats: [beatText(object.spread)] });
  }
  if (quotas.pattern > 0) items.push({ kind: 'pattern', key: 12.2, anchor: null, hasChild: false, companion: false, props: [], beats: [] });
  if (quotas.after > 0) items.push({ kind: 'after', key: 12.5, anchor: { spread: 12 }, hasChild: true, companion: false, props: carriedAt(12), beats: [beatText(12)] });

  items.sort((a, b) => a.key - b.key || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  // No adjacent kind repeats (between excepted): swap the second of a pair
  // with the next page that differs from both of its would-be neighbours.
  for (let i = 1; i < items.length; i++) {
    if (items[i].kind !== items[i - 1].kind || items[i].kind === 'between') continue;
    const j = items.findIndex((it, idx) => idx > i && it.kind !== items[i].kind && it.kind !== items[i - 1].kind && (idx + 1 >= items.length || items[idx + 1].kind !== items[i].kind));
    if (j > i) [items[i], items[j]] = [items[j], items[i]];
  }

  // Composition: fixed shots for portrait kinds, rotated for the rest (no
  // adjacent repeats), placements rotated across the whole book.
  const menu = band === '1-3' ? SHOTS_YOUNG : SHOTS;
  let rotate = 0;
  let prevShot = null;
  const pages = items.map((it, i) => {
    let shot = null;
    if (it.kind !== 'meet' && it.kind !== 'pattern') {
      shot = FIXED_SHOT[it.kind] && menu.includes(FIXED_SHOT[it.kind]) ? FIXED_SHOT[it.kind] : null;
      if (!shot) {
        shot = menu[rotate % menu.length];
        if (shot === prevShot) { rotate += 1; shot = menu[rotate % menu.length]; }
        rotate += 1;
      }
    }
    prevShot = shot;
    const placement = it.kind === 'meet' || it.kind === 'pattern' ? null : PLACEMENTS[i % PLACEMENTS.length];
    return { index: i + 1, kind: it.kind, anchor: it.anchor, shot, placement, hasChild: it.hasChild, companion: it.companion, props: it.props, beats: it.beats.filter(Boolean) };
  });

  const kinds = {};
  for (const pg of pages) kinds[pg.kind] = (kinds[pg.kind] || 0) + 1;
  return { version: COLORING_VERSION, band, pageCount: pages.length, kinds, peakSpread: Number.isInteger(peak) ? peak : null, object, pages };
}

/**
 * Content hash of a plan plus the caller's extra identity (story
 * fingerprint, bible hash, sheet hashes, LINE_RULES hash) — the page cache
 * dimension.
 * @param {object} plan
 * @param {object} [extra]
 * @returns {string}
 */
function planHash(plan, extra = {}) {
  const pages = (plan.pages || []).map(pg => [pg.index, pg.kind, pg.anchor, pg.shot, pg.placement, pg.hasChild, pg.companion, pg.props, pg.moment || null]);
  return fnv1a(JSON.stringify({ v: plan.version, b: plan.band, n: plan.pageCount, pages, ...extra })).toString(36);
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['version', 'band', 'pageCount', 'kinds', 'pages'],
  additionalProperties: true,
  properties: {
    version: { type: 'string' },
    band: { type: 'string', enum: Object.keys(PAGES_BY_BAND) },
    pageCount: { type: 'integer', minimum: MIN_PAGES, maximum: MAX_PAGES },
    kinds: { type: 'object' },
    peakSpread: { type: ['integer', 'null'], minimum: 1, maximum: 12 },
    pages: {
      type: 'array', minItems: MIN_PAGES, maxItems: MAX_PAGES,
      items: {
        type: 'object',
        required: ['index', 'kind', 'anchor', 'shot', 'placement', 'hasChild', 'companion', 'props', 'beats'],
        properties: {
          index: { type: 'integer', minimum: 1, maximum: MAX_PAGES },
          kind: { type: 'string', enum: KINDS },
          anchor: { type: ['object', 'null'] },
          shot: { type: ['string', 'null'], enum: [...SHOTS, null] },
          placement: { type: ['string', 'null'], enum: [...PLACEMENTS, null] },
          hasChild: { type: 'boolean' },
          companion: { type: 'boolean' },
          props: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 4 },
          beats: { type: 'array', items: { type: 'string' }, maxItems: 2 },
          moment: { type: 'string', maxLength: 400 },
          title: { type: 'string', maxLength: 60 },
          momentSource: { type: 'string', enum: ['writer', 'template'] },
        },
      },
    },
  },
};
const validatePlanSchema = new Ajv({ allErrors: true }).compile(PLAN_SCHEMA);

/**
 * Validate a plan against the schema + the structural invariants (indices
 * 1..n in order, exactly one `meet` first, no adjacent non-between repeats,
 * gap uniqueness, band exclusions).
 * @param {object} plan
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateColoringPlan(plan) {
  const errors = [];
  if (!validatePlanSchema(plan)) {
    for (const e of validatePlanSchema.errors || []) errors.push(`${e.instancePath || '/'} ${e.message}`);
    return { ok: false, errors };
  }
  const pages = plan.pages;
  pages.forEach((pg, i) => { if (pg.index !== i + 1) errors.push(`page ${i + 1} carries index ${pg.index}`); });
  if (pages[0].kind !== 'meet') errors.push('the first page must be the meet page');
  if (pages.filter(pg => pg.kind === 'meet').length !== 1) errors.push('exactly one meet page');
  if (pages.length !== plan.pageCount) errors.push('pageCount does not match pages');
  for (let i = 1; i < pages.length; i++) {
    if (pages[i].kind === pages[i - 1].kind && pages[i].kind !== 'between') errors.push(`adjacent ${pages[i].kind} pages at ${i} and ${i + 1}`);
  }
  const gaps = pages.filter(pg => pg.kind === 'between').map(pg => pg.anchor && pg.anchor.spreads && pg.anchor.spreads[0]);
  if (new Set(gaps).size !== gaps.length) errors.push('a between gap is used twice');
  if (plan.band === '1-3') for (const pg of pages) { if (YOUNG_EXCLUDED.has(pg.kind)) errors.push(`band 1-3 never gets a ${pg.kind} page`); }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  KINDS,
  PAGES_BY_BAND,
  QUOTAS_BY_BAND,
  YOUNG_EXCLUDED,
  CHILD_KINDS,
  FIXED_SHOT,
  MIN_PAGES,
  MAX_PAGES,
  PLAN_SCHEMA,
  mulberry32,
  seededShuffle,
  resolveQuotas,
  objectEvidence,
  castAnchors,
  buildColoringPlan,
  planHash,
  validateColoringPlan,
};
