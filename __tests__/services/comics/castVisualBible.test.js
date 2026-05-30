process.env.GEMINI_API_KEY = 'test-gemini-key';

jest.mock('../../../services/gcsStorage', () => ({
  uploadBuffer: jest.fn(),
  downloadBuffer: jest.fn(),
  saveJson: jest.fn(),
  loadJson: jest.fn(),
}));
jest.mock('../../../services/retry', () => ({
  withRetry: jest.fn((fn) => fn()),
}));

const {
  uploadBuffer, downloadBuffer, saveJson, loadJson,
} = require('../../../services/gcsStorage');
const { generateCharacterRefSheet, __private } = require('../../../services/comics/castVisualBible');

describe('castVisualBible', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    uploadBuffer.mockReset().mockResolvedValue('https://storage.googleapis.com/test-bucket/comics/comic-1/refsheets/char-1.png');
    downloadBuffer.mockReset().mockResolvedValue(Buffer.from('face-image'));
    saveJson.mockReset().mockResolvedValue(undefined);
    loadJson.mockReset().mockRejectedValue(new Error('not found'));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('computeCacheKey ignores signed URL query params', () => {
    const keyA = __private.computeCacheKey(
      'https://storage.googleapis.com/test-bucket/comics/comic-1/faces/abc.jpg?X-Goog-Date=1&X-Goog-Signature=foo',
      'noir'
    );
    const keyB = __private.computeCacheKey(
      'https://storage.googleapis.com/test-bucket/comics/comic-1/faces/abc.jpg?X-Goog-Date=2&X-Goog-Signature=bar',
      'noir'
    );

    expect(keyA).toBe(keyB);
  });

  test('fetchWithTimeout surfaces descriptive timeout error', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    global.fetch = jest.fn().mockRejectedValue(abortErr);

    await expect(__private.fetchWithTimeout('https://example.com', {}, 123))
      .rejects
      .toThrow('Request timed out after 123ms');
  });

  test('buildRefSheetPrompt leads with identity-first likeness language', () => {
    const prompt = __private.buildRefSheetPrompt({ visualLocks: { face: 'oval face' } });
    expect(prompt).toMatch(/recognizable as the EXACT person/);
    expect(prompt).toMatch(/PRESERVE THE EXACT FACIAL GEOMETRY/);
    expect(prompt).toMatch(/Likeness is the #1 priority/);
    expect(prompt).toMatch(/semi-realistic/);
    // Likeness-maximizing softening: no hard photoreal ban, no cel-shading mandate.
    expect(prompt).not.toMatch(/NOT photorealistic/);
    expect(prompt).not.toMatch(/cel shad/i);
  });

  test('skips cache save when visualLocks soft-fail to empty object', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'not-json' }] } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{
            content: { parts: [{ inlineData: { data: Buffer.from('png').toString('base64') } }] },
          }],
        }),
      });

    const result = await generateCharacterRefSheet({
      comicId: 'comic-1',
      characterId: 'char-1',
      faceCropUrl: 'https://storage.googleapis.com/test-bucket/comics/comic-1/faces/abc.jpg',
    });

    expect(result.refSheetUrl).toContain('/refsheets/char-1.png');
    expect(result.visualLocks).toEqual({});
    expect(saveJson).not.toHaveBeenCalled();
  });
});
