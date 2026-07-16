const { toLegacyStoryPlan, backfillCaptionModeEntries } = require('../../../../services/bookPipelineV3/contract/toLegacyStoryPlan');
const { computePageCount, computeSynopsis } = require('../../../../services/coverMetadata');

function makeDoc(overrides = {}) {
  return {
    // AA-CW-6: pipeline cutover bumped v1 → v2 alongside the AA-CW-1–5b
    // refactor stack. Use the current PIPELINE_VERSION value here so the
    // fixture matches the version that runs in production.
    version: 'book-pipeline-v2',
    request: { theme: 'adventure', child: { name: 'Luna', age: 5 } },
    brief: { child: { name: 'Luna', age: 5, gender: 'girl' } },
    storyBible: {
      narrativeSpine: 'A magical journey of discovery and friendship for Luna.',
    },
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

  test('computeSynopsis uses storyBible.narrativeSpine, not raw spread text', () => {
    const { storyPlan } = toLegacyStoryPlan(makeDoc());
    const synopsis = computeSynopsis(storyPlan, { name: 'Luna' });
    expect(synopsis).toMatch(/magical journey/);
    expect(synopsis).not.toMatch(/Spread 1/);
  });

  // Caption-mode contract (2026-07-16): the native illustrator renders square
  // images with NO on-image text — assemblePdf picks the caption-mode layout
  // (typeset verso + full-bleed recto) per entry via these two fields. Missing
  // fields silently fall back to the legacy wide-split path (bisected art, no
  // story text in the printed book), which is exactly the bug this pins.
  describe('caption-mode fields (native illustrator)', () => {
    test('native doc: every spread entry is square with the manuscript text as captionText', () => {
      const doc = makeDoc({ v3: { illustrator: { version: 'native', source: 'default' } } });
      const { entriesWithIllustrations } = toLegacyStoryPlan(doc);
      const spreads = entriesWithIllustrations.filter(e => e.type === 'spread');
      expect(spreads).toHaveLength(13);
      for (const entry of spreads) {
        expect(entry.illustrationAspect).toBe('square');
        expect(entry.captionText).toBe(`Spread ${entry.spread} text content.`);
      }
    });

    test('the storyPlan persisted to checkpoints carries the same fields (resume-safe)', () => {
      const doc = makeDoc({ v3: { illustrator: { version: 'native', source: 'default' } } });
      const { storyPlan } = toLegacyStoryPlan(doc);
      const spreads = storyPlan.entries.filter(e => e.type === 'spread');
      expect(spreads.every(e => e.illustrationAspect === 'square' && e.captionText)).toBe(true);
    });

    test('non-native / absent illustrator version stays on the wide-split path with no captionText', () => {
      const { entriesWithIllustrations } = toLegacyStoryPlan(makeDoc());
      const spreads = entriesWithIllustrations.filter(e => e.type === 'spread');
      for (const entry of spreads) {
        expect(entry.illustrationAspect).toBe('wide');
        expect(entry.captionText).toBeUndefined();
      }
    });

    test('structural entries are untouched by aspect/caption fields', () => {
      const doc = makeDoc({ v3: { illustrator: { version: 'native' } } });
      const { entriesWithIllustrations } = toLegacyStoryPlan(doc);
      const structural = entriesWithIllustrations.filter(e => e.type !== 'spread');
      expect(structural.every(e => e.illustrationAspect === undefined)).toBe(true);
    });
  });

  // Backfill for checkpoints written BEFORE the caption-mode fields existed:
  // native books resumed from such checkpoints must not re-break the layout.
  describe('backfillCaptionModeEntries', () => {
    function preFixEntries() {
      return [
        { type: 'half_title_page', title: 'T' },
        { type: 'spread', spread: 1, left: { text: 'One.' }, right: { text: '' } },
        { type: 'spread', spread: 2, left: { text: 'Two.' }, right: { text: '' } },
        { type: 'closing_page' },
      ];
    }

    test('marks pre-fix native spread entries square and recovers captionText from left.text', () => {
      const entries = preFixEntries();
      const count = backfillCaptionModeEntries(entries);
      expect(count).toBe(2);
      expect(entries[1]).toMatchObject({ illustrationAspect: 'square', captionText: 'One.' });
      expect(entries[2]).toMatchObject({ illustrationAspect: 'square', captionText: 'Two.' });
      expect(entries[0].illustrationAspect).toBeUndefined();
      expect(entries[3].illustrationAspect).toBeUndefined();
    });

    test('entries that already carry an aspect are left alone (idempotent, wide stays wide)', () => {
      const entries = [
        { type: 'spread', spread: 1, illustrationAspect: 'wide', left: { text: 'Legacy.' } },
        { type: 'spread', spread: 2, illustrationAspect: 'square', captionText: 'Done.', left: { text: 'Done.' } },
      ];
      expect(backfillCaptionModeEntries(entries)).toBe(0);
      expect(entries[0].illustrationAspect).toBe('wide');
      expect(entries[0].captionText).toBeUndefined();
      expect(entries[1].captionText).toBe('Done.');
    });

    test('missing left.text backfills an empty caption without throwing', () => {
      const entries = [{ type: 'spread', spread: 1 }];
      expect(backfillCaptionModeEntries(entries)).toBe(1);
      expect(entries[0].captionText).toBe('');
      expect(entries[0].illustrationAspect).toBe('square');
    });
  });
});
