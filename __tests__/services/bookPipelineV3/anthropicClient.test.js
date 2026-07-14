const { callClaude, ANTHROPIC_URL } = require('../../../services/bookPipelineV3/llm/anthropicClient');
const { LlmAuthError } = require('../../../services/shared/llm/openaiClient');

function anthropicResponse({ text = 'hello', stopReason = 'end_turn', inputTokens = 100, outputTokens = 50 } = {}) {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text }],
      stop_reason: stopReason,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
  };
}

describe('anthropicClient.callClaude', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  let fetchMock;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterAll(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  const base = { model: 'claude-opus-4-8', systemPrompt: 'sys', userPrompt: 'user', label: 'test' };

  test('happy path returns text + usage and hits the Messages API with required headers', async () => {
    fetchMock.mockResolvedValueOnce(anthropicResponse({ text: 'ok!' }));
    const res = await callClaude(base);
    expect(res.text).toBe('ok!');
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(res.finishReason).toBe('stop');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ANTHROPIC_URL);
    expect(init.headers['x-api-key']).toBe('test-key');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
  });

  test('never sends temperature or top_p (rejected by claude-opus-4-8)', async () => {
    fetchMock.mockResolvedValueOnce(anthropicResponse());
    await callClaude({ ...base, temperature: 0.9, top_p: 0.5 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  test('missing key throws LlmAuthError without calling fetch', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(callClaude(base)).rejects.toThrow(LlmAuthError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('429 is retried then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
      .mockResolvedValueOnce(anthropicResponse({ text: 'second try' }));
    const res = await callClaude(base);
    expect(res.text).toBe('second try');
    expect(res.attempts).toBe(2);
  });

  test('max_tokens stop reason bumps the budget and retries', async () => {
    fetchMock
      .mockResolvedValueOnce(anthropicResponse({ stopReason: 'max_tokens', text: 'trunc' }))
      .mockResolvedValueOnce(anthropicResponse({ text: 'full' }));
    const res = await callClaude({ ...base, maxTokens: 1000 });
    expect(res.text).toBe('full');
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.max_tokens).toBe(2000);
  });

  test('refusal is a non-transient error', async () => {
    fetchMock.mockResolvedValueOnce(anthropicResponse({ stopReason: 'refusal' }));
    await expect(callClaude(base)).rejects.toThrow(/refused/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('jsonMode parses loose JSON and appends the JSON instruction', async () => {
    fetchMock.mockResolvedValueOnce(anthropicResponse({ text: '```json\n{"a": 1}\n```' }));
    const res = await callClaude({ ...base, jsonMode: true });
    expect(res.json).toEqual({ a: 1 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0].content).toContain('single valid JSON object');
  });
});
