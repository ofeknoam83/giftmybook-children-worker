/**
 * The Book Bible render path (ce-9) end to end, with the bible modules
 * mocked: the reference pack and prompt blocks reach every render, N
 * candidates render beside the shipped key and the best is promoted, the
 * repair loop runs only on blocking defects, blocking residuals fail the
 * book `consistency_unresolved` (or ship under the opt-in switch), the
 * identity kit is required by default, an old-version marker re-checks,
 * and a fallback-rung render is never silent.
 */

jest.mock('../../../services/illustrationGenerator', () => ({
  generateIllustration: jest.fn(),
  downloadPhotoAsBase64: jest.fn().mockResolvedValue({ base64: 'Y292ZXI=', mimeType: 'image/jpeg' }),
  fetchWithTimeout: jest.fn().mockRejectedValue(new Error('offline test')),
  getNextApiKey: jest.fn().mockReturnValue('test-key'),
  isModestBathWaterScene: jest.fn().mockReturnValue(false),
}));
jest.mock('../../../services/gcsStorage', () => ({
  downloadBuffer: jest.fn(),
  uploadBuffer: jest.fn().mockResolvedValue(undefined),
  uploadBufferIfAbsent: jest.fn().mockResolvedValue({ created: true }),
  deletePrefix: jest.fn().mockResolvedValue(undefined),
  getSignedUrl: jest.fn(async (key) => `https://signed.example/${key}`),
}));
jest.mock('../../../services/catalogEngine/illustrator/bible/characterSheet', () => ({ getCharacterSheet: jest.fn() }));
jest.mock('../../../services/catalogEngine/illustrator/bible/propSheet', () => ({
  getBibleProps: jest.fn(),
  normalizePropValue: (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim(),
}));
jest.mock('../../../services/catalogEngine/illustrator/outfitLock', () => ({ getOutfitLock: jest.fn() }));
jest.mock('../../../services/catalogEngine/illustrator/worldPlate', () => ({ getWorldPlate: jest.fn().mockResolvedValue(null) }));
jest.mock('../../../services/catalogEngine/illustrator/emotionPlan', () => ({
  EMOTIONS: ['joy', 'wonder', 'curiosity', 'determination', 'worry', 'calm', 'surprise', 'pride', 'tenderness', 'silly'],
  EMOTION_CUES: { wonder: 'eyes wide, mouth open', joy: 'big smile' },
  getEmotionPlan: jest.fn(),
  renderEmotionLine: (e) => (e ? `EMOTION (this spread): ${e.intensity} ${e.emotion} — cue.` : ''),
}));
jest.mock('../../../services/catalogEngine/illustrator/spreadQa', () => ({
  checkSpreadRenderV2: jest.fn(),
  repairNoteV2: jest.fn(() => 'CRITICAL REPAIR — fixed note'),
  checkWorldConsistency: jest.fn().mockResolvedValue({ pass: true, flagged: [] }),
  worldRepairNote: jest.fn(() => 'WORLD REPAIR'),
  classifyDefects: jest.fn(),
}));
jest.mock('../../../services/catalogEngine/illustrator/metrics', () => ({
  bboxRules: jest.fn(() => ({ offCenterOk: true, safeZoneOk: true, shotSizeOk: null, notes: [] })),
  cropBbox: jest.fn().mockResolvedValue(Buffer.from('crop')),
  regionColours: jest.fn().mockResolvedValue(null),
  outfitColourCheck: jest.fn(),
  identityScore: jest.fn().mockResolvedValue(null),
  embedImage: jest.fn().mockResolvedValue(null),
  outlierSpreads: jest.fn(() => []),
  textInkColour: jest.fn().mockResolvedValue(null),
  inkSetOutliers: jest.fn(() => ({ referenceHex: null, flagged: [] })),
}));
jest.mock('../../../services/catalogEngine/illustrator/contactSheet', () => ({
  checkCharacterContactSheet: jest.fn().mockResolvedValue({ pass: true, flagged: [], checked: 2 }),
  checkPropContactSheet: jest.fn().mockResolvedValue({ pass: true, flagged: [], checked: 2 }),
  contactRepairNote: jest.fn((defect, o) => `REPAIR ${defect} ref=${o && o.referenceIndex}`),
  CONTACT_REPAIR_INSTRUCTIONS: { prop_rendering: 'Draw the prop EXACTLY as its reference sheet.' },
}));

const { generateIllustration } = require('../../../services/illustrationGenerator');
const { downloadBuffer, uploadBuffer } = require('../../../services/gcsStorage');
const { getCharacterSheet } = require('../../../services/catalogEngine/illustrator/bible/characterSheet');
const { getBibleProps } = require('../../../services/catalogEngine/illustrator/bible/propSheet');
const { getOutfitLock } = require('../../../services/catalogEngine/illustrator/outfitLock');
const { getEmotionPlan } = require('../../../services/catalogEngine/illustrator/emotionPlan');
const { checkSpreadRenderV2 } = require('../../../services/catalogEngine/illustrator/spreadQa');
const { inkSetOutliers } = require('../../../services/catalogEngine/illustrator/metrics');
const { checkCharacterContactSheet, checkPropContactSheet } = require('../../../services/catalogEngine/illustrator/contactSheet');
const { renderStorySpreads, illustrateStory } = require('../../../services/catalogEngine/illustrator');
const { getBook } = require('../../../services/catalogEngine/catalog');
const { QA_VERSION } = require('../../../services/catalogEngine/versions');
const { fnv1a } = require('../../../services/catalogEngine/selection');

const BOOK_ID = 'farm_2_3_hello_farm';
const PROFILE = { name: 'Emma', age: 2, pronouns: { subject: 'she', object: 'her', possessive_adjective: 'her' } };
const SHEET = { base64: 'c2hlZXQ=', mimeType: 'image/png', hash: 'sheethash', storageKey: 'catalog-assets/character-sheets/ce-9/a.png', likeness: 0.9, candidates: 3, advisories: [] };
const OUTFIT = { outfit: 'Top: red t-shirt. Bottom: blue jeans. Footwear: white sneakers.', hash: 'outfithash', source: 'sheet', spec: { top: { desc: 'red t-shirt', colourHex: ['#ff0000'] } } };
const PROP_SHEET = { key: 'teddy bear', kind: 'prop', base64: 'cHJvcA==', mimeType: 'image/png', hash: 'prophash', storageKey: 'catalog-assets/prop-sheets/ce-9/farm-x.png', specText: 'a small honey-brown plush bear' };

const story = (spreadNos, evidence = []) => ({
  book_id: BOOK_ID,
  spreads: spreadNos.map(n => ({ spread: n, text: `Spread ${n} text.` })),
  personalization_evidence: evidence,
});
const cleanQa = (over = {}) => ({ pass: true, defects: [], blocking: [], advisory: [], textSizeRatio: 1, verdict: {}, bbox: { x: 0.6, y: 0.2, w: 0.25, h: 0.7 }, refs: { sheetRef: 2, props: [], companionRef: null }, ...over });
const blockingQa = (d) => ({ pass: false, defects: [d], blocking: [d], advisory: [], verdict: {}, bbox: null, refs: { sheetRef: 2, props: [], companionRef: null } });

const baseParams = (over = {}) => ({
  bookId: 'bible-book-1',
  story: story(over.spreadNos || [1, 3], over.evidence),
  bookDef: getBook(BOOK_ID),
  profile: PROFILE,
  approvedCoverUrl: 'https://covers.example/cover.png?sig=1',
  childPhotoUrl: null,
  characterDescription: 'short curly dark hair, light brown skin',
  spreads: over.spreadNos || [1, 3],
  log: () => {},
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.CATALOG_RENDER_CANDIDATES;
  process.env.CATALOG_SHIP_ON_EXHAUSTION = '0';
  delete process.env.CATALOG_SHEET_REQUIRED;
  delete process.env.CATALOG_CHARACTER_SHEET;
  delete process.env.CATALOG_SPREAD_QA_MAX_REPAIRS;
  delete process.env.CATALOG_DRIFT_MAX_REPAIRS;
  getCharacterSheet.mockResolvedValue({ ...SHEET });
  getOutfitLock.mockResolvedValue({ ...OUTFIT });
  getBibleProps.mockResolvedValue({ props: [], companion: null, advisories: [] });
  getEmotionPlan.mockResolvedValue({ plan: { 1: { emotion: 'wonder', intensity: 'soft', source: 'table' }, 3: { emotion: 'joy', intensity: 'clear', source: 'table' } }, hash: 'emo', source: 'table' });
  checkSpreadRenderV2.mockResolvedValue(cleanQa());
  inkSetOutliers.mockReturnValue({ referenceHex: null, flagged: [] });
  // Cache misses on the first download of every key; later downloads
  // return distinct bytes per key so candidates are distinguishable.
  const seen = new Map();
  downloadBuffer.mockImplementation(async (key) => {
    if (key.endsWith('.qa.json')) throw new Error('no marker');
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    // Candidate keys (`.cK` / `.rPcK`) are never cache-checked — only
    // downloaded right after their own render.
    if (n === 1 && !/\.(?:r\d+)?c\d\.png$/.test(key)) throw new Error('cache miss');
    return Buffer.from(`png:${key}`);
  });
  generateIllustration.mockImplementation(async (scene, ref, style, opts) => `https://gcs.example/${opts.gcsPath}`);
});

test('the reference pack, bible blocks and outfit spec ride every render; the bible hash folds into the key; bookBible is echoed', async () => {
  const { results, bookBible, outfitLockUsed, storyHash } = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
  expect(results[0].buffer).not.toBeNull();
  expect(storyHash).toMatch(/-b[0-9a-z]+$/);
  const opts = generateIllustration.mock.calls[0][3];
  expect(opts.referencePack.map(r => r.kind)).toEqual(['characterSheet', 'cover']);
  expect(opts.referencePack[0].base64).toBe(SHEET.base64);
  expect(opts.bible).toMatchObject({ characterSheetRef: 1, coverRef: 2, outfitSpecText: OUTFIT.outfit, hairLine: 'short curly dark hair, light brown skin' });
  expect(opts.bible.emotionLine).toContain('soft wonder');
  expect(opts.characterOutfit).toBe(OUTFIT.outfit);
  expect(getOutfitLock).toHaveBeenCalledWith(expect.objectContaining({ source: 'sheet', sourceHash: 'sheethash' }));
  expect(outfitLockUsed).toBe('outfithash');
  expect(bookBible).toMatchObject({ characterSheet: { hash: 'sheethash', likeness: 0.9 }, outfitSpec: { text: OUTFIT.outfit, source: 'sheet' }, bibleHash: expect.any(String) });
  // QA was checked AGAINST the sheet, with the beat, the emotion and the closed vocabulary
  const qaOpts = checkSpreadRenderV2.mock.calls[0][1];
  expect(qaOpts.sheet.base64).toBe(SHEET.base64);
  expect(qaOpts.outfitSpec).toBe(OUTFIT.outfit);
  expect(qaOpts.beat).toContain('Child gets ready');
  expect(qaOpts.emotion).toMatchObject({ emotion: 'wonder', intensity: 'soft' });
  expect(qaOpts.emotionVocabulary).toContain('wonder');
});

test('N=2 candidates render beside the shipped key; the higher-scoring one is promoted and its verdict is kept', async () => {
  process.env.CATALOG_RENDER_CANDIDATES = '2';
  checkSpreadRenderV2
    .mockResolvedValueOnce(blockingQa('outfit break: bottom differs from the locked outfit spec')) // c1
    .mockResolvedValueOnce(cleanQa()); // c2
  const { results } = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
  const keys = generateIllustration.mock.calls.map(c => c[3].gcsPath);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/spread-1\.square\.c1\.png$/);
  expect(keys[1]).toMatch(/spread-1\.square\.c2\.png$/);
  // the clean candidate (c2) was promoted to the canonical key
  const promoted = uploadBuffer.mock.calls.find(c => c[1] === results[0].storageKey && c[2] === 'image/png');
  expect(promoted).toBeTruthy();
  expect(promoted[0].toString()).toBe(`png:${keys[1]}`);
  expect(results[0].blocking).toEqual([]);
  expect(results[0].candidates.map(c => c.k)).toEqual([1, 2]);
  // the marker records the verdict + QA version, not unresolved
  const marker = JSON.parse(uploadBuffer.mock.calls.find(c => c[1].endsWith('.qa.json'))[0].toString());
  expect(marker).toMatchObject({ qaVersion: QA_VERSION, qa: { blocking: [] } });
  expect(marker.unresolved).toBeUndefined();
});

