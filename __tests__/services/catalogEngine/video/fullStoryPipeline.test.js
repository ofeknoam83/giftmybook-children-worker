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
jest.mock('../../../../services/catalogEngine/video/filmPerformance', () => ({ LIPSYNC_VERSION: 'sync-test', LEGACY_LIPSYNC_VERSION: 'sync-legacy', LIPSYNC_MODEL: 'sync/lipsync-2', NARRATION_MOUTH_DEFECT: 'a character’s lips moved as if talking during a narrated passage — every mouth stays closed and still; feeling is shown with eyes, hands and body only', validateLipsyncModel: jest.fn(async () => true), syncDialogue: jest.fn(async () => Buffer.from('synced')), checkPerformance: jest.fn(async () => ({ pass: true, defects: [] })), checkNarrationSilence: jest.fn(async () => ({ pass: true, defects: [] })) }));
jest.mock('../../../../services/catalogEngine/audio/music/suites', () => ({ getMusicSuite: jest.fn() }));
jest.mock('../../../../services/catalogEngine/audio/sfx/library', () => ({ getSoundCues: jest.fn() }));
jest.mock('../../../../services/catalogEngine/video/verify', () => ({ verifyClip: jest.fn(async () => ({ blocking: [], score: 100, frames: [], judge: {} })) }));
jest.mock('../../../../services/catalogEngine/video/stills', () => ({ ...jest.requireActual('../../../../services/catalogEngine/video/stills'), fetchStill: jest.fn(async () => ({ buffer: Buffer.from('frame') })), textGate: jest.fn(async () => ({ pass: true })), prepareStartFrame: jest.fn(async () => ({ buffer: Buffer.from('prepared') })) }));
jest.mock('../../../../services/catalogEngine/video/ffmpeg', () => ({ ...jest.requireActual('../../../../services/catalogEngine/video/ffmpeg'), runFfmpeg: jest.fn(), probeVideo: jest.fn() }));

const { encodeWav } = require('../../../../services/catalogEngine/audio/wav');
const { renderChunk } = require('../../../../services/catalogEngine/audio/narrate');
const { directScript } = require('../../../../services/catalogEngine/video/filmScript');
const { generateCandidates } = require('../../../../services/catalogEngine/video/generate');
const { renderStorySpreads } = require('../../../../services/catalogEngine/illustrator');
const { textGate } = require('../../../../services/catalogEngine/video/stills');
const { syncDialogue, checkPerformance, checkNarrationSilence, NARRATION_MOUTH_DEFECT } = require('../../../../services/catalogEngine/video/filmPerformance');
const { getMusicSuite } = require('../../../../services/catalogEngine/audio/music/suites');
const { getSoundCues } = require('../../../../services/catalogEngine/audio/sfx/library');
const path = require('path');
const FALLBACK = path.join(__dirname, '../../../../services/catalogEngine/data/audio/fallback');
const cc0 = file => ({ path: path.join(FALLBACK, file), fallback: true, mimeType: 'audio/mpeg' });
const ffmpeg = require('../../../../services/catalogEngine/video/ffmpeg');
const storage = require('../../../../services/gcsStorage');
const { generateFullStoryFilm, validateFullStoryInput } = require('../../../../services/catalogEngine/video/fullStory');
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
  checkNarrationSilence.mockResolvedValue({ pass: true, defects: [] });
  getMusicSuite.mockResolvedValue({ themeId: 'farm', hash: 'suite', provider: 'library', fallbackCues: [], advisories: [],
    cues: { theme_intro: cc0('ambient-light.mp3'), calm: cc0('ambient-calm.mp3'), playful: cc0('ambient-playful.mp3'), wonder: cc0('ambient-curious.mp3'), tender: cc0('ambient-tender.mp3'), gentle_tension: cc0('ambient-suspense.mp3'), triumph: cc0('ambient-triumph.mp3'), lullaby_outro: cc0('ambient-bedtime.mp3'), refrain_motif: cc0('ambient-curious.mp3') } });
  getSoundCues.mockResolvedValue({ hash: 'lib', provider: 'elevenlabs', cues: {}, skipped: [], advisories: [] });
  delete process.env.CATALOG_FILM_VIDEO_QUALITY;
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
  expect(checkPerformance).toHaveBeenCalledTimes(6); // every dialogue shot is judged after its lip sync
  expect(storage.saveJson).toHaveBeenCalledWith(expect.objectContaining({ mode: 'full-story' }), expect.stringMatching(/film.json$/));
});

