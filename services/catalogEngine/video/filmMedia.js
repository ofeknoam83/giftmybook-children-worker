/** Measured speech determines shot lengths. No words are sped up or truncated. */
const { parseWav, encodeWav } = require('../audio/wav');
const { filmError } = require('./filmScript');

const FPS = 30;
const MAX_SHOT_SECONDS = 14;

/**
 * Divide a verified take into <=14s shots, preferring quiet boundaries.
 * Source samples are partitioned exactly once; padding occurs only at turn edges.
 * Durations are integral video frames to prevent cumulative audiovisual drift.
 */
function speechShots(buffer, trim) {
  const { sampleRate, samples } = parseWav(buffer);
  const first = Math.max(0, Math.floor((trim?.start || 0) * sampleRate));
  const last = Math.min(samples.length, Math.ceil((trim?.end ?? samples.length / sampleRate) * sampleRate));
  if (last <= first) throw filmError('The verified speech take is empty.', 'film_audio_invalid');
  const pieces = []; let at = first;
  while (at < last) {
    const head = at === first ? Math.round(0.2 * sampleRate) : 0;
    const max = Math.floor((MAX_SHOT_SECONDS - 0.6) * sampleRate) - head;
    let end = Math.min(last, at + max);
    if (end < last) {
      // Search the final second of the shot for the quietest 40ms boundary.
      const window = Math.max(1, Math.round(sampleRate * 0.04));
      let best = Infinity; let boundary = end;
      for (let pos = end - sampleRate; pos <= end - window; pos += window) {
        let power = 0;
        for (let i = pos; i < pos + window; i++) power += samples[i] ** 2;
        if (power < best) { best = power; boundary = pos + Math.floor(window / 2); }
      }
      end = boundary;
    }
    const tail = end === last ? Math.round(0.45 * sampleRate) : 0;
    const frames = Math.max(3 * FPS, Math.ceil((head + end - at + tail) * FPS / sampleRate));
    const padded = new Float32Array(Math.round(frames * sampleRate / FPS));
    padded.set(samples.subarray(at, end), head);
    pieces.push({ buffer: encodeWav(padded, sampleRate), seconds: frames / FPS, frames, sourceStart: at / sampleRate, sourceEnd: end / sampleRate, speechStart: head / sampleRate, speechEnd: (head + end - at) / sampleRate });
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

module.exports = { FPS, MAX_SHOT_SECONDS, speechShots, shotCommand, finishCommand };
