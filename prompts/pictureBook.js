/**
 * Prompt templates for picture book generation.
 *
 * V2: The story planner now uses the full V2 brief as the system prompt
 * and returns front matter + left/right spreads with text and image prompts
 * in a single LLM call.
 */

const { sanitizeForPrompt } = require('../services/validation');
const { buildV2Brief, buildChildContext, getAgeTier } = require('./writerBrief');

/**
 * Build system prompt for V2 story planner.
 * Uses the full V2 brief with variables substituted.
 *
 * @param {{ name: string, age: number, favorite_object: string, fear: string, setting: string, dedication: string }} vars
 * @returns {string}
 */
function buildStoryPlannerSystem(vars) {
  // Accept either a vars object (V2) or a bare age number (legacy compat)
  if (typeof vars === 'number' || typeof vars === 'string') {
    return buildV2Brief({
      name: '{name}',
      age: Number(vars) || 5,
      favorite_object: '{favorite_object}',
      fear: '{fear}',
      setting: '{setting}',
      dedication: '{dedication}',
    });
  }
  return buildV2Brief(vars);
}

// Static fallback for backward compat
const STORY_PLANNER_SYSTEM = buildStoryPlannerSystem(5);

/**
 * Build V2 user prompt for story planner.
 *
 * @param {object} childDetails - { name, age, gender, interests, ... }
 * @param {string} theme
 * @param {string} customDetails
 * @param {object} v2Vars - { favorite_object, fear, setting, dedication }
 * @returns {string}
 */
function STORY_PLANNER_USER(childDetails, theme, customDetails, v2Vars = {}) {
  const name = sanitizeForPrompt(childDetails.childName || childDetails.name || '', 50);
  const age = childDetails.childAge || childDetails.age || 5;
  const interests = (childDetails.childInterests || childDetails.interests || []).map(i => sanitizeForPrompt(i, 50)).join(', ') || 'general';
  const details = customDetails ? sanitizeForPrompt(customDetails, 500) : '';
  const childContext = buildChildContext(childDetails, details);

  const { tier } = getAgeTier(age);

  const favoriteObject = v2Vars.favorite_object || 'a stuffed bear';
  const fear = v2Vars.fear || 'the dark';
  const setting = v2Vars.setting || '';
  const dedication = v2Vars.dedication || `For ${name || 'the child'}`;

  return `${childContext}

Create a personalized bedtime picture book for ${name} (age ${age}).

Child details:
- Age: ${age} (Tier ${tier})
- Gender: ${childDetails.childGender || childDetails.gender || 'not specified'}
- Interests: ${interests}
- Favorite object/toy: ${favoriteObject}
- Fear or challenge: ${fear}
- Setting: ${setting || 'use theme to determine'}
- Dedication: ${dedication}
${details ? `- Special requests / real quirks: ${details}` : ''}

Theme: ${theme || 'bedtime'}

Generate the COMPLETE story as a JSON object with this structure:
{
  "title": "The book title",
  "characterOutfit": "exact outfit the child wears in EVERY spread (garment type, color, patterns, shoes, accessories)",
  "characterDescription": "physical appearance details beyond the photo (MUST include hair description)",
  "recurringElement": "exact visual description of ${v2Vars?.favorite_object || 'the favorite object'} so it looks identical on every page",
  "keyObjects": "other objects that recur across spreads, with exact visual details",
  "entries": [
    { "type": "dedication_page", "text": "${dedication}" },
    { "type": "spread", "spread": 1, "left": { "text": "..." }, "right": { "text": "..." }, "spread_image_prompt": "..." },
    ...12 spreads total...
  ]
}

IMPORTANT:
- You MUST include title, characterOutfit, characterDescription, recurringElement, and keyObjects at the top level.
- characterOutfit defines ONE specific outfit the child wears from first spread to last — no clothing changes.
- Return ONLY a valid JSON object with the visual consistency fields and an "entries" array.
- Front matter (half-title, title page, copyright) is added automatically — do NOT include them.
- The entries array must contain exactly: 1 dedication_page + 12 spreads = 13 entries.
- Each spread must have spread_image_prompt (a wide landscape scene spanning two facing pages).
- The CENTER of each illustration will be in the book's binding — do NOT describe key characters, text, or objects in the center of the scene. Place them on the left or right side.
- Do NOT re-describe the outfit in spread_image_prompt — it is defined once at the top level.
- Text goes in left.text and/or right.text (one can be null if the illustration carries the moment).
- All image prompts must specify: lighting, color palette, perspective, one texture detail.
- Do NOT specify art medium or style in image prompts — that is handled separately by the illustration engine.
- Follow ALL rules from the system brief (age tier, pacing, dialogue, etc.).
- No newlines inside string values. Use apostrophes directly in strings (no escaping needed).`;
}

