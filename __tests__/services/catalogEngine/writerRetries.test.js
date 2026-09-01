/**
 * Writer attempt/repair budgets: a few retries before a candidate completely
 * fails. Generation retries feed the validation errors back
 * (CATALOG_WRITER_MAX_ATTEMPTS, default 3 attempts total); bounded failures
 * then get up to CATALOG_WRITER_MAX_REPAIRS (default 2) targeted repair
 * passes, each fully re-validated and held to the minimal-edit boundary.
 */

jest.mock('../../../services/shared/llm/openaiClient', () => ({
  callText: jest.fn(),
  LlmParseError: class LlmParseError extends Error {},
}));

const { callText } = require('../../../services/shared/llm/openaiClient');
const {
  generateStory,
  buildStoryRequest,
  StoryGenerationError,
  WRITER_MAX_ATTEMPTS,
  WRITER_MAX_REPAIRS,
} = require('../../../services/catalogEngine/writer');

const PRONOUNS = { subject: 'she', object: 'her', possessive_adjective: 'her' };
const PROFILE = { name: 'Emma', age: 2, pronouns: PRONOUNS };
const BOOK_ID = 'farm_2_3_hello_farm';

/** A response that passes the full validation for farm_2_3_hello_farm
 * (world name present, Farmer Bea on her beats, counting on spread 7,
 * refrain on 2/5/8/11) — same fixture shape as writerPolish.test.js. */
function validResponse(request, wordSwap = 'sunny') {
  const base = `Emma walks along the ${wordSwap} path at Sunnybrook Farm and smiles at the animals`;
  const spreads = Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    let text;
    if ([3, 4, 12].includes(n)) text = `${base}. Farmer Bea waves at Emma warmly.`;
    else if (n === 7) text = `Emma counts one, two, three little hens beside the ${wordSwap} barn today`;
    else text = `${base} today.`;
    if ([2, 5, 8, 11].includes(n)) text += ' Hello, farm! Here we are!';
    return { spread: n, text };
  });
  return {
    request_id: request.request_id,
    book_id: request.book_id,
    title: request.rendered_title,
    versions: { ...request.versions },
    spreads,
    personalization_evidence: [],
    omitted_profile_fields: [],
  };
}

/** Same story, but spread 1 blows the exact-age-2 per-spread word max —
 * a bounded, repairable violation (`spread 1: N words, must be ...`). */
function overlongResponse(request, filler = 'The gentle breeze drifts over the quiet green meadow while happy little birds sing sweet cheerful songs together this bright morning') {
  const r = validResponse(request);
  r.spreads[0] = { spread: 1, text: `${r.spreads[0].text} ${filler}.` };
  return r;
}

function pinnedRequest(requestId) {
  return buildStoryRequest({ bookId: BOOK_ID, profile: PROFILE, sessionId: 'sess_retries', requestId }).request;
}

function generate(requestId) {
  return generateStory({ bookId: BOOK_ID, profile: PROFILE, sessionId: 'sess_retries', requestId });
}

const ok = (json) => ({ json, usage: { inputTokens: 1, outputTokens: 1 } });

afterEach(() => {
  callText.mockReset();
  delete process.env.CATALOG_WRITER_MAX_ATTEMPTS;
  delete process.env.CATALOG_WRITER_MAX_REPAIRS;
});

describe('attempt/repair budget knobs', () => {
  it('default to 3 attempts and 2 repairs, clamped against nonsense values', () => {
    expect(WRITER_MAX_ATTEMPTS()).toBe(3);
    expect(WRITER_MAX_REPAIRS()).toBe(2);
    process.env.CATALOG_WRITER_MAX_ATTEMPTS = '99';
    process.env.CATALOG_WRITER_MAX_REPAIRS = '-1';
    expect(WRITER_MAX_ATTEMPTS()).toBe(3);
    expect(WRITER_MAX_REPAIRS()).toBe(2);
    process.env.CATALOG_WRITER_MAX_ATTEMPTS = 'lots';
    process.env.CATALOG_WRITER_MAX_REPAIRS = '0';
    expect(WRITER_MAX_ATTEMPTS()).toBe(3);
    expect(WRITER_MAX_REPAIRS()).toBe(0);
    process.env.CATALOG_WRITER_MAX_ATTEMPTS = '1';
    process.env.CATALOG_WRITER_MAX_REPAIRS = '5';
    expect(WRITER_MAX_ATTEMPTS()).toBe(1);
    expect(WRITER_MAX_REPAIRS()).toBe(5);
  });
});

