/**
 * Writing rules by age tier — derived from children's book writing craft research.
 *
 * These rules are injected into the system prompt for the writer LLM.
 * Each tier has structure, language, rhyme, and anti-AI-flatness rules.
 */

const RULES_BY_TIER = {
  'board-book': {
    label: 'Board Book (ages 0-2)',
    structure: [
      '1 idea per spread — not a story beat, just one object, one action, or one sound.',
      'Maximum 100 words total (strict industry standard).',
      'Maximum 5-12 words per spread.',
      'Repetition is mandatory — the same structure on every spread is a feature.',
      'Do NOT require narrative memory — each spread must be complete without the others.',
      'Open-ended endings invite participation: "What do YOU say?"',
    ],
    language: [
      'Single words, sounds, onomatopoeia for ages 0-1.',
      'Simple nouns, action verbs, 2-3 word phrases for ages 1-2.',
      'Use only common toddler words a child this age hears daily.',
      'No metaphors, no words above 2 syllables.',
      'Grammar must always be correct — no baby talk.',
      'Simple does NOT mean broken. Complete, musical sentences.',
    ],
    rhyme: [
      'AABB couplets — every spread is two rhyming lines.',
      'Bouncy, sing-song rhythm (Boynton-style) — not strict meter.',
      'Rhyme payoff arrives in 2 lines, not 4 — instant satisfaction.',
      'If a rhyme does not flow naturally, rewrite Line 1 until Line 2 rhymes naturally.',
      'No prose. Couplets only.',
    ],
    antiAI: [
      'NO "you are special/wonderful/amazing" — too abstract for this age.',
      'NO adjective stacking — choose ONE precise word.',
      'Use concrete nouns: "oak" not "tree", "chicken soup" not "lunch".',
      'Maximum 1-2 onomatopoeia across the entire story.',
      'Do NOT invent names or details not provided in the input. Use ONLY the names given to you.',
    ],
  },

  'early-picture': {
    label: 'Early Picture Book (ages 2-3)',
    structure: [
      'Simple sentences, 100-250 total words.',
      '8-20 words per spread.',
      'Pattern with variation — same structure repeated but with new content each time.',
      'Repetition can substitute for escalation.',
      'The "ending" is often a satisfying completion of the pattern.',
      'Imagery must match the scene\'s time of day — no moon at noon, no sunrise at bedtime.',
    ],
    language: [
      'Simple sentences, action + object.',
      'Two-syllable words freely; occasional three-syllable if natural.',
      'Complete, flowing sentences that a parent enjoys reading aloud.',
      'Vivid verbs: whispered, tumbled, wandered, crept, wobbled, tiptoed.',
      'No adjective stacking. One rich metaphor per story is fine.',
    ],
    rhyme: [
      'AABB couplets — every spread MUST rhyme.',
      'Iambic tetrameter (da-DUM da-DUM da-DUM da-DUM) — 4 beats per line.',
      'The meter, once chosen, cannot be broken except deliberately at emotional peaks.',
      'Rhymes must feel EFFORTLESS — never bending a sentence into unnatural shape.',
      'If a rhyme does not flow naturally, rewrite BOTH lines.',
      'Near-rhymes acceptable only when they sound musical.',
      'End-rhymes must be natural end-of-phrase words. Do NOT use enjambment to force a weak word into rhyme position.',
    ],
    antiAI: [
      'NO greeting-card language ("a love so deep and pure").',
      'NO emotion declarations ("she felt so happy").',
      'Concrete actions beat declarations: "She saved the last cookie" > "She loved you so much".',
      'Every spread must have at least one concrete, specific noun.',
      'Every spread must have rhythm variation.',
      'Could this line appear in a greeting card? If yes, replace it.',
      'Do NOT invent names or details not provided in the input. Use ONLY the names given to you.',
    ],
  },

  'picture-book': {
    label: 'Picture Book (ages 3-5)',
    structure: [
      'Full narrative arc: three-act structure across 12-14 spreads.',
      '250-500 total words, 15-35 words per spread.',
      'Act 1 (setup): Spreads 1-3, ~20% of total words.',
      'Act 2 (escalation): Spreads 4-9, ~60% of total words.',
      'Act 3 (resolution): Spreads 10-13, ~20% of total words.',
      'The climax spread (10) often has the FEWEST words.',
      'Page turns are tools: end each spread with something that compels the next turn.',
      'Imagery must match the scene\'s time of day — no moon at noon, no sunrise at bedtime.',
    ],
    language: [
      'Compound sentences, emerging narrative.',
      'Two-syllable words freely; three-syllable words welcome when natural.',
      'The equilibrium approach: mostly familiar vocabulary, occasional stretch words.',
      'One or two vivid, unfamiliar words per book, chosen for sound AND meaning.',
      'Vivid verbs over vague ones: "crept" not "went", "tumbled" not "fell".',
      'Vary sentence length for rhythm: short-short-long, or long-then-very-short.',
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
  'The closing spread should be your quietest — fewest words, largest emotional payoff.',
  'Repetition is not laziness — it is the engine. Plan your refrain before you write the book.',
  'The page turn is your most powerful tool — every spread should earn the next turn.',
  'Read it aloud before considering it done — if you stumble anywhere, revise until you don\'t.',
  'NEVER invent character names, place names, or personal details that were not provided in the input — use only the names and details given to you.',
];

/**
 * Get writing rules for a specific age tier.
 * @param {string} tierName - 'board-book', 'early-picture', or 'picture-book'
 * @returns {object|null}
 */
function getRulesForTier(tierName) {
  return RULES_BY_TIER[tierName] || null;
}

module.exports = { RULES_BY_TIER, TEN_COMMANDMENTS, getRulesForTier };
