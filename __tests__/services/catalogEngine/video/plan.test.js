/**
 * Film plan (gv-1): deterministic picks, the duration table, motion
 * assignment from the shot plan, subsets, and the cover rule.
 */

const { buildFilmPlan, pickStorySpreads, requestedClipSeconds, DURATIONS, XFADE_SECONDS, TOTAL_SECONDS, MOTIONS, MOTIONS_YOUNG } = require('../../../../services/catalogEngine/video/plan');

const ALL = Array.from({ length: 12 }, (_, i) => i + 1);
const shotPlan = Object.fromEntries(ALL.map(n => [n, { shotType: n === 1 || n === 12 ? 'wide' : (n % 2 ? 'medium' : 'close-up'), placement: n % 2 ? 'left-third' : 'right-third' }]));

describe('duration table', () => {
  test('every segment count sums to exactly TOTAL_SECONDS after the crossfades', () => {
    for (const [count, table] of Object.entries(DURATIONS)) {
      const sum = table.reduce((a, b) => a + b, 0) - XFADE_SECONDS * (Number(count) - 1);
      expect(Math.round(sum * 1000) / 1000).toBe(TOTAL_SECONDS);
    }
  });
  test('requested clip seconds cover the segment with a whole-second margin (min 3)', () => {
    expect(requestedClipSeconds(2.4)).toBe(4);
    expect(requestedClipSeconds(3.0)).toBe(4);
    expect(requestedClipSeconds(4.2)).toBe(6);
    expect(requestedClipSeconds(1)).toBe(3);
  });
});

describe('pickStorySpreads', () => {
  test('a full book picks the opening, the peak by intensity, the resolution', () => {
    const { spreads, picks } = pickStorySpreads(ALL, { 6: { intensity: 'big' }, 8: { intensity: 'clear' } });
    expect(picks).toEqual({ opening: 1, peak: 6, resolution: 12 });
    expect(spreads).toEqual([1, 6, 12]);
  });
  test('ties break by the fixed preference order (8 before 9 before 7)', () => {
    expect(pickStorySpreads(ALL, null).picks.peak).toBe(8);
    expect(pickStorySpreads(ALL, { 9: { intensity: 'big' }, 7: { intensity: 'big' } }).picks.peak).toBe(9);
  });
  test('subsets compress deterministically', () => {
    expect(pickStorySpreads([5, 6, 7], null).spreads).toEqual([5, 6, 7]);
    expect(pickStorySpreads([3, 9], null).spreads).toEqual([3, 9]);
    expect(pickStorySpreads([4], null).spreads).toEqual([4]);
    expect(pickStorySpreads([], null).spreads).toEqual([]);
    expect(pickStorySpreads([2, 3, 4, 5], null).picks).toEqual({ opening: 2, peak: 4, resolution: 5 });
  });
  test('the same inputs always give the same picks', () => {
    const a = pickStorySpreads([1, 2, 5, 8, 11, 12], { 5: { intensity: 'soft' } });
    const b = pickStorySpreads([12, 11, 8, 5, 2, 1], { 5: { intensity: 'soft' } });
    expect(a).toEqual(b);
  });
});

describe('buildFilmPlan', () => {
  test('cover + three story moments, motions from the shot plan, no adjacent repeats', () => {
    const plan = buildFilmPlan({ available: ALL, coverKind: 'cover', emotionPlan: null, shotPlan, textLayout: 'half', ageBand: '4-5' });
    expect(plan.segments.map(s => [s.kind, s.spread])).toEqual([['cover', null], ['spread', 1], ['spread', 8], ['spread', 12]]);
    expect(plan.totalSeconds).toBe(10);
    expect(plan.segments.map(s => s.seconds)).toEqual(DURATIONS[4]);
    for (let i = 1; i < plan.segments.length; i++) expect(plan.segments[i].motion).not.toBe(plan.segments[i - 1].motion);
    for (const s of plan.segments) expect(MOTIONS).toContain(s.motion);
    // cover push-in → spread 1 (wide → push-in, repeat → alternate pull-out) →
    // spread 8 (close-up → pull-out, repeat → alternate push-in) → spread 12
    // (wide → push-in, repeat → alternate pull-out): the rule alternates.
    expect(plan.segments.map(s => s.motion)).toEqual(['push-in', 'pull-out', 'push-in', 'pull-out']);
  });
  test('a photo anchor never opens the film', () => {
    const plan = buildFilmPlan({ available: ALL, coverKind: 'photo', shotPlan, ageBand: '6-7' });
    expect(plan.segments[0].kind).toBe('spread');
    expect(plan.segments).toHaveLength(3);
    expect(plan.totalSeconds).toBe(10);
  });
  test('band 1-3 only pushes in or holds', () => {
    const plan = buildFilmPlan({ available: ALL, coverKind: 'cover', shotPlan, ageBand: '1-3' });
    for (const s of plan.segments) expect(MOTIONS_YOUNG).toContain(s.motion);
    for (let i = 1; i < plan.segments.length; i++) expect(plan.segments[i].motion).not.toBe(plan.segments[i - 1].motion);
  });
  test('a single available spread makes a 10 s single-segment film', () => {
    const plan = buildFilmPlan({ available: [7], coverKind: null, shotPlan });
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].seconds).toBe(10);
    expect(plan.totalSeconds).toBe(10);
  });
  test('no spreads → no segments', () => {
    expect(buildFilmPlan({ available: [], coverKind: 'cover' }).segments).toEqual([]);
  });
  test('shot-plan-less runs treat every spread as wide', () => {
    const plan = buildFilmPlan({ available: ALL, coverKind: null, shotPlan: null, ageBand: '8-10' });
    expect(plan.segments.map(s => s.shotType)).toEqual([null, null, null]);
    expect(plan.segments.map(s => s.motion)).toEqual(['push-in', 'pull-out', 'push-in']);
  });
});
