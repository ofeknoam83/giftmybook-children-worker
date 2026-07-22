jest.mock('pdf-lib', () => ({
  PDFDocument: { create: jest.fn() },
  rgb: jest.fn(),
  StandardFonts: {},
  degrees: jest.fn(),
}), { virtual: true });
jest.mock('sharp', () => jest.fn(() => ({
  resize: jest.fn().mockReturnThis(),
  toColorspace: jest.fn().mockReturnThis(),
  jpeg: jest.fn().mockReturnThis(),
  png: jest.fn().mockReturnThis(),
  toBuffer: jest.fn().mockResolvedValue(Buffer.from('fake')),
  metadata: jest.fn().mockResolvedValue({ width: 100, height: 100 }),
})), { virtual: true });
jest.mock('p-limit', () => jest.fn(() => (fn) => fn()), { virtual: true });
jest.mock('../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(),
  uploadBuffer: jest.fn(),
  getSignedUrl: jest.fn(),
  uploadFromUrl: jest.fn(),
}));
jest.mock('../../services/illustrationGenerator', () => ({
  ART_STYLE_CONFIG: {
    pixar_premium: { prefix: 'Cinematic 3D Pixar.', suffix: 'PBR materials.', antiStyle: '2D' },
    paper_cutout: { prefix: 'Paper cutout style.', suffix: 'Layered paper textures.' },
    watercolor: { prefix: 'Watercolor style.', suffix: 'Soft wet-on-wet washes.' },
    cinematic_3d: { prefix: '3D render.', suffix: 'Pixar quality.' },
    scandinavian_minimal: { prefix: 'Scandi minimal.', suffix: 'Muted palette.' },
  },
  renderStyleBlock: (cfg) => {
    if (!cfg) return '';
    const positive = `${cfg.prefix || ''} ${cfg.suffix || ''}`.trim();
    return cfg.antiStyle ? `${positive}. AVOID (hard no): ${cfg.antiStyle}.` : positive;
  },
  canonicalBookArtStyle: jest.fn(() => 'pixar_premium'),
  getNextApiKey: jest.fn(() => 'fake-key'),
  fetchWithTimeout: jest.fn(),
}));

const { buildUpsellCoverPrompt, geminiImagePartFromResponsePart, shouldSkipCoverStyleHarmonize, UPSELL_STYLES } = require('../../services/coverGenerator');

describe('buildUpsellCoverPrompt', () => {
  const base = {
    title: 'Luna and the Starlight Bridge',
    childName: 'Luna',
    childAge: 5,
    artStyle: 'watercolor',
  };

  test('male gender produces "boy" and authoritative gender statement', () => {
    const prompt = buildUpsellCoverPrompt(base.title, base.childName, base.childAge, 'male', base.artStyle);
    expect(prompt).toContain('5-year-old boy');
    expect(prompt).toContain('Depict a boy.');
    expect(prompt).not.toContain('girl');
  });

  test('female gender produces "girl" and authoritative gender statement', () => {
    const prompt = buildUpsellCoverPrompt(base.title, base.childName, base.childAge, 'female', base.artStyle);
    expect(prompt).toContain('5-year-old girl');
    expect(prompt).toContain('Depict a girl.');
    expect(prompt).not.toContain('boy');
  });

  test('neutral gender produces "young child" without forced gender cues', () => {
    const prompt = buildUpsellCoverPrompt(base.title, base.childName, base.childAge, 'neutral', base.artStyle);
    expect(prompt).toContain('young child');
    expect(prompt).toContain('without inventing gendered cues');
  });

  test('includes likeness-only reference instructions', () => {
    const prompt = buildUpsellCoverPrompt(base.title, base.childName, base.childAge, 'female', base.artStyle);
    expect(prompt).toContain('ONLY a character-likeness reference');
    expect(prompt).toContain('Do NOT copy the composition');
  });

  test('includes multi-figure guard', () => {
    const prompt = buildUpsellCoverPrompt(base.title, base.childName, base.childAge, 'male', base.artStyle);
    expect(prompt).toContain('ONLY depict Luna');
    expect(prompt).toContain('Do NOT include siblings');
  });

  test('locks upsell prompts to canonical 3D Pixar style block', () => {
    const prompt = buildUpsellCoverPrompt(base.title, base.childName, base.childAge, 'female', 'watercolor');
    expect(prompt).toContain('Cinematic 3D Pixar.');
    expect(prompt).toContain('PBR materials.');
    expect(prompt).not.toContain('Watercolor style.');
  });

  test('includes title and branding', () => {
    const prompt = buildUpsellCoverPrompt(base.title, base.childName, base.childAge, 'female', base.artStyle);
    expect(prompt).toContain('"Luna and the Starlight Bridge"');
    expect(prompt).toContain('By GiftMyBook');
  });

  test('appends characterDescription when provided', () => {
    const prompt = buildUpsellCoverPrompt(base.title, base.childName, base.childAge, 'female', base.artStyle, {
      characterDescription: 'Shoulder-length brown curly hair, green eyes',
    });
    expect(prompt).toContain('CHARACTER APPEARANCE LOCK');
    expect(prompt).toContain('Shoulder-length brown curly hair, green eyes');
  });

  test('appends characterAnchor when provided', () => {
    const prompt = buildUpsellCoverPrompt(base.title, base.childName, base.childAge, 'male', base.artStyle, {
      characterAnchor: 'East Asian boy, light skin, round face, dark brown straight hair',
    });
    expect(prompt).toContain('PHYSICAL IDENTITY LOCK');
    expect(prompt).toContain('East Asian boy');
  });

  test('omits lock sections when identity is empty', () => {
    const prompt = buildUpsellCoverPrompt(base.title, base.childName, base.childAge, 'female', base.artStyle, {});
    expect(prompt).not.toContain('CHARACTER APPEARANCE LOCK');
    expect(prompt).not.toContain('PHYSICAL IDENTITY LOCK');
  });
});

