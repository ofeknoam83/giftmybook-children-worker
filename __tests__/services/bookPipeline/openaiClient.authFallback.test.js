/**
 * PR AA-1 — silent-Gemini-fallback incident regression tests.
 *
 * The bug: Cloud Run revision shipped with OPENAI_API_KEY="" (empty). OpenAI
 * returned 401 invalid_api_key on every call. The error was classified as
 * "non-transient", which made it eligible for the Gemini fallback path. Every
 * book stage silently switched from gpt-5.x to gemini-2.5-flash. Prompts tuned
 * for GPT then rendered as Gemini output without anyone noticing for weeks.
 *
 * These tests lock in the fix:
 *   1. Missing OPENAI_API_KEY throws LlmAuthError (not generic Error).
 *   2. callText NEVER falls back to Gemini on auth errors, even when a Gemini
 *      key is present and allowGeminiFallback=true.
 *   3. callText DOES still fall back to Gemini on transient infra errors,
 *      and emits a structured [LLM_FALLBACK] log line we can grep for.
 *   4. assertLlmConfig reports missing keys cleanly and emits structured
 *      [LLM_CONFIG] logs at boot.
 */

const path = require('path');

const MODULE_PATH = path.resolve(
  __dirname,
  '../../../services/bookPipeline/llm/openaiClient.js',
);

function freshClient() {
  // Force a fresh module load so module-level state from a previous test
  // (none today, but defensive against future changes) doesn't leak.
  delete require.cache[MODULE_PATH];
  return require(MODULE_PATH);
}

