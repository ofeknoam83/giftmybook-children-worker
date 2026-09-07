/**
 * The mix (ab-1, docs/AUDIOBOOK_V2_PLAN.md §4.7): PURE argv builders over
 * the timeline (snapshot-tested; argv arrays, never a shell string — the
 * gv-1 rule) plus thin runners over `execFile`.
 *
 * Pass 1 (`buildMixCommand`) renders the master AND the four stems as
 * WAV from one filter graph: every take trimmed, level-matched to the
 * voice target and placed by `adelay`; every music span looped, trimmed,
 * faded, level-matched and placed, then ducked under the voice by
 * `sidechaincompress`; the ambience bed looped, filtered and faded; every
 * sound cue placed at its gain. Pass 2 (`buildMasterCommand`) applies the
 * measured master gain + a true-peak limiter and encodes the MP3 with
 * chapter-friendly metadata. Loudness is MEASURED in JS between the two
 * passes (wav.js), never trusted from a filter's own report.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SAMPLE_RATE = 48000;
const VOICE_TARGET_LUFS = -18;
const ASSUMED_ASSET_LUFS = -20;
const DUCK = Object.freeze({ threshold: 0.1, ratio: 3, attackMs: 250, releaseMs: 1200 });
const AMBIENCE_FILTER = 'highpass=f=120,lowpass=f=8000';
const LIMITER = Object.freeze({ limit: 0.891, attackMs: 5, releaseMs: 50 }); // 0.891 ≈ −1 dBTP
const LOOP_SIZE = 2147483647;

/** The ffmpeg binary: `FFMPEG_PATH` (tests point it at a static build) or the image's `ffmpeg`. */
function ffmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

const f3 = n => Number(n).toFixed(3);
const db = n => `${Number(n).toFixed(2)}dB`;
const ms = s => Math.max(0, Math.round(Number(s) * 1000));
const STEREO = `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`;

/**
 * The gain that brings a measured loudness to a target (dB), bounded.
 * @param {number|null} measuredLufs
 * @param {number} targetLufs
 * @returns {number}
 */
function gainTo(measuredLufs, targetLufs) {
  const measured = Number.isFinite(measuredLufs) ? measuredLufs : ASSUMED_ASSET_LUFS;
  return Math.max(-40, Math.min(30, targetLufs - measured));
}

/**
 * Build the pass-1 argv: master + stems as WAV.
 * @param {object} p
 * @param {object} p.timeline
 * @param {Array<{path: string, at: number, trim: {start: number, end: number}, lufs: number|null}>} p.takes every chunk take, in timeline order
 * @param {Array<{cue: string, path: string, from: number, to: number, gainDb: number, fadeIn: number, fadeOut: number, lufs?: number|null}>} p.music spans with their files
 * @param {Array<{path: string, at: number, gainDb: number, lufs?: number|null}>} p.sfx placed cues, motifs and page turns with files
 * @param {{path: string, gainDb: number, lufs?: number|null}|null} p.ambience
 * @param {{master: string, voice?: string, music?: string, ambience?: string, sfx?: string}} p.outputs file paths
 * @param {number} [p.voiceTargetLufs]
 * @param {number} [p.musicOffsetDb] extra gain applied to every music span (the ratio gate's correction)
 * @returns {{args: string[], totalSeconds: number, inputs: number}}
 */
