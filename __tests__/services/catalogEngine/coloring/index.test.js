/**
 * The coloring-book orchestration (cb-1) end to end with the model,
 * storage, sheet and layout dependencies mocked: identity kit → line
 * sheets → plan + template moments → N candidates per page, judged,
 * scored, promoted beside their own keys → the bounded repair loop → the
 * contact gate's one re-render → ship policy (`coloring_unresolved` fails
 * closed, the opt-in ships) → PDFs + manifest; page and whole-book replay;
 * the required line sheet; the subset mode; cancellation.
 */

process.env.CATALOG_COLORING_MOMENT_WRITER = '0';

jest.mock('../../../../services/illustrationGenerator', () => ({
  downloadPhotoAsBase64: jest.fn().mockResolvedValue({ base64: 'Y292ZXI=', mimeType: 'image/jpeg' }),
  callGeminiImageParts: jest.fn(),
  buildReferenceParts: (prompt, pack) => [{ text: prompt }, ...pack.map(r => ({ inline_data: { data: r.base64 } }))],
  getNextApiKey: jest.fn(() => 'k'),
  fetchWithTimeout: jest.fn().mockRejectedValue(new Error('offline')),
}));
jest.mock('../../../../services/gcsStorage', () => ({
  uploadBuffer: jest.fn(async (buf, key) => `https://signed/${key}`),
  downloadBuffer: jest.fn().mockRejectedValue(new Error('not found')),
  getSignedUrl: jest.fn(async key => `https://signed/${key}`),
  objectExists: jest.fn().mockResolvedValue(false),
  loadJson: jest.fn().mockRejectedValue(new Error('not found')),
  saveJson: jest.fn().mockResolvedValue('ok'),
  uploadBufferIfAbsent: jest.fn(),
}));
jest.mock('../../../../services/catalogEngine/illustrator', () => ({ storyFingerprint: () => 'fp1' }));
jest.mock('../../../../services/catalogEngine/illustrator/bible', () => ({
  buildBookBible: jest.fn(),
  summarizeBible: jest.fn(async () => ({ bibleHash: 'bh', characterSheet: { hash: 'sheethash' } })),
  anchorHash: () => 'anchor1',
}));
jest.mock('../../../../services/catalogEngine/coloring/sheets', () => ({
  getHeroLineSheet: jest.fn(),
  getCompanionLineSheet: jest.fn(),
  getBorderPlate: jest.fn(),
}));
jest.mock('../../../../services/catalogEngine/coloring/render', () => {
  const real = jest.requireActual('../../../../services/catalogEngine/coloring/render');
  return { ...real, renderPageCandidates: jest.fn() };
});
jest.mock('../../../../services/catalogEngine/coloring/metrics', () => ({
  checkAspect: jest.fn(async () => ({ ok: true, ratio: 0.75 })),
  cleanLineArt: jest.fn(async buffer => ({ buffer, specks: 0, changed: true })),
  measureLineArt: jest.fn(async () => ({ blocking: [], advisory: [], grayRatio: 0.01, inkRatio: 0.08, strokeWidthPercent: 0.9, strokeRatio: 1, frameRing: 0 })),
}));
jest.mock('../../../../services/catalogEngine/coloring/pageQa', () => {
  const real = jest.requireActual('../../../../services/catalogEngine/coloring/pageQa');
  return { ...real, checkColoringPage: jest.fn() };
});
jest.mock('../../../../services/catalogEngine/coloring/gates', () => {
  const real = jest.requireActual('../../../../services/catalogEngine/coloring/gates');
  return { ...real, runColoringContactGate: jest.fn(async () => ({ hero: { pass: true, flagged: [], checked: 19 }, companion: null })) };
});
jest.mock('../../../../services/catalogEngine/coloring/layout', () => ({
  buildInteriorPdf: jest.fn(async ({ pages }) => ({ buffer: Buffer.from('interior-pdf'), pageCount: 24, coloringPageCount: pages.length, pages: pages.map(pg => ({ index: pg.index, ppi: 300, upscaled: false })) })),
  buildCoverWrapPdf: jest.fn(async () => ({ buffer: Buffer.from('cover-pdf'), palette: { r: 0.5, g: 0.5, b: 0.5, ink: 'light' } })),
  renderCoverThumbnail: jest.fn(async () => Buffer.from('thumb')),
  renderPreviews: jest.fn(async () => [Buffer.from('p1'), Buffer.from('p2')]),
  preflightLulu: jest.fn(async () => ({ ok: true, errors: [], warnings: [], minPpi: 300 })),
}));

