/**
 * The timeline + the mix graph + the gates (ab-1 §4.7-4.8): gaps per band,
 * chunk joins, line times from an alignment and from word share, a cue
 * anchored on a last line widening the gap, motifs before the refrain,
 * page turns in the gaps, music spans with crossfades, the invariants;
 * pass-1 argv (one graph, stems, sidechain, no shell strings), pass-2
 * argv (gain + limiter + MP3), decode; the deterministic gates on
 * synthetic stems.
 */

const { buildTimeline, validateTimeline, spreadAt, lineTimes, GAPS } = require('../../../../services/catalogEngine/audio/timeline');
const mix = require('../../../../services/catalogEngine/audio/mix');
const gates = require('../../../../services/catalogEngine/audio/gates');
const wav = require('../../../../services/catalogEngine/audio/wav');

const line = (index, text, speaker = 'narrator', isRefrain = false) => ({ index, text, speaker, isRefrain, direction: { emotion: 'joy', intensity: 'clear', pace: 'even', shape: 'statement' }, pauseAfterMs: 450 });
const script = (band = '4-5') => ({
  version: 'ab-1', band, pageTurn: { cueId: 'transition_page', gainDb: -22, seconds: 1.2 },
  segments: [
    { index: 0, kind: 'intro', spread: null, lines: [line(0, 'Title.'), line(1, 'A story for Emma.')], music: { cue: 'theme_intro', gainDb: -14 }, sfx: [], ambience: { cueId: 'amb_farm_day', gainDb: -30 } },
    { index: 1, kind: 'spread', spread: 1, lines: [line(0, 'Emma looked around the farm.'), line(1, 'The cow said moo.')], music: { cue: 'theme_intro', gainDb: -14 }, sfx: [{ cueId: 'cow_moo', anchorLine: 1, placement: 'after', gainDb: -14, source: 'text', seconds: 2.5 }], ambience: { cueId: 'amb_farm_day', gainDb: -30 } },
    { index: 2, kind: 'spread', spread: 2, lines: [line(0, 'Hello, farm! Here we are!', 'narrator', true), line(1, '"Hi!"', 'companion'), line(2, 'said Farmer Bea.')], music: { cue: 'playful', gainDb: -14, change: true, motif: true }, sfx: [], ambience: { cueId: 'amb_farm_day', gainDb: -30 } },
    { index: 3, kind: 'outro', spread: null, lines: [line(0, 'The end.')], music: { cue: 'lullaby_outro', gainDb: -14, change: true }, sfx: [], ambience: { cueId: 'amb_farm_day', gainDb: -30 } },
  ],
});
const chunk = (index, speaker, lineIndexes, seconds, alignment = null) => ({ chunk: index, speaker, lineIndexes, storageKey: `k${index}`, measure: { trim: { start: 0.1, end: 0.1 + seconds }, trimmedSeconds: seconds, lufs: -19 }, alignment });
const takes = () => [
  { index: 0, chunks: [chunk(0, 'narrator', [0, 1], 3)] },
  { index: 1, chunks: [chunk(0, 'narrator', [0, 1], 4, [{ line: 0, start: 0.1, end: 2.1 }, { line: 1, start: 2.4, end: 4.1 }])] },
  { index: 2, chunks: [chunk(0, 'narrator', [0], 2), chunk(1, 'companion', [1], 0.8), chunk(2, 'narrator', [2], 1.2)] },
  { index: 3, chunks: [chunk(0, 'narrator', [0], 1)] },
];

