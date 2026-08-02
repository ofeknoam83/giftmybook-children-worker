/**
 * Onomatopoeia / sound-effect detector (2026-08-02 customer feedback:
 * "the onomatopoeias everywhere are not good (ex 'tap tap')").
 *
 * A sound word used as an ordinary verb is fine writing ("Maya tapped on
 * the little door"); a sound word used as an EFFECT is what the feedback
 * killed. Effect usage is machine-detectable, so this check flags only:
 *
 *   - reduplication:  "tap tap", "tap, tap", "tap-tap" (any word doubled
 *                     back-to-back where the base word is in the lexicon;
 *                     simple -s inflections count: "taps taps")
 *   - known pairs:    "tick tock", "pitter patter", "splish splash", …
 *   - exclamation:    "Whoosh!" — a lexicon word immediately followed by !
 *   - shouted caps:   "BOOM" — a lexicon word in ALL CAPS (3+ chars)
 *
 * Band routing (same shape as bannedWords): reduplication/pair hits are
 * `onomatopoeia` (HARD, demotable via BOOK_PIPELINE_V3_QA_HARD=0) for
 * PB_INFANT/PB_TODDLER/PB_PRESCHOOL and `onomatopoeia_soft` for
 * PB_EARLY_READER; exclamation/caps-only hits are always soft (they feed
 * revision notes and the book-level overuse lint, which allows at most ONE
 * sound-word moment per book).
 */

const LEXICON = require('../lexicons/soundWords.json');

const WORDS = new Set((LEXICON.words || []).map((w) => String(w).toLowerCase()));
const PAIRS = (LEXICON.pairs || []).map(([a, b]) => [String(a).toLowerCase(), String(b).toLowerCase()]);

const HARD_BANDS = new Set(['PB_INFANT', 'PB_TODDLER', 'PB_PRESCHOOL']);
const SOFT_BANDS = new Set(['PB_EARLY_READER']);

/** Lexicon membership, folding a simple plural/3rd-person -s ("taps"). */
function isSoundWord(token) {
  const t = String(token || '').toLowerCase();
  if (WORDS.has(t)) return true;
  return t.endsWith('s') && WORDS.has(t.slice(0, -1));
}

/**
 * Every sound-EFFECT event in a text.
 *
 * @param {string} text
 * @returns {Array<{ kind: 'reduplication'|'pair'|'exclamation'|'caps', match: string }>}
 */
function findOnomatopoeiaEvents(text) {
  const t = String(text || '');
  if (!t) return [];
  const events = [];
  const seen = new Set();
  const push = (kind, match) => {
    const key = `${kind}:${match.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push({ kind, match });
  };

  // Reduplication: the same word (2+ times) separated by spaces/commas/hyphens.
  const redup = t.matchAll(/\b([A-Za-z]+)(?:[\s,]*[-–—]?[\s,]*\1\b)+[!.]?/gi);
  for (const m of redup) {
    if (isSoundWord(m[1])) push('reduplication', m[0].trim());
  }

  // Known reduplicative pairs ("tick tock", "tick-tock").
  for (const [a, b] of PAIRS) {
    const m = t.match(new RegExp(`\\b${a}[\\s,]*[-–—]?[\\s,]*${b}\\b`, 'i'));
    if (m) push('pair', m[0]);
  }

  // Exclamation form: "Whoosh!" — the sound as an effect, not a verb.
  for (const m of t.matchAll(/\b([A-Za-z]+)!/g)) {
    if (isSoundWord(m[1])) push('exclamation', `${m[1]}!`);
  }

  // Shouted caps: "BOOM" (3+ chars, whole word). Skip tokens immediately
  // followed by ! — those are already captured by the exclamation detector
  // above, and counting them twice would incorrectly inflate the overuse tally.
  for (const m of t.matchAll(/\b([A-Z]{3,})\b/g)) {
    if (t[m.index + m[1].length] === '!') continue;
    if (isSoundWord(m[1])) push('caps', m[1]);
  }

  return events;
}

/**
 * Gate check: sound-effect onomatopoeia, band-routed.
 *
 * @param {{ text?: string }} draft
 * @param {null} beat - unused in V3
 * @param {object} ageProfile
 * @returns {{ passed: boolean, code?: string, message?: string, detail?: object }}
 */
function onomatopoeiaCheck(draft, beat, ageProfile) {
  const band = String(ageProfile?.ageBand || '');
  if (!HARD_BANDS.has(band) && !SOFT_BANDS.has(band)) return { passed: true };

  const events = findOnomatopoeiaEvents(draft?.text);
  if (!events.length) return { passed: true };

  const hardKinds = events.filter((e) => e.kind === 'reduplication' || e.kind === 'pair');
  const code = hardKinds.length && HARD_BANDS.has(band) ? 'onomatopoeia' : 'onomatopoeia_soft';
  const listed = events.map((e) => `"${e.match}"`).join(', ');
  return {
    passed: false,
    code,
    message: `sound-effect onomatopoeia machine-flagged: ${listed} — never repeat a sound word ("tap tap") or drop it in as an effect ("Whoosh!"); write the sound as a real action sentence instead ("Maya tapped twice on the little door", "the rocket whooshed past the moon")`,
    detail: { events, band },
  };
}

module.exports = { onomatopoeiaCheck, findOnomatopoeiaEvents, isSoundWord };
