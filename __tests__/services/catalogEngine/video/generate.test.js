/**
 * Clip generation (gv-1): candidate keys, the clip hash, cache replay of a
 * candidate's own bytes, the poll loop (done → download → GCS + cost;
 * filtered; failed; deadline), configuration errors surfacing, and the
 * book-context touch on every tick.
 */

jest.mock('../../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(), uploadBuffer: jest.fn().mockResolvedValue('https://signed/clip.mp4'), uploadBufferIfAbsent: jest.fn(), getSignedUrl: jest.fn(), deletePrefix: jest.fn(), saveJson: jest.fn(), loadJson: jest.fn(), objectExists: jest.fn(),
  loadJson: jest.fn(async () => null),
  saveJson: jest.fn(async () => {}),
}));
jest.mock('../../../../services/illustrationGenerator', () => ({
  fetchWithTimeout: jest.fn(), getNextApiKey: jest.fn(() => 'k'), downloadPhotoAsBase64: jest.fn(), isModestBathWaterScene: jest.fn(() => false),
}));

const { downloadBuffer, uploadBuffer } = require('../../../../services/gcsStorage');
const { generateCandidates, clipHashFor, clipKey, candidateClipKey, parseCandidateClipKey } = require('../../../../services/catalogEngine/video/generate');
const { CostTracker } = require('../../../../services/costTracker');
const { VIDEO_VERSION } = require('../../../../services/catalogEngine/versions');

const adapter = () => ({
  submit: jest.fn(async () => ({ jobId: 'j1', pollUrl: 'https://poll/j1' })),
  poll: jest.fn(),
  download: jest.fn(async () => Buffer.from('mp4-bytes')),
});
const provider = (a) => ({ provider: 'replicate', model: 'kwaivgi/kling-v3-video', adapter: a, profile: { durations: [3, 4, 5, 6], input: (job) => ({ prompt: 'p', ...(job.endFrameUrl ? { end_image: job.endFrameUrl } : {}) }) } });
const brief = { hash: 'bh', prompt: 'p', negativePrompt: 'n', params: { cfgScale: 0.5 } };
const base = (a, over = {}) => ({
  bookId: 'b1', segment: { index: 1, requestedSeconds: 4 }, brief, startFrame: { url: 'https://s/f.jpg', hash: 'sf' },
  references: [{ kind: 'character', urls: ['u'], hash: 'rh' }], provider: provider(a), aspect: '16:9', n: 2,
  costTracker: new CostTracker(), ctx: { touch: jest.fn(), log: jest.fn() }, pollIntervalMs: 1, deadlineMs: 200, ...over,
});

beforeEach(() => { downloadBuffer.mockReset().mockRejectedValue(new Error('miss')); uploadBuffer.mockClear(); });

describe('keys', () => {
  test('clip keys live under the book\'s gift-video namespace and parse back', () => {
    const h = clipHashFor({ provider: 'replicate', model: 'm', briefHash: 'b', startFrameHash: 's', referenceHashes: ['r'], seconds: 4, aspect: '16:9' });
    expect(h).toBe(clipHashFor({ provider: 'replicate', model: 'm', briefHash: 'b', startFrameHash: 's', referenceHashes: ['r'], seconds: 4, aspect: '16:9' }));
    expect(h).not.toBe(clipHashFor({ provider: 'replicate', model: 'm', briefHash: 'b', startFrameHash: 's', referenceHashes: ['r'], seconds: 5, aspect: '16:9' }));
    // gv-2: the end frame is part of the clip's identity
    expect(h).not.toBe(clipHashFor({ provider: 'replicate', model: 'm', briefHash: 'b', startFrameHash: 's', endFrameHash: 'e', referenceHashes: ['r'], seconds: 4, aspect: '16:9' }));
    const canonical = clipKey('b1', 2, h);
    expect(canonical).toBe(`children-jobs/b1/gift-video/${VIDEO_VERSION}/clips/s2-${h}.mp4`);
    expect(candidateClipKey(canonical, 1)).toBe(canonical.replace('.mp4', '.c1.mp4'));
    expect(candidateClipKey(canonical, 2, 1)).toBe(canonical.replace('.mp4', '.r1c2.mp4'));
    expect(parseCandidateClipKey('b1', candidateClipKey(canonical, 2, 1))).toEqual({ segment: 2, clipHash: h, candidate: 'r1c2', canonicalKey: canonical, version: VIDEO_VERSION });
    expect(parseCandidateClipKey('b2', candidateClipKey(canonical, 1))).toBeNull();
    expect(parseCandidateClipKey('b1', canonical)).toBeNull();
  });
});

