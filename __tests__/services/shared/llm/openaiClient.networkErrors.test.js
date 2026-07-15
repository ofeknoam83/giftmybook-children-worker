/**
 * Network-level fetch failures must classify as TRANSIENT.
 *
 * They carry no HTTP status (the socket died before/while the body
 * streamed), so the status-based classification never sees them. Before
 * this fix, undici's bare "terminated" — a dropped connection mid-body —
 * was treated as non-transient and failed the whole activity on one
 * network blip (live incident 2026-07-15: DeepSeek closed a 50s v3.editor
 * call mid-body; the book died instead of retrying).
 */
const { isNetworkError, callText } = require('../../../../services/shared/llm/openaiClient');

describe('isNetworkError', () => {
  test('classifies undici/network failure shapes as network errors', () => {
    expect(isNetworkError(new TypeError('terminated'))).toBe(true);
    expect(isNetworkError(new TypeError('fetch failed'))).toBe(true);
    expect(isNetworkError(new Error('socket hang up'))).toBe(true);
    expect(isNetworkError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }))).toBe(true);
    expect(isNetworkError(new Error('other side closed: connection reset'))).toBe(true);
  });

  test('does NOT classify model/content errors as network errors', () => {
    expect(isNetworkError(new Error('v3.editor HTTP 400: invalid request'))).toBe(false);
    expect(isNetworkError(new Error('Empty response from model'))).toBe(false);
    expect(isNetworkError(new Error('JSON parse failed'))).toBe(false);
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });
});

describe('callText retries a dropped connection', () => {
  const origFetch = global.fetch;
  const origKey = process.env.DEEPSEEK_API_KEY;

  beforeAll(() => { process.env.DEEPSEEK_API_KEY = 'test-key'; });
  afterAll(() => {
    global.fetch = origFetch;
    if (origKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = origKey;
  });

  test('"terminated" mid-call retries and succeeds on the next attempt', async () => {
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls++;
      if (calls === 1) throw new TypeError('terminated');
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      };
    });

    const out = await callText({
      model: 'deepseek-v4-pro',
      systemPrompt: 's',
      userPrompt: 'u',
      jsonMode: true,
      maxTokens: 100,
      label: 'test.networkRetry',
      allowGeminiFallback: false,
    });

    expect(calls).toBe(2);
    expect(out.json).toEqual({ ok: true });
    expect(out.attempts).toBe(2);
  });
});