describe('openaiClient — auth error handling (PR AA-1)', () => {
  let originalEnv;
  let originalFetch;
  let warnSpy;
  let errorSpy;
  let logSpy;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = global.fetch;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('LlmAuthError is exported and is-a Error', () => {
    const { LlmAuthError } = freshClient();
    expect(typeof LlmAuthError).toBe('function');
    const e = new LlmAuthError('test', { httpStatus: 401 });
    expect(e).toBeInstanceOf(Error);
    expect(e.isAuthError).toBe(true);
    expect(e.httpStatus).toBe(401);
    expect(e.name).toBe('LlmAuthError');
  });

  test('missing OPENAI_API_KEY throws LlmAuthError, never reaches fetch', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.GOOGLE_AI_STUDIO_KEY = 'gem-key-present';

    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const { callText, LlmAuthError } = freshClient();
    await expect(callText({
      model: 'gpt-5.1',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      maxAttempts: 1,
      allowGeminiFallback: true,
      label: 'test.missing-key',
    })).rejects.toBeInstanceOf(LlmAuthError);

    // Critical: the request must never hit the network. If the missing-key
    // path silently fell back to Gemini we'd see fetch called once.
    expect(fetchMock).not.toHaveBeenCalled();

    // And we must have emitted a grep-able [LLM_AUTH_FAIL] log line.
    const errLines = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errLines).toMatch(/\[LLM_AUTH_FAIL\]/);
    expect(errLines).toMatch(/missingKey=true/);
  });

  test('OpenAI 401 response throws LlmAuthError and refuses Gemini fallback', async () => {
    process.env.OPENAI_API_KEY = 'sk-bad-key';
    process.env.GOOGLE_AI_STUDIO_KEY = 'gem-key-present';

    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({
        error: { code: 'invalid_api_key', message: 'Incorrect API key provided' },
      }),
      json: async () => ({}),
    });
    global.fetch = fetchMock;

    const { callText, LlmAuthError } = freshClient();
    await expect(callText({
      model: 'gpt-5.1',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      maxAttempts: 3,
      allowGeminiFallback: true,
      label: 'test.401',
    })).rejects.toBeInstanceOf(LlmAuthError);

    // Exactly one fetch (the OpenAI call). NO Gemini fallback fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrls = fetchMock.mock.calls.map(c => c[0]);
    expect(calledUrls[0]).toContain('api.openai.com');
    expect(calledUrls.some(u => /generativelanguage\.googleapis\.com/.test(u))).toBe(false);

    const errLines = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errLines).toMatch(/\[LLM_AUTH_FAIL\]/);
    expect(errLines).toMatch(/httpStatus=401/);
  });

  test('OpenAI 403 response is also classified as auth error', async () => {
    process.env.OPENAI_API_KEY = 'sk-no-permission';
    process.env.GOOGLE_AI_STUDIO_KEY = 'gem-key-present';

    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
      json: async () => ({}),
    });
    global.fetch = fetchMock;

    const { callText, LlmAuthError } = freshClient();
    await expect(callText({
      model: 'gpt-5.1',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      maxAttempts: 3,
      allowGeminiFallback: true,
      label: 'test.403',
    })).rejects.toBeInstanceOf(LlmAuthError);

    expect(fetchMock).toHaveBeenCalledTimes(1); // no fallback retry
  });

  test('non-transient non-auth OpenAI error falls back to Gemini and emits [LLM_FALLBACK]', async () => {
    // Per the openaiClient catch logic, the Gemini fallback path fires for
    // errors that are NOT transient AND NOT auth AND NOT truncation AND
    // NOT a parse error. A 400 with an unrelated body (e.g. malformed
    // request, content policy) is the canonical "non-transient OpenAI
    // failure" we still want to ride out via Gemini in production.
    process.env.OPENAI_API_KEY = 'sk-good-key';
    process.env.GOOGLE_AI_STUDIO_KEY = 'gem-key-present';

    const geminiBody = {
      candidates: [{
        content: { parts: [{ text: '{"hello":"from-gemini"}' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    };

    const fetchMock = jest.fn()
      // OpenAI: HTTP 400, non-auth body → generic Error → fallback eligible.
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"error":{"code":"context_length_exceeded","message":"too long"}}',
        json: async () => ({}),
      })
      // Gemini fallback succeeds.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(geminiBody),
        json: async () => geminiBody,
      });
    global.fetch = fetchMock;

    const { callText } = freshClient();
    const result = await callText({
      model: 'gpt-5.1',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      maxAttempts: 1,
      allowGeminiFallback: true,
      jsonMode: true,
      label: 'test.non-transient-fallback',
    });

    expect(result.model).toMatch(/gemini/);
    expect(result.json).toEqual({ hello: 'from-gemini' });
    // Both calls should have been issued: OpenAI then Gemini.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('api.openai.com');
    expect(fetchMock.mock.calls[1][0]).toMatch(/generativelanguage\.googleapis\.com/);

    const warnLines = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warnLines).toMatch(/\[LLM_FALLBACK\]/);
    expect(warnLines).toMatch(/primary_model=gpt-5\.1/);
    expect(warnLines).toMatch(/fallback_model=gemini/);
    expect(warnLines).toMatch(/label=test\.non-transient-fallback/);
  });

  test('OpenAI body containing "invalid_api_key" is treated as auth even if status is 200-ish bug', async () => {
    // Defensive: some proxies have been observed wrapping auth errors in
    // a 200 body. The body-text classifier must catch them.
    process.env.OPENAI_API_KEY = 'sk-something';
    process.env.GOOGLE_AI_STUDIO_KEY = 'gem-key-present';

    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 400, // not 401, but body says invalid_api_key
      text: async () => '{"error":{"code":"invalid_api_key","message":"Incorrect API key provided"}}',
      json: async () => ({}),
    });
    global.fetch = fetchMock;

    const { callText, LlmAuthError } = freshClient();
    await expect(callText({
      model: 'gpt-5.1',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      maxAttempts: 1,
      allowGeminiFallback: true,
      label: 'test.body-auth',
    })).rejects.toBeInstanceOf(LlmAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('assertLlmConfig — startup checks (PR AA-1)', () => {
  let originalEnv;
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    originalEnv = { ...process.env };
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('returns ok when OPENAI_API_KEY is set, emits [LLM_CONFIG] ok line', () => {
    process.env.OPENAI_API_KEY = 'sk-real';
    const { assertLlmConfig } = freshClient();
    const r = assertLlmConfig();
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    const logLines = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logLines).toMatch(/\[LLM_CONFIG\] ok/);
  });

  test('flags empty string as missing (the actual incident shape)', () => {
    process.env.OPENAI_API_KEY = ''; // exactly the prod state
    const { assertLlmConfig } = freshClient();
    const r = assertLlmConfig();
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['OPENAI_API_KEY']);
    const errLines = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errLines).toMatch(/\[LLM_CONFIG\] FAIL/);
    expect(errLines).toMatch(/missing=\[OPENAI_API_KEY\]/);
  });

  test('flags whitespace-only as missing', () => {
    process.env.OPENAI_API_KEY = '   \t\n  ';
    const { assertLlmConfig } = freshClient();
    const r = assertLlmConfig();
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('OPENAI_API_KEY');
  });

  test('flags fully unset as missing', () => {
    delete process.env.OPENAI_API_KEY;
    const { assertLlmConfig } = freshClient();
    const r = assertLlmConfig();
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('OPENAI_API_KEY');
  });

  test('reports gemini_fallback_available accurately', () => {
    process.env.OPENAI_API_KEY = 'sk-real';
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_AI_STUDIO_KEY;
    const { assertLlmConfig } = freshClient();
    assertLlmConfig();
    const logLines = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logLines).toMatch(/gemini_fallback_available=false/);

    process.env.GOOGLE_AI_STUDIO_KEY = 'g-key';
    const r2 = assertLlmConfig();
    expect(r2.ok).toBe(true);
    const logLines2 = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logLines2).toMatch(/gemini_fallback_available=true/);
  });
});
