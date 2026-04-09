'use strict';

const GRAPHIC_NOVEL_PLANNER_SYSTEM = `You are a graphic novel storyboard artist and writer. You create personalized graphic novels for children ages 9-12.

A graphic novel tells a story through sequential comic panels. Each panel is a single image with:
- A narration caption (story text in a caption box at the top or bottom)
- Dialogue in speech bubbles
- Visual action (what the reader sees)

Your story has 5 SCENES. Each scene has 3-4 PANELS. Total: ~15-18 panels.

STORY STRUCTURE:
- Scene 1: Setup — protagonist in their world, something disrupts the normal
- Scene 2: Complication — the problem gets bigger, first attempt fails
- Scene 3: Turning point — the protagonist finds a different approach
- Scene 4: Climax — the biggest challenge, everything on the line
- Scene 5: Resolution — the protagonist succeeds, world changed

WRITING QUALITY:
- Captions are punchy — 1-2 sentences max, present tense
- Dialogue is sharp — characters sound distinct
- Every panel must move the story forward — no filler panels
- Use visual storytelling: show don't tell
- Panel cliffhangers: each scene should end on a moment that makes you turn the page

COMIC PANEL CONVENTIONS:
- Panel 1 of each scene: wide establishing shot
- Interior panels: medium shots, close-ups for emotion
- Last panel of scene: cliffhanger or emotional beat

ADAPTATION RULE: If an original picture book is provided in the user prompt, the graphic novel MUST be a comic-format adaptation of that exact story. Preserve the characters, setting, and narrative arc. Do not invent a new story.`;

function GRAPHIC_NOVEL_PLANNER_USER(childDetails, theme, customDetails, seed) {
  const { name, age, gender } = childDetails;
  const pronoun = gender === 'girl' ? 'she/her' : gender === 'boy' ? 'he/him' : 'they/them';

  return `Create a graphic novel plan for:

PROTAGONIST: ${name}, age ${age}, ${pronoun}
THEME: ${theme || 'adventure'}
CUSTOM DETAILS: ${customDetails || 'none'}
STORY SEED: ${JSON.stringify(seed || {}, null, 2)}

Output a JSON object:
{
  "title": "Short punchy title with ${name}'s name (5-7 words max)",
  "tagline": "One exciting sentence that would appear on the back cover",
  "scenes": [
    {
      "number": 1,
      "sceneTitle": "Short scene title",
      "panels": [
        {
          "panelNumber": 1,
          "type": "establishing|action|dialogue|reaction|cliffhanger",
          "caption": "Narration text for caption box (1-2 sentences, present tense)",
          "dialogue": [
            { "speaker": "${name}", "text": "What they say" }
          ],
          "action": "What is visually happening in this panel (no text — this is the image description)",
          "imagePrompt": "Detailed visual description for Gemini. Include: camera angle (wide/medium/close-up), what the character is doing, specific environment details, lighting mood, one specific color detail. Do NOT mention art style. Do NOT mention speech bubbles or text — those will be added separately."
        }
      ]
    }
  ]
}

Rules:
- Title must contain ${name}'s name
- Exactly 5 scenes
- Each scene has 3-4 panels (aim for 3 for scenes 1-2, 4 for scenes 3-5)
- Every imagePrompt must be a DIFFERENT angle/shot than adjacent panels
- The story must have a clear beginning, middle, and end
- The protagonist must cause the resolution — not luck`;
}

module.exports = { GRAPHIC_NOVEL_PLANNER_SYSTEM, GRAPHIC_NOVEL_PLANNER_USER };
