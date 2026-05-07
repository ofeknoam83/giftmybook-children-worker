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
 * Skipped when the band's narrative tense isn't pinned to present — for
 * tonight that means we only enforce in PB_INFANT and PB_TODDLER. We
 * detect those by `ageProfile.ageBand`.
 */

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
]);

function tokenIsPastTense(tok) {
  const t = tok.toLowerCase();
  if (ED_ALLOWLIST.has(t)) return false;
  if (t.length < 4) return false; // too short to be a verb form
  if (!/ed$/.test(t)) return false;
  // "blanket-ed" / hyphenated false positives — skip if hyphenated.
  if (t.includes('-')) return false;
  return true;
}

function pastTenseCheck(draft, beat, ageProfile) {
  const band = ageProfile?.ageBand;
  if (!band || !PRESENT_TENSE_BANDS.has(band)) return { passed: true };

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
  // Tokenize on word boundaries, find -ed tokens.
  const tokens = text.match(/[A-Za-z'-]+/g) || [];
  for (const tok of tokens) {
    if (tokenIsPastTense(tok)) {
      return {
        passed: false,
        code: 'past_tense_regular',
        message: `Past-tense verb '${tok}' detected. Band ${band} is present-tense — use the present-tense form (e.g. 'looks' not 'looked').`,
        detail: { verb: tok },
      };
    }
  }
  return { passed: true };
}

module.exports = { pastTenseCheck, PRESENT_TENSE_BANDS };
