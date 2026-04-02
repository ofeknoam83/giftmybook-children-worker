jest.mock('../../services/replicateClient');
jest.mock('../../services/faceEngine', () => ({
  verifyFaceConsistency: jest.fn().mockResolvedValue(0.8),
}));
jest.mock('../../services/gcsStorage', () => ({
  uploadFromUrl: jest.fn().mockResolvedValue('https://storage.example.com/illustration.png'),
}));

const { generateIllustration, buildCharacterPrompt } = require('../../services/illustrationGenerator');
const { runModel } = require('../../services/replicateClient');
const { uploadFromUrl } = require('../../services/gcsStorage');

describe('buildCharacterPrompt', () => {
  test('includes safety anchors', () => {
    const prompt = buildCharacterPrompt('A child in a garden', 'watercolor');
    expect(prompt).toContain("children's book illustration");
    expect(prompt).toContain('non-realistic');
    expect(prompt).toContain('fully clothed');
    expect(prompt).toContain('family-friendly');
  });

  test('includes child name when provided', () => {
    const prompt = buildCharacterPrompt('scene', 'watercolor', null, 'Emma');
    expect(prompt).toContain('Emma');
  });

  test('includes appearance description when provided', () => {
    const prompt = buildCharacterPrompt('scene', 'watercolor', 'curly brown hair', null);
    expect(prompt).toContain('curly brown hair');
  });

  test('falls back to watercolor style for unknown styles', () => {
    const prompt = buildCharacterPrompt('scene', 'oil_painting');
    expect(prompt).toContain('watercolor');
  });
});

describe('generateIllustration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns GCS URL on success with bookId', async () => {
    runModel.mockResolvedValue(['https://replicate.com/output.png']);

    const result = await generateIllustration(
      'A child playing',
      'https://ref.example.com/ref.png',
      'watercolor',
      { embedding: null },
      { bookId: 'test-book' }
    );

    expect(result).toBe('https://storage.example.com/illustration.png');
    expect(runModel).toHaveBeenCalledTimes(1);
    expect(uploadFromUrl).toHaveBeenCalledTimes(1);
  });

  test('returns Replicate URL when no bookId', async () => {
    runModel.mockResolvedValue(['https://replicate.com/output.png']);

    const result = await generateIllustration(
      'A child playing',
      null,
      'watercolor',
      { embedding: null },
      {}
    );

    expect(result).toBe('https://replicate.com/output.png');
    expect(uploadFromUrl).not.toHaveBeenCalled();
  });

  test('falls back to sanitized prompt on NSFW', async () => {
    const nsfwErr = new Error('NSFW content detected');
    nsfwErr.isNsfw = true;

    runModel
      .mockRejectedValueOnce(nsfwErr) // original with char ref → drop char ref
      .mockRejectedValueOnce(nsfwErr) // original without char ref → advance to sanitized
      .mockResolvedValue(['https://replicate.com/safe.png']); // sanitized succeeds

    const result = await generateIllustration(
      'A child bathing',
      'https://ref.example.com/ref.png',
      'watercolor',
      { embedding: null },
      {}
    );

    expect(result).toBe('https://replicate.com/safe.png');
    expect(runModel).toHaveBeenCalledTimes(3);
  });

  test('returns null when all NSFW variants exhausted', async () => {
    const nsfwErr = new Error('NSFW content detected');
    nsfwErr.isNsfw = true;

    runModel.mockRejectedValue(nsfwErr);

    const result = await generateIllustration(
      'problematic scene',
      null,
      'watercolor',
      { embedding: null },
      {}
    );

    // Should return null after exhausting all prompt variants
    expect(result).toBeNull();
  });

  test('throws after max retries on non-NSFW errors', async () => {
    runModel.mockRejectedValue(new Error('API timeout'));

    await expect(
      generateIllustration('scene', null, 'watercolor', { embedding: null }, {})
    ).rejects.toThrow('Illustration generation failed after 3 attempts');
  });

  test('tracks cost when costTracker provided', async () => {
    runModel.mockResolvedValue(['https://replicate.com/output.png']);
    const costTracker = { addImageGeneration: jest.fn() };

    await generateIllustration('scene', null, 'watercolor', { embedding: null }, { costTracker });

    expect(costTracker.addImageGeneration).toHaveBeenCalledWith('flux-dev', 1);
  });
});
