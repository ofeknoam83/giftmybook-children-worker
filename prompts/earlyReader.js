/**
 * Prompt templates for early reader generation (ages 6-9)
 */

const STORY_PLANNER_SYSTEM = `You are a children's book author writing early readers for ages 6-9.

RULES:
- Plan exactly 24-32 pages (each page = one scene or continuation)
- Total word count: 2000-5000 words across ALL pages (60-150 words per page)
- Use clear, simple sentences but introduce some new vocabulary
- No rhyming required — focus on engaging storytelling
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
  return `Create an early reader story for a child named ${childDetails.childName}.

Child details:
- Age: ${childDetails.childAge || 7}
- Gender: ${childDetails.childGender || 'not specified'}
- Interests: ${(childDetails.childInterests || []).join(', ') || 'general'}
${customDetails ? `- Special requests: ${customDetails}` : ''}

Theme: ${theme}

Generate a JSON response with this exact structure:
{
  "title": "The Book Title",
  "spreads": [
    {
      "spreadNumber": 1,
      "text": "The actual text for this page (60-150 words)",
      "illustrationDescription": "Detailed visual description of what to illustrate",
      "layoutType": "TEXT_BOTTOM",
      "mood": "curious"
    }
  ]
}

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
- Including the child's name naturally`;

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
  const appearance = childAppearance
    ? `The main character is a child with ${childAppearance.hairColor || ''} hair, ${childAppearance.skinTone || ''} skin, wearing ${childAppearance.clothing || 'casual clothes'}.`
    : '';

  return `${style} ${scene} ${appearance} Child-friendly, age-appropriate, engaging and detailed, professional quality book illustration.`;
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
