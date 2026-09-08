jest.mock('../../../services/gcsStorage', () => ({ downloadBuffer: jest.fn(), uploadBufferIfAbsent: jest.fn() }));
jest.mock('../../../services/illustrationGenerator', () => ({ getNextApiKey: () => 'test-key', fetchWithTimeout: jest.fn() }));
const storage = require('../../../services/gcsStorage');
const { fetchWithTimeout: fetch } = require('../../../services/illustrationGenerator');
const { resolveScenePresence, tasksFor, verdictIssue, presenceHash, needsReference } = require('../../../services/catalogEngine/illustrator/scenePresence');
const { inputsFor, criticalObjectFailures } = require('../../../services/catalogEngine/illustrator/storyObjects');
const { spreadDependencies } = require('../../../services/catalogEngine/illustrator/visualDependencies');
const files = new Map();
const response = json => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }) });
function fixture() {
  const texts = [
    'No meerkat group. Only a bright lizard skittered away. Kito waited, tail still.',
    'The meerkat group called from somewhere beyond the rocks.',
    'She remembered the meerkat group as she watched the empty path.',
    'The meerkat group was no longer hidden. Two stood beside the mound.',
    'The empty nesting boxes stood by the barn wall.',
    'They imagined finding the meerkat group, but saw only grass.',
  ];
  const family = (id, name, spreads) => ({ id, name, critical: true, aliases: [],
    design: { shape: 'fixed shape', material: 'fixed material', colors: 'fixed colors', scale: 'fixed scale', features: 'fixed features' },
    instances: [{ id: 'group', description: 'The same story family' }],
    occurrences: spreads.map(spread => ({ spread, instanceIds: ['group'], multiplicity: 'group', required: true,
      state: 'The entire family must be shown.', evidence: texts[spread - 1] })),
  });
  return { bookId: 'presence-test', book: { id: 'generic_search', beats: texts.map((_, i) => ({ spread: i + 1, beat: 'Find the group.' })) },
    theme: { theme_id: 'safari', world_name: 'Savanna' },
    story: { book_id: 'generic_search', spreads: texts.map((text, i) => ({ spread: i + 1, text })) },
    plan: { hash: 'frozen-design-plan', version: 'so-1', objects: [family('meerkats', 'meerkat group', [1, 2, 3, 4, 6]), family('boxes', 'nesting boxes', [5])] },
  };
}
function verdict(p = fixture()) {
  return Object.fromEntries(p.plan.objects.flatMap(d => d.occurrences.map(o => [`${d.id}__s${o.spread}`, {
    visibility: o.spread === 1 ? 'absent' : [2, 3, 6].includes(o.spread) ? 'off_screen' : 'visible',
    evidence: `s${o.spread}_text_1`, state: p.story.spreads.find(s => s.spread === o.spread).text,
  }])));
}
beforeEach(() => {
  jest.clearAllMocks(); files.clear();
  storage.downloadBuffer.mockImplementation(async k => { if (files.has(k)) return files.get(k); throw Object.assign(new Error('not found'), { code: 404 }); });
  storage.uploadBufferIfAbsent.mockImplementation(async (b, k) => { if (files.has(k)) return { created: false }; files.set(k, b); return { created: true }; });
  fetch.mockResolvedValue(response(verdict()));
});

test('only a completely off-screen or absent family can omit its reference; unknowns and visible effects keep theirs', () => {
  for (const name of ['meerkat calls', 'a remembered bell', 'unfound nesting boxes', 'רחש רחוק']) {
    expect(needsReference({ name, critical: true, occurrences: [
      { required: false, visibility: 'off_screen' }, { required: false, visibility: 'absent' },
    ] })).toBe(false);
  }
  for (const occurrence of [{ required: true, visibility: 'visible' }, { required: false, visibility: 'optional' },
    { required: false }, { required: true, visibility: 'off_screen' }]) {
    expect(needsReference({ name: 'magical visible sound ribbons', occurrences: [
      { required: false, visibility: 'off_screen' }, occurrence,
    ] })).toBe(true);
  }
  expect(needsReference({ occurrences: [] })).toBe(true);
});

