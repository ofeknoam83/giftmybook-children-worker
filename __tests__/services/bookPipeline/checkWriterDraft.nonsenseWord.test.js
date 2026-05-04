const {
  findNonsenseWords,
} = require('../../../services/bookPipeline/qa/checkWriterDraft');
const {
  isCommonEnglishWord,
} = require('../../../services/bookPipeline/qa/wordDictionary');

describe('isCommonEnglishWord (PR D / D.3)', () => {
  test('accepts ordinary English words', () => {
    expect(isCommonEnglishWord('scarf')).toBe(true);
    expect(isCommonEnglishWord('dance')).toBe(true);
    expect(isCommonEnglishWord('peekaboo')).toBe(true);
  });

  test('accepts inflected forms via simple suffix-strip', () => {
    expect(isCommonEnglishWord('twirling')).toBe(true);
    expect(isCommonEnglishWord('giggled')).toBe(true);
    expect(isCommonEnglishWord('puppies')).toBe(true);
  });

  test('rejects fabricated rhyme-fillers', () => {
    expect(isCommonEnglishWord('farf')).toBe(false);
    expect(isCommonEnglishWord('shloop')).toBe(false);
    expect(isCommonEnglishWord('flarbo')).toBe(false);
  });

  test('passes very short tokens (under 4 chars) by default', () => {
    expect(isCommonEnglishWord('xy')).toBe(true);
    expect(isCommonEnglishWord('zzz')).toBe(true);
  });

  test('accepts baby-vocabulary additions (boop, oop, mwah)', () => {
    expect(isCommonEnglishWord('boop')).toBe(true);
    expect(isCommonEnglishWord('mwah')).toBe(true);
  });
});

describe('findNonsenseWords (PR D / D.3)', () => {
  const brief = {
    child: { name: 'Everleigh' },
    customDetails: { mom_name: 'Courtney' },
  };

  test('flags the invented word "farf" used as a forced rhyme for "scarf"', () => {
    const text = 'Mama waves the scarf.\nNot farf!';
    const out = findNonsenseWords(text, brief);
    expect(out.map(w => w.toLowerCase())).toContain('farf');
  });

  test('does not flag the declared child name "Everleigh"', () => {
    const text = 'Everleigh giggles softly.';
    const out = findNonsenseWords(text, brief);
    expect(out.map(w => w.toLowerCase())).not.toContain('everleigh');
  });

  test('does not flag mid-sentence proper nouns even when not declared', () => {
    // "Brooklyn" is a real word too, but the point: a capitalized mid-sentence
    // token is treated as a proper noun and not flagged as nonsense.
    const text = 'They went to Zylphalon together.';
    const out = findNonsenseWords(text, brief);
    expect(out.map(w => w.toLowerCase())).not.toContain('zylphalon');
  });

  test('does flag a sentence-initial nonsense word', () => {
    const text = 'Farf! Mama said with a wink.';
    const out = findNonsenseWords(text, brief);
    expect(out.map(w => w.toLowerCase())).toContain('farf');
  });

  test('does not flag hyphenated compounds whose parts are real ("sun-warmed")', () => {
    const text = 'A sun-warmed blanket waits.';
    const out = findNonsenseWords(text, brief);
    expect(out).toEqual([]);
  });

  test('returns empty array for clean baby-book text', () => {
    const text = 'Peekaboo! Mama hides her smile.\nThe scarf flutters down.';
    const out = findNonsenseWords(text, brief);
    expect(out).toEqual([]);
  });
});
