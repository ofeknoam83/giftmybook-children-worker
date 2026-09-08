/**
 * The full-story film's director (gfs-1): a screenplay that fails validation
 * is sent back ONCE with the exact failing fragments for a corrected one; a
 * fragment the director still cannot resolve fails `film_script_ambiguous`
 * naming its text; the repair budget is bounded by CATALOG_FILM_DIRECTOR_REPAIRS.
 */

jest.mock('../../../../services/illustrationGenerator', () => ({ getNextApiKey: jest.fn(() => 'k') }));
jest.mock('../../../../services/catalogEngine/audio/providers', () => ({
  ...jest.requireActual('../../../../services/catalogEngine/audio/providers'),
  fetchWithTimeout: jest.fn(),
}));

const { fetchWithTimeout } = require('../../../../services/catalogEngine/audio/providers');
const { directScript, manuscriptUnits } = require('../../../../services/catalogEngine/video/filmScript');

const story = { spreads: Array.from({ length: 12 }, (_, i) => ({ spread: i + 1, text: `Jo saw a tree. “Hello!” said Jo. Patch answered, “Welcome!”` })) };
const cast = [{ id: 'narrator', name: 'Narrator', voiceKey: 'storyteller_warm_f' }, { id: 'child', name: 'Jo', voiceKey: 'storyteller_bright' }, { id: 'companion', name: 'Patch', voiceKey: 'creature_small' }];
const direction = units => ({ cast, assignments: units.map(u => ({ id: u.id, speaker: u.text.includes('Hello') ? 'child' : u.text.includes('Welcome') ? 'companion' : 'narrator', certain: true, emotion: 'wonder' })) });
const reply = json => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }) });
const params = () => ({ story, profile: { name: 'Jo' }, theme: { companion: { name: 'Patch', type: 'parrot' } }, provider: 'elevenlabs', ageBand: '4-5', log: jest.fn() });

beforeEach(() => { jest.clearAllMocks(); delete process.env.CATALOG_FILM_DIRECTOR_REPAIRS; });

test('a valid screenplay needs one call', async () => {
  const units = manuscriptUnits(story);
  fetchWithTimeout.mockResolvedValueOnce(reply(direction(units)));
  const { script } = await directScript(params());
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  expect(script.turns.filter(t => t.speaker === 'child')).toHaveLength(12);
});

test('an uncertain spoken fragment is sent back ONCE with its id, spread, text and reason; the corrected screenplay ships', async () => {
  const units = manuscriptUnits(story);
  const first = direction(units); first.assignments[7] = { ...first.assignments[7], certain: false };
  first.assignments[13] = { ...first.assignments[13], emotion: 'happy' };
  first.assignments[14] = { ...first.assignments[14], certain: false }; // a silent fragment — never a problem
  expect(units[14].text).toBe(' ');
  fetchWithTimeout.mockResolvedValueOnce(reply(first)).mockResolvedValueOnce(reply(direction(units)));
  const p = params();
  const { raw, script } = await directScript(p);
  expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  const repairPrompt = JSON.parse(fetchWithTimeout.mock.calls[1][1].body).contents[0].parts[0].text;
  expect(repairPrompt).toContain('failed validation');
  expect(repairPrompt).toContain('fragment 7 (spread 2, text "“Hello!”"): uncertain speaker');
  expect(repairPrompt).toContain('fragment 13 (spread 3, text "“Hello!”"): unknown emotion "happy"');
  expect(repairPrompt).not.toContain('fragment 14 ');
  expect(raw).toEqual(direction(units));
  expect(script.turns.filter(t => t.speaker === 'child')).toHaveLength(12);
  expect(p.log).toHaveBeenCalledWith('warn', expect.stringMatching(/round 1 rejected .*asking for a corrected screenplay/));
});

test('a fragment the director still cannot resolve fails film_script_ambiguous naming its text; the budget is bounded', async () => {
  const units = manuscriptUnits(story);
  const bad = direction(units); bad.assignments[7] = { ...bad.assignments[7], certain: false };
  fetchWithTimeout.mockResolvedValue(reply(bad));
  await expect(directScript(params())).rejects.toMatchObject({ failureCode: 'film_script_ambiguous', message: expect.stringContaining('spread 2, fragment 7 "“Hello!”": uncertain speaker') });
  expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  jest.clearAllMocks(); fetchWithTimeout.mockResolvedValue(reply(bad));
  process.env.CATALOG_FILM_DIRECTOR_REPAIRS = '0';
  await expect(directScript(params())).rejects.toMatchObject({ failureCode: 'film_script_ambiguous' });
  expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
});

test('a cast-level failure (shared voices) is repaired the same way; a transport failure is not', async () => {
  const units = manuscriptUnits(story);
  const shared = direction(units); shared.cast = cast.map(c => ({ ...c, voiceKey: 'storyteller_warm_f' }));
  fetchWithTimeout.mockResolvedValueOnce(reply(shared)).mockResolvedValueOnce(reply(direction(units)));
  const { script } = await directScript(params());
  expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetchWithTimeout.mock.calls[1][1].body).contents[0].parts[0].text).toContain('distinct supported voice');
  expect(script.cast.child.voice.voiceId).not.toBe(script.cast.narrator.voice.voiceId);
  jest.clearAllMocks();
  fetchWithTimeout.mockResolvedValue({ ok: false, status: 503 });
  await expect(directScript(params())).rejects.toMatchObject({ failureCode: 'film_director_unavailable' });
  expect(fetchWithTimeout).toHaveBeenCalledTimes(3); // the transport retries, no screenplay repair
}, 15000);
