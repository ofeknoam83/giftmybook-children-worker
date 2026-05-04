/**
 * V2 Writer Brief for children's bedtime picture books.
 *
 * The full brief is a professional-grade prompt with 4 age tiers,
 * left/right spread layout, and two-phase bedtime pacing.
 * Variables are substituted at call time: {name}, {age}, {favorite_object},
 * {fear}, {setting}, {dedication}.
 */

const { buildPronounInstruction } = require('../services/pronouns');

// ── Age Tier Configuration ──

const AGE_TIERS = {
  0: {
    tier: 0,
    label: 'Lap-Baby Board Book',
    range: [0, 1.5],
    vocabulary: 'words a baby hears every day. Mama, Dada, hand, light, soft, warm, smile, hug, see, look, up, down, big, little, sky, moon, sun, song, grass, cup. Max ~40 unique words across the entire book. The book is read TO the baby by the parent — write FOR the parent reading aloud, in a tiny musical voice. Simple does NOT mean broken: every line is a complete, graceful sentence with a clear, gentle rhythm.',
    maxWordsPerSpread: 8,
    sentencesPerSpread: '2',
    sentenceStyle: 'EXACTLY 2 short, complete sentences per spread (one rhyming AA couplet). 2-4 words per line, never more than 5. Every line is a complete sensory observation. ("Mama holds the cup. / Little hand reaches up.")',
    conflict: 'NONE. Sensory observation only. No problem, no chase, no resolution arc — just little warm moments.',
    dialogue: 'NONE. Narrator only. No quoted speech, no question marks directed at characters.',
    imagePromptStyle: 'extreme close-up. Single subject. Hero is always physically supported — held, in lap, in stroller, in high chair, lying down, or sitting against a soft prop. Never standing unsupported.',
    fearHandling: 'ignore entirely. No fear, no startle, no "too loud / too dark" — replace with a small comfort moment.',
    pacing: 'every spread is already calm. No phasing required. Distribute sensory observations evenly.',
    arc: 'NO arc. 13 little moments of warmth and noticing — they may share a thread (a day with Mama, an evening at home) but there is no problem to solve.',
    phaseTwo: null,
    rhymeLevel: 'mandatory AA couplets — write EVERY spread as exactly 2 rhyming lines (AA scheme). Real end-rhymes only — never the same word twice. The two lines together form one tiny sing-song moment. Example shape: "Little hand sees the light. / Mama holds her tight." If a couplet does not actually rhyme, rewrite it.',
    soundWordsRule: 'AT MOST 1 onomatopoeia in the entire book. Almost always zero. Babies hear sound words live from their parents — the book does not need them. NEVER include screams, squeals, bangs, or repeated sound words.',
    actionWhitelist: 'Permitted hero actions: sees, looks, hears, smiles, snuggles, reaches, holds (small light object), touches, pats, claps, points, lies, sits (supported), is held, is carried. FORBIDDEN: walks, runs, climbs, jumps, rides, leads, grabs (a moving object), chases, says (any quoted speech).',
  },
  1: {
    tier: 1,
    label: 'Board Book',
    range: [1.5, 2],
    vocabulary: 'simple words a baby or toddler hears every day. One- and two-syllable words freely ("sleeping", "quiet", "little", "tumble", "morning", "blanket"). Max 60 unique words total. The language should be simple but BEAUTIFUL — lyrical, warm, with a gentle rhythm that sings when read aloud. Think "Goodnight Moon" or "Guess How Much I Love You" — not a vocabulary flashcard. Simple does NOT mean broken. Complete, musical sentences always.',
    sentencesPerSpread: '1-2',
    sentenceStyle: 'Short, complete, graceful sentences. ("The little bear curls into sleep." not just "Bear. Sleep.")',
    conflict: 'none. Sensory observation only.',
    dialogue: 'none, or single-word utterances ("Oh." / "Warm."). Any dialogue must be grammatically correct — no baby talk.',
    imagePromptStyle: 'extreme close-up, high contrast, single subject per scene.',
    fearHandling: 'ignore. Replace with a gentle sensory discomfort (too loud, too bright) that simply fades by the final spread.',
    pacing: 'every spread is already calm. No phasing required.',
    arc: 'no arc. Distribute sensory observations evenly across spreads.',
    phaseTwo: null,
    rhymeLevel: 'mandatory couplets — write EVERY spread as two rhyming lines using AABB rhyme scheme. Format: Line 1 (sets up the image), Line 2 (rhymes and closes). Example: "The stars come out one by one. / Goodnight moon, goodnight sun." Use exact end-rhymes or strong near-rhymes. If you cannot find a natural rhyme, rewrite Line 1 until Line 2 rhymes naturally. No prose. Couplets only. The story should have a musical, rhythmic quality — think Dr. Seuss or Julia Donaldson. Prioritize natural-sounding rhymes over forced ones.',
    soundWordsRule: 'LIMIT onomatopoeia to at most 1-2 per spread. Do NOT overuse sound words (BANG, WHOOSH, CRASH, SPLAT, etc.). Include at most 2 sound words across the entire story. Describe actions through vivid imagery and movement rather than sound effects. Avoid excessive references to sounds — show, don\'t tell through noise.',
  },
  2: {
    tier: 2,
    label: 'Classic Picture Book',
    range: [3, 5],
    vocabulary: 'common words a 3-5 year old hears and understands. Two-syllable words freely; three-syllable words welcome when they sound natural read aloud ("adventure", "beautiful", "tomorrow", "butterfly", "discovery"). The language should be SIMPLE but BEAUTIFUL and COHERENT — complete, flowing sentences that a parent enjoys reading aloud. Think Julia Donaldson, Oliver Jeffers, or Margaret Wise Brown — not a reading primer. Vivid verbs are encouraged: whispered, tumbled, wandered, crept, wobbled, tiptoed. No adjective stacking. One rich metaphor per story is fine if grounded in something a child knows ("the moon was a nightlight").',
    maxWordsPerSpread: 30,
    sentencesPerSpread: '1-2',
    sentenceStyle: 'distributed across left and right pages.',
    conflict: 'present but never scary. Stakes are emotional, not physical.',
    dialogue: '2 exchanges required. Rules: (1) Child\'s voice must sound like a real 3-5 year old — short sentences, concrete words, more questions than statements; (2) Dialogue must advance the plot or reveal character; (3) The child\'s voice must sound different from the narrator\'s voice; (4) All dialogue MUST be grammatically correct and complete — never broken grammar, baby talk, or sentence fragments. Write "Can I help?" not "me help?". Write "I found it!" not "Found it!".',
    imagePromptStyle: 'wide establishing shots mixed with close emotional moments.',
    fearHandling: 'use as written.',
    pacing: 'Phase 1 (spreads 1-9): emotional aliveness. Phase 2 (spreads 11-13): emotional resolution — energy matches the theme. Adventure/birthday/science/mothers_day/fathers_day/grandparents_day ends warm and triumphant. Friendship/nature ends with quiet joy. Bedtime only ends with calm settling. NEVER deflate the energy on non-bedtime themes.',
    arc: 'full story arc applies.',
    phaseTwo: 10,
    rhymeLevel: 'RHYMING IS MANDATORY — every spread MUST rhyme. Use AABB rhyming couplets as the backbone of every spread. The entire story should read like a poem — think Dr. Seuss, Julia Donaldson, or "The Gruffalo." Every line pair should have a clear, satisfying end-rhyme that a child would notice and love. The rhymes must feel EFFORTLESS and BEAUTIFUL — never forced, never bending a sentence into an unnatural shape. If a rhyme doesn\'t flow naturally, rewrite BOTH lines until they do. Near-rhymes are acceptable only when they sound musical. A parent reading this aloud should feel the rhythm carry them forward — the book should be impossible to read in a flat voice.',
    soundWordsRule: 'LIMIT onomatopoeia to at most 1-2 across the entire story. Do NOT overuse sound words (BANG, WHOOSH, CRASH, SPLAT, etc.). Place them only at genuinely pivotal moments. Describe actions through vivid imagery and movement rather than sound effects. Avoid excessive references to sounds — show, don\'t tell through noise. NEVER include a sound word on more than 1 out of 13 spreads.',
  },
  3: {
    tier: 3,
    label: 'Early Reader / Illustrated Story',
    range: [6, 8],
    vocabulary: 'up to 3-syllable words. May introduce one new word per story.',
    maxWordsPerSpread: 40,
    sentencesPerSpread: '2-4',
    sentenceStyle: 'Compound sentences allowed.',
    conflict: 'mild physical stakes allowed (lost, stuck, alone in the dark).',
    dialogue: '3 exchanges required. May include subtext.',
    imagePromptStyle: 'layered scenes with background detail permitted.',
    fearHandling: 'use as written. May be specific and named.',
    pacing: 'Phase 1 (spreads 1-9): emotional aliveness. Phase 2 (spreads 11-13): emotional resolution — energy matches the theme. Adventure/birthday/science/mothers_day/fathers_day/grandparents_day ends warm and triumphant. Friendship/nature ends with quiet joy. Bedtime only ends with calm settling. NEVER deflate the energy on non-bedtime themes.',
    arc: 'arc may include a false resolution before true resolution.',
    phaseTwo: 10,
    rhymeLevel: 'strong — use rhyming couplets or AABB rhyme schemes in MOST spreads (at least 9 of 13). The story should have a clear rhythmic pulse. Prose bridges are allowed for 2-3 dramatic moments, but the default mode is rhyming couplets. Think Julia Donaldson\'s early readers — prose with a strong lyrical backbone. Rhymes must feel natural and beautiful — never forced. A parent reading aloud should feel the rhythm.',
    soundWordsRule: 'LIMIT onomatopoeia: maximum 1 across the entire story, and only if it serves a specific scene purpose. Do NOT overuse sound words (BANG, WHOOSH, CRASH, SPLAT, etc.). Describe actions through vivid imagery and movement rather than sound effects. Avoid excessive references to sounds — show, don\'t tell through noise. If in doubt, use zero.',
  },
  4: {
    tier: 4,
    label: 'Illustrated Chapter / Bedtime Story',
    range: [9, 12],
    vocabulary: 'no restriction. Metaphor and irony permitted.',
    maxWordsPerSpread: 60,
    sentencesPerSpread: 'up to 6',
    sentenceStyle: 'Varied rhythm intentional.',
    conflict: 'emotional complexity allowed (embarrassment, grief, longing).',
    dialogue: '3-4 exchanges. Subtext expected. Characters may be unreliable.',
    imagePromptStyle: 'cinematic framing, shadow/light contrast, symbolic detail.',
    fearHandling: 'may be treated as an internal state, not just external obstacle.',
    pacing: 'Phase 1 (spreads 1-9): Fuller sentences. Richer texture. Phase 2 (spreads 11-13): emotional resolution — energy matches the theme. Adventure ends triumphant. Friendship/nature ends with quiet joy. Bedtime only ends with calm settling.',
    arc: 'arc may include a secondary character with their own want.',
    phaseTwo: 10,
    rhymeLevel: 'light rhythmic prose — weave in occasional rhyming couplets, internal rhymes, and near-rhymes for musicality. Slant rhymes and internal echoes add rhythm without forcing a pattern. Include at least 2-3 rhyming passages across the story. The prose should have a rhythmic quality that rewards reading aloud. Prioritize natural-sounding rhymes over forced ones.',
    soundWordsRule: 'ZERO onomatopoeia. No sound words whatsoever — no bang, crash, whoosh, splash, creak. At this age they feel juvenile and break the literary voice. Describe sounds with prose: "the door groaned open" not "CREEEAK." This rule has no exceptions.',
  },
};

/**
 * Return the tier number (1-4) and tier config for a given age.
 * @param {number|string} age
 * @returns {{ tier: number, config: object }}
 */
function getAgeTier(age) {
  const n = Number(age);
  let a;
  if (Number.isFinite(n) && n >= 0) {
    a = n;
  } else {
    a = 5;
    console.warn(`[writerBrief] getAgeTier called with non-finite age=${JSON.stringify(age)} — defaulting to 5 (tier 2). Caller should pass a numeric age or a DOB-derived age.`);
  }
  // Tier 0 = lap-baby board book (under ~18 months). The hero cannot stand,
  // walk, run, climb, or grab moving objects, and the book has no plot or
  // dialogue — just sensory observation in 2-line AA couplets. Babies in
  // tier 0 share the same musical voice as toddlers, but with a tighter
  // word budget and a stricter no-locomotion action whitelist.
  if (a < 1.5) return { tier: 0, config: AGE_TIERS[0] };
  if (a <= 2) return { tier: 1, config: AGE_TIERS[1] };
  if (a <= 5) return { tier: 2, config: AGE_TIERS[2] };
  if (a <= 8) return { tier: 3, config: AGE_TIERS[3] };
  return { tier: 4, config: AGE_TIERS[4] };
}

// ── Emotional Age Tier Configuration ──

