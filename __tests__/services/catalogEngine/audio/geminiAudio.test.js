/**
 * geminiAudio (the ab-1 audio judge transport; 2026-09-16 migration): the
 * call targets the registry's CATALOG_AUDIO_STT_MODEL, sends the ONE
 * strict-JSON generationConfig (thinking level MINIMAL on the 3.x family),
 * and retries ONCE without `thinkingConfig` when the model rejects the
 * field — the same audio and prompt on the retry, never a second retry.
 */

jest.mock('../../../../services/illustrationGenerator', () => ({ getNextApiKey: jest.fn(() => 'test-key'), fetchWithTimeout: jest.fn() }));

const { fetchWithTimeout } = require('../../../../services/illustrationGenerator');
const { judgeAudio } = require('../../../../services/catalogEngine/audio/geminiAudio');
const { audioModel } = require('../../../../services/shared/llm/models');

const ok = json => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }) });
const audio = [{ buffer: Buffer.from('RIFF....WAVE'), mimeType: 'audio/wav' }];
let warnSpy;
beforeEach(() => {
  fetchWithTimeout.mockReset();
  delete process.env.CATALOG_AUDIO_STT_MODEL;
  delete process.env.CATALOG_QA_THINKING_LEVEL;
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

test('targets the registry audio model with the strict-JSON config at thinking level MINIMAL and bills the tokens', async () => {
  fetchWithTimeout.mockResolvedValue(ok({ transcript: 'hi' }));
  const costTracker = { addTextUsage: jest.fn() };
  const r = await judgeAudio({ prompt: 'Transcribe.', audio, schema: { type: 'object' }, costTracker });
  expect(audioModel()).toBe('gemini-3.5-flash');
  expect(r).toEqual({ json: { transcript: 'hi' }, model: audioModel(), usage: { promptTokens: 10, candidateTokens: 5 } });
  const [url, init] = fetchWithTimeout.mock.calls[0];
  expect(url).toContain(`/${audioModel()}:generateContent?key=test-key`);
  const body = JSON.parse(init.body);
  expect(body.generationConfig).toEqual({ temperature: 0, maxOutputTokens: 2048, responseMimeType: 'application/json', responseSchema: { type: 'object' }, thinkingConfig: { thinkingLevel: 'MINIMAL' } });
  expect(body.contents[0].parts[0].inline_data.mime_type).toBe('audio/wav');
  expect(body.contents[0].parts[1].text).toBe('Transcribe.');
  expect(costTracker.addTextUsage).toHaveBeenCalledWith(audioModel(), 10, 5);
});

test('CATALOG_AUDIO_STT_MODEL overrides the model per call and an explicit model wins over both', async () => {
  fetchWithTimeout.mockResolvedValue(ok({ transcript: 'hi' }));
  process.env.CATALOG_AUDIO_STT_MODEL = ' gemini-audio-pinned ';
  expect((await judgeAudio({ prompt: 'x' })).model).toBe('gemini-audio-pinned');
  expect(fetchWithTimeout.mock.calls[0][0]).toContain('/gemini-audio-pinned:generateContent');
  expect((await judgeAudio({ prompt: 'x', model: 'gemini-2.0-flash' })).model).toBe('gemini-2.0-flash');
  // A model outside the thinking families sends no thinkingConfig.
  expect(JSON.parse(fetchWithTimeout.mock.calls[1][1].body).generationConfig.thinkingConfig).toBeUndefined();
});

test('a 400 naming the thinking field is retried ONCE without thinkingConfig; the same audio and prompt ride the retry', async () => {
  fetchWithTimeout
    .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Invalid JSON payload received. Unknown name "thinking_level" at generation_config.thinking_config' })
    .mockResolvedValue(ok({ transcript: 'hi' }));
  const r = await judgeAudio({ prompt: 'Transcribe.', audio });
  expect(r.json).toEqual({ transcript: 'hi' });
  expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  const first = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
  const second = JSON.parse(fetchWithTimeout.mock.calls[1][1].body);
  expect(first.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
  expect(second.generationConfig.thinkingConfig).toBeUndefined();
  expect(second.generationConfig).toEqual({ temperature: 0, maxOutputTokens: 2048, responseMimeType: 'application/json' });
  expect(second.contents).toEqual(first.contents);
  expect(fetchWithTimeout.mock.calls[1][0]).toBe(fetchWithTimeout.mock.calls[0][0]);
  expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/rejected generationConfig.thinkingConfig/);
});

test('any other failure throws once with its status, and a second thinking rejection is never retried again', async () => {
  fetchWithTimeout.mockResolvedValue({ ok: false, status: 503, text: async () => 'busy' });
  await expect(judgeAudio({ prompt: 'x' })).rejects.toMatchObject({ statusCode: 503, message: 'audio judge HTTP 503: busy' });
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  fetchWithTimeout.mockReset();
  fetchWithTimeout.mockResolvedValue({ ok: false, status: 400, text: async () => 'thinkingLevel is not supported by this model' });
  await expect(judgeAudio({ prompt: 'x' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('thinkingLevel is not supported') });
  expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  fetchWithTimeout.mockReset();
  // A 400 that names another field is not a thinking rejection.
  fetchWithTimeout.mockResolvedValue({ ok: false, status: 400, text: async () => 'Unknown name "image_size"' });
  await expect(judgeAudio({ prompt: 'x' })).rejects.toMatchObject({ statusCode: 400 });
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
});
