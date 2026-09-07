jest.mock('../../../services/illustrationGenerator', () => ({ fetchWithTimeout: jest.fn(), getNextApiKey: () => 'test' }));
jest.mock('../../../services/gcsStorage', () => ({ downloadBuffer: jest.fn(), uploadBufferIfAbsent: jest.fn() }));
const { fetchWithTimeout } = require('../../../services/illustrationGenerator');
const { downloadBuffer, uploadBufferIfAbsent } = require('../../../services/gcsStorage');
const { inputsFor, validatePlan, resolveStoryObjects, objectsForSpread, criticalObjectFailures, designText, hash } = require('../../../services/catalogEngine/illustrator/storyObjects');
const seed = require('../../../services/catalogEngine/data/storyObjects.json').safari_6_7_watering_hole_map.objects[0];

// Regression excerpts from Ziv's marker book, including noun-free references.
const texts = [
  'Ahead, bright route markers curved toward the watering hole.',
  'Same shape, same bright stripe, same careful spacing.',
  'A third marker leaned far from the line, half-hidden in the grass.',
  'Dust warmed her fingers as she picked it up.',
  'Ziv found the nearest empty space in the route and set the marker there.',
  'This marker sat too close to one and too far from the next.',
  'One marker lined up with an acacia. Another pointed toward the rocky lookout.',
  'The marker’s stripe faced the same way as the others, toward the bend leading to the watering hole.',
  'The marker belonged not in the nearest gap, but one place farther along.',
  'Together, Ziv and Kito carried the marker to the new spot and pressed it firmly into the ground.',
  'Each marker appeared exactly where it should.',
  'The markers stood in their proper places, ready for the next traveler.',
];
const params = () => ({
  book: { id: 'safari_6_7_watering_hole_map', beats: texts.map((text, i) => ({ spread: i + 1, beat: text })) },
  theme: { theme_id: 'safari', world_name: 'Sunny Savanna' },
  story: { book_id: 'safari_6_7_watering_hole_map', spreads: texts.map((text, i) => ({ spread: i + 1, text })), personalization_evidence: [] },
});
const plan = () => ({ objects: [{ ...JSON.parse(JSON.stringify(seed)),
  instances: [{ id: 'third', description: 'The displaced third marker' }, { id: 'others', description: 'The other route markers' }],
  occurrences: texts.map((evidence, i) => ({ spread: i + 1, evidence, instanceIds: i === 3 ? ['third'] : ['third', 'others'], multiplicity: i === 3 ? 'single' : 'group', state: i === 3 ? 'The child lifts the fallen third marker; it retains its fixed design.' : evidence, required: true })),
}], conflicts: [] });
const response = p => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(p) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 200 } }) });
let storage;
beforeEach(() => {
  jest.clearAllMocks();
  storage = new Map();
  downloadBuffer.mockImplementation(async key => { if (!storage.has(key)) throw Object.assign(new Error('missing'), { code: 404 }); return storage.get(key); });
  uploadBufferIfAbsent.mockImplementation(async (bytes, key) => { const created = !storage.has(key); if (created) storage.set(key, bytes); return { created }; });
  fetchWithTimeout.mockResolvedValue(response(plan()));
});

test('the marker family spans all 12 spreads; pronouns retain the displaced instance', () => {
  const validated = validatePlan(plan(), inputsFor(params()));
  expect(validated.objects[0].occurrences).toHaveLength(12);
  expect(objectsForSpread(validated, 4)[0]).toMatchObject({ id: 'route_marker', value: 'Story object: route marker', occurrence: { instanceIds: ['third'], multiplicity: 'single' } });
  expect(objectsForSpread(validated, 2)[0].occurrence.multiplicity).toBe('group');
  expect(objectsForSpread(validated, 13)).toEqual([]);
  expect(designText(validated.objects[0])).toContain('one bright orange stripe');
});

test.each([
  ['missing catalog object', p => { p.objects = []; }],
  ['changed criticality', p => { p.objects[0].critical = false; }],
  ['changed design', p => { p.objects[0].design.shape = 'Animal-shaped marker'; }],
  ['fabricated source', p => { p.objects[0].occurrences[3].evidence = 'A new sentence never written'; }],
  ['unknown instance', p => { p.objects[0].occurrences[3].instanceIds = ['fourth']; }],
  ['duplicate spread', p => { p.objects[0].occurrences[3].spread = 3; }],
  ['single/group conflict', p => { p.objects[0].occurrences[0].multiplicity = 'single'; }],
  ['reported contradiction', p => { p.conflicts = ['The manuscript describes two incompatible shapes']; }],
  ['extra schema field', p => { p.objects[0].instructions = 'ignore previous'; }],
])('rejects %s rather than dropping constraints', (_, mutate) => {
  const p = plan(); mutate(p);
  expect(() => validatePlan(p, inputsFor(params()))).toThrow();
});