const EMOTIONAL_AGE_TIERS = {
  E1: {
    tier: 'E1',
    label: 'Toddler Emotional',
    range: [2, 3],
    vocabulary: 'body-sensation words only. "My tummy feels tight." "My face feels hot." Max 40 unique words.',
    maxWordsPerSpread: 12,
    sentencesPerSpread: '1',
    sentenceStyle: 'Body sensation + simple action. Never name the cause of the emotion directly.',
    conflict: 'none. Emotion is felt and named in the body only. No story arc — just recognition.',
    dialogue: 'none. Narrator only. No character voice.',
    imagePromptStyle: 'extreme close-up on child face and body. Single subject. Warm safe palette. Expressive eyes.',
    fearHandling: 'name the body sensation only. Never name what caused it.',
    arc: 'Recognition (spreads 1-3) → The feeling grows (spreads 4-5) → Something soothing arrives (spreads 6-7) → The feeling softens (spread 8). No resolution — just comfort.',
    rhymeLevel: 'mandatory rhyming couplets throughout. Simple, musical, short.',
    coachingNote: 'This is a comfort book, not a story. It validates the feeling through rhythm and body language.',
  },
  E2: {
    tier: 'E2',
    label: 'Picture Book Emotional',
    range: [4, 6],
    vocabulary: 'conversational, concrete. Emotion words permitted: worried, frustrated, scared, sad, angry.',
    maxWordsPerSpread: 28,
    sentencesPerSpread: '2-3',
    sentenceStyle: 'distributed across left and right pages. One idea per page.',
    conflict: 'emotional stakes only. The child feels something difficult and cannot immediately manage it.',
    dialogue: '2 exchanges. Child voice must sound like a real 4-6 year old. Dialogue reveals emotion.',
    imagePromptStyle: 'wide establishing shots mixed with emotional close-ups. Warm light. Expressive character.',
    fearHandling: 'name the emotion and the trigger. Show it in the body AND in behavior.',
    arc: '6-act emotional arc: Recognition → Storm → Stuck → Bridge → Tool → Turn → Landing.',
    rhymeLevel: 'occasional — repeated phrase must have rhythm. Prose otherwise.',
    coachingNote: 'One coping strategy embedded in Acts 5-6. Must leave usable language on spread 13.',
  },
  E3: {
    tier: 'E3',
    label: 'Illustrated Story Emotional',
    range: [7, 9],
    vocabulary: 'up to 3-syllable words. Metaphor permitted. Interior monologue in italics.',
    maxWordsPerSpread: 55,
    sentencesPerSpread: '3-5',
    sentenceStyle: 'varied rhythm. Interior thoughts in italics. Dialogue advances the emotional journey.',
    conflict: 'emotional complexity: two conflicting feelings simultaneously. External + internal stakes.',
    dialogue: '3-4 exchanges. Subtext expected. A secondary character has their own perspective.',
    imagePromptStyle: 'layered scenes with background detail. Symbolic objects. Cinematic framing. One illustration per spread on 6x9 portrait.',
    fearHandling: 'treated as internal state. The child may be aware of their own emotion patterns.',
    arc: '6-act emotional arc across 18 spreads. Acts 3-4 (Stuck) get 3 spreads each. Spread 17: Looking back. Spread 18: The Landing + Reflection page.',
    rhymeLevel: 'none. Pure prose with varied sentence rhythm.',
    coachingNote: 'Spread 18 ends with 3 reflection questions for the reader. Coping strategy is named and practiced across 2-3 spreads.',
    reflectionPage: true,
  },
  E4: {
    tier: 'E4',
    label: 'Story + Reflection Emotional',
    range: [10, 14],
    vocabulary: 'no restriction. Metaphor, irony, ambiguity all permitted. Interior monologue extended.',
    maxWordsPerSpread: 90,
    sentencesPerSpread: '4-7',
    sentenceStyle: 'full literary prose. Varying rhythm intentional. Unreliable narrator possible.',
    conflict: 'emotional complexity fully expressed. The emotion may not be fully resolved by the end.',
    dialogue: '4-5 exchanges. Characters may be unreliable narrators. Subtext and silence used.',
    imagePromptStyle: 'cinematic, symbolic, mood-driven. Less literal — metaphor in image. Shadow/light contrast.',
    fearHandling: 'internal state. Child understands their own emotional patterns. May reflect on them.',
    arc: '6-act arc across 20 spreads. Spreads 18-19: Adult note to parent + Reflection section with writing prompts.',
    rhymeLevel: 'none. Literary prose only.',
    coachingNote: 'Last 2 spreads are structured differently: spread 19 = "For You" reflection with prompts + space to write. Spread 20 = "For the Adult Reading This" — a note about the emotional approach used in this book.',
    reflectionPage: true,
    adultNote: true,
  },
};

/**
 * Return the emotional tier and config for a given age.
 * @param {number|string} age
 * @returns {{ tier: string, config: object }}
 */
function getEmotionalAgeTier(age) {
  const a = Number(age) || 5;
  if (a <= 3)  return { tier: 'E1', config: EMOTIONAL_AGE_TIERS.E1 };
  if (a <= 6)  return { tier: 'E2', config: EMOTIONAL_AGE_TIERS.E2 };
  if (a <= 9)  return { tier: 'E3', config: EMOTIONAL_AGE_TIERS.E3 };
  return       { tier: 'E4', config: EMOTIONAL_AGE_TIERS.E4 };
}

// ── Style Modes ──

const STYLE_MODES = {
  sparse: {
    label: 'Sparse & Precise',
    description: 'Sendak/Jeffers style. Short sentences. Maximum economy. Trust silence. The unsaid carries the weight.',
    writingBias: 'Use the fewest possible words. Prefer fragments over full sentences. Silence (null pages) is a tool. Cut anything the illustration can carry.',
    criticBias: 'Do not add words. Do not expand. Only tighten.',
  },
  playful: {
    label: 'Playful & Absurd',
    description: 'Willems/Dahl style. Deadpan humor. Absurd logic. The narrator winks at the reader. The world has silly rules.',
    writingBias: 'Lean into comic timing. Use the page turn for punchlines. The narrator has opinions. Objects have personality. At least 3 funny moments.',
    criticBias: 'Protect humor. Do not make funny lines "smoother" or "more literary." Rough edges are features.',
  },
  lyrical: {
    label: 'Lyrical & Musical',
    description: 'Donaldson/Dr. Seuss style. Strong rhythm. Rhyming couplets. The story sings. Read-aloud quality is everything.',
    writingBias: 'Prioritize rhythm and rhyme. Every line should feel good in the mouth. Musical flow > narrative complexity.',
    criticBias: 'Protect rhythm above all. Do not break a rhyming pattern to add a "stronger" verb.',
  },
  tender: {
    label: 'Tender & Meditative',
    description: 'Klassen/Portis style. Quiet. Observational. Gentle pacing. The story breathes. Emotion through stillness.',
    writingBias: 'Slow pacing is intentional. Small moments > big events. The story does not need to rush. Sensory detail over action.',
    criticBias: 'Do not add tension where calm is the point. Do not speed up pacing. Stillness is a feature.',
  },
  mischievous: {
    label: 'Mischievous & Energetic',
    description: 'Barnett/Oliver Jeffers style. Kinetic energy. Rules being broken. The child is slightly naughty. The world is surprising.',
    writingBias: 'The child acts first, thinks later. Things go slightly wrong. Energy builds. The narrator is amused.',
    criticBias: 'Protect energy. Do not smooth chaos into calm. The slight messiness is the charm.',
  },
};

// ── V3 Brief Template (Author-Level) ──

