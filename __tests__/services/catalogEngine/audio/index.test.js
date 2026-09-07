/**
 * The run (ab-1 §5.1): provider + cast + script + pronunciations, the
 * whole-book replay from a manifest, takes per segment concurrently with
 * the asset election, the timeline, the two ffmpeg passes (mocked to write
 * synthetic stems), the gates (loudness correction, the ratio re-mix,
 * dead air fails), the ship policy (`audiobook_unresolved` fails closed
 * with candidates; the opt-in ships with an advisory), the takes-only
 * subset, the audition, cancellation, and the callback fields.
 */

process.env.CATALOG_EMOTION_CLASSIFIER = '0';
process.env.CATALOG_AUDIO_DIRECTOR = '0';
process.env.CATALOG_AUDIO_LISTEN_QA = '0';
jest.setTimeout(90000);

jest.mock('../../../../services/gcsStorage', () => ({
  uploadBuffer: jest.fn().mockResolvedValue('https://storage.example/x'),
  uploadBufferIfAbsent: jest.fn().mockResolvedValue({ created: true }),
  downloadBuffer: jest.fn().mockResolvedValue(Buffer.from('asset-bytes')),
  loadJson: jest.fn().mockRejectedValue(new Error('not found')),
  saveJson: jest.fn().mockResolvedValue(undefined),
  objectExists: jest.fn().mockResolvedValue(false),
  getSignedUrl: jest.fn(async key => `https://signed/${key}`),
}));
jest.mock('../../../../services/catalogEngine/illustrator', () => ({ storyFingerprint: () => 'fp1' }));
jest.mock('../../../../services/catalogEngine/audio/narrate', () => {
  const actual = jest.requireActual('../../../../services/catalogEngine/audio/narrate');
  return { ...actual, renderSegment: jest.fn() };
});
jest.mock('../../../../services/catalogEngine/audio/pronounce', () => ({ ensurePronunciation: jest.fn(async ({ name }) => ({ name, status: 'verified', alias: null, cached: false })) }));
jest.mock('../../../../services/catalogEngine/audio/music/suites', () => ({ getMusicSuite: jest.fn() }));
jest.mock('../../../../services/catalogEngine/audio/sfx/library', () => ({ getSoundCues: jest.fn() }));
jest.mock('../../../../services/catalogEngine/audio/assets', () => ({ assetBytes: jest.fn(async () => Buffer.from('asset')), bytesHash: () => 'mp3hash' }));
jest.mock('../../../../services/catalogEngine/audio/mix', () => {
  const actual = jest.requireActual('../../../../services/catalogEngine/audio/mix');
  return { ...actual, runFfmpeg: jest.fn() };
});

const fs = require('fs');
const gcs = require('../../../../services/gcsStorage');
const wav = require('../../../../services/catalogEngine/audio/wav');
const narrate = require('../../../../services/catalogEngine/audio/narrate');
const { getMusicSuite } = require('../../../../services/catalogEngine/audio/music/suites');
const { getSoundCues } = require('../../../../services/catalogEngine/audio/sfx/library');
const mix = require('../../../../services/catalogEngine/audio/mix');
const { generateAudiobook, auditionAudiobook, AudiobookError, normalizeAudioTuning } = require('../../../../services/catalogEngine/audio');
const catalog = require('../../../../services/catalogEngine/catalog');
const { CostTracker } = require('../../../../services/costTracker');
const { AUDIO_VERSION } = require('../../../../services/catalogEngine/versions');

const FS = 48000;
const farm = catalog.baseCatalog().themes.farm;
const book = farm.age_bands['4-5'][0];
const profile = { name: 'Emma', age: 5 };
const story = {
  title: book.title_template.replace('{name}', 'Emma'),
  spreads: book.beats.map(b => ({ spread: b.spread, text: `${book.refrain && book.refrain.spreads.includes(b.spread) ? `${book.refrain.text} ` : ''}Emma looked around. ${b.beat.replace(/^Child/, 'Emma')} The cow said moo.` })),
  personalization_evidence: [],
};
const bookDef = { book, theme: farm, ageBand: '4-5' };
const take = seconds => wav.encodeWav(wav.sine({ hz: 440, seconds, amp: 0.2, sampleRate: 24000 }), 24000);

