/**
 * Prompt templates for picture book generation (ages 3-6)
 */

const { sanitizeForPrompt } = require('../services/validation');

const STORY_PLANNER_SYSTEM = `You are a children's picture book author creating stories for ages 3-6.

RULES:
- Plan exactly 12-16 page spreads (each spread = one scene)
- Total word count: 150-300 words across ALL spreads (8-20 words per spread)
- Use simple, rhythmic language — rhyming is strongly encouraged
- Each spread's text MUST be a complete thought — NEVER split a sentence across spreads
- Each spread must have a clear visual scene that can be illustrated
- Story arc: setup (3 spreads) → adventure (6-8 spreads) → resolution (2-3 spreads)
- The child character is ALWAYS the hero
- Keep themes positive: courage, kindness, curiosity, friendship
- NO scary content, violence, or complex emotions
- Include recurring visual elements (a special object, animal companion, etc.)

LAYOUT TYPES for each spread:
- TEXT_BOTTOM: Illustration top 65%, text bottom 35% (most common)
- FULL_BLEED: Full-page illustration with text overlay (dramatic moments)
- NO_TEXT: Full illustration, no text (visual-only beats)

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
  "spreads": [
    {
      "spreadNumber": 1,
      "text": "The actual text for this spread (30-60 words, rhyming preferred)",
      "illustrationDescription": "Detailed visual description of what to illustrate",
      "layoutType": "TEXT_BOTTOM",
      "mood": "warm"
    }
  ]
}

MOODS: warm, playful, exciting, mysterious, peaceful, triumphant, funny`;
}

const TEXT_GENERATOR_SYSTEM = `You are a children's picture book writer. Your text must be:
- Simple vocabulary suitable for ages 3-6
- Rhythmic and musical — rhyming when natural
- 8-20 words per spread (STRICT limit — keep it SHORT)
- Emotionally engaging but never scary
- Written in present tense for immediacy
- Including the child's name naturally (not forced)

CRITICAL RULE: Each page's text MUST be a COMPLETE thought or sentence. NEVER end mid-sentence.
The text for each page stands alone — it is NOT continued from the previous page.
Do NOT split a sentence across two pages. Each spread's text must make sense on its own.
Keep sentences short and self-contained. One or two short sentences per page maximum.`;

function TEXT_GENERATOR_USER(spreadPlan, childDetails, storyContext) {
  return `Write the text for spread #${spreadPlan.spreadNumber} of a picture book for ${childDetails.childName} (age ${childDetails.childAge || 5}).

Story context so far:
${storyContext || 'This is the beginning of the story.'}

This spread's plan:
- Scene: ${spreadPlan.illustrationDescription}
- Mood: ${spreadPlan.mood}
- Layout: ${spreadPlan.layoutType}

Write 30-60 words of picture book text. Rhyming is encouraged. Return ONLY the text, nothing else.`;
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
