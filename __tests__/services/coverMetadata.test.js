const {
  computePageCount,
  computeSynopsis,
  computeCoverPdfMetadata,
} = require('../../services/coverMetadata');

describe('computePageCount', () => {
  test('picture book: 10 spreads → 32 (min clamp)', () => {
    const source = { entries: Array.from({ length: 10 }, () => ({ type: 'spread' })) };
    expect(computePageCount(source)).toBe(32);
  });

  test('picture book: 18 spreads → 36 (even)', () => {
    const source = { entries: Array.from({ length: 18 }, () => ({ type: 'spread' })) };
    expect(computePageCount(source)).toBe(36);
  });

  test('picture book: singles + spreads mix, rounds up to even', () => {
    const source = {
      entries: [
        { type: 'single' },
        ...Array.from({ length: 16 }, () => ({ type: 'spread' })),
        { type: 'single' },
      ],
    };
    // 1 + 32 + 1 = 34 → already even, min 32 ok
    expect(computePageCount(source)).toBe(34);
  });

  test('graphic novel via allPanels (storyPlan shape)', () => {
    const source = { allPanels: Array.from({ length: 48 }, (_, i) => ({ panelNumber: i })) };
    // 2 + ceil(48/2) + 1 = 27 → +1 even = 28 → clamp 32
    expect(computePageCount(source, { isGraphicNovel: true })).toBe(32);
  });

  test('graphic novel via scenes[] (storyContent shape)', () => {
    const source = {
      isGraphicNovel: true,
      scenes: [
        { panels: Array.from({ length: 30 }, () => ({})) },
        { panels: Array.from({ length: 30 }, () => ({})) },
        { panels: Array.from({ length: 10 }, () => ({})) },
      ],
    };
    // total panels = 70 → 2 + 35 + 1 = 38
    expect(computePageCount(source)).toBe(38);
  });

  test('chapter book via chapters', () => {
    const source = { chapters: Array.from({ length: 5 }, () => ({})) };
    // 2 + 5*4 + 1 = 23 → +1 even = 24 → clamp 32
    expect(computePageCount(source, { isChapterBook: true })).toBe(32);
  });

  test('chapter book large', () => {
    const source = { isChapterBook: true, chapters: Array.from({ length: 12 }, () => ({})) };
    // 2 + 48 + 1 = 51 → 52
    expect(computePageCount(source)).toBe(52);
  });

  test('empty source → 32', () => {
    expect(computePageCount({})).toBe(32);
  });
});

describe('computeSynopsis', () => {
  const child = { name: 'Luna' };

  test('picture book prefers storyPlan.synopsis', () => {
    const source = { synopsis: 'Epic tale', entries: [{ type: 'spread', left: { text: 'Once' }, right: { text: 'upon' } }] };
    expect(computeSynopsis(source, child)).toBe('Epic tale');
  });

  test('picture book does not use spread narration when synopsis is missing', () => {
    const source = {
      entries: [
        { type: 'spread', left: { text: 'Once' }, right: { text: 'upon a time' } },
        { type: 'spread', left: { text: 'there was' }, right: { text: 'a brave child' } },
      ],
    };
    expect(computeSynopsis(source, child)).toBe('A personalized bedtime story for Luna');
  });

  test('picture book uses storyBible.narrativeSpine when synopsis missing', () => {
    const source = {
      entries: [{ type: 'spread', left: { text: 'ignored' } }],
      storyBible: { narrativeSpine: 'A quest for courage and kindness.' },
    };
    expect(computeSynopsis(source, child)).toBe('A quest for courage and kindness.');
  });

  test('picture book uses plotSynopsis when higher-priority fields missing', () => {
    const source = { plotSynopsis: 'One-line plot from the writer plan.' };
    expect(computeSynopsis(source, child)).toBe('One-line plot from the writer plan.');
  });

  test('picture book uses tagline when synopsis and bible missing', () => {
    const source = { tagline: 'Reach for the stars.' };
    expect(computeSynopsis(source, child)).toBe('Reach for the stars.');
  });

  test('picture book fallback when no entries', () => {
    expect(computeSynopsis({}, child)).toBe('A personalized bedtime story for Luna');
  });

  test('graphic novel uses storyBible.logline when synopsis missing', () => {
    const source = { isGraphicNovel: true, storyBible: { logline: 'Heroic quest across worlds' } };
    expect(computeSynopsis(source, child)).toBe('Heroic quest across worlds');
  });

  test('graphic novel falls back to tagline', () => {
    const source = { isGraphicNovel: true, tagline: 'Luna rises' };
    expect(computeSynopsis(source, child)).toBe('Luna rises');
  });

  test('chapter book joins first 2 chapter synopses', () => {
    const source = {
      isChapterBook: true,
      chapters: [
        { synopsis: 'Luna finds a map.' },
        { synopsis: 'Luna sets sail.' },
        { synopsis: 'ignored' },
      ],
    };
    expect(computeSynopsis(source, child)).toBe('Luna finds a map. Luna sets sail.');
  });

  test('chapter book fallback', () => {
    expect(computeSynopsis({ isChapterBook: true, chapters: [] }, child))
      .toBe('A personalized chapter book for Luna');
  });

  test('accepts childDetails.childName alias', () => {
    expect(computeSynopsis({}, { childName: 'Aya' }))
      .toBe('A personalized bedtime story for Aya');
  });
});

describe('computeCoverPdfMetadata', () => {
  test('returns both pageCount and synopsis', () => {
    const source = {
      entries: Array.from({ length: 20 }, () => ({ type: 'spread' })),
      synopsis: 'A magical story',
    };
    const result = computeCoverPdfMetadata(source, { name: 'Luna' });
    expect(result).toEqual({ pageCount: 40, synopsis: 'A magical story' });
  });

  test('graphic novel: storyContent with scenes + tagline → identical to storyPlan with allPanels + tagline', () => {
    const panels = Array.from({ length: 30 }, (_, i) => ({ panelNumber: i }));

    const fromStoryPlan = computeCoverPdfMetadata(
      { allPanels: panels, tagline: 'Luna rises' },
      { name: 'Luna' },
      { isGraphicNovel: true },
    );

    const fromStoryContent = computeCoverPdfMetadata(
      { isGraphicNovel: true, scenes: [{ panels }], tagline: 'Luna rises' },
      { name: 'Luna' },
    );

    expect(fromStoryContent).toEqual(fromStoryPlan);
  });
});
