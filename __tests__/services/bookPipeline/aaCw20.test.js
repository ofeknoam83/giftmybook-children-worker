/**
 * AA-CW-20 — Same-model self-critique replaces the cross-family judge.
 *
 * Production failure on book e3f4e0c0 after AA-CW-19 deploy: the
 * cross-family gemini-2.5-pro judge raised taste-level tags
 * (semantic_filler, forced_rhyme_meaning_drift, fragment_line) at the
 * 2-5 word PB_INFANT line budget that the gpt-5.4 writer could not
 * satisfy in 5 rewrite waves. Wave 4 had zero structural defects
 * (verb_crutch, refrain_crutch, dropped_article, identity_rhyme all
 * cleared) but the judge still failed the manuscript on aesthetics.
 *
 * Three structural changes locked in this suite:
 *
 *   1. MODELS.WRITER_JUDGE flipped 'gemini-2.5-pro' -> 'gpt-5.4' so the
 *      authoritative critic shares the writer's distribution. The
 *      gemini-2.5-flash shadow stays wired up but is observability-only.
 *
 *   2. REPAIR_BUDGETS.writerRewriteWaves reduced 5 -> 2. Same-model
 *      self-critique converges fast; if two waves cannot fix it the
 *      escape hatch should fire instead of burning more tokens.
 *
 *   3. WRITER_FATAL_TAGS split into UNCONDITIONAL (identity_rhyme,
 *      unrenderable_action, writer_invented_prop — always fatal) and
 *      TASTE (semantic_filler, forced_rhyme_meaning_drift — fatal at
 *      PB_TODDLER and PB_PRESCHOOL but advisory at PB_INFANT).
 *      collectWriterFatalResiduals reads doc.request.ageBand and
 *      filters accordingly. checkWriterDraft also flips per-spread
 *      pass=true on advisory-only entries at PB_INFANT and ignores
 *      judge.pass=false when the only failures are advisory-only.
 *
 *   4. JUDGE_SYSTEM prompt rewritten as a self-critique pass. The
 *      preamble names the same-model dynamic ("you are running a
 *      SELF-CRITIQUE pass on a manuscript you wrote") and instructs
 *      the LLM to only raise issues with concrete one-line fixes. The
 *      pass-criteria block is split into STRUCTURAL (all bands) and
 *      TASTE (band-conditional).
 */

jest.mock('../../../services/bookPipeline/llm/openaiClient', () => ({
  callText: jest.fn(),
}));

const { callText } = require('../../../services/bookPipeline/llm/openaiClient');
const { checkWriterDraft, JUDGE_SYSTEM } = require('../../../services/bookPipeline/qa/checkWriterDraft');
const {
  collectWriterFatalResiduals,
  WRITER_FATAL_TAGS,
  WRITER_FATAL_TAGS_UNCONDITIONAL,
  WRITER_FATAL_TAGS_TASTE,
} = require('../../../services/bookPipeline/writer/rewriteBookText');
const { AGE_BANDS, FORMATS, MODELS, REPAIR_BUDGETS } = require('../../../services/bookPipeline/constants');

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

function makeDoc(spreads, ageBand = AGE_BANDS.PB_INFANT) {
  return {
    request: { ageBand, format: FORMATS.PICTURE_BOOK, theme: 'mothers_day' },
    brief: {
      child: { name: 'Scarlett', age: 1, anecdotes: {} },
      pronouns: { subject: 'she', object: 'her', possessive: 'her', reflexive: 'herself' },
      customDetails: {},
    },
    storyBible: { title: "Scarlett's Day" },
    spreads,
    trace: { llmCalls: [], stages: [] },
    retryMemory: [],
    operationalContext: { bookId: 'aa-cw-20-test' },
    llmCalls: [],
  };
}

function mockJudgeResult(judgePerSpread, judgePass = true, judgeBookLevel = []) {
  callText.mockImplementation(async ({ label }) => {
    if (label === 'writerQa.judge') {
      return {
        json: {
          pass: judgePass,
          bookLevelIssues: judgeBookLevel,
          bookLevelTags: [],
          perSpread: judgePerSpread,
          infantLocomotionHits: [],
        },
        model: MODELS.WRITER_JUDGE,
        attempts: 1,
        usage: { in: 1, out: 1 },
      };
    }
    if (label === 'writerQa.shadow') {
      return {
        json: { pass: true, bookLevelIssues: [], perSpread: [] },
        model: MODELS.WRITER_QA,
        attempts: 1,
        usage: { in: 1, out: 1 },
      };
    }
    throw new Error(`unexpected callText label: ${label}`);
  });
}

