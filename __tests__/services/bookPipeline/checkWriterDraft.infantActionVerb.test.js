const {
  findInfantForbiddenActionVerbs,
} = require('../../../services/bookPipeline/qa/checkWriterDraft');
const { AGE_BANDS } = require('../../../services/bookPipeline/constants');

describe('findInfantForbiddenActionVerbs (PR D / D.2)', () => {
  test('flags "jumps" in an infant-band manuscript', () => {
    const out = findInfantForbiddenActionVerbs('Up jumps Everleigh.', AGE_BANDS.PB_INFANT);
    expect(out).toEqual(expect.arrayContaining(['jumps']));
  });

  test('flags multiple distinct verbs in one spread', () => {
    const out = findInfantForbiddenActionVerbs(
      'We dance and twirl, then race to the door.',
      AGE_BANDS.PB_INFANT,
    );
    expect(out).toEqual(expect.arrayContaining(['dance', 'twirl', 'race']));
  });

  test('flags the body-part displacement "feet flash"', () => {
    const out = findInfantForbiddenActionVerbs('Her feet flash past the bench.', AGE_BANDS.PB_INFANT);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toMatch(/feet flash/);
  });

  test('returns empty when text uses only infant-safe verbs', () => {
    const out = findInfantForbiddenActionVerbs(
      'She giggles and looks. She reaches for Mama.',
      AGE_BANDS.PB_INFANT,
    );
    expect(out).toEqual([]);
  });

  test('returns empty for non-infant age bands (toddler can dance)', () => {
    expect(findInfantForbiddenActionVerbs('She jumps and dances.', AGE_BANDS.PB_TODDLER)).toEqual([]);
    expect(findInfantForbiddenActionVerbs('She jumps and dances.', AGE_BANDS.PB_PRESCHOOL)).toEqual([]);
  });

  test('does not double-report identical surface forms', () => {
    const out = findInfantForbiddenActionVerbs(
      'Jump, jump, jump, jump.',
      AGE_BANDS.PB_INFANT,
    );
    expect(out).toEqual(['jump']);
  });

  test('catches inflected forms (jumping, raced, twirled, hopping)', () => {
    expect(findInfantForbiddenActionVerbs('keep jumping', AGE_BANDS.PB_INFANT)).toEqual(['jumping']);
    expect(findInfantForbiddenActionVerbs('she raced past', AGE_BANDS.PB_INFANT)).toEqual(['raced']);
    expect(findInfantForbiddenActionVerbs('twirled around', AGE_BANDS.PB_INFANT)).toEqual(['twirled']);
    expect(findInfantForbiddenActionVerbs('hopping high', AGE_BANDS.PB_INFANT)).toEqual(['hopping']);
  });
});
