/**
 * AA-CW-2 \u2014 Planner Guard tests.
 *
 * The guard replaces the deterministic regex sanitizer (PR H, deleted in
 * AA-CW-2) with a single Gemini Flash call that semantically audits the
 * planner's spread specs for infant-band self-locomotion phrasing.
 *
 * The tests below mock `callText` and verify:
 *
 *   - the guard is a no-op for non-infant age bands (no LLM call at all);
 *   - the guard runs once per planner attempt for PB_INFANT and stashes
 *     hits onto `spec.plannerGuardHits` only on the spreads the model
 *     flagged;
 *   - the guard fails open on LLM transport / parse error \u2014 the doc
 *     returns unchanged, no spec is mutated, and the writer-side LLM
 *     judge (AA-CW-4) becomes the second line of defense;
 *   - the guard's user prompt carries focalAction + plotBeat for every
 *     spread but does NOT leak full spec internals.
 */

jest.mock('../../../services/bookPipeline/llm/openaiClient', () => ({
  callText: jest.fn(),
}));

const { callText } = require('../../../services/bookPipeline/llm/openaiClient');
const { runPlannerGuard, __testInternals } = require('../../../services/bookPipeline/planner/plannerGuard');
const { AGE_BANDS, MODELS } = require('../../../services/bookPipeline/constants');

function buildInfantDoc(overrides = {}) {
  const spreads = Array.from({ length: 13 }, (_, i) => ({
    spreadNumber: i + 1,
    spec: {
      focalAction: `Mama lifts Scarlett to see something on spread ${i + 1}`,
      plotBeat: `quiet beat ${i + 1}`,
      forbiddenMistakes: [],
    },
    manuscript: null,
  }));
  return {
    request: { ageBand: AGE_BANDS.PB_INFANT },
    brief: { child: { name: 'Scarlett' } },
    spreads,
    trace: { llmCalls: [] },
    operationalContext: { bookId: 'test-book' },
    ...overrides,
  };
}

beforeEach(() => {
  callText.mockReset();
});

describe('runPlannerGuard \u2014 age band gating', () => {
  test('no-op for non-infant age bands (no LLM call)', async () => {
    const doc = buildInfantDoc({ request: { ageBand: AGE_BANDS.PB_TODDLER } });
    const out = await runPlannerGuard(doc);
    expect(callText).not.toHaveBeenCalled();
    expect(out).toBe(doc);
  });

  test('no-op for PB_PRESCHOOL', async () => {
    const doc = buildInfantDoc({ request: { ageBand: AGE_BANDS.PB_PRESCHOOL } });
    const out = await runPlannerGuard(doc);
    expect(callText).not.toHaveBeenCalled();
    expect(out).toBe(doc);
  });
});

describe('runPlannerGuard \u2014 infant clean run', () => {
  test('runs exactly one Flash call and stashes no hits when the spec is clean', async () => {
    callText.mockResolvedValue({
      json: { hits: [] },
      model: 'gemini-2.5-flash',
      attempts: 1,
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    const doc = buildInfantDoc();
    const out = await runPlannerGuard(doc);
    expect(callText).toHaveBeenCalledTimes(1);
    expect(callText.mock.calls[0][0].model).toBe(MODELS.WRITER_QA);
    // No spec mutated.
    for (const s of out.spreads) {
      expect(s.spec.plannerGuardHits).toBeUndefined();
    }
    // LLM call appended to trace.
    expect(out.trace.llmCalls.some((c) => c.stage === 'plannerGuard')).toBe(true);
  });
});

describe('runPlannerGuard \u2014 infant hit run', () => {
  test('stashes hits onto exactly the flagged spreads', async () => {
    callText.mockResolvedValue({
      json: {
        hits: [
          {
            spreadNumber: 4,
            problemPhrase: 'Scarlett runs across the meadow',
            reason: 'lap baby cannot run',
            suggestedAlternative: 'Mama carries Scarlett across the meadow',
          },
          {
            spreadNumber: 9,
            problemPhrase: 'climbs onto the couch',
            reason: 'lap baby cannot climb on their own',
            suggestedAlternative: 'Mama lifts Scarlett onto the couch',
          },
        ],
      },
      model: 'gemini-2.5-flash',
      attempts: 1,
      usage: {},
    });
    const doc = buildInfantDoc();
    const out = await runPlannerGuard(doc);

    const bySpread = new Map(out.spreads.map((s) => [s.spreadNumber, s]));

    expect(bySpread.get(4).spec.plannerGuardHits).toEqual([
      {
        problemPhrase: 'Scarlett runs across the meadow',
        reason: 'lap baby cannot run',
        suggestedAlternative: 'Mama carries Scarlett across the meadow',
      },
    ]);
    expect(bySpread.get(9).spec.plannerGuardHits).toEqual([
      {
        problemPhrase: 'climbs onto the couch',
        reason: 'lap baby cannot climb on their own',
        suggestedAlternative: 'Mama lifts Scarlett onto the couch',
      },
    ]);

    // No other spread is touched.
    for (const s of out.spreads) {
      if (s.spreadNumber !== 4 && s.spreadNumber !== 9) {
        expect(s.spec.plannerGuardHits).toBeUndefined();
      }
    }
  });

  test('aggregates multiple hits on the same spread', async () => {
    callText.mockResolvedValue({
      json: {
        hits: [
          { spreadNumber: 7, problemPhrase: 'runs', reason: 'r1', suggestedAlternative: 'a1' },
          { spreadNumber: 7, problemPhrase: 'jumps', reason: 'r2', suggestedAlternative: 'a2' },
        ],
      },
      model: 'gemini-2.5-flash',
      attempts: 1,
      usage: {},
    });
    const doc = buildInfantDoc();
    const out = await runPlannerGuard(doc);
    const seven = out.spreads.find((s) => s.spreadNumber === 7);
    expect(seven.spec.plannerGuardHits).toHaveLength(2);
  });

  test('drops malformed hits with no spreadNumber', async () => {
    callText.mockResolvedValue({
      json: {
        hits: [
          { problemPhrase: 'oops', reason: 'no number' },
          { spreadNumber: 'abc', problemPhrase: 'oops2' },
          { spreadNumber: 3, problemPhrase: 'good', reason: 'r', suggestedAlternative: 'a' },
        ],
      },
      model: 'gemini-2.5-flash',
      attempts: 1,
      usage: {},
    });
    const doc = buildInfantDoc();
    const out = await runPlannerGuard(doc);
    const flagged = out.spreads.filter((s) => s.spec.plannerGuardHits);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].spreadNumber).toBe(3);
  });
});

