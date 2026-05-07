const { pastTenseCheck } = require('../../../../services/bookPipelineV2/gate/checks/pastTense');

const infantBand = { ageBand: 'PB_INFANT', narrativeConstraints: { dialogueDensity: 'none' } };
const earlyReader = { ageBand: 'PB_EARLY_READER', narrativeConstraints: {} };

describe('pastTenseCheck', () => {
  test('passes empty draft', () => {
    expect(pastTenseCheck({ text: '' }, {}, infantBand).passed).toBe(true);
  });

  test('passes pure present-tense draft', () => {
    const r = pastTenseCheck({
      text: 'Mama sways in the shade.\nScarlett snuggles where lights fade.\nMama watches her cheek.\nPorch boards give one soft creak.'
    }, {}, infantBand);
    expect(r.passed).toBe(true);
  });

  test('flags irregular past-tense "stayed"', () => {
    const r = pastTenseCheck({ text: 'Mama stays where she stayed.' }, {}, infantBand);
    expect(r.passed).toBe(false);
    expect(r.code).toBe('past_tense_irregular');
    expect(r.detail.verb.toLowerCase()).toBe('stayed');
  });

  test('flags irregular past-tense "swayed"', () => {
    const r = pastTenseCheck({ text: 'Scarlett reaches as Mama swayed.' }, {}, infantBand);
    expect(r.passed).toBe(false);
    expect(r.detail.verb.toLowerCase()).toBe('swayed');
  });

  test('flags regular past-tense "looked"', () => {
    const r = pastTenseCheck({ text: 'She looked up.' }, {}, infantBand);
    expect(r.passed).toBe(false);
    expect(r.code).toBe('past_tense_regular');
    expect(r.detail.verb.toLowerCase()).toBe('looked');
  });

  test('does not flag short -ed words like "red"', () => {
    const r = pastTenseCheck({ text: 'Red leaves. Bed is soft. Mama hums.' }, {}, infantBand);
    expect(r.passed).toBe(true);
  });

  test('skips on PB_EARLY_READER band', () => {
    const r = pastTenseCheck({ text: 'She looked up and saw the moon.' }, {}, earlyReader);
    expect(r.passed).toBe(true);
  });

  test('skips when no ageBand specified', () => {
    const r = pastTenseCheck({ text: 'Mama looked up.' }, {}, {});
    expect(r.passed).toBe(true);
  });
});