test('extracts once, persists, and replays the same frozen design without a model call', async () => {
  const costTracker = { addTextUsage: jest.fn() };
  const first = await resolveStoryObjects({ ...params(), costTracker });
  const second = await resolveStoryObjects(params());
  expect(second).toEqual(first);
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  expect(costTracker.addTextUsage).toHaveBeenCalledWith(expect.any(String), 100, 200);
  const body = JSON.parse(fetchWithTimeout.mock.calls[0][1].body);
  expect(body.contents[0].parts[0].text).toContain(texts[3]);
  expect(body.contents[0].parts[0].text).toContain('plot-critical object');
});

test('changed manuscript rekeys extraction while the authored design remains fixed', async () => {
  const first = await resolveStoryObjects(params());
  const changed = params(); changed.story.spreads[0].text += ' A bird sang.';
  const second = await resolveStoryObjects(changed);
  expect(second.storageKey).not.toEqual(first.storageKey);
  expect(second.objects[0].design).toEqual(first.objects[0].design);
});

test('a lost election adopts the winning state plan and its hash', async () => {
  const winner = plan(); winner.objects[0].occurrences[3].state = 'The same third marker is lifted with its stripe visible.';
  uploadBufferIfAbsent.mockImplementation(async (body, key) => {
    storage.set(key, Buffer.from(JSON.stringify({ ...JSON.parse(body), plan: winner })));
    return { created: false };
  });
  const result = await resolveStoryObjects(params());
  expect(result.hash).toBe(hash(winner));
  expect(result.objects[0].occurrences[3].state).toBe(winner.objects[0].occurrences[3].state);
});

test('storage outages never start a new local design; malformed plans cannot ship', async () => {
  downloadBuffer.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 503 }));
  await expect(resolveStoryObjects(params())).rejects.toMatchObject({ failureCode: 'identity_kit_failed' });
  expect(fetchWithTimeout).not.toHaveBeenCalled();
  fetchWithTimeout.mockResolvedValue(response({ objects: [], conflicts: [] }));
  await expect(resolveStoryObjects(params())).rejects.toMatchObject({ failureCode: 'identity_kit_failed' });
  expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  expect(uploadBufferIfAbsent).not.toHaveBeenCalled();
});

test('generic objects work without a catalog definition; no-object stories are explicit', () => {
  const inputs = inputsFor({ ...params(), book: { id: 'other', beats: [] } });
  expect(validatePlan({ objects: [], conflicts: [] }, inputs).objects).toEqual([]);
  const generic = plan(); generic.objects[0].id = 'key'; generic.objects[0].name = 'key';
  expect(validatePlan(generic, inputs).objects[0].id).toBe('key');
});

// Reproduce the reported forest_bells omission with synthetic manuscript text.
// Heard/off-screen objects need a grounded occurrence, not forced visibility.
function bellsFixture() {
  const p = params();
  p.book = { id: 'enchanted_6_7_echo_bells', beats: [] };
  p.story = { book_id: p.book.id, spreads: [
    { spread: 1, text: 'Forest bells rang somewhere beyond the clearing.' },
    { spread: 9, text: 'The bells sounded farther away as the child followed the new clue.' },
    { spread: 10, text: 'They found the forest bells hanging beneath the arch.' },
  ], personalization_evidence: [] };
  const complete = { objects: [{ id: 'forest_bells', name: 'forest bells', aliases: ['bells'], critical: true,
    design: { shape: 'Small rounded bells', material: 'Brass', colors: 'Gold', scale: 'Palm sized', features: 'Round loops' },
    instances: [{ id: 'bell_group', description: 'The uncounted group of bells beneath the arch' }],
    occurrences: p.story.spreads.map(s => ({ spread: s.spread, instanceIds: ['bell_group'], multiplicity: 'group',
      evidence: s.text, required: s.spread === 10,
      state: s.spread === 10 ? 'The bells hang visibly beneath the arch.' : 'The bells are heard off-screen; do not show them.' })),
  }], conflicts: [] };
  const incomplete = JSON.parse(JSON.stringify(complete));
  incomplete.objects[0].occurrences = incomplete.objects[0].occurrences.filter(o => o.spread !== 9);
  return { p, complete, incomplete };
}

