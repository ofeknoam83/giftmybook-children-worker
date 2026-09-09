jest.mock('../../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(), loadJson: jest.fn(), saveJson: jest.fn(), uploadBuffer: jest.fn(),
}));
jest.mock('../../../../services/catalogEngine/video/filmScript', () => ({
  hash: value => String(value), filmError: message => new Error(message), directorJson: jest.fn(),
}));
const storage = require('../../../../services/gcsStorage');
const replicate = require('../../../../services/catalogEngine/video/providers/replicate');
const { generateCandidates } = require('../../../../services/catalogEngine/video/generate');
const { syncDialogue } = require('../../../../services/catalogEngine/video/filmPerformance');

beforeEach(() => {
  jest.restoreAllMocks();
  storage.downloadBuffer.mockReset().mockResolvedValue(null);
  storage.loadJson.mockReset().mockResolvedValue(null);
  storage.saveJson.mockReset().mockResolvedValue(true);
  storage.uploadBuffer.mockReset().mockResolvedValue('https://storage/media');
  jest.spyOn(replicate, 'submit').mockResolvedValue({ jobId: 'new-job' });
  jest.spyOn(replicate, 'poll').mockResolvedValue({ status: 'done', videoUrl: 'https://provider/video' });
  jest.spyOn(replicate, 'download').mockResolvedValue(Buffer.from('video'));
});

function animation(over = {}) {
  return generateCandidates({ bookId: 'book', segment: { index: 1, requestedSeconds: 4 },
    brief: { hash: 'brief' }, startFrame: { hash: 'frame', url: 'https://storage/frame' },
    aspect: '16:9', n: 1, persistJobs: true, pollIntervalMs: 1, deadlineMs: 1000,
    provider: { provider: 'replicate', model: 'kwaivgi/kling-v3-omni-video', adapter: replicate,
      profile: { durations: [4], input: () => ({ prompt: 'scene', mode: 'std' }) } }, ...over });
}
function dialogue(over = {}) {
  return syncDialogue({ base: 'book/film', video: Buffer.from('motion'), audio: Buffer.from('speech'),
    seconds: 4, token: 'test-token', pollIntervalMs: 1, ...over });
}

describe.each([['animation', animation], ['dialogue', dialogue]])('%s saved prediction', (_name, run) => {
  test.each([503, 403, 'ETIMEDOUT', 'invalid-json'])('a %s read failure never buys another prediction', async code => {
    storage.loadJson.mockRejectedValue(Object.assign(new Error('checkpoint read failed'), { code }));
    await expect(run()).rejects.toMatchObject({ failureCode: 'video_prediction_state_unavailable',
      recovery: { status: 'verification_pending', retryable: [503, 'ETIMEDOUT'].includes(code) } });
    expect(replicate.submit).not.toHaveBeenCalled();
    expect(storage.saveJson).not.toHaveBeenCalled();
  });
  test('a missing checkpoint permits a new prediction', async () => {
    storage.loadJson.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));
    await run();
    expect(replicate.submit).toHaveBeenCalledTimes(1);
  });
  test('a saved prediction is polled without submitting again', async () => {
    storage.loadJson.mockResolvedValue({ jobId: 'paid-job' });
    await run();
    expect(replicate.submit).not.toHaveBeenCalled();
    expect(replicate.poll).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'paid-job' }));
  });
  test('an already-cancelled run cannot make a purchase, even with forceNew', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(run({ signal: controller.signal, ctx: { abortSignal: controller.signal }, forceNew: true }))
      .rejects.toMatchObject({ failureCode: 'cancelled' });
    expect(replicate.submit).not.toHaveBeenCalled();
  });
  test('cancellation while reading the checkpoint prevents submission', async () => {
    const controller = new AbortController();
    storage.loadJson.mockImplementation(async () => { controller.abort(); return null; });
    await expect(run({ signal: controller.signal, ctx: { abortSignal: controller.signal } }))
      .rejects.toMatchObject({ failureCode: 'cancelled' });
    expect(replicate.submit).not.toHaveBeenCalled();
  });
});

test('resuming lip sync does not rewrite its existing input objects', async () => {
  storage.loadJson.mockResolvedValue({ jobId: 'paid-job' });
  await dialogue();
  expect(storage.uploadBuffer).toHaveBeenCalledTimes(1);
  expect(storage.uploadBuffer.mock.calls[0][2]).toBe('video/mp4');
});

test('a resumed corrected prediction keeps its actual tier and repair diagnostics', async () => {
  const inputRepairs = [{ field: 'mode', from: 'std', to: null }];
  storage.loadJson.mockResolvedValue({ jobId: 'paid-job', inputRepairs, endFrameDropped: true });
  const costTracker = { addVideoSeconds: jest.fn() };
  const result = await animation({ quality: 'std', costTracker });
  expect(result.candidates[0]).toMatchObject({ inputRepairs, endFrameDropped: true });
  expect(costTracker.addVideoSeconds).toHaveBeenCalledWith('kwaivgi/kling-v3-omni-video', 4);
  expect(replicate.submit).not.toHaveBeenCalled();
});

test('new predictions save their accepted input corrections for the next resume', async () => {
  replicate.submit.mockRejectedValueOnce(Object.assign(new Error('unknown field'), {
    failureCode: 'video_provider_input_rejected', inputIssues: [{ field: 'mode', unknown: true, detail: 'unknown field' }],
  }));
  await animation({ quality: 'std' });
  expect(storage.saveJson).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'new-job',
    inputRepairs: [expect.objectContaining({ field: 'mode', to: null })], endFrameDropped: false }), expect.any(String));
});
