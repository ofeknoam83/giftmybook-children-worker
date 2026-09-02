/**
 * Film plan (gift video, gv-1 — docs/GIFT_VIDEO_PLAN.md §4.1–4.2).
 *
 * A pure function from the book's pinned inputs to the 10-second film: which
 * moments (the approved cover coming alive, the opening spread, the emotional
 * peak, the resolution), how long each segment runs (a fixed duration table
 * per segment count so the total is exactly TOTAL_SECONDS after the
 * crossfades), and which camera move each clip is briefed with (a closed
 * vocabulary keyed by the spread's assigned shot type). Same inputs, same
 * plan, forever — no model output and no free text ever enters here.
 */

const TOTAL_SECONDS = 10.0;
const XFADE_SECONDS = 0.4;
const FADE_SECONDS = 0.5;

/** Seconds per segment, keyed by segment count: sum − overlaps === TOTAL_SECONDS. */
const DURATIONS = {
  1: [10.0],
  2: [4.2, 6.2],
  3: [2.6, 4.2, 4.0],
  4: [2.4, 3.0, 3.0, 2.8],
};

/** Closed camera-move vocabulary (the brief renders each as one sentence). */
const MOTIONS = ['push-in', 'pull-out', 'pan-left', 'pan-right', 'rise', 'hold'];
/** Band 1-3 menu: calm, slow. */
const MOTIONS_YOUNG = ['push-in', 'hold'];

/** Fixed tie order for the peak spread among 5..10. */
const PEAK_PREFERENCE = [8, 9, 7, 10, 6, 5];
const INTENSITY_RANK = { big: 3, clear: 2, soft: 1 };

/** Alternate move when two adjacent segments would repeat one. */
const ALTERNATE = { 'push-in': 'pull-out', 'pull-out': 'push-in', 'pan-left': 'pan-right', 'pan-right': 'pan-left', rise: 'push-in', hold: 'push-in' };
const ALTERNATE_YOUNG = { 'push-in': 'hold', hold: 'push-in' };

/** Camera move per shot type (pinned data → closed vocabulary). */
function motionForShot(entry, textLayout) {
  const shotType = entry && entry.shotType;
  switch (shotType) {
    case 'wide': return 'push-in';
    case 'close-up': return 'pull-out';
    case 'medium':
      if (entry.placement === 'left-third') return 'pan-left';
      if (entry.placement === 'right-third') return 'pan-right';
      return textLayout === 'half' ? 'pan-right' : 'push-in';
    case 'overhead': return 'rise';
    case 'low-angle': return 'push-in';
    default: return 'push-in';
  }
}

/**
 * The seconds a provider is asked for so `[0, seconds]` of the clip covers
 * the segment (Kling takes whole seconds from 3; the tail is discarded).
 * @param {number} seconds
 * @returns {number}
 */
function requestedClipSeconds(seconds) {
  return Math.max(3, Math.ceil(seconds) + 1);
}

/**
 * Choose the story spreads for the film from the ones the caller has
 * renders for: opening (lowest in 1..4), peak (highest planned emotion
 * intensity in 5..10, ties by PEAK_PREFERENCE), resolution (highest in
 * 11..12) — falling back to the nearest available spread for each role and
 * compressing to what exists.
 * @param {number[]} available spread numbers with renders
 * @param {Object<number, {emotion?: string, intensity?: string}>|null} emotionPlan
 * @returns {{spreads: number[], picks: {opening: number|null, peak: number|null, resolution: number|null}}}
 */
