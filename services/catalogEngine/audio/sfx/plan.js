/**
 * The sound-cue plan — placement over the CLOSED library (ab-1,
 * docs/AUDIOBOOK_V2_PLAN.md §4.6). PURE: a function of the segments (their
 * lines), the book's beats, the theme, the personalization evidence, the
 * band and the library file.
 *
 * Per spread the candidate set is the union of: the evidence declared on
 * that spread (an `object`/`food`/… value that names a cue keyword —
 * highest priority), the beat's whole-word keyword hits (second), the
 * spread text's whole-word keyword hits with the verbatim names masked
 * (third). The pick is bounded by the band quota, priority first, a seeded
 * shuffle for ties only. Rules: never anchored on a refrain line, anchors
 * ≥ 2 lines apart, a `startle` cue never under 4-5 and always −6 dB, the
 * same cue at most twice per book, one ambience bed per theme, one page
 * turn between spreads.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fnv1a } = require('../../selection');

const LIBRARY_PATH = path.join(__dirname, '..', '..', 'data', 'audio', 'sfxCues.json');
const QUOTA = Object.freeze({ '1-3': 1, '4-5': 2, '6-7': 3, '8-10': 3 });
const PRIORITY = Object.freeze({ evidence: 0, beat: 1, text: 2, director: 3 });
const STARTLE_PENALTY_DB = -6;
const MAX_USES_PER_BOOK = 2;
const MIN_LINE_GAP = 2;

let _library = null;

/** @param {string} s @returns {string} */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Unicode-bounded whole-word/phrase regex (the companionOnSpread rule: \b is ASCII-only). */
function bounded(term, flags = 'iu') {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, flags);
}

/**
 * Load + validate the library once (unique cue ids, closed fields).
 * @returns {{version: string, ambience: object, pageTurn: object, cues: object[], hash: string, byId: Map<string, object>}}
 */
function loadSfxLibrary() {
  if (_library) return _library;
  const raw = fs.readFileSync(LIBRARY_PATH, 'utf8');
  const lib = JSON.parse(raw);
  if (!lib || !Array.isArray(lib.cues) || !lib.ambience || !lib.pageTurn) throw new Error('sfxCues.json: malformed library');
  const byId = new Map();
  for (const c of lib.cues) {
    if (!/^[a-z][a-z0-9_]+$/.test(String(c.cueId))) throw new Error(`sfxCues.json: bad cueId '${c.cueId}'`);
    if (byId.has(c.cueId)) throw new Error(`sfxCues.json: duplicate cueId '${c.cueId}'`);
    if (!Array.isArray(c.keywords) || c.keywords.length === 0) throw new Error(`sfxCues.json: cue '${c.cueId}' has no keywords`);
    if (!Array.isArray(c.bands) || c.bands.length === 0) throw new Error(`sfxCues.json: cue '${c.cueId}' has no bands`);
    if (typeof c.maxGainDb !== 'number' || c.maxGainDb > 0) throw new Error(`sfxCues.json: cue '${c.cueId}' maxGainDb must be ≤ 0`);
    if (typeof c.prompt !== 'string' || !c.prompt) throw new Error(`sfxCues.json: cue '${c.cueId}' has no prompt`);
    c.regexes = c.keywords.map(k => bounded(String(k).toLowerCase()));
    byId.set(c.cueId, c);
  }
  for (const [themeId, amb] of Object.entries(lib.ambience)) {
    if (!amb || !/^amb_[a-z_]+$/.test(String(amb.cueId))) throw new Error(`sfxCues.json: ambience for '${themeId}' has a bad cueId`);
  }
  _library = { ...lib, byId, hash: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12) };
  return _library;
}

/** Test hook. */
function resetSfxLibrary() { _library = null; }

/**
 * Text with every verbatim name masked out (whole word), lower-cased.
 * @param {string} text
 * @param {string[]} masks
 * @returns {string}
 */
function maskedText(text, masks) {
  let t = String(text || '');
  for (const m of [...new Set((masks || []).filter(Boolean).map(String))].sort((a, b) => b.length - a.length)) {
    if (!m.trim()) continue;
    t = t.replace(bounded(m, 'giu'), ' ');
  }
  return t.toLowerCase();
}

/**
 * Cues whose keywords occur in a text (whole word), filtered by theme/band.
 * @param {string} text already masked/lower-cased
 * @param {{cues: object[]}} library
 * @param {{themeId: string, band: string}} ctx
 * @returns {Array<{cue: object, keyword: string}>}
 */
function keywordHits(text, library, { themeId, band }) {
  const hits = [];
  if (!text) return hits;
  for (const cue of library.cues) {
    if (cue.themes && cue.themes.length > 0 && !cue.themes.includes(themeId)) continue;
    if (!cue.bands.includes(band)) continue;
    if (cue.startle && band === '1-3') continue;
    for (let i = 0; i < cue.regexes.length; i++) {
      if (cue.regexes[i].test(text)) { hits.push({ cue, keyword: cue.keywords[i] }); break; }
    }
  }
  return hits;
}

