/**
 * Providers (gv-1): the model profile (durations, input rendering, env
 * overrides, elements switch), the registry (allowed providers, defaults,
 * bad pairs), and the Replicate adapter over a mocked fetch (submit → poll
 * → download, filtered vs failed, rejected input, missing token).
 */

jest.mock('../../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(), uploadBuffer: jest.fn(), uploadBufferIfAbsent: jest.fn(), getSignedUrl: jest.fn(), deletePrefix: jest.fn(), saveJson: jest.fn(), loadJson: jest.fn(), objectExists: jest.fn(),
}));
jest.mock('../../../../services/illustrationGenerator', () => ({
  fetchWithTimeout: jest.fn(), getNextApiKey: jest.fn(() => 'k'), downloadPhotoAsBase64: jest.fn(), isModestBathWaterScene: jest.fn(() => false),
}));

const { modelProfile, clipSecondsFor, KLING_DURATIONS } = require('../../../../services/catalogEngine/video/providers/models');
const { resolveProvider, allowedProviders } = require('../../../../services/catalogEngine/video/providers');
const replicate = require('../../../../services/catalogEngine/video/providers/replicate');
const { buildClipBrief } = require('../../../../services/catalogEngine/video/brief');

const brief = buildClipBrief({ segment: { kind: 'spread', spread: 1, motion: 'push-in', seconds: 3 }, name: 'Emma', beat: 'Child waves.', companion: null, emotion: null, propValues: [], references: [{ kind: 'character' }] });
const job = { brief, startFrameUrl: 'https://s/f.jpg', referenceUrls: [{ kind: 'character', urls: ['https://s/c.jpg', 'https://s/sheet.png'] }], seconds: 4, aspect: '16:9', seed: null };

describe('model profile', () => {
  afterEach(() => { delete process.env.CATALOG_VIDEO_MODEL_INPUT_JSON; });
  test('Kling 3.0 on Replicate: whole seconds from 3, elements from the references, audio off', () => {
    const p = modelProfile('kwaivgi/kling-v3-video');
    expect(p.provider).toBe('replicate');
    expect(clipSecondsFor(4, p.durations)).toBe(4);
    expect(clipSecondsFor(2, KLING_DURATIONS)).toBe(3);
    expect(clipSecondsFor(99, KLING_DURATIONS)).toBe(15);
    const input = p.input(job, { elements: true });
    expect(input.start_image).toBe('https://s/f.jpg');
    expect(input.duration).toBe(4);
    expect(input.generate_audio).toBe(false);
    expect(input.prompt).toContain('@Element1');
    expect(input.elements).toEqual([{ name: 'Element1', images: ['https://s/c.jpg', 'https://s/sheet.png'] }]);
    expect(input.negative_prompt).toBe(brief.negativePrompt);
  });
  test('elements off → no elements field and the prompt cites the first frame', () => {
    const input = modelProfile('kwaivgi/kling-v3-video').input(job, { elements: false });
    expect(input.elements).toBeUndefined();
    expect(input.prompt).toContain('the child of the first frame');
  });
  test('CATALOG_VIDEO_MODEL_INPUT_JSON adds, overrides and removes fields (never prototype keys)', () => {
    process.env.CATALOG_VIDEO_MODEL_INPUT_JSON = JSON.stringify({ mode: 'pro', cfg_scale: null, __proto__: { x: 1 }, constructor: 'no' });
    const input = modelProfile('kwaivgi/kling-v3-video').input(job, { elements: true });
    expect(input.mode).toBe('pro');
    expect('cfg_scale' in input).toBe(false);
    expect(input.constructor).not.toBe('no');
    expect(Object.prototype.hasOwnProperty.call(input, 'constructor')).toBe(false);
  });
  test('unknown models have no profile', () => {
    expect(modelProfile('someone/else')).toBeNull();
  });
});

