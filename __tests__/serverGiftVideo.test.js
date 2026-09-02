/**
 * POST /v13/generate-video + POST /v13/pick-clip (gv-1): every validation
 * before the 202, the kill-switch, the 202 body, the stable callback shape
 * on success and on failure (unresolved payload passed through), the
 * request-injected provider token, and the sync pick-clip contract.
 */

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-api-key';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GCS_BUCKET_NAME = 'test-bucket';

jest.mock('../services/catalogEngine/pipeline', () => ({
  runBookPipeline: jest.fn(),
  resolveStory: jest.fn(),
  PipelineError: class PipelineError extends Error {},
}));
jest.mock('../services/catalogEngine/illustrator', () => ({ renderStorySpreads: jest.fn(), storyFingerprint: () => 'fp' }));
jest.mock('../services/catalogEngine/illustrator/bible', () => ({ prepareIdentity: jest.fn() }));
jest.mock('../services/catalogEngine/illustrator/candidates', () => ({ pickCandidate: jest.fn() }));
jest.mock('../services/catalogEngine/video', () => ({ generateGiftVideo: jest.fn() }));
jest.mock('../services/catalogEngine/video/clips', () => ({ pickClip: jest.fn() }));
jest.mock('../services/illustrationGenerator', () => ({
  generateIllustration: jest.fn(),
  downloadPhotoAsBase64: jest.fn().mockResolvedValue({ base64: 'fake-base64', mimeType: 'image/jpeg' }),
  getNextApiKey: jest.fn().mockReturnValue('test-key'),
  fetchWithTimeout: jest.fn(),
  isModestBathWaterScene: jest.fn(() => false),
  ART_STYLE_CONFIG: { watercolor: { prefix: 'watercolor', suffix: 'soft' } },
  canonicalBookArtStyle: jest.fn(() => 'watercolor'),
  PARENT_THEMES: new Set(['mothers_day', 'fathers_day']),
}));
jest.mock('../services/layoutEngine', () => ({ assemblePdf: jest.fn() }));
jest.mock('../services/coverGenerator', () => ({ generateCover: jest.fn(), generateFrontCoverImage: jest.fn() }));
jest.mock('../services/gcsStorage', () => ({
  uploadBuffer: jest.fn().mockResolvedValue('https://storage.example.com/file'),
  getSignedUrl: jest.fn().mockResolvedValue('https://storage.example.com/signed-url'),
  downloadBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-image')),
  deletePrefix: jest.fn().mockResolvedValue(undefined),
  uploadFromUrl: jest.fn(),
  uploadBufferIfAbsent: jest.fn(),
  objectExists: jest.fn(),
  saveJson: jest.fn().mockResolvedValue(undefined),
  loadJson: jest.fn().mockRejectedValue(new Error('not found')),
  getBucket: jest.fn(),
}));
jest.mock('../services/progressReporter', () => ({
  reportProgress: jest.fn().mockResolvedValue(undefined),
  reportProgressForce: jest.fn().mockResolvedValue(undefined),
  reportComplete: jest.fn().mockResolvedValue(undefined),
  reportError: jest.fn().mockResolvedValue(undefined),
  clearThrottle: jest.fn(),
}));
jest.mock('../services/comics/castVisualBible', () => ({ generateCharacterRefSheet: jest.fn() }));

const request = require('supertest');
const app = require('../server');
const { resolveStory } = require('../services/catalogEngine/pipeline');
const { generateGiftVideo } = require('../services/catalogEngine/video');
const { pickClip } = require('../services/catalogEngine/video/clips');
const { reportProgress } = require('../services/progressReporter');
const { VIDEO_VERSION } = require('../services/catalogEngine/versions');

