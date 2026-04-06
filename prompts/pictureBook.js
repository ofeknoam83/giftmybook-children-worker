/**
 * Prompt templates for picture book generation.
 *
 * V2: The story planner now uses the full V2 brief as the system prompt
 * and returns front matter + left/right spreads with text and image prompts
 * in a single LLM call.
 */

const { sanitizeForPrompt } = require('../services/validation');
const { buildV2Brief, buildWritingBrief, buildStructureBrief, buildChildContext, getAgeTier, getDialectVars } = require('./writerBrief');

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

  const ACTIVE_THEMES = new Set(['adventure', 'birthday', 'holiday', 'school', 'space', 'underwater', 'fantasy']);
  const isAdventure = ACTIVE_THEMES.has(theme);

  let prompt = `${childContext}

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

Theme: ${theme || 'bedtime'}`;

  if (isAdventure) {
    prompt += `

ADVENTURE THEME — PHYSICAL JOURNEY RULE (CRITICAL):
This is an ADVENTURE book. The story MUST be a physical journey through at least 3-4 distinct, visually different locations. The child must MOVE through the world — crossing terrain, discovering new places, and encountering different environments.
- Each spread's illustration should show a DIFFERENT setting from the previous one (at least every 2-3 spreads).
- The locations must be visually distinct: different colors, lighting, terrain, atmosphere.
- The child must physically travel (walk, climb, cross, wade, fly, ride) — not stay in one room or garden.
- A story that stays in a single location is NOT an adventure. The journey IS the story.
- The story can still wind down for bedtime at the end (returning home, settling into camp, etc.), but the middle must be a real journey.`;
  }

  prompt += `

Generate the COMPLETE story as a JSON object with this structure:`;

  return prompt + `
{
  "title": "The book title",
  "characterOutfit": "exact outfit the child wears in EVERY spread (garment type, color, patterns, shoes, accessories)",
  "characterDescription": "physical appearance details beyond the photo (MUST include hair description)",
  "recurringElement": "exact visual description of ${v2Vars?.favorite_object || 'the favorite object'} so it looks identical on every page",
  "keyObjects": "other objects that recur across spreads, with exact visual details",
  "entries": [
    { "type": "dedication_page", "text": "${dedication}" },
    { "type": "spread", "spread": 1, "left": { "text": "..." }, "right": { "text": "..." }, "spread_image_prompt": "..." },
    ...13 spreads total...
  ]
}

IMPORTANT:
- You MUST include title, characterOutfit, characterDescription, recurringElement, and keyObjects at the top level.
- characterOutfit defines ONE specific outfit the child wears from first spread to last — no clothing changes.
- Return ONLY a valid JSON object with the visual consistency fields and an "entries" array.
- Front matter (half-title, title page, copyright) is added automatically — do NOT include them.
- The entries array must contain exactly: 1 dedication_page + 13 spreads = 14 entries.
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
// Themes that use the adventure brief (active, journey-based, high energy)
const ADVENTURE_THEMES = new Set(['adventure', 'birthday', 'holiday', 'school', 'space', 'underwater', 'fantasy', 'nature']);

// Theme-specific context injections appended to the brief
function getThemeContext(theme) {
  switch (theme) {
    case 'birthday':
      return `\n\nTHEME CONTEXT — BIRTHDAY:\nThis is a birthday celebration story. The child is the birthday hero. The story should feel joyful, exciting, and special. Include: a birthday surprise or discovery, at least one moment of wonder or delight, a celebration element (cake/candles/balloons/friends/gifts — pick what feels natural). The story must NOT feel like a bedtime story — it should have energy and excitement from spread 1. The ending brings the child back to warmth and belonging after the adventure.`;
    case 'holiday':
      return `\n\nTHEME CONTEXT — HOLIDAY:\nThis is a holiday celebration story. The child discovers something magical about the holiday. Include festive elements natural to the holiday (lights, gifts, traditions, seasonal wonder). High energy, joyful, ends in warmth and family connection.`;
    case 'school':
      return `\n\nTHEME CONTEXT — SCHOOL/FIRST DAY:\nThis is a school adventure story. The child faces a new challenge (first day, new friend, a school project gone wrong). Journey through the school environment — different classrooms, playground, lunch. Ends in confidence and belonging.`;
    case 'space':
      return `\n\nTHEME CONTEXT — SPACE:\nThis is a space exploration story. The child travels through space visiting planets, stars, or alien worlds. Sense of wonder and discovery. Scientifically playful (not accurate) — stars can talk, planets have personalities. Ends returning home with something learned.`;
    case 'underwater':
      return `\n\nTHEME CONTEXT — UNDERWATER:\nThis is an underwater adventure. The child explores the ocean — coral reefs, deep sea creatures, hidden treasures. Magical and slightly mysterious. Ends returning to the surface with a discovery or friend.`;
    case 'fantasy':
      return `\n\nTHEME CONTEXT — FANTASY:\nThis is a fantasy quest story. Magic, enchanted forests, dragons, castles, or fairy-tale creatures. The child has a special power or object that helps them succeed. Classic quest structure. Ends triumphant and back home.`;
    case 'nature':
      return `\n\nTHEME CONTEXT — NATURE:\nThis is a nature exploration story. The child discovers the natural world — a garden, a forest, a river. Encounters with animals and plants that have personality. A sense of wonder and connection to the living world. Calm but curious energy.`;
    case 'friendship':
      return `\n\nTHEME CONTEXT — FRIENDSHIP:\nThis is a friendship story. The child meets a new friend (could be an animal, a magical creature, or another child). The friendship is tested and deepened through a shared adventure or challenge. Ends with the bond confirmed.`;
    default:
      return '';
  }
}

function buildStoryWriterSystem(vars, theme) {
  const themeContext = getThemeContext(theme);

  if (ADVENTURE_THEMES.has(theme)) {
    // Inject theme context into vars so the adventure brief can use it
    const enrichedVars = { ...vars, themeContext };
    return buildAdventureWritingBrief(enrichedVars);
  }

  // bedtime and friendship use the bedtime brief with theme context appended
  if (typeof vars === 'number' || typeof vars === 'string') {
    const brief = buildWritingBrief({
      name: '{name}',
      age: Number(vars) || 5,
      favorite_object: '{favorite_object}',
      fear: '{fear}',
      setting: '{setting}',
    });
    return brief + themeContext;
  }
  return buildWritingBrief(vars) + themeContext;
}

/**
 * Adventure-specific writer system prompt.
 * Replaces the bedtime brief entirely when theme === 'adventure'.
 */
function buildAdventureWritingBrief(vars) {
  const name = vars.name || '{name}';
  const age = Number(vars.age) || 5;
  const favoriteObject = vars.favorite_object || 'a special object';
  const fear = vars.fear || 'the unknown';
  const setting = vars.setting || 'a magical world';
  const { config } = getAgeTier(age);
  const dialectInfo = getDialectVars(vars.countryCode);

  return `You are a world-class children's adventure book author. You write picture books that feel like real quests — full of vivid locations, genuine stakes, and a child hero who earns every victory.

