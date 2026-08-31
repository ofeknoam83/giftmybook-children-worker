/**
 * Layout-aware spread QA (ce-2): caption renders must contain NO painted
 * text; embedded renders must contain the story text and it must MATCH the
 * manuscript (transcribed by the same vision call, verified by the real
 * compareTexts). Repair notes carry the exact required text.
 */

jest.mock('../../../services/gcsStorage', () => ({
  uploadBuffer: jest.fn(),
  uploadFromUrl: jest.fn(),
  downloadBuffer: jest.fn(),
  getSignedUrl: jest.fn(),
}));
jest.mock('../../../services/illustrationGenerator', () => {
  const real = jest.requireActual('../../../services/illustrationGenerator');
  return {
    fetchWithTimeout: jest.fn(),
    getNextApiKey: jest.fn(() => 'test-key'),
    compareTexts: real.compareTexts, // the deterministic OCR comparison, for real
  };
});

const { fetchWithTimeout } = require('../../../services/illustrationGenerator');
const { checkSpreadRender, repairNote } = require('../../../services/catalogEngine/illustrator/spreadQa');

const STORY_TEXT = 'Emma waves to the red hen by the gate.';
const IMG = Buffer.from('png-bytes');

const verdict = (json) => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }),
});
const cleanBooleans = { child_absent: false, multiple_children: false, flat_or_photo_style: false };
const sentPrompt = () => JSON.parse(fetchWithTimeout.mock.calls[0][1].body).contents[0].parts[0].text;

beforeEach(() => fetchWithTimeout.mockReset());

describe('caption layout (no expectedText)', () => {
  test('painted text stays the defect', async () => {
    fetchWithTimeout.mockResolvedValue(verdict({ ...cleanBooleans, readable_text: true }));
    const qa = await checkSpreadRender(IMG);
    expect(qa.pass).toBe(false);
    expect(qa.defects).toEqual(['painted text in the illustration']);
    expect(sentPrompt()).toMatch(/contain no\s+readable text/);
  });

  test('a text-free render passes', async () => {
    fetchWithTimeout.mockResolvedValue(verdict({ ...cleanBooleans, readable_text: false }));
    const qa = await checkSpreadRender(IMG);
    expect(qa.pass).toBe(true);
  });
});

describe('embedded layout (expectedText set)', () => {
  test('the QA prompt requires the story text and asks for a transcription', async () => {
    fetchWithTimeout.mockResolvedValue(verdict({ ...cleanBooleans, readable_text: true, visible_text: STORY_TEXT }));
    const qa = await checkSpreadRender(IMG, { expectedText: STORY_TEXT });
    expect(qa.pass).toBe(true);
    const prompt = sentPrompt();
    expect(prompt).toContain('STORY TEXT THAT MUST APPEAR IN THE IMAGE');
    expect(prompt).toContain(STORY_TEXT);
    expect(prompt).toContain('visible_text');
  });

  test('no readable text at all = missing-embedded-text defect', async () => {
    fetchWithTimeout.mockResolvedValue(verdict({ ...cleanBooleans, readable_text: false, visible_text: '' }));
    const qa = await checkSpreadRender(IMG, { expectedText: STORY_TEXT });
    expect(qa.pass).toBe(false);
    expect(qa.defects).toEqual(['embedded story text missing from the image']);
  });

  test('garbled or duplicated painted text fails the real compareTexts', async () => {
    fetchWithTimeout.mockResolvedValue(verdict({
      ...cleanBooleans,
      readable_text: true,
      visible_text: 'Emma wavs to the redd hen hen by the gaate.',
    }));
    const qa = await checkSpreadRender(IMG, { expectedText: STORY_TEXT });
    expect(qa.pass).toBe(false);
    expect(qa.defects).toHaveLength(1);
    expect(qa.defects[0]).toMatch(/^embedded story text garbled: /);
  });

  test('punctuation/case OCR noise is tolerated (normalization, not equality)', async () => {
    fetchWithTimeout.mockResolvedValue(verdict({
      ...cleanBooleans,
      readable_text: true,
      visible_text: 'emma waves to the red hen by the gate',
    }));
    const qa = await checkSpreadRender(IMG, { expectedText: STORY_TEXT });
    expect(qa.pass).toBe(true);
  });

  test('a verdict without a usable transcription cannot be accuracy-checked but still gates presence', async () => {
    fetchWithTimeout.mockResolvedValue(verdict({ ...cleanBooleans, readable_text: true }));
    const qa = await checkSpreadRender(IMG, { expectedText: STORY_TEXT });
    expect(qa.pass).toBe(true); // presence confirmed; accuracy best-effort
  });

  test('other defects still stack beside the text check', async () => {
    fetchWithTimeout.mockResolvedValue(verdict({
      child_absent: true, multiple_children: false, flat_or_photo_style: false,
      readable_text: false, visible_text: '',
    }));
    const qa = await checkSpreadRender(IMG, { expectedText: STORY_TEXT });
    expect(qa.defects).toEqual([
      'child hero missing from the scene',
      'embedded story text missing from the image',
    ]);
  });

  test('a malformed verdict still ships as qaUnavailable, never a silent pass', async () => {
    fetchWithTimeout.mockResolvedValue(verdict({ readable_text: true }));
    const qa = await checkSpreadRender(IMG, { expectedText: STORY_TEXT });
    expect(qa.pass).toBe(true);
    expect(qa.qaUnavailable).toContain('malformed');
  });
});

describe('repairNote', () => {
  test('caption painted-text defect keeps the no-text repair', () => {
    const note = repairNote(['painted text in the illustration']);
    expect(note).toContain('ABSOLUTELY NO text');
  });

  test('embedded text defects carry the EXACT required text', () => {
    const note = repairNote(['embedded story text missing from the image'], STORY_TEXT);
    expect(note).toContain('EXACTLY as written');
    expect(note).toContain(`"${STORY_TEXT}"`);
    expect(note).not.toContain('ABSOLUTELY NO text');
    const garbled = repairNote(['embedded story text garbled: "hen" appears 2x in illustration (expected 1x) — text rendered twice'], STORY_TEXT);
    expect(garbled).toContain(`"${STORY_TEXT}"`);
  });

  test('the child-absent repair is not confused with the text-missing defect', () => {
    const note = repairNote(['child hero missing from the scene']);
    expect(note).toContain('clearly visible and central');
    expect(note).not.toContain('EXACTLY as written');
  });
});
