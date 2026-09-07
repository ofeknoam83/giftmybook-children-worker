/**
 * Takes (ab-1 §4.3-4.4, §4.9): chunking by speaker, the take hash (cast /
 * provider / alias / version folded), candidates → verify → select →
 * promote with a marker, the repair ladder that runs only while blocking
 * defects remain (restate, then plain), the per-chunk budget, a replay
 * from a marker at the current QA version (and never from an unresolved
 * one), an admin-picked marker, a provider outage that fails the chunk,
 * and cost lines. The adapter, the judge and GCS are mocked.
 */

jest.mock('../../../../services/gcsStorage', () => ({
  uploadBuffer: jest.fn().mockResolvedValue('https://storage.example/x'),
  downloadBuffer: jest.fn(),
  loadJson: jest.fn().mockRejectedValue(new Error('not found')),
  saveJson: jest.fn().mockResolvedValue(undefined),
  uploadBufferIfAbsent: jest.fn().mockResolvedValue({ created: true }),
  objectExists: jest.fn().mockResolvedValue(false),
  getSignedUrl: jest.fn().mockResolvedValue('https://signed'),
}));
jest.mock('../../../../services/catalogEngine/audio/geminiAudio', () => ({ judgeAudio: jest.fn() }));

const gcs = require('../../../../services/gcsStorage');
const { judgeAudio } = require('../../../../services/catalogEngine/audio/geminiAudio');
const wav = require('../../../../services/catalogEngine/audio/wav');
const narrate = require('../../../../services/catalogEngine/audio/narrate');
const { AUDIO_QA_VERSION, AUDIO_VERSION } = require('../../../../services/catalogEngine/versions');
const { CostTracker } = require('../../../../services/costTracker');

const FS = 24000;
const take = (seconds = 3) => wav.encodeWav(wav.sine({ hz: 440, seconds, amp: 0.2, sampleRate: FS }), FS);
const segment = {
  index: 3, kind: 'spread', spread: 2,
  lines: [
    { index: 0, text: 'Emma looked around.', speaker: 'narrator', direction: { emotion: 'wonder', intensity: 'clear', pace: 'even', shape: 'statement' }, isRefrain: false, pauseAfterMs: 450 },
    { index: 1, text: '"Hello there!"', speaker: 'companion', direction: { emotion: 'joy', intensity: 'clear', pace: 'even', shape: 'exclaim' }, isRefrain: false, pauseAfterMs: 500 },
    { index: 2, text: 'said Farmer Bea.', speaker: 'narrator', direction: { emotion: 'wonder', intensity: 'clear', pace: 'even', shape: 'statement' }, isRefrain: false, pauseAfterMs: 0 },
  ],
};
const cast = { narrator: { key: 'storyteller_warm_f', hash: 'n1', model: 'eleven_v3' }, companion: { key: 'guide_adult_f', hash: 'c1', model: 'eleven_v3' } };
const verdict = transcript => ({ json: { transcript, spoken_control_words: false, glitch_or_artifact: false, robotic: false, reads_as: 'wonder', monotone: false, pace: 'right', mispronounced: [] } });
const adapter = () => ({ name: 'mock', supportsSeed: true, supportsAlignment: false, supportsAliases: true, synthesize: jest.fn(async ({ lines }) => ({ wav: take(lines.length * 1.2 + 1), sampleRate: FS, alignment: null, characters: lines.map(l => l.text).join(' ').length, model: 'mock-1' })) });
const base = (over = {}) => ({ bookId: 'book1', segment, cast, provider: 'mock', credentials: { apiKey: 'k' }, language: 'en', band: '4-5', name: 'Emma', costTracker: new CostTracker(), log: () => {}, opts: { candidates: 2, maxRepairs: 2, budget: 5 }, ...over });

beforeEach(() => { judgeAudio.mockReset(); gcs.uploadBuffer.mockClear(); gcs.loadJson.mockReset().mockRejectedValue(new Error('not found')); gcs.downloadBuffer.mockReset(); });

