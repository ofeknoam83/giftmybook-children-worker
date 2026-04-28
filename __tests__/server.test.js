// Set required env vars BEFORE requiring the server
process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-api-key';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.REPLICATE_API_TOKEN = 'test-replicate-token';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GCS_BUCKET_NAME = 'test-bucket';

// Mock all external service modules to prevent real API calls
jest.mock('../services/storyPlanner', () => ({
  planStory: jest.fn().mockResolvedValue({
    title: 'Test Story',
    entries: [
      { type: 'half_title_page', title: 'Test Story' },
      { type: 'blank' },
      { type: 'title_page', title: 'Test Story', subtitle: 'A bedtime story' },
      { type: 'copyright_page' },
      { type: 'dedication_page', text: 'For Emma' },
      ...Array.from({ length: 12 }, (_, i) => ({
        type: 'spread',
        spread: i + 1,
        left: { text: `Text ${i + 1}` },
        right: { text: null },
        spread_image_prompt: `Scene ${i + 1}`,
      })),
      { type: 'blank' },
      { type: 'closing_page' },
      { type: 'blank' },
    ],
  }),
  polishStory: jest.fn().mockImplementation(async (plan) => plan),
  brainstormStorySeed: jest.fn().mockResolvedValue({
    favorite_object: 'a toy dinosaur',
    fear: 'a strange sound',
    setting: 'a twilight garden',
    storySeed: 'A child discovers the garden sings at night.',
    repeated_phrase: 'hush now, little seed',
    phrase_arc: ['playful', 'guiding', 'calming'],
    beats: [],
  }),
  validateStoryText: jest.fn().mockReturnValue({ valid: true, issues: [] }),
  combinedCritic: jest.fn().mockResolvedValue({ approved: true }),
  polishEarlyReader: jest.fn().mockImplementation(async (plan) => plan),
  masterCritic: jest.fn().mockResolvedValue({ approved: true }),
  EMOTIONAL_THEMES: new Set(['separation_anxiety', 'new_sibling', 'first_day_school', 'moving_house', 'grief', 'hospital']),
  getEmotionalTier: jest.fn().mockReturnValue(null),
  planChapterBook: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/textGenerator', () => ({
  generateSpreadText: jest.fn().mockResolvedValue('Generated text.'),
}));
jest.mock('../services/illustrationGenerator', () => ({
  generateIllustration: jest.fn().mockResolvedValue('https://example.com/illustration.png'),
  generateIllustrationWithAnchors: jest.fn().mockResolvedValue('https://example.com/illustration.png'),
  downloadPhotoAsBase64: jest.fn().mockResolvedValue({ base64: 'fake-base64', mimeType: 'image/jpeg' }),
  getNextApiKey: jest.fn().mockReturnValue('test-key'),
  fetchWithTimeout: jest.fn(),
  ART_STYLE_CONFIG: { watercolor: { prefix: 'watercolor', suffix: 'soft' } },
}));
jest.mock('../services/chatSessionManager', () => ({
  ChatSessionManager: jest.fn().mockImplementation(() => ({
    startBookSession: jest.fn().mockResolvedValue(true),
    generateSpread: jest.fn().mockResolvedValue({
      imageBuffer: Buffer.from('fake-image'),
      imageBase64: 'ZmFrZS1pbWFnZQ==',
    }),
    retrySpread: jest.fn().mockResolvedValue({
      imageBuffer: Buffer.from('fake-image'),
      imageBase64: 'ZmFrZS1pbWFnZQ==',
    }),
    retryTextOnly: jest.fn().mockResolvedValue({
      imageBuffer: Buffer.from('fake-image'),
      imageBase64: 'ZmFrZS1pbWFnZQ==',
    }),
    getSessionInfo: jest.fn().mockReturnValue({ turnsUsed: 1, model: 'test', startedAt: Date.now() }),
  })),
}));
jest.mock('../services/faceEngine', () => ({
  extractFaceEmbedding: jest.fn().mockResolvedValue({ embedding: null, faceCount: 1, primaryPhotoUrl: 'https://example.com/photo.jpg' }),
  generateCharacterReference: jest.fn().mockResolvedValue('https://example.com/ref.png'),
  verifyFaceConsistency: jest.fn().mockResolvedValue(0.8),
  describeChildAppearance: jest.fn().mockResolvedValue('A young child with brown hair.'),
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
jest.mock('../services/taskQueue', () => ({
  enqueueSpreadJob: jest.fn(),
  enqueueFinalizeJob: jest.fn(),
}));
jest.mock('../services/progressReporter', () => ({
  reportProgress: jest.fn(),
  reportProgressForce: jest.fn(),
  reportComplete: jest.fn(),
  reportError: jest.fn(),
  clearThrottle: jest.fn(),
}));

const request = require('supertest');
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

describe('POST /generate-book validation', () => {
  test('rejects empty body', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  test('rejects missing childName', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({
        bookId: 'test-book-123',
        childPhotoUrls: ['https://example.com/photo.jpg'],
      });
    expect(res.status).toBe(400);
    expect(res.body.errors.some(e => e.includes('childName'))).toBe(true);
  });

  test('rejects non-HTTPS photo URLs', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({
        bookId: 'test-book-123',
        childName: 'Emma',
        childPhotoUrls: ['http://insecure.com/photo.jpg'],
      });
    expect(res.status).toBe(400);
    expect(res.body.errors.some(e => e.includes('HTTPS'))).toBe(true);
  });

  test('rejects bookId with path traversal characters', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({
        bookId: '../../../etc/passwd',
        childName: 'Emma',
        childPhotoUrls: ['https://example.com/photo.jpg'],
      });
    expect(res.status).toBe(400);
  });

  test('accepts valid request with 202', async () => {
    const res = await request(app)
      .post('/generate-book')
      .set('x-api-key', 'test-api-key')
      .send({
        bookId: 'test-book-valid',
        childName: 'Emma',
        childPhotoUrls: ['https://example.com/photo.jpg'],
        childAge: 5,
        bookFormat: 'picture_book',
        artStyle: 'watercolor',
        theme: 'adventure',
      });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.bookId).toBe('test-book-valid');
  });
});

describe('POST /generate-spread validation', () => {
  test('rejects missing bookId', async () => {
    const res = await request(app)
      .post('/generate-spread')
      .set('x-api-key', 'test-api-key')
      .send({ spreadPlan: { spreadNumber: 1 } });
    expect(res.status).toBe(400);
  });

  test('rejects missing spreadPlan', async () => {
    const res = await request(app)
      .post('/generate-spread')
      .set('x-api-key', 'test-api-key')
      .send({ bookId: 'book-123' });
    expect(res.status).toBe(400);
  });
});

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
