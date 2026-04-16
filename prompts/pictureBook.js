/**
 * Prompt templates for picture book generation.
 *
 * V2: The story planner now uses the full V2 brief as the system prompt
 * and returns front matter + left/right spreads with text and image prompts
 * in a single LLM call.
 */

const { sanitizeForPrompt } = require('../services/validation');
const { buildV2Brief, buildWritingBrief, buildStructureBrief, buildChildContext, getAgeTier, getDialectVars, getEmotionalAgeTier } = require('./writerBrief');
const { getPronounInfo, buildPronounInstruction } = require('../services/pronouns');

const EMOTIONAL_THEMES = new Set(['anxiety', 'anger', 'fear', 'grief', 'loneliness', 'new_beginnings', 'self_worth', 'family_change']);

const COPING_STRATEGIES = {
  anxiety: { name: 'Worry Externalizing', description: 'The worry becomes a visible, nameable presence — something the child can talk to and set aside' },
  anger: { name: 'Body Sensation Awareness', description: 'The child learns to notice the physical signs of anger rising — heat, tight chest, clenched hands — as a signal to pause' },
  fear: { name: 'Brave Ladder', description: 'One micro-step toward the feared thing, celebrated as genuine courage regardless of outcome' },
  grief: { name: 'Memory Ritual', description: 'A tangible action the child can take to stay connected to who or what was lost' },
  loneliness: { name: 'One Act of Noticing', description: 'The child notices one person, and is noticed by one person — the ripple of connection starts small' },
  new_beginnings: { name: 'Finding the Familiar', description: 'Identifying one anchor of familiarity inside the new situation' },
  self_worth: { name: 'Inherent Value Reframe', description: 'Separating worth from achievement — the child is seen and valued for who they are, not what they do' },
  family_change: { name: 'Love as Constant', description: 'Naming what has NOT changed — the love from the people who matter most' },
};

function getEmotionalWritingRules(emotion, situation, parentGoal, copingResourceHint, age) {
  const { tier, config } = getEmotionalAgeTier(age);
  const strategy = COPING_STRATEGIES[emotion];

  let rules = `\n\n\u26a0\ufe0f EMOTIONAL DEVELOPMENT BOOK \u2014 TIER ${tier} (Age ${age}) \u2014 CRITICAL RULES:\n`;
  rules += `Writing tier: ${config.label}\n`;
  rules += `Max words per spread: ${config.maxWordsPerSpread}\n`;
  rules += `Sentences per spread: ${config.sentencesPerSpread}\n`;
  rules += `Vocabulary: ${config.vocabulary}\n`;
  rules += `Dialogue: ${config.dialogue}\n\n`;

  // Tier-specific tone
  if (tier === 'E1') {
    rules += `TIER E1 RULES \u2014 TODDLER:\n`;
    rules += `- Body sensations ONLY. Never name the cause of the emotion.\n`;
    rules += `- No coping strategy. This is a comfort book \u2014 recognition + rhythm.\n`;
    rules += `- Every spread: rhyming couplets. Musical, short, simple.\n`;
    rules += `- The emotion softens but does NOT resolve.\n`;
    rules += `- Last line must be something a parent can say out loud.\n`;
  } else if (tier === 'E2') {
    rules += `TIER E2 RULES \u2014 PICTURE BOOK:\n`;
    rules += `COPING STRATEGY TO EMBED (${strategy?.name}):\n${strategy?.description}\n`;
    rules += `- Strategy appears in Acts 5-6. It feels like the character's natural response.\n`;
    rules += `- Last spread: one usable phrase the parent can say in real moments.\n`;
    rules += `- Never dismiss, minimize, or rush past the Stuck phase.\n`;
  } else if (tier === 'E3') {
    rules += `TIER E3 RULES \u2014 ILLUSTRATED STORY:\n`;
    rules += `- Interior monologue in italics (the child's unspoken thoughts).\n`;
    rules += `- Secondary character has their own perspective \u2014 not just a helper.\n`;
    rules += `COPING STRATEGY (${strategy?.name}): ${strategy?.description}\n`;
    rules += `- Strategy used and practiced across spreads 12-13. Imperfect but genuine.\n`;
    if (copingResourceHint) rules += `- Parent says this helps: "${copingResourceHint}" \u2014 weave it in.\n`;
    rules += `- Spread 18 ends with 3 reflection questions for the reader.\n`;
    rules += `  Format: "What did you feel when...?" "Have you ever...?" "What would you do if...?"\n`;
  } else if (tier === 'E4') {
    rules += `TIER E4 RULES \u2014 STORY + REFLECTION:\n`;
    rules += `- Full literary prose. Unreliable narrator permitted.\n`;
    rules += `- The emotion may NOT be fully resolved. Ambiguity is allowed and honest.\n`;
    rules += `COPING STRATEGY (${strategy?.name}): ${strategy?.description}\n`;
    rules += `- Spread 19 MUST BE: A structured reflection page with exactly 3 prompts + "write your thoughts here" space.\n`;
    rules += `- Spread 20 MUST BE: A note to the adult reading this. Explain the emotional arc used and suggest how to continue the conversation.\n`;
    if (copingResourceHint) rules += `- Parent says this helps: "${copingResourceHint}" \u2014 weave it in.\n`;
  }

  // Universal rules for all tiers
  rules += `\nUNIVERSAL RULES:\n`;
  rules += `- Never promise the emotion will go away\n`;
  rules += `- Never make the resolution too fast\n`;
  rules += `- Never patronize or talk down to the child's experience\n`;
  rules += `- ${config.coachingNote}\n`;

  if (situation) {
    rules += `\nSITUATION: "${situation}" \u2014 Every scene must be grounded in THIS.\n`;
  }

  if (parentGoal) {
    const goalMap = {
      conversation: 'GOAL: Open a conversation \u2014 give the child language to bring back to their parent.',
      validate: 'GOAL: Validate \u2014 the child must finish feeling seen and not alone, above all else.',
      tool: 'GOAL: Give a tool \u2014 the coping strategy must be concrete, named, and repeatable.',
    };
    rules += `\n${goalMap[parentGoal] || ''}\n`;
  }

  return rules;
}

