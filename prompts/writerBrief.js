/**
 * V2 Writer Brief for children's bedtime picture books.
 *
 * The full brief is a professional-grade prompt with 4 age tiers,
 * left/right spread layout, and two-phase bedtime pacing.
 * Variables are substituted at call time: {name}, {age}, {favorite_object},
 * {fear}, {setting}, {dedication}.
 */

// ── Age Tier Configuration ──

const AGE_TIERS = {
  1: {
    tier: 1,
    label: 'Board Book',
    range: [0, 2],
    vocabulary: 'single-syllable words preferred. Max 50 unique words total.',
    sentencesPerSpread: '1-2',
    sentenceStyle: 'Subject-verb only. ("The bunny sleeps.")',
    conflict: 'none. Sensory observation only.',
    dialogue: 'none, or single-word utterances ("Oh." / "Warm.")',
    imagePromptStyle: 'extreme close-up, high contrast, single subject per scene.',
    fearHandling: 'ignore. Replace with a gentle sensory discomfort (too loud, too bright) that simply fades by the final spread.',
    pacing: 'every spread is already calm. No phasing required.',
    arc: 'no arc. Distribute sensory observations evenly across spreads.',
    phaseTwo: null,
    rhymeLevel: 'mandatory couplets — write EVERY spread as two rhyming lines. Format: Line 1 (sets up the image), Line 2 (rhymes and closes). Example: "The stars come out one by one. / Goodnight moon, goodnight sun." Use exact end-rhymes or strong near-rhymes. If you cannot find a natural rhyme, rewrite Line 1 until Line 2 rhymes naturally. No prose. Couplets only.',
  },
  2: {
    tier: 2,
    label: 'Classic Picture Book',
    range: [3, 5],
    vocabulary: 'conversational, concrete. No words above 2 syllables unless a name.',
    maxWordsPerSpread: 25,
    sentencesPerSpread: '1-2',
    sentenceStyle: 'distributed across left and right pages.',
    conflict: 'present but never scary. Stakes are emotional, not physical.',
    dialogue: '2 exchanges required. Rules: (1) Child\'s voice must sound like a real 3-5 year old — short sentences, concrete words, more questions than statements; (2) Dialogue must advance the plot or reveal character — not just describe what the child already knows; (3) The child\'s voice must sound different from the narrator\'s voice.',
    imagePromptStyle: 'wide establishing shots mixed with close emotional moments.',
    fearHandling: 'use as written.',
    pacing: 'Phase 1 (spreads 1-9): emotional aliveness. Phase 2 (spreads 11-13): deliberate de-escalation.',
    arc: 'full story arc applies.',
    phaseTwo: 10,
    rhymeLevel: 'moderate — roughly half the spreads should contain a rhyme or near-rhyme. Mix rhyming couplets with prose. The repeated phrase should rhyme or have a strong rhythmic beat. At age 3, children still love the musicality of rhyme.',
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
    pacing: 'Phase 1 (spreads 1-9): emotional aliveness. Phase 2 (spreads 11-13): deliberate de-escalation.',
    arc: 'arc may include a false resolution before true resolution.',
    phaseTwo: 10,
    rhymeLevel: 'light — occasional internal rhymes or near-rhymes for flavor. Story prose dominates. A couplet here and there, not a pattern.',
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
    pacing: 'Phase 1 (spreads 1-9): Fuller sentences. Richer texture. Phase 2 (spreads 11-13): same de-escalation.',
    arc: 'arc may include a secondary character with their own want.',
    phaseTwo: 10,
    rhymeLevel: 'subtle — only where it emerges naturally from the prose. Slant rhymes and internal echoes preferred over end-rhymes.',
  },
};

/**
 * Return the tier number (1-4) and tier config for a given age.
 * @param {number|string} age
 * @returns {{ tier: number, config: object }}
 */
