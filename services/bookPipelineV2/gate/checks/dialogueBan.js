/**
 * Dialogue ban detector.
 *
 * For age bands with `dialogueDensity: "none"` (PB_INFANT in particular),
 * any quoted speech, ALL-CAPS exclamation, or dialogue-tag verb is banned.
 * The lap-baby band is non-verbal — having "Mama says, 'Smushy'" violates
 * the band's contract and reads wrong aloud.
 *
 * We are conservative — only flag when the band explicitly disallows
 * dialogue. Other bands keep dialogue freely.
 *
 * Detected:
 *   - Straight or curly double quotes around any text: "..." or “...”
 *   - Single-quote dialogue: 'Smushy' (only when surrounded by spaces, to
 *     avoid mangling possessives like "Mama's chin")
 *   - Common dialogue-tag verbs ("says", "said", "shouts", "asks", etc.)
 */

const DIALOGUE_TAG_VERBS = [
  'says', 'said', 'shouts', 'shouted', 'asks', 'asked', 'whispers', 'whispered',
  'cries', 'cried', 'calls', 'called', 'yells', 'yelled', 'replies', 'replied',
  'tells', 'told', 'announces', 'announced', 'declares', 'declared',
];

const TAG_VERB_RE = new RegExp(`\\b(?:${DIALOGUE_TAG_VERBS.join('|')})\\b`, 'i');
const STRAIGHT_DOUBLE_RE = /"[^"]*"/;
const CURLY_DOUBLE_RE = /[\u201C\u201D][^\u201C\u201D]*[\u201C\u201D]/;
// Single-quote pair with whitespace boundaries (skips possessives).
const SINGLE_QUOTE_RE = /(?:^|\s)'[^']+'(?:\s|[.,!?;:]|$)/;

function dialogueBanCheck(draft, beat, ageProfile) {
  const density = ageProfile?.narrativeConstraints?.dialogueDensity;
  if (density && density !== 'none') return { passed: true };
  // If the band doesn't speak about dialogue at all, skip — only enforce
  // when the band has explicitly opted out.
  if (!density) return { passed: true };

  const text = String(draft?.text || '');
  if (!text) return { passed: true };

  if (STRAIGHT_DOUBLE_RE.test(text) || CURLY_DOUBLE_RE.test(text)) {
    return {
      passed: false,
      code: 'dialogue_quoted_speech',
      message: `Quoted speech is banned for this band (dialogueDensity=${density}). Remove quotation marks and rewrite as narration or sensory detail.`,
    };
  }
  if (SINGLE_QUOTE_RE.test(text)) {
    return {
      passed: false,
      code: 'dialogue_single_quoted',
      message: `Single-quoted speech is banned for this band (dialogueDensity=${density}). Rewrite as narration or sensory detail.`,
    };
  }
  if (TAG_VERB_RE.test(text)) {
    const m = text.match(TAG_VERB_RE);
    return {
      passed: false,
      code: 'dialogue_tag_verb',
      message: `Dialogue-tag verb '${m[0]}' is banned for this band (dialogueDensity=${density}). Show what the character does or what the camera sees, not what they say.`,
      detail: { verb: m[0] },
    };
  }
  return { passed: true };
}

module.exports = { dialogueBanCheck };
