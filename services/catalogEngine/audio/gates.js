/**
 * Book-level gates (ab-1, docs/AUDIOBOOK_V2_PLAN.md §4.8) — deterministic
 * over the rendered master and stems (wav.js), corrected by re-mixing:
 *  - loudness: the master's integrated loudness vs the target, true peak
 *    ≤ −1 dBTP — the correction is a master gain for pass 2;
 *  - speech-to-music ratio: per spread, the voice stem minus the ducked
 *    music stem inside that spread's speech windows ≥ 12 LU — the
 *    correction is a music offset for a bounded re-mix;
 *  - dead air: no silence > 2.5 s on the master (a timeline bug — fails);
 *  - startle: no 100 ms window above −8 dBTP on the effects / music stems;
 *  - the listen-through: ONE Gemini audio call on the final MP3 (an
 *    excerpt when long) with closed advisory fields.
 */

const wav = require('./wav');
const { judgeAudio } = require('./geminiAudio');
const flags = require('../flags');

const RATIO_MIN_LU = 12;
const DEAD_AIR_SECONDS = 2.5;
const STARTLE_DBTP = -8;
const LOUDNESS_TOLERANCE_LU = 1;
const TRUE_PEAK_MAX = -1;
const LISTEN_MAX_SECONDS = 480;

/**
 * Measure the master.
 * @param {Buffer} masterWav
 * @param {number} targetLufs
 * @returns {{integratedLufs: number, truePeakDbtp: number, lra: number, deadAir: Array<{start: number, end: number}>, gainDb: number, pass: boolean}}
 */
function measureMaster(masterWav, targetLufs) {
  const { samples, sampleRate } = wav.parseWav(masterWav);
  const integrated = wav.integratedLufs(samples, sampleRate);
  const tp = wav.truePeakDb(samples);
  const lra = wav.loudnessRange(samples, sampleRate);
  const profile = wav.silenceProfile(samples, sampleRate, { thresholdDb: -50, minRunMs: DEAD_AIR_SECONDS * 1000 });
  const gainDb = Number.isFinite(integrated) ? Math.round((targetLufs - integrated) * 100) / 100 : 0;
  return {
    integratedLufs: Number.isFinite(integrated) ? Math.round(integrated * 100) / 100 : null,
    truePeakDbtp: Math.round(tp * 100) / 100,
    lra,
    deadAir: profile.runs,
    gainDb,
    pass: Number.isFinite(integrated) && Math.abs(integrated + gainDb - targetLufs) <= LOUDNESS_TOLERANCE_LU && profile.runs.length === 0,
  };
}

/**
 * The speech-to-music ratio inside the speech windows, per spread.
 * @param {{voiceWav: Buffer, musicWav: Buffer, timeline: object}} p
 * @returns {{pass: boolean, minLu: number|null, perSpread: Array<{spread: number|null, lu: number|null}>, adjustDb: number}}
 */
function speechMusicRatio({ voiceWav, musicWav, timeline }) {
  const v = wav.parseWav(voiceWav);
  const m = wav.parseWav(musicWav);
  const groups = new Map();
  for (const w of timeline.speechWindows) {
    const key = w.spread == null ? 'x' : w.spread;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  const perSpread = [];
  let minLu = null;
  for (const [key, windows] of groups) {
    const vl = wav.windowedLufs(v.samples, v.sampleRate, windows);
    const ml = wav.windowedLufs(m.samples, m.sampleRate, windows);
    const lu = Number.isFinite(vl) && Number.isFinite(ml) ? Math.round((vl - ml) * 10) / 10 : (Number.isFinite(vl) ? Infinity : null);
    perSpread.push({ spread: key === 'x' ? null : key, lu: lu === Infinity ? null : lu, voiceLufs: Number.isFinite(vl) ? Math.round(vl * 10) / 10 : null, musicLufs: Number.isFinite(ml) ? Math.round(ml * 10) / 10 : null });
    if (lu !== null && lu !== Infinity && (minLu === null || lu < minLu)) minLu = lu;
  }
  const pass = minLu === null || minLu >= RATIO_MIN_LU;
  return { pass, minLu, perSpread, adjustDb: pass ? 0 : -Math.min(12, Math.ceil(RATIO_MIN_LU - minLu)) };
}

/**
 * The startle ruler on the effects and music stems.
 * @param {{sfxWav?: Buffer|null, musicWav?: Buffer|null}} p
 * @returns {{pass: boolean, sfx: {peakDb: number, at: number}|null, music: {peakDb: number, at: number}|null}}
 */
function startleCheck({ sfxWav = null, musicWav = null }) {
  const peak = buf => { if (!buf) return null; const { samples, sampleRate } = wav.parseWav(buf); const p = wav.windowPeak(samples, sampleRate); return { peakDb: Math.round(p.peakDb * 100) / 100, at: Math.round(p.at * 100) / 100 }; };
  const s = peak(sfxWav);
  const m = peak(musicWav);
  return { pass: (!s || s.peakDb <= STARTLE_DBTP) && (!m || m.peakDb <= STARTLE_DBTP), sfx: s, music: m };
}

const LISTEN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intelligible: { type: 'BOOLEAN' }, music_too_loud: { type: 'BOOLEAN' }, sfx_distracting: { type: 'BOOLEAN' },
    pace: { type: 'STRING', enum: ['too_slow', 'right', 'too_fast'] }, abrupt_transitions: { type: 'BOOLEAN' }, overall: { type: 'INTEGER' }, note: { type: 'STRING' },
  },
  required: ['intelligible', 'music_too_loud', 'sfx_distracting', 'pace', 'abrupt_transitions', 'overall'],
};

