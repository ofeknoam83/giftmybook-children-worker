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
  expect(body.contents[0].parts[0].text).toContain('plot-critical visual entity');
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

test('empty instance lists remain invalid in elected manifests (CATALOG_REFERENCE_AUTOHEAL=0 keeps the hard failure)', async () => {
  process.env.CATALOG_REFERENCE_AUTOHEAL = '0';
  try {
    const { p, complete } = bellsFixture();
    complete.objects[0].occurrences[0].instanceIds = [];
    expect(() => validatePlan(complete, inputsFor(p))).toThrow('Missing object instance on spread 1: forest_bells');
    const inputHash = hash(inputsFor(p));
    storage.set(`catalog-assets/story-objects/so-1/${inputHash}.json`, Buffer.from(JSON.stringify({ inputHash, plan: complete })));
    await expect(resolveStoryObjects(p)).rejects.toMatchObject({ failureCode: 'identity_kit_failed' });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(uploadBufferIfAbsent).not.toHaveBeenCalled();
  } finally { delete process.env.CATALOG_REFERENCE_AUTOHEAL; }
});

describe('references that heal themselves (autoheal, 2026-09-16)', () => {
  const { validateReplan, applyReplans, replanKey, seedPlan, authoredObjectIds, MAX_REPLAN_ROUNDS } = require('../../../services/catalogEngine/illustrator/storyObjects');
  const electionKey = p => `catalog-assets/story-objects/so-1/${hash(inputsFor(p))}.json`;
  const foldKey = (p, n) => `catalog-assets/story-objects/so-1/${hash(inputsFor(p))}-r${n}.json`;
  const storeInvalid = () => {
    const { p, complete } = bellsFixture();
    const invalid = JSON.parse(JSON.stringify(complete));
    invalid.objects[0].occurrences[0].instanceIds = [];
    storage.set(electionKey(p), Buffer.from(JSON.stringify({ inputHash: hash(inputsFor(p)), plan: invalid })));
    return { p, complete };
  };

  test('a stored plan that stopped validating is re-planned under the retry fold and the fold is elected', async () => {
    const { p, complete } = storeInvalid();
    fetchWithTimeout.mockResolvedValue(response(complete));
    const log = jest.fn();
    const result = await resolveStoryObjects({ ...p, log });
    expect(result).toMatchObject({ retry: 1, storageKey: foldKey(p, 1), version: 'so-1' });
    expect(result.fallback).toBeUndefined();
    expect(result.objects).toEqual(complete.objects);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(storage.has(foldKey(p, 1))).toBe(true);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('Stored story-object plan no longer validates'));
    // The election is durable: a later run adopts the fold with no model call.
    fetchWithTimeout.mockClear();
    const again = await resolveStoryObjects(p);
    expect(again.hash).toBe(result.hash);
    expect(again.retry).toBe(1);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  test('when re-planning still fails, the catalog seeds become the plan — elected at the fold with the reason, so no later run spends again', async () => {
    const p = params();
    const invalid = plan();
    invalid.objects[0].occurrences[3].instanceIds = ['fourth'];
    storage.set(electionKey(p), Buffer.from(JSON.stringify({ inputHash: hash(inputsFor(p)), plan: invalid })));
    fetchWithTimeout.mockResolvedValue(response({ objects: [], conflicts: [] })); // the planner keeps omitting the catalog object
    const result = await resolveStoryObjects(p);
    expect(result).toMatchObject({ retry: 1, storageKey: foldKey(p, 1), fallback: { kind: 'catalog_seeds', reason: expect.stringContaining('Invalid object instance on spread 4: route_marker') } });
    expect(result.fallback.reason).toContain('re-plan: Catalog object omitted: route_marker');
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0]).toMatchObject({ id: 'route_marker', name: 'route marker', critical: true, design: seed.design, instances: [{ id: 'route_marker' }] });
    // Every spread that names the family gets one grounded, required occurrence.
    expect(result.objects[0].occurrences.map(o => o.spread)).toEqual([1, 3, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(result.objects[0].occurrences[0]).toMatchObject({ instanceIds: ['route_marker'], multiplicity: 'single', required: true, evidence: texts[0] });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    const saved = JSON.parse(storage.get(foldKey(p, 1)).toString());
    expect(saved.fallback.kind).toBe('catalog_seeds');
    fetchWithTimeout.mockClear();
    const again = await resolveStoryObjects(p);
    expect(again.fallback).toEqual(result.fallback);
    expect(again.hash).toBe(result.hash);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  test('a genuine contradiction on the re-plan also falls back to the seeds; a planner outage never invents a plan', async () => {
    const p = params();
    const invalid = plan();
    invalid.objects[0].occurrences[3].instanceIds = ['fourth'];
    storage.set(electionKey(p), Buffer.from(JSON.stringify({ inputHash: hash(inputsFor(p)), plan: invalid })));
    const conflicted = plan(); conflicted.conflicts = ['Two incompatible shapes'];
    fetchWithTimeout.mockResolvedValue(response(conflicted));
    expect((await resolveStoryObjects(p)).fallback.reason).toContain('Story-object contradiction');
    storage.delete(foldKey(p, 1));
    fetchWithTimeout.mockResolvedValue({ ok: false, status: 503 });
    await expect(resolveStoryObjects(p)).rejects.toMatchObject({ failureCode: 'identity_kit_failed' });
    expect(storage.has(foldKey(p, 1))).toBe(false);
  });

  test('a fold that is itself invalid is skipped; when every fold is unusable the seeds serve unelected', async () => {
    const p = params();
    const invalid = plan();
    invalid.objects[0].occurrences[3].instanceIds = ['fourth'];
    const blob = Buffer.from(JSON.stringify({ inputHash: hash(inputsFor(p)), plan: invalid }));
    storage.set(electionKey(p), blob);
    storage.set(foldKey(p, 1), blob);
    fetchWithTimeout.mockResolvedValue(response(plan()));
    expect(await resolveStoryObjects(p)).toMatchObject({ retry: 2, storageKey: foldKey(p, 2) });
    storage.set(foldKey(p, 2), blob);
    fetchWithTimeout.mockClear();
    const seeds = await resolveStoryObjects(p);
    expect(seeds).toMatchObject({ retry: 2, fallback: { kind: 'catalog_seeds' }, storageKey: expect.stringMatching(/-seeds\.json$/) });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  test('seedPlan is a valid minimal plan for the authored book and the explicit no-object plan elsewhere', () => {
    expect(() => validatePlan(seedPlan(inputsFor(params())), inputsFor(params()))).not.toThrow();
    const other = inputsFor({ ...params(), book: { id: 'other', beats: [] } });
    expect(seedPlan(other)).toEqual({ objects: [], conflicts: [] });
    expect(authoredObjectIds('safari_6_7_watering_hole_map')).toEqual(new Set(['route_marker']));
    expect(authoredObjectIds('other')).toEqual(new Set());
  });

  test('persisted re-plans are applied to objects on read — the originals stay on renderObjects, the hash and inputs never move', async () => {
    const p = params();
    const key = electionKey(p);
    storage.set(key, Buffer.from(JSON.stringify({ inputHash: hash(inputsFor(p)), plan: plan() })));
    const reference = { kind: 'single', subject: 'object', description: 'One representative route post' };
    storage.set(replanKey(key, 'route_marker', 1), Buffer.from(JSON.stringify({ version: 1, objectId: 'route_marker', round: 1, at: 't', reason: 'reference does not match its group, assembly or scene contract', to: { design: seed.design, reference } })));
    expect(replanKey(key, 'route_marker', 1)).toBe(`${key.replace(/\.json$/, '')}.replans/route_marker/r1.json`);
    const result = await resolveStoryObjects(p);
    expect(result.hash).toBe(hash(plan()));
    expect(result.objects[0]).toMatchObject({ reference, replanned: 1, design: seed.design });
    expect(result.renderObjects[0].reference).toBeUndefined();
    expect(result.replans).toEqual({ route_marker: { round: 1, design: seed.design, reference, reason: 'reference does not match its group, assembly or scene contract', at: 't' } });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    // A design rewrite of the catalog-authored marker is ignored (its design is authoritative).
    storage.set(replanKey(key, 'route_marker', 2), Buffer.from(JSON.stringify({ to: { design: { ...seed.design, colors: 'blue' }, reference } })));
    const log = jest.fn();
    const ignored = await resolveStoryObjects({ ...p, log });
    expect(ignored.replans.route_marker.round).toBe(1);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('re-plan r2 for route_marker is unusable'));
    expect(MAX_REPLAN_ROUNDS).toBe(2);
  });

  test('a generic object may have its design rewritten by a re-plan; a stale second round chains from the first', async () => {
    const p = { ...params(), book: { id: 'other', beats: [] } };
    const generic = plan(); generic.objects[0].id = 'key'; generic.objects[0].name = 'key'; generic.objects[0].aliases = ['keys'];
    generic.objects[0].occurrences = [{ spread: 1, instanceIds: ['third'], multiplicity: 'single', state: 'Held.', evidence: texts[0], required: true }];
    p.story = { ...p.story, spreads: [{ spread: 1, text: `${texts[0]} The key shone.` }] };
    const key = electionKey(p);
    storage.set(key, Buffer.from(JSON.stringify({ inputHash: hash(inputsFor(p)), plan: generic })));
    const r1 = { design: { ...seed.design, colors: 'brass' }, reference: { kind: 'single', subject: 'object', description: 'One brass key' } };
    storage.set(replanKey(key, 'key', 1), Buffer.from(JSON.stringify({ to: r1 })));
    storage.set(replanKey(key, 'key', 2), Buffer.from(JSON.stringify({ to: { design: { ...r1.design, features: 'two teeth' }, reference: r1.reference } })));
    const result = await resolveStoryObjects(p);
    expect(result.objects[0].design).toEqual({ ...seed.design, colors: 'brass', features: 'two teeth' });
    expect(result.replans.key.round).toBe(2);
    expect(result.renderObjects[0].design).toEqual(seed.design);
    expect(applyReplans(result.renderObjects, result.replans)[0].design.features).toBe('two teeth');
    expect(applyReplans(result.renderObjects, null)).toBe(result.renderObjects);
  });

  test.each([
    ['missing reference', { design: seed.design }, /reference needs kind/],
    ['an extra design key', { design: { ...seed.design, extra: 'x' }, reference: { kind: 'single', subject: 'object', description: 'x' } }, /exactly shape, material/],
    ['an over-long field', { design: { ...seed.design, shape: 'x'.repeat(181) }, reference: { kind: 'single', subject: 'object', description: 'x' } }, /1-180 characters/],
    ['a changed subject', { design: seed.design, reference: { kind: 'single', subject: 'creature', description: 'x' } }, /subject never changes/],
    ['an upgrade to group', { design: seed.design, reference: { kind: 'group', subject: 'object', description: 'x' } }, /only be downgraded/],
    ['no change at all', { design: seed.design, reference: { kind: 'single', subject: 'object', description: 'The post' } }, /changed neither/],
    ['a design rewrite of an authored object', { design: { ...seed.design, colors: 'blue' }, reference: { kind: 'single', subject: 'object', description: 'The post' } }, /catalog-authored/],
    ['a hostile __proto__ answer', JSON.parse('{"__proto__": {"design": {}}, "reference": {"kind": "single", "subject": "object", "description": "x"}}'), /design must be an object/],
  ])('validateReplan rejects %s', (_, to, issue) => {
    const from = { ...seed, reference: { kind: 'single', subject: 'object', description: 'The post' } };
    expect(validateReplan(to, from, { authored: true }).issue).toMatch(issue);
  });
  test('validateReplan accepts a downgrade to single and a rewritten generic design, inertly', () => {
    const from = { ...seed, reference: { kind: 'group', subject: 'object', description: 'A line of posts' } };
    const downgraded = validateReplan({ design: seed.design, reference: { kind: 'single', subject: 'object', description: ' One "post"  ' } }, from, { authored: true });
    expect(downgraded).toEqual({ issue: null, design: seed.design, reference: { kind: 'single', subject: 'object', description: 'One post' } });
    const rewritten = validateReplan({ design: { ...seed.design, colors: 'plain `brown`' }, reference: from.reference }, from, { authored: false });
    expect(rewritten.issue).toBeNull();
    expect(rewritten.design.colors).toBe('plain brown');
  });
});

// Repair responses only contain requested fields keyed by family and spread.
function occurrencePatch(complete, objectId, spread, fields = ['instanceIds', 'multiplicity', 'state', 'evidence', 'required']) {
  const occurrence = complete.objects.find(o => o.id === objectId).occurrences.find(o => o.spread === spread);
  return Object.fromEntries(fields.map(f => [f, f === 'evidence' ? `s${spread}_text_1` : occurrence[f]]));
}
const requestBody = i => JSON.parse(fetchWithTimeout.mock.calls[i][1].body);

function nestingFixture() {
  const p = params();
  p.book = { id: 'generic_egg_hunt', beats: [] };
  const story = Array.from({ length: 12 }, (_, i) => `The nesting boxes are empty on this part of the search, ${i + 1}.`);
  story[5] = 'They left the nesting boxes behind and watched a hen walk out of a quiet corner.';
  story[7] = 'The child remembered the empty nesting boxes while studying loose straw by the wall.';
  p.story = { book_id: p.book.id, spreads: story.map((text, i) => ({ spread: i + 1, text })), personalization_evidence: [] };
  const complete = plan();
  const def = complete.objects[0];
  def.id = 'nesting_boxes'; def.name = 'nesting boxes'; def.aliases = ['boxes'];
  def.instances = [{ id: 'left_box', description: 'The left nesting box' }, { id: 'right_box', description: 'The right nesting box' }];
  def.design = { shape: 'Square open-front boxes', material: 'Wood', colors: 'Brown', scale: 'Hen sized', features: 'Straw lining' };
  def.occurrences = p.story.spreads.map(s => ({ spread: s.spread, evidence: s.text, instanceIds: ['left_box', 'right_box'], multiplicity: 'group',
    state: [6, 8].includes(s.spread) ? 'The same empty boxes are mentioned off-screen.' : 'The two boxes remain empty.', required: ![6, 8].includes(s.spread) }));
  const incomplete = JSON.parse(JSON.stringify(complete));
  incomplete.objects[0].occurrences = incomplete.objects[0].occurrences.filter(o => ![6, 8].includes(o.spread));
  return { p, complete, incomplete };
}

test('nesting-box count conflicts and omitted spreads 6/8 are diagnosed together and repaired in place', async () => {
  const { p, complete, incomplete } = nestingFixture();
  incomplete.objects[0].occurrences[0].multiplicity = 'single';
  fetchWithTimeout.mockResolvedValueOnce(response(incomplete)).mockResolvedValueOnce(response({
    nesting_boxes__s1: { instanceIds: ['left_box', 'right_box'], multiplicity: 'group' },
    nesting_boxes__s6: occurrencePatch(complete, 'nesting_boxes', 6),
    nesting_boxes__s8: occurrencePatch(complete, 'nesting_boxes', 8),
  }));
  const result = await resolveStoryObjects(p);
  expect(requestBody(1).generationConfig.responseJsonSchema.required).toEqual(['nesting_boxes__s6', 'nesting_boxes__s8', 'nesting_boxes__s1']);
  expect(result.objects[0].instances).toEqual(complete.objects[0].instances);
  expect(result.objects[0].design).toEqual(complete.objects[0].design);
  expect([...result.objects[0].occurrences].sort((a, b) => a.spread - b.spread)).toEqual(complete.objects[0].occurrences);
  expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
});

test('a structural retry cannot consume the separate occurrence-completion budget', async () => {
  const { p, complete, incomplete } = nestingFixture();
  fetchWithTimeout.mockResolvedValueOnce(response({ malformed: true })).mockResolvedValueOnce(response(incomplete)).mockResolvedValueOnce(response({
    nesting_boxes__s6: occurrencePatch(complete, 'nesting_boxes', 6), nesting_boxes__s8: occurrencePatch(complete, 'nesting_boxes', 8),
  }));
  expect((await resolveStoryObjects(p)).objects[0].occurrences).toHaveLength(12);
  expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
  expect(requestBody(2).generationConfig.responseJsonSchema.required).toHaveLength(2);
});

test('partial completion retains successful patches and requests only remaining slots', async () => {
  const { p, complete, incomplete } = nestingFixture();
  fetchWithTimeout.mockResolvedValueOnce(response(incomplete)).mockResolvedValueOnce(response({
    nesting_boxes__s6: occurrencePatch(complete, 'nesting_boxes', 6),
  })).mockResolvedValueOnce(response({ nesting_boxes__s8: occurrencePatch(complete, 'nesting_boxes', 8) }));
  const result = await resolveStoryObjects(p);
  expect(requestBody(2).generationConfig.responseJsonSchema.required).toEqual(['nesting_boxes__s8']);
  expect(objectsForSpread(result, 6)[0].occurrence.required).toBe(false);
  expect(objectsForSpread(result, 8)[0].occurrence.required).toBe(false);
  const second = await resolveStoryObjects(p);
  expect(second.hash).toBe(result.hash);
  expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
});

test('malformed completion responses get a bounded retry without restarting extraction', async () => {
  const { p, complete, incomplete } = bellsFixture();
  fetchWithTimeout.mockResolvedValueOnce(response(incomplete)).mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{truncated' }] } }] }) })
    .mockResolvedValueOnce(response({ forest_bells__s9: occurrencePatch(complete, 'forest_bells', 9) }));
  expect((await resolveStoryObjects(p)).objects[0].occurrences).toHaveLength(3);
  expect(requestBody(2).generationConfig.responseJsonSchema.required).toEqual(['forest_bells__s9']);
});

test.each(['wrong evidence', 'unknown instance', 'count conflict', 'empty state', 'invented family'])('missing occurrence patches reject %s', async kind => {
  const { p, complete, incomplete } = nestingFixture();
  const patch = occurrencePatch(complete, 'nesting_boxes', 6);
  if (kind === 'wrong evidence') patch.evidence = 's8_text_1';
  if (kind === 'unknown instance') patch.instanceIds = ['invented'];
  if (kind === 'count conflict') patch.multiplicity = 'single';
  if (kind === 'empty state') patch.state = '   ';
  const patches = { nesting_boxes__s6: patch, nesting_boxes__s8: occurrencePatch(complete, 'nesting_boxes', 8) };
  if (kind === 'invented family') patches.objects = [];
  fetchWithTimeout.mockResolvedValueOnce(response(incomplete)).mockResolvedValue(response(patches));
  await expect(resolveStoryObjects(p)).rejects.toMatchObject({ failureCode: 'identity_kit_failed' });
  expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
  expect(uploadBufferIfAbsent).not.toHaveBeenCalled();
});

test('genuine contradictions stop immediately in extraction and completion', async () => {
  const { p, complete, incomplete } = bellsFixture();
  complete.conflicts = ['The text explicitly gives two incompatible materials.'];
  fetchWithTimeout.mockResolvedValue(response(complete));
  await expect(resolveStoryObjects(p)).rejects.toThrow('Story-object contradiction');
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  fetchWithTimeout.mockClear();
  fetchWithTimeout.mockResolvedValueOnce(response(incomplete)).mockResolvedValue(response({ forest_bells__s9: { conflict: 'The source contradicts the fixed identity.' } }));
  await expect(resolveStoryObjects(p)).rejects.toThrow('Story-object contradiction on spread 9: forest_bells');
  expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  expect(uploadBufferIfAbsent).not.toHaveBeenCalled();
});

test('a family with every occurrence omitted is completed in bounded batches with full-story context', async () => {
  const { p, complete, incomplete } = nestingFixture();
  incomplete.objects[0].occurrences = [];
  fetchWithTimeout.mockResolvedValueOnce(response(incomplete)).mockImplementation(async (_url, options) => {
    const body = JSON.parse(options.body);
    const keys = body.generationConfig.responseJsonSchema.required;
    expect(keys.length).toBeLessThanOrEqual(8);
    expect(body.contents[0].parts[0].text).toContain(p.story.spreads[11].text);
    return response(Object.fromEntries(keys.map(key => [key, occurrencePatch(complete, 'nesting_boxes', Number(key.split('__s')[1]))])));
  });
  expect((await resolveStoryObjects(p)).objects[0].occurrences).toHaveLength(12);
  expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
});

test('ambiguous empty assignments and evidence are completed together without rewriting state', async () => {
  const invalid = plan();
  invalid.objects[0].occurrences[3].instanceIds = [];
  invalid.objects[0].occurrences[3].evidence = 'Invented quotation';
  invalid.objects[0].occurrences[4].instanceIds = [];
  fetchWithTimeout.mockResolvedValueOnce(response(invalid)).mockResolvedValueOnce(response({
    route_marker__s4: { instanceIds: ['third'], evidence: 's4_text_1' },
    route_marker__s5: { instanceIds: ['third', 'others'] },
  }));
  const result = await resolveStoryObjects(params());
  expect(result.objects).toEqual(plan().objects);
  const schema = requestBody(1).generationConfig.responseJsonSchema;
  expect(schema.required).toEqual(['route_marker__s4', 'route_marker__s5']);
  expect(schema.properties.route_marker__s4.anyOf[0].properties.instanceIds).toMatchObject({ minItems: 1, maxItems: 1, items: { enum: ['third', 'others'] } });
  expect(uploadBufferIfAbsent).toHaveBeenCalledTimes(1);
});

test.each(['empty', 'unknown', 'state', 'required', 'multiplicity', 'design', 'other occurrence', 'drop'])('instance completion rejects %s changes', async kind => {
  const invalid = plan();
  invalid.objects[0].occurrences[3].instanceIds = [];
  const patches = { route_marker__s4: { instanceIds: ['third'] } };
  if (kind === 'empty') patches.route_marker__s4.instanceIds = [];
  if (kind === 'unknown') patches.route_marker__s4.instanceIds = ['invented'];
  if (['state', 'required', 'multiplicity', 'design'].includes(kind)) patches.route_marker__s4[kind] = 'changed';
  if (kind === 'other occurrence') patches.route_marker__s3 = { instanceIds: ['others'] };
  if (kind === 'drop') delete patches.route_marker__s4;
  fetchWithTimeout.mockResolvedValueOnce(response(invalid)).mockResolvedValue(response(patches));
  await expect(resolveStoryObjects(params())).rejects.toMatchObject({ failureCode: 'identity_kit_failed' });
  expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
  expect(uploadBufferIfAbsent).not.toHaveBeenCalled();
});

test('forest_bells spread 9 is an explicitly required response slot and can remain off-screen', async () => {
  const { p, complete, incomplete } = bellsFixture();
  expect(() => validatePlan(incomplete, inputsFor(p))).toThrow('Object occurrence omitted on spread 9: forest_bells');
  fetchWithTimeout.mockResolvedValueOnce(response(incomplete)).mockResolvedValueOnce(response({ forest_bells__s9: occurrencePatch(complete, 'forest_bells', 9) }));
  const result = await resolveStoryObjects(p);
  expect(requestBody(1).generationConfig.responseJsonSchema.required).toEqual(['forest_bells__s9']);
  expect(requestBody(1).contents[0].parts[0].text).toContain('ENTIRE manuscript');
  expect(objectsForSpread(result, 9)[0].occurrence.required).toBe(false);
  expect(result.objects[0].occurrences.find(o => o.spread === 1)).toEqual(complete.objects[0].occurrences[0]);
});

test('omitted beat-only mentions are completed without changing the manuscript', async () => {
  const { p, complete, incomplete } = bellsFixture();
  p.book.beats = [{ spread: 10, beat: p.story.spreads[2].text }];
  p.story.spreads[2].text = 'They finally found the arch.';
  incomplete.objects[0].occurrences = incomplete.objects[0].occurrences.filter(o => o.spread !== 10);
  fetchWithTimeout.mockResolvedValueOnce(response(incomplete)).mockResolvedValueOnce(response({
    forest_bells__s9: occurrencePatch(complete, 'forest_bells', 9),
    forest_bells__s10: { ...occurrencePatch(complete, 'forest_bells', 10), evidence: 's10_beat_1' },
  }));
  const result = await resolveStoryObjects(p);
  expect(requestBody(1).generationConfig.responseJsonSchema.required).toEqual(['forest_bells__s9', 'forest_bells__s10']);
  expect(objectsForSpread(result, 10)[0].occurrence.evidence).toBe(p.book.beats[0].beat);
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
  test('repairs every invalid citation using constrained source IDs', async () => {
    const { p, complete } = bellsFixture();
    const invalid = JSON.parse(JSON.stringify(complete));
    invalid.objects[0].occurrences[0].evidence = 'Paraphrased ringing.';
    invalid.objects[0].occurrences[1].evidence = 'Paraphrased distant sound.';
    fetchWithTimeout.mockResolvedValueOnce(response(invalid)).mockResolvedValueOnce(response({
      forest_bells__s1: { evidence: 's1_text_1' }, forest_bells__s9: { evidence: 's9_text_1' },
    }));
    const result = await resolveStoryObjects(p);
    expect(result.objects).toEqual(complete.objects);
    expect(requestBody(1).generationConfig.responseJsonSchema.properties.forest_bells__s9.anyOf[0]).toMatchObject({
      required: ['evidence'], additionalProperties: false, properties: { evidence: { enum: ['s9_text_1'] } },
    });
  });
  test.each(['state', 'required', 'design', 'drop'])('evidence patch cannot change %s', async field => {
    const { p, complete } = bellsFixture();
    complete.objects[0].occurrences[0].evidence = 'Invented quotation';
    const patches = { forest_bells__s1: { evidence: 's1_text_1' } };
    if (field === 'drop') delete patches.forest_bells__s1;
    else patches.forest_bells__s1[field] = 'changed';
    fetchWithTimeout.mockResolvedValueOnce(response(complete)).mockResolvedValue(response(patches));
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
