const { toLegacyStoryPlan } = require('../../../services/bookPipeline/adapters/toLegacyStoryPlan');
const { computePageCount, computeSynopsis } = require('../../../services/coverMetadata');

function makeDoc(overrides = {}) {
  return {
    version: 'book-pipeline-v1',
    request: { theme: 'adventure', child: { name: 'Luna', age: 5 } },
    brief: { child: { name: 'Luna', age: 5, gender: 'girl' } },
    cover: { title: "Luna's Big Day", imageUrl: 'https://example.com/cover.png' },
    visualBible: {
      hero: {
        name: 'Luna',
        physicalDescription: 'Curly brown hair, bright eyes.',
        outfitDescription: 'Red raincoat and yellow boots.',
      },
      supportingCast: [{ role: 'mom', name: 'Mom', description: 'Warm smile, brown hair, green scarf.' }],
    },
    spreads: Array.from({ length: 13 }, (_, i) => ({
      spreadNumber: i + 1,
      manuscript: { text: `Spread ${i + 1} text content.` },
      illustration: {
        imageUrl: `https://gcs.example.com/spread-${i + 1}.png`,
        imageStorageKey: `books/xyz/spread-${i + 1}.png`,
        scenePrompt: `Scene prompt for spread ${i + 1}`,
      },
      spec: { location: 'forest', scenePrompt: null },
    })),
    ...overrides,
  };
}

describe('toLegacyStoryPlan', () => {
  test('produces storyPlan with title + structural entries + spread entries', () => {
    const doc = makeDoc();
    const { storyPlan, entriesWithIllustrations } = toLegacyStoryPlan(doc);

    expect(storyPlan.title).toBe("Luna's Big Day");
    expect(storyPlan._generatedByNewPipeline).toBe(true);
    expect(storyPlan.isChapterBook).toBe(false);
    expect(storyPlan.isGraphicNovel).toBe(false);

    const types = entriesWithIllustrations.map(e => e.type);
    expect(types[0]).toBe('half_title_page');
    expect(types).toContain('title_page');
    expect(types).toContain('copyright_page');
    expect(types).toContain('dedication_page');
    expect(types).toContain('closing_page');
    expect(types.filter(t => t === 'spread')).toHaveLength(13);
  });

  test('spread entries carry scene prompt + illustration URL', () => {
    const { entriesWithIllustrations } = toLegacyStoryPlan(makeDoc());
    const firstSpread = entriesWithIllustrations.find(e => e.type === 'spread' && e.spread === 1);
    expect(firstSpread.spreadIllustrationUrl).toMatch(/spread-1\.png$/);
    expect(firstSpread.spread_image_prompt).toBe('Scene prompt for spread 1');
    expect(firstSpread.left.text).toBe('Spread 1 text content.');
    expect(firstSpread.right.text).toBe('');
  });

  test('pulls hero physical + outfit description into storyPlan for regen', () => {
    const { storyPlan } = toLegacyStoryPlan(makeDoc());
    expect(storyPlan.characterDescription).toMatch(/curly brown hair/i);
    expect(storyPlan.characterOutfit).toMatch(/red raincoat/i);
    expect(storyPlan.heroOutfitFromCover).toMatch(/red raincoat/i);
  });

  test('flattens supporting cast descriptions for legacy additionalCoverCharacters', () => {
    const { storyPlan } = toLegacyStoryPlan(makeDoc());
    expect(storyPlan.additionalCoverCharacters).toMatch(/warm smile/i);
    expect(storyPlan.coverHadVisionSecondaries).toBe(true);
  });

  test('computePageCount is correct: 13 spreads + 5 structural front + 3 back = within 32-page minimum', () => {
    const { storyPlan } = toLegacyStoryPlan(makeDoc());
    // Legacy computation: 13*2 + 8*1 = 34 → normalizePageCount rounds up to even → 34
    const pageCount = computePageCount(storyPlan);
    expect(pageCount).toBeGreaterThanOrEqual(32);
    expect(pageCount % 2).toBe(0);
  });

  test('computeSynopsis derives a non-empty back-cover blurb from manuscript', () => {
    const { storyPlan } = toLegacyStoryPlan(makeDoc());
    const synopsis = computeSynopsis(storyPlan, { name: 'Luna' });
    expect(synopsis).toMatch(/Spread 1/);
  });
});
