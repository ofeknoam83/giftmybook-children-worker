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
  PipelineError: class PipelineError extends Error {},
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
  reportProgress: jest.fn(),
  reportProgressForce: jest.fn(),
  reportComplete: jest.fn(),
  reportError: jest.fn(),
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
