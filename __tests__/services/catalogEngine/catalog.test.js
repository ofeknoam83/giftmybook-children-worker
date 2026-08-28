/**
 * Catalog invariants (the handoff's validate_release.py, as a jest gate) +
 * age-band routing + the ageBounds↔ageEngines.json consistency check.
 */

const {
  loadCatalog, loadAgeEngines, validateCatalog, ageBandForAge,
  toWireBand, fromWireBand, getBook, eligibleBooks, renderTitle, listThemes,
} = require('../../../services/catalogEngine/catalog');
const { BAND_BOUNDS, EXACT_AGE_BOUNDS, boundsFor, countWords } = require('../../../services/catalogEngine/ageBounds');

describe('catalog invariants (release gate)', () => {
  test('catalog loads with 12 themes and 228 books, 12 ordered beats each', () => {
    const catalog = loadCatalog();
    expect(validateCatalog(catalog)).toEqual([]);
    expect(Object.keys(catalog.themes)).toHaveLength(12);
    expect(listThemes().reduce((n, t) => n + Object.values(t.bandCounts).reduce((a, b) => a + b, 0), 0)).toBe(228);
  });

  test('legacy 2_3 book ids route by catalog band key, never by id parsing', () => {
    const hit = getBook('farm_2_3_hello_farm');
    expect(hit).not.toBeNull();
    expect(hit.ageBand).toBe('1-3');
  });

  test('eligibleBooks accepts wire-format band keys', () => {
    expect(eligibleBooks('farm', '1_3')).toEqual(eligibleBooks('farm', '1-3'));
  });

  test('renderTitle substitutes {name}', () => {
    const { book } = getBook('farm_2_3_hello_farm');
    expect(renderTitle(book, 'Emma')).toBe("Emma's Farm Day");
  });
});

describe('ageBandForAge boundaries (2,3,4,5,6,7,8,10)', () => {
  test.each([
    [1, '1-3'], [2, '1-3'], [3, '1-3'], [4, '4-5'], [5, '4-5'],
    [6, '6-7'], [7, '6-7'], [8, '8-10'], [10, '8-10'],
  ])('age %i → band %s', (age, band) => {
    expect(ageBandForAge(age)).toBe(band);
  });

  test('rejects out-of-range ages', () => {
    expect(() => ageBandForAge(0)).toThrow();
    expect(() => ageBandForAge(11)).toThrow();
    expect(() => ageBandForAge(2.5)).toThrow();
  });

  test('wire band conversion round-trips', () => {
    expect(toWireBand('1-3')).toBe('1_3');
    expect(fromWireBand('8_10')).toBe('8-10');
  });
});

describe('ageBounds stays consistent with the vendored ageEngines.json', () => {
  const engines = loadAgeEngines();

  test.each(Object.keys(BAND_BOUNDS))('band %s ranges match the JSON', (band) => {
    const e = engines[band];
    expect(BAND_BOUNDS[band].perSpread).toEqual([e.words_per_spread.min, e.words_per_spread.max]);
    expect(BAND_BOUNDS[band].total).toEqual([e.total_words.min, e.total_words.max]);
  });

  test.each([1, 2, 3])('exact-age %i calibration matches the JSON prose', (age) => {
    const text = engines['1-3'].exact_age_calibration[String(age)];
    const m = text.match(/(\d+)-(\d+) words per spread; (\d+)-(\d+) total/);
    expect(m).not.toBeNull();
    expect(EXACT_AGE_BOUNDS[age].perSpread).toEqual([Number(m[1]), Number(m[2])]);
    expect(EXACT_AGE_BOUNDS[age].total).toEqual([Number(m[3]), Number(m[4])]);
  });

  test('boundsFor uses exact-age calibration only inside 1-3', () => {
    expect(boundsFor('1-3', 1)).toEqual(EXACT_AGE_BOUNDS[1]);
    expect(boundsFor('4-5', 4)).toEqual(BAND_BOUNDS['4-5']);
  });

  test('countWords counts word tokens, not punctuation', () => {
    expect(countWords('Hello, farm! Here we are!')).toBe(5);
    expect(countWords('  ')).toBe(0);
  });
});
