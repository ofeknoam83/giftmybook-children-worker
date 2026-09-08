// The checkpoint pacing/backoff clock is tested in filmCheckpoint.test.js.
// Keep end-to-end media orchestration deterministic without real one-second sleeps.
jest.mock('node:timers/promises', () => ({ setTimeout: jest.fn(async () => {}) }));
const fs = require('fs');
jest.mock('../../../../services/catalogEngine/audio/geminiAudio', () => ({ judgeAudio: jest.fn() }));
jest.mock('../../../../services/gcsStorage', () => ({ uploadBuffer: jest.fn(async (_b, k) => `https://stored/${k}`), downloadBuffer: jest.fn(async () => null), loadJson: jest.fn(async () => null), saveJson: jest.fn(async () => {}), objectExists: jest.fn(async () => false), getSignedUrl: jest.fn(async k => `https://signed/${k}`) }));
jest.mock('../../../../services/illustrationGenerator', () => ({ downloadPhotoAsBase64: jest.fn(async () => ({ base64: 'cmVm', mimeType: 'image/png' })), getNextApiKey: jest.fn() }));
jest.mock('../../../../services/catalogEngine/illustrator', () => ({ renderStorySpreads: jest.fn() }));
jest.mock('../../../../services/catalogEngine/illustrator/bible', () => ({ buildBookBible: jest.fn(async () => ({ hash: 'bible', sheet: { hash: 'sheet', base64: 'cmVm' }, props: [] })), summarizeBible: jest.fn(async () => ({})) }));
jest.mock('../../../../services/catalogEngine/video/filmInputs', () => ({ loadFilmBible: jest.fn(), prepareFilmStill: jest.fn(async ({ entry }) => ({ buffer: Buffer.from('frame'), storageKey: entry.storageKey, rerendered: entry.embedded })) }));
jest.mock('../../../../services/catalogEngine/video/filmScript', () => ({ ...jest.requireActual('../../../../services/catalogEngine/video/filmScript'), directScript: jest.fn() }));
jest.mock('../../../../services/catalogEngine/audio/narrate', () => ({ renderChunk: jest.fn() }));
jest.mock('../../../../services/catalogEngine/video/generate', () => ({ generateCandidates: jest.fn(async () => ({ candidates: [{ status: 'done', buffer: Buffer.from('motion') }] })) }));
jest.mock('../../../../services/catalogEngine/video/filmPerformance', () => ({ LIPSYNC_VERSION: 'sync-test', LEGACY_LIPSYNC_VERSION: 'sync-legacy', validateLipsyncModel: jest.fn(async () => true), syncDialogue: jest.fn(async () => Buffer.from('synced')), checkPerformance: jest.fn(async () => ({ pass: true, defects: [] })) }));
jest.mock('../../../../services/catalogEngine/video/verify', () => ({ verifyClip: jest.fn(async () => ({ blocking: [], score: 100, frames: [], judge: {} })) }));
jest.mock('../../../../services/catalogEngine/video/stills', () => ({ ...jest.requireActual('../../../../services/catalogEngine/video/stills'), fetchStill: jest.fn(async () => ({ buffer: Buffer.from('frame') })), textGate: jest.fn(async () => ({ pass: true })), prepareStartFrame: jest.fn(async () => ({ buffer: Buffer.from('prepared') })) }));
jest.mock('../../../../services/catalogEngine/video/ffmpeg', () => ({ ...jest.requireActual('../../../../services/catalogEngine/video/ffmpeg'), runFfmpeg: jest.fn(), probeVideo: jest.fn() }));

