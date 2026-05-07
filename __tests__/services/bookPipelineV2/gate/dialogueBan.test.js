const { dialogueBanCheck } = require('../../../../services/bookPipelineV2/gate/checks/dialogueBan');

const infantBand = { ageBand: 'PB_INFANT', narrativeConstraints: { dialogueDensity: 'none' } };
const presLowBand = { ageBand: 'PB_PRESCHOOL', narrativeConstraints: { dialogueDensity: 'low' } };

describe('dialogueBanCheck', () => {
  test('passes empty draft', () => {
    expect(dialogueBanCheck({ text: '' }, {}, infantBand).passed).toBe(true);
  });

  test('flags straight double-quoted speech in PB_INFANT', () => {
    const r = dialogueBanCheck({ text: 'Mama says, "Smushy," low.\nScarlett blinks slow.' }, {}, infantBand);
    expect(r.passed).toBe(false);
    expect(r.code).toBe('dialogue_quoted_speech');
  });

  test('flags curly double-quoted speech', () => {
    const r = dialogueBanCheck({ text: 'Mama says, \u201CSmushy,\u201D low.\nScarlett blinks slow.' }, {}, infantBand);
    expect(r.passed).toBe(false);
    expect(r.code).toBe('dialogue_quoted_speech');
  });

  test('flags dialogue-tag verb even without quotes', () => {
    const r = dialogueBanCheck({ text: 'Mama says hello to her child.' }, {}, infantBand);
    expect(r.passed).toBe(false);
    expect(r.code).toBe('dialogue_tag_verb');
  });

  test('does not flag possessive "Mama\'s"', () => {
    const r = dialogueBanCheck({ text: "Scarlett finds Mama's chin.\nMama laughs with a grin." }, {}, infantBand);
    expect(r.passed).toBe(true);
  });

  test('does not flag bands with dialogueDensity=low', () => {
    const r = dialogueBanCheck({ text: 'Mama says, "Hello!"' }, {}, presLowBand);
    expect(r.passed).toBe(true);
  });

  test('skips when band has no dialogueDensity field', () => {
    const r = dialogueBanCheck({ text: 'Mama says, "hi".' }, {}, { ageBand: 'PB_TODDLER', narrativeConstraints: {} });
    expect(r.passed).toBe(true);
  });
});
