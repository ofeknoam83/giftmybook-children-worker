/**
 * Elected audio assets (ab-1 §3.3, §4.5-4.6): the create-if-absent
 * election (pinned record wins, a race adopts the other instance's
 * winner, a production failure cools down), the music suite (fixed
 * prompts from the palettes + world card, the suite hash, judged
 * candidates, the CC0 fallback with an advisory when nothing elects or
 * music is off), the sound library (cue definitions incl. ambience and
 * page turn, judged candidates, skipped cues), the pick-take remedy.
 */

jest.mock('../../../../services/gcsStorage', () => ({
  uploadBuffer: jest.fn().mockResolvedValue('https://storage.example/x'),
  uploadBufferIfAbsent: jest.fn().mockResolvedValue({ created: true }),
  downloadBuffer: jest.fn(),
  loadJson: jest.fn().mockRejectedValue(new Error('not found')),
  saveJson: jest.fn().mockResolvedValue(undefined),
  objectExists: jest.fn().mockResolvedValue(false),
  getSignedUrl: jest.fn().mockResolvedValue('https://signed'),
}));
jest.mock('../../../../services/catalogEngine/audio/geminiAudio', () => ({ judgeAudio: jest.fn() }));
jest.mock('../../../../services/catalogEngine/audio/music/providers', () => ({ resolveMusicProvider: jest.fn() }));
jest.mock('../../../../services/catalogEngine/audio/sfx/providers', () => ({ resolveSfxProvider: jest.fn() }));

const gcs = require('../../../../services/gcsStorage');
const { judgeAudio } = require('../../../../services/catalogEngine/audio/geminiAudio');
const { resolveMusicProvider } = require('../../../../services/catalogEngine/audio/music/providers');
const { resolveSfxProvider } = require('../../../../services/catalogEngine/audio/sfx/providers');
const assets = require('../../../../services/catalogEngine/audio/assets');
const suites = require('../../../../services/catalogEngine/audio/music/suites');
const library = require('../../../../services/catalogEngine/audio/sfx/library');
const { pickTake, parseTakeCandidateKey } = require('../../../../services/catalogEngine/audio/candidates');
const wav = require('../../../../services/catalogEngine/audio/wav');
const catalog = require('../../../../services/catalogEngine/catalog');
const { AUDIO_VERSION } = require('../../../../services/catalogEngine/versions');

const farm = catalog.baseCatalog().themes.farm;
const gen = (model = 'm') => jest.fn(async ({ seconds }) => ({ buffer: Buffer.from(`audio-${Math.random()}`), mimeType: 'audio/mpeg', model, seconds }));

beforeEach(() => {
  assets.resetAssetCaches();
  judgeAudio.mockReset();
  gcs.loadJson.mockReset().mockRejectedValue(new Error('not found'));
  gcs.uploadBufferIfAbsent.mockReset().mockResolvedValue({ created: true });
  resolveMusicProvider.mockReset();
  resolveSfxProvider.mockReset();
  delete process.env.CATALOG_AUDIO_MUSIC;
  delete process.env.CATALOG_AUDIO_SFX;
});

