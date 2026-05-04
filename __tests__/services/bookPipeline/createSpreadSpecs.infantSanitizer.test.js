const {
  findInfantPlannerVerbs,
} = require('../../../services/bookPipeline/planner/createSpreadSpecs');

describe('findInfantPlannerVerbs (PR E.3)', () => {
  test('detects "dance" in a focalAction', () => {
    const out = findInfantPlannerVerbs('She starts to dance with Mama on the rug.');
    expect(out).toContain('dance');
  });

  test('detects multiple offenders in plotBeat-shaped text', () => {
    const out = findInfantPlannerVerbs('They twirl, hop, and chase the puppy.');
    expect(out).toEqual(expect.arrayContaining(['twirl', 'hop', 'chase']));
  });

  test('returns empty for an infant-safe focalAction', () => {
    expect(findInfantPlannerVerbs('Mama lifts her up to see the moon.')).toEqual([]);
  });

  test('does not false-positive on substrings (e.g. "rundown" should not match "run")', () => {
    expect(findInfantPlannerVerbs('A rundown of Saturday morning.')).toEqual([]);
  });

  test('handles empty / null input', () => {
    expect(findInfantPlannerVerbs('')).toEqual([]);
    expect(findInfantPlannerVerbs(null)).toEqual([]);
    expect(findInfantPlannerVerbs(undefined)).toEqual([]);
  });
});
