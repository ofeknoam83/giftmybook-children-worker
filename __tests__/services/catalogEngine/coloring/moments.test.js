/**
 * Moments (cb-1 §4.2): the duplication gate rejects a beat paraphrase, a
 * copied phrase, an invented name, a brand, a peril word, a quoted string
 * and a digit, and accepts every template line for every catalog book; the
 * writer's answers are gated per slot with one retry and the template is
 * the per-slot fallback; the writer never fails the book.
 */

jest.mock('../../../../services/illustrationGenerator', () => ({
  getNextApiKey: jest.fn(() => 'test-key'),
  fetchWithTimeout: jest.fn(),
}));

const { fetchWithTimeout } = require('../../../../services/illustrationGenerator');
const { loadCatalog } = require('../../../../services/catalogEngine/catalog');
const { buildColoringPlan } = require('../../../../services/catalogEngine/coloring/plan');
const {
  duplicationGate, templateMoment, resolveMoments, contentTokens, inventedNames, cleanTitle, buildWriterPrompt, KIND_GUIDE,
} = require('../../../../services/catalogEngine/coloring/moments');

const catalog = loadCatalog();
const farm = catalog.themes.farm;
const book = farm.age_bands['4-5'].find(b => b.id === 'farm_4_5_little_chick') || farm.age_bands['4-5'][0];
const beats = book.beats.map(b => b.beat);
const NAMES = ['Emma', 'Farmer Bea', 'Sunnybrook Farm', 'Farm'];
const refs = { beats, spreadTexts: ['Emma skipped up the lane to Sunnybrook Farm, humming.'], names: NAMES, allowedWords: [] };
const story = { spreads: book.beats.map(b => ({ spread: b.spread, text: `Story text ${b.spread}.` })), personalization_evidence: [{ visual_required: true, moment_type: 'object_presence', source_field: 'object', source_value: 'a red toy tractor', spread: 1 }] };
const plan = buildColoringPlan({ book, theme: farm, story, profile: { name: 'Emma', age: 5 }, ageBand: '4-5', seedBasis: 'fp' });

const writerResponse = (pages) => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ pages }) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } }) });

beforeEach(() => {
  fetchWithTimeout.mockReset();
  delete process.env.CATALOG_COLORING_MOMENT_WRITER;
});

describe('duplicationGate', () => {
  test('accepts a quiet in-between line', () => {
    const g = duplicationGate('Emma walks along the fence with Farmer Bea, looking at the wide sky over Sunnybrook Farm, a red toy tractor tucked under her arm.', refs);
    expect(g).toEqual({ ok: true, reasons: [] });
  });
  test('rejects a beat restated (shared phrase)', () => {
    const g = duplicationGate('Exactly three chicks bustle out and the curious chick engages with the child.', refs);
    expect(g.ok).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/restates beat|too close|paraphrases/);
  });
  test('rejects a close paraphrase of the spread text', () => {
    const g = duplicationGate('Emma skipped up the lane to Sunnybrook Farm while humming.', refs);
    expect(g.ok).toBe(false);
  });
  test('rejects an invented name but allows the child, companion and world', () => {
    expect(duplicationGate('Emma waves to Grandpa Joe at the gate of Sunnybrook Farm while Farmer Bea waters the flowers.', refs).reasons.join(' ')).toMatch(/invents a name: Grandpa, Joe/);
    expect(duplicationGate('Farmer Bea rakes the yard of Sunnybrook Farm while Emma watches the clouds drift by.', refs).ok).toBe(true);
    expect(duplicationGate('At the barn door. Emma looks up at the swallows nesting under the eaves.', refs).ok).toBe(true);
  });
  test('rejects a brand, a peril word, a quoted string and a digit', () => {
    expect(duplicationGate('Emma carries a Peppa Pig lunchbox across the yard of Sunnybrook Farm.', refs).reasons.join(' ')).toMatch(/banned brand/);
    expect(duplicationGate('Emma is lost in the tall grass and afraid of the dark barn.', refs).reasons.join(' ')).toMatch(/peril/);
    expect(duplicationGate('Emma reads a sign that says "Welcome" beside the barn.', refs).reasons.join(' ')).toMatch(/quoted/);
    expect(duplicationGate('Emma counts 3 hens on the fence of Sunnybrook Farm.', refs).reasons.join(' ')).toMatch(/digit/);
  });
  test('rejects the too short and the too long', () => {
    expect(duplicationGate('Emma.', refs).reasons.join(' ')).toMatch(/too short/);
    expect(duplicationGate('Emma walks. '.repeat(40), refs).reasons.join(' ')).toMatch(/too long/);
  });
  test('contentTokens masks names, drops stop words and stems', () => {
    expect(contentTokens('Emma and Farmer Bea are walking the chickens home', NAMES)).toEqual(['walk', 'chicken', 'home']);
  });
  test('inventedNames ignores sentence starts and the allowlist', () => {
    expect(inventedNames('Bea waves. Then Emma sees Luna.', new Set(['bea', 'emma']))).toEqual(['Luna']);
  });
});

