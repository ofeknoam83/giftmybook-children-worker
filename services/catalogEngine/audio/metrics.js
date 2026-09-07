/**
 * Deterministic take measurements and the spoken-text comparison (ab-1,
 * docs/AUDIOBOOK_V2_PLAN.md §4.4). PURE over WAV bytes and strings:
 *  - `measureTake`: duration, the trim bounds (leading / trailing silence),
 *    internal dead air, sample / true peak, integrated loudness of the
 *    spoken part, clipping;
 *  - `compareSpoken`: the manuscript vs a transcript — word match, the
 *    longest missing run, edge words (the qa-6 rule), doubled words,
 *    direction words spoken aloud, the name heard;
 *  - `levelOutliers`: takes whose loudness sits far from the book's median.
 */

const wav = require('./wav');

const TRIM_PAD_SECONDS = 0.08;
const SILENCE_DB = -45;
const DEAD_AIR_MS = 2000;
const CLIP_DB = -0.1;

/**
 * Measure one take.
 * @param {Buffer} buffer a WAV
 * @returns {{sampleRate: number, seconds: number, trim: {start: number, end: number}, trimmedSeconds: number, leadingSeconds: number, trailingSeconds: number, longestSilenceSeconds: number, silenceRuns: Array<{start: number, end: number}>, lufs: number, peakDb: number, truePeakDb: number, rmsDb: number, clipped: boolean, samples: Float32Array}}
 */
function measureTake(buffer) {
  const { sampleRate, samples } = wav.parseWav(buffer);
  const seconds = samples.length / sampleRate;
  const profile = wav.silenceProfile(samples, sampleRate, { thresholdDb: SILENCE_DB, minRunMs: DEAD_AIR_MS });
  const start = Math.max(0, profile.leadingSeconds - TRIM_PAD_SECONDS);
  const end = Math.max(start, Math.min(seconds, seconds - profile.trailingSeconds + TRIM_PAD_SECONDS));
  const spoken = samples.subarray(Math.floor(start * sampleRate), Math.ceil(end * sampleRate));
  const lv = wav.levels(samples);
  return {
    sampleRate,
    seconds: Math.round(seconds * 1000) / 1000,
    trim: { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 },
    trimmedSeconds: Math.round((end - start) * 1000) / 1000,
    leadingSeconds: Math.round(profile.leadingSeconds * 1000) / 1000,
    trailingSeconds: Math.round(profile.trailingSeconds * 1000) / 1000,
    longestSilenceSeconds: Math.round(profile.longestRunSeconds * 1000) / 1000,
    silenceRuns: profile.runs,
    lufs: spoken.length ? Math.round(wav.integratedLufs(spoken, sampleRate) * 100) / 100 : -Infinity,
    peakDb: Math.round(lv.peakDb * 100) / 100,
    truePeakDb: Math.round(wav.truePeakDb(samples) * 100) / 100,
    rmsDb: Math.round(lv.rmsDb * 100) / 100,
    clipped: lv.peakDb >= CLIP_DB,
    samples,
  };
}

/**
 * A 16 kHz mono WAV of a take for the speech-to-text upload.
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
function toSttWav(buffer) {
  const { sampleRate, samples } = wav.parseWav(buffer);
  const target = 16000;
  return wav.encodeWav(sampleRate > target ? wav.decimate(samples, sampleRate, target) : samples, Math.min(sampleRate, target));
}

/**
 * Spoken-text tokens: NFD-stripped accents, quotes folded, lower-case,
 * letters / digits / inner apostrophes only.
 * @param {string} s
 * @returns {string[]}
 */
function spokenTokens(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″"]/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .split(' ')
    .map(w => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

/** Sørensen–Dice bigram similarity of two tokens. @param {string} a @param {string} b @returns {number} */
function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const ga = grams(a); const gb = grams(b);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) || 0);
  return (2 * inter) / ((a.length - 1) + (b.length - 1));
}

/** @param {string} a @param {string} b @returns {boolean} the same spoken word, allowing an STT slip on longer words */
function sameWord(a, b) {
  if (a === b) return true;
  if (a.length >= 5 && b.length >= 5) return dice(a, b) >= 0.8;
  return false;
}