const V2_BRIEF_TEMPLATE = `CHILDREN'S BEDTIME BOOK GENERATION — V3 (AUTHOR-LEVEL)

You are writing a personalized bedtime picture book that should feel as if it was written by a world-class children's author.

This is NOT generic content.
This book must feel intentional, specific, emotional, and re-readable.

-------------------------------------
CORE PRINCIPLE
-------------------------------------
The child is the active emotional force of the story.
The story does not happen to the child — the child changes the story.

-------------------------------------
INPUTS
-------------------------------------
- Child name: {name}
- Age: {age} (minimum 3)
- Favorite object: {favorite_object}
- Fear or challenge: {fear}
- Setting (optional): {setting}
- Dedication (optional): {dedication}
- Gift is from: {gifterFrom}

-------------------------------------
WRITING QUALITY OVERRIDES (MANDATORY)
-------------------------------------
{poeticRule}

- Never state emotions directly (no: "she was scared", "he felt happy").
  Always show emotion through action, sensory detail, or environment.

- PUNCTUATION (CRITICAL): Do NOT use em-dashes (\u2014) or en-dashes (\u2013) anywhere in the story text. Use commas, periods, or ellipses instead. Children\u2019s books use simple punctuation only. If you would write "She held Momo closer \u2014 one ear still warm" write instead "She held Momo closer. One ear still warm" or "She held Momo closer, one ear still warm."

- DIALECT & SPELLING \u2014 use {dialect} throughout:
  {dialectRule}
  Never mix dialects. Every single word in the story text, dedication, and any labels must be consistent.

- Every spread must contain a small tension, question, or imbalance.

- The child must actively cause the turning point and resolution.

- Use concrete, sensory language. Avoid vague words like "thing", "stuff", "very", "nice", "pretty", "fun", "special", "magical".

CLARITY FOR YOUNG READERS (CRITICAL for ages 3-6):
- Every image and metaphor must be LITERAL enough for the child to picture. A parent enjoys the rhythm; a child must understand the picture.
- BAD: "Sun stripes the rug with bars of gold" — a 3-year-old cannot parse this. GOOD: "Sunlight falls across the rug."
- BAD: "Toast is a map, and they ride it through" — confusing metaphor. GOOD: "He holds the toast like a steering wheel."
- If you mix imagination and reality, SIGNAL the shift clearly: "The puddle BECAME an ocean" not "A puddle turns into a bright blue sea" (which sounds literal and confusing).
- When in doubt, choose the simpler image. The parent will appreciate clarity too.

- Include one repeated phrase that appears at least twice and evolves in meaning by the climax.

- Include one subtle emotional layer that resonates with the parent reading.

- Every 2 spreads must include at least one short sentence (<=5 words) for rhythm.

- At least one line in the story must be memorable enough that a parent would want to repeat it even outside the book.

TEXT LENGTH (CRITICAL):
- Each spread's combined text (left + right pages) must not exceed {maxWordsPerSpread} words.
- Shorter is always better. Every word must earn its place.
- Trust the illustration to carry the scene — do not over-explain in text.
- If you find yourself writing more than 2 sentences per page, cut ruthlessly.

-------------------------------------
AUTHORIAL VOICE (MANDATORY)
-------------------------------------
{authorialVoice}

NARRATOR VOICE (CRITICAL):
Before writing a single word, decide the narrator's personality. The narrator is NOT neutral.
Choose ONE voice for the entire story and commit to it:
- Conspiratorial: "Now, between you and me, this is the part where things get interesting."
- Breathless: "And then — oh, and THEN — the door opened."
- Wry/Amused: "Which, as everyone knows, is exactly the wrong thing to do."
- Gentle: "The moon was patient. It had done this before."
- Matter-of-fact: "The bear was in the kitchen. This was a problem."

The voice must be consistent across every spread. Every sentence should sound like the same person telling the story. If you can swap sentences between spreads and nobody notices, the voice isn't strong enough.

STYLE MODE BIAS:
{style_mode_bias}

ADVANCED TECHNIQUE BUDGET:
Your brainstorm selected these techniques: {techniques}. Execute ONLY these with full commitment.
Do NOT try to include all techniques — a story that does 2 things brilliantly
beats a story that does 5 things mechanically.

IF you selected "rule_of_three":
RULE OF THREE — Three attempts, three encounters, three obstacles. The third breaks the pattern.
- Repetition 1: Establish the pattern. The reader learns the rules.
- Repetition 2: Vary slightly. Escalate the stakes. The reader anticipates.
- Repetition 3: BREAK the pattern. Subvert, invert, or escalate beyond expectation.
Example (Gruffalo): Three animals warn the mouse, then the Gruffalo actually appears (inversion).

IF you selected "surprise":
SURPRISE — One genuinely unexpected moment: character subversion, situation twist, perspective shift, or emotional surprise.
The surprise must feel EARNED — not random. The reader should think "I didn't see that coming, but of course."

IF you selected "humor":
HUMOR THROUGH STRUCTURE — Comic timing, running gags, deadpan delivery.
- COMIC TIMING: Setup on one spread, punchline revealed on the next.
- RUNNING GAGS: Introduce something funny early and let it recur 2-3 times, escalating.
- THE CHILD IS FUNNY: Let the child say or do something unexpected, observant, or accidentally wise.
- For bedtime themes: humor should be gentle and cozy. For adventure themes: humor can be bigger.

IF you selected "page_turn_hooks":
PAGE-TURN HOOKS — Use the physical page turn as a dramatic device.
- At least 3 spreads must end with a line that pulls the reader forward.
- Place hooks at the END of spreads 2, 4, 6, and/or 8 (the rising-action spreads).

IF you selected "lyrical_repetition":
LYRICAL REPETITION — A repeated phrase or structure that creates rhythm and evolves.
- The phrase appears at least 3 times, shifting in meaning each time.

After choosing, commit fully. Half-measures are worse than not including the technique at all.

VERB POWER (MANDATORY):
The verb carries action AND emotion in one word. Never use a weak verb + adverb when a strong verb exists.
- "walked quickly" → "darted" or "scrambled"
- "said quietly" → "whispered" or "murmured"
- "looked carefully" → "peered" or "squinted"
- "ran fast" → "bolted" or "tore"
- "fell down" → "tumbled" or "crashed"

Before finalizing, scan every sentence. If you find an adverb modifying a verb, replace both with a single stronger verb.

EMOTIONAL RESTRAINT:
Trust the reader to feel the emotion. Do NOT amplify or explain.
- After a sad moment, do NOT add "and a tear rolled down her cheek." The situation is enough.
- After a triumph, do NOT add "she had never been so happy." Show the action.
- The most powerful emotional moments in children's literature use the FEWEST words.
  - Sendak: "And it was still hot." (10 words. Max returning home. The whole book lands in this sentence.)
  - Jeffers: "So he took him home." (Six words. The entire emotional resolution.)
- When in doubt, CUT the emotional sentence. If the emotion is clear from context, the extra sentence weakens it.

UNDERSTATEMENT > OVERSTATEMENT. Always.

ANTI-KITSCHY RULES (CRITICAL — violating these produces generic books):
- REJECT any of these patterns: "the real treasure was...", "love is the strongest...", "you are special just the way you are", "they learned that the most important thing is...", "and they all lived happily...", "the magic was inside them all along", "home is where the heart is", "with love, anything is possible".
- REJECT vague emotional summaries at the end: "and the child felt warm and happy and loved." Instead, show ONE specific image: "She pressed her nose against the window. The stars were still there."
- REJECT moralizing: never end with a lesson, a realization announced aloud, or a character explaining what they learned.
- The story should make the parent FEEL something real — not just feel like they read a nice story. Aim for a lump in the throat, not a nod of approval.

ANTI-REPETITION RULE (CRITICAL):
- Do NOT reuse the same phrase, image, or sentence structure across multiple spreads.
- Each spread must use FRESH language — if you described the child "taking a step" on one spread, use a completely different image for movement on the next.
- The ONLY phrase that may repeat is the story's intentional evolving phrase (from the phrase_arc). Everything else must be unique.
- If you catch yourself writing a similar construction to a previous spread, stop and rewrite from a different angle.
- Repetitive phrasing is the #1 sign of lazy AI writing. A parent must never think "didn't I just read this?"

{rhythmGuide}

TONE:
- Warm but never sentimental. Intimate but never syrupy.
- Emotionally alive — every spread should make the reader feel something specific (curiosity, tenderness, surprise, delight, wonder), not vaguely "nice."
- Avoid moralizing or explicit lessons. If the story has a "message," it should be invisible — felt, not stated.
- Funny and tender should coexist. The funniest children's books are also the most moving. Humor is not the opposite of depth — it's the vehicle.

SOUND WORDS & ONOMATOPOEIA (age-appropriate):
{soundWordsRule}

- BIRTHDAY THEME EXCEPTION: Birthday books must feel like a celebration from spread 1. Warmth, joy, and excitement are the emotional baseline — not tension. The reader should feel like they are invited to a wonderful party, not reading a story about a problem to solve. The "every spread needs tension" rule does NOT apply — spreads 1-5 and 7-13 should be purely celebratory.

-------------------------------------
STORY ENGINE
-------------------------------------
- {favorite_object} is essential — it must actively help OR represent courage.
  Name it specifically every time. Never call it "the toy."
- {fear} must appear as a real obstacle the child moves THROUGH.
- {setting} (if provided) must shape the visual world of the story.
- {dedication} (if provided): use as written. If not provided, write: "For {name}."

ADVENTURE/QUEST BOOKS: The quest or mission must be named explicitly in spread 1 or 2. It must be specific and concrete ("find the lost color", "reach the top of Ember Hill", "return the golden acorn"). Vague adventures with no stated goal are not allowed. The final spread must resolve the quest — the child succeeded. "The world feels bigger" is not a resolution. "She held the golden acorn in both hands" is.

FAMILY MEMBERS — TEXT vs. ILLUSTRATIONS (CRITICAL):
- The story text MAY mention family members (parents, grandparents, siblings)
  by name — they can speak, tuck the child in, hum a song, etc.
- Family members must NEVER appear as visible characters in ILLUSTRATIONS.
  We only have the child's photo — any depiction of relatives would be a
  fabricated guess. A caregiver's presence can be implied in illustration
  prompts (a warm hand, a shadow, a light from a doorway) but never shown
  as a full person with a face.
- Fictional characters (animals, imaginary friends, fairies, shopkeepers,
  talking creatures) may appear freely in illustrations.

STRUCTURE:

Spreads 1-2:   Setup (normal world + emotional need)
Spreads 3-6:   Rising tension (problem grows, uncertainty increases)
Spreads 7-9:   Turning point + resolution (child takes action)
Spreads 10-11: Emotional release (world softens)
Spread 12:     The penultimate beat — one last moment of unresolved anticipation before the landing.

SCENE PACING (CRITICAL — interesting story, not a “home sandwich”):
- The book must feel **geographically alive**: aim for **at least 4 distinct, visually different physical settings** (park ≠ kitchen ≠ path ≠ shop — the illustrator should be able to draw clearly different backdrops). Do **not** fill the book with one interior (e.g. home) and slot a single “we went to the park” interlude in the middle — that reads as a dull loop.
- You may spend 2-3 consecutive spreads in one place to deepen a moment, but **change setting** as the story progresses; avoid more than **3-4 consecutive spreads in the same room** unless a beat truly requires it.
- A spread that introduces a brand-new activity unrelated to the previous spread is a RED FLAG. If you find yourself writing 13 different unrelated activities, you are writing a list, not a story — connect beats with a clear through-line and narrated movement.
- Group spreads into SCENES when it helps emotional build, with explicit transitions: show the characters moving, arriving, or shifting focus. Never jump-cut without one line of connective tissue.

-------------------------------------
PAGE-TURN TENSION (the secret weapon of great picture books)
-------------------------------------
The physical page turn is a dramatic device. Use it.

- At least 3 spreads must end with a LINE THAT PULLS THE READER FORWARD — a question, an incomplete action, a sound without a source, a "but then..." moment. The parent should WANT to turn the page.
- The best page-turn lines are short and unresolved:
  - "She reached inside and found..." (what??)
  - "The door was open." (what's behind it?)
  - "Something moved." (what was it?)
  - "But the sound wasn't coming from the forest." (then where?)
- Place page-turn hooks at the END of spreads 2, 4, 6, and/or 8 (the rising-action spreads).
- Spread 12 is the ULTIMATE page-turn: it must create maximum anticipation for the final spread.
- Do NOT put page-turn hooks on every spread — the contrast between resolved and unresolved spreads creates rhythm.
- The right page of a spread is the last thing read before the turn. If you want suspense, put the hook on the right page.

-------------------------------------
OPENING SPREAD (CRITICAL — the first spread determines whether a parent keeps reading)
-------------------------------------
- NEVER open with the child waking up, opening their eyes, or getting out of bed (unless bedtime theme specifically requires the routine).
- NEVER open with "One day..." / "Once upon a time..." / "It was a [adjective] morning..." / "The day began..."
- The first spread must drop the reader into a MOMENT — mid-action, mid-sensation, mid-observation.
- The opening line must contain a specific, concrete image that could only belong to THIS story.

GOOD OPENINGS (for calibration — do NOT copy):
- "The compass needle spun. Not north. Not south. It pointed at the wall."
- "Streamers hung from every doorknob. The house smelled like frosting and secrets."
- "The house creaked its old-wood song. Something in the attic was counting."
- "A single bubble rose from the drain. Then another. Then a hundred."

BAD OPENINGS (REJECT these patterns):
- "One sunny morning, [child] woke up to find..."
- "[Child] opened her eyes and saw something amazing."
- "It was a beautiful day in [setting]."
- "Once upon a time, there was a [adjective] child named [name]."

TIME OF DAY (IMPORTANT): The story does NOT need to follow a morning-to-night arc. The time of day must serve the story's emotional logic — not a default bedtime template. An adventure can begin at 2pm and end at sunset. A birthday can unfold entirely in the golden afternoon. A space story might begin and end at midnight. Choose the time that makes this specific story feel most alive. Only bedtime-themed books should default to evening/night.

-------------------------------------
TRANSFORMATION RULE (CRITICAL)
-------------------------------------
A repeated element (word, phrase, or concept — e.g. "the dark") must:

- Start as something uncertain or threatening
- Gradually change
- End as something safe, understood, or gentle

PHRASE ARC USAGE (CRITICAL):
The brainstorm provided a phrase_arc with 3 stages. You MUST use them.

TIMING (NON-NEGOTIABLE):
- The motif phrase MUST first appear by spread 2 or 3. NOT later. Early introduction = maximum impact.
- The phrase must appear a MINIMUM of 3 times across the story (4-5 is ideal for tier 1-2 picture books).
- Distribution: spreads 2-3 (introduce), spreads 5-7 (develop), spreads 10-12 (payoff). Never cluster all appearances at the end.

MEANING EVOLUTION:
- When the phrase appears in spreads 1-4: the surrounding action/imagery must reflect the EARLY meaning. The phrase should feel tentative, playful, or questioning.
- When the phrase appears in spreads 5-8: the surrounding action/imagery must reflect the MIDDLE meaning. The phrase should feel braver or more purposeful.
- When the phrase appears in spreads 10-13: the surrounding action/imagery must reflect the END meaning. The phrase should feel resolved, safe, or transforming.

Show the evolution through what the child DOES around the phrase — not by adding explanation.

MOTIF PATTERN (think "Goodnight Moon" or "We're Going on a Bear Hunt"):
- Introduce: The child says or encounters the phrase for the first time. It's simple, maybe a question.
- Repeat with variation: The phrase returns in a new context. The child's relationship to it shifts.
- Emotional payoff: The phrase appears one final time. Its meaning has transformed. This should be the most emotionally resonant moment.

-------------------------------------
ENDING RULES (CRITICAL)
-------------------------------------
- The final lines must feel EMOTIONALLY COMPLETE — not a whisper unless the theme calls for it. Match the ending energy to the theme:
  - ADVENTURE / BIRTHDAY / SPACE / SCIENCE / SCHOOL: End with warmth and triumph. The child succeeded. The final spread should feel JOYFUL and energized — not sleepy, not hushed. The reader should close the book feeling happy, not winding down.
  - FRIENDSHIP / NATURE / HOLIDAY: End with quiet joy and connection — warm and content, not sad.
  - BEDTIME ONLY: End with calm and settling — soft and safe.
  Never let a non-bedtime book end with sleepiness, exhaustion, or sadness.
- The world must feel physically and emotionally safe.
- The {favorite_object} should be present in the final moment.
- End with an image or feeling — NOT a lesson.
- ENDING CONCRETENESS (CRITICAL): The final 1-2 lines must be CONCRETE — a specific image, action, or sensory detail. NEVER end with an abstract poetic summary.
  - BAD: "all my love for Mama, soft and grand" — abstract, adult-poetic
  - BAD: "and the world felt warm with love" — vague emotional summary
  - BAD: "the whole day sang its gentle tune" — lyrical abstraction
  - GOOD: "Crumbs in my palm. For Mama." — concrete, simple, devastating
  - GOOD: "She pressed her nose against the window. The stars were still there." — specific image
  - GOOD: "Bear was in the bed. The bed was warm." — concrete sensory detail
  The simpler and more concrete the ending, the harder it hits. Trust the reader to feel the emotion from the image alone.
- ENDING ILLUSTRATION — ADVENTURE/JOURNEY THEMES: If this is an adventure, science, space, underwater, fantasy, school, or nature book, the final spread illustration must show the child in the moment AFTER the climax — triumphant, still, changed — NOT in a bedroom, NOT in pajamas, NOT going to sleep. The story ends where the journey ends: on the hill, at the lab bench, under the stars, in the garden. Sleep is implied by the emotional landing, never shown.
- ENDING ILLUSTRATION — BEDTIME/FRIENDSHIP themes only: the final spread may show the child settling in, cozy, eyes closing — but never literally sitting by a door or in a hallway. The final location must be warm and interior: a bed, a couch, a nest of pillows.

-------------------------------------
PERSONAL HOOK INTEGRATION (MANDATORY)
-------------------------------------

You are given personal details about the child and caregiver.
You must transform them into natural story elements — NOT insert them literally.

Each personal detail must become ONE of the following:

1. REFRAIN (repeatable phrase)
- If a playful or unique phrase is provided (e.g. "tinky tinky"),
  use it as a recurring, soothing refrain.
- It must appear 2–4 times across the story.
- It should feel like part of a bedtime ritual, not an interruption.

2. PHYSICAL RITUAL
- Convert physical behaviors into gentle actions in the story.
  Example: toe sniffing → toe tapping, toe counting, gentle tickling.
- These actions should ground the story in the body.

3. EMOTIONAL ANCHOR
- Caregiver relationships (e.g. grandmother) must shape tone:
  voice, warmth, rhythm, safety.
- The caregiver should feel like the source of calm.

4. SYMBOLIC TRANSFORMATION
- Sensitive or complex details (e.g. death, family history)
  must NOT be stated directly.
- Instead, convert them into:
  - continuity
  - presence
  - quiet warmth
  - "someone watching over"

-------------------------------------
USAGE RULES
-------------------------------------

- Never force personal phrases unnaturally into sentences.
- Never break tone or rhythm to include a detail.
- The reader should feel:
  "this story was written for us" — not "this detail was inserted."

- Prioritize subtlety over completeness:
  it is better to use 2 details beautifully than 5 awkwardly.

-------------------------------------
REFRAIN QUALITY RULE (CRITICAL)
-------------------------------------

If a refrain is used:
- It must feel soothing when repeated
- It should slightly evolve in meaning across the story
- It should appear naturally in dialogue or rhythm

Example progression:
early → playful
middle → guiding
end → calming / closing

{exemplars}

-------------------------------------
ILLUSTRATION PROMPTS
-------------------------------------
For each spread, include a spread_image_prompt that describes the visual scene.
- Describe composition, lighting, color palette, perspective, and one texture detail.
- Do NOT specify art medium or style — that is handled separately.
- Show emotion through body language, environment, and light — never label it.
- {name}'s appearance must be consistent across all prompts — SAME hair style, hair color, hair length, and clothing in every single illustration.
- {favorite_object} must look identical every time it appears.
- Time of day and lighting must follow story logic.
- Only include objects in illustration prompts that serve the story. No random props.
- Do NOT describe the child changing clothes, getting wet/dirty in ways that alter outfit appearance, or wearing anything different from the defined characterOutfit.
- Do NOT describe the child's hair changing (wind-blown, messy from sleep, tied differently, etc.) — hair must stay exactly as defined.
- NEVER depict family members (parents, siblings, grandparents) in any illustration prompt. Caregivers may only be implied (a warm hand, a shadow, a voice). Fictional characters are fine.

-------------------------------------
CHARACTER VISUAL CONSISTENCY (CRITICAL)
-------------------------------------
You MUST define the child's appearance ONCE at the top level so every
illustration matches. This is non-negotiable — inconsistent visuals ruin
the printed book.

Define these top-level fields:
- "characterOutfit": ONE specific outfit the child wears in EVERY spread.
  Be precise: garment type, color, patterns, shoes/socks, accessories.
  Example: "a red hoodie with a small star patch on the chest, dark blue jeans, white sneakers with red laces, and a yellow beanie hat"
  The child wears this SAME outfit from spread 1 to the last spread. No exceptions.
  - No added layers, no removed items, no changes due to weather, activity, or time of day.
  - If the story takes place in rain — the child is still in the exact same outfit.
  - If the story involves water or mud — the scene composition avoids showing the body below the neck, or the illustration shows them from behind or at a distance. The outfit does NOT change.
  - NEVER have the child change clothes, get visibly wet/muddy, or wear anything different from the defined characterOutfit.
  - The illustrator will be given this exact outfit description for every single spread and must match it exactly.

- "characterDescription": Physical appearance details beyond the photo.
  MUST include a detailed hair description (color, style, length, texture, parting).
  MUST explicitly state hair accessories: if the child has a headband, bow, clip, ribbon, or elastic, describe it exactly (color, position). If the child has NO hair accessories, write "no hair accessories."
  Also include posture, height relative to surroundings, any distinguishing features.
  The hair MUST remain IDENTICAL in every illustration — no wind-blown variations, no messy-from-sleep versions, no style changes, no added or removed accessories.

- "recurringElement": The {favorite_object}'s exact visual description so it
  looks identical on every page. Example: "a small brown teddy bear with a
  red bow tie, slightly worn left ear, and button eyes"

- "keyObjects": Other objects that recur across spreads, with exact
  visual details so they stay consistent. ONLY include objects that are
  meaningful to the plot — if an object appears in illustrations, it must
  have a reason to exist in the story. Do NOT add random props or filler
  objects. Less is more. Example: "a blue flashlight with silver trim"

-------------------------------------
OUTPUT FORMAT (MANDATORY JSON)
-------------------------------------
Return a JSON object with this structure:
{
  "title": "The book title",
  "characterOutfit": "exact outfit description — same in every spread",
  "characterDescription": "physical appearance details",
  "recurringElement": "exact visual description of the recurring companion/object",
  "keyObjects": "other recurring visual elements with exact descriptions",
  "entries": [
    { "type": "dedication_page", "text": "..." },
    { "type": "spread", "spread": 1, "left": { "text": "..." }, "right": { "text": "..." }, "spread_image_prompt": "..." },
    ...13 spreads total...
  ]
}

Front matter pages (half-title, title page, copyright) are added automatically — do NOT include them.
The "entries" array must contain exactly: 1 dedication_page + 13 spreads = 14 entries.

Rules:
- ONE-SIDE TEXT RULE (CRITICAL): Each spread MUST have text in EXACTLY ONE of left or right. The other side MUST be null. NEVER put text on both sides — a spread is never text-on-both-left-and-right. Choose the side that best serves the rhythm (hook on the right for page-turn suspense; opening statement on the left). Alternate sides across spreads for visual variety.
- spread_image_prompt describes ONE CONTINUOUS PANORAMIC SCENE (wide landscape, like a movie still or panoramic photograph). Write it as a single unified scene — NOT as separate left-side and right-side descriptions.
- IMPORTANT: Do NOT describe content as being "on the left" and other content "on the right." Describe ONE flowing scene with the child as the focal point and the environment surrounding them naturally. The child MUST be positioned in the left third or right third of the scene — NOT at the center. Never describe the child as standing in the middle of the scene.
- Do NOT specify art medium in spread_image_prompt.
- Do NOT re-describe the outfit in spread_image_prompt — it is defined once at the top level.
- Do NOT re-describe hair or hair accessories in spread_image_prompt — they are defined once in characterDescription. Never mention headbands, bows, clips, or any hair accessory in individual spread prompts.
- Use apostrophes directly in strings (no escaping needed).
- No newlines inside string values.

TITLE RULES (CRITICAL):
- The title MUST include the child's name: "{name}" or a possessive form ("{name}'s").
- The title must reference something SPECIFIC to THIS story — the quest, the setting, the repeated phrase, or the favorite object. NOT a generic concept.
- Keep it short: 3-8 words maximum.
- GOOD titles: "{name} and the Map That Remembered", "{name}'s Midnight Garden", "The Day {name} Found the Stars"
- BAD titles: "{name}'s Adventure", "{name}'s Special Day", "A Magical Journey", "The Brave Little Child"
- If the title could apply to ANY child's book, it's too generic. Rewrite it.

-------------------------------------
FINAL CHECK BEFORE OUTPUT
-------------------------------------
Before writing, silently verify:
- Is the child the one who changes the outcome?
- Is emotion shown, not told?
- Is there at least one memorable line a parent would repeat outside the book?
- Does the repeated phrase transform from uncertain to safe?
- Does the ending feel soft and satisfying?
- Does the title include the child's name and reference something specific to THIS story?
- Does every spread have text on at least one page (left or right)? No spread may have null text on both pages.
- Are there exactly 13 spreads (not fewer, not more)?
- Does characterDescription include a specific hair description (color, style, length)?
- Does characterOutfit describe a complete, specific outfit?
- Do any spread_image_prompts describe the child changing clothes or hairstyle? (If yes, remove those descriptions)

Only proceed if all answers are YES.`;

