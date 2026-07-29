/**
 * Banned poetic-register words (2026-07-29 QA review, Liv birthday book).
 *
 * The review's core language finding: the writer floats into atmospheric
 * poetry ("moonlight silver rests on sand", "the isle hums at dusk") that a
 * young child cannot picture and a parent trips over reading aloud. The
 * lexicon (gate/lexicons/bannedWords.json) carries a replacement per word —
 * the failure message quotes it so the single surgical gatefix is a word
 * swap, not a rewrite.
 *
 * Band routing (product decision 2026-07-29):
 *   PB_INFANT / PB_TODDLER  hard-tier hits → `banned_word` (HARD gate code);
 *                           soft-tier hits → `banned_word_soft`
 *   PB_PRESCHOOL            every hit → `banned_word_soft` (wider tolerance,
 *                           and the one-gatefix budget is protected)
 *   PB_EARLY_READER         exempt (the review's own note — beneath/gather
 *                           are fine at 6+)
 *
 * `banned_word_soft` is deliberately NOT in HARD_GATE_CODES: it fails the
 * spread (feeds mergeTargets revision notes) but never triggers the
 * surgical fix or blocks eligibility.
 *
 * Exemptions: the child's name and capitalized tokens (proper nouns — same
 * convention as wordLengthLint; the sentence-initial blind spot is an
 * accepted trade-off for zero proper-noun false positives).
 */

const LEXICON = require('../lexicons/bannedWords.json');
const { inflectionsOf, normalizeSentence, wordsOf } = require('./textUtils');

const HARD_BANDS = new Set(['PB_INFANT', 'PB_TODDLER']);
const SOFT_BANDS = new Set(['PB_PRESCHOOL']);

/** surface form → { base, replacement, tier, category } (built once). */
const SURFACE_MAP = (() => {
  const map = new Map();
  for (const tier of ['hard', 'soft']) {
    for (const [category, entries] of Object.entries(LEXICON[tier] || {})) {
      if (category === 'phrases') continue;
      for (const [base, replacement] of Object.entries(entries)) {
        for (const form of inflectionsOf(base)) {
          if (!map.has(form)) map.set(form, { base, replacement, tier, category });
        }
      }
    }
  }
  return map;
})();

/** normalized phrase → replacement (soft tier only). */
const PHRASES = Object.entries((LEXICON.soft || {}).phrases || {})
  .map(([phrase, replacement]) => ({ phrase: normalizeSentence(phrase), replacement }));

/**
 * Gate check: banned poetic-register vocabulary, band-routed.
 *
 * @param {{ text?: string }} draft
 * @param {null} beat - unused in V3
 * @param {object} ageProfile
 * @param {{ protagonistName?: string }} ctx
 * @returns {{ passed: boolean, code?: string, message?: string, detail?: object }}
 */
function bannedWordsCheck(draft, beat, ageProfile, ctx = {}) {
  const band = String(ageProfile?.ageBand || '');
  if (!HARD_BANDS.has(band) && !SOFT_BANDS.has(band)) return { passed: true };

  const nameLower = String(ctx.protagonistName || '').toLowerCase();
  const hits = [];
  const seen = new Set();
  for (const raw of wordsOf(draft?.text)) {
    if (/^[A-Z]/.test(raw)) continue; // proper nouns / sentence-case (wordLengthLint convention)
    const word = raw.toLowerCase().replace(/[’']/g, '');
    if (!word || word === nameLower || seen.has(word)) continue;
    const entry = SURFACE_MAP.get(word);
    if (!entry) continue;
    seen.add(word);
    hits.push({ word, ...entry });
  }
  const normText = normalizeSentence(draft?.text);
  for (const { phrase, replacement } of PHRASES) {
    if (phrase && normText.includes(phrase) && !seen.has(phrase)) {
      seen.add(phrase);
      hits.push({ word: phrase, base: phrase, replacement, tier: 'soft', category: 'phrases' });
    }
  }
  if (hits.length === 0) return { passed: true };

  const hardHits = HARD_BANDS.has(band) ? hits.filter((h) => h.tier === 'hard') : [];
  const describe = (list) => list.map((h) => `"${h.word}" → "${h.replacement}"`).join(', ');
  const code = hardHits.length ? 'banned_word' : 'banned_word_soft';
  return {
    passed: false,
    code,
    message: `poetic-register word(s) machine-banned for ${band}: ${describe(hits)} — swap each for its replacement (or a word from the safe register: ${LEXICON.safeRegister.slice(0, 8).join(', ')}…), keeping the line's meaning`,
    detail: { hits, band },
  };
}

module.exports = { bannedWordsCheck, SURFACE_MAP };
