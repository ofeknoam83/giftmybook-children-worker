'use strict';

const GRAPHIC_NOVEL_PLANNER_SYSTEM = `You are a world-class middle-grade graphic novel showrunner, comics editor, storyboard artist, letterer, and production designer.

You are planning a shelf-quality graphic novel for readers ages 9-12. Think like a premium publisher: every page needs clear reading flow, controlled pacing, distinct emotional beats, and art-direction metadata.

Return JSON only.

CRITICAL — fullPagePrompt:
For each page you MUST write a "fullPagePrompt" field. This is a detailed natural-language description of the COMPLETE comic book page as a single image. An AI image generator will receive this prompt and render the entire page — panels, borders, speech bubbles with text, captions, sound effects — all in one image.

The fullPagePrompt must describe:
1. Panel layout and spatial arrangement (e.g. "3 panels: one wide strip across the top, two equal panels side by side below").
2. What happens visually in each panel — characters, action, setting, lighting, camera angle, expressions.
3. ALL text content VERBATIM — every speech bubble (with speaker and bubble type), every caption box (with style), every sound effect (with visual treatment).
4. Art direction — color palette, lighting mood, atmosphere.

fullPagePrompt text rules:
- Speech bubbles: max 8 words per bubble. Prefer 3-6 words.
- Caption boxes: max 15 words per caption.
- Sound effects: 1-2 words, all caps.
- These limits are critical — AI image models render short text reliably but fail on long text.
- Specify bubble type when not standard speech: "(shout bubble)", "(thought bubble)", "(whisper bubble)".
- Specify caption style: "(narration caption)", "(location caption)", "(internal monologue caption)".

Editorial principles:
- Clarity beats density.
- Default to 2-3 panels per page, with 1-4 total panels on most pages.
- Every page needs one dominant beat.
- Every page must have an intentional page-turn function: setup, reveal, joke, dread, question, release, or wonder.
- Readers must always know where to look next.
- Dialogue must be concise and actable.
- Let the art carry at least 20-30% of the book through silent or near-silent panels.

Story structure:
- Exactly 7 scenes.
- Scene 1: ordinary world and want.
- Scene 2: disruption and pull into the story.
- Scene 3: complication and failed first approach.
- Scene 4: midpoint shift and new strategy.
- Scene 5: escalation and internal doubt.
- Scene 6: climax and decisive choice.
- Scene 7: resolution and emotional landing.

Design constraints:
- Two splash pages exactly: one in scene 6 and one in scene 7.
- Scene openers should establish place before relying on close-ups.
- Dialogue-heavy pages should prefer stable grids.
- Action pages should privilege hierarchy and negative space.
- Default style is cinematic 3D Pixar-like with volumetric lighting, rim lights, subsurface skin scattering, and rich saturated colors.
- Every fullPagePrompt should include lighting and color palette direction.

For each page output production metadata, not vague prose.`;

const GRAPHIC_NOVEL_STORY_BIBLE_SYSTEM = `You are creating the story bible for a premium middle-grade graphic novel. Return JSON only.

You are not writing pages yet. Instead, define the story engine:
- title
- tagline
- logline
- cast with voice notes
- world bible
- color script by scene
- scene arc
- recurring motifs
- emotional rhythm
- how the child personalization appears naturally

Keep the book commercial, emotionally clear, and page-turnable for ages 9-12.`;

