/**
 * POST /v13/generate-audiobook + /v13/audiobook-audition + /v13/pick-take +
 * /v13/cancel-audiobook (ab-1): every validation before the 202, the
 * kill-switch, the 409 on a live run, the stable callback shape on success
 * and on failure (the unresolved payload passed through, every key
 * present), the progress heartbeats, the sync audition and pick contracts.
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
jest.mock('../services/catalogEngine/coloring', () => ({ generateColoringBook: jest.fn() }));
jest.mock('../services/catalogEngine/coloring/candidates', () => ({ pickColoringCandidate: jest.fn() }));
jest.mock('../services/catalogEngine/audio', () => ({ generateAudiobook: jest.fn(), auditionAudiobook: jest.fn(), AudiobookError: class AudiobookError extends Error { constructor(m, c, d) { super(m); this.failureCode = c; this.details = d; } } }));
jest.mock('../services/catalogEngine/audio/candidates', () => ({ pickTake: jest.fn() }));
jest.mock('../services/illustrationGenerator', () => ({
  generateIllustration: jest.fn(),
  downloadPhotoAsBase64: jest.fn().mockResolvedValue({ base64: 'fake-base64', mimeType: 'image/jpeg' }),
  getNextApiKey: jest.fn().mockReturnValue('test-key'),
  fetchWithTimeout: jest.fn(),
  callGeminiImageParts: jest.fn(),
  buildReferenceParts: jest.fn(),
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
  downloadBuffer: jest.fn().mockResolvedValue(Buffer.from('fake')),
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
const { generateAudiobook, auditionAudiobook, AudiobookError } = require('../services/catalogEngine/audio');
const { pickTake } = require('../services/catalogEngine/audio/candidates');
const { reportProgress } = require('../services/progressReporter');
const { AUDIO_VERSION, AUDIO_QA_VERSION } = require('../services/catalogEngine/versions');

const profile = { name: 'Emma', age: 5, pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' } };
const storyPair = {
  request: { book_id: 'farm_4_5_little_chick', profile, versions: { catalog: '1.3' } },
  response: { title: 'Emma and the Little Chick', spreads: [{ spread: 1, text: 'One.' }] },
};
const validBody = () => ({
  bookId: 'audio-book-1',
  dispatchId: 'ab_test_1',
  story: storyPair,
  profile,
  language: 'en',
  cast: { narrator: 'storyteller_warm_f' },
  dedication: { text: 'With love.', from: 'Mom' },
  callbackUrl: 'https://app.example/api/children/audiobook-callback',
  progressCallbackUrl: 'https://app.example/api/children/progress',
});
const post = body => request(app).post('/v13/generate-audiobook').set('x-api-key', 'test-api-key').send(body);
const settle = () => new Promise(r => setTimeout(r, 40));

const readyResult = () => ({
  cached: false, audioVersion: AUDIO_VERSION, qaVersion: AUDIO_QA_VERSION, scriptHash: 'mix1', audiobookUrl: 'https://signed/audiobook.mp3', storageKey: 'children-jobs/audio-book-1/audiobook/ab-1/mix1/audiobook.mp3',
  timelineUrl: 'https://signed/timeline.json', timeline: { totalSeconds: 123, spreads: [] }, durationSeconds: 123, bytes: 1000, loudness: { integratedLufs: -16, truePeakDbtp: -1.2 },
  cast: { narrator: { key: 'storyteller_warm_f' }, companion: null, hash: 'c' }, script: { hash: 's', director: 'table', lines: 30, companionLines: 0, segments: 14 }, audioTuningUsed: 'none', language: 'en',
  pronunciations: [{ name: 'Emma', status: 'verified', alias: null }], segments: [{ index: 0, kind: 'intro', spread: null, chunks: [] }], music: { provider: 'lyria', suite: { hash: 'x' }, plan: [] }, sfx: { placed: [] }, ambience: null,
  gates: { loudness: { pass: true } }, unresolved: [], advisories: [{ stage: 'music', note: 'x' }], warnings: [],
});

let callbacks;
beforeEach(() => {
  callbacks = [];
  global.fetch = jest.fn(async (url, opts) => { callbacks.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; });
  resolveStory.mockReset().mockResolvedValue({ request: storyPair.request, response: storyPair.response });
  generateAudiobook.mockReset();
  auditionAudiobook.mockReset();
  pickTake.mockReset();
  reportProgress.mockClear();
  delete process.env.CATALOG_AUDIOBOOK;
});

describe('POST /v13/generate-audiobook validation', () => {
  test('requires the API key, a bookId, a callbackUrl and a story pair', async () => {
    expect((await request(app).post('/v13/generate-audiobook').send(validBody())).status).toBe(403);
    expect((await post({ ...validBody(), bookId: '' })).status).toBe(400);
    expect((await post({ ...validBody(), callbackUrl: undefined })).body.error).toMatch(/callbackUrl/);
    const noStory = await post({ ...validBody(), story: undefined });
    expect(noStory.status).toBe(400);
    expect(noStory.body.error).toMatch(/story/);
    expect((await post({ ...validBody(), language: 'fr' })).body.error).toMatch(/language/);
    expect((await post({ ...validBody(), cast: { narrator: 'Not A Key' } })).body.error).toMatch(/cast\.narrator/);
    expect((await post({ ...validBody(), segments: [1, 1] })).body.error).toMatch(/segments/);
    expect((await post({ ...validBody(), forceRetake: [13] })).body.error).toMatch(/forceRetake/);
    expect((await post({ ...validBody(), audioTuning: 'text' })).body.error).toMatch(/audioTuning/);
    expect(generateAudiobook).not.toHaveBeenCalled();
  });
  test('an invalid story is a 400 with its code; a stale catalog tag is missing_book_definition', async () => {
    resolveStory.mockRejectedValueOnce(Object.assign(new Error('bad story'), { failureCode: 'invalid_story' }));
    const r = await post(validBody());
    expect(r.status).toBe(400);
    expect(r.body.failureCode).toBe('invalid_story');
    resolveStory.mockResolvedValueOnce({ request: { ...storyPair.request, book_id: 'nope', versions: { catalog: '9.9+deadbeef' } }, response: storyPair.response });
    const stale = await post(validBody());
    expect(stale.status).toBe(400);
    expect(stale.body.failureCode).toBe('missing_book_definition');
  });
  test('the kill-switch answers 503 on every route', async () => {
    process.env.CATALOG_AUDIOBOOK = '0';
    expect((await post(validBody())).status).toBe(503);
    expect((await request(app).post('/v13/audiobook-audition').set('x-api-key', 'test-api-key').send(validBody())).status).toBe(503);
    expect((await request(app).post('/v13/pick-take').set('x-api-key', 'test-api-key').send({ bookId: 'b', storageKey: 'k' })).status).toBe(503);
  });
});

describe('POST /v13/generate-audiobook run', () => {
  test('202 with the accepted segments, then a success callback with every key + the progress heartbeats', async () => {
    generateAudiobook.mockImplementation(async (p) => { p.onProgress(0.5, 'Recording...'); return readyResult(); });
    const r = await post(validBody());
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ success: true, bookId: 'audio-book-1', dispatchId: 'ab_test_1', audioVersion: AUDIO_VERSION, language: 'en', cast: { narrator: 'storyteller_warm_f' } });
    expect(r.body.accepted.segments.length).toBe(12);
    await settle();
    expect(generateAudiobook).toHaveBeenCalledTimes(1);
    const args = generateAudiobook.mock.calls[0][0];
    expect(args.bookDef.book.id).toBe('farm_4_5_little_chick');
    expect(args.dedication).toEqual({ text: 'With love.', from: 'Mom' });
    expect(args.cast).toEqual({ narrator: 'storyteller_warm_f', companion: undefined });
    expect(callbacks).toHaveLength(1);
    const cb = callbacks[0].body;
    expect(cb.success).toBe(true);
    for (const k of ['bookId', 'dispatchId', 'audioVersion', 'qaVersion', 'scriptHash', 'cached', 'audiobookUrl', 'storageKey', 'timelineUrl', 'timeline', 'durationSeconds', 'bytes', 'loudness', 'cast', 'script', 'audioTuningUsed', 'language', 'pronunciations', 'segments', 'music', 'sfx', 'ambience', 'gates', 'unresolved', 'advisories', 'warnings', 'costs', 'elapsedMs', 'failureCode', 'error']) expect(cb).toHaveProperty(k);
    expect(cb.failureCode).toBeNull();
    expect(cb.durationSeconds).toBe(123);
    expect(reportProgress).toHaveBeenCalledWith('https://app.example/api/children/progress', expect.objectContaining({ bookId: 'audio-book-1', stage: 'audiobook', progress: 50, dispatchId: 'ab_test_1' }));
  });
  test('an unresolved failure carries its candidates and every key; a 409 while a run is live', async () => {
    let release;
    generateAudiobook.mockImplementation(() => new Promise((_, reject) => { release = () => reject(new AudiobookError('2 takes failed', 'audiobook_unresolved', { unresolved: [{ segment: 3, spread: 2, chunk: 0, defects: ['narration text mismatch'], candidates: [{ storageKey: 'k', url: 'u', score: -20 }] }], segments: [{ index: 3 }], cast: { hash: 'c' } })); }));
    expect((await post(validBody())).status).toBe(202);
    expect((await post(validBody())).status).toBe(409);
    release();
    await settle();
    const cb = callbacks[0].body;
    expect(cb.success).toBe(false);
    expect(cb.failureCode).toBe('audiobook_unresolved');
    expect(cb.unresolved[0].candidates[0].storageKey).toBe('k');
    expect(cb.segments).toEqual([{ index: 3 }]);
    expect(cb.cast).toEqual({ hash: 'c' });
    for (const k of ['audiobookUrl', 'timeline', 'gates', 'music', 'sfx', 'advisories', 'costs']) expect(cb).toHaveProperty(k);
    expect((await post(validBody())).status).toBe(202);
    release();
    await settle();
  });
  test('a subset run passes segments / forceRetake / forceNew through', async () => {
    generateAudiobook.mockResolvedValue({ ...readyResult(), subset: true, audiobookUrl: null });
    const r = await post({ ...validBody(), segments: [2, 5], forceRetake: [5], forceNew: true });
    expect(r.body.accepted.segments).toEqual([2, 5]);
    await settle();
    expect(generateAudiobook.mock.calls[0][0]).toMatchObject({ segments: [2, 5], forceRetake: [5], forceNew: true });
    expect(callbacks[0].body.subset).toBe(true);
  });
});

describe('GET /v13/audiobook-cast', () => {
  test('lists the cast vocabulary with the recommended default for a theme/band', async () => {
    const res = await request(app).get('/v13/audiobook-cast?themeId=farm&ageBand=4-5').set('x-api-key', 'test-api-key');
    expect(res.status).toBe(200);
    expect(res.body.narrators.map(n => n.key)).toEqual(expect.arrayContaining(['storyteller_warm_f', 'storyteller_warm_m', 'storyteller_bright']));
    expect(res.body.companions.map(n => n.key)).toEqual(expect.arrayContaining(['creature_small', 'guide_adult_f', 'magical']));
    expect(res.body.recommended).toEqual({ narrator: 'storyteller_warm_f', companion: 'guide_adult_f' });
    expect(res.body.languages).toEqual(['en', 'es', 'he']);
    expect(res.body.castHash).toMatch(/^[0-9a-f]{8,}$/);
    const bare = await request(app).get('/v13/audiobook-cast').set('x-api-key', 'test-api-key');
    expect(bare.body.recommended).toEqual({ narrator: null, companion: null });
  });
});

describe('sync routes', () => {
  test('audition validates, runs and answers; a provider outage is a 503', async () => {
    auditionAudiobook.mockResolvedValue({ url: 'https://signed/a.wav', storageKey: 'k', seconds: 4.2, spread: 3, wordMatch: 1, transcript: 'One.', cast: { narrator: { key: 'storyteller_warm_f' } }, blocking: [], advisory: [], unresolved: false });
    const r = await request(app).post('/v13/audiobook-audition').set('x-api-key', 'test-api-key').send({ ...validBody(), spread: 3 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, bookId: 'audio-book-1', spread: 3, url: 'https://signed/a.wav' });
    expect(auditionAudiobook.mock.calls[0][0].spread).toBe(3);
    expect((await request(app).post('/v13/audiobook-audition').set('x-api-key', 'test-api-key').send({ ...validBody(), spread: 0 })).status).toBe(400);
    auditionAudiobook.mockRejectedValueOnce(Object.assign(new Error('no key'), { failureCode: 'audiobook_provider_unavailable' }));
    expect((await request(app).post('/v13/audiobook-audition').set('x-api-key', 'test-api-key').send(validBody())).status).toBe(503);
  });
  test('pick-take promotes a candidate; a bad key is a 400', async () => {
    pickTake.mockResolvedValue({ chunk: 0, takeHash: 'h', storageKey: 'canonical', renderHash: 'r', seconds: 2 });
    const r = await request(app).post('/v13/pick-take').set('x-api-key', 'test-api-key').send({ bookId: 'audio-book-1', storageKey: 'children-jobs/audio-book-1/x.c1.wav' });
    expect(r.body).toMatchObject({ success: true, storageKey: 'canonical' });
    pickTake.mockRejectedValueOnce(Object.assign(new Error('not a candidate'), { statusCode: 400 }));
    expect((await request(app).post('/v13/pick-take').set('x-api-key', 'test-api-key').send({ bookId: 'audio-book-1', storageKey: 'x' })).status).toBe(400);
    expect((await request(app).post('/v13/pick-take').set('x-api-key', 'test-api-key').send({ bookId: 'audio-book-1' })).status).toBe(400);
  });
  test('cancel: 404 without a run, 200 while one is live', async () => {
    expect((await request(app).post('/v13/cancel-audiobook').set('x-api-key', 'test-api-key').send({ bookId: 'audio-book-1' })).status).toBe(404);
    let release;
    generateAudiobook.mockImplementation(() => new Promise((_, reject) => { release = () => reject(new AudiobookError('cancelled', 'cancelled')); }));
    await post(validBody());
    const r = await request(app).post('/v13/cancel-audiobook').set('x-api-key', 'test-api-key').send({ bookId: 'audio-book-1' });
    expect(r.status).toBe(200);
    release();
    await settle();
    expect(callbacks[0].body.cancelled).toBe(true);
  });
});