describe('generation retries', () => {
  it('a story that only validates on the third attempt still ships', async () => {
    const request = pinnedRequest('req_retry_third');
    callText
      .mockResolvedValueOnce(ok(overlongResponse(request)))
      .mockResolvedValueOnce(ok(overlongResponse(request)))
      .mockResolvedValueOnce(ok(validResponse(request)));

    const result = await generate('req_retry_third');
    expect(callText).toHaveBeenCalledTimes(3);
    expect(callText.mock.calls.map(c => c[0].label)).toEqual([
      expect.stringMatching(/:attempt1$/),
      expect.stringMatching(/:attempt2$/),
      expect.stringMatching(/:attempt3$/),
    ]);
    // Retries feed the previous validation errors back into the prompt.
    expect(callText.mock.calls[1][0].userPrompt).toContain('PREVIOUS ATTEMPT FAILED VALIDATION');
    expect(callText.mock.calls[1][0].userPrompt).toMatch(/spread 1: \d+ words, must be/);
    expect(result.attempts).toBe(3);
    expect(result.repaired).toBeUndefined();
  });

  it('CATALOG_WRITER_MAX_ATTEMPTS=1 with repairs disabled fails after a single call', async () => {
    process.env.CATALOG_WRITER_MAX_ATTEMPTS = '1';
    process.env.CATALOG_WRITER_MAX_REPAIRS = '0';
    const request = pinnedRequest('req_single_shot');
    callText.mockResolvedValue(ok(overlongResponse(request)));

    await expect(generate('req_single_shot')).rejects.toThrow(StoryGenerationError);
    expect(callText).toHaveBeenCalledTimes(1);
  });
});

describe('repair passes', () => {
  it('a repair that converges only on the second pass still ships as repaired', async () => {
    const request = pinnedRequest('req_repair_second');
    // All 3 generations overlong; repair 1 trims but stays overlong
    // (adopted as the new base); repair 2 lands the fix.
    callText
      .mockResolvedValueOnce(ok(overlongResponse(request)))
      .mockResolvedValueOnce(ok(overlongResponse(request)))
      .mockResolvedValueOnce(ok(overlongResponse(request)))
      .mockResolvedValueOnce(ok(overlongResponse(request, 'while soft clouds drift high above the quiet friendly farmyard in the morning')))
      .mockResolvedValueOnce(ok(validResponse(request)));

    const result = await generate('req_repair_second');
    expect(callText).toHaveBeenCalledTimes(5);
    expect(callText.mock.calls[3][0].label).toMatch(/:repair1$/);
    expect(callText.mock.calls[4][0].label).toMatch(/:repair2$/);
    // Pass 2 repairs the ADOPTED (pass-1) draft, not the original.
    expect(callText.mock.calls[4][0].userPrompt).toContain('friendly farmyard');
    expect(result.repaired).toBe(true);
    expect(result.attempts).toBe(5);
  });

  it('a boundary-breaking repair is discarded — the next pass retries from the kept draft', async () => {
    const request = pinnedRequest('req_repair_boundary');
    // Repair 1 fixes spread 1 but ALSO rewrites unimplicated spread 3.
    const overreach = validResponse(request);
    overreach.spreads[2] = { spread: 3, text: 'Emma skips through Sunnybrook Farm while Farmer Bea waves at Emma warmly today.' };
    callText
      .mockResolvedValueOnce(ok(overlongResponse(request)))
      .mockResolvedValueOnce(ok(overlongResponse(request)))
      .mockResolvedValueOnce(ok(overlongResponse(request)))
      .mockResolvedValueOnce(ok(overreach))
      .mockResolvedValueOnce(ok(validResponse(request)));

    const result = await generate('req_repair_boundary');
    expect(callText).toHaveBeenCalledTimes(5);
    // The overreaching draft never became the base: spread 3 ships verbatim
    // from the kept draft, and repair 2 was prompted with the KEPT spread 1.
    expect(result.response.spreads[2].text).toBe(validResponse(request).spreads[2].text);
    expect(callText.mock.calls[4][0].userPrompt).toContain('gentle breeze');
    expect(result.repaired).toBe(true);
  });

  it('exhausting both budgets fails the candidate, naming the counts and the latest violations', async () => {
    const request = pinnedRequest('req_exhausted');
    callText.mockResolvedValue(ok(overlongResponse(request)));

    const err = await generate('req_exhausted').catch(e => e);
    expect(err).toBeInstanceOf(StoryGenerationError);
    expect(err.message).toContain('failed validation after 3 attempts and 2 repair passes');
    expect(err.validationErrors.join(' ')).toMatch(/spread 1: \d+ words, must be/);
    expect(callText).toHaveBeenCalledTimes(5); // 3 generations + 2 repairs
  });

  it('a repair-call error consumes one pass and the loop continues', async () => {
    const request = pinnedRequest('req_repair_flake');
    callText
      .mockResolvedValueOnce(ok(overlongResponse(request)))
      .mockResolvedValueOnce(ok(overlongResponse(request)))
      .mockResolvedValueOnce(ok(overlongResponse(request)))
      .mockRejectedValueOnce(new Error('upstream 503'))
      .mockResolvedValueOnce(ok(validResponse(request)));

    const result = await generate('req_repair_flake');
    expect(result.repaired).toBe(true);
    expect(callText).toHaveBeenCalledTimes(5);
  });
});
