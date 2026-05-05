/**
 * PR Z — anchorAllocation unit tests.
 *
 * Covers:
 *   - extractLoadBearingTokens drops stopwords / address words / duplicates
 *   - allocateBeatsToSpreads pins each beat to its role-default spread
 *   - allocations are deterministic across reruns
 *   - compressionGuidance branches on anchor density
 *   - buildAnchorAllocation produces a stable perSpread map and address
 *     beats land on spread 1
 *   - rendered prompt blocks include the verbatim words and per-beat lines
 */

const {
  buildAnchorAllocation,
  allocateBeatsToSpreads,
  extractLoadBearingTokens,
  compressionGuidance,
  renderAllocationBlockForPlanner,
  renderAllocationBlockForStoryBible,
  SPREAD_ROLES,
  DEFAULT_BEAT_ROLE_MAP,
} = require('../../../services/bookPipeline/planner/anchorAllocation');

const { extractSignatureBeats } = require('../../../services/bookPipeline/qa/signatureBeats');

function scarlettBrief() {
  return {
    child: {
      name: 'Scarlett',
      anecdotes: {
        meaningful_moment: 'first time she squealed in the bath',
        moms_favorite_moment: 'morning snuggle in pajamas with Courtney',
        funny_thing: 'bites mama on the chin',
        anything_else: 'we call her smushy',
        calls_mom: 'Mama',
      },
    },
  };
}

describe('extractLoadBearingTokens', () => {
  test('keeps content nouns/verbs and drops stopwords + address words', () => {
    const tokens = extractLoadBearingTokens('bites mama on the chin');
    // Mama is an address word -> must NOT appear here (tracked separately).
    expect(tokens).not.toContain('mama');
    // Stopwords like "on", "the" are dropped.
    expect(tokens).not.toContain('on');
    expect(tokens).not.toContain('the');
    // Load-bearing nouns/verbs survive.
    expect(tokens).toContain('bites');
    expect(tokens).toContain('chin');
  });

  test('returns the words in source order, deduped', () => {
    const tokens = extractLoadBearingTokens('smushy smushy bath time bath');
    // Deduped, order preserved.
    expect(tokens).toEqual(['smushy', 'bath', 'time']);
  });

  test('caps output to ~6 tokens', () => {
    const tokens = extractLoadBearingTokens(
      'apple banana cherry date elderberry fig grape honeydew',
    );
    expect(tokens.length).toBeLessThanOrEqual(6);
  });

  test('empty / falsy input returns []', () => {
    expect(extractLoadBearingTokens('')).toEqual([]);
    expect(extractLoadBearingTokens(undefined)).toEqual([]);
    expect(extractLoadBearingTokens(null)).toEqual([]);
  });
});

describe('allocateBeatsToSpreads', () => {
  test('pins each text beat to its default role and address beats are unpinned', () => {
    const beats = extractSignatureBeats(scarlettBrief());
    const allocations = allocateBeatsToSpreads(beats);
    const byKey = new Map(allocations.map(a => [a.key, a]));

    // meaningful_moment → opening (spread 1)
    expect(byKey.get('meaningful_moment').spreadNumber).toBe(1);
    expect(byKey.get('meaningful_moment').role).toBe('opening');

    // moms_favorite_moment → heart (sp 6-8 → middle = 7)
    expect(byKey.get('moms_favorite_moment').spreadNumber).toBe(7);
    expect(byKey.get('moms_favorite_moment').role).toBe('heart');

    // funny_thing → peak2 (sp 9-11 → middle = 10)
    expect(byKey.get('funny_thing').spreadNumber).toBe(10);
    expect(byKey.get('funny_thing').role).toBe('peak2');

    // anything_else → closing (sp 12-13 → middle = 12)
    expect(byKey.get('anything_else').spreadNumber).toBe(12);
    expect(byKey.get('anything_else').role).toBe('closing');

    // calls_mom is an address beat: not pinned (spreadNumber: null).
    expect(byKey.get('calls_mom').isAddress).toBe(true);
    expect(byKey.get('calls_mom').spreadNumber).toBeNull();
  });

  test('is deterministic across reruns', () => {
    const beats = extractSignatureBeats(scarlettBrief());
    const a1 = allocateBeatsToSpreads(beats);
    const a2 = allocateBeatsToSpreads(beats);
    expect(a1).toEqual(a2);
  });

  test('two beats wanting the same role get distinct spreads', () => {
    // Both moms_favorite_moment and dads_favorite_moment default to "heart".
    const brief = {
      child: {
        anecdotes: {
          moms_favorite_moment: 'mom moment text here',
          dads_favorite_moment: 'dad moment text here',
        },
      },
    };
    const beats = extractSignatureBeats(brief);
    const allocations = allocateBeatsToSpreads(beats);
    const slots = allocations
      .filter(a => !a.isAddress)
      .map(a => a.spreadNumber);
    // No duplicates.
    expect(new Set(slots).size).toBe(slots.length);
    // Both inside the heart range (6-8).
    for (const n of slots) {
      expect(n).toBeGreaterThanOrEqual(SPREAD_ROLES.heart.start);
      expect(n).toBeLessThanOrEqual(SPREAD_ROLES.heart.end);
    }
  });

  test('returns [] when there are no beats', () => {
    expect(allocateBeatsToSpreads([])).toEqual([]);
    expect(allocateBeatsToSpreads(undefined)).toEqual([]);
  });
});