function GRAPHIC_NOVEL_STORY_BIBLE_USER(childDetails, theme, customDetails, seed) {
  const { name, age, gender } = childDetails;
  const interests = (childDetails.childInterests || childDetails.interests || []).filter(Boolean);
  const pronoun = gender === 'female' ? 'she/her' : gender === 'male' ? 'he/him' : 'they/them';

  return `Create a story bible for a personalized middle-grade graphic novel.

PROTAGONIST: ${name}, age ${age}, ${pronoun}
${interests.length ? `INTERESTS: ${interests.join(', ')}` : ''}
THEME: ${theme || 'adventure'}
CUSTOM DETAILS: ${customDetails || 'none'}
STORY SEED: ${JSON.stringify(seed || {}, null, 2)}

Return a JSON object with this shape:
{
  "title": "Must include ${name}'s name",
  "tagline": "Back-cover quality line",
  "logline": "1-2 sentence premise",
  "narrativeMode": "close third person present",
  "audiencePromise": "What the reader gets emotionally and visually",
  "cast": [
    {
      "id": "hero",
      "name": "${name}",
      "role": "protagonist",
      "voiceGuide": "short description of speech rhythm and attitude",
      "visualAnchor": "2-3 reusable visual identifiers",
      "actingNotes": "facial and body-language notes the illustrator should keep consistent"
    }
  ],
  "worldBible": {
    "setting": "core world description",
    "locationAnchors": ["3-6 recurring location anchors"],
    "propAnchors": ["3-8 recurring prop anchors"],
    "styleNorthStar": "How the visuals should feel"
  },
  "sceneColorScript": [
    {
      "sceneNumber": 1,
      "dominantPalette": "one sentence",
      "contrastStrategy": "one sentence"
    }
  ],
  "recurringMotifs": ["2-5 motifs"],
  "sceneBlueprints": [
    {
      "sceneNumber": 1,
      "sceneTitle": "short title",
      "purpose": "narrative purpose",
      "turningPoint": "what changes by the end of scene",
      "pageCountTarget": 4,
      "dominantEmotion": "emotion",
      "pageTurnIntent": "what the final page turn of the scene should do"
    }
  ]
}

Rules:
- Exactly 7 sceneBlueprints.
- The sum of all pageCountTarget values must be between 24 and 32.
- Total target length should imply roughly 24-32 pages.
- The protagonist must drive the resolution.
- Personalization must feel story-native, not pasted on.
- Avoid babyish tone. Use middle-grade wit, emotional clarity, and adventure.
- Keep the cast small and production-friendly.`;
}

function GRAPHIC_NOVEL_PLANNER_USER(childDetails, theme, customDetails, seed, storyBible) {
  const { name, age, gender } = childDetails;
  const interests = (childDetails.childInterests || childDetails.interests || []).filter(Boolean);
  const pronoun = gender === 'female' ? 'she/her' : gender === 'male' ? 'he/him' : 'they/them';

  return `Create the full production script for a personalized middle-grade graphic novel.

PROTAGONIST: ${name}, age ${age}, ${pronoun}
${interests.length ? `INTERESTS: ${interests.join(', ')}` : ''}
THEME: ${theme || 'adventure'}
CUSTOM DETAILS: ${customDetails || 'none'}
STORY SEED: ${JSON.stringify(seed || {}, null, 2)}
STORY BIBLE: ${JSON.stringify(storyBible || {}, null, 2)}

Return a JSON object:
{
  "title": "Must include ${name}'s name",
  "tagline": "Back-cover line",
  "pages": [
    {
      "pageNumber": 1,
      "sceneNumber": 1,
      "sceneTitle": "scene title",
      "pagePurpose": "what this page is doing dramatically",
      "pageTurnIntent": "setup|reveal|joke|threat|wonder|question|release|cliffhanger",
      "dominantBeat": "the one beat that should dominate the page",
      "layoutTemplate": "cinematicTopStrip|heroTopTwoBottom|twoTierEqual|conversationGrid|fourGrid|fullBleedSplash",
      "panelCount": 3,
      "textDensity": "silent|light|medium",
      "colorScript": {
        "paletteId": "short id",
        "dominantHue": "e.g. ember orange",
        "contrastMode": "brightFacesDarkGround|coolWideWarmFaces|graphicHighContrast"
      },
      "fullPagePrompt": "A detailed natural-language description of the COMPLETE comic page as a single image. Describe the panel layout, what happens in each panel, ALL speech bubbles with exact text, ALL captions with exact text, ALL sound effects. This will be sent directly to an image-generation AI to render the entire page in one shot. Example: 'A comic book page with 3 panels. Top panel (wide): Wide shot of a sparkling crystal cavern. ${name} stands center, red backpack visible, looking up in awe. Golden light streams through ceiling cracks. A narration caption in the top-left reads: \"The caverns had been sealed for ages.\" Bottom-left panel: Medium close-up of ${name}, eyes wide. Speech bubble: \"Incredible...\" Bottom-right panel: Close-up of a glowing crystal. A tiny fairy peeks out. Sound effect \"SHIMMER\" in sparkly lettering near the crystal.'",
      "panels": [
        {
          "sceneNumber": 1,
          "panelNumber": 1,
          "panelType": "establishing|action|dialogue|closeup|reaction|insert|splash",
          "shot": "EWS|WS|MS|MCU|CU|ECU",
          "cameraAngle": "eye-level|low-angle|high-angle|over-shoulder|profile|dutch",
          "pacing": "slow|medium|fast",
          "actingNotes": "concrete expression/gesture/eyeline note",
          "backgroundComplexity": "minimal|simple|medium",
          "action": "What the reader sees happen",
          "balloons": [
            {
              "type": "speech|shout|whisper|thought",
              "speaker": "${name}",
              "text": "max 8 words",
              "order": 1
            }
          ],
          "captions": [
            {
              "type": "narration|location_time|internal_monologue",
              "text": "max 15 words"
            }
          ],
          "sfx": [
            {
              "text": "WHOOM",
              "style": "impact|airy|electric|magic"
            }
          ]
        }
      ]
    }
  ]
}

Rules:
- Build 24-32 story pages total.
- The pages array itself must contain 24-32 fully written page objects.
- Exactly 7 scenes.
- Exactly 2 splash pages total: one in scene 6 and one in scene 7.
- Default to 2-3 panels per page.
- Use 4-panel pages sparingly.
- At least 20% of panels should have no balloons.
- The last page of each scene should create a clear page-turn impulse.
- Adjacent panels must not repeat the same shot/camera combination.
- Dialogue must sound distinct per character.
- Preserve the story bible.
- Weave the child personalization in naturally so a parent can see it immediately.
- Returning one page per scene is invalid.
- Returning only an outline, scene summaries, or page stubs is invalid.
- Every page object must include a non-empty panels array.
- Every non-splash page should usually contain 2 or 3 panels.
- CRITICAL: Every page object MUST include a non-empty fullPagePrompt string.
- The fullPagePrompt must include ALL text verbatim — every speech bubble, caption, and sound effect.
- Keep speech bubble text to max 8 words. Keep caption text to max 15 words.
- Describe panel layout spatially in the fullPagePrompt (top/bottom/left/right) so the image model composes correctly.`;
}

