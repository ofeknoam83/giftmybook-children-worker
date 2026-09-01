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
  illustrationGenerator.fetchWithTimeout.mockResolvedValue(geminiPlateResponse);
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
  expect(illustrationGenerator.fetchWithTimeout).toHaveBeenCalledTimes(2);
});

test('a persisted plate IS cached — the third resolve makes no further IO', async () => {
  const { getWorldPlate, gcs, illustrationGenerator } = freshWorldPlate();
  gcs.downloadBuffer.mockRejectedValue(new Error('cache miss'));
  gcs.uploadBufferIfAbsent.mockResolvedValue({ created: true });
  await getWorldPlate({ theme: THEME, log: () => {} });
  await getWorldPlate({ theme: THEME, log: () => {} });
  expect(illustrationGenerator.fetchWithTimeout).toHaveBeenCalledTimes(1);
  expect(gcs.downloadBuffer).toHaveBeenCalledTimes(1);
});