describe('geminiImagePartFromResponsePart', () => {
  test('reads camelCase inlineData', () => {
    expect(
      geminiImagePartFromResponsePart({
        inlineData: { mimeType: 'image/jpeg', data: 'eA==' },
      }),
    ).toEqual({ data: 'eA==', mime: 'image/jpeg' });
  });

  test('reads snake_case inline_data and mime_type (Gemini REST JSON)', () => {
    expect(
      geminiImagePartFromResponsePart({
        inline_data: { mime_type: 'image/png', data: 'abc' },
      }),
    ).toEqual({ data: 'abc', mime: 'image/png' });
  });

  test('returns null for text-only part', () => {
    expect(geminiImagePartFromResponsePart({ text: 'hello' })).toBeNull();
  });
});

describe('shouldSkipCoverStyleHarmonize (always-3D lock: skip ONLY for provably-3D sources)', () => {
  // Regression guard for book 497c8b68: the old heuristic skipped harmonize for
  // ANY admin-upload or upsell cover, so 2D covers shipped un-harmonized on top
  // of 3D interiors. These must now HARMONIZE (return false).
  test('false for admin-upload path (arbitrary art — must harmonize to 3D)', () => {
    expect(shouldSkipCoverStyleHarmonize('https://storage.googleapis.com/b/children-covers/90079/admin-upload-1.png'))
      .toBe(false);
  });

  test('false for a plain children-jobs upsell cover (could be 2D — must harmonize)', () => {
    expect(shouldSkipCoverStyleHarmonize('gs://giftmybook-bucket/children-jobs/abc-123/upsell/0/cover.png'))
      .toBe(false);
  });

  test('false for a watercolor-named source (2D — must harmonize)', () => {
    expect(shouldSkipCoverStyleHarmonize('https://cdn/covers/luna-watercolor.png')).toBe(false);
  });

  test('false for a paper_cutout-named source (2D — must harmonize)', () => {
    expect(shouldSkipCoverStyleHarmonize('gs://bucket/x/paper_cutout/cover.jpg')).toBe(false);
  });

  test('true only for a source explicitly marked pixar_premium', () => {
    expect(shouldSkipCoverStyleHarmonize('gs://bucket/covers/abc-pixar_premium-cover.png')).toBe(true);
  });

  test('true for a source explicitly marked cinematic_3d', () => {
    expect(shouldSkipCoverStyleHarmonize('https://cdn/covers/abc/cinematic-3d/cover.png')).toBe(true);
  });

  test('true for a 3d-harmonized marker', () => {
    expect(shouldSkipCoverStyleHarmonize('gs://bucket/x/cover-3d-harmonized.png')).toBe(true);
  });

  test('false for unrelated URL', () => {
    expect(shouldSkipCoverStyleHarmonize('https://example.com/approved-cover.png')).toBe(false);
  });

  test('false for empty', () => {
    expect(shouldSkipCoverStyleHarmonize('')).toBe(false);
  });
});

describe('buildUpsellCoverPrompt — every UPSELL_STYLE resolves to 3D (never 2D)', () => {
  test.each(UPSELL_STYLES)('style "%s" produces the 3D Pixar block, never a 2D style block', (style) => {
    const prompt = buildUpsellCoverPrompt('Luna and the Star', 'Luna', 5, 'female', style);
    expect(prompt).toContain('Cinematic 3D Pixar.');
    expect(prompt).toContain('PBR materials.');
    // No 2D style suffix should ever leak into a cover prompt.
    expect(prompt).not.toContain('Watercolor style.');
    expect(prompt).not.toContain('Paper cutout style.');
    expect(prompt).not.toContain('Scandi minimal.');
  });
});