describe('generateCandidates', () => {
  test('submits N candidates, polls to done, downloads, uploads and bills the seconds', async () => {
    const a = adapter();
    a.poll.mockResolvedValueOnce({ status: 'running' }).mockResolvedValue({ status: 'done', videoUrl: 'https://v/x.mp4' });
    const p = base(a);
    const r = await generateCandidates(p);
    expect(r.seconds).toBe(4);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.every(c => c.status === 'done' && c.buffer)).toBe(true);
    expect(a.submit).toHaveBeenCalledTimes(2);
    expect(uploadBuffer).toHaveBeenCalledWith(expect.any(Buffer), r.candidates[0].storageKey, 'video/mp4');
    expect(r.candidates[0].storageKey).toBe(candidateClipKey(r.canonicalKey, 1));
    expect(p.costTracker.getSummary().breakdown['kwaivgi/kling-v3-video'].videoSeconds).toBe(8);
    expect(p.ctx.touch).toHaveBeenCalled();
  });
  test('a cached candidate replays its own bytes without a vendor call or a charge', async () => {
    const a = adapter();
    downloadBuffer.mockResolvedValue(Buffer.from('cached'));
    const p = base(a, { n: 1 });
    const r = await generateCandidates(p);
    expect(r.candidates[0]).toMatchObject({ status: 'done', cached: true });
    expect(a.submit).not.toHaveBeenCalled();
    expect(p.costTracker.getSummary().totalCost).toBe(0);
  });
  test('forceNew ignores the cache', async () => {
    const a = adapter();
    downloadBuffer.mockResolvedValue(Buffer.from('cached'));
    a.poll.mockResolvedValue({ status: 'done', videoUrl: 'u' });
    await generateCandidates(base(a, { n: 1, forceNew: true }));
    expect(a.submit).toHaveBeenCalledTimes(1);
  });
  test('filtered and failed candidates are recorded, never retried', async () => {
    const a = adapter();
    a.poll.mockResolvedValueOnce({ status: 'filtered', error: 'moderation', reasons: ['moderation'] }).mockResolvedValueOnce({ status: 'failed', error: 'boom' });
    const r = await generateCandidates(base(a));
    expect(r.candidates.map(c => c.status).sort()).toEqual(['failed', 'filtered']);
    expect(r.candidates.every(c => c.buffer === null)).toBe(true);
    expect(uploadBuffer).not.toHaveBeenCalled();
  });
  test('a vendor that never finishes hits the deadline', async () => {
    const a = adapter();
    a.poll.mockResolvedValue({ status: 'running' });
    const r = await generateCandidates(base(a, { n: 1, deadlineMs: 30, pollIntervalMs: 5 }));
    expect(r.candidates[0]).toMatchObject({ status: 'failed' });
    expect(r.candidates[0].error).toMatch(/did not finish/);
  });
  test('a rejected input or dead account surfaces as the run\'s failure', async () => {
    const a = adapter();
    a.submit.mockRejectedValue(Object.assign(new Error('422'), { failureCode: 'video_provider_input_rejected' }));
    await expect(generateCandidates(base(a, { n: 1 }))).rejects.toMatchObject({ failureCode: 'video_provider_input_rejected' });
    a.submit.mockRejectedValue(new Error('network'));
    const r = await generateCandidates(base(a, { n: 1 }));
    expect(r.candidates[0]).toMatchObject({ status: 'failed', error: 'network' });
  });
  test('the end frame rides the input and its hash; a 422 with it is resubmitted ONCE without it, flagged', async () => {
    const a = adapter();
    a.poll.mockResolvedValue({ status: 'done', videoUrl: 'u' });
    const withEnd = await generateCandidates(base(a, { n: 1, endFrame: { url: 'https://s/e.jpg', hash: 'eh' } }));
    expect(a.submit.mock.calls[0][0].input.end_image).toBe('https://s/e.jpg');
    expect(withEnd.candidates[0].endFrameDropped).toBe(false);
    const without = await generateCandidates(base(a, { n: 1 }));
    expect(withEnd.clipHash).not.toBe(without.clipHash);

    const b = adapter();
    b.submit.mockRejectedValueOnce(Object.assign(new Error('422: end_image is not a valid field'), { failureCode: 'video_provider_input_rejected' }));
    b.poll.mockResolvedValue({ status: 'done', videoUrl: 'u' });
    const r = await generateCandidates(base(b, { n: 1, endFrame: { url: 'https://s/e.jpg', hash: 'eh' } }));
    expect(b.submit).toHaveBeenCalledTimes(2);
    expect('end_image' in b.submit.mock.calls[1][0].input).toBe(false);
    expect(r.candidates[0]).toMatchObject({ status: 'done', endFrameDropped: true });
    // without an end frame a 422 stays the run's failure
    const c = adapter();
    c.submit.mockRejectedValue(Object.assign(new Error('422'), { failureCode: 'video_provider_input_rejected' }));
    await expect(generateCandidates(base(c, { n: 1 }))).rejects.toMatchObject({ failureCode: 'video_provider_input_rejected' });
    expect(c.submit).toHaveBeenCalledTimes(1);
  });
  test('a 422 naming a field is corrected from the vendor\'s own message and resubmitted, flagged and billed as bought', async () => {
    const issue = (msg, issues) => Object.assign(new Error(msg), { failureCode: 'video_provider_input_rejected', inputIssues: issues });
    const tiered = (a) => ({ ...provider(a), model: 'kwaivgi/kling-v3-omni-video', profile: { durations: [3, 4, 5, 6], input: (job) => ({ prompt: 'p', mode: job.quality === 'std' ? 'std' : 'pro', ...(job.endFrameUrl ? { end_image: job.endFrameUrl } : {}) }) } });
    // The vendor lists its enum: our value is mapped, the clip is bought at the tier we asked for.
    const a = adapter();
    a.submit.mockRejectedValueOnce(issue('422', [{ field: 'mode', allowed: ['standard', 'pro', '4k'], unknown: false, detail: 'mode must be one of the following: "standard", "pro", "4k"' }]));
    a.poll.mockResolvedValue({ status: 'done', videoUrl: 'u' });
    const tracker = new CostTracker();
    const r = await generateCandidates(base(a, { n: 1, provider: tiered(a), quality: 'std', costTracker: tracker }));
    expect(a.submit).toHaveBeenCalledTimes(2);
    expect(a.submit.mock.calls[0][0].input.mode).toBe('std');
    expect(a.submit.mock.calls[1][0].input.mode).toBe('standard');
    expect(r.candidates[0]).toMatchObject({ status: 'done', inputRepairs: [expect.objectContaining({ field: 'mode', from: 'std', to: 'standard' })] });
    expect(tracker.videoUsage).toEqual({ 'kwaivgi/kling-v3-omni-video:std': 4 });

    // Repairs survive the end-frame fallback: the rebuilt input keeps the mapped tier.
    const b = adapter();
    b.submit
      .mockRejectedValueOnce(issue('422', [{ field: 'mode', allowed: ['standard', 'pro'], unknown: false, detail: '' }]))
      .mockRejectedValueOnce(issue('422: something about end frames', []));
    b.poll.mockResolvedValue({ status: 'done', videoUrl: 'u' });
    const withEnd = await generateCandidates(base(b, { n: 1, provider: tiered(b), quality: 'std', endFrame: { url: 'https://s/e.jpg', hash: 'eh' } }));
    expect(b.submit).toHaveBeenCalledTimes(3);
    expect(b.submit.mock.calls[2][0].input).toEqual({ prompt: 'p', mode: 'standard' });
    expect(withEnd.candidates[0]).toMatchObject({ status: 'done', endFrameDropped: true });

    // A vendor that keeps rejecting is bounded: the run fails after the correction budget, never loops.
    const c = adapter();
    c.submit.mockImplementation(async ({ input }) => { throw issue('422', [{ field: 'mode', allowed: [input.mode === 'x' ? 'y' : 'x'], unknown: false, detail: '' }]); });
    await expect(generateCandidates(base(c, { n: 1, provider: tiered(c), quality: 'std' }))).rejects.toMatchObject({ failureCode: 'video_provider_input_rejected' });
    expect(c.submit.mock.calls.length).toBeLessThanOrEqual(4);
  });
  test('poll errors are retried until the deadline', async () => {
    const a = adapter();
    a.poll.mockRejectedValueOnce(new Error('503')).mockResolvedValue({ status: 'done', videoUrl: 'u' });
    const r = await generateCandidates(base(a, { n: 1 }));
    expect(r.candidates[0].status).toBe('done');
  });
});