describe('electAsset', () => {
  test('a pinned record is returned; a produced winner is published create-if-absent; a race adopts the other winner', async () => {
    gcs.loadJson.mockResolvedValueOnce({ storageKey: 'k/a.mp3', hash: 'h' });
    const pinned = await assets.electAsset({ recordKey: 'k/a.json', bytesKeyBase: 'k/a', produce: jest.fn() });
    expect(pinned.cached).toBe(true);
    const produce = jest.fn(async () => ({ buffer: Buffer.from('x'), mimeType: 'audio/mpeg', meta: { cueId: 'a' } }));
    const r = await assets.electAsset({ recordKey: 'k/b.json', bytesKeyBase: 'k/b', produce });
    expect(r.created).toBe(true);
    expect(r.record.storageKey).toBe('k/b.mp3');
    expect(r.record.audioVersion).toBe(AUDIO_VERSION);
    gcs.uploadBufferIfAbsent.mockResolvedValueOnce({ created: true }).mockResolvedValueOnce({ created: false });
    gcs.loadJson.mockRejectedValueOnce(new Error('not found')).mockResolvedValueOnce({ storageKey: 'k/c.wav', hash: 'other' });
    const raced = await assets.electAsset({ recordKey: 'k/c.json', bytesKeyBase: 'k/c', produce });
    expect(raced.record.hash).toBe('other');
    expect(raced.cached).toBe(true);
  });
  test('a production failure yields nothing and cools down', async () => {
    const produce = jest.fn(async () => { throw new Error('vendor down'); });
    expect((await assets.electAsset({ recordKey: 'k/d.json', bytesKeyBase: 'k/d', produce })).record).toBeNull();
    expect((await assets.electAsset({ recordKey: 'k/d.json', bytesKeyBase: 'k/d', produce })).record).toBeNull();
    expect(produce).toHaveBeenCalledTimes(1);
    expect(assets.extensionFor('audio/wav')).toBe('wav');
    expect(assets.extensionFor('audio/mpeg')).toBe('mp3');
  });
});

describe('music suite', () => {
  test('cue prompts are fixed from the palette + world card; the suite hash is stable per theme', () => {
    const { prompt, negative, seconds } = suites.cuePrompt(farm, 'playful');
    expect(prompt).toMatch(/acoustic guitar/);
    expect(prompt).toMatch(/Palette & light/);
    expect(prompt).toMatch(/playful, bouncy/);
    expect(negative).toMatch(/vocals/);
    expect(seconds).toBe(60);
    expect(suites.suiteHash(farm)).toBe(suites.suiteHash(farm));
    expect(suites.suiteHash(farm)).not.toBe(suites.suiteHash(catalog.baseCatalog().themes.space));
    expect(suites.suiteBase(farm)).toMatch(new RegExp(`^catalog-assets/music-suites/${AUDIO_VERSION}/farm-[0-9a-f]{8}$`));
    expect(suites.fallbackCue('lullaby_outro').path).toMatch(/ambient-bedtime\.mp3$/);
  });
  test('elects the best judged candidate per cue; a cue nothing elects falls back to the CC0 file with an advisory', async () => {
    const adapter = { generate: gen('lyria-002') };
    resolveMusicProvider.mockReturnValue({ ok: true, provider: 'lyria', adapter });
    let call = 0;
    judgeAudio.mockImplementation(async () => { call += 1; return { json: { has_vocals: call % 3 === 0, heavy_percussion: false, harsh_or_loud_hits: false, mood_match: call <= 4 ? 4 : 1, abrupt_ending: false, quality: 4 } }; });
    const costTracker = { addAudioSeconds: jest.fn(), addTextUsage: jest.fn() };
    const r = await suites.getMusicSuite({ theme: farm, cueIds: ['playful', 'calm', 'wonder'], costTracker });
    expect(r.provider).toBe('lyria');
    expect(r.cues.playful.fallback).toBe(false);
    expect(r.cues.playful.storageKey).toMatch(/\/playful\.mp3$/);
    expect(r.cues.wonder.fallback).toBe(true); // calls 5-6: mood 1 → nothing elected
    expect(r.fallbackCues).toEqual(['wonder']);
    expect(r.advisories.some(a => /CC0 library/.test(a.note))).toBe(true);
    expect(costTracker.addAudioSeconds).toHaveBeenCalledWith('lyria:lyria-002', 60);
  });
  test('music off → every cue is the library fallback; a provider outage throws through', async () => {
    process.env.CATALOG_AUDIO_MUSIC = '0';
    const r = await suites.getMusicSuite({ theme: farm, cueIds: ['calm'] });
    expect(r.provider).toBeNull();
    expect(r.cues.calm.fallback).toBe(true);
    delete process.env.CATALOG_AUDIO_MUSIC;
    resolveMusicProvider.mockReturnValue({ ok: true, provider: 'lyria', adapter: { generate: async () => { throw Object.assign(new Error('no project'), { failureCode: 'audiobook_provider_unavailable' }); } } });
    const r2 = await suites.getMusicSuite({ theme: farm, cueIds: ['calm'] });
    expect(r2.cues.calm.fallback).toBe(true); // electAsset catches and falls open
  });
});

