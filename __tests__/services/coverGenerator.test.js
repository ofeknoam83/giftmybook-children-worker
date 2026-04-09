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
    paper_cutout: { prefix: 'Paper cutout style.', suffix: 'Layered paper textures.' },
    watercolor: { prefix: 'Watercolor style.', suffix: 'Soft wet-on-wet washes.' },
    cinematic_3d: { prefix: '3D render.', suffix: 'Pixar quality.' },
    scandinavian_minimal: { prefix: 'Scandi minimal.', suffix: 'Muted palette.' },
  },
  getNextApiKey: jest.fn(() => 'fake-key'),
  fetchWithTimeout: jest.fn(),
}));

const { buildUpsellCoverPrompt } = require('../../services/coverGenerator');

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

  test('includes art style prefix and suffix', () => {
    const prompt = buildUpsellCoverPrompt(base.title, base.childName, base.childAge, 'female', 'watercolor');
    expect(prompt).toContain('Watercolor style.');
    expect(prompt).toContain('Soft wet-on-wet washes.');
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
