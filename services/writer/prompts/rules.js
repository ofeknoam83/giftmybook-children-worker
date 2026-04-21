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
      'Full narrative arc across exactly 13 spreads organized into 4 SCENES. Beats within a scene share the same location.',
      '200-350 total words, 10-30 words per spread.',
      'Scene A (home): Spreads 1-3, ~20% of total words. Setup and departure anticipation.',
      'Scene B (journey/adventure): Spreads 4-7, ~35% of total words. Escalation.',
      'Scene C (destination/peak): Spreads 8-11, ~30% of total words. Climax and emotional peak.',
      'Scene D (heading home): Spreads 12-13, ~15% of total words. Warm resolution.',
      'Pattern with variation — the same emotional structure repeated with new content.',
      'Repetition is a strength at this age — use it as a rhythmic engine.',
      'Page turns are tools: end each spread with something that compels the next turn.',
      'Imagery must match the scene\'s time of day — no moon at noon, no sunrise at bedtime.',
      'NARRATIVE FLOW: Each spread must connect to the previous. A 3-year-old must be able to follow every transition. Do NOT write a slideshow of unrelated activities.',
    ],
    language: [
      'Simple, fun sentences — parents read this aloud, so it must be easy AND enjoyable.',
      'Maximum 2 syllables per word (except proper names). NO words a 3-year-old wouldn\'t hear daily.',
      'Simple action verbs: ran, jumped, hugged, splashed, clapped, spun, kissed.',
      'Complete sentences — simple does NOT mean broken. But keep them SHORT.',
      'No adjective stacking. No metaphors. No similes. Say what happens.',
      'Grammar must always be correct — no baby talk, no broken syntax.',
      'DEFAULT to exactly 2 lines per spread (one AABB couplet). Use 4 lines ONLY on rare climactic spreads, and only as TWO clean AABB couplets — never 3 lines, never mixed.',
      'Clever and playful, not literary. Think Dr. Seuss, not poetry.',
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
      'RHYME VARIETY across the book: No single end-rhyme sound should appear in more than 3 spreads. Each spread gets its own fresh rhyme pair.',
      'IDENTICAL-WORD RHYME IS FORBIDDEN. The two rhyming lines in a couplet MUST end on DIFFERENT words that share an end-sound. "nose / nose", "tree / tree", "slide / slide", "splash / splash" are NOT rhymes — they are repetitions, and they are a ship-blocker. "nose / rose", "tree / bee", "slide / wide", "splash / dash" are rhymes.',
      'REPETITION-AS-RHYME IS FORBIDDEN. A rhyme built on repeating the same word or the same phrase ("splash goes Mason, splash goes tub") is a ship-blocker. Vary the end-words of BOTH lines.',
      'NO "X to X" echo rhymes ("nose to nose", "cheek to nose", "hand in hand"). These masquerade as rhymes but do not rhyme.',
      'Slant/near rhymes (e.g. "slide / wide", "pop / top") are fine — but use them sparingly, never as a substitute for a clean rhyme you could find with one more minute of thought.',
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
      'Full narrative arc across exactly 13 spreads organized into 4 SCENES. Beats within a scene share the same location.',
      '300-500 total words, 15-40 words per spread.',
      'Scene A (home): Spreads 1-3, ~20% of total words. Setup and departure anticipation.',
      'Scene B (journey/adventure): Spreads 4-7, ~35% of total words. Escalation.',
      'Scene C (destination/peak): Spreads 8-11, ~30% of total words. Climax and emotional peak.',
      'Scene D (heading home): Spreads 12-13, ~15% of total words. Warm resolution.',
      'Page turns are tools: end each spread with something that compels the next turn.',
      'Imagery must match the scene\'s time of day — no moon at noon, no sunrise at bedtime.',
      'NARRATIVE FLOW: Each spread must connect to the previous. Do NOT write a slideshow of unrelated activities. The reader should always know WHERE the characters are and WHY.',
    ],
    language: [
      'Simple, clear sentences that a 4-year-old can follow on first listen.',
      'Mostly one- and two-syllable words. Three-syllable words only when they sound fun (e.g. "adventure", "enormous").',
      'Everyday vocabulary — no literary words. "ran" not "crept", "fell" not "tumbled", "big" not "vast".',
      'Clever wordplay and humor are great — complex vocabulary is not.',
      'Short sentences are your friend. Mix short and medium. Avoid long compound sentences.',
      'DEFAULT to 2 or 4 lines per spread (one or two clean AABB couplets). NEVER 3 lines, NEVER 5 lines, NEVER a mix. Odd line counts guarantee a broken rhyme scheme.',
      'The parent is the reader. The writing should be fun for the parent AND easy for the child.',
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
      'RHYME VARIETY across the book: No single end-rhyme sound should appear in more than 3 spreads. If the refrain uses "here," do NOT rhyme other spreads with here/clear/near/cheer. Each spread gets its own rhyme pair.',
      'IDENTICAL-WORD RHYME IS FORBIDDEN. The two rhyming lines in a couplet MUST end on DIFFERENT words that share an end-sound. "nose / nose", "tree / tree", "slide / slide", "splash / splash" are NOT rhymes — they are repetitions, and they are a ship-blocker. "nose / rose", "tree / bee", "slide / wide" are rhymes.',
      'REPETITION-AS-RHYME IS FORBIDDEN. Using the same word in rhyme position twice ("splash goes Mason, splash goes tub") or repeating a phrase to fake a rhyme is a ship-blocker. Vary the end-words of BOTH lines.',
      'NO "X to X" echo rhymes ("nose to nose", "cheek to nose", "hand in hand"). These masquerade as rhymes but do not rhyme.',
      'Multi-syllable and fresh rhymes earn you points. "splatter / chatter", "wobble / bobble", "rumble / tumble" sound more delightful than single-syllable filler rhymes.',
    ],
    antiAI: [
      'NO "you are so special/wonderful/amazing".',
      'NO greeting-card language.',
      'NO emotion declarations — show through action.',
      'NO adjective stacking ("beautiful, wonderful, precious").',
      'Every spread must have at least one concrete, specific noun.',
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
  'Keep it simple. If a simpler word works, use it. If a line can be shorter, shorten it.',
  'Meter, once chosen, cannot be broken — except deliberately at emotional peaks for effect.',
  'Rhyme serves story; story never serves rhyme — if you are reaching for a rhyme word, rebuild the couplet.',
  'Be specific: "peanut butter toast" > "lunch"; "she checked three times" > "she worried".',
  'Show the action; let the art carry the emotion — never narrate what the illustration will show.',
  'AABB couplets for ages 0-6. Each pair of lines rhymes.',
  'The closing spread should have fewest words and largest emotional payoff. Unless the theme is bedtime, the story must NOT end with sleep, bedtime, dreaming, or goodnight imagery. The closing should be WARM, AWAKE, and emotionally FULL — togetherness, joy, and light.',
  'Repetition is your engine. Plan the refrain before you write the book.',
  'Every spread should make the reader want to turn the page.',
  'Read it aloud. If you stumble, rewrite. A parent should never trip over a word.',
  'NEVER invent character names, place names, or personal details that were not provided in the input. Use only the names and details given to you.',
  'NEVER use dashes, hyphens, or em dashes in the story text. No "\u2014", no "-" between words. Rewrite the sentence to avoid them. Use commas, periods, or line breaks instead.',
  'INTERESTS ARE INSPIRATION, NOT THEMES: If the child likes a character (Pinkalicious, Bluey, etc.) or a color, use it as a subtle detail — NOT as a visual motif that saturates every spread. One pink ribbon is charming; pink fish, pink flowers, pink sky, and pink everything is overwhelming. Vary your imagery.',
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
