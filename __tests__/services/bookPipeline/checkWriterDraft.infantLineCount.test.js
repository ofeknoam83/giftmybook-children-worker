const {
  resolvePictureBookLineRange,
} = require('../../../services/bookPipeline/qa/checkWriterDraft');
const { AGE_BANDS } = require('../../../services/bookPipeline/constants');

describe('resolvePictureBookLineRange (PR D / D.1)', () => {
  test('infant band (PB_INFANT, 0-1) requires 2 lines per spread', () => {
    const range = resolvePictureBookLineRange(AGE_BANDS.PB_INFANT);
    expect(range).toEqual({ min: 2, max: 2 });
  });

  test('toddler band (PB_TODDLER, 0-3) requires 4 lines per spread', () => {
    const range = resolvePictureBookLineRange(AGE_BANDS.PB_TODDLER);
    expect(range).toEqual({ min: 4, max: 4 });
  });

  test('preschool band (PB_PRESCHOOL, 3-6) requires 4 lines per spread', () => {
    const range = resolvePictureBookLineRange(AGE_BANDS.PB_PRESCHOOL);
    expect(range).toEqual({ min: 4, max: 4 });
  });

  test('unknown / missing age band falls back to 4-line picture-book default', () => {
    expect(resolvePictureBookLineRange(undefined)).toEqual({ min: 4, max: 4 });
    expect(resolvePictureBookLineRange('not-a-band')).toEqual({ min: 4, max: 4 });
  });
});
