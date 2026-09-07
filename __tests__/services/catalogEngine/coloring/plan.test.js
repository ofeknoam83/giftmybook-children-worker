/**
 * The coloring scene plan (cb-1 §4.1): quotas per band on real catalog
 * books, determinism, no adjacent kind repeats, gap uniqueness, band 1-3
 * exclusions, the page-count override, the object/companion substitutions,
 * and the schema + invariant validator.
 */

const { loadCatalog } = require('../../../../services/catalogEngine/catalog');
const {
  buildColoringPlan, validateColoringPlan, planHash, resolveQuotas, objectEvidence, castAnchors,
  PAGES_BY_BAND, QUOTAS_BY_BAND, YOUNG_EXCLUDED, KINDS, MIN_PAGES, MAX_PAGES,
} = require('../../../../services/catalogEngine/coloring/plan');

const catalog = loadCatalog();
const farm = catalog.themes.farm;
const bookFor = (band) => farm.age_bands[band][0];
const OBJECT = { visual_required: true, moment_type: 'object_presence', source_field: 'object', source_value: 'a red toy tractor', spread: 1 };
const storyFor = (book, evidence = [OBJECT]) => ({ spreads: book.beats.map(b => ({ spread: b.spread, text: `Text ${b.spread}.` })), personalization_evidence: evidence });
const build = (band, extra = {}) => {
  const book = bookFor(band);
  return buildColoringPlan({ book, theme: farm, story: storyFor(book), profile: { name: 'Emma', age: 5 }, ageBand: band, emotionPlan: null, seedBasis: `fp-${book.id}`, ...extra });
};

describe('quotas', () => {
  test('every band table sums to its page count', () => {
    for (const band of Object.keys(PAGES_BY_BAND)) {
      const sum = Object.values(QUOTAS_BY_BAND[band]).reduce((a, b) => a + b, 0);
      expect(sum).toBe(PAGES_BY_BAND[band]);
    }
  });
  test('resolveQuotas grows into between/world/cast and shrinks back, never below one meet', () => {
    const grown = resolveQuotas('4-5', 24);
    expect(Object.values(grown).reduce((a, b) => a + b, 0)).toBe(24);
    expect(grown.meet).toBe(1);
    expect(grown.between).toBeGreaterThan(QUOTAS_BY_BAND['4-5'].between);
    const shrunk = resolveQuotas('4-5', 12);
    expect(Object.values(shrunk).reduce((a, b) => a + b, 0)).toBe(12);
    expect(shrunk.meet).toBe(1);
    expect(shrunk.between).toBeGreaterThanOrEqual(2);
  });
});