const { encodeWav } = require('../../../../services/catalogEngine/audio/wav');
const { renderChunk } = require('../../../../services/catalogEngine/audio/narrate');
const { directScript } = require('../../../../services/catalogEngine/video/filmScript');
const { generateCandidates } = require('../../../../services/catalogEngine/video/generate');
const { renderStorySpreads } = require('../../../../services/catalogEngine/illustrator');
const { textGate } = require('../../../../services/catalogEngine/video/stills');
const { syncDialogue, checkPerformance } = require('../../../../services/catalogEngine/video/filmPerformance');
const ffmpeg = require('../../../../services/catalogEngine/video/ffmpeg');
const storage = require('../../../../services/gcsStorage');
const { generateFullStoryFilm } = require('../../../../services/catalogEngine/video/fullStory');
const { loadFilmBible, prepareFilmStill } = require('../../../../services/catalogEngine/video/filmInputs');
const { modelProfile } = require('../../../../services/catalogEngine/video/providers/models');

const input = () => ({ bookId: 'film-test', story: { spreads: Array.from({ length: 12 }, (_, i) => ({ spread: i + 1, text: 'Hello.' })) }, profile: { name: 'Jo' }, bookDef: { ageBand: '1-3', theme: {}, book: { beats: Array.from({ length: 12 }, (_, i) => ({ spread: i + 1, beat: 'Jo waves.' })) } }, renders: Array.from({ length: 12 }, (_, i) => ({ spread: i + 1, storageKey: `children-jobs/film-test/ce-renders/v/h/spread-${i + 1}.wide-plain.png` })), approvedCoverUrl: 'https://cover/image.png', injectedKeys: { ELEVENLABS_API_KEY: 'test-key' }, voiceProvider: 'elevenlabs', music: 'story-score' });

beforeEach(() => {
  jest.clearAllMocks();
  loadFilmBible.mockResolvedValue({ hash: 'bible', sheet: { hash: 'sheet', base64: 'cmVm' }, props: [] });
  storage.loadJson.mockResolvedValue(null);
  storage.downloadBuffer.mockResolvedValue(null);
  renderStorySpreads.mockReset();
  textGate.mockResolvedValue({ pass: true });
  directScript.mockResolvedValue({ raw: {}, script: { hash: 'script', cast: { narrator: { id: 'narrator', name: 'Narrator', voice: {} }, child: { id: 'child', name: 'Jo', voice: {} } }, turns: Array.from({ length: 12 }, (_, i) => ({ index: i, spread: i + 1, speaker: i % 2 ? 'child' : 'narrator', text: 'Hello.', emotion: 'wonder', direction: { emotion: 'wonder', pace: 'even' }, sourceIds: [i] })) } });
  renderChunk.mockResolvedValue({ buffer: encodeWav(new Float32Array(24000).fill(0.1), 24000), measure: { trim: { start: 0, end: 1 }, lufs: -20 }, transcript: 'Hello.', qa: {}, takeHash: 'take', storageKey: 'take.wav' });
  checkPerformance.mockResolvedValue({ pass: true, defects: [] });
  ffmpeg.runFfmpeg.mockImplementation(async args => { const out = args[args.length - 1]; if (out !== '-') await fs.promises.writeFile(out, Buffer.from('encoded')); });
  ffmpeg.probeVideo.mockImplementation(async file => ({ durationSeconds: file.endsWith('film.mp4') ? 36 : 3, width: 1920, height: 1080 }));
});

