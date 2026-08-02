const { onomatopoeiaCheck, findOnomatopoeiaEvents } = require('../../../../services/bookPipelineV3/gate/checks/onomatopoeia');
const { onomatopoeiaOveruseLint } = require('../../../../services/bookPipelineV3/gate/checks/bookLints');
const { isHardCode } = require('../../../../services/bookPipelineV3/gate/runGate');

const preschool = { ageBand: 'PB_PRESCHOOL' };
const toddler = { ageBand: 'PB_TODDLER' };
const earlyReader = { ageBand: 'PB_EARLY_READER' };

describe('findOnomatopoeiaEvents', () => {
  test('flags reduplicated sound words in every separator form', () => {
    expect(findOnomatopoeiaEvents('Tap tap went the branch.')[0].kind).toBe('reduplication');
    expect(findOnomatopoeiaEvents('Tap, tap. Someone was there.')[0].kind).toBe('reduplication');
    expect(findOnomatopoeiaEvents('The clock went tick-tock all night.').length).toBeGreaterThan(0);
    expect(findOnomatopoeiaEvents('Knock knock knock!')[0].kind).toBe('reduplication');
  });

  test('flags known reduplicative pairs and exclamation/caps effects', () => {
    expect(findOnomatopoeiaEvents('She heard the pitter patter of rain.')[0].kind).toBe('pair');
    expect(findOnomatopoeiaEvents('Whoosh! The rocket flew.')[0].kind).toBe('exclamation');
    expect(findOnomatopoeiaEvents('Then — BOOM — the door opened.')[0].kind).toBe('caps');
  });

  test('never flags sound words used as ordinary verbs', () => {
    expect(findOnomatopoeiaEvents('Maya tapped twice on the little door.')).toEqual([]);
    expect(findOnomatopoeiaEvents('The rocket whooshed past the moon and popped over the hill.')).toEqual([]);
    expect(findOnomatopoeiaEvents('She knocked and the door creaked open.')).toEqual([]);
  });

  test('ignores non-sound reduplication ("no, no") and empty text', () => {
    expect(findOnomatopoeiaEvents('"No, no," said Mama.')).toEqual([]);
    expect(findOnomatopoeiaEvents('')).toEqual([]);
  });
});

describe('onomatopoeiaCheck', () => {
  test('reduplication is the HARD code for preschool and toddler', () => {
    for (const profile of [preschool, toddler]) {
      const r = onomatopoeiaCheck({ text: 'Tap tap went the branch.' }, null, profile);
      expect(r.passed).toBe(false);
      expect(r.code).toBe('onomatopoeia');
    }
  });

  test('onomatopoeia is a demotable hard gate code', () => {
    expect(isHardCode('onomatopoeia')).toBe(true);
    process.env.BOOK_PIPELINE_V3_QA_HARD = '0';
    try {
      expect(isHardCode('onomatopoeia')).toBe(false);
    } finally {
      delete process.env.BOOK_PIPELINE_V3_QA_HARD;
    }
  });

  test('reduplication is soft for early readers; exclamation-only is soft everywhere', () => {
    expect(onomatopoeiaCheck({ text: 'Tap tap.' }, null, earlyReader).code).toBe('onomatopoeia_soft');
    expect(onomatopoeiaCheck({ text: 'Whoosh! Off she went.' }, null, preschool).code).toBe('onomatopoeia_soft');
  });

  test('clean text passes', () => {
    expect(onomatopoeiaCheck({ text: 'Maya tapped twice on the little door.' }, null, preschool).passed).toBe(true);
  });
});

describe('onomatopoeiaOveruseLint', () => {
  const book = (texts) => ({
    spreads: texts.map((text, i) => ({ spread: i + 1, text, lines: [text] })),
  });

  test('a single sound-word moment is allowed', () => {
    expect(onomatopoeiaOveruseLint(book([
      'Maya raced to the door.', 'Whoosh! The wind sang.', 'She smiled.',
    ]))).toEqual([]);
  });

  test('two or more sound-word moments lint with the offending spreads', () => {
    const lints = onomatopoeiaOveruseLint(book([
      'Tap tap went the branch.', 'Maya looked up.', 'Whoosh! Off she flew.',
    ]));
    expect(lints).toHaveLength(1);
    expect(lints[0].code).toBe('onomatopoeia_overuse');
    expect(lints[0].spreads).toEqual([1, 3]);
  });
});