test.each([false, true])('recovers an empty occurrence from the sole defined group without changing visibility (%s)', async required => {
  const { p, complete } = bellsFixture();
  complete.objects[0].occurrences[0].required = required;
  const invalid = JSON.parse(JSON.stringify(complete));
  invalid.objects[0].occurrences[0].instanceIds = [];
  fetchWithTimeout.mockResolvedValue(response(invalid));
  const result = await resolveStoryObjects(p);
  expect(result.objects).toEqual(complete.objects);
  expect(invalid.objects[0].occurrences[0].instanceIds).toEqual([]);
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  expect((await resolveStoryObjects(p)).hash).toBe(result.hash);
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
});

test('recovers a sole individual instance without inventing another identity', async () => {
  const p = plan();
  p.objects[0].instances = p.objects[0].instances.slice(0, 1);
  p.objects[0].occurrences.forEach(o => { o.instanceIds = []; o.multiplicity = 'single'; });
  fetchWithTimeout.mockResolvedValue(response(p));
  const result = await resolveStoryObjects(params());
  expect(result.objects[0].occurrences.every(o => o.instanceIds.length === 1 && o.instanceIds[0] === 'third')).toBe(true);
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
});

test('empty instance lists remain invalid in elected manifests', async () => {
  const { p, complete } = bellsFixture();
  complete.objects[0].occurrences[0].instanceIds = [];
  expect(() => validatePlan(complete, inputsFor(p))).toThrow('Missing object instance on spread 1: forest_bells');
  const inputHash = hash(inputsFor(p));
  storage.set(`catalog-assets/story-objects/so-1/${inputHash}.json`, Buffer.from(JSON.stringify({ inputHash, plan: complete })));
  await expect(resolveStoryObjects(p)).rejects.toMatchObject({ failureCode: 'identity_kit_failed' });
  expect(fetchWithTimeout).not.toHaveBeenCalled();
  expect(uploadBufferIfAbsent).not.toHaveBeenCalled();
});

test('ambiguous empty assignments and evidence are repaired together with all valid state preserved', async () => {
  const invalid = plan();
  invalid.objects[0].occurrences[3].instanceIds = [];
  invalid.objects[0].occurrences[3].evidence = 'Invented quotation';
  invalid.objects[0].occurrences[4].instanceIds = [];
  fetchWithTimeout.mockResolvedValueOnce(response(invalid)).mockResolvedValueOnce(response(plan()));
  const result = await resolveStoryObjects(params());
  expect(result.objects).toEqual(plan().objects);
  const prompt = JSON.parse(fetchWithTimeout.mock.calls[1][1].body).contents[0].parts[0].text;
  expect(prompt).toContain('Missing object instance on spread 4: route_marker');
  expect(prompt).toContain('Missing object instance on spread 5: route_marker');
  expect(prompt).toContain('"allowedInstanceIds":["third","others"]');
  expect(prompt).toContain('Ungrounded object occurrence on spread 4');
  expect(uploadBufferIfAbsent).toHaveBeenCalledTimes(1);
});

test.each(['empty', 'unknown', 'invented', 'state', 'required', 'multiplicity', 'design', 'other occurrence', 'drop'])('instance repair rejects %s changes', async kind => {
  const invalid = plan();
  invalid.objects[0].occurrences[3].instanceIds = [];
  const retry = plan();
  const o = retry.objects[0].occurrences[3];
  if (kind === 'empty') o.instanceIds = [];
  if (kind === 'unknown') o.instanceIds = ['unknown'];
  if (kind === 'invented') {
    retry.objects[0].instances.push({ id: 'new_marker', description: 'Invented replacement' });
    o.instanceIds = ['new_marker'];
  }
  if (kind === 'state') o.state = 'A different physical state';
  if (kind === 'required') o.required = false;
  if (kind === 'multiplicity') o.multiplicity = 'group';
  if (kind === 'design') retry.objects[0].design.colors = 'Blue';
  if (kind === 'other occurrence') retry.objects[0].occurrences[2].instanceIds = ['others'];
  if (kind === 'drop') retry.objects = [];
  fetchWithTimeout.mockResolvedValueOnce(response(invalid)).mockResolvedValueOnce(response(retry));
  await expect(resolveStoryObjects(params())).rejects.toMatchObject({ failureCode: 'identity_kit_failed' });
  expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  expect(uploadBufferIfAbsent).not.toHaveBeenCalled();
});