afterEach(() => {
  callText.mockReset();
});

// =============================================================================
// 1. Constants flip
// =============================================================================

describe('AA-CW-20 — constants', () => {
  test('MODELS.WRITER_JUDGE is gpt-5.4 (same family as writer)', () => {
    expect(MODELS.WRITER_JUDGE).toBe('gpt-5.4');
    expect(MODELS.WRITER).toBe('gpt-5.4');
    expect(MODELS.WRITER).toBe(MODELS.WRITER_JUDGE);
  });

  test('MODELS.WRITER_QA is gemini-2.5-flash (shadow, observability-only)', () => {
    expect(MODELS.WRITER_QA).toBe('gemini-2.5-flash');
    expect(MODELS.WRITER_QA).not.toBe(MODELS.WRITER_JUDGE);
  });

  test('REPAIR_BUDGETS.writerRewriteWaves is 2 (down from 5)', () => {
    expect(REPAIR_BUDGETS.writerRewriteWaves).toBe(2);
  });
});

// =============================================================================
// 2. WRITER_FATAL_TAGS split
// =============================================================================

describe('AA-CW-20 — WRITER_FATAL_TAGS split into unconditional + taste', () => {
  test('WRITER_FATAL_TAGS_UNCONDITIONAL contains the three structural tags', () => {
    expect(WRITER_FATAL_TAGS_UNCONDITIONAL).toEqual([
      'identity_rhyme',
      'unrenderable_action',
      'writer_invented_prop',
    ]);
  });

  test('WRITER_FATAL_TAGS_TASTE contains the two taste tags', () => {
    expect(WRITER_FATAL_TAGS_TASTE).toEqual([
      'semantic_filler',
      'forced_rhyme_meaning_drift',
    ]);
  });

  test('WRITER_FATAL_TAGS is the union (length 5)', () => {
    expect(WRITER_FATAL_TAGS).toEqual([
      ...WRITER_FATAL_TAGS_UNCONDITIONAL,
      ...WRITER_FATAL_TAGS_TASTE,
    ]);
    expect(WRITER_FATAL_TAGS).toHaveLength(5);
  });
});

// =============================================================================
// 3. collectWriterFatalResiduals — band-conditional taste-tag demotion
// =============================================================================

