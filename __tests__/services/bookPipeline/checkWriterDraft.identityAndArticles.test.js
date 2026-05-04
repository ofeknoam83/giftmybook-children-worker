const {
  wordsRhyme,
  findDroppedArticles,
  findAddressNameConcat,
  findVerbCrutches,
  checkPersonalizationSaturation,
  extractPersonalizationItems,
} = require('../../../services/bookPipeline/qa/checkWriterDraft');

describe('wordsRhyme — identity, stem, and suffix-only rejections (PR B / B.1)', () => {
  test('rejects identity rhymes', () => {
    expect(wordsRhyme('town', 'town')).toBe(false);
    expect(wordsRhyme('squeals', 'squeals')).toBe(false);
  });

  test('rejects identity rhymes that differ only in punctuation or case', () => {
    expect(wordsRhyme('Town.', 'town,')).toBe(false);
    expect(wordsRhyme('Squeals!', 'squeals')).toBe(false);
    expect(wordsRhyme('TOWN', 'Town')).toBe(false);
  });

  test('rejects stem rhymes where one word fully contains the other', () => {
    expect(wordsRhyme('town', 'hometown')).toBe(false);
    expect(wordsRhyme('light', 'spotlight')).toBe(false);
    expect(wordsRhyme('day', 'today')).toBe(false);
  });

  test('rejects suffix-only rhymes carried by a shared grammatical ending', () => {
    expect(wordsRhyme('running', 'jumping')).toBe(false);
    expect(wordsRhyme('quickly', 'slowly')).toBe(false);
  });

  test('rejects non-rhyming pairs with different vowels and codas', () => {
    expect(wordsRhyme('beat', 'wide')).toBe(false);
  });

  test('accepts genuine rhymes', () => {
    expect(wordsRhyme('tune', 'moon')).toBe(true);
    expect(wordsRhyme('door', 'floor')).toBe(true);
    expect(wordsRhyme('high', 'sky')).toBe(true);
    expect(wordsRhyme('grass', 'pass')).toBe(true);
    expect(wordsRhyme('cat', 'hat')).toBe(true);
  });
});

describe('findDroppedArticles (PR B / B.2)', () => {
  test('flags "down street" as a dropped article', () => {
    expect(findDroppedArticles('The stroller squeaks down street.')).toEqual(['down street']);
  });

  test('flags "by feet" as a dropped article', () => {
    expect(findDroppedArticles('Birds tweet by feet.')).toEqual(['by feet']);
  });

  test('does not flag prepositional phrases that include a determiner', () => {
    expect(findDroppedArticles('She walks down the street.')).toEqual([]);
    expect(findDroppedArticles('Birds tweet by her feet.')).toEqual([]);
  });

  test('returns multiple offenders when present in one text', () => {
    const out = findDroppedArticles('Run down street and on bench.');
    expect(out).toContain('down street');
    expect(out).toContain('on bench');
  });
});

describe('findAddressNameConcat (PR B / B.3)', () => {
  const brief = {
    customDetails: { mom_name: 'Courtney' },
    child: { anecdotes: { calls_mom: 'Mama' } },
  };

  test('flags "Mama Courtney" when Courtney is the declared mom name', () => {
    expect(findAddressNameConcat('Mama Courtney holds her tight.', brief)).toEqual(['Mama Courtney']);
  });

  test('does not flag "Mama Bear" — Bear is not a declared parent name', () => {
    expect(findAddressNameConcat('Mama Bear walks by.', brief)).toEqual([]);
  });

  test('does not flag the bare proper name on its own', () => {
    expect(findAddressNameConcat('Just Courtney here.', brief)).toEqual([]);
  });

  test('does not flag the bare address term on its own', () => {
    expect(findAddressNameConcat('Mama holds her tight.', brief)).toEqual([]);
  });

  test('returns no offenders when brief has no parent names', () => {
    expect(findAddressNameConcat('Mama Courtney holds her tight.', {})).toEqual([]);
  });
});

describe('findVerbCrutches (PR B / B.4)', () => {
  function makeBook(crutchSpreadCount, totalSpreads) {
    const spreads = [];
    for (let i = 1; i <= totalSpreads; i++) {
      const text = i <= crutchSpreadCount
        ? 'The baby squeals with joy.'
        : 'The baby smiles softly today.';
      spreads.push({ spreadNumber: i, manuscript: { text } });
    }
    return spreads;
  }

  test('flags a verb that appears in more than 25% of spreads (8 of 13 = ~62%)', () => {
    const out = findVerbCrutches(makeBook(8, 13));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].verb).toBe('squeal');
    expect(out[0].spreadCount).toBe(8);
    expect(out[0].ratio).toBeGreaterThan(0.25);
  });

  test('does not flag a verb that appears in only 2 of 13 spreads (~15%)', () => {
    const out = findVerbCrutches(makeBook(2, 13));
    expect(out.find(o => o.verb === 'squeal')).toBeUndefined();
  });

  test('returns empty array when there are no spreads', () => {
    expect(findVerbCrutches([])).toEqual([]);
  });
});

describe('checkPersonalizationSaturation (PR B / B.5)', () => {
  const brief = {
    child: {
      interests: ['trains', 'dinosaurs', 'mud'],
      anecdotes: { calls_mom: 'Smushy', funny_thing: 'snuggles in the morning' },
    },
    customDetails: { favorite_food: 'pancakes' },
  };

  test('reports low saturation when fewer than 60% of items appear in manuscript', () => {
    const spreads = [
      { spreadNumber: 1, manuscript: { text: 'Smushy reads a story.' } },
      { spreadNumber: 2, manuscript: { text: 'Smushy tucks her in.' } },
    ];
    const out = checkPersonalizationSaturation(brief, spreads);
    expect(out.threshold).toBe(0.6);
    expect(out.total).toBeGreaterThan(0);
    expect(out.ratio).toBeLessThan(0.6);
    expect(out.missing.length).toBeGreaterThan(0);
  });

  test('reports passing saturation when most items appear in manuscript', () => {
    const spreads = [
      { spreadNumber: 1, manuscript: { text: 'Smushy reads about trains and dinosaurs.' } },
      { spreadNumber: 2, manuscript: { text: 'Pancakes and mud at snuggles time.' } },
    ];
    const out = checkPersonalizationSaturation(brief, spreads);
    expect(out.ratio).toBeGreaterThanOrEqual(0.6);
  });

  test('returns ratio 1 with empty items list when brief has no personalization fields', () => {
    const out = checkPersonalizationSaturation({}, [
      { spreadNumber: 1, manuscript: { text: 'Hello.' } },
    ]);
    expect(out.ratio).toBe(1);
    expect(out.total).toBe(0);
  });

  test('extractPersonalizationItems collects interests, anecdotes, and custom details', () => {
    const items = extractPersonalizationItems(brief);
    const labels = items.map(i => i.label);
    expect(labels).toEqual(expect.arrayContaining([
      'interest: trains',
      'interest: dinosaurs',
      'interest: mud',
      'address calls_mom: Smushy',
      'questionnaire funny_thing: snuggles in the morning',
      'questionnaire favorite_food: pancakes',
    ]));
  });
});