const { loadCatalog } = require('../../../../services/catalogEngine/catalog');
const { uploadBuffer, downloadBuffer, loadJson, saveJson, objectExists } = require('../../../../services/gcsStorage');
const { buildBookBible } = require('../../../../services/catalogEngine/illustrator/bible');
const { getHeroLineSheet, getCompanionLineSheet, getBorderPlate } = require('../../../../services/catalogEngine/coloring/sheets');
const { renderPageCandidates } = require('../../../../services/catalogEngine/coloring/render');
const { checkColoringPage } = require('../../../../services/catalogEngine/coloring/pageQa');
const { runColoringContactGate } = require('../../../../services/catalogEngine/coloring/gates');
const { buildInteriorPdf } = require('../../../../services/catalogEngine/coloring/layout');
const { COLORING_VERSION, COLORING_QA_VERSION } = require('../../../../services/catalogEngine/versions');
const { contentHash } = require('../../../../services/catalogEngine/coloring/candidates');
const { generateColoringBook } = require('../../../../services/catalogEngine/coloring');

const farm = loadCatalog().themes.farm;
const book = farm.age_bands['4-5'].find(b => b.id === 'farm_4_5_little_chick') || farm.age_bands['4-5'][0];
const story = { title: 'Emma and the Little Chick', spreads: book.beats.map(b => ({ spread: b.spread, text: `Story ${b.spread}.` })), personalization_evidence: [{ visual_required: true, moment_type: 'object_presence', source_field: 'object', source_value: 'a red toy tractor', spread: 1 }] };
const profile = { name: 'Emma', age: 5 };
const img = tag => ({ base64: Buffer.from(tag).toString('base64'), mimeType: 'image/png', hash: `${tag}hash`, storageKey: `catalog-assets/x/${tag}.png`, likeness: 0.9, advisories: [] });
const PNG = Buffer.from('page-png');
const cleanVerdict = { pass: true, defects: [], blocking: [], advisory: [], verdict: {}, childBbox: { x: 0.2, y: 0.1, w: 0.5, h: 0.8 }, companionBbox: null };
const blockingVerdict = (d) => ({ pass: false, defects: [d], blocking: [d], advisory: [], verdict: {}, childBbox: null, companionBbox: null });
const pageOf = label => Number((/:p(\d+)(?::|$)/.exec(label) || [])[1]);
const isGate = label => /:gate/.test(label);

const args = (extra = {}) => ({
  bookId: 'book-1', story, bookDef: { book, theme: farm, ageBand: '4-5' }, profile,
  approvedCoverUrl: 'https://covers.example/c.png', childPhotoUrl: null, characterDescription: null,
  costTracker: { addImageGeneration: jest.fn(), addTextUsage: jest.fn() }, log: jest.fn(), onProgress: jest.fn(), ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.CATALOG_COLORING_SHIP_ON_EXHAUSTION;
  delete process.env.CATALOG_COLORING_SHEET_REQUIRED;
  process.env.CATALOG_COLORING_CANDIDATES = '2';
  process.env.CATALOG_COLORING_MAX_REPAIRS = '1';
  downloadBuffer.mockRejectedValue(new Error('not found'));
  loadJson.mockRejectedValue(new Error('not found'));
  objectExists.mockResolvedValue(false);
  buildBookBible.mockResolvedValue({
    hash: 'bh', advisories: [{ stage: 'outfitLock', note: 'from bible' }],
    sheet: img('sheet'), outfit: { outfit: 'a red hooded jacket, blue dungarees', hash: 'oh' },
    props: [{ value: 'a red toy tractor', sheet: img('prop') }],
    companion: { key: 'Farmer Bea', type: 'friendly adult farm guide', specText: 'woman, bun', human: true, ...img('bea') },
    worldPlate: img('plate'), emotion: null, manifest: {},
  });
  getHeroLineSheet.mockResolvedValue(img('heroline'));
  getCompanionLineSheet.mockResolvedValue(img('bealine'));
  getBorderPlate.mockResolvedValue(img('border'));
  renderPageCandidates.mockImplementation(async ({ n, pass }) => Array.from({ length: n }, (_, i) => ({ k: i + 1, pass, buffer: Buffer.from(`${PNG}-${pass}-${i}`), rung: 'original', error: null, attempts: [] })));
  checkColoringPage.mockResolvedValue(cleanVerdict);
  runColoringContactGate.mockResolvedValue({ hero: { pass: true, flagged: [], checked: 19 }, companion: null });
});

