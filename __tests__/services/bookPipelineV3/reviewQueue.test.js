/**
 * Review-queue contract (cutover plan W2):
 *   - payload builder normalizes/validates the needs_review payload
 *   - resolution builder rejects unknown actions
 *   - /v3/review/* endpoints: approve + regen-manuscript mutate the GCS
 *     checkpoint (needsReview → resolvedNeedsReview + reviewResolution);
 *     pick-candidate + regen-spread 409 until the native illustrator (W10);
 *     guards: invalid bookId 400, missing checkpoint 404, not-awaiting 409.
 */

process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.NODE_ENV = 'test';

// In-memory GCS stand-in for the checkpoint helpers.
const mockGcsFiles = new Map();
jest.mock('../../../services/gcsStorage', () => ({
  uploadBuffer: jest.fn(async (buf, path) => { mockGcsFiles.set(path, Buffer.from(buf)); return `gs://test/${path}`; }),
  downloadBuffer: jest.fn(async (path) => {
    if (!mockGcsFiles.has(path)) throw new Error('not found');
    return mockGcsFiles.get(path);
  }),
  deletePrefix: jest.fn(async (prefix) => {
    for (const k of [...mockGcsFiles.keys()]) if (k.startsWith(prefix)) mockGcsFiles.delete(k);
  }),
  uploadFile: jest.fn(),
  getSignedUrl: jest.fn(),
}));

const {
  buildNeedsReviewPayload,
  buildReviewResolution,
} = require('../../../services/bookPipelineV3/reviewQueue/payload');

describe('buildNeedsReviewPayload', () => {
  test('normalizes a writerQa exhaustion payload', () => {
    const p = buildNeedsReviewPayload({
      stage: 'writerQa',
      reason: 'judge_panel_exhausted',
      defects: ['failing dimensions [musicality]'],
      judgeScores: { medians: { musicality: 3 } },
      judgeHistory: [{ msA: { sumMedians: 21 } }],
      manuscriptHistory: [{ id: 'msA', title: 'T' }],
    });
    expect(p.version).toBe(1);
    expect(p.stage).toBe('writerQa');
    expect(p.reason).toBe('judge_panel_exhausted');
    expect(p.spread).toBeNull();
    expect(p.defects).toEqual(['failing dimensions [musicality]']);
    expect(p.candidateUrls).toEqual([]);
    expect(typeof p.createdAt).toBe('string');
  });

  test('requires stage and reason', () => {
    expect(() => buildNeedsReviewPayload({ reason: 'judge_panel_exhausted' })).toThrow(/stage/);
    expect(() => buildNeedsReviewPayload({ stage: 'writerQa' })).toThrow(/reason/);
  });

  test('caps defect and candidate list sizes', () => {
    const p = buildNeedsReviewPayload({
      stage: 'spreadQa',
      reason: 'spread_qa_exhausted',
      spread: 7,
      defects: Array.from({ length: 80 }, (_, i) => `d${i}`),
      candidateUrls: Array.from({ length: 40 }, (_, i) => `https://x/${i}.jpg`),
    });
    expect(p.spread).toBe(7);
    expect(p.defects).toHaveLength(50);
    expect(p.candidateUrls).toHaveLength(20);
  });
});

describe('buildReviewResolution', () => {
  test('builds a ship_best resolution', () => {
    const r = buildReviewResolution({ action: 'ship_best', note: 'fine as-is', admin: 'qa@x.com' });
    expect(r.action).toBe('ship_best');
    expect(r.note).toBe('fine as-is');
    expect(r.admin).toBe('qa@x.com');
    expect(typeof r.resolvedAt).toBe('string');
  });

  test('rejects unknown actions', () => {
    expect(() => buildReviewResolution({ action: 'yolo_ship' })).toThrow(/unknown action/);
  });
});

describe('POST /v3/review/*', () => {
  const request = require('supertest');
  let app;

  beforeAll(() => {
    app = require('../../../server');
  });

  beforeEach(() => {
    mockGcsFiles.clear();
  });

  const seedCheckpoint = (bookId, data) => {
    mockGcsFiles.set(`children-jobs/${bookId}/checkpoint.json`, Buffer.from(JSON.stringify(data)));
  };

  const auth = { 'x-api-key': process.env.API_KEY };

  test('approve: 400 on invalid bookId', async () => {
    const res = await request(app).post('/v3/review/approve').set(auth).send({ bookId: '../evil' });
    expect(res.status).toBe(400);
  });

  test('approve: 404 without a checkpoint', async () => {
    const res = await request(app).post('/v3/review/approve').set(auth).send({ bookId: 'book-x' });
    expect(res.status).toBe(404);
  });

  test('approve: 409 when checkpoint is not awaiting review', async () => {
    seedCheckpoint('book-1', { completedStage: 'illustration', pipelineVersion: 'v3' });
    const res = await request(app).post('/v3/review/approve').set(auth).send({ bookId: 'book-1' });
    expect(res.status).toBe(409);
  });

  test('approve: records ship_best resolution and clears needsReview', async () => {
    const needsReview = buildNeedsReviewPayload({ stage: 'writerQa', reason: 'judge_panel_exhausted', defects: ['x'] });
    seedCheckpoint('book-2', { completedStage: 'needs_review', pipelineVersion: 'v3', needsReview });

    const res = await request(app).post('/v3/review/approve').set(auth)
      .send({ bookId: 'book-2', note: 'ship it', admin: 'qa@x.com' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, action: 'ship_best', next: 'redispatch_generate_book' });

    const saved = JSON.parse(mockGcsFiles.get('children-jobs/book-2/checkpoint.json').toString());
    expect(saved.needsReview).toBeUndefined();
    expect(saved.resolvedNeedsReview.reason).toBe('judge_panel_exhausted');
    expect(saved.reviewResolution).toMatchObject({ action: 'ship_best', note: 'ship it', admin: 'qa@x.com' });
    expect(saved.pipelineVersion).toBe('v3'); // resume stays on v3
  });

  test('regen-manuscript: records resolution', async () => {
    const needsReview = buildNeedsReviewPayload({ stage: 'writerQa', reason: 'judge_panel_exhausted' });
    seedCheckpoint('book-3', { completedStage: 'needs_review', pipelineVersion: 'v3', needsReview });

    const res = await request(app).post('/v3/review/regen-manuscript').set(auth)
      .send({ bookId: 'book-3', note: 'voice is flat, try again' });
    expect(res.status).toBe(200);
    const saved = JSON.parse(mockGcsFiles.get('children-jobs/book-3/checkpoint.json').toString());
    expect(saved.reviewResolution.action).toBe('regen_manuscript');
    expect(saved.reviewResolution.note).toMatch(/voice is flat/);
  });

  test('pick-candidate and regen-spread 409 until W10', async () => {
    for (const action of ['pick-candidate', 'regen-spread']) {
      const res = await request(app).post(`/v3/review/${action}`).set(auth).send({ bookId: 'book-4' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/native V3 illustrator/);
    }
  });

  test('all review endpoints require the API key', async () => {
    const res = await request(app).post('/v3/review/approve').send({ bookId: 'book-5' });
    expect([401, 403]).toContain(res.status);
  });
});
