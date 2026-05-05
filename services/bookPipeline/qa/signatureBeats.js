/**
 * PR Y — Signature beats: the highest-priority emotional anchors from the
 * questionnaire. These are the answers a parent typed by hand that make the
 * book feel like *their* child rather than a stock template:
 *
 *   - funny_thing            (e.g. "bites mom's chin")
 *   - meaningful_moment      (e.g. "first time she squealed at the bath")
 *   - moms_favorite_moment   (parent-side memory)
 *   - dads_favorite_moment   (parent-side memory)
 *   - calls_mom              (e.g. "Mama", "Mommy", "Ima")
 *   - calls_dad              (e.g. "Dada", "Abba")
 *   - anything_else          (free-text "anything we missed" — often a nickname like "smushy")
 *
 * The legacy generic personalization-saturation gate (60% of all items hit)
 * happily passed Scarlett's book at 50% landed because the half it missed
 * was *every emotional anchor* — the gate counted "interest: walks" as
 * landed and gave the writer credit. Per-anchor coverage closes that gap:
 * each signature beat must surface in at least one spread or the book fails
 * with a tag the rewrite loop can act on.
 *
 * The module is deliberately framework-free (no LLM, no I/O) so it is cheap
 * to run inside checkWriterDraft and trivial to unit-test.
 */

const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'to', 'in', 'on', 'at', 'is', 'it', 'for',
  'with', 'her', 'his', 'my', 'our', 'their', 'i', 'me', 'we', 'you', 'be',
  'as', 'by', 'or', 'so', 'do', 'does', 'did', 'has', 'have', 'had',
  'this', 'that', 'these', 'those', 'one', 'two', 'three', 'all',
  // Pronouns and copulas the legacy saturation gate also strips out —
  // these would otherwise let a beat "land" on an empty pronoun match.
  'she', 'he', 'they', 'them', 'him', 'who', 'whom', 'whose',
  'was', 'were', 'are', 'am', 'been', 'being',
  // Common questionnaire filler that shouldn't anchor a beat by itself.
  'thing', 'things', 'something', 'anything', 'really', 'very', 'just',
  'also', 'when', 'while', 'always', 'sometimes', 'often', 'every',
]);

// Order matters: opening / peak / closing allocation walks this list.
const SIGNATURE_TEXT_KEYS = [
  'meaningful_moment',
  'moms_favorite_moment',
  'dads_favorite_moment',
  'funny_thing',
  'anything_else',
];

const SIGNATURE_ADDRESS_KEYS = ['calls_mom', 'calls_dad'];

/**
 * Tokenize free-text into content-word "signal" tokens (≥3 chars, no
 * stopwords). Used both to label a beat and to detect whether it landed
 * in the manuscript.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function signalTokens(text) {
  const tokens = String(text || '').toLowerCase().match(/[a-z']+/g) || [];
  const out = new Set();
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/**
 * Pull the structured signature beats from a brief. Returns a deterministic,
 * order-stable array so test assertions stay sharp. Each beat carries:
 *   - key:       questionnaire field name
 *   - kind:      'text' | 'address'
 *   - text:      original answer (trimmed)
 *   - keywords:  Set<string> of signal tokens for landed-in-manuscript checks
 *
 * Address-form beats (`calls_mom`, `calls_dad`) are special: a single short
 * word ("Mama", "Ima") that must appear verbatim somewhere in the book.
 *
 * Empty / whitespace-only fields are skipped. Address forms whose value is
 * the same as the corresponding parent name field (e.g. `calls_mom = mom_name`)
 * still count — it's the address word the writer is supposed to use.
 *
 * @param {{ child?: object, customDetails?: object }} brief
 * @returns {Array<{ key:string, kind:'text'|'address', text:string, keywords:Set<string> }>}
 */
