/**
 * Writer text policies per age band and format.
 *
 * Encodes the non-negotiable style choices from the rewrite plan:
 * musical-but-simple sentences, no large metaphors, low repetition,
 * third-person by default, funny/playful tone, light dialogue, implicit
 * emotional meaning, rhyme by default for picture books.
 */

const { FORMATS, AGE_BANDS, RHYME_POLICY, TEXT_LINE_TARGET, WORDS_PER_LINE_TARGET } = require('../constants');

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
  const lineTarget = TEXT_LINE_TARGET[doc.request.ageBand] || { min: 3, max: 4 };
  const isPictureBook = doc.request.format === FORMATS.PICTURE_BOOK;

  const lines = [
    `Age band: ${doc.request.ageBand}. Format: ${doc.request.format}.`,
    `Voice: ${rules.voice}`,
    `Vocabulary: ${rules.vocabulary}`,
    `Narration: ${narration === 'third' ? 'third-person' : 'first-person (child)'}.`,
  ];

  if (isPictureBook) {
    const wordBudget = WORDS_PER_LINE_TARGET[doc.request.ageBand] || WORDS_PER_LINE_TARGET[AGE_BANDS.PB_PRESCHOOL];
    const isToddler = doc.request.ageBand === AGE_BANDS.PB_TODDLER;
    const lineLengthRule = isToddler
      ? `- LINE LENGTH (ages 0-3 are the shortest): each of the 4 lines is VERY short — about ${wordBudget.min} to ${wordBudget.max} words, never more than ${wordBudget.hardMax}. Tight, sing-song, board-book cadence. No run-ons, no sub-clauses, no "and... and... and..." chaining.`
      : `- LINE LENGTH: each of the 4 lines is short — about ${wordBudget.min} to ${wordBudget.max} words, never more than ${wordBudget.hardMax}. No run-ons.`;
    const voiceRule = isToddler
      ? '- TONE (ages 0-3 specific): simple, musical, concrete. Tiny actions and feelings, named things a toddler knows (hand, moon, song, sky, hug). Big, punchy end-rhymes. Never abstract, never preachy.'
      : null;
    const toddlerStructureExample = isToddler
      ? [
          '- EXAMPLE CADENCE for ages 0-3 (do not copy these words — copy the shape):',
          '    "Little hand reached high.',
          '     Stars danced in the sky.',
          '     Mommy hummed a tune.',
          '     Up floated the moon."',
        ]
      : [];
    lines.push(
      '',
      '### STRUCTURE (NON-NEGOTIABLE for picture books — every single spread):',
      '- EXACTLY 4 lines of text per spread. Not 3. Not 5. Always 4. Each line separated by a single "\\n".',
      '- RHYME SCHEME: AABB (two rhyming couplets per spread). Line 1 rhymes with line 2. Line 3 rhymes with line 4. Lines 2 and 4 do NOT have to rhyme with each other.',
      '- Rhymes must be real end-rhymes — the FINAL word of line 1 rhymes with the FINAL word of line 2 (and 3 with 4). Near-rhymes (e.g. "high/sky", "wide/side", "tune/moon") are fine. Slant rhymes and identity rhymes (same word twice) are NOT acceptable. Forced or dictionary-stretching rhymes are NOT acceptable.',
      '- METER: a consistent musical pulse across each couplet — not strict iambic, but roughly the same number of stressed beats in line 1 as line 2, and line 3 as line 4. Read every couplet aloud in your head and confirm both lines sing at the same pace.',
      lineLengthRule,
      ...(voiceRule ? [voiceRule] : []),
      '- LINE BREAKS: the 4 lines are natural phrase units. Never break mid-phrase just to force a rhyme.',
      '- SOUND: musical and read-aloud first. If a couplet does not actually rhyme, rewrite the couplet — do not ship it.',
      ...toddlerStructureExample,
      '',
    );
  } else {
    lines.push(
      `Target rendered lines per spread: ${lineTarget.min}-${lineTarget.max}.`,
      `Rhyme policy: ${rhyme === 'default_rhyme' ? 'use rhyming couplets by default; near-rhymes are fine' : 'prose by default; do not force rhyme'}.`,
    );
  }

  lines.push(
    'Tone: funny/playful with character-based humor. Never preachy.',
    'Dialogue: light. Most spreads are narration; dialogue when it earns its place.',
    'Repetition: low. Repetition only when it clearly improves rhythm.',
    'Metaphors: avoid large metaphors. Concrete images over abstractions.',
    'Ending: story-specific. Do not force a bedtime/quiet-close ending.',
    'Personalization: use custom details concretely and recognizably.',
    'Child\'s name: used sometimes, not constantly.',
  );

  return lines.join('\n');
}

module.exports = {
  ageRules,
  resolveRhymePolicy,
  resolveNarration,
  renderTextPolicyBlock,
};
