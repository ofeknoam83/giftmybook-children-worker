/**
 * PR E.2 — Book-level failures (refrain_crutch, verb_crutch) must produce
 * per-spread repair targets so the rewrite loop can act on them.
 *
 * Before this fix: book-level failures set pass=false but produced an empty
 * repairPlan, so the rewrite loop saw "no targets" and exited silently.
 */

jest.mock('../../../services/bookPipeline/llm/openaiClient', () => ({
  callText: jest.fn(),
}));

const { callText } = require('../../../services/bookPipeline/llm/openaiClient');
const { checkWriterDraft } = require('../../../services/bookPipeline/qa/checkWriterDraft');
const { AGE_BANDS, FORMATS } = require('../../../services/bookPipeline/constants');

function makeDoc(spreads, overrides = {}) {
  return {
    request: {
      ageBand: AGE_BANDS.PB_INFANT,
      format: FORMATS.PICTURE_BOOK,
      theme: 'mothers_day',
      ...overrides.request,
    },
    brief: {
      child: { name: 'Everleigh', age: '1' },
      customDetails: { mom_name: 'Courtney' },
      ...overrides.brief,
    },
    spreads,
    storyBible: {},
    trace: { llmCalls: [] },
  };
}

beforeEach(() => {
  // Stub the literary-QA LLM call to return a clean pass — that way the only
  // failures in the test are the deterministic book-level crutches.
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

describe('checkWriterDraft book-level repair-plan injection (PR E.2)', () => {
  test('refrain_crutch from "peekaboo" produces per-spread repair targets', async () => {
    // 5 of 13 spreads use "peekaboo". The other 8 spreads each use a UNIQUE
    // imagery word so no other refrain crutch fires. Use 2-line spreads so
    // the infant line-count gate doesn't contaminate the test.
    const filler = [
      'Mama spies a small kite.\nIts tail floats out of sight.',
      'A robin sings hello.\nMorning paints the snow.',
      'A teacup waits on glass.\nWindows hold a butterfly.',
      'Soft pillows hold a dream.\nMoonlight builds a stream.',
      'A puppy yawns at noon.\nClouds carry a balloon.',
      'A bell hums very low.\nShadows on the willow.',
      'A spoon taps on a plate.\nLeaves drift past the gate.',
      'A scarf lifts on the air.\nBranches comb baby hair.',
    ];
    const spreads = [];
    let fillerIdx = 0;
    for (let i = 1; i <= 13; i++) {
      const useCrutch = [1, 3, 4, 10, 13].includes(i);
      const text = useCrutch
        ? 'Peekaboo, then a coo.\nMama whispers "I see you."'
        : filler[fillerIdx++];
      spreads.push({
        spreadNumber: i,
        spec: { textSide: 'right' },
        manuscript: { text, side: 'right', lineBreakHints: [], personalizationUsed: [] },
      });
    }
    const doc = makeDoc(spreads);
    const out = await checkWriterDraft(doc);

    // Book-level failure recorded
    expect(out.pass).toBe(false);
    expect(out.bookLevel.some(s => /refrain crutch.*peekaboo/i.test(s))).toBe(true);
    expect(out.bookLevelTags).toContain('refrain_crutch');

    // Critical: repairPlan now contains the offending spreads tagged with
    // refrain_crutch (other detectors may add their own spreads/tags too,
    // which is fine — we just need the book-level tag injected per-spread).
    const refrainTargets = out.repairPlan.filter(p => p.tags.includes('refrain_crutch'));
    const refrainSpreads = refrainTargets.map(p => p.spreadNumber).sort((a, b) => a - b);
    expect(refrainSpreads).toEqual([1, 3, 4, 10, 13]);
    for (const target of refrainTargets) {
      expect(target.issues.some(i => /peekaboo/i.test(i))).toBe(true);
    }
  });

  test('verb_crutch produces per-spread repair targets naming the verb', async () => {
    // "wave" (waves) appears in 5 of 13 spreads as the only repeated verb.
    const filler = [
      'A robin paints the sky.\nSoft clouds drift by.',
      'A teacup gleams on glass.\nMoonlight on the brass.',
      'A puppy yawns at noon.\nBalloon climbs near the moon.',
      'A scarf lifts in the air.\nLeaves comb baby hair.',
      'A bell pings very low.\nShadows on the willow.',
      'A spoon clinks on a plate.\nLight pools by the gate.',
      'A kite floats out of view.\nBaby blinks anew.',
      'A pillow holds a dream.\nMoonlight builds a stream.',
    ];
    const spreads = [];
    let fillerIdx = 0;
    for (let i = 1; i <= 13; i++) {
      const useCrutch = [2, 4, 6, 8, 10].includes(i);
      const text = useCrutch
        ? 'Mama waves at a star.\nLight tumbles from afar.'
        : filler[fillerIdx++];
      spreads.push({
        spreadNumber: i,
        spec: { textSide: 'right' },
        manuscript: { text, side: 'right', lineBreakHints: [], personalizationUsed: [] },
      });
    }
    const doc = makeDoc(spreads);
    const out = await checkWriterDraft(doc);

    expect(out.pass).toBe(false);
    expect(out.bookLevelTags).toContain('verb_crutch');
    const verbTargets = out.repairPlan.filter(p => p.tags.includes('verb_crutch'));
    const verbSpreads = verbTargets.map(p => p.spreadNumber).sort((a, b) => a - b);
    expect(verbSpreads).toEqual([2, 4, 6, 8, 10]);
    for (const target of verbTargets) {
      expect(target.issues.some(i => /wave/i.test(i))).toBe(true);
    }
  });

  test('child name in many spreads does NOT produce a refrain_crutch repair target', async () => {
    // Everleigh in 7 of 13 spreads — must not be flagged (PR E.5 exclusion).
    const filler = [
      'A robin paints the sky.\nSoft clouds drift by.',
      'A teacup gleams on glass.\nMoonlight on the brass.',
      'A puppy yawns at noon.\nBalloon climbs near the moon.',
      'A scarf lifts in the air.\nLeaves comb baby hair.',
      'A bell pings very low.\nShadows on the willow.',
      'A spoon clinks on a plate.\nLight pools by the gate.',
    ];
    const spreads = [];
    let fillerIdx = 0;
    for (let i = 1; i <= 13; i++) {
      const useChild = i <= 7;
      const text = useChild
        ? 'Everleigh peeks at sky.\nMama whispers a sigh.'
        : filler[fillerIdx++];
      spreads.push({
        spreadNumber: i,
        spec: { textSide: 'right' },
        manuscript: { text, side: 'right', lineBreakHints: [], personalizationUsed: [] },
      });
    }
    const doc = makeDoc(spreads);
    const out = await checkWriterDraft(doc);

    // No refrain_crutch fired on the child's name.
    const refrainBookLevel = out.bookLevel.filter(s => /refrain crutch.*everleigh/i.test(s));
    expect(refrainBookLevel).toEqual([]);
    // No spread should have a refrain_crutch tag triggered by the name.
    const nameTriggered = out.repairPlan.filter(p =>
      p.tags.includes('refrain_crutch') && p.issues.some(i => /everleigh/i.test(i)),
    );
    expect(nameTriggered).toEqual([]);
  });
});
