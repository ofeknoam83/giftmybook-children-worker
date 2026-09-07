/**
 * Set gates (cb-1 §4.7): the stroke-weight gate over the book's own median,
 * the contact-sheet gate (tiles beside the line sheet, flagged pages,
 * fail-open), the kill-switches, and the gate repair notes.
 */

jest.mock('../../../../services/catalogEngine/coloring/pageQa', () => ({
  judgeJson: jest.fn(),
  qaData: (v, max = 300) => String(v ?? '').replace(/["'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max),
}));

const sharp = require('sharp');
const { judgeJson } = require('../../../../services/catalogEngine/coloring/pageQa');
const { runStrokeGate, runColoringContactGate, gateRepairNote, tileFor, contactPrompt, STROKE_TOLERANCE } = require('../../../../services/catalogEngine/coloring/gates');

const png = (w = 60, h = 80, bg = '#ffffff') => sharp({ create: { width: w, height: h, channels: 3, background: bg } }).png().toBuffer();
const pagesFor = (widths) => widths.map((strokeWidthPercent, i) => ({ index: i + 1, metrics: { strokeWidthPercent } }));

beforeEach(() => {
  judgeJson.mockReset();
  delete process.env.CATALOG_COLORING_STROKE_GATE;
  delete process.env.CATALOG_COLORING_CONTACT_QA;
});

describe('runStrokeGate', () => {
  test('flags outliers beyond the tolerance of the median, worst first', () => {
    const r = runStrokeGate({ pages: pagesFor([0.9, 0.95, 0.88, 0.3, 0.92, 1.8]) });
    expect(r.median).toBeCloseTo(0.91, 2);
    expect(r.pass).toBe(false);
    expect(r.outliers.map(o => o.page)).toEqual([6, 4]);
    expect(r.checked).toBe(6);
  });
  test('passes a uniform book, needs three measured pages, honours the kill-switch', () => {
    expect(runStrokeGate({ pages: pagesFor([0.9, 0.92, 0.88, 0.9]) }).pass).toBe(true);
    expect(runStrokeGate({ pages: pagesFor([0.9, 5]) })).toBeNull();
    expect(runStrokeGate({ pages: [{ index: 1, metrics: null }, { index: 2, metrics: { strokeWidthPercent: null } }, { index: 3, metrics: { strokeWidthPercent: 1 } }] })).toBeNull();
    process.env.CATALOG_COLORING_STROKE_GATE = '0';
    expect(runStrokeGate({ pages: pagesFor([0.9, 0.9, 5]) })).toBeNull();
    expect(STROKE_TOLERANCE).toBe(0.35);
  });
});

describe('runColoringContactGate', () => {
  test('tiles the child crops beside the line sheet, flags what the judge flags, keeps only known pages', async () => {
    const sheet = await png(160, 90);
    const pages = [];
    for (let i = 1; i <= 4; i++) pages.push({ index: i, kind: 'between', buffer: await png(), childBbox: { x: 0.2, y: 0.1, w: 0.5, h: 0.8 }, companionBbox: null, expectsChild: true, expectsCompanion: false });
    judgeJson.mockResolvedValueOnce({ json: { pages: [{ page: 2, flag: true, note: 'longer hair' }, { page: 3, flag: false }, { page: 99, flag: true }, { page: 2, flag: true, note: 'dup' }] } });
    const r = await runColoringContactGate({ pages, heroLineSheet: { buffer: sheet }, name: 'Emma', outfitSpecText: 'a jacket' });
    expect(r.hero.pass).toBe(false);
    expect(r.hero.flagged).toEqual([{ page: 2, defect: 'character_rendering', note: 'longer hair' }]);
    expect(r.hero.checked).toBe(4);
    expect(r.companion).toBeNull();
    const prompt = judgeJson.mock.calls[0][0][0].text;
    expect(prompt).toMatch(/the child hero "Emma"/);
    expect(prompt).toMatch(/pages 1, 2, 3, 4/);
    expect(prompt).toMatch(/Colours do not exist in line art/);
  });
  test('the companion check runs beside the companion sheet when two or more pages expect it', async () => {
    const pages = [];
    for (let i = 1; i <= 3; i++) pages.push({ index: i, kind: 'between', buffer: await png(), childBbox: null, companionBbox: { x: 0.5, y: 0.2, w: 0.4, h: 0.6 }, expectsChild: true, expectsCompanion: true });
    judgeJson.mockResolvedValueOnce({ json: { pages: [] } }).mockResolvedValueOnce({ json: { pages: [{ page: 3, flag: true, note: 'different hat' }] } });
    const r = await runColoringContactGate({ pages, heroLineSheet: { buffer: await png(160, 90) }, companionLineSheet: { buffer: await png(160, 90) }, name: 'Emma', companionName: 'Farmer Bea' });
    expect(r.hero.pass).toBe(true);
    expect(r.companion.flagged).toEqual([{ page: 3, defect: 'companion_rendering', note: 'different hat' }]);
  });
  test('fails open: unavailable judge, missing reference, fewer than two tiles, the kill-switch', async () => {
    const pages = [];
    for (let i = 1; i <= 2; i++) pages.push({ index: i, kind: 'between', buffer: await png(), childBbox: null, expectsChild: true, expectsCompanion: false });
    judgeJson.mockResolvedValueOnce({ unavailable: 'HTTP 500' });
    const r = await runColoringContactGate({ pages, heroLineSheet: { buffer: await png(160, 90) }, name: 'Emma' });
    expect(r.hero.pass).toBe(true);
    expect(r.hero.qaUnavailable).toBe('HTTP 500');
    const noRef = await runColoringContactGate({ pages, heroLineSheet: null, name: 'Emma' });
    expect(noRef.hero.qaUnavailable).toMatch(/reference sheet unavailable/);
    const one = await runColoringContactGate({ pages: pages.slice(0, 1), heroLineSheet: { buffer: await png(160, 90) }, name: 'Emma' });
    expect(one.hero).toBeNull();
    process.env.CATALOG_COLORING_CONTACT_QA = '0';
    expect(await runColoringContactGate({ pages, heroLineSheet: { buffer: await png(160, 90) } })).toEqual({ hero: null, companion: null });
  });
  test('tileFor crops at the bbox or falls back to the whole page', async () => {
    const page = await png(100, 100);
    const crop = await tileFor(page, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    expect(crop.cropped).toBe(true);
    const whole = await tileFor(page, null);
    expect(whole.cropped).toBe(false);
    expect(await tileFor('not a buffer', null)).toBeNull();
    expect(contactPrompt({ subject: 'companion', pages: [1, 2], name: 'Farmer Bea', columns: 4 })).toMatch(/DIFFERENT design/);
  });
});

describe('gateRepairNote', () => {
  test('fixed notes per gate defect', () => {
    expect(gateRepairNote({ defect: 'character_rendering', note: 'longer hair', heroRef: 1, name: 'Emma', outfitSpecText: 'a jacket' })).toMatch(/CONSISTENCY REPAIR: on the other pages of this book Emma is drawn EXACTLY as REFERENCE 1.*longer hair/);
    expect(gateRepairNote({ defect: 'companion_rendering', companionRef: 4, companionName: 'Farmer Bea' })).toMatch(/Farmer Bea is drawn EXACTLY as REFERENCE 4/);
    expect(gateRepairNote({ defect: 'stroke_weight', medianStrokePercent: 0.91 })).toMatch(/about 0.91% of the image width/);
    expect(gateRepairNote({ defect: 'other' })).toBe('');
  });
});
