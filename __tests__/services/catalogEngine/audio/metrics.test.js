/**
 * Take measurements + the spoken-text comparison (ab-1 §4.4): trim bounds
 * and dead air on a synthetic take, clipping, the 16 kHz STT downsample;
 * compareSpoken's word match, missing runs, edge words, doubled words,
 * control words spoken, the name heard (exact, accented, alias), extra
 * words; level outliers; the take scorer's ordering.
 */

const wav = require('../../../../services/catalogEngine/audio/wav');
const m = require('../../../../services/catalogEngine/audio/metrics');
const { scoreTake, takeCandidateKey } = require('../../../../services/catalogEngine/audio/select');

const FS = 24000;
const tone = (seconds, amp = 0.2) => wav.sine({ hz: 440, seconds, amp, sampleRate: FS });
const silence = seconds => new Float32Array(Math.round(seconds * FS));
const concat = parts => { const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

describe('measureTake', () => {
  test('trim bounds, spoken loudness, no dead air', () => {
    const take = wav.encodeWav(concat([silence(0.4), tone(2), silence(0.3)]), FS);
    const r = m.measureTake(take);
    expect(r.seconds).toBeCloseTo(2.7, 1);
    expect(r.trim.start).toBeCloseTo(0.32, 1);
    expect(r.trim.end).toBeCloseTo(2.48, 1);
    expect(r.trimmedSeconds).toBeCloseTo(2.16, 1);
    expect(r.longestSilenceSeconds).toBe(0);
    expect(r.clipped).toBe(false);
    expect(r.lufs).toBeLessThan(-10);
    expect(r.lufs).toBeGreaterThan(-30);
  });
  test('internal dead air ≥ 2 s and clipping are reported', () => {
    const take = wav.encodeWav(concat([tone(1), silence(2.5), tone(1, 1)]), FS);
    const r = m.measureTake(take);
    expect(r.longestSilenceSeconds).toBeCloseTo(2.5, 1);
    expect(r.clipped).toBe(true);
  });
  test('toSttWav downsamples to 16 kHz', () => {
    const take = wav.encodeWav(wav.sine({ hz: 440, seconds: 1, amp: 0.2, sampleRate: 44100 }), 44100);
    const parsed = wav.parseWav(m.toSttWav(take));
    expect(parsed.sampleRate).toBe(16000);
    expect(parsed.samples.length).toBe(16000);
  });
});

describe('compareSpoken', () => {
  const text = 'Emma looked around. "Hello there!" said Farmer Bea. The cow said moo and the birds sang.';
  test('an exact read matches fully', () => {
    const c = m.compareSpoken(text, 'Emma looked around. Hello there! said Farmer Bea. The cow said moo and the birds sang.');
    expect(c.wordMatch).toBe(1);
    expect(c.missingRun).toBe(0);
    expect(c.firstWordPresent && c.lastWordPresent).toBe(true);
    expect(c.doubledWords).toEqual([]);
    expect(c.extraRatio).toBe(0);
  });
  test('a dropped sentence is a missing run; a dropped first word is an edge miss', () => {
    const c = m.compareSpoken(text, 'Emma looked around. The cow said moo and the birds sang.');
    expect(c.wordMatch).toBeLessThan(0.92);
    expect(c.missingRun).toBeGreaterThanOrEqual(3);
    const e = m.compareSpoken(text, 'looked around. Hello there! said Farmer Bea. The cow said moo and the birds sang.');
    expect(e.firstWordPresent).toBe(false);
  });
  test('a doubled word and a stage direction read aloud are caught', () => {
    const c = m.compareSpoken('The cow said moo.', 'the cow cow cow said moo whispers', { controlWords: ['whispers', 'excited'] });
    expect(c.doubledWords).toEqual(['cow']);
    expect(c.controlSpoken).toEqual(['whispers']);
  });
  test('curly quotes, accents and an STT slip on a long word still match', () => {
    const c = m.compareSpoken('José’s “wonderful” adventure begins.', 'Joses wonderfull adventure begins');
    expect(c.wordMatch).toBeGreaterThanOrEqual(0.75);
    expect(c.lastWordPresent).toBe(true);
  });
  test('the name heard: exact, close, alias, or not at all', () => {
    expect(m.compareSpoken('Noam waved.', 'Noam waved.', { name: 'Noam' }).nameHeard).toBe(true);
    expect(m.compareSpoken('Sarah waved.', 'Sair-uh waved.', { name: 'Sarah', alias: 'Sair-uh' }).nameHeard).toBe(true);
    expect(m.compareSpoken('Noam waved.', 'Gnome waved.', { name: 'Noam' }).nameHeard).toBe(false);
    expect(m.compareSpoken('Isabella waved.', 'Isabela waved.', { name: 'Isabella' }).nameHeard).toBe(true);
    expect(m.compareSpoken('Hi.', 'Hi.').nameHeard).toBeNull();
  });
  test('extra words raise extraRatio', () => {
    const c = m.compareSpoken('The end.', 'The end. And then the narrator said many more things that were not written.');
    expect(c.extraRatio).toBeGreaterThan(1);
  });
});

describe('levelOutliers + scoring', () => {
  test('outliers beyond the tolerance from the median', () => {
    const r = m.levelOutliers([{ key: 'a', lufs: -18 }, { key: 'b', lufs: -18.5 }, { key: 'c', lufs: -17.5 }, { key: 'd', lufs: -25 }]);
    expect(r.median).toBe(-18);
    expect(r.outliers.map(o => o.key)).toEqual(['d']);
  });
  test('a blocking defect sinks a take below zero; word match, duration, level and the name shade', () => {
    const clean = scoreTake({ qa: { blocking: [], advisory: [] }, compare: { wordMatch: 1, nameHeard: true, extraRatio: 0 }, durationRatio: 1, levelDeltaDb: 0 });
    expect(clean).toBe(100);
    expect(scoreTake({ qa: { blocking: ['narration text mismatch'], advisory: [] } })).toBeLessThan(0);
    expect(scoreTake({ qa: { blocking: [], advisory: ['monotone delivery'] } })).toBe(90);
    expect(scoreTake({ qa: { blocking: [], advisory: [], qaUnavailable: 'x' } })).toBe(40);
    expect(scoreTake({ qa: { blocking: [], advisory: [] }, compare: { wordMatch: 0.95 } })).toBeCloseTo(97, 0);
    expect(scoreTake({ qa: { blocking: [], advisory: [] }, durationRatio: 1.5 })).toBe(85);
    expect(scoreTake({ qa: { blocking: [], advisory: [] }, compare: { nameHeard: false } })).toBe(75);
    expect(scoreTake({ qa: { blocking: [], advisory: [] }, levelDeltaDb: 5 })).toBe(94);
  });
  test('candidate keys keep every pass apart', () => {
    expect(takeCandidateKey('a/chunk0.wav', 2)).toBe('a/chunk0.c2.wav');
    expect(takeCandidateKey('a/chunk0.wav', 1, 2)).toBe('a/chunk0.r2c1.wav');
  });
});
