/**
 * WAV / PCM helpers and the loudness ruler (ab-1, docs/AUDIOBOOK_V2_PLAN.md
 * §4.4, §4.7, §4.8) — PURE, dependency-free DSP over Float32 samples so
 * every measurement the engine gates on (integrated loudness, true peak,
 * silence, RMS) is deterministic, unit-testable on synthetic signals, and
 * identical between the per-take check and the book-level gates.
 *
 * Loudness follows ITU-R BS.1770-4: K-weighting (a high-shelf + a high-pass
 * biquad, coefficients designed for the file's own sample rate), 400 ms
 * blocks at a 100 ms hop, the −70 LUFS absolute gate and the −10 LU
 * relative gate. A 997 Hz sine at full scale reads −3.01 LUFS. True peak
 * is 4× oversampled (cubic interpolation — a conservative estimate; the
 * mix keeps a 1 dB margin under −1 dBTP for it).
 */

const MIN_LUFS = -70;

/**
 * Wrap raw little-endian 16-bit PCM in a canonical WAV header.
 * @param {Buffer} pcm interleaved int16 samples
 * @param {number} sampleRate
 * @param {number} [channels]
 * @returns {Buffer}
 */
function wrapPcm16(pcm, sampleRate, channels = 1) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Encode Float32 mono samples (−1..1) as a 16-bit WAV.
 * @param {Float32Array|number[]} samples
 * @param {number} sampleRate
 * @returns {Buffer}
 */
function encodeWav(samples, sampleRate) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    pcm.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), i * 2);
  }
  return wrapPcm16(pcm, sampleRate, 1);
}

/**
 * Parse a PCM WAV (8/16/24/32-bit int or 32-bit float, any channel count)
 * into mono Float32 samples (channels averaged). Throws on a non-WAV or a
 * compressed WAV.
 * @param {Buffer} buf
 * @returns {{sampleRate: number, channels: number, samples: Float32Array, bitsPerSample: number}}
 */
function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE buffer');
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      const audioFormat = buf.readUInt16LE(start);
      fmt = {
        audioFormat: audioFormat === 0xFFFE ? buf.readUInt16LE(start + 24) : audioFormat,
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        bitsPerSample: buf.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      data = { start, end: Math.min(buf.length, start + size) };
    }
    offset = start + size + (size % 2);
    if (fmt && data) break;
  }
  if (!fmt || !data) throw new Error('WAV has no fmt/data chunk');
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 3) throw new Error(`unsupported WAV format ${fmt.audioFormat} (PCM only)`);
  const bytes = fmt.bitsPerSample / 8;
  const frames = Math.floor((data.end - data.start) / (bytes * fmt.channels));
  const samples = new Float32Array(frames);
  if (fmt.audioFormat === 1 && bytes === 2) {
    // The common case (every provider's PCM): a typed-array view, not a
    // per-sample readInt16LE — an order of magnitude faster on a book.
    const aligned = (buf.byteOffset + data.start) % 2 === 0 ? buf : Buffer.from(buf.subarray(data.start, data.start + frames * fmt.channels * 2));
    const start = aligned === buf ? buf.byteOffset + data.start : aligned.byteOffset;
    const view = new Int16Array(aligned.buffer, start, frames * fmt.channels);
    const ch = fmt.channels;
    if (ch === 1) {
      for (let f = 0; f < frames; f++) samples[f] = view[f] / 32768;
    } else {
      for (let f = 0; f < frames; f++) {
        let sum = 0;
        for (let c = 0; c < ch; c++) sum += view[f * ch + c];
        samples[f] = sum / (32768 * ch);
      }
    }
    return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples, bitsPerSample: fmt.bitsPerSample };
  }
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const p = data.start + (f * fmt.channels + c) * bytes;
      let v;
      if (fmt.audioFormat === 3) v = buf.readFloatLE(p);
      else if (bytes === 2) v = buf.readInt16LE(p) / 32768;
      else if (bytes === 3) v = ((buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)) << 8 >> 8) / 8388608;
      else if (bytes === 4) v = buf.readInt32LE(p) / 2147483648;
      else v = (buf[p] - 128) / 128;
      sum += v;
    }
    samples[f] = sum / fmt.channels;
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples, bitsPerSample: fmt.bitsPerSample };
}

/** @param {number} v @returns {number} */
const db = v => (v > 0 ? 20 * Math.log10(v) : -Infinity);

/**
 * Sample peak (dBFS) and RMS (dBFS) of a signal.
 * @param {Float32Array} samples
 * @returns {{peakDb: number, rmsDb: number}}
 */
function levels(samples) {
  let peak = 0;
  let sq = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    sq += samples[i] * samples[i];
  }
  return { peakDb: db(peak), rmsDb: samples.length ? 10 * Math.log10(sq / samples.length || 1e-20) : -Infinity };
}

