const {
  findNonsenseSimiles,
} = require('../../../services/bookPipeline/qa/checkWriterDraft');

describe('findNonsenseSimiles (PR D / D.4)', () => {
  test('flags "as light as code"', () => {
    const out = findNonsenseSimiles('She is as light as code in the spring.');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].toLowerCase()).toContain('as light as code');
  });

  test('flags "soft as math"', () => {
    const out = findNonsenseSimiles('A blanket soft as math.');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].toLowerCase()).toContain('soft as math');
  });

  test('flags "like an algorithm"', () => {
    const out = findNonsenseSimiles('She moves like an algorithm.');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].toLowerCase()).toContain('like an algorithm');
  });

  test('flags "like a server"', () => {
    const out = findNonsenseSimiles('It hummed like a server.');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].toLowerCase()).toContain('like a server');
  });

  test('does NOT flag plausible baby-book similes', () => {
    expect(findNonsenseSimiles('Soft as fluff.')).toEqual([]);
    expect(findNonsenseSimiles('Warm as toast.')).toEqual([]);
    expect(findNonsenseSimiles('Quick as a wink.')).toEqual([]);
    expect(findNonsenseSimiles('Like a bunny in the grass.')).toEqual([]);
  });

  test('does NOT flag "like" used as a verb ("she likes Mama")', () => {
    expect(findNonsenseSimiles('She likes Mama.')).toEqual([]);
  });

  test('returns empty for plain text with no similes', () => {
    expect(findNonsenseSimiles('Mama hugs her tight.')).toEqual([]);
  });
});