test('blocking residuals after candidates + repairs fail the book consistency_unresolved with the candidates attached', async () => {
  process.env.CATALOG_RENDER_CANDIDATES = '1';
  process.env.CATALOG_SPREAD_QA_MAX_REPAIRS = '1';
  process.env.CATALOG_DRIFT_MAX_REPAIRS = '1';
  checkSpreadRenderV2.mockResolvedValue(blockingQa('prop missing: "teddy bear"'));
  const evidence = [{ spread: 1, moment_type: 'object_presence', source_field: 'object', source_value: 'teddy bear', visual_required: true }];
  // A full book renders every beat (12); every spread carries the residual.
  const err = await illustrateStory(baseParams({ spreadNos: [1, 3], evidence })).catch(e => e);
  expect(err.failureCode).toBe('consistency_unresolved');
  expect(err.unresolved.map(u => u.spread)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  expect(err.unresolved[0].defects).toEqual(['prop missing: "teddy bear"']);
  // Every attempt, including the base, keeps its own pickable bytes.
  expect(err.unresolved[0].candidates.map(c => c.storageKey)).toEqual([
    expect.stringMatching(/spread-1\.square\.c1\.png$/),
    expect.stringMatching(/spread-1\.square\.r1c1\.png$/),
    expect.stringMatching(/spread-1\.square\.r2c1\.png$/),
  ]);
  expect(err.unresolved[0].candidates[1]).toMatchObject({ pass: 'repair1', url: expect.stringContaining('https://signed.example/') });
  expect(err.bookBible).toBeTruthy();
  // base + 1 general + 1 drift repair per spread = 3 renders per spread
  expect(generateIllustration).toHaveBeenCalledTimes(12 * 3);
  // the marker never vouches for an unresolved render
  const marker = JSON.parse(uploadBuffer.mock.calls.filter(c => c[1].endsWith('.qa.json')).pop()[0].toString());
  expect(marker.unresolved).toBe(true);
});

test('CATALOG_SHIP_ON_EXHAUSTION=1 ships blocking residuals with a book-level advisory instead of failing', async () => {
  process.env.CATALOG_SHIP_ON_EXHAUSTION = '1';
  process.env.CATALOG_RENDER_CANDIDATES = '1';
  process.env.CATALOG_SPREAD_QA_MAX_REPAIRS = '0';
  process.env.CATALOG_DRIFT_MAX_REPAIRS = '0';
  checkSpreadRenderV2.mockResolvedValue(blockingQa('duplicated child hero'));
  const art = await illustrateStory(baseParams({ spreadNos: [1], spreads: [1] }));
  expect(art.entries).toHaveLength(12); // a full book always renders every beat
  expect(art.qaAdvisories).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: 'shipPolicy', note: expect.stringContaining('Automatically used') }),
    expect.objectContaining({ stage: 'spreadQa', spread: 1, note: expect.stringContaining('BLOCKING residual defects (repairs disabled)') }),
  ]));
});

