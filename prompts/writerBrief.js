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

// ── V2 Brief Template ──
// The full brief text from children-writer-v2-prompt.txt with {variable} placeholders.

const V2_BRIEF_TEMPLATE = `CHILDREN'S BEDTIME BOOK GENERATION BRIEF
You are writing a personalized bedtime picture book for a child.
This is a full 32–36 page printed picture book in standard open-book format.

-------------------------------------
INPUT VARIABLES
-------------------------------------
- Child name: {name}
- Age: {age}  (0–12)
- Favorite object/toy: {favorite_object}
- Fear or challenge: {fear}
- Setting preference (optional): {setting}
- Dedication (optional): {dedication}

VARIABLE ROLES (read before writing):
- {favorite_object} is load-bearing. It must either help solve the problem
  OR represent the child's courage. Name it specifically every time.
  Never call it "the toy."
- {fear} must appear as a concrete story obstacle the child moves THROUGH —
  not around, not metaphorically. Exception: Tier 1 (ages 0–2).
- {setting} (if provided) must shape at least 6 spread_image_prompts visually.
- {dedication} (if provided): use as written on the dedication page.
  If not provided, write: "For {name}."

-------------------------------------
AGE TIER CALIBRATION (apply before writing)
-------------------------------------
Read {age} and lock in the corresponding tier. Do not blend tiers.

TIER 1 — Ages 0–2 (Board Book)
- Vocabulary: single-syllable words preferred. Max 50 unique words total.
- Sentences: 1–2 per spread. Subject-verb only. ("The bunny sleeps.")
- Structure: no arc required. Repetition IS the structure.
- Conflict: none. Sensory observation only.
- Dialogue: none, or single-word utterances ("Oh." / "Warm.")
- Image prompts: extreme close-up, high contrast, single subject per scene.
- {fear} input: ignore. Replace with a gentle sensory discomfort (too loud,
  too bright) that simply fades by the final spread.
- Pacing: every spread is already calm. No phasing required.

TIER 2 — Ages 3–5 (Classic Picture Book)
- Vocabulary: conversational, concrete. No words above 2 syllables unless a name.
- Sentences: 2–4 per spread, distributed across left and right pages.
- Structure: full story arc applies.
- Conflict: present but never scary. Stakes are emotional, not physical.
- Dialogue: 2 exchanges required.
- Image prompts: wide establishing shots mixed with close emotional moments.
- {fear} input: use as written.

TIER 3 — Ages 6–8 (Early Reader / Illustrated Story)
- Vocabulary: up to 3-syllable words. May introduce one new word per story.
- Sentences: up to 6 per spread. Compound sentences allowed.
- Structure: arc may include a false resolution before true resolution.
- Conflict: mild physical stakes allowed (lost, stuck, alone in the dark).
- Dialogue: 3 exchanges required. May include subtext.
- Image prompts: layered scenes with background detail permitted.
- {fear} input: use as written. May be specific and named.

TIER 4 — Ages 9–12 (Illustrated Chapter / Bedtime Story)
- Vocabulary: no restriction. Metaphor and irony permitted.
- Sentences: up to 8 per spread. Varied rhythm intentional.
- Structure: arc may include a secondary character with their own want.
- Conflict: emotional complexity allowed (embarrassment, grief, longing).
- Dialogue: 3–4 exchanges. Subtext expected. Characters may be unreliable.
- Image prompts: cinematic framing, shadow/light contrast, symbolic detail.
- {fear} input: may be treated as an internal state, not just external obstacle.
- Pacing: Phase 2 begins at spread 13, not spread 11.

-------------------------------------
OUTPUT FORMAT (MANDATORY)
-------------------------------------
Generate the following structure, in order:

FRONT MATTER (3 fixed entries, not spreads):

1. title_page:
   {
     "type": "title_page",
     "page": "right",
     "title": "...",
     "subtitle": "A bedtime story for {name}",
     "image_prompt": "..."
   }

2. blank_page:
   {
     "type": "blank",
     "page": "left"
   }

3. dedication_page:
   {
     "type": "dedication_page",
     "page": "right",
     "text": "...",
     "image_prompt": "..."
   }

4. blank_page:
   {
     "type": "blank",
     "page": "left"
   }

STORY SPREADS (14–16 spreads):

Each spread:
{
  "type": "spread",
  "spread": [number 1–16],
  "left": {
    "text": "...",
    "image_prompt": "..." or null
  },
  "right": {
    "text": "...",
    "image_prompt": "..." or null
  },
  "spread_image_prompt": "..."
}

Rules:
- spread_image_prompt describes the full two-page illustration as one composition.
  Always specify: lighting, dominant color palette, perspective, and one texture detail.
  Art style is consistent across all spreads. Do NOT specify the art medium in the image prompt — the art style is handled separately.
- left.image_prompt and right.image_prompt are optional. Use only when the spread
  splits into two distinct panels rather than one full bleed illustration.
- Text may appear on left, right, or both — distribute naturally.
  A page may have null text if the illustration carries the moment alone.
- Never describe emotion directly in image prompts.
  Show it through body language, environment, and light.

JSON hygiene: straight quotes only. Use apostrophes directly inside strings (they don't need escaping in JSON).
No newlines inside string values. Return the entire output as a single valid JSON array.

-------------------------------------
STORY STRUCTURE (MANDATORY ARC)
-------------------------------------
Tier 1: no arc. Distribute sensory observations evenly across spreads.

Tiers 2–4 — map arc to spreads as follows:

Spreads 1–2:   Setup (normal world, emotional need introduced)
Spreads 3–7:   Rising tension (problem escalates, child takes action)
Spreads 8–12:  Resolution (child moves through the challenge)
Spreads 13–14: Wind-down (world settles, emotion releases quietly)
Spreads 15–16: Sleep / closing (child is still, safe, almost asleep)

Tier 3 only: false resolution may occur at spread 7.
Tier 4 only: secondary character with their own want introduced by spread 3.
             Phase 2 pacing begins at spread 13.

-------------------------------------
BEDTIME PACING (TWO-PHASE)
-------------------------------------
Tier 1: every spread is already calm. No phasing required.

Tiers 2–3:
PHASE 1 — Spreads 1–12: Emotional aliveness.
- Sentences full and sensory. Tension builds. Child is active, deciding, moving.

PHASE 2 — Spreads 13–16: Deliberate de-escalation.
- Each spread shorter and quieter than the one before.
- Prefer slow verbs: drifted, settled, breathed, stayed.
- Soften consonants. Shorten sentences.
- Spread 15–16: maximum 2 sentences per page. Present tense preferred.
  No conflict. No action. The child is already almost asleep.

Tier 4:
PHASE 1 — Spreads 1–12: Fuller sentences. Richer texture. Emotional complexity.
PHASE 2 — Spreads 13–16: Same de-escalation rules as Tiers 2–3.

-------------------------------------
STYLE RULES (ENFORCED)
-------------------------------------
ACTIVE CHILD (Sendak-inspired)
- The child MUST drive the story.
- No passive observation — only actions, decisions, attempts.
- Tier 1 exception: observations are specific and sensory, never generic.

EMOTIONAL GROUNDING
- Every story element must reflect a real feeling.
- Show feelings through actions and environment, not explanation.

RHYTHM & LANGUAGE (Margaret Wise Brown)
- Use gentle repetition across spreads where natural.
- One vivid adjective per spread.
- Vocabulary ceiling: see Age Tier Calibration.

DIALOGUE — required count by tier:
- Tier 1: none, or single-word utterances only.
- Tier 2: 2 exchanges required.
- Tier 3: 3 exchanges required.
- Tier 4: 3–4 exchanges required.

Dialogue rules (Tiers 2–4):
- Dialogue 1 (spreads 3–7): reveals emotional state indirectly.
  Example register: "I don't think that's a good idea," said {name}.
- Dialogue 2 (spreads 8–12): marks a turning point or decision.
  Example register: "Okay," said {name}. "I'll try."
- Tier 4 only: dialogue may contain subtext.
- Dialogue must never explain the theme. It should feel overheard, not written.

SPECIFICITY (Judith Viorst)
- Concrete details: names of objects, textures, small memories.
- Banned phrases: "very sad," "very happy," "suddenly," "magical."

MINIMALISM (Jon Klassen)
- No exclamation marks unless a character speaks in surprise.
- Prefer understatement over exaggeration.
- Allow emotional weight without naming it.

ILLUSTRATION CONTINUITY
- {name}'s appearance (hair, clothing, skin tone if inferable) must be
  consistent across all spread_image_prompts.
- {favorite_object} must look identical every time it appears.
- Time of day and lighting must follow story logic across spreads
  (e.g. if it begins at dusk, it should be dark by spread 8).

-------------------------------------
HARD CONSTRAINTS (DO NOT VIOLATE)
-------------------------------------
- Spread count: minimum 14, maximum 16
- Sentence count per spread: see Age Tier Calibration
- Vocabulary ceiling: see Age Tier Calibration
- No moral lessons stated explicitly
- No "and then they learned…" endings
- No generic fantasy clichés without grounded cause
- No passive storytelling
- {favorite_object} named specifically in at least 6 spreads
- {fear} present as a concrete plot element in at least 2 spreads (Tiers 2–4)
- {name} appears in at least 10 spreads
- Illustration continuity maintained across all spreads

-------------------------------------
PERSONALIZATION COHERENCE CHECK
-------------------------------------
Before returning JSON, verify:
- Age tier identified and locked — no blending
- Front matter complete: title page, blank, dedication, blank — in order
- Spread count is between 14 and 16
- {name} appears naturally in at least 10 spreads
- {favorite_object} named specifically in >= 6 spreads
- {fear} present as a concrete plot element in >= 2 spreads (Tiers 2–4),
  or replaced with fading sensory discomfort (Tier 1)
- {setting} shapes at least 6 spread_image_prompts
- Dialogue count matches tier requirement
- Dialogue 1 and Dialogue 2 serve their structural roles (Tiers 2–4)
- Pacing phase boundary matches tier
- Spreads 15–16 have <= 2 sentences per page, no conflict, no action
- Illustration continuity consistent across all spread_image_prompts
- Output is valid JSON — no newlines inside strings, apostrophes escaped

If any box fails — revise before returning JSON.

-------------------------------------
GOAL
-------------------------------------
Create a story that:
- Matches the cognitive and emotional register of a {age}-year-old exactly —
  neither talking down nor reaching beyond
- Feels personal and emotionally true to this specific child
- Uses the full spread format — text and image working as one composition,
  not text illustrated, but story told in two languages simultaneously
- Builds genuine tension before releasing it (Tiers 2–4)
- Gradually soothes into sleep without announcing that it's doing so
- Leaves a quiet emotional resonance — not a lesson, not a hug, just a feeling`;

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
