const {
  extractChild,
  normalizeAgeBand,
} = require('../../../services/bookPipeline/input/normalizeRequest');
const { AGE_BANDS, FORMATS } = require('../../../services/bookPipeline/constants');

describe('normalizeRequest extractChild', () => {
  test('collects interests from child.interests', () => {
    const c = extractChild({
      child: { name: 'A', age: 4, anecdotes: {}, interests: ['trains', 'mud'] },
    });
    expect(c.interests).toEqual(['trains', 'mud']);
  });

  test('collects interests from top-level childInterests', () => {
    const c = extractChild({
      childInterests: ['bugs', 'bike'],
      child: { name: 'B', age: 5, anecdotes: {} },
    });
    expect(c.interests).toEqual(['bugs', 'bike']);
  });

  test('parses favorite_activities string from child when no array', () => {
    const c = extractChild({
      child: { name: 'C', age: 3, anecdotes: {}, favorite_activities: 'soccer; drawing' },
    });
    expect(c.interests).toEqual(['soccer', 'drawing']);
  });

  test('parses favorite_activities from top-level', () => {
    const c = extractChild({
      favorite_activities: 'swimming,\ncooking',
      child: { name: 'D', age: 6, anecdotes: {} },
    });
    expect(c.interests).toEqual(['swimming', 'cooking']);
  });

  test('sets appearance from child or top-level aliases', () => {
    expect(
      extractChild({
        child: { name: 'E', anecdotes: {}, childAppearance: ' curly hair ' },
      }).appearance,
    ).toBe('curly hair');
    expect(
      extractChild({
        childAppearance: 'blue glasses',
        child: { name: 'F', anecdotes: {} },
      }).appearance,
    ).toBe('blue glasses');
  });

  test('omits interests and appearance when absent', () => {
    const c = extractChild({
      child: { name: 'G', age: 2, gender: 'f', anecdotes: {} },
    });
    expect(c.interests).toBeUndefined();
    expect(c.appearance).toBeUndefined();
  });
});

describe('normalizeRequest normalizeAgeBand', () => {
  // Critical: a 7-month-old has age 0.58 in our DOB pipeline. The previous
  // parseInt(age, 10) implementation truncated this to 0 and routed to the
  // toddler band, which is what produced the impossible-action infant book
  // (a 7-month-old written as if she could walk and talk).
  test('routes a 7-month-old (age 0.58) to PB_INFANT, not PB_TODDLER', () => {
    expect(normalizeAgeBand(0.58, FORMATS.PICTURE_BOOK)).toBe(AGE_BANDS.PB_INFANT);
  });

  test('routes a 1-year-old to PB_INFANT', () => {
    expect(normalizeAgeBand(1, FORMATS.PICTURE_BOOK)).toBe(AGE_BANDS.PB_INFANT);
  });

  test('routes a 1.4-year-old (just under threshold) to PB_INFANT', () => {
    expect(normalizeAgeBand(1.4, FORMATS.PICTURE_BOOK)).toBe(AGE_BANDS.PB_INFANT);
  });

  test('routes a 1.6-year-old (just over threshold) to PB_TODDLER', () => {
    expect(normalizeAgeBand(1.6, FORMATS.PICTURE_BOOK)).toBe(AGE_BANDS.PB_TODDLER);
  });

  test('routes a 2.5-year-old to PB_TODDLER', () => {
    expect(normalizeAgeBand(2.5, FORMATS.PICTURE_BOOK)).toBe(AGE_BANDS.PB_TODDLER);
  });

  test('routes a 4-year-old to PB_PRESCHOOL', () => {
    expect(normalizeAgeBand(4, FORMATS.PICTURE_BOOK)).toBe(AGE_BANDS.PB_PRESCHOOL);
  });

  test('early_reader format always routes to ER_EARLY, even for an infant age', () => {
    expect(normalizeAgeBand(0.58, FORMATS.EARLY_READER)).toBe(AGE_BANDS.ER_EARLY);
    expect(normalizeAgeBand(7, FORMATS.EARLY_READER)).toBe(AGE_BANDS.ER_EARLY);
  });

  test('accepts numeric strings ("0.58", "4") without truncating to 0', () => {
    expect(normalizeAgeBand('0.58', FORMATS.PICTURE_BOOK)).toBe(AGE_BANDS.PB_INFANT);
    expect(normalizeAgeBand('4', FORMATS.PICTURE_BOOK)).toBe(AGE_BANDS.PB_PRESCHOOL);
  });

  test('falls back to PB_PRESCHOOL when age is non-finite or negative', () => {
    expect(normalizeAgeBand(undefined, FORMATS.PICTURE_BOOK)).toBe(AGE_BANDS.PB_PRESCHOOL);
    expect(normalizeAgeBand(NaN, FORMATS.PICTURE_BOOK)).toBe(AGE_BANDS.PB_PRESCHOOL);
    expect(normalizeAgeBand(-1, FORMATS.PICTURE_BOOK)).toBe(AGE_BANDS.PB_PRESCHOOL);
  });

  test('falls back to ER_EARLY for early_reader when age is non-finite', () => {
    expect(normalizeAgeBand(undefined, FORMATS.EARLY_READER)).toBe(AGE_BANDS.ER_EARLY);
  });
});
