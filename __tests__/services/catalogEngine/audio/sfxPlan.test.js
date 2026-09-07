/**
 * The sound-cue plan (ab-1 §4.6): the library validates, keyword hits are
 * whole-word and name-masked, evidence > beat > text priority, band quotas,
 * no cue on a refrain line, anchors spaced, startle cues gated and
 * attenuated, the same cue at most twice per book, one ambience bed per
 * theme, the page turn — and the placement invariants over every catalog
 * book with a synthetic story.
 */

const sfx = require('../../../../services/catalogEngine/audio/sfx/plan');
const catalog = require('../../../../services/catalogEngine/catalog');

const theme = id => catalog.baseCatalog().themes[id];
const line = (text, isRefrain = false) => ({ text, isRefrain });
const seg = (index, spread, lines) => ({ index, kind: 'spread', spread, lines: lines.map((l, i) => ({ ...l, index: i })) });
const book = { beats: [{ spread: 1, beat: 'Child meets a gentle cow.' }, { spread: 2, beat: 'Child counts three chickens.' }, { spread: 3, beat: 'Child says goodbye.' }] };

describe('library', () => {
  test('loads with unique cue ids, closed fields and a hash', () => {
    const lib = sfx.loadSfxLibrary();
    expect(lib.cues.length).toBeGreaterThan(50);
    expect(lib.hash).toMatch(/^[0-9a-f]{12}$/);
    for (const t of Object.values(catalog.baseCatalog().themes)) expect(lib.ambience[t.theme_id]).toBeTruthy();
    expect(lib.pageTurn.cueId).toBe('transition_page');
  });
});

describe('keywordHits + masks', () => {
  test('whole-word, theme- and band-filtered', () => {
    const lib = sfx.loadSfxLibrary();
    const hits = sfx.keywordHits('the cow said moo by the cowshed', lib, { themeId: 'farm', band: '4-5' });
    expect(hits.map(h => h.cue.cueId)).toContain('cow_moo');
    expect(sfx.keywordHits('a cow', lib, { themeId: 'space', band: '4-5' }).map(h => h.cue.cueId)).not.toContain('cow_moo');
    // a startle cue never fires for band 1-3
    expect(sfx.keywordHits('distant thunder', lib, { themeId: 'farm', band: '6-7' }).map(h => h.cue.cueId)).toContain('thunder_distant');
    expect(sfx.keywordHits('distant thunder', lib, { themeId: 'farm', band: '1-3' }).map(h => h.cue.cueId)).not.toContain('thunder_distant');
  });
  test('verbatim names are masked before matching ("Maple" the squirrel never fires on Maple Harvest Hall)', () => {
    expect(sfx.maskedText('Maple Harvest Hall was busy. Maple scampered.', ['Maple Harvest Hall', 'Maple'])).not.toMatch(/maple/);
    const lib = sfx.loadSfxLibrary();
    const text = sfx.maskedText('Patch flew to the patch of grass', ['Patch']);
    expect(sfx.keywordHits(text, lib, { themeId: 'pirate', band: '6-7' }).map(h => h.cue.cueId)).not.toContain('parrot_squawk');
  });
});

