/**
 * visionClient (W4): family dispatch, wire shapes, transient retry, and
 * the loud failure for roles routed to non-vision families.
 */

jest.mock('../../../services/shared/llm/openaiClient', () => {
  const actual = jest.requireActual('../../../services/shared/llm/openaiClient');
  return { ...actual, fetchWithTimeout: jest.fn() };
});

const { fetchWithTimeout } = require('../../../services/shared/llm/openaiClient');
const { callVisionRole, _resetOpenAiVisionFallback } = require('../../../services/bookPipelineV3/llm/visionClient');

const IMG = { base64: 'abc', mimeType: 'image/png' };

function geminiResponse(text) {
  return {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }),
  };
}

/** Responses API shape (the primary OpenAI vision path since 2026-07-17). */
function openaiResponsesReply(text) {
  return {
    ok: true,
    json: async () => ({
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 7, output_tokens: 3 },
    }),
  };
}

/** Legacy chat/completions shape (fallback only). */
function openaiChatReply(text) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetOpenAiVisionFallback();
  process.env.GEMINI_API_KEY = 'gk';
  process.env.OPENAI_API_KEY = 'ok';
  delete process.env.BOOK_PIPELINE_V3_QA_VISION_FAMILY;
  delete process.env.BOOK_PIPELINE_V3_LIKENESS_JUDGE_B_FAMILY;
});

test('gemini role builds inline_data parts', async () => {
  fetchWithTimeout.mockResolvedValueOnce(geminiResponse('{"x":1}'));
  const res = await callVisionRole('QA_VISION', { prompt: 'judge', images: [IMG], expectJson: true });
  expect(res.family).toBe('gemini');
  expect(res.json).toEqual({ x: 1 });
  const [url, opts] = fetchWithTimeout.mock.calls[0];
  expect(url).toContain('generativelanguage.googleapis.com');
  expect(url).toContain('gemini-2.5-flash');
  const body = JSON.parse(opts.body);
  expect(body.contents[0].parts[0].text).toBe('judge');
  expect(body.contents[0].parts[1].inline_data).toEqual({ mime_type: 'image/png', data: 'abc' });
});

// 2026-07-17: OpenAI stopped accepting chat/completions image_url parts for
// gpt-5.x ("image_url is only supported by certain models") — every likeness
// judgment 400'd and identity kits dead-ended. The openai vision path is now
// the Responses API with input_text/input_image content items.
test('openai role calls the Responses API with input_text/input_image items', async () => {
  fetchWithTimeout.mockResolvedValueOnce(openaiResponsesReply('verdict'));
  const res = await callVisionRole('LIKENESS_JUDGE_B', { prompt: 'compare', images: [IMG] });
  expect(res.family).toBe('openai');
  expect(res.text).toBe('verdict');
  expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  const [url, opts] = fetchWithTimeout.mock.calls[0];
  expect(url).toBe('https://api.openai.com/v1/responses');
  const body = JSON.parse(opts.body);
  expect(body.model).toBe('gpt-5.4');
  expect(body.input[0].content[0]).toEqual({ type: 'input_text', text: 'compare' });
  expect(body.input[0].content[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,abc' });
});

test('openai output_text shorthand is parsed too', async () => {
  fetchWithTimeout.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ output_text: 'shorthand verdict', usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  const res = await callVisionRole('LIKENESS_JUDGE_B', { prompt: 'compare', images: [IMG] });
  expect(res.text).toBe('shorthand verdict');
});

test('a 404 on /v1/responses falls back LOUDLY to legacy chat/completions and memoizes', async () => {
  fetchWithTimeout
    .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'unknown endpoint' })
    .mockResolvedValueOnce(openaiChatReply('legacy verdict'))
    .mockResolvedValueOnce(openaiChatReply('legacy verdict 2'));

  const res1 = await callVisionRole('LIKENESS_JUDGE_B', { prompt: 'compare', images: [IMG] });
  expect(res1.text).toBe('legacy verdict');
  expect(fetchWithTimeout.mock.calls[1][0]).toBe('https://api.openai.com/v1/chat/completions');
  const legacyBody = JSON.parse(fetchWithTimeout.mock.calls[1][1].body);
  expect(legacyBody.messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } });

  // memoized: the next call skips /v1/responses entirely
  const res2 = await callVisionRole('LIKENESS_JUDGE_B', { prompt: 'compare', images: [IMG] });
  expect(res2.text).toBe('legacy verdict 2');
  expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
  expect(fetchWithTimeout.mock.calls[2][0]).toBe('https://api.openai.com/v1/chat/completions');
});

test('a non-404 openai error still fails loudly (no silent fallback)', async () => {
  fetchWithTimeout.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' });
  await expect(callVisionRole('LIKENESS_JUDGE_B', { prompt: 'compare', images: [IMG] }))
    .rejects.toThrow(/openai vision 400/);
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
});

test('transient 503 retries then succeeds', async () => {
  fetchWithTimeout
    .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'UNAVAILABLE' })
    .mockResolvedValueOnce(geminiResponse('ok'));
  const res = await callVisionRole('QA_VISION', { prompt: 'p', images: [IMG] });
  expect(res.text).toBe('ok');
  expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
}, 15000);

test('non-vision family override fails loudly', async () => {
  process.env.BOOK_PIPELINE_V3_QA_VISION_FAMILY = 'deepseek';
  await expect(callVisionRole('QA_VISION', { prompt: 'p', images: [IMG] }))
    .rejects.toThrow(/no vision support/);
  expect(fetchWithTimeout).not.toHaveBeenCalled();
});
