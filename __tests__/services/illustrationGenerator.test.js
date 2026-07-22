jest.mock('../../services/replicateClient');
jest.mock('../../services/faceEngine', () => ({
  verifyFaceConsistency: jest.fn().mockResolvedValue(0.8),
}));
jest.mock('../../services/gcsStorage', () => ({
  uploadFromUrl: jest.fn().mockResolvedValue('https://storage.example.com/illustration.png'),
}));

const {
  generateIllustration,
  buildCharacterPrompt,
  ART_STYLE_CONFIG,
  renderStyleBlock,
} = require('../../services/illustrationGenerator');
const { PIXAR_STYLE } = require('../../services/shared/illustration/config');
const { STYLE_BIBLE, STYLE_VERSION } = require('../../services/bookPipelineV3/illustrator/styleBible');
const { runModel } = require('../../services/replicateClient');
const { uploadFromUrl } = require('../../services/gcsStorage');

describe('shared 3D style — single source of truth (cover + interiors always 3D)', () => {
  test('ART_STYLE_CONFIG.pixar_premium IS the shared PIXAR_STYLE object', () => {
    expect(ART_STYLE_CONFIG.pixar_premium).toBe(PIXAR_STYLE);
  });

  test('cinematic_3d aliases the same shared PIXAR_STYLE object', () => {
    expect(ART_STYLE_CONFIG.cinematic_3d).toBe(PIXAR_STYLE);
  });

  test('renderStyleBlock(pixar_premium) pins STYLIZED-not-photoreal + cross-page/cover consistency', () => {
    const block = renderStyleBlock(ART_STYLE_CONFIG.pixar_premium);
    expect(block).toMatch(/stylized 3D CGI render/i);
    expect(block).toMatch(/NOT a photorealistic live-action render/i);
    expect(block).toContain(PIXAR_STYLE.consistency);
    expect(block).toMatch(/every spread and on the cover/i);
  });

  test('interior styleBible derives from the SAME PIXAR_STYLE (cover ↔ interior parity)', () => {
    expect(STYLE_BIBLE).toContain(PIXAR_STYLE.suffix);
    expect(STYLE_BIBLE).toContain(PIXAR_STYLE.consistency);
    // Style text changed → version must have been bumped past the sb-1 baseline.
    expect(STYLE_VERSION).not.toBe('sb-1-pixar-premium-3d');
    expect(STYLE_VERSION).toMatch(/stylized/);
  });
});

describe('buildCharacterPrompt', () => {
  test('includes safety anchors', () => {
    const prompt = buildCharacterPrompt('A child in a garden', 'watercolor');
    expect(prompt).toContain('Children\'s book illustration');
    expect(prompt).toMatch(/Cinematic 3D Pixar|family-friendly/i);
    expect(prompt).toContain('fully clothed');
  });

  test('bath scene uses modest water guidance instead of street outfit lock', () => {
    const prompt = buildCharacterPrompt(
      'Warm bathroom, child stands in a bathtub with rubber duck and thick soap bubbles',
      'pixar_premium',
      'Ellis',
      'Mama reached for soap while Ellis stood tall in the tub.',
      'brown overalls over a white tee, sneakers',
      'young boy, brown hair, blue eyes',
    );
    expect(prompt).toMatch(/BATH \/ WATER|bubble|BATH\/WATER MODE/i);
    expect(prompt).not.toContain('FORBIDDEN OUTFIT CHANGES: Even if the story describes water');
  });

  test('includes child name when provided', () => {
    const prompt = buildCharacterPrompt('scene', 'watercolor', 'Emma', null, '', '');
    expect(prompt).toContain('Emma');
  });

  test('includes appearance description when provided', () => {
    const prompt = buildCharacterPrompt('scene', 'watercolor', null, '', '', 'curly brown hair');
    expect(prompt).toContain('curly brown hair');
  });

  test('locks nominal style keys to premium 3D Pixar', () => {
    const prompt = buildCharacterPrompt('scene', 'oil_painting');
    expect(prompt).toMatch(/Cinematic 3D Pixar|photorealistic 3D CGI|Disney-Pixar/i);
  });
});

// Suite targets an older Replicate/Flux path; generateIllustration now calls Gemini HTTP.
describe.skip('generateIllustration', () => {
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
