/**
 * AA-CW-4 — Smoke test for the LLM-judge writer-side QA orchestrator.
 *
 * The previous deterministic checkWriterDraft was 1396 lines of regex
 * helpers. The new implementation is a single LLM judge call (gpt-5.4)
 * + a parallel shadow run (gemini-2.5-flash) + a deterministic
 * signature-beat coverage preflight.
 *
 * This suite mocks `callText` and asserts:
 *   1. The judge call uses MODELS.WRITER_JUDGE with jsonMode + the
 *      enlarged 12000-token / 0.2-temp budget.
 *   2. A passing judge verdict + clean signature-beat coverage yields
 *      `pass: true` and an empty repair plan.
 *   3. A failing judge verdict surfaces per-spread issues and tags into
 *      the merged repair plan.
 *   4. Signature-beat misses are layered as book-level + per-spread
 *      injections even when the judge itself missed them.
 *   5. The shadow call is recorded on the doc via appendLlmCall under
 *      `writerQa.shadow` and never short-circuits the authoritative
 *      verdict.
 */

jest.mock('../../../services/bookPipeline/llm/openaiClient', () => ({
  callText: jest.fn(),
}));

const { callText } = require('../../../services/bookPipeline/llm/openaiClient');
const { checkWriterDraft } = require('../../../services/bookPipeline/qa/checkWriterDraft');
const { AGE_BANDS, FORMATS, MODELS } = require('../../../services/bookPipeline/constants');

function makeSpread(spreadNumber, text) {
  return {
    spreadNumber,
    spec: { textSide: 'right', beat: `beat-${spreadNumber}` },
    manuscript: {
      text,
      side: 'right',
      lineBreakHints: [],
      personalizationUsed: [],
      writerNotes: null,
    },
    qa: { spreadChecks: [], repairHistory: [] },
  };
}

function makeDoc({ spreads, brief = null }) {
  return {
    request: {
      ageBand: AGE_BANDS.PB_PRESCHOOL,
      format: FORMATS.PICTURE_BOOK,
      theme: 'mothers_day',
    },
    brief: brief || {
      child: { name: 'Eden', age: 4, anecdotes: {} },
      pronouns: { subject: 'she', object: 'her', possessive: 'her', reflexive: 'herself' },
      customDetails: {},
    },
    storyBible: { title: 'Eden Smiles' },
    spreads,
    trace: { llmCalls: [], stages: [] },
    retryMemory: [],
    operationalContext: { bookId: 'judge-orchestrator-test' },
    llmCalls: [],
  };
}

afterEach(() => {
  callText.mockReset();
});

function mockJudgeAndShadow({ judgeJson, shadowJson }) {
  callText.mockImplementation(async ({ label }) => {
    if (label === 'writerQa.judge') {
      return { json: judgeJson, model: MODELS.WRITER_JUDGE, attempts: 1, usage: { in: 1, out: 1 } };
    }
    if (label === 'writerQa.shadow') {
      return { json: shadowJson, model: MODELS.WRITER_QA, attempts: 1, usage: { in: 1, out: 1 } };
    }
    throw new Error(`unexpected callText label: ${label}`);
  });
}