describe('buildColoringPlan on real catalog books', () => {
  test.each(Object.keys(PAGES_BY_BAND))('band %s: the band page count, a meet page first, valid invariants', (band) => {
    const plan = build(band);
    expect(plan.pageCount).toBe(PAGES_BY_BAND[band]);
    expect(plan.pages[0].kind).toBe('meet');
    expect(plan.band).toBe(band);
    const v = validateColoringPlan(plan);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });
  test('the same inputs give the same plan and hash; a different story fingerprint reshuffles the gaps', () => {
    const a = build('6-7');
    const b = build('6-7');
    expect(a).toEqual(b);
    expect(planHash(a)).toBe(planHash(b));
    const c = build('6-7', { seedBasis: 'other-story' });
    expect(planHash(c)).not.toBe(planHash(a));
    expect(c.pages.filter(p => p.kind === 'between').map(p => p.anchor.spreads[0])).not.toEqual(a.pages.filter(p => p.kind === 'between').map(p => p.anchor.spreads[0]));
  });
  test('between pages read in story order and never reuse a gap', () => {
    const plan = build('8-10');
    const gaps = plan.pages.filter(p => p.kind === 'between').map(p => p.anchor.spreads[0]);
    expect(gaps).toEqual([...gaps].sort((x, y) => x - y));
    expect(new Set(gaps).size).toBe(gaps.length);
    for (const p of plan.pages.filter(x => x.kind === 'between')) expect(p.anchor.spreads[1]).toBe(p.anchor.spreads[0] + 1);
  });
  test('no adjacent kind repeats except between', () => {
    for (const band of Object.keys(PAGES_BY_BAND)) {
      const plan = build(band);
      for (let i = 1; i < plan.pages.length; i++) {
        if (plan.pages[i].kind !== 'between') expect(plan.pages[i].kind).not.toBe(plan.pages[i - 1].kind);
      }
    }
  });
  test('band 1-3 never gets before/after/quiet/pattern and only medium/close shots', () => {
    const plan = build('1-3');
    for (const p of plan.pages) {
      expect(YOUNG_EXCLUDED.has(p.kind)).toBe(false);
      if (p.shot) expect(['medium', 'close']).toContain(p.shot);
    }
  });
  test('the comfort object rides child pages from its evidence spread on and the still life', () => {
    const plan = build('4-5');
    const still = plan.pages.find(p => p.kind === 'prop_still_life');
    expect(still.props).toEqual(['a red toy tractor']);
    for (const p of plan.pages.filter(x => x.hasChild && x.kind !== 'meet')) expect(p.props).toEqual(['a red toy tractor']);
    const late = buildColoringPlan({ book: bookFor('4-5'), theme: farm, story: storyFor(bookFor('4-5'), [{ ...OBJECT, spread: 9 }]), profile: { name: 'Emma' }, ageBand: '4-5', seedBasis: 'x' });
    for (const p of late.pages.filter(x => x.kind === 'between')) {
      expect(p.props).toEqual(p.anchor.spreads[0] >= 9 ? ['a red toy tractor'] : []);
    }
  });
  test('without object evidence the still life becomes a world portrait; without a companion the companion portrait does too', () => {
    const noObject = buildColoringPlan({ book: bookFor('4-5'), theme: farm, story: storyFor(bookFor('4-5'), []), profile: { name: 'Emma' }, ageBand: '4-5', seedBasis: 'x' });
    expect(noObject.kinds.prop_still_life).toBeUndefined();
    expect(noObject.kinds.world_portrait).toBe(QUOTAS_BY_BAND['4-5'].world_portrait + 1);
    const noCompanion = buildColoringPlan({ book: bookFor('4-5'), theme: { ...farm, companion: null }, story: storyFor(bookFor('4-5')), profile: { name: 'Emma' }, ageBand: '4-5', seedBasis: 'x' });
    expect(noCompanion.kinds.companion_portrait).toBeUndefined();
    for (const p of noCompanion.pages) expect(p.companion).toBe(false);
    expect(validateColoringPlan(noCompanion).ok).toBe(true);
  });
  test('the page-count override scales the plan and is clamped', () => {
    expect(build('4-5', { pageCount: 24 }).pageCount).toBe(24);
    expect(build('4-5', { pageCount: 12 }).pageCount).toBe(12);
    expect(build('4-5', { pageCount: 2 }).pageCount).toBe(MIN_PAGES);
    expect(build('4-5', { pageCount: 99 }).pageCount).toBe(MAX_PAGES);
    expect(validateColoringPlan(build('4-5', { pageCount: 24 })).ok).toBe(true);
  });
  test('the companion rides between pages exactly where the beats name it', () => {
    const plan = build('4-5');
    const beats = bookFor('4-5').beats;
    for (const p of plan.pages.filter(x => x.kind === 'between')) {
      const [k, k1] = p.anchor.spreads;
      // The engine's signal (scenes.js companionOnSpread): the companion's FULL
      // name as a whole word, or the full type phrase — "Bea follows" alone
      // never fires (the prose always writes the full name when she appears).
      const named = [k, k1].some(s => /Farmer Bea|friendly adult farm guide/i.test(beats.find(b => b.spread === s).beat));
      expect(p.companion).toBe(named);
    }
    expect(plan.pages.find(p => p.kind === 'companion_portrait').companion).toBe(true);
    expect(plan.pages.find(p => p.kind === 'hero_portrait').companion).toBe(false);
  });
  test('unknown band falls back to 4-5 and the peak spread is pinned', () => {
    const plan = buildColoringPlan({ book: bookFor('4-5'), theme: farm, story: storyFor(bookFor('4-5')), profile: { name: 'Emma' }, ageBand: 'nope', seedBasis: 'x', emotionPlan: { 6: { emotion: 'wonder', intensity: 'big' } } });
    expect(plan.band).toBe('4-5');
    expect(plan.peakSpread).toBe(6);
    expect(plan.pages.find(p => p.kind === 'quiet_parallel').anchor.spread).toBe(6);
  });
});

describe('helpers', () => {
  test('objectEvidence picks only the visual comfort object', () => {
    expect(objectEvidence([{ visual_required: true, moment_type: 'food_moment', source_field: 'food', source_value: 'cake', spread: 5 }])).toBeNull();
    expect(objectEvidence([OBJECT])).toEqual({ value: 'a red toy tractor', spread: 1 });
    expect(objectEvidence(null)).toBeNull();
  });
  test('castAnchors prefers learning-line spreads, then counting beats, then the fallback — distinct', () => {
    const book = bookFor('4-5');
    const anchors = castAnchors(book, 3);
    expect(anchors.length).toBe(3);
    expect(new Set(anchors).size).toBe(3);
    expect(anchors[0]).toBe(5); // "Count three chicks on spread 5."
    expect(castAnchors({ beats: [], learning: [] }, 2)).toEqual([4, 7]);
  });
  test('validateColoringPlan rejects a broken plan with named errors', () => {
    const plan = build('4-5');
    const broken = { ...plan, pages: plan.pages.map((p, i) => (i === 0 ? { ...p, kind: 'between' } : p)) };
    const v = validateColoringPlan(broken);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/meet/);
    expect(validateColoringPlan({ ...plan, pages: [] }).ok).toBe(false);
    expect(KINDS).toContain('between');
  });
});
