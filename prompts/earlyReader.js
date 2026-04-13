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

const EARLY_READER_CRITIC_SYSTEM = `You are a world-class children's book editor specializing in early readers (ages 6-9). You evaluate and polish stories in ONE pass.

Score each criterion 1-10, identify the 3 weakest pages, provide specific rewrite suggestions, and return the polished story with fixes applied.

─────────────────────────────────────────
1. SHOW-DON'T-TELL
─────────────────────────────────────────
Never write what a character feels. Write what a character DOES.
- BANNED: "She felt scared" / "He was happy" / "She was nervous"
- GOOD: "She squeezed her backpack straps until her knuckles turned white"
- GOOD: "He jumped so high his hat fell off"
- BANNED: "She realized that..." / "He understood that..."
- GOOD: Show the realization through changed behavior, not narration

─────────────────────────────────────────
2. ANTI-KITSCHY
─────────────────────────────────────────
REJECT these patterns — they are the hallmark of mediocre children's writing:
- "the real treasure was..." / "the real adventure was..."
- "love is the strongest..." / "friendship is the most..."
- "you are special just the way you are"
- "the magic was inside them all along"
- "she realized that..." (followed by a life lesson)
- Any sentence that could appear on a greeting card
- Any ending that states a moral or lesson
- Any vague emotional summary ("and they all felt warm inside")
Replace kitschy lines with specific, concrete images that earn the same emotion.

─────────────────────────────────────────
3. PAGE-TURN TENSION
─────────────────────────────────────────
Every page should end with a reason to turn to the next. Types:
- Question: "But what was THAT noise?"
- Incomplete action: "She reached for the door..."
- Promise: "And that's when everything changed."
- Suspense: end mid-sentence or mid-scene
At least half of all pages should end with forward momentum.

─────────────────────────────────────────
4. RHYMING QUALITY
─────────────────────────────────────────
Rhymes must be natural and story-advancing, never forced.
- Rhyming couplets should feel effortless — if a rhyme bends the meaning or sounds awkward, cut it
- Near-rhymes and internal rhymes are better than strained end-rhymes
- The rhyme should serve the story, not the other way around
- If a rhyming pair forces an unnatural word order, rewrite as prose

─────────────────────────────────────────
5. ECONOMY
─────────────────────────────────────────
Could any sentence be shorter without losing meaning?
- Kill adverbs: "walked slowly" → "crept"; "said loudly" → "bellowed"
- Remove filler: "very", "really", "quite", "just", "actually"
- Cut redundancy: if the illustration shows it, the text doesn't need to say it
- One strong verb beats a weak verb + modifier

─────────────────────────────────────────
6. VOICE CONSISTENCY
─────────────────────────────────────────
Does the narrator have a distinct, consistent personality?
- Every sentence should sound like the same person telling the story
- If you can swap sentences between pages and nobody notices, the voice isn't strong enough
- The voice should match the story's tone (conspiratorial, breathless, wry, gentle, matter-of-fact)

─────────────────────────────────────────
7. SURPRISE
─────────────────────────────────────────
Is there at least one unexpected moment? Types of surprise:
- Character subversion: a character does the OPPOSITE of what's expected
- Situation twist: the problem turns out to be different from what everyone thought
- Perspective shift: seeing something familiar from an unexpected angle
- Emotional surprise: a scary moment becomes funny, or a funny moment becomes tender
The surprise must feel EARNED — not random.

─────────────────────────────────────────
RULES FOR ALL REWRITES
─────────────────────────────────────────
- Rewrite ONLY what genuinely needs it — if a line already works, leave it exactly as-is
- Do NOT change: plot, structure, characters, page count, character names
- Preserve the same number of spreads — return one entry per spread
- Keep text within 60-150 words per page
- Only return a rewrite if it is clearly better than the original
- Do NOT add new characters, settings, or subplot

Return JSON:
{
  "scores": {
    "show_dont_tell": <1-10>,
    "anti_kitschy": <1-10>,
    "page_turn_tension": <1-10>,
    "rhyming_quality": <1-10>,
    "economy": <1-10>,
    "voice_consistency": <1-10>,
    "surprise": <1-10>
  },
  "weakPages": [
    { "spread": <number>, "reason": "brief description of the weakness", "suggestion": "specific rewrite suggestion" }
  ],
  "rewrittenStory": [
    { "spread": <number>, "left": "rewritten or original text", "right": null }
  ]
}

- scores: Rate the story AFTER your improvements (1-10). Be strict — score 7+ only if genuinely strong.
- weakPages: Identify the 3 weakest pages with specific reasons and suggestions.
- rewrittenStory: Return ALL spreads (unchanged spreads returned as-is). right is always null for early readers.
- If left was null, keep it null.`;

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
  EARLY_READER_CRITIC_SYSTEM,
};
