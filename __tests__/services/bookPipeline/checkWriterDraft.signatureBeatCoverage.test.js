/**
 * PR Y — Per-anchor signature-beat coverage at the book-level QA gate.
 *
 * The legacy `low_personalization_saturation` gate averages all
 * personalization items together and passes at 60% landed. Scarlett's
 * failed book passed it at 50% because the writer landed generic interests
 * ("walks", "outside") and missed every emotional anchor (smushy, chin,
 * squeal, Mama). This new gate fails the book unless EVERY signature beat
 * lands in at least one spread, and injects per-spread repair targets at
 * the opening / peak / closing slots so the rewrite loop can act on them.
 */

jest.mock('../../../services/bookPipeline/llm/openaiClient', () => ({
  callText: jest.fn(),
}));

const { callText } = require('../../../services/bookPipeline/llm/openaiClient');
const { checkWriterDraft } = require('../../../services/bookPipeline/qa/checkWriterDraft');
const { AGE_BANDS, FORMATS } = require('../../../services/bookPipeline/constants');

function makeDoc(spreads, briefOverride = {}) {
  return {
    request: {
      ageBand: AGE_BANDS.PB_INFANT,
      format: FORMATS.PICTURE_BOOK,
      theme: 'mothers_day',
    },
    brief: {
      child: { name: 'Scarlett', age: 0 },
      customDetails: {},
      ...briefOverride,
    },
    spreads,
    storyBible: {},
    trace: { llmCalls: [] },
  };
}

beforeEach(() => {
  // Stub the literary QA so deterministic checks dominate the verdict.
  callText.mockResolvedValue({
    json: { pass: true, perSpread: [], bookLevelIssues: [] },
    model: 'stub',
    attempts: 1,
    usage: {},
  });
});

afterEach(() => {
  callText.mockReset();
});

/**
 * Build 13 unique 2-line spreads from a fixed pool so we don't trip
 * verb_crutch or refrain_crutch — those fire ≥3 spreads with the same
 * verb / noun and would contaminate the bookLevelTags assertion.
 */
function buildSpreads(textByIndex = {}) {
  const filler = [
    'A robin paints the sky.\nSoft clouds drift by.',
    'A teacup gleams on glass.\nMoonlight on the brass.',
    'A puppy yawns at noon.\nBalloon climbs near the moon.',
    'A scarf lifts in the air.\nLeaves comb baby hair.',
    'A bell pings very low.\nShadows on the willow.',
    'A spoon clinks on a plate.\nLight pools by the gate.',
    'A kite floats out of view.\nBaby blinks anew.',
    'A pillow holds a dream.\nMoonlight builds a stream.',
    'A doorbell hums hello.\nSunlight finds the window.',
    'A petal taps the floor.\nNoonlight at the door.',
    'A puppy nuzzles wool.\nStarlight, soft and full.',
    'A teabag steeps in cream.\nMoonbeams paint a beam.',
    'A daisy nods to dew.\nSky turns soft and new.',
  ];
  const spreads = [];
  for (let i = 1; i <= 13; i++) {
    const override = textByIndex[i];
    spreads.push({
      spreadNumber: i,
      spec: { textSide: 'right' },
      manuscript: {
        text: override != null ? override : filler[i - 1],
        side: 'right',
        lineBreakHints: [],
        personalizationUsed: [],
      },
    });
  }
  return spreads;
}

