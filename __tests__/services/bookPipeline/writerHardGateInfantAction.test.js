/**
 * PR F.1/F.2 — Writer hard gate.
 *
 * If the writer rewrite loop exhausts and the manuscript still contains
 * infant-forbidden action verbs, the pipeline must throw a
 * WriterUnresolvableError tagged `infant_action_text_residual` instead
 * of letting the bad text reach the illustrator (where it would burn
 * the entire per-spread budget on an unwinnable loop).
 */

jest.mock('../../../services/bookPipeline/llm/openaiClient', () => ({
  callText: jest.fn(),
}));

const { callText } = require('../../../services/bookPipeline/llm/openaiClient');
const {
  writerQaAndRewrite,
  collectInfantActionResiduals,
  WriterUnresolvableError,
} = require('../../../services/bookPipeline/writer/rewriteBookText');
const { AGE_BANDS, FORMATS, FAILURE_CODES, REPAIR_BUDGETS } = require('../../../services/bookPipeline/constants');

function makeSpread(spreadNumber, text) {
  return {
    spreadNumber,
    spec: { textSide: 'right' },
    manuscript: { text, side: 'right', lineBreakHints: [], personalizationUsed: [], writerNotes: null },
    qa: { spreadChecks: [], repairHistory: [] },
  };
}

function makeDoc(spreads, ageBand = AGE_BANDS.PB_INFANT) {
  return {
    request: {
      ageBand,
      format: FORMATS.PICTURE_BOOK,
      theme: 'mothers_day',
    },
    brief: {
      child: { name: 'Everleigh', age: ageBand === AGE_BANDS.PB_INFANT ? '1' : '3' },
      customDetails: { mom_name: 'Courtney' },
    },
    spreads,
    storyBible: {},
    trace: { llmCalls: [], stages: [] },
    retryMemory: [],
    operationalContext: { bookId: 'test-book' },
  };
}

afterEach(() => {
  callText.mockReset();
});

describe('collectInfantActionResiduals', () => {
  test('returns offenders for infant book containing forbidden verbs', () => {
    const doc = makeDoc([
      makeSpread(1, 'Everleigh twirls up high.\nRibbons loop the sky.'),
      makeSpread(2, 'Soft sun on her cheek.\nMama gives a peek.'),
      makeSpread(3, 'Tall grass skips all day.\nSun warms toes that sway.'),
    ]);
    const residuals = collectInfantActionResiduals(doc);
    const offendingNumbers = residuals.map(r => r.spreadNumber).sort();
    expect(offendingNumbers).toEqual([1, 3]);
    expect(residuals.find(r => r.spreadNumber === 1).hits.join(',')).toMatch(/twirl/);
    expect(residuals.find(r => r.spreadNumber === 3).hits.join(',')).toMatch(/skip/);
  });

  test('returns empty for non-infant age band even with locomotion verbs', () => {
    const doc = makeDoc(
      [makeSpread(1, 'Everleigh twirls up high.\nRibbons loop the sky.')],
      AGE_BANDS.PB_PRESCHOOL,
    );
    expect(collectInfantActionResiduals(doc)).toEqual([]);
  });

  test('returns empty for clean infant manuscript', () => {
    const doc = makeDoc([
      makeSpread(1, 'Soft sun on her cheek.\nMama gives a peek.'),
      makeSpread(2, 'Wave hello to Mama.\nClap clap, little llama.'),
    ]);
    expect(collectInfantActionResiduals(doc)).toEqual([]);
  });
});

describe('writerQaAndRewrite hard gate', () => {
  test('throws WriterUnresolvableError tagged infant_action_text_residual when forbidden verbs survive all rewrite waves', async () => {
    // Stub the literary-QA LLM call to always pass — so the only thing that
    // can fail QA is the deterministic infant-line-count + action-verb check.
    // That keeps the test isolated to the hard-gate behaviour.
    callText.mockResolvedValue({
      json: {
        pass: true,
        perSpread: [],
        bookLevelIssues: [],
        // when invoked as a rewrite, return the same offending text so the
        // forbidden verbs persist all the way through the loop
        spreads: [
          { spreadNumber: 1, text: 'Everleigh twirls up high.\nRibbons loop the sky.', side: 'right' },
        ],
      },
      model: 'stub',
      attempts: 1,
      usage: {},
    });

    const doc = makeDoc([
      makeSpread(1, 'Everleigh twirls up high.\nRibbons loop the sky.'),
    ]);

    await expect(writerQaAndRewrite(doc)).rejects.toMatchObject({
      name: 'WriterUnresolvableError',
      failureCode: FAILURE_CODES.WRITER_UNRESOLVABLE,
      tags: ['infant_action_text_residual'],
    });
  });

  test('does not throw when manuscript is clean of forbidden verbs (even if other QA fails)', async () => {
    // Even when other QA detectors fail, the hard gate must not fire as long
    // as no infant-forbidden action verbs remain. The pipeline should return
    // normally so other failure modes can be reported through the regular
    // writerQa.pass=false channel.
    callText.mockResolvedValue({
      json: { pass: true, perSpread: [], bookLevelIssues: [] },
      model: 'stub',
      attempts: 1,
      usage: {},
    });

    const doc = makeDoc([
      makeSpread(1, 'Soft sun on her cheek.\nMama gives a peek.'),
    ]);

    // Should resolve, not throw — the absence of forbidden verbs is what
    // matters, regardless of other QA outcomes.
    await expect(writerQaAndRewrite(doc)).resolves.toBeDefined();
  });

  test('does not throw for non-infant book even with locomotion verbs', async () => {
    callText.mockResolvedValue({
      json: { pass: true, perSpread: [], bookLevelIssues: [] },
      model: 'stub',
      attempts: 1,
      usage: {},
    });

    const doc = makeDoc(
      [makeSpread(1, 'Everleigh twirls up high.\nThen jumps down to say hi.\nRibbons loop the sky.\nMama gives a sigh.')],
      AGE_BANDS.PB_PRESCHOOL,
    );

    // Should not throw regardless of QA pass/fail noise — preschool age band
    // never trips the infant action gate.
    await expect(writerQaAndRewrite(doc)).resolves.toBeDefined();
  });

  test('WriterUnresolvableError carries per-spread issue strings naming the offending verb(s)', async () => {
    callText.mockResolvedValue({
      json: { pass: true, perSpread: [], bookLevelIssues: [] },
      model: 'stub',
      attempts: 1,
      usage: {},
    });
    const doc = makeDoc([
      makeSpread(1, 'Everleigh twirls up high.\nRibbons loop the sky.'),
      makeSpread(2, 'She skips the day away.\nSun says hi to play.'),
    ]);

    let caught;
    try {
      await writerQaAndRewrite(doc);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WriterUnresolvableError);
    expect(caught.issues.length).toBe(2);
    expect(caught.issues.join(' | ')).toMatch(/spread 1/);
    expect(caught.issues.join(' | ')).toMatch(/spread 2/);
    expect(caught.issues.join(' | ')).toMatch(/twirl/);
    expect(caught.issues.join(' | ')).toMatch(/skip/);
  });
});