// ── Writing-Only Brief (for free-form text generation — no JSON) ──

const WRITING_BRIEF_TEMPLATE = `SYSTEM ROLE:
You are a world-class children's picture book writer.

Your writing should be musical, simple, emotionally resonant, and original.
Do NOT imitate or reference any specific author or existing book.

This is a personalized book for a specific child. Use their name, interests, and personal details naturally — not literally.

---

OBJECTIVE:
Write a bedtime picture book for the child described below.

The story should feel like a soft, dreamlike journey with a gentle build of curiosity,
a moment of uncertainty, and a comforting emotional resolution.

-------------------------------------
CORE PRINCIPLE
-------------------------------------
The child is the active emotional force of the story.
The story does not happen to the child — the child changes the story.

-------------------------------------
INPUTS
-------------------------------------
- Child name: {name}
- Age: {age} (minimum 3)
- Favorite object: {favorite_object}
- Fear or challenge: {fear}
- Setting (optional): {setting}
- Gift is from: {gifterFrom}

---

STYLE RULES:

1. RHYTHM & FLOW (CRITICAL — this book is read aloud)
- After writing EACH spread, read it aloud in your head. If it stumbles anywhere, rewrite it before moving on.
- Syllable target: 8–14 syllables per sentence. Count stressed syllables as you write.
- Use short, musical sentences — varied length creates natural breathing points.
- Avoid: consecutive hard consonants that create tongue twisters.
- Avoid: three-word noun stacks ("big bright bold") or abstract modifiers.
- Avoid: words over 3 syllables unless it is a character name or a meaningful invented sound.
- Every spread must have at least ONE short sentence of 5 words or fewer for rhythm contrast.

2. RHYME (MUSICAL AND RHYTHMIC — think Dr. Seuss or Julia Donaldson)
- {rhymeLevel}
- Use rhyming couplets or AABB rhyme schemes where the tier calls for it.
- Every spread should aim for at least one rhyming pair (exact or near-rhyme).
- The story should have a musical, rhythmic quality that makes it a joy to read aloud.
- A near-rhyme or internal rhyme is always better than a strained end-rhyme.
- Prioritize natural-sounding rhymes over forced ones — if a rhyme bends the meaning, drop it.
- Rhymes that feel inevitable are the goal — the reader should feel the rhyme before they hear it.

3. LANGUAGE LEVEL
- Vocabulary suitable for the child's age
- Prefer concrete, visual words (blanket, moon, steps, glow)
- Avoid abstract phrases and vague words ("magical", "special", "nice", "wonderful")
- CLARITY FOR YOUNG READERS (ages 3-6): Every image and metaphor must be literal enough for the child to picture. If you mix imagination and reality, signal the shift clearly ("The puddle BECAME an ocean" not "A puddle turns into a bright blue sea"). When in doubt, choose the simpler image.

3.5 PUNCTUATION (CRITICAL): Do NOT use em-dashes (\u2014) or en-dashes (\u2013) anywhere in the story text. Use commas, periods, or ellipses instead. Children\u2019s books use simple punctuation only.

3.6 DIALECT & SPELLING \u2014 use {dialect} throughout:
{dialectRule}
Never mix dialects. Every single word in the story must be consistent with the locale above.

4. PLAYFUL INVENTION
- Allow occasional invented words or sounds (e.g. "tinky", "luma", "sniffle-pop")
- These should be easy to pronounce and emotionally meaningful
- Only use if they arise naturally from the story

5. IMAGE ANCHORING (VERY IMPORTANT)
- Each spread must include at least ONE clear, visual, concrete image or action
- A child should be able to draw the scene from the words alone

6. ESCALATION
- Each spread should slightly increase curiosity, movement, or wonder
- Mid-story must include a small moment of doubt, silence, or "loss"

7. EMOTIONAL ARC
- Beginning: calm / safe
- Middle: curious / searching / slightly uncertain
- End: warm / reassuring / emotionally satisfying

8. MESSAGE (IMPLICIT ONLY)
- Do NOT state the lesson directly
- The meaning should be felt, not explained

9. NEVER STATE EMOTIONS DIRECTLY
- No: "she was scared", "he felt happy"
- Always show through action, sensory detail, or environment

10. THE CHILD IS ACTIVE
- The child moves, searches, tries, listens, or acts
- The story does not happen TO the child — the child CHANGES the story

TEXT LENGTH (CRITICAL):
- Each spread's combined text (left + right pages) must not exceed {maxWordsPerSpread} words.
- Shorter is always better. Every word must earn its place.
- Trust the illustration to carry the scene — do not over-explain in text.

-------------------------------------
AUTHORIAL VOICE (MANDATORY)
-------------------------------------
{authorialVoice}

NARRATOR VOICE (CRITICAL):
Before writing a single word, decide the narrator's personality. The narrator is NOT neutral.
Choose ONE voice for the entire story and commit to it:
- Conspiratorial: "Now, between you and me, this is the part where things get interesting."
- Breathless: "And then — oh, and THEN — the door opened."
- Wry/Amused: "Which, as everyone knows, is exactly the wrong thing to do."
- Gentle: "The moon was patient. It had done this before."
- Matter-of-fact: "The bear was in the kitchen. This was a problem."

The voice must be consistent across every spread. Every sentence should sound like the same person telling the story. If you can swap sentences between spreads and nobody notices, the voice isn't strong enough.

STYLE MODE BIAS:
{style_mode_bias}

ADVANCED TECHNIQUE BUDGET:
Your brainstorm selected these techniques: {techniques}. Execute ONLY these with full commitment.
Do NOT try to include all techniques — a story that does 2 things brilliantly
beats a story that does 5 things mechanically.

IF you selected "rule_of_three":
RULE OF THREE — Three attempts, three encounters, three obstacles. The third breaks the pattern.
- Repetition 1: Establish the pattern. The reader learns the rules.
- Repetition 2: Vary slightly. Escalate the stakes. The reader anticipates.
- Repetition 3: BREAK the pattern. Subvert, invert, or escalate beyond expectation.
Example (Gruffalo): Three animals warn the mouse, then the Gruffalo actually appears (inversion).

IF you selected "surprise":
SURPRISE — One genuinely unexpected moment: character subversion, situation twist, perspective shift, or emotional surprise.
The surprise must feel EARNED — not random. The reader should think "I didn't see that coming, but of course."

IF you selected "humor":
HUMOR THROUGH STRUCTURE — Comic timing, running gags, deadpan delivery.
- COMIC TIMING: Setup on one spread, punchline revealed on the next.
- RUNNING GAGS: Introduce something funny early and let it recur 2-3 times, escalating.
- THE CHILD IS FUNNY: Let the child say or do something unexpected, observant, or accidentally wise.
- For bedtime themes: humor should be gentle and cozy. For adventure themes: humor can be bigger.

IF you selected "page_turn_hooks":
PAGE-TURN HOOKS — Use the physical page turn as a dramatic device.
- At least 3 spreads must end with a line that pulls the reader forward.
- Place hooks at the END of spreads 2, 4, 6, and/or 8 (the rising-action spreads).

IF you selected "lyrical_repetition":
LYRICAL REPETITION — A repeated phrase or structure that creates rhythm and evolves.
- The phrase appears at least 3 times, shifting in meaning each time.

After choosing, commit fully. Half-measures are worse than not including the technique at all.

VERB POWER (MANDATORY):
The verb carries action AND emotion in one word. Never use a weak verb + adverb when a strong verb exists.
- "walked quickly" → "darted" or "scrambled"
- "said quietly" → "whispered" or "murmured"
- "looked carefully" → "peered" or "squinted"
- "ran fast" → "bolted" or "tore"
- "fell down" → "tumbled" or "crashed"

Before finalizing, scan every sentence. If you find an adverb modifying a verb, replace both with a single stronger verb.

EMOTIONAL RESTRAINT:
Trust the reader to feel the emotion. Do NOT amplify or explain.
- After a sad moment, do NOT add "and a tear rolled down her cheek." The situation is enough.
- After a triumph, do NOT add "she had never been so happy." Show the action.
- The most powerful emotional moments in children's literature use the FEWEST words.
  - Sendak: "And it was still hot." (10 words. Max returning home. The whole book lands in this sentence.)
  - Jeffers: "So he took him home." (Six words. The entire emotional resolution.)
- When in doubt, CUT the emotional sentence. If the emotion is clear from context, the extra sentence weakens it.

UNDERSTATEMENT > OVERSTATEMENT. Always.

ANTI-KITSCHY RULES (CRITICAL — violating these produces generic books):
- REJECT any of these patterns: "the real treasure was...", "love is the strongest...", "you are special just the way you are", "they learned that the most important thing is...", "and they all lived happily...", "the magic was inside them all along", "home is where the heart is", "with love, anything is possible".
- REJECT vague emotional summaries at the end: "and the child felt warm and happy and loved." Instead, show ONE specific image: "She pressed her nose against the window. The stars were still there."
- REJECT moralizing: never end with a lesson, a realization announced aloud, or a character explaining what they learned.
- The story should make the parent FEEL something real — not just feel like they read a nice story. Aim for a lump in the throat, not a nod of approval.

ANTI-REPETITION RULE (CRITICAL):
- Do NOT reuse the same phrase, image, or sentence structure across multiple spreads.
- Each spread must use FRESH language — if you described the child "taking a step" on one spread, use a completely different image for movement on the next.
- The ONLY phrase that may repeat is the story's intentional evolving phrase (from the phrase_arc). Everything else must be unique.
- If you catch yourself writing a similar construction to a previous spread, stop and rewrite from a different angle.
- Repetitive phrasing is the #1 sign of lazy AI writing. A parent must never think "didn't I just read this?"

{rhythmGuide}

TONE:
- Warm but never sentimental. Intimate but never syrupy.
- Emotionally alive — every spread should make the reader feel something specific (curiosity, tenderness, surprise, delight, wonder), not vaguely "nice."
- Avoid moralizing or explicit lessons. If the story has a "message," it should be invisible — felt, not stated.
- Funny and tender should coexist. The funniest children's books are also the most moving. Humor is not the opposite of depth — it's the vehicle.

SOUND WORDS & ONOMATOPOEIA (age-appropriate):
{soundWordsRule}

- BIRTHDAY THEME EXCEPTION: Birthday books must feel like a celebration from spread 1. Warmth, joy, and excitement are the emotional baseline — not tension. The reader should feel like they are invited to a wonderful party, not reading a story about a problem to solve. The "every spread needs tension" rule does NOT apply — spreads 1-5 and 7-13 should be purely celebratory.

-------------------------------------
STORY ENGINE
-------------------------------------
- {favorite_object} is essential — it must actively help OR represent courage.
  Name it specifically every time. Never call it "the toy."
- {fear} must appear as a real obstacle the child moves THROUGH.
- {setting} (if provided) must shape the visual world of the story.

ADVENTURE/QUEST BOOKS: The quest or mission must be named explicitly in spread 1 or 2. It must be specific and concrete ("find the lost color", "reach the top of Ember Hill", "return the golden acorn"). Vague adventures with no stated goal are not allowed. The final spread must resolve the quest — the child succeeded. "The world feels bigger" is not a resolution. "She held the golden acorn in both hands" is.

FAMILY MEMBERS — TEXT vs. ILLUSTRATIONS:
- The story text MAY mention family members (parents, grandparents, siblings)
  by name — they can speak, tuck the child in, hum a song, etc.
- However, when writing scenes, keep in mind that family members will NEVER
  be shown in illustrations. Design scenes so the child is the visual focus.
  When a family member speaks or acts, frame it so the illustration can show
  the child's reaction, or the effect (a warm light, a tucked blanket, a
  shadow in the doorway) rather than the relative's face or full body.

STRUCTURE:

Spreads 1-2:   Setup (normal world + emotional need)
Spreads 3-6:   Rising tension (problem grows, uncertainty increases)
Spreads 7-9:   Turning point + resolution (child takes action)
Spreads 10-11: Emotional release (world softens)
Spread 12:     The penultimate beat — one last moment of unresolved anticipation before the landing.

SCENE PACING (CRITICAL — interesting story, not a “home sandwich”):
- The book must feel **geographically alive**: aim for **at least 4 distinct, visually different physical settings** (park ≠ kitchen ≠ path ≠ shop — the illustrator should be able to draw clearly different backdrops). Do **not** fill the book with one interior (e.g. home) and slot a single “we went to the park” interlude in the middle — that reads as a dull loop.
- You may spend 2-3 consecutive spreads in one place to deepen a moment, but **change setting** as the story progresses; avoid more than **3-4 consecutive spreads in the same room** unless a beat truly requires it.
- A spread that introduces a brand-new activity unrelated to the previous spread is a RED FLAG. If you find yourself writing 13 different unrelated activities, you are writing a list, not a story — connect beats with a clear through-line and narrated movement.
- Group spreads into SCENES when it helps emotional build, with explicit transitions: show the characters moving, arriving, or shifting focus. Never jump-cut without one line of connective tissue.

-------------------------------------
PAGE-TURN TENSION (the secret weapon of great picture books)
-------------------------------------
The physical page turn is a dramatic device. Use it.

- At least 3 spreads must end with a LINE THAT PULLS THE READER FORWARD — a question, an incomplete action, a sound without a source, a "but then..." moment. The parent should WANT to turn the page.
- The best page-turn lines are short and unresolved:
  - "She reached inside and found..." (what??)
  - "The door was open." (what's behind it?)
  - "Something moved." (what was it?)
  - "But the sound wasn't coming from the forest." (then where?)
- Place page-turn hooks at the END of spreads 2, 4, 6, and/or 8 (the rising-action spreads).
- Spread 12 is the ULTIMATE page-turn: it must create maximum anticipation for the final spread.
- Do NOT put page-turn hooks on every spread — the contrast between resolved and unresolved spreads creates rhythm.
- The right page of a spread is the last thing read before the turn. If you want suspense, put the hook on the right page.

-------------------------------------
OPENING SPREAD (CRITICAL — the first spread determines whether a parent keeps reading)
-------------------------------------
- NEVER open with the child waking up, opening their eyes, or getting out of bed (unless bedtime theme specifically requires the routine).
- NEVER open with "One day..." / "Once upon a time..." / "It was a [adjective] morning..." / "The day began..."
- The first spread must drop the reader into a MOMENT — mid-action, mid-sensation, mid-observation.
- The opening line must contain a specific, concrete image that could only belong to THIS story.

GOOD OPENINGS (for calibration — do NOT copy):
- "The compass needle spun. Not north. Not south. It pointed at the wall."
- "Streamers hung from every doorknob. The house smelled like frosting and secrets."
- "The house creaked its old-wood song. Something in the attic was counting."
- "A single bubble rose from the drain. Then another. Then a hundred."

BAD OPENINGS (REJECT these patterns):
- "One sunny morning, [child] woke up to find..."
- "[Child] opened her eyes and saw something amazing."
- "It was a beautiful day in [setting]."
- "Once upon a time, there was a [adjective] child named [name]."

TIME OF DAY (IMPORTANT): The story does NOT need to follow a morning-to-night arc. The time of day must serve the story's emotional logic — not a default bedtime template. An adventure can begin at 2pm and end at sunset. A birthday can unfold entirely in the golden afternoon. A space story might begin and end at midnight. Choose the time that makes this specific story feel most alive. Only bedtime-themed books should default to evening/night.

-------------------------------------
TRANSFORMATION RULE (CRITICAL)
-------------------------------------
A repeated element (word, phrase, or concept — e.g. "the dark") must:

- Start as something uncertain or threatening
- Gradually change
- End as something safe, understood, or gentle

PHRASE ARC USAGE (CRITICAL):
The brainstorm provided a phrase_arc with 3 stages. You MUST use them.

TIMING (NON-NEGOTIABLE):
- The motif phrase MUST first appear by spread 2 or 3. NOT later. Early introduction = maximum impact.
- The phrase must appear a MINIMUM of 3 times across the story (4-5 is ideal for tier 1-2 picture books).
- Distribution: spreads 2-3 (introduce), spreads 5-7 (develop), spreads 10-12 (payoff). Never cluster all appearances at the end.

MEANING EVOLUTION:
- When the phrase appears in spreads 1-4: the surrounding action/imagery must reflect the EARLY meaning. The phrase should feel tentative, playful, or questioning.
- When the phrase appears in spreads 5-8: the surrounding action/imagery must reflect the MIDDLE meaning. The phrase should feel braver or more purposeful.
- When the phrase appears in spreads 10-13: the surrounding action/imagery must reflect the END meaning. The phrase should feel resolved, safe, or transforming.

Show the evolution through what the child DOES around the phrase — not by adding explanation.

MOTIF PATTERN (think "Goodnight Moon" or "We're Going on a Bear Hunt"):
- Introduce: The child says or encounters the phrase for the first time. It's simple, maybe a question.
- Repeat with variation: The phrase returns in a new context. The child's relationship to it shifts.
- Emotional payoff: The phrase appears one final time. Its meaning has transformed. This should be the most emotionally resonant moment.

-------------------------------------
ENDING RULES (CRITICAL)
-------------------------------------
- The final lines must feel EMOTIONALLY COMPLETE — not a whisper unless the theme calls for it. Match the ending energy to the theme:
  - ADVENTURE / BIRTHDAY / SPACE / SCIENCE / SCHOOL: End with warmth and triumph. The child succeeded. The final spread should feel JOYFUL and energized — not sleepy, not hushed. The reader should close the book feeling happy, not winding down.
  - FRIENDSHIP / NATURE / HOLIDAY: End with quiet joy and connection — warm and content, not sad.
  - BEDTIME ONLY: End with calm and settling — soft and safe.
  Never let a non-bedtime book end with sleepiness, exhaustion, or sadness.
- The world must feel physically and emotionally safe.
- The {favorite_object} should be present in the final moment.
- End with an image or feeling — NOT a lesson.
- ENDING CONCRETENESS (CRITICAL): The final 1-2 lines must be CONCRETE — a specific image, action, or sensory detail. NEVER end with an abstract poetic summary.
  - BAD: "all my love for Mama, soft and grand" — abstract, adult-poetic
  - BAD: "and the world felt warm with love" — vague emotional summary
  - BAD: "the whole day sang its gentle tune" — lyrical abstraction
  - GOOD: "Crumbs in my palm. For Mama." — concrete, simple, devastating
  - GOOD: "She pressed her nose against the window. The stars were still there." — specific image
  - GOOD: "Bear was in the bed. The bed was warm." — concrete sensory detail
  The simpler and more concrete the ending, the harder it hits. Trust the reader to feel the emotion from the image alone.
- ENDING ILLUSTRATION — ADVENTURE/JOURNEY THEMES: If this is an adventure, science, space, underwater, fantasy, school, or nature book, the final spread illustration must show the child in the moment AFTER the climax — triumphant, still, changed — NOT in a bedroom, NOT in pajamas, NOT going to sleep. The story ends where the journey ends: on the hill, at the lab bench, under the stars, in the garden. Sleep is implied by the emotional landing, never shown.
- ENDING ILLUSTRATION — BEDTIME/FRIENDSHIP themes only: the final spread may show the child settling in, cozy, eyes closing — but never literally sitting by a door or in a hallway. The final location must be warm and interior: a bed, a couch, a nest of pillows.

-------------------------------------
PERSONAL HOOK INTEGRATION (MANDATORY)
-------------------------------------

You are given personal details about the child and caregiver.
You must transform them into natural story elements — NOT insert them literally.

Each personal detail must become ONE of the following:

1. REFRAIN (repeatable phrase)
- If a playful or unique phrase is provided (e.g. "tinky tinky"),
  use it as a recurring, soothing refrain.
- It must appear 2-4 times across the story.
- It should feel like part of a bedtime ritual, not an interruption.

2. PHYSICAL RITUAL
- Convert physical behaviors into gentle actions in the story.
  Example: toe sniffing -> toe tapping, toe counting, gentle tickling.
- These actions should ground the story in the body.

3. EMOTIONAL ANCHOR
- Caregiver relationships (e.g. grandmother) must shape tone:
  voice, warmth, rhythm, safety.
- The caregiver should feel like the source of calm.

4. SYMBOLIC TRANSFORMATION
- Sensitive or complex details (e.g. death, family history)
  must NOT be stated directly.
- Instead, convert them into continuity, presence, quiet warmth,
  or "someone watching over."

USAGE RULES:
- Never force personal phrases unnaturally into sentences.
- Never break tone or rhythm to include a detail.
- Prioritize subtlety over completeness:
  it is better to use 2 details beautifully than 5 awkwardly.

-------------------------------------
REFRAIN QUALITY RULE (CRITICAL)
-------------------------------------

If a refrain is used:
- It must feel soothing when repeated
- It should slightly evolve in meaning across the story
- It should appear naturally in dialogue or rhythm

Example progression:
early -> playful
middle -> guiding
end -> calming / closing

-------------------------------------
EXEMPLAR SPREADS (TARGET QUALITY)
-------------------------------------

These examples show the level of writing you must match or exceed.
Do NOT copy these — they are for tone and quality calibration only.

EXAMPLE A (setup — emotion shown through action, not told):
Left: "The house creaked its old-wood song. Luna pulled Momo closer, one ear still warm from breakfast."
Right: null

EXAMPLE B (turning point — sensory, minimal, repeated phrase appears):
Left: "She pressed her palm against the window. The fog pressed back."
Right: "Hush now, little seed, she whispered. But her voice wobbled."

EXAMPLE C (resolution — poetic, whisper-like, phrase transformed):
Left: null
Right: "The dark had a sound now. Not a growl. A hum. Momo's button eyes caught the last sliver of moon."

Notice what makes these work:
- No emotion-telling — only action and sensation
- Every sentence is specific and unreplaceable
- Rhythm varies (long then short)
- The repeated phrase evolves naturally
- Silence (null pages) creates breathing room

CONTRAST EXAMPLES (what to avoid vs. what to write):

BAD (flat, functional):
Left: "Zara walked through the dark forest. She was scared but kept going."
Right: "She held her lantern up to see better."

GOOD (poetic, sensory, unexpected):
Left: "The forest held its breath. Zara's lantern made one small circle of warmth."
Right: "She stepped into it anyway."

---

BAD (flat, transition):
Left: "They ran up the hill quickly."
Right: "At the top they could see everything."

GOOD (poetic, earned):
Left: "Her legs burned. The hill didn't care."
Right: "Then. The whole sky."

Notice: the GOOD versions show emotion through action, use surprising specificity, trust silence, and make every word carry weight.

---

STRUCTURE GUIDANCE:
- Spread 1: Setup (comfort → small disruption)
- Spreads 2–4: Exploration begins
- Spreads 5–7: Build wonder + introduce tension/doubt
- Spreads 8–10: Discovery and emotional shift
- Spreads 11–12: Return to safety + emotional resolution

QUALITY CHECK (before finishing):
- The story flows smoothly when read aloud
- At least one moment of tension exists
- The ending feels emotionally complete
- No phrasing resembles known books or famous lines
Rewrite silently if needed before outputting the final version.

-------------------------------------
OUTPUT FORMAT (PLAIN TEXT — NOT JSON)
-------------------------------------
Write the story in this exact format. Do NOT output JSON.

TITLE: [your title — see TITLE RULES below]

DEDICATION: [dedication text]

SPREAD 1:
Left: "[text]"
Right: null

SPREAD 2:
Left: null
Right: "[text]"

...continue for all 13 spreads...

Rules:
- Write exactly 13 spreads.
- Each spread has Left and Right. EXACTLY ONE must have text; the other MUST be null. NEVER put text on both sides of the same spread — pick the side that serves the rhythm (opening beats on Left, page-turn hooks on Right) and alternate across the book for visual variety.
- Do NOT include illustration descriptions, JSON, or metadata.
- Focus entirely on the story text and its quality.

TITLE RULES (CRITICAL):
- The title MUST include the child's name: "{name}" or a possessive form ("{name}'s").
- The title must reference something SPECIFIC to THIS story — the quest, the setting, the repeated phrase, or the favorite object. NOT a generic concept.
- Keep it short: 3-8 words maximum.
- GOOD titles: "{name} and the Map That Remembered", "{name}'s Midnight Garden", "The Day {name} Found the Stars"
- BAD titles: "{name}'s Adventure", "{name}'s Special Day", "A Magical Journey", "The Brave Little Child"
- If the title could apply to ANY child's book, it's too generic. Rewrite it.`;

