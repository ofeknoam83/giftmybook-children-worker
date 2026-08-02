const { getAgeProfile, narrativeTenseFor } = require('../../../../services/bookPipelineV3/ageProfiles');
const { pastTenseCheck, textHasPastTenseMarker } = require('../../../../services/bookPipelineV3/gate/checks/pastTense');
const { tenseDriftLint } = require('../../../../services/bookPipelineV3/gate/checks/bookLints');
const { buildBudgetPreamble } = require('../../../../services/bookPipelineV3/orchestration/activities/manuscriptWriter');

afterEach(() => { delete process.env.BOOK_PIPELINE_V3_NARRATIVE_TENSE; });

describe('narrativeTenseFor', () => {
  test('profiles declare past for PRESCHOOL/EARLY_READER and present for the lap-baby bands', () => {
    expect(narrativeTenseFor(getAgeProfile('PB_INFANT'))).toBe('present');
    expect(narrativeTenseFor(getAgeProfile('PB_TODDLER'))).toBe('present');
    expect(narrativeTenseFor(getAgeProfile('PB_PRESCHOOL'))).toBe('past');
    expect(narrativeTenseFor(getAgeProfile('PB_EARLY_READER'))).toBe('past');
  });

  test('legacy profiles without the field fall back by band', () => {
    expect(narrativeTenseFor({ ageBand: 'PB_TODDLER' })).toBe('present');
    expect(narrativeTenseFor({ ageBand: 'PB_PRESCHOOL' })).toBe('past');
  });

  test('env override wins; unknown values are ignored', () => {
    process.env.BOOK_PIPELINE_V3_NARRATIVE_TENSE = 'present';
    expect(narrativeTenseFor(getAgeProfile('PB_PRESCHOOL'))).toBe('present');
    process.env.BOOK_PIPELINE_V3_NARRATIVE_TENSE = 'bogus';
    expect(narrativeTenseFor(getAgeProfile('PB_PRESCHOOL'))).toBe('past');
  });
});

describe('pastTenseCheck tense gating', () => {
  test('still hard-fails past tense in present-tense bands', () => {
    const r = pastTenseCheck({ text: 'Baby jumped high.' }, {}, getAgeProfile('PB_INFANT'));
    expect(r.passed).toBe(false);
  });

  test('past-tense bands are exempt (past tense is the ordered register)', () => {
    expect(pastTenseCheck({ text: 'Maya raced down the hill and found the door.' }, {}, getAgeProfile('PB_PRESCHOOL')).passed).toBe(true);
  });

  test('env flip to present re-arms the check for preschool', () => {
    process.env.BOOK_PIPELINE_V3_NARRATIVE_TENSE = 'present';
    expect(pastTenseCheck({ text: 'Maya jumped high.' }, {}, getAgeProfile('PB_PRESCHOOL')).passed).toBe(false);
  });
});

describe('tenseDriftLint', () => {
  const book = (texts) => ({ spreads: texts.map((text, i) => ({ spread: i + 1, text, lines: [text] })) });
  const past = 'Maya raced down the hill and found the little door.';
  const present = 'Maya races down the hill. She sees a little door.';

  test('a past-tense book passes', () => {
    expect(tenseDriftLint(book([past, past, past, past, past]), { ageProfile: getAgeProfile('PB_PRESCHOOL') })).toEqual([]);
  });

  test('present-tense narration in a past-tense book lints with the driftiest spreads', () => {
    const lints = tenseDriftLint(book([present, present, present, present, past]), { ageProfile: getAgeProfile('PB_PRESCHOOL') });
    expect(lints).toHaveLength(1);
    expect(lints[0].code).toBe('tense_drift');
    expect(lints[0].spreads).toEqual([1, 2, 3, 4]);
  });

  test('never runs for present-tense bands', () => {
    expect(tenseDriftLint(book([present, present, present, present, present]), { ageProfile: getAgeProfile('PB_TODDLER') })).toEqual([]);
  });

  test('textHasPastTenseMarker sees irregulars and -ed forms', () => {
    expect(textHasPastTenseMarker('She went home.')).toBe(true);
    expect(textHasPastTenseMarker('She looked up.')).toBe(true);
    expect(textHasPastTenseMarker('She looks up.')).toBe(false);
  });
});

describe('buildBudgetPreamble tense line', () => {
  test('present-tense bands keep the machine-checked present line', () => {
    expect(buildBudgetPreamble(getAgeProfile('PB_TODDLER'), 13)).toContain('present tense ONLY');
  });

  test('past-tense bands order past-tense narration', () => {
    const preamble = buildBudgetPreamble(getAgeProfile('PB_PRESCHOOL'), 13);
    expect(preamble).toContain('PAST TENSE narration');
    expect(preamble).not.toContain('present tense ONLY');
  });
});
