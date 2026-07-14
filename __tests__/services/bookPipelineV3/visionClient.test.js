/**
 * visionClient (W4): family dispatch, wire shapes, transient retry, and
 * the loud failure for roles routed to non-vision families.
 */

jest.mock('../../../services/shared/llm/openaiClient', () => {
  const actual = jest.requireActual('../../../services/shared/llm/openaiClient');
  return { ...actual, fetchWithTimeout: jest.fn() };
});

const { fetchWithTimeout } = require('../../../services/shared/llm/openaiClient');
const { callVisionRole } = require('../../../services/bookPipelineV3/llm/visionClient');

const IMG = { base64: 'abc', mimeType: 'image/png' };

function geminiResponse(text) {
  return {
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }),
  };
}

function openaiResponse(text) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
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

test('openai role builds image_url data URIs', async () => {
  fetchWithTimeout.mockResolvedValueOnce(openaiResponse('verdict'));
  const res = await callVisionRole('LIKENESS_JUDGE_B', { prompt: 'compare', images: [IMG] });
  expect(res.family).toBe('openai');
  expect(res.text).toBe('verdict');
  const [url, opts] = fetchWithTimeout.mock.calls[0];
  expect(url).toContain('api.openai.com');
  const body = JSON.parse(opts.body);
  expect(body.model).toBe('gpt-5.4');
  expect(body.messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } });
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
