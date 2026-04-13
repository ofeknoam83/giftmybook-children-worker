/**
 * Prompt templates for early reader generation (ages 6-9)
 */

const { sanitizeForPrompt } = require('../services/validation');

const STORY_PLANNER_SYSTEM = `You are a children's book author writing early readers for ages 6-9.

RULES:
- Plan exactly 24-32 pages (each page = one scene or continuation)
- Total word count: 2000-5000 words across ALL pages (60-150 words per page)
- Use clear, simple sentences but introduce some new vocabulary
- Use rhythmic prose with occasional rhyming couplets or AABB rhyme passages — aim for at least one rhyming pair every 3-4 pages. Think Julia Donaldson's early readers: prose with a lyrical backbone. Prioritize natural-sounding rhymes over forced ones
- Include simple dialogue between characters
- Story arc: introduction (4 pages) → rising action (8-10 pages) → climax (4-6 pages) → resolution (4 pages)
- The child character is ALWAYS the protagonist
- Include a friend or companion character
- Themes: bravery, problem-solving, teamwork, self-confidence
- Age-appropriate challenges — nothing truly scary
- Short chapters optional (3-4 pages each)

LAYOUT TYPES for each page:
- TEXT_BOTTOM: Illustration top, text bottom (most common)
- TEXT_LEFT: Left side text, right side illustration
- FULL_BLEED: Full-page illustration with text overlay (key moments)
- NO_TEXT: Full illustration, no text (chapter breaks, dramatic reveals)

Respond with ONLY valid JSON.`;

function STORY_PLANNER_USER(childDetails, theme, customDetails) {
  const name = sanitizeForPrompt(childDetails.childName || '', 50);
  const interests = (childDetails.childInterests || []).map(i => sanitizeForPrompt(i, 50)).join(', ') || 'general';
  const details = customDetails ? sanitizeForPrompt(customDetails, 500) : '';

  return `Create an early reader story for a child named ${name}.

Child details:
- Age: ${childDetails.childAge || 7}
- Gender: ${childDetails.childGender || 'not specified'}
- Interests: ${interests}
${details ? `- Special requests: ${details}` : ''}

Theme: ${theme}

Generate a JSON response with this exact structure:
{
  "title": "The Book Title",
  "characterOutfit": "exact outfit the child wears in EVERY illustration (garment type, color, patterns, shoes, accessories) — same from first page to last",
  "characterDescription": "physical appearance details beyond the photo",
  "recurringElement": "exact visual description of any companion or recurring object so it looks identical on every page",
  "keyObjects": "other objects that recur across pages, with exact visual details",
  "spreads": [
    {
      "spreadNumber": 1,
      "text": "The actual text for this page (60-150 words)",
      "illustrationDescription": "Detailed visual description of what to illustrate (do NOT re-describe the outfit — it is defined once at the top level)",
      "layoutType": "TEXT_BOTTOM",
      "mood": "curious"
    }
  ]
}

IMPORTANT:
- You MUST include characterOutfit at the top level — the child wears ONE outfit throughout the entire book.
- Do NOT re-describe clothing in illustrationDescription.

MOODS: warm, curious, exciting, mysterious, peaceful, triumphant, funny, determined, surprised`;
}

const TEXT_GENERATOR_SYSTEM = `You are a children's early reader writer (ages 6-9). Your text must be:
- Simple but varied vocabulary — introduce 1-2 new words per page with context clues
- 60-150 words per page
- Short sentences (under 20 words)
- Include dialogue with quotation marks
- Written in past tense (standard narrative)
- Paragraphs of 2-3 sentences max
- Emotionally engaging with relatable challenges
- Including the child's name naturally
- RHYTHMIC PROSE WITH RHYMES: Weave in rhyming couplets and near-rhymes for musicality. Aim for at least one rhyming pair every 2-3 pages. The prose should have a rhythmic, musical quality — think Julia Donaldson. Prioritize natural-sounding rhymes over forced ones.`;

function TEXT_GENERATOR_USER(spreadPlan, childDetails, storyContext) {
  return `Write the text for page #${spreadPlan.spreadNumber} of an early reader book for ${childDetails.childName} (age ${childDetails.childAge || 7}).

Story context so far:
${storyContext || 'This is the beginning of the story.'}

This page's plan:
- Scene: ${spreadPlan.illustrationDescription}
- Mood: ${spreadPlan.mood}
- Layout: ${spreadPlan.layoutType}

Write 60-150 words of early reader text. Include dialogue where natural. Return ONLY the text, nothing else.`;
}

function ILLUSTRATION_PROMPT_BUILDER(scene, artStyle, childAppearance) {
  const stylePrompts = {
    watercolor: 'Beautiful watercolor children\'s book illustration with expressive brushwork, warm color palette, detailed characters.',
    digital_painting: 'Vibrant digital painting children\'s book illustration, rich colors, dynamic composition, modern and engaging.',
    storybook: 'Classic children\'s storybook illustration with warm tones, detailed scenes, inviting and immersive.',
  };

  const style = stylePrompts[artStyle] || stylePrompts.watercolor;
  let appearance = '';
  if (typeof childAppearance === 'string' && childAppearance) {
    appearance = `The main character is a young child: ${childAppearance}`;
  } else if (childAppearance && typeof childAppearance === 'object') {
    appearance = `The main character is a child with ${childAppearance.hairColor || ''} hair, ${childAppearance.skinTone || ''} skin, wearing ${childAppearance.clothing || 'casual clothes'}.`;
  }

  return `${style} ${scene} ${appearance} Child-friendly, age-appropriate, engaging and detailed, professional quality book illustration. CRITICAL TEXT WIDTH RULE: All text MUST occupy no more than 35% of the page width. This is a hard limit — text that exceeds 35% width will cause the page to be REJECTED. Use shorter lines and more line breaks rather than wide text blocks. Verify text width before finalizing.`;
}

function VOCABULARY_CHECK_PROMPT(text, ageGroup) {
  return `Check if this text is appropriate for a ${ageGroup || 'ages 6-9'} early reader:

"${text}"

Evaluate:
1. Are words appropriate for the age group? (some challenge is OK)
2. Are sentences under 20 words each?
3. Is the content emotionally appropriate?
4. Is dialogue formatted correctly?
5. Does it read well for a child reading independently?

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
