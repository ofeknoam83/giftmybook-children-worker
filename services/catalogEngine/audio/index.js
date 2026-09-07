/**
 * The audiobook (ab-1 — docs/AUDIOBOOK_V2_PLAN.md): a performed read-aloud
 * of one finished V1.3 story with a per-theme score and sound design.
 *
 * Order of work: provider + cast → emotion plan → the audio script (table,
 * then the optional director) → pronunciations → the whole-book replay
 * check → takes per segment (candidates → verify → select → repair;
 * replay from markers) concurrently with the asset election (music suite,
 * sound cues) → the timeline → the mix (pass 1: master + stems as WAV) →
 * the gates (loudness, speech-to-music ratio with a bounded re-mix, dead
 * air, startle) → pass 2 (gain + limiter → MP3) → the listen-through →
 * ship policy (`audiobook_unresolved` fails closed with the scored
 * candidates; `CATALOG_AUDIO_SHIP_ON_EXHAUSTION=1` opts in) → upload →
 * manifest. Every model call heartbeats through `touch`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pLimit = require('p-limit');
const { uploadBuffer, downloadBuffer, getSignedUrl, objectExists, loadJson, saveJson } = require('../../gcsStorage');
const { AUDIO_VERSION, AUDIO_QA_VERSION } = require('../versions');
const { storyFingerprint } = require('../illustrator');
const { getEmotionPlan, buildEmotionPlan } = require('../illustrator/emotionPlan');
const flags = require('../flags');
const { resolveNarratorProvider, providerCredentials } = require('./providers');
const { resolveCast } = require('./cast');
const { buildAudioScript } = require('./script');
const { runDirector } = require('./director');
const { ensurePronunciation } = require('./pronounce');
const { renderSegment, chunkLines, takeHash } = require('./narrate');
const { getMusicSuite } = require('./music/suites');
const { MOTIF_CUE } = require('./music/plan');
const { getSoundCues } = require('./sfx/library');
const { assetBytes, bytesHash } = require('./assets');
const { buildTimeline, validateTimeline } = require('./timeline');
const mix = require('./mix');
const gates = require('./gates');
const { fnv1a } = require('../selection');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HEARTBEAT_MS = 30000;
const MAX_TUNING_BYTES = 1500;
const MAX_RATIO_REMIXES = 2;
const MIX_RULES_HASH = 'mix-1';

class AudiobookError extends Error {
  /**
   * @param {string} message
   * @param {string} failureCode
   * @param {object} [details] callback fields to carry on failure
   */
  constructor(message, failureCode, details) {
    super(message);
    this.name = 'AudiobookError';
    this.failureCode = failureCode || null;
    this.details = details || null;
  }
}

/** @param {string} key @returns {Promise<string|null>} */
async function sign(key) {
  if (!key) return null;
  try { return await getSignedUrl(key, SIGNED_URL_TTL_MS); } catch (err) { return null; }
}

/**
 * Validate an `audioTuning` overlay (`{versionLabel, hash, text}`).
 * @param {*} raw
 * @returns {{label: string, hash: string, text: string, tag: string}|null}
 */
function normalizeAudioTuning(raw) {
  if (!raw || typeof raw !== 'object' || !flags.audioTuningLayerEnabled()) return null;
  const text = typeof raw.text === 'string' ? raw.text.replace(/[\u0000-\u001F\u007F]/g, '').trim() : '';
  if (!text) return null;
  if (Buffer.byteLength(text, 'utf8') > MAX_TUNING_BYTES) throw Object.assign(new Error(`audioTuning.text exceeds ${MAX_TUNING_BYTES} bytes`), { statusCode: 400 });
  const label = typeof raw.versionLabel === 'string' && raw.versionLabel.trim() ? raw.versionLabel.trim().slice(0, 40) : 'tuning';
  const hash = typeof raw.hash === 'string' && /^[0-9a-f]{8,64}$/i.test(raw.hash) ? raw.hash.slice(0, 8).toLowerCase() : crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
  return { label, hash, text, tag: `${label}.${hash}` };
}

/**
 * The base key of one mix.
 * @param {string} bookId
 * @param {string} mixHash
 * @returns {string}
 */
