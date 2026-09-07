/**
 * The page verdict (cb-1 §4.6): prompt sections per pinned input, the
 * verdict → fixed defect strings → classes, fail-open on a malformed or
 * unavailable judge, the repair notes per class, and the line-sheet judge.
 */

jest.mock('../../../../services/illustrationGenerator', () => ({
  getNextApiKey: jest.fn(() => 'k'),
  fetchWithTimeout: jest.fn(),
}));

const { fetchWithTimeout } = require('../../../../services/illustrationGenerator');
const {
  checkColoringPage, classifyColoringDefects, buildPageQaPrompt, validPageVerdict, repairNote, checkLineSheet, COLORING_BLOCKING_PREFIXES, cleanBbox,
} = require('../../../../services/catalogEngine/coloring/pageQa');

const img = tag => ({ base64: Buffer.from(tag).toString('base64'), mimeType: 'image/png' });
const respond = (json) => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: typeof json === 'string' ? json : JSON.stringify(json) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }) });
const cleanVerdict = () => ({
  child_present: true, child_count: 1, extra_people: 0, identity_match: true, identity_notes: '',
  outfit: { top: 'match', bottom: 'match', footwear: 'not_visible', outerwear: 'match', accessories: 'not_visible' },
  companion: { present: true, look_match: true, count: 1, bbox: { x: 0.6, y: 0.2, w: 0.3, h: 0.6 } },
  props: [{ presence: 'present', as_text: false }],
  painted_text: false, visible_text: '', shading_present: false, solid_fills: false, open_shapes: false, frame_drawn: false,
  scene_match: true, complexity_fit: 'ok', scary_or_unsafe: false, child_bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.8 },
});
const opts = () => ({
  kind: 'between', moment: 'Emma walks along the fence with Farmer Bea.', expectsChild: true, expectsCompanion: true,
  heroLineSheet: img('line'), colourSheet: img('colour'), outfitSpecText: 'a hooded jacket, dungarees, rubber boots',
  companion: { name: 'Farmer Bea', type: 'friendly adult farm guide', specText: 'woman, bun, overalls', sheet: img('comp') },
  props: [{ name: 'a red toy tractor', sheet: img('prop'), expected: 'carried' }],
  label: 't', costTracker: { addTextUsage: jest.fn() },
});
const page = Buffer.from('png-bytes');

beforeEach(() => { fetchWithTimeout.mockReset(); });

describe('buildPageQaPrompt', () => {
  test('numbers the reference images in attachment order and states the expectations', () => {
    const { prompt, required } = buildPageQaPrompt({ ...opts(), props: opts().props.map(p => ({ ...p, expected: 'carried' })) });
    expect(prompt).toMatch(/Image 2 is the LINE-ART MODEL SHEET/);
    expect(prompt).toMatch(/Image 3 is the COLOUR model sheet/);
    expect(prompt).toMatch(/Image 4 is the reference sheet of the companion "Farmer Bea"/);
    expect(prompt).toMatch(/Image 5 is the reference sheet of the object "a red toy tractor"/);
    expect(prompt).toMatch(/ONE child hero must appear exactly once/);
    expect(prompt).toMatch(/usually visible, small/);
    expect(required).toEqual(expect.arrayContaining(['identity_match', 'outfit', 'companion', 'props']));
    const noChild = buildPageQaPrompt({ ...opts(), expectsChild: false, heroLineSheet: null, colourSheet: null, outfitSpecText: null, props: [] });
    expect(noChild.prompt).toMatch(/NO PEOPLE/);
    expect(noChild.required).not.toContain('identity_match');
  });
});