describe('AA-CW-4 checkWriterDraft judge orchestrator', () => {
  test('clean judge + clean signature beats → pass=true, no repair plan', async () => {
    mockJudgeAndShadow({
      judgeJson: {
        pass: true,
        bookLevelIssues: [],
        bookLevelTags: [],
        perSpread: [
          { spreadNumber: 1, issues: [], tags: [], suggestedRewrite: null },
          { spreadNumber: 2, issues: [], tags: [], suggestedRewrite: null },
        ],
        infantLocomotionHits: [],
      },
      shadowJson: { pass: true, bookLevelIssues: [], perSpread: [] },
    });

    const doc = makeDoc({
      spreads: [
        makeSpread(1, 'Eden looks at the morning sky.\nBlue clouds drift up so high.\nMama hums a little song.\nThe whole bright day feels long.'),
        makeSpread(2, 'She picks a daisy by the stream.\nIts petals shine like sunbeam cream.\nMama smiles and squeezes tight.\nEverything feels just right.'),
      ],
    });

    const verdict = await checkWriterDraft(doc);
    expect(verdict.pass).toBe(true);
    expect(verdict.repairPlan).toEqual([]);
    expect(verdict.bookLevel).toEqual([]);

    // Two callText invocations: judge (authoritative) + shadow.
    expect(callText).toHaveBeenCalledTimes(2);
    const judgeCall = callText.mock.calls.find(c => c[0].label === 'writerQa.judge')[0];
    expect(judgeCall.model).toBe(MODELS.WRITER_JUDGE);
    expect(judgeCall.jsonMode).toBe(true);
    expect(judgeCall.maxTokens).toBe(12000);
    expect(judgeCall.temperature).toBe(0.2);
  });

  test('judge fails a spread → tags + issues surface into repair plan', async () => {
    mockJudgeAndShadow({
      judgeJson: {
        pass: false,
        bookLevelIssues: [],
        bookLevelTags: [],
        perSpread: [
          {
            spreadNumber: 1,
            issues: ['rhyme_fail: lines 1+2 use identity rhyme "town/town"'],
            tags: ['rhyme_fail'],
            suggestedRewrite: 'End line 2 with a real rhyme for "town" (down/crown/brown/gown).',
          },
          { spreadNumber: 2, issues: [], tags: [], suggestedRewrite: null },
        ],
        infantLocomotionHits: [],
      },
      shadowJson: { pass: false, bookLevelIssues: [], perSpread: [] },
    });

    const doc = makeDoc({
      spreads: [
        makeSpread(1, 'Eden walks through town.\nMama walks through town.\nThe sun is warm and bright.\nThe day is full of light.'),
        makeSpread(2, 'She skips along the way.\nMama hums a tune so gay.\nFlowers nod and bees buzz by.\nClouds drift slow across the sky.'),
      ],
    });

    const verdict = await checkWriterDraft(doc);
    expect(verdict.pass).toBe(false);
    expect(verdict.repairPlan).toHaveLength(1);
    expect(verdict.repairPlan[0].spreadNumber).toBe(1);
    expect(verdict.repairPlan[0].tags).toContain('rhyme_fail');
    expect(verdict.repairPlan[0].suggestedRewrite).toMatch(/real rhyme for "town"/);
  });

  test('signature beats missing → book-level fail + per-spread injections', async () => {
    mockJudgeAndShadow({
      judgeJson: {
        pass: true,
        bookLevelIssues: [],
        bookLevelTags: [],
        // The judge missed the questionnaire anchors but they're caught by
        // the deterministic preflight in the orchestrator.
        perSpread: [
          { spreadNumber: 1, issues: [], tags: [], suggestedRewrite: null },
          { spreadNumber: 2, issues: [], tags: [], suggestedRewrite: null },
        ],
        infantLocomotionHits: [],
      },
      shadowJson: { pass: true, bookLevelIssues: [], perSpread: [] },
    });

    const doc = makeDoc({
      spreads: [
        makeSpread(1, 'Eden looks at the morning sky.\nBlue clouds drift up so high.\nMama hums a little song.\nThe whole bright day feels long.'),
        makeSpread(2, 'A tiny bird flies into view.\nIts feathers shine in dappled hue.\nMama waves and Eden sees.\nThey laugh beneath the trees.'),
      ],
      brief: {
        child: {
          name: 'Eden',
          age: 4,
          anecdotes: {
            funny_thing: 'puts spaghetti in her hair',
            meaningful_moment: 'first time she fed the ducks',
          },
        },
        pronouns: { subject: 'she', object: 'her', possessive: 'her', reflexive: 'herself' },
        customDetails: {},
      },
    });

    const verdict = await checkWriterDraft(doc);
    expect(verdict.pass).toBe(false);
    expect(verdict.bookLevel.join(' ')).toMatch(/signature beats missing/);
    expect(verdict.bookLevelTags).toContain('signature_beat_missing');
    // At least one per-spread entry must carry a signature_beat_missing
    // injection so the rewrite loop has a concrete target.
    const sigSpreads = verdict.perSpread.filter(s => s.tags.includes('signature_beat_missing'));
    expect(sigSpreads.length).toBeGreaterThan(0);
  });

  test('shadow run is recorded via appendLlmCall under writerQa.shadow', async () => {
    mockJudgeAndShadow({
      judgeJson: {
        pass: true,
        bookLevelIssues: [],
        bookLevelTags: [],
        perSpread: [{ spreadNumber: 1, issues: [], tags: [], suggestedRewrite: null }],
        infantLocomotionHits: [],
      },
      shadowJson: {
        pass: false,
        bookLevelIssues: ['shadow disagreement'],
        perSpread: [{ spreadNumber: 1, issues: ['shadow disagrees'], tags: ['rhyme_fail'] }],
      },
    });

    const doc = makeDoc({
      spreads: [
        makeSpread(1, 'Eden looks at the morning sky.\nBlue clouds drift up so high.\nMama hums a little song.\nThe whole bright day feels long.'),
      ],
    });

    const verdict = await checkWriterDraft(doc);
    // Authoritative path stays clean — shadow disagreement does not flip pass.
    expect(verdict.pass).toBe(true);
    const stages = (verdict.updatedDoc?.trace?.llmCalls || []).map(c => c.stage);
    expect(stages).toContain('writerQa.judge');
    expect(stages).toContain('writerQa.shadow');
  });

  test('judge infantLocomotionHits → per-spread infant_action_verb_in_text injection', async () => {
    mockJudgeAndShadow({
      judgeJson: {
        pass: false,
        bookLevelIssues: [],
        bookLevelTags: [],
        perSpread: [
          { spreadNumber: 1, issues: [], tags: [], suggestedRewrite: null },
          { spreadNumber: 2, issues: [], tags: [], suggestedRewrite: null },
        ],
        infantLocomotionHits: [
          { spreadNumber: 2, verbs: ['twirls', 'spins'] },
        ],
      },
      shadowJson: { pass: true, bookLevelIssues: [], perSpread: [] },
    });

    const doc = makeDoc({
      spreads: [
        makeSpread(1, 'Soft sun on her cheek.\nMama gives a peek.\nWarm light fills the room.\nDay wakes from its bloom.'),
        makeSpread(2, 'Eden twirls and spins all day.\nRibbons trail her merry way.\nLeaves fall down so light.\nGiggle giggle, what a sight.'),
      ],
    });

    const verdict = await checkWriterDraft(doc);
    const s2 = verdict.perSpread.find(s => s.spreadNumber === 2);
    expect(s2.tags).toContain('infant_action_verb_in_text');
    expect(s2.issues.join(' ')).toMatch(/twirls/);
    expect(s2.issues.join(' ')).toMatch(/spins/);
  });
});
