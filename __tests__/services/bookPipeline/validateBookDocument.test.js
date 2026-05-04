const {
  validateStoryBible,
} = require('../../../services/bookPipeline/schema/validateBookDocument');
const { AGE_BANDS, FORMATS } = require('../../../services/bookPipeline/constants');

function buildStoryBibleDoc(ageBand, sbOverrides = {}) {
  const baseSb = {
    narrativeSpine: 'Scarlett notices the warm light through her quiet day with Mama.',
    beginningHook: 'Mama lifts Scarlett to see the morning light on the wall.',
    middleEscalation: 'Together they follow the sun through the kitchen and the porch.',
    endingPayoff: 'Scarlett snuggles into Mama as the day softens to evening.',
    emotionalArc: 'Curious — warm — calm.',
    humorStrategy: 'The cat curls into Mama\'s lap, surprising Scarlett with a soft purr.',
    locationStrategy: 'Two connected micro-settings: the kitchen window and the porch.',
    visualJourneySpine: 'The same warm beam of light travels from the kitchen to the porch across the day, threading both micro-settings together.',
    recurringVisualMotifs: ['warm light', 'Mama\'s hands', 'soft blanket'],
    personalizationTargets: ['Mama Courtney', 'nickname Smushy'],
    cinematicLocations: ['kitchen window at morning', 'porch at midday'],
    forbiddenMoves: ['locomotion'],
  };
  return {
    request: { ageBand, format: FORMATS.PICTURE_BOOK, theme: 'mothers_day', bookId: 'b1' },
    storyBible: { ...baseSb, ...sbOverrides },
  };
}

describe('validateStoryBible — cinematicLocations gate', () => {
  test('non-infant band requires at least 3 cinematicLocations (existing behavior preserved)', () => {
    const doc = buildStoryBibleDoc(AGE_BANDS.PB_PRESCHOOL, {
      cinematicLocations: ['kitchen', 'porch'],
    });
    const issues = validateStoryBible(doc);
    expect(issues.some(i => i.includes('cinematicLocations'))).toBe(true);
    expect(issues.some(i => i.includes('at least 3'))).toBe(true);
  });

  test('non-infant band passes when 3+ cinematicLocations are present', () => {
    const doc = buildStoryBibleDoc(AGE_BANDS.PB_PRESCHOOL, {
      cinematicLocations: ['hilltop', 'lighthouse', 'tide pool'],
    });
    const issues = validateStoryBible(doc);
    expect(issues.filter(i => i.includes('cinematicLocations'))).toEqual([]);
  });

  test('infant band passes with 1 cinematicLocation (waiver applied)', () => {
    const doc = buildStoryBibleDoc(AGE_BANDS.PB_INFANT, {
      cinematicLocations: ['kitchen window at morning'],
    });
    const issues = validateStoryBible(doc);
    expect(issues.filter(i => i.includes('cinematicLocations'))).toEqual([]);
  });

  test('infant band passes with 2 cinematicLocations (the lap-baby ceiling)', () => {
    const doc = buildStoryBibleDoc(AGE_BANDS.PB_INFANT, {
      cinematicLocations: ['kitchen window at morning', 'porch at midday'],
    });
    const issues = validateStoryBible(doc);
    expect(issues.filter(i => i.includes('cinematicLocations'))).toEqual([]);
  });

  test('infant band rejects 0 cinematicLocations', () => {
    const doc = buildStoryBibleDoc(AGE_BANDS.PB_INFANT, {
      cinematicLocations: [],
    });
    const issues = validateStoryBible(doc);
    expect(issues.some(i => i.includes('cinematicLocations') && i.includes('at least 1'))).toBe(true);
  });

  test('infant band rejects 3+ cinematicLocations (over the lap-baby cap)', () => {
    const doc = buildStoryBibleDoc(AGE_BANDS.PB_INFANT, {
      cinematicLocations: ['kitchen', 'porch', 'garden'],
    });
    const issues = validateStoryBible(doc);
    expect(issues.some(i => i.includes('cinematicLocations') && i.includes('at most 2'))).toBe(true);
  });
});