test('corrects negated, heard and remembered occurrences while preserving visible clues, identities and image keys', async () => {
  const p = fixture();
  const original = JSON.parse(JSON.stringify(p.plan));
  const corrected = await resolveScenePresence(p);
  const occurrences = corrected.objects[0].occurrences;
  expect(occurrences.map(o => o.required)).toEqual([false, false, false, true, false]);
  expect(corrected.objects[1].occurrences[0]).toMatchObject({ required: true, visibility: 'visible' });
  expect(corrected.hash).toBe(original.hash);
  expect(p.plan).toEqual(original);
  expect(corrected.renderObjects).toEqual(original.objects);
  expect(corrected.objects.map(d => [d.design, d.instances])).toEqual(original.objects.map(d => [d.design, d.instances]));
  const bible = plan => ({ manifest: { props: [] }, storyObjects: plan });
  for (const s of p.story.spreads) expect(spreadDependencies(bible(corrected), s.spread)).toBe(spreadDependencies(bible(original), s.spread));
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  const prompt = body.contents[0].parts[0].text;
  expect(prompt).toContain('The final manuscript takes precedence');
  expect(prompt).toContain('empty nesting boxes');
  expect(prompt).toContain('no longer hidden');
  expect(body.contents[0].parts).toHaveLength(1); // text only, no child photos
  expect(await resolveScenePresence(p)).toEqual(corrected);
  expect(await resolveScenePresence({ ...p, plan: corrected })).toEqual(corrected);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('an absence requirement approves correct absence and rejects hallucinated group members even if state_match is claimed', async () => {
  const corrected = await resolveScenePresence(fixture());
  const result = presence => [{ spread: 1, qa: { verdict: { props: [{ name: 'Story object: meerkat group', presence,
    look: presence === 'absent' ? 'n/a' : 'match', state_match: true, duplicated: false, as_text: false }] } } }];
  expect(criticalObjectFailures(result('absent'), corrected)).toEqual([]);
  expect(criticalObjectFailures(result('present'), corrected)).toHaveLength(1);
  expect(criticalObjectFailures([{ spread: 4, qa: result('absent')[0].qa }], corrected)).toHaveLength(1);
  expect(criticalObjectFailures([{ spread: 1, qa: { qaUnavailable: 'offline' } }], corrected)).toHaveLength(1);
});

test.each(['missing', 'extra', 'wrong-spread', 'beat', 'invalid-mode', 'blank-state', 'extra-field'])('rejects %s presence verdicts without dropping a story constraint', async kind => {
  const p = fixture(); const v = verdict(p);
  if (kind === 'missing') delete v.meerkats__s1;
  if (kind === 'extra') v.other__s1 = v.meerkats__s1;
  if (kind === 'wrong-spread') v.meerkats__s1.evidence = 's2_text_1';
  if (kind === 'beat') v.meerkats__s1.evidence = 's1_beat_1';
  if (kind === 'invalid-mode') v.meerkats__s1.visibility = 'probably';
  if (kind === 'blank-state') v.meerkats__s1.state = '   ';
  if (kind === 'extra-field') v.meerkats__s1.required = false;
  expect(verdictIssue(v, tasksFor(p.plan, inputsFor(p)))).toBeTruthy();
  fetch.mockResolvedValue(response(v));
  await expect(resolveScenePresence(p)).rejects.toMatchObject({ failureCode: 'visual_recovery_pending', recovery: { stage: 'story_object_presence' } });
  await expect(resolveScenePresence(p)).rejects.toMatchObject({ failureCode: 'visual_recovery_pending' });
  expect(fetch).toHaveBeenCalledTimes(2); // durable total budget, not two per retry
});

test('a malformed verdict can recover on the same saved request', async () => {
  fetch.mockResolvedValueOnce(response({})).mockResolvedValueOnce(response(verdict()));
  const corrected = await resolveScenePresence(fixture());
  expect(corrected.objects[0].occurrences[0].visibility).toBe('absent');
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('a transient checker outage retains the plan and retries without re-extracting or buying artwork', async () => {
  const p = fixture();
  fetch.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce(response(verdict()));
  await expect(resolveScenePresence(p)).rejects.toMatchObject({ recovery: { retryable: true, reason: 'verification_unavailable' } });
  expect((await resolveScenePresence(p)).objects[0].occurrences[0].required).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('changed manuscript invalidates only its scene-presence check without mutating the frozen design', async () => {
  const p = fixture(); const first = await resolveScenePresence(p);
  p.story.spreads[0].text = 'The meerkat group stepped into the clearing.';
  const v = verdict(p); v.meerkats__s1.visibility = 'visible';
  fetch.mockResolvedValue(response(v));
  const second = await resolveScenePresence(p);
  expect(presenceHash(second, 1)).not.toBe(presenceHash(first, 1));
  expect(presenceHash(second, 2)).toBe(presenceHash(first, 2));
  expect(second.hash).toBe(first.hash);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('a story without object families needs no new check', async () => {
  const p = fixture(); p.plan.objects = [];
  expect(await resolveScenePresence(p)).toBe(p.plan);
  expect(fetch).not.toHaveBeenCalled();
});

test('provider refusal is retained without treating it as an object defect or repeating calls', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] }) });
  await expect(resolveScenePresence(fixture())).rejects.toMatchObject({ recovery: { reason: 'provider_blocked', retryable: false } });
  await expect(resolveScenePresence(fixture())).rejects.toMatchObject({ recovery: { reason: 'provider_blocked', retryable: false } });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('storage outage cannot silently bypass the scene contract or spend on a new request', async () => {
  storage.uploadBufferIfAbsent.mockRejectedValue(new Error('storage offline'));
  await expect(resolveScenePresence(fixture())).rejects.toMatchObject({ recovery: { reason: 'configuration', retryable: false } });
  expect(fetch).not.toHaveBeenCalled();
});