test('advisory-only defects never trigger repairs and ship with an advisory', async () => {
  process.env.CATALOG_RENDER_CANDIDATES = '1';
  checkSpreadRenderV2.mockResolvedValue(cleanQa({ pass: false, defects: ['emotion mismatch: reads as joy instead of wonder'], advisory: ['emotion mismatch: reads as joy instead of wonder'] }));
  const { results } = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
  expect(generateIllustration).toHaveBeenCalledTimes(1);
  expect(results[0].blocking).toEqual([]);
  expect(results[0].advisories).toEqual(expect.arrayContaining([expect.objectContaining({ note: expect.stringContaining('shipped with advisory defects: emotion mismatch') })]));
});

test('the identity kit is required by default (identity_kit_failed); CATALOG_SHEET_REQUIRED=0 renders sheet-less with an advisory', async () => {
  const boom = Object.assign(new Error('no candidate passed QA'), { failureCode: 'identity_kit_failed', advisories: [{ stage: 'characterSheet', note: 'candidate 1 rejected' }] });
  getCharacterSheet.mockRejectedValue(boom);
  await expect(renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }))).rejects.toMatchObject({ failureCode: 'identity_kit_failed' });
  expect(generateIllustration).not.toHaveBeenCalled();

  process.env.CATALOG_SHEET_REQUIRED = '0';
  getOutfitLock.mockResolvedValueOnce({ outfit: 'Top: red. Bottom: jeans. Footwear: shoes.', hash: 'coverlock' });
  const { results, advisories, bookBible } = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
  expect(results[0].buffer).not.toBeNull();
  expect(advisories).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'characterSheet', note: expect.stringContaining('NOT anchored on a character model sheet') })]));
  expect(bookBible.characterSheet).toBeNull();
  expect(generateIllustration.mock.calls[0][3].referencePack.map(r => r.kind)).toEqual(['cover']);
});