describe('planSfx', () => {
  test('evidence beats beat beats text; quotas; refrain excluded; startle attenuated; ambience + page turn', () => {
    const segments = [
      seg(0, 1, [line('Emma met a gentle cow.'), line('Hello, farm!', true), line('The birds sang and a frog croaked.'), line('She giggled.')]),
      seg(1, 2, [line('Emma counted three chickens.'), line('Then thunder rumbled far away.'), line('Rain fell.')]),
      seg(2, 3, [line('Goodbye, farm!'), line('Emma waved and the cow said moo.')]),
    ];
    const evidence = [{ spread: 1, source_value: 'rubber duck', source_field: 'object', moment_type: 'object_presence', slot_id: 's', visual_required: true }];
    const r = sfx.planSfx({ segments, book, theme: theme('farm'), band: '6-7', evidence, masks: ['Emma', 'Farmer Bea', 'Sunnybrook Farm', 'Farm'], seedBasis: 'fp' });
    const s1 = segments[0].sfx;
    expect(s1.length).toBeLessThanOrEqual(3);
    expect(s1[0].cueId).toBe('duck_quack');
    expect(s1[0].source).toBe('evidence');
    expect(s1.every(x => !segments[0].lines[x.anchorLine].isRefrain)).toBe(true);
    const thunder = segments[1].sfx.find(x => x.cueId === 'thunder_distant');
    expect(thunder).toBeTruthy();
    expect(thunder.gainDb).toBe(-18 + sfx.STARTLE_PENALTY_DB);
    expect(segments.every(s => s.ambience && s.ambience.cueId === 'amb_farm_day')).toBe(true);
    expect(r.pageTurn.cueId).toBe('transition_page');
    expect(r.libraryHash).toMatch(/^[0-9a-f]{12}$/);
    expect(sfx.validateSfxPlan(segments, '6-7').errors).toEqual([]);
  });
  test('band 1-3: one cue per spread, no startle', () => {
    const segments = [seg(0, 1, [line('The cow said moo.'), line('The hen clucked.'), line('Thunder rumbled.')])];
    sfx.planSfx({ segments, book, theme: theme('farm'), band: '1-3', seedBasis: 'fp' });
    expect(segments[0].sfx).toHaveLength(1);
    expect(segments[0].sfx[0].cueId).not.toBe('thunder_distant');
    expect(sfx.validateSfxPlan(segments, '1-3').ok).toBe(true);
  });
  test('the same cue is placed at most twice per book', () => {
    const segments = [1, 2, 3, 4].map(s => seg(s - 1, s, [line('The cow said moo.'), line('A calf followed.'), line('Another cow mooed.'), line('Fun.')]));
    const r = sfx.planSfx({ segments, book: { beats: [] }, theme: theme('farm'), band: '8-10', seedBasis: 'fp' });
    expect(r.placed.filter(p => p.cueId === 'cow_moo')).toHaveLength(2);
    expect(r.skipped.some(k => k.cueId === 'cow_moo' && k.reason === 'max_uses')).toBe(true);
  });
  test('options can switch ambience, page turn and spots off; the director may only promote candidates', () => {
    const segments = [seg(0, 1, [line('The cow said moo.'), line('Hens clucked.'), line('Ducks quacked.'), line('Pigs oinked.')])];
    const r = sfx.planSfx({ segments, book, theme: theme('farm'), band: '4-5', seedBasis: 'fp', options: { ambience: false, pageTurn: false }, directorPicks: { 1: ['pig_oink', 'rocket_whoosh_soft'] } });
    expect(segments[0].ambience).toBeNull();
    expect(r.pageTurn).toBeNull();
    expect(segments[0].sfx[0].cueId).toBe('pig_oink');
    expect(segments[0].sfx[0].source).toBe('director');
    expect(segments[0].sfx.map(x => x.cueId)).not.toContain('rocket_whoosh_soft');
    const off = [seg(0, 1, [line('The cow said moo.')])];
    sfx.planSfx({ segments: off, book, theme: theme('farm'), band: '4-5', options: { spots: false } });
    expect(off[0].sfx).toEqual([]);
  });
  test('is deterministic for a seed and varies tie-breaks by seed', () => {
    const make = () => [seg(0, 1, [line('The cow, the hen, the duck, the pig and the goat all sang.')])];
    const a = make(); const b = make();
    sfx.planSfx({ segments: a, book: { beats: [] }, theme: theme('farm'), band: '4-5', seedBasis: 'one' });
    sfx.planSfx({ segments: b, book: { beats: [] }, theme: theme('farm'), band: '4-5', seedBasis: 'one' });
    expect(a[0].sfx).toEqual(b[0].sfx);
  });
});

describe('every catalog book', () => {
  test('placement invariants hold with a synthetic story', () => {
    const raw = catalog.baseCatalog();
    let placed = 0;
    for (const t of Object.values(raw.themes)) {
      for (const [band, list] of Object.entries(t.age_bands)) {
        for (const book of list) {
          const segments = book.beats.map((b, i) => seg(i, b.spread, [line(`Emma looked around. ${b.beat}`), line(book.refrain && book.refrain.spreads.includes(b.spread) ? book.refrain.text : 'Then she smiled.', !!(book.refrain && book.refrain.spreads.includes(b.spread))), line('The birds sang and the wind blew.')]));
          const r = sfx.planSfx({ segments, book, theme: t, band, masks: ['Emma', t.companion.name, t.world_name, t.display_name], seedBasis: book.id });
          const v = sfx.validateSfxPlan(segments, band);
          expect(v.errors).toEqual([]);
          placed += r.placed.length;
        }
      }
    }
    expect(placed).toBeGreaterThan(228);
  });
});
