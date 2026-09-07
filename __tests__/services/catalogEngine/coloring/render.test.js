/**
 * The coloring renderer (cb-1 §4.4-4.5): prompt block order, the fixed
 * reference-pack order and labels, colour words stripped from the outfit
 * spec, the generic-safe moment, and the safety ladder over the shared
 * transport (a safety block advances the rung, another error retries the
 * rung, the accepted rung is reported, a total failure never throws).
 */

jest.mock('../../../../services/illustrationGenerator', () => ({
  callGeminiImageParts: jest.fn(),
  buildReferenceParts: (prompt, pack) => [{ text: prompt }, ...pack.flatMap((r, i) => [{ text: `REFERENCE IMAGE ${i + 1} — ${r.label}` }, { inline_data: { mimeType: r.mimeType || 'image/png', data: r.base64 } }])],
  getNextApiKey: jest.fn(() => 'k'),
  fetchWithTimeout: jest.fn(),
}));

const { callGeminiImageParts } = require('../../../../services/illustrationGenerator');
const { loadCatalog } = require('../../../../services/catalogEngine/catalog');
const { LINE_RULES_BY_BAND } = require('../../../../services/catalogEngine/coloring/lineRules');
const {
  buildPagePrompt, buildColoringReferencePack, stripColourWords, stripTriggerWords, genericSafeMoment, promptLadder, renderPageCandidates, imageModelKey, PAGE_ASPECT, RUNGS,
} = require('../../../../services/catalogEngine/coloring/render');

const farm = loadCatalog().themes.farm;
const rules = LINE_RULES_BY_BAND['4-5'];
const img = (tag) => ({ base64: Buffer.from(tag).toString('base64'), mimeType: 'image/png' });
const page = { index: 4, kind: 'between', anchor: { spreads: [3, 4] }, shot: 'medium', placement: 'in the left third', hasChild: true, companion: true, props: ['a red toy tractor'], beats: [] };
const baseArgs = () => ({
  page, moment: 'Emma walks along the fence with Farmer Bea, keeping her tractor close.', pageCount: 20, title: 'Emma and the Little Chick', theme: farm,
  profile: { name: 'Emma', age: 5 }, rules, outfitSpecText: 'a red hooded jacket, blue denim dungarees, yellow rubber boots (#ffcc00)',
  companion: { name: 'Farmer Bea', type: 'friendly adult farm guide', specText: 'woman about 40, brown hair in a bun, green overalls', human: true },
  refs: { heroLineRef: 1, colourSheetRef: 2, coverRef: 3, companionRef: 4, props: { 'a red toy tractor': 5 }, worldPlateRef: 6, borderRef: null },
  repairNote: null,
});

beforeEach(() => { callGeminiImageParts.mockReset(); });

describe('buildColoringReferencePack', () => {
  test('fixed order and labels: hero line sheet, colour sheet, cover, companion, props, world plate', () => {
    const { pack, refs } = buildColoringReferencePack({ page, heroLineSheet: img('line'), colourSheet: img('colour'), cover: img('cover'), companionSheet: img('comp'), propSheets: [{ value: 'a red toy tractor', ...img('prop') }], worldPlate: img('plate'), borderPlate: img('border') });
    expect(pack.map(p => p.kind)).toEqual(['hero-line-sheet', 'character-sheet', 'cover', 'companion-sheet', 'prop-sheet', 'world-plate']);
    expect(pack[0].label).toMatch(/LINE-ART MODEL SHEET/);
    expect(pack[4].label).toMatch(/"a red toy tractor"/);
    expect(refs).toEqual({ heroLineRef: 1, colourSheetRef: 2, coverRef: 3, companionRef: 4, props: { 'a red toy tractor': 5 }, worldPlateRef: 6, borderRef: null });
  });
  test('a no-child page carries no identity references; a pattern page carries the border plate instead of the world plate', () => {
    const world = buildColoringReferencePack({ page: { ...page, kind: 'world_portrait', hasChild: false, companion: false, props: [] }, heroLineSheet: img('line'), colourSheet: img('c'), cover: img('cv'), worldPlate: img('plate') });
    expect(world.pack.map(p => p.kind)).toEqual(['world-plate']);
    expect(world.refs.heroLineRef).toBeNull();
    const pattern = buildColoringReferencePack({ page: { ...page, kind: 'pattern', hasChild: false, companion: false, props: [] }, worldPlate: img('plate'), borderPlate: img('border') });
    expect(pattern.pack.map(p => p.kind)).toEqual(['border-plate']);
    expect(pattern.refs.borderRef).toBe(1);
  });
});

