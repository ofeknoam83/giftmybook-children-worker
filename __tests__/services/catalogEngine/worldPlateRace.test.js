/**
 * getWorldPlate creation-race semantics: once ANOTHER instance is known to
 * have won the create-if-absent race, local bytes are never acceptable — a
 * failed winner download renders plate-less rather than forking the world.
 * An upload failure BEFORE learning of a winner keeps the local plate
 * best-effort but never caches it.
 */

jest.mock('../../../services/illustrationGenerator', () => ({
  getNextApiKey: jest.fn(() => 'test-key'),
  GEMINI_MODEL: 'test-image-model',
  fetchWithTimeout: jest.fn(),
  renderStyleBlock: jest.fn(() => 'STYLE BLOCK'),
}));
jest.mock('../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(),
  uploadBufferIfAbsent: jest.fn(),
}));

const THEME = { theme_id: 'farm', display_name: 'Farm', world_name: 'Sunnybrook Farm' };
const LOCAL_PLATE = Buffer.from('local-plate-bytes');

const geminiPlateResponse = {
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: LOCAL_PLATE.toString('base64') } }] } }] }),
};
const plateQaVerdict = v => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(v) }] } }] }),
});
const CLEAN_PLATE_VERDICT = { people_or_characters: false, subject_creatures: false, readable_text: false };
/** Calls to the image-generation model only (the plate QA hits the vision model). */
const genCalls = fetchMock => fetchMock.mock.calls.filter(c => c[0].includes('test-image-model'));

/** Fresh module state per test — the plate/in-flight memos are module-level. */
function freshWorldPlate() {
  jest.resetModules();
  jest.mock('../../../services/illustrationGenerator', () => ({
    getNextApiKey: jest.fn(() => 'test-key'),
    GEMINI_MODEL: 'test-image-model',
    fetchWithTimeout: jest.fn(),
    renderStyleBlock: jest.fn(() => 'STYLE BLOCK'),
  }));
  jest.mock('../../../services/gcsStorage', () => ({
    downloadBuffer: jest.fn(),
    uploadBufferIfAbsent: jest.fn(),
  }));
  const illustrationGenerator = require('../../../services/illustrationGenerator');
  const gcs = require('../../../services/gcsStorage');
  const { getWorldPlate } = require('../../../services/catalogEngine/illustrator/worldPlate');
  // Default transport: the image model returns the local plate; the plate
  // content check returns a clean verdict.
  illustrationGenerator.fetchWithTimeout.mockImplementation(async url => (
    url.includes('test-image-model') ? geminiPlateResponse : plateQaVerdict(CLEAN_PLATE_VERDICT)
  ));
  return { getWorldPlate, gcs, illustrationGenerator };
}

test('losing the race and failing to fetch the winner renders plate-less — never divergent local bytes', async () => {
  const { getWorldPlate, gcs } = freshWorldPlate();
  gcs.downloadBuffer
    .mockRejectedValueOnce(new Error('cache miss')) // initial GCS check
    .mockRejectedValueOnce(new Error('transient 503')); // winner download
  gcs.uploadBufferIfAbsent.mockResolvedValue({ created: false }); // lost the race
  await expect(getWorldPlate({ theme: THEME, log: () => {} })).resolves.toBeNull();
});

test('losing the race adopts the winning bytes, not the locally generated plate', async () => {
  const { getWorldPlate, gcs } = freshWorldPlate();
  const WINNER = Buffer.from('winning-plate-bytes');
  gcs.downloadBuffer
    .mockRejectedValueOnce(new Error('cache miss'))
    .mockResolvedValueOnce(WINNER);
  gcs.uploadBufferIfAbsent.mockResolvedValue({ created: false });
  const plate = await getWorldPlate({ theme: THEME, log: () => {} });
  expect(plate.base64).toBe(WINNER.toString('base64'));
});

