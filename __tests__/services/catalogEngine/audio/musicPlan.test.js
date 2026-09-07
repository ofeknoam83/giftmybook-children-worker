/**
 * The music plan (ab-1 §4.5): the emotion → cue mapping, the forced intro /
 * ending, the ≥ 2-spread hold, the change cap per band, band 1-3 never
 * hears gentle_tension, the motif flag on refrain spreads — and the
 * invariants over every catalog book × its band.
 */

const { cueFor, planMusic, validateMusicPlan, MAX_CHANGES, CUES } = require('../../../../services/catalogEngine/audio/music/plan');
const { buildEmotionPlan } = require('../../../../services/catalogEngine/illustrator/emotionPlan');
const catalog = require('../../../../services/catalogEngine/catalog');

const segmentsFor = (spreads = 12, { dedication = false } = {}) => {
  const out = [{ index: 0, kind: 'intro', spread: null }];
  if (dedication) out.push({ index: out.length, kind: 'dedication', spread: null });
  for (let s = 1; s <= spreads; s++) out.push({ index: out.length, kind: 'spread', spread: s });
  out.push({ index: out.length, kind: 'outro', spread: null });
  return out;
};
const plan = (emotions, band = '6-7') => Object.fromEntries(emotions.map((e, i) => [i + 1, typeof e === 'string' ? { emotion: e, intensity: 'clear' } : e]));

describe('cueFor', () => {
  test('maps the closed emotion set onto the suite', () => {
    expect(cueFor({ emotion: 'joy' }, 4, '6-7')).toBe('playful');
    expect(cueFor({ emotion: 'silly' }, 4, '6-7')).toBe('playful');
    expect(cueFor({ emotion: 'wonder' }, 4, '6-7')).toBe('wonder');
    expect(cueFor({ emotion: 'curiosity' }, 4, '6-7')).toBe('wonder');
    expect(cueFor({ emotion: 'surprise' }, 4, '6-7')).toBe('wonder');
    expect(cueFor({ emotion: 'calm' }, 4, '6-7')).toBe('calm');
    expect(cueFor({ emotion: 'tenderness' }, 4, '6-7')).toBe('tender');
    expect(cueFor({ emotion: 'pride' }, 10, '6-7')).toBe('triumph');
    expect(cueFor({ emotion: 'determination' }, 5, '6-7')).toBe('wonder');
    expect(cueFor({ emotion: 'worry' }, 5, '6-7')).toBe('gentle_tension');
    expect(cueFor({ emotion: 'worry' }, 5, '1-3')).toBe('wonder');
    expect(cueFor(null, 5, '6-7')).toBe('calm');
  });
});

describe('planMusic', () => {
  test('intro + spread 1 under theme_intro, spread 12 + outro under lullaby_outro, the hold rule and the cap', () => {
    const segments = segmentsFor(12, { dedication: true });
    const emotions = plan(['joy', 'wonder', 'calm', 'joy', 'wonder', 'calm', 'joy', 'wonder', 'pride', 'pride', 'tenderness', 'tenderness']);
    const { changes } = planMusic({ segments, emotionPlan: emotions, band: '6-7', refrainSpreads: [2, 5, 8, 11] });
    const cues = segments.map(s => s.music.cue);
    expect(cues[0]).toBe('theme_intro');
    expect(cues[1]).toBe('theme_intro'); // dedication
    expect(segments.find(s => s.spread === 1).music.cue).toBe('theme_intro');
    expect(segments.find(s => s.spread === 12).music.cue).toBe('lullaby_outro');
    expect(cues[cues.length - 1]).toBe('lullaby_outro');
    expect(changes).toBeLessThanOrEqual(MAX_CHANGES.default);
    expect(validateMusicPlan(segments, '6-7').ok).toBe(true);
    for (const s of segments.filter(x => [2, 5, 8, 11].includes(x.spread))) expect(s.music.motif).toBe(true);
    expect(segments.find(s => s.spread === 3).music.motif).toBeUndefined();
    for (const s of segments) expect(CUES).toContain(s.music.cue);
  });
  test('a flip-flopping emotion plan never flips the cue every spread', () => {
    const segments = segmentsFor();
    const emotions = plan(['joy', 'calm', 'joy', 'calm', 'joy', 'calm', 'joy', 'calm', 'joy', 'calm', 'joy', 'calm']);
    planMusic({ segments, emotionPlan: emotions, band: '8-10' });
    const v = validateMusicPlan(segments, '8-10');
    expect(v.errors).toEqual([]);
  });
  test('band 1-3 never hears gentle_tension and stays under 3 changes', () => {
    const segments = segmentsFor();
    const emotions = plan(['worry', 'worry', 'joy', 'joy', 'worry', 'calm', 'joy', 'worry', 'pride', 'pride', 'calm', 'calm']);
    const { changes } = planMusic({ segments, emotionPlan: emotions, band: '1-3' });
    expect(segments.some(s => s.music.cue === 'gentle_tension')).toBe(false);
    expect(changes).toBeLessThanOrEqual(MAX_CHANGES['1-3']);
    expect(validateMusicPlan(segments, '1-3').ok).toBe(true);
    expect(segments.find(s => s.spread === 5).music.gainDb).toBe(-17);
  });
  test('a change is never proposed on spread 11 (it would hold one spread before the ending)', () => {
    const segments = segmentsFor();
    const emotions = plan(['calm', 'calm', 'calm', 'calm', 'calm', 'calm', 'calm', 'calm', 'calm', 'calm', 'joy', 'joy']);
    planMusic({ segments, emotionPlan: emotions, band: '6-7' });
    expect(segments.find(s => s.spread === 11).music.cue).toBe('calm');
  });
  test('validateMusicPlan reports the broken invariants', () => {
    const segments = segmentsFor();
    planMusic({ segments, emotionPlan: plan(Array(12).fill('calm')), band: '6-7' });
    segments.find(s => s.spread === 6).music.cue = 'playful';
    segments.find(s => s.spread === 12).music.cue = 'calm';
    const v = validateMusicPlan(segments, '6-7');
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/holds only spread 6/);
    expect(v.errors.join(' ')).toMatch(/spread 12/);
  });
});

describe('every catalog book × its band', () => {
  test('the plan satisfies the invariants', () => {
    const raw = catalog.baseCatalog();
    let books = 0;
    for (const theme of Object.values(raw.themes)) {
      for (const [band, list] of Object.entries(theme.age_bands)) {
        for (const book of list) {
          const segments = segmentsFor(book.beats.length);
          const emotionPlan = buildEmotionPlan({ book, ageBand: band });
          planMusic({ segments, emotionPlan, band, refrainSpreads: book.refrain ? book.refrain.spreads : [] });
          const v = validateMusicPlan(segments, band);
          expect(v.errors).toEqual([]);
          books += 1;
        }
      }
    }
    expect(books).toBe(228);
  });
});