function mixBase(bookId, mixHash) {
  return `children-jobs/${bookId}/audiobook/${AUDIO_VERSION}/${mixHash}`;
}

/**
 * Every take hash of a script (pure — computable before any render).
 * @param {object} script
 * @param {object} cast
 * @param {string} provider
 * @param {string} language
 * @param {Object<string, {status: string, alias: string|null}>} pronunciations
 * @param {string} tuningHash
 * @returns {string[]}
 */
function allTakeHashes(script, cast, provider, language, pronunciations, tuningHash) {
  const out = [];
  for (const seg of script.segments) {
    for (const chunk of chunkLines(seg)) {
      const voice = chunk.speaker === 'companion' && cast.companion ? cast.companion : cast.narrator;
      const alias = Object.values(pronunciations).find(p => p && p.status === 'alias');
      out.push(takeHash({ chunk, voice, provider, language, aliasHash: alias ? fnv1a(alias.alias).toString(36) : 'none', tuningHash }));
    }
  }
  return out;
}

/**
 * Generate the audiobook for one finished picture book.
 * @param {object} p
 * @param {string} p.bookId
 * @param {object} p.story the validated writer response
 * @param {{book: object, theme: object, ageBand: string}} p.bookDef from getBookForTag
 * @param {object} p.profile normalized profile
 * @param {'en'|'es'|'he'} [p.language]
 * @param {{narrator?: string, companion?: string}} [p.cast]
 * @param {{text: string, from?: string}|null} [p.dedication]
 * @param {object|null} [p.audioTuning]
 * @param {number[]} [p.segments] spread subset (takes only, no mix)
 * @param {number[]} [p.forceRetake] spreads whose takes render fresh
 * @param {boolean} [p.forceNew]
 * @param {object} [p.injectedKeys] request body fields carrying provider keys
 * @param {object} p.costTracker
 * @param {(fraction: number, message: string) => void} [p.onProgress]
 * @param {() => void} [p.touch]
 * @param {AbortSignal} [p.abortSignal]
 * @param {(level: string, msg: string) => void} [p.log]
 * @returns {Promise<object>} the callback fields
 */