describe('chunkLines + takeHash', () => {
  test('consecutive lines group by speaker, order kept', () => {
    const chunks = narrate.chunkLines(segment);
    expect(chunks.map(c => c.speaker)).toEqual(['narrator', 'companion', 'narrator']);
    expect(chunks[0].lines.map(l => l.index)).toEqual([0]);
  });
  test('the hash folds the voice, provider, alias and version', () => {
    const chunk = narrate.chunkLines(segment)[0];
    const a = narrate.takeHash({ chunk, voice: cast.narrator, provider: 'mock', language: 'en' });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(narrate.takeHash({ chunk, voice: { ...cast.narrator, hash: 'other' }, provider: 'mock', language: 'en' })).not.toBe(a);
    expect(narrate.takeHash({ chunk, voice: cast.narrator, provider: 'mock', language: 'en', aliasHash: 'x' })).not.toBe(a);
    expect(narrate.chunkKey('b', a, 0)).toBe(`children-jobs/b/audiobook/${AUDIO_VERSION}/takes/${a}/chunk0.wav`);
  });
});

describe('renderSegment', () => {
  test('clean takes: N candidates per chunk, the best promoted with a marker, costs recorded', async () => {
    judgeAudio.mockImplementation(async ({ prompt }) => verdict(/Hello there/.test(prompt) ? 'Hello there!' : (/said Farmer/.test(prompt) ? 'said Farmer Bea.' : 'Emma looked around.')));
    const a = adapter();
    const p = base({ adapter: a });
    const r = await narrate.renderSegment(p);
    expect(r.chunks).toHaveLength(3);
    expect(r.unresolved).toBe(false);
    expect(a.synthesize).toHaveBeenCalledTimes(6); // 2 candidates × 3 chunks
    expect(a.synthesize.mock.calls[2][0].voice.key).toBe('guide_adult_f'); // the companion chunk on the companion voice
    expect(a.synthesize.mock.calls[0][0].seed).not.toBe(a.synthesize.mock.calls[1][0].seed);
    const canonical = r.chunks[0].storageKey;
    expect(canonical).toMatch(/\/chunk0\.wav$/);
    const markerCall = gcs.uploadBuffer.mock.calls.find(c => c[1] === `${canonical}.qa.json`);
    const marker = JSON.parse(markerCall[0].toString());
    expect(marker.audioQaVersion).toBe(AUDIO_QA_VERSION);
    expect(marker.unresolved).toBe(false);
    expect(marker.transcript).toBe('Emma looked around.');
    expect(gcs.uploadBuffer.mock.calls.some(c => /chunk0\.c2\.wav$/.test(c[1]))).toBe(true);
    expect(r.chunks[0].candidates).toBe(2);
    expect(p.costTracker.getSummary().breakdown['mock:mock-1'].audioCharacters).toBeGreaterThan(0);
  });
  test('a blocking transcript defect triggers the repair ladder; a spoken tag drops to the plain rung; the budget bounds it', async () => {
    judgeAudio.mockResolvedValue({ json: { transcript: 'whispers Emma looked around.', spoken_control_words: true, glitch_or_artifact: false, robotic: false, reads_as: 'wonder', monotone: false, pace: 'right', mispronounced: [] } });
    const a = adapter();
    const r = await narrate.renderChunk({ ...base({ adapter: a }), chunk: narrate.chunkLines(segment)[0], voice: cast.narrator, opts: { candidates: 2, maxRepairs: 3, budget: 5 } });
    expect(r.unresolved).toBe(true);
    expect(r.repairs).toBeGreaterThanOrEqual(1);
    expect(a.synthesize).toHaveBeenCalledTimes(5); // 2 + 2 + 1 (budget 5)
    expect(a.synthesize.mock.calls[2][0].rung).toBe('plain');
    expect(r.qa.blocking.join(' ')).toMatch(/tag spoken aloud/);
    const marker = JSON.parse(gcs.uploadBuffer.mock.calls.find(c => /chunk0\.wav\.qa\.json$/.test(c[1]))[0].toString());
    expect(marker.unresolved).toBe(true);
    expect(r.candidateFiles.length).toBe(5);
  });
  test('a repair that passes stops the ladder', async () => {
    let n = 0;
    judgeAudio.mockImplementation(async () => { n += 1; return n <= 2 ? verdict('Emma looked.') : verdict('Emma looked around.'); });
    const a = adapter();
    const r = await narrate.renderChunk({ ...base({ adapter: a }), chunk: narrate.chunkLines(segment)[0], voice: cast.narrator });
    expect(r.unresolved).toBe(false);
    expect(r.repairs).toBe(1);
    expect(a.synthesize.mock.calls[2][0].rung).toBe('restate');
  });
  test('replays a clean marker at the current QA version, never an unresolved or a stale one', async () => {
    const buffer = take(3);
    const { contentHash } = narrate;
    gcs.loadJson.mockResolvedValue({ audioQaVersion: AUDIO_QA_VERSION, renderHash: contentHash(buffer), unresolved: false, qa: { blocking: [], advisory: [], qaUnavailable: null }, measure: { seconds: 3, trim: { start: 0, end: 3 }, trimmedSeconds: 3, lufs: -20 }, transcript: 't', score: 100 });
    gcs.downloadBuffer.mockResolvedValue(buffer);
    const a = adapter();
    const r = await narrate.renderChunk({ ...base({ adapter: a }), chunk: narrate.chunkLines(segment)[0], voice: cast.narrator });
    expect(r.cached).toBe(true);
    expect(a.synthesize).not.toHaveBeenCalled();
    gcs.loadJson.mockResolvedValue({ audioQaVersion: 'aq-0', renderHash: contentHash(buffer), unresolved: false });
    judgeAudio.mockResolvedValue(verdict('Emma looked around.'));
    const fresh = await narrate.renderChunk({ ...base({ adapter: a }), chunk: narrate.chunkLines(segment)[0], voice: cast.narrator });
    expect(fresh.cached).toBe(false);
    gcs.loadJson.mockResolvedValue({ audioQaVersion: AUDIO_QA_VERSION, renderHash: contentHash(buffer), unresolved: true });
    const again = await narrate.renderChunk({ ...base({ adapter: a }), chunk: narrate.chunkLines(segment)[0], voice: cast.narrator });
    expect(again.cached).toBe(false);
    gcs.loadJson.mockResolvedValue({ audioQaVersion: AUDIO_QA_VERSION, renderHash: contentHash(buffer), unresolved: true, adminPicked: true });
    const picked = await narrate.renderChunk({ ...base({ adapter: a }), chunk: narrate.chunkLines(segment)[0], voice: cast.narrator });
    expect(picked.cached).toBe(true);
    expect(picked.adminPicked).toBe(true);
    expect(picked.qa.blocking).toEqual([]);
  });
  test('forceRetake ignores the marker; a provider outage fails the chunk with its code', async () => {
    const buffer = take(3);
    gcs.loadJson.mockResolvedValue({ audioQaVersion: AUDIO_QA_VERSION, renderHash: narrate.contentHash(buffer), unresolved: false });
    gcs.downloadBuffer.mockResolvedValue(buffer);
    judgeAudio.mockResolvedValue(verdict('Emma looked around.'));
    const a = adapter();
    await narrate.renderChunk({ ...base({ adapter: a }), chunk: narrate.chunkLines(segment)[0], voice: cast.narrator, forceRetake: true });
    expect(a.synthesize).toHaveBeenCalled();
    const dead = { ...adapter(), synthesize: jest.fn(async () => { throw Object.assign(new Error('no key'), { failureCode: 'audiobook_provider_unavailable' }); }) };
    await expect(narrate.renderChunk({ ...base({ adapter: dead }), chunk: narrate.chunkLines(segment)[0], voice: cast.narrator, forceRetake: true })).rejects.toMatchObject({ failureCode: 'audiobook_provider_unavailable' });
    const flaky = { ...adapter(), synthesize: jest.fn(async () => { throw new Error('boom'); }) };
    await expect(narrate.renderChunk({ ...base({ adapter: flaky }), chunk: narrate.chunkLines(segment)[0], voice: cast.narrator, forceRetake: true })).rejects.toMatchObject({ failureCode: 'audiobook_render_failed' });
  });
});