// ── Legacy text generator prompts (kept for backward compat) ──

function buildTextGeneratorSystem(age) {
  return buildStoryPlannerSystem(age);
}

const TEXT_GENERATOR_SYSTEM = buildTextGeneratorSystem(5);

function TEXT_GENERATOR_USER(spreadPlan, childDetails, storyContext) {
  return `Write the text for spread #${spreadPlan.spreadNumber} of a picture book for ${childDetails.childName || childDetails.name} (age ${childDetails.childAge || childDetails.age || 5}).

Story context so far:
${storyContext || 'This is the beginning of the story.'}

This spread's plan:
- Scene: ${spreadPlan.illustrationPrompt || spreadPlan.illustrationDescription || spreadPlan.spread_image_prompt}
- Mood: ${spreadPlan.mood || 'warm'}

Write the text. Return ONLY the text, nothing else.`;
}

function ILLUSTRATION_PROMPT_BUILDER(scene, artStyle, childAppearance) {
  const stylePrompts = {
    watercolor: 'Beautiful watercolor children\'s book illustration with soft washes of color, gentle brushstrokes, warm palette, dreamy atmosphere.',
    digital_painting: 'Vibrant digital painting children\'s book illustration, rich colors, clean lines, professional digital art, warm lighting, friendly atmosphere.',
    storybook: 'Classic children\'s storybook illustration, warm and cozy, hand-painted feel, reminiscent of golden age picture books.',
  };

  const style = stylePrompts[artStyle] || stylePrompts.watercolor;
  let appearance = '';
  if (typeof childAppearance === 'string' && childAppearance) {
    appearance = `The main character is a young child: ${childAppearance}`;
  } else if (childAppearance && typeof childAppearance === 'object') {
    appearance = `The main character is a child with ${childAppearance.hairColor || ''} hair, ${childAppearance.skinTone || ''} skin, wearing ${childAppearance.clothing || 'colorful clothes'}.`;
  }

  return `${style} ${scene} ${appearance} Child-friendly, age-appropriate, whimsical, beautiful composition, professional quality illustration.`;
}

function VOCABULARY_CHECK_PROMPT(text, ageGroup) {
  return `Check if this text is appropriate for a ${ageGroup || 'ages 3-6'} picture book:

"${text}"

Evaluate:
1. Are all words appropriate for the age group?
2. Are sentences short enough?
3. Is the content emotionally appropriate?
4. Does it flow well when read aloud?

Respond with JSON:
{
  "approved": true/false,
  "issues": ["list of issues if any"],
  "suggestion": "improved version if not approved"
}`;
}

module.exports = {
  STORY_PLANNER_SYSTEM,
  buildStoryPlannerSystem,
  STORY_PLANNER_USER,
  TEXT_GENERATOR_SYSTEM,
  buildTextGeneratorSystem,
  TEXT_GENERATOR_USER,
  ILLUSTRATION_PROMPT_BUILDER,
  VOCABULARY_CHECK_PROMPT,
};
