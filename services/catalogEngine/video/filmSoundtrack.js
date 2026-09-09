/**
 * The full-story film's soundtrack (gfs-2, 2026-09-09): the audiobook's
 * per-theme music SUITE (music/plan.js + music/suites.js), its CLOSED sound
 * library (sfx/plan.js + sfx/library.js) and the theme's ambience bed, laid
 * on the film's FIXED clock. Before gfs-2 the film scored every spread with
 * one of nine CC0 ambient loops chosen by that spread's emotion — a
 * per-spread flip-flop of generic beds, no cues, no ambience.
 *
 * Planning is PURE (`planFilmCues` needs only the screenplay, so the assets
 * can be elected while speech records; `layFilmSoundtrack` needs the
 * measured shots): the cue grammar, hold rules, band caps, quotas, spacing
 * and startle rules are the audiobook's own, reused — not restated. The
 * clock differs from the audiobook's in one way: a film has no gaps to
 * widen, so a sound cue plays in the pause the whole-second shot already
 * paid for (filmMedia.speechShots), starting 0.15 s after the anchored
 * passage ends and never on a spoken word; its tail may run under the next
 * passage at the cue's own low gain, as film sound design does.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { planMusic, validateMusicPlan, MOTIF_CUE, MOTIF_GAIN_DB, MOTIF_LEAD_SECONDS } = require('../audio/music/plan');
const { planSfx, validateSfxPlan } = require('../audio/sfx/plan');
const { normalizeSpoken } = require('../audio/script');
const { getMusicSuite } = require('../audio/music/suites');
const { getSoundCues } = require('../audio/sfx/library');
const { assetBytes } = require('../audio/assets');
const flags = require('../flags');

/** The placement rules' identity — part of the film hash. */
const SOUNDTRACK_RULES = 'fst-1';
const CROSSFADE_SECONDS = 3;
const OPENING_FADE_SECONDS = 1;
const CLOSING_FADE_SECONDS = 2.5;
const SFX_AFTER_SPEECH_SECONDS = 0.15;
const MIN_SFX_SPACING_SECONDS = 4;
const SPEECH_GUARD_SECONDS = 0.05;

const r3 = n => Math.round(n * 1000) / 1000;

/** @param {*} value @returns {string} */
function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * The emotion of every spread from the director's per-passage emotions —
 * the one that carries the most spoken text wins (ties: first seen), so
 * the score follows the acting the film actually shows.
 * @param {Array<{spread: number, emotion: string, text: string}>} turns
 * @returns {Object<number, {emotion: string, intensity: string}>}
 */
function spreadEmotions(turns) {
  const weights = new Map();
  for (const t of turns) {
    if (!weights.has(t.spread)) weights.set(t.spread, new Map());
    const w = weights.get(t.spread);
    w.set(t.emotion, (w.get(t.emotion) || 0) + String(t.text || '').replace(/\s+/g, '').length);
  }
  const plan = {};
  for (const [spread, w] of weights) {
    let best = null;
    for (const [emotion, weight] of w) if (!best || weight > best.weight) best = { emotion, weight };
    plan[spread] = { emotion: best ? best.emotion : 'calm', intensity: 'clear' };
  }
  return plan;
}

/**
 * The passages that speak the refrain (the whole refrain, normalized, as a
 * substring of the passage) on the book's refrain spreads.
 * @param {Array<{index: number, spread: number, text: string}>} turns
 * @param {{text?: string, spreads?: number[]}|null} refrain
 * @returns {Set<number>} turn indexes
 */
function refrainTurns(turns, refrain) {
  const out = new Set();
  const text = refrain && typeof refrain.text === 'string' ? normalizeSpoken(refrain.text) : '';
  if (!text) return out;
  const spreads = new Set(Array.isArray(refrain.spreads) ? refrain.spreads : []);
  for (const t of turns) if (spreads.has(t.spread) && normalizeSpoken(t.text).includes(text)) out.add(t.index);
  return out;
}