test('prop and companion sheets ride the pack only on the spreads that carry them, with their specs in the PROPS block', async () => {
  process.env.CATALOG_RENDER_CANDIDATES = '1';
  getBibleProps.mockResolvedValue({ props: [{ value: 'teddy bear', sheet: PROP_SHEET }], companion: null, advisories: [] });
  const evidence = [{ spread: 3, moment_type: 'object_presence', source_field: 'object', source_value: 'Teddy Bear', visual_required: true }];
  await renderStorySpreads(baseParams({ spreadNos: [1, 3, 5], spreads: [1, 3, 5], evidence }));
  const bySpread = Object.fromEntries(generateIllustration.mock.calls.map(c => [c[3].spreadIndex + 1, c[3]]));
  expect(bySpread[1].referencePack.map(r => r.kind)).toEqual(['characterSheet', 'cover']);
  expect(bySpread[3].referencePack.map(r => r.kind)).toEqual(['characterSheet', 'cover', 'prop']);
  expect(bySpread[3].bible.props).toEqual([{ name: 'Teddy Bear', specText: 'a small honey-brown plush bear', ref: 3, carried: false }]);
  // carried through on the later spread (ce-6) with the same sheet
  expect(bySpread[5].referencePack.map(r => r.kind)).toEqual(['characterSheet', 'cover', 'prop']);
  expect(bySpread[5].bible.props[0]).toMatchObject({ name: 'Teddy Bear', carried: true, ref: 3 });
  const qa5 = checkSpreadRenderV2.mock.calls.find(c => c[1].label.includes(':s5:'))[1];
  // carried on spread 5 (declared on 3): its absence is advisory, not blocking
  expect(qa5.props).toEqual([{ name: 'Teddy Bear', specText: 'a small honey-brown plush bear', sheet: { base64: PROP_SHEET.base64, mimeType: 'image/png' }, expected: 'carried' }]);
  const qa3 = checkSpreadRenderV2.mock.calls.find(c => c[1].label.includes(':s3:'))[1];
  expect(qa3.props[0]).toMatchObject({ name: 'Teddy Bear', expected: 'required' });
});

