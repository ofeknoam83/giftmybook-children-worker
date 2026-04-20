jest.mock('../../../services/illustrationGenerator', () => ({
  fetchWithTimeout: jest.fn(),
  getNextApiKey: jest.fn(() => 'test-key'),
  ART_STYLE_CONFIG: {
    pixar_premium: {
      prefix: "Cinematic 3D Pixar-like soft render children's book illustration,",
      suffix: 'photorealistic 3D CGI render, soft volumetric cinematic lighting',
    },
  },
  PARENT_THEMES: new Set(['mothers_day', 'fathers_day']),
}));

const { buildSpreadPrompt } = require('../../../services/illustrator/prompts/spread');

describe('buildSpreadPrompt CRITICAL RULES block', () => {
  test('includes ONE HERO rule at the top', () => {
    const prompt = buildSpreadPrompt({
      spreadIndex: 0,
      totalSpreads: 13,
      scenePrompt: 'Paisley dances in the living room.',
      leftText: 'Left text.',
      rightText: 'Right text.',
      hasParentOnCover: false,
      additionalCoverCharacters: null,
      theme: null,
      style: 'pixar_premium',
    });

    expect(prompt).toContain('CRITICAL RULES');
    expect(prompt).toMatch(/ONE HERO/);
    expect(prompt).toMatch(/EXACTLY ONCE/);
    expect(prompt).toMatch(/ONE MOMENT/);
    expect(prompt).toMatch(/ONE SEAMLESS PAINTING/);
  });

  test('CRITICAL RULES block appears before the scene description', () => {
    const prompt = buildSpreadPrompt({
      spreadIndex: 2,
      totalSpreads: 13,
      scenePrompt: 'Scene description here.',
      leftText: '',
      rightText: '',
      hasParentOnCover: false,
      additionalCoverCharacters: null,
      theme: null,
      style: 'pixar_premium',
    });

    const criticalIdx = prompt.indexOf('CRITICAL RULES');
    const sceneIdx = prompt.indexOf('### SCENE');
    expect(criticalIdx).toBeGreaterThanOrEqual(0);
    expect(sceneIdx).toBeGreaterThan(criticalIdx);
  });

  test('FORMAT section references the critical rules', () => {
    const prompt = buildSpreadPrompt({
      spreadIndex: 0,
      totalSpreads: 13,
      scenePrompt: 'Any scene.',
      leftText: '',
      rightText: '',
      hasParentOnCover: false,
      additionalCoverCharacters: null,
      theme: null,
      style: 'pixar_premium',
    });

    expect(prompt).toContain('### FORMAT');
    expect(prompt).toMatch(/ONE HERO \/ ONE MOMENT \/ ONE SEAMLESS PAINTING/);
  });
});