describe('checkWriterDraft signature-beat coverage (PR Y)', () => {
  test('all signature beats landing → no signature_beat_missing tag', async () => {
    // Each anchor surfaces in a different spread, no repeats ≥3 → no crutches.
    const spreads = buildSpreads({
      // funny_thing → "chin"
      1: 'Tiny teeth find a chin.\nMama laughs and grins thin.',
      // meaningful_moment → "squealed" + "bath"
      6: 'Scarlett squealed at the bath.\nWater drew a little path.',
      // moms_favorite_moment → "snuggle" + "pajamas"
      11: 'Pajamas warm and bright.\nMama snuggle, hold her tight.',
      // calls_mom → "mama" already present in 1, 11
      // anything_else → "smushy"
      13: 'Sleepy smushy, soft and small.\nGoodnight, beloved doll.',
    });
    const doc = makeDoc(spreads, {
      child: {
        name: 'Scarlett',
        age: 0,
        anecdotes: {
          funny_thing: 'bites mama on the chin',
          meaningful_moment: 'first time she squealed in the bath',
          moms_favorite_moment: 'morning snuggle in pajamas',
          calls_mom: 'Mama',
          anything_else: 'we call her smushy',
        },
      },
    });
    const out = await checkWriterDraft(doc);
    expect(out.bookLevelTags).not.toContain('signature_beat_missing');
    expect(out.bookLevel.find(s => /signature beats missing/i.test(s))).toBeUndefined();
  });

  test('Scarlett fixture (stock manuscript, all anchors missing) → fail with per-spread injection', async () => {
    const spreads = buildSpreads();
    const doc = makeDoc(spreads, {
      child: {
        name: 'Scarlett',
        age: 0,
        anecdotes: {
          funny_thing: 'bites mama on the chin',
          meaningful_moment: 'first time she squealed in the bath',
          moms_favorite_moment: 'morning snuggle in pajamas',
          calls_mom: 'Mama',
          anything_else: 'we call her smushy',
        },
      },
    });
    const out = await checkWriterDraft(doc);

    // Book-level failure is recorded with the new tag.
    expect(out.pass).toBe(false);
    expect(out.bookLevelTags).toContain('signature_beat_missing');
    expect(out.bookLevel.some(s => /signature beats missing/i.test(s))).toBe(true);

    // Repair plan injects per-spread targets at opening (1), peak (7),
    // closing (13) — and at least one target names each missing anchor.
    const sbTargets = out.repairPlan.filter(p => p.tags.includes('signature_beat_missing'));
    const targetSpreads = sbTargets.map(p => p.spreadNumber).sort((a, b) => a - b);
    // 5 missing beats over the [1,7,13] rotation collapse to {1,7,13}
    // when we look at unique spread numbers.
    expect(targetSpreads).toEqual([1, 7, 13]);

    // Each missing anchor is named somewhere in the injected issues.
    const allIssues = sbTargets.flatMap(t => t.issues).join(' | ');
    expect(allIssues).toMatch(/funny_thing/);
    expect(allIssues).toMatch(/meaningful_moment/);
    expect(allIssues).toMatch(/moms_favorite_moment/);
    expect(allIssues).toMatch(/anything_else/);
    expect(allIssues).toMatch(/calls_mom/);
    // Address-form prompt phrasing surfaces the literal address word.
    expect(allIssues).toMatch(/"Mama"/);
  });

  test('partial miss: only the missing anchors are injected; landed ones are not', async () => {
    // funny_thing lands; meaningful_moment is missing.
    const spreads = buildSpreads({
      4: 'Tiny teeth find a chin.\nMama laughs and grins thin.',
    });
    const doc = makeDoc(spreads, {
      child: {
        name: 'Scarlett',
        age: 0,
        anecdotes: {
          funny_thing: 'bites mama on the chin',
          meaningful_moment: 'first time she squealed in the bath',
        },
      },
    });
    const out = await checkWriterDraft(doc);
    expect(out.bookLevelTags).toContain('signature_beat_missing');
    const sbTargets = out.repairPlan.filter(p => p.tags.includes('signature_beat_missing'));
    const allIssues = sbTargets.flatMap(t => t.issues).join(' | ');
    expect(allIssues).toMatch(/meaningful_moment/);
    expect(allIssues).not.toMatch(/funny_thing/);
  });

  test('no anecdotes → gate is silent (no false positive)', async () => {
    // Brief has no signature anecdotes — gate must not fire.
    const spreads = buildSpreads();
    const doc = makeDoc(spreads, {
      child: { name: 'Scarlett', age: 0, anecdotes: {} },
    });
    const out = await checkWriterDraft(doc);
    expect(out.bookLevelTags).not.toContain('signature_beat_missing');
  });

  test('anecdotes survive when delivered via raw.childAnecdotes through normalizeRequest end-to-end', async () => {
    // Defensive integration: the same brief shape we get AFTER
    // normalizeRequest restores raw.childAnecdotes (PR Y line-1 fix). If
    // somebody silently regresses normalizeRequest in the future, this
    // test continues to demonstrate that QA reacts correctly when the
    // normalized brief contains the anecdotes.
    const { extractChild } = require('../../../services/bookPipeline/input/normalizeRequest');
    const child = extractChild({
      child: { name: 'Scarlett', age: 0 },
      childAnecdotes: { funny_thing: 'bites mama chin', calls_mom: 'Mama' },
    });
    const spreads = buildSpreads();
    const doc = makeDoc(spreads, { child });
    const out = await checkWriterDraft(doc);
    expect(out.bookLevelTags).toContain('signature_beat_missing');
    const sbTargets = out.repairPlan.filter(p => p.tags.includes('signature_beat_missing'));
    const allIssues = sbTargets.flatMap(t => t.issues).join(' | ');
    expect(allIssues).toMatch(/funny_thing/);
    expect(allIssues).toMatch(/calls_mom/);
  });
});