describe('runPlannerGuard \u2014 fail-open behavior', () => {
  test('LLM transport error returns doc unchanged, does not throw', async () => {
    callText.mockRejectedValue(new Error('Gemini upstream 503'));
    const doc = buildInfantDoc();
    const out = await runPlannerGuard(doc);
    expect(out).toBe(doc);
    for (const s of out.spreads) {
      expect(s.spec.plannerGuardHits).toBeUndefined();
    }
  });

  test('LLM returns non-array hits returns doc with no mutations', async () => {
    callText.mockResolvedValue({
      json: { hits: 'not an array' },
      model: 'gemini-2.5-flash',
      attempts: 1,
      usage: {},
    });
    const doc = buildInfantDoc();
    const out = await runPlannerGuard(doc);
    for (const s of out.spreads) {
      expect(s.spec.plannerGuardHits).toBeUndefined();
    }
  });
});

describe('runPlannerGuard \u2014 user prompt shape', () => {
  test('user prompt carries focalAction + plotBeat for every spread, not full spec internals', async () => {
    callText.mockResolvedValue({
      json: { hits: [] },
      model: 'gemini-2.5-flash',
      attempts: 1,
      usage: {},
    });
    const doc = buildInfantDoc();
    // Add some noise on the spec that should NOT leak to the guard prompt.
    doc.spreads[0].spec.cameraIntent = 'wide angle';
    doc.spreads[0].spec.parentVisibility = 'full';
    doc.spreads[0].spec.continuityAnchors = ['secret'];

    await runPlannerGuard(doc);
    const userPrompt = callText.mock.calls[0][0].userPrompt;

    expect(userPrompt).toMatch(/PB_INFANT/);
    expect(userPrompt).toMatch(/Hero name: Scarlett/);
    // Every spread's focalAction is rendered.
    for (let i = 1; i <= 13; i++) {
      expect(userPrompt).toContain(`spread ${i}`);
    }
    // Full spec internals do NOT leak.
    expect(userPrompt).not.toContain('cameraIntent');
    expect(userPrompt).not.toContain('parentVisibility');
    expect(userPrompt).not.toContain('continuityAnchors');
  });

  test('system prompt names the lap-baby contract and the still-point reframing rule', () => {
    const sys = __testInternals.PLANNER_GUARD_SYSTEM;
    expect(sys).toMatch(/lap baby|LAP BABY/i);
    expect(sys).toMatch(/still point/i);
    // System prompt must describe the audit job clearly enough for a small
    // model: identify self-locomotion phrasings, suggest a still-point
    // alternative.
    expect(sys).toMatch(/self-locomotion|locomotion/i);
    expect(sys).toMatch(/suggestedAlternative/);
    expect(sys).toMatch(/strict JSON/i);
  });
});
