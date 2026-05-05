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

  // PR G additions — verbs the detector previously missed even though they
  // paint a walking/standing illustration the age-action gate then rejects.
  describe('PR G — extended infant verbs (step / stand / bounce)', () => {
    test('flags "steps" (the prod failure: "Her brave steps bounce with thrill")', () => {
      const out = findInfantForbiddenActionVerbs(
        'Her brave steps bounce with thrill.',
        AGE_BANDS.PB_INFANT,
      );
      expect(out).toEqual(expect.arrayContaining(['steps', 'bounce']));
    });

    test('flags singular "step" and inflections (stepped, stepping)', () => {
      expect(findInfantForbiddenActionVerbs('one small step', AGE_BANDS.PB_INFANT)).toEqual(['step']);
      expect(findInfantForbiddenActionVerbs('she stepped close', AGE_BANDS.PB_INFANT)).toEqual(['stepped']);
      expect(findInfantForbiddenActionVerbs('stepping outside', AGE_BANDS.PB_INFANT)).toEqual(['stepping']);
    });

    test('flags stand / stands / standing / stood', () => {
      expect(findInfantForbiddenActionVerbs('Stand up tall.', AGE_BANDS.PB_INFANT)).toEqual(['stand']);
      expect(findInfantForbiddenActionVerbs('She stands alone.', AGE_BANDS.PB_INFANT)).toEqual(['stands']);
      expect(findInfantForbiddenActionVerbs('standing on the dock', AGE_BANDS.PB_INFANT)).toEqual(['standing']);
      expect(findInfantForbiddenActionVerbs('she stood up', AGE_BANDS.PB_INFANT)).toEqual(['stood']);
    });

    test('flags bounce / bounces / bouncing / bounced', () => {
      expect(findInfantForbiddenActionVerbs('bounce on the bed', AGE_BANDS.PB_INFANT)).toEqual(['bounce']);
      expect(findInfantForbiddenActionVerbs('she bounces high', AGE_BANDS.PB_INFANT)).toEqual(['bounces']);
      expect(findInfantForbiddenActionVerbs('bouncing along', AGE_BANDS.PB_INFANT)).toEqual(['bouncing']);
      expect(findInfantForbiddenActionVerbs('she bounced once', AGE_BANDS.PB_INFANT)).toEqual(['bounced']);
    });

    test('catches body-part displacement with new verbs ("feet step", "feet bounce")', () => {
      const stepOut = findInfantForbiddenActionVerbs('Her feet step quick.', AGE_BANDS.PB_INFANT);
      expect(stepOut.some(v => /feet step/.test(v))).toBe(true);
      const bounceOut = findInfantForbiddenActionVerbs('Her feet bounce hard.', AGE_BANDS.PB_INFANT);
      expect(bounceOut.some(v => /feet bounce/.test(v))).toBe(true);
    });

    test('does NOT flag the new verbs for non-infant bands', () => {
      expect(findInfantForbiddenActionVerbs('She steps and bounces.', AGE_BANDS.PB_TODDLER)).toEqual([]);
      expect(findInfantForbiddenActionVerbs('Stand tall.', AGE_BANDS.PB_PRESCHOOL)).toEqual([]);
    });

    test('does NOT false-positive on safe nouns/words containing the substrings', () => {
      // word boundaries should prevent: "understand" (no match), "stepping
      // stone" as part of metaphor still IS "stepping" so we expect a hit;
      // here we just guard against the 'understand' false positive case.
      expect(findInfantForbiddenActionVerbs('I understand.', AGE_BANDS.PB_INFANT)).toEqual([]);
      expect(findInfantForbiddenActionVerbs('outstanding day', AGE_BANDS.PB_INFANT)).toEqual([]);
    });
  });
});