test('resume progress distinguishes saved recordings and shots from newly completed work', async () => {
  await generateFullStoryFilm(input());
  const markers = new Map(storage.saveJson.mock.calls.filter(([, key]) => key.endsWith('.media.json')).map(([value, key]) => [key, value]));
  const media = new Map(storage.uploadBuffer.mock.calls.map(([buffer, key]) => [key, buffer]));
  storage.loadJson.mockImplementation(async key => markers.get(key) || null);
  storage.downloadBuffer.mockImplementation(async key => media.get(key) || null);
  renderChunk.mockResolvedValue({ ...(await renderChunk()), cached: true });
  generateCandidates.mockClear();
  const onProgress = jest.fn();
  await generateFullStoryFilm({ ...input(), onProgress });
  expect(generateCandidates).not.toHaveBeenCalled();
  const messages = onProgress.mock.calls.map(([, message]) => message);
  expect(messages).toContain('Prepared passage 12 of 12 (12 saved recordings reused)');
  expect(messages).toContain('Prepared 12 of 12 shots (12 reused, 0 newly completed)');
  expect(messages.some(message => message.startsWith('Animated '))).toBe(false);
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
  expect(result.warnings).toEqual([]);
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

test('a shot-judge outage never blocks a playable film: the shot ships flagged, never silently passed', async () => {
  const { verifyClip } = require('../../../../services/catalogEngine/video/verify');
  verifyClip.mockRejectedValueOnce(new Error('review unavailable'));
  checkNarrationSilence.mockRejectedValueOnce(new Error('review unavailable'));
  const result = await generateFullStoryFilm(input());
  expect(result.visualQa).toMatchObject({ status: 'partial', checked: 11, unchecked: 1, repaired: 0 });
  expect(result.advisories).toContainEqual(expect.objectContaining({ stage: 'visualQa', note: expect.stringContaining('UNCHECKED') }));
  expect(result.warnings).toContainEqual(expect.stringContaining('1 shot(s) shipped without a shot-judge verdict'));
  expect(verifyClip).not.toHaveBeenCalled();
  expect(storage.saveJson).toHaveBeenCalledWith(expect.objectContaining({ validation: 'media', visualQa: 'unchecked', score: null }), expect.stringMatching(/media.json$/));
  expect(storage.saveJson).toHaveBeenCalledWith(expect.objectContaining({ validation: 'media', visualQa: 'pass' }), expect.stringMatching(/media.json$/));
});

test('every shot is judged before acceptance: narration for talking mouths, dialogue for the right speaker', async () => {
  const result = await generateFullStoryFilm(input());
  expect(checkNarrationSilence).toHaveBeenCalledTimes(6);
  expect(checkPerformance).toHaveBeenCalledTimes(6);
  expect(checkPerformance.mock.calls[0][0]).toMatchObject({ speaker: { id: 'child', name: 'Jo' }, reference: { hash: 'sheet' } });
  expect(result.visualQa).toMatchObject({ status: 'pass', checked: 12, unchecked: 0, repaired: 0 });
  expect(result.plan.every(p => p.visualQa === 'pass')).toBe(true);
});

test('a narrated shot whose characters talk is re-animated with the defect fed back, and the repaired shot ships', async () => {
  checkNarrationSilence.mockResolvedValueOnce({ pass: false, defects: [NARRATION_MOUTH_DEFECT] });
  const result = await generateFullStoryFilm(input());
  expect(generateCandidates).toHaveBeenCalledTimes(13);
  const repair = generateCandidates.mock.calls.find(([c]) => c.pass === 1)[0];
  expect(repair.brief.prompt).toContain(`Repair these observed defects: ${NARRATION_MOUTH_DEFECT}`);
  expect(storage.saveJson).toHaveBeenCalledWith({ nextPass: 1, defects: [NARRATION_MOUTH_DEFECT] }, expect.stringMatching(/attempt.json$/));
  expect(result.visualQa).toMatchObject({ status: 'pass', repaired: 1 });
});

test('a shot that keeps talking after the run’s two attempts fails closed with the defect, saved shots retained for retry', async () => {
  checkNarrationSilence.mockImplementation(async () => ({ pass: false, defects: [NARRATION_MOUTH_DEFECT] }));
  await expect(generateFullStoryFilm(input())).rejects.toMatchObject({ failureCode: 'film_scene_unresolved', message: expect.stringContaining('lips moved as if talking'),
    details: { unresolved: [expect.objectContaining({ kind: 'scene', spread: expect.any(Number), defects: [NARRATION_MOUTH_DEFECT] })] } });
  expect(storage.saveJson.mock.calls.some(([value]) => value.mode === 'full-story')).toBe(false);
});

test('the shot judge can be switched off; the film then says so', async () => {
  process.env.CATALOG_FILM_VISUAL_QA = '0';
  try {
    const result = await generateFullStoryFilm(input());
    expect(checkNarrationSilence).not.toHaveBeenCalled();
    expect(result.visualQa.status).toBe('not_run');
    expect(result.warnings).toContainEqual(expect.stringContaining('CATALOG_FILM_VISUAL_QA=0'));
  } finally { delete process.env.CATALOG_FILM_VISUAL_QA; }
});

test('shots are bought at the std tier by default and the tier is part of every shot key; a pro request re-keys', async () => {
  const std = await generateFullStoryFilm(input());
  for (const [call] of generateCandidates.mock.calls) expect(call.quality).toBe('std');
  expect(std.quality).toBe('std');
  expect(std.video.quality).toBe('std');
  expect(std.spend).toMatchObject({ quality: 'std', shots: 12, dialogueShots: 6, animatedSeconds: 36, lipsyncSeconds: 18 });
  expect(std.spend.estimatedUsd).toBeCloseTo(36 * 0.084 + 18 * 0.0685, 1);
  const stdKeys = std.plan.map(p => p.clip.hash);
  generateCandidates.mockClear();
  const pro = await generateFullStoryFilm({ ...input(), quality: 'pro' });
  for (const [call] of generateCandidates.mock.calls) expect(call.quality).toBe('pro');
  expect(pro.plan.map(p => p.clip.hash).some(h => stdKeys.includes(h))).toBe(false);
  expect(pro.spend.estimatedUsd).toBeGreaterThan(std.spend.estimatedUsd);
  expect(() => validateFullStoryInput({ ...input(), quality: 'ultra' })).toThrow(/std.*pro/);
});

test('the soundtrack is the themed suite under the cue grammar plus the ambience bed, mixed with ducking and a measured master', async () => {
  getSoundCues.mockResolvedValue({ hash: 'lib', provider: 'elevenlabs', cues: { amb_farm_day: cc0('ambient-calm.mp3') }, skipped: [], advisories: [] });
  const result = await generateFullStoryFilm({ ...input(), bookDef: { ...input().bookDef, theme: { theme_id: 'farm', display_name: 'Farm', world_name: 'Sunnybrook Farm', companion: { name: 'Bea', type: 'farmer' } } } });
  expect(getMusicSuite).toHaveBeenCalledWith(expect.objectContaining({ cueIds: expect.arrayContaining(['theme_intro', 'lullaby_outro']) }));
  expect(getSoundCues).toHaveBeenCalledWith(expect.objectContaining({ cueIds: expect.arrayContaining(['amb_farm_day']) }));
  const mix = ffmpeg.runFfmpeg.mock.calls.map(([args]) => args.join(' ')).find(a => a.includes('-filter_complex'));
  expect(mix).toContain('sidechaincompress');
  expect(mix).toMatch(/music-0-theme_intro\.mp3/);
  expect(mix).toContain('highpass=f=120');
  expect(result.soundtrack.music.plan[0]).toMatchObject({ cue: 'theme_intro', from: 0 });
  expect(result.soundtrack.music.plan[result.soundtrack.music.plan.length - 1]).toMatchObject({ cue: 'lullaby_outro', to: 36 });
  expect(result.soundtrack.music.plan.length).toBeGreaterThanOrEqual(2);
  expect(result.soundtrack.ambience).toEqual({ cueId: 'amb_farm_day', gainDb: -30 });
  expect(result.soundtrack.sfx).toMatchObject({ provider: 'elevenlabs' });
  // the film's own gain stage follows the measured master (unmeasurable here — the mock writes no WAV — so 0 dB with an advisory)
  const limiter = ffmpeg.runFfmpeg.mock.calls.map(([args]) => args.join(' ')).find(a => a.includes('alimiter'));
  expect(limiter).toContain('volume=0.00dB');
  expect(result.advisories).toContainEqual(expect.objectContaining({ stage: 'soundtrack', note: expect.stringContaining('could not be measured') }));
});

test('music: none keeps the voices, the cues and the ambience but no score', async () => {
  getSoundCues.mockResolvedValue({ hash: 'lib', provider: 'elevenlabs', cues: { amb_farm_day: cc0('ambient-calm.mp3') }, skipped: [], advisories: [] });
  const result = await generateFullStoryFilm({ ...input(), music: 'none', bookDef: { ...input().bookDef, theme: { theme_id: 'farm' } } });
  expect(getMusicSuite).not.toHaveBeenCalled();
  expect(result.soundtrack.music).toBeNull();
  expect(result.soundtrack.ambience).toEqual({ cueId: 'amb_farm_day', gainDb: -30 });
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