test('the bible hash folds each prop sheet\'s SPEC hash beside its pixels; a prop named __proto__ still gets its sheet', async () => {
  process.env.CATALOG_RENDER_CANDIDATES = '1';
  const evidence = [{ spread: 3, moment_type: 'object_presence', source_field: 'object', source_value: 'teddy bear', visual_required: true }];
  getBibleProps.mockResolvedValue({ props: [{ value: 'teddy bear', sheet: { ...PROP_SHEET, specHash: 'specA' } }], companion: null, advisories: [] });
  const a = await renderStorySpreads(baseParams({ spreadNos: [3], spreads: [3], evidence }));
  getBibleProps.mockResolvedValue({ props: [{ value: 'teddy bear', sheet: { ...PROP_SHEET, specHash: 'specB' } }], companion: null, advisories: [] });
  const b = await renderStorySpreads(baseParams({ spreadNos: [3], spreads: [3], evidence }));
  expect(a.storyHash).toMatch(/-b[0-9a-z]+$/);
  expect(a.storyHash).not.toBe(b.storyHash); // same pixels, re-derived spec ⇒ never a replay under the old spec
  expect(a.bookBible.bibleHash).not.toBe(b.bookBible.bibleHash);

  // Prop values are profile data — an inherited-key name is still a prop.
  const hostile = [{ spread: 3, moment_type: 'object_presence', source_field: 'object', source_value: '__proto__', visual_required: true }];
  getBibleProps.mockResolvedValue({ props: [{ value: '__proto__', sheet: { ...PROP_SHEET, key: '__proto__' } }], companion: null, advisories: [] });
  generateIllustration.mockClear();
  await renderStorySpreads(baseParams({ spreadNos: [3], spreads: [3], evidence: hostile }));
  const opts = generateIllustration.mock.calls[0][3];
  expect(opts.referencePack.map(r => r.kind)).toEqual(['characterSheet', 'cover', 'prop']);
  expect(opts.bible.props[0]).toMatchObject({ name: '__proto__', ref: 3 });
});

test('the contact gate tiles the child and each prop from their QA crops (a spread without a box is a named FULL tile) and a prop repair cites the prop sheet', async () => {
  process.env.CATALOG_RENDER_CANDIDATES = '1';
  process.env.CATALOG_CONTACT_MAX_RERENDERS = '3';
  getBibleProps.mockResolvedValue({ props: [{ value: 'teddy bear', sheet: PROP_SHEET }], companion: null, advisories: [] });
  const evidence = [{ spread: 3, moment_type: 'object_presence', source_field: 'object', source_value: 'Teddy Bear', visual_required: true }];
  const boxed = cleanQa({ propBoxes: [{ name: 'Teddy Bear', bbox: { x: 0.1, y: 0.6, w: 0.15, h: 0.2 } }] });
  checkSpreadRenderV2.mockImplementation(async (buf, { label }) => (label.includes(':s5:') ? cleanQa({ bbox: null, propBoxes: [{ name: 'Teddy Bear', bbox: null }] }) : boxed));
  checkPropContactSheet.mockResolvedValueOnce({ pass: false, flagged: [{ spread: 5, note: 'a different bear' }], checked: 2 });
  const { results, contactQa } = await renderStorySpreads(baseParams({ spreadNos: [1, 3, 5], spreads: [1, 3, 5], evidence }));
  expect(results.map(r => r.spread)).toEqual([1, 3, 5]);
  // Child tiles: crops where the verdict gave a box, the whole spread named FULL where it did not.
  const childTiles = checkCharacterContactSheet.mock.calls[0][0].tiles;
  expect(childTiles.map(t => [t.spread, t.cropped])).toEqual([[1, true], [3, true], [5, false]]);
  // Prop tiles: the prop's own crop on spread 3 (declared) and the FULL spread on 5 (carried, no box).
  const propCall = checkPropContactSheet.mock.calls[0][0];
  expect(propCall.propSheet.name).toBe('teddy bear');
  const originalSpread5 = generateIllustration.mock.calls.find(c => c[3].spreadIndex === 4)[3].gcsPath;
  expect(propCall.tiles.map(t => [t.spread, t.cropped, t.buffer.toString()])).toEqual([[3, true, 'crop'], [5, false, `png:${originalSpread5}`]]);
  // The flagged spread re-rendered once with the prop-sheet-citing repair note (REFERENCE 3: sheet, cover, prop).
  expect(contactQa).toMatchObject({ pass: false, rerendered: [5] });
  const repair = generateIllustration.mock.calls.at(-1);
  expect(repair[3].spreadIndex).toBe(4);
  expect(repair[0]).toContain('broke prop consistency for "teddy bear". REPAIR prop_rendering ref=3');
  expect(repair[0]).not.toContain('REFERENCE <n>');
});

