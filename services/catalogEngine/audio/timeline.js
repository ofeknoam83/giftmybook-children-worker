/**
 * The timeline — PURE (ab-1, docs/AUDIOBOOK_V2_PLAN.md §3.5, §4.7). From the
 * selected takes' measured, trimmed durations (and the provider's line
 * alignment when it exists) the timeline places every chunk, every line,
 * every sound cue, every music span, the motifs and the page turns on one
 * clock. The mix graph is generated FROM it, so the file can never
 * disagree with the timeline; the app's read-along turns pages from it.
 *
 * Gaps: intro → 1.2 s; dedication → 1.0 s; between spreads 0.9 s (band
 * 1-3: 1.3 s); before the outro 1.2 s; the tail 2.5 s under the ending
 * cue; between chunks of one segment 0.25 s. A sound cue anchored on the
 * last line of a chunk widens the gap after it to fit; a mid-chunk anchor
 * never exists (narrate.js breaks a chunk after every anchored line).
 * Music changes land in the middle of a gap on a 3 s crossfade; the motif
 * fires 1.5 s before the refrain line; the page turn sits in the middle
 * of every gap between spreads.
 */

const { MOTIF_CUE, MOTIF_GAIN_DB, MOTIF_LEAD_SECONDS } = require('./music/plan');

const GAPS = Object.freeze({ intro: 1.2, dedication: 1.0, spread: 0.9, spreadYoung: 1.3, beforeOutro: 1.2, tail: 2.5, chunk: 0.25 });
const CROSSFADE_SECONDS = 3;
const SFX_AFTER_LINE_SECONDS = 0.15;
const SFX_GAP_FACTOR = 0.6;
const MIN_SFX_SPACING_SECONDS = 4;

const r3 = n => Math.round(n * 1000) / 1000;