async function generateAudiobook(p) {
  const log = p.log || ((l, m) => console.log(`[audiobook:${p.bookId}] ${m}`));
  const onProgress = p.onProgress || (() => {});
  const touch = p.touch || (() => {});
  const { bookId, story, bookDef, profile, costTracker } = p;
  const { book, theme, ageBand } = bookDef;
  const language = ['en', 'es', 'he'].includes(p.language) ? p.language : 'en';
  const advisories = [];
  const warnings = [];
  const checkAbort = () => { if (p.abortSignal && p.abortSignal.aborted) throw new AudiobookError('audiobook generation cancelled', 'cancelled'); };
  const heartbeat = (fraction, message) => setInterval(() => { touch(); onProgress(fraction, message); }, HEARTBEAT_MS);

  // ── Provider, cast, tuning ─────────────────────────────────────────────
  const resolved = resolveNarratorProvider();
  if (!resolved.ok) throw new AudiobookError(resolved.error, 'audiobook_provider_unavailable');
  const { provider, adapter } = resolved;
  const credentials = providerCredentials(provider, p.injectedKeys || {});
  const fingerprint = storyFingerprint(story);
  let cast;
  try {
    cast = resolveCast({ provider, theme, ageBand, seedBasis: fingerprint, request: p.cast || {}, characterVoices: flags.audioCharacterVoicesEnabled() });
  } catch (err) {
    throw new AudiobookError(err.message, 'audiobook_bad_cast');
  }
  const tuning = normalizeAudioTuning(p.audioTuning);
  const tuningHash = tuning ? tuning.hash : 'none';

  // ── Emotion plan + script (+ director) ─────────────────────────────────
  onProgress(0.03, 'Planning the performance...');
  let emotionPlan;
  try { emotionPlan = await getEmotionPlan({ book, story, ageBand, costTracker, log }); } catch (err) { emotionPlan = buildEmotionPlan({ book, story, ageBand }); }
  const options = { music: flags.audioMusicEnabled(), sfx: flags.audioSfxEnabled(), ambience: flags.audioAmbienceEnabled(), pageTurn: flags.audioPageTurnEnabled(), characterVoices: flags.audioCharacterVoicesEnabled() };
  const scriptArgs = { story, book, theme, profile, ageBand, emotionPlan, cast, language, dedication: p.dedication || null, options, seedBasis: fingerprint };
  let built = buildAudioScript(scriptArgs);
  const director = await runDirector({ segments: built.script.segments, book, theme, band: ageBand, evidence: built.script.segments.length ? (story.personalization_evidence || []) : [], masks: built.masks, costTracker, log, signal: p.abortSignal });
  if (director && (director.lines.length || Object.keys(director.cues).length)) {
    built = buildAudioScript({ ...scriptArgs, directorLines: director.lines, directorPicks: director.cues });
  }
  const { script } = built;
  for (const a of script.advisories || []) advisories.push({ stage: 'script', note: a });
  checkAbort();

  // ── Pronunciations ─────────────────────────────────────────────────────
  onProgress(0.06, 'Checking the names...');
  let hb = heartbeat(0.06, 'Checking the names...');
  const pronunciations = {};
  try {
    const names = [[profile.name, cast.narrator], ...(cast.companion && theme.companion && theme.companion.name ? [[theme.companion.name, cast.narrator]] : [])];
    for (const [name, voice] of names) {
      if (!name) continue;
      pronunciations[name] = await ensurePronunciation({ name, language, voice, adapter, credentials, costTracker, log, signal: p.abortSignal });
      if (pronunciations[name].status === 'unverified') advisories.push({ stage: 'pronunciation', note: `the pronunciation of "${name}" could not be verified on ${voice.key}` });
    }
  } finally { clearInterval(hb); }
  checkAbort();

  // ── Keys + whole-book replay ───────────────────────────────────────────
  const takeHashes = allTakeHashes(script, cast, provider, language, pronunciations, tuningHash);
  const cueIds = [...new Set(script.segments.flatMap(s => (s.sfx || []).map(x => x.cueId)))];
  const ambienceId = script.segments.find(s => s.ambience) ? script.segments.find(s => s.ambience).ambience.cueId : null;
  const musicCues = [...new Set(script.segments.filter(s => s.music).map(s => s.music.cue))];
  const wantsMotif = script.segments.some(s => s.music && s.music.motif);
  const mixHash = crypto.createHash('sha256').update(JSON.stringify({ script: script.hash, takes: takeHashes, options, target: flags.audioTargetLufs(), rules: MIX_RULES_HASH, v: AUDIO_VERSION })).digest('hex').slice(0, 16);
  const base = mixBase(bookId, mixHash);
  const subset = Array.isArray(p.segments) && p.segments.length ? new Set(p.segments) : null;
  const retake = Array.isArray(p.forceRetake) && p.forceRetake.length ? new Set(p.forceRetake) : null;
  const castReport = { narrator: { key: cast.narrator.key, label: cast.narrator.label, provider, model: cast.narrator.model || null, hash: cast.narrator.hash }, companion: cast.companion ? { key: cast.companion.key, label: cast.companion.label, provider, model: cast.companion.model || null, hash: cast.companion.hash } : null, hash: cast.hash };
  const scriptReport = { hash: script.hash, director: script.director, lines: script.segments.reduce((n, s) => n + s.lines.length, 0), companionLines: script.segments.reduce((n, s) => n + s.lines.filter(l => l.speaker === 'companion').length, 0), segments: script.segments.length };
  const pronunciationReport = Object.values(pronunciations).map(r => ({ name: r.name, status: r.status, alias: r.alias || null, cached: !!r.cached }));
  const stable = { audioVersion: AUDIO_VERSION, qaVersion: AUDIO_QA_VERSION, scriptHash: mixHash, cast: castReport, script: scriptReport, audioTuningUsed: tuning ? tuning.tag : 'none', pronunciations: pronunciationReport, language };
  if (!p.forceNew && !subset && !retake) {
    const manifest = await loadJson(`${base}/manifest.json`).catch(() => null);
    if (manifest && manifest.mp3Key && await objectExists(manifest.mp3Key).catch(() => false)) {
      log('info', `audiobook ${mixHash} replays from ${manifest.mp3Key}`);
      return {
        ...stable, cached: true, audiobookUrl: await sign(manifest.mp3Key), storageKey: manifest.mp3Key, timelineUrl: await sign(manifest.timelineKey), timeline: manifest.timeline || null,
        durationSeconds: manifest.durationSeconds, bytes: manifest.bytes, loudness: manifest.loudness, segments: manifest.segments || [], music: manifest.music || null, sfx: manifest.sfx || null, ambience: manifest.ambience || null,
        gates: manifest.gates || null, unresolved: [], advisories: [...advisories, ...(manifest.advisories || [])], warnings,
      };
    }
  }

  // ── Takes + assets (concurrent) ────────────────────────────────────────
  const targets = script.segments.filter(s => !subset || (s.kind === 'spread' && subset.has(s.spread)));
  const limit = pLimit(flags.audioConcurrency());
  let finished = 0;
  hb = setInterval(() => { touch(); onProgress(0.1 + (finished / Math.max(1, targets.length)) * 0.55, `Recording (${finished}/${targets.length} segments)...`); }, HEARTBEAT_MS);
  let takes;
  let suite = null;
  let sounds = null;
  try {
    onProgress(0.1, `Recording ${targets.length} segments (${flags.audioTakeCandidates()} takes each)...`);
    const takesTask = Promise.all(targets.map(seg => limit(async () => {
      const r = await renderSegment({
        bookId, segment: seg, cast, adapter, provider, credentials, language, band: ageBand, name: profile.name,
        pronunciation: pronunciations[profile.name] || null, tuning: tuning ? tuning.text : null, costTracker, log, touch, signal: p.abortSignal,
        forceRetake: !!(p.forceNew || (retake && seg.kind === 'spread' && retake.has(seg.spread))),
      });
      finished += 1;
      return r;
    })));
    const assetsTask = (async () => {
      if (subset) return { suite: null, sounds: null };
      const [s, c] = await Promise.all([
        options.music ? getMusicSuite({ theme, cueIds: [...musicCues, ...(wantsMotif ? [MOTIF_CUE] : [])], costTracker, log, signal: p.abortSignal, credentials: providerCredentials('elevenlabs', p.injectedKeys || {}) }).catch(err => { log('warn', `music suite failed (${err.message})`); return null; }) : Promise.resolve(null),
        options.sfx ? getSoundCues({ cueIds: [...cueIds, ...(ambienceId && options.ambience ? [ambienceId] : []), ...(script.pageTurn && options.pageTurn ? [script.pageTurn.cueId] : [])], costTracker, log, signal: p.abortSignal, credentials: providerCredentials('elevenlabs', p.injectedKeys || {}) }).catch(err => { log('warn', `sound cues failed (${err.message})`); return null; }) : Promise.resolve(null),
      ]);
      return { suite: s, sounds: c };
    })();
    [takes, { suite, sounds }] = await Promise.all([takesTask, assetsTask]);
  } catch (err) {
    if (err instanceof AudiobookError) throw err;
    throw new AudiobookError(err.message, err.failureCode || 'audiobook_render_failed');
  } finally { clearInterval(hb); }
  takes.sort((a, b) => a.index - b.index);
  checkAbort();
  if (suite) for (const a of suite.advisories) advisories.push(a);
  if (sounds) for (const a of sounds.advisories) advisories.push(a);

  // ── Per-segment report + ship policy ───────────────────────────────────
  const unresolved = [];
  const segmentReport = [];
  for (const t of takes) {
    const seg = script.segments.find(s => s.index === t.index);
    for (const c of t.chunks) {
      if (c.qa.qaUnavailable) advisories.push({ stage: 'takeQa', spread: seg.spread, note: `${seg.kind}${seg.spread ? ` ${seg.spread}` : ''} chunk ${c.chunk} shipped UNCHECKED (${c.qa.qaUnavailable})` });
      for (const a of c.qa.advisory) advisories.push({ stage: 'takeQa', spread: seg.spread, note: `${seg.kind}${seg.spread ? ` ${seg.spread}` : ''}: ${a}` });
      if (c.rung && c.rung !== 'full' && !c.cached) advisories.push({ stage: 'take', spread: seg.spread, note: `${seg.kind}${seg.spread ? ` ${seg.spread}` : ''} chunk ${c.chunk} shipped from the ${c.rung} rung` });
      if (c.unresolved) {
        const candidates = [];
        for (const f of c.candidateFiles) candidates.push({ storageKey: f.storageKey, url: await sign(f.storageKey), score: f.score });
        unresolved.push({ segment: t.index, spread: seg.spread, chunk: c.chunk, defects: c.qa.blocking, candidates });
      }
    }
    segmentReport.push({
      index: t.index, kind: t.kind, spread: t.spread, cached: t.cached,
      chunks: await Promise.all(t.chunks.map(async c => ({ chunk: c.chunk, speaker: c.speaker, storageKey: c.storageKey, url: await sign(c.storageKey), seconds: c.measure.trimmedSeconds, lufs: c.measure.lufs, qa: { pass: !c.unresolved && c.qa.advisory.length === 0, blocking: c.qa.blocking, advisory: c.qa.advisory, qaUnavailable: c.qa.qaUnavailable || null, wordMatch: c.compare ? c.compare.wordMatch : null, transcript: c.transcript || null }, candidates: c.candidates, repairs: c.repairs, cached: c.cached, rung: c.rung, ...(c.adminPicked ? { adminPicked: true } : {}) }))),
    });
  }
  const failDetails = () => ({ ...stable, segments: segmentReport, unresolved, advisories, warnings });
  if (unresolved.length > 0 && !flags.audioShipOnExhaustion()) {
    throw new AudiobookError(`${unresolved.length} take(s) could not be read to the book's standard: ${unresolved.map(u => `${u.spread ? `spread ${u.spread}` : `segment ${u.segment}`}: ${u.defects.join(' | ')}`).join('; ')}`, 'audiobook_unresolved', failDetails());
  }
  if (unresolved.length > 0) advisories.push({ stage: 'shipPolicy', note: `shipped ${unresolved.length} take(s) with BLOCKING residual defects (CATALOG_AUDIO_SHIP_ON_EXHAUSTION=1)` });
  if (subset) {
    onProgress(1, 'Takes ready');
    return { ...stable, cached: false, subset: true, audiobookUrl: null, storageKey: null, timelineUrl: null, timeline: null, durationSeconds: null, bytes: null, loudness: null, segments: segmentReport, music: null, sfx: null, ambience: null, gates: null, unresolved, advisories, warnings };
  }

  // ── Timeline ───────────────────────────────────────────────────────────
  onProgress(0.7, 'Laying out the timeline...');
  const cueSeconds = {};
  if (sounds) for (const [id, rec] of Object.entries(sounds.cues)) cueSeconds[id] = { seconds: rec.seconds };
  const timelineTakes = takes.map(t => ({ index: t.index, chunks: t.chunks.map(c => ({ chunk: c.chunk, speaker: c.speaker, lineIndexes: c.lineIndexes, storageKey: c.storageKey, measure: c.measure, alignment: c.alignment })) }));
  const timeline = buildTimeline({ script, takes: timelineTakes, cueSeconds, options: { pageTurn: !!(options.pageTurn && sounds && script.pageTurn && sounds.cues[script.pageTurn.cueId]), motif: !!(suite && suite.cues[MOTIF_CUE]) } });
  const tv = validateTimeline(timeline);
  if (!tv.ok) throw new AudiobookError(`the timeline is invalid: ${tv.errors.join('; ')}`, 'audiobook_mix_failed', failDetails());

  // ── Mix + gates ────────────────────────────────────────────────────────
  onProgress(0.75, 'Mixing...');
  hb = heartbeat(0.78, 'Mixing...');
  const dir = await mix.makeTempDir(bookId);
  let mp3;
  let loudness;
  let gateReport;
  let musicReport = null;
  let sfxReport = null;
  try {
    const takeFiles = [];
    for (const t of takes) for (const c of t.chunks) {
      const file = path.join(dir, `${t.index}-${c.chunk}.wav`);
      await fs.promises.writeFile(file, c.buffer || await downloadBuffer(c.storageKey));
      const placed = timeline.segments.find(s => s.index === t.index).chunks.find(x => x.chunk === c.chunk);
      takeFiles.push({ path: file, at: placed.at, trim: c.measure.trim, lufs: c.measure.lufs });
    }
    const assetFile = async (rec, label) => {
      const ext = rec.path ? path.extname(rec.path).slice(1) : (rec.storageKey ? path.extname(rec.storageKey).slice(1) : 'bin');
      const file = path.join(dir, `${label}.${ext || 'bin'}`);
      if (rec.path) await fs.promises.copyFile(rec.path, file);
      else await fs.promises.writeFile(file, await assetBytes(rec));
      return file;
    };
    const musicSpans = [];
    if (suite) {
      for (const [i, span] of timeline.music.entries()) {
        const rec = suite.cues[span.cue];
        if (!rec) { advisories.push({ stage: 'music', note: `cue ${span.cue} is unavailable — the span plays without music` }); continue; }
        musicSpans.push({ ...span, path: await assetFile(rec, `music-${i}-${span.cue}`), lufs: Number.isFinite(rec.lufs) ? rec.lufs : null });
      }
      musicReport = { provider: suite.provider, suite: { themeId: suite.themeId, hash: suite.hash, fallbackCues: suite.fallbackCues }, plan: timeline.music.map(m => ({ cue: m.cue, from: m.from, to: m.to, gainDb: m.gainDb, spreads: m.spreads })), motifs: timeline.motifs };
    }
    const sfxFiles = [];
    const placedReport = [];
    if (sounds) {
      for (const [i, s] of timeline.sfx.entries()) {
        const rec = sounds.cues[s.cueId];
        if (!rec) continue;
        sfxFiles.push({ path: await assetFile(rec, `sfx-${i}-${s.cueId}`), at: s.at, gainDb: s.gainDb, lufs: Number.isFinite(rec.lufs) ? rec.lufs : null });
        placedReport.push({ spread: s.spread, cueId: s.cueId, at: s.at, gainDb: s.gainDb, source: s.source });
      }
      if (suite && suite.cues[MOTIF_CUE]) for (const [i, m] of timeline.motifs.entries()) sfxFiles.push({ path: await assetFile(suite.cues[MOTIF_CUE], `motif-${i}`), at: m.at, gainDb: m.gainDb, lufs: Number.isFinite(suite.cues[MOTIF_CUE].lufs) ? suite.cues[MOTIF_CUE].lufs : null });
      if (script.pageTurn && sounds.cues[script.pageTurn.cueId]) for (const [i, t] of timeline.pageTurns.entries()) sfxFiles.push({ path: await assetFile(sounds.cues[script.pageTurn.cueId], `turn-${i}`), at: t.at, gainDb: t.gainDb, lufs: null });
      sfxReport = { provider: sounds.provider, libraryHash: sounds.hash, placed: placedReport, skipped: sounds.skipped, pageTurns: timeline.pageTurns.length };
    }
    let ambience = null;
    if (sounds && timeline.ambience && sounds.cues[timeline.ambience.cueId]) ambience = { path: await assetFile(sounds.cues[timeline.ambience.cueId], 'ambience'), gainDb: timeline.ambience.gainDb, lufs: null };
    const target = flags.audioTargetLufs();
    const outputs = { master: path.join(dir, 'master.wav'), voice: path.join(dir, 'voice.wav'), music: path.join(dir, 'music.wav'), ambience: path.join(dir, 'ambience.wav'), sfx: path.join(dir, 'sfx.wav') };
    let musicOffsetDb = 0;
    let ratio = null;
    let master = null;
    let startle = null;
    for (let pass = 0; pass <= MAX_RATIO_REMIXES; pass++) {
      checkAbort();
      const cmd = mix.buildMixCommand({ timeline, takes: takeFiles, music: musicSpans, sfx: sfxFiles, ambience, outputs, musicOffsetDb });
      await mix.runFfmpeg(cmd.args, { timeoutMs: 15 * 60 * 1000 });
      touch();
      const masterWav = await fs.promises.readFile(outputs.master);
      master = gates.measureMaster(masterWav, target);
      const voiceWav = await fs.promises.readFile(outputs.voice);
      const musicWav = await fs.promises.readFile(outputs.music);
      const sfxWav = await fs.promises.readFile(outputs.sfx);
      ratio = musicSpans.length ? gates.speechMusicRatio({ voiceWav, musicWav, timeline }) : { pass: true, minLu: null, perSpread: [], adjustDb: 0 };
      startle = gates.startleCheck({ sfxWav, musicWav });
      if (ratio.pass || pass === MAX_RATIO_REMIXES) break;
      musicOffsetDb += ratio.adjustDb;
      log('info', `speech-to-music ratio ${ratio.minLu} LU < ${gates.RATIO_MIN_LU} — re-mixing with the music ${musicOffsetDb} dB`);
    }
    if (master.deadAir.length) throw new AudiobookError(`dead air on the master at ${master.deadAir.map(r => `${r.start}s`).join(', ')} — the timeline and the mix disagree`, 'audiobook_mix_failed', failDetails());
    if (!ratio.pass) advisories.push({ stage: 'gates', note: `speech-to-music ratio ${ratio.minLu} LU stays under ${gates.RATIO_MIN_LU} LU after ${MAX_RATIO_REMIXES} re-mixes` });
    if (!startle.pass) advisories.push({ stage: 'gates', note: `a sound peaks at ${startle.sfx && startle.sfx.peakDb > gates.STARTLE_DBTP ? `${startle.sfx.peakDb} dB (effects, ${startle.sfx.at}s)` : `${startle.music.peakDb} dB (music, ${startle.music.at}s)`}` });
    const mp3Path = path.join(dir, 'audiobook.mp3');
    const masterGain = master.gainDb;
    await mix.runFfmpeg(mix.buildMasterCommand({ input: outputs.master, output: mp3Path, gainDb: masterGain, metadata: { title: String((story && story.title) || book.title_template.replace('{name}', profile.name || '')), artist: 'Gift My Book', album: `${theme.display_name || theme.theme_id} audiobook`, comment: `ab-1 ${mixHash}` } }), { timeoutMs: 10 * 60 * 1000 });
    mp3 = await fs.promises.readFile(mp3Path);
    loudness = { integratedLufs: master.integratedLufs === null ? null : Math.round((master.integratedLufs + masterGain) * 100) / 100, truePeakDbtp: Math.min(gates.TRUE_PEAK_MAX, Math.round((master.truePeakDbtp + masterGain) * 100) / 100), lra: master.lra, masterGainDb: masterGain, target };
    const listen = await gates.listenThrough({ mp3, seconds: timeline.totalSeconds, band: ageBand, costTracker, signal: p.abortSignal });
    for (const a of listen.advisories) advisories.push(a);
    gateReport = {
      loudness: { pass: true, integratedLufs: loudness.integratedLufs, truePeakDbtp: loudness.truePeakDbtp, lra: loudness.lra, masterGainDb: masterGain },
      speechMusicRatio: { pass: ratio.pass, minLu: ratio.minLu, perSpread: ratio.perSpread, musicOffsetDb },
      deadAir: { pass: true }, startle: { pass: startle.pass, sfx: startle.sfx, music: startle.music },
      listen: listen.verdict ? { ...listen.verdict, pass: listen.verdict.intelligible && !listen.verdict.musicTooLoud && !listen.verdict.sfxDistracting } : { pass: null, unavailable: listen.unavailable },
    };
  } catch (err) {
    if (err instanceof AudiobookError) throw err;
    throw new AudiobookError(err.message, err.failureCode || 'audiobook_mix_failed', failDetails());
  } finally {
    clearInterval(hb);
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  checkAbort();

  // ── Upload + manifest ──────────────────────────────────────────────────
  onProgress(0.95, 'Uploading...');
  const mp3Key = `${base}/audiobook.mp3`;
  const timelineKey = `${base}/timeline.json`;
  await uploadBuffer(mp3, mp3Key, 'audio/mpeg');
  await uploadBuffer(Buffer.from(JSON.stringify(timeline)), timelineKey, 'application/json');
  const manifest = {
    audioVersion: AUDIO_VERSION, qaVersion: AUDIO_QA_VERSION, mixHash, scriptHash: script.hash, mp3Key, timelineKey, mp3Hash: bytesHash(mp3),
    durationSeconds: timeline.totalSeconds, bytes: mp3.length, loudness, timeline, segments: segmentReport.map(s => ({ ...s, chunks: s.chunks.map(({ url, ...rest }) => rest) })),
    music: musicReport, sfx: sfxReport, ambience: timeline.ambience, gates: gateReport, cast: castReport, advisories, createdAt: new Date().toISOString(),
  };
  try { await saveJson(manifest, `${base}/manifest.json`); } catch (err) { log('warn', `manifest write failed (${err.message})`); }
  onProgress(1, 'Audiobook ready');
  return {
    ...stable, cached: false, audiobookUrl: await sign(mp3Key), storageKey: mp3Key, timelineUrl: await sign(timelineKey), timeline,
    durationSeconds: timeline.totalSeconds, bytes: mp3.length, loudness, segments: segmentReport, music: musicReport, sfx: sfxReport, ambience: timeline.ambience,
    gates: gateReport, unresolved, advisories, warnings,
  };
}

/**
 * The audition — one spread through the full take path (and its music cue
 * under it when the suite is available), synchronous.
 * @param {object} p generateAudiobook's params + `spread` (default 1) + `withMusic`
 * @returns {Promise<{url: string|null, storageKey: string|null, seconds: number, wordMatch: number|null, transcript: string|null, cast: object, blocking: string[], advisory: string[]}>}
 */
async function auditionAudiobook(p) {
  const log = p.log || (() => {});
  const { bookId, story, bookDef, profile, costTracker } = p;
  const { book, theme, ageBand } = bookDef;
  const language = ['en', 'es', 'he'].includes(p.language) ? p.language : 'en';
  const resolved = resolveNarratorProvider();
  if (!resolved.ok) throw new AudiobookError(resolved.error, 'audiobook_provider_unavailable');
  const { provider, adapter } = resolved;
  const credentials = providerCredentials(provider, p.injectedKeys || {});
  let cast;
  try { cast = resolveCast({ provider, theme, ageBand, seedBasis: storyFingerprint(story), request: p.cast || {}, characterVoices: flags.audioCharacterVoicesEnabled() }); } catch (err) { throw new AudiobookError(err.message, 'audiobook_bad_cast'); }
  const emotionPlan = buildEmotionPlan({ book, story, ageBand });
  const { script } = buildAudioScript({ story, book, theme, profile, ageBand, emotionPlan, cast, language, options: { music: false, sfx: false } });
  const spread = Number.isInteger(p.spread) ? p.spread : 1;
  const segment = script.segments.find(s => s.kind === 'spread' && s.spread === spread) || script.segments.find(s => s.kind === 'spread');
  if (!segment) throw new AudiobookError('the story has no spread to audition', 'invalid_story');
  const take = await renderSegment({ bookId, segment, cast, adapter, provider, credentials, language, band: ageBand, name: profile.name, pronunciation: null, tuning: null, costTracker, log, touch: p.touch || (() => {}), signal: p.abortSignal, forceRetake: !!p.forceNew, opts: { candidates: 1, maxRepairs: 1, budget: 2 } });
  const first = take.chunks[0];
  const key = `children-jobs/${bookId}/audiobook/${AUDIO_VERSION}/auditions/${cast.hash}-s${segment.spread}-${first.takeHash}.wav`;
  const buffer = first.buffer || await downloadBuffer(first.storageKey);
  await uploadBuffer(buffer, key, 'audio/wav');
  return {
    url: await sign(key), storageKey: key, seconds: take.chunks.reduce((n, c) => n + c.measure.trimmedSeconds, 0), spread: segment.spread,
    wordMatch: first.compare ? first.compare.wordMatch : null, transcript: first.transcript || null,
    cast: { narrator: { key: cast.narrator.key, label: cast.narrator.label, provider }, companion: cast.companion ? { key: cast.companion.key, label: cast.companion.label } : null },
    blocking: take.chunks.flatMap(c => c.qa.blocking), advisory: take.chunks.flatMap(c => c.qa.advisory), unresolved: take.unresolved,
  };
}

module.exports = { generateAudiobook, auditionAudiobook, AudiobookError, normalizeAudioTuning, mixBase, allTakeHashes, SIGNED_URL_TTL_MS, MAX_TUNING_BYTES };