test('N=1: a repair that scores WORSE renders beside the key and never overwrites the better base render', async () => {
  process.env.CATALOG_RENDER_CANDIDATES = '1';
  process.env.CATALOG_SPREAD_QA_MAX_REPAIRS = '1';
  process.env.CATALOG_DRIFT_MAX_REPAIRS = '0';
  const worse = { pass: false, defects: ['duplicated child hero', 'painted text in the art'], blocking: ['duplicated child hero', 'painted text in the art'], advisory: [], verdict: {}, bbox: null, refs: { sheetRef: 2, props: [], companionRef: null } };
  checkSpreadRenderV2
    .mockResolvedValueOnce(blockingQa('duplicated child hero')) // base
    .mockResolvedValueOnce(worse); // repair 1
  const { results } = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
  const keys = generateIllustration.mock.calls.map(c => c[3].gcsPath);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/spread-1\.square\.c1\.png$/);
  expect(keys[1]).toMatch(/spread-1\.square\.r1c1\.png$/); // the repair renders BESIDE it
  // the rejected repair was never copied over the base render
  const promotions = uploadBuffer.mock.calls.filter(c => c[1] === results[0].storageKey && c[2] === 'image/png');
  expect(promotions).toHaveLength(1);
  expect(promotions[0][0].toString()).toBe(`png:${keys[0]}`);
  expect(results[0].buffer.toString()).toBe(`png:${keys[0]}`);
  expect(results[0].blocking).toEqual(['duplicated child hero']);
  // the failure payload offers only candidates that still hold their own bytes
  expect(results[0].candidateFiles.map(c => c.storageKey)).toEqual(keys);
});

test('an UNCHECKED repair (checker outage mid-loop) never replaces the checked render; the marker records unresolved', async () => {
  process.env.CATALOG_RENDER_CANDIDATES = '1';
  process.env.CATALOG_SPREAD_QA_MAX_REPAIRS = '1';
  process.env.CATALOG_DRIFT_MAX_REPAIRS = '0';
  checkSpreadRenderV2
    .mockResolvedValueOnce(blockingQa('duplicated child hero'))
    .mockResolvedValueOnce({ pass: true, defects: [], blocking: [], advisory: [], qaUnavailable: 'spread QA HTTP 503', verdict: null, bbox: null, refs: { sheetRef: 2, props: [], companionRef: null } });
  const { results } = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
  expect(generateIllustration).toHaveBeenCalledTimes(2);
  expect(results[0].buffer.toString()).toBe(`png:${generateIllustration.mock.calls[0][3].gcsPath}`);
  expect(results[0].blocking).toEqual(['duplicated child hero']);
  expect(results[0].advisories).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: 'spreadQa', note: expect.stringContaining('repair could not be verified (spread QA HTTP 503) — kept the checked render') }),
  ]));
  expect(results[0].advisories.some(a => /UNCHECKED/.test(a.note))).toBe(false);
  // the unchecked candidate ranks below the checked one on the candidate list
  expect(results[0].candidateFiles).toEqual([
    expect.objectContaining({ storageKey: expect.stringMatching(/\.c1\.png$/) }),
    expect.objectContaining({ storageKey: expect.stringMatching(/r1c1\.png$/), score: 40 }),
  ]);
  const marker = JSON.parse(uploadBuffer.mock.calls.filter(c => c[1].endsWith('.qa.json')).pop()[0].toString());
  expect(marker).toMatchObject({ unresolved: true, qa: { blocking: ['duplicated child hero'] } });
});