test('forest_bells spread 9 is repaired with error feedback and can remain off-screen', async () => {
  const { p, complete, incomplete } = bellsFixture();
  expect(() => validatePlan(incomplete, inputsFor(p))).toThrow('Object occurrence omitted on spread 9: forest_bells');
  fetchWithTimeout.mockResolvedValueOnce(response(incomplete)).mockResolvedValueOnce(response(complete));
  const result = await resolveStoryObjects(p);
  const prompt = JSON.parse(fetchWithTimeout.mock.calls[1][1].body).contents[0].parts[0].text;
  expect(prompt).toContain('Object occurrence omitted on spread 9: forest_bells');
  expect(prompt).toContain('"previousPlan"');
  expect(prompt).toContain('"objectId":"forest_bells","spread":9');
  expect(objectsForSpread(result, 9)[0].occurrence.required).toBe(false);
  expect(uploadBufferIfAbsent).toHaveBeenCalledTimes(1);
});

test('reports all omitted occurrences together, including beat-only mentions', async () => {
  const { p, complete, incomplete } = bellsFixture();
  p.book.beats = [{ spread: 10, beat: p.story.spreads[2].text }];
  p.story.spreads[2].text = 'They finally found the arch.';
  incomplete.objects[0].occurrences = incomplete.objects[0].occurrences.filter(o => o.spread !== 10);
  fetchWithTimeout.mockResolvedValueOnce(response(incomplete)).mockResolvedValueOnce(response(complete));
  await resolveStoryObjects(p);
  const prompt = JSON.parse(fetchWithTimeout.mock.calls[1][1].body).contents[0].parts[0].text;
  expect(prompt).toContain('Object occurrence omitted on spread 9: forest_bells');
  expect(prompt).toContain('Object occurrence omitted on spread 10: forest_bells');
});

test.each(['still omitted', 'dropped object', 'changed alias', 'changed design', 'changed state'])('an invalid repair (%s) never ships', async kind => {
  const { p, complete, incomplete } = bellsFixture();
  let retry = JSON.parse(JSON.stringify(complete));
  if (kind === 'still omitted') retry = incomplete;
  if (kind === 'dropped object') retry.objects = [];
  if (kind === 'changed alias') retry.objects[0].aliases = [];
  if (kind === 'changed design') retry.objects[0].design.colors = 'Silver';
  if (kind === 'changed state') retry.objects[0].occurrences[0].required = true;
  fetchWithTimeout.mockResolvedValueOnce(response(incomplete)).mockResolvedValueOnce(response(retry));
  await expect(resolveStoryObjects(p)).rejects.toMatchObject({ failureCode: 'identity_kit_failed' });
  expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  expect(uploadBufferIfAbsent).not.toHaveBeenCalled();
});

test('an elected so-1 manifest remains frozen across planner prompt revisions', async () => {
  const p = params();
  const inputHash = hash(inputsFor(p));
  const key = `catalog-assets/story-objects/so-1/${inputHash}.json`;
  storage.set(key, Buffer.from(JSON.stringify({ inputHash, plan: plan() })));
  const result = await resolveStoryObjects(p);
  expect(result.storageKey).toBe(key);
  expect(result.hash).toBe(hash(plan()));
  expect(fetchWithTimeout).not.toHaveBeenCalled();
  expect(uploadBufferIfAbsent).not.toHaveBeenCalled();
});

test.each([
  ['different shape', { look: 'wrong_look' }],
  ['wrong orientation', { state_match: false }],
  ['missing object', { presence: 'absent' }],
  ['unchecked look', { look: 'n/a' }],
  ['extra copy', { duplicated: true }],
])('critical completion gate rejects %s', (_, override) => {
  const props = [{ name: 'Story object: route marker', presence: 'present', look: 'match', state_match: true, duplicated: false, as_text: false, ...override }];
  expect(criticalObjectFailures([{ spread: 4, qa: { verdict: { props } } }], plan())).toHaveLength(1);
});

test('critical checks reject unavailable and legacy verdicts but accept an intentional matching group', () => {
  expect(criticalObjectFailures([{ spread: 2, qa: { verdict: {} } }], plan())).toHaveLength(1);
  const props = [{ name: 'Story object: route marker', presence: 'present', look: 'match', state_match: true, duplicated: false, as_text: false }];
  expect(criticalObjectFailures([{ spread: 2, qa: { verdict: { props } } }], plan())).toEqual([]);
  expect(criticalObjectFailures([{ spread: 2, qa: { verdict: { props }, qaUnavailable: 'timeout' } }], plan())).toHaveLength(1);
});