/**
 * Build system prompt for V2 story planner.
 * Uses the full V2 brief with variables substituted.
 *
 * @param {{ name: string, age: number, favorite_object: string, fear: string, setting: string, dedication: string }} vars
 * @returns {string}
 */
function buildStoryPlannerSystem(vars, additionalCoverCharacters = null, theme = null) {
  // Accept either a vars object (V2) or a bare age number (legacy compat)
  let brief;
  if (typeof vars === 'number' || typeof vars === 'string') {
    brief = buildV2Brief({
      name: '{name}',
      age: Number(vars) || 5,
      favorite_object: '{favorite_object}',
      fear: '{fear}',
      setting: '{setting}',
      dedication: '{dedication}',
    });
  } else {
    brief = buildV2Brief(vars);
  }

  // Override the family member rule based on theme and secondary character detection
  if (theme === 'mothers_day') {
    if (additionalCoverCharacters) {
      // Both Mom AND a detected secondary person are allowed in illustrations
      const combinedOverride = `MOTHER'S DAY — MOM AS VISIBLE CHARACTER + SECONDARY CHARACTERS:
Mom is a co-protagonist in this story. She MUST appear in illustration prompts for at least 6 of 13 spreads.
When writing spread_image_prompt fields that include Mom, describe her presence explicitly:
- Her position relative to the child (kneeling beside, standing behind, sitting together)
- Her gesture or action (hugging, pointing, laughing, holding hands)
- A warm, generic appearance if no specific description is available (e.g. "a warm-smiled woman with gentle eyes")
ADDITIONALLY, the uploaded photo contains a secondary person:
${additionalCoverCharacters}
CRITICAL: Their appearance must be CONSISTENT across all illustrations. Only Mom and the secondary character(s) listed above are allowed in illustrations — do NOT invent any other family members.`;

      brief = brief.replace(
        /FAMILY MEMBERS — TEXT vs\. ILLUSTRATIONS \(CRITICAL\):[\s\S]*?(?=\n[A-Z]|\n-{5,})/,
        combinedOverride + '\n'
      );
      brief = brief.replace(
        /- NEVER depict family members \(parents, siblings, grandparents\) in any illustration prompt\.[^\n]*/,
        `- Mom and the secondary character(s) listed above MAY appear in illustration prompts. Describe each consistently every time. Do NOT invent other family members not listed.`
      );
    } else {
      // For Mother's Day WITHOUT a cover parent: Mom is in the STORY TEXT but shown via implied presence in illustrations
      const motherImpliedOverride = `MOTHER'S DAY — MOM IN STORY, IMPLIED PRESENCE IN ILLUSTRATIONS:
Mom is a co-protagonist in the story TEXT — she speaks, acts, and is central to the narrative.
However, because we have NO reference image for Mom, her face must NEVER be shown in illustrations.

ILLUSTRATION RULES FOR MOM (CRITICAL):
- Mom MUST appear physically present in at least 6 of 13 spread_image_prompt fields — she is REAL, not invisible.
- But ALWAYS describe her with HIDDEN FACE: show her from behind, from the side with face turned away, as hands reaching in from frame edge, kneeling with face cropped out, back view hugging the child, silhouette, or partially out of frame.
- NEVER write "a warm-smiled woman" or describe Mom's facial features in spread_image_prompt fields.
- DO describe: her hands, her arms around the child, her back, her hair from behind, her silhouette, her posture.
- The child's face is always fully visible. Mom's warmth comes through her ACTIONS and BODY LANGUAGE, not her face.
- Examples of good spread_image_prompt Mom descriptions:
  "Mom's hands gently holding Logan's small hands over a mixing bowl"
  "Logan sitting in Mom's lap, we see Mom from behind, her arms wrapped around Logan"
  "Mom kneeling beside Logan, her face turned away, pointing at something in the distance"
  "A warm pair of hands reaching into frame to straighten Logan's collar"
Other family members (siblings, grandparents, dad) still follow the standard rule — text only, never illustrated.`;

      brief = brief.replace(
        /FAMILY MEMBERS — TEXT vs\. ILLUSTRATIONS \(CRITICAL\):[\s\S]*?(?=\n[A-Z]|\n-{5,})/,
        motherImpliedOverride + '\n'
      );
      brief = brief.replace(
        /- NEVER depict family members \(parents, siblings, grandparents\) in any illustration prompt\.[^\n]*/,
        `- Mom MUST appear in illustration prompts but with HIDDEN FACE (back view, hands, silhouette, side view with face turned away). She is physically present but we have no face reference. Other family members must NOT appear in illustrations.`
      );
    }
  } else if (theme === 'fathers_day') {
    if (additionalCoverCharacters) {
      const combinedOverride = `FATHER'S DAY — DAD AS VISIBLE CHARACTER + SECONDARY CHARACTERS:
Dad is a co-protagonist in this story. He MUST appear in illustration prompts for at least 6 of 13 spreads.
When writing spread_image_prompt fields that include Dad, describe his presence explicitly:
- His position relative to the child (kneeling beside, standing behind, sitting together)
- His gesture or action (hugging, pointing, laughing, holding hands, carrying)
- A warm, generic appearance if no specific description is available (e.g. "a warm-smiled man with kind eyes")
ADDITIONALLY, the uploaded photo contains a secondary person:
${additionalCoverCharacters}
CRITICAL: Their appearance must be CONSISTENT across all illustrations. Only Dad and the secondary character(s) listed above are allowed in illustrations — do NOT invent any other family members.`;

      brief = brief.replace(
        /FAMILY MEMBERS — TEXT vs\. ILLUSTRATIONS \(CRITICAL\):[\s\S]*?(?=\n[A-Z]|\n-{5,})/,
        combinedOverride + '\n'
      );
      brief = brief.replace(
        /- NEVER depict family members \(parents, siblings, grandparents\) in any illustration prompt\.[^\n]*/,
        `- Dad and the secondary character(s) listed above MAY appear in illustration prompts. Describe each consistently every time. Do NOT invent other family members not listed.`
      );
    } else {
      // For Father's Day WITHOUT a cover parent: Dad is in the STORY TEXT but shown via implied presence in illustrations
      const fatherImpliedOverride = `FATHER'S DAY — DAD IN STORY, IMPLIED PRESENCE IN ILLUSTRATIONS:
Dad is a co-protagonist in the story TEXT — he speaks, acts, and is central to the narrative.
However, because we have NO reference image for Dad, his face must NEVER be shown in illustrations.

ILLUSTRATION RULES FOR DAD (CRITICAL):
- Dad MUST appear physically present in at least 6 of 13 spread_image_prompt fields — he is REAL, not invisible.
- But ALWAYS describe him with HIDDEN FACE: show him from behind, from the side with face turned away, as hands reaching in from frame edge, kneeling with face cropped out, back view hugging the child, silhouette, or partially out of frame.
- NEVER write "a warm-smiled man" or describe Dad's facial features in spread_image_prompt fields.
- DO describe: his hands, his arms around the child, his back, his hair from behind, his silhouette, his posture.
- The child's face is always fully visible. Dad's warmth comes through his ACTIONS and BODY LANGUAGE, not his face.
- Examples of good spread_image_prompt Dad descriptions:
  "Dad's large hands steadying Logan on the bicycle seat"
  "Logan riding on Dad's shoulders, we see Dad from behind, walking down a sunlit path"
  "Dad kneeling beside Logan, his face turned away, pointing at something in the sky"
  "A strong pair of hands reaching into frame to help Logan up"
Other family members (siblings, grandparents, mom) still follow the standard rule — text only, never illustrated.`;

      brief = brief.replace(
        /FAMILY MEMBERS — TEXT vs\. ILLUSTRATIONS \(CRITICAL\):[\s\S]*?(?=\n[A-Z]|\n-{5,})/,
        fatherImpliedOverride + '\n'
      );
      brief = brief.replace(
        /- NEVER depict family members \(parents, siblings, grandparents\) in any illustration prompt\.[^\n]*/,
        `- Dad MUST appear in illustration prompts but with HIDDEN FACE (back view, hands, silhouette, side view with face turned away). He is physically present but we have no face reference. Other family members must NOT appear in illustrations.`
      );
    }
  } else if (additionalCoverCharacters) {
    // Non-parent-theme: override for secondary characters detected in the photo
    const familyOverride = `SECONDARY CHARACTERS (from the uploaded photo):
The uploaded photo contains more than one person. The following secondary character(s) appear on the cover and MAY appear in illustrations. Include them naturally in the story where appropriate.
${additionalCoverCharacters}
CRITICAL: Their appearance must be CONSISTENT across all illustrations — same hair, same skin, same build, same clothing style. Write their presence into illustration prompts just as you do for the child. They are LOCKED to the reference photo.
Do NOT invent other family members beyond what is listed above.`;

    // Replace the static family rule with the override
    brief = brief.replace(
      /FAMILY MEMBERS — TEXT vs\. ILLUSTRATIONS \(CRITICAL\):[\s\S]*?(?=\n[A-Z]|\n-{5,})/,
      familyOverride + '\n'
    );
    // Also replace the illustration prompt rule about never depicting family
    brief = brief.replace(
      /- NEVER depict family members \(parents, siblings, grandparents\) in any illustration prompt\.[^\n]*/,
      `- The secondary character(s) listed above MAY appear in illustration prompts. Describe them consistently every time. Do NOT invent other family members not listed.`
    );
  }

  return brief;
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
function STORY_PLANNER_USER(childDetails, theme, customDetails, v2Vars = {}, additionalCoverCharacters = null) {
  const name = sanitizeForPrompt(childDetails.childName || childDetails.name || '', 50);
  const age = childDetails.childAge || childDetails.age || 5;
  const interests = (childDetails.childInterests || childDetails.interests || []).map(i => sanitizeForPrompt(i, 50)).join(', ') || 'general';
  const details = customDetails ? sanitizeForPrompt(customDetails, 500) : '';
  const childContext = buildChildContext(childDetails, details);

  const { tier } = getAgeTier(age);

  const favoriteObject = v2Vars.favorite_object || 'a favorite toy';
  const fear = v2Vars.fear || 'the dark';
  const setting = v2Vars.setting || '';
  const dedication = v2Vars.dedication || `For ${name || 'the child'}`;

  const ACTIVE_THEMES = new Set(['adventure', 'birthday', 'holiday', 'school', 'space', 'underwater', 'fantasy']);
  const isAdventure = ACTIVE_THEMES.has(theme);

  const gender = childDetails.childGender || childDetails.gender || 'not specified';
  const pronouns = getPronounInfo(gender);
  const pronounInstruction = buildPronounInstruction(name, gender);

  let prompt = `${childContext}

Create a personalized bedtime picture book for ${name} (age ${age}).

Child details:
- Age: ${age} (Tier ${tier})
- Gender: ${gender} (${pronouns.pair} pronouns)
- Interests: ${interests}
- Favorite object/toy: ${favoriteObject}
- Fear or challenge: ${fear}
- Setting: ${setting || 'use theme to determine'}
- Dedication: ${dedication}
${details ? `- Special requests / real quirks: ${details}` : ''}
${pronounInstruction ? `\n${pronounInstruction}` : ''}
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

  if (details && details.trim()) {
    prompt += `\n\n\u26a0\ufe0f MANDATORY PERSONALIZATION — THE PARENT WROTE THIS ABOUT THEIR CHILD:\n"${details.trim()}"\nEvery specific person, place, object, or quirk mentioned here MUST appear concretely in the story — not as vague inspiration, but as actual named elements. If a grandparent is mentioned, they appear (voice/presence, not illustrated). If a pet is named, it appears. If a real place is named, the child goes there.`;
  }

  const plannerSpreadTarget = (EMOTIONAL_THEMES.has(theme) && v2Vars?.emotionalSpreads)
    ? v2Vars.emotionalSpreads
    : 13;

  if (additionalCoverCharacters) {
    prompt += `\n\n⚠️ SECONDARY CHARACTER ON COVER: The uploaded photo includes a secondary person. Their appearance:\n${additionalCoverCharacters}\nWhen you write spread_image_prompt fields, you MAY include this person naturally in scenes. Describe them consistently every time they appear — same hair, skin, build. Add "secondaryCharacterDescription" to the top-level JSON with their full appearance for illustration locking.`;
  }

  if (v2Vars.isMultipleGifters && v2Vars.gifterNames?.length > 1) {
    prompt += `\n\nMULTIPLE GIFTERS — DEDICATION PAGE ONLY:\nThis book is a gift from ${v2Vars.gifterNames.join(' and ')}.\nTheir names belong ONLY on the dedication page: "${dedication}"\nDo NOT mention gifter names in the story text unless they are also named characters in the child's daily life (e.g., "Mom", "Dad", "Grandma Sara"). Random first names appearing in the story without context confuses readers.\nDo NOT add gifters to illustration prompts.`;
  } else if (!v2Vars.isMultipleGifters && v2Vars.gifterNames?.length === 1) {
    prompt += `\n\nSINGLE GIFTER — DEDICATION PAGE ONLY:\nThis book is a gift from ${v2Vars.gifterNames[0]}.\nTheir name belongs ONLY on the dedication page: "${dedication}"\nDo NOT mention this gifter's name in the story text unless they are also a named character in the child's daily life (e.g., "Mom", "Dad", "Grandma Sara"). Random first names appearing in the story without context confuses readers.`;
  }

  prompt += `

Generate the COMPLETE story as a JSON object with this structure:`;

  const secondaryCharField = additionalCoverCharacters
    ? `\n  "secondaryCharacterDescription": "appearance of secondary person from the photo — hair, skin, build — written so illustrations stay consistent",`
    : '';

  const { PARENT_THEMES } = require('../services/illustrationGenerator');
  const needsParentOutfit = !additionalCoverCharacters && PARENT_THEMES.has(theme);
  const parentOutfitField = needsParentOutfit
    ? `\n  "parentOutfit": "EXACT outfit the parent wears in EVERY spread — LOCKED, no changes. Must include: top garment + color, bottom garment + color, shoe type + color. Example: 'soft cream cable-knit sweater, dark blue jeans, brown leather ankle boots'. Pick a warm, parent-appropriate outfit that fits the story setting.",`
    : '';

  return prompt + `
{
  "title": "The book title (MUST include the child's name and reference something specific to THIS story — see TITLE RULES)",
  "characterOutfit": "EXACT outfit the child wears in EVERY spread with NO changes. Must include ALL of: (1) top garment type + exact color + any pattern/logo, (2) bottom garment type + exact color, (3) shoe type + exact color, (4) any accessories or 'none'. Example: 'red short-sleeve t-shirt with a small yellow star on the chest, blue denim shorts, white canvas sneakers with green laces, no hat, no accessories'. This outfit is LOCKED — it must not change on any spread.",
  "characterDescription": "physical appearance details beyond the photo (MUST include hair description)",${secondaryCharField}${parentOutfitField}
  "recurringElement": "exact visual description of ${v2Vars?.favorite_object || 'the favorite object'} so it looks identical on every page",
  "keyObjects": "other objects that recur across spreads, with exact visual details",
  "entries": [
    { "type": "dedication_page", "text": "${dedication}" },
    { "type": "spread", "spread": 1, "left": { "text": "..." }, "right": { "text": "..." }, "spread_image_prompt": "..." },
    ...${plannerSpreadTarget} spreads total...
  ]
}

IMPORTANT:
- You MUST include title, characterOutfit, characterDescription, recurringElement, and keyObjects at the top level.
- characterOutfit defines ONE specific outfit the child wears from first spread to last — no clothing changes.
- Return ONLY a valid JSON object with the visual consistency fields and an "entries" array.
- Front matter (half-title, title page, copyright) is added automatically — do NOT include them.
- The entries array must contain exactly: 1 dedication_page + ${plannerSpreadTarget} spreads = ${plannerSpreadTarget + 1} entries.
- Each spread must have spread_image_prompt — ONE CONTINUOUS PANORAMIC SCENE (wide landscape, like a movie still). Describe a single unified scene, NOT separate left-side and right-side content. Do NOT split the composition into two halves.
- CHARACTER POSITION: The child MUST be in the left third or right third of the scene — NOT at the horizontal center. Never describe the child as standing in the middle. The center of the panorama is reserved for environment, depth, or secondary elements.
- Do NOT re-describe the outfit in spread_image_prompt — it is defined once at the top level.
- Every spread MUST have text in at least one of left.text or right.text — null text is not allowed.
- All image prompts must specify: lighting, color palette, perspective, one texture detail.
- Do NOT specify art medium or style in image prompts — that is handled separately by the illustration engine.
- Follow ALL rules from the system brief (age tier, pacing, dialogue, etc.).
- No newlines inside string values. Use apostrophes directly in strings (no escaping needed).
- TITLE RULES: The title MUST include the child's name and reference something specific to THIS story (the quest, setting, repeated phrase, or favorite object). 3-8 words max. REJECT generic titles like "[Name]'s Adventure" or "A Magical Journey" — the title must be ownable to THIS child and THIS story.`;
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
      return `\n\nTHEME CONTEXT — BIRTHDAY:\nThis is a birthday celebration story. The child is the birthday hero. Every single spread must feel soaked in birthday — the decorations, the friends, the cake smells, the streamers, the anticipation. This is not an adventure that happens to end at a cake. The birthday IS the story, from the first page to the last.\n\nBIRTHDAY SATURATION RULE: Include specific birthday details in EVERY spread — different ones each time so the celebration builds and accumulates. Balloons, banners, gifts being wrapped, candles being counted, friends arriving, singing warming up in another room. By spread 12 the reader must feel completely surrounded by birthday.\n\nBIRTHDAY ENDING OVERRIDE: The generic ending rules do NOT apply. Instead:\n- The child's specific age must be woven through the story. In at least 3 spreads, reflect what turning this age MEANS — something new they can now do, a milestone, something they understand that they didn't before. The age is the emotional spine.\n- Spread 12: the lights dim, someone carries something in, the room holds its breath. One line that makes the reader's heart lift.\n- Spread 13: the birthday cake arrives, glowing. This is the moment the ENTIRE story has been building toward — warm, joyful, triumphant.\n- The ending must feel like the best moment of the best day — not sleepy, not whispered, not quiet.`;
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
    case 'mothers_day':
      return `\n\nTHEME CONTEXT — MOTHER'S DAY:\nThis is a love letter from a child to their mother. Mom is a NAMED, VISIBLE co-protagonist — she appears alongside the child in at least 6 of 13 spreads. The story is told from the child's perspective: gratitude, love, and a desire to show Mom how special she is. The arc moves from everyday shared moments to a heartfelt gesture of love. Mom must be described consistently in every illustration prompt where she appears. The ending is warm, tender, and emotionally resonant — it should make a mother cry happy tears.\n\nMOM IN ILLUSTRATIONS (CRITICAL): Mom is allowed — and required — in illustration prompts for this theme. Describe her presence explicitly when she appears (position, gesture, expression). If a specific appearance description is available from the cover, use it consistently. If not, describe her generically but warmly (e.g. "Mom, a warm-smiled woman with gentle eyes"). Do NOT apply the "never depict family members" rule to Mom in this theme.`;
    case 'fathers_day':
      return `\n\nTHEME CONTEXT — FATHER'S DAY:\nThis is a love letter from a child to their father. Dad is a NAMED, VISIBLE co-protagonist — he appears alongside the child in at least 6 of 13 spreads. The story is told from the child's perspective: gratitude, love, and admiration for Dad. The arc moves from everyday shared moments (playing, building, exploring) to a heartfelt gesture of love. Dad must be described consistently in every illustration prompt where he appears. The ending is warm, tender, and emotionally resonant — it should make a father's eyes water.\n\nDAD IN ILLUSTRATIONS (CRITICAL): Dad is allowed — and required — in illustration prompts for this theme. Describe his presence explicitly when he appears (position, gesture, expression). If a specific appearance description is available from the cover, use it consistently. If not, describe him generically but warmly (e.g. "Dad, a warm-smiled man with kind eyes"). Do NOT apply the "never depict family members" rule to Dad in this theme.`;
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

WRITING QUALITY:
- Max ${config.maxWordsPerSpread || 25} words per spread total (left + right combined)
- Never state emotions directly. Show through action and environment.
- Every spread must have a tension, question, or forward momentum.
- ${config.rhymeLevel}
- Use concrete, specific language: "a rope bridge swayed over black water" not "a scary bridge"
- At least one line must be memorable enough that a child asks to hear it again
- The child's dialogue must sound like a real ${age}-year-old: short sentences, concrete words
- The ${favoriteObject} must appear in at least 5 spreads — it is the child's anchor

PERSONAL DETAIL INTEGRATION (MANDATORY):
You are given personal details about the child and their world. Transform them into natural story elements:
- Convert interests into SKILLS the child uses during the adventure (e.g. "loves dinosaurs" → the child recognizes a fossil that others missed)
- Convert real places into SETTINGS or destinations on the journey
- Convert real people into characters who HELP or INSPIRE (mentioned in text, not illustrated unless specifically allowed)
- Convert quirks or habits into CHARACTER MOMENTS that feel true to this specific child

INTEGRATION QUALITY RULES:
- Never force a detail where it breaks the story's flow. If "loves pizza" doesn't fit a space adventure naturally, reference it once in a small, genuine moment (packing a snack) — don't build a pizza planet.
- Each detail should serve the STORY, not just prove you read the input. Ask: "Would this detail exist in this scene if the story demanded it?" If no, find a better scene for it.
- It is better to integrate 2-3 details beautifully than to cram all details in awkwardly.
- The reader should feel "this story was written FOR this child" — not "these details were inserted INTO a story."

WHAT MAKES THIS BOOK GREAT:
- A parent should feel their heart rate rise at spread 6 and exhale at spread 13
- The child protagonist should feel brave, capable, and real
- Every location should be so vivid a child can draw it from memory
- The ending should feel EARNED — not just "then they went home"

PRONOUN CONSISTENCY (CRITICAL):
When the child's gender and pronouns are specified, use ONLY the correct pronouns throughout the entire story. Never switch pronouns mid-story. Pay special attention to gender-ambiguous names — always follow the declared pronouns regardless of the name.

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

  const favoriteObject = v2Vars.favorite_object || 'a favorite toy';
  const fear = v2Vars.fear || 'the dark';
  const setting = v2Vars.setting || '';
  const dedication = v2Vars.dedication || `For ${name || 'the child'}`;

  const gender = childDetails.childGender || childDetails.gender || 'not specified';
  const pronouns = getPronounInfo(gender);
  const pronounInstruction = buildPronounInstruction(name, gender);

  let prompt = `${childContext}

Write a personalized bedtime picture book for ${name} (age ${age}).

Child details:
- Age: ${age} (Tier ${tier})
- Gender: ${gender} (${pronouns.pair} pronouns)
- Interests: ${interests}
- Favorite object/toy: ${favoriteObject}
- Fear or challenge: ${fear}
- Setting: ${setting || 'use theme to determine'}
- Dedication: ${dedication}
${details ? `- Special requests / real quirks: ${details}` : ''}
${pronounInstruction ? `\n${pronounInstruction}` : ''}
Theme: ${theme || 'bedtime'}

When weaving the child's interests into the story, include at least one clearly recognizable mention (name, visual, or unmistakable motif) alongside any playful puns or allusions, so personalization is legible to both parents and downstream illustration systems.`;

  // Theme-specific structural rules
  const themeJourneyRules = {
    adventure: `\n\nADVENTURE THEME — PHYSICAL JOURNEY RULE (CRITICAL):\nThis is an ADVENTURE book. The story MUST be a physical journey through at least 3-4 distinct, visually different locations. The child must MOVE through the world — crossing terrain, discovering new places, encountering different environments.\n- Every 2-3 spreads places the child in a NEW, visually distinct location.\n- The child physically travels (walk, climb, cross, wade, fly, ride) — not stay in one room or garden.\n- A story that stays in a single location is NOT an adventure.`,
    birthday: `\n\nBIRTHDAY THEME — CELEBRATION ARC (CRITICAL):\nThis is a BIRTHDAY story. The entire story builds toward ONE moment: the child blowing out the candles on their birthday cake (spread 13).\n- The child is the birthday hero — this is THEIR day.\n- Include a birthday quest, surprise, or discovery that drives the plot.\n- There must be a celebration PEAK moment (spreads 9-10): wonder, joy, something unforgettable.\n- The story must NOT feel like a generic bedtime story — it has momentum and excitement.\n- Spread 12 is the HELD BREATH — the room hushes, everyone gathers, the lights dim. One quiet line. The reader knows what is coming.\n- Spread 13 is the RELEASE — the cake arrives, candles are lit, the child leans in and blows. This is the emotional resolution of the whole journey.\n- The repeated phrase should feel celebratory in its final appearance.\n- The child's favorite object should be present in the final scene.\n- IGNORE the generic ending rules and "whisper" ending rules. Birthday endings are warm, joyful, and triumphant.`,
    holiday: `\n\nHOLIDAY THEME — FESTIVE MAGIC ARC (CRITICAL):\nThis is a HOLIDAY story. Festive magic must be present from spread 1.\n- The child discovers or delivers something magical connected to the holiday.\n- Include at least 3 visually distinct festive locations.\n- The emotional peak is connection and belonging — the holiday feeling fulfilled.\n- High energy through middle spreads, warm and cozy at the end.`,
    school: `\n\nSCHOOL THEME — BELONGING ARC (CRITICAL):\nThis is a SCHOOL ADVENTURE story.\n- At least 3 distinct school locations (classroom, playground, hallway, cafeteria, gym — pick specific ones).\n- The child faces a real social or emotional challenge (being new, making a mistake, feeling excluded).\n- The story ends in confidence and belonging — the child has EARNED their place.\n- Avoid generic "first day goes fine" stories. There must be a real hinge moment.`,
    space: `\n\nSPACE THEME — COSMIC JOURNEY RULE (CRITICAL):\nThis is a SPACE EXPLORATION story.\n- At least 3 different cosmic settings: a colorful planet, a star-field, a nebula, a moon — each visually unique.\n- The cosmos is playful, not scientifically accurate — stars can speak, planets have personalities.\n- The child discovers something no one has seen before.\n- The ending returns them home, carrying the universe inside.`,
    underwater: `\n\nUNDERWATER THEME — OCEAN JOURNEY RULE (CRITICAL):\nThis is an UNDERWATER ADVENTURE.\n- At least 3 ocean zones: sunlit reef, deeper blue, dark deep — each with different lighting and creatures.\n- The ocean world has personality: creatures that help, currents that push, bioluminescence that guides.\n- The child finds something hidden in the deep and brings it back to the surface.`,
    fantasy: `\n\nFANTASY THEME — QUEST ARC (CRITICAL):\nThis is a FANTASY QUEST. The child crosses into an enchanted world and must complete a quest.\n- At least 4 locations: the threshold, an enchanted forest/field, a castle/tower, the quest endpoint.\n- Victory comes from cleverness or heart, not force. The favorite object is key.`,
    nature: `\n\nNATURE THEME — DISCOVERY ARC (CRITICAL):\nThis is a NATURE DISCOVERY story.\n- At least 3 distinct natural locations with different light, sound, and life.\n- An animal or plant needs help — the child must observe carefully before acting.\n- The natural world responds to the child's care — something heals, blooms, or moves.`,
    mothers_day: `\n\nMOTHER'S DAY THEME — LOVE LETTER ARC (CRITICAL):\nThis is a MOTHER'S DAY book — a love letter from the child to Mom.\n- Mom is a NAMED, VISIBLE co-protagonist. Use the name from customDetails (calls_mom / mom_name). If not provided, use "Mommy".\n- Mom MUST appear in illustration prompts for at least 6 of 13 spreads — describe her position, gesture, and expression each time.\n- The story is told from the child's perspective of love and gratitude.\n- Arc: everyday shared moments → realization of Mom's love → child's gesture of love back → heartfelt embrace.\n- Include the meaningful_moment from customDetails as a specific scene.\n- The ending is warm, tender, deeply emotional — Mom and child together. NOT a quest ending, NOT a bedtime ending.\n- IGNORE the "never depict family members" rule for Mom. Mom is a visible character in illustrations for this theme.\n- The repeated phrase should feel tender and personal in its final appearance.\n- This book should make a mother cry happy tears.`,
    fathers_day: `\n\nFATHER'S DAY THEME — LOVE LETTER ARC (CRITICAL):\nThis is a FATHER'S DAY book — a love letter from the child to Dad.\n- Dad is a NAMED, VISIBLE co-protagonist. Use the name from customDetails (calls_dad / dad_name). If not provided, use "Daddy".\n- Dad MUST appear in illustration prompts for at least 6 of 13 spreads — describe his position, gesture, and expression each time.\n- The story is told from the child's perspective of love and admiration.\n- Arc: everyday shared moments (playing, building, exploring) → realization of Dad's love → child's gesture of love back → heartfelt embrace.\n- Include the meaningful_moment from customDetails as a specific scene.\n- The ending is warm, tender, deeply emotional — Dad and child together. NOT a quest ending, NOT a bedtime ending.\n- IGNORE the "never depict family members" rule for Dad. Dad is a visible character in illustrations for this theme.\n- The repeated phrase should feel tender and personal in its final appearance.\n- This book should make a father's eyes water.`,
  };

  if (themeJourneyRules[theme]) {
    prompt += themeJourneyRules[theme];
  }

  // Emotional development books — replaces adventure theme rules entirely
  if (EMOTIONAL_THEMES.has(theme)) {
    const emotionalRules = getEmotionalWritingRules(
      theme,
      v2Vars.emotionalSituation || customDetails,
      v2Vars.emotionalParentGoal || null,
      v2Vars.copingResourceHint || null,
      age
    );
    prompt += emotionalRules;
  }

  if (details && details.trim()) {
    prompt += `\n\n\u26a0\ufe0f MANDATORY PERSONALIZATION — THE PARENT WROTE THIS ABOUT THEIR CHILD:\n"${details.trim()}"\nEvery specific person, place, object, or quirk mentioned here MUST appear concretely in the story — not as vague inspiration, but as actual named elements. If a grandparent is mentioned, they appear (voice/presence, not illustrated). If a pet is named, it appears. If a real place is named, the child goes there. Do not generalize or ignore any detail.`;
  }

  const maxBeats = (EMOTIONAL_THEMES.has(theme) && v2Vars?.emotionalSpreads) ? v2Vars.emotionalSpreads : 13;
  if (v2Vars.beats && Array.isArray(v2Vars.beats) && v2Vars.beats.length >= 12) {
    prompt += `\n\nYOU MUST follow this exact emotional arc for each spread:`;
    const beatCount = Math.min(v2Vars.beats.length, maxBeats);
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

  // BIRTHDAY: spread 13 must always land on the cake/candles moment
  if (theme === 'birthday') {
    const candleCount = age || 5;
    const candleWord = candleCount === 1 ? '1 candle' : `${candleCount} candles`;
    const ordinal = candleCount === 1 ? '1st' : candleCount === 2 ? '2nd' : candleCount === 3 ? '3rd' : `${candleCount}th`;
    prompt += `\n\n⚠️ BIRTHDAY ENDING RULE — SPREAD 13 MUST BE THE CAKE/CANDLES MOMENT (NON-NEGOTIABLE):\nThe entire story arc must build toward spread 13 as the natural, earned emotional payoff.\n\nIMPORTANT: IGNORE the generic ENDING RULES about "whispers", "stillness", and "sleep" — those rules do NOT apply to birthday stories. The birthday ending is warm, joyful, and triumphant.\n\nSPREAD 12 (the held breath): One quiet line only. The room hushes, lights dim, everyone gathers. The text must make the reader lean forward.\n\nSPREAD 13 (the release): Write spread 13 text in your own voice — warm, joyful, matching the child's voice and the rhythm of the story that came before. Do NOT use a template sentence. This is the emotional climax the whole story earned.\n\nThe ILLUSTRATION for spread 13 is fixed and non-negotiable: ${name} leaning toward a birthday cake, cheeks puffed, about to blow out the candles. Warm golden candlelight, the ${favoriteObject} nearby, confetti, joy.\nCANDLE COUNT: The cake must have EITHER:\n  • Exactly ${candleCount} individual lit candles (one for each year), OR\n  • A single large numeral candle in the shape of the number ${candleCount}\nDo NOT draw ${candleCount + 1} candles or any other number. This is the child's ${ordinal} birthday.\nShape the preceding spreads so this ending feels inevitable, not sudden. Every spread should increase the anticipation.`;
    prompt += `\n\nBIRTHDAY AGE-WEAVING (CRITICAL): ${name} is turning ${candleCount} today. The number ${candleCount} must feel meaningful across the whole story — not just at the candles. In at least 3 spreads, show what being ${candleCount} MEANS: something new they can do, something they now understand, a milestone of being ${candleCount}. The age is not a decoration — it is the emotional spine of the story.`;
  }

  if (v2Vars.repeated_phrase) {
    prompt += `\n\nREPEATED PHRASE to use: "${v2Vars.repeated_phrase}"`;
    if (v2Vars.phrase_arc && Array.isArray(v2Vars.phrase_arc)) {
      prompt += `\nPhrase evolution: ${v2Vars.phrase_arc.join(' → ')}`;
    }
  }

  const writerSpreadCount = (EMOTIONAL_THEMES.has(theme) && v2Vars?.emotionalSpreads) ? v2Vars.emotionalSpreads : 13;
  prompt += `\n\nWrite the COMPLETE story as plain text (NOT JSON). Follow the output format from the system brief exactly.
- Write exactly ${writerSpreadCount} spreads with Left/Right text assignments.
- Focus entirely on literary quality. No illustration prompts needed.
- Follow ALL writing rules from the system brief (age tier, pacing, dialogue, etc.).`;

  // Inject theme-specific context if provided
  if (v2Vars?.themeContext) {
    prompt += v2Vars.themeContext;
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
function STORY_STRUCTURER_USER(storyText, childDetails, v2Vars = {}, beats, referenceContext) {
  const name = sanitizeForPrompt(childDetails.childName || childDetails.name || '', 50);
  const favoriteObject = v2Vars.favorite_object || 'a favorite toy';
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

  if (referenceContext) {
    const { interests, enrichedCustomDetails } = referenceContext;
    const interestsList = (interests || []).filter(Boolean);
    if (interestsList.length || enrichedCustomDetails) {
      prompt += `\n\nREFERENCE CONTEXT — The child's known interests and personalized details:`;
      if (interestsList.length) {
        prompt += `\nInterests: ${interestsList.join(', ')}`;
      }
      if (enrichedCustomDetails) {
        prompt += `\nAnnotated parent details: ${enrichedCustomDetails}`;
      }
      prompt += `\nWhen story text alludes to any of these (e.g. puns, compound words, color references), reflect the underlying reference in the spread_image_prompt so illustrations can incorporate recognizable visual nods. Do NOT change the story text itself.`;
    }
  }

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
  const name = childDetails.childName || childDetails.name;
  const gender = childDetails.childGender || childDetails.gender;
  const pronouns = getPronounInfo(gender);
  const pronounInstruction = buildPronounInstruction(name, gender);

  return `Write the text for spread #${spreadPlan.spreadNumber} of a picture book for ${name} (age ${childDetails.childAge || childDetails.age || 5}).
${pronounInstruction ? `\n${pronounInstruction}\n` : ''}
Story context so far:
${storyContext || 'This is the beginning of the story.'}

This spread's plan:
- Scene: ${spreadPlan.illustrationPrompt || spreadPlan.illustrationDescription || spreadPlan.spread_image_prompt}
- Mood: ${spreadPlan.mood || 'warm'}

Write the text. Use ONLY ${pronouns.pair} pronouns for ${name}. Return ONLY the text, nothing else.`;
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
  getEmotionalWritingRules,
  COPING_STRATEGIES,
};
