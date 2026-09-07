const fs = require('fs');
jest.mock('../../../../services/gcsStorage', () => ({ uploadBuffer: jest.fn(async (_b, k) => `https://stored/${k}`), downloadBuffer: jest.fn(async () => null), loadJson: jest.fn(async () => null), saveJson: jest.fn(async () => {}), objectExists: jest.fn(async () => false), getSignedUrl: jest.fn(async k => `https://signed/${k}`) }));
jest.mock('../../../../services/illustrationGenerator', () => ({ downloadPhotoAsBase64: jest.fn(async () => ({ base64: 'cmVm', mimeType: 'image/png' })), getNextApiKey: jest.fn() }));
jest.mock('../../../../services/catalogEngine/illustrator', () => ({ renderStorySpreads: jest.fn() }));
jest.mock('../../../../services/catalogEngine/illustrator/bible', () => ({ buildBookBible: jest.fn(async () => ({ hash: 'bible', sheet: { hash: 'sheet', base64: 'cmVm' }, props: [] })), summarizeBible: jest.fn(async () => ({})) }));
jest.mock('../../../../services/catalogEngine/video/filmScript', () => ({ ...jest.requireActual('../../../../services/catalogEngine/video/filmScript'), directScript: jest.fn() }));
jest.mock('../../../../services/catalogEngine/audio/narrate', () => ({ renderChunk: jest.fn() }));
jest.mock('../../../../services/catalogEngine/video/generate', () => ({ generateCandidates: jest.fn(async () => ({ candidates: [{ status: 'done', buffer: Buffer.from('motion') }] })) }));
jest.mock('../../../../services/catalogEngine/video/filmPerformance', () => ({ LIPSYNC_VERSION: 'sync-test', syncDialogue: jest.fn(async () => Buffer.from('synced')), checkPerformance: jest.fn(async () => ({ pass: true, defects: [] })) }));
jest.mock('../../../../services/catalogEngine/video/verify', () => ({ verifyClip: jest.fn(async () => ({ blocking: [], score: 100, frames: [], judge: {} })) }));
jest.mock('../../../../services/catalogEngine/video/stills', () => ({ ...jest.requireActual('../../../../services/catalogEngine/video/stills'), fetchStill: jest.fn(async () => ({ buffer: Buffer.from('frame') })), textGate: jest.fn(async () => ({ pass: true })), prepareStartFrame: jest.fn(async () => ({ buffer: Buffer.from('prepared') })) }));
jest.mock('../../../../services/catalogEngine/video/ffmpeg', () => ({ ...jest.requireActual('../../../../services/catalogEngine/video/ffmpeg'), runFfmpeg: jest.fn(), probeVideo: jest.fn() }));

const { encodeWav } = require('../../../../services/catalogEngine/audio/wav');
const { renderChunk } = require('../../../../services/catalogEngine/audio/narrate');
const { directScript } = require('../../../../services/catalogEngine/video/filmScript');
const { generateCandidates } = require('../../../../services/catalogEngine/video/generate');
const { syncDialogue, checkPerformance } = require('../../../../services/catalogEngine/video/filmPerformance');
const ffmpeg = require('../../../../services/catalogEngine/video/ffmpeg');
const storage = require('../../../../services/gcsStorage');
const { generateFullStoryFilm } = require('../../../../services/catalogEngine/video/fullStory');

const input = () => ({ bookId: 'film-test', story: { spreads: Array.from({ length: 12 }, (_, i) => ({ spread: i + 1, text: 'Hello.' })) }, profile: { name: 'Jo' }, bookDef: { ageBand: '1-3', theme: {}, book: { beats: Array.from({ length: 12 }, (_, i) => ({ spread: i + 1, beat: 'Jo waves.' })) } }, renders: Array.from({ length: 12 }, (_, i) => ({ spread: i + 1, storageKey: `children-jobs/film-test/ce-renders/v/h/spread-${i + 1}.wide-plain.png` })), approvedCoverUrl: 'https://cover/image.png', injectedKeys: { ELEVENLABS_API_KEY: 'test-key' }, voiceProvider: 'elevenlabs', music: 'story-score' });

beforeEach(() => {
  jest.clearAllMocks();
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
  expect(checkPerformance).toHaveBeenCalledTimes(6);
  expect(storage.saveJson).toHaveBeenCalledWith(expect.objectContaining({ mode: 'full-story' }), expect.stringMatching(/film.json$/));
});

test('missing spoken words stop the film before any animation is purchased', async () => {
  renderChunk.mockResolvedValue({ transcript: 'Goodbye.', qa: {}, unresolved: false });
  await expect(generateFullStoryFilm(input())).rejects.toMatchObject({ failureCode: 'film_audio_unresolved' });
  expect(generateCandidates).not.toHaveBeenCalled();
});

test('a wrong speaking character never produces a deliverable film', async () => {
  checkPerformance.mockResolvedValue({ pass: false, defects: ['wrong speaker'] });
  await expect(generateFullStoryFilm(input())).rejects.toMatchObject({ failureCode: 'film_scene_unresolved' });
  expect(storage.saveJson.mock.calls.some(([value]) => value.mode === 'full-story')).toBe(false);
});