/**
 * The cue plan — PURE over the screenplay, before any speech is recorded:
 * which music cue every spread sits under (the audiobook's grammar: intro
 * and lullaby bookends, ≥ 2-spread holds, the band's change cap, no
 * gentle_tension under 4), which spot cues each spread earns (evidence >
 * beat > text, band quota, two uses per book, never on the refrain), the
 * theme's ambience bed, and the refrain motif — so the assets can be
 * elected while the takes record.
 * @param {object} p
 * @param {Array<{index: number, spread: number, speaker: string, emotion: string, text: string}>} p.turns the screenplay
 * @param {{book: object, theme: object, ageBand: string}} p.bookDef
 * @param {object} p.story the pinned story (personalization_evidence)
 * @param {{name?: string}} p.profile
 * @param {string} p.seedBasis tie-break seed (the script hash)
 * @param {{music: boolean, sfx: boolean, ambience: boolean}} p.options
 * @returns {{segments: object[], refrainTurns: number[], musicCues: string[], sfxCues: string[], ambience: {cueId: string, gainDb: number}|null, wantsMotif: boolean, libraryHash: string|null, errors: string[]}}
 */
function planFilmCues({ turns, bookDef, story, profile, seedBasis, options }) {
  const { book, theme, ageBand } = bookDef;
  const refrain = book && book.refrain ? book.refrain : null;
  const refrainSet = refrainTurns(turns, refrain);
  const segments = Array.from({ length: 12 }, (_, i) => {
    const spread = i + 1;
    const mine = turns.filter(t => t.spread === spread);
    return { index: i, kind: 'spread', spread, lines: mine.map((t, k) => ({ index: k, turn: t.index, text: t.text, speaker: t.speaker, isRefrain: refrainSet.has(t.index) })) };
  });
  const errors = [];
  let musicCues = [];
  let wantsMotif = false;
  if (options.music) {
    planMusic({ segments, emotionPlan: spreadEmotions(turns), band: ageBand, refrainSpreads: refrain && Array.isArray(refrain.spreads) ? refrain.spreads : [] });
    const check = validateMusicPlan(segments, ageBand);
    if (!check.ok) errors.push(...check.errors.map(e => `music: ${e}`));
    musicCues = [...new Set(segments.map(s => s.music.cue))];
    wantsMotif = segments.some(s => s.music.motif && s.lines.some(l => l.isRefrain));
  }
  let sfxCues = [];
  let ambience = null;
  let libraryHash = null;
  if (options.sfx || options.ambience) {
    const masks = [profile && profile.name, theme && theme.companion && theme.companion.name, theme && theme.world_name, theme && theme.display_name, refrain && refrain.text].filter(Boolean);
    const planned = planSfx({ segments, book, theme, band: ageBand, evidence: Array.isArray(story && story.personalization_evidence) ? story.personalization_evidence : [], masks, seedBasis, options: { ambience: !!options.ambience, spots: !!options.sfx, pageTurn: false } });
    const check = validateSfxPlan(segments, ageBand);
    if (!check.ok) errors.push(...check.errors.map(e => `sfx: ${e}`));
    sfxCues = [...new Set(planned.placed.map(x => x.cueId))];
    ambience = planned.segments.find(s => s.ambience) ? planned.segments.find(s => s.ambience).ambience : null;
    libraryHash = planned.libraryHash;
  }
  return { segments, refrainTurns: [...refrainSet], musicCues, sfxCues, ambience, wantsMotif, libraryHash, errors };
}

/**
 * Lay the cue plan on the film's clock — PURE over the measured shots.
 * Music spans follow the spreads (a boundary crossfades over 3 s centred
 * on the cut; the opening fades in over 1 s, the ending fades over the
 * last 2.5 s); the motif fires 1.5 s before the refrain passage (never
 * over the previous passage's last word); a spot
 * cue starts 0.15 s after its anchored passage ends, inside the pause the
 * shot paid for, spaced ≥ 4 s from the previous cue, never over speech.
 * @param {object} p
 * @param {object[]} p.segments from planFilmCues (annotated)
 * @param {Array<{index: number, turn: number, spread: number, from: number, to: number, speechStart: number, speechEnd: number}>} p.shots in film order
 * @param {Object<string, {seconds: number}>} [p.cueSeconds] the elected cues' durations
 * @param {{music: boolean, sfx: boolean, ambience: boolean, motif: boolean}} p.options
 * @returns {{totalSeconds: number, music: object[], motifs: object[], sfx: object[], skipped: object[], ambience: object|null, speechWindows: object[], hash: string}}
 */
