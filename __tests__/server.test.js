// Set required env vars BEFORE requiring the server
process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-api-key';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GCS_BUCKET_NAME = 'test-bucket';

// Mock all external service modules to prevent real API calls
jest.mock('../services/catalogEngine/pipeline', () => ({
  runBookPipeline: jest.fn().mockResolvedValue({
    interiorPdfUrl: 'https://storage.example.com/interior.pdf',
    coverPdfUrl: 'https://storage.example.com/cover.pdf',
    backCoverImageUrl: null,
    previewImageUrls: [],
    title: 'Test Story',
    spreadCount: 12,
    storyContent: { title: 'Test Story', entries: [] },
    qaAdvisories: [],
    warnings: [],
  }),
  resolveStory: jest.fn(),
  PipelineError: class PipelineError extends Error {},
}));
jest.mock('../services/catalogEngine/illustrator', () => ({
  renderStorySpreads: jest.fn(),
}));
jest.mock('../services/illustrationGenerator', () => ({
  generateIllustration: jest.fn().mockResolvedValue('https://example.com/illustration.png'),
  downloadPhotoAsBase64: jest.fn().mockResolvedValue({ base64: 'fake-base64', mimeType: 'image/jpeg' }),
  getNextApiKey: jest.fn().mockReturnValue('test-key'),
  fetchWithTimeout: jest.fn(),
  ART_STYLE_CONFIG: { watercolor: { prefix: 'watercolor', suffix: 'soft' } },
  // The art-style funnel was consolidated to one canonical key ("watercolor")
  // so server.js calls canonicalBookArtStyle() to normalize whatever the
  // caller sends. The mock returns the canonical key regardless of input,
  // matching the production no-op behavior.
  canonicalBookArtStyle: jest.fn(() => 'watercolor'),
  PARENT_THEMES: new Set(['mothers_day', 'fathers_day']),
}));
jest.mock('../services/layoutEngine', () => ({
  assemblePdf: jest.fn().mockResolvedValue(Buffer.from('fake-pdf')),
}));
jest.mock('../services/coverGenerator', () => ({
  generateCover: jest.fn().mockResolvedValue({ coverPdfBuffer: Buffer.from('fake-cover'), frontCoverImageUrl: 'https://example.com/cover.png' }),
  generateFrontCoverImage: jest.fn().mockResolvedValue({
    frontCoverImageUrl: 'https://example.com/front.png',
    frontCoverBuffer: Buffer.from('fake-front-cover'),
    coverAnatomyAdvisory: null,
  }),
}));
jest.mock('../services/gcsStorage', () => ({
  uploadBuffer: jest.fn().mockResolvedValue('https://storage.example.com/file'),
  getSignedUrl: jest.fn().mockResolvedValue('https://storage.example.com/signed-url'),
  downloadBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-image')),
  deletePrefix: jest.fn().mockResolvedValue(undefined),
  uploadFromUrl: jest.fn().mockResolvedValue('https://storage.example.com/uploaded'),
  saveJson: jest.fn().mockResolvedValue(undefined),
  loadJson: jest.fn().mockRejectedValue(new Error('not found')),
  getBucket: jest.fn(),
}));
jest.mock('../services/progressReporter', () => ({
  // The real reporters return promises (callers chain .catch on them) — a
  // bare jest.fn() returning undefined makes every background pipeline block
  // die on `.catch` before reaching the code under test.
  reportProgress: jest.fn().mockResolvedValue(undefined),
  reportProgressForce: jest.fn().mockResolvedValue(undefined),
  reportComplete: jest.fn().mockResolvedValue(undefined),
  reportError: jest.fn().mockResolvedValue(undefined),
  clearThrottle: jest.fn(),
}));
jest.mock('../services/comics/castVisualBible', () => ({
  generateCharacterRefSheet: jest.fn(),
}));

const request = require('supertest');
const { generateCharacterRefSheet } = require('../services/comics/castVisualBible');
const app = require('../server');

describe('GET /health', () => {
  test('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('giftmybook-children-worker');
  });
});

describe('POST /health', () => {
  test('returns 200 with status ok', async () => {
    const res = await request(app).post('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('Authentication', () => {
  test('rejects requests without API key', async () => {
    const res = await request(app)
      .post('/generate-book')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden');
  });

  test('rejects requests with wrong API key', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'wrong-key')
      .send({});
    expect(res.status).toBe(403);
  });

  test('allows requests with correct API key (then fails validation)', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({});
    // Should get past auth to validation (400), not auth error (403)
    expect(res.status).toBe(400);
  });
});

