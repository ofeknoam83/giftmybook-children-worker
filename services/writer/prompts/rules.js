/**
 * Writing rules by age tier — derived from children's book writing craft research.
 *
 * These rules are injected into the system prompt for the writer LLM.
 * Each tier has structure, language, rhyme, and anti-AI-flatness rules.
 */

const RULES_BY_TIER = {
  'young-picture': {
    label: 'Young Picture Book (ages 0-3)',
    structure: [
      'Full narrative arc across exactly 13 spreads.',
      '200-350 total words, 10-30 words per spread.',
      'Act 1 (setup): Spreads 1-3, ~20% of total words.',
      'Act 2 (escalation): Spreads 4-9, ~60% of total words.',
      'Act 3 (resolution): Spreads 10-13, ~20% of total words.',
      'The climax spread (10) should have the FEWEST words.',
      'Pattern with variation — the same emotional structure repeated with new content.',
      'Repetition is a strength at this age — use it as a rhythmic engine.',
      'Page turns are tools: end each spread with something that compels the next turn.',
      'Imagery must match the scene\'s time of day — no moon at noon, no sunrise at bedtime.',
    ],
    language: [
      'Simple, musical sentences — parents read this aloud, so it must SOUND beautiful.',
      'Mostly one- and two-syllable words; occasional three-syllable if it sounds natural.',
      'Vivid verbs: whispered, tumbled, wandered, crept, wobbled, tiptoed.',
      'Complete, flowing sentences — simple does NOT mean broken.',
      'No adjective stacking. One rich metaphor per story is fine.',
      'Grammar must always be correct — no baby talk, no broken syntax.',
      'The parent is the reader. Write for the parent\'s pleasure and the child\'s ear.',
    ],
    rhyme: [
      'AABB couplets — every spread MUST rhyme.',
      'Iambic tetrameter (da-DUM da-DUM da-DUM da-DUM) — 4 beats per line.',
      'The meter, once chosen, cannot be broken except deliberately at emotional peaks.',
      'Rhymes must feel EFFORTLESS — never bending a sentence into unnatural shape.',
      'If a rhyme does not flow naturally, rewrite BOTH lines.',
      'Near-rhymes acceptable only when they sound musical.',
      'End-rhymes must be natural end-of-phrase words. Do NOT use enjambment to force a weak word into rhyme position.',
      'NEVER sacrifice logical consistency for a rhyme.',
    ],
    antiAI: [
      'NO greeting-card language ("a love so deep and pure").',
      'NO emotion declarations ("she felt so happy") — show through action.',
      'Concrete actions beat declarations: "She saved the last cookie" > "She loved you so much".',
      'Every spread must have at least one concrete, specific noun.',
      'Could this line appear in a greeting card? If yes, replace it.',
      'Do NOT invent names, places, or details not provided in the input. Use ONLY the names given to you.',
    ],
  },

  'picture-book': {
    label: 'Picture Book (ages 4-6)',
    structure: [
      'Full narrative arc: three-act structure across exactly 13 spreads.',
      '300-500 total words, 15-40 words per spread.',
      'Act 1 (setup): Spreads 1-3, ~20% of total words.',
      'Act 2 (escalation): Spreads 4-9, ~60% of total words.',
      'Act 3 (resolution): Spreads 10-13, ~20% of total words.',
      'The climax spread (10) should have the FEWEST words.',
      'Page turns are tools: end each spread with something that compels the next turn.',
      'Imagery must match the scene\'s time of day — no moon at noon, no sunrise at bedtime.',
    ],
    language: [
      'Compound sentences, emerging narrative — the story can carry more complexity.',
      'Two-syllable words freely; three-syllable words welcome when natural.',
      'The equilibrium approach: mostly familiar vocabulary, occasional stretch words.',
      'One or two vivid, unfamiliar words per book, chosen for sound AND meaning.',
      'Vivid verbs over vague ones: "crept" not "went", "tumbled" not "fell".',
      'Vary sentence length for rhythm: short-short-long, or long-then-very-short.',
      'The parent is the reader. Write for the parent\'s pleasure and the child\'s comprehension.',
    ],
    rhyme: [
      'AABB couplets as the backbone of every spread.',
      'Iambic tetrameter — consistent throughout.',
      'The entire story should read like a poem — think Donaldson, Seuss.',
      'Every line pair should have a clear, satisfying end-rhyme.',
      'Rhymes must feel EFFORTLESS and BEAUTIFUL — never forced.',
      'If rhyme controls the story rather than serving it, rebuild the couplet.',
      'AI-common rhyme pairs to AVOID: day/way, heart/start, love/above, you/true.',
      'End-rhymes must be natural end-of-phrase words. Do NOT use enjambment to force a weak word into rhyme position.',
      'NEVER sacrifice logical consistency for a rhyme — if the image contradicts the scene, the rhyme is wrong.',
    ],
    antiAI: [
      'NO "you are so special/wonderful/amazing".',
      'NO greeting-card language.',
      'NO emotion declarations — show through action.',
      'NO adjective stacking ("beautiful, wonderful, precious").',
      'NO primer prose (equal-length S-V-O sentences).',
      'Every spread must have at least one concrete, specific noun.',
      'At least one word per spread that mildly surprises the reader.',
      'Emotion must emerge from ACTION, not declaration.',
      'Close on an image, not a declaration.',
      'Do NOT invent names, places, or details not provided in the input. Use ONLY the names given to you.',
    ],
  },
};

/**
 * The 10 Commandments of Children's Picture Book Writing.
 * Injected into every writer prompt regardless of tier.
 */
const TEN_COMMANDMENTS = [
  'Every word earns its place — if a word can be cut without losing meaning, cut it.',
  'Meter, once chosen, cannot be broken — except deliberately at emotional peaks for effect.',
  'Rhyme serves story; story never serves rhyme — if you are reaching for a rhyme word, rebuild the couplet.',
  'Concrete nouns over abstract claims — "baloney sandwich" > "lunch"; "she checked three times" > "she worried".',
  'Show the action; let the art carry the emotion — never narrate what the illustration will show.',
  'AABB couplets for ages 0-5 — ABAB requires memory-holding that young children do not yet have.',
  'The closing spread should have fewest words and largest emotional payoff. For celebration themes (Mother\'s Day, Father\'s Day, birthday), the closing should be the WARMEST and most emotionally FULL — not quiet, not sleepy, not bedtime. End with togetherness, joy, and light.',
  'Repetition is not laziness — it is the engine. Plan your refrain before you write the book.',
  'The page turn is your most powerful tool — every spread should earn the next turn.',
  'Read it aloud before considering it done — if you stumble anywhere, revise until you don\'t.',
  'NEVER invent character names, place names, or personal details that were not provided in the input. Use only the names and details given to you.',
  'NEVER use dashes, hyphens, or em dashes in the story text. No "\u2014", no "-" between words. Rewrite the sentence to avoid them. Use commas, periods, or line breaks instead.',
];

/**
 * Get writing rules for a specific age tier.
 * @param {string} tierName - 'young-picture' or 'picture-book'
 * @returns {object|null}
 */
function getRulesForTier(tierName) {
  return RULES_BY_TIER[tierName] || null;
}

module.exports = { RULES_BY_TIER, TEN_COMMANDMENTS, getRulesForTier };