describe('sound library', () => {
  test('cue definitions cover spots, ambience and the page turn', () => {
    expect(library.cueDefinition('cow_moo').category).toBe('animal');
    expect(library.cueDefinition('amb_farm_day').category).toBe('ambience');
    expect(library.cueDefinition('transition_page').category).toBe('transition');
    expect(library.cueDefinition('nope')).toBeNull();
    expect(library.cueKeyBase(library.cueDefinition('cow_moo'))).toMatch(new RegExp(`^catalog-assets/sfx/${AUDIO_VERSION}/cow_moo-[0-9a-f]{8}$`));
  });
  test('elects judged candidates; a rejected cue is skipped with an advisory; a startle cue may be harsh', async () => {
    resolveSfxProvider.mockReturnValue({ ok: true, provider: 'elevenlabs', adapter: { generate: gen('sound_effects') } });
    judgeAudio.mockImplementation(async ({ prompt }) => ({ json: { matches_description: !/two or three gentle hen clucks/.test(prompt), contains_voice_or_music: false, harsh_or_startling: /thunder/.test(prompt), quality: 4 } }));
    const r = await library.getSoundCues({ cueIds: ['cow_moo', 'hen_cluck', 'thunder_distant', 'amb_farm_day', 'transition_page'] });
    expect(Object.keys(r.cues).sort()).toEqual(['amb_farm_day', 'cow_moo', 'thunder_distant', 'transition_page']);
    expect(r.skipped.map(s => s.cueId)).toEqual(['hen_cluck']);
    expect(r.advisories).toHaveLength(1);
    expect(r.hash).toMatch(/^[0-9a-f]{12}$/);
  });
  test('sound effects off → every cue skipped', async () => {
    process.env.CATALOG_AUDIO_SFX = '0';
    const r = await library.getSoundCues({ cueIds: ['cow_moo'] });
    expect(r.cues).toEqual({});
    expect(r.skipped[0].reason).toMatch(/disabled/);
  });
});

describe('pick-take', () => {
  test('parses only a candidate key of this book and promotes it with an admin marker', async () => {
    const key = `children-jobs/b1/audiobook/${AUDIO_VERSION}/takes/0123456789abcdef/chunk0.r1c2.wav`;
    expect(parseTakeCandidateKey('b1', key)).toMatchObject({ takeHash: '0123456789abcdef', chunk: 0, candidate: 2, pass: 1, canonicalKey: key.replace('.r1c2.wav', '.wav') });
    expect(parseTakeCandidateKey('other', key)).toBeNull();
    expect(parseTakeCandidateKey('b1', key.replace('.wav', '.wav/../x'))).toBeNull();
    gcs.downloadBuffer.mockResolvedValue(wav.encodeWav(wav.sine({ hz: 440, seconds: 2, amp: 0.2, sampleRate: 24000 }), 24000));
    const r = await pickTake({ bookId: 'b1', candidateKey: key });
    expect(r.storageKey).toBe(key.replace('.r1c2.wav', '.wav'));
    expect(r.seconds).toBeCloseTo(2, 0);
    const marker = JSON.parse(gcs.uploadBuffer.mock.calls.find(c => /\.qa\.json$/.test(c[1]))[0].toString());
    expect(marker.adminPicked).toBe(true);
    expect(marker.unresolved).toBe(false);
    expect(marker.measure.trimmedSeconds).toBeGreaterThan(1.5);
    await expect(pickTake({ bookId: 'b1', candidateKey: 'children-jobs/b1/nope.wav' })).rejects.toMatchObject({ statusCode: 400 });
  });
});