test('all 12 scenes reach the final film; only character dialogue is lip-synced', async () => {
  const result = await generateFullStoryFilm(input());
  expect(result.video.durationSeconds).toBe(36);
  expect(result.plan.map(p => p.spread)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  expect(result.mode).toBe('full-story');
  expect(generateCandidates).toHaveBeenCalledTimes(12);
  expect(syncDialogue).toHaveBeenCalledTimes(6);
  for (const [call] of generateCandidates.mock.calls) {
    const clip = result.plan[call.segment.index];
    if (clip.role === 'narrator') expect(clip.clip.hash).toBe(call.clipHash);
    else expect(clip.clip.hash).not.toBe(call.clipHash); // updated lip sync does not change raw motion identity
  }
  expect(checkPerformance).not.toHaveBeenCalled();
  expect(storage.saveJson).toHaveBeenCalledWith(expect.objectContaining({ mode: 'full-story' }), expect.stringMatching(/film.json$/));
});

test('an oversized kit reaches animation with only character and critical prop references', async () => {
  const bible = await loadFilmBible();
  bible.companion = { hash: 'companion', base64: 'cmVm' };
  bible.props = Array.from({ length: 9 }, (_, i) => ({ value: `prop-${i}`, storyObjectId: `p${i}`, sheet: { hash: `prop-${i}`, base64: 'cmVm' } }));
  bible.storyObjects = { objects: bible.props.map((p, i) => ({ id: p.storyObjectId, critical: i === 4 })) };
  const result = await generateFullStoryFilm(input());
  expect(generateCandidates).toHaveBeenCalledTimes(12);
  for (const [call] of generateCandidates.mock.calls) {
    expect(call.references.map(r => r.hash)).toEqual(['sheet', 'companion', 'prop-4']);
    expect(call.brief.prompt).toContain('prop: [REF3]');
    expect(call.brief.prompt).not.toContain('[REF4]');
  }
  const uploadedRefs = storage.uploadBuffer.mock.calls.map(([, key]) => key).filter(k => k.includes('/refs/'));
  expect(uploadedRefs).toHaveLength(3);
  expect(result.warnings[0]).toContain('prop-0');
  expect(result.warnings[0]).not.toContain('prop-4');
  expect(storage.saveJson).toHaveBeenCalledWith(expect.objectContaining({ omittedVideoProps: expect.arrayContaining(['prop-0', 'prop-8']) }), expect.any(String));
  expect(bible.props).toHaveLength(9);
});

test('an essential set beyond one Kling request is split by scene: every shot fits the seven-picture limit and keeps the props its spread stages', async () => {
  // The request that failed with vendor error 1201: one start frame + seven sheets.
  const bible = await loadFilmBible();
  bible.props = Array.from({ length: 7 }, (_, i) => ({ value: `key-${i}`, storyObjectId: `p${i}`, sheet: { hash: `key-${i}`, base64: 'cmVm' } }));
  bible.storyObjects = { objects: bible.props.map((p, i) => ({ id: p.storyObjectId, critical: true, occurrences: [
    ...(i === 5 ? [{ spread: 3, required: true }] : []), ...(i === 6 ? [{ spread: 3, required: false }] : []),
  ] })) };
  const result = await generateFullStoryFilm(input());
  expect(generateCandidates).toHaveBeenCalledTimes(12);
  const omni = modelProfile('kwaivgi/kling-v3-omni-video');
  for (const [call] of generateCandidates.mock.calls) {
    expect(call.references.length).toBeLessThanOrEqual(6);
    expect(call.references[0].hash).toBe('sheet');
    // the exact vendor input the shot would send stays within the limit
    const sent = omni.input({ brief: call.brief, startFrameUrl: 'https://s/f.jpg', endFrameUrl: null, referenceUrls: call.references, seconds: 3, aspect: '16:9' });
    expect(1 + sent.reference_images.length).toBeLessThanOrEqual(7);
    expect(call.brief.prompt).toContain('prop: [REF6]');
    expect(call.brief.prompt).not.toContain('[REF7]');
  }
  const spread3 = generateCandidates.mock.calls.find(([c]) => c.segment.index === 2)[0];
  expect(spread3.references.map(r => r.hash)).toEqual(['sheet', 'key-0', 'key-1', 'key-2', 'key-5', 'key-6']);
  const spread1 = generateCandidates.mock.calls.find(([c]) => c.segment.index === 0)[0];
  expect(spread1.references.map(r => r.hash)).toEqual(['sheet', 'key-0', 'key-1', 'key-2', 'key-3', 'key-4']);
  // every sheet some shot uses is staged once; the omission is loud on the checkpoint, the log and the result
  const uploadedRefs = storage.uploadBuffer.mock.calls.map(([, key]) => key).filter(k => k.includes('/refs/'));
  expect(uploadedRefs).toHaveLength(8);
  expect(new Set(uploadedRefs).size).toBe(8);
  expect(storage.saveJson).toHaveBeenCalledWith(expect.objectContaining({ shotReferences: expect.arrayContaining([
    { spread: 1, omitted: ['key-5', 'key-6'] }, { spread: 3, omitted: ['key-3', 'key-4'] },
  ]) }), expect.any(String));
  expect(result.warnings.find(w => w.includes('7-image limit'))).toContain('spread 3 omits key-3, key-4');
  expect(result.video.durationSeconds).toBe(36);
});

test('a kit that fits every shot is keyed exactly as before the budget (six sheets with the start frame)', async () => {
  const bible = await loadFilmBible();
  bible.props = Array.from({ length: 5 }, (_, i) => ({ value: `key-${i}`, storyObjectId: `p${i}`, sheet: { hash: `key-${i}`, base64: 'cmVm' } }));
  bible.storyObjects = { objects: bible.props.map(p => ({ id: p.storyObjectId, critical: true })) };
  const result = await generateFullStoryFilm(input());
  for (const [call] of generateCandidates.mock.calls) expect(call.references.map(r => r.hash)).toEqual(['sheet', 'key-0', 'key-1', 'key-2', 'key-3', 'key-4']);
  expect(result.warnings).toEqual(['Visual review was not run for this film.']);
  expect(storage.saveJson).toHaveBeenCalledWith(expect.objectContaining({ shotReferences: [], omittedVideoProps: [] }), expect.any(String));
});

test('a filtered reference set cannot replay a completed film or approved shots from the full kit', async () => {
  const bible = await loadFilmBible();
  bible.props = [{ value: 'flowers', storyObjectId: 'flowers', sheet: { hash: 'flowers', base64: 'cmVm' } }];
  bible.storyObjects = { objects: [{ id: 'flowers', critical: true }] };
  const original = await generateFullStoryFilm(input());
  const saved = new Map(storage.saveJson.mock.calls.map(([value, key]) => [key, value]));
  storage.loadJson.mockImplementation(async key => key.endsWith('/film.json') || key.endsWith('.media.json') ? saved.get(key) || null : null);
  storage.objectExists.mockResolvedValue(true);
  storage.downloadBuffer.mockResolvedValue(Buffer.from('motion'));
  bible.storyObjects.objects[0].critical = false;
  generateCandidates.mockClear();
  try {
    const changed = await generateFullStoryFilm(input());
    expect(changed.planHash).not.toBe(original.planHash);
    expect(changed.video.cached).toBe(false);
    expect(generateCandidates).toHaveBeenCalledTimes(12);
  } finally { storage.objectExists.mockResolvedValue(false); }
});

test('an upgraded resume migrates compatible approved legacy clips without new animation', async () => {
  await generateFullStoryFilm(input());
  const currentKeys = new Set(storage.saveJson.mock.calls.map(([, key]) => key).filter(key => key.includes('/shots/') && key.endsWith('.media.json')));
  expect(currentKeys.size).toBe(12);
  const bytes = Buffer.from('saved-approved-clip');
  const digest = require('../../../../services/catalogEngine/video/filmScript').hash(bytes);
  storage.loadJson.mockImplementation(async key => key.includes('/shots/') && key.endsWith('.qa.json') && !currentKeys.has(key) ? { pass: true, hash: digest, score: 100 } : null);
  storage.downloadBuffer.mockResolvedValue(bytes);
  generateCandidates.mockClear();
  await generateFullStoryFilm(input());
  expect(generateCandidates).not.toHaveBeenCalled();
});

const embeddedInput = () => {
  const p = input();
  p.renders = p.renders.map(r => ({ ...r, storageKey: r.storageKey.replace('.wide-plain.png', '.wide.png') }));
  return p;
};
test('embedded pages go directly through input preparation to Kling without illustration or text QA', async () => {
  renderStorySpreads.mockRejectedValue(new Error('saved object review must not run'));
  textGate.mockRejectedValue(new Error('saved verifier block must not run'));
  const result = await generateFullStoryFilm(embeddedInput());
  expect(result.video.durationSeconds).toBe(36);
  expect(prepareFilmStill).toHaveBeenCalledTimes(12);
  expect(generateCandidates).toHaveBeenCalledTimes(12);
  expect(renderStorySpreads).not.toHaveBeenCalled();
  expect(textGate).not.toHaveBeenCalled();
  expect(require('../../../../services/catalogEngine/illustrator/bible').buildBookBible).not.toHaveBeenCalled();
  expect(result.textGate).toEqual(Array.from({ length: 12 }, (_, i) => ({ spread: i + 1, checked: false, status: 'not_run' })));
  expect(storage.saveJson).toHaveBeenCalledWith(expect.objectContaining({ stage: 'scene_preparation', recovery: null }), expect.any(String));
});

test('a provider refusal during input preparation still stops before speech or motion', async () => {
  prepareFilmStill.mockRejectedValueOnce(Object.assign(new Error('Image provider blocked generation'), {
    recovery: { reason: 'provider_blocked', retryable: false },
  }));
  await expect(generateFullStoryFilm(embeddedInput())).rejects.toMatchObject({ recovery: { reason: 'provider_blocked' } });
  expect(renderChunk).not.toHaveBeenCalled();
  expect(generateCandidates).not.toHaveBeenCalled();
});

test('missing spoken words stop the film before any animation is purchased', async () => {
  renderChunk.mockResolvedValue({ transcript: 'Goodbye.', qa: {}, unresolved: false });
  await expect(generateFullStoryFilm(input())).rejects.toMatchObject({ failureCode: 'film_audio_unresolved',
    message: expect.stringContaining('at word 1: manuscript "hello"; transcript "goodbye"'),
  });
  expect(generateCandidates).not.toHaveBeenCalled();
});

test('the film accepts a homophone only with verification bound to that exact recording and manuscript', async () => {
  const { judgeAudio } = require('../../../../services/catalogEngine/audio/geminiAudio');
  const { verifySpellingAmbiguity } = require('../../../../services/catalogEngine/audio/exactSpeech');
  const direction = await directScript();
  direction.script.turns[0].text = 'Follow route markers.';
  const buffer = encodeWav(new Float32Array(24000).fill(0.1), 24000);
  judgeAudio.mockResolvedValue({ json: { complete_recording: true, decisions: [{ index: 1, same_pronunciation: true }] } });
  const textVerification = await verifySpellingAmbiguity({ expectedText: 'Follow route markers.', transcript: 'Follow root markers.', wav: buffer, language: 'en' });
  renderChunk.mockResolvedValueOnce({ buffer, measure: { trim: { start: 0, end: 1 }, lufs: -20 },
    transcript: 'Follow root markers.', textVerification, qa: { blocking: [] }, takeHash: 'take', storageKey: 'take.wav' });
  expect((await generateFullStoryFilm(input())).video.durationSeconds).toBe(36);
  expect(generateCandidates).toHaveBeenCalledTimes(12);
});

test.each([
  ['Hello again.', 'Hello.', 'at word 2: manuscript "again"; transcript "(end of passage)"'],
  ['Hello.', 'Hello again.', 'at word 2: manuscript "(end of passage)"; transcript "again"'],
  ['Hello.', '', 'at word 1: manuscript "hello"; transcript "(end of passage)"'],
])('mismatch errors identify the first differing words including truncated passages', async (text, transcript, detail) => {
  const direction = await directScript();
  direction.script.turns[0].text = text;
  renderChunk.mockResolvedValue({ transcript, qa: { blocking: ['narration text mismatch'] }, unresolved: true });
  await expect(generateFullStoryFilm(input())).rejects.toMatchObject({ message: expect.stringContaining(detail) });
  expect(generateCandidates).not.toHaveBeenCalled();
});

test('visual review outages do not prevent a playable Kling film', async () => {
  const { verifyClip } = require('../../../../services/catalogEngine/video/verify');
  verifyClip.mockRejectedValueOnce(new Error('review unavailable'));
  checkPerformance.mockRejectedValueOnce(new Error('review unavailable'));
  const result = await generateFullStoryFilm(input());
  expect(result.visualQa.status).toBe('not_run');
  expect(verifyClip).not.toHaveBeenCalled();
  expect(checkPerformance).not.toHaveBeenCalled();
  expect(storage.saveJson).toHaveBeenCalledWith(expect.objectContaining({ validation: 'media', visualQa: 'not_run', score: null }), expect.stringMatching(/media.json$/));
});

test('a resumed direct film reuses saved media without purchasing animation again', async () => {
  await generateFullStoryFilm(input());
  const saved = new Map(storage.saveJson.mock.calls.map(([value, key]) => [key, value]));
  const bytes = new Map(storage.uploadBuffer.mock.calls.map(([value, key]) => [key, value]));
  storage.loadJson.mockImplementation(async key => key.endsWith('.media.json') ? saved.get(key) || null : null);
  storage.downloadBuffer.mockImplementation(async key => bytes.get(key) || null);
  generateCandidates.mockClear();
  await generateFullStoryFilm(input());
  expect(generateCandidates).not.toHaveBeenCalled();
});

test('clips shorter than their narration still cannot become a finished film', async () => {
  ffmpeg.probeVideo.mockResolvedValue({ durationSeconds: 0.5, width: 1920, height: 1080 });
  await expect(generateFullStoryFilm(input())).rejects.toMatchObject({ failureCode: 'film_scene_unresolved', message: expect.stringContaining('animation ended before the spoken passage') });
  expect(storage.saveJson.mock.calls.some(([value]) => value.mode === 'full-story')).toBe(false);
});

test('audio-quality defects are reported accurately with reviewable evidence', async () => {
  renderChunk.mockResolvedValue({ transcript: 'Hello.', qa: { blocking: ['clipped audio'] }, unresolved: true, storageKey: 'take.wav', candidateFiles: [{ storageKey: 'candidate.wav' }] });
  await expect(generateFullStoryFilm(input())).rejects.toMatchObject({
    failureCode: 'film_audio_unresolved', message: expect.stringContaining('clipped audio'),
    details: { unresolved: [expect.objectContaining({ spread: 1, passage: 1, expectedText: 'Hello.', transcript: 'Hello.', storageKey: 'take.wav', defects: ['clipped audio'] })] },
  });
  expect(generateCandidates).not.toHaveBeenCalled();
});

test('an unavailable verifier is distinct from a recording that dropped words', async () => {
  renderChunk.mockResolvedValue({ transcript: null, qa: { blocking: [], qaUnavailable: 'transcript check failed (HTTP 503)' }, unresolved: true });
  await expect(generateFullStoryFilm(input())).rejects.toMatchObject({
    failureCode: 'film_audio_verification_unavailable',
    details: { unresolved: [expect.objectContaining({ defects: ['audio verification unavailable'], qaUnavailable: expect.stringContaining('HTTP 503') })] },
  });
  expect(generateCandidates).not.toHaveBeenCalled();
});


test('an unavailable lip-sync pin stops before new animation is purchased', async () => {
  const { validateLipsyncModel } = require('../../../../services/catalogEngine/video/filmPerformance');
  validateLipsyncModel.mockRejectedValueOnce(Object.assign(new Error('pin unavailable'), { failureCode: 'film_lipsync_unavailable' }));
  await expect(generateFullStoryFilm(input())).rejects.toMatchObject({ failureCode: 'film_lipsync_unavailable' });
  expect(generateCandidates).not.toHaveBeenCalled();
});