describe('AA-CW-20 — collectWriterFatalResiduals taste-tag demotion at PB_INFANT', () => {
  // ageBand is stored as the VALUE in doc.request.ageBand, not the key.
  // PB_INFANT='0-1', PB_TODDLER='0-3', PB_PRESCHOOL='3-6'.
  function buildResidualDoc(ageBand, perSpread) {
    return {
      request: { ageBand },
      operationalContext: { bookId: 'band-test' },
      writerQa: { perSpread, bookLevel: [] },
    };
  }

  test('PB_INFANT: semantic_filler tag is DEMOTED (no offender)', () => {
    const out = collectWriterFatalResiduals(buildResidualDoc(AGE_BANDS.PB_INFANT, [
      { spreadNumber: 4, tags: ['semantic_filler'], issues: ['semantic_filler: line 3 is filler.'] },
    ]));
    expect(out).toEqual([]);
  });

  test('PB_INFANT: forced_rhyme_meaning_drift tag is DEMOTED (no offender)', () => {
    const out = collectWriterFatalResiduals(buildResidualDoc(AGE_BANDS.PB_INFANT, [
      { spreadNumber: 5, tags: ['forced_rhyme_meaning_drift'], issues: ['forced_rhyme_meaning_drift: laughs at wail.'] },
    ]));
    expect(out).toEqual([]);
  });

  test('PB_INFANT: identity_rhyme tag is STILL FATAL (one offender)', () => {
    const out = collectWriterFatalResiduals(buildResidualDoc(AGE_BANDS.PB_INFANT, [
      { spreadNumber: 8, tags: ['identity_rhyme'], issues: ['rhyme_fail: identity rhyme on lines 3+4 — "mama/mama".'] },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ spreadNumber: 8, tag: 'identity_rhyme' });
  });

  test('PB_INFANT: unrenderable_action tag is STILL FATAL', () => {
    const out = collectWriterFatalResiduals(buildResidualDoc(AGE_BANDS.PB_INFANT, [
      { spreadNumber: 9, tags: ['unrenderable_action'], issues: ['unrenderable_action: holds her purr.'] },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe('unrenderable_action');
  });

  test('PB_INFANT: writer_invented_prop tag is STILL FATAL', () => {
    const out = collectWriterFatalResiduals(buildResidualDoc(AGE_BANDS.PB_INFANT, [
      { spreadNumber: 7, tags: ['writer_invented_prop'], issues: ['writer_invented_prop: pats one string.'] },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe('writer_invented_prop');
  });

  test('PB_TODDLER: semantic_filler is STILL FATAL', () => {
    const out = collectWriterFatalResiduals(buildResidualDoc(AGE_BANDS.PB_TODDLER, [
      { spreadNumber: 4, tags: ['semantic_filler'], issues: ['semantic_filler: line 3 is filler.'] },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe('semantic_filler');
  });

  test('PB_PRESCHOOL: forced_rhyme_meaning_drift is STILL FATAL', () => {
    const out = collectWriterFatalResiduals(buildResidualDoc(AGE_BANDS.PB_PRESCHOOL, [
      { spreadNumber: 5, tags: ['forced_rhyme_meaning_drift'], issues: ['forced_rhyme_meaning_drift: laughs at wail.'] },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe('forced_rhyme_meaning_drift');
  });

  test('PB_INFANT: mixed structural + taste tags — only structural is fatal', () => {
    const out = collectWriterFatalResiduals(buildResidualDoc(AGE_BANDS.PB_INFANT, [
      {
        spreadNumber: 11,
        tags: ['identity_rhyme', 'semantic_filler', 'forced_rhyme_meaning_drift'],
        issues: [
          'rhyme_fail: identity rhyme.',
          'semantic_filler: line.',
          'forced_rhyme_meaning_drift: line.',
        ],
      },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe('identity_rhyme');
  });
});

// =============================================================================
// 4. checkWriterDraft — judge call dispatched against gpt-5.4
// =============================================================================

describe('AA-CW-20 — checkWriterDraft dispatches judge against gpt-5.4', () => {
  test('judge call uses MODELS.WRITER_JUDGE (gpt-5.4)', async () => {
    mockJudgeResult([
      { spreadNumber: 1, issues: [], tags: [], suggestedRewrite: null },
    ]);
    const doc = makeDoc([
      makeSpread(1, 'Look up at the bright sky.\nThe clouds drift up so high.\nMama hums a little song.\nThe whole bright day feels long.'),
    ]);
    await checkWriterDraft(doc);
    const judgeCall = callText.mock.calls.find(c => c[0].label === 'writerQa.judge')[0];
    expect(judgeCall.model).toBe('gpt-5.4');
    expect(judgeCall.model).toBe(MODELS.WRITER_JUDGE);
  });

  test('shadow call still uses MODELS.WRITER_QA (gemini-2.5-flash)', async () => {
    mockJudgeResult([
      { spreadNumber: 1, issues: [], tags: [], suggestedRewrite: null },
    ]);
    const doc = makeDoc([
      makeSpread(1, 'Look up at the bright sky.\nThe clouds drift up so high.\nMama hums a little song.\nThe whole bright day feels long.'),
    ]);
    await checkWriterDraft(doc);
    const shadowCall = callText.mock.calls.find(c => c[0].label === 'writerQa.shadow')[0];
    expect(shadowCall.model).toBe('gemini-2.5-flash');
  });
});

// =============================================================================
// 5. checkWriterDraft — advisory-only PB_INFANT pass
// =============================================================================

describe('AA-CW-20 — checkWriterDraft PB_INFANT advisory-only pass', () => {
  test('PB_INFANT spread with ONLY semantic_filler passes (advisory-only flips pass=true)', async () => {
    // Judge says pass=false because of semantic_filler. AA-CW-20 should
    // override and report pass=true at PB_INFANT.
    mockJudgeResult(
      [
        {
          spreadNumber: 1,
          issues: ['semantic_filler: line 3 is filler.'],
          tags: ['semantic_filler'],
          suggestedRewrite: null,
        },
      ],
      false,
    );
    const doc = makeDoc([
      makeSpread(1, 'Look up at the bright sky.\nThe clouds drift up so high.\nMama hums a little song.\nThe whole bright day feels long.'),
    ]);
    const result = await checkWriterDraft(doc);
    expect(result.pass).toBe(true);
    expect(result.repairPlan).toEqual([]);
    expect(result.perSpread[0].advisoryOnly).toBe(true);
    expect(result.perSpread[0].tags).toContain('semantic_filler');
  });

  test('PB_INFANT spread with structural tag (rhyme_fail) does NOT pass', async () => {
    mockJudgeResult(
      [
        {
          spreadNumber: 1,
          issues: ['rhyme_fail: lines 1+2 do not rhyme.'],
          tags: ['rhyme_fail'],
          suggestedRewrite: null,
        },
      ],
      false,
    );
    const doc = makeDoc([
      makeSpread(1, 'Look up at the bright sky.\nThe clouds drift up so high.\nMama hums a little song.\nThe whole bright day feels long.'),
    ]);
    const result = await checkWriterDraft(doc);
    expect(result.pass).toBe(false);
    expect(result.repairPlan.length).toBeGreaterThan(0);
  });

  test('PB_TODDLER spread with semantic_filler does NOT pass (taste tag still fatal)', async () => {
    mockJudgeResult(
      [
        {
          spreadNumber: 1,
          issues: ['semantic_filler: line 3 is filler.'],
          tags: ['semantic_filler'],
          suggestedRewrite: null,
        },
      ],
      false,
    );
    const doc = makeDoc(
      [
        makeSpread(1, 'Look up at the bright sky.\nThe clouds drift up so high.\nMama hums a little song.\nThe whole bright day feels long.'),
      ],
      AGE_BANDS.PB_TODDLER,
    );
    const result = await checkWriterDraft(doc);
    expect(result.pass).toBe(false);
    expect(result.perSpread[0].advisoryOnly).not.toBe(true);
  });
});

// =============================================================================
// 6. JUDGE_SYSTEM prompt — self-critique framing
// =============================================================================

describe('AA-CW-20 — JUDGE_SYSTEM prompt is reframed as self-critique', () => {
  test('preamble names self-critique', () => {
    expect(JUDGE_SYSTEM).toMatch(/SELF-CRITIQUE/);
  });

  test('preamble names same model family', () => {
    expect(JUDGE_SYSTEM).toMatch(/same model family/);
  });

  test('preamble names convergence and fixable defects', () => {
    expect(JUDGE_SYSTEM).toMatch(/convergence/i);
    expect(JUDGE_SYSTEM).toMatch(/fixable/i);
  });

  test('semantic_filler rule names band policy: ADVISORY at PB_INFANT', () => {
    // The semantic_filler section must include the band policy text.
    const sf = JUDGE_SYSTEM.split('20. "semantic_filler"')[1] || '';
    expect(sf).toMatch(/ADVISORY at PB_INFANT/);
  });

  test('forced_rhyme_meaning_drift rule names band policy: ADVISORY at PB_INFANT', () => {
    const frmd = JUDGE_SYSTEM.split('21. "forced_rhyme_meaning_drift"')[1] || '';
    expect(frmd).toMatch(/ADVISORY at PB_INFANT/);
  });

  test('fragment_line rule names band policy: ADVISORY at PB_INFANT', () => {
    const fl = JUDGE_SYSTEM.split('13. "fragment_line"')[1] || '';
    expect(fl).toMatch(/ADVISORY at PB_INFANT/);
  });

  test('Pass criteria splits STRUCTURAL and TASTE blocks', () => {
    expect(JUDGE_SYSTEM).toMatch(/STRUCTURAL \(all bands\)/);
    expect(JUDGE_SYSTEM).toMatch(/TASTE \(band-conditional\)/);
  });

  test('Pass criteria explicitly names PB_INFANT advisory escape', () => {
    expect(JUDGE_SYSTEM).toMatch(/When the only failures at PB_INFANT are advisory taste tags/);
  });

  test('STRUCTURAL block still forbids identity rhymes universally', () => {
    expect(JUDGE_SYSTEM).toMatch(/All rhymed couplets are real rhymes/);
  });
});