describe('compressionGuidance', () => {
  test('heavy mode at 4+ text beats', () => {
    const beats = [
      { kind: 'text' }, { kind: 'text' }, { kind: 'text' }, { kind: 'text' },
    ];
    expect(compressionGuidance(beats).mode).toBe('heavy');
  });

  test('light mode at 2-3 text beats', () => {
    expect(compressionGuidance([{ kind: 'text' }, { kind: 'text' }]).mode).toBe('light');
    expect(compressionGuidance([{ kind: 'text' }, { kind: 'text' }, { kind: 'text' }]).mode).toBe('light');
  });

  test('sparse mode at <2 text beats', () => {
    expect(compressionGuidance([]).mode).toBe('sparse');
    expect(compressionGuidance([{ kind: 'text' }]).mode).toBe('sparse');
    expect(compressionGuidance([{ kind: 'address' }]).mode).toBe('sparse');
  });

  test('every mode emits a non-empty operator-readable message', () => {
    expect(compressionGuidance([{ kind: 'text' }]).message).toMatch(/sparse/i);
    expect(compressionGuidance([{ kind: 'text' }, { kind: 'text' }]).message).toMatch(/moderate/i);
    expect(
      compressionGuidance([{ kind: 'text' }, { kind: 'text' }, { kind: 'text' }, { kind: 'text' }]).message,
    ).toMatch(/rich/i);
  });
});

