/** Measured speech determines shot lengths. No words are sped up or truncated. */
const { parseWav, encodeWav } = require('../audio/wav');
const { filmError } = require('./filmScript');

const FPS = 30;
/** Kling's longest clip — a take longer than this is split into balanced shots. */
const MAX_SHOT_SECONDS = 15;
/** Kling's shortest clip — a one-word line still buys three seconds. */
const MIN_SHOT_SECONDS = 3;
const HEAD_SECONDS = 0.2;
const TAIL_SECONDS = 0.45;
const BOUNDARY_WINDOW_SECONDS = 0.75;
const QUIET_WINDOW_SECONDS = 0.04;

/**
 * The quietest 40 ms boundary inside [lo, hi] (sample offsets), so a split
 * lands in a pause rather than mid-word.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function quietestBoundary(samples, sampleRate, lo, hi) {
  const window = Math.max(1, Math.round(sampleRate * QUIET_WINDOW_SECONDS));
  let best = Infinity; let boundary = hi;
  for (let pos = lo; pos <= hi - window; pos += window) {
    let power = 0;
    for (let i = pos; i < pos + window; i++) power += samples[i] ** 2;
    if (power < best) { best = power; boundary = pos + Math.floor(window / 2); }
  }
  return Math.min(hi, Math.max(lo, boundary));
}

/**
 * Divide a verified take into whole-second shots of 3–15 s, balanced so
 * the vendor's per-second bill is spent on speech rather than on padding
 * (gfs-2): a take that needs N shots gets N shots of about equal length,
 * never 14 s + a 3 s stub, and every shot is as long as the whole second
 * Kling bills for it — the pause at its end is film time the purchase
 * already paid for, and the sound cues live there. Boundaries prefer
 * quiet windows near the even split. Source samples are partitioned
 * exactly once; the head/tail pads sit only at the turn's edges. Durations
 * are integral video frames to prevent cumulative audiovisual drift.
 * @param {Buffer} buffer the take WAV
 * @param {{start?: number, end?: number}} [trim] the measured speech window (seconds)
 * @returns {Array<{buffer: Buffer, seconds: number, frames: number, sourceStart: number, sourceEnd: number, speechStart: number, speechEnd: number}>}
 */
function speechShots(buffer, trim) {
  const { sampleRate, samples } = parseWav(buffer);
  const first = Math.max(0, Math.floor((trim?.start || 0) * sampleRate));
  const last = Math.min(samples.length, Math.ceil((trim?.end ?? samples.length / sampleRate) * sampleRate));
  if (last <= first) throw filmError('The verified speech take is empty.', 'film_audio_invalid');
  const head = Math.round(HEAD_SECONDS * sampleRate);
  const tail = Math.round(TAIL_SECONDS * sampleRate);
  const maxSamples = MAX_SHOT_SECONDS * sampleRate;
  const count = Math.max(1, Math.ceil((head + (last - first) + tail) / maxSamples));
  const window = Math.round(BOUNDARY_WINDOW_SECONDS * sampleRate);
  const pieces = []; let at = first;
  for (let k = 0; k < count; k++) {
    const isFirst = k === 0; const isLast = k === count - 1;
    let end = last;
    if (!isLast) {
      // An even share of the remaining speech, searched for a pause within
      // ±0.75 s — bounded so this shot fits its 15 s and the rest still fit theirs.
      const target = at + Math.round((last - at) / (count - k));
      const maxEnd = at + maxSamples - (isFirst ? head : 0);
      const minEnd = last - ((count - k - 1) * maxSamples - tail);
      const lo = Math.max(at + 1, minEnd, target - window);
      const hi = Math.min(last - 1, maxEnd, target + window);
      end = hi <= lo ? Math.min(maxEnd, Math.max(minEnd, target)) : quietestBoundary(samples, sampleRate, lo, hi);
    }
    const headK = isFirst ? head : 0; const tailK = isLast ? tail : 0;
    const seconds = Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, Math.ceil((headK + (end - at) + tailK) / sampleRate)));
    const frames = seconds * FPS;
    const padded = new Float32Array(Math.round(frames * sampleRate / FPS));
    padded.set(samples.subarray(at, end), headK);
    pieces.push({ buffer: encodeWav(padded, sampleRate), seconds, frames, sourceStart: at / sampleRate, sourceEnd: end / sampleRate, speechStart: headK / sampleRate, speechEnd: (headK + end - at) / sampleRate });
    at = end;
  }
  return pieces;
}

/** Mux the exact soundtrack into a normalized shot; vendor audio is discarded. */
function shotCommand({ video, audio, output, seconds, width, height }) {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', video, '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}`,
    '-af', 'aresample=48000', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-t', seconds.toFixed(6), output];
}

/**
 * Assemble uniform shots without overlap (overlap would eat dialogue).
 * PCM intermediates prevent an AAC encoder delay at every cut. Score is already
 * ducked and limited in the separate soundtrack master.
 */
function finishCommand({ list, soundtrack, output, seconds }) {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'concat', '-safe', '1', '-i', list, '-i', soundtrack,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-t', seconds.toFixed(6), output];
}

module.exports = { FPS, MAX_SHOT_SECONDS, MIN_SHOT_SECONDS, HEAD_SECONDS, TAIL_SECONDS, speechShots, shotCommand, finishCommand };