test('an upload failure with no known winner keeps the local plate but never caches it', async () => {
  const { getWorldPlate, gcs, illustrationGenerator } = freshWorldPlate();
  gcs.downloadBuffer.mockRejectedValue(new Error('cache miss'));
  gcs.uploadBufferIfAbsent.mockRejectedValueOnce(new Error('network down'));
  const first = await getWorldPlate({ theme: THEME, log: () => {} });
  expect(first.base64).toBe(LOCAL_PLATE.toString('base64'));
  // Not cached: a second resolve goes back to GCS + generation (here the
  // upload succeeds, so THIS plate is the one that persists and caches).
  gcs.uploadBufferIfAbsent.mockResolvedValue({ created: true });
  await getWorldPlate({ theme: THEME, log: () => {} });
  expect(genCalls(illustrationGenerator.fetchWithTimeout)).toHaveLength(2);
});

test('a persisted plate IS cached — the third resolve makes no further IO', async () => {
  const { getWorldPlate, gcs, illustrationGenerator } = freshWorldPlate();
  gcs.downloadBuffer.mockRejectedValue(new Error('cache miss'));
  gcs.uploadBufferIfAbsent.mockResolvedValue({ created: true });
  await getWorldPlate({ theme: THEME, log: () => {} });
  await getWorldPlate({ theme: THEME, log: () => {} });
  expect(genCalls(illustrationGenerator.fetchWithTimeout)).toHaveLength(1);
  expect(gcs.downloadBuffer).toHaveBeenCalledTimes(1);
});

test('a contaminated plate is retried once, then rejected — never uploaded or cached', async () => {
  const { getWorldPlate, gcs, illustrationGenerator } = freshWorldPlate();
  gcs.downloadBuffer.mockRejectedValue(new Error('cache miss'));
  gcs.uploadBufferIfAbsent.mockResolvedValue({ created: true });
  illustrationGenerator.fetchWithTimeout.mockImplementation(async url => (
    url.includes('test-image-model')
      ? geminiPlateResponse
      : plateQaVerdict({ ...CLEAN_PLATE_VERDICT, people_or_characters: true })
  ));
  await expect(getWorldPlate({ theme: THEME, log: () => {} })).resolves.toBeNull();
  expect(gcs.uploadBufferIfAbsent).not.toHaveBeenCalled();
  expect(genCalls(illustrationGenerator.fetchWithTimeout)).toHaveLength(2); // one corrective retry
});

test('a failed plate resolution is negative-cached — the next book inside the cooldown skips the retry storm', async () => {
  const { getWorldPlate, gcs, illustrationGenerator } = freshWorldPlate();
  gcs.downloadBuffer.mockRejectedValue(new Error('cache miss'));
  gcs.uploadBufferIfAbsent.mockResolvedValue({ created: true });
  illustrationGenerator.fetchWithTimeout.mockImplementation(async url => (
    url.includes('test-image-model')
      ? geminiPlateResponse
      : plateQaVerdict({ ...CLEAN_PLATE_VERDICT, people_or_characters: true })
  ));
  await expect(getWorldPlate({ theme: THEME, log: () => {} })).resolves.toBeNull();
  const gensAfterFirst = genCalls(illustrationGenerator.fetchWithTimeout).length;
  await expect(getWorldPlate({ theme: THEME, log: () => {} })).resolves.toBeNull();
  // No new generation or QA spend inside the cooldown window.
  expect(genCalls(illustrationGenerator.fetchWithTimeout)).toHaveLength(gensAfterFirst);
});

test('a plate that passes the content check on the retry is accepted and persisted', async () => {
  const { getWorldPlate, gcs, illustrationGenerator } = freshWorldPlate();
  gcs.downloadBuffer.mockRejectedValue(new Error('cache miss'));
  gcs.uploadBufferIfAbsent.mockResolvedValue({ created: true });
  let qaCall = 0;
  illustrationGenerator.fetchWithTimeout.mockImplementation(async (url) => {
    if (url.includes('test-image-model')) return geminiPlateResponse;
    qaCall += 1;
    return plateQaVerdict(qaCall === 1 ? { ...CLEAN_PLATE_VERDICT, readable_text: true } : CLEAN_PLATE_VERDICT);
  });
  const plate = await getWorldPlate({ theme: THEME, log: () => {} });
  expect(plate.base64).toBe(LOCAL_PLATE.toString('base64'));
  expect(gcs.uploadBufferIfAbsent).toHaveBeenCalledTimes(1);
});
