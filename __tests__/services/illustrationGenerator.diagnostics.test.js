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

const baseOpts = (attemptLog) => ({
  bookId: 'diag-book',
  attemptLog,
  skipTextEmbed: true,
  childPhotoUrl: 'https://photos.example/child.png',
  _cachedPhotoBase64: 'aaaa',
  _cachedPhotoMime: 'image/png',
});

test('a safety-flagged no-image response rides the prompt-variant ladder and logs every step', async () => {
  const attemptLog = [];
  // isNsfw advances the variant ladder (original → sanitized → generic-safe)
  // instead of retrying the identical prompt; exhaustion returns null.
  const result = await generateIllustration('a reef scene', null, 'pixar_premium', baseOpts(attemptLog));
  expect(result).toBeNull();
  expect(attemptLog.map(a => a.variant)).toEqual(['original', 'sanitized', 'generic-safe']);
  expect(attemptLog.every(a => a.nsfw === true)).toBe(true);
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

test('a non-safety no-image response keeps the retry-then-throw contract, attempts attached', async () => {
  const body = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'no image produced' }] } }] };
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
  const attemptLog = [];
  await expect(generateIllustration('a reef scene', null, 'pixar_premium', baseOpts(attemptLog)))
    .rejects.toMatchObject({
      message: expect.stringContaining('No image in Gemini response'),
      attempts: expect.any(Array),
    });
  expect(attemptLog).toHaveLength(3); // BASE_MAX_RETRIES, same variant
  expect(attemptLog.every(a => a.variant === 'original' && !a.nsfw)).toBe(true);
  expect(attemptLog[0].finishReason).toBe('STOP');
});