test('CATALOG_SHIP_ON_EXHAUSTION=1: the marker records the shipped defects and a replay keeps reporting them; switch off and it re-checks', async () => {
  process.env.CATALOG_SHIP_ON_EXHAUSTION = '1';
  process.env.CATALOG_RENDER_CANDIDATES = '1';
  process.env.CATALOG_SPREAD_QA_MAX_REPAIRS = '0';
  process.env.CATALOG_DRIFT_MAX_REPAIRS = '0';
  checkSpreadRenderV2.mockResolvedValue(blockingQa('duplicated child hero'));
  const first = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
  expect(first.unresolved.map(u => u.spread)).toEqual([1]);
  const markerBuf = uploadBuffer.mock.calls.filter(c => c[1].endsWith('.qa.json')).pop()[0];
  const marker = JSON.parse(markerBuf.toString());
  expect(marker).toMatchObject({ unresolved: true, shippedOnExhaustion: true, qa: { blocking: ['duplicated child hero'] } });
  const storageKey = first.results[0].storageKey;

  // Replay under the switch: no render, no re-check, the defects stay on record.
  downloadBuffer.mockImplementation(async key => (key.endsWith('.qa.json') ? markerBuf : first.results[0].buffer));
  generateIllustration.mockClear();
  checkSpreadRenderV2.mockClear();
  const replay = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
  expect(generateIllustration).not.toHaveBeenCalled();
  expect(checkSpreadRenderV2).not.toHaveBeenCalled();
  expect(replay.results[0]).toMatchObject({ storageKey, fresh: false, blocking: ['duplicated child hero'] });
  expect(replay.unresolved.map(u => u.spread)).toEqual([1]);
  expect(replay.advisories).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'shipPolicy' })]));

  // Switch off: the unresolved marker never vouches — the replay re-checks.
  process.env.CATALOG_SHIP_ON_EXHAUSTION = '0';
  const rechecked = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
  expect(checkSpreadRenderV2).toHaveBeenCalledTimes(1);
  expect(checkSpreadRenderV2.mock.calls[0][1].label).toContain(':recheck');
  expect(generateIllustration).not.toHaveBeenCalled(); // no repair budget
  expect(rechecked.results[0].blocking).toEqual(['duplicated child hero']);
});

test('a cached render whose marker predates QA_VERSION is re-checked, never trusted', async () => {
  process.env.CATALOG_RENDER_CANDIDATES = '1';
  const png = Buffer.from('png-bytes');
  downloadBuffer.mockImplementation(async (key) => {
    if (key.endsWith('.qa.json')) return Buffer.from(JSON.stringify({ advisories: [{ stage: 'spreadQa', spread: 1, note: 'old verdict' }], renderHash: fnv1a(png.toString('base64')).toString(36), qaVersion: 'qa-1' }));
    return png;
  });
  const { results } = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
  expect(generateIllustration).not.toHaveBeenCalled();
  expect(checkSpreadRenderV2).toHaveBeenCalledTimes(1);
  expect(results[0].fresh).toBe(false);
  expect(results[0].advisories).not.toEqual(expect.arrayContaining([expect.objectContaining({ note: 'old verdict' })]));
});

test('a render accepted on a safety-fallback rung is never silent', async () => {
  process.env.CATALOG_RENDER_CANDIDATES = '1';
  generateIllustration.mockImplementation(async (scene, ref, style, opts) => {
    opts.attemptLog.push({ attempt: 1, variant: 'original', error: 'NSFW', nsfw: true });
    opts.attemptLog.push({ attempt: 2, variant: 'sanitized', accepted: true });
    return `https://gcs.example/${opts.gcsPath}`;
  });
  const { results } = await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] }));
  expect(results[0].advisories).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'render', note: expect.stringContaining('"sanitized" fallback prompt') })]));
});

