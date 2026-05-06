/**
 * v2 ageProfiles — band derivation must mirror v1 normalizeRequest's
 * banding so the cutover doesn't shift any child's age band.
 */

const {
  getAgeProfile, listAgeBands, isPictureBookBand, deriveAgeBandFromAge,
} = require('../../../services/bookPipelineV2/ageProfiles');

describe('ageProfiles', () => {
  test('lists the 4 picture-book bands', () => {
    const bands = listAgeBands().sort();
    expect(bands).toEqual(['PB_EARLY_READER', 'PB_INFANT', 'PB_PRESCHOOL', 'PB_TODDLER']);
  });

  test('every band loads with narrativeConstraints', () => {
    for (const band of listAgeBands()) {
      const p = getAgeProfile(band);
      expect(p.ageBand).toBe(band);
      expect(p.narrativeConstraints).toBeDefined();
      expect(p.narrativeConstraints.spreadCount).toBeGreaterThan(0);
    }
  });

  test('isPictureBookBand returns true for known bands and false otherwise', () => {
    expect(isPictureBookBand('PB_TODDLER')).toBe(true);
    expect(isPictureBookBand('CHAPTER_BOOK')).toBe(false);
    expect(isPictureBookBand(null)).toBe(false);
  });

  test('returned profile is a deep clone (mutation-safe)', () => {
    const a = getAgeProfile('PB_INFANT');
    a.narrativeConstraints.spreadCount = 999;
    const b = getAgeProfile('PB_INFANT');
    expect(b.narrativeConstraints.spreadCount).not.toBe(999);
  });

  describe('deriveAgeBandFromAge', () => {
    test('< 18 months → PB_INFANT', () => {
      expect(deriveAgeBandFromAge({ ageMonths: 0 })).toBe('PB_INFANT');
      expect(deriveAgeBandFromAge({ ageMonths: 17 })).toBe('PB_INFANT');
    });
    test('18–36 months → PB_TODDLER', () => {
      expect(deriveAgeBandFromAge({ ageMonths: 18 })).toBe('PB_TODDLER');
      expect(deriveAgeBandFromAge({ ageMonths: 36 })).toBe('PB_TODDLER');
    });
    test('37–72 months → PB_PRESCHOOL', () => {
      expect(deriveAgeBandFromAge({ ageMonths: 37 })).toBe('PB_PRESCHOOL');
      expect(deriveAgeBandFromAge({ ageMonths: 72 })).toBe('PB_PRESCHOOL');
    });
    test('> 72 months → PB_EARLY_READER', () => {
      expect(deriveAgeBandFromAge({ ageMonths: 73 })).toBe('PB_EARLY_READER');
      expect(deriveAgeBandFromAge({ ageMonths: 96 })).toBe('PB_EARLY_READER');
    });
    test('falls back to ageYears when months absent', () => {
      expect(deriveAgeBandFromAge({ ageYears: 1 })).toBe('PB_INFANT');     // 12 mo
      expect(deriveAgeBandFromAge({ ageYears: 2 })).toBe('PB_TODDLER');    // 24 mo
      expect(deriveAgeBandFromAge({ ageYears: 4 })).toBe('PB_PRESCHOOL');  // 48 mo
      expect(deriveAgeBandFromAge({ ageYears: 7 })).toBe('PB_EARLY_READER'); // 84 mo
    });
    test('defaults to PB_PRESCHOOL when nothing usable provided', () => {
      expect(deriveAgeBandFromAge({})).toBe('PB_PRESCHOOL');
    });
  });
});