describe('buildTimeline', () => {
  test('places segments with band gaps, widens for the cue, motif before the refrain, page turn in the gap, music spans crossfaded', () => {
    const t = buildTimeline({ script: script('4-5'), takes: takes(), cueSeconds: { cow_moo: { seconds: 2.5 } } });
    expect(validateTimeline(t).errors).toEqual([]);
    expect(t.segments[0].start).toBe(0);
    expect(t.segments[1].start).toBeCloseTo(3 + GAPS.intro, 3);
    const s1 = t.segments[1];
    expect(s1.lines[0].start).toBeCloseTo(s1.start, 2); // alignment (relative to the untrimmed take, trim 0.1)
    expect(s1.lines[1].start).toBeCloseTo(s1.start + 2.3, 2);
    expect(t.sfx).toHaveLength(1);
    expect(t.sfx[0].at).toBeCloseTo(s1.end + 0.15, 3);
    // the gap after spread 1 is widened to fit the cue (0.15 + 2.5×0.6 + 0.3 = 1.95 > 0.9)
    expect(t.segments[2].start - s1.end).toBeCloseTo(1.95, 2);
    expect(t.pageTurns).toHaveLength(1);
    expect(t.pageTurns[0].at).toBeCloseTo(s1.end + 1.95 / 2, 2);
    expect(t.motifs).toHaveLength(1);
    expect(t.motifs[0].at).toBeCloseTo(t.segments[2].lines[0].start - 1.5, 2);
    expect(t.segments[2].chunks[1].at).toBeCloseTo(t.segments[2].chunks[0].at + 2 + GAPS.chunk, 3);
    expect(t.music.map(m => m.cue)).toEqual(['theme_intro', 'playful', 'lullaby_outro']);
    expect(t.music[0].from).toBe(0);
    expect(t.music[0].to).toBeGreaterThan(t.music[1].from); // 3 s crossfade overlap
    expect(t.music[2].to).toBe(t.totalSeconds);
    expect(t.totalSeconds).toBeCloseTo(t.segments[3].end + GAPS.tail, 3);
    expect(t.ambience).toEqual({ cueId: 'amb_farm_day', gainDb: -30 });
    expect(t.spreads.map(s => s.spread)).toEqual([1, 2]);
    expect(spreadAt(t, 0.5)).toBeNull();
    expect(spreadAt(t, t.spreads[1].start + 0.1)).toBe(2);
    expect(t.chapters[1].title).toBe('Spread 1');
  });
  test('band 1-3 uses the longer spread gap; options can drop page turns and motifs', () => {
    const t = buildTimeline({ script: script('1-3'), takes: takes(), options: { pageTurn: false, motif: false } });
    expect(t.pageTurns).toEqual([]);
    expect(t.motifs).toEqual([]);
    const t2 = buildTimeline({ script: { ...script('1-3'), segments: script('1-3').segments.map(s => ({ ...s, sfx: [] })) }, takes: takes() });
    expect(t2.segments[2].start - t2.segments[1].end).toBeCloseTo(GAPS.spreadYoung, 3);
  });
  test('lineTimes falls back to word share when the alignment is missing or malformed', () => {
    const lines = [line(0, 'one two three four'), line(1, 'five six')];
    const c = chunk(0, 'narrator', [0, 1], 6, [{ line: 0, start: 5, end: 1 }, { line: 1, start: 0, end: 0 }]);
    const t = lineTimes(c, lines, 10);
    expect(t[0]).toEqual({ index: 0, start: 10, end: 14 });
    expect(t[1]).toEqual({ index: 1, start: 14, end: 16 });
  });
});

describe('mix argv', () => {
  const t = buildTimeline({ script: script(), takes: takes(), cueSeconds: { cow_moo: { seconds: 2.5 } } });
  const takeFiles = t.segments.flatMap(s => s.chunks.map(c => ({ path: `${c.storageKey}.wav`, at: c.at, trim: c.trim, lufs: c.lufs })));
  test('pass 1: one graph with trimmed, level-matched, delayed takes; looped faded music under a sidechain; ambience; cues; five outputs', () => {
    const { args, inputs } = mix.buildMixCommand({
      timeline: t, takes: takeFiles,
      music: t.music.map(m => ({ ...m, path: `${m.cue}.mp3`, lufs: -22 })),
      sfx: [...t.sfx.map(s => ({ path: 'cow.mp3', at: s.at, gainDb: s.gainDb, lufs: null })), ...t.motifs.map(m => ({ path: 'motif.wav', at: m.at, gainDb: m.gainDb })), ...t.pageTurns.map(p => ({ path: 'turn.mp3', at: p.at, gainDb: p.gainDb }))],
      ambience: { path: 'amb.mp3', gainDb: -30, lufs: -25 },
      outputs: { master: 'master.wav', voice: 'voice.wav', music: 'music.wav', ambience: 'amb.wav', sfx: 'sfx.wav' },
    });
    expect(inputs).toBe(takeFiles.length + 3 + 3 + 1);
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('atrim=start=0.100:end=3.100,asetpts=PTS-STARTPTS');
    expect(graph).toContain('volume=1.00dB'); // −18 target vs −19 measured take
    expect(graph).toContain(`adelay=${Math.round(t.segments[1].start * 1000)}|${Math.round(t.segments[1].start * 1000)}`);
    expect(graph).toContain('asplit=3[voice][sc][voiceout]');
    expect(graph).toContain('aloop=loop=-1:size=2147483647');
    expect(graph).toContain('sidechaincompress=threshold=0.1:ratio=3:attack=250:release=1200');
    expect(graph).toContain('highpass=f=120,lowpass=f=8000');
    expect(graph).toContain('[voice][music][ambience][sfx]amix=inputs=4:normalize=0:duration=first[master]');
    expect(args.filter(a => a === '-map')).toHaveLength(5);
    expect(args).toContain('master.wav');
    expect(args).toContain('sfx.wav');
    expect(args.join(' ')).not.toMatch(/[;&|]\s*(rm|sh)/);
    // music level: −18 − 14 − (−22) = −10 dB
    expect(graph).toContain('volume=-10.00dB');
    // an asset without a measured loudness assumes −20 LUFS: cue −14 → −12 dB
    expect(graph).toContain('volume=-12.00dB');
  });
  test('pass 1 without music or ambience still yields every stem; a music offset shifts the spans', () => {
    const { args } = mix.buildMixCommand({ timeline: t, takes: takeFiles, outputs: { master: 'm.wav' } });
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('[sc]anullsink');
    expect(graph).toContain('anullsrc=r=48000:cl=stereo');
    expect(args.filter(a => a === '-f')).toHaveLength(4); // four null stems
    const shifted = mix.buildMixCommand({ timeline: t, takes: takeFiles, music: t.music.map(m => ({ ...m, path: 'x.mp3', lufs: -22 })), outputs: { master: 'm.wav' }, musicOffsetDb: -3 });
    expect(shifted.args[shifted.args.indexOf('-filter_complex') + 1]).toContain('volume=-13.00dB');
    expect(() => mix.buildMixCommand({ timeline: t, takes: [], outputs: { master: 'm.wav' } })).toThrow(/at least one take/);
  });
  test('pass 2: gain + limiter + MP3 + metadata; decode command', () => {
    const args = mix.buildMasterCommand({ input: 'master.wav', output: 'book.mp3', gainDb: 2.35, metadata: { title: 'Emma\'s Farm Day', artist: 'Gift My Book\nx' } });
    expect(args).toContain('volume=2.35dB,alimiter=limit=0.891:attack=5:release=50:level=false');
    expect(args).toContain('libmp3lame');
    expect(args).toContain('title=Emma\'s Farm Day');
    expect(args).toContain('artist=Gift My Book x');
    expect(args[args.length - 1]).toBe('book.mp3');
    expect(mix.buildDecodeCommand({ input: 'a.mp3', output: 'a.wav' })).toEqual(['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'a.mp3', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1', 'a.wav']);
    expect(mix.gainTo(null, -18)).toBe(2);
    expect(mix.gainTo(-60, -18)).toBe(30);
  });
});

