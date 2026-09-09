/**
 * The film soundtrack (gfs-2): the audiobook's cue grammar and sound
 * library laid on the film's FIXED clock — spans that cover the film with
 * crossfades on the cuts, the motif before the refrain, spot cues in the
 * paid-for pause after a passage and never over a spoken word, the
 * theme's ambience bed; and the asset election / mixer inputs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const soundtrack = require('../../../../services/catalogEngine/video/filmSoundtrack');
const catalog = require('../../../../services/catalogEngine/catalog');
const { MOTIF_CUE, BASE_GAIN_DB } = require('../../../../services/catalogEngine/audio/music/plan');

const theme = catalog.baseCatalog().themes.farm;
const book = { beats: Array.from({ length: 12 }, (_, i) => ({ spread: i + 1, beat: i === 1 ? 'Child counts three chickens by the pond.' : 'Child walks on.' })), refrain: { text: 'Sunny day, hooray!', spreads: [3, 9] } };
const bookDef = { book, theme, ageBand: '6-7' };
const story = { personalization_evidence: [{ spread: 5, source_value: 'rubber duck', source_field: 'object', moment_type: 'object_presence', slot_id: 's', visual_required: true }] };

/** Two passages per spread — a narrated line and a quoted one — with emotions that shape the score. */
function turns() {
  const out = [];
  const emotionOf = spread => (spread <= 4 ? 'wonder' : spread <= 8 ? 'joy' : spread <= 10 ? 'determination' : 'tenderness');
  for (let spread = 1; spread <= 12; spread++) {
    const text = spread === 2 ? 'Emma counted three chickens and a duck quacked. ' : spread === 5 ? 'Emma hugged her rubber duck. ' : [3, 9].includes(spread) ? 'Sunny day, hooray! ' : 'Emma walked on. ';
    out.push({ index: out.length, spread, speaker: 'narrator', emotion: emotionOf(spread), text });
    out.push({ index: out.length, spread, speaker: 'child', emotion: emotionOf(spread), text: '“Look!”' });
  }
  return out;
}

/** One 4-second shot per passage (0.2 s head, speech to 3.4 s, tail to 4 s). */
function shots(script) {
  return script.map((t, i) => ({ index: i, turn: t.index, spread: t.spread, speaker: t.speaker, from: i * 4, to: (i + 1) * 4, seconds: 4, speechStart: 0.2, speechEnd: 3.4 }));
}

describe('planFilmCues', () => {
  test('per-spread emotions weigh the spoken text; the cue plan follows the audiobook grammar; refrain passages are found', () => {
    const script = turns();
    expect(soundtrack.spreadEmotions(script)[2]).toEqual({ emotion: 'wonder', intensity: 'clear' });
    const cues = soundtrack.planFilmCues({ turns: script, bookDef, story, profile: { name: 'Emma' }, seedBasis: 'seed', options: { music: true, sfx: true, ambience: true } });
    expect(cues.errors).toEqual([]);
    expect(cues.segments[0].music.cue).toBe('theme_intro');
    expect(cues.segments[11].music.cue).toBe('lullaby_outro');
    expect(cues.musicCues).toEqual(expect.arrayContaining(['theme_intro', 'lullaby_outro']));
    expect(cues.wantsMotif).toBe(true);
    expect(cues.refrainTurns).toEqual([4, 16]);
    expect(cues.ambience).toEqual({ cueId: 'amb_farm_day', gainDb: -30 });
    // spread 2's beat and text earn farm cues; spread 5's evidence names the duck
    expect(cues.segments[1].sfx.map(x => x.cueId)).toEqual(expect.arrayContaining(['hen_cluck']));
    expect(cues.segments[4].sfx[0]).toMatchObject({ cueId: 'duck_quack', source: 'evidence' });
    expect(cues.sfxCues).toEqual(expect.arrayContaining(['hen_cluck', 'duck_quack']));
    expect(cues.libraryHash).toMatch(/^[0-9a-f]{12}$/);
  });

  test('music off plans no cues; sound design off plans no cues or bed', () => {
    const script = turns();
    const none = soundtrack.planFilmCues({ turns: script, bookDef, story, profile: { name: 'Emma' }, seedBasis: 'seed', options: { music: false, sfx: false, ambience: false } });
    expect(none.musicCues).toEqual([]);
    expect(none.sfxCues).toEqual([]);
    expect(none.ambience).toBeNull();
    expect(none.segments[0].music).toBeUndefined();
  });
});

