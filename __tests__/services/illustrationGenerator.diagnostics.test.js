/**
 * Render-failure diagnostics: a Gemini response with no image part must
 * surface WHY — finishReason / blockReason, elevated safety ratings, and the
 * model's own refusal text — through the caller-owned attemptLog and on the
 * final thrown error, so probe failures are actionable for the admin.
 */

process.env.GEMINI_API_KEY = 'test-gemini-key';

jest.mock('../../services/gcsStorage', () => ({
  uploadBuffer: jest.fn(),
  uploadFromUrl: jest.fn(),
  downloadBuffer: jest.fn(),
  getSignedUrl: jest.fn(),
}));

const { generateIllustration } = require('../../services/illustrationGenerator');

const NO_IMAGE_BODY = {
  candidates: [{
    finishReason: 'IMAGE_SAFETY',
    content: { parts: [{ text: 'I cannot generate this image because the scene shows a child underwater without supervision.' }] },
    safetyRatings: [
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'MEDIUM' },
      { category: 'HARM_CATEGORY_HARASSMENT', probability: 'NEGLIGIBLE' },
    ],
  }],
};

let realFetch;
beforeEach(() => {
  realFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => NO_IMAGE_BODY,
    text: async () => JSON.stringify(NO_IMAGE_BODY),
  });
});
afterEach(() => { global.fetch = realFetch; });

test('every failed attempt is logged with the Gemini finish reason, safety signal, and refusal text', async () => {
  const attemptLog = [];
  await expect(generateIllustration('a reef scene', null, 'pixar_premium', {
    bookId: 'diag-book',
    attemptLog,
    skipTextEmbed: true,
    childPhotoUrl: 'https://photos.example/child.png',
    _cachedPhotoBase64: 'aaaa',
    _cachedPhotoMime: 'image/png',
  })).rejects.toMatchObject({
    message: expect.stringContaining('No image in Gemini response'),
    attempts: expect.any(Array),
  });

  expect(attemptLog.length).toBeGreaterThan(0);
  expect(attemptLog[0]).toMatchObject({
    attempt: 1,
    error: expect.stringContaining('No image in Gemini response'),
    finishReason: 'IMAGE_SAFETY',
    modelText: expect.stringContaining('cannot generate this image'),
    safety: ['HARM_CATEGORY_DANGEROUS_CONTENT: MEDIUM'],
  });
  // NEGLIGIBLE ratings are noise, never diagnostics.
  expect(attemptLog[0].safety).not.toContain('HARM_CATEGORY_HARASSMENT: NEGLIGIBLE');
});