/**
 * The candidate cues for one spread segment, in priority order, before
 * the quota — the director may choose among these only.
 * @param {object} p
 * @param {{spread: number, lines: Array<{text: string, isRefrain: boolean}>}} p.segment
 * @param {{beat: string}|null} p.beat
 * @param {object[]} p.evidence personalization_evidence
 * @param {string[]} p.masks
 * @param {string} p.themeId
 * @param {string} p.band
 * @param {object} p.library
 * @returns {Array<{cueId: string, cue: object, source: string, anchorLine: number, keyword: string}>}
 */
function candidatesForSegment({ segment, beat, evidence, masks, themeId, band, library }) {
  const out = [];
  const seen = new Set();
  const lines = segment.lines || [];
  const lineText = lines.map(l => maskedText(l.text, masks));
  const anchorFor = (regex, fallback) => {
    for (let i = 0; i < lineText.length; i++) if (!lines[i].isRefrain && regex.test(lineText[i])) return i;
    return fallback;
  };
  const middle = Math.max(0, Math.floor((lines.length - 1) / 2));
  const push = (hit, source, anchorLine) => {
    if (seen.has(hit.cue.cueId)) return;
    seen.add(hit.cue.cueId);
    out.push({ cueId: hit.cue.cueId, cue: hit.cue, source, anchorLine, keyword: hit.keyword });
  };
  // 1. Evidence declared on this spread (the value itself names the cue).
  for (const ev of (evidence || []).filter(e => e && e.spread === segment.spread)) {
    const value = String(ev.source_value || '').toLowerCase();
    for (const hit of keywordHits(value, library, { themeId, band })) {
      const valueRe = bounded(String(ev.source_value || ''), 'iu');
      const anchor = anchorFor(valueRe, anchorFor(hit.cue.regexes[hit.cue.keywords.indexOf(hit.keyword)], lines.length - 1));
      push(hit, 'evidence', anchor);
    }
  }
  // 2. The beat's own words.
  if (beat && beat.beat) {
    for (const hit of keywordHits(maskedText(beat.beat, masks), library, { themeId, band })) {
      const re = hit.cue.regexes[hit.cue.keywords.indexOf(hit.keyword)];
      push(hit, 'beat', anchorFor(re, middle));
    }
  }
  // 3. The spread text.
  for (let i = 0; i < lineText.length; i++) {
    if (lines[i].isRefrain) continue;
    for (const hit of keywordHits(lineText[i], library, { themeId, band })) push(hit, 'text', i);
  }
  return out.filter(c => !lines[c.anchorLine] || !lines[c.anchorLine].isRefrain);
}

/**
 * Annotate every segment with its ambience bed and its sound cues.
 * @param {object} p
 * @param {object[]} p.segments ordered (lines already built)
 * @param {{beats: Array<{spread: number, beat: string}>}} p.book
 * @param {{theme_id?: string, themeId?: string}} p.theme
 * @param {string} p.band
 * @param {object[]} [p.evidence]
 * @param {string[]} [p.masks] verbatim names never matched as keywords
 * @param {string} [p.seedBasis]
 * @param {{ambience?: boolean, pageTurn?: boolean, spots?: boolean}} [p.options]
 * @param {object} [p.library]
 * @param {Object<number, string[]>} [p.directorPicks] spread → cue ids the director chose (validated against the candidates)
 * @returns {{segments: object[], pageTurn: object|null, placed: object[], skipped: object[], libraryHash: string}}
 */