/**
 * The listen-through judge — ADVISORY only.
 * @param {{mp3: Buffer, seconds: number, band: string, costTracker?: object, signal?: AbortSignal, excerpt?: Buffer|null}} p
 * @returns {Promise<{verdict: object|null, advisories: object[], unavailable: string|null}>}
 */
async function listenThrough({ mp3, seconds, band, costTracker, signal, excerpt = null }) {
  if (!flags.audioListenQaEnabled()) return { verdict: null, advisories: [], unavailable: 'listen-through disabled (CATALOG_AUDIO_LISTEN_QA=0)' };
  try {
    const audio = excerpt || mp3;
    const { json } = await judgeAudio({
      prompt: [
        `You are listening to ${excerpt ? 'an excerpt of' : ''} a finished children's audiobook (age band ${band}): a narrator over a gentle score, a soft ambience bed and occasional sound effects.`,
        'Judge with the closed fields: intelligible (every word easy to understand), music_too_loud (the music competes with the voice), sfx_distracting (an effect startles or covers words), pace, abrupt_transitions (cuts in the music or effects), overall 1-5, and one short note.',
        'Return JSON only.',
      ].join('\n'),
      audio: [{ buffer: audio, mimeType: 'audio/mpeg' }], schema: LISTEN_SCHEMA, costTracker, signal, maxOutputTokens: 512,
    });
    const verdict = { intelligible: json.intelligible === true, musicTooLoud: json.music_too_loud === true, sfxDistracting: json.sfx_distracting === true, pace: json.pace, abruptTransitions: json.abrupt_transitions === true, overall: Number(json.overall) || null, note: typeof json.note === 'string' ? json.note.slice(0, 300) : null, seconds };
    const advisories = [];
    if (!verdict.intelligible) advisories.push({ stage: 'listenQa', note: 'listen-through: the narration is not fully intelligible' });
    if (verdict.musicTooLoud) advisories.push({ stage: 'listenQa', note: 'listen-through: the music competes with the voice' });
    if (verdict.sfxDistracting) advisories.push({ stage: 'listenQa', note: 'listen-through: a sound effect distracts or startles' });
    if (verdict.pace && verdict.pace !== 'right') advisories.push({ stage: 'listenQa', note: `listen-through: the pace reads ${verdict.pace.replace('_', ' ')}` });
    if (verdict.abruptTransitions) advisories.push({ stage: 'listenQa', note: 'listen-through: abrupt transitions in the music or effects' });
    return { verdict, advisories, unavailable: null };
  } catch (err) {
    return { verdict: null, advisories: [], unavailable: `listen-through failed (${err.message})` };
  }
}

module.exports = { RATIO_MIN_LU, DEAD_AIR_SECONDS, STARTLE_DBTP, LOUDNESS_TOLERANCE_LU, TRUE_PEAK_MAX, LISTEN_MAX_SECONDS, LISTEN_SCHEMA, measureMaster, speechMusicRatio, startleCheck, listenThrough };
