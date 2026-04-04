/**
 * Prompt templates for picture book generation (ages 3-6)
 */

const { sanitizeForPrompt } = require('../services/validation');

const STORY_PLANNER_SYSTEM = `You are a world-class children's picture book author. Your writing style is inspired by Roald Dahl and Dr. Seuss — warm, magical, slightly mischievous, with vivid simple imagery and unexpected twists.

WRITING STYLE:
- Simple, clear language a child aged 3-6 can understand
- Short, playful, engaging sentences
- A sense of wonder, imagination, and quirky humor
- Prefer showing over explaining
- Light rhythm or subtle rhyme throughout
- Emotionally intelligent but never heavy
- Show deeper meaning beneath simple events (friendship, courage, honesty, growing up)

STORY STRUCTURE:
1. Begin with a calm, relatable situation (2-3 spreads)
2. Introduce a small problem, mystery, or discovery
3. Gradually build wonder and excitement — something unexpected happens
4. Let the adventure grow with curious twists that delight but never scare
5. Resolve with a satisfying emotional release (joy, relief, warmth, insight)
6. End with a gentle takeaway and a small spark of imagination

RULES:
- Plan exactly 12-16 page spreads (each spread = one scene)
- Total word count: 150-300 words across ALL spreads (8-20 words per spread)
- Each spread's text MUST be a complete thought — NEVER split a sentence across spreads
- Each spread must have a clear visual scene that can be illustrated
- The child character is ALWAYS the hero
- Include a recurring visual element throughout (a special object, animal companion, etc.)
- Add small unexpected twists or funny details
- NO scary content, violence, or complex emotions
- Avoid complex vocabulary

Respond with ONLY valid JSON.`;

function STORY_PLANNER_USER(childDetails, theme, customDetails) {
  const name = sanitizeForPrompt(childDetails.childName || '', 50);
  const interests = (childDetails.childInterests || []).map(i => sanitizeForPrompt(i, 50)).join(', ') || 'general';
  const details = customDetails ? sanitizeForPrompt(customDetails, 500) : '';

  return `Create a picture book story for a child named ${name}.

Child details:
- Age: ${childDetails.childAge || 5}
- Gender: ${childDetails.childGender || 'not specified'}
- Interests: ${interests}
${details ? `- Special requests: ${details}` : ''}

Theme: ${theme}

Generate a JSON response with this exact structure:
{
  "title": "The Book Title",
  "characterDescription": "Detailed visual description of the child character as they should appear in EVERY illustration: approximate age appearance, skin tone, hair color/style, facial features. This description must be consistent across all pages.",
  "characterOutfit": "Describe the child's outfit in detail — this EXACT outfit will be worn on EVERY page (e.g., 'bright red raincoat with yellow buttons, green rubber boots, blue striped scarf')",
  "recurringElement": "A special recurring companion that appears throughout the story (e.g., 'a small orange cat with a bent ear and a tiny blue collar'). Describe its exact visual appearance.",
  "keyObjects": "Describe ALL important objects in the story with EXACT colors and details. These must look identical on every page. Example: 'a bright red tricycle with silver handlebars and a white basket, a yellow kite with blue stripes'. Be very specific about colors.",
  "spreads": [
    {
      "spreadNumber": 1,
      "text": "Short complete sentence for this page (8-20 words, rhyming preferred)",
      "illustrationPrompt": "DETAILED illustration prompt — see rules below",
      "mood": "warm"
    }
  ]
}

ILLUSTRATION PROMPT RULES — CRITICAL:
- Each illustrationPrompt must describe the FULL scene in one detailed paragraph
- Include: character pose, facial expression, what they're doing with their hands/body
- Include: environment (indoor/outdoor, time of day, weather, key objects)
- Include: camera angle (close-up, medium shot, wide shot)
- Include: lighting and color mood (warm sunset, bright morning, soft moonlight)
- Include: any secondary characters, animals, or the recurring element
- The main character ALWAYS wears the outfit defined in characterOutfit
- The main character appears ONLY ONCE per illustration — NEVER show the same character twice in one image
- The recurring element should appear naturally in each scene (not forced)
- Objects that appear across multiple pages must look identical (same color, shape, size — can be shown from different angles)
- Make each scene visually distinct from the others — vary the setting, camera angle, and composition

MOODS: warm, playful, exciting, mysterious, peaceful, triumphant, funny`;
}

const TEXT_GENERATOR_SYSTEM = `You are a children's picture book writer in the style of Roald Dahl and Dr. Seuss. Your text must be:
- Simple vocabulary suitable for ages 3-6
- Rhythmic and musical — light rhyme and playful rhythm throughout
- 8-20 words per spread (STRICT limit — keep it SHORT)
- Full of wonder, humor, and vivid simple imagery
- Written in present tense for immediacy
- Including the child's name naturally (not forced)
- Warm, magical, slightly mischievous tone
- Show, don't explain

CRITICAL RULE: Each page's text MUST be a COMPLETE thought or sentence. NEVER end mid-sentence.
The text for each page stands alone — it is NOT continued from the previous page.
Do NOT split a sentence across two pages. Each spread's text must make sense on its own.
Keep sentences short and self-contained. One or two short sentences per page maximum.`;

function TEXT_GENERATOR_USER(spreadPlan, childDetails, storyContext) {
  return `Write the text for spread #${spreadPlan.spreadNumber} of a picture book for ${childDetails.childName} (age ${childDetails.childAge || 5}).

Story context so far:
${storyContext || 'This is the beginning of the story.'}

This spread's plan:
- Scene: ${spreadPlan.illustrationPrompt || spreadPlan.illustrationDescription}
- Mood: ${spreadPlan.mood}

Write 8-20 words of picture book text. Rhyming and rhythm encouraged. Return ONLY the text, nothing else.`;
}

function ILLUSTRATION_PROMPT_BUILDER(scene, artStyle, childAppearance) {
  const stylePrompts = {
    watercolor: 'Beautiful watercolor children\'s book illustration with soft washes of color, gentle brushstrokes, warm palette, dreamy atmosphere.',
    digital_painting: 'Vibrant digital painting children\'s book illustration, rich colors, detailed and polished, modern storybook style.',
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
2. Are sentences short enough (under 15 words each)?
3. Is the content emotionally appropriate (no fear, violence, complex themes)?
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
  STORY_PLANNER_USER,
  TEXT_GENERATOR_SYSTEM,
  TEXT_GENERATOR_USER,
  ILLUSTRATION_PROMPT_BUILDER,
  VOCABULARY_CHECK_PROMPT,
};
