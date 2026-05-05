/**
 * PR G — Infant spread compressor unit tests.
 *
 * Covers:
 *   - per-spread compression returns the LLM's 2-line output
 *   - book-level compressInfantManuscript only fires for PB_INFANT
 *   - LLM failures are swallowed (best-effort) and the original draft survives
 *   - pickBestCouplet picks an AA-rhyming pair when given more than 2 lines
 *   - banned verb / safe verb constants stay in sync with detector behavior
 */

jest.mock('../../../services/bookPipeline/llm/openaiClient', () => ({
  callText: jest.fn(),
}));

const { callText } = require('../../../services/bookPipeline/llm/openaiClient');
const {
  compressInfantManuscript,
  compressInfantSpreadText,
  pickBestCouplet,
  BANNED_INFANT_VERBS,
  SAFE_INFANT_VERBS,
} = require('../../../services/bookPipeline/writer/compressInfantSpread');
const {
  findInfantForbiddenActionVerbs,
} = require('../../../services/bookPipeline/qa/checkWriterDraft');
const { AGE_BANDS, FORMATS } = require('../../../services/bookPipeline/constants');

function makeSpread(spreadNumber, text) {
  return {
    spreadNumber,
    spec: {
      location: 'sunny doorway',
      focalAction: 'baby reaches for mama',
      plotBeat: 'PEEKABOO',
      textSide: 'right',
    },
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
    request: {
      ageBand,
      format: FORMATS.PICTURE_BOOK,
      heroName: 'Everleigh',
      theme: 'mothers_day',
    },
    brief: {
      heroName: 'Everleigh',
      child: { name: 'Everleigh', age: '1' },
      interests: ['peekaboo', 'soft toys'],
      customDetails: 'mom_name=Courtney; favorite_blanket=yellow',
    },
    spreads,
    storyBible: {},
    trace: { llmCalls: [], stages: [] },
    retryMemory: [],
    llmCalls: [],
    operationalContext: { bookId: 'test-book' },
  };
}

afterEach(() => {
  callText.mockReset();
});

describe('compressInfantSpreadText', () => {
  test('returns the LLM-emitted 2-line couplet and an llmCall record', async () => {
    callText.mockResolvedValueOnce({
      text: '{"text":"Sun warms cheek.\\nMama gives a peek."}',
      json: { text: 'Sun warms cheek.\nMama gives a peek.' },
      usage: { promptTokens: 100, completionTokens: 20 },
      model: 'gpt-5.4',
      attempts: 1,
      label: 'writerCompressInfant.s1',
      finishReason: 'stop',
    });

    const out = await compressInfantSpreadText({
      draftText: 'Peekaboo! Everleigh dances at the door.\nMama laughs and twirls some more.\nThey race outside.\nA bright chase has begun.',
      spec: { focalAction: 'peekaboo at the door' },
      brief: { heroName: 'Everleigh' },
      heroName: 'Everleigh',
      label: 'writerCompressInfant.s1',
    });

    expect(out.text).toBe('Sun warms cheek.\nMama gives a peek.');
    expect(out.text.split('\n')).toHaveLength(2);
    expect(out.llmCall).toMatchObject({
      stage: 'writerCompressInfant.s1',
      model: 'gpt-5.4',
      attempts: 1,
    });
    expect(callText).toHaveBeenCalledTimes(1);
    const callArgs = callText.mock.calls[0][0];
    expect(callArgs.jsonMode).toBe(true);
    expect(callArgs.temperature).toBeLessThan(0.6);
    // Banned verbs surface in the user prompt so the model sees the explicit list
    expect(callArgs.userPrompt).toMatch(/BANNED VERBS/);
    expect(callArgs.userPrompt).toMatch(/step/);
    expect(callArgs.userPrompt).toMatch(/bounce/);
  });

  test('falls back to the first AA-rhyming pair when the LLM returns 3+ lines', async () => {
    callText.mockResolvedValueOnce({
      text: '{"text":"Hi mama, hi.\\nClouds drift by.\\nDay is bright."}',
      json: { text: 'Hi mama, hi.\nClouds drift by.\nDay is bright.' },
      usage: { promptTokens: 80, completionTokens: 15 },
      model: 'gpt-5.4',
      attempts: 1,
      label: 'writerCompressInfant.s1',
      finishReason: 'stop',
    });

    const out = await compressInfantSpreadText({
      draftText: 'long draft',
      spec: {},
      brief: {},
      heroName: 'X',
      label: 'writerCompressInfant.s1',
    });
    expect(out.text.split('\n')).toHaveLength(2);
    // hi/by rhymes — the truncator should pick the first rhyming pair
    expect(out.text).toBe('Hi mama, hi.\nClouds drift by.');
  });
});

