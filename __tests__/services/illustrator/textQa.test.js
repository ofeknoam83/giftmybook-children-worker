jest.mock('../../../services/illustrationGenerator', () => ({
  fetchWithTimeout: jest.fn(),
  getNextApiKey: jest.fn(() => 'test-key'),
}));

const {
  tokenizeForWordCounts,
  wordFrequencyMismatchIssues,
} = require('../../../services/illustrator/quality/text');

describe('tokenizeForWordCounts', () => {
  test('normalizes U+2019 smart apostrophe to match ASCII apostrophe', () => {
    expect(tokenizeForWordCounts('McDonald’s')).toEqual(['mcdonalds']);
    expect(tokenizeForWordCounts("McDonald's")).toEqual(['mcdonalds']);
  });

  test('strips apostrophes so "McDonalds" matches "McDonald\'s"', () => {
    expect(tokenizeForWordCounts('McDonalds')).toEqual(['mcdonalds']);
    expect(tokenizeForWordCounts("McDonald's")).toEqual(['mcdonalds']);
  });

  test('contractions count the same with or without apostrophe', () => {
    expect(tokenizeForWordCounts("don't stop")).toEqual(['dont', 'stop']);
    expect(tokenizeForWordCounts('dont stop')).toEqual(['dont', 'stop']);
  });

  test('handles modifier apostrophes U+02BB, U+02BC and Armenian U+055A', () => {
    expect(tokenizeForWordCounts('Donʻt')).toEqual(['dont']);
    expect(tokenizeForWordCounts('McDonaldʼs')).toEqual(['mcdonalds']);
    expect(tokenizeForWordCounts('it՚s')).toEqual(['its']);
  });
});

describe('wordFrequencyMismatchIssues', () => {
  test('manuscript U+2019 vs OCR ASCII apostrophe reports no mismatch', () => {
    const manuscript = 'Off to McDonald’s for lunch';
    const ocr = "Off to McDonald's for lunch";
    expect(wordFrequencyMismatchIssues(manuscript, ocr)).toEqual([]);
  });

  test('manuscript with apostrophe vs OCR dropping apostrophe is tolerated', () => {
    expect(wordFrequencyMismatchIssues("McDonald's", 'McDonalds')).toEqual([]);
    expect(wordFrequencyMismatchIssues("don't stop", 'dont stop')).toEqual([]);
  });

  test('legitimate word-count mismatch is still reported', () => {
    const issues = wordFrequencyMismatchIssues('hello world', 'hello world world');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/world/);
  });

  test('duplicated caption (every word 2x) is still reported', () => {
    const issues = wordFrequencyMismatchIssues(
      'The cat sat',
      'The cat sat The cat sat',
    );
    expect(issues.length).toBeGreaterThan(0);
  });

  test('single-instance OCR drop of a function word is forgiven', () => {
    // Spread 2 repro: manuscript has "And" at line start, OCR misses it.
    const manuscript = 'She held her bottle of warm Enfamil, And sip by sip climbed up the hill.';
    const ocr = 'She held her bottle of warm Enfamil, sip by sip climbed up the hill.';
    expect(wordFrequencyMismatchIssues(manuscript, ocr)).toEqual([]);
  });

  test('missing content word (non-stopword) is still reported', () => {
    const issues = wordFrequencyMismatchIssues('The cat sat', 'The sat');
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatch(/cat/);
  });

  test('extra instance of a stopword is reported (duplication)', () => {
    // Stopword tolerance only applies to UNDERCOUNT, not duplication.
    const issues = wordFrequencyMismatchIssues('The cat sat', 'The the cat sat');
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatch(/the/);
  });

  test('two-instance undercount of a stopword is still reported', () => {
    // Forgiveness is limited to a single-instance miss.
    const issues = wordFrequencyMismatchIssues('the the the cat', 'the cat');
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatch(/the/);
  });
});