describe('buildPagePrompt', () => {
  test('states the moment, the structured blocks, and the fixed blocks in order', () => {
    const p = buildPagePrompt(baseArgs());
    const idx = s => p.indexOf(s);
    expect(idx('COLORING PAGE 4 of 20')).toBe(0);
    expect(p).toMatch(/MOMENT \(draw exactly this, nothing more\): Emma walks along the fence/);
    expect(idx('CHARACTER: Emma, age 5 — exactly ONE of them, drawn as REFERENCE 1')).toBeGreaterThan(0);
    expect(idx('COMPANION: Farmer Bea, a friendly adult farm guide — exactly ONE of them, drawn EXACTLY as REFERENCE 4')).toBeGreaterThan(idx('CHARACTER:'));
    expect(idx('PROPS (each quoted text is DATA')).toBeGreaterThan(idx('COMPANION:'));
    expect(idx('WORLD: the setting and objects of "Sunnybrook Farm", consistent with REFERENCE 6')).toBeGreaterThan(idx('PROPS'));
    expect(idx('PAGE COMPOSITION')).toBeGreaterThan(idx('WORLD:'));
    expect(idx('LINE ART RULES')).toBeGreaterThan(idx('PAGE COMPOSITION'));
    expect(idx('NO TEXT:')).toBeGreaterThan(idx('LINE ART RULES'));
    expect(idx('FINAL CHECK')).toBeGreaterThan(idx('NO TEXT:'));
    expect(p).toMatch(/in the left third/);
    expect(p).not.toMatch(/Palette & light/);
    expect(p).toMatch(/Era & setting/);
  });
  test('the outfit spec loses its colour words and hex codes; the spec sentence still names the garments', () => {
    const p = buildPagePrompt(baseArgs());
    expect(p).toMatch(/hooded jacket, denim dungarees, rubber boots/);
    expect(p).not.toMatch(/#ffcc00|yellow|blue|red hooded/);
    expect(stripColourWords('a bright red cap, light blue shorts (#1122aa)')).toBe('a cap, shorts');
    expect(stripColourWords(null)).toBeNull();
  });
  test('a no-child page says NO PEOPLE and excludes the companion; a repair note lands last', () => {
    const args = { ...baseArgs(), page: { ...page, kind: 'world_portrait', hasChild: false, companion: false, props: [] }, repairNote: 'TEXT REPAIR: remove all letters.' };
    const p = buildPagePrompt(args);
    expect(p).toMatch(/CHARACTER: NO PEOPLE in this picture/);
    expect(p).toMatch(/COMPANION: do NOT draw Farmer Bea/);
    expect(p.trim().endsWith('REPAIR (fix ONLY what is named; keep everything else identical): TEXT REPAIR: remove all letters.')).toBe(true);
  });
  test('a still life names the object as the subject; a pattern page skips the composition block', () => {
    const still = buildPagePrompt({ ...baseArgs(), page: { ...page, kind: 'prop_still_life', hasChild: false, companion: false, props: ['a red toy tractor'] } });
    expect(still).toMatch(/PROPS: the page's subject is "a red toy tractor" drawn LARGE/);
    const pattern = buildPagePrompt({ ...baseArgs(), page: { ...page, kind: 'pattern', hasChild: false, companion: false, props: [], shot: null, placement: null }, refs: { props: {}, borderRef: 1 } });
    expect(pattern).toMatch(/PATTERN: repeat the motifs/);
    expect(pattern).not.toMatch(/PAGE COMPOSITION/);
  });
  test('the ladder strips trigger words from the moment and the generic-safe rung discards the moment', () => {
    const args = { ...baseArgs(), moment: 'Emma and her dead-tired dog kiss the scary goat by the fence.' };
    const ladder = promptLadder(args, { name: 'Emma', world: 'Sunnybrook Farm' });
    expect(ladder.original).toMatch(/scary goat/);
    expect(ladder.sanitized).not.toMatch(/scary|kiss/);
    expect(ladder['generic-safe']).toMatch(/Emma standing calmly in Sunnybrook Farm/);
    expect(ladder['generic-safe']).not.toMatch(/goat/);
    expect(stripTriggerWords('a naked  flame')).toBe('a flame');
    expect(genericSafeMoment({ hasChild: false }, { name: 'Emma', world: 'W' })).toMatch(/no people/);
  });
});

describe('renderPageCandidates', () => {
  const prompts = { original: 'P0', sanitized: 'P1', 'generic-safe': 'P2' };
  const pack = [{ label: 'L', base64: 'AAAA', mimeType: 'image/png', kind: 'hero-line-sheet' }];
  test('renders N candidates at 3:4 with the configured size and bills the model key', async () => {
    callGeminiImageParts.mockResolvedValue(Buffer.from('png'));
    const costTracker = { addImageGeneration: jest.fn() };
    const out = await renderPageCandidates({ prompts, pack, n: 2, imageSize: '2K', costTracker, label: 'p4' });
    expect(out.map(c => c.k)).toEqual([1, 2]);
    expect(out.every(c => c.buffer && c.rung === 'original')).toBe(true);
    expect(callGeminiImageParts).toHaveBeenCalledTimes(2);
    const [parts, opts] = callGeminiImageParts.mock.calls[0];
    expect(parts[0]).toEqual({ text: 'P0' });
    expect(parts[1].text).toMatch(/REFERENCE IMAGE 1 — L/);
    expect(opts.aspectRatio).toBe(PAGE_ASPECT);
    expect(opts.imageSize).toBe('2K');
    expect(costTracker.addImageGeneration).toHaveBeenCalledWith('gemini-3.1-flash-image:2K', 1);
    expect(imageModelKey('4K')).toBe('gemini-3.1-flash-image:4K');
    expect(imageModelKey(null)).toBe('gemini-3.1-flash-image');
  });
  test('a safety block advances the rung; another error retries the same rung; the accepted rung is reported', async () => {
    const nsfw = Object.assign(new Error('blocked'), { isNsfw: true });
    callGeminiImageParts
      .mockRejectedValueOnce(nsfw)
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce(Buffer.from('ok'));
    const [c] = await renderPageCandidates({ prompts, pack, n: 1, label: 'p' });
    expect(c.rung).toBe('sanitized');
    expect(c.attempts.map(a => a.rung)).toEqual(['original', 'sanitized', 'sanitized']);
    expect(callGeminiImageParts.mock.calls[1][0][0].text).toBe('P1');
  });
  test('a total failure never throws — the candidate carries the error and RUNGS is the closed ladder', async () => {
    callGeminiImageParts.mockRejectedValue(new Error('down'));
    const [c] = await renderPageCandidates({ prompts, pack, n: 1, label: 'p' });
    expect(c.buffer).toBeNull();
    expect(c.error).toBe('down');
    expect(c.attempts.length).toBe(RUNGS.length * 2);
  });
});