// ── Structure Brief (for JSON conversion + illustration prompts) ──

const STRUCTURE_BRIEF_TEMPLATE = `CHILDREN'S BOOK — STORY STRUCTURER

You are given a children's bedtime picture book story written as plain text.
Your job is to convert it into a precise JSON format, adding illustration prompts
and visual consistency metadata. You must PRESERVE the story text EXACTLY as written.

-------------------------------------
ILLUSTRATION PROMPTS
-------------------------------------
For each spread, create a spread_image_prompt that describes the visual scene.
- Describe composition, lighting, color palette, perspective, and one texture detail.
- Do NOT specify art medium or style — that is handled separately.
- Show emotion through body language, environment, and light — never label it.

Each spread must include a "shot_type" field with one of: "wide", "medium", "close-up", "overhead".
- "wide": Characters visible head-to-toe in their environment. Use for scenes with movement, exploration, or setting establishment.
- "medium": Characters visible from waist up, interacting with each other or objects. Use for conversation, activities, shared moments.
- "close-up": Focus on face, hands, or a specific detail. Use for emotional moments, reactions, small discoveries.
- "overhead": Bird's-eye view. Use sparingly for unique visual variety.
Vary shot types across the book for visual interest. Do not use the same shot type for more than 2 consecutive spreads.

Each spread must include a "character_position" field with one of: "left_third", "center", "right_third".
- This indicates where the main character should be positioned in the illustration.
- Alternate positions across spreads for visual variety.
- Avoid placing the character in "center" for more than 2 consecutive spreads.
- {name}'s appearance must be consistent across all prompts — SAME hair style, hair color, hair length, and clothing in every single illustration.
- {favorite_object} must look identical every time it appears.
- Time of day and lighting must follow story logic.
- Only include objects in illustration prompts that serve the story. No random props.
- Do NOT describe the child changing clothes, getting wet/dirty in ways that alter outfit appearance, or wearing anything different from the defined characterOutfit.
- Do NOT describe the child's hair changing (wind-blown, messy from sleep, tied differently, etc.) — hair must stay exactly as defined.
- NEVER depict family members (parents, siblings, grandparents) in any illustration prompt. Caregivers may only be implied (a warm hand, a shadow, a voice). Fictional characters are fine.

-------------------------------------
CHARACTER VISUAL CONSISTENCY (CRITICAL)
-------------------------------------
You MUST define the child's appearance ONCE at the top level so every
illustration matches. This is non-negotiable — inconsistent visuals ruin
the printed book.

Define these top-level fields:
- "characterOutfit": ONE specific outfit the child wears in EVERY spread.
  Be precise: garment type, color, patterns, shoes/socks, accessories.
  Example: "a red hoodie with a small star patch on the chest, dark blue jeans, white sneakers with red laces, and a yellow beanie hat"
  The child wears this SAME outfit from spread 1 to the last spread. No exceptions.
  - No added layers, no removed items, no changes due to weather, activity, or time of day.
  - If the story takes place in rain — the child is still in the exact same outfit.
  - If the story involves water or mud — the scene composition avoids showing the body below the neck, or the illustration shows them from behind or at a distance. The outfit does NOT change.
  - NEVER have the child change clothes, get visibly wet/muddy, or wear anything different from the defined characterOutfit.
  - The illustrator will be given this exact outfit description for every single spread and must match it exactly.

- "characterDescription": Physical appearance details beyond the photo.
  MUST include a detailed hair description (color, style, length, texture, parting).
  MUST explicitly state hair accessories: if the child has a headband, bow, clip, ribbon, or elastic, describe it exactly (color, position). If the child has NO hair accessories, write "no hair accessories."
  Also include posture, height relative to surroundings, any distinguishing features.
  The hair MUST remain IDENTICAL in every illustration — no added or removed accessories.

- "recurringElement": The {favorite_object}'s exact visual description so it
  looks identical on every page.

- "keyObjects": Other objects that recur across spreads, with exact
  visual details so they stay consistent. ONLY include objects meaningful
  to the plot. Less is more.

-------------------------------------
OUTPUT FORMAT (MANDATORY JSON)
-------------------------------------
Return a JSON object with this structure:
{
  "title": "The book title",
  "characterOutfit": "exact outfit description — same in every spread",
  "characterDescription": "physical appearance details",
  "recurringElement": "exact visual description of the recurring companion/object",
  "keyObjects": "other recurring visual elements with exact descriptions",
  "entries": [
    { "type": "dedication_page", "text": "..." },
    { "type": "spread", "spread": 1, "left": { "text": "..." }, "right": { "text": "..." }, "spread_image_prompt": "...", "shot_type": "wide", "character_position": "left_third" },
    ...13 spreads total...
  ]
}

Front matter pages (half-title, title page, copyright) are added automatically — do NOT include them.
The "entries" array must contain exactly: 1 dedication_page + 13 spreads = 14 entries.

Rules:
- PRESERVE all story text EXACTLY as written in the input — do not rewrite, paraphrase, or edit.
- ONE-SIDE TEXT RULE (CRITICAL): Each spread MUST have text in EXACTLY ONE of left.text or right.text. The other side MUST be null. NEVER both sides. If the input accidentally has text on both sides of any spread, do NOT invent new text — move/merge the text onto whichever side reads best and set the other side to null.
- Every spread MUST include "shot_type" (one of: "wide", "medium", "close-up", "overhead") and "character_position" (one of: "left_third", "center", "right_third").
- spread_image_prompt describes ONE CONTINUOUS PANORAMIC SCENE (wide landscape, like a movie still or panoramic photograph). Write it as a single unified scene — NOT as separate left-side and right-side descriptions.
- IMPORTANT: Do NOT describe content as being "on the left" and other content "on the right." Describe ONE flowing scene with the child as the focal point. The child MUST be positioned in the left third or right third of the scene — NOT at the center. Never describe the child as standing in the middle of the scene.
- Do NOT specify art medium in spread_image_prompt.
- Do NOT re-describe the outfit in spread_image_prompt — it is defined once at the top level.
- Do NOT re-describe hair or hair accessories in spread_image_prompt — they are defined once in characterDescription. Never mention headbands, bows, clips, or any hair accessory in individual spread prompts.
- Use apostrophes directly in strings (no escaping needed).
- No newlines inside string values.

-------------------------------------
FINAL CHECK
-------------------------------------
Before outputting, verify:
- Are there exactly 13 spreads?
- Does characterDescription include a specific hair description (color, style, length, texture)?
- Does characterDescription explicitly mention hair accessories or state "no hair accessories"?
- Does characterOutfit describe a complete, specific outfit?
- Do any spread_image_prompts mention hair accessories, headbands, bows, or clips? (If yes, remove them — hair is defined only in characterDescription)
- Is the story text preserved exactly as provided?
- Do any spread_image_prompts describe the child changing clothes or hairstyle? (Remove if yes)`;

