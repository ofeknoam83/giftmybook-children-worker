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
  generateIllustration: jest.fn(),
}));

const {
  buildUpsellCoverPrompt, geminiImagePartFromResponsePart, shouldSkipCoverStyleHarmonize, UPSELL_STYLES,
  qaCoverFlatArtwork, generateFrontCoverImage, FLAT_COVER_ART_RULE, flatCoverArtRepairNote,
} = require('../../services/coverGenerator');
const { fetchWithTimeout, generateIllustration } = require('../../services/illustrationGenerator');
const { downloadBuffer } = require('../../services/gcsStorage');

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

// ── Flat cover artwork (2026-09-07): a cover is the printed surface, never a picture of a book ──

/** One Gemini JSON-QA response as the mocked fetchWithTimeout resolves it. */
const qaResponse = (verdict) => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdict) }] } }] }),
});
const CLEAN_FLAT = { book_mockup: false, framed_artwork: false, photo_surface: false };
const CLEAN_WARDROBE = { flag_on_clothing: false, logo_on_clothing: false, lettering_on_clothing: false };
const CLEAN_ANATOMY = { hand_count: 2, arm_count: 2, extra_or_fused_fingers: false, extra_limb: false };

describe('FLAT_COVER_ART_RULE rides every generated cover prompt', () => {
  test('the upsell prompt forbids a book mockup and never opens with "Book cover for"', () => {
    const prompt = buildUpsellCoverPrompt('Luna and the Star', 'Luna', 5, 'female', 'watercolor');
    expect(prompt).toContain(FLAT_COVER_ART_RULE);
    expect(prompt).toContain('NEVER A PICTURE OF A BOOK');
    expect(prompt).not.toMatch(/^Book cover for/m);
    expect(prompt).toContain('never a picture of a book) for a book titled "Luna and the Star"');
  });

  test('the rule names the concrete drift classes: mockup, pages/spine/shadow, frame/mat/card, background', () => {
    for (const phrase of ['3D book mockup', 'spine', 'cast shadow of a book', 'rounded-corner card', 'mat', 'tabletop', 'all four edges']) {
      expect(FLAT_COVER_ART_RULE).toContain(phrase);
    }
  });

  test('the repair note restates the verdict and the full-bleed demand', () => {
    const note = flatCoverArtRepairNote('depicts a physical book / product mockup');
    expect(note).toMatch(/^CRITICAL COVER FORMAT REPAIR: the previous render depicts a physical book \/ product mockup\./);
    expect(note).toContain('filling the entire image edge to edge');
  });
});

describe('qaCoverFlatArtwork', () => {
  beforeEach(() => { fetchWithTimeout.mockReset(); });

  test('a clean full-bleed cover passes', async () => {
    fetchWithTimeout.mockResolvedValueOnce(qaResponse(CLEAN_FLAT));
    await expect(qaCoverFlatArtwork(Buffer.from('img'))).resolves.toEqual({ pass: true, reason: null });
    const [, init] = fetchWithTimeout.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.contents[0].parts[0].text).toContain('FRONT COVER');
    expect(body.contents[0].parts[1].inline_data.data).toBe(Buffer.from('img').toString('base64'));
  });

  test('a book mockup fails with a reason', async () => {
    fetchWithTimeout.mockResolvedValueOnce(qaResponse({ ...CLEAN_FLAT, book_mockup: true }));
    const v = await qaCoverFlatArtwork(Buffer.from('img'));
    expect(v.pass).toBe(false);
    expect(v.reason).toBe('depicts a physical book / product mockup');
  });

  test('framed / matted artwork fails, and reasons join', async () => {
    fetchWithTimeout.mockResolvedValueOnce(qaResponse({ book_mockup: true, framed_artwork: true, photo_surface: false }));
    const v = await qaCoverFlatArtwork(Buffer.from('img'));
    expect(v.pass).toBe(false);
    expect(v.reason).toContain('inside a frame, mat or card');
    expect(v.reason).toContain(' + ');
  });

  test('fenced JSON is tolerated', async () => {
    fetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '```json\n{"book_mockup": false, "framed_artwork": true, "photo_surface": false}\n```' }] } }] }),
    });
    const v = await qaCoverFlatArtwork(Buffer.from('img'));
    expect(v.pass).toBe(false);
  });

  test('infrastructure failures pass (fail-open): HTTP error, thrown fetch, unparseable answer', async () => {
    fetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(qaCoverFlatArtwork(Buffer.from('img'))).resolves.toEqual({ pass: true, reason: null });
    fetchWithTimeout.mockRejectedValueOnce(new Error('timeout'));
    await expect(qaCoverFlatArtwork(Buffer.from('img'))).resolves.toEqual({ pass: true, reason: null });
    fetchWithTimeout.mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }) });
    await expect(qaCoverFlatArtwork(Buffer.from('img'))).resolves.toEqual({ pass: true, reason: null });
  });
});