describe('source-backed occurrence evidence', () => {
  test('source IDs attach exact manuscript punctuation and preserve off-screen state', async () => {
    const { p, complete } = bellsFixture();
    p.story.spreads[0].text = '“The bells aren’t here,” she said.\nTing—ting!';
    complete.objects[0].occurrences.forEach(o => { o.evidence = `s${o.spread}_text_1`; });
    fetchWithTimeout.mockResolvedValue(response(complete));
    const result = await resolveStoryObjects(p);
    expect(result.objects[0].occurrences[0]).toMatchObject({ evidence: p.story.spreads[0].text, required: false });
    const prompt = JSON.parse(fetchWithTimeout.mock.calls[0][1].body).contents[0].parts[0].text;
    expect(prompt).toContain('"id":"s1_text_1"');
    expect(prompt).toContain('copy exactly ONE evidenceSources id');
    const saved = JSON.parse([...storage.values()][0].toString());
    expect(saved.plan.objects[0].occurrences[0].evidence).toBe(p.story.spreads[0].text);
    expect((await resolveStoryObjects(p)).hash).toBe(result.hash);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });
  test.each(['s10_text_1', 's1_text_99', 'The bells were somewhere else.', '   '])('wrong-spread, unknown, fabricated and blank citations stay invalid: %s', evidence => {
    const { p, complete } = bellsFixture();
    complete.objects[0].occurrences[0].evidence = evidence;
    expect(() => validatePlan(complete, inputsFor(p))).toThrow('Ungrounded object occurrence on spread 1: forest_bells');
  });
  test('reports every invalid citation and repairs only evidence without redesigning the objects', async () => {
    const { p, complete } = bellsFixture();
    const invalid = JSON.parse(JSON.stringify(complete));
    invalid.objects[0].occurrences[0].evidence = 'Paraphrased ringing.';
    invalid.objects[0].occurrences[1].evidence = 'Paraphrased distant sound.';
    complete.objects[0].occurrences[0].evidence = 's1_text_1';
    complete.objects[0].occurrences[1].evidence = 's9_text_1';
    fetchWithTimeout.mockResolvedValueOnce(response(invalid)).mockResolvedValueOnce(response(complete));
    const log = jest.fn();
    const result = await resolveStoryObjects({ ...p, log });
    expect(result.objects[0].design).toEqual(invalid.objects[0].design);
    const prompt = JSON.parse(fetchWithTimeout.mock.calls[1][1].body).contents[0].parts[0].text;
    expect(prompt).toContain('Ungrounded object occurrence on spread 1: forest_bells');
    expect(prompt).toContain('Ungrounded object occurrence on spread 9: forest_bells');
    expect(prompt).toContain('"allowedEvidenceIds":["s9_text_1"]');
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('attempt 1/2'));
  });
  test.each(['state', 'required', 'design', 'drop'])('evidence repair cannot change %s', async field => {
    const { p, complete } = bellsFixture();
    const invalid = JSON.parse(JSON.stringify(complete));
    invalid.objects[0].occurrences[0].evidence = 'Invented quotation';
    complete.objects[0].occurrences[0].evidence = 's1_text_1';
    if (field === 'state') complete.objects[0].occurrences[0].state = 'Now visible.';
    if (field === 'required') complete.objects[0].occurrences[0].required = true;
    if (field === 'design') complete.objects[0].design.colors = 'Silver';
    if (field === 'drop') complete.objects = [];
    fetchWithTimeout.mockResolvedValueOnce(response(invalid)).mockResolvedValueOnce(response(complete));
    await expect(resolveStoryObjects(p)).rejects.toMatchObject({ failureCode: 'identity_kit_failed' });
    expect(uploadBufferIfAbsent).not.toHaveBeenCalled();
  });
  test('long passages yield bounded exact substrings and beat references remain distinct', () => {
    const { evidenceSources } = require('../../../services/catalogEngine/illustrator/storyObjects');
    const spread = { spread: 8, text: 'The lantern glowed. '.repeat(60), beat: 'A ribbon marks the path.' };
    const sources = evidenceSources(spread);
    expect(sources.filter(s => s.id.includes('_text_')).length).toBeGreaterThan(1);
    for (const source of sources) {
      expect(source.quote.length).toBeLessThanOrEqual(600);
      expect(source.quote.length).toBeGreaterThan(0);
      expect(source.id.includes('_text_') ? spread.text.includes(source.quote) : spread.beat.includes(source.quote)).toBe(true);
    }
    expect(sources.at(-1)).toEqual({ id: 's8_beat_1', quote: spread.beat });
  });
});
