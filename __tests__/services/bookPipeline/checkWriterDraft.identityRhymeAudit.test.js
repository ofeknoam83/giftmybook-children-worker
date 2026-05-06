/**
 * AA-CW-11 \u2014 Deterministic identity-rhyme audit + judge model flip.
 *
 * Production failure: a 13-spread PB_INFANT book shipped with multiple
 * couplets ending on the same word ("cheek/cheek", "Mama/Mama"). The
 * gpt-5.4 judge \u2014 same family as the gpt-5.4 writer \u2014 passed them.
 *
 * Two structural fixes locked in this suite:
 *   1. WRITER_JUDGE model is now `gemini-2.5-pro` (different vendor,
 *      different family from the gpt-5.4 writer; decouples the judge
 *      from the writer's distribution).
 *   2. After the LLM judge returns, a pure deterministic post-pass
 *      extracts the last word of each line and forces a `rhyme_fail`
 *      + `identity_rhyme` tag if either couplet (lines 1+2 or 3+4)
 *      ends on the same surface form. This is belt-and-suspenders \u2014
 *      it works regardless of which model is the judge.
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
    operationalContext: { bookId: 'identity-rhyme-audit-test' },
    llmCalls: [],
  };
}

function mockClean() {
  callText.mockImplementation(async ({ label }) => {
    if (label === 'writerQa.judge') {
      return {
        json: {
          pass: true,
          bookLevelIssues: [],
          bookLevelTags: [],
          perSpread: [
            { spreadNumber: 1, issues: [], tags: [], suggestedRewrite: null },
          ],
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

describe('AA-CW-20 \u2014 WRITER_JUDGE model flip (self-critique)', () => {
  test('WRITER_JUDGE points at gpt-5.4 (same family as writer for self-critique)', () => {
    expect(MODELS.WRITER_JUDGE).toBe('gpt-5.4');
    expect(MODELS.WRITER).toBe('gpt-5.4');
    expect(MODELS.WRITER).toBe(MODELS.WRITER_JUDGE);
  });

  test('judge call is dispatched with WRITER_JUDGE (gpt-5.4)', async () => {
    mockClean();
    const doc = makeDoc([
      // Lines 1+2 rhyme (sky/high), lines 3+4 rhyme (song/long) \u2014 clean.
      makeSpread(1, 'Look up at the bright sky.\nThe clouds drift up so high.\nMama hums a little song.\nThe whole bright day feels long.'),
    ]);
    await checkWriterDraft(doc);
    const judgeCall = callText.mock.calls.find(c => c[0].label === 'writerQa.judge')[0];
    expect(judgeCall.model).toBe('gpt-5.4');
    expect(judgeCall.model).toBe(MODELS.WRITER_JUDGE);
  });
});

describe('AA-CW-11 \u2014 deterministic identity-rhyme audit', () => {
  test('forces rhyme_fail when LLM judge missed lines 1+2 identity rhyme', async () => {
    // Mock: judge says clean. Deterministic check must override.
    mockClean();
    const doc = makeDoc([
      // Lines 1+2 both end on "cheek" (the production failure case).
      makeSpread(1, 'Window sun warms her cheek.\nMama holds her, cheek to cheek.\nMama says, "Smushy," bright.\nScarlett smiles in light.'),
    ]);

    const verdict = await checkWriterDraft(doc);
    expect(verdict.pass).toBe(false);
    expect(verdict.repairPlan).toHaveLength(1);
    const entry = verdict.perSpread[0];
    expect(entry.tags).toContain('rhyme_fail');
    expect(entry.tags).toContain('identity_rhyme');
    expect(entry.issues.some(i => /identity rhyme/i.test(i) && /cheek/i.test(i))).toBe(true);
  });

  test('forces rhyme_fail when LLM judge missed lines 3+4 identity rhyme (Mama/Mama)', async () => {
    mockClean();
    const doc = makeDoc([
      // Lines 3+4 both end on "Mama".
      makeSpread(1, 'Bright stars hang up high.\nClouds drift past the sky.\nScarlett looks at Mama.\nShe squeals to Mama.'),
    ]);

    const verdict = await checkWriterDraft(doc);
    expect(verdict.pass).toBe(false);
    const entry = verdict.perSpread[0];
    expect(entry.tags).toContain('identity_rhyme');
    expect(entry.issues.some(i => /identity rhyme/i.test(i) && /mama/i.test(i))).toBe(true);
  });

  test('flags BOTH couplets when both end on identity rhymes', async () => {
    mockClean();
    const doc = makeDoc([
      makeSpread(1, 'Soft warm cheek.\nGentle little cheek.\nLittle one Mama.\nClose to Mama.'),
    ]);
    const verdict = await checkWriterDraft(doc);
    const entry = verdict.perSpread[0];
    const identityIssues = entry.issues.filter(i => /identity rhyme/i.test(i));
    expect(identityIssues.length).toBe(2);
    expect(identityIssues.some(i => /cheek/i.test(i))).toBe(true);
    expect(identityIssues.some(i => /mama/i.test(i))).toBe(true);
  });

  test('does NOT flag genuinely rhymed couplets (high/sky, song/long)', async () => {
    mockClean();
    const doc = makeDoc([
      makeSpread(1, 'Look up at the bright sky.\nThe clouds drift up so high.\nMama hums a little song.\nThe whole bright day feels long.'),
    ]);
    const verdict = await checkWriterDraft(doc);
    expect(verdict.pass).toBe(true);
    expect(verdict.perSpread[0].tags).not.toContain('identity_rhyme');
  });

  test('case-insensitive and punctuation-tolerant (e.g. "Mama!" vs "mama")', async () => {
    mockClean();
    const doc = makeDoc([
      makeSpread(1, 'Bright stars hang up high.\nClouds drift past the sky.\nShe squeals, "Mama!"\nShe whispers mama.'),
    ]);
    const verdict = await checkWriterDraft(doc);
    expect(verdict.perSpread[0].tags).toContain('identity_rhyme');
  });

  test('AA-CW-21: drops non-fatal judge tags but adds the deterministic identity_rhyme', async () => {
    callText.mockImplementation(async ({ label }) => {
      if (label === 'writerQa.judge') {
        return {
          json: {
            pass: false,
            bookLevelIssues: [],
            bookLevelTags: [],
            perSpread: [
              {
                spreadNumber: 1,
                issues: ['verb_crutch: too many "looks"'],
                tags: ['verb_crutch'],
                suggestedRewrite: null,
              },
            ],
            infantLocomotionHits: [],
          },
          model: MODELS.WRITER_JUDGE,
          attempts: 1,
          usage: { in: 1, out: 1 },
        };
      }
      return { json: { pass: false, bookLevelIssues: [], perSpread: [] }, model: MODELS.WRITER_QA, attempts: 1, usage: { in: 1, out: 1 } };
    });
    const doc = makeDoc([
      makeSpread(1, 'Soft warm cheek.\nGentle little cheek.\nClose to Mama.\nNear to Papa.'),
    ]);
    const verdict = await checkWriterDraft(doc);
    const entry = verdict.perSpread[0];
    // AA-CW-21: verb_crutch is now advisory and filtered out by the
    // 5-tag whitelist.
    expect(entry.tags).not.toContain('verb_crutch');
    // The deterministic identity-rhyme audit still forces these.
    expect(entry.tags).toContain('rhyme_fail');
    expect(entry.tags).toContain('identity_rhyme');
  });

  test('fewer than 4 lines on a spread → no identity-rhyme audit (defensive)', async () => {
    mockClean();
    const doc = makeDoc([
      makeSpread(1, 'Soft warm cheek.\nGentle little cheek.'),
    ]);
    const verdict = await checkWriterDraft(doc);
    // 2-line spread won't trigger the identity-rhyme flag; line-count
    // failure is the LLM judge's job.
    expect(verdict.perSpread[0].tags).not.toContain('identity_rhyme');
  });
});