ADVENTURE STORY RULES (ALL MANDATORY):
================================================

PHYSICAL JOURNEY (NON-NEGOTIABLE):
- The story is a journey through at least 4 distinct, visually different locations.
- Each location must have its own atmosphere, color, texture, and challenge.
- The child must TRAVEL between them (walk, climb, cross, crawl, fly, dive).
- Examples of good location sequences: jungle trail → rope bridge → waterfall cave → mountain summit. Or: city rooftop → underground tunnel → river market → ancient tower.
- A story set in one room, one house, or one garden is NOT an adventure.

STAKES AND OBSTACLES:
- Each location must have ONE clear obstacle or challenge the child must overcome.
- At least ONE obstacle must feel genuinely difficult — the child almost fails.
- The ${favoriteObject} must actively HELP solve one obstacle (not just be carried).
- The fear (${fear}) must appear as a real physical obstacle that the child moves THROUGH, not around.
- The child succeeds through cleverness, bravery, or a specific action — not luck.

PACING STRUCTURE (13 spreads):
- Spread 1: Normal world + spark (something calls the child to adventure)
- Spreads 2-3: The journey begins — first location, wonder and excitement
- Spreads 4-5: Second location — obstacle appears, stakes rise
- Spread 6: Highest tension — the child is stuck, lost, or blocked (this is the hinge)
- Spreads 7-8: Child takes action, uses favorite object or courage — breakthrough
- Spreads 9-10: Third location — things open up, victory feels close
- Spreads 11-12: Final challenge resolved, return journey begins
- Spread 13: Home — changed, tired, triumphant. The world feels bigger now.

