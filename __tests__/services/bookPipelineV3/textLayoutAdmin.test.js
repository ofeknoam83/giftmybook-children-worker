/**
 * Admin textLayout flip + embedded-overlay preview (2026-07-18):
 *   - POST /v3/set-text-layout records the new mode on the checkpoint;
 *     an illustrated checkpoint drops its stale storyPlan entries (they pin
 *     the OLD aspect) so the re-dispatch re-renders at the new aspect,
 *     while target-aspect candidates replay from the aspect-keyed cache.
 *   - POST /v3/preview/embedded-overlay renders the ACTUAL overlay PDF
 *     pages + per-spread contrast metrics from request entries or the
 *     checkpoint.
 */

process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.NODE_ENV = 'test';

// In-memory GCS stand-in for the checkpoint helpers + preview upload.
const mockGcsFiles = new Map();
jest.mock('../../../services/gcsStorage', () => ({
  uploadBuffer: jest.fn(async (buf, path) => { mockGcsFiles.set(path, Buffer.from(buf)); return `gs://test/${path}`; }),
  downloadBuffer: jest.fn(async (path) => {
    if (!mockGcsFiles.has(path)) throw new Error('not found');
    return mockGcsFiles.get(path);
  }),
  deletePrefix: jest.fn(async () => {}),
  uploadFile: jest.fn(),
  getSignedUrl: jest.fn(async (path) => `https://signed.example.com/${path}`),
}));

const request = require('supertest');

describe('POST /v3/set-text-layout', () => {
  let app;
  beforeAll(() => { app = require('../../../server'); });
  beforeEach(() => { mockGcsFiles.clear(); });

  const auth = { 'x-api-key': process.env.API_KEY };
  const seedCheckpoint = (bookId, data) => {
    mockGcsFiles.set(`children-jobs/${bookId}/checkpoint.json`, Buffer.from(JSON.stringify(data)));
  };
  const readCheckpoint = (bookId) => JSON.parse(mockGcsFiles.get(`children-jobs/${bookId}/checkpoint.json`).toString());

  test('400 on invalid bookId or unsupported layout', async () => {
    expect((await request(app).post('/v3/set-text-layout').set(auth).send({ bookId: '../evil', textLayout: 'embedded' })).status).toBe(400);
    expect((await request(app).post('/v3/set-text-layout').set(auth).send({ bookId: 'bk', textLayout: 'comic' })).status).toBe(400);
  });

  test('no checkpoint (completed/draft book): nothing to pin, dispatch carries the mode', async () => {
    const res = await request(app).post('/v3/set-text-layout').set(auth).send({ bookId: 'bk-none', textLayout: 'embedded' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, changed: false, checkpoint: false, rerender: 'dispatch', next: 'redispatch_generate_book' });
    expect(mockGcsFiles.has('children-jobs/bk-none/checkpoint.json')).toBe(false);
  });

  test('same layout on an existing checkpoint is a no-op', async () => {
    seedCheckpoint('bk-same', { completedStage: 'illustration', textLayout: 'embedded', storyPlan: { entries: [] } });
    const res = await request(app).post('/v3/set-text-layout').set(auth).send({ bookId: 'bk-same', textLayout: 'embedded' });
    expect(res.body).toMatchObject({ changed: false, checkpoint: true, rerender: null });
    expect(readCheckpoint('bk-same').storyPlan).toBeDefined(); // untouched
  });

  test('illustrated checkpoint: flips the pin, drops stale entries, targets an illustration re-render', async () => {
    seedCheckpoint('bk-flip', {
      completedStage: 'illustration',
      pipelineVersion: 'v3',
      illustratorVersion: 'native',
      textLayout: 'caption',
      storyPlan: { entries: [{ type: 'spread', spread: 1, illustrationAspect: 'square' }] },
      illustrationResults: [{ type: 'spread', spread: 1 }],
    });
    const res = await request(app).post('/v3/set-text-layout').set(auth).send({ bookId: 'bk-flip', textLayout: 'embedded' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, checkpoint: true, rerender: 'illustration', next: 'redispatch_generate_book' });

    const saved = readCheckpoint('bk-flip');
    expect(saved.textLayout).toBe('embedded');
    expect(saved.textLayoutChange).toMatchObject({ from: 'caption', to: 'embedded' });
    expect(saved.storyPlan).toBeUndefined();
    expect(saved.illustrationResults).toBeUndefined();
    expect(saved.completedStage).toBe('text_layout_change');
    expect(saved.pipelineVersion).toBe('v3');          // pipeline pin survives
    expect(saved.illustratorVersion).toBe('native');   // illustrator pin survives
  });

  test('in-flight checkpoint (no storyPlan yet): flips the pin without touching stage state', async () => {
    seedCheckpoint('bk-early', { completedStage: 'needs_review', textLayout: 'embedded', needsReview: { stage: 'writerQa' } });
    const res = await request(app).post('/v3/set-text-layout').set(auth).send({ bookId: 'bk-early', textLayout: 'caption' });
    expect(res.body).toMatchObject({ changed: true, rerender: 'resume' });
    const saved = readCheckpoint('bk-early');
    expect(saved.textLayout).toBe('caption');
    expect(saved.needsReview).toBeDefined(); // review state untouched
    expect(saved.completedStage).toBe('needs_review');
  });

  test('requires the API key', async () => {
    const res = await request(app).post('/v3/set-text-layout').send({ bookId: 'bk', textLayout: 'embedded' });
    expect([401, 403]).toContain(res.status);
  });
});