/** A fake renderSegment: one clean chunk per speaker group, 2 s each. */
const fakeRender = (over = {}) => jest.fn(async ({ segment }) => {
  const chunks = narrate.chunkLines(segment).map(c => ({
    chunk: c.index, speaker: c.speaker, lineIndexes: c.lines.map(l => l.index), storageKey: `children-jobs/b1/audiobook/${AUDIO_VERSION}/takes/${'0'.repeat(16)}/chunk${c.index}.wav`, takeHash: '0'.repeat(16),
    buffer: take(2), measure: { seconds: 2, trim: { start: 0, end: 2 }, trimmedSeconds: 2, lufs: -19, peakDb: -14, truePeakDb: -14, longestSilenceSeconds: 0, sampleRate: 24000 },
    alignment: null, transcript: c.lines.map(l => l.text).join(' '), compare: { wordMatch: 1 }, judged: null,
    qa: { blocking: [], advisory: [], qaUnavailable: null }, score: 100, rung: 'full', candidates: 2, repairs: 0, cached: false, adminPicked: false, candidateFiles: [{ storageKey: 'c1', score: 100 }], unresolved: false,
    ...(typeof over.chunk === 'function' ? over.chunk(segment, c) : {}),
  }));
  return { index: segment.index, kind: segment.kind, spread: segment.spread, chunks, unresolved: chunks.some(c => c.unresolved), cached: false };
});

/** The ffmpeg mock: pass 1 writes synthetic stems, pass 2 writes an "mp3". */
const fakeFfmpeg = ({ musicAmp = 0.005, masterGap = false } = {}) => jest.fn(async (args) => {
  if (args.includes('libmp3lame')) { await fs.promises.writeFile(args[args.length - 1], Buffer.from('ID3fake-mp3')); return { stdout: '', stderr: '' }; }
  const outputs = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '-map') { for (let j = i + 1; j < Math.min(args.length, i + 12); j++) if (/\.wav$/.test(args[j])) { outputs.push(args[j]); break; } }
  const seconds = Number(args[args.indexOf('-t') + 1]) || 10;
  for (const out of outputs) {
    let amp = 0.1;
    if (/music\.wav$/.test(out)) amp = musicAmp;
    if (/ambience\.wav$|sfx\.wav$/.test(out)) amp = 0.002;
    let samples = wav.sine({ hz: 440, seconds, amp, sampleRate: FS });
    if (masterGap && /master\.wav$/.test(out)) samples.fill(0, FS * 2, FS * 6);
    await fs.promises.writeFile(out, wav.encodeWav(samples, FS));
  }
  return { stdout: '', stderr: '' };
});

const suite = () => ({ themeId: 'farm', hash: 'suite1', provider: 'lyria', cues: Object.fromEntries(['theme_intro', 'calm', 'playful', 'wonder', 'tender', 'gentle_tension', 'triumph', 'lullaby_outro', 'refrain_motif'].map(c => [c, { cueId: c, storageKey: `s/${c}.wav`, seconds: 30, lufs: -22, fallback: false }])), fallbackCues: [], advisories: [] });
const sounds = () => ({ hash: 'lib1', provider: 'elevenlabs', cues: { cow_moo: { cueId: 'cow_moo', storageKey: 's/cow.mp3', seconds: 2.5 }, amb_farm_day: { cueId: 'amb_farm_day', storageKey: 's/amb.mp3', seconds: 40 }, transition_page: { cueId: 'transition_page', storageKey: 's/turn.mp3', seconds: 1.2 } }, skipped: [], advisories: [] });
const base = (over = {}) => ({ bookId: 'b1', story, bookDef, profile, costTracker: new CostTracker(), log: () => {}, injectedKeys: { ELEVENLABS_API_KEY: 'k' }, ...over });

beforeEach(() => {
  narrate.renderSegment.mockReset();
  getMusicSuite.mockReset().mockResolvedValue(suite());
  getSoundCues.mockReset().mockResolvedValue(sounds());
  mix.runFfmpeg.mockReset().mockImplementation(fakeFfmpeg());
  gcs.loadJson.mockReset().mockRejectedValue(new Error('not found'));
  gcs.objectExists.mockReset().mockResolvedValue(false);
  gcs.uploadBuffer.mockClear();
  delete process.env.CATALOG_AUDIO_SHIP_ON_EXHAUSTION;
});

