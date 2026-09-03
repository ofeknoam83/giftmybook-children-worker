/**
 * ffmpeg for the gift video (gv-1 — docs/GIFT_VIDEO_PLAN.md §4.6): PURE
 * argv builders (snapshot-tested; the graph never draws text) plus thin
 * runners over `child_process.execFile` (argv arrays, never a shell string).
 *
 * The stitch: every segment clip is trimmed to its planned seconds, scaled
 * onto the frame with a blur-fill behind it (a non-16:9 clip is letterboxed
 * over a blurred, darkened copy of itself — never black bars), normalized
 * to one fps/format/timebase, crossfaded with `xfade`, faded in from and
 * out to white, given a silent (or licensed music) AAC track, and encoded
 * H.264 High yuv420p `+faststart` at exactly the plan's total seconds.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = { width: 1920, height: 1080, fps: 30, fadeSeconds: 0.5, xfadeSeconds: 0.4 };

/** The ffmpeg binary: `FFMPEG_PATH` (tests point it at a static build) or the image's `ffmpeg`. */
function ffmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

/**
 * Build the stitch argv.
 * @param {object} p
 * @param {Array<{path: string, seconds: number}>} p.segments clip files in film order
 * @param {string} p.output output mp4 path
 * @param {number} [p.width]
 * @param {number} [p.height]
 * @param {number} [p.fps]
 * @param {number} [p.fadeSeconds]
 * @param {number} [p.xfadeSeconds]
 * @param {string|null} [p.musicPath] licensed music bed (null → silent track)
 * @returns {{args: string[], totalSeconds: number}}
 */
function buildStitchCommand(p) {
  const width = p.width || DEFAULTS.width;
  const height = p.height || DEFAULTS.height;
  const fps = p.fps || DEFAULTS.fps;
  const fade = Number.isFinite(p.fadeSeconds) ? p.fadeSeconds : DEFAULTS.fadeSeconds;
  const xfade = Number.isFinite(p.xfadeSeconds) ? p.xfadeSeconds : DEFAULTS.xfadeSeconds;
  const segments = Array.isArray(p.segments) ? p.segments : [];
  if (segments.length === 0) throw new Error('buildStitchCommand: at least one segment is required');
  const total = Math.round((segments.reduce((a, s) => a + s.seconds, 0) - xfade * (segments.length - 1)) * 1000) / 1000;
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin'];
  const f = [];
  segments.forEach((s, i) => {
    args.push('-t', s.seconds.toFixed(3), '-i', s.path);
    f.push(`[${i}:v]setpts=PTS-STARTPTS,fps=${fps},split=2[a${i}][b${i}]`);
    f.push(`[a${i}]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=40,eq=brightness=-0.08[bg${i}]`);
    f.push(`[b${i}]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg${i}]`);
    f.push(`[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p,settb=AVTB[seg${i}]`);
  });
  let last = 'seg0';
  let offset = 0;
  for (let i = 1; i < segments.length; i++) {
    offset += segments[i - 1].seconds - xfade;
    f.push(`[${last}][seg${i}]xfade=transition=fade:duration=${xfade}:offset=${offset.toFixed(3)}[x${i}]`);
    last = `x${i}`;
  }
  f.push(`[${last}]fade=t=in:st=0:d=${fade}:color=white,fade=t=out:st=${(total - fade).toFixed(3)}:d=${fade}:color=white,format=yuv420p[v]`);
  const audioIndex = segments.length;
  if (p.musicPath) {
    args.push('-i', p.musicPath);
    f.push(`[${audioIndex}:a]afade=t=in:st=0:d=1,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(3)}:d=1.5,volume=0.8[a]`);
  } else {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  }
  args.push('-filter_complex', f.join(';'), '-map', '[v]', '-map', p.musicPath ? '[a]' : `${audioIndex}:a`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-t', total.toFixed(3), p.output);
  return { args, totalSeconds: total };
}

/**
 * Argv to extract ONE frame at a timestamp as PNG.
 * @param {{input: string, timeSeconds: number, output: string}} p
 * @returns {string[]}
 */
function buildFrameCommand(p) {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', Math.max(0, p.timeSeconds).toFixed(3), '-i', p.input, '-frames:v', '1', '-f', 'image2', '-vcodec', 'png', p.output];
}

/**
 * Argv to extract the poster JPEG.
 * @param {{input: string, timeSeconds: number, output: string}} p
 * @returns {string[]}
 */
function buildPosterCommand(p) {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', Math.max(0, p.timeSeconds).toFixed(3), '-i', p.input, '-frames:v', '1', '-q:v', '2', p.output];
}

/**
 * Run ffmpeg with an argv array.
 * @param {string[]} args
 * @param {{timeoutMs?: number, cwd?: string}} [opts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runFfmpeg(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { timeout: opts.timeoutMs || 600000, cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`ffmpeg failed (${err.code === 'ENOENT' ? 'binary not found' : err.killed ? 'timed out' : `exit ${err.code}`}): ${String(stderr || err.message).trim().slice(-600)}`);
        e.failureCode = 'video_encode_failed';
        return reject(e);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * A fresh per-run temp directory.
 * @param {string} label
 * @returns {Promise<string>}
 */
async function makeTempDir(label) {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), `gift-video-${String(label).replace(/[^A-Za-z0-9_-]/g, '')}-`));
}

/**
 * Extract PNG frames at the given timestamps.
 * @param {string} input clip path
 * @param {number[]} times seconds
 * @param {{dir: string}} opts temp dir to write into
 * @returns {Promise<Array<{t: number, buffer: Buffer}>>}
 */
async function extractFrames(input, times, opts) {
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const file = path.join(opts.dir, `frame-${i}.png`);
    await runFfmpeg(buildFrameCommand({ input, timeSeconds: times[i], output: file }), { timeoutMs: 60000 });
    out.push({ t: times[i], buffer: await fs.promises.readFile(file) });
  }
  return out;
}

/**
 * Parse `ffmpeg -i` stderr for duration/size/fps (no ffprobe dependency).
 * @param {string} stderr
 * @returns {{durationSeconds: number|null, width: number|null, height: number|null, fps: number|null}}
 */
function parseProbe(stderr) {
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const size = /Video:.*?\s(\d{2,5})x(\d{2,5})[\s,]/.exec(stderr);
  const fps = /(\d+(?:\.\d+)?)\s*fps/.exec(stderr);
  return {
    durationSeconds: dur ? Math.round((Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) * 1000) / 1000 : null,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    fps: fps ? Number(fps[1]) : null,
  };
}

/**
 * Probe a media file (duration, size, fps) via `ffmpeg -i`.
 * @param {string} input
 * @returns {Promise<{durationSeconds: number|null, width: number|null, height: number|null, fps: number|null}>}
 */
function probeVideo(input) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), ['-hide_banner', '-nostdin', '-i', input], { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      // ffmpeg exits 1 with "At least one output file must be specified" — the
      // stream info we want is on stderr either way.
      const text = String(stderr || '');
      if (!/Duration:/.test(text)) {
        const e = new Error(`ffmpeg could not probe ${path.basename(input)}: ${(err && err.code === 'ENOENT') ? 'binary not found' : text.trim().slice(-300)}`);
        e.failureCode = 'video_encode_failed';
        return reject(e);
      }
      resolve(parseProbe(text));
    });
  });
}

module.exports = { DEFAULTS, ffmpegPath, buildStitchCommand, buildFrameCommand, buildPosterCommand, runFfmpeg, makeTempDir, extractFrames, probeVideo, parseProbe };
