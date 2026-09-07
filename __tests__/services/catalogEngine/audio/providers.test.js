/**
 * Narrator providers (ab-1 §4.3): the registry (default, unknown, the
 * kill-switch env), credentials from env or the request body, ElevenLabs'
 * closed tag composition (tag only when the direction changes, none on
 * the plain rung), per-line timings from the character alignment, the
 * synthesize transport for each adapter with `fetch` mocked (headers,
 * body fields, PCM → WAV, error classification), Gemini's and OpenAI's
 * composed prompts never containing anything but the text + the closed
 * direction words.
 */

const registry = require('../../../../services/catalogEngine/audio/providers');
const eleven = require('../../../../services/catalogEngine/audio/providers/elevenlabs');
const gemini = require('../../../../services/catalogEngine/audio/providers/gemini');
const openai = require('../../../../services/catalogEngine/audio/providers/openai');
const { parseWav } = require('../../../../services/catalogEngine/audio/wav');

const lines = [
  { text: 'Emma looked around.', direction: { emotion: 'wonder', intensity: 'soft', pace: 'even', shape: 'statement' }, isRefrain: false },
  { text: 'What a farm!', direction: { emotion: 'wonder', intensity: 'soft', pace: 'even', shape: 'exclaim' }, isRefrain: false },
  { text: 'Hello, farm! Here we are!', direction: { emotion: 'joy', intensity: 'clear', pace: 'even', shape: 'exclaim' }, isRefrain: true },
];
const pcmBase64 = () => { const b = Buffer.alloc(4410 * 2); for (let i = 0; i < 4410; i++) b.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2); return b.toString('base64'); };
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; delete process.env.CATALOG_AUDIO_NARRATOR_PROVIDER; delete process.env.ELEVENLABS_API_KEY; });

describe('registry + credentials', () => {
  test('defaults to elevenlabs; the env picks; unknown is refused', () => {
    expect(registry.resolveNarratorProvider().provider).toBe('elevenlabs');
    process.env.CATALOG_AUDIO_NARRATOR_PROVIDER = 'openai';
    expect(registry.resolveNarratorProvider().adapter.name).toBe('openai');
    expect(registry.resolveNarratorProvider({ provider: 'gemini' }).adapter.name).toBe('gemini');
    expect(registry.resolveNarratorProvider({ provider: 'polly' }).ok).toBe(false);
  });
  test('credentials: env first, then the request-injected copy', () => {
    expect(registry.providerCredentials('elevenlabs', { ELEVENLABS_API_KEY: 'body-key' }).apiKey).toBe('body-key');
    process.env.ELEVENLABS_API_KEY = 'env-key';
    expect(registry.providerCredentials('elevenlabs', { ELEVENLABS_API_KEY: 'body-key' }).apiKey).toBe('env-key');
    expect(registry.providerCredentials('openai', { apiKeys: { OPENAI_API_KEY: 'o' } }).apiKey).toBe(process.env.OPENAI_API_KEY || 'o');
    expect(registry.providerCredentials('gemini', {}).apiKey).toBeNull();
  });
  test('providerError classifies statuses', () => {
    expect(registry.providerError('x', 401, 'no').failureCode).toBe('audiobook_provider_unavailable');
    expect(registry.providerError('x', 422, 'bad').failureCode).toBe('audiobook_provider_input_rejected');
    expect(registry.providerError('x', 503, 'later').transient).toBe(true);
  });
});

