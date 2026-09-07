/**
 * Film plan (gv-2): one continuous take through the picked stills — one
 * act per still with a distinct camera angle from the closed vocabulary,
 * the moves that carry the take between angles, equal act windows summing
 * to 10 s, the band 1-3 menu, and the embedded fallback's arc trio.
 */

const { buildFilmPlan, pickStorySpreads, actWindows, angleForShot, moveInto, requestedClipSeconds, TOTAL_SECONDS, ANGLES, ANGLE_ORDER, ANGLES_YOUNG, MOVES, MOVES_YOUNG } = require('../../../../services/catalogEngine/video/plan');

const ALL = Array.from({ length: 12 }, (_, i) => i + 1);
const shotPlan = Object.fromEntries(ALL.map(n => [n, { shotType: n === 1 || n === 12 ? 'wide' : (n % 2 ? 'medium' : 'close-up'), placement: n % 2 ? 'left-third' : 'right-third' }]));

describe('windows and seconds', () => {
  test('acts split the take evenly and end exactly at TOTAL_SECONDS', () => {
    expect(actWindows(3)).toEqual([{ from: 0, to: 3.3 }, { from: 3.3, to: 6.7 }, { from: 6.7, to: 10 }]);
    expect(actWindows(1)).toEqual([{ from: 0, to: 10 }]);
    expect(actWindows(2)).toEqual([{ from: 0, to: 5 }, { from: 5, to: 10 }]);
    expect(actWindows(4)[3].to).toBe(TOTAL_SECONDS);
  });
  test('the whole take is used: requested seconds are the plan seconds rounded up (min 3)', () => {
    expect(requestedClipSeconds(10)).toBe(10);
    expect(requestedClipSeconds(2.4)).toBe(3);
    expect(requestedClipSeconds(9.5)).toBe(10);
  });
});

describe('angles and moves', () => {
  test('shot types map onto the closed angle vocabulary', () => {
    expect(angleForShot({ shotType: 'wide' })).toBe('wide');
    expect(angleForShot({ shotType: 'medium' })).toBe('eye-level');
    expect(angleForShot({ shotType: 'close-up' })).toBe('close');
    expect(angleForShot({ shotType: 'overhead' })).toBe('overhead');
    expect(angleForShot({ shotType: 'low-angle' })).toBe('low-angle');
    expect(angleForShot(null)).toBeNull();
    for (const a of ANGLE_ORDER) expect(typeof ANGLES[a]).toBe('string');
  });
  test('every move into an angle is in the closed vocabulary; band 1-3 never sweeps or rises', () => {
    for (const a of ANGLE_ORDER) {
      expect(Object.keys(MOVES)).toContain(moveInto(a, false));
      expect(MOVES_YOUNG).toContain(moveInto(a, true));
    }
    expect(moveInto('overhead', false)).toBe('rise');
    expect(moveInto('overhead', true)).toBe('glide');
  });
});

describe('buildFilmPlan', () => {
  test('one journey segment, one act per picked still in story order, distinct angles, 10 s', () => {
    const plan = buildFilmPlan({ scenes: [12, 1, 7], shotPlan, emotionPlan: { 7: { emotion: 'joy', intensity: 'big' } }, ageBand: '4-5' });
    expect(plan.segments).toHaveLength(1);
    const s = plan.segments[0];
    expect(s).toMatchObject({ index: 0, kind: 'journey', spread: null, spreads: [1, 7, 12], seconds: 10, requestedSeconds: 10, motion: 'journey' });
    expect(s.acts.map(a => a.spread)).toEqual([1, 7, 12]);
    expect(s.acts.map(a => [a.from, a.to])).toEqual([[0, 3.3], [3.3, 6.7], [6.7, 10]]);
    // spread 1 wide → 'wide'; spread 7 medium → 'eye-level'; spread 12 wide
    // again → the next unused angle, never a repeat
    expect(s.acts.map(a => a.angle)).toEqual(['wide', 'eye-level', 'low-angle']);
    expect(new Set(s.acts.map(a => a.angle)).size).toBe(3);
    expect(s.acts[0].move).toBe('push-in');
    expect(s.acts.map(a => a.move).every(m => Object.keys(MOVES).includes(m))).toBe(true);
    expect(s.acts.every(a => typeof a.angleText === 'string' && typeof a.moveText === 'string')).toBe(true);
    expect(s.acts[1].emotion).toEqual({ emotion: 'joy', intensity: 'big' });
    expect(s.acts[0].shotType).toBe('wide');
    expect(plan.totalSeconds).toBe(10);
  });
  test('band 1-3 only uses the calm menu and never repeats an angle', () => {
    const plan = buildFilmPlan({ scenes: [2, 6, 11], shotPlan: Object.fromEntries(ALL.map(n => [n, { shotType: 'overhead' }])), ageBand: '1-3' });
    const angles = plan.segments[0].acts.map(a => a.angle);
    for (const a of angles) expect(ANGLES_YOUNG).toContain(a);
    expect(new Set(angles).size).toBe(3);
    for (const a of plan.segments[0].acts) expect(MOVES_YOUNG).toContain(a.move);
  });
  test('a plan-less run still changes angle every act', () => {
    const plan = buildFilmPlan({ scenes: [3, 8, 10], shotPlan: null, ageBand: '8-10' });
    const angles = plan.segments[0].acts.map(a => a.angle);
    expect(new Set(angles).size).toBe(3);
    expect(plan.segments[0].acts.map(a => a.shotType)).toEqual([null, null, null]);
  });
  test('one or two stills make a shorter journey with the same 10 s take', () => {
    expect(buildFilmPlan({ scenes: [7] }).segments[0].acts).toHaveLength(1);
    const two = buildFilmPlan({ scenes: [4, 9] }).segments[0];
    expect(two.acts.map(a => [a.from, a.to])).toEqual([[0, 5], [5, 10]]);
    expect(two.seconds).toBe(10);
  });
  test('no scenes → no segments; duplicates and out-of-range spreads are dropped', () => {
    expect(buildFilmPlan({ scenes: [] }).segments).toEqual([]);
    expect(buildFilmPlan({ scenes: [5, 5, 0, 13] }).segments[0].spreads).toEqual([5]);
  });
  test('the same inputs always give the same plan', () => {
    const a = buildFilmPlan({ scenes: [1, 7, 12], shotPlan, ageBand: '6-7' });
    const b = buildFilmPlan({ scenes: [12, 7, 1], shotPlan, ageBand: '6-7' });
    expect(a).toEqual(b);
  });
});

describe('pickStorySpreads (embedded fallback)', () => {
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
  });
});
