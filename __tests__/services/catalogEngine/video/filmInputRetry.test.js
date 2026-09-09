jest.mock('../../../../services/gcsStorage', () => ({ downloadBuffer: jest.fn(), uploadBufferIfAbsent: jest.fn() }));
const storage = require('../../../../services/gcsStorage');
const { digest } = require('../../../../services/shared/llm/visualJudge');
const { grantFilmInputRetry, filmInputAttemptLimit } = require('../../../../services/catalogEngine/video/filmInputRetry');
const identity = { source: 'pixels', version: 'gfi-1' };
const id = digest(identity);
const root = `children-jobs/book-1/gift-video/inputs/gfi-1/${'a'.repeat(24)}`;
const args = { bookId: 'book-1', evidenceKey: root, requestedBy: 'admin@example.com' };
let saved;
beforeEach(() => {
  jest.resetAllMocks(); saved = new Map();
  for (let n = 0; n < 2; n++) {
    saved.set(`${root}/candidate-${n}.json`, Buffer.from(JSON.stringify({ id, at: Date.now() })));
    saved.set(`${root}/candidate-${n}.failure.json`, Buffer.from(JSON.stringify({ recovery: {
      retryable: true, reason: 'verification_unavailable', issues: [{ status: 'transient' }],
    } })));
  }
  storage.downloadBuffer.mockImplementation(async key => {
    if (!saved.has(key)) throw Object.assign(new Error('Not found'), { code: 404 });
    return saved.get(key);
  });
  storage.uploadBufferIfAbsent.mockImplementation(async (bytes, key) => {
    if (saved.has(key)) return { created: false };
    saved.set(key, bytes); return { created: true };
  });
});
test('only an immutable matching grant increases this input limit from two to three', async () => {
  expect(await filmInputAttemptLimit(root, identity)).toBe(2);
  await grantFilmInputRetry(args);
  const first = saved.get(`${root}/manual-retry.json`);
  await grantFilmInputRetry({ ...args, requestedBy: 'second-admin@example.com' });
  expect(saved.get(`${root}/manual-retry.json`)).toEqual(first);
  expect(await filmInputAttemptLimit(root, identity)).toBe(3);
  expect(JSON.parse(first)).toMatchObject({ id, limit: 3, requestedBy: args.requestedBy });
  await expect(filmInputAttemptLimit(root, { source: 'other pixels' })).rejects.toHaveProperty('recovery');
});
test.each(['provider_blocked', 'configuration', 'confirmed_defect', 'cancelled'])('never overrides a %s failure', async status => {
  saved.set(`${root}/candidate-0.failure.json`, Buffer.from(JSON.stringify({ recovery: { retryable: true, reason: 'verification_unavailable', issues: [{ status }] } })));
  await expect(grantFilmInputRetry(args)).rejects.toMatchObject({ status: 409 });
  expect(storage.uploadBufferIfAbsent).not.toHaveBeenCalled();
});
test.each(['missing failure', 'missing claim', 'different identity', 'image exists', 'provider detail'])('refuses ambiguous or completed work: %s', async condition => {
  if (condition === 'missing failure') saved.delete(`${root}/candidate-0.failure.json`);
  if (condition === 'missing claim') saved.delete(`${root}/candidate-0.json`);
  if (condition === 'different identity') saved.set(`${root}/candidate-0.json`, Buffer.from(JSON.stringify({ id: 'b'.repeat(64) })));
  if (condition === 'image exists') saved.set(`${root}/candidate-0.png`, Buffer.from('image'));
  if (condition === 'provider detail') saved.set(`${root}/candidate-0.failure.json`, Buffer.from(JSON.stringify({ recovery: { retryable: true, reason: 'verification_unavailable', issues: [{ status: 'transient', promptBlock: 'SAFETY' }] } })));
  await expect(grantFilmInputRetry(args)).rejects.toMatchObject({ status: 409 });
  expect(storage.uploadBufferIfAbsent).not.toHaveBeenCalled();
});
test.each(['children-jobs/other/gift-video/inputs/gfi-1/'+ 'a'.repeat(24), root+'/../other', root.replace('gfi-1', 'gfi-2')])('rejects unrelated or unsupported root %s', async evidenceKey => {
  await expect(grantFilmInputRetry({ ...args, evidenceKey })).rejects.toMatchObject({ status: 400 });
  expect(storage.downloadBuffer).not.toHaveBeenCalled();
});
test('storage errors cannot create an extra allowance or turn into a cache miss', async () => {
  storage.downloadBuffer.mockRejectedValue(Object.assign(new Error('not found in unavailable storage'), { code: 503 }));
  await expect(grantFilmInputRetry(args)).rejects.toThrow();
  await expect(filmInputAttemptLimit(root, identity)).rejects.toHaveProperty('recovery');
  expect(storage.uploadBufferIfAbsent).not.toHaveBeenCalled();
});