function buildMixCommand({ timeline, takes, music = [], sfx = [], ambience = null, outputs, voiceTargetLufs = VOICE_TARGET_LUFS, musicOffsetDb = 0 }) {
  const total = timeline.totalSeconds;
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin'];
  const graph = [];
  let inputs = 0;
  const addInput = (file) => { args.push('-i', file); return inputs++; };

  // Voice
  const voiceLabels = [];
  takes.forEach((t, k) => {
    const i = addInput(t.path);
    const g = gainTo(t.lufs, voiceTargetLufs);
    graph.push(`[${i}:a]atrim=start=${f3(t.trim.start)}:end=${f3(t.trim.end)},asetpts=PTS-STARTPTS,${STEREO},volume=${db(g)},adelay=${ms(t.at)}|${ms(t.at)}[t${k}]`);
    voiceLabels.push(`[t${k}]`);
  });
  if (voiceLabels.length === 0) throw new Error('buildMixCommand: at least one take is required');
  graph.push(`${voiceLabels.join('')}amix=inputs=${voiceLabels.length}:normalize=0:duration=longest,apad=whole_dur=${f3(total)},atrim=0:${f3(total)}[voiceraw]`);
  graph.push(`[voiceraw]asplit=3[voice][sc][voiceout]`);

  // Music
  const musicLabels = [];
  music.forEach((m, k) => {
    const i = addInput(m.path);
    const dur = Math.max(0.5, m.to - m.from);
    const g = gainTo(m.lufs, voiceTargetLufs + m.gainDb + musicOffsetDb);
    const fo = Math.min(m.fadeOut, dur / 2);
    const fi = Math.min(m.fadeIn, dur / 2);
    graph.push(`[${i}:a]${STEREO},aloop=loop=-1:size=${LOOP_SIZE},atrim=0:${f3(dur)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${f3(fi)},afade=t=out:st=${f3(dur - fo)}:d=${f3(fo)},volume=${db(g)},adelay=${ms(m.from)}|${ms(m.from)}[m${k}]`);
    musicLabels.push(`[m${k}]`);
  });
  if (musicLabels.length) {
    graph.push(`${musicLabels.join('')}amix=inputs=${musicLabels.length}:normalize=0:duration=longest,apad=whole_dur=${f3(total)},atrim=0:${f3(total)}[musicraw]`);
    graph.push(`[musicraw][sc]sidechaincompress=threshold=${DUCK.threshold}:ratio=${DUCK.ratio}:attack=${DUCK.attackMs}:release=${DUCK.releaseMs}:makeup=1:level_sc=1[musicduck]`);
    graph.push(`[musicduck]asplit=2[music][musicout]`);
  } else {
    graph.push(`[sc]anullsink`);
    graph.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=0:${f3(total)}[musicraw]`);
    graph.push(`[musicraw]asplit=2[music][musicout]`);
  }

  // Ambience
  if (ambience) {
    const i = addInput(ambience.path);
    const g = gainTo(ambience.lufs, voiceTargetLufs + ambience.gainDb);
    graph.push(`[${i}:a]${STEREO},aloop=loop=-1:size=${LOOP_SIZE},atrim=0:${f3(total)},asetpts=PTS-STARTPTS,${AMBIENCE_FILTER},afade=t=in:st=0:d=2,afade=t=out:st=${f3(Math.max(0, total - 3))}:d=3,volume=${db(g)}[ambraw]`);
  } else {
    graph.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=0:${f3(total)}[ambraw]`);
  }
  graph.push(`[ambraw]asplit=2[ambience][ambout]`);

  // Sound cues
  const sfxLabels = [];
  sfx.forEach((s, k) => {
    const i = addInput(s.path);
    const g = gainTo(s.lufs, voiceTargetLufs + s.gainDb);
    graph.push(`[${i}:a]${STEREO},volume=${db(g)},adelay=${ms(s.at)}|${ms(s.at)}[s${k}]`);
    sfxLabels.push(`[s${k}]`);
  });
  if (sfxLabels.length) graph.push(`${sfxLabels.join('')}amix=inputs=${sfxLabels.length}:normalize=0:duration=longest,apad=whole_dur=${f3(total)},atrim=0:${f3(total)}[sfxraw]`);
  else graph.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=0:${f3(total)}[sfxraw]`);
  graph.push(`[sfxraw]asplit=2[sfx][sfxout]`);

  // Master
  graph.push(`[voice][music][ambience][sfx]amix=inputs=4:normalize=0:duration=first[master]`);

  args.push('-filter_complex', graph.join(';'));
  const wavOut = ['-c:a', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', '2', '-t', f3(total)];
  args.push('-map', '[master]', ...wavOut, outputs.master);
  const stems = [['voiceout', outputs.voice], ['musicout', outputs.music], ['ambout', outputs.ambience], ['sfxout', outputs.sfx]];
  for (const [label, file] of stems) {
    if (file) args.push('-map', `[${label}]`, ...wavOut, file);
    else args.push('-map', `[${label}]`, '-f', 'null', '-');
  }
  return { args, totalSeconds: total, inputs };
}

/**
 * Build the pass-2 argv: the measured gain + a true-peak limiter → MP3.
 * @param {{input: string, output: string, gainDb: number, metadata?: {title?: string, artist?: string, album?: string, comment?: string}}} p
 * @returns {string[]}
 */
function buildMasterCommand({ input, output, gainDb, metadata = {} }) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input,
    '-af', `volume=${db(gainDb)},alimiter=limit=${LIMITER.limit}:attack=${LIMITER.attackMs}:release=${LIMITER.releaseMs}:level=false`,
    '-c:a', 'libmp3lame', '-b:a', '192k', '-ar', String(SAMPLE_RATE), '-ac', '2', '-id3v2_version', '3'];
  for (const [k, v] of Object.entries(metadata)) if (typeof v === 'string' && v) args.push('-metadata', `${k}=${v.replace(/[\r\n]+/g, ' ').slice(0, 200)}`);
  args.push(output);
  return args;
}

/**
 * Build the argv that decodes any audio file to a mono 48 kHz 16-bit WAV
 * (the measurement path for MP3 assets).
 * @param {{input: string, output: string, mono?: boolean}} p
 * @returns {string[]}
 */
function buildDecodeCommand({ input, output, mono = true }) {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input, '-c:a', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', mono ? '1' : '2', output];
}

/**
 * Run ffmpeg with an argv array.
 * @param {string[]} args
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runFfmpeg(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { timeout: opts.timeoutMs || 600000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`ffmpeg failed (${err.code === 'ENOENT' ? 'binary not found' : err.killed ? 'timed out' : `exit ${err.code}`}): ${String(stderr || err.message).trim().slice(-600)}`);
        e.failureCode = 'audiobook_mix_failed';
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
  return fs.promises.mkdtemp(path.join(os.tmpdir(), `audiobook-${String(label).replace(/[^A-Za-z0-9_-]/g, '')}-`));
}

/**
 * Decode an audio buffer to a mono WAV buffer through ffmpeg (null when
 * ffmpeg is unavailable — callers fail open).
 * @param {Buffer} buffer
 * @param {string} ext file extension hint
 * @param {string} dir temp dir
 * @returns {Promise<Buffer|null>}
 */
async function decodeToWav(buffer, ext, dir) {
  const input = path.join(dir, `decode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext || 'bin'}`);
  const output = `${input}.wav`;
  await fs.promises.writeFile(input, buffer);
  try {
    await runFfmpeg(buildDecodeCommand({ input, output }), { timeoutMs: 120000 });
    return await fs.promises.readFile(output);
  } catch (err) {
    return null;
  } finally {
    await fs.promises.rm(input, { force: true }).catch(() => {});
    await fs.promises.rm(output, { force: true }).catch(() => {});
  }
}

module.exports = { SAMPLE_RATE, VOICE_TARGET_LUFS, ASSUMED_ASSET_LUFS, DUCK, LIMITER, ffmpegPath, gainTo, buildMixCommand, buildMasterCommand, buildDecodeCommand, runFfmpeg, makeTempDir, decodeToWav };
