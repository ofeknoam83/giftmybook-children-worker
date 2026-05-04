/**
 * Unit tests for action-consistency QA evaluation (PR C, sections C.1 + C.2).
 *
 * Tests the pure evaluator (no network) against the four interesting
 * combinations of (actionMatches, ageActionPossible).
 */

const { evaluateActionResult } = require('../../../services/illustrator/actionConsistencyQa');

function baseParsed(overrides = {}) {
  return {
    actionMatches: true,
    actionMismatchReason: '',
    ageActionPossible: true,
    ageActionReason: '',
    ...overrides,
  };
}

describe('evaluateActionResult', () => {
  test('all checks pass → pass:true, no tags', () => {
    const r = evaluateActionResult(baseParsed());
    expect(r.pass).toBe(true);
    expect(r.tags).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  test('actionMatches:false → action_mismatch tag', () => {
    const r = evaluateActionResult(baseParsed({
      actionMatches: false,
      actionMismatchReason: 'text says reaching for moon, image shows hero asleep',
    }));
    expect(r.pass).toBe(false);
    expect(r.tags).toContain('action_mismatch');
    expect(r.tags).not.toContain('age_action_impossible');
    expect(r.issues.join(' ')).toMatch(/reaching for moon/);
  });

  test('ageActionPossible:false → age_action_impossible tag', () => {
    const r = evaluateActionResult(baseParsed({
      ageActionPossible: false,
      ageActionReason: '8-month-old depicted twirling unsupported',
    }));
    expect(r.pass).toBe(false);
    expect(r.tags).toContain('age_action_impossible');
    expect(r.tags).not.toContain('action_mismatch');
    expect(r.issues.join(' ')).toMatch(/twirling unsupported/);
  });

  test('both fail → both tags emitted, deduped', () => {
    const r = evaluateActionResult(baseParsed({
      actionMatches: false,
      actionMismatchReason: 'wrong scene',
      ageActionPossible: false,
      ageActionReason: 'walking unsupported',
    }));
    expect(r.pass).toBe(false);
    expect(r.tags).toContain('action_mismatch');
    expect(r.tags).toContain('age_action_impossible');
    expect(r.tags.length).toBe(2);
  });

  test('null/undefined parsed → fails open (no tags, pass true)', () => {
    const r = evaluateActionResult(null);
    expect(r.pass).toBe(true);
    expect(r.tags).toEqual([]);
  });

  test('parsed with non-strict-false values is treated as pass (uncertain → pass)', () => {
    // The evaluator only fails on explicit `=== false`. undefined / true / 'maybe'
    // all read as pass. This matches the contract "When uncertain, prefer true."
    const r = evaluateActionResult({ actionMatches: undefined, ageActionPossible: 'yes' });
    expect(r.pass).toBe(true);
    expect(r.tags).toEqual([]);
  });
});
