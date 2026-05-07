const {
  HARD_GATE_CODES,
  hardFailures,
  draftPenalty,
} = require('../../../../services/bookPipelineV2/orchestration/workflows/createBook.workflow');

describe('hard-gate classification', () => {
  test('identity_rhyme is a hard failure', () => {
    expect(HARD_GATE_CODES.has('identity_rhyme')).toBe(true);
  });
  test('dialogue codes are hard failures', () => {
    expect(HARD_GATE_CODES.has('dialogue_quoted_speech')).toBe(true);
    expect(HARD_GATE_CODES.has('dialogue_single_quoted')).toBe(true);
    expect(HARD_GATE_CODES.has('dialogue_tag_verb')).toBe(true);
  });
  test('past_tense codes are hard failures', () => {
    expect(HARD_GATE_CODES.has('past_tense_irregular')).toBe(true);
    expect(HARD_GATE_CODES.has('past_tense_regular')).toBe(true);
  });
  test('imperfect_rhyme is NOT a hard failure', () => {
    expect(HARD_GATE_CODES.has('imperfect_rhyme')).toBe(false);
  });
  test('line_length_window is NOT a hard failure', () => {
    expect(HARD_GATE_CODES.has('line_length_window')).toBe(false);
  });
  test('filler_phrase is NOT a hard failure', () => {
    expect(HARD_GATE_CODES.has('filler_phrase')).toBe(false);
  });
});

describe('hardFailures', () => {
  test('returns only hard codes', () => {
    const fails = [
      { code: 'identity_rhyme' },
      { code: 'imperfect_rhyme' },
      { code: 'past_tense_irregular' },
      { code: 'filler_phrase' },
    ];
    const hard = hardFailures(fails);
    expect(hard).toHaveLength(2);
    expect(hard.map((f) => f.code)).toEqual(['identity_rhyme', 'past_tense_irregular']);
  });
  test('handles non-arrays', () => {
    expect(hardFailures(null)).toEqual([]);
    expect(hardFailures(undefined)).toEqual([]);
  });
});

describe('draftPenalty', () => {
  test('passing gate has zero penalty', () => {
    expect(draftPenalty({ passed: true })).toBe(0);
  });
  test('null/undefined gate has zero penalty', () => {
    expect(draftPenalty(null)).toBe(0);
    expect(draftPenalty(undefined)).toBe(0);
  });
  test('one hard fail = 100 penalty', () => {
    expect(draftPenalty({ passed: false, failures: [{ code: 'identity_rhyme' }] })).toBe(100);
  });
  test('one soft fail = 1 penalty', () => {
    expect(draftPenalty({ passed: false, failures: [{ code: 'imperfect_rhyme' }] })).toBe(1);
  });
  test('mixed: hard always dominates soft', () => {
    expect(draftPenalty({
      passed: false,
      failures: [
        { code: 'imperfect_rhyme' },
        { code: 'imperfect_rhyme' },
        { code: 'identity_rhyme' },
      ],
    })).toBe(102);
  });
  test('the worst-case from the production manuscript ranks worse than a clean draft', () => {
    const stuck = {
      passed: false,
      failures: [
        { code: 'identity_rhyme' },
        { code: 'past_tense_irregular' },
        { code: 'dialogue_tag_verb' },
        { code: 'imperfect_rhyme' },
      ],
    };
    const cleanish = {
      passed: false,
      failures: [{ code: 'imperfect_rhyme' }, { code: 'line_length_window' }],
    };
    expect(draftPenalty(stuck)).toBeGreaterThan(draftPenalty(cleanish));
  });
});