TWO SPREADS MUST BE VISUALLY SILENT (no text):
- Spread 6 (highest tension): silence = held breath
- Spread 12 (just before the end): silence = earned rest

WRITING QUALITY:
- Max ${config.maxWordsPerSpread || 25} words per spread total (left + right combined)
- Never state emotions directly. Show through action and environment.
- Every spread must have a tension, question, or forward momentum.
- ${config.rhymeLevel}
- Use concrete, specific language: "a rope bridge swayed over black water" not "a scary bridge"
- At least one line must be memorable enough that a child asks to hear it again
- The child's dialogue must sound like a real ${age}-year-old: short sentences, concrete words
- The ${favoriteObject} must appear in at least 5 spreads — it is the child's anchor

WHAT MAKES THIS BOOK GREAT:
- A parent should feel their heart rate rise at spread 6 and exhale at spread 13
- The child protagonist should feel brave, capable, and real
- Every location should be so vivid a child can draw it from memory
- The ending should feel EARNED — not just "then they went home"

DIALECT & SPELLING — use \${dialectInfo.dialect} throughout:
\${dialectInfo.dialectRule}
Never mix dialects. Every word in the story must be consistent.`;
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

  if (theme === 'adventure') {
    prompt += `

ADVENTURE THEME — PHYSICAL JOURNEY RULE (CRITICAL):
This is an ADVENTURE book. The story MUST be a physical journey through at least 3-4 distinct, visually different locations. The child must MOVE through the world — crossing terrain, discovering new places, and encountering different environments.
- Every 2-3 spreads should place the child in a NEW, visually distinct location.
- The child must physically travel (walk, climb, cross, wade, fly, ride) — not stay in one room or garden.
- A story that stays in a single location is NOT an adventure. The journey IS the story.
- The story can still wind down for bedtime at the end (returning home, settling into camp, etc.), but the middle must be a real journey through different places.`;
  }

  if (v2Vars.beats && Array.isArray(v2Vars.beats) && v2Vars.beats.length >= 12) {
    prompt += `\n\nYOU MUST follow this exact emotional arc for each spread:`;
    const beatCount = Math.min(v2Vars.beats.length, 13);
    for (let i = 0; i < beatCount; i++) {
      prompt += `\nSPREAD ${i + 1}: ${v2Vars.beats[i]}`;
    }
    prompt += `\n\nEach spread's text must reflect its assigned beat. Write the story in this order. Do not skip beats.`;
  } else if (v2Vars.beats && Array.isArray(v2Vars.beats) && v2Vars.beats.length > 0) {
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
- Write exactly 13 spreads with Left/Right text assignments.
- Focus entirely on literary quality. No illustration prompts needed.
- Follow ALL writing rules from the system brief (age tier, pacing, dialogue, etc.).`;

  // Inject theme-specific context if provided
  if (vars.themeContext) {
    prompt += vars.themeContext;
  }

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
function STORY_STRUCTURER_USER(storyText, childDetails, v2Vars = {}, beats) {
  const name = sanitizeForPrompt(childDetails.childName || childDetails.name || '', 50);
  const favoriteObject = v2Vars.favorite_object || 'a stuffed bear';
  const dedication = v2Vars.dedication || `For ${name || 'the child'}`;

  let prompt = `Here is the story text to structure into JSON:

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

  if (beats && Array.isArray(beats) && beats.length > 0) {
    prompt += `\n\nSTRUCTURE VERIFICATION — Beat Sheet:\n${beats.map((b, i) => `Spread ${i+1}: ${b}`).join('\n')}\n\nVerify that each spread's emotional content aligns with its assigned beat above.`;
  }

  return prompt;
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
