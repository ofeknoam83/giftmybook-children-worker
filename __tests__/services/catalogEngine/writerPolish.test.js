/**
 * Style-polish pass integration: a validated story gets ONE focused polish
 * call when a tuning overlay is pinned; the polished response ships only if
 * it re-passes the full validation with identical personalization evidence —
 * any polish failure keeps the validated draft.
 */

jest.mock('../../../services/shared/llm/openaiClient', () => ({
  callText: jest.fn(),
  LlmParseError: class LlmParseError extends Error {},
}));

const { callText } = require('../../../services/shared/llm/openaiClient');
const { generateStory, buildStoryRequest, normalizeTuning } = require('../../../services/catalogEngine/writer');

const PRONOUNS = { subject: 'she', object: 'her', possessive_adjective: 'her' };
const PROFILE = { name: 'Emma', age: 2, pronouns: PRONOUNS };
const TUNING = {
  versionLabel: 'tune-007',
  hash: '9F31C2AB9F31C2AB',
  text: '- NON-NEGOTIABLE — Prefer concrete sensory detail.',
};

/** A response that passes the full validation (theme beat checks included)
 * for farm_2_3_hello_farm: world name present, Farmer Bea on her beats,
 * counting on spread 7, refrain on 2/5/8/11. */
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

const REQUEST_ID = 'req_polish_test_1';

function pinnedRequest(tuning) {
  return buildStoryRequest({
    bookId: 'farm_2_3_hello_farm', profile: PROFILE, sessionId: 'sess_polish', requestId: REQUEST_ID, tuning,
  }).request;
}

afterEach(() => {
  callText.mockReset();
  delete process.env.CATALOG_STYLE_POLISH;
});

test('a validated tuned story is polished and the polished prose ships', async () => {
  const tuning = normalizeTuning(TUNING);
  const request = pinnedRequest(tuning);
  callText
    .mockResolvedValueOnce({ json: validResponse(request, 'sunny'), usage: { inputTokens: 10, outputTokens: 20 } })
    .mockResolvedValueOnce({ json: validResponse(request, 'golden'), usage: { inputTokens: 5, outputTokens: 10 } });

  const result = await generateStory({
    bookId: 'farm_2_3_hello_farm', profile: PROFILE, sessionId: 'sess_polish', requestId: REQUEST_ID, tuning: TUNING,
  });

  expect(callText).toHaveBeenCalledTimes(2);
  expect(callText.mock.calls[1][0].label).toMatch(/:polish$/);
  expect(callText.mock.calls[1][0].userPrompt).toContain('# STYLE POLISH TASK');
  expect(result.polished).toBe(true);
  expect(result.response.spreads[0].text).toContain('golden');
  expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 30 });
});

test('a polish result that fails validation is discarded — the draft ships', async () => {
  const tuning = normalizeTuning(TUNING);
  const request = pinnedRequest(tuning);
  const broken = validResponse(request, 'golden');
  broken.spreads[1].text = 'No refrain here anymore.'; // drops the required refrain
  callText
    .mockResolvedValueOnce({ json: validResponse(request, 'sunny'), usage: { inputTokens: 10, outputTokens: 20 } })
    .mockResolvedValueOnce({ json: broken, usage: { inputTokens: 5, outputTokens: 10 } });

  const result = await generateStory({
    bookId: 'farm_2_3_hello_farm', profile: PROFILE, sessionId: 'sess_polish', requestId: REQUEST_ID, tuning: TUNING,
  });

  expect(callText).toHaveBeenCalledTimes(2);
  expect(result.polished).toBeUndefined();
  expect(result.response.spreads[0].text).toContain('sunny');
});

test('no tuning overlay → no polish call; CATALOG_STYLE_POLISH=0 kills it for tuned runs', async () => {
  const bareRequest = pinnedRequest(null);
  callText.mockResolvedValueOnce({ json: validResponse(bareRequest), usage: { inputTokens: 10, outputTokens: 20 } });
  const bare = await generateStory({ bookId: 'farm_2_3_hello_farm', profile: PROFILE, sessionId: 'sess_polish', requestId: REQUEST_ID });
  expect(callText).toHaveBeenCalledTimes(1);
  expect(bare.polished).toBeUndefined();

  callText.mockReset();
  process.env.CATALOG_STYLE_POLISH = '0';
  const tuning = normalizeTuning(TUNING);
  const request = pinnedRequest(tuning);
  callText.mockResolvedValueOnce({ json: validResponse(request), usage: { inputTokens: 10, outputTokens: 20 } });
  const killed = await generateStory({
    bookId: 'farm_2_3_hello_farm', profile: PROFILE, sessionId: 'sess_polish', requestId: REQUEST_ID, tuning: TUNING,
  });
  expect(callText).toHaveBeenCalledTimes(1);
  expect(killed.polished).toBeUndefined();
});