describe('checkColoringPage', () => {
  test('a clean verdict passes and carries the boxes', async () => {
    fetchWithTimeout.mockResolvedValueOnce(respond(cleanVerdict()));
    const r = await checkColoringPage(page, opts());
    expect(r.pass).toBe(true);
    expect(r.blocking).toEqual([]);
    expect(r.childBbox).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.8 });
    expect(r.companionBbox.x).toBe(0.6);
    const body = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
    expect(body.contents[0].parts.length).toBe(6); // prompt + page + 4 references
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });
  test('maps every blocking class to its fixed string', async () => {
    fetchWithTimeout.mockResolvedValueOnce(respond({
      ...cleanVerdict(), child_count: 2, extra_people: 1, identity_match: false, identity_notes: 'longer hair',
      outfit: { ...cleanVerdict().outfit, top: 'mismatch' }, companion: { present: false }, props: [{ presence: 'absent', as_text: false }],
      painted_text: true, visible_text: 'BARN', shading_present: true, solid_fills: true, scary_or_unsafe: true,
    }));
    const r = await checkColoringPage(page, { ...opts(), props: [{ name: 'a red toy tractor', expected: 'required' }] });
    expect(r.blocking).toEqual(expect.arrayContaining([
      'child duplicated (2 drawn)', 'invented character: 1 extra person in the scene', 'identity mismatch: the child does not read as the model sheet (longer hair)',
      'outfit mismatch: top differs from the line-art model sheet', 'companion missing: "Farmer Bea"', 'declared prop missing: "a red toy tractor"',
      'painted text: "BARN"', 'grey shading present (judged)', 'solid black fills (judged)', 'unsafe content: frightening or not wholesome',
    ]));
    expect(r.advisory).toEqual([]);
  });
  test('advisory classes: carried prop, open shapes, frame, scene drift, complexity, an unexpected companion', async () => {
    fetchWithTimeout.mockResolvedValueOnce(respond({ ...cleanVerdict(), props: [{ presence: 'absent' }], open_shapes: true, frame_drawn: true, scene_match: false, complexity_fit: 'too_busy', companion: { present: true, look_match: true, count: 1 } }));
    const r = await checkColoringPage(page, { ...opts(), expectsCompanion: false });
    expect(r.blocking).toEqual([]);
    expect(r.advisory).toEqual(expect.arrayContaining(['carried prop not visible: "a red toy tractor"', 'open shapes: outlines with gaps', 'frame drawn around the page', 'scene drift: the page does not show the planned moment', 'too busy for the band', 'unexpected companion in the scene: "Farmer Bea"']));
  });
  test('a no-child page with a child drawn is BLOCKING; a missing child on a child page too', async () => {
    fetchWithTimeout.mockResolvedValueOnce(respond({ ...cleanVerdict(), companion: undefined, props: [] }));
    const r = await checkColoringPage(page, { ...opts(), expectsChild: false, heroLineSheet: null, colourSheet: null, outfitSpecText: null, companion: null, props: [] });
    expect(r.blocking).toEqual(['unexpected person: a child was drawn on a page without the hero']);
    fetchWithTimeout.mockResolvedValueOnce(respond({ ...cleanVerdict(), child_present: false, child_count: 0, companion: undefined, props: [] }));
    const r2 = await checkColoringPage(page, { ...opts(), companion: null, props: [] });
    expect(r2.blocking).toEqual(['child missing from the page']);
  });
  test('fails open: HTTP error, unparseable JSON, malformed verdict', async () => {
    fetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 500, text: async () => '' });
    expect((await checkColoringPage(page, opts())).qaUnavailable).toMatch(/HTTP 500/);
    fetchWithTimeout.mockResolvedValueOnce(respond('not json at all'));
    expect((await checkColoringPage(page, opts())).qaUnavailable).toMatch(/unparseable/);
    fetchWithTimeout.mockResolvedValueOnce(respond({ ...cleanVerdict(), child_count: 'two' }));
    const r = await checkColoringPage(page, opts());
    expect(r.qaUnavailable).toMatch(/malformed/);
    expect(r.pass).toBe(true);
  });
  test('validPageVerdict and classify are strict about types and prefixes', () => {
    expect(validPageVerdict({ child_present: true, child_count: 0, painted_text: false, shading_present: false, solid_fills: false, extra_people: 0 }, ['child_present', 'child_count', 'painted_text', 'shading_present', 'solid_fills', 'extra_people'])).toBe(true);
    expect(validPageVerdict({ child_present: 'yes' }, ['child_present'])).toBe(false);
    const c = classifyColoringDefects(['painted text: "x"', 'frame drawn around the page', 'too dense: heavy ink']);
    expect(c.blocking).toEqual(['painted text: "x"', 'too dense: heavy ink']);
    expect(c.advisory).toEqual(['frame drawn around the page']);
    expect(COLORING_BLOCKING_PREFIXES).toContain('grey shading present');
    expect(cleanBbox({ x: 1.2, y: -1, w: 0.5, h: 0.5 })).toBeNull();
    expect(cleanBbox({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 });
  });
});