test('full-film exact text rejects a permissive cached take and repairs missing words', async () => {
  const buffer = take(3);
  gcs.loadJson.mockResolvedValue({ audioQaVersion: AUDIO_QA_VERSION, renderHash: narrate.contentHash(buffer), unresolved: false, transcript: 'Emma looked.', qa: { blocking: [] } });
  gcs.downloadBuffer.mockResolvedValue(buffer);
  judgeAudio.mockResolvedValue(verdict('Emma looked around.'));
  const a = adapter();
  const result = await narrate.renderChunk({ ...base({ adapter: a }), chunk: narrate.chunkLines(segment)[0], voice: cast.narrator, opts: { candidates: 1, maxRepairs: 1, budget: 2, requireExactText: true } });
  expect(a.synthesize).toHaveBeenCalled();
  expect(result.cached).toBe(false);
  expect(result.transcript).toBe('Emma looked around.');
});

describe('full-film narration recovery', () => {
  const exact = a => ({ ...base({ adapter: a }), chunk: narrate.chunkLines(segment)[0], voice: cast.narrator,
    opts: { candidates: 1, maxRepairs: 0, budget: 1, requireExactText: true } });
  test.each([
    { qa: { blocking: [], qaUnavailable: 'judge down' } },
    { qa: null },
    { qa: { blocking: ['clipped audio'] } },
    { qa: { blocking: [] }, unresolved: true, adminPicked: true },
  ])('exact transcript does not make an unverified or defective cache reusable: %p', async over => {
    const buffer = take(3);
    gcs.loadJson.mockResolvedValue({ audioQaVersion: AUDIO_QA_VERSION, renderHash: narrate.contentHash(buffer),
      unresolved: false, transcript: 'Emma looked around.', ...over });
    gcs.downloadBuffer.mockResolvedValue(buffer);
    judgeAudio.mockResolvedValue(verdict('Emma looked around.'));
    const a = adapter();
    const result = await narrate.renderChunk(exact(a));
    expect(result.cached).toBe(false);
    expect(result.unresolved).toBe(false);
    expect(a.synthesize).toHaveBeenCalledTimes(1);
  });
  test('retry uses new seeds and candidate paths while retaining the canonical key', async () => {
    const a = adapter();
    judgeAudio.mockResolvedValue(verdict('Emma looked.'));
    const first = await narrate.renderChunk(exact(a));
    const marker = JSON.parse(gcs.uploadBuffer.mock.calls.find(c => c[1] === `${first.storageKey}.qa.json`)[0]);
    gcs.loadJson.mockResolvedValue(marker);
    const second = await narrate.renderChunk(exact(a));
    expect(first.unresolved).toBe(true);
    expect(second.unresolved).toBe(true);
    expect(second.storageKey).toBe(first.storageKey);
    expect(second.candidateFiles[0].storageKey).not.toBe(first.candidateFiles[0].storageKey);
    const { parseTakeCandidateKey } = require('../../../../services/catalogEngine/audio/candidates');
    expect(parseTakeCandidateKey('book1', second.candidateFiles[0].storageKey)).toMatchObject({ canonicalKey: first.storageKey });
    expect(parseTakeCandidateKey('another-book', second.candidateFiles[0].storageKey)).toBeNull();
    expect(a.synthesize.mock.calls[1][0].seed).not.toBe(a.synthesize.mock.calls[0][0].seed);
    expect(a.synthesize).toHaveBeenCalledTimes(2);
  });
  test('a fully verified exact take still replays without another synthesis', async () => {
    const buffer = take(3);
    gcs.loadJson.mockResolvedValue({ audioQaVersion: AUDIO_QA_VERSION, renderHash: narrate.contentHash(buffer),
      unresolved: false, transcript: 'Emma looked around.', qa: { blocking: [], qaUnavailable: null } });
    gcs.downloadBuffer.mockResolvedValue(buffer);
    const a = adapter();
    expect((await narrate.renderChunk(exact(a))).cached).toBe(true);
    expect(a.synthesize).not.toHaveBeenCalled();
  });
  test('an unavailable checker retries the same recording without paying for a new take', async () => {
    judgeAudio.mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValueOnce(verdict('Emma looked around.'));
    const a = adapter();
    const result = await narrate.renderChunk(exact(a));
    expect(result.unresolved).toBe(false);
    expect(a.synthesize).toHaveBeenCalledTimes(1);
    expect(judgeAudio).toHaveBeenCalledTimes(2);
    expect(judgeAudio.mock.calls[0][0].audio[0].buffer).toEqual(judgeAudio.mock.calls[1][0].audio[0].buffer);
  });
  test('persistent verification failure stays unresolved and is not mislabeled as a text mismatch', async () => {
    judgeAudio.mockRejectedValue(new Error('HTTP 503'));
    const a = adapter();
    const result = await narrate.renderChunk(exact(a));
    expect(result.unresolved).toBe(true);
    expect(result.qa.qaUnavailable).toContain('HTTP 503');
    expect(result.qa.blocking).not.toContain('narration text mismatch');
    expect(judgeAudio).toHaveBeenCalledTimes(2);
    expect(a.synthesize).toHaveBeenCalledTimes(1);
  });
});
