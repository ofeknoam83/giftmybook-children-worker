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
jest.mock('../../../services/bookPipelineV3/llm/visionClient', () => ({
  callVisionRole: jest.fn(),
}));

const { generateImage } = require('../../../services/bookPipelineV3/illustrator/render/imageClient');
const { callVisionRole } = require('../../../services/bookPipelineV3/llm/visionClient');
const { renderWorldPlates, buildPlatePrompt } = require('../../../services/bookPipelineV3/illustrator/artDirection/worldPlates');
const { renderPropPlate } = require('../../../services/bookPipelineV3/illustrator/artDirection/propPlate');
const { PLATE_STYLE_REPAIR } = require('../../../services/bookPipelineV3/illustrator/artDirection/plateStyleQa');

const REFS = [
  { base64: 'SHEET', mimeType: 'image/png', kind: 'sheet' },
  { base64: 'COVER', mimeType: 'image/jpeg', kind: 'cover' },
];

describe('renderWorldPlates style anchoring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    generateImage.mockResolvedValue({ buffer: Buffer.from('plate-img'), mimeType: 'image/png' });
    // Default: the style-medium QA passes the plate.
    callVisionRole.mockResolvedValue({ json: { medium_ok: true }, model: 'm' });
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
    expect(p).toContain('Palette/lighting (scene mood only — never changes the render MEDIUM): warm dawn light');
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

// Plate style-medium QA (book 16758e3c): plates were the only unjudged images
// in the pipeline — one drifted 2D plate dragged every spread that shared its
// location into flat cel-shaded renders. Each plate now gets one cheap
// QA_VISION medium check; a failure earns one repair render; a second
// failure DROPS the plate (spreads keep the sheet+cover style refs) and
// surfaces an advisory.
describe('plate style-medium QA', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    generateImage.mockResolvedValue({ buffer: Buffer.from('plate-img'), mimeType: 'image/png' });
  });

  test('a passing plate is judged once and kept', async () => {
    callVisionRole.mockResolvedValue({ json: { medium_ok: true }, model: 'm' });
    const map = await renderWorldPlates({
      plates: [{ location: 'riverbank', spreads: [1, 3] }],
      styleReferences: REFS,
      log: () => {},
    });
    expect(map.has('riverbank')).toBe(true);
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(callVisionRole).toHaveBeenCalledTimes(1);
    // The cover rides as the medium ground truth beside the plate.
    expect(callVisionRole.mock.calls[0][1].images).toHaveLength(2);
    expect(callVisionRole.mock.calls[0][1].images[1].base64).toBe('COVER');
  });

  test('a failed plate re-renders once with the repair note and is kept when the repair passes', async () => {
    callVisionRole
      .mockResolvedValueOnce({ json: { medium_ok: false, reason: 'flat cel-shaded 2D look' }, model: 'm' })
      .mockResolvedValueOnce({ json: { medium_ok: true }, model: 'm' });
    const map = await renderWorldPlates({
      plates: [{ location: 'riverbank', spreads: [1, 3] }],
      styleReferences: REFS,
      log: () => {},
    });
    expect(map.has('riverbank')).toBe(true);
    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(generateImage.mock.calls[1][0].prompt).toContain(PLATE_STYLE_REPAIR);
  });

  test('a plate failing twice is DROPPED and reported as an advisory', async () => {
    callVisionRole.mockResolvedValue({ json: { medium_ok: false, reason: 'watercolor look' }, model: 'm' });
    const advisories = [];
    const map = await renderWorldPlates({
      plates: [{ location: 'riverbank', spreads: [1, 3] }],
      styleReferences: REFS,
      onAdvisory: (note) => advisories.push(note),
      log: () => {},
    });
    expect(map.has('riverbank')).toBe(false);
    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain('riverbank');
    expect(advisories[0]).toContain('watercolor look');
  });

  test('an unreachable judge ships the plate unverified (best-effort, never blocks)', async () => {
    callVisionRole.mockRejectedValue(new Error('vision down'));
    const map = await renderWorldPlates({
      plates: [{ location: 'riverbank', spreads: [1, 3] }],
      styleReferences: REFS,
      log: () => {},
    });
    expect(map.has('riverbank')).toBe(true);
    expect(generateImage).toHaveBeenCalledTimes(1);
  });

  test('the prop plate shares the same QA contract (fail twice → dropped + advisory)', async () => {
    callVisionRole.mockResolvedValue({ json: { medium_ok: false, reason: 'photoreal look' }, model: 'm' });
    const advisories = [];
    const plate = await renderPropPlate({
      continuityLocks: { props: [{ name: 'compass', design: 'brass star compass', spreads: [1, 4, 9] }] },
      styleReferences: REFS,
      onAdvisory: (note) => advisories.push(note),
      log: () => {},
    });
    expect(plate).toBeNull();
    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(generateImage.mock.calls[1][0].prompt).toContain(PLATE_STYLE_REPAIR);
    expect(advisories[0]).toContain('photoreal look');
  });

  test('a passing prop plate is kept with its props list', async () => {
    callVisionRole.mockResolvedValue({ json: { medium_ok: true }, model: 'm' });
    const plate = await renderPropPlate({
      continuityLocks: { props: [{ name: 'compass', design: 'brass star compass', spreads: [1, 4] }] },
      styleReferences: REFS,
      log: () => {},
    });
    expect(plate.props).toEqual(['compass']);
    expect(callVisionRole).toHaveBeenCalledTimes(1);
  });
});
