/**
 * Line-art sheet election (cb-1 §4.3): a cached sheet is adopted, N
 * candidates are rendered/measured/judged and the best passing one is
 * elected create-if-absent (a lost race adopts the winner), the hero sheet
 * fails `coloring_identity_failed` when nothing passes (never elected
 * blind), the companion sheet and border plate fail open, and the prompts
 * carry the colour-stripped outfit spec.
 */

jest.mock('../../../../services/illustrationGenerator', () => ({
  callGeminiImageParts: jest.fn(),
  buildReferenceParts: (prompt, pack) => [{ text: prompt }, ...pack.map(r => ({ inline_data: { data: r.base64 } }))],
  getNextApiKey: jest.fn(() => 'k'),
  fetchWithTimeout: jest.fn(),
}));
jest.mock('../../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(),
  uploadBuffer: jest.fn().mockResolvedValue('https://signed/x'),
  uploadBufferIfAbsent: jest.fn(),
}));
jest.mock('../../../../services/catalogEngine/coloring/pageQa', () => ({
  checkLineSheet: jest.fn(),
  judgeJson: jest.fn(),
  qaData: v => String(v || ''),
}));
jest.mock('../../../../services/catalogEngine/coloring/metrics', () => ({
  cleanLineArt: jest.fn(async (buffer) => ({ buffer, specks: 0, changed: true })),
  measureLineArt: jest.fn(async () => ({ blocking: [], advisory: [], grayRatio: 0.01 })),
}));

const { callGeminiImageParts } = require('../../../../services/illustrationGenerator');
const { downloadBuffer, uploadBuffer, uploadBufferIfAbsent } = require('../../../../services/gcsStorage');
const { checkLineSheet } = require('../../../../services/catalogEngine/coloring/pageQa');
const { measureLineArt } = require('../../../../services/catalogEngine/coloring/metrics');
const { loadCatalog } = require('../../../../services/catalogEngine/catalog');
const { COLORING_VERSION } = require('../../../../services/catalogEngine/versions');
const sheets = require('../../../../services/catalogEngine/coloring/sheets');
const { resolveLineRules } = require('../../../../services/catalogEngine/coloring/lineRules');

const farm = loadCatalog().themes.farm;
const colourSheet = { base64: Buffer.from('colour').toString('base64'), mimeType: 'image/png', hash: 'abc12345' };
const cover = { base64: Buffer.from('cover').toString('base64'), mimeType: 'image/jpeg' };
const imageResponse = tag => Buffer.from(`png-${tag}`);
const log = jest.fn();

beforeEach(() => {
  callGeminiImageParts.mockReset();
  downloadBuffer.mockReset().mockRejectedValue(new Error('not found'));
  uploadBuffer.mockClear();
  uploadBufferIfAbsent.mockReset().mockResolvedValue({ created: true });
  checkLineSheet.mockReset();
  measureLineArt.mockClear();
  sheets.resetSheetCache();
  process.env.CATALOG_COLORING_SHEET_CANDIDATES = '3';
});
afterEach(() => { delete process.env.CATALOG_COLORING_SHEET_CANDIDATES; });