function extractSignatureBeats(brief) {
  const child = (brief && brief.child) || {};
  const customDetails = (brief && brief.customDetails) || {};
  const anecdotes = (child.anecdotes && typeof child.anecdotes === 'object') ? child.anecdotes : {};
  const beats = [];

  const readField = (k) => {
    const fromAnec = typeof anecdotes[k] === 'string' ? anecdotes[k].trim() : '';
    if (fromAnec) return fromAnec;
    const fromCustom = typeof customDetails[k] === 'string' ? customDetails[k].trim() : '';
    return fromCustom || '';
  };

  for (const k of SIGNATURE_TEXT_KEYS) {
    const text = readField(k);
    if (!text) continue;
    const keywords = signalTokens(text);
    if (keywords.size === 0) continue; // nothing matchable — ignore.
    beats.push({ key: k, kind: 'text', text, keywords });
  }

  for (const k of SIGNATURE_ADDRESS_KEYS) {
    const text = readField(k);
    if (!text) continue;
    // Address forms match on the literal word ("mama", "ima"). Strip
    // anything beyond the first word — parents sometimes write "Mama (most
    // of the time)" or "Mommy / Mom".
    const head = text.toLowerCase().match(/[a-z']+/g);
    if (!head || !head.length) continue;
    const keywords = new Set([head[0]]);
    beats.push({ key: k, kind: 'address', text, keywords });
  }

  return beats;
}

/**
 * Build a lowercase token set from all spread manuscript text. Keeps this
 * module independent of checkWriterDraft's internal helpers.
 *
 * @param {Array<{ manuscript?: { text?: string } }>} spreads
 * @returns {{ corpusTokens: Set<string>, perSpreadTokens: Map<number, Set<string>> }}
 */
function tokenizeSpreads(spreads) {
  const corpusTokens = new Set();
  const perSpreadTokens = new Map();
  for (const s of spreads || []) {
    const text = String(s?.manuscript?.text || '').toLowerCase();
    const tokens = new Set(text.match(/[a-z']+/g) || []);
    perSpreadTokens.set(s?.spreadNumber, tokens);
    for (const t of tokens) corpusTokens.add(t);
  }
  return { corpusTokens, perSpreadTokens };
}

/**
 * Check that EVERY signature beat lands in at least one spread.
 *
 * Returns:
 *   - beats:   the extracted beats (so callers can render diagnostics)
 *   - missing: beats that didn't land anywhere
 *   - landed:  beats that did land
 *   - assignments: spreadNumber[] suggested as repair targets for missing
 *                  beats — opening (1), peak (~middle), closing (last) by
 *                  default. Empty when nothing is missing or when there are
 *                  no spreads to assign to.
 *
 * The threshold is implicitly 100% per beat — we don't tolerate ANY missing
 * signature beat. The 60% generic threshold remains in place for non-anchor
 * items (interests, favorite_food, …) via checkPersonalizationSaturation.
 *
 * @param {{ child?: object, customDetails?: object }} brief
 * @param {Array<{ spreadNumber:number, manuscript?:{ text?:string } }>} spreads
 * @returns {{ beats:Array, landed:Array, missing:Array, assignments:number[] }}
 */
function checkSignatureBeatCoverage(brief, spreads) {
  const beats = extractSignatureBeats(brief);
  if (beats.length === 0) {
    return { beats: [], landed: [], missing: [], assignments: [] };
  }
  const { corpusTokens } = tokenizeSpreads(spreads);
  const landed = [];
  const missing = [];
  for (const beat of beats) {
    let hit = false;
    for (const k of beat.keywords) {
      if (corpusTokens.has(k)) { hit = true; break; }
    }
    if (hit) landed.push(beat);
    else missing.push(beat);
  }

  const assignments = [];
  if (missing.length && Array.isArray(spreads) && spreads.length > 0) {
    // Allocate missing beats to opening (first spread), peak (~middle), and
    // closing (last). With ≤3 missing beats this gives one canonical slot
    // per beat. With more, repeat the rotation — the rewrite loop will
    // dedupe per spread anyway.
    const numbers = spreads.map(s => s.spreadNumber).filter(n => Number.isFinite(n));
    if (numbers.length > 0) {
      numbers.sort((a, b) => a - b);
      const opening = numbers[0];
      const closing = numbers[numbers.length - 1];
      const peak = numbers[Math.floor(numbers.length / 2)];
      const rotation = [opening, peak, closing];
      for (let i = 0; i < missing.length; i++) {
        assignments.push(rotation[i % rotation.length]);
      }
    }
  }

  return { beats, landed, missing, assignments };
}

/**
 * Render a short, human-readable label for a beat — used in book-level
 * issue strings and per-spread injection messages.
 *
 * @param {{ key:string, kind:string, text:string }} beat
 * @returns {string}
 */
function describeBeat(beat) {
  // Trim long free-text answers so book-level summaries stay scannable.
  const snippet = beat.text.length > 80 ? `${beat.text.slice(0, 77)}…` : beat.text;
  return `${beat.key}: "${snippet}"`;
}

module.exports = {
  extractSignatureBeats,
  checkSignatureBeatCoverage,
  describeBeat,
  // exported for tests
  signalTokens,
  SIGNATURE_TEXT_KEYS,
  SIGNATURE_ADDRESS_KEYS,
};
