/**
 * Writer text policies per age band and format.
 *
 * Encodes the non-negotiable style choices from the rewrite plan:
 * musical-but-simple sentences, no large metaphors, low repetition,
 * third-person by default, funny/playful tone, light dialogue, implicit
 * emotional meaning, rhyme by default for picture books.
 */

const { FORMATS, AGE_BANDS, RHYME_POLICY } = require('../constants');

/**
 * @param {string} ageBand
 * @returns {{ maxSyllableTarget: number, voice: string, vocabulary: string }}
 */
function ageRules(ageBand) {
  switch (ageBand) {
    case AGE_BANDS.PB_TODDLER:
      return {
        maxSyllableTarget: 2,
        voice: 'Very simple musical sentences. No metaphors. Complete grammar — no baby talk.',
        vocabulary: 'Common toddler words a 2-3 year old hears daily.',
      };
    case AGE_BANDS.PB_PRESCHOOL:
      return {
        maxSyllableTarget: 3,
        voice: 'Musical, flowing, read-aloud first. Short words. No large metaphors. Funny beats okay.',
        vocabulary: 'Familiar preschool vocabulary; occasional natural three-syllable word is fine.',
      };
    case AGE_BANDS.ER_EARLY:
      return {
        maxSyllableTarget: 3,
        voice: 'Musical but slightly longer sentences. Real dialogue-quality narration, still simple.',
        vocabulary: 'Early-reader vocabulary. Natural multi-syllable words fine. Still concrete.',
      };
    default:
      return {
        maxSyllableTarget: 3,
        voice: 'Musical, simple, read-aloud first.',
        vocabulary: 'Common children\'s vocabulary.',
      };
  }
}

/**
 * Resolve rhyme policy, honoring any brief override.
 *
 * @param {string} format
 * @param {object} brief
 * @returns {'default_rhyme'|'prose'}
 */
function resolveRhymePolicy(format, brief) {
  const override = brief?.creativeGoals?.rhymeOverride;
  if (override === true) return 'default_rhyme';
  if (override === false) return 'prose';
  return RHYME_POLICY[format] || 'prose';
}

/**
 * Resolve narration style.
 *
 * @param {object} brief
 * @returns {'third'|'first'}
 */
function resolveNarration(brief) {
  const override = brief?.creativeGoals?.narrationOverride;
  if (override === 'first' || override === 'first_person') return 'first';
  return 'third';
}

/**
 * Render a compact text-policy block for a writer prompt.
 *
 * @param {object} doc
 * @returns {string}
 */
function renderTextPolicyBlock(doc) {
  const rules = ageRules(doc.request.ageBand);
  const rhyme = resolveRhymePolicy(doc.request.format, doc.brief);
  const narration = resolveNarration(doc.brief);
  return [
    `Age band: ${doc.request.ageBand}. Format: ${doc.request.format}.`,
    `Voice: ${rules.voice}`,
    `Vocabulary: ${rules.vocabulary}`,
    `Narration: ${narration === 'third' ? 'third-person' : 'first-person (child)'}.`,
    `Rhyme policy: ${rhyme === 'default_rhyme' ? 'use rhyming couplets by default; near-rhymes are fine' : 'prose by default; do not force rhyme'}.`,
    'Tone: funny/playful with character-based humor. Never preachy.',
    'Dialogue: light. Most spreads are narration; dialogue when it earns its place.',
    'Repetition: low. Repetition only when it clearly improves rhythm.',
    'Metaphors: avoid large metaphors. Concrete images over abstractions.',
    'Ending: story-specific. Do not force a bedtime/quiet-close ending.',
    'Personalization: use custom details concretely and recognizably.',
    'Child\'s name: used sometimes, not constantly.',
  ].join('\n');
}

module.exports = {
  ageRules,
  resolveRhymePolicy,
  resolveNarration,
  renderTextPolicyBlock,
};
