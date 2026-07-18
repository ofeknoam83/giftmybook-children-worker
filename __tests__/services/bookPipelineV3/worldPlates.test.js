/**
 * World-plate style anchoring (2026-07-18, book 6e018c20): a plate rendered
 * from prose alone drifted flat/desaturated and dragged its spreads into a
 * book-pass style break. Plates now render with the book pack (sheet +
 * approved cover) attached as RENDERING-STYLE references — while the
 * "no characters" rule keeps the referenced child out of the empty plate.
 */

jest.mock('../../../services/bookPipelineV3/illustrator/render/imageClient', () => ({
  generateImage: jest.fn(),
}));

const { generateImage } = require('../../../services/bookPipelineV3/illustrator/render/imageClient');
const { renderWorldPlates, buildPlatePrompt } = require('../../../services/bookPipelineV3/illustrator/artDirection/worldPlates');

const REFS = [
  { base64: 'SHEET', mimeType: 'image/png', kind: 'sheet' },
  { base64: 'COVER', mimeType: 'image/jpeg', kind: 'cover' },
];

describe('renderWorldPlates style anchoring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    generateImage.mockResolvedValue({ buffer: Buffer.from('plate-img'), mimeType: 'image/png' });
  });

  test('plates render with the book style references attached', async () => {
    const map = await renderWorldPlates({
      plates: [{ location: 'riverbank', spreads: [1, 3] }],
      styleReferences: REFS,
      log: () => {},
    });
    expect(generateImage).toHaveBeenCalledTimes(1);
    const call = generateImage.mock.calls[0][0];
    expect(call.references).toBe(REFS);
    expect(call.prompt).toContain('RENDERING STYLE');
    expect(call.prompt).toContain('paint the LOCATION ONLY');
    expect(map.get('riverbank').base64).toBe(Buffer.from('plate-img').toString('base64'));
  });

  test('the no-characters rule survives beside the style instruction', () => {
    const p = buildPlatePrompt('riverbank', 'warm dawn light', { hasStyleReferences: true });
    expect(p).toContain('No people, no animals, no characters of any kind');
    expect(p).toContain('match their brushwork, color saturation, line weight, and lighting quality EXACTLY');
    expect(p).toContain('no characters from the references');
    expect(p).toContain('Palette/lighting: warm dawn light');
  });

  test('reference-less plates keep the legacy prompt (no style-reference paragraph)', () => {
    const p = buildPlatePrompt('riverbank', null);
    expect(p).not.toContain('reference images');
    expect(p).toContain('No people, no animals, no characters of any kind');
  });

  test('a reference-less call still renders with an empty references array', async () => {
    await renderWorldPlates({ plates: [{ location: 'cove', spreads: [2, 6] }], log: () => {} });
    expect(generateImage.mock.calls[0][0].references).toEqual([]);
  });
});
