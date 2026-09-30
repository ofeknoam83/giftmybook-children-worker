/**
 * The fast, display-only preview spread (2026-09-30): ONE text-free render
 * anchored on the cover, stored outside the book's render cache.
 */
jest.mock('../../../services/illustrationGenerator', () => ({
  generateIllustration: jest.fn(),
  downloadPhotoAsBase64: jest.fn(async () => ({ base64: 'Y292ZXI=', mimeType: 'image/png' })),
  isModestBathWaterScene: jest.fn(() => false),
}));
jest.mock('../../../services/gcsStorage', () => ({
  getSignedUrl: jest.fn(async (key) => `https://signed.example/${key}`),
  downloadBuffer: jest.fn(),
  uploadBuffer: jest.fn(),
}));

const { generateIllustration, downloadPhotoAsBase64 } = require('../../../services/illustrationGenerator');
const { renderPreviewSpread, PREVIEW_COMPOSITION } = require('../../../services/catalogEngine/illustrator/previewSpread');
const { getBook } = require('../../../services/catalogEngine/catalog');

const BOOK_ID = 'farm_2_3_hello_farm';
const params = (over = {}) => ({
  bookId: 'book-prev-1',
  story: { book_id: BOOK_ID, spreads: [{ spread: 1, text: 'Emma waves hello to the farm.' }], personalization_evidence: [] },
  bookDef: getBook(BOOK_ID),
  profile: { name: 'Emma', age: 2, pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' } },
  approvedCoverUrl: 'https://storage.example/cover.png',
  childPhotoUrl: 'https://storage.example/photo.png',
  ...over,
});

beforeEach(() => {
  generateIllustration.mockReset().mockResolvedValue('https://storage.example/uploaded.png');
  downloadPhotoAsBase64.mockClear();
});

test('one text-free 16:9 render anchored on the cover, off the book render cache', async () => {
  const out = await renderPreviewSpread(params());
  expect(generateIllustration).toHaveBeenCalledTimes(1);
  const [scene, anchor, , opts] = generateIllustration.mock.calls[0];
  expect(anchor).toBe('https://storage.example/cover.png');
  expect(scene).toContain(PREVIEW_COMPOSITION);
  expect(scene).toContain('NEVER paint these words');
  expect(opts).toMatchObject({ aspectRatio: '16:9', isSpread: true, skipTextEmbed: true, childName: 'Emma' });
  expect(opts.embedText).toBeUndefined();
  expect(opts.imageSize).toBeUndefined();
  expect(opts.referencePack).toBeUndefined();
  expect(opts.gcsPath).toMatch(/^children-jobs\/book-prev-1\/preview-spread\/spread-1-/);
  expect(opts.gcsPath).not.toContain('ce-renders');
  expect(out.results).toEqual([expect.objectContaining({ spread: 1, buffer: true, url: expect.stringContaining('https://signed.example/children-jobs/book-prev-1/preview-spread/') })]);
  expect(out.timings).toEqual(expect.objectContaining({ renderMs: expect.any(Number) }));
});

test('no image → a failed result (never a throw), with the attempt detail', async () => {
  generateIllustration.mockImplementation(async (_s, _a, _st, opts) => { opts.attemptLog.push({ attempt: 1, error: 'IMAGE_SAFETY' }); return null; });
  const out = await renderPreviewSpread(params());
  expect(out.results[0]).toMatchObject({ spread: 1, buffer: null, url: null });
  expect(out.results[0].advisories[0].detail.attempts[0]).toMatchObject({ error: 'IMAGE_SAFETY' });
});

test('an unreadable anchor fails missing_identity_reference', async () => {
  downloadPhotoAsBase64.mockRejectedValueOnce(new Error('403'));
  await expect(renderPreviewSpread(params())).rejects.toMatchObject({ failureCode: 'missing_identity_reference' });
});