describe('generateColoringBook', () => {
  test('happy path: every page rendered, judged, promoted; the meet page is the line sheet; PDFs + manifest', async () => {
    const r = await generateColoringBook(args());
    expect(r.cached).toBe(false);
    expect(r.pages.length).toBe(20);
    expect(r.pages[0]).toMatchObject({ kind: 'meet', cached: true, storageKey: 'catalog-assets/x/heroline.png' });
    expect(renderPageCandidates).toHaveBeenCalledTimes(19);
    expect(checkColoringPage).toHaveBeenCalledTimes(38);
    const canonical = uploadBuffer.mock.calls.map(c => c[1]).filter(k => /\/page-\d+\.png$/.test(k));
    expect(canonical.length).toBe(19);
    expect(canonical[0]).toMatch(new RegExp(`^children-jobs/book-1/coloring/${COLORING_VERSION}/[a-z0-9]+/page-\\d+\\.png$`));
    const candidates = uploadBuffer.mock.calls.map(c => c[1]).filter(k => /\.c\d\.png$/.test(k));
    expect(candidates.length).toBe(38);
    const marker = JSON.parse(uploadBuffer.mock.calls.find(c => c[1].endsWith('page-2.png.qa.json'))[0].toString());
    expect(marker).toMatchObject({ coloringQaVersion: COLORING_QA_VERSION, unresolved: false, pass: 0, repairs: 0 });
    expect(r.interiorPdfUrl).toMatch(/interior\.pdf$/);
    expect(r.coverPdfUrl).toMatch(/cover\.pdf$/);
    expect(r.coverImageUrl).toMatch(/cover-thumb\.png$/);
    expect(r.previewImageUrls.length).toBe(2);
    expect(r.pageCount).toBe(24);
    expect(r.coloringPageCount).toBe(20);
    expect(r.unresolved).toEqual([]);
    expect(r.plan.kinds.between).toBe(9);
    expect(r.plan.momentWriter).toBe('template');
    expect(r.bookBible.lineSheet.hash).toBe('herolinehash');
    expect(r.gates.contact.hero.pass).toBe(true);
    expect(r.gates.stroke.pass).toBe(true);
    expect(r.preflight.ok).toBe(true);
    expect(r.advisories.some(a => a.note === 'from bible')).toBe(true);
    expect(saveJson).toHaveBeenCalledWith(expect.objectContaining({ planHash: r.planHash, pageCount: 24 }), expect.stringMatching(/manifest\.json$/));
    expect(buildInteriorPdf.mock.calls[0][0].pages[0].kind).toBe('meet');
    const last = args().onProgress;
    expect(renderPageCandidates.mock.calls[0][0].prompts.original).toMatch(/LINE ART RULES/);
    expect(last).toBeDefined();
  });

  test('the repair loop: a blocking first pass re-renders with a repair note and the clean second pass ships', async () => {
    checkColoringPage.mockImplementation(async (buffer, o) => (pageOf(o.label) === 2 && buffer.toString().includes('-0-') ? blockingVerdict('painted text: "BARN"') : cleanVerdict));
    const r = await generateColoringBook(args());
    const p2 = r.pages.find(p => p.index === 2);
    expect(p2.repairs).toBe(1);
    expect(p2.qa.blocking).toEqual([]);
    expect(p2.candidates).toBe(4);
    const repairCall = renderPageCandidates.mock.calls.find(c => c[0].pass === 1);
    expect(repairCall[0].prompts.original).toMatch(/REPAIR \(fix ONLY what is named/);
    expect(repairCall[0].prompts.original).toMatch(/TEXT REPAIR/);
    const repairKeys = uploadBuffer.mock.calls.map(c => c[1]).filter(k => /page-2\.r1c\d\.png$/.test(k));
    expect(repairKeys.length).toBe(2);
  });

  test('residual blocking defects fail the book coloring_unresolved with the scored candidates; the opt-in ships with an advisory', async () => {
    checkColoringPage.mockImplementation(async (buffer, o) => (pageOf(o.label) === 3 ? blockingVerdict('child duplicated (2 drawn)') : cleanVerdict));
    await expect(generateColoringBook(args())).rejects.toMatchObject({
      failureCode: 'coloring_unresolved',
      details: expect.objectContaining({ unresolved: [expect.objectContaining({ page: 3, defects: ['child duplicated (2 drawn)'], candidates: expect.arrayContaining([expect.objectContaining({ storageKey: expect.stringMatching(/page-3\.c1\.png$/), score: expect.any(Number) })]) })] }),
    });
    expect(buildInteriorPdf).not.toHaveBeenCalled();
    process.env.CATALOG_COLORING_SHIP_ON_EXHAUSTION = '1';
    jest.clearAllMocks();
    renderPageCandidates.mockImplementation(async ({ n, pass }) => Array.from({ length: n }, (_, i) => ({ k: i + 1, pass, buffer: Buffer.from(`x-${pass}-${i}`), rung: 'original', error: null, attempts: [] })));
    checkColoringPage.mockImplementation(async (buffer, o) => (pageOf(o.label) === 3 ? blockingVerdict('child duplicated (2 drawn)') : cleanVerdict));
    const r = await generateColoringBook(args());
    expect(r.unresolved.length).toBe(1);
    expect(r.advisories.some(a => a.stage === 'shipPolicy')).toBe(true);
    expect(r.interiorPdfUrl).toBeTruthy();
  });

  test('page replay: a current marker whose bytes match skips the render; an outdated or unresolved marker re-renders', async () => {
    const good = Buffer.from('cached-page-5');
    loadJson.mockImplementation(async (key) => {
      if (/page-5\.png\.qa\.json$/.test(key)) return { coloringQaVersion: COLORING_QA_VERSION, renderHash: contentHash(good), unresolved: false, qa: { blocking: [], advisory: ['frame drawn around the page'] }, metrics: { strokeWidthPercent: 0.9 }, score: 90 };
      if (/page-6\.png\.qa\.json$/.test(key)) return { coloringQaVersion: 'cq-0', renderHash: 'x', unresolved: false, qa: { blocking: [], advisory: [] } };
      if (/page-7\.png\.qa\.json$/.test(key)) return { coloringQaVersion: COLORING_QA_VERSION, renderHash: 'x', unresolved: true, qa: { blocking: ['painted text'], advisory: [] } };
      throw new Error('not found');
    });
    downloadBuffer.mockImplementation(async (key) => (/page-5\.png$/.test(key) ? good : Promise.reject(new Error('not found'))));
    const r = await generateColoringBook(args());
    const p5 = r.pages.find(p => p.index === 5);
    expect(p5.cached).toBe(true);
    expect(p5.qa.advisory).toEqual(['frame drawn around the page']);
    expect(renderPageCandidates).toHaveBeenCalledTimes(18);
    expect(renderPageCandidates.mock.calls.some(c => /:p6$/.test(c[0].label))).toBe(true);
    expect(renderPageCandidates.mock.calls.some(c => /:p7$/.test(c[0].label))).toBe(true);
    expect(renderPageCandidates.mock.calls.some(c => /:p5$/.test(c[0].label))).toBe(false);
  });

  test('whole-book replay from the manifest renders nothing and re-signs the URLs', async () => {
    loadJson.mockImplementation(async (key) => {
      if (/manifest\.json$/.test(key)) return { interiorKey: 'k/interior.pdf', coverKey: 'k/cover.pdf', thumbKey: 'k/thumb.png', previewKeys: ['k/p1.png'], pageCount: 24, coloringPageCount: 20, pages: [{ index: 1, kind: 'meet', storageKey: 'k/sheet.png' }], gates: { contact: null, stroke: null }, preflight: { ok: true }, advisories: [] };
      throw new Error('not found');
    });
    objectExists.mockResolvedValue(true);
    const r = await generateColoringBook(args());
    expect(r.cached).toBe(true);
    expect(r.interiorPdfUrl).toBe('https://signed/k/interior.pdf');
    expect(r.pages[0].url).toBe('https://signed/k/sheet.png');
    expect(renderPageCandidates).not.toHaveBeenCalled();
    expect(buildInteriorPdf).not.toHaveBeenCalled();
  });

  test('the hero line sheet is required by default; degraded, the meet page becomes a hero portrait', async () => {
    getHeroLineSheet.mockRejectedValue(Object.assign(new Error('no candidate passed'), { failureCode: 'coloring_identity_failed', advisories: [{ stage: 'coloringSheet', note: 'c1 rejected' }] }));
    await expect(generateColoringBook(args())).rejects.toMatchObject({ failureCode: 'coloring_identity_failed' });
    expect(renderPageCandidates).not.toHaveBeenCalled();
    process.env.CATALOG_COLORING_SHEET_REQUIRED = '0';
    const r = await generateColoringBook(args());
    expect(r.pages[0].kind).toBe('hero_portrait');
    expect(r.pages.filter(p => p.kind === 'meet').length).toBe(0);
    expect(r.advisories.some(a => /hero line sheet unavailable/.test(a.note))).toBe(true);
    expect(renderPageCandidates).toHaveBeenCalledTimes(20);
  });

  test('no anchor at all fails missing_identity_reference before any spend', async () => {
    await expect(generateColoringBook(args({ approvedCoverUrl: null, childPhotoUrl: null }))).rejects.toMatchObject({ failureCode: 'missing_identity_reference' });
    expect(buildBookBible).not.toHaveBeenCalled();
  });

  test('a subset renders only those pages and builds no PDFs', async () => {
    const r = await generateColoringBook(args({ pages: [2, 3] }));
    expect(r.subset).toBe(true);
    expect(r.pages.map(p => p.index)).toEqual([2, 3]);
    expect(r.interiorPdfUrl).toBeNull();
    expect(renderPageCandidates).toHaveBeenCalledTimes(2);
    expect(buildInteriorPdf).not.toHaveBeenCalled();
    expect(saveJson).not.toHaveBeenCalled();
  });

  test('a contact-gate finding re-renders the flagged fresh page once with the consistency note and adopts a clean result', async () => {
    runColoringContactGate.mockResolvedValue({ hero: { pass: false, flagged: [{ page: 4, defect: 'character_rendering', note: 'longer hair' }], checked: 19 }, companion: null });
    const r = await generateColoringBook(args());
    const gateCall = renderPageCandidates.mock.calls.find(c => isGate(c[0].label));
    expect(gateCall).toBeDefined();
    expect(gateCall[0].pass).toBe(10);
    expect(gateCall[0].prompts.original).toMatch(/CONSISTENCY REPAIR: on the other pages of this book Emma/);
    expect(r.pages.find(p => p.index === 4).gateRepaired).toBe(true);
    expect(r.advisories.some(a => /character_rendering: longer hair/.test(a.note))).toBe(true);
    expect(r.gates.contact.hero.flagged.length).toBe(1);
  });

  test('cancellation surfaces as failureCode cancelled', async () => {
    const controller = new AbortController();
    buildBookBible.mockImplementation(async () => { controller.abort(); return { hash: 'bh', advisories: [], sheet: img('sheet'), outfit: null, props: [], companion: null, worldPlate: null, emotion: null }; });
    await expect(generateColoringBook(args({ abortSignal: controller.signal }))).rejects.toMatchObject({ failureCode: 'cancelled' });
  });
});