describe('registry', () => {
  afterEach(() => { delete process.env.CATALOG_VIDEO_PROVIDERS; delete process.env.CATALOG_VIDEO_MODEL; });
  test('defaults to replicate + the flag model', () => {
    const r = resolveProvider({});
    expect(r.ok).toBe(true);
    expect([r.provider, r.model]).toEqual(['replicate', 'kwaivgi/kling-v3-video']);
    expect(typeof r.adapter.submit).toBe('function');
  });
  test('an unimplemented or disabled provider is refused, as is a mismatched model', () => {
    expect(resolveProvider({ provider: 'fal' }).error).toMatch(/not enabled/);
    process.env.CATALOG_VIDEO_PROVIDERS = 'fal';
    expect(allowedProviders()).toEqual([]);
    expect(resolveProvider({}).error).toMatch(/no video provider/);
    delete process.env.CATALOG_VIDEO_PROVIDERS;
    expect(resolveProvider({ model: 'someone/else' }).error).toMatch(/no profile/);
    expect(resolveProvider({ model: 'bad model id!' }).error).toMatch(/not a valid model id/);
  });
});

describe('replicate adapter', () => {
  let realFetch;
  beforeEach(() => { realFetch = global.fetch; process.env.REPLICATE_API_TOKEN = 'tok'; });
  afterEach(() => { global.fetch = realFetch; delete process.env.REPLICATE_API_TOKEN; });
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

  test('submit posts the model input with the bearer token and returns the poll URL', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(reply(201, { id: 'p1', status: 'starting', urls: { get: 'https://api.replicate.com/v1/predictions/p1' } }));
    const r = await replicate.submit({ model: 'kwaivgi/kling-v3-video', input: { prompt: 'x' } });
    expect(r).toEqual({ jobId: 'p1', pollUrl: 'https://api.replicate.com/v1/predictions/p1' });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.replicate.com/v1/models/kwaivgi/kling-v3-video/predictions');
    expect(opts.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(opts.body)).toEqual({ input: { prompt: 'x' } });
  });
  test('the request-injected token is the fallback; no token at all is video_provider_unavailable', async () => {
    delete process.env.REPLICATE_API_TOKEN;
    await expect(replicate.submit({ model: 'a/b', input: {} })).rejects.toMatchObject({ failureCode: 'video_provider_unavailable' });
    global.fetch = jest.fn().mockResolvedValueOnce(reply(201, { id: 'p2', urls: { get: 'u' } }));
    await replicate.submit({ model: 'a/b', input: {}, token: 'body-tok' });
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer body-tok');
  });
  test('a 422 is a rejected input (configuration), a 401 is unavailable', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(reply(422, { detail: 'input.elements: unknown field' }));
    await expect(replicate.submit({ model: 'a/b', input: {} })).rejects.toMatchObject({ failureCode: 'video_provider_input_rejected' });
    global.fetch = jest.fn().mockResolvedValueOnce(reply(401, { detail: 'nope' }));
    await expect(replicate.submit({ model: 'a/b', input: {} })).rejects.toMatchObject({ failureCode: 'video_provider_unavailable' });
  });
  test('poll maps statuses, finds the video URL, and classifies moderation refusals as filtered', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(reply(200, { status: 'starting' }))
      .mockResolvedValueOnce(reply(200, { status: 'processing' }))
      .mockResolvedValueOnce(reply(200, { status: 'succeeded', output: ['https://replicate.delivery/x.mp4'] }))
      .mockResolvedValueOnce(reply(200, { status: 'failed', error: 'Prediction failed: content moderation flagged the input' }))
      .mockResolvedValueOnce(reply(200, { status: 'failed', error: 'CUDA out of memory' }))
      .mockResolvedValueOnce(reply(200, { status: 'succeeded', output: { url: 'https://replicate.delivery/y.mp4' } }));
    const ref = { jobId: 'p1', pollUrl: 'https://api.replicate.com/v1/predictions/p1' };
    expect((await replicate.poll(ref)).status).toBe('queued');
    expect((await replicate.poll(ref)).status).toBe('running');
    expect(await replicate.poll(ref)).toMatchObject({ status: 'done', videoUrl: 'https://replicate.delivery/x.mp4' });
    expect(await replicate.poll(ref)).toMatchObject({ status: 'filtered' });
    expect(await replicate.poll(ref)).toMatchObject({ status: 'failed', error: 'CUDA out of memory' });
    expect(await replicate.poll(ref)).toMatchObject({ status: 'done', videoUrl: 'https://replicate.delivery/y.mp4' });
  });
  test('download returns the bytes and fails on a non-2xx', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer });
    expect([...(await replicate.download('https://x/v.mp4'))]).toEqual([1, 2, 3]);
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(replicate.download('https://x/v.mp4')).rejects.toThrow(/HTTP 404/);
  });
});
