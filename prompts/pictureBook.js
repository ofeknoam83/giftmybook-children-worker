/**
 * Prompt templates for picture book generation.
 *
 * V2: The story planner now uses the full V2 brief as the system prompt
 * and returns front matter + left/right spreads with text and image prompts
 * in a single LLM call.
 */

const { sanitizeForPrompt } = require('../services/validation');
const { buildV2Brief, buildWritingBrief, buildStructureBrief, buildChildContext, getAgeTier } = require('./writerBrief');

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

// ── Two-phase prompt builders (split text generation from JSON structuring) ──

/**
 * Build system prompt for the text-only story writing call.
 * @param {{ name: string, age: number, favorite_object: string, fear: string, setting: string }} vars
 * @returns {string}
 */
function buildStoryWriterSystem(vars) {
  if (typeof vars === 'number' || typeof vars === 'string') {
    return buildWritingBrief({
      name: '{name}',
      age: Number(vars) || 5,
      favorite_object: '{favorite_object}',
      fear: '{fear}',
      setting: '{setting}',
    });
  }
  return buildWritingBrief(vars);
}

/**
 * Build user prompt for the text-only story writing call.
 * @param {object} childDetails
 * @param {string} theme
 * @param {string} customDetails
 * @param {object} v2Vars - { favorite_object, fear, setting, dedication, beats, repeated_phrase, phrase_arc }
 * @returns {string}
 */
function STORY_WRITER_USER(childDetails, theme, customDetails, v2Vars = {}) {
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

  let prompt = `${childContext}

Write a personalized bedtime picture book for ${name} (age ${age}).

Child details:
- Age: ${age} (Tier ${tier})
- Gender: ${childDetails.childGender || childDetails.gender || 'not specified'}
- Interests: ${interests}
- Favorite object/toy: ${favoriteObject}
- Fear or challenge: ${fear}
- Setting: ${setting || 'use theme to determine'}
- Dedication: ${dedication}
${details ? `- Special requests / real quirks: ${details}` : ''}

Theme: ${theme || 'bedtime'}`;

  if (v2Vars.beats && Array.isArray(v2Vars.beats) && v2Vars.beats.length > 0) {
    prompt += `\n\nSTORY OUTLINE (follow this beat sheet — you may adjust wording but preserve the emotional arc):`;
    v2Vars.beats.forEach((beat, i) => {
      prompt += `\nSpread ${i + 1}: ${beat}`;
    });
  }

  if (v2Vars.repeated_phrase) {
    prompt += `\n\nREPEATED PHRASE to use: "${v2Vars.repeated_phrase}"`;
    if (v2Vars.phrase_arc && Array.isArray(v2Vars.phrase_arc)) {
      prompt += `\nPhrase evolution: ${v2Vars.phrase_arc.join(' → ')}`;
    }
  }

  prompt += `\n\nWrite the COMPLETE story as plain text (NOT JSON). Follow the output format from the system brief exactly.
- Write exactly 12 spreads with Left/Right text assignments.
- Focus entirely on literary quality. No illustration prompts needed.
- Follow ALL writing rules from the system brief (age tier, pacing, dialogue, etc.).`;

  return prompt;
}

/**
 * Build system prompt for the JSON structuring call.
 * @param {{ name: string, favorite_object: string }} vars
 * @returns {string}
 */
function buildStoryStructurerSystem(vars) {
  if (typeof vars === 'number' || typeof vars === 'string') {
    return buildStructureBrief({
      name: '{name}',
      favorite_object: '{favorite_object}',
    });
  }
  return buildStructureBrief(vars);
}

/**
 * Build user prompt for the JSON structuring call.
 * Takes the raw story text and asks the model to add illustration prompts + visual metadata.
 * @param {string} storyText - raw text output from the writing call
 * @param {object} childDetails
 * @param {object} v2Vars
 * @returns {string}
 */
function STORY_STRUCTURER_USER(storyText, childDetails, v2Vars = {}) {
  const name = sanitizeForPrompt(childDetails.childName || childDetails.name || '', 50);
  const favoriteObject = v2Vars.favorite_object || 'a stuffed bear';
  const dedication = v2Vars.dedication || `For ${name || 'the child'}`;

  return `Here is the story text to structure into JSON:

---
${storyText}
---

Child name: ${name}
Favorite object: ${favoriteObject}
Dedication: ${dedication}

Convert this story into the JSON format described in the system brief.
- PRESERVE all story text EXACTLY as written — do not rewrite or paraphrase anything.
- Add spread_image_prompt for each spread based on what the text describes.
- Define characterOutfit, characterDescription, recurringElement, and keyObjects at the top level.
- Return ONLY a valid JSON object.`;
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
  buildStoryWriterSystem,
  STORY_WRITER_USER,
  buildStoryStructurerSystem,
  STORY_STRUCTURER_USER,
  TEXT_GENERATOR_SYSTEM,
  buildTextGeneratorSystem,
  TEXT_GENERATOR_USER,
  ILLUSTRATION_PROMPT_BUILDER,
  VOCABULARY_CHECK_PROMPT,
};