describe('repairNote', () => {
  const ctx = { name: 'Emma', moment: 'Emma waits by the gate.', outfitSpecText: 'a hooded jacket, dungarees', heroRef: 1, companion: { name: 'Farmer Bea', ref: 4, specText: 'bun, overalls' }, props: [{ name: 'a red toy tractor', ref: 5 }], rules: { primaryStrokePercent: 0.9 } };
  test('one fixed note per defect class, citing the pinned references', () => {
    const note = repairNote(['identity mismatch: x', 'outfit mismatch: top differs', 'outfit mismatch: bottom differs', 'companion duplicated: "Farmer Bea"', 'carried prop not visible: "a red toy tractor"', 'painted text: "BARN"', 'grey shading present (judged)', 'scene drift: y', 'stroke weight off spec (0.3%)'], ctx);
    expect(note).toMatch(/IDENTITY REPAIR: draw EXACTLY the child of REFERENCE 1/);
    expect(note).toMatch(/OUTFIT REPAIR \(top, bottom\)/);
    expect(note).toMatch(/COMPANION REPAIR: "Farmer Bea" must appear exactly once, drawn EXACTLY as REFERENCE 4/);
    expect(note).toMatch(/Exactly ONE of them/);
    expect(note).toMatch(/PROP REPAIR: "a red toy tractor" must be VISIBLE/);
    expect(note).toMatch(/TEXT REPAIR/);
    expect(note).toMatch(/LINE ART REPAIR/);
    expect(note).toMatch(/SCENE REPAIR: draw EXACTLY this moment and nothing else: "Emma waits by the gate."/);
    expect(note).toMatch(/STROKE REPAIR: draw every main outline at about 0.9%/);
  });
  test('no defects → empty; an unexpected person → the no-people note', () => {
    expect(repairNote([], ctx)).toBe('');
    expect(repairNote(['unexpected person: a child'], ctx)).toMatch(/NO PEOPLE REPAIR/);
  });
});

describe('checkLineSheet', () => {
  test('a hero sheet verdict maps to defects and likeness; unverifiable on a malformed answer', async () => {
    fetchWithTimeout.mockResolvedValueOnce(respond({ readable_text: false, shading_present: false, solid_fills: false, open_shapes: false, figure_count: 3, one_child: true, same_child: true, outfit_match: true, likeness: 0.9 }));
    const ok = await checkLineSheet(page, { kind: 'hero', reference: img('c'), outfitSpecText: 'a jacket' });
    expect(ok).toEqual({ pass: true, defects: [], likeness: 0.9 });
    fetchWithTimeout.mockResolvedValueOnce(respond({ readable_text: true, shading_present: false, solid_fills: false, open_shapes: false, figure_count: 2, one_child: true, same_child: false, outfit_match: true, likeness: 1.4 }));
    const bad = await checkLineSheet(page, { kind: 'hero', reference: img('c') });
    expect(bad.pass).toBe(false);
    expect(bad.defects).toEqual(['readable text on the sheet', '2 full-body figures (expected 3)', 'the child does not match the colour model sheet']);
    expect(bad.likeness).toBe(1);
    fetchWithTimeout.mockResolvedValueOnce(respond({ readable_text: false }));
    expect((await checkLineSheet(page, { kind: 'hero', reference: img('c') })).unverifiable).toMatch(/malformed/);
  });
  test('companion and border sheets use their own fields', async () => {
    fetchWithTimeout.mockResolvedValueOnce(respond({ readable_text: false, shading_present: false, solid_fills: false, open_shapes: false, same_subject: false, child_present: true, likeness: 0.4 }));
    const c = await checkLineSheet(page, { kind: 'companion', reference: img('c'), companion: { name: 'Farmer Bea', type: 'guide' } });
    expect(c.defects).toEqual(['the companion design differs from its reference sheet', 'a child is drawn on the companion sheet']);
    fetchWithTimeout.mockResolvedValueOnce(respond({ readable_text: false, shading_present: false, solid_fills: false, open_shapes: false, frame_complete: true, centre_empty: false, people_present: false, likeness: 0.7 }));
    const b = await checkLineSheet(page, { kind: 'border' });
    expect(b.defects).toEqual(['the centre is not empty']);
    const body = JSON.parse(fetchWithTimeout.mock.calls[1][1].body);
    expect(body.contents[0].parts.length).toBe(2); // prompt + candidate, no reference
  });
});