/**
 * Build the complete V2 brief with variables substituted.
 *
 * @param {{ name: string, age: number, favorite_object: string, fear: string, setting: string, dedication: string }} vars
 * @returns {string} The full brief with all variables replaced
 */
function buildGifterFromValue(vars) {
  if (vars.isMultipleGifters && vars.gifterNames && vars.gifterNames.length > 1) {
    const bookFrom = vars.gifterNames.join(' and ');
    return `${bookFrom} (multiple people: ${vars.gifterNames.join(' and ')})\n\nMULTIPLE GIFTERS RULE (TEXT ONLY — illustrations are NOT affected by this rule):\nThis book is a gift from BOTH ${vars.gifterNames[0]} AND ${vars.gifterNames[1]}.\nIf either person is mentioned in the story text (speaking, acting, calling the child's name, being referenced), the OTHER must ALSO be mentioned in the story text at least once.\nBoth gifters must feel equally present in the narrative — not one as the main character and the other forgotten.\nThis applies to TEXT ONLY. Do NOT add family members to illustration prompts — the illustration rules are separate.`;
  }
  if (vars.gifterNames && vars.gifterNames.length === 1) {
    const gifterName = vars.gifterNames[0];
    return `${gifterName}\n\nGIFTER NAME RULE: "${gifterName}" is the person giving this book as a gift. Their name belongs ONLY on the dedication page. Do NOT mention "${gifterName}" in the story text unless they are a named character in the child's daily life (e.g., "Mom", "Dad", "Grandma"). Random first names appearing in story text without introduction confuses readers.`;
  }
  return '';
}

function buildV2Brief(vars) {
  const { name, favorite_object, fear, setting, dedication } = vars;
  const age = Number(vars.age) || 5;
  const { config } = getAgeTier(age);

  // Age-conditional poetic vs simplicity rule
  const poeticRule = config.tier <= 2
    ? `- MUSICAL SIMPLICITY (FIRST PRIORITY): Write in RHYMING COUPLETS using simple words a ${age}-year-old already knows. The rhymes carry the story forward like a song. Simple vocabulary + beautiful rhyme = a book parents read over and over. Think Julia Donaldson, Dr. Seuss, Sandra Boynton. "The room was dark, the room was deep. Bear whispered, I will help you sleep." — every word is simple, every line rhymes, every couplet tells a story. Do NOT write flat prose fragments ("She walked. She saw. She sat."). Do NOT write sentences that just describe what happens without rhythm. Every spread should SING when read aloud. Use words from the child's daily life — "The moon slept behind a cloud" is fine, "The vespertine haze unfurled" is not.`
    : `- POETIC LANGUAGE (FIRST PRIORITY): Every sentence must earn its place poetically. If you could replace it with a more ordinary sentence without losing meaning, it is not good enough. Reach for the unexpected image. "She held Momo closer" is better than "She was scared." "The fog pressed back" is better than "It was foggy outside." Ask yourself: could a flat writer have written this sentence? If yes, rewrite it.`;

  let brief = V2_BRIEF_TEMPLATE;
  brief = brief.replace(/\{name\}/g, name || 'the child');
  brief = brief.replace(/\{age\}/g, String(age));
  brief = brief.replace(/\{favorite_object\}/g, favorite_object || 'a favorite toy');
  brief = brief.replace(/\{fear\}/g, fear || 'the dark');
  brief = brief.replace(/\{setting\}/g, setting || 'a magical place');
  brief = brief.replace(/\{dedication\}/g, dedication || `For ${name || 'the child'}`);
  brief = brief.replace(/\{gifterFrom\}/g, buildGifterFromValue(vars));
  brief = brief.replace(/\{maxWordsPerSpread\}/g, String(config.maxWordsPerSpread || 30));
  brief = brief.replace(/\{rhymeLevel\}/g, config.rhymeLevel || '');
  brief = brief.replace(/\{poeticRule\}/g, poeticRule);
  brief = brief.replace(/\{soundWordsRule\}/g, config.soundWordsRule || 'Include 2-3 sound words across the story. Do NOT overuse them.');

  // Replace style mode and technique budget placeholders
  const styleMode = vars.style_mode || 'playful';
  const styleModeConfig = STYLE_MODES[styleMode] || STYLE_MODES.playful;
  brief = brief.replace(/\{style_mode_bias\}/g, styleModeConfig.writingBias);
  const techniques = Array.isArray(vars.techniques) ? vars.techniques.join(', ') : (vars.techniques || 'rule_of_three, humor');
  brief = brief.replace(/\{techniques\}/g, techniques);

  // Replace age-conditional content sections
  brief = brief.replace(/\{authorialVoice\}/g, getAuthorialVoice(config.tier, age));
  brief = brief.replace(/\{rhythmGuide\}/g, getRhythmGuide(config.tier, age));
  brief = brief.replace(/\{exemplars\}/g, getExemplars(config.tier));

  // Replace dialect placeholders (same logic as buildWritingBrief)
  const { dialect, dialectRule } = getDialectVars(vars.countryCode);
  brief = brief.replace(/\{dialect\}/g, dialect);
  brief = brief.replace(/\{dialectRule\}/g, dialectRule);

  // Inject Tier 2 vocabulary guidance
  if (config.tier === 2) {
    const tier2Block = `

TIER 2 VOCABULARY GUIDANCE (ages 3-5):
- BANNED WORDS (too literary for this age): glistening, magnificent, whimsical, ethereal, luminous, iridescent, cascade, eloquent, radiant, resplendent, enchanting, mesmerizing, serene, tranquil, mystical, majestic, celestial, melodic, beckon, vespertine
- ALLOWED and ENCOURAGED: whispered, tumbled, wandered, murmured, crept, drifted, curled, scrambled, peeked, wobbled, tiptoed — these are vivid, concrete verbs children understand and love
- READ-ALOUD TEST: read each sentence out loud. Does it flow like a song? Would a parent enjoy saying it? If it sounds choppy or robotic, rewrite it.
- No poetic inversions ("Down the hill rolled the ball" → "The ball rolled down the hill")`;
    brief += tier2Block;
  }

  return brief;
}

/**
 * Build the writing-only brief (for free-form text generation, no JSON).
 * @param {{ name: string, age: number, favorite_object: string, fear: string, setting: string, dedication: string }} vars
 * @returns {string}
 */

// ── Age-conditional content for brief templates ────────────────────────────

function getAuthorialVoice(tier, age) {
  if (tier <= 2) {
    return `Write like Julia Donaldson, Dr. Seuss, Sandra Boynton, Margaret Wise Brown — the masters of MUSICAL picture books for young children:

FIRST RULE — THIS BOOK MUST RHYME:
- Write in RHYMING COUPLETS (AABB). Every spread should have at least one rhyming pair.
- Simple words + beautiful rhymes = a book parents read over and over.
- "The room was dark, the room was deep. Bear whispered, I will help you sleep." — THIS is the target quality.
- Do NOT write flat prose fragments: "She walked. She saw. She sat." is UNACCEPTABLE.
- Do NOT write primer-style sentences: "Logan put one hand on the book. Still here." is UNACCEPTABLE.
- Every spread must SING when read aloud. If it doesn't rhyme and doesn't have rhythm, rewrite it.

- Simple but deep. Use small, familiar words to say big things. A ${age}-year-old must understand every word. An adult should feel something unexpected from the simplicity.
- Concrete over abstract. Never write "love is the strongest magic" — show the child putting a blanket over a sleeping cat.
- Emotion is shown through action and image, never labeled. "She was sad" is lazy.
- Dialogue must sound like a real ${age}-year-old — short, concrete, more questions than statements.

READ-ALOUD TEST (MANDATORY):
Before finalizing ANY line, read it aloud. Does it SING? Does it BOUNCE? Does it make you want to keep reading?
- If a line sits flat on the page with no rhythm, REWRITE it as a couplet.
- If a line sounds like a reading primer or robot, REWRITE it with music.
- The parent reading this should feel the rhythm carry them forward — the book should be impossible to read in a flat voice.
- Dialogue from the child must sound like a REAL ${age}-year-old talking — short, concrete, sometimes funny.

VOCABULARY CONSISTENCY:
Maintain a consistent complexity level throughout. Your first spread sets the ceiling.
- The reader should never feel a tonal "gear shift" between spreads.
- Simple words throughout — but arranged into beautiful, musical couplets, not broken fragments.`;
  }
  return `Write like the best children's authors — Sendak, Silverstein, Donaldson, Jeffers, Klassen:

- Simple but deep. Use small words to say big things. "The tree gave and gave and gave" says more about love than any explanation. A 5-year-old should understand every word; an adult should feel something unexpected.
- Concrete over abstract. Never write "love is the strongest magic" — show the child putting a blanket over a sleeping cat. The reader feels the love; you never name it.
- Every sentence earns its place. If you can cut it and the story still works, cut it.
- No cliches. No filler. No greeting-card language. If a line could appear on a motivational poster, a coffee mug, or a mass-produced birthday card, delete it and write something only THIS story could say.
- Respect the child's intelligence — never talk down, never explain the joke, never underline the emotion.
- Emotion is shown through action and image, never labeled. "She was sad" is lazy. "She set the cup down without drinking" is alive.
- Dialogue must sound like a real child — surprising, concrete, sometimes funny, sometimes off-topic.

READ-ALOUD VOICE TEST:
Before finalizing ANY line, read it aloud in your head. Does it flow naturally? If a line sounds writerly rather than storyteller-y, simplify it. The best children's prose sounds like someone TELLING a story, not writing one.

VOCABULARY CONSISTENCY:
Maintain a consistent complexity level throughout. If you establish a simple, direct voice in the opening, do not suddenly shift to lyrical or literary language mid-story. The reader should feel one consistent voice from first page to last.`;
}