describe('getHeroLineSheet', () => {
  test('a cached sheet in GCS is adopted with its sidecar numbers — no render', async () => {
    downloadBuffer.mockImplementation(async (key) => (key.endsWith('.json') ? Buffer.from(JSON.stringify({ likeness: 0.8, candidates: 3 })) : Buffer.from('cached-png')));
    const s = await sheets.getHeroLineSheet({ anchorHash: 'anchor1', colourSheet, cover, outfitSpecText: 'a red jacket', profile: { name: 'Emma' }, ageBand: '4-5', log });
    expect(s.storageKey).toBe(`catalog-assets/coloring-sheets/${COLORING_VERSION}/anchor1-abc12345.png`);
    expect(s.likeness).toBe(0.8);
    expect(s.candidates).toBe(3);
    expect(callGeminiImageParts).not.toHaveBeenCalled();
  });
  test('renders N candidates, elects the passing one with the highest likeness, uploads create-if-absent with a sidecar', async () => {
    callGeminiImageParts.mockImplementation(async () => imageResponse(callGeminiImageParts.mock.calls.length));
    checkLineSheet
      .mockResolvedValueOnce({ pass: true, defects: [], likeness: 0.6 })
      .mockResolvedValueOnce({ pass: false, defects: ['readable text on the sheet'], likeness: 0.9 })
      .mockResolvedValueOnce({ pass: true, defects: [], likeness: 0.85 });
    const costTracker = { addImageGeneration: jest.fn() };
    const s = await sheets.getHeroLineSheet({ anchorHash: 'anchor2', colourSheet, cover, outfitSpecText: 'a bright red hooded jacket', profile: { name: 'Emma' }, ageBand: '4-5', costTracker, log });
    expect(callGeminiImageParts).toHaveBeenCalledTimes(3);
    const [parts, opts] = callGeminiImageParts.mock.calls[0];
    expect(parts[0].text).toMatch(/Redraw REFERENCE IMAGE 1 — the CHARACTER MODEL SHEET of the child Emma/);
    expect(parts[0].text).toMatch(/hooded jacket/);
    expect(parts[0].text).not.toMatch(/bright red/);
    expect(parts[0].text).toMatch(/LINE ART RULES/);
    expect(parts.length).toBe(5); // prompt + 2 labels + 2 images
    expect(opts.aspectRatio).toBe('16:9');
    expect(costTracker.addImageGeneration).toHaveBeenCalledTimes(3);
    expect(s.likeness).toBe(0.85);
    expect(s.candidates).toBe(3);
    expect(uploadBufferIfAbsent).toHaveBeenCalledWith(expect.any(Buffer), `catalog-assets/coloring-sheets/${COLORING_VERSION}/anchor2-abc12345.png`, 'image/png');
    expect(uploadBuffer).toHaveBeenCalledWith(expect.any(Buffer), `catalog-assets/coloring-sheets/${COLORING_VERSION}/anchor2-abc12345.json`, 'application/json');
    expect(s.advisories.map(a => a.note)).toEqual(['hero sheet candidate 2 rejected: readable text on the sheet']);
  });
  test('the hero and companion line-sheet prompts keep garment lettering as a blank shape (2026-09-08)', () => {
    const rules = resolveLineRules('4-5');
    const hero = sheets.buildHeroSheetPrompt({ outfitSpecText: 'a white spacesuit with a red patch', name: 'Emma', rules });
    expect(hero).toContain('GARMENT LETTERING: a logo, patch, badge, label, name or number on a garment in REFERENCE IMAGE 1 keeps its OUTLINE SHAPE');
    expect(hero.indexOf('GARMENT LETTERING')).toBeLessThan(hero.indexOf('NO TEXT'));
    const companion = sheets.buildCompanionSheetPrompt({ companion: { name: 'Farmer Bea', type: 'friendly adult farm guide', human: true, specText: 'blue overalls' }, rules });
    expect(companion).toContain('GARMENT LETTERING');
  });
  test('a lost creation race adopts the winning object', async () => {
    callGeminiImageParts.mockResolvedValue(imageResponse('local'));
    checkLineSheet.mockResolvedValue({ pass: true, defects: [], likeness: 0.7 });
    uploadBufferIfAbsent.mockResolvedValue({ created: false });
    downloadBuffer.mockImplementation(async (key) => {
      // First call (cache probe) misses; after the race the winner exists.
      if (uploadBufferIfAbsent.mock.calls.length === 0) throw new Error('not found');
      return key.endsWith('.json') ? Buffer.from(JSON.stringify({ likeness: 0.95, candidates: 3 })) : Buffer.from('winner-png');
    });
    const s = await sheets.getHeroLineSheet({ anchorHash: 'anchor3', colourSheet, profile: { name: 'Emma' }, log });
    expect(s.base64).toBe(Buffer.from('winner-png').toString('base64'));
    expect(s.likeness).toBe(0.95);
    expect(s.advisories.map(a => a.note)).toContain('adopted the concurrently elected sheet');
  });
  test('no passing candidate → coloring_identity_failed with every outcome; a metrics-blocking candidate is rejected before the judge; unverifiable is never elected', async () => {
    callGeminiImageParts.mockResolvedValue(imageResponse('x'));
    measureLineArt.mockResolvedValueOnce({ blocking: ['grey shading present (9%)'], advisory: [] }).mockResolvedValue({ blocking: [], advisory: [] });
    checkLineSheet.mockResolvedValue({ unverifiable: 'sheet QA HTTP 500' });
    await expect(sheets.getHeroLineSheet({ anchorHash: 'anchor4', colourSheet, profile: { name: 'Emma' }, log })).rejects.toMatchObject({
      failureCode: 'coloring_identity_failed',
      advisories: expect.arrayContaining([expect.objectContaining({ note: 'hero sheet candidate 1 rejected: grey shading present (9%)' }), expect.objectContaining({ note: expect.stringMatching(/unverifiable/) })]),
    });
    expect(checkLineSheet).toHaveBeenCalledTimes(2);
    expect(uploadBufferIfAbsent).not.toHaveBeenCalled();
  });
  test('a missing colour sheet fails the same code without rendering', async () => {
    await expect(sheets.getHeroLineSheet({ anchorHash: 'a', colourSheet: null, log })).rejects.toMatchObject({ failureCode: 'coloring_identity_failed' });
    expect(callGeminiImageParts).not.toHaveBeenCalled();
  });
});