const GRAPHIC_NOVEL_SCENE_PLANNER_SYSTEM = `You are planning a subset of pages for a premium middle-grade graphic novel.

Return JSON only.

You are not planning the whole book in one pass. You are planning only the requested scenes/pages, but they must feel like part of the same professionally designed graphic novel.

CRITICAL — fullPagePrompt:
Every page MUST include a "fullPagePrompt" field — a detailed natural-language description of the COMPLETE comic book page as a single image. An AI image generator will render the entire page from this prompt: panels, borders, speech bubbles with text, captions, sound effects — everything in one image.

The fullPagePrompt must describe:
1. Panel layout and spatial arrangement (e.g. "3 panels: one wide strip across the top, two equal panels below").
2. What happens visually in each panel — characters, action, setting, lighting, expressions.
3. ALL text content VERBATIM — every speech bubble (with speaker and bubble type), every caption box (with style), every sound effect.
4. Art direction — color palette, lighting mood, atmosphere.

Text limits (critical for AI image rendering):
- Speech bubbles: max 8 words per bubble. Prefer 3-6 words.
- Caption boxes: max 15 words.
- Sound effects: 1-2 words, all caps.

Rules:
- Output only the requested scenes.
- Output exactly the requested number of page objects.
- Keep panel metadata production-ready and concise.
- Non-splash pages should usually have 2-3 panels.
- Preserve continuity with the supplied story bible and prior story setup.
- Do not include commentary, markdown, or any text outside the JSON object.`;