describe('compressInfantManuscript', () => {
  test('replaces every infant spread\'s text with the LLM\'s compressed couplet', async () => {
    const doc = makeDoc([
      makeSpread(1, 'Peekaboo at the door.\nEverleigh wants more.\nMama dances near.\nA giggle, oh dear.'),
      makeSpread(2, 'Tall grass blew.\nSky warm and blue.'),
    ]);

    callText
      .mockResolvedValueOnce({
        text: '{"text":"Mama lifts the moon.\\nBright as a spoon."}',
        json: { text: 'Mama lifts the moon.\nBright as a spoon.' },
        usage: { promptTokens: 90, completionTokens: 18 },
        model: 'gpt-5.4',
        attempts: 1,
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        text: '{"text":"Soft sun on cheek.\\nMama gives a peek."}',
        json: { text: 'Soft sun on cheek.\nMama gives a peek.' },
        usage: { promptTokens: 80, completionTokens: 16 },
        model: 'gpt-5.4',
        attempts: 1,
        finishReason: 'stop',
      });

    const next = await compressInfantManuscript(doc);

    const s1 = next.spreads.find(s => s.spreadNumber === 1);
    const s2 = next.spreads.find(s => s.spreadNumber === 2);
    expect(s1.manuscript.text).toBe('Mama lifts the moon.\nBright as a spoon.');
    expect(s2.manuscript.text).toBe('Soft sun on cheek.\nMama gives a peek.');
    // The compressor only walks spreads 1..TOTAL_SPREADS that have text;
    // here we provided 2 spreads so callText fires twice.
    expect(callText).toHaveBeenCalledTimes(2);
    // llmCalls trace gets one entry per compressed spread
    const compressionCalls = (next.trace?.llmCalls || []).filter(c => /writerCompressInfant/.test(c.stage || ''));
    expect(compressionCalls.length).toBe(2);
  });

  test('is a no-op for non-infant age bands (no LLM calls, manuscript unchanged)', async () => {
    const doc = makeDoc(
      [makeSpread(1, 'Original toddler text.\nStays exactly as-is.')],
      AGE_BANDS.PB_PRESCHOOL,
    );
    const next = await compressInfantManuscript(doc);
    expect(callText).not.toHaveBeenCalled();
    expect(next).toBe(doc);
  });

  test('on per-spread LLM failure, keeps the original draft text and continues', async () => {
    const doc = makeDoc([
      makeSpread(1, 'Original spread one text.\nKept on failure.'),
      makeSpread(2, 'Original spread two text.\nReplaced on success.'),
    ]);

    callText
      .mockRejectedValueOnce(new Error('LLM hiccup'))
      .mockResolvedValueOnce({
        text: '{"text":"Soft new line.\\nBoard-book fine."}',
        json: { text: 'Soft new line.\nBoard-book fine.' },
        usage: {},
        model: 'gpt-5.4',
        attempts: 1,
        finishReason: 'stop',
      });

    const next = await compressInfantManuscript(doc);

    const s1 = next.spreads.find(s => s.spreadNumber === 1);
    const s2 = next.spreads.find(s => s.spreadNumber === 2);
    expect(s1.manuscript.text).toBe('Original spread one text.\nKept on failure.');
    expect(s2.manuscript.text).toBe('Soft new line.\nBoard-book fine.');
    // The failed spread still records an llmCall entry with an error field
    const errorCall = (next.trace?.llmCalls || []).find(c => c.stage === 'writerCompressInfant.s1');
    expect(errorCall).toBeTruthy();
    expect(errorCall.error).toMatch(/LLM hiccup/);
  });

  test('skips spreads whose manuscript text is empty / missing', async () => {
    const docSpreads = [
      makeSpread(1, 'Spread one has text.\nIt rhymes here.'),
      makeSpread(2, ''),
    ];
    docSpreads[1].manuscript = null; // simulate missing manuscript
    const doc = makeDoc(docSpreads);

    callText.mockResolvedValueOnce({
      text: '{"text":"New line one.\\nNew line done."}',
      json: { text: 'New line one.\nNew line done.' },
      usage: {},
      model: 'gpt-5.4',
      attempts: 1,
      finishReason: 'stop',
    });

    await compressInfantManuscript(doc);
    expect(callText).toHaveBeenCalledTimes(1);
  });
});

describe('pickBestCouplet', () => {
  test('returns input unchanged when 2 lines or fewer', () => {
    expect(pickBestCouplet('one\ntwo')).toBe('one\ntwo');
    expect(pickBestCouplet('only one')).toBe('only one');
  });

  test('picks the first AA-rhyming pair from a multi-line block', () => {
    const out = pickBestCouplet('Mama lifts a spoon.\nThe day is wide.\nBright as a moon.\nClouds drift by.');
    // spoon/moon rhymes; appears as lines 1 and 3 — picker should grab them
    expect(out).toBe('Mama lifts a spoon.\nBright as a moon.');
  });

  test('falls back to first two lines when nothing rhymes', () => {
    const out = pickBestCouplet('Apple.\nOrange.\nBanana.');
    expect(out).toBe('Apple.\nOrange.');
  });
});

describe('BANNED_INFANT_VERBS / SAFE_INFANT_VERBS', () => {
  test('every banned verb actually trips the writer-QA detector', () => {
    for (const verb of BANNED_INFANT_VERBS) {
      const out = findInfantForbiddenActionVerbs(`she ${verb} now`, AGE_BANDS.PB_INFANT);
      expect(out.length).toBeGreaterThan(0);
    }
  });

  test('safe verbs do NOT trip the detector', () => {
    for (const verb of SAFE_INFANT_VERBS) {
      const out = findInfantForbiddenActionVerbs(`she ${verb} now`, AGE_BANDS.PB_INFANT);
      expect(out).toEqual([]);
    }
  });
});
