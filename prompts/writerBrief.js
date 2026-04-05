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
  },
  2: {
    tier: 2,
    label: 'Classic Picture Book',
    range: [3, 5],
    vocabulary: 'conversational, concrete. No words above 2 syllables unless a name.',
    sentencesPerSpread: '2-4',
    sentenceStyle: 'distributed across left and right pages.',
    conflict: 'present but never scary. Stakes are emotional, not physical.',
    dialogue: '2 exchanges required.',
    imagePromptStyle: 'wide establishing shots mixed with close emotional moments.',
    fearHandling: 'use as written.',
    pacing: 'Phase 1 (spreads 1-12): emotional aliveness. Phase 2 (spreads 13-16): deliberate de-escalation.',
    arc: 'full story arc applies.',
    phaseTwo: 13,
  },
  3: {
    tier: 3,
    label: 'Early Reader / Illustrated Story',
    range: [6, 8],
    vocabulary: 'up to 3-syllable words. May introduce one new word per story.',
    sentencesPerSpread: 'up to 6',
    sentenceStyle: 'Compound sentences allowed.',
    conflict: 'mild physical stakes allowed (lost, stuck, alone in the dark).',
    dialogue: '3 exchanges required. May include subtext.',
    imagePromptStyle: 'layered scenes with background detail permitted.',
    fearHandling: 'use as written. May be specific and named.',
    pacing: 'Phase 1 (spreads 1-12): emotional aliveness. Phase 2 (spreads 13-16): deliberate de-escalation.',
    arc: 'arc may include a false resolution before true resolution.',
    phaseTwo: 13,
  },
  4: {
    tier: 4,
    label: 'Illustrated Chapter / Bedtime Story',
    range: [9, 12],
    vocabulary: 'no restriction. Metaphor and irony permitted.',
    sentencesPerSpread: 'up to 8',
    sentenceStyle: 'Varied rhythm intentional.',
    conflict: 'emotional complexity allowed (embarrassment, grief, longing).',
    dialogue: '3-4 exchanges. Subtext expected. Characters may be unreliable.',
    imagePromptStyle: 'cinematic framing, shadow/light contrast, symbolic detail.',
    fearHandling: 'may be treated as an internal state, not just external obstacle.',
    pacing: 'Phase 1 (spreads 1-12): Fuller sentences. Richer texture. Phase 2 (spreads 13-16): same de-escalation.',
    arc: 'arc may include a secondary character with their own want.',
    phaseTwo: 13,
  },
};

/**
 * Return the tier number (1-4) and tier config for a given age.
 * @param {number|string} age
 * @returns {{ tier: number, config: object }}
 */
function getAgeTier(age) {
  const a = Math.max(3, Number(age) || 5); // Minimum age 3 for writing quality — Tier 1 (board book) text is too simple for a printed picture book
  if (a <= 2) return { tier: 1, config: AGE_TIERS[1] };
  if (a <= 5) return { tier: 2, config: AGE_TIERS[2] };
  if (a <= 8) return { tier: 3, config: AGE_TIERS[3] };
  return { tier: 4, config: AGE_TIERS[4] };
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

- Every spread must contain a small tension, question, or imbalance.

- The child must actively cause the turning point and resolution.

- Use concrete, sensory language. Avoid vague words like "thing", "stuff", "very", "nice", "pretty", "fun", "special", "magical".

- Include one repeated phrase that appears at least twice and evolves in meaning by the climax.

- At least 2 spreads should rely primarily on visuals (minimal or no text).

- Include one subtle emotional layer that resonates with the parent reading.

- Every 2 spreads must include at least one short sentence (<=5 words) for rhythm.

- At least one line in the story must be memorable enough that a parent would want to repeat it even outside the book.

-------------------------------------
AUTHORIAL VOICE (MANDATORY)
-------------------------------------
Write with the qualities of master children's authors:

- Simple but precise language. Every word earns its place.
- No cliches. No filler sentences.
- Respect the child's intelligence — never talk down.
- Emotion is implied, never explained.
- Dialogue feels natural, curious, and childlike — not functional.

RHYTHM:
- The text must sound beautiful when read aloud.
- Vary sentence length intentionally.
- Use gentle repetition for emotional effect.

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

STRUCTURE:

Spreads 1-2:   Setup (normal world + emotional need)
Spreads 3-7:   Rising tension (problem grows, uncertainty increases)
Spreads 8-12:  Turning point + resolution (child takes action)
Spreads 13-14: Emotional release (world softens)
Spreads 15-16: Sleep / stillness

-------------------------------------
TRANSFORMATION RULE (CRITICAL)
-------------------------------------
A repeated element (word, phrase, or concept — e.g. "the dark") must:

- Start as something uncertain or threatening
- Gradually change
- End as something safe, understood, or gentle

-------------------------------------
ENDING RULES (CRITICAL)
-------------------------------------
- The final lines must feel like a whisper, not a conclusion.
- The world must feel physically and emotionally safe.
- The {favorite_object} should be present in the final moment.
- End with an image or feeling — NOT a lesson.

-------------------------------------
ILLUSTRATION PROMPTS
-------------------------------------
For each spread, include a spread_image_prompt that describes the visual scene.
- Describe composition, lighting, color palette, perspective, and one texture detail.
- Do NOT specify art medium or style — that is handled separately.
- Show emotion through body language, environment, and light — never label it.
- {name}'s appearance must be consistent across all prompts.
- {favorite_object} must look identical every time it appears.
- Time of day and lighting must follow story logic.

-------------------------------------
OUTPUT FORMAT (MANDATORY JSON)
-------------------------------------
Return a JSON object with this structure:
{
  "entries": [
    { "type": "title_page", "page": "right", "title": "...", "subtitle": "A bedtime story for {name}" },
    { "type": "blank", "page": "left" },
    { "type": "dedication_page", "page": "right", "text": "..." },
    { "type": "blank", "page": "left" },
    { "type": "spread", "spread": 1, "left": { "text": "..." }, "right": { "text": "..." }, "spread_image_prompt": "..." },
    ...16 spreads total...
  ]
}

Rules:
- Text may appear on left, right, or both. A page may have null text for visual-only spreads.
- spread_image_prompt describes the full illustration scene.
- Do NOT specify art medium in spread_image_prompt.
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

Only proceed if all answers are YES.`;

/**
 * Build the complete V2 brief with variables substituted.
 *
 * @param {{ name: string, age: number, favorite_object: string, fear: string, setting: string, dedication: string }} vars
 * @returns {string} The full brief with all variables replaced
 */
function buildV2Brief(vars) {
  const { name, favorite_object, fear, setting, dedication } = vars;
  const age = Math.max(3, Number(vars.age) || 5); // Minimum age 3 — Tier 1 board book text too simple
  let brief = V2_BRIEF_TEMPLATE;
  brief = brief.replace(/\{name\}/g, name || 'the child');
  brief = brief.replace(/\{age\}/g, String(age));
  brief = brief.replace(/\{favorite_object\}/g, favorite_object || 'a stuffed bear');
  brief = brief.replace(/\{fear\}/g, fear || 'the dark');
  brief = brief.replace(/\{setting\}/g, setting || 'a magical place');
  brief = brief.replace(/\{dedication\}/g, dedication || `For ${name || 'the child'}`);
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
  const favoriteObject = childDetails.favorite_object || (interests[0] ? `a ${interests[0]}` : 'a stuffed bear');
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
  buildChildContext,
  getAgeProfile,
  getAgeTier,
  AGE_PROFILES,
  AGE_TIERS,
};