describe('POST /generate-book validation (catalog engine)', () => {
  const profile = {
    name: 'Emma', age: 5,
    pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' },
  };

  test('rejects empty body', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({});
    expect(res.status).toBe(400);
  });

  test('rejects bookId with path traversal characters', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({ bookId: '../../../etc/passwd', profile, bookDefinitionId: 'farm_2_3_hello_farm' });
    expect(res.status).toBe(400);
  });

  test('rejects missing profile', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({ bookId: 'test-book-123', bookDefinitionId: 'space_4_5_rover_route' });
    expect(res.status).toBe(400);
  });

  test('rejects request with neither story nor bookDefinitionId', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({ bookId: 'test-book-123', profile });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/story|bookDefinitionId/);
  });

  test('rejects unknown catalog book id', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({ bookId: 'test-book-123', profile, bookDefinitionId: 'not_a_real_book' });
    expect(res.status).toBe(400);
  });

  test('accepts valid request with 202', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({ bookId: 'test-book-valid', profile, bookDefinitionId: 'space_4_5_rover_route' });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.engine).toBe('catalog-v13');
  });

  test('rejects a book outside the profile age band before the 202', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({ bookId: 'test-book-band', profile, bookDefinitionId: 'farm_2_3_hello_farm' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/age band/);
  });

  test('catalogThemeId alone is a valid legacy fallback (auto-selects the top candidate)', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({ bookId: 'test-book-legacy-1', profile, catalogThemeId: 'farm' });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
  });

  test('an unknown catalogThemeId fallback still 400s before the 202', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({ bookId: 'test-book-legacy-2', profile, catalogThemeId: 'volcanoes' });
    expect(res.status).toBe(400);
  });
});

describe('GET /v13/themes', () => {
  test('returns the 12 catalog themes', async () => {
    const res = await request(app).get('/v13/themes').set('x-api-key', 'test-api-key');
    expect(res.status).toBe(200);
    expect(res.body.themes).toHaveLength(12);
    expect(res.body.themes.map(t => t.themeId)).toContain('farm');
  });
});

describe('POST /v13/select-books', () => {
  const profile = {
    name: 'Emma', age: 4,
    pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' },
  };

  test('returns three deterministic candidates', async () => {
    const body = { themeId: 'space', sessionId: 'sess_test_1', profile };
    const res1 = await request(app).post('/v13/select-books').set('x-api-key', 'test-api-key').send(body);
    const res2 = await request(app).post('/v13/select-books').set('x-api-key', 'test-api-key').send(body);
    expect(res1.status).toBe(200);
    expect(res1.body.selection.candidates).toHaveLength(3);
    expect(res1.body.ageBand).toBe('4-5');
    expect(res1.body.selection.candidates).toEqual(res2.body.selection.candidates);
  });

  test('rejects unknown theme', async () => {
    const res = await request(app)
      .post('/v13/select-books')
      .set('x-api-key', 'test-api-key')
      .send({ themeId: 'volcanoes', sessionId: 'sess_test_1', profile });
    expect(res.status).toBe(400);
  });

  test('rejects invalid profile age', async () => {
    const res = await request(app)
      .post('/v13/select-books')
      .set('x-api-key', 'test-api-key')
      .send({ themeId: 'space', sessionId: 'sess_test_1', profile: { ...profile, age: 14 } });
    expect(res.status).toBe(400);
  });
});

describe('POST /v13/generate-stories validation', () => {
  const profile = {
    name: 'Emma', age: 4,
    pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' },
  };

  test('rejects unknown candidate book ids', async () => {
    const res = await request(app)
      .post('/v13/generate-stories')
      .set('x-api-key', 'test-api-key')
      .send({ bookId: 'test-book-123', bookIds: ['nope'], profile });
    expect(res.status).toBe(400);
  });

  test('rejects candidates outside the profile age band', async () => {
    const res = await request(app)
      .post('/v13/generate-stories')
      .set('x-api-key', 'test-api-key')
      .send({ bookId: 'test-book-123', bookIds: ['farm_2_3_hello_farm'], profile });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/age band/);
  });

  test('rejects more than three candidates', async () => {
    const res = await request(app)
      .post('/v13/generate-stories')
      .set('x-api-key', 'test-api-key')
      .send({ bookId: 'test-book-123', bookIds: ['a', 'b', 'c', 'd'], profile });
    expect(res.status).toBe(400);
  });
});

