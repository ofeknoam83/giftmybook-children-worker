/**
 * Prompt templates for picture book generation (ages 3-6)
 */

const { sanitizeForPrompt } = require('../services/validation');
const { buildWriterBrief, getAgeProfile } = require('./writerBrief');

// Dynamic — built per request with the child's actual age
function buildStoryPlannerSystem(age) {
  const profile = getAgeProfile(age);
  return `${buildWriterBrief(age)}

You are planning the story structure for this book. Apply the brief above to every decision.

STORY STRUCTURE:
1. Begin grounded — a real moment, a real room, a real feeling (1-2 spreads)
2. One small disruption — a discovery, a question, a dare. The child chooses to act.
3. Build through cause and effect — each spread is a consequence of the last, not a new vignette.
4. Let the emotional temperature rise then slowly cool.
5. The final 2 spreads decelerate: shorter sentences, quieter images, breath slowing.
6. Last spread: inevitable. The reader exhales.

RULES:
- Plan exactly 8 page spreads (each spread = one scene)
- Words per spread: ${profile.wordsPerSpread}
- Total word count: ${profile.totalWords} across ALL spreads
- Each spread's text MUST be a complete thought — NEVER split a sentence across spreads
- Each spread must have a clear visual scene that can be illustrated
- The child character is ALWAYS the active agent — choosing, doing, causing
- Include a recurring visual element throughout (a named companion, a special object)
- NO scary content, violence, or complex emotions
- Vocabulary appropriate for age ${age}: ${profile.vocabulary}
- NO filler phrases: "What a fun...", "How magical!", "full of magic", "It feels like..."
- No exclamation marks after spread 4

Respond with ONLY valid JSON.`;
}

// Static fallback for backward compat
const STORY_PLANNER_SYSTEM = buildStoryPlannerSystem(5);

function STORY_PLANNER_USER(childDetails, theme, customDetails) {
  const { buildChildContext } = require('./writerBrief');
  const name = sanitizeForPrompt(childDetails.childName || '', 50);
  const interests = (childDetails.childInterests || []).map(i => sanitizeForPrompt(i, 50)).join(', ') || 'general';
  const details = customDetails ? sanitizeForPrompt(customDetails, 500) : '';
  const childContext = buildChildContext(childDetails, details);

  return `${childContext}

Create a bedtime picture book story for ${name}.

Child details:
- Age: ${childDetails.childAge || 5}
- Gender: ${childDetails.childGender || 'not specified'}
- Interests: ${interests}
${details ? `- Special requests / real quirks: ${details}` : ''}

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

// Dynamic text generator system prompt — adapts to child's age
function buildTextGeneratorSystem(age) {
  const profile = getAgeProfile(age);
  return `${buildWriterBrief(age)}

You are writing the final page text. Apply the brief above to every word.

FORMAT CONSTRAINTS:
- ${profile.wordsPerSpread} words per spread (STRICT limit)
- ${profile.sentenceStyle}
- Written in present tense for immediacy
- Include the child's name naturally (not forced)
- ${profile.readAloudNote}

CRITICAL RULES:
- Each page's text MUST be a COMPLETE thought. NEVER split a sentence across pages.
- The child acts. Every sentence answers: what does the child choose, touch, say, or do?
- Name things specifically. Not "a treat" — what kind?
- No filler: cut "What a fun...", "How magical!", "So much...", "full of magic"
- No exclamation marks after spread 4. Sentences get shorter as sleep approaches.
- The last spread: the reader exhales. Not surprised — settled.`;
}

const TEXT_GENERATOR_SYSTEM = buildTextGeneratorSystem(5);

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
  buildStoryPlannerSystem,
  STORY_PLANNER_USER,
  TEXT_GENERATOR_SYSTEM,
  buildTextGeneratorSystem,
  TEXT_GENERATOR_USER,
  ILLUSTRATION_PROMPT_BUILDER,
  VOCABULARY_CHECK_PROMPT,
};