function pickStorySpreads(available, emotionPlan) {
  const story = [...new Set((available || []).filter(n => Number.isInteger(n) && n >= 1 && n <= 12))].sort((a, b) => a - b);
  const picks = { opening: null, peak: null, resolution: null };
  if (story.length === 0) return { spreads: [], picks };
  if (story.length <= 2) {
    picks.opening = story[0];
    if (story.length === 2) picks.resolution = story[1];
    return { spreads: story, picks };
  }
  picks.opening = story.find(n => n <= 4) ?? story[0];
  picks.resolution = [...story].reverse().find(n => n >= 11 && n !== picks.opening) ?? story[story.length - 1];
  const middle = story.filter(n => n !== picks.opening && n !== picks.resolution);
  const intensity = (n) => {
    const e = emotionPlan && emotionPlan[n];
    return e && INTENSITY_RANK[e.intensity] ? INTENSITY_RANK[e.intensity] : 0;
  };
  const rank = (n) => {
    const pref = PEAK_PREFERENCE.indexOf(n);
    // Inside 5..10 the fixed preference order breaks ties; outside it the
    // spread closest to 8 wins, after every in-range spread.
    return pref >= 0 ? pref : 100 + Math.abs(8 - n);
  };
  picks.peak = middle.slice().sort((a, b) => intensity(b) - intensity(a) || rank(a) - rank(b))[0] ?? null;
  const spreads = [picks.opening, picks.peak, picks.resolution].filter(n => Number.isInteger(n));
  return { spreads: [...new Set(spreads)].sort((a, b) => a - b), picks };
}

/**
 * Build the film plan.
 * @param {object} p
 * @param {number[]} p.available spreads the caller has renders for
 * @param {'cover'|'photo'|null} p.coverKind 'cover' when the anchor is an approved cover (the only kind that opens the film)
 * @param {Object<number, {emotion: string, intensity: string}>|null} [p.emotionPlan]
 * @param {Object<number, {shotType: string, placement?: string|null}>|null} [p.shotPlan]
 * @param {string} [p.textLayout]
 * @param {string} [p.ageBand]
 * @returns {{segments: Array<{index: number, kind: 'cover'|'spread', spread: number|null, seconds: number, requestedSeconds: number, motion: string, shotType: string|null}>, totalSeconds: number, xfadeSeconds: number, fadeSeconds: number, picks: object}}
 */
function buildFilmPlan(p) {
  const { spreads, picks } = pickStorySpreads(p.available, p.emotionPlan || null);
  // A cover alone is not a story summary: no story spreads → no film.
  if (spreads.length === 0) return { segments: [], totalSeconds: 0, xfadeSeconds: XFADE_SECONDS, fadeSeconds: FADE_SECONDS, picks };
  const kinds = [];
  if (p.coverKind === 'cover') kinds.push({ kind: 'cover', spread: null });
  for (const s of spreads) kinds.push({ kind: 'spread', spread: s });
  const young = p.ageBand === '1-3';
  const table = DURATIONS[kinds.length];
  if (!table) return { segments: [], totalSeconds: 0, xfadeSeconds: XFADE_SECONDS, fadeSeconds: FADE_SECONDS, picks };
  const segments = [];
  let prev = null;
  kinds.forEach((k, i) => {
    const entry = k.kind === 'spread' && p.shotPlan ? p.shotPlan[k.spread] || null : null;
    let motion = k.kind === 'cover' ? 'push-in' : motionForShot(entry, p.textLayout);
    if (young && !MOTIONS_YOUNG.includes(motion)) motion = 'push-in';
    if (motion === prev) motion = (young ? ALTERNATE_YOUNG : ALTERNATE)[motion] || 'push-in';
    prev = motion;
    segments.push({
      index: i,
      kind: k.kind,
      spread: k.spread,
      seconds: table[i],
      requestedSeconds: requestedClipSeconds(table[i]),
      motion,
      shotType: entry ? entry.shotType : null,
    });
  });
  const sum = segments.reduce((a, s) => a + s.seconds, 0) - XFADE_SECONDS * (segments.length - 1);
  return { segments, totalSeconds: Math.round(sum * 1000) / 1000, xfadeSeconds: XFADE_SECONDS, fadeSeconds: FADE_SECONDS, picks };
}

module.exports = {
  buildFilmPlan,
  pickStorySpreads,
  motionForShot,
  requestedClipSeconds,
  TOTAL_SECONDS,
  XFADE_SECONDS,
  FADE_SECONDS,
  DURATIONS,
  MOTIONS,
  MOTIONS_YOUNG,
  PEAK_PREFERENCE,
};