function getRhythmGuide(tier, age) {
  if (tier <= 2) {
    return `RHYTHM & RHYME (CRITICAL — this book is read aloud to a very young child):
- Pattern over poetry. The best picture books for this age use REPETITION as their rhythm engine: "Goodnight room. Goodnight moon. Goodnight cow jumping over the moon." is beautiful because of its pattern, not its vocabulary.
- Each spread should have a natural breathing cadence — read it aloud: does it rock like a lullaby? Does it bounce like a game? If it just sits flat, rewrite.
- Alternate long and short sentences: "The wind blew. It pushed the leaves around and around the yard." Long-short creates music.
- The repeated phrase is your RHYTHMIC ANCHOR. It should feel natural to say aloud, like a refrain in a song.
- Avoid: flat chains of same-length declarative sentences ("She walked. She looked. She saw."). Vary the rhythm.
- Every word must feel good in the MOUTH. "Crunch" is satisfying. "Utilized" is not. Choose mouth-feel words over eye-pleasing words.
- Avoid: tongue twisters, three-word noun stacks, words a ${age}-year-old would not know.
- RHYME LEVEL FOR THIS AGE (${age}): {rhymeLevel}
  A near-rhyme or internal rhyme always beats a strained end-rhyme. If a rhyme bends the meaning, drop it.`;
  }
  return `RHYTHM & RHYME (CRITICAL — read-aloud quality is non-negotiable):
- Read each line aloud in your head before finalizing. If it stumbles, rewrite it.
- Vary sentence rhythm intentionally: a long image sentence followed by a 3-word punch. Prose should breathe.
- Every spread must contain at least one short sentence (5 words or fewer) for rhythm contrast.
- Avoid: tongue twisters, three-word noun stacks, words over 3 syllables (except names/invented words).
- RHYME LEVEL FOR THIS AGE (${age}): {rhymeLevel}
  A near-rhyme or internal rhyme always beats a strained end-rhyme. If a rhyme bends the meaning, drop it.
- Use gentle repetition for emotional effect — the repeated phrase is a rhythmic anchor.
- Write for the EAR, not the eye. "She stepped inside" has rhythm. "She walked into the room" is flat. Choose words that feel good in the mouth.`;
}

function getExemplars(tier) {
  if (tier <= 2) {
    return `-------------------------------------
EXEMPLAR SPREADS (TARGET QUALITY — ages 0-5)
-------------------------------------

These examples show the level of writing you must match or exceed.
Do NOT copy these — they are for tone and quality calibration only.

Each MEDIOCRE vs EXCELLENT pair teaches ONE principle. Study what makes the excellent version work.
CRITICAL: Notice that ALL excellent examples use RHYMING COUPLETS or strong musical rhythm. This is non-negotiable for ages 0-5.

─── PAIR 1: RHYMING COUPLETS THAT TELL A STORY (Donaldson-level) ───

MEDIOCRE:
Left: "Luna was feeling very scared of the dark room. She held her teddy bear close to her chest and wished she could be brave."
Right: "But she knew she had to try because her mommy said she was a brave girl."

EXCELLENT:
Left: "The room was dark, the room was deep. Bear whispered, I will help you sleep."
Right: "She tiptoed in on quiet toes. The dark was soft. The dark was close."

WHY IT WORKS: Simple words, perfect rhymes (deep/sleep, toes/close). The couplets carry the child forward like a song. Every word a toddler knows. Emotion shown through action (tiptoed, whispered), never stated. The dark transforms from scary to soft — IN the couplet itself.

─── PAIR 2: RHYME AS PLOT ENGINE (Seuss-level) ───

MEDIOCRE:
Left: "The fox said hello and waved with glee, come play with me under this tree! We'll laugh and sing and dance all day, in every possible wonderful way!"
Right: null

EXCELLENT:
Left: "Fox said, Come in, the water is fine. Hen said, No thank you, this puddle is mine. Fox said, Sit down, the table is set. Hen said, Not yet. Not yet. Not yet."
Right: null

WHY IT WORKS: The rhyme (fine/mine, set/yet) drives the story — each exchange builds tension. The hen's refusals escalate. Repetition of "Not yet" creates rhythm AND suspense. Rhyme is a vehicle for plot, not decoration.

─── PAIR 3: HUMOR + RHYME TOGETHER ───

MEDIOCRE:
Left: "Then the silliest thing happened! The cake fell right on the dog's head! Everyone laughed because it was so very funny."
Right: "What a silly dog, said Mama, giggling with delight."

EXCELLENT:
Left: "The cake fell down upon the dog. The dog just sat there like a log."
Right: "He ate the crumbs, he ate the cream. He ate the candles. What a dream."

WHY IT WORKS: The humor lands through deadpan rhyme. "Like a log" is funny because it's unexpected. "What a dream" is the dog's perspective — subversive and delightful. The rhyme makes it musical AND funny. A child wants to hear this again.

─── PAIR 4: EMOTIONAL RESTRAINT WITH MUSIC (Brown-level) ───

MEDIOCRE:
Left: "Grandpa loved her so, so much. She felt warm and safe in his big strong arms."
Right: "I love you to the moon and stars, whispered Grandpa with happy tears."

EXCELLENT:
Left: "Grandpa's chair still held his shape. His blanket smelled of toast and grape."
Right: "She climbed right in, she fit just so. Some things stay warm. The good ones know."

WHY IT WORKS: The emotion is enormous but nothing is stated. "Toast and grape" is specific and sensory. "She fit just so" carries loss, comfort, and love. The final couplet (so/know) lands the feeling without explaining it. A parent reading this will feel a lump in their throat.

─── PAIR 5: NARRATIVE VOICE WITH RHYTHM (Willems-level) ───

MEDIOCRE:
Left: "One sunny morning, little Bear woke up and decided today would be a special day."
Right: "He put on his hat and went outside to see what he could find."

EXCELLENT:
Left: "Bear found a hat upon the stair. He put it on with extra care."
Right: "He marched outside, the hat came too. The hat had plans. The hat just knew."

WHY IT WORKS: The hat becomes a character through rhyme and personification. "The hat just knew" — a child laughs because hats don't know things. The couplets (stair/care, too/knew) make it singable. The narrator's wry voice comes through the rhyme, not despite it.

-------------------------------------
WHAT THESE TEACH:
- RHYMING COUPLETS are the foundation — every excellent example rhymes.
- Rhythm comes from couplet patterns and repetition, not fancy vocabulary.
- Show emotion through OBJECTS and ACTIONS, never through feeling-words.
- Humor lands through deadpan rhyme and surprise, not exclamation marks.
- The narrator has a personality that comes through IN the rhyme.
- Simple words + perfect rhymes = a book parents read over and over.
- A child should understand every single word AND want to hear it again.

-------------------------------------
FULL-STORY EXEMPLAR (TARGET QUALITY, complete 13-spread arc)
-------------------------------------

The pairs above teach individual principles. This complete story shows how they work TOGETHER across a full arc.

Study how the repeated phrase evolves, where humor lands, where page-turn hooks pull the reader forward, and how the ending earns its emotion without stating it. Do NOT copy this story. Use it for structural and quality calibration only.

Child "Mila", age 4, loves her stuffed fox "Runo", fear = the wind, setting = the garden, bedtime book from Mom.

TITLE: Mila and the Wind's Pocket

DEDICATION: For Mila, who holds on tight.

SPREAD 1:
Left: "The wind came knocking at the gate. It flipped the mat. It couldn't wait."
Right: "It tugged one sock right off the line, and spun it round, and thought it fine."

SPREAD 2:
Left: null
Right: "Mila grabbed Runo by the tail. Hold on tight through every gale. Runo did not hold on tight. Runo was a fox. All right."

SPREAD 3:
Left: "The garden path went past the tree, past the fence, past snails — all three."
Right: "The snails looked up? They did not care. They had a meeting. Mila stared."

SPREAD 4:
Left: "Her hat began to lift and sway. Not much, but just enough to play."
Right: null

SPREAD 5:
Left: null
Right: "She chased it past the rose and rake, past the frog beside the lake. The frog sat still on his frog-sitting rock. He did not move. He did not talk."

SPREAD 6:
Left: "A feather landed on her nose. The wind said, Mine! and off it goes."
Right: "Hold on tight, she told the feather. But feathers do not stay together."

SPREAD 7:
Left: "And then."
Right: "Runo lifted off her arm, above the garden, past the farm. One ear, and then the other ear. And all of him just... disappeared."

SPREAD 8:
Left: "Mila stood there, very still. The garden hushed. The air went chill."
Right: null

SPREAD 9:
Left: null
Right: "She climbed the fence, she found the track. She followed all the things blown back. One sock, one hat, one feather too. She knew exactly what to do."

SPREAD 10:
Left: "Behind the wall, the wind had made a nest of things inside the shade. Her hat, three leaves, and face-down there — one stuffed fox with clover in his hair."
Right: null

SPREAD 11:
Left: null
Right: "She picked him up. Still soft, still warm. Still Runo-shaped. Still safe from harm."

SPREAD 12:
Left: "The wind pushed once more, soft and low."
Right: "Hold on tight, she whispered. And this time it meant something different, though."

SPREAD 13:
Left: "They walked home slow beneath the sky. The gate stayed open. So did I."
Right: null

WHY THIS WORKS (study these structural patterns):
- RHYME: Every single spread uses AABB couplets. The rhymes are natural and effortless — gate/wait, tail/gale, tree/three, sway/play. The story SINGS.
- OPENING: Drops into a moment (wind causing mischief). The wind is a character from line one. The couplet (gate/wait) sets the musical tone immediately.
- ARC: Setup (1-2), Exploration (3-5), Loss (6-7), Stillness (8), Quest (9), Discovery (10), Reunion (11-12), Home (13).
- PHRASE EVOLUTION: "Hold on tight" appears three times with evolving meaning. Spread 2: playful (said to a stuffed toy, then undercut with humor). Spread 6: desperate (losing things). Spread 12: tender (she means holding on to what matters).
- RULE OF THREE: Wind takes hat (4-5), feather (6), Runo (7). Each loss escalates.
- HUMOR: "Runo did not hold on tight. Runo was a fox. All right." (deadpan subversion IN a couplet). "He did not move. He did not talk." (the frog's indifference). Comedy through rhyme and observation.
- EMOTIONAL RESTRAINT: Runo's loss is never called sad. "The garden hushed. The air went chill." carries the weight through rhyme. The reunion is "Still soft, still warm. Still Runo-shaped. Still safe from harm" — physical sensation in couplet form.
- ENDING: "The gate stayed open. So did I." — the most powerful line is also a perfect rhyme (sky/I). No lesson, no moral. The image closes the circle.
- VOCABULARY: Every word is simple enough for a 4-year-old. The beauty comes from the rhyme and rhythm, not from complex words.`;
  }
  return `-------------------------------------
EXEMPLAR SPREADS (TARGET QUALITY — ages 6+)
-------------------------------------

These examples show the level of writing you must match or exceed.
Do NOT copy these — they are for tone and quality calibration only.

Each MEDIOCRE vs EXCELLENT pair teaches ONE principle. Study what makes the excellent version work.

─── PAIR 1: ECONOMY — Maximum impact in minimum words (Sendak-level) ───

MEDIOCRE:
Left: "The old house stood at the end of the long, winding lane, its windows dark and mysterious. Luna felt a shiver run down her spine as she clutched Momo to her chest, wondering what secrets lay inside."
Right: "Despite her fear, she gathered all her courage and took a deep, steadying breath before approaching the creaking front door."

EXCELLENT:
Left: "The house creaked its old-wood song. Luna pulled Momo closer, one ear still warm from breakfast."
Right: null

WHY IT WORKS: Two sentences. One specific sensory detail ("one ear still warm from breakfast") tells us everything — she just left safety. The house "creaked its old-wood song" gives it personality without adjective pileup. No feelings named. Silence on the right lets the image breathe.

─── PAIR 2: NATURAL RHYME THAT ADVANCES STORY (Donaldson-level) ───

MEDIOCRE:
Left: "The magical forest was shining so bright, with stars and with moonbeams all glowing with light. The creatures were dancing with joy everywhere, with wonder and magic just floating through air!"
Right: null

EXCELLENT:
Left: "She followed the path where the wild roses grow, past the tree with the swing and the creek running slow."
Right: "But then the path split. And the roses stopped growing. And the creek — the creek had no way of knowing which way the girl went."

WHY IT WORKS: The rhyme (grow/slow) sets a lull — then the rhythm BREAKS when the danger starts. The creek "had no way of knowing" personifies without cliché. Rhyme lulls the reader, then prose jolts them awake. The form matches the feeling.

─── PAIR 3: HUMOR THROUGH SUBVERSION (Dahl-level) ───

MEDIOCRE:
Left: "Professor Wigglesworth was a very funny and eccentric inventor who always made silly mistakes. One day he accidentally turned his mustache purple, which made everyone laugh!"
Right: "Oh dear me, he chuckled, looking at himself in the mirror. How delightfully absurd!"

EXCELLENT:
Left: "The professor had invented a machine to make toast. It made toast perfectly. It also made toast constantly. It could not be stopped."
Right: "By Tuesday, the toast was three feet deep in the kitchen. The professor ate breakfast in the garden. He did not mention the machine."

WHY IT WORKS: The humor escalates through deadpan repetition. "He did not mention the machine" is funnier than any exclamation because it subverts — we expect panic, we get denial. The comedy is structural (escalation + understatement), not decorative.

─── PAIR 4: EMOTIONAL RESTRAINT — Trust the reader (Jeffers-level) ───

MEDIOCRE:
Left: "Since Grandma had gone away, everything felt empty and sad. The garden that Grandma loved so much was now overgrown and lonely, just like the hole in Maya's heart."
Right: "She missed Grandma terribly. Sometimes she would cry and wish Grandma could come back and hold her one more time."

EXCELLENT:
Left: "The garden had grown strange without her. Tomatoes fat as fists, nobody picking them."
Right: "Maya pulled one off. Still warm from the sun. She wiped it on her shirt the way Grammy showed her."

WHY IT WORKS: Loss is never named. "Nobody picking them" carries the absence. "The way Grammy showed her" connects past and present through a gesture, not a speech. The warm tomato is sensory and specific — it makes the reader FEEL instead of being told to feel.

─── PAIR 5: DISTINCT NARRATIVE VOICE (Willems-level) ───

MEDIOCRE:
Left: "It was a bright and beautiful Saturday morning when everything changed for our young hero. Little did she know that an extraordinary adventure was about to begin!"
Right: "She put on her favourite coat and stepped outside, completely unaware of the amazing things that awaited her."

EXCELLENT:
Left: "Here is the thing about Saturday: it starts slow. Too slow. Unbearably, spectacularly slow."
Right: "And then it doesn't."

WHY IT WORKS: The narrator has a VOICE — conspiratorial, building anticipation. The rule of three ("slow, too slow, unbearably spectacularly slow") escalates, then "And then it doesn't" detonates in four words. The reader hears a PERSON, not a template. The foreshadowing is earned through rhythm, not announced with "little did she know."

-------------------------------------
WHAT THESE TEACH:
- Every sentence must earn its place. If you can cut it, cut it.
- Emotion lives in OBJECTS and GESTURES, never in feeling-words.
- Humor comes from structure (escalation + subversion), not from announcing that something is funny.
- Rhythm is a tool: vary sentence length, then break the pattern at the turn.
- The narrator has a personality — wry, breathless, conspiratorial, or gentle. Pick one and commit.
- Silence (null pages) creates breathing room and lets images do their work.
- Rhyme should serve the story, not decorate it. Break the form when the story demands it.

-------------------------------------
FULL-STORY EXEMPLAR (TARGET QUALITY, complete 13-spread arc)
-------------------------------------

The pairs above teach individual principles. This complete story shows how they work TOGETHER across a full arc.

Study how the repeated phrase evolves, where humor lands, where page-turn hooks pull the reader forward, and how the ending earns its emotion without stating it. Do NOT copy this story. Use it for structural and quality calibration only.

Child "Jonah", age 7, loves his compass, fear = getting lost, setting = the hill behind his house, theme = adventure, from Dad.

TITLE: Jonah and the Compass That Forgot

DEDICATION: For Jonah, who always finds the way.

SPREAD 1:
Left: "The compass had belonged to someone before Jonah. He didn't know who. It was heavy for its size, and the needle never quite settled. It trembled, like it was trying to remember."
Right: null

SPREAD 2:
Left: null
Right: "North is that way, Jonah told the dog. The dog went south. The compass agreed with the dog."

SPREAD 3:
Left: "The hill behind the house had no name. Jonah had tried to give it one, but nothing stuck. Too-Far Hill. Almost Hill. The Hill Where the Fence Ends."
Right: "Today the fence ended, and Jonah kept going."

SPREAD 4:
Left: "The compass said north. The path went north. Then the path turned into a marsh, and the marsh turned into the kind of mud that eats shoes."
Right: null

SPREAD 5:
Left: "He tried east. East was full of thorns and one very loud crow that did not want company."
Right: "He tried west. West was a cliff. Not a big cliff, but big enough."

SPREAD 6:
Left: null
Right: "The compass needle spun. Slow, then fast, then slow again. Jonah shook it. The needle kept spinning."

SPREAD 7:
Left: "He sat on a rock. The rock was cold and shaped like a mistake."
Right: "Below him: the marsh. Behind him: the thorns. Above him: nothing useful."

SPREAD 8:
Left: "North is that way, he said again. But quieter. And he wasn't sure anymore which way he was pointing."
Right: null

SPREAD 9:
Left: null
Right: "The dog appeared. It had mud on its ears and a look of great personal satisfaction. It sat beside Jonah and leaned in. The kind of lean that means I know where I am, even if you don't."

SPREAD 10:
Left: "Jonah closed the compass. He looked at the hill. Really looked. The light sat differently here. Lower. Warmer. The grass bent one direction, like everything on this hill leaned toward the same place."
Right: null

SPREAD 11:
Left: "He followed the lean of the grass. Past the crow, who had calmed down. Past the marsh, which had shrunk somehow. Down the hill, where the fence began again."
Right: null

SPREAD 12:
Left: null
Right: "The house. The kitchen light, already on. The shape of his dad in the window, not waving. Just there."

SPREAD 13:
Left: "Jonah opened the compass one more time. The needle pointed behind him. Back up the hill, back toward the place he'd been."
Right: "North is that way, he said. And smiled. Because now he knew: north wasn't a direction. It was wherever you'd already been brave."

WHY THIS WORKS (study these structural patterns):
- OPENING: Mid-moment. The compass's history is hinted, not explained. "It trembled, like it was trying to remember" personifies the object and establishes its emotional role.
- ARC: Setup (1-2), Journey begins (3-4), Three failures (4-5-6), Low point (7-8), Help arrives (9), Seeing differently (10), Return (11-12), Meaning (13). Classic quest structure with a twist at the end.
- PHRASE EVOLUTION: "North is that way" appears three times. Spread 2: confident, almost bossy (immediately undercut by the dog). Spread 8: "quieter. And he wasn't sure anymore." The certainty cracks. Spread 13: redefines north entirely, not a direction but a measure of courage. The phrase transforms from geographic to emotional.
- RULE OF THREE: Marsh (4), thorns (5), cliff (5). Three directions, three failures. The pattern breaks when the compass itself fails (6).
- HUMOR: The dog going south while the compass agrees (Spread 2). "The Hill Where the Fence Ends," naming attempts that don't stick (Spread 3). The crow "did not want company" (Spread 5). The rock "shaped like a mistake" (Spread 7). The dog's "look of great personal satisfaction" (Spread 9). Wry, observational, character-driven.
- PAGE-TURN HOOKS: Spread 3 ("Jonah kept going"), where? Spread 6 (compass breaking), now what? Spread 8 (lost and unsure), what changes? Spread 12 (dad in the window), what does Jonah do?
- EMOTIONAL RESTRAINT: The dad appears in Spread 12 as "The shape of his dad in the window, not waving. Just there." No hug scene. No "I was worried." The stillness says everything. The parent reading this feels it.
- PARENT LAYER: "Not waving. Just there." is for the parent. The child reads an adventure. The parent reads the ache of watching your kid come home safe.
- SURPRISE: The compass doesn't lead him home. It points BACK to where he was lost (Spread 13). The tool that was supposed to guide him turns out to be pointing at his own bravery, not at safety.
- ENDING: Not a lesson announced. The last line could border on explicit, but it's earned. Twelve spreads of physical, specific experience give "brave" a meaning the reader felt, not just heard. The smile is the only emotion shown.`;
}