test('full films resume an in-flight prediction instead of buying the same motion again', async () => {
  const storage = require('../../../../services/gcsStorage');
  storage.loadJson.mockResolvedValue({ jobId: 'already-paid', pollUrl: 'https://poll/already-paid' });
  const a = adapter(); a.poll.mockResolvedValue({ status: 'done', videoUrl: 'https://video/done.mp4' });
  const result = await generateCandidates(base(a, { n: 1, persistJobs: true }));
  expect(a.submit).not.toHaveBeenCalled();
  expect(a.poll).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'already-paid' }));
  expect(result.candidates[0].status).toBe('done');
});

test('a persisted full-film prediction can finish past the clip deadline without another purchase', async () => {
  const storage = require('../../../../services/gcsStorage'); storage.loadJson.mockResolvedValue(null);
  const a = adapter(), controller = new AbortController();
  a.poll.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 12)); return { status: 'running' }; })
    .mockResolvedValue({ status: 'done', videoUrl: 'https://video/done.mp4' });
  const result = await generateCandidates(base(a, { n: 1, deadlineMs: 5, persistJobs: true, waitForPersistedJob: true,
    ctx: { abortSignal: controller.signal, touch: jest.fn(), log: jest.fn() } }));
  expect(result.candidates[0].status).toBe('done'); expect(a.submit).toHaveBeenCalledTimes(1);
});
test('the outer full-film deadline cancels extended polling and preserves the vendor job', async () => {
  const storage = require('../../../../services/gcsStorage'); storage.loadJson.mockResolvedValue({ jobId: 'saved-job' }); storage.saveJson.mockClear();
  const a = adapter(), controller = new AbortController();
  a.poll.mockImplementation(async () => { controller.abort(); return { status: 'running' }; });
  const result = await generateCandidates(base(a, { n: 1, deadlineMs: 1, persistJobs: true, waitForPersistedJob: true,
    ctx: { abortSignal: controller.signal, touch: jest.fn(), log: jest.fn() } }));
  expect(result.candidates[0]).toMatchObject({ status: 'failed', error: 'aborted', providerJobId: 'saved-job' });
  expect(a.submit).not.toHaveBeenCalled(); expect(storage.saveJson).not.toHaveBeenCalled();
});
test('extended polling still stops on provider moderation or terminal failure', async () => {
  const storage = require('../../../../services/gcsStorage'); storage.loadJson.mockResolvedValue(null);
  for (const status of ['filtered', 'failed']) {
    const a = adapter(); a.poll.mockResolvedValue({ status, error: 'provider verdict' });
    const result = await generateCandidates(base(a, { n: 1, persistJobs: true, waitForPersistedJob: true,
      ctx: { abortSignal: new AbortController().signal, touch: jest.fn(), log: jest.fn() } }));
    expect(result.candidates[0].status).toBe(status); expect(a.submit).toHaveBeenCalledTimes(1);
  }
});