function getAgeTier(age) {
  const a = Number(age) || 5;
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

-------------------------------------
WRITING QUALITY OVERRIDES (MANDATORY)
-------------------------------------
- Never state emotions directly (no: "she was scared", "he felt happy").
  Always show emotion through action, sensory detail, or environment.

- DIALECT & SPELLING — use {dialect} throughout:
  {dialectRule}
  Never mix dialects. Every single word — story text, dedication, any labels — must be consistent.

- Every spread must contain a small tension, question, or imbalance.

- The child must actively cause the turning point and resolution.

- Use concrete, sensory language. Avoid vague words like "thing", "stuff", "very", "nice", "pretty", "fun", "special", "magical".

- Include one repeated phrase that appears at least twice and evolves in meaning by the climax.

- At least 2 spreads should be entirely visual (no text on either page). Place these strategically:
  - ONE at the moment of highest tension — where silence is more powerful than words (typically spreads 6-8)
  - ONE just before or at the ending — where the image completes what words cannot (typically spreads 12-13)
  Do NOT place visual-only spreads during setup (spreads 1-3) — the reader needs words to enter the world first.

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
Write with the qualities of master children's authors:

- Simple but precise language. Every word earns its place.
- No cliches. No filler sentences.
- Respect the child's intelligence — never talk down.
- Emotion is implied, never explained.
- Dialogue feels natural, curious, and childlike — not functional.

RHYTHM & RHYME (CRITICAL — read-aloud quality is non-negotiable):
- Read each line aloud in your head before finalizing. If it stumbles, rewrite it.
- Syllable target: 8–14 syllables per sentence. Vary length for natural breathing points.
- Every spread must contain at least one short sentence (5 words or fewer) for rhythm contrast.
- Avoid: tongue twisters, three-word noun stacks, words over 3 syllables (except names/invented words).
- RHYME LEVEL FOR THIS AGE ({age}): {rhymeLevel}
  A near-rhyme or internal rhyme always beats a strained end-rhyme. If a rhyme bends the meaning, drop it.
- Use gentle repetition for emotional effect — the repeated phrase is a rhythmic anchor.

TONE:
- Warm, intimate, slightly poetic.
- Calm but emotionally alive.
- Avoid moralizing or explicit lessons.

-------------------------------------
STORY ENGINE
-------------------------------------
- {favorite_object} is essential — it must actively help OR represent courage.
  Name it specifically every time. Never call it "the toy."
- {fear} must appear as a real obstacle the child moves THROUGH.
- {setting} (if provided) must shape the visual world of the story.
- {dedication} (if provided): use as written. If not provided, write: "For {name}."

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
Spread 12:     Sleep / stillness

-------------------------------------
TRANSFORMATION RULE (CRITICAL)
-------------------------------------
A repeated element (word, phrase, or concept — e.g. "the dark") must:

- Start as something uncertain or threatening
- Gradually change
- End as something safe, understood, or gentle

PHRASE ARC USAGE (CRITICAL):
The brainstorm provided a phrase_arc with 3 stages. You MUST use them:
- When the phrase appears in spreads 1-4: the surrounding action/imagery must reflect the EARLY meaning. The phrase should feel tentative, playful, or questioning.
- When the phrase appears in spreads 5-8: the surrounding action/imagery must reflect the MIDDLE meaning. The phrase should feel braver or more purposeful.
- When the phrase appears in spreads 10-13: the surrounding action/imagery must reflect the END meaning. The phrase should feel resolved, safe, or transforming.
Show the evolution through what the child DOES around the phrase — not by adding explanation.

-------------------------------------
ENDING RULES (CRITICAL)
-------------------------------------
- The final lines must feel like a whisper, not a conclusion.
- The world must feel physically and emotionally safe.
- The {favorite_object} should be present in the final moment.
- End with an image or feeling — NOT a lesson.

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

-------------------------------------
EXEMPLAR SPREADS (TARGET QUALITY)
-------------------------------------

These examples show the level of writing you must match or exceed.
Do NOT copy these — they are for tone and quality calibration only.

EXAMPLE A (setup — emotion shown through action, not told):
Left: "The house creaked its old-wood song. Luna pulled Momo closer — one ear still warm from breakfast."
Right: null

EXAMPLE B (turning point — sensory, minimal, repeated phrase appears):
Left: "She pressed her palm against the window. The fog pressed back."
Right: "Hush now, little seed, she whispered — but her voice wobbled."

EXAMPLE C (resolution — poetic, whisper-like, phrase transformed):
Left: null
Right: "The dark had a sound now. Not a growl. A hum. Momo's button eyes caught the last sliver of moon."

EXAMPLE D (ending spread — whisper, not conclusion):
Left: null
Right: "The last Number Num clicked into place. One, two, three — all the way to ten. She let out a breath she didn't know she'd been holding. The blanket pulled itself up around her chin."

Notice: No "and she fell asleep" — the action shows it. The held breath released = relief. The blanket "pulled itself" = magical calm.

EXAMPLE E (visual-only spread — silence as storytelling):
Left: null
Right: null
[Image prompt: Wide shot of the child standing still at the center of the forest, small against the tall trees, the glow of a single Number Num floating at eye level. No text. The moment holds itself.]

Notice: No words. The reader pauses. The image does more than any sentence could.

EXAMPLE F (refrain spread — phrase at its middle stage):
Left: "The path forked into three. She held Barnaby tighter."
Right: "Grammy's warmth is always with you, she whispered to herself. This time it came out more like a question."

Notice: The refrain appears naturally in dialogue. "More like a question" shows it's still evolving — not yet resolved.

EXAMPLE G (resolution spread — child causes the turning point):
Left: "She didn't wait for the dark to move."
Right: "She walked into it."

Notice: Two sentences. Five words on the right. The child acts — the story turns. No explanation.

EXAMPLE H (tension spread — specific sensory detail, not vague fear):
Left: "A sound. Not the house. Not the wind."
Right: "She pressed her ear against the door and heard — counting. One, two, three."

Notice: Short sentences create rhythm and suspense. The fear becomes specific. The child investigates — not paralyzed.

Notice what makes these work:
- No emotion-telling ("she felt scared") — only action and sensation
- Every sentence is specific and unreplaceable
- Rhythm varies (long then short)
- The repeated phrase appears naturally and evolves
- Silence (null pages) creates breathing room

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
  The child wears this SAME outfit from spread 1 to the last spread. No changes.
  NEVER have the child change clothes, add layers, remove items, or get messy/wet.

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
- Text may appear on left, right, or both. A page may have null text for visual-only spreads.
- spread_image_prompt describes ONE CONTINUOUS PANORAMIC SCENE (wide landscape, like a movie still or panoramic photograph). Write it as a single unified scene — NOT as separate left-side and right-side descriptions.
- IMPORTANT: Do NOT describe content as being "on the left" and other content "on the right." Describe ONE flowing scene with the child as the focal point and the environment surrounding them naturally. Avoid placing the child at the exact horizontal center of the composition — offset them slightly for visual interest.
- Do NOT specify art medium in spread_image_prompt.
- Do NOT re-describe the outfit in spread_image_prompt — it is defined once at the top level.
- Do NOT re-describe hair or hair accessories in spread_image_prompt — they are defined once in characterDescription. Never mention headbands, bows, clips, or any hair accessory in individual spread prompts.
- Use apostrophes directly in strings (no escaping needed).
- No newlines inside string values.

-------------------------------------
FINAL CHECK BEFORE OUTPUT
-------------------------------------
Before writing, silently verify:
- Is the child the one who changes the outcome?
- Is emotion shown, not told?
- Is there at least one memorable line a parent would repeat outside the book?
- Does the repeated phrase transform from uncertain to safe?
- Does the ending feel soft and satisfying?
- Are there at least 2 visual-only spreads?
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

2. RHYME (EARNED, NOT FORCED)
- {rhymeLevel}
- A near-rhyme or internal rhyme is always better than a strained end-rhyme.
- If a rhyme would bend the meaning or feel like a coincidence, drop it entirely.
- Rhymes that feel inevitable are the goal — the reader should feel the rhyme before they hear it.

3. LANGUAGE LEVEL
- Vocabulary suitable for the child's age
- Prefer concrete, visual words (blanket, moon, steps, glow)
- Avoid abstract phrases and vague words ("magical", "special", "nice", "wonderful")

3.5 DIALECT & SPELLING — use {dialect} throughout:
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
Write with the qualities of master children's authors:

- Simple but precise language. Every word earns its place.
- No cliches. No filler sentences.
- Respect the child's intelligence — never talk down.
- Emotion is implied, never explained.
- Dialogue feels natural, curious, and childlike — not functional.

RHYTHM & RHYME (CRITICAL — read-aloud quality is non-negotiable):
- Read each line aloud in your head before finalizing. If it stumbles, rewrite it.
- Syllable target: 8–14 syllables per sentence. Vary length for natural breathing points.
- Every spread must contain at least one short sentence (5 words or fewer) for rhythm contrast.
- Avoid: tongue twisters, three-word noun stacks, words over 3 syllables (except names/invented words).
- RHYME LEVEL FOR THIS AGE ({age}): {rhymeLevel}
  A near-rhyme or internal rhyme always beats a strained end-rhyme. If a rhyme bends the meaning, drop it.
- Use gentle repetition for emotional effect — the repeated phrase is a rhythmic anchor.

TONE:
- Warm, intimate, slightly poetic.
- Calm but emotionally alive.
- Avoid moralizing or explicit lessons.

-------------------------------------
STORY ENGINE
-------------------------------------
- {favorite_object} is essential — it must actively help OR represent courage.
  Name it specifically every time. Never call it "the toy."
- {fear} must appear as a real obstacle the child moves THROUGH.
- {setting} (if provided) must shape the visual world of the story.

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
Spread 12:     Sleep / stillness

-------------------------------------
TRANSFORMATION RULE (CRITICAL)
-------------------------------------
A repeated element (word, phrase, or concept — e.g. "the dark") must:

- Start as something uncertain or threatening
- Gradually change
- End as something safe, understood, or gentle

PHRASE ARC USAGE (CRITICAL):
The brainstorm provided a phrase_arc with 3 stages. You MUST use them:
- When the phrase appears in spreads 1-4: the surrounding action/imagery must reflect the EARLY meaning. The phrase should feel tentative, playful, or questioning.
- When the phrase appears in spreads 5-8: the surrounding action/imagery must reflect the MIDDLE meaning. The phrase should feel braver or more purposeful.
- When the phrase appears in spreads 10-13: the surrounding action/imagery must reflect the END meaning. The phrase should feel resolved, safe, or transforming.
Show the evolution through what the child DOES around the phrase — not by adding explanation.

-------------------------------------
ENDING RULES (CRITICAL)
-------------------------------------
- The final lines must feel like a whisper, not a conclusion.
- The world must feel physically and emotionally safe.
- The {favorite_object} should be present in the final moment.
- End with an image or feeling — NOT a lesson.

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
Left: "The house creaked its old-wood song. Luna pulled Momo closer — one ear still warm from breakfast."
Right: null

EXAMPLE B (turning point — sensory, minimal, repeated phrase appears):
Left: "She pressed her palm against the window. The fog pressed back."
Right: "Hush now, little seed, she whispered — but her voice wobbled."

EXAMPLE C (resolution — poetic, whisper-like, phrase transformed):
Left: null
Right: "The dark had a sound now. Not a growl. A hum. Momo's button eyes caught the last sliver of moon."

Notice what makes these work:
- No emotion-telling — only action and sensation
- Every sentence is specific and unreplaceable
- Rhythm varies (long then short)
- The repeated phrase evolves naturally
- Silence (null pages) creates breathing room

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

TITLE: [your title]

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
- Each spread has Left and Right. Use null for visual-only pages.
- At least 2 spreads must have a null page.
- Do NOT include illustration descriptions, JSON, or metadata.
- Focus entirely on the story text and its quality.`;

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
  The child wears this SAME outfit from spread 1 to the last spread. No changes.
  NEVER have the child change clothes, add layers, remove items, or get messy/wet.

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
    { "type": "spread", "spread": 1, "left": { "text": "..." }, "right": { "text": "..." }, "spread_image_prompt": "..." },
    ...13 spreads total...
  ]
}

Front matter pages (half-title, title page, copyright) are added automatically — do NOT include them.
The "entries" array must contain exactly: 1 dedication_page + 13 spreads = 14 entries.

Rules:
- PRESERVE all story text EXACTLY as written in the input — do not rewrite, paraphrase, or edit.
- Text may appear on left, right, or both. null text means visual-only page.
- spread_image_prompt describes ONE CONTINUOUS PANORAMIC SCENE (wide landscape, like a movie still or panoramic photograph). Write it as a single unified scene — NOT as separate left-side and right-side descriptions.
- IMPORTANT: Do NOT describe content as being "on the left" and other content "on the right." Describe ONE flowing scene with the child as the focal point. Avoid placing the child at the exact horizontal center — offset them slightly for visual interest.
- Do NOT specify art medium in spread_image_prompt.
- Do NOT re-describe the outfit in spread_image_prompt — it is defined once at the top level.
- Do NOT re-describe hair or hair accessories in spread_image_prompt — they are defined once in characterDescription. Never mention headbands, bows, clips, or any hair accessory in individual spread prompts.
- Use apostrophes directly in strings (no escaping needed).
- No newlines inside string values.

-------------------------------------
FINAL CHECK
-------------------------------------
Before outputting, verify:
- Are there exactly 12 spreads?
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
function buildV2Brief(vars) {
  const { name, favorite_object, fear, setting, dedication } = vars;
  const age = Number(vars.age) || 5;
  const { config } = getAgeTier(age);
  let brief = V2_BRIEF_TEMPLATE;
  brief = brief.replace(/\{name\}/g, name || 'the child');
  brief = brief.replace(/\{age\}/g, String(age));
  brief = brief.replace(/\{favorite_object\}/g, favorite_object || 'a favorite toy');
  brief = brief.replace(/\{fear\}/g, fear || 'the dark');
  brief = brief.replace(/\{setting\}/g, setting || 'a magical place');
  brief = brief.replace(/\{dedication\}/g, dedication || `For ${name || 'the child'}`);
  brief = brief.replace(/\{maxWordsPerSpread\}/g, String(config.maxWordsPerSpread || 30));
  brief = brief.replace(/\{rhymeLevel\}/g, config.rhymeLevel || '');
  return brief;
}

/**
 * Build the writing-only brief (for free-form text generation, no JSON).
 * @param {{ name: string, age: number, favorite_object: string, fear: string, setting: string, dedication: string }} vars
 * @returns {string}
 */

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
  brief = brief.replace(/\{maxWordsPerSpread\}/g, String(config.maxWordsPerSpread || 30));
  brief = brief.replace(/\{rhymeLevel\}/g, config.rhymeLevel || '');
  brief = brief.replace(/\{dialect\}/g, dialect);
  brief = brief.replace(/\{dialectRule\}/g, dialectRule);
  return brief;
}

/**
 * Build the structure brief (for JSON conversion + illustration prompts).
 * @param {{ name: string, age: number, favorite_object: string, fear: string, setting: string }} vars
 * @returns {string}
 */
function buildStructureBrief(vars) {
  const { name, favorite_object } = vars;
  let brief = STRUCTURE_BRIEF_TEMPLATE;
  brief = brief.replace(/\{name\}/g, name || 'the child');
  brief = brief.replace(/\{favorite_object\}/g, favorite_object || 'a favorite toy');
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
};