/**
 * Compare the text a take was given with what the transcript heard.
 * @param {string} expected the text (direction tags already stripped)
 * @param {string} transcript
 * @param {{name?: string|null, alias?: string|null, controlWords?: string[]}} [opts]
 * @returns {{wordMatch: number, expectedCount: number, heardCount: number, missingRun: number, firstWordPresent: boolean, lastWordPresent: boolean, doubledWords: string[], extraRatio: number, controlSpoken: string[], nameHeard: boolean|null}}
 */
function compareSpoken(expected, transcript, opts = {}) {
  const exp = spokenTokens(expected);
  const heard = spokenTokens(transcript);
  const bag = arr => { const m = new Map(); for (const w of arr) m.set(w, (m.get(w) || 0) + 1); return m; };
  const expBag = bag(exp);
  const heardBag = bag(heard);
  const heardHas = w => heardBag.has(w) || [...heardBag.keys()].some(h => sameWord(w, h));
  let matched = 0;
  for (const [w, n] of expBag) {
    let h = heardBag.get(w) || 0;
    if (!h) for (const [hw, hn] of heardBag) if (sameWord(w, hw)) { h += hn; }
    matched += Math.min(n, h);
  }
  const wordMatch = exp.length ? matched / exp.length : 1;
  // Ordered alignment with a lookahead window — the longest run of expected words never found in order.
  let j = 0; let run = 0; let missingRun = 0;
  for (const w of exp) {
    let found = -1;
    for (let k = j; k < Math.min(heard.length, j + 8); k++) if (sameWord(w, heard[k])) { found = k; break; }
    if (found >= 0) { j = found + 1; run = 0; } else { run += 1; if (run > missingRun) missingRun = run; }
  }
  const doubledWords = [];
  for (const [w, n] of heardBag) {
    const e = expBag.get(w) || 0;
    if (e > 0 && n > e + 1) doubledWords.push(w);
  }
  let extra = 0;
  for (const [w, n] of heardBag) if (!expBag.has(w) && ![...expBag.keys()].some(e => sameWord(e, w))) extra += n;
  const controlSpoken = [];
  for (const c of opts.controlWords || []) {
    const t = spokenTokens(c).join(' ');
    if (t && heardBag.has(t) && !expBag.has(t)) controlSpoken.push(t);
  }
  let nameHeard = null;
  if (opts.name) {
    const nameTokens = spokenTokens(opts.name);
    const aliasTokens = opts.alias ? spokenTokens(opts.alias) : [];
    const present = tokens => tokens.length > 0 && tokens.every(t => heardHas(t) || [...heardBag.keys()].some(h => dice(t, h) >= 0.75 && t.length >= 4));
    nameHeard = present(nameTokens) || (aliasTokens.length > 0 && present(aliasTokens));
  }
  return {
    wordMatch: Math.round(wordMatch * 1000) / 1000,
    expectedCount: exp.length,
    heardCount: heard.length,
    missingRun,
    firstWordPresent: exp.length ? heardHas(exp[0]) : true,
    lastWordPresent: exp.length ? heardHas(exp[exp.length - 1]) : true,
    doubledWords,
    extraRatio: heard.length ? Math.round((extra / Math.max(1, exp.length)) * 1000) / 1000 : 0,
    controlSpoken,
    nameHeard,
  };
}

/**
 * Takes whose spoken loudness sits more than `toleranceDb` from the median.
 * @param {Array<{key: string, lufs: number}>} takes
 * @param {number} [toleranceDb]
 * @returns {{median: number|null, outliers: Array<{key: string, lufs: number, deltaDb: number}>}}
 */
function levelOutliers(takes, toleranceDb = 4) {
  const vals = takes.filter(t => Number.isFinite(t.lufs)).map(t => t.lufs).sort((a, b) => a - b);
  if (vals.length < 3) return { median: vals.length ? vals[Math.floor(vals.length / 2)] : null, outliers: [] };
  const median = vals[Math.floor(vals.length / 2)];
  return { median, outliers: takes.filter(t => Number.isFinite(t.lufs) && Math.abs(t.lufs - median) > toleranceDb).map(t => ({ key: t.key, lufs: t.lufs, deltaDb: Math.round((t.lufs - median) * 10) / 10 })) };
}

module.exports = { TRIM_PAD_SECONDS, SILENCE_DB, DEAD_AIR_MS, CLIP_DB, measureTake, toSttWav, spokenTokens, dice, sameWord, compareSpoken, levelOutliers };