describe('buildAnchorAllocation (top-level)', () => {
  test('Scarlett brief: 4 text beats land on opening / heart / peak2 / closing', () => {
    const allocation = buildAnchorAllocation(scarlettBrief());
    expect(allocation.compression.mode).toBe('heavy');
    expect(allocation.compression.textBeatCount).toBe(4);

    // Per-spread anchored slots match the role plan.
    expect(allocation.perSpread.get(1).anchorRole).toBe('opening');
    expect(allocation.perSpread.get(7).anchorRole).toBe('heart');
    expect(allocation.perSpread.get(10).anchorRole).toBe('peak2');
    expect(allocation.perSpread.get(12).anchorRole).toBe('closing');

    // Spreads with no anchor have anchorRole: null and an empty mustUseDetails.
    for (const n of [2, 3, 4, 5, 6, 8, 9, 11, 13]) {
      expect(allocation.perSpread.get(n).anchorRole).toBeNull();
      expect(allocation.perSpread.get(n).mustUseDetails).toEqual([]);
    }
  });

  test('address beats go on spread 1 mustUseDetails as a leading line', () => {
    const allocation = buildAnchorAllocation(scarlettBrief());
    const sp1 = allocation.perSpread.get(1);
    expect(sp1.mustUseDetails.length).toBeGreaterThanOrEqual(2);
    // The very first entry on spread 1 is the address line.
    expect(sp1.mustUseDetails[0]).toMatch(/ADDRESS \(calls_mom\)/);
    expect(sp1.mustUseDetails[0]).toContain('Mama');
    // Followed by the meaningful_moment anchor.
    expect(sp1.mustUseDetails[1]).toMatch(/ANCHOR \(meaningful_moment\)/);
  });

  test('verbatim load-bearing words are surfaced in the ANCHOR line', () => {
    const allocation = buildAnchorAllocation(scarlettBrief());
    // Spread 10 (funny_thing) should explicitly require "bites" and "chin".
    const sp10 = allocation.perSpread.get(10);
    const anchor = sp10.mustUseDetails.find(s => s.includes('funny_thing'));
    expect(anchor).toContain("'bites'");
    expect(anchor).toContain("'chin'");
    expect(sp10.verbatimTokens).toEqual(expect.arrayContaining(['bites', 'chin']));

    // Spread 12 (anything_else) should require "smushy".
    const sp12 = allocation.perSpread.get(12);
    const anchor12 = sp12.mustUseDetails.find(s => s.includes('anything_else'));
    expect(anchor12).toContain("'smushy'");
    expect(sp12.verbatimTokens).toContain('smushy');
  });

  test('empty brief produces a clean, empty allocation', () => {
    const allocation = buildAnchorAllocation({ child: {} });
    expect(allocation.beats).toEqual([]);
    expect(allocation.allocations).toEqual([]);
    expect(allocation.compression.mode).toBe('sparse');
    for (const slot of allocation.perSpread.values()) {
      expect(slot.mustUseDetails).toEqual([]);
      expect(slot.anchorRole).toBeNull();
    }
  });
});

describe('renderAllocationBlockForPlanner', () => {
  test('returns a multi-line block listing every beat with role and verbatim words', () => {
    const allocation = buildAnchorAllocation(scarlettBrief());
    const text = renderAllocationBlockForPlanner(allocation);
    expect(text).toMatch(/ANCHOR ALLOCATION/);
    expect(text).toMatch(/spread 1 \(opening\) · meaningful_moment/);
    expect(text).toMatch(/spread 7 \(heart\) · moms_favorite_moment/);
    expect(text).toMatch(/spread 10 \(peak2\) · funny_thing/);
    expect(text).toMatch(/spread 12 \(closing\) · anything_else/);
    expect(text).toMatch(/ADDRESS · calls_mom/);
    expect(text).toMatch(/'bites'/);
    expect(text).toMatch(/'smushy'/);
    // The compression message must be on the same block.
    expect(text).toMatch(/ANCHOR DENSITY/);
  });

  test('returns empty string when there are no beats', () => {
    const allocation = buildAnchorAllocation({ child: {} });
    expect(renderAllocationBlockForPlanner(allocation)).toBe('');
  });
});

describe('renderAllocationBlockForStoryBible', () => {
  test('lists the BOOK SUBJECT moments verbatim', () => {
    const allocation = buildAnchorAllocation(scarlettBrief());
    const text = renderAllocationBlockForStoryBible(allocation);
    expect(text).toMatch(/BOOK SUBJECT/);
    expect(text).toContain('first time she squealed in the bath');
    expect(text).toContain('bites mama on the chin');
    expect(text).toContain('we call her smushy');
    expect(text).toContain('Mama');
    expect(text).toMatch(/ANCHOR DENSITY/);
  });

  test('returns empty string when there are no beats', () => {
    const allocation = buildAnchorAllocation({ child: {} });
    expect(renderAllocationBlockForStoryBible(allocation)).toBe('');
  });
});

describe('DEFAULT_BEAT_ROLE_MAP / SPREAD_ROLES exports', () => {
  test('every default-mapped beat key resolves to a real role range', () => {
    for (const role of Object.values(DEFAULT_BEAT_ROLE_MAP)) {
      expect(SPREAD_ROLES[role]).toBeDefined();
      expect(SPREAD_ROLES[role].start).toBeLessThanOrEqual(SPREAD_ROLES[role].end);
    }
  });
});