describe('POST /v3/preview/embedded-overlay', () => {
  let app;
  beforeAll(() => { app = require('../../../server'); });
  beforeEach(() => { mockGcsFiles.clear(); });

  const auth = { 'x-api-key': process.env.API_KEY };

  const embeddedEntry = (spread, zone) => ({
    type: 'spread',
    spread,
    textLayout: 'embedded',
    textZone: zone,
    captionText: `Caption for spread ${spread}.`,
  });

  test('404 when the book has no embedded entries anywhere', async () => {
    const res = await request(app).post('/v3/preview/embedded-overlay').set(auth)
      .send({ bookId: 'bk-caption', entries: [{ type: 'spread', spread: 1, textLayout: 'caption', captionText: 'x' }] });
    expect(res.status).toBe(404);
  });

  test('renders a preview PDF + per-spread metrics from request entries', async () => {
    const res = await request(app).post('/v3/preview/embedded-overlay').set(auth)
      .send({ bookId: 'bk-prev', entries: [embeddedEntry(1, 'left-top'), embeddedEntry(2, 'right-bottom')] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.previewPdfUrl).toContain('children-jobs/bk-prev/previews/embedded-overlay-');
    expect(res.body.minContrast).toBe(4.5);
    expect(res.body.spreads).toHaveLength(2);
    expect(res.body.spreads[0]).toMatchObject({ spread: 1, zone: 'left-top', belowContrast: false });
    // The preview PDF itself was uploaded.
    const uploaded = [...mockGcsFiles.keys()].find((k) => k.startsWith('children-jobs/bk-prev/previews/'));
    expect(uploaded).toBeDefined();
    expect(mockGcsFiles.get(uploaded).slice(0, 4).toString()).toBe('%PDF');
  });

  test('falls back to checkpoint entries for in-flight books', async () => {
    mockGcsFiles.set('children-jobs/bk-cp/checkpoint.json', Buffer.from(JSON.stringify({
      completedStage: 'illustration',
      textLayout: 'embedded',
      storyPlan: { entries: [embeddedEntry(3, 'left-bottom')] },
    })));
    const res = await request(app).post('/v3/preview/embedded-overlay').set(auth).send({ bookId: 'bk-cp' });
    expect(res.status).toBe(200);
    expect(res.body.spreads).toHaveLength(1);
    expect(res.body.spreads[0].spread).toBe(3);
  });

  test('400 on invalid bookId', async () => {
    const res = await request(app).post('/v3/preview/embedded-overlay').set(auth).send({ bookId: '../evil' });
    expect(res.status).toBe(400);
  });
});