function GRAPHIC_NOVEL_SCENE_PLANNER_USER(childDetails, theme, customDetails, seed, storyBible, chunkSpec) {
  const { name, age, gender } = childDetails;
  const interests = (childDetails.childInterests || childDetails.interests || []).filter(Boolean);
  const pronoun = gender === 'female' ? 'she/her' : gender === 'male' ? 'he/him' : 'they/them';
  const sceneNumbers = (chunkSpec?.scenes || []).map((scene) => scene.sceneNumber);
  const expectedPages = Number(chunkSpec?.expectedPages) || 0;
  const scenePageBudgets = (chunkSpec?.scenes || [])
    .map((scene) => `scene ${scene.sceneNumber}: ${Math.max(2, Number(scene.pageCountTarget) || 0)} pages`)
    .join(', ');
  const splashRequirement = (chunkSpec?.scenes || [])
    .filter((scene) => scene.sceneNumber === 6 || scene.sceneNumber === 7)
    .map((scene) => `scene ${scene.sceneNumber}: exactly 1 splash page`)
    .join(', ') || 'no splash pages in this chunk';

  return `Create only one chunk of the full production script for a personalized middle-grade graphic novel.

PROTAGONIST: ${name}, age ${age}, ${pronoun}
${interests.length ? `INTERESTS: ${interests.join(', ')}` : ''}
THEME: ${theme || 'adventure'}
CUSTOM DETAILS: ${customDetails || 'none'}
STORY SEED: ${JSON.stringify(seed || {}, null, 2)}
STORY BIBLE CHUNK: ${JSON.stringify(storyBible || {}, null, 2)}

REQUESTED SCENES: ${sceneNumbers.join(', ')}
EXACT PAGE COUNT FOR THIS CHUNK: ${expectedPages}
SCENE PAGE BUDGETS: ${scenePageBudgets}
SPLASH REQUIREMENT: ${splashRequirement}

Return a JSON object:
{
  "title": "Must include ${name}'s name",
  "tagline": "Back-cover line",
  "pages": [
    {
      "pageNumber": 1,
      "sceneNumber": ${sceneNumbers[0] || 1},
      "sceneTitle": "scene title",
      "pagePurpose": "what this page is doing dramatically",
      "pageTurnIntent": "setup|reveal|joke|threat|wonder|question|release|cliffhanger",
      "dominantBeat": "the one beat that should dominate the page",
      "layoutTemplate": "cinematicTopStrip|heroTopTwoBottom|twoTierEqual|conversationGrid|fourGrid|fullBleedSplash",
      "panelCount": 2,
      "textDensity": "silent|light|medium",
      "colorScript": { "paletteId": "short id", "dominantHue": "ember orange", "contrastMode": "graphicHighContrast" },
      "fullPagePrompt": "A detailed description of the COMPLETE comic page as a single image. Describe panel layout, what happens in each panel, ALL speech bubbles with exact text, ALL captions with exact text, ALL sound effects. This is sent to an AI image generator to render the entire page.",
      "panels": [
        {
          "sceneNumber": ${sceneNumbers[0] || 1},
          "panelNumber": 1,
          "panelType": "dialogue|action|reaction|closeup|establishing|insert|splash",
          "shot": "WS|MS|MCU|CU",
          "cameraAngle": "eye-level|low-angle|high-angle|over-shoulder|profile|dutch",
          "pacing": "slow|medium|fast",
          "actingNotes": "concrete expression/gesture note",
          "backgroundComplexity": "minimal|simple|medium",
          "action": "What the reader sees happen",
          "balloons": [{ "type": "speech", "speaker": "${name}", "text": "max 8 words", "order": 1 }],
          "captions": [{ "type": "narration", "text": "max 15 words" }],
          "sfx": [{ "text": "WHOOM", "style": "impact" }]
        }
      ]
    }
  ]
}

Rules:
- Return exactly ${expectedPages} pages.
- Return only scenes ${sceneNumbers.join(', ')}.
- Follow the page/panel schema above for every page in the chunk.
- Every page must include a non-empty panels array.
- CRITICAL: Every page MUST include a non-empty fullPagePrompt string with ALL text verbatim.
- Keep speech bubble text to max 8 words. Keep caption text to max 15 words.
- Describe panel layout spatially in fullPagePrompt (top/bottom/left/right).
- Keep scene/page continuity coherent inside this chunk.
- Do not include any pages from other scenes.
- Do not return an outline or summaries instead of pages.`;
}

module.exports = {
  GRAPHIC_NOVEL_PLANNER_SYSTEM,
  GRAPHIC_NOVEL_STORY_BIBLE_SYSTEM,
  GRAPHIC_NOVEL_STORY_BIBLE_USER,
  GRAPHIC_NOVEL_PLANNER_USER,
  GRAPHIC_NOVEL_SCENE_PLANNER_SYSTEM,
  GRAPHIC_NOVEL_SCENE_PLANNER_USER,
};