/** @param {string} text @returns {number} */
function wordCount(text) {
  return String(text || '').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * Line timings inside one chunk: the provider alignment when present
 * (times relative to the untrimmed take), else word-share interpolation.
 * @param {{lineIndexes: number[], measure: {trim: {start: number}, trimmedSeconds: number}, alignment?: Array<{line: number, start: number, end: number}>|null}} chunk
 * @param {object[]} lines the segment's lines
 * @param {number} at the chunk's start on the clock
 * @returns {Array<{index: number, start: number, end: number}>}
 */
function lineTimes(chunk, lines, at) {
  const idx = chunk.lineIndexes;
  const dur = chunk.measure.trimmedSeconds;
  const trimStart = chunk.measure.trim ? chunk.measure.trim.start : 0;
  if (Array.isArray(chunk.alignment) && chunk.alignment.length === idx.length) {
    const out = idx.map((li, k) => {
      const a = chunk.alignment[k];
      return { index: li, start: r3(at + Math.max(0, a.start - trimStart)), end: r3(at + Math.max(0, Math.min(dur, a.end - trimStart))) };
    });
    if (out.every((t, k) => t.end >= t.start && (k === 0 || t.start >= out[k - 1].start))) return out;
  }
  const words = idx.map(li => Math.max(1, wordCount(lines[li].text)));
  const total = words.reduce((a, b) => a + b, 0);
  let cursor = at;
  return idx.map((li, k) => {
    const share = (words[k] / total) * dur;
    const t = { index: li, start: r3(cursor), end: r3(cursor + share) };
    cursor += share;
    return t;
  });
}

/**
 * Build the timeline.
 * @param {object} p
 * @param {object} p.script the audio script (segments with lines, music, sfx, ambience, pageTurn)
 * @param {Array<{index: number, chunks: Array<{chunk: number, speaker: string, lineIndexes: number[], storageKey: string, measure: object, alignment?: object[]|null}>}>} p.takes per segment, in order
 * @param {Object<string, {seconds?: number}>} [p.cueSeconds] sound cue durations by id
 * @param {{pageTurn?: boolean, motif?: boolean}} [p.options]
 * @returns {object} the timeline
 */
function buildTimeline({ script, takes, cueSeconds = {}, options = {} }) {
  const band = script.band;
  const byIndex = new Map(takes.map(t => [t.index, t]));
  const segments = [];
  let clock = 0;
  let prevKind = null;
  let prevSpread = null;
  const pageTurns = [];
  const motifs = [];
  const sfxOut = [];
  const pageTurnOn = options.pageTurn !== false && !!script.pageTurn;
  const motifOn = options.motif !== false;
  let lastSfxAt = -Infinity;

  for (const seg of script.segments) {
    const take = byIndex.get(seg.index);
    if (!take) continue;
    // The gap before this segment (widened by a sound cue anchored on the
    // previous segment's last line, computed when that segment closed).
    let gap = 0;
    if (prevKind === 'intro') gap = GAPS.intro;
    else if (prevKind === 'dedication') gap = GAPS.dedication;
    else if (prevKind === 'spread') gap = seg.kind === 'outro' ? GAPS.beforeOutro : (band === '1-3' ? GAPS.spreadYoung : GAPS.spread);
    if (segments.length) {
      const prev = segments[segments.length - 1];
      gap = Math.max(gap, prev.gapAfterMin || 0);
      if (pageTurnOn && prev.kind === 'spread' && seg.kind === 'spread') pageTurns.push({ at: r3(prev.end + gap / 2), afterSpread: prev.spread, cueId: script.pageTurn.cueId, gainDb: script.pageTurn.gainDb, seconds: script.pageTurn.seconds });
      clock = prev.end + gap;
    }
    const segStart = clock;
    const chunks = [];
    const lines = [];
    let gapAfterMin = 0;
    take.chunks.forEach((c, k) => {
      if (k > 0) clock += GAPS.chunk;
      const at = clock;
      const dur = c.measure.trimmedSeconds;
      chunks.push({ chunk: c.chunk, speaker: c.speaker, storageKey: c.storageKey, at: r3(at), seconds: r3(dur), trim: c.measure.trim, lufs: c.measure.lufs });
      for (const t of lineTimes(c, seg.lines, at)) lines.push({ ...t, text: seg.lines[t.index].text, speaker: seg.lines[t.index].speaker, isRefrain: !!seg.lines[t.index].isRefrain });
      clock += dur;
      // Sound cues anchored on this chunk's last line widen the gap that follows it.
      const lastLine = c.lineIndexes[c.lineIndexes.length - 1];
      for (const s of seg.sfx || []) {
        if (s.anchorLine !== lastLine) continue;
        const seconds = (cueSeconds[s.cueId] && cueSeconds[s.cueId].seconds) || s.seconds || 2;
        const at2 = r3(clock + SFX_AFTER_LINE_SECONDS);
        if (at2 - lastSfxAt < MIN_SFX_SPACING_SECONDS) continue;
        sfxOut.push({ segment: seg.index, spread: seg.spread, cueId: s.cueId, at: at2, gainDb: s.gainDb, seconds: r3(seconds), source: s.source, anchorLine: s.anchorLine });
        lastSfxAt = at2;
        const need = SFX_AFTER_LINE_SECONDS + seconds * SFX_GAP_FACTOR + 0.3;
        if (k === take.chunks.length - 1) gapAfterMin = Math.max(gapAfterMin, need);
        else clock += Math.max(0, need - GAPS.chunk);
      }
    });
    const segEnd = clock;
    if (motifOn && seg.music && seg.music.motif) {
      const refrain = lines.find(l => l.isRefrain);
      const floor = segments.length ? segments[segments.length - 1].end + 0.1 : 0;
      if (refrain) motifs.push({ at: r3(Math.max(floor, refrain.start - MOTIF_LEAD_SECONDS)), spread: seg.spread, cueId: MOTIF_CUE, gainDb: MOTIF_GAIN_DB });
    }
    segments.push({ index: seg.index, kind: seg.kind, spread: seg.spread, start: r3(segStart), end: r3(segEnd), chunks, lines, music: seg.music || null, gapAfterMin: r3(gapAfterMin) });
    prevKind = seg.kind;
    prevSpread = seg.spread;
  }
  const last = segments[segments.length - 1];
  const totalSeconds = r3((last ? last.end : 0) + GAPS.tail);

  // Music spans: consecutive segments under one cue; boundaries in the
  // middle of the gap, crossfaded.
  const music = [];
  for (const seg of segments) {
    if (!seg.music) continue;
    const cur = music[music.length - 1];
    if (cur && cur.cue === seg.music.cue) { cur.to = seg.end; cur.segments.push(seg.index); if (seg.spread) cur.spreads.push(seg.spread); continue; }
    music.push({ cue: seg.music.cue, from: seg.start, to: seg.end, gainDb: seg.music.gainDb, segments: [seg.index], spreads: seg.spread ? [seg.spread] : [] });
  }
  for (let i = 0; i < music.length; i++) {
    const prev = music[i - 1];
    const next = music[i + 1];
    if (prev) { const b = (prev.to + music[i].from) / 2; music[i].from = r3(Math.max(0, b - CROSSFADE_SECONDS / 2)); prev.to = r3(b + CROSSFADE_SECONDS / 2); }
    if (!next) music[i].to = totalSeconds;
    if (i === 0) music[i].from = 0;
    music[i].fadeIn = i === 0 ? 1 : CROSSFADE_SECONDS;
    music[i].fadeOut = next ? CROSSFADE_SECONDS : GAPS.tail;
  }

  const ambience = (script.segments.find(s => s.ambience) || {}).ambience || null;
  const spreads = segments.filter(s => s.kind === 'spread').map(s => ({ spread: s.spread, start: s.start, end: s.end, lines: s.lines.map(l => ({ index: l.index, start: l.start, end: l.end, text: l.text, speaker: l.speaker })), sfx: sfxOut.filter(x => x.segment === s.index).map(({ cueId, at, gainDb, seconds }) => ({ cueId, at, gainDb, seconds })), music: s.music ? { cue: s.music.cue, motif: !!s.music.motif } : null }));
  const chapters = segments.map(s => ({ title: s.kind === 'spread' ? `Spread ${s.spread}` : s.kind.charAt(0).toUpperCase() + s.kind.slice(1), start: s.start, end: s.end, spread: s.spread }));
  return {
    version: script.version,
    totalSeconds,
    segments: segments.map(({ gapAfterMin, ...rest }) => rest),
    spreads,
    chapters,
    music,
    motifs,
    sfx: sfxOut,
    pageTurns,
    ambience: ambience ? { cueId: ambience.cueId, gainDb: ambience.gainDb } : null,
    speechWindows: segments.flatMap(s => s.chunks.map(c => ({ start: c.at, end: r3(c.at + c.seconds), spread: s.spread }))),
  };
}

/**
 * Invariants of a built timeline.
 * @param {object} timeline
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateTimeline(timeline) {
  const errors = [];
  let prevEnd = -1;
  for (const seg of timeline.segments) {
    if (seg.start < prevEnd) errors.push(`segment ${seg.index} starts before the previous one ends`);
    if (seg.end < seg.start) errors.push(`segment ${seg.index} ends before it starts`);
    let cEnd = seg.start - 0.001;
    for (const c of seg.chunks) { if (c.at < cEnd) errors.push(`chunk ${c.chunk} of segment ${seg.index} overlaps`); cEnd = c.at + c.seconds; }
    for (const l of seg.lines) if (l.start < seg.start - 0.01 || l.end > seg.end + 0.01) errors.push(`line ${l.index} of segment ${seg.index} lies outside its segment`);
    prevEnd = seg.end;
  }
  for (const m of timeline.music) if (m.to <= m.from) errors.push(`music span ${m.cue} is empty`);
  const inSpeech = t => timeline.speechWindows.some(w => t > w.start + 0.05 && t < w.end - 0.05);
  for (const s of timeline.sfx) if (inSpeech(s.at)) errors.push(`sound cue ${s.cueId} at ${s.at}s starts over a spoken word`);
  for (const p of timeline.pageTurns) if (inSpeech(p.at)) errors.push(`page turn at ${p.at}s lands over speech`);
  for (let i = 1; i < timeline.sfx.length; i++) if (timeline.sfx[i].at - timeline.sfx[i - 1].at < MIN_SFX_SPACING_SECONDS - 0.001) errors.push(`sound cues closer than ${MIN_SFX_SPACING_SECONDS}s`);
  if (timeline.totalSeconds <= 0) errors.push('empty timeline');
  return { ok: errors.length === 0, errors };
}

/**
 * The spread playing at a time (the read-along's page).
 * @param {object} timeline
 * @param {number} t seconds
 * @returns {number|null}
 */
function spreadAt(timeline, t) {
  let current = null;
  for (const s of timeline.spreads) if (t >= s.start) current = s.spread;
  return current;
}

module.exports = { GAPS, CROSSFADE_SECONDS, SFX_AFTER_LINE_SECONDS, MIN_SFX_SPACING_SECONDS, lineTimes, buildTimeline, validateTimeline, spreadAt };
