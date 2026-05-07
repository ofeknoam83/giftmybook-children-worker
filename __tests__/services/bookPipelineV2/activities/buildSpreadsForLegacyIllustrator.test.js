'use strict';

const {
  buildSpreadsForLegacyIllustrator,
} = require('../../../../services/bookPipelineV2/orchestration/activities/illustrationDirector');

/**
 * Regression: production book e3f4e0c0 crashed with
 *   "Cannot read properties of undefined (reading 'spreadChecks')"
 * inside renderAllSpreadsQuad because the manuscript-level refactor (PR #179)
 * stopped seeding the per-spread qa block. Every spread MUST carry
 * `qa.{writerChecks, spreadChecks, repairHistory}` so the legacy illustrator
 * can mutate those arrays as it runs.
 */
describe('buildSpreadsForLegacyIllustrator', () => {
  test('every spread carries the legacy qa block (writerChecks, spreadChecks, repairHistory)', () => {
    const spreadSpecs = [
      { spreadNumber: 1 },
      { spreadNumber: 2 },
      { spreadNumber: 13 },
    ];
    const draftBySpread = new Map([
      [1, { spread: 1, lines: ['L1', 'L2', 'L3', 'L4'] }],
      [2, { spread: 2, lines: ['a', 'b', 'c', 'd'] }],
      [13, { spread: 13, lines: ['x', 'y', 'z', 'w'] }],
    ]);

    const spreads = buildSpreadsForLegacyIllustrator({ spreadSpecs, draftBySpread });

    expect(spreads).toHaveLength(3);
    spreads.forEach((s) => {
      expect(s.qa).toBeDefined();
      expect(Array.isArray(s.qa.writerChecks)).toBe(true);
      expect(Array.isArray(s.qa.spreadChecks)).toBe(true);
      expect(Array.isArray(s.qa.repairHistory)).toBe(true);
      expect(s.qa.writerChecks).toHaveLength(0);
      expect(s.qa.spreadChecks).toHaveLength(0);
      expect(s.qa.repairHistory).toHaveLength(0);
    });
  });

  test('spread carries spec, manuscript text + lines, illustration=null', () => {
    const spreadSpecs = [{ spreadNumber: 1, location: 'kitchen' }];
    const draftBySpread = new Map([
      [1, { spread: 1, lines: ['One', 'Two', 'Three', 'Four'] }],
    ]);

    const [s] = buildSpreadsForLegacyIllustrator({ spreadSpecs, draftBySpread });

    expect(s.spreadNumber).toBe(1);
    expect(s.spec).toEqual({ spreadNumber: 1, location: 'kitchen' });
    expect(s.manuscript.text).toBe('One\nTwo\nThree\nFour');
    expect(s.manuscript.lines).toEqual(['One', 'Two', 'Three', 'Four']);
    expect(s.illustration).toBeNull();
  });

  test('falls back to empty manuscript when no draft for a spread', () => {
    const spreadSpecs = [{ spreadNumber: 1 }, { spreadNumber: 2 }];
    const draftBySpread = new Map([
      [1, { spread: 1, lines: ['only one'] }],
      // spread 2 has no draft
    ]);

    const [s1, s2] = buildSpreadsForLegacyIllustrator({ spreadSpecs, draftBySpread });

    expect(s1.manuscript.text).toBe('only one');
    expect(s2.manuscript.text).toBe('');
    expect(s2.manuscript.lines).toEqual([]);
    // qa block still present even when draft is missing
    expect(s2.qa.spreadChecks).toEqual([]);
  });

  test('uses draft.text when present (over joining lines)', () => {
    const spreadSpecs = [{ spreadNumber: 1 }];
    const draftBySpread = new Map([
      [1, { spread: 1, text: 'pre-joined text', lines: ['ignored', 'lines'] }],
    ]);

    const [s] = buildSpreadsForLegacyIllustrator({ spreadSpecs, draftBySpread });

    expect(s.manuscript.text).toBe('pre-joined text');
    // lines are still preserved separately
    expect(s.manuscript.lines).toEqual(['ignored', 'lines']);
  });

  test('does not share qa-array references across spreads (regression: mutation isolation)', () => {
    const spreadSpecs = [{ spreadNumber: 1 }, { spreadNumber: 2 }];
    const draftBySpread = new Map();

    const spreads = buildSpreadsForLegacyIllustrator({ spreadSpecs, draftBySpread });

    spreads[0].qa.spreadChecks.push({ tag: 'mutated' });
    expect(spreads[1].qa.spreadChecks).toEqual([]);
    expect(spreads[0].qa.spreadChecks).toEqual([{ tag: 'mutated' }]);
  });
});