describe('layFilmSoundtrack + validateFilmSoundtrack', () => {
  test('spans cover the film, crossfade on the cuts, the motif leads the refrain, cues sit in the pause after a passage', () => {
    const script = turns();
    const cues = soundtrack.planFilmCues({ turns: script, bookDef, story, profile: { name: 'Emma' }, seedBasis: 'seed', options: { music: true, sfx: true, ambience: true } });
    const laid = soundtrack.layFilmSoundtrack({ segments: cues.segments, shots: shots(script), cueSeconds: { duck_quack: { seconds: 2 } }, options: { music: true, sfx: true, ambience: true, motif: true } });
    expect(laid.totalSeconds).toBe(96);
    expect(laid.music[0]).toMatchObject({ cue: 'theme_intro', from: 0, fadeIn: 1, gainDb: BASE_GAIN_DB.default });
    expect(laid.music[laid.music.length - 1]).toMatchObject({ cue: 'lullaby_outro', to: 96, fadeOut: 2.5 });
    for (let i = 1; i < laid.music.length; i++) {
      // a 3 s crossfade centred on the cut: the next span starts 1.5 s before the previous ends
      expect(laid.music[i - 1].to - laid.music[i].from).toBeCloseTo(3, 3);
      expect(laid.music[i].fadeIn).toBe(3);
    }
    // 1.5 s before the refrain would land under the previous passage's last word (12 + 3.4); the floor is its end + 0.1
    expect(laid.motifs).toEqual([
      { spread: 3, cueId: MOTIF_CUE, at: 12 + 3.4 + 0.1, gainDb: -12 },
      { spread: 9, cueId: MOTIF_CUE, at: 60 + 3.4 + 0.1, gainDb: -12 },
    ]);
    const roomy = shots(script).map(s => ({ ...s, from: s.index * 6, to: (s.index + 1) * 6, seconds: 6 }));
    expect(soundtrack.layFilmSoundtrack({ segments: cues.segments, shots: roomy, options: { music: true, sfx: false, ambience: false, motif: true } }).motifs[0].at).toBeCloseTo(4 * 6 + 0.2 - 1.5, 3);
    const duck = laid.sfx.find(s => s.cueId === 'duck_quack');
    expect(duck).toMatchObject({ spread: 5, at: 8 * 4 + 3.4 + 0.15, seconds: 2, gainDb: -14, source: 'evidence', passage: 8 });
    expect(laid.ambience).toEqual({ cueId: 'amb_farm_day', gainDb: -30 });
    expect(laid.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(soundtrack.validateFilmSoundtrack(laid)).toEqual({ ok: true, errors: [] });
    // the plan is a pure function of its inputs
    expect(soundtrack.layFilmSoundtrack({ segments: cues.segments, shots: shots(script), cueSeconds: { duck_quack: { seconds: 2 } }, options: { music: true, sfx: true, ambience: true, motif: true } }).hash).toBe(laid.hash);
  });

  test('cues never start over a spoken word and keep 4 s apart; a cue with no shot or at the film’s end is skipped', () => {
    const script = turns();
    const cues = soundtrack.planFilmCues({ turns: script, bookDef, story, profile: { name: 'Emma' }, seedBasis: 'seed', options: { music: true, sfx: true, ambience: true } });
    // squeeze every shot to 3 s with speech to the very end: no pause to place a cue in
    const tight = shots(script).map(s => ({ ...s, from: s.index * 3, to: (s.index + 1) * 3, seconds: 3, speechEnd: 2.9 }));
    const laid = soundtrack.layFilmSoundtrack({ segments: cues.segments, shots: tight, options: { music: false, sfx: true, ambience: false, motif: false } });
    const check = soundtrack.validateFilmSoundtrack({ ...laid, speechWindows: tight.map(s => ({ start: s.from + 0.2, end: s.from + 3.2 })) });
    expect(check.ok).toBe(false);
    expect(check.errors[0]).toMatch(/starts over a spoken word/);
    // two cues anchored on adjacent passages: exactly 4 s apart is allowed, 3.5 s drops the second for spacing
    const close = cues.segments.map(seg => ({ ...seg, sfx: seg.spread === 2 ? [{ cueId: 'hen_cluck', anchorLine: 0, gainDb: -14, seconds: 2.5, source: 'text' }, { cueId: 'duck_quack', anchorLine: 1, gainDb: -14, seconds: 2, source: 'text' }] : [] }));
    expect(soundtrack.layFilmSoundtrack({ segments: close, shots: shots(script), options: { music: false, sfx: true, ambience: false, motif: false } }).sfx.map(s => s.cueId)).toEqual(['hen_cluck', 'duck_quack']);
    const closer = shots(script).map(s => ({ ...s, from: s.index * 3.5, to: (s.index + 1) * 3.5, seconds: 3.5, speechEnd: 2.9 }));
    const spaced = soundtrack.layFilmSoundtrack({ segments: close, shots: closer, options: { music: false, sfx: true, ambience: false, motif: false } });
    expect(spaced.sfx.map(s => s.cueId)).toEqual(['hen_cluck']);
    expect(spaced.skipped).toContainEqual({ spread: 2, cueId: 'duck_quack', reason: 'spacing' });
    const orphan = soundtrack.layFilmSoundtrack({ segments: close, shots: shots(script).filter(s => s.spread !== 2), options: { music: false, sfx: true, ambience: false, motif: false } });
    expect(orphan.sfx).toEqual([]);
    expect(orphan.skipped).toContainEqual({ spread: 2, cueId: 'hen_cluck', reason: 'no shot' });
  });

  test('validation names an empty span, a silent gap between spans and a score that does not cover the film', () => {
    const base = { totalSeconds: 10, music: [{ cue: 'calm', from: 0, to: 4 }, { cue: 'tender', from: 6, to: 10 }], sfx: [], speechWindows: [] };
    expect(soundtrack.validateFilmSoundtrack(base).errors).toEqual(['music is silent between calm and tender']);
    expect(soundtrack.validateFilmSoundtrack({ ...base, music: [{ cue: 'calm', from: 2, to: 2 }] }).errors).toEqual(expect.arrayContaining(['music span calm is empty', 'the score does not cover the film']));
  });
});

describe('assets + mixer inputs', () => {
  test('soundtrackOptions follow the request and the switches', () => {
    for (const k of ['CATALOG_FILM_SFX', 'CATALOG_AUDIO_SFX', 'CATALOG_AUDIO_AMBIENCE', 'CATALOG_AUDIO_MUSIC']) delete process.env[k];
    expect(soundtrack.soundtrackOptions('story-score')).toEqual({ music: true, motif: true, sfx: true, ambience: true });
    expect(soundtrack.soundtrackOptions('none')).toEqual({ music: false, motif: false, sfx: true, ambience: true });
    process.env.CATALOG_FILM_SFX = '0';
    expect(soundtrack.soundtrackOptions('story-score')).toEqual({ music: true, motif: true, sfx: false, ambience: false });
    delete process.env.CATALOG_FILM_SFX;
  });

  test('writeSoundtrackInputs stages every elected file once and reports what plays; a missing cue is an advisory', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'film-soundtrack-'));
    try {
      const fallback = path.join(__dirname, '../../../../services/catalogEngine/data/audio/fallback');
      const cc0 = file => ({ path: path.join(fallback, file), fallback: true, mimeType: 'audio/mpeg' });
      const laid = {
        music: [{ cue: 'theme_intro', from: 0, to: 6, gainDb: -14, fadeIn: 1, fadeOut: 3, spreads: [1] }, { cue: 'calm', from: 3, to: 20, gainDb: -14, fadeIn: 3, fadeOut: 2.5, spreads: [2, 3] }, { cue: 'wonder', from: 18, to: 30, gainDb: -14, fadeIn: 3, fadeOut: 2.5, spreads: [4] }],
        motifs: [{ spread: 3, cueId: MOTIF_CUE, at: 9, gainDb: -12 }],
        sfx: [{ spread: 2, cueId: 'hen_cluck', at: 7.55, gainDb: -14, seconds: 2.5, source: 'beat' }, { spread: 3, cueId: 'ghost', at: 12, gainDb: -14, seconds: 2, source: 'text' }],
        skipped: [], ambience: { cueId: 'amb_farm_day', gainDb: -30 },
      };
      const assets = {
        suite: { themeId: 'farm', hash: 'suite', provider: 'library', fallbackCues: ['theme_intro'], cues: { theme_intro: cc0('ambient-light.mp3'), calm: cc0('ambient-calm.mp3'), [MOTIF_CUE]: cc0('ambient-curious.mp3') } },
        sounds: { hash: 'lib', provider: 'elevenlabs', skipped: [{ cueId: 'ghost', reason: 'no candidate could be elected' }], cues: { hen_cluck: cc0('ambient-playful.mp3'), amb_farm_day: cc0('ambient-tender.mp3') } },
      };
      const inputs = await soundtrack.writeSoundtrackInputs({ dir, laid, assets });
      expect(inputs.music.map(m => [m.cue, path.basename(m.path)])).toEqual([['theme_intro', 'music-0-theme_intro.mp3'], ['calm', 'music-1-calm.mp3']]);
      expect(inputs.advisories).toEqual([{ stage: 'music', note: 'cue wonder is unavailable — spreads 4 play without music' }]);
      expect(inputs.sfx.map(s => [path.basename(s.path), s.at, s.gainDb])).toEqual([['sfx-0-hen_cluck.mp3', 7.55, -14], ['motif-0.mp3', 9, -12]]);
      expect(inputs.ambience).toMatchObject({ gainDb: -30 });
      expect(inputs.report).toMatchObject({ rules: 'fst-1', music: { provider: 'library', suite: { themeId: 'farm', fallbackCues: ['theme_intro'] }, motifs: [{ spread: 3, at: 9 }] }, sfx: { provider: 'elevenlabs', placed: [{ spread: 2, cueId: 'hen_cluck', at: 7.55 }], skipped: [{ cueId: 'ghost', reason: 'no candidate could be elected' }] }, ambience: { cueId: 'amb_farm_day', gainDb: -30 } });
      expect(soundtrack.soundtrackAssetsHash(assets)).toMatch(/^[0-9a-f]{16}$/);
      expect(soundtrack.soundtrackAssetsHash({ suite: null, sounds: null })).not.toBe(soundtrack.soundtrackAssetsHash(assets));
      for (const f of await fs.promises.readdir(dir)) expect((await fs.promises.stat(path.join(dir, f))).size).toBeGreaterThan(1000);
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  });
});
