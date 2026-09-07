/**
 * The music plan — per-book cue assignment over the per-theme suite
 * (ab-1, docs/AUDIOBOOK_V2_PLAN.md §4.5). PURE: a function of the ordered
 * segments, the pinned emotion plan, the band and the refrain spreads.
 *
 * Invariants (unit-tested over every catalog book × band):
 *  - the intro and spread 1 sit under `theme_intro`; spread 12 and the
 *    outro under `lullaby_outro`;
 *  - a body cue holds ≥ 2 spreads (no per-spread flip-flop) — a change is
 *    never proposed on spread 11, which would hold one spread before the
 *    forced ending;
 *  - the total number of cue changes (the two forced boundaries included)
 *    is ≤ MAX_CHANGES for the band;
 *  - band 1-3 never hears `gentle_tension`;
 *  - every refrain spread carries `motif: true` — the timeline places the
 *    `refrain_motif` sting 1.5 s before the refrain line.
 */

const CUES = Object.freeze(['theme_intro', 'calm', 'playful', 'wonder', 'tender', 'gentle_tension', 'triumph', 'lullaby_outro']);
const MOTIF_CUE = 'refrain_motif';
/** Total cue changes per book (the intro→body and body→outro boundaries count). */
const MAX_CHANGES = Object.freeze({ '1-3': 3, default: 5 });
/** The bed's gap-level gain (dB re. the voice target); ducking under speech is the mixer's. */
const BASE_GAIN_DB = Object.freeze({ '1-3': -17, default: -14 });
/** The motif's gain and lead before the refrain line. */
const MOTIF_GAIN_DB = -12;
const MOTIF_LEAD_SECONDS = 1.5;

/**
 * The cue an (emotion, intensity) pair maps to on a given spread.
 * @param {{emotion: string, intensity: string}} entry
 * @param {number} spread
 * @param {string} band
 * @returns {string}
 */
function cueFor(entry, spread, band) {
  const emotion = entry && entry.emotion;
  switch (emotion) {
    case 'joy':
    case 'silly':
      return 'playful';
    case 'wonder':
    case 'curiosity':
    case 'surprise':
      return 'wonder';
    case 'calm':
      return 'calm';
    case 'tenderness':
      return 'tender';
    case 'determination':
    case 'pride':
      return spread >= 9 ? 'triumph' : 'wonder';
    case 'worry':
      return band === '1-3' ? 'wonder' : 'gentle_tension';
    default:
      return 'calm';
  }
}

/**
 * Assign a cue to every segment (annotates `segment.music`) and return the
 * cue spans in order.
 * @param {object} p
 * @param {Array<{index: number, kind: string, spread: number|null}>} p.segments ordered
 * @param {Object<number, {emotion: string, intensity: string}>} p.emotionPlan per spread
 * @param {string} p.band
 * @param {number[]} [p.refrainSpreads]
 * @returns {{segments: object[], spans: Array<{cue: string, segments: number[], spreads: number[]}>, changes: number}}
 */
function planMusic({ segments, emotionPlan, band, refrainSpreads = [] }) {
  const cap = MAX_CHANGES[band] || MAX_CHANGES.default;
  const gainDb = BASE_GAIN_DB[band] ?? BASE_GAIN_DB.default;
  const refrain = new Set(refrainSpreads);
  let current = 'theme_intro';
  let heldSince = 1;
  let changes = 0;
  const spans = [];
  const open = (cue, seg) => { spans.push({ cue, segments: [seg.index], spreads: seg.spread ? [seg.spread] : [] }); };
  const extend = (seg) => { const s = spans[spans.length - 1]; s.segments.push(seg.index); if (seg.spread) s.spreads.push(seg.spread); };

  for (const seg of segments) {
    let cue;
    let change = false;
    if (seg.kind === 'intro' || seg.kind === 'dedication') {
      cue = 'theme_intro';
    } else if (seg.kind === 'outro') {
      cue = 'lullaby_outro';
      change = current !== cue;
    } else {
      const s = seg.spread;
      if (s === 1) {
        cue = 'theme_intro';
      } else if (s === 12) {
        cue = 'lullaby_outro';
        change = current !== cue;
      } else {
        const proposed = cueFor(emotionPlan && emotionPlan[s], s, band);
        if (s === 2) {
          cue = proposed;
          change = true;
          heldSince = 2;
        } else if (proposed !== current && s - heldSince >= 2 && s <= 10 && changes + 1 < cap) {
          // +1: the forced ending change is still to come and counts too.
          cue = proposed;
          change = true;
          heldSince = s;
        } else {
          cue = current;
        }
      }
    }
    if (change) changes += 1;
    if (spans.length === 0 || cue !== current) open(cue, seg); else extend(seg);
    current = cue;
    seg.music = { cue, change, gainDb, ...(seg.kind === 'spread' && refrain.has(seg.spread) ? { motif: true } : {}) };
  }
  return { segments, spans, changes };
}

/**
 * Check the invariants of an annotated segment list.
 * @param {object[]} segments
 * @param {string} band
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateMusicPlan(segments, band) {
  const errors = [];
  const cap = MAX_CHANGES[band] || MAX_CHANGES.default;
  const spreads = segments.filter(s => s.kind === 'spread');
  const first = spreads.find(s => s.spread === 1);
  const last = spreads.find(s => s.spread === 12);
  if (first && first.music.cue !== 'theme_intro') errors.push('spread 1 must sit under theme_intro');
  if (last && last.music.cue !== 'lullaby_outro') errors.push('spread 12 must sit under lullaby_outro');
  for (const s of segments) {
    if (!s.music || !CUES.includes(s.music.cue)) errors.push(`segment ${s.index} has no valid cue`);
    if (band === '1-3' && s.music && s.music.cue === 'gentle_tension') errors.push(`band 1-3 must never hear gentle_tension (spread ${s.spread})`);
  }
  const intro = segments.find(s => s.kind === 'intro');
  if (intro && intro.music.cue !== 'theme_intro') errors.push('the intro must sit under theme_intro');
  const outro = segments.find(s => s.kind === 'outro');
  if (outro && outro.music.cue !== 'lullaby_outro') errors.push('the outro must sit under lullaby_outro');
  // Hold rule on the body (spreads 2-11): every run of one cue spans ≥ 2 spreads.
  const body = spreads.filter(s => s.spread >= 2 && s.spread <= 11);
  let run = 0;
  for (let i = 0; i < body.length; i++) {
    run += 1;
    const next = body[i + 1];
    if (!next || next.music.cue !== body[i].music.cue) {
      if (run < 2) errors.push(`cue ${body[i].music.cue} holds only spread ${body[i].spread}`);
      run = 0;
    }
  }
  let changes = 0;
  let prev = null;
  for (const s of segments) {
    if (prev && s.music.cue !== prev) changes += 1;
    prev = s.music.cue;
  }
  if (changes > cap) errors.push(`${changes} cue changes exceed the band's cap of ${cap}`);
  return { ok: errors.length === 0, errors };
}

module.exports = { CUES, MOTIF_CUE, MAX_CHANGES, BASE_GAIN_DB, MOTIF_GAIN_DB, MOTIF_LEAD_SECONDS, cueFor, planMusic, validateMusicPlan };
