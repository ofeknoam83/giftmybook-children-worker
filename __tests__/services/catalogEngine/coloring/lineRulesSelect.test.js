/**
 * LINE_RULES (cb-1 §4.4) and coloring candidate scoring: the spec per band,
 * byte-stable prompt blocks, the hash, and the score weights (blocking sinks
 * below zero, unchecked ranks below checked, grey and stroke deviation shade).
 */

const {
  BANDS, LINE_RULES_BY_BAND, resolveLineRules, renderLineRulesBlock, renderCompositionBlock, lineRulesHash, NO_TEXT_BLOCK, FINAL_CHECK_BLOCK, SHOTS, SHOTS_YOUNG, PLACEMENTS,
} = require('../../../../services/catalogEngine/coloring/lineRules');
const { scoreColoringCandidate, pickBest, compareCandidates, residualBlocking, WEIGHTS } = require('../../../../services/catalogEngine/coloring/select');

describe('LINE_RULES', () => {
  test('every band has a spec and strokes thin with age', () => {
    expect(BANDS).toEqual(['1-3', '4-5', '6-7', '8-10']);
    const strokes = BANDS.map(b => LINE_RULES_BY_BAND[b].primaryStrokePercent);
    expect(strokes).toEqual([...strokes].sort((a, b) => b - a));
    for (const b of BANDS) {
      const r = LINE_RULES_BY_BAND[b];
      expect(r.detailStrokePercent).toBeLessThan(r.primaryStrokePercent);
      expect(r.inkMin).toBeLessThan(r.inkMax);
      expect(Object.isFrozen(r)).toBe(true);
    }
  });
  test('an unknown band resolves to the 4-5 spec', () => {
    expect(resolveLineRules('nope')).toBe(LINE_RULES_BY_BAND['4-5']);
    expect(resolveLineRules(null)).toBe(LINE_RULES_BY_BAND['4-5']);
  });
  test('the blocks state the band numbers and the fixed rules', () => {
    const block = renderLineRulesBlock(LINE_RULES_BY_BAND['1-3']);
    expect(block).toMatch(/about 1.1% of the image width/);
    expect(block).toMatch(/never thinner than 0.7%/);
    expect(block).toMatch(/EVERY shape is CLOSED/);
    expect(block).toMatch(/NO shading, hatching/);
    const comp = renderCompositionBlock({ shot: 'wide', placement: 'in the left third', rules: LINE_RULES_BY_BAND['8-10'] });
    expect(comp).toMatch(/WIDE view/);
    expect(comp).toMatch(/in the left third/);
    expect(comp).toMatch(/about 4% clear inside EVERY edge/);
    expect(comp).toMatch(/3:4/);
    expect(renderCompositionBlock({ shot: 'bogus', placement: 'bogus', rules: null })).toMatch(/MEDIUM view.*centred/);
    expect(NO_TEXT_BLOCK).toMatch(/no letters, words, numbers/);
    expect(FINAL_CHECK_BLOCK).toMatch(/every shape closed/);
  });
  test('the vocabularies are closed and the hash is stable', () => {
    expect(SHOTS).toEqual(['wide', 'medium', 'close']);
    expect(SHOTS_YOUNG).toEqual(['medium', 'close']);
    expect(PLACEMENTS.length).toBe(3);
    expect(lineRulesHash()).toBe(lineRulesHash());
    expect(lineRulesHash()).toMatch(/^[a-z0-9]+$/);
  });
});

describe('scoreColoringCandidate', () => {
  const clean = { k: 1, qa: { pass: true, blocking: [], advisory: [] }, metrics: { grayRatio: 0.01, strokeRatio: 1, inkRatio: 0.08, inkMin: 0.03, inkMax: 0.14, specks: 0 } };
  test('a clean on-spec candidate scores near the base; blocking sinks below zero', () => {
    expect(scoreColoringCandidate(clean)).toBeCloseTo(WEIGHTS.base - 3, 1);
    expect(scoreColoringCandidate({ qa: { blocking: ['grey shading present'], advisory: [] } })).toBeLessThan(0);
  });
  test('unchecked ranks below any checked candidate whatever its score', () => {
    const unchecked = { k: 1, qa: { qaUnavailable: 'HTTP 500' } };
    const checkedBlocking = { k: 2, qa: { blocking: ['painted text'], advisory: [] } };
    unchecked.score = scoreColoringCandidate(unchecked);
    checkedBlocking.score = scoreColoringCandidate(checkedBlocking);
    expect(unchecked.score).toBe(WEIGHTS.base + WEIGHTS.unchecked);
    expect(compareCandidates(checkedBlocking, unchecked)).toBeGreaterThan(0);
  });
  test('grey mass and stroke deviation shade the score so the cleaner page wins', () => {
    const greyer = { ...clean, k: 2, metrics: { ...clean.metrics, grayRatio: 0.05 } };
    const offSpec = { ...clean, k: 3, metrics: { ...clean.metrics, strokeRatio: 0.5 } };
    const dense = { ...clean, k: 4, metrics: { ...clean.metrics, inkRatio: 0.18 } };
    const scored = [clean, greyer, offSpec, dense].map(c => ({ ...c, score: scoreColoringCandidate(c) }));
    expect(pickBest(scored).k).toBe(1);
    expect(scored[1].score).toBeLessThan(scored[0].score);
    expect(scored[2].score).toBeLessThan(scored[0].score);
    expect(scored[3].score).toBeLessThan(scored[0].score);
  });
  test('missing metrics never throw and residualBlocking reads the best', () => {
    expect(scoreColoringCandidate({ qa: { blocking: [], advisory: ['frame drawn'] }, metrics: null })).toBe(WEIGHTS.base + WEIGHTS.advisory);
    expect(residualBlocking({ qa: { blocking: ['a', 'b'] } })).toEqual(['a', 'b']);
  });
});
