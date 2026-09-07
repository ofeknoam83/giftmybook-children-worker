/**
 * POST /v13/generate-coloring-book + /v13/pick-coloring-candidate +
 * /v13/cancel-coloring-book (cb-1): every validation before the 202, the
 * kill-switch, the 409 on a live run, the stable callback shape on success
 * and on failure (the unresolved payload passed through, every key present),
 * the progress heartbeats, the sync pick contract, and the three 410 stubs
 * that replaced the deleted coloring routes.
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
const { generateColoringBook } = require('../services/catalogEngine/coloring');
const { pickColoringCandidate } = require('../services/catalogEngine/coloring/candidates');
const { reportProgress } = require('../services/progressReporter');
const { COLORING_VERSION, COLORING_QA_VERSION } = require('../services/catalogEngine/versions');

const profile = { name: 'Emma', age: 5, pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' } };
const storyPair = {
  request: { book_id: 'farm_4_5_little_chick', profile, versions: { catalog: '1.3' } },
  response: { title: 'Emma and the Little Chick', spreads: [{ spread: 1, text: 'One.' }] },
};
const validBody = () => ({
  bookId: 'coloring-book-1',
  dispatchId: 'cb_test_1',
  story: storyPair,
  profile,
  approvedCoverUrl: 'https://covers.example/c.png',
  childPhotoUrls: ['https://photos.example/p.jpg'],
  callbackUrl: 'https://app.example/api/children/coloring-book-callback',
  progressCallbackUrl: 'https://app.example/api/children/coloring-book-progress',
});
const post = body => request(app).post('/v13/generate-coloring-book').set('x-api-key', 'test-api-key').send(body);
const settle = () => new Promise(r => setTimeout(r, 40));

const readyResult = () => ({
  cached: false, planHash: 'plan1', plan: { hash: 'plan1', band: '4-5', kinds: { meet: 1, between: 9 }, peakSpread: 8, momentWriter: 'gemini-2.5-flash', gateRejections: [] },
  bookBible: { bibleHash: 'bh', lineSheet: { hash: 'h' } },
  interiorPdfUrl: 'https://signed/interior.pdf', coverPdfUrl: 'https://signed/cover.pdf', coverImageUrl: 'https://signed/thumb.png', previewImageUrls: ['https://signed/p1.png'],
  pageCount: 24, coloringPageCount: 20,
  pages: [{ index: 1, kind: 'meet', storageKey: 'k/sheet.png', url: 'https://signed/sheet.png', qa: { pass: true, blocking: [], advisory: [] }, candidates: 0, repairs: 0, cached: true }],
  gates: { contact: { hero: { pass: true } }, stroke: { pass: true } }, unresolved: [], preflight: { ok: true, errors: [], warnings: [] }, advisories: [], warnings: [],
});

let realFetch;
beforeEach(() => {
  realFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
  resolveStory.mockReset().mockImplementation(async ({ storyPair: pair }) => ({ request: pair.request, response: pair.response, generated: false }));
  generateColoringBook.mockReset().mockResolvedValue(readyResult());
  pickColoringCandidate.mockReset();
  reportProgress.mockClear();
  delete process.env.CATALOG_COLORING_BOOK;
});
afterEach(() => { global.fetch = realFetch; });

describe('POST /v13/generate-coloring-book', () => {
  test('every validation happens BEFORE the 202', async () => {
    expect((await post({ ...validBody(), callbackUrl: undefined })).status).toBe(400);
    expect((await post({ ...validBody(), bookId: 'bad id!' })).status).toBe(400);
    expect((await post({ ...validBody(), story: undefined })).status).toBe(400);
    expect((await post({ ...validBody(), pageCount: 3 })).status).toBe(400);
    expect((await post({ ...validBody(), pages: [1, 1] })).status).toBe(400);
    expect((await post({ ...validBody(), pages: [0] })).status).toBe(400);
    expect((await post({ ...validBody(), dispatchId: 42 })).status).toBe(400);
    const noAnchor = await post({ ...validBody(), approvedCoverUrl: undefined, childPhotoUrls: [] });
    expect(noAnchor.status).toBe(400);
    expect(noAnchor.body.failureCode).toBe('missing_identity_reference');
    resolveStory.mockRejectedValueOnce(Object.assign(new Error('bad story'), { failureCode: 'invalid_story' }));
    const badStory = await post(validBody());
    expect(badStory.status).toBe(400);
    expect(badStory.body.failureCode).toBe('invalid_story');
    const badDef = await post({ ...validBody(), story: { ...storyPair, request: { ...storyPair.request, book_id: 'no_such_book' } } });
    expect(badDef.status).toBe(400);
    expect(badDef.body.failureCode).toBe('missing_book_definition');
    expect(generateColoringBook).not.toHaveBeenCalled();
  });

  test('the kill-switch answers 503 on every coloring route', async () => {
    process.env.CATALOG_COLORING_BOOK = '0';
    const r = await post(validBody());
    expect(r.status).toBe(503);
    expect(r.body.failureCode).toBe('coloring_disabled');
    const pick = await request(app).post('/v13/pick-coloring-candidate').set('x-api-key', 'test-api-key').send({ bookId: 'coloring-book-1', storageKey: 'k' });
    expect(pick.status).toBe(503);
  });

  test('202 carries the plan band and page count, then the callback carries the stable success shape', async () => {
    const r = await post(validBody());
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ success: true, bookId: 'coloring-book-1', dispatchId: 'cb_test_1', engine: 'catalog-v13', coloringVersion: COLORING_VERSION, plan: { band: '4-5', pages: 20 } });
    await settle();
    expect(generateColoringBook).toHaveBeenCalledTimes(1);
    const args = generateColoringBook.mock.calls[0][0];
    expect(args.bookId).toBe('coloring-book-1');
    expect(args.bookDef.book.id).toBe('farm_4_5_little_chick');
    expect(args.bookDef.ageBand).toBe('4-5');
    expect(args.approvedCoverUrl).toBe('https://covers.example/c.png');
    expect(args.childPhotoUrl).toBe('https://photos.example/p.jpg');
    expect(args.forceNew).toBe(false);
    const callback = global.fetch.mock.calls.find(c => c[0] === validBody().callbackUrl);
    expect(callback).toBeDefined();
    const payload = JSON.parse(callback[1].body);
    expect(payload).toMatchObject({ success: true, bookId: 'coloring-book-1', dispatchId: 'cb_test_1', engine: 'catalog-v13', coloringVersion: COLORING_VERSION, qaVersion: COLORING_QA_VERSION, planHash: 'plan1', cached: false, pageCount: 24, coloringPageCount: 20, failureCode: null, error: null });
    expect(payload.interiorPdfUrl).toBe('https://signed/interior.pdf');
    expect(payload.pages.length).toBe(1);
    expect(payload.preflight.ok).toBe(true);
    expect(payload.costs).toBeDefined();
    expect(callback[1].headers['x-api-key']).toBe('test-api-key');
  });

  test('a page-count override and a subset reach the run; progress heartbeats carry the dispatchId', async () => {
    generateColoringBook.mockImplementation(async (p) => { p.onProgress(0.5, 'Drawing pages...'); return { ...readyResult(), subset: true, interiorPdfUrl: null, pageCount: null }; });
    const r = await post({ ...validBody(), pageCount: 24, pages: [2, 3], forceNew: true });
    expect(r.status).toBe(202);
    expect(r.body.plan.pages).toBe(24);
    await settle();
    const args = generateColoringBook.mock.calls[0][0];
    expect(args.pageCount).toBe(24);
    expect(args.pages).toEqual([2, 3]);
    expect(args.forceNew).toBe(true);
    expect(reportProgress).toHaveBeenCalledWith(validBody().progressCallbackUrl, expect.objectContaining({ bookId: 'coloring-book-1', stage: 'coloring', progress: 50, dispatchId: 'cb_test_1' }));
    const payload = JSON.parse(global.fetch.mock.calls.find(c => c[0] === validBody().callbackUrl)[1].body);
    expect(payload.subset).toBe(true);
    expect(payload.interiorPdfUrl).toBeNull();
  });

  test('a failure carries every key: coloring_unresolved passes the candidates through', async () => {
    const err = Object.assign(new Error('2 page(s) could not be drawn'), { failureCode: 'coloring_unresolved', details: { unresolved: [{ page: 3, kind: 'between', defects: ['painted text: "x"'], candidates: [{ storageKey: 'k/page-3.c1.png', url: 'u', score: -20 }] }], pages: [{ index: 3 }], plan: { hash: 'plan1' }, bookBible: { bibleHash: 'bh' }, gates: { contact: null, stroke: null }, advisories: [{ stage: 'coloringQa', note: 'n' }], warnings: [], planHash: 'plan1' } });
    generateColoringBook.mockRejectedValueOnce(err);
    expect((await post(validBody())).status).toBe(202);
    await settle();
    const payload = JSON.parse(global.fetch.mock.calls.find(c => c[0] === validBody().callbackUrl)[1].body);
    expect(payload).toMatchObject({ success: false, failureCode: 'coloring_unresolved', error: '2 page(s) could not be drawn', planHash: 'plan1', cached: false, interiorPdfUrl: null, coverPdfUrl: null, coverImageUrl: null, previewImageUrls: [], pageCount: null, coloringPageCount: null, cancelled: false });
    expect(payload.unresolved[0].candidates[0].storageKey).toBe('k/page-3.c1.png');
    expect(payload.pages).toEqual([{ index: 3 }]);
    expect(payload.advisories[0].note).toBe('n');
    expect(payload.costs).toBeDefined();
    for (const k of ['plan', 'bookBible', 'gates', 'preflight', 'warnings', 'elapsedMs']) expect(payload).toHaveProperty(k);
  });

  test('a second dispatch while the run is live answers 409 and the context is released afterwards', async () => {
    let release;
    generateColoringBook.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(readyResult()); }));
    expect((await post(validBody())).status).toBe(202);
    await settle();
    const busy = await post(validBody());
    expect(busy.status).toBe(409);
    expect(busy.body.failureCode).toBe('in_flight');
    const cancel = await request(app).post('/v13/cancel-coloring-book').set('x-api-key', 'test-api-key').send({ bookId: 'coloring-book-1' });
    expect(cancel.status).toBe(200);
    release();
    await settle();
    expect((await post(validBody())).status).toBe(202);
    await settle();
    const gone = await request(app).post('/v13/cancel-coloring-book').set('x-api-key', 'test-api-key').send({ bookId: 'coloring-book-1' });
    expect(gone.status).toBe(404);
  });
});

describe('POST /v13/pick-coloring-candidate', () => {
  test('promotes through the module and answers the page + canonical key; a bad key is a 400', async () => {
    pickColoringCandidate.mockResolvedValueOnce({ page: 3, storageKey: 'k/page-3.png', renderHash: 'rh' });
    const r = await request(app).post('/v13/pick-coloring-candidate').set('x-api-key', 'test-api-key').send({ bookId: 'coloring-book-1', storageKey: 'k/page-3.c1.png' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, bookId: 'coloring-book-1', page: 3, storageKey: 'k/page-3.png', renderHash: 'rh' });
    expect(pickColoringCandidate).toHaveBeenCalledWith(expect.objectContaining({ bookId: 'coloring-book-1', candidateKey: 'k/page-3.c1.png' }));
    pickColoringCandidate.mockRejectedValueOnce(Object.assign(new Error('not a candidate'), { statusCode: 400 }));
    expect((await request(app).post('/v13/pick-coloring-candidate').set('x-api-key', 'test-api-key').send({ bookId: 'coloring-book-1', storageKey: 'x' })).status).toBe(400);
    expect((await request(app).post('/v13/pick-coloring-candidate').set('x-api-key', 'test-api-key').send({ bookId: 'coloring-book-1' })).status).toBe(400);
  });
});

describe('the deleted coloring routes answer 410', () => {
  test.each(['/generate-coloring-book', '/cancel-coloring-book', '/rebuild-coloring-cover-pdf'])('%s', async (route) => {
    const r = await request(app).post(route).set('x-api-key', 'test-api-key').send({ bookId: 'coloring-book-1' });
    expect(r.status).toBe(410);
    expect(r.body.success).toBe(false);
    expect(r.body.error).toMatch(/v13\/(generate|cancel)-coloring-book/);
  });
});