describe('templates', () => {
  test('every kind has a guide and a template that passes the gate', () => {
    for (const pg of plan.pages) {
      expect(KIND_GUIDE[pg.kind]).toBeTruthy();
      const t = templateMoment(pg, { name: 'Emma', world: farm.world_name, display: farm.display_name, companion: farm.companion });
      expect(t.title.split(/\s+/).length).toBeLessThanOrEqual(5);
      expect(duplicationGate(t.moment, refs)).toEqual({ ok: true, reasons: [] });
    }
  });
  test('the still life names the carried object and the between page the companion when present', () => {
    const still = plan.pages.find(p => p.kind === 'prop_still_life');
    expect(templateMoment(still, { name: 'Emma', world: 'W', display: 'D', companion: farm.companion }).moment).toMatch(/red toy tractor/);
    const between = { kind: 'between', companion: true, props: [] };
    expect(templateMoment(between, { name: 'Emma', world: 'W', display: 'D', companion: farm.companion }).moment).toMatch(/with Farmer Bea alongside/);
  });
  test('cleanTitle caps words and rejects digits and brands', () => {
    expect(cleanTitle('On the way home')).toBe('On the way home');
    expect(cleanTitle('One two three four five six')).toBeNull();
    expect(cleanTitle('Page 3')).toBeNull();
    expect(cleanTitle('A Bluey day')).toBeNull();
  });
});

describe('resolveMoments', () => {
  const ctx = () => ({ plan, book, theme: farm, story, profile: { name: 'Emma' }, costTracker: { addTextUsage: jest.fn() }, log: () => {} });
  const good = (index) => ({ index, moment: `Emma pauses by the water trough of Sunnybrook Farm, watching a butterfly settle on the rim (page ${index}).`.replace(/\(page \d+\)/, '(a small page)'), title: 'By the trough' });

  test('writer answers that pass the gate are used; the meet page keeps its template', async () => {
    fetchWithTimeout.mockResolvedValueOnce(writerResponse(plan.pages.filter(p => p.kind !== 'meet').map(p => good(p.index))));
    const r = await resolveMoments(ctx());
    expect(r.writer).toBe('gemini-2.5-flash');
    expect(r.pages[0].source).toBe('template');
    expect(r.pages.slice(1).every(p => p.source === 'writer')).toBe(true);
    expect(r.gateRejections).toEqual([]);
  });
  test('a rejected slot is retried once with the reasons and falls back to its template', async () => {
    const bad = plan.pages[1].index;
    const first = plan.pages.filter(p => p.kind !== 'meet').map(p => (p.index === bad ? { index: p.index, moment: 'Exactly three chicks bustle out and the curious chick engages with the child.', title: 'Chicks' } : good(p.index)));
    fetchWithTimeout.mockResolvedValueOnce(writerResponse(first));
    fetchWithTimeout.mockResolvedValueOnce(writerResponse([{ index: bad, moment: 'Emma is lost and scared in the barn.', title: 'Lost' }]));
    const r = await resolveMoments(ctx());
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(fetchWithTimeout.mock.calls[1][1].body);
    expect(retryBody.contents[0].parts[0].text).toMatch(new RegExp(`page ${bad}: `));
    const page = r.pages.find(p => p.index === bad);
    expect(page.source).toBe('template');
    expect(r.gateRejections.map(x => x.index)).toEqual([bad]);
  });
  test('a writer transport failure leaves every page on its template — never a throw', async () => {
    fetchWithTimeout.mockRejectedValueOnce(new Error('offline'));
    const r = await resolveMoments(ctx());
    expect(r.pages.every(p => p.source === 'template')).toBe(true);
    expect(r.pages.length).toBe(plan.pages.length);
  });
  test('the kill-switch skips the writer entirely', async () => {
    process.env.CATALOG_COLORING_MOMENT_WRITER = '0';
    const r = await resolveMoments(ctx());
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(r.writer).toBe('template');
  });
  test('the writer prompt quotes slots as data and carries the safety lines', () => {
    const prompt = buildWriterPrompt({ plan, book, theme: farm, name: 'Emma' });
    expect(prompt).toMatch(/SLOTS \(data\)/);
    expect(prompt).toMatch(/"kind":"between"/);
    expect(prompt).toMatch(/Book safety rules/);
    expect(prompt).not.toMatch(/"kind":"meet"/);
  });
});