describe('getCompanionLineSheet + getBorderPlate', () => {
  test('the companion sheet elects from the companion colour sheet and fails open', async () => {
    callGeminiImageParts.mockResolvedValue(imageResponse('c'));
    checkLineSheet.mockResolvedValue({ pass: true, defects: [], likeness: 0.8 });
    const companion = { name: 'Farmer Bea', type: 'friendly adult farm guide', specText: 'woman, green overalls', human: true, base64: Buffer.from('bea').toString('base64'), mimeType: 'image/png', hash: 'beahash' };
    const s = await sheets.getCompanionLineSheet({ theme: farm, companion, ageBand: '4-5', log });
    expect(s.storageKey).toMatch(new RegExp(`^catalog-assets/coloring-companions/${COLORING_VERSION}/farm-[a-z0-9]+\\.png$`));
    expect(callGeminiImageParts.mock.calls[0][0][0].text).toMatch(/Farmer Bea, a friendly adult farm guide/);
    expect(callGeminiImageParts.mock.calls[0][0][0].text).toMatch(/overalls/);
    expect(callGeminiImageParts.mock.calls[0][0][0].text).not.toMatch(/green/);
    checkLineSheet.mockResolvedValue({ pass: false, defects: ['a child is drawn on the companion sheet'], likeness: 0.1 });
    sheets.resetSheetCache();
    expect(await sheets.getCompanionLineSheet({ theme: farm, companion: { ...companion, hash: 'other' }, log })).toBeNull();
    expect(await sheets.getCompanionLineSheet({ theme: farm, companion: null, log })).toBeNull();
  });
  test('the border plate is per theme + prompt hash, 3:4, and fails open', async () => {
    callGeminiImageParts.mockResolvedValue(imageResponse('b'));
    checkLineSheet.mockResolvedValue({ pass: true, defects: [], likeness: 0.9 });
    const plate = await sheets.getBorderPlate({ theme: farm, ageBand: '8-10', log });
    expect(plate.storageKey).toMatch(new RegExp(`^catalog-assets/coloring-borders/${COLORING_VERSION}/farm-[a-z0-9]+\\.png$`));
    expect(callGeminiImageParts.mock.calls[0][1].aspectRatio).toBe('3:4');
    expect(callGeminiImageParts.mock.calls[0][0][0].text).toMatch(/BORDER FRAME for the story world "Sunnybrook Farm"/);
    expect(callGeminiImageParts.mock.calls[0][0][0].text).toMatch(/CENTRE of the page is completely EMPTY/);
    callGeminiImageParts.mockRejectedValue(new Error('down'));
    sheets.resetSheetCache();
    expect(await sheets.getBorderPlate({ theme: { ...farm, theme_id: 'other' }, log })).toBeNull();
  });
});
