/**
 * Past-tense detector for present-tense bands.
 *
 * Picture books for the youngest bands (PB_INFANT, PB_TODDLER) are
 * present-tense always — every spread is happening NOW. The writer
 * sometimes drifts into past tense to hit a rhyme ("Scarlett reaches
 * as Mama swayed.") which is both ungrammatical and disorienting.
 *
 * We flag obvious past-tense markers conservatively:
 *   - Common irregular past-tense verbs in tracked bands (was, were,
 *     said, went, came, saw, gave, took, held, made, found, sat, stood,
 *     ran, swung, kept).
 *   - Regular -ed past tense verbs that are NOT in the small allowlist
 *     of words that just happen to end in -ed (e.g. "red", "shed",
 *     "bed", "fed", "led", "wed", "sled", "head" are nouns/adjectives;
 *     "tired", "bored" can be adjectives but in lap-baby books they're
 *     usually verbs — we still flag, the writer can revise).
 *
 * Runs ONLY when the book's resolved narrative tense is 'present'
 * (2026-08-02: past tense became the standard for PRESCHOOL/EARLY_READER —
 * see ageProfiles narrativeTenseFor; the pre-verbal bands keep present
 * tense and this check). Past-tense books get the soft `tense_drift` book
 * lint instead (bookLints).
 */

const { narrativeTenseFor } = require('../../ageProfiles');

const PRESENT_TENSE_BANDS = new Set(['PB_INFANT', 'PB_TODDLER']);

const IRREGULAR_PAST = [
  'was', 'were', 'said', 'went', 'came', 'saw', 'gave', 'took',
  'held', 'made', 'found', 'sat', 'stood', 'ran', 'swung', 'kept',
  'felt', 'told', 'fell', 'broke', 'hung', 'lay', 'sang', 'sprang',
  'spoke', 'wove', 'wore', 'tore', 'thought', 'caught', 'taught',
  'brought', 'sought', 'fought', 'began', 'drank', 'sank', 'shrank',
  'stuck', 'stung', 'swam', 'swept', 'swayed', 'stayed',
];

const IRREGULAR_RE = new RegExp(`\\b(?:${IRREGULAR_PAST.join('|')})\\b`, 'i');
// Regular -ed past tense (greedy enough to catch "looked", "rested",
// "snuggled" but not nouns. We don't try to be a real morphological
// analyzer — the writer's job is to rewrite, not argue.)
// Allowlist common -ed words that are NOT past-tense verbs in normal
// child-book usage:
const ED_ALLOWLIST = new Set([
  'red', 'bed', 'fed', 'led', 'wed', 'shed', 'sled', 'head',
  'sped', 'pled', 'bred', 'fled', 'thread', 'tread', 'spread', 'dread',
  'forehead', 'cared', // sometimes adjectival but usually verb — skip ambiguity by allowing
  // 2026-07-28 false-positive fix: lexical -ed words that are never
  // past-tense verbs ("Mama plants a seed" hard-failed an infant book).
  'hundred', 'sacred', 'wicked', 'naked', 'crooked', 'rugged', 'jagged', 'beloved',
]);

/**
 * Tokens whose PRESENCE right before a -ed word marks it adjectival, not a
 * finite past-tense verb: copulas/linking verbs ("Baby is tired", "the sand
 * feels speckled") and intensifiers ("so excited", "all tired out"). A true
 * passive ("is carried") is also exempted — acceptable, since "is carried"
 * is present tense anyway.
 */
const LINKING_PRECEDERS = new Set([
  'is', 'are', 'am', 'be', 'been', 'being',
  'looks', 'look', 'feels', 'feel', 'seems', 'seem', 'gets', 'get',
  'sounds', 'sound', 'smells', 'smell', 'stays', 'stay', 'grows', 'grow', 'turns', 'turn',
  'so', 'very', 'too', 'all', 'half', 'quite',
]);

/** Determiners/possessives that mark an attributive adjective ("the striped hat"). */
const DETERMINERS = new Set([
  'a', 'an', 'the', 'his', 'her', 'their', 'its',
  'this', 'that', 'these', 'those', 'one', 'two', 'three', 'some', 'every', 'each',
]);

function tokenIsPastTense(tok) {
  const t = tok.toLowerCase();
  if (ED_ALLOWLIST.has(t)) return false;
  if (t.length < 4) return false; // too short to be a verb form
  if (!/ed$/.test(t)) return false;
  // No regular past tense ends in -eed (seed, need, feed, indeed; the only
  // -eed pasts are irregulars like "agreed"/"freed", which read adjectival
  // or are already the wrong register for these bands — never hard-fail).
  if (/eed$/.test(t)) return false;
  // "blanket-ed" / hyphenated false positives — skip if hyphenated.
  if (t.includes('-')) return false;
  return true;
}

/**
 * Loose evidence that a text is narrated in past tense — an irregular past
 * form or any -ed token (participial adjectives count as noise here, which
 * is fine: the consumer is the SOFT tense_drift book lint, thresholded over
 * all spreads, never a hard gate).
 *
 * @param {string} text
 * @returns {boolean}
 */
function textHasPastTenseMarker(text) {
  const t = String(text || '');
  if (!t) return false;
  if (IRREGULAR_RE.test(t)) return true;
  return (t.match(/[A-Za-z'-]+/g) || []).some(tokenIsPastTense);
}

function pastTenseCheck(draft, beat, ageProfile) {
  const band = ageProfile?.ageBand;
  if (!band || narrativeTenseFor(ageProfile) !== 'present') return { passed: true };

  const text = String(draft?.text || '');
  if (!text) return { passed: true };

  const irregularHit = text.match(IRREGULAR_RE);
  if (irregularHit) {
    return {
      passed: false,
      code: 'past_tense_irregular',
      message: `Past-tense verb '${irregularHit[0]}' detected. Band ${band} is present-tense — rewrite using present tense (e.g. 'sways' not 'swayed').`,
      detail: { verb: irregularHit[0] },
    };
  }
  // Tokenize on word boundaries, find -ed tokens. Context exemptions
  // (2026-07-28): participial ADJECTIVES were all false positives — "Baby is
  // tired", "the striped hat", "so excited" hard-failed infant/toddler books.
  // A -ed token preceded by a copula/linking verb or intensifier, or sitting
  // in attributive position (determiner + -ed + noun), is adjectival and
  // passes; subject-position verbs ("She looked up") still fail.
  const tokens = text.match(/[A-Za-z'-]+/g) || [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (!tokenIsPastTense(tok)) continue;
    const prev = (tokens[i - 1] || '').toLowerCase();
    if (LINKING_PRECEDERS.has(prev)) continue;
    if (DETERMINERS.has(prev) && i + 1 < tokens.length) continue;
    return {
      passed: false,
      code: 'past_tense_regular',
      message: `Past-tense verb '${tok}' detected. Band ${band} is present-tense — use the present-tense form (e.g. 'looks' not 'looked').`,
      detail: { verb: tok },
    };
  }
  return { passed: true };
}

module.exports = { pastTenseCheck, textHasPastTenseMarker, PRESENT_TENSE_BANDS };