describe('ce-18: the book has ONE ink — pinned, measured, and never copied from a defective page', () => {
  const INK = require('../../../services/shared/illustration/config').TEXT_RULES.fontColorHex;
  const inked = (hex) => cleanQa({ textInk: { hex, deltaE: 1, polarity: 'dark', pass: true, pixels: 900 } });

  test('the pinned hex reaches the checker and the repair options on embedded renders only', async () => {
    await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1], textLayout: 'embedded' }));
    expect(checkSpreadRenderV2.mock.calls[0][1].inkHex).toBe(INK);
    expect(INK).toMatch(/^#[0-9A-Fa-f]{6}$/);
    checkSpreadRenderV2.mockClear();
    await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1] })); // caption: nothing painted
    expect(checkSpreadRenderV2.mock.calls[0][1].inkHex).toBeNull();
  });

  test('CATALOG_TEXT_INK_QA=0 stops the measurement (the ink still rides the prompt)', async () => {
    process.env.CATALOG_TEXT_INK_QA = '0';
    try {
      await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1], textLayout: 'embedded' }));
      expect(checkSpreadRenderV2.mock.calls[0][1].inkHex).toBeNull();
      expect(inkSetOutliers).not.toHaveBeenCalled();
    } finally {
      delete process.env.CATALOG_TEXT_INK_QA;
    }
  });

  test('the set gate holds every spread to the book\'s median ink and re-renders the outlier', async () => {
    checkSpreadRenderV2.mockImplementation(async (buf, { label }) => (label.includes(':s3:') ? inked('#F5F0E6') : inked('#2A1C12')));
    inkSetOutliers.mockReturnValue({ referenceHex: '#2A1C12', flagged: [{ spread: 3, hex: '#F5F0E6', deltaE: 81.6 }] });
    const { results, textInkQa } = await renderStorySpreads(baseParams({ spreadNos: [1, 3], spreads: [1, 3], textLayout: 'embedded' }));
    // Measured inks (replayed spreads included) are what the gate compares;
    // whether two of them are comparable at all is inkSetOutliers' own rule
    // (it needs three — see textInk.test.js), mocked here to exercise the wiring.
    expect(inkSetOutliers).toHaveBeenCalledWith([
      { spread: 1, hex: '#2A1C12' }, { spread: 3, hex: '#F5F0E6' },
    ]);
    expect(textInkQa).toMatchObject({ pass: false, checked: 2, referenceHex: '#2A1C12', rerendered: [3] });
    const s3 = results.find(r => r.spread === 3);
    expect(s3.advisories.some(a => a.stage === 'textInk' && a.note.includes('#F5F0E6'))).toBe(true);
  });

  test('a consistent book passes the gate without spending a re-render', async () => {
    checkSpreadRenderV2.mockResolvedValue(inked('#2A1C12'));
    const { textInkQa } = await renderStorySpreads(baseParams({ spreadNos: [1, 3], spreads: [1, 3], textLayout: 'embedded' }));
    expect(textInkQa).toEqual({ pass: true, checked: 2, referenceHex: null });
  });

  test('the measured ink rides the QA marker, so a replayed spread still counts toward the book\'s ink', async () => {
    checkSpreadRenderV2.mockResolvedValue(inked('#2A1C12'));
    await renderStorySpreads(baseParams({ spreadNos: [1], spreads: [1], textLayout: 'embedded' }));
    const marker = uploadBuffer.mock.calls.find(c => String(c[1]).endsWith('.qa.json'));
    expect(JSON.parse(marker[0].toString('utf8')).qa.textInk).toMatchObject({ hex: '#2A1C12' });
  });

  test('an anchor page whose OWN painted text is blocking is never elected — no page copies its defect', async () => {
    checkSpreadRenderV2.mockResolvedValue(blockingQa("embedded story text ink colour differs (painted #f5f0e6, the book's ink is #2A1C12)"));
    process.env.CATALOG_SHIP_ON_EXHAUSTION = '1'; // let the run finish so the advisory is observable
    try {
      const { typographyAnchorUsed, advisories } = await renderStorySpreads(baseParams({ spreadNos: [1, 3], spreads: [1, 3], textLayout: 'embedded' }));
      expect(typographyAnchorUsed).toBe('none');
      expect(advisories).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 'typographyAnchor', note: expect.stringContaining('own painted text is blocking') }),
      ]));
      // Exactly one anchor advisory: the guard's, not the generic "no crop" one.
      expect(advisories.filter(a => a.stage === 'typographyAnchor')).toHaveLength(1);
    } finally {
      delete process.env.CATALOG_SHIP_ON_EXHAUSTION;
    }
  });

  test('the first page chooses a suitable small-text candidate within its existing render budget', async () => {
    process.env.CATALOG_TEXT_ANCHOR_CANDIDATES = '2';
    const notes = ['emotion mismatch', 'composition advice', 'minor hand advice'];
    checkSpreadRenderV2
      .mockResolvedValueOnce(cleanQa({ textSizeRatio: 1.6 }))
      .mockResolvedValueOnce(cleanQa({ pass: false, textSizeRatio: 1.1, defects: notes, advisory: notes }));
    try {
      const { results } = await renderStorySpreads(baseParams({ spreadNos: [1, 3], spreads: [1, 3], textLayout: 'embedded' }));
      expect(results[0].qa.textSizeRatio).toBe(1.1);
      expect(results[0].candidates).toHaveLength(2);
      // The smaller reference wins even when unrelated advisory scores
      // would have elected the oversized candidate for an ordinary page.
      expect(results[0].candidates[1].score).toBeLessThan(results[0].candidates[0].score);
      expect(generateIllustration.mock.calls.filter(([scene]) => scene.includes('Scene 1 of 12'))).toHaveLength(2);
    } finally {
      delete process.env.CATALOG_TEXT_ANCHOR_CANDIDATES;
    }
  });

  test('a blocking defect that is NOT about the text still elects the anchor — the guard is text-scoped', async () => {
    checkSpreadRenderV2.mockResolvedValue(blockingQa('prop missing: "teddy bear"'));
    process.env.CATALOG_SHIP_ON_EXHAUSTION = '1';
    try {
      const { advisories } = await renderStorySpreads(baseParams({ spreadNos: [1, 3], spreads: [1, 3], textLayout: 'embedded' }));
      expect(advisories.some(a => a.stage === 'typographyAnchor' && a.note.includes('own painted text is blocking'))).toBe(false);
    } finally {
      delete process.env.CATALOG_SHIP_ON_EXHAUSTION;
    }
  });
});
