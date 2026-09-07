/**
 * The loudness ruler (ab-1 §4.4/§4.8): BS.1770 integrated loudness on
 * synthetic signals (a full-scale 997 Hz sine reads −3.01 LUFS, a −20 dBFS
 * sine ≈ −23), true peak, the silence profile (leading / trailing /
 * internal runs), the 100 ms startle window, windowed loudness inside
 * speech windows, WAV encode/parse round trips (16-bit and float, stereo
 * averaging), decimation.
 */

const wav = require('../../../../services/catalogEngine/audio/wav');

const FS = 48000;
const silence = seconds => new Float32Array(Math.round(seconds * FS));
const concat = parts => {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

describe('integrated loudness (BS.1770)', () => {
  test('a full-scale 997 Hz sine reads −3.01 LUFS', () => {
    const s = wav.sine({ hz: 997, seconds: 4, amp: 1, sampleRate: FS });
    expect(wav.integratedLufs(s, FS)).toBeCloseTo(-3.01, 1);
  });
  test('a −20 dBFS 1 kHz sine reads ≈ −23 LUFS at 48 k and at 24 k', () => {
    expect(wav.integratedLufs(wav.sine({ hz: 1000, seconds: 4, amp: 0.1, sampleRate: FS }), FS)).toBeCloseTo(-23.0, 1);
    expect(wav.integratedLufs(wav.sine({ hz: 1000, seconds: 4, amp: 0.1, sampleRate: 24000 }), 24000)).toBeCloseTo(-23.0, 0);
  });
  test('the relative gate ignores a quiet tail: a tone followed by near-silence keeps the tone\'s loudness', () => {
    const tone = wav.sine({ hz: 1000, seconds: 3, amp: 0.1, sampleRate: FS });
    const withTail = concat([tone, wav.sine({ hz: 1000, seconds: 3, amp: 0.0005, sampleRate: FS })]);
    expect(wav.integratedLufs(withTail, FS)).toBeCloseTo(wav.integratedLufs(tone, FS), 0);
  });
  test('silence is −Infinity', () => {
    expect(wav.integratedLufs(silence(2), FS)).toBe(-Infinity);
  });
  test('windowed loudness measures only the blocks inside the windows', () => {
    const s = concat([silence(1), wav.sine({ hz: 1000, seconds: 2, amp: 0.1, sampleRate: FS }), silence(1)]);
    expect(wav.windowedLufs(s, FS, [{ start: 1, end: 3 }])).toBeCloseTo(-23.0, 0);
    expect(wav.windowedLufs(s, FS, [{ start: 0, end: 0.9 }])).toBe(-Infinity);
  });
});

describe('peaks and silence', () => {
  test('true peak is at least the sample peak and within 0.5 dB of it for a low-frequency sine', () => {
    const s = wav.sine({ hz: 100, seconds: 1, amp: 0.5, sampleRate: FS });
    const tp = wav.truePeakDb(s);
    expect(tp).toBeGreaterThanOrEqual(wav.levels(s).peakDb - 0.01);
    expect(tp).toBeLessThan(wav.levels(s).peakDb + 0.5);
  });
  test('silence profile finds leading, trailing and internal runs', () => {
    const s = concat([silence(0.5), wav.sine({ hz: 440, seconds: 1, amp: 0.3, sampleRate: FS }), silence(3), wav.sine({ hz: 440, seconds: 1, amp: 0.3, sampleRate: FS }), silence(0.2)]);
    const p = wav.silenceProfile(s, FS);
    expect(p.leadingSeconds).toBeCloseTo(0.5, 1);
    expect(p.trailingSeconds).toBeCloseTo(0.2, 1);
    expect(p.runs).toHaveLength(1);
    expect(p.longestRunSeconds).toBeCloseTo(3, 1);
    expect(wav.silenceProfile(s, FS, { minRunMs: 4000 }).runs).toHaveLength(0);
  });
  test('an all-silent signal reports one run covering it', () => {
    const p = wav.silenceProfile(silence(2), FS);
    expect(p.leadingSeconds).toBeCloseTo(2, 1);
    expect(p.longestRunSeconds).toBeCloseTo(2, 1);
  });
  test('the 100 ms window peak names the loudest moment', () => {
    const s = concat([silence(1), wav.sine({ hz: 440, seconds: 0.2, amp: 0.8, sampleRate: FS }), silence(1)]);
    const w = wav.windowPeak(s, FS);
    expect(w.peakDb).toBeCloseTo(20 * Math.log10(0.8), 0);
    expect(w.at).toBeCloseTo(1, 1);
  });
});

describe('WAV round trips', () => {
  test('16-bit mono encode → parse', () => {
    const s = wav.sine({ hz: 440, seconds: 0.5, amp: 0.5, sampleRate: 24000 });
    const parsed = wav.parseWav(wav.encodeWav(s, 24000));
    expect(parsed.sampleRate).toBe(24000);
    expect(parsed.channels).toBe(1);
    expect(parsed.samples.length).toBe(s.length);
    expect(Math.abs(parsed.samples[100] - s[100])).toBeLessThan(1e-3);
  });
  test('raw PCM wraps into a parseable WAV; stereo averages to mono', () => {
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(16384, 0); pcm.writeInt16LE(-16384, 2); // L,R frame 1 → 0
    pcm.writeInt16LE(8192, 4); pcm.writeInt16LE(8192, 6); // frame 2 → 0.25
    const parsed = wav.parseWav(wav.wrapPcm16(pcm, 44100, 2));
    expect(parsed.channels).toBe(2);
    expect(parsed.samples.length).toBe(2);
    expect(parsed.samples[0]).toBeCloseTo(0, 5);
    expect(parsed.samples[1]).toBeCloseTo(0.25, 3);
  });
  test('rejects non-WAV buffers', () => {
    expect(() => wav.parseWav(Buffer.from('not a wav file at all, really not'))).toThrow(/RIFF/);
  });
  test('decimation keeps the length ratio', () => {
    const s = wav.sine({ hz: 440, seconds: 1, amp: 0.5, sampleRate: FS });
    expect(wav.decimate(s, FS, 16000).length).toBe(16000);
    expect(wav.decimate(s, FS, FS)).toBe(s);
  });
});