/**
 * Cubic (Catmull-Rom) 4× oversampled true peak in dBTP.
 * @param {Float32Array} s
 * @returns {number}
 */
function truePeakDb(s) {
  let peak = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const p0 = s[Math.max(0, i - 1)];
    const p1 = s[i];
    const p2 = s[Math.min(n - 1, i + 1)];
    const p3 = s[Math.min(n - 1, i + 2)];
    const a1 = Math.abs(p1);
    if (a1 > peak) peak = a1;
    for (let k = 1; k < 4; k++) {
      const t = k / 4;
      const v = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
  }
  return db(peak);
}

/**
 * BS.1770 K-weighting biquads designed for a sample rate (the pyloudnorm /
 * libebur128 design equations).
 * @param {number} fs
 * @returns {{shelf: number[], hp: number[]}} [b0,b1,b2,a1,a2] each
 */
function kWeighting(fs) {
  const design = (f0, G, Q, shelf) => {
    const K = Math.tan((Math.PI * f0) / fs);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    if (shelf) {
      return [
        (Vh + (Vb * K) / Q + K * K) / a0,
        (2 * (K * K - Vh)) / a0,
        (Vh - (Vb * K) / Q + K * K) / a0,
        (2 * (K * K - 1)) / a0,
        (1 - K / Q + K * K) / a0,
      ];
    }
    return [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  };
  return {
    shelf: design(1681.974450955533, 3.999843853973347, 0.7071752369554196, true),
    hp: design(38.13547087602444, 0, 0.5003270373238773, false),
  };
}

/**
 * Apply one biquad (direct form I) in place-copy.
 * @param {Float32Array} x
 * @param {number[]} c [b0,b1,b2,a1,a2]
 * @returns {Float32Array}
 */
function biquad(x, c) {
  const [b0, b1, b2, a1, a2] = c;
  const y = new Float32Array(x.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

/**
 * Block loudness values (LKFS per 400 ms block, 100 ms hop) of a mono
 * signal — the building block of every loudness figure below.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {{blockMs?: number, hopMs?: number}} [opts]
 * @returns {{blocks: Array<{start: number, lkfs: number}>}}
 */
function blockLoudness(samples, sampleRate, opts = {}) {
  const blockMs = opts.blockMs || 400;
  const hopMs = opts.hopMs || 100;
  const w = kWeighting(sampleRate);
  const k = biquad(biquad(samples, w.shelf), w.hp);
  const block = Math.max(1, Math.round((sampleRate * blockMs) / 1000));
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const blocks = [];
  if (k.length < block) {
    let sq = 0;
    for (let i = 0; i < k.length; i++) sq += k[i] * k[i];
    const ms = k.length ? sq / k.length : 0;
    blocks.push({ start: 0, lkfs: -0.691 + 10 * Math.log10(ms || 1e-20) });
    return { blocks };
  }
  // Sliding window over the squared signal with a running sum.
  let sq = 0;
  for (let i = 0; i < block; i++) sq += k[i] * k[i];
  for (let start = 0; start + block <= k.length; start += hop) {
    if (start > 0) {
      for (let i = start - hop; i < start; i++) sq -= k[i] * k[i];
      for (let i = start + block - hop; i < start + block; i++) sq += k[i] * k[i];
      if (sq < 0) sq = 0;
    }
    blocks.push({ start: start / sampleRate, lkfs: -0.691 + 10 * Math.log10(sq / block || 1e-20) });
  }
  return { blocks };
}

/**
 * Integrated loudness (LUFS) with the BS.1770 gates over given blocks.
 * @param {Array<{lkfs: number}>} blocks
 * @returns {number} LUFS, or -Infinity for silence
 */
function integrateBlocks(blocks) {
  const powers = blocks.filter(b => b.lkfs > MIN_LUFS).map(b => Math.pow(10, (b.lkfs + 0.691) / 10));
  if (!powers.length) return -Infinity;
  const mean = powers.reduce((a, b) => a + b, 0) / powers.length;
  const relGate = -0.691 + 10 * Math.log10(mean) - 10;
  const kept = blocks.filter(b => b.lkfs > MIN_LUFS && b.lkfs > relGate).map(b => Math.pow(10, (b.lkfs + 0.691) / 10));
  if (!kept.length) return -Infinity;
  return -0.691 + 10 * Math.log10(kept.reduce((a, b) => a + b, 0) / kept.length);
}

/**
 * Integrated loudness of a mono signal.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {number} LUFS
 */
function integratedLufs(samples, sampleRate) {
  return integrateBlocks(blockLoudness(samples, sampleRate).blocks);
}

/**
 * Integrated loudness of a signal inside a set of time windows (the
 * speech windows of a stem) — blocks whose start falls inside any window.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {Array<{start: number, end: number}>} windows seconds
 * @returns {number} LUFS
 */
function windowedLufs(samples, sampleRate, windows) {
  const { blocks } = blockLoudness(samples, sampleRate);
  const inside = blocks.filter(b => windows.some(w => b.start >= w.start && b.start + 0.4 <= w.end));
  return integrateBlocks(inside);
}

/**
 * Loudness range (LU, EBU R128 short-term 3 s blocks, 10th–95th percentile).
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {number}
 */
function loudnessRange(samples, sampleRate) {
  const { blocks } = blockLoudness(samples, sampleRate, { blockMs: 3000, hopMs: 1000 });
  const vals = blocks.map(b => b.lkfs).filter(v => v > MIN_LUFS);
  if (vals.length < 2) return 0;
  const powers = vals.map(v => Math.pow(10, (v + 0.691) / 10));
  const rel = -0.691 + 10 * Math.log10(powers.reduce((a, b) => a + b, 0) / powers.length) - 20;
  const gated = vals.filter(v => v > rel).sort((a, b) => a - b);
  if (gated.length < 2) return 0;
  const q = p => gated[Math.min(gated.length - 1, Math.max(0, Math.floor(p * (gated.length - 1))))];
  return Math.round((q(0.95) - q(0.1)) * 10) / 10;
}

/**
 * Silence analysis: leading / trailing silence and every internal silent
 * run longer than `minRunMs`, on a 20 ms RMS envelope.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {{thresholdDb?: number, minRunMs?: number}} [opts]
 * @returns {{leadingSeconds: number, trailingSeconds: number, runs: Array<{start: number, end: number}>, longestRunSeconds: number}}
 */
function silenceProfile(samples, sampleRate, opts = {}) {
  const thresholdDb = opts.thresholdDb ?? -45;
  const minRunMs = opts.minRunMs ?? 2000;
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  const frames = Math.ceil(samples.length / frame);
  const loud = new Array(frames);
  for (let f = 0; f < frames; f++) {
    let sq = 0;
    const s = f * frame;
    const e = Math.min(samples.length, s + frame);
    for (let i = s; i < e; i++) sq += samples[i] * samples[i];
    loud[f] = 10 * Math.log10(sq / Math.max(1, e - s) || 1e-20) > thresholdDb;
  }
  let first = loud.indexOf(true);
  let last = loud.lastIndexOf(true);
  if (first === -1) {
    const total = samples.length / sampleRate;
    return { leadingSeconds: total, trailingSeconds: 0, runs: [{ start: 0, end: total }], longestRunSeconds: total };
  }
  const runs = [];
  let runStart = null;
  for (let f = first; f <= last; f++) {
    if (!loud[f] && runStart === null) runStart = f;
    if (loud[f] && runStart !== null) {
      const len = (f - runStart) * frame / sampleRate;
      if (len * 1000 >= minRunMs) runs.push({ start: runStart * frame / sampleRate, end: f * frame / sampleRate });
      runStart = null;
    }
  }
  return {
    leadingSeconds: first * frame / sampleRate,
    trailingSeconds: (frames - 1 - last) * frame / sampleRate,
    runs,
    longestRunSeconds: runs.reduce((m, r) => Math.max(m, r.end - r.start), 0),
  };
}

/**
 * Highest 100 ms-window peak (dBFS) of a signal — the startle ruler.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {{peakDb: number, at: number}}
 */
function windowPeak(samples, sampleRate) {
  const win = Math.max(1, Math.round(sampleRate * 0.1));
  let best = 0;
  let at = 0;
  for (let s = 0; s < samples.length; s += win) {
    let p = 0;
    const e = Math.min(samples.length, s + win);
    for (let i = s; i < e; i++) { const a = Math.abs(samples[i]); if (a > p) p = a; }
    if (p > best) { best = p; at = s / sampleRate; }
  }
  return { peakDb: db(best), at };
}

/**
 * Decimate to a lower rate with box averaging (for the speech-to-text
 * upload: a 16 kHz mono WAV is one eighth of a 44.1 kHz take).
 * @param {Float32Array} samples
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
function decimate(samples, fromRate, toRate) {
  if (toRate >= fromRate) return samples;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const s = Math.floor(i * ratio);
    const e = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = s; j < e; j++) sum += samples[j];
    out[i] = e > s ? sum / (e - s) : 0;
  }
  return out;
}

/**
 * A test/fixture signal: a sine of `seconds` at `hz` with amplitude `amp`.
 * @param {{hz: number, seconds: number, amp: number, sampleRate: number}} p
 * @returns {Float32Array}
 */
function sine({ hz, seconds, amp, sampleRate }) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

module.exports = {
  wrapPcm16, encodeWav, parseWav, levels, truePeakDb, kWeighting, biquad, blockLoudness, integrateBlocks,
  integratedLufs, windowedLufs, loudnessRange, silenceProfile, windowPeak, decimate, sine, MIN_LUFS,
};