function layFilmSoundtrack({ segments, shots, cueSeconds = {}, options }) {
  const totalSeconds = r3(shots.reduce((max, s) => Math.max(max, s.to), 0));
  const speechWindows = shots.map(s => ({ spread: s.spread, start: r3(s.from + s.speechStart), end: r3(s.from + s.speechEnd) }));
  const window = spread => {
    const mine = shots.filter(s => s.spread === spread);
    return mine.length ? { from: r3(Math.min(...mine.map(s => s.from))), to: r3(Math.max(...mine.map(s => s.to))) } : null;
  };
  const music = [];
  if (options.music) {
    for (const seg of segments) {
      const w = window(seg.spread);
      if (!w || !seg.music) continue;
      const cur = music[music.length - 1];
      if (cur && cur.cue === seg.music.cue) { cur.to = w.to; cur.spreads.push(seg.spread); continue; }
      music.push({ cue: seg.music.cue, from: w.from, to: w.to, gainDb: seg.music.gainDb, spreads: [seg.spread] });
    }
    for (let i = 0; i < music.length; i++) {
      const prev = music[i - 1];
      const next = music[i + 1];
      if (prev) { const b = (prev.to + music[i].from) / 2; music[i].from = r3(Math.max(0, b - CROSSFADE_SECONDS / 2)); prev.to = r3(Math.min(totalSeconds, b + CROSSFADE_SECONDS / 2)); }
      if (i === 0) music[i].from = 0;
      if (!next) music[i].to = totalSeconds;
      music[i].fadeIn = i === 0 ? OPENING_FADE_SECONDS : CROSSFADE_SECONDS;
      music[i].fadeOut = next ? CROSSFADE_SECONDS : r3(Math.min(CLOSING_FADE_SECONDS, Math.max(0.5, (music[i].to - music[i].from) / 2)));
    }
  }
  const motifs = [];
  if (options.music && options.motif) {
    for (const seg of segments) {
      if (!seg.music || !seg.music.motif) continue;
      const line = seg.lines.find(l => l.isRefrain);
      const shot = line && shots.find(s => s.turn === line.turn);
      if (!shot) continue;
      // 1.5 s before the refrain passage, but never over the previous
      // passage's last word (the audiobook's floor: the previous segment's end).
      const previous = shots.find(s => s.index === shot.index - 1);
      const floor = previous ? previous.from + previous.speechEnd + 0.1 : 0;
      motifs.push({ spread: seg.spread, cueId: MOTIF_CUE, at: r3(Math.max(floor, shot.from + shot.speechStart - MOTIF_LEAD_SECONDS)), gainDb: MOTIF_GAIN_DB });
    }
  }
  const sfx = [];
  const skipped = [];
  if (options.sfx) {
    let lastAt = -Infinity;
    for (const seg of segments) {
      for (const s of seg.sfx || []) {
        const line = seg.lines[s.anchorLine];
        const mine = line ? shots.filter(x => x.turn === line.turn) : [];
        const shot = mine[mine.length - 1];
        if (!shot) { skipped.push({ spread: seg.spread, cueId: s.cueId, reason: 'no shot' }); continue; }
        const at = r3(shot.from + shot.speechEnd + SFX_AFTER_SPEECH_SECONDS);
        if (at - lastAt < MIN_SFX_SPACING_SECONDS) { skipped.push({ spread: seg.spread, cueId: s.cueId, reason: 'spacing' }); continue; }
        if (at >= totalSeconds - SPEECH_GUARD_SECONDS) { skipped.push({ spread: seg.spread, cueId: s.cueId, reason: 'end of film' }); continue; }
        const seconds = (cueSeconds[s.cueId] && cueSeconds[s.cueId].seconds) || s.seconds || 2;
        sfx.push({ spread: seg.spread, cueId: s.cueId, at, gainDb: s.gainDb, seconds: r3(seconds), source: s.source, passage: line.turn });
        lastAt = at;
      }
    }
  }
  const ambience = options.ambience ? ((segments.find(s => s.ambience) || {}).ambience || null) : null;
  const laid = { totalSeconds, music, motifs, sfx, skipped, ambience, speechWindows };
  return { ...laid, hash: hash({ rules: SOUNDTRACK_RULES, music: music.map(m => [m.cue, m.from, m.to, m.gainDb]), motifs: motifs.map(m => [m.at, m.gainDb]), sfx: sfx.map(s => [s.cueId, s.at, s.gainDb]), ambience }) };
}

