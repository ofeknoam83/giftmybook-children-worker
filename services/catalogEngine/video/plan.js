/**
 * Film plan (gift video, gv-2 — docs/GIFT_VIDEO_PLAN.md, revision 4).
 *
 * The film is ONE continuous shot: the child advances through the picked
 * illustrations (the still-selection gate's best stills, in story order)
 * as one unbroken take while the camera angle changes along the way. A
 * pure function from the picked scenes + the book's pinned plans to the
 * plan: one 10-second segment carrying one ACT per scene — its time window,
 * a camera ANGLE from a closed vocabulary (keyed by the spread's assigned
 * shot type, made distinct across the acts), and the camera MOVE that
 * carries the take from the previous angle to this one. Same inputs, same
 * plan, forever — no model output and no free text ever enters here.
 *
 * gv-1's per-moment clips (cover + opening + peak + resolution, crossfaded)
 * are gone: they cost four to sixteen vendor clips per film and never read
 * as one story. `pickStorySpreads` survives ONLY as the fallback for a book
 * whose renders all carry painted text (an embedded book has no text-free
 * stills to choose from, so the arc trio is re-rendered text-free instead).
 */

const TOTAL_SECONDS = 10.0;
const FADE_SECONDS = 0.5;

/** Closed camera-angle vocabulary: each act of the single take is filmed from one of these. */
const ANGLES = {
  wide: 'a wide establishing angle, the whole scene around the child',
  'eye-level': 'an eye-level angle beside the child, tracking alongside as the child moves',
  'low-angle': 'a low angle looking slightly up at the child, the world rising tall behind',
  overhead: 'a high angle looking down over the scene, the child small in the space',
  close: 'a close angle on the child\'s face and shoulders, the scene soft behind',
};
/** Rotation order when an act needs a distinct angle. */
const ANGLE_ORDER = ['wide', 'eye-level', 'low-angle', 'overhead', 'close'];
/** Band 1-3 menu: calm, no vertigo. */
const ANGLES_YOUNG = ['wide', 'eye-level', 'close'];

/** Closed camera-move vocabulary: how the take travels INTO an act's angle. */
const MOVES = {
  'push-in': 'pushes in slowly',
  glide: 'glides forward alongside the child',
  sweep: 'sweeps smoothly around the child in a slow arc',
  rise: 'rises and drifts higher',
  'pull-out': 'pulls back slowly to reveal more of the scene',
};
const MOVES_YOUNG = ['push-in', 'glide', 'pull-out'];

/** Fixed tie order for the peak spread among 5..10 (embedded fallback only). */
const PEAK_PREFERENCE = [8, 9, 7, 10, 6, 5];
const INTENSITY_RANK = { big: 3, clear: 2, soft: 1 };

/** Camera angle per shot type (pinned data → closed vocabulary). */
function angleForShot(entry) {
  switch (entry && entry.shotType) {
    case 'wide': return 'wide';
    case 'medium': return 'eye-level';
    case 'close-up': return 'close';
    case 'overhead': return 'overhead';
    case 'low-angle': return 'low-angle';
    default: return null;
  }
}

/** The move that carries the take into an angle. */
function moveInto(angle, young) {
  const move = { wide: 'pull-out', 'eye-level': 'glide', 'low-angle': 'sweep', overhead: 'rise', close: 'push-in' }[angle] || 'push-in';
  if (young && !MOVES_YOUNG.includes(move)) return 'glide';
  return move;
}

/**
 * The seconds a provider is asked for: the whole take is used, so the
 * request is the plan's seconds rounded up (Kling takes whole seconds from 3).
 * @param {number} seconds
 * @returns {number}
 */
function requestedClipSeconds(seconds) {
  return Math.max(3, Math.ceil(seconds));
}

/**
 * Split the take into `n` equal time windows (tenths of a second).
 * @param {number} n
 * @param {number} [total]
 * @returns {Array<{from: number, to: number}>}
 */
function actWindows(n, total = TOTAL_SECONDS) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const from = Math.round((total * i / n) * 10) / 10;
    const to = i === n - 1 ? total : Math.round((total * (i + 1) / n) * 10) / 10;
    out.push({ from, to });
  }
  return out;
}

/**
 * EMBEDDED FALLBACK ONLY — the story-arc trio from the spreads the caller
 * has renders for: opening (lowest in 1..4), peak (highest planned emotion
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
 * Build the film plan: one continuous take through the picked scenes.
 * @param {object} p
 * @param {number[]} p.scenes picked spreads (story order is enforced here)
 * @param {Object<number, {emotion: string, intensity: string}>|null} [p.emotionPlan]
 * @param {Object<number, {shotType: string, placement?: string|null}>|null} [p.shotPlan]
 * @param {string} [p.ageBand]
 * @param {number} [p.seconds] total seconds (default TOTAL_SECONDS)
 * @returns {{segments: Array<{index: number, kind: 'journey', spread: null, spreads: number[], seconds: number, requestedSeconds: number, motion: 'journey', acts: Array<{index: number, spread: number, from: number, to: number, angle: string, angleText: string, move: string, moveText: string, shotType: string|null, emotion: object|null}>}>, totalSeconds: number, fadeSeconds: number}}
 */
function buildFilmPlan(p) {
  const scenes = [...new Set((p.scenes || []).filter(n => Number.isInteger(n) && n >= 1 && n <= 12))].sort((a, b) => a - b);
  const seconds = Number.isFinite(p.seconds) && p.seconds > 0 ? p.seconds : TOTAL_SECONDS;
  if (scenes.length === 0) return { segments: [], totalSeconds: 0, fadeSeconds: FADE_SECONDS };
  const young = p.ageBand === '1-3';
  const menu = young ? ANGLES_YOUNG : ANGLE_ORDER;
  const windows = actWindows(scenes.length, seconds);
  const used = [];
  const acts = scenes.map((spread, i) => {
    const entry = p.shotPlan ? p.shotPlan[spread] || null : null;
    let angle = angleForShot(entry);
    if (!angle || !menu.includes(angle) || used.includes(angle)) {
      // Distinct angles across the take: the first unused entry of the
      // menu, rotated from the act's position so a plan-less run still
      // changes angle every act.
      angle = menu.slice(i).concat(menu.slice(0, i)).find(a => !used.includes(a)) || menu[i % menu.length];
    }
    used.push(angle);
    const move = i === 0 ? (young ? 'push-in' : (angle === 'wide' ? 'push-in' : 'glide')) : moveInto(angle, young);
    return {
      index: i,
      spread,
      from: windows[i].from,
      to: windows[i].to,
      angle,
      angleText: ANGLES[angle],
      move,
      moveText: MOVES[move],
      shotType: entry ? entry.shotType : null,
      emotion: p.emotionPlan && p.emotionPlan[spread] ? p.emotionPlan[spread] : null,
    };
  });
  const segment = {
    index: 0,
    kind: 'journey',
    spread: null,
    spreads: scenes,
    seconds,
    requestedSeconds: requestedClipSeconds(seconds),
    motion: 'journey',
    acts,
  };
  return { segments: [segment], totalSeconds: seconds, fadeSeconds: FADE_SECONDS };
}

module.exports = {
  buildFilmPlan,
  pickStorySpreads,
  angleForShot,
  moveInto,
  actWindows,
  requestedClipSeconds,
  TOTAL_SECONDS,
  FADE_SECONDS,
  ANGLES,
  ANGLE_ORDER,
  ANGLES_YOUNG,
  MOVES,
  MOVES_YOUNG,
  PEAK_PREFERENCE,
};