describe('elevenlabs', () => {
  test('composeText tags a line only when the direction changes; the refrain gets its tag; plain has none', () => {
    const { text, spans } = eleven.composeText(lines);
    expect(text).toBe('[amazed] [softly] Emma looked around.\n\nWhat a farm!\n\n[warmly] Hello, farm! Here we are!');
    expect(spans).toHaveLength(3);
    expect(text.slice(spans[0].start, spans[0].end)).toBe('Emma looked around.');
    expect(text.slice(spans[2].start, spans[2].end)).toBe('Hello, farm! Here we are!');
    expect(eleven.composeText(lines, 'plain').text).toBe('Emma looked around.\n\nWhat a farm!\n\nHello, farm! Here we are!');
  });
  test('lineTimings maps character times onto the lines; fails open', () => {
    const { text, spans } = eleven.composeText(lines, 'plain');
    const chars = text.split('');
    const alignment = { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.05), character_end_times_seconds: chars.map((_, i) => i * 0.05 + 0.05) };
    const t = eleven.lineTimings(alignment, text, spans);
    expect(t).toHaveLength(3);
    expect(t[0].start).toBe(0);
    expect(t[1].start).toBeGreaterThan(t[0].end);
    expect(eleven.lineTimings(null, text, spans)).toBeNull();
  });
  test('synthesize posts to with-timestamps with the pinned settings and returns a WAV', async () => {
    let captured;
    global.fetch = jest.fn(async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200, json: async () => ({ audio_base64: pcmBase64(), alignment: null }) }; });
    const r = await eleven.synthesize({ lines, rung: 'full', voice: { voiceId: 'V1', model: 'eleven_v3', settings: { stability: 0.5 } }, language: 'en', seed: 42, credentials: { apiKey: 'k' }, pace: 'slow' });
    expect(captured.url).toMatch(/text-to-speech\/V1\/with-timestamps\?output_format=pcm_44100/);
    expect(captured.opts.headers['xi-api-key']).toBe('k');
    const body = JSON.parse(captured.opts.body);
    expect(body.model_id).toBe('eleven_v3');
    expect(body.seed).toBe(42);
    expect(body.voice_settings.speed).toBe(0.9);
    expect(body.language_code).toBe('en');
    expect(body.text).toMatch(/^\[amazed\]/);
    const parsed = parseWav(r.wav);
    expect(parsed.sampleRate).toBe(44100);
    expect(parsed.samples.length).toBe(4410);
    expect(r.characters).toBe(body.text.length);
  });
  test('an alias rides as a pronunciation dictionary; a 401 is provider_unavailable; no key is refused before any call', async () => {
    const calls = [];
    global.fetch = jest.fn(async (url, opts) => {
      calls.push(url);
      if (/add-from-rules/.test(url)) return { ok: true, status: 200, json: async () => ({ id: 'dict1', version_id: 'v1' }) };
      return { ok: true, status: 200, json: async () => ({ audio_base64: pcmBase64() }) };
    });
    await eleven.synthesize({ lines, voice: { voiceId: 'V1' }, aliases: [{ name: 'Sarah', alias: 'Sair-uh' }], credentials: { apiKey: 'k' } });
    expect(calls.some(u => /add-from-rules/.test(u))).toBe(true);
    const body = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(body.pronunciation_dictionary_locators).toEqual([{ pronunciation_dictionary_id: 'dict1', version_id: 'v1' }]);
    global.fetch = jest.fn(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }));
    await expect(eleven.synthesize({ lines, voice: { voiceId: 'V1' }, credentials: { apiKey: 'k' } })).rejects.toMatchObject({ failureCode: 'audiobook_provider_unavailable' });
    global.fetch = jest.fn();
    await expect(eleven.synthesize({ lines, voice: { voiceId: 'V1' }, credentials: { apiKey: null } })).rejects.toMatchObject({ failureCode: 'audiobook_provider_unavailable' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('gemini + openai', () => {
  test('gemini composes a style prefix + the text; plain reads only the text; the PCM is wrapped', async () => {
    const { text } = gemini.composeText(lines, 'full', { directionWords: 'hushed, slow', paceWords: 'an easy pace', language: 'en' });
    expect(text).toMatch(/hushed, slow; an easy pace/);
    expect(text).toMatch(/Emma looked around\.\nWhat a farm!/);
    expect(gemini.composeText(lines, 'plain', {}).text).toMatch(/^Read this English/);
    global.fetch = jest.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      expect(body.generationConfig.responseModalities).toEqual(['AUDIO']);
      expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcmBase64() } }] } }] }) };
    });
    const r = await gemini.synthesize({ lines, directionWords: 'x', paceWords: 'y', voice: { voice: 'Kore', model: 'gemini-2.5-pro-preview-tts' }, credentials: { apiKey: 'g' } });
    expect(parseWav(r.wav).sampleRate).toBe(24000);
    expect(r.model).toBe('gemini-2.5-pro-preview-tts');
  });
  test('openai sends instructions apart from the input and returns the WAV bytes', async () => {
    const { text, instructions } = openai.composeText(lines, 'full', { directionWords: 'bright and happy', paceWords: 'a lively pace', tuning: 'Smile more.' });
    expect(text).toBe('Emma looked around.\nWhat a farm!\nHello, farm! Here we are!');
    expect(instructions).toMatch(/bright and happy/);
    expect(instructions).toMatch(/Smile more/);
    const wavBytes = Buffer.alloc(200);
    global.fetch = jest.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      expect(body.response_format).toBe('wav');
      expect(body.voice).toBe('nova');
      expect(body.speed).toBe(1.06);
      return { ok: true, status: 200, arrayBuffer: async () => wavBytes };
    });
    const r = await openai.synthesize({ lines, directionWords: 'x', paceWords: 'y', voice: { voice: 'nova' }, credentials: { apiKey: 'o' }, pace: 'brisk' });
    expect(r.wav.length).toBe(200);
    expect(r.sampleRate).toBe(24000);
  });
});