/**
 * Invariants of a laid soundtrack (the audiobook's timeline rules, on the
 * film's clock).
 * @param {{totalSeconds: number, music: object[], sfx: object[], speechWindows: object[]}} laid
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateFilmSoundtrack(laid) {
  const errors = [];
  const inSpeech = t => laid.speechWindows.some(w => t > w.start + SPEECH_GUARD_SECONDS && t < w.end - SPEECH_GUARD_SECONDS);
  for (const m of laid.music) if (m.to <= m.from) errors.push(`music span ${m.cue} is empty`);
  for (let i = 1; i < laid.music.length; i++) if (laid.music[i].from > laid.music[i - 1].to + 0.001) errors.push(`music is silent between ${laid.music[i - 1].cue} and ${laid.music[i].cue}`);
  if (laid.music.length && (laid.music[0].from !== 0 || Math.abs(laid.music[laid.music.length - 1].to - laid.totalSeconds) > 0.001)) errors.push('the score does not cover the film');
  for (const s of laid.sfx) if (inSpeech(s.at)) errors.push(`sound cue ${s.cueId} at ${s.at}s starts over a spoken word`);
  for (let i = 1; i < laid.sfx.length; i++) if (laid.sfx[i].at - laid.sfx[i - 1].at < MIN_SFX_SPACING_SECONDS - 0.001) errors.push('sound cues closer than 4 s');
  if (!(laid.totalSeconds > 0)) errors.push('empty film');
  return { ok: errors.length === 0, errors };
}

/**
 * Elect (or fetch) the assets a cue plan needs — the suite's cues for THIS
 * theme, the spot cues and the ambience bed — create-if-absent under
 * catalog-assets, shared with the audiobook. Fail-open: a provider outage
 * returns null for that family with an advisory; the CC0 library covers
 * the music, a missing sound is skipped.
 * @param {object} p
 * @param {object} p.theme
 * @param {ReturnType<typeof planFilmCues>} p.cues
 * @param {{music: boolean, sfx: boolean, ambience: boolean}} p.options
 * @param {object} [p.credentials] the ElevenLabs credentials (sound cues / Eleven Music)
 * @param {object} [p.costTracker]
 * @param {(level: string, msg: string) => void} [p.log]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{suite: object|null, sounds: object|null, advisories: object[]}>}
 */
async function electFilmSoundtrackAssets({ theme, cues, options, credentials = {}, costTracker, log = () => {}, signal }) {
  const advisories = [];
  const soundIds = [...(options.sfx ? cues.sfxCues : []), ...(options.ambience && cues.ambience ? [cues.ambience.cueId] : [])];
  const [suite, sounds] = await Promise.all([
    options.music && cues.musicCues.length
      ? getMusicSuite({ theme, cueIds: [...cues.musicCues, ...(cues.wantsMotif ? [MOTIF_CUE] : [])], costTracker, log, signal, credentials })
        .catch(err => { advisories.push({ stage: 'music', note: `music suite unavailable (${err.message}) — the film ships without a score` }); return null; })
      : Promise.resolve(null),
    soundIds.length
      ? getSoundCues({ cueIds: soundIds, costTracker, log, signal, credentials })
        .catch(err => { advisories.push({ stage: 'sfx', note: `sound cues unavailable (${err.message}) — the film ships without sound effects` }); return null; })
      : Promise.resolve(null),
  ]);
  if (suite) advisories.push(...suite.advisories);
  if (sounds) advisories.push(...sounds.advisories);
  return { suite, sounds, advisories };
}

/**
 * The identity of the elected assets (part of the film hash: a newly
 * elected suite or cue is a new mix, never a re-bought shot).
 * @param {{suite: object|null, sounds: object|null}} assets
 * @returns {object}
 */
function soundtrackAssetsHash({ suite, sounds }) {
  return hash({
    suite: suite ? { hash: suite.hash, cues: Object.fromEntries(Object.entries(suite.cues).map(([id, rec]) => [id, rec.hash || rec.path || null])) } : null,
    sounds: sounds ? Object.fromEntries(Object.entries(sounds.cues).map(([id, rec]) => [id, rec.hash || null])) : null,
  });
}

/**
 * Write the elected assets into the mix directory and return the mixer's
 * inputs (`buildMixCommand`'s `music`, `sfx`, `ambience`) plus the report
 * the callback carries.
 * @param {object} p
 * @param {string} p.dir the temp directory
 * @param {ReturnType<typeof layFilmSoundtrack>} p.laid
 * @param {{suite: object|null, sounds: object|null}} p.assets
 * @returns {Promise<{music: object[], sfx: object[], ambience: object|null, report: object, advisories: object[]}>}
 */