describe('gates', () => {
  const FS = 48000;
  const tone = (seconds, amp) => wav.sine({ hz: 1000, seconds, amp, sampleRate: FS });
  const cat = parts => { const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
  test('measureMaster: the gain to the target, true peak, dead air', () => {
    const master = wav.encodeWav(tone(6, 0.1), FS); // ≈ −23 LUFS
    const r = gates.measureMaster(master, -16);
    expect(r.integratedLufs).toBeCloseTo(-23, 0);
    expect(r.gainDb).toBeCloseTo(7, 0);
    expect(r.deadAir).toEqual([]);
    expect(r.pass).toBe(true);
    const gap = wav.encodeWav(cat([tone(2, 0.1), new Float32Array(FS * 3), tone(2, 0.1)]), FS);
    expect(gates.measureMaster(gap, -16).deadAir).toHaveLength(1);
  });
  test('speechMusicRatio per spread from the stems; a low ratio proposes a music offset', () => {
    const voice = wav.encodeWav(cat([tone(4, 0.2), new Float32Array(FS), tone(4, 0.2)]), FS);
    const quietMusic = wav.encodeWav(tone(9, 0.005), FS);
    const loudMusic = wav.encodeWav(tone(9, 0.15), FS);
    const timeline = { speechWindows: [{ start: 0, end: 4, spread: 1 }, { start: 5, end: 9, spread: 2 }] };
    const ok = gates.speechMusicRatio({ voiceWav: voice, musicWav: quietMusic, timeline });
    expect(ok.pass).toBe(true);
    expect(ok.perSpread.map(p => p.spread)).toEqual([1, 2]);
    const bad = gates.speechMusicRatio({ voiceWav: voice, musicWav: loudMusic, timeline });
    expect(bad.pass).toBe(false);
    expect(bad.adjustDb).toBeLessThan(0);
  });
  test('startle: a loud 100 ms burst on the effects stem fails', () => {
    const quiet = wav.encodeWav(tone(2, 0.05), FS);
    const burst = wav.encodeWav(cat([tone(1, 0.05), tone(0.1, 0.9), tone(1, 0.05)]), FS);
    expect(gates.startleCheck({ sfxWav: quiet, musicWav: quiet }).pass).toBe(true);
    const r = gates.startleCheck({ sfxWav: burst, musicWav: null });
    expect(r.pass).toBe(false);
    expect(r.sfx.at).toBeCloseTo(1, 1);
  });
});
