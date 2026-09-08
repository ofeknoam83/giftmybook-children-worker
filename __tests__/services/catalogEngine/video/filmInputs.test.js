const sharp = require('sharp');
jest.mock('../../../../services/gcsStorage', () => ({
  loadJson: jest.fn(), downloadBuffer: jest.fn(), uploadBufferIfAbsent: jest.fn(), uploadBuffer: jest.fn(),
}));
jest.mock('../../../../services/illustrationGenerator', () => ({ callGeminiImageParts: jest.fn(), GEMINI_MODEL: 'image-model' }));
const storage = require('../../../../services/gcsStorage');
const { callGeminiImageParts } = require('../../../../services/illustrationGenerator');
const { anchorHash } = require('../../../../services/catalogEngine/illustrator/bible');
const { loadFilmBible, prepareFilmStill } = require('../../../../services/catalogEngine/video/filmInputs');
const { selectFilmReferenceSheets } = require('../../../../services/catalogEngine/video/filmReferences');

let image;
let saved;
const bookId = 'film-inputs';
const anchorUrl = 'https://example.com/cover.jpg';
const entry = { spread: 6, embedded: true, storageKey: `children-jobs/${bookId}/ce-renders/v/h/spread-6.wide.png` };
beforeEach(async () => {
  jest.resetAllMocks();
  image = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#334455' } }).png().toBuffer();
  saved = new Map([[entry.storageKey, image]]);
  storage.downloadBuffer.mockImplementation(async key => {
    if (!saved.has(key)) throw Object.assign(new Error('Not found'), { code: 404 });
    return saved.get(key);
  });
  storage.uploadBufferIfAbsent.mockImplementation(async (buffer, key) => {
    if (saved.has(key)) return { created: false };
    saved.set(key, buffer); return { created: true };
  });
  storage.uploadBuffer.mockImplementation(async (buffer, key) => { saved.set(key, buffer); return key; });
  callGeminiImageParts.mockResolvedValue(image);
});

test('loads saved essential references, retaining unknown story props, without loading decorative props', async () => {
  const manifest = { anchorHash: anchorHash(anchorUrl), bibleHash: 'saved',
    characterSheet: { key: 'catalog-assets/character.png' }, companion: { key: 'catalog-assets/companion.png' },
    props: [
      { value: 'Story object: bell', key: 'catalog-assets/bell.png' },
      { value: 'Story object: unknown', key: 'catalog-assets/unknown.png' },
      { value: 'Story object: leaf', key: 'catalog-assets/leaf.png' },
      { value: 'DJ Controller', key: 'catalog-assets/dj.png' },
    ], storyObjects: { objects: [{ id: 'bell', name: 'bell', critical: true }, { id: 'leaf', name: 'leaf', critical: false }] } };
  storage.loadJson.mockResolvedValue(manifest);
  for (const name of ['character', 'companion', 'bell', 'unknown']) saved.set(`catalog-assets/${name}.png`, image);
  const bible = await loadFilmBible({ bookId, anchorUrl });
  const selected = selectFilmReferenceSheets(bible);
  expect(selected.sheets).toHaveLength(4);
  expect(selected.omittedProps).toEqual(['Story object: leaf', 'DJ Controller']);
  expect(storage.downloadBuffer).toHaveBeenCalledTimes(4);
  expect(callGeminiImageParts).not.toHaveBeenCalled();
  expect(storage.uploadBuffer).not.toHaveBeenCalled();
});

test('does not send a different cover identity or cross-book reference to a provider', async () => {
  storage.loadJson.mockResolvedValue({ anchorHash: 'old', characterSheet: { key: 'catalog-assets/character.png' } });
  await expect(loadFilmBible({ bookId, anchorUrl })).rejects.toMatchObject({ failureCode: 'identity_kit_failed' });
  storage.loadJson.mockResolvedValue({ anchorHash: anchorHash(anchorUrl), characterSheet: { key: 'children-jobs/other/sheet.png' } });
  await expect(loadFilmBible({ bookId, anchorUrl })).rejects.toMatchObject({ failureCode: 'video_source_missing' });
  expect(callGeminiImageParts).not.toHaveBeenCalled();
});

test('reuses plain source pixels and caches embedded-text removal without changing the book', async () => {
  const plain = await prepareFilmStill({ bookId, entry: { ...entry, embedded: false } });
  expect(plain.buffer).toEqual(image);
  expect(callGeminiImageParts).not.toHaveBeenCalled();
  const costTracker = { addImageGeneration: jest.fn(), recordReuse: jest.fn() };
  const first = await prepareFilmStill({ bookId, entry, costTracker });
  const second = await prepareFilmStill({ bookId, entry, costTracker });
  expect(second.buffer).toEqual(first.buffer);
  expect(callGeminiImageParts).toHaveBeenCalledTimes(1);
  expect(costTracker.addImageGeneration).toHaveBeenCalledTimes(1);
  expect(first.storageKey).toContain('/gift-video/inputs/gfi-1/');
  expect(storage.uploadBuffer.mock.calls.every(([, key]) => key !== entry.storageKey)).toBe(true);
  saved.set(entry.storageKey, await sharp(image).negate().png().toBuffer());
  const changed = await prepareFilmStill({ bookId, entry });
  expect(changed.storageKey).not.toBe(first.storageKey);
  expect(callGeminiImageParts).toHaveBeenCalledTimes(2);
});

test('retains an image-provider refusal on retry without changing prompts or routing providers', async () => {
  callGeminiImageParts.mockRejectedValue(Object.assign(new Error('blocked'), { isNsfw: true }));
  for (let retry = 0; retry < 2; retry++) {
    await expect(prepareFilmStill({ bookId, entry })).rejects.toMatchObject({ recovery: { reason: 'provider_blocked', retryable: false } });
  }
  expect(callGeminiImageParts).toHaveBeenCalledTimes(1);
});