function planSfx({ segments, book, theme, band, evidence = [], masks = [], seedBasis = '', options = {}, library, directorPicks = null }) {
  const lib = library || loadSfxLibrary();
  const themeId = theme.theme_id || theme.themeId;
  const wantAmbience = options.ambience !== false;
  const wantSpots = options.spots !== false;
  const amb = wantAmbience && lib.ambience[themeId] ? { cueId: lib.ambience[themeId].cueId, gainDb: lib.ambience[themeId].gainDb } : null;
  const quota = QUOTA[band] || 2;
  const uses = new Map();
  const placed = [];
  const skipped = [];
  const beats = new Map((book.beats || []).map(b => [b.spread, b]));
  for (const seg of segments) {
    seg.ambience = amb;
    seg.sfx = [];
    if (seg.kind !== 'spread' || !wantSpots) continue;
    let candidates = candidatesForSegment({ segment: seg, beat: beats.get(seg.spread) || null, evidence, masks, themeId, band, library: lib });
    if (directorPicks && Array.isArray(directorPicks[seg.spread])) {
      const chosen = new Set(directorPicks[seg.spread]);
      const promoted = candidates.filter(c => chosen.has(c.cueId)).map(c => ({ ...c, source: 'director' }));
      const rest = candidates.filter(c => !chosen.has(c.cueId));
      candidates = [...promoted, ...rest];
    }
    candidates.sort((a, b) => {
      const pa = a.source === 'director' ? -1 : PRIORITY[a.source];
      const pb = b.source === 'director' ? -1 : PRIORITY[b.source];
      if (pa !== pb) return pa - pb;
      return fnv1a(`${seedBasis}|${seg.spread}|${a.cueId}`) - fnv1a(`${seedBasis}|${seg.spread}|${b.cueId}`);
    });
    const anchors = [];
    for (const c of candidates) {
      if (seg.sfx.length >= quota) { skipped.push({ spread: seg.spread, cueId: c.cueId, reason: 'quota' }); continue; }
      if ((uses.get(c.cueId) || 0) >= MAX_USES_PER_BOOK) { skipped.push({ spread: seg.spread, cueId: c.cueId, reason: 'max_uses' }); continue; }
      if (anchors.some(a => Math.abs(a - c.anchorLine) < MIN_LINE_GAP) && seg.lines.length >= 4) { skipped.push({ spread: seg.spread, cueId: c.cueId, reason: 'spacing' }); continue; }
      if (anchors.includes(c.anchorLine)) { skipped.push({ spread: seg.spread, cueId: c.cueId, reason: 'spacing' }); continue; }
      const gainDb = Math.min(0, c.cue.maxGainDb + (c.cue.startle ? STARTLE_PENALTY_DB : 0));
      seg.sfx.push({ cueId: c.cueId, anchorLine: c.anchorLine, placement: 'after', gainDb, source: c.source, seconds: c.cue.seconds });
      anchors.push(c.anchorLine);
      uses.set(c.cueId, (uses.get(c.cueId) || 0) + 1);
      placed.push({ segment: seg.index, spread: seg.spread, cueId: c.cueId, anchorLine: c.anchorLine, source: c.source, keyword: c.keyword, gainDb });
    }
  }
  const pageTurn = options.pageTurn !== false && lib.pageTurn ? { cueId: lib.pageTurn.cueId, gainDb: lib.pageTurn.gainDb, seconds: lib.pageTurn.seconds } : null;
  return { segments, pageTurn, placed, skipped, libraryHash: lib.hash };
}

/**
 * Check the placement invariants of annotated segments.
 * @param {object[]} segments
 * @param {string} band
 * @param {object} [library]
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateSfxPlan(segments, band, library) {
  const lib = library || loadSfxLibrary();
  const errors = [];
  const quota = QUOTA[band] || 2;
  const uses = new Map();
  for (const seg of segments) {
    const sfx = Array.isArray(seg.sfx) ? seg.sfx : [];
    if (seg.kind !== 'spread' && sfx.length) errors.push(`segment ${seg.index} (${seg.kind}) carries sound cues`);
    if (sfx.length > quota) errors.push(`spread ${seg.spread} exceeds the band quota (${sfx.length} > ${quota})`);
    const anchors = [];
    for (const s of sfx) {
      const cue = lib.byId.get(s.cueId);
      if (!cue) { errors.push(`unknown cue ${s.cueId}`); continue; }
      if (!cue.bands.includes(band)) errors.push(`cue ${s.cueId} is not allowed in band ${band}`);
      if (cue.startle && band === '1-3') errors.push(`startle cue ${s.cueId} in band 1-3`);
      if (cue.startle && s.gainDb > cue.maxGainDb + STARTLE_PENALTY_DB) errors.push(`startle cue ${s.cueId} is not attenuated`);
      if (s.gainDb > cue.maxGainDb) errors.push(`cue ${s.cueId} exceeds its maxGainDb`);
      const line = seg.lines && seg.lines[s.anchorLine];
      if (!line) errors.push(`cue ${s.cueId} anchors on a missing line`);
      else if (line.isRefrain) errors.push(`cue ${s.cueId} anchors on the refrain (spread ${seg.spread})`);
      if (anchors.includes(s.anchorLine)) errors.push(`two cues anchor on line ${s.anchorLine} of spread ${seg.spread}`);
      anchors.push(s.anchorLine);
      uses.set(s.cueId, (uses.get(s.cueId) || 0) + 1);
    }
  }
  for (const [cueId, n] of uses) if (n > MAX_USES_PER_BOOK) errors.push(`cue ${cueId} is placed ${n} times (max ${MAX_USES_PER_BOOK})`);
  return { ok: errors.length === 0, errors };
}

module.exports = { QUOTA, PRIORITY, STARTLE_PENALTY_DB, MAX_USES_PER_BOOK, MIN_LINE_GAP, LIBRARY_PATH, loadSfxLibrary, resetSfxLibrary, maskedText, keywordHits, candidatesForSegment, planSfx, validateSfxPlan, bounded };