async function writeSoundtrackInputs({ dir, laid, assets }) {
  const advisories = [];
  const files = new Map();
  const assetFile = async (rec, label) => {
    const id = rec.storageKey || rec.path;
    if (files.has(id)) return files.get(id);
    const ext = (rec.path ? path.extname(rec.path) : path.extname(rec.storageKey || '')).slice(1) || 'bin';
    const file = path.join(dir, `${label}.${ext}`);
    if (rec.path) await fs.promises.copyFile(rec.path, file);
    else await fs.promises.writeFile(file, await assetBytes(rec));
    files.set(id, file);
    return file;
  };
  const { suite, sounds } = assets;
  const music = [];
  if (suite) {
    for (const [i, span] of laid.music.entries()) {
      const rec = suite.cues[span.cue];
      if (!rec) { advisories.push({ stage: 'music', note: `cue ${span.cue} is unavailable — spreads ${span.spreads.join(', ')} play without music` }); continue; }
      music.push({ ...span, path: await assetFile(rec, `music-${i}-${span.cue}`), lufs: Number.isFinite(rec.lufs) ? rec.lufs : null });
    }
  }
  const sfx = [];
  const placed = [];
  if (sounds) {
    for (const [i, s] of laid.sfx.entries()) {
      const rec = sounds.cues[s.cueId];
      if (!rec) continue;
      sfx.push({ path: await assetFile(rec, `sfx-${i}-${s.cueId}`), at: s.at, gainDb: s.gainDb, lufs: Number.isFinite(rec.lufs) ? rec.lufs : null });
      placed.push({ spread: s.spread, cueId: s.cueId, at: s.at, gainDb: s.gainDb, source: s.source });
    }
  }
  if (suite && suite.cues[MOTIF_CUE]) {
    for (const [i, m] of laid.motifs.entries()) sfx.push({ path: await assetFile(suite.cues[MOTIF_CUE], `motif-${i}`), at: m.at, gainDb: m.gainDb, lufs: Number.isFinite(suite.cues[MOTIF_CUE].lufs) ? suite.cues[MOTIF_CUE].lufs : null });
  }
  let ambience = null;
  if (sounds && laid.ambience && sounds.cues[laid.ambience.cueId]) ambience = { path: await assetFile(sounds.cues[laid.ambience.cueId], 'ambience'), gainDb: laid.ambience.gainDb, lufs: null };
  const report = {
    rules: SOUNDTRACK_RULES,
    music: suite ? { provider: suite.provider, suite: { themeId: suite.themeId, hash: suite.hash, fallbackCues: suite.fallbackCues }, plan: laid.music.map(m => ({ cue: m.cue, from: m.from, to: m.to, gainDb: m.gainDb, spreads: m.spreads })), motifs: laid.motifs.map(m => ({ spread: m.spread, at: m.at })) } : null,
    sfx: sounds ? { provider: sounds.provider, libraryHash: sounds.hash, placed, skipped: [...laid.skipped, ...sounds.skipped] } : null,
    ambience: ambience ? { cueId: laid.ambience.cueId, gainDb: laid.ambience.gainDb } : null,
  };
  return { music, sfx, ambience, report, advisories };
}

/**
 * The soundtrack options a film run resolves from its request + the switches.
 * @param {string} music the request's `music` (`story-score` | `none`)
 * @returns {{music: boolean, sfx: boolean, ambience: boolean, motif: boolean}}
 */
function soundtrackOptions(music) {
  const score = music !== 'none' && flags.audioMusicEnabled();
  const design = flags.filmSfxEnabled();
  return { music: score, motif: score, sfx: design && flags.audioSfxEnabled(), ambience: design && flags.audioAmbienceEnabled() };
}

module.exports = { SOUNDTRACK_RULES, CROSSFADE_SECONDS, MIN_SFX_SPACING_SECONDS, SFX_AFTER_SPEECH_SECONDS, spreadEmotions, refrainTurns, planFilmCues, layFilmSoundtrack, validateFilmSoundtrack, electFilmSoundtrackAssets, soundtrackAssetsHash, writeSoundtrackInputs, soundtrackOptions };
