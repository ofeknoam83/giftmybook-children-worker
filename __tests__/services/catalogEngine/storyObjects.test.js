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