describe('generateAudiobook', () => {
  test('a clean run: script → takes → assets → timeline → two passes → gates → upload → manifest; every callback key present', async () => {
    narrate.renderSegment.mockImplementation(fakeRender());
    const p = base();
    const r = await generateAudiobook(p);
    expect(r.cached).toBe(false);
    expect(r.audioVersion).toBe(AUDIO_VERSION);
    expect(r.storageKey).toMatch(new RegExp(`^children-jobs/b1/audiobook/${AUDIO_VERSION}/[0-9a-f]{16}/audiobook\\.mp3$`));
    expect(r.audiobookUrl).toMatch(/^https:\/\/signed\//);
    expect(r.timeline.totalSeconds).toBeGreaterThan(20);
    expect(r.timeline.spreads.map(s => s.spread)).toEqual(book.beats.map(b => b.spread));
    expect(r.durationSeconds).toBe(r.timeline.totalSeconds);
    expect(r.cast.narrator.key).toMatch(/^storyteller_/);
    expect(r.cast.companion.key).toBe('guide_adult_f');
    expect(r.script.lines).toBeGreaterThan(20);
    expect(r.pronunciations.map(x => x.name).sort()).toEqual(['Emma', 'Farmer Bea']);
    expect(r.segments.length).toBe(r.timeline.segments.length);
    expect(r.music.suite.hash).toBe('suite1');
    expect(r.music.plan[0].cue).toBe('theme_intro');
    expect(r.music.motifs.length).toBe(book.refrain.spreads.length);
    expect(r.sfx.placed.some(s => s.cueId === 'cow_moo')).toBe(true);
    expect(r.sfx.pageTurns).toBe(book.beats.length - 1);
    expect(r.ambience).toEqual({ cueId: 'amb_farm_day', gainDb: -30 });
    expect(r.loudness.integratedLufs).toBeCloseTo(-16, 0);
    expect(r.loudness.truePeakDbtp).toBeLessThanOrEqual(-1);
    expect(r.gates.loudness.pass).toBe(true);
    expect(r.gates.speechMusicRatio.pass).toBe(true);
    expect(r.gates.deadAir.pass).toBe(true);
    expect(r.gates.listen.unavailable).toMatch(/disabled/);
    expect(r.unresolved).toEqual([]);
    expect(mix.runFfmpeg).toHaveBeenCalledTimes(2);
    const pass1 = mix.runFfmpeg.mock.calls[0][0];
    expect(pass1.join(' ')).toMatch(/sidechaincompress/);
    expect(pass1.filter(a => a === '-i').length).toBeGreaterThan(r.timeline.segments.length); // takes + music + ambience + cues
    const pass2 = mix.runFfmpeg.mock.calls[1][0];
    expect(pass2).toContain('libmp3lame');
    expect(pass2.join(' ')).toMatch(/volume=7\.\d\ddB/); // −23 measured → −16 target
    expect(gcs.uploadBuffer.mock.calls.some(c => /audiobook\.mp3$/.test(c[1]))).toBe(true);
    expect(gcs.saveJson.mock.calls.some(c => /manifest\.json$/.test(c[1]))).toBe(true);
    expect(getMusicSuite.mock.calls[0][0].cueIds).toContain('refrain_motif');
    expect(narrate.renderSegment).toHaveBeenCalledTimes(r.segments.length);
    expect(p.costTracker.getSummary().totalCost).toBeGreaterThanOrEqual(0);
  });
  test('the whole book replays from a manifest when nothing changed; forceNew ignores it', async () => {
    narrate.renderSegment.mockImplementation(fakeRender());
    gcs.loadJson.mockImplementation(async key => (/manifest\.json$/.test(key) ? { mp3Key: 'k/audiobook.mp3', timelineKey: 'k/timeline.json', durationSeconds: 100, bytes: 5, loudness: { integratedLufs: -16 }, segments: [], timeline: { totalSeconds: 100 } } : Promise.reject(new Error('nope'))));
    gcs.objectExists.mockResolvedValue(true);
    const r = await generateAudiobook(base());
    expect(r.cached).toBe(true);
    expect(narrate.renderSegment).not.toHaveBeenCalled();
    expect(r.audiobookUrl).toBe('https://signed/k/audiobook.mp3');
    const fresh = await generateAudiobook(base({ forceNew: true }));
    expect(fresh.cached).toBe(false);
    expect(narrate.renderSegment).toHaveBeenCalled();
    expect(narrate.renderSegment.mock.calls[0][0].forceRetake).toBe(true);
  });
  test('a low speech-to-music ratio re-mixes with the music lowered (bounded), then reports', async () => {
    narrate.renderSegment.mockImplementation(fakeRender());
    mix.runFfmpeg.mockImplementation(fakeFfmpeg({ musicAmp: 0.08 }));
    const r = await generateAudiobook(base());
    expect(mix.runFfmpeg.mock.calls.filter(c => !c[0].includes('libmp3lame')).length).toBe(3);
    expect(r.gates.speechMusicRatio.musicOffsetDb).toBeLessThan(0);
    expect(r.advisories.some(a => /speech-to-music ratio/.test(a.note))).toBe(true);
  });
  test('dead air on the master fails the mix', async () => {
    narrate.renderSegment.mockImplementation(fakeRender());
    mix.runFfmpeg.mockImplementation(fakeFfmpeg({ masterGap: true }));
    await expect(generateAudiobook(base())).rejects.toMatchObject({ failureCode: 'audiobook_mix_failed' });
  });
  test('an unresolved take fails closed with its candidates; the opt-in ships it with an advisory', async () => {
    narrate.renderSegment.mockImplementation(fakeRender({ chunk: (segment, c) => (segment.spread === 3 && c.index === 0 ? { unresolved: true, qa: { blocking: ['narration text mismatch: word match 0.5'], advisory: [], qaUnavailable: null }, candidateFiles: [{ storageKey: `children-jobs/b1/audiobook/${AUDIO_VERSION}/takes/${'0'.repeat(16)}/chunk0.c1.wav`, score: -20 }] } : {}) }));
    let caught;
    try { await generateAudiobook(base()); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(AudiobookError);
    expect(caught.failureCode).toBe('audiobook_unresolved');
    expect(caught.details.unresolved).toHaveLength(1);
    expect(caught.details.unresolved[0].spread).toBe(3);
    expect(caught.details.unresolved[0].candidates[0].url).toMatch(/^https:\/\/signed\//);
    expect(caught.details.segments.length).toBeGreaterThan(10);
    expect(mix.runFfmpeg).not.toHaveBeenCalled();
    process.env.CATALOG_AUDIO_SHIP_ON_EXHAUSTION = '1';
    const r = await generateAudiobook(base());
    expect(r.unresolved).toHaveLength(1);
    expect(r.advisories.some(a => a.stage === 'shipPolicy')).toBe(true);
  });
  test('a spread subset renders takes only (no assets, no mix); forceRetake marks the listed spreads', async () => {
    narrate.renderSegment.mockImplementation(fakeRender());
    const r = await generateAudiobook(base({ segments: [2, 5], forceRetake: [5] }));
    expect(r.subset).toBe(true);
    expect(r.audiobookUrl).toBeNull();
    expect(r.segments.map(s => s.spread)).toEqual([2, 5]);
    expect(narrate.renderSegment.mock.calls.find(c => c[0].segment.spread === 5)[0].forceRetake).toBe(true);
    expect(narrate.renderSegment.mock.calls.find(c => c[0].segment.spread === 2)[0].forceRetake).toBe(false);
    expect(getMusicSuite).not.toHaveBeenCalled();
    expect(mix.runFfmpeg).not.toHaveBeenCalled();
  });
  test('music and sound cues fail open; a bad cast is a coded error; tuning is capped and echoed', async () => {
    narrate.renderSegment.mockImplementation(fakeRender());
    getMusicSuite.mockRejectedValue(new Error('vertex down'));
    getSoundCues.mockRejectedValue(new Error('eleven down'));
    const r = await generateAudiobook(base({ audioTuning: { versionLabel: 'warm-v2', hash: 'abcdef12', text: 'Lean into every question.' } }));
    expect(r.music).toBeNull();
    expect(r.sfx).toBeNull();
    expect(r.audioTuningUsed).toBe('warm-v2.abcdef12');
    expect(narrate.renderSegment.mock.calls[0][0].tuning).toBe('Lean into every question.');
    await expect(generateAudiobook(base({ cast: { narrator: 'nobody' } }))).rejects.toMatchObject({ failureCode: 'audiobook_bad_cast' });
    expect(() => normalizeAudioTuning({ text: 'x'.repeat(2000) })).toThrow(/exceeds/);
    expect(normalizeAudioTuning({ text: '  ' })).toBeNull();
  });
  test('cancellation aborts', async () => {
    const controller = new AbortController();
    narrate.renderSegment.mockImplementation(async (p) => { controller.abort(); return fakeRender()(p); });
    await expect(generateAudiobook(base({ abortSignal: controller.signal }))).rejects.toMatchObject({ failureCode: 'cancelled' });
  });
});

describe('auditionAudiobook', () => {
  test('renders one spread on the cast and returns the take with its verdict', async () => {
    narrate.renderSegment.mockImplementation(fakeRender());
    const r = await auditionAudiobook(base({ spread: 4, cast: { narrator: 'storyteller_bright' } }));
    expect(r.spread).toBe(4);
    expect(r.cast.narrator.key).toBe('storyteller_bright');
    expect(r.url).toMatch(/auditions\//);
    expect(r.wordMatch).toBe(1);
    expect(narrate.renderSegment).toHaveBeenCalledTimes(1);
    expect(narrate.renderSegment.mock.calls[0][0].opts.candidates).toBe(1);
  });
});