const profile = { name: 'Emma', age: 2, pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' } };
const storyPair = {
  request: { book_id: 'farm_2_3_hello_farm', profile },
  response: { title: 'Hello Farm', spreads: [{ spread: 1, text: 'One.' }] },
};
const key = (n, aspect = 'wide-plain', book = 'video-book-1') => `children-jobs/${book}/ce-renders/ce-9/abc/spread-${n}.${aspect}.png`;
const validBody = () => ({
  bookId: 'video-book-1',
  dispatchId: 'gv_test_1',
  story: storyPair,
  renders: [{ spread: 1, storageKey: key(1) }, { spread: 7, storageKey: key(7) }, { spread: 12, storageKey: key(12) }],
  profile,
  approvedCoverUrl: 'https://covers.example/c.png',
  textLayout: 'half',
  callbackUrl: 'https://app.example/api/children/video-callback',
  progressCallbackUrl: 'https://app.example/api/children/progress',
  REPLICATE_API_TOKEN: 'body-token',
});
const post = body => request(app).post('/v13/generate-video').set('x-api-key', 'test-api-key').send(body);
const settle = () => new Promise(r => setTimeout(r, 30));

const readyResult = () => ({
  video: { url: 'https://signed/v.mp4', storageKey: 'k/video.mp4', posterUrl: 'https://signed/p.jpg', posterKey: 'k/poster.jpg', hash: 'h', version: VIDEO_VERSION, durationSeconds: 10, width: 1920, height: 1080, fps: 30, bytes: 123, music: 'none', cached: false },
  plan: [{ index: 0, kind: 'cover', spread: null, seconds: 2.4, motion: 'push-in', startFrame: { storageKey: null, renderHash: 'r' }, clip: { storageKey: 'c', hash: 'ch', score: 100, candidates: 2, repairs: 0 } }],
  textGate: [{ segment: 0, pass: true }], bookBible: { bibleHash: 'bh' }, unresolved: [], advisories: [], warnings: [],
  provider: 'replicate', model: 'kwaivgi/kling-v3-video',
});

let realFetch;
beforeEach(() => {
  realFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
  resolveStory.mockReset().mockImplementation(async ({ storyPair: pair }) => ({ request: pair.request, response: pair.response, generated: false }));
  generateGiftVideo.mockReset().mockResolvedValue(readyResult());
  pickClip.mockReset();
  reportProgress.mockClear();
  delete process.env.CATALOG_GIFT_VIDEO;
});
afterEach(() => { global.fetch = realFetch; });

describe('POST /v13/generate-video', () => {
  test('every validation happens BEFORE the 202', async () => {
    expect((await post({ ...validBody(), callbackUrl: undefined })).status).toBe(400);
    expect((await post({ ...validBody(), bookId: 'bad id!' })).status).toBe(400);
    const badKey = await post({ ...validBody(), renders: [{ spread: 1, storageKey: key(1).replace('.png', '.c1.png') }] });
    expect(badKey.status).toBe(400);
    expect(badKey.body.failureCode).toBe('video_no_sources');
    expect((await post({ ...validBody(), renders: [{ spread: 1, storageKey: key(1, 'wide-plain', 'other-book') }] })).status).toBe(400);
    expect((await post({ ...validBody(), renders: [] })).status).toBe(400);
    expect((await post({ ...validBody(), story: undefined })).status).toBe(400);
    expect((await post({ ...validBody(), seed: 'x' })).status).toBe(400);
    expect((await post({ ...validBody(), illustrationTuning: { versionLabel: 'bad label!', hash: 'aabbccdd', text: 'x' } })).status).toBe(400);
    const noAnchor = await post({ ...validBody(), approvedCoverUrl: undefined });
    expect(noAnchor.status).toBe(400);
    expect(noAnchor.body.failureCode).toBe('missing_identity_reference');
    const badProvider = await post({ ...validBody(), provider: 'fal' });
    expect(badProvider.status).toBe(400);
    expect(badProvider.body.failureCode).toBe('video_provider_unavailable');
    expect((await post({ ...validBody(), aspect: '4:3' })).status).toBe(400);
    expect((await post({ ...validBody(), music: '../etc' })).status).toBe(400);
    expect(generateGiftVideo).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a story pair that fails re-validation is rejected before the 202', async () => {
    resolveStory.mockRejectedValue(Object.assign(new Error('stored story failed re-validation'), { failureCode: 'invalid_story' }));
    const res = await post(validBody());
    expect(res.status).toBe(400);
    expect(res.body.failureCode).toBe('invalid_story');
    expect(generateGiftVideo).not.toHaveBeenCalled();
  });

  test('the kill-switch answers 503', async () => {
    process.env.CATALOG_GIFT_VIDEO = '0';
    const res = await post(validBody());
    expect(res.status).toBe(503);
    expect(res.body.failureCode).toBe('gift_video_disabled');
  });

  test('202 → the film is built with the exact keys + identity inputs, and the callback carries the stable shape', async () => {
    const res = await post(validBody());
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      success: true, bookId: 'video-book-1', dispatchId: 'gv_test_1', engine: 'catalog-v13', videoVersion: VIDEO_VERSION,
      provider: 'replicate', model: 'kwaivgi/kling-v3-video', accepted: { spreads: [1, 7, 12] },
    });
    await settle();
    expect(generateGiftVideo).toHaveBeenCalledTimes(1);
    const arg = generateGiftVideo.mock.calls[0][0];
    expect(arg).toMatchObject({
      bookId: 'video-book-1', renders: [{ spread: 1, storageKey: key(1) }, { spread: 7, storageKey: key(7) }, { spread: 12, storageKey: key(12) }],
      approvedCoverUrl: 'https://covers.example/c.png', textLayout: 'half', provider: 'replicate', model: 'kwaivgi/kling-v3-video',
      aspect: '16:9', music: 'none', forceNew: false, identityKeyed: false, providerToken: 'body-token',
    });
    expect(typeof arg.touch).toBe('function');
    arg.onProgress(0.5, 'Animating...');
    expect(reportProgress).toHaveBeenCalledWith('https://app.example/api/children/progress', expect.objectContaining({ bookId: 'video-book-1', stage: 'video', progress: 50, message: 'Animating...', dispatchId: 'gv_test_1' }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://app.example/api/children/video-callback');
    expect(opts.headers['x-api-key']).toBe('test-api-key');
    const payload = JSON.parse(opts.body);
    expect(payload).toMatchObject({
      success: true, bookId: 'video-book-1', dispatchId: 'gv_test_1', engine: 'catalog-v13', videoVersion: VIDEO_VERSION,
      provider: 'replicate', model: 'kwaivgi/kling-v3-video', failureCode: null, error: null, unresolved: [],
    });
    expect(payload.video.durationSeconds).toBe(10);
    expect(payload.plan).toHaveLength(1);
    expect(payload.bookBible).toEqual({ bibleHash: 'bh' });
    expect(payload.costs).toEqual(expect.objectContaining({ totalCost: expect.any(Number) }));
    for (const k of ['video', 'plan', 'textGate', 'bookBible', 'unresolved', 'advisories', 'warnings', 'costs', 'failureCode', 'error']) expect(payload).toHaveProperty(k);
  });

  test('a failed film keeps every key and passes the unresolved payload through', async () => {
    const err = Object.assign(new Error('1 segment(s) could not be animated'), {
      failureCode: 'video_unresolved',
      details: { unresolved: [{ segment: 2, spread: 7, defects: ['identity break: x'], candidates: [{ storageKey: 'c1', url: 'u', score: -20 }] }], plan: [{ index: 2 }], textGate: [], bookBible: { bibleHash: 'bh' }, advisories: [{ stage: 'video', note: 'n' }], warnings: [] },
    });
    generateGiftVideo.mockRejectedValue(err);
    expect((await post(validBody())).status).toBe(202);
    await settle();
    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(payload).toMatchObject({ success: false, failureCode: 'video_unresolved', error: '1 segment(s) could not be animated', video: null, provider: 'replicate' });
    expect(payload.unresolved).toHaveLength(1);
    expect(payload.plan).toEqual([{ index: 2 }]);
    expect(payload.bookBible).toEqual({ bibleHash: 'bh' });
    for (const k of ['video', 'plan', 'textGate', 'bookBible', 'unresolved', 'advisories', 'warnings', 'costs', 'failureCode', 'error']) expect(payload).toHaveProperty(k);
  });

  test('a provider override and probe salts pass through', async () => {
    expect((await post({ ...validBody(), provider: 'replicate', model: 'kwaivgi/kling-v3-video', identityKeyed: true, seed: 3, probeNonce: 'n', forceNew: true, aspect: '9:16' })).status).toBe(202);
    await settle();
    expect(generateGiftVideo.mock.calls[0][0]).toMatchObject({ identityKeyed: true, seed: 3, probeNonce: 'n', forceNew: true, aspect: '9:16' });
  });
});

describe('POST /v13/pick-clip', () => {
  const pick = body => request(app).post('/v13/pick-clip').set('x-api-key', 'test-api-key').send(body);
  test('validates, promotes, and passes the module\'s status code through', async () => {
    expect((await pick({ bookId: 'b1' })).status).toBe(400);
    expect((await pick({ bookId: 'bad id!', storageKey: 'x' })).status).toBe(400);
    pickClip.mockResolvedValueOnce({ segment: 2, storageKey: 'children-jobs/b1/gift-video/gv-1/clips/s2-abc.mp4', clipHash: 'abc' });
    const ok = await pick({ bookId: 'b1', storageKey: 'children-jobs/b1/gift-video/gv-1/clips/s2-abc.c1.mp4' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true, bookId: 'b1', segment: 2, storageKey: 'children-jobs/b1/gift-video/gv-1/clips/s2-abc.mp4', clipHash: 'abc' });
    expect(pickClip).toHaveBeenCalledWith(expect.objectContaining({ bookId: 'b1', candidateKey: 'children-jobs/b1/gift-video/gv-1/clips/s2-abc.c1.mp4' }));
    pickClip.mockRejectedValueOnce(Object.assign(new Error('storageKey is not a candidate clip of this book'), { statusCode: 400 }));
    expect((await pick({ bookId: 'b1', storageKey: 'nope' })).status).toBe(400);
    process.env.CATALOG_GIFT_VIDEO = '0';
    expect((await pick({ bookId: 'b1', storageKey: 'x' })).status).toBe(503);
  });
});
