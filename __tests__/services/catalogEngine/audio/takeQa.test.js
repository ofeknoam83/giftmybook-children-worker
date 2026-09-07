/**
 * The take verdict (ab-1 §4.4, aq-1): measurements alone catch an empty,
 * a too-long, a dead-air and a clipped take; the transcript gate (the
 * judge mocked) catches a mismatch, a spoken tag, an artifact, the name
 * not heard, and shades pace / monotone / emotion as advisories; a judge
 * outage is `qaUnavailable` (never a pass); classification and the repair
 * ladder note.
 */

jest.mock('../../../../services/catalogEngine/audio/geminiAudio', () => ({ judgeAudio: jest.fn() }));

const { judgeAudio } = require('../../../../services/catalogEngine/audio/geminiAudio');
const wav = require('../../../../services/catalogEngine/audio/wav');
const { measureTake } = require('../../../../services/catalogEngine/audio/metrics');
const qa = require('../../../../services/catalogEngine/audio/takeQa');

const FS = 24000;
const take = (seconds, amp = 0.2) => wav.encodeWav(wav.sine({ hz: 440, seconds, amp, sampleRate: FS }), FS);
const verdict = (over = {}) => ({ json: { transcript: 'Emma looked around. The cow said moo.', spoken_control_words: false, glitch_or_artifact: false, robotic: false, reads_as: 'wonder', monotone: false, pace: 'right', mispronounced: [], ...over } });
const base = () => ({ expectedText: 'Emma looked around. The cow said moo.', expectedSeconds: { min: 1.5, max: 6 }, directionWords: 'amazed and full of wonder', name: 'Emma', controlWords: ['whispers', 'excited'], expectedEmotion: 'wonder' });

beforeEach(() => { judgeAudio.mockReset(); delete process.env.CATALOG_AUDIO_TRANSCRIPT_QA; });

describe('checkTake', () => {
  test('a clean take passes with the transcript recorded', async () => {
    judgeAudio.mockResolvedValue(verdict());
    const w = take(3);
    const r = await qa.checkTake({ ...base(), wav: w, measure: measureTake(w) });
    expect(r.blocking).toEqual([]);
    expect(r.advisory).toEqual([]);
    expect(r.transcript).toMatch(/cow said moo/);
    expect(r.compare.wordMatch).toBe(1);
    expect(r.qaUnavailable).toBeNull();
    expect(judgeAudio).toHaveBeenCalledTimes(1);
    const call = judgeAudio.mock.calls[0][0];
    expect(call.audio[0].mimeType).toBe('audio/wav');
    expect(call.prompt).toMatch(/word for word/);
  });
  test('measurements alone: too long, dead air, clipped, empty', async () => {
    judgeAudio.mockResolvedValue(verdict());
    const long = take(9);
    expect((await qa.checkTake({ ...base(), wav: long, measure: measureTake(long) })).blocking.join(' ')).toMatch(/duration off/);
    const parts = [wav.sine({ hz: 440, seconds: 1, amp: 0.2, sampleRate: FS }), new Float32Array(FS * 3), wav.sine({ hz: 440, seconds: 1, amp: 0.2, sampleRate: FS })];
    const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    const gap = wav.encodeWav(all, FS);
    expect((await qa.checkTake({ ...base(), wav: gap, measure: measureTake(gap) })).blocking.join(' ')).toMatch(/dead air/);
    const hot = take(3, 1);
    expect((await qa.checkTake({ ...base(), wav: hot, measure: measureTake(hot) })).blocking).toContain(qa.DEFECTS.CLIPPED);
    const empty = wav.encodeWav(new Float32Array(FS), FS);
    const e = await qa.checkTake({ ...base(), wav: empty, measure: measureTake(empty) });
    expect(e.blocking).toContain(qa.DEFECTS.EMPTY);
    expect(judgeAudio).toHaveBeenCalledTimes(3); // never for the empty take
  });
  test('the transcript gate: mismatch, spoken tag, artifact are blocking; name / pace / monotone / emotion are advisory', async () => {
    const w = take(3);
    judgeAudio.mockResolvedValueOnce(verdict({ transcript: 'Emma looked. The cow.' }));
    expect((await qa.checkTake({ ...base(), wav: w, measure: measureTake(w) })).blocking.join(' ')).toMatch(/text mismatch/);
    judgeAudio.mockResolvedValueOnce(verdict({ transcript: 'whispers Emma looked around. The cow said moo.', spoken_control_words: true }));
    expect((await qa.checkTake({ ...base(), wav: w, measure: measureTake(w) })).blocking.join(' ')).toMatch(/tag spoken aloud: whispers/);
    judgeAudio.mockResolvedValueOnce(verdict({ glitch_or_artifact: true }));
    expect((await qa.checkTake({ ...base(), wav: w, measure: measureTake(w) })).blocking.join(' ')).toMatch(/synthesis artifact/);
    const longer = { ...base(), expectedText: 'The little cow looked at Emma and said moo, and all the birds sang along.' };
    judgeAudio.mockResolvedValueOnce(verdict({ transcript: 'The little cow looked at Gnome and said moo, and all the birds sang along.', monotone: true, pace: 'too_fast', reads_as: 'calm', mispronounced: ['Gnome'] }));
    const r = await qa.checkTake({ ...longer, wav: w, measure: measureTake(w) });
    expect(r.blocking).toEqual([]);
    expect(r.advisory).toEqual(expect.arrayContaining([qa.DEFECTS.NAME_NOT_HEARD, qa.DEFECTS.MONOTONE, qa.DEFECTS.TOO_FAST]));
    expect(r.advisory.join(' ')).toMatch(/reads as calm, directed wonder/);
    expect(r.advisory.join(' ')).toMatch(/mispronounced word: Gnome/);
  });
  test('a judge outage is qaUnavailable, never a pass; the switch off says so', async () => {
    const w = take(3);
    judgeAudio.mockRejectedValueOnce(new Error('HTTP 503'));
    const r = await qa.checkTake({ ...base(), wav: w, measure: measureTake(w) });
    expect(r.qaUnavailable).toMatch(/HTTP 503/);
    expect(r.transcript).toBeNull();
    process.env.CATALOG_AUDIO_TRANSCRIPT_QA = '0';
    const off = await qa.checkTake({ ...base(), wav: w, measure: measureTake(w) });
    expect(off.qaUnavailable).toMatch(/disabled/);
    expect(judgeAudio).toHaveBeenCalledTimes(1);
  });
});

describe('classification + repair note', () => {
  test('fixed strings split blocking / advisory; unknown is advisory', () => {
    const r = qa.classifyTakeDefects([`${qa.DEFECTS.TEXT_MISMATCH}: word match 0.5`, qa.DEFECTS.MONOTONE, 'something new']);
    expect(r.blocking).toEqual([`${qa.DEFECTS.TEXT_MISMATCH}: word match 0.5`]);
    expect(r.advisory).toEqual([qa.DEFECTS.MONOTONE, 'something new']);
  });
  test('a spoken tag drops to the plain rung; a text mismatch restates', () => {
    expect(qa.repairNote([qa.DEFECTS.TAG_SPOKEN], { directionWords: 'warm' }).rung).toBe('plain');
    const n = qa.repairNote([`${qa.DEFECTS.TEXT_MISMATCH}: x`], { directionWords: 'warm', alias: 'Sair-uh' });
    expect(n.rung).toBe('restate');
    expect(n.useAlias).toBe(true);
    expect(n.note).toMatch(/exactly as written/);
  });
});
