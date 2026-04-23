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
      'Exactly 13 spreads. 200-350 total words, 10-30 words per spread.',
      'INVENT THE ARC: the shape of the story is yours to chart spread by spread. There is NO prescribed Scene A / Scene B / Scene C / Scene D. There is NO mandatory "home → journey → peak → heading home" template. Let the child, the theme, and the anecdotes dictate the shape. The world should feel **big and thrilling** — forward motion, a clear "gulp" or wonder moment mid-book (age-safe), and stakes a child can feel (lost toy found, height crossed, surprise revealed). What you owe the reader: a hook that feels epic or wondrous, a middle with tension and surprise, and a warm concrete resolution. Everything else is on you.',
      'OPENING LOCATION (HARD RULE): Spread 1 must be in a **non-home, epic or visually striking** setting — NOT a generic neighborhood park, NOT a backyard or private garden, NOT the kitchen/living room/playroom. SHIP-BLOCKERS: waking in bed, breakfast table, rug at home, ordinary local playground, "the park", picnic in the garden. Prefer openings you could photograph with **wow**: lighthouse rock at dawn, rope bridge over a misty gap, hot-air balloon basket over hills, waterfall terrace, ice cave mouth glowing blue, castle parapet, canyon overlook, tide cave, floating market docks, observatory dome under stars, desert ridge at sunset, marble ruins of an old causeway — or another invented place with the same **scale and novelty** (still safe for the age).',
      'NO FORMULAIC ENDINGS: do NOT default to "heading home", "walking home", or "back at home" for spreads 12-13 — that formula is banned. The closing image is yours to invent: it can be a still moment at the place you ended up, a quiet shared gesture, a found object, a mid-air leap, a whispered line — anything warm, concrete, and specific to THIS story. Home may appear in the closing only if the story organically arrived there.',
      'LINE-COUNT LOCK (HARD RULE): Pick 2 lines OR 4 lines for spread 1 and use the SAME count on EVERY OTHER spread. NEVER mix (e.g. 2 lines on spread 1-3 and 4 lines on spread 4-13 is a ship-blocker). Odd counts (1, 3, 5, 7) are forbidden.',
      'SEED-ARC SPINE (when a story seed provides a `fear`): Plant the unease as a tiny undercurrent in the opening spreads; dramatize it at its worst around the middle (one clear "worry moment"); RESOLVE it through a concrete action in the closing spreads (gift given, hug received, shared moment) — never leave the fear unresolved. Exactly where within the 13 spreads this lands is your call.',
      'Pattern with variation — the same emotional structure repeated with new content.',
      'Repetition is a strength at this age — use it as a rhythmic engine.',
      'Page turns are tools: end each spread with something that compels the next turn.',
      'Imagery must match the time of day — no moon at noon, no sunrise at bedtime.',
      'NARRATIVE FLOW: Each spread must connect to the previous. A 3-year-old must be able to follow every transition. Do NOT write a slideshow of unrelated activities.',
      'SETTING COHERENCE: Do NOT invent unusual compound-noun locations ("bath shop", "swim play spot", "hall rug seat") just to rhyme. On a journey, prefer **memorable, epic-feeling** stops over domestic defaults — do NOT anchor half the book in home, generic park, or backyard garden unless the parent brief explicitly demands it. If the characters change locations, narrate the transition in one line so the reader tracks where they are.',
      'VISUAL PROGRESSION (for illustrations): Each spread must advance what the reader can **see** — a new action, a new zone of the place, a time or weather shift, or a prop introduced or paid off. Avoid interchangeable stanzas that would paint the same tableau twice.',
    ],
    language: [
      'Simple, fun sentences — parents read this aloud, so it must be easy AND enjoyable.',
      'Maximum 2 syllables per word (except proper names). NO words a 3-year-old wouldn\'t hear daily.',
      'Simple action verbs: ran, jumped, hugged, splashed, clapped, spun, kissed.',
      'Complete sentences — simple does NOT mean broken. But keep them SHORT.',
      'No adjective stacking. No metaphors. No similes. Say what happens.',
      'Grammar must always be correct — no baby talk, no broken syntax.',
      'POSSESSIVE PRONOUNS: use "his" / "her" / "their" for possession — NEVER "him" / "he" / "them" in that role. Write "his hair", "his arm", "her hand" — NEVER "him hair", "him arm", "he hand". Using an object pronoun ("him") where a possessive ("his") belongs is a ship-blocker, even when it fits the meter.',
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
      'IDENTICAL-WORD RHYME IS FORBIDDEN. The two rhyming lines in a couplet MUST end on DIFFERENT words that share an end-sound. "nose / nose", "tree / tree", "slide / slide", "splash / splash", "Mama / Mama", "Dad / Dad" are NOT rhymes — they are repetitions, and they are a ship-blocker. "nose / rose", "tree / bee", "slide / wide", "Mama / llama", "Mama / drama" are rhymes.',
      'REFRAIN WORDS ARE NOT A LOOPHOLE. If your refrain ends with "Mama" (or "Papa", "Daddy", "Mom"), the OTHER line of that couplet MUST end on a DIFFERENT word that rhymes with the refrain word. Good pairs for "Mama": llama, drama, pajama, panorama. Good pairs for "Daddy": paddy, caddy, laddie. Never use the same refrain word on both lines of the same couplet.',
      'REPETITION-AS-RHYME IS FORBIDDEN. A rhyme built on repeating the same word or the same phrase ("splash goes Mason, splash goes tub") is a ship-blocker. Vary the end-words of BOTH lines.',
      'NO "X to X" echo rhymes ("nose to nose", "cheek to nose", "cheek to Mama", "hand in hand"). These masquerade as rhymes but do not rhyme.',
      'Slant/near rhymes (e.g. "slide / wide", "pop / top") are fine — but use them sparingly, never as a substitute for a clean rhyme you could find with one more minute of thought.',
    ],
    antiAI: [
      'NO greeting-card language ("a love so deep and pure").',
      'NO emotion declarations ("she felt so happy") — show through action.',
      'Concrete actions beat declarations: "She saved the last cookie" > "She loved you so much".',
      'Every spread must have at least one concrete, specific noun.',
      'Could this line appear in a greeting card? If yes, replace it.',
      'CONCRETE CLOSING (HARD RULE): The final line of the FINAL spread must be an image the illustrator can draw (a hug, a spin, toast on the table, a child tucked into bed for bedtime themes) — not an abstract phrase ("grin for more", "love that\'s true", "feels so right"). And NO end-word may appear twice in the final spread\'s rhyme positions.',
      'REFRAIN AT THE CLOSE: If a refrain is established, it MUST appear at least once in spreads 10-13. A refrain that only lives in the middle and then disappears at the end is a broken promise to the reader.',
      'NEVER open the story at home or in a mundane outdoor default (HARD RULE): no bed, kitchen table, living-room rug, generic park, backyard garden, or ordinary playground for spread 1 — match OPENING LOCATION above. Home may appear only if the story organically returns there near the end.',
      'NEVER default to "heading home" / "walking home" / "back at home" for the closing (HARD RULE). That formula is banned. Invent the final image yourself: a moment at wherever the story ended up is almost always better than a journey-home shot.',
      'Do NOT invent names, places, or details not provided in the input. Use ONLY the names given to you.',
    ],
  },

  'picture-book': {
    label: 'Picture Book (ages 4-6)',
    structure: [
      'Exactly 13 spreads. 300-500 total words, 15-40 words per spread.',
      'INVENT THE ARC: the shape of the story is yours to chart spread by spread. There is NO mandatory "home → short outing → back home" template — that **anti-pattern** (most spreads indoors, 1-2 "away" in the middle, then home) reads as flat and overdone; prefer a **journey of several distinct, epic or visually striking settings** with clear transitions and a **thrilling** mid-story beat (age-safe stakes: discovery, height, mystery, race against a closing door, almost-lost moment). You may use one sustained location when the theme truly demands it, but the default should be: memorable places, forward motion, and variety — not the same three rooms, generic park, or backyard on repeat.',
      'OPENING LOCATION (HARD RULE): Spread 1 must be **non-home and non-mundane** — NOT a generic neighborhood park, NOT a backyard garden, NOT kitchen/playroom/bed. SHIP-BLOCKERS: ordinary playground, "the park", picnic garden, splash pad as the only tame option unless framed inside a larger epic place. Prefer: lighthouse rock, suspension bridge, balloon deck, waterfall ledge, castle approach, canyon trail, ice cave, observatory platform, tide cave, floating market pier, desert ridge, ruins causeway — or another invented location with the same sense of **scale, novelty, and page-turn wonder**.',
      'NO FORMULAIC ENDINGS: do NOT default to "heading home", "walking home", or "back at home" for spreads 12-13 — that formula is banned. The closing image is yours to invent: it can be a still moment at the place you ended up, a quiet shared gesture, a found object, a whispered line — anything warm, concrete, and specific to THIS story. Home may appear in the closing only if the story organically arrived there.',
      'LINE-COUNT LOCK (HARD RULE): Pick 2 lines OR 4 lines for spread 1 and use the SAME count on EVERY OTHER spread. NEVER mix (e.g. 2 lines on spread 1-3 and 4 lines on spread 4-13 is a ship-blocker). Odd counts (1, 3, 5, 7) are forbidden.',
      'SEED-ARC SPINE (when a story seed provides a `fear`): Plant the unease as a tiny undercurrent in the opening spreads; dramatize it at its worst around the middle (one clear "worry moment"); RESOLVE it through a concrete action in the closing spreads (gift given, hug received, shared moment) — never leave the fear unresolved. Exactly where within the 13 spreads this lands is your call.',
      'Page turns are tools: end each spread with something that compels the next turn.',
      'Imagery must match the time of day — no moon at noon, no sunrise at bedtime.',
      'NARRATIVE FLOW: Each spread must connect to the previous. Do NOT write a slideshow of unrelated activities. The reader should always know WHERE the characters are and WHY.',
      'SETTING COHERENCE: Do NOT invent unusual compound-noun locations ("bath shop", "swim play spot", "hall rug seat") just to rhyme. Prefer **epic or highly specific** waypoints over a chain of home / garden / generic park — unless the parent brief explicitly requires a domestic story. If the characters change locations, narrate the transition in one line so the reader tracks where they are.',
      'VISUAL PROGRESSION (for illustrations): Each spread must advance what the reader can **see** — a new action, a new zone of the place, a time or weather shift, or a prop introduced or paid off. Avoid interchangeable stanzas that would paint the same tableau twice.',
    ],
    language: [
      'Simple, clear sentences that a 4-year-old can follow on first listen.',
      'Mostly one- and two-syllable words. Three-syllable words only when they sound fun (e.g. "adventure", "enormous").',
      'Everyday vocabulary — no literary words. "ran" not "crept", "fell" not "tumbled", "big" not "vast".',
      'Clever wordplay and humor are great — complex vocabulary is not.',
      'Short sentences are your friend. Mix short and medium. Avoid long compound sentences.',
      'POSSESSIVE PRONOUNS: use "his" / "her" / "their" for possession — NEVER "him" / "he" / "them" in that role. Write "his hair", "his arm", "her hand" — NEVER "him hair", "him arm", "he hand". Using an object pronoun ("him") where a possessive ("his") belongs is a ship-blocker, even when it fits the meter.',
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
      'IDENTICAL-WORD RHYME IS FORBIDDEN. The two rhyming lines in a couplet MUST end on DIFFERENT words that share an end-sound. "nose / nose", "tree / tree", "slide / slide", "splash / splash", "Mama / Mama", "Dad / Dad" are NOT rhymes — they are repetitions, and they are a ship-blocker. "nose / rose", "tree / bee", "slide / wide", "Mama / llama" are rhymes.',
      'REFRAIN WORDS ARE NOT A LOOPHOLE. If your refrain ends with "Mama" (or "Papa", "Daddy", "Mom"), the OTHER line of that couplet MUST end on a DIFFERENT word that rhymes with the refrain word. Good pairs for "Mama": llama, drama, pajama, panorama. Good pairs for "Daddy": paddy, caddy, laddie. Never use the same refrain word on both lines of the same couplet.',
      'REPETITION-AS-RHYME IS FORBIDDEN. Using the same word in rhyme position twice ("splash goes Mason, splash goes tub") or repeating a phrase to fake a rhyme is a ship-blocker. Vary the end-words of BOTH lines.',
      'NO "X to X" echo rhymes ("nose to nose", "cheek to nose", "cheek to Mama", "hand in hand"). These masquerade as rhymes but do not rhyme.',
      'Multi-syllable and fresh rhymes earn you points. "splatter / chatter", "wobble / bobble", "rumble / tumble" sound more delightful than single-syllable filler rhymes.',
    ],
    antiAI: [
      'NO "you are so special/wonderful/amazing".',
      'NO greeting-card language.',
      'NO emotion declarations — show through action.',
      'NO adjective stacking ("beautiful, wonderful, precious").',
      'Every spread must have at least one concrete, specific noun.',
      'Emotion must emerge from ACTION, not declaration.',
      'CONCRETE CLOSING (HARD RULE): The final line of the FINAL spread must be an image the illustrator can draw (a hug, a spin, toast on the table, a child tucked into bed for bedtime themes) — not an abstract phrase ("grin for more", "love that\'s true", "feels so right"). NO end-word may appear twice in the final spread\'s rhyme positions ("door / more / floor / more" is a ship-blocker).',
      'REFRAIN AT THE CLOSE: If a refrain is established, it MUST appear at least once in spreads 10-13. A refrain that only lives in the middle and then disappears at the end is a broken promise to the reader.',
      'NEVER open the story at home or in a mundane outdoor default (HARD RULE): no bed, kitchen, living-room rug, generic park, backyard garden, or ordinary playground for spread 1 — match OPENING LOCATION above. Home may appear only if the story organically returns there near the end.',
      'NEVER default to "heading home" / "walking home" / "back at home" for the closing (HARD RULE). That formula is banned. Invent the final image yourself: a moment at wherever the story ended up is almost always better than a journey-home shot.',
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
  'Settings should feel **epic or unforgettable** — avoid making home, backyard garden, or a generic neighborhood park the spine of the book unless the brief explicitly requires it. Thrill comes from place, stakes, and surprise, not from a checklist of cozy rooms.',
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