test('polish that rewrites the omission audit is discarded — the draft ships', async () => {
  const tuning = normalizeTuning(TUNING);
  const request = pinnedRequest(tuning);
  const draft = validResponse(request, 'sunny');
  // Above the map minima the validator does not constrain omissions, so
  // only the polish guard protects this audit data.
  draft.omitted_profile_fields = [{ source_field: 'food', reason: 'missing' }];
  const polished = validResponse(request, 'golden');
  polished.omitted_profile_fields = []; // audit silently dropped
  callText
    .mockResolvedValueOnce({ json: draft, usage: { inputTokens: 10, outputTokens: 20 } })
    .mockResolvedValueOnce({ json: polished, usage: { inputTokens: 5, outputTokens: 10 } });

  const result = await generateStory({
    bookId: 'farm_2_3_hello_farm', profile: PROFILE, sessionId: 'sess_polish', requestId: REQUEST_ID, tuning: TUNING,
  });
  expect(result.polished).toBeUndefined();
  expect(result.response.spreads[0].text).toContain('sunny');
  expect(result.response.omitted_profile_fields).toEqual([{ source_field: 'food', reason: 'missing' }]);
});

test('a failed repair reports the REPAIR response\'s errors, not the stale pre-repair ones', async () => {
  const request = pinnedRequest(null);
  const longText = 'the little hen walks slowly down the winding path '.repeat(20);
  const brokenSpread1 = validResponse(request);
  brokenSpread1.spreads[0].text = longText; // word-bound violation on spread 1 (repairable)
  const brokenSpread3 = validResponse(request);
  brokenSpread3.spreads[2].text = `${longText}. Farmer Bea waves at Emma warmly.`; // now spread 3 violates instead
  callText
    .mockResolvedValueOnce({ json: brokenSpread1, usage: {} }) // attempt 1
    .mockResolvedValueOnce({ json: brokenSpread1, usage: {} }) // attempt 2 (retry)
    .mockResolvedValueOnce({ json: brokenSpread3, usage: {} }); // repair

  await expect(generateStory({
    bookId: 'farm_2_3_hello_farm', profile: PROFILE, sessionId: 'sess_polish', requestId: REQUEST_ID,
  })).rejects.toMatchObject({
    validationErrors: expect.arrayContaining([expect.stringMatching(/^spread 3: /)]),
  });
  expect(callText).toHaveBeenCalledTimes(3);
});

test('a repair that touches unimplicated spreads is rejected even when it validates', async () => {
  const request = pinnedRequest(null);
  // 40 words: violates the per-spread max (32 at age 2) WITHOUT tripping the
  // total bound — so ONLY spread 1 is implicated, not the whole story.
  const broken = validResponse(request);
  broken.spreads[0].text = 'the small hen walks '.repeat(10).trim();
  const overreach = validResponse(request, 'golden'); // valid, but EVERY spread differs
  callText
    .mockResolvedValueOnce({ json: broken, usage: {} })
    .mockResolvedValueOnce({ json: broken, usage: {} })
    .mockResolvedValueOnce({ json: overreach, usage: {} });

  await expect(generateStory({
    bookId: 'farm_2_3_hello_farm', profile: PROFILE, sessionId: 'sess_polish', requestId: REQUEST_ID,
  })).rejects.toMatchObject({
    validationErrors: expect.arrayContaining([expect.stringMatching(/unimplicated spreads must stay verbatim/)]),
  });
});

test('a failed polish CALL keeps the draft instead of failing the story', async () => {
  const tuning = normalizeTuning(TUNING);
  const request = pinnedRequest(tuning);
  callText
    .mockResolvedValueOnce({ json: validResponse(request, 'sunny'), usage: { inputTokens: 10, outputTokens: 20 } })
    .mockRejectedValueOnce(new Error('rate limited'));

  const result = await generateStory({
    bookId: 'farm_2_3_hello_farm', profile: PROFILE, sessionId: 'sess_polish', requestId: REQUEST_ID, tuning: TUNING,
  });
  expect(result.polished).toBeUndefined();
  expect(result.response.spreads[0].text).toContain('sunny');
});