// POST /generate-spread validation describe removed — the /generate-spread
// endpoint was retired (V2 pipeline generates sequentially), see
// server.js:2467 "// /generate-spread removed". The endpoint now 404s, so
// the legacy 400-validation tests no longer apply.

describe('POST /finalize-book validation', () => {
  test('rejects empty spreads', async () => {
    const res = await request(app)
      .post('/finalize-book')
      .set('x-api-key', 'test-api-key')
      .send({ bookId: 'book-123', spreads: [] });
    expect(res.status).toBe(400);
  });

  test('rejects missing bookId', async () => {
    const res = await request(app)
      .post('/finalize-book')
      .set('x-api-key', 'test-api-key')
      .send({ spreads: [{ spreadNumber: 1 }] });
    expect(res.status).toBe(400);
  });
});

describe('POST /comics/crop-face validation', () => {
  test('rejects comicId with unsafe characters', async () => {
    const res = await request(app)
      .post('/comics/crop-face')
      .set('x-api-key', 'test-api-key')
      .send({
        comicId: '../other-comic',
        groupPhotoUrl: 'https://example.com/group.jpg',
        box: [0.1, 0.1, 0.2, 0.2],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('comicId has unsafe characters');
  });

  test('rejects padding outside the allowed range', async () => {
    const res = await request(app)
      .post('/comics/crop-face')
      .set('x-api-key', 'test-api-key')
      .send({
        comicId: 'comic-123',
        groupPhotoUrl: 'https://example.com/group.jpg',
        box: [0.1, 0.1, 0.2, 0.2],
        padding: -0.1,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('padding must be a finite number between 0 and 2');
  });
});

describe('POST /comics/generate-refsheet validation', () => {
  beforeEach(() => {
    generateCharacterRefSheet.mockReset();
  });

  test('rejects faceCropUrl outside expected comics face path', async () => {
    const res = await request(app)
      .post('/comics/generate-refsheet')
      .set('x-api-key', 'test-api-key')
      .send({
        comicId: 'comic-123',
        characterId: 'char-1',
        faceCropUrl: 'https://example.com/anything.jpg',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('faceCropUrl must be an HTTPS GCS URL');
  });

  test('parses force string false as false', async () => {
    generateCharacterRefSheet.mockResolvedValue({
      refSheetUrl: 'https://storage.googleapis.com/test-bucket/comics/comic-123/refsheets/char-1.png',
      visualLocks: { hair: 'brown' },
    });

    const res = await request(app)
      .post('/comics/generate-refsheet')
      .set('x-api-key', 'test-api-key')
      .send({
        comicId: 'comic-123',
        characterId: 'char-1',
        faceCropUrl: 'https://storage.googleapis.com/test-bucket/comics/comic-123/faces/abc.jpg?X-Goog-Signature=1',
        force: 'false',
      });

    expect(res.status).toBe(200);
    expect(generateCharacterRefSheet).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
  });

  test('returns 502 for timeout-like upstream errors', async () => {
    generateCharacterRefSheet.mockRejectedValue(new Error('Request timed out after 30000ms'));

    const res = await request(app)
      .post('/comics/generate-refsheet')
      .set('x-api-key', 'test-api-key')
      .send({
        comicId: 'comic-123',
        characterId: 'char-1',
        faceCropUrl: 'https://storage.googleapis.com/test-bucket/comics/comic-123/faces/abc.jpg',
      });

    expect(res.status).toBe(502);
  });
});

describe('POST /v13/render-spreads (illustration probe)', () => {
  const { resolveStory } = require('../services/catalogEngine/pipeline');
  const { renderStorySpreads } = require('../services/catalogEngine/illustrator');
  const profile = {
    name: 'Emma', age: 2,
    pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' },
  };
  const storyPair = {
    request: { book_id: 'farm_2_3_hello_farm', profile },
    response: { title: 'Hello Farm', spreads: [{ spread: 1, text: 'One.' }, { spread: 3, text: 'Three.' }] },
  };
  const validBody = () => ({
    bookId: 'probe-book-1',
    story: storyPair,
    spreads: [3, 1],
    profile,
    childPhotoUrls: ['https://photos.example/child.png'],
    callbackUrl: 'https://app.example/api/children/render-probe-callback',
    dispatchId: 'art_d_test',
  });
  const post = body => request(app)
    .post('/v13/render-spreads')
    .set('x-api-key', 'test-api-key')
    .send(body);

  let realFetch;
  beforeEach(() => {
    realFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    resolveStory.mockReset().mockImplementation(async ({ storyPair: pair }) => ({
      request: pair.request, response: pair.response, generated: false,
    }));
    renderStorySpreads.mockReset().mockResolvedValue({
      results: [
        { spread: 1, buffer: Buffer.from('x'), storageKey: 'k1', url: 'https://x/1.png', advisories: [] },
        {
          spread: 3, buffer: null, storageKey: 'k3', url: null,
          advisories: [{
            stage: 'render', spread: 3, note: 'render errored: boom',
            detail: { attempts: [{ attempt: 1, variant: 'original', error: 'No image in Gemini response (public-2)', finishReason: 'IMAGE_SAFETY' }] },
          }],
        },
      ],
      aspect: 'square',
      storyHash: 'h1',
      tuningTag: 'art-001.aabbccdd',
    });
  });
  afterEach(() => { global.fetch = realFetch; });
  const settle = () => new Promise(r => setTimeout(r, 25));

  test('every validation happens BEFORE the 202', async () => {
    expect((await post({ ...validBody(), callbackUrl: undefined })).status).toBe(400);
    expect((await post({ ...validBody(), spreads: [] })).status).toBe(400);
    expect((await post({ ...validBody(), spreads: [1, 1] })).status).toBe(400);
    expect((await post({ ...validBody(), spreads: [0, 13] })).status).toBe(400);
    expect((await post({ ...validBody(), story: undefined })).status).toBe(400);
    expect((await post({ ...validBody(), seed: 'not-an-int' })).status).toBe(400);
    const badTuning = await post({ ...validBody(), illustrationTuning: { versionLabel: 'bad label!', hash: 'aabbccdd', text: 'x' } });
    expect(badTuning.status).toBe(400);
    expect(badTuning.body.error).toMatch(/versionLabel/);
    const noAnchor = await post({ ...validBody(), childPhotoUrls: undefined });
    expect(noAnchor.status).toBe(400);
    expect(noAnchor.body.failureCode).toBe('missing_identity_reference');
    expect(renderStorySpreads).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a story pair that fails re-validation is rejected before the 202', async () => {
    resolveStory.mockRejectedValue(Object.assign(new Error('stored story failed re-validation'), { failureCode: 'invalid_story' }));
    const res = await post(validBody());
    expect(res.status).toBe(400);
    expect(res.body.failureCode).toBe('invalid_story');
    expect(renderStorySpreads).not.toHaveBeenCalled();
  });

  test('202 → renders through the identity-keyed probe path → per-spread callback with dispatchId echo', async () => {
    const res = await post({ ...validBody(), probeNonce: 'n1', seed: 42 });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toEqual([1, 3]);
    await settle();
    expect(renderStorySpreads).toHaveBeenCalledWith(expect.objectContaining({
      bookId: 'probe-book-1',
      spreads: [1, 3],
      identityKeyed: true,
      seed: 42,
      probeNonce: 'n1',
    }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://app.example/api/children/render-probe-callback');
    const payload = JSON.parse(opts.body);
    expect(payload.dispatchId).toBe('art_d_test');
    expect(payload.illustrationTuningUsed).toBe('art-001.aabbccdd');
    expect(payload.renders).toEqual([
      expect.objectContaining({ spread: 1, url: 'https://x/1.png', qa: expect.objectContaining({ pass: true }) }),
    ]);
    expect(payload.failures).toEqual([
      expect.objectContaining({ spread: 3, message: expect.stringContaining('render errored: boom') }),
    ]);
    // The externally consumed diagnostics contract: advisory detail rides
    // the callback failure verbatim.
    expect(payload.failures[0].detail.attempts).toEqual([
      expect.objectContaining({ attempt: 1, variant: 'original', finishReason: 'IMAGE_SAFETY' }),
    ]);
    expect(payload.success).toBe(true);
  });

  test('a probe that blows up entirely still reports by callback, never silently', async () => {
    renderStorySpreads.mockRejectedValue(Object.assign(new Error('identity reference could not be downloaded'), { failureCode: 'missing_identity_reference' }));
    const res = await post(validBody());
    expect(res.status).toBe(202);
    await settle();
    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(payload.success).toBe(false);
    expect(payload.dispatchId).toBe('art_d_test');
    expect(payload.failures[0].failureCode).toBe('missing_identity_reference');
  });
});

describe('POST /v13/generate-cover-image (probe-anchor cover)', () => {
  const { generateFrontCoverImage } = require('../services/coverGenerator');
  const { uploadBuffer } = require('../services/gcsStorage');
  const validBody = () => ({
    bookId: 'anchor-book-1',
    title: 'Hello Farm',
    childName: 'Emma',
    childAge: 2,
    childPhotoUrl: 'https://photos.example/child.png',
  });
  const post = body => request(app)
    .post('/v13/generate-cover-image')
    .set('x-api-key', 'test-api-key')
    .send(body);

  beforeEach(() => {
    generateFrontCoverImage.mockClear().mockResolvedValue({
      frontCoverImageUrl: 'https://example.com/front.png',
      frontCoverBuffer: Buffer.from('fake-front-cover'),
      coverAnatomyAdvisory: null,
    });
    uploadBuffer.mockClear().mockResolvedValue('https://storage.example.com/anchor-cover.png');
  });

  test('validates before any render spend', async () => {
    expect((await post({ ...validBody(), bookId: 'bad id!' })).status).toBe(400);
    expect((await post({ ...validBody(), childName: undefined })).status).toBe(400);
    expect((await post({ ...validBody(), childName: '   ' })).status).toBe(400);
    expect((await post({ ...validBody(), childName: 'Em\u0000ma' })).status).toBe(400);
    expect((await post({ ...validBody(), childName: 'x'.repeat(61) })).status).toBe(400);
    expect((await post({ ...validBody(), title: 42 })).status).toBe(400);
    const noPhoto = await post({ ...validBody(), childPhotoUrl: undefined });
    expect(noPhoto.status).toBe(400);
    expect(noPhoto.body.failureCode).toBe('missing_identity_reference');
    const badScheme = await post({ ...validBody(), childPhotoUrl: 'gs://bucket/child.png' });
    expect(badScheme.status).toBe(400);
    expect(generateFrontCoverImage).not.toHaveBeenCalled();
  });

  test('renders through the production front-cover path and uploads to children-covers/', async () => {
    const res = await post(validBody());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.coverUrl).toBe('https://storage.example.com/anchor-cover.png');
    expect(res.body.gcsPath).toMatch(/^children-covers\/anchor-book-1\/anchor-cover-\d+\.png$/);
    expect(res.body.title).toBe('Hello Farm');
    expect(res.body.coverAnatomyAdvisory).toBeNull();
    expect(res.body.costs).toBeDefined();
    const [childDetails, refUrl, opts] = generateFrontCoverImage.mock.calls[0];
    expect(childDetails).toEqual({ childName: 'Emma', childAge: 2 });
    expect(refUrl).toBe('https://photos.example/child.png');
    expect(opts).toMatchObject({
      bookId: 'anchor-book-1',
      childPhotoUrl: 'https://photos.example/child.png',
      isSquareTrim: true,
      isGraphicNovel: false,
      isHardcover: false,
    });
    expect(uploadBuffer).toHaveBeenCalledWith(expect.any(Buffer), res.body.gcsPath, 'image/png');
  });

  test('accepts childPhotoUrls[] and hardcover binding', async () => {
    const res = await post({
      ...validBody(),
      childPhotoUrl: undefined,
      childPhotoUrls: ['https://photos.example/alt.png'],
      bindingType: 'HARDCOVER_CASEWRAP',
    });
    expect(res.status).toBe(200);
    const [, refUrl, opts] = generateFrontCoverImage.mock.calls[0];
    expect(refUrl).toBe('https://photos.example/alt.png');
    expect(opts.isHardcover).toBe(true);
  });

  test('a render that produced no image is a 502, never a silent success', async () => {
    generateFrontCoverImage.mockResolvedValue({ frontCoverImageUrl: null, frontCoverBuffer: null, coverAnatomyAdvisory: null });
    const res = await post(validBody());
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  test('a residual anatomy advisory ships on the response, ship-and-flag', async () => {
    generateFrontCoverImage.mockResolvedValue({
      frontCoverImageUrl: 'https://example.com/front.png',
      frontCoverBuffer: Buffer.from('fake-front-cover'),
      coverAnatomyAdvisory: 'cover hero anatomy: three hands (shipped after 1 retry)',
    });
    const res = await post(validBody());
    expect(res.status).toBe(200);
    expect(res.body.coverAnatomyAdvisory).toMatch(/three hands/);
  });
});

describe('POST /generate-book render_failed diagnostics on the failure callback', () => {
  const { runBookPipeline } = require('../services/catalogEngine/pipeline');
  const profile = {
    name: 'Emma', age: 2,
    pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' },
  };

  test('err.renderFailures from the illustrator is serialized for the caller', async () => {
    let realFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    runBookPipeline.mockRejectedValueOnce(Object.assign(
      new Error('render failed for spread(s) 1 — the book cannot complete with blank art; retry re-renders only the missing spreads'),
      {
        failureCode: 'render_failed',
        renderFailures: [{
          spread: 1,
          message: 'render errored: No image in Gemini response (public-2)',
          detail: { attempts: [{ attempt: 1, variant: 'original', error: 'No image in Gemini response (public-2)', finishReason: 'IMAGE_SAFETY' }] },
        }],
      },
    ));
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({
        bookId: 'gb-render-failed', profile, bookDefinitionId: 'farm_2_3_hello_farm',
        callbackUrl: 'https://app.example/api/children/callback',
      });
    expect(res.status).toBe(202);
    await new Promise(r => setTimeout(r, 25));
    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(payload.success).toBe(false);
    expect(payload.failureCode).toBe('render_failed');
    expect(payload.renderFailures[0].detail.attempts[0]).toMatchObject({ finishReason: 'IMAGE_SAFETY' });
    global.fetch = realFetch;
  });
});

describe('POST /generate-book illustrationTuning passthrough', () => {
  const { runBookPipeline } = require('../services/catalogEngine/pipeline');
  const profile = {
    name: 'Emma', age: 2,
    pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' },
  };
  const tuning = { versionLabel: 'art-001', hash: 'aabbccdd', text: 'warm rim light' };

  test('malformed illustrationTuning is rejected before the 202', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({
        bookId: 'gb-tuning-bad', profile, bookDefinitionId: 'farm_2_3_hello_farm',
        illustrationTuning: { versionLabel: 'art-001', hash: 'nothex', text: 'x' },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hash/);
  });

  test('a well-formed overlay reaches runBookPipeline verbatim', async () => {
    runBookPipeline.mockClear();
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({ bookId: 'gb-tuning-ok', profile, bookDefinitionId: 'farm_2_3_hello_farm', illustrationTuning: tuning });
    expect(res.status).toBe(202);
    await new Promise(r => setTimeout(r, 25));
    expect(runBookPipeline).toHaveBeenCalledWith(expect.objectContaining({
      bookId: 'gb-tuning-ok',
      illustrationTuning: tuning,
    }));
  });
});

describe('textLayout vocabulary: half', () => {
  const { renderStorySpreads } = require('../services/catalogEngine/illustrator');
  const { resolveStory } = require('../services/catalogEngine/pipeline');
  const profile = {
    name: 'Emma', age: 2,
    pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' },
  };
  const storyPair = {
    request: { book_id: 'farm_2_3_hello_farm', profile },
    response: { title: 'Hello Farm', spreads: [{ spread: 1, text: 'One.' }] },
  };

  test('POST /v13/set-text-layout accepts half and still rejects junk', async () => {
    const ok = await request(app)
      .post('/v13/set-text-layout')
      .set('x-api-key', 'test-api-key')
      .send({ bookId: 'tl-book', textLayout: 'half' });
    expect(ok.status).toBe(200);
    expect(ok.body.textLayout).toBe('half');
    const bad = await request(app)
      .post('/v13/set-text-layout')
      .set('x-api-key', 'test-api-key')
      .send({ bookId: 'tl-book', textLayout: 'poster' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/caption', 'half', or 'embedded/);
  });

  test('render-spreads forwards half to the illustrator instead of coercing it to caption', async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    resolveStory.mockReset().mockImplementation(async ({ storyPair: pair }) => ({
      request: pair.request, response: pair.response, generated: false,
    }));
    renderStorySpreads.mockReset().mockResolvedValue({ results: [], aspect: 'square', storyHash: 'h', tuningTag: 'none' });
    const res = await request(app)
      .post('/v13/render-spreads')
      .set('x-api-key', 'test-api-key')
      .send({
        bookId: 'half-probe', story: storyPair, spreads: [1], profile,
        textLayout: 'half',
        childPhotoUrls: ['https://photos.example/child.png'],
        callbackUrl: 'https://app.example/api/children/render-probe-callback',
      });
    expect(res.status).toBe(202);
    await new Promise(r => setTimeout(r, 25));
    expect(renderStorySpreads).toHaveBeenCalledWith(expect.objectContaining({ textLayout: 'half' }));
    global.fetch = realFetch;
  });
});