describe('generateFrontCoverImage — flat-artwork gate with one hardened retry', () => {
  const child = { childName: 'Luna', childAge: 5 };
  beforeEach(() => {
    fetchWithTimeout.mockReset();
    generateIllustration.mockReset();
    downloadBuffer.mockReset();
    downloadBuffer.mockImplementation(async (url) => Buffer.from(`bytes-of:${url}`));
  });

  test('the scene prompt carries the flat-artwork rule', async () => {
    generateIllustration.mockResolvedValueOnce('https://r/first.png');
    fetchWithTimeout
      .mockResolvedValueOnce(qaResponse(CLEAN_FLAT))
      .mockResolvedValueOnce(qaResponse(CLEAN_WARDROBE))
      .mockResolvedValueOnce(qaResponse(CLEAN_ANATOMY));
    const out = await generateFrontCoverImage(child, 'https://ref/photo.jpg', { bookId: 'b1' });
    expect(generateIllustration).toHaveBeenCalledTimes(1);
    expect(generateIllustration.mock.calls[0][0]).toContain(FLAT_COVER_ART_RULE);
    expect(out).toEqual({
      frontCoverImageUrl: 'https://r/first.png',
      frontCoverBuffer: Buffer.from('bytes-of:https://r/first.png'),
      coverAnatomyAdvisory: null,
      coverArtworkAdvisory: null,
    });
  });

  test('the graphic-novel scene carries it too', async () => {
    generateIllustration.mockResolvedValueOnce('https://r/gn.png');
    fetchWithTimeout
      .mockResolvedValueOnce(qaResponse(CLEAN_FLAT))
      .mockResolvedValueOnce(qaResponse(CLEAN_WARDROBE))
      .mockResolvedValueOnce(qaResponse(CLEAN_ANATOMY));
    await generateFrontCoverImage(child, 'https://ref/photo.jpg', { isGraphicNovel: true });
    expect(generateIllustration.mock.calls[0][0]).toContain(FLAT_COVER_ART_RULE);
  });

  test('a render that depicts a book is re-rendered with the repair note and the clean retry ships', async () => {
    generateIllustration
      .mockResolvedValueOnce('https://r/mockup.png')
      .mockResolvedValueOnce('https://r/flat.png');
    fetchWithTimeout
      .mockResolvedValueOnce(qaResponse({ ...CLEAN_FLAT, book_mockup: true })) // first render: mockup
      .mockResolvedValueOnce(qaResponse(CLEAN_FLAT))                            // retry: flat
      .mockResolvedValueOnce(qaResponse(CLEAN_WARDROBE))
      .mockResolvedValueOnce(qaResponse(CLEAN_ANATOMY));
    const out = await generateFrontCoverImage(child, 'https://ref/photo.jpg', { bookId: 'b1' });
    expect(generateIllustration).toHaveBeenCalledTimes(2);
    const retryScene = generateIllustration.mock.calls[1][0];
    expect(retryScene).toContain('CRITICAL COVER FORMAT REPAIR: the previous render depicts a physical book / product mockup.');
    // The retry keeps the full original scene (identity + rules) in front of the note.
    expect(retryScene.startsWith(generateIllustration.mock.calls[0][0])).toBe(true);
    // Same identity inputs on the retry as on the first render.
    expect(generateIllustration.mock.calls[1].slice(1, 3)).toEqual(generateIllustration.mock.calls[0].slice(1, 3));
    expect(out.frontCoverImageUrl).toBe('https://r/flat.png');
    expect(out.frontCoverBuffer).toEqual(Buffer.from('bytes-of:https://r/flat.png'));
    expect(out.coverArtworkAdvisory).toBeNull();
    // The wardrobe/anatomy reads ran on the ACCEPTED (retry) bytes, not the mockup.
    const wardrobeBody = JSON.parse(fetchWithTimeout.mock.calls[2][1].body);
    expect(wardrobeBody.contents[0].parts[1].inline_data.data).toBe(Buffer.from('bytes-of:https://r/flat.png').toString('base64'));
  });

  test('a retry that still depicts a book keeps the first cover and flags it (ship-and-flag)', async () => {
    generateIllustration
      .mockResolvedValueOnce('https://r/mockup.png')
      .mockResolvedValueOnce('https://r/mockup2.png');
    fetchWithTimeout
      .mockResolvedValueOnce(qaResponse({ ...CLEAN_FLAT, framed_artwork: true }))
      .mockResolvedValueOnce(qaResponse({ ...CLEAN_FLAT, framed_artwork: true }))
      .mockResolvedValueOnce(qaResponse(CLEAN_WARDROBE))
      .mockResolvedValueOnce(qaResponse(CLEAN_ANATOMY));
    const out = await generateFrontCoverImage(child, 'https://ref/photo.jpg', { bookId: 'b1' });
    expect(generateIllustration).toHaveBeenCalledTimes(2);
    expect(out.frontCoverImageUrl).toBe('https://r/mockup.png');
    expect(out.coverArtworkAdvisory).toBe('cover artwork: shows the artwork inside a frame, mat or card instead of filling the image (shipped after 1 retry)');
  });

  test('a retry that errors keeps the first cover and flags it', async () => {
    generateIllustration
      .mockResolvedValueOnce('https://r/mockup.png')
      .mockRejectedValueOnce(new Error('quota'));
    fetchWithTimeout
      .mockResolvedValueOnce(qaResponse({ ...CLEAN_FLAT, book_mockup: true }))
      .mockResolvedValueOnce(qaResponse(CLEAN_WARDROBE))
      .mockResolvedValueOnce(qaResponse(CLEAN_ANATOMY));
    const out = await generateFrontCoverImage(child, 'https://ref/photo.jpg', { bookId: 'b1' });
    expect(out.frontCoverImageUrl).toBe('https://r/mockup.png');
    expect(out.coverArtworkAdvisory).toBe('cover artwork: depicts a physical book / product mockup (retry errored)');
  });

  test('a QA outage never blocks the cover and spends no retry', async () => {
    generateIllustration.mockResolvedValueOnce('https://r/first.png');
    fetchWithTimeout.mockRejectedValue(new Error('down'));
    const out = await generateFrontCoverImage(child, 'https://ref/photo.jpg', { bookId: 'b1' });
    expect(generateIllustration).toHaveBeenCalledTimes(1);
    expect(out.frontCoverImageUrl).toBe('https://r/first.png');
    expect(out.coverArtworkAdvisory).toBeNull();
    expect(out.coverAnatomyAdvisory).toBeNull();
  });
});