// ── Dialect helper ──────────────────────────────────────────────────────────
const BRITISH_COUNTRIES = new Set([
  'GB', 'UK', 'AU', 'NZ', 'IE', 'ZA', 'IN', 'SG', 'MY', 'HK', 'NG', 'KE', 'GH',
  'JM', 'TT', 'BB', 'MT', 'CY', 'MS', 'VG', 'KY', 'TC', 'BM',
]);

function getDialectVars(countryCode) {
  const code = (countryCode || 'US').toUpperCase().trim();
  if (BRITISH_COUNTRIES.has(code)) {
    return {
      dialect: 'British English',
      dialectRule: `Use British spellings and vocabulary throughout: colour, favourite, mum, nappy, biscuit, jumper, torch, loo, flat, brilliant, lovely, whilst, amongst, autumn, fortnight, rubbish, queue, trainers, garden, post (not mail), solicitor. Use British idioms naturally — do not force them, but never use American alternatives.`,
    };
  }
  // Default: American English
  return {
    dialect: 'American English',
    dialectRule: `Use American spellings and vocabulary throughout: color, favorite, mom, diaper, cookie, sweater, flashlight, bathroom, yard, apartment, awesome, fall (not autumn), trash, sneakers, mail (not post), lawyer. Never use British spellings or vocabulary.`,
  };
}

function buildWritingBrief(vars) {
  const { name, favorite_object, fear, setting } = vars;
  const age = Number(vars.age) || 5;
  const { config } = getAgeTier(age);
  const { dialect, dialectRule } = getDialectVars(vars.countryCode);
  let brief = WRITING_BRIEF_TEMPLATE;
  brief = brief.replace(/\{name\}/g, name || 'the child');
  brief = brief.replace(/\{age\}/g, String(age));
  brief = brief.replace(/\{favorite_object\}/g, favorite_object || 'a favorite toy');
  brief = brief.replace(/\{fear\}/g, fear || 'the dark');
  brief = brief.replace(/\{setting\}/g, setting || 'a magical place');
  brief = brief.replace(/\{gifterFrom\}/g, buildGifterFromValue(vars));
  brief = brief.replace(/\{maxWordsPerSpread\}/g, String(config.maxWordsPerSpread || 30));
  brief = brief.replace(/\{rhymeLevel\}/g, config.rhymeLevel || '');
  brief = brief.replace(/\{dialect\}/g, dialect);
  brief = brief.replace(/\{dialectRule\}/g, dialectRule);
  brief = brief.replace(/\{soundWordsRule\}/g, config.soundWordsRule || 'Include 2-3 sound words across the story. Do NOT overuse them.');

  // Replace style mode and technique budget placeholders
  const wmStyleMode = vars.style_mode || 'playful';
  const wmStyleConfig = STYLE_MODES[wmStyleMode] || STYLE_MODES.playful;
  brief = brief.replace(/\{style_mode_bias\}/g, wmStyleConfig.writingBias);
  const wmTechniques = Array.isArray(vars.techniques) ? vars.techniques.join(', ') : (vars.techniques || 'rule_of_three, humor');
  brief = brief.replace(/\{techniques\}/g, wmTechniques);

  // Replace age-conditional content sections
  brief = brief.replace(/\{authorialVoice\}/g, getAuthorialVoice(config.tier, age));
  brief = brief.replace(/\{rhythmGuide\}/g, getRhythmGuide(config.tier, age));
  brief = brief.replace(/\{exemplars\}/g, getExemplars(config.tier));

  // Fix 4A: Append pronoun instruction to system prompt when gender is known
  const gender = vars.gender;
  if (gender && gender !== 'neutral' && gender !== 'not specified') {
    const pronounInstruction = buildPronounInstruction(name || 'the child', gender);
    if (pronounInstruction) {
      brief += `\n\nPRONOUN RULE (CRITICAL):\n${pronounInstruction}\nNEVER use they/them when referring to ${name || 'the child'} unless ${name || 'the child'}'s gender is explicitly neutral.`;
    }
  }

  return brief;
}

/**
 * Build the structure brief (for JSON conversion + illustration prompts).
 * @param {{ name: string, age: number, favorite_object: string, fear: string, setting: string }} vars
 * @returns {string}
 */
function buildStructureBrief(vars) {
  const { name, favorite_object, age, theme } = vars;
  const { tier, config } = getAgeTier(age);
  let brief = STRUCTURE_BRIEF_TEMPLATE;
  brief = brief.replace(/\{name\}/g, name || 'the child');
  brief = brief.replace(/\{favorite_object\}/g, favorite_object || 'a favorite toy');
  if (theme === 'mothers_day') {
    brief = brief.replace(
      /- NEVER depict family members \(parents, siblings, grandparents\) in any illustration prompt\.[^\n]*/,
      '- Mom MAY appear in illustration prompts for this Love to mom book. Describe her warmly and consistently. Other family members (siblings, grandparents, dad) must NOT appear in illustrations.'
    );
  } else if (theme === 'fathers_day') {
    brief = brief.replace(
      /- NEVER depict family members \(parents, siblings, grandparents\) in any illustration prompt\.[^\n]*/,
      '- Dad MAY appear in illustration prompts for this Father\'s Day book. Describe him warmly and consistently. Other family members (siblings, grandparents, mom) must NOT appear in illustrations.'
    );
  }
  // Append age-tier guidance so the structurer produces age-appropriate output
  brief += `\n\nAGE-TIER GUIDANCE (Tier ${tier}, age ${age || 5}):\n- Max words per spread: ${config.maxWordsPerSpread || 30}\n- Vocabulary level: ${config.vocabulary || 'age-appropriate'}\n- Preserve the text exactly as written — do NOT simplify or complicate it.`;
  return brief;
}

// ── Legacy Compatibility ──

const AGE_PROFILES = {
  toddler: { range: '0-2', wordsPerSpread: '4-10', totalWords: '32-80' },
  preschool: { range: '3-5', wordsPerSpread: '8-18', totalWords: '64-144' },
  earlyKid: { range: '6-8', wordsPerSpread: '12-25', totalWords: '96-200' },
  olderKid: { range: '9-12', wordsPerSpread: '20-40', totalWords: '160-320' },
};

function getAgeProfile(age) {
  const a = Math.max(3, Number(age) || 5); // Minimum age 3
  if (a <= 2) return AGE_PROFILES.toddler;
  if (a <= 5) return AGE_PROFILES.preschool;
  if (a <= 8) return AGE_PROFILES.earlyKid;
  return AGE_PROFILES.olderKid;
}

function buildWriterBrief(age) {
  return buildV2Brief({ name: '{name}', age, favorite_object: '{favorite_object}', fear: '{fear}', setting: '{setting}', dedication: '{dedication}' });
}

const WRITER_BRIEF = buildWriterBrief(5);

function buildChildContext(childDetails, customDetails) {
  const name = childDetails.childName || childDetails.name || 'the child';
  const age = childDetails.childAge || childDetails.age || 5;
  const gender = childDetails.childGender || childDetails.gender || 'child';
  const interests = (childDetails.childInterests || childDetails.interests || []).filter(Boolean);
  const favoriteObject = childDetails.favorite_object || (interests[0] ? `a ${interests[0]}` : 'a favorite toy');
  const fear = childDetails.fear || 'the dark';
  const setting = childDetails.setting || '';
  const dedication = childDetails.dedication || `For ${name}`;

  const parts = [`${name}, age ${age}`];
  if (gender && gender !== 'neutral' && gender !== 'not specified') {
    parts.push(gender === 'male' ? 'boy' : gender === 'female' ? 'girl' : gender);
  }
  if (interests.length) parts.push(`loves ${interests.join(', ')}`);
  if (favoriteObject) parts.push(`favorite object: ${favoriteObject}`);
  if (fear) parts.push(`fear/challenge: ${fear}`);
  if (setting) parts.push(`setting: ${setting}`);
  if (customDetails) parts.push(customDetails);

  return `CHILD DETAILS (use these for the specificity rules): ${parts.join('. ')}.`;
}

module.exports = {
  WRITER_BRIEF,
  buildWriterBrief,
  buildV2Brief,
  buildWritingBrief,
  buildStructureBrief,
  buildChildContext,
  getAgeProfile,
  getAgeTier,
  getDialectVars,
  getEmotionalAgeTier,
  AGE_PROFILES,
  AGE_TIERS,
  EMOTIONAL_AGE_TIERS,
  STYLE_MODES,
};
