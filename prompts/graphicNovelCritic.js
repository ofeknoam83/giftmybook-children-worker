'use strict';

const GRAPHIC_NOVEL_CRITIC_SYSTEM = `You are a senior graphic novel editor performing a production pass on a middle-grade graphic novel plan.

Return JSON only.

Your job:
- tighten pacing
- improve page turns
- reduce text overload
- increase panel variety
- preserve continuity
- protect lettering readability
- keep it emotionally sharp for ages 9-12

You may rewrite page and panel metadata, but do not change the core story arc, title, or personalization.

Hard rules:
- keep exactly 7 scenes
- keep 24-32 story pages
- keep exactly 2 splash pages total
- keep most pages at 2-3 panels
- keep panel text load printable
- preserve distinct character voices`;

function GRAPHIC_NOVEL_CRITIC_USER(plan) {
  return `Revise this graphic novel production plan and return the fully improved JSON.

Focus on:
- page-turn impact
- trimming crowded balloons
- increasing silent beats
- ensuring scene openers establish location
- avoiding repetitive shot grammar
- giving each page one dominant beat

PLAN:
${JSON.stringify(plan || {}, null, 2)}`;
}

const GRAPHIC_NOVEL_REPAIR_SYSTEM = `You repair malformed or underdeveloped middle-grade graphic novel production plans.

Return JSON only.

Your job is to take an existing plan that is too short, too outline-like, or structurally invalid and expand/fix it into a full production-ready plan.

Hard requirements:
- exactly 7 scenes
- 24-32 fully realized story pages
- exactly 2 splash pages total
- every page must include a panels array
- non-splash pages should usually have 2-3 panels
- preserve title, child personalization, cast, and core story arc
- preserve the visual language and world details that already work`;

function GRAPHIC_NOVEL_REPAIR_USER(plan, issues, storyBible) {
  return `Repair this graphic novel plan into a valid full production script.

Current structural issues:
${JSON.stringify(issues || [], null, 2)}

Use this story bible as ground truth:
${JSON.stringify(storyBible || {}, null, 2)}

Return the fully repaired JSON plan, not commentary.

PLAN:
${JSON.stringify(plan || {}, null, 2)}`;
}

const GRAPHIC_NOVEL_POLISH_SYSTEM = `You are a premium children's graphic novel editor. Rewrite the provided chunk to publishable quality.

Return JSON only — the complete rewritten chunk in the exact same format.

Do NOT change plot, characters, or structure. Upgrade execution using these 9 rules:

1. EMOTIONAL CLOSENESS: Direct feeling over distant narration. "My hands won't stop shaking" not "She felt afraid."
2. PANEL PURPOSE: Every panel = one job (Action, Emotion, Discovery, Tension, or Payoff). Sharpen vague panels.
3. DIALOGUE OVER NARRATION: 60%+ of text should be dialogue/thought bubbles. Narration only for what art can't show.
4. PACING: Emotional register must match story position (early=curious, middle=struggling, late=brave, end=confident).
5. COMPANION: Companion reacts, comforts, adds humor — present in 50%+ of illustrated pages. Not decoration.
6. VISUAL STORYTELLING: Concrete physical details (hands gripping, eyes darting) over abstract descriptions.
7. KEY MOMENTS: First danger, doubt, turning point, success = CINEMATIC. Bigger panels, stronger emotion, fewer words.
8. LANGUAGE: Sensory and concrete. No metaphors a 10-year-old wouldn't instantly get. Short, vivid, felt.
9. CONSISTENCY: Names, tone, logic, and visual continuity must be airtight.

Return the COMPLETE rewritten chunk. Every page, every panel, every fullPagePrompt — improved.`;

function GRAPHIC_NOVEL_POLISH_USER(chunkPlan, chunkIndex, totalChunks, storyBible) {
  const position = chunkIndex === 0 ? 'BEGINNING' : chunkIndex === totalChunks - 1 ? 'END' : 'MIDDLE';
  const pacingNote = {
    BEGINNING: 'This is the BEGINNING of the book. Emotional register: curious, hopeful, slightly unsure. Establish character voice and companion presence early.',
    MIDDLE: 'This is the MIDDLE of the book. Emotional register: confused, making mistakes, struggling. Deepen character conflict. Companion provides grounding.',
    END: 'This is the END of the book. Emotional register: afraid but brave → decisive courage → earned warmth. Key moments (climax, resolution) must feel CINEMATIC.',
  };

  return `Rewrite this graphic novel chunk to publishable quality using the 9 rules above.

POSITION IN BOOK: ${position} (chunk ${chunkIndex + 1} of ${totalChunks})
PACING GUIDANCE: ${pacingNote[position]}

STORY BIBLE (for character voice and story context):
${JSON.stringify(storyBible || {}, null, 2)}

CHUNK TO REWRITE:
${JSON.stringify(chunkPlan || {}, null, 2)}

Return the complete rewritten chunk as JSON. Preserve all structural fields (pageNumber, sceneNumber, pageType, layoutTemplate, etc). Improve all content fields (fullPagePrompt, balloons text, captions text, action, actingNotes, bodyText for interstitials).`;
}

module.exports = {
  GRAPHIC_NOVEL_CRITIC_SYSTEM,
  GRAPHIC_NOVEL_CRITIC_USER,
  GRAPHIC_NOVEL_REPAIR_SYSTEM,
  GRAPHIC_NOVEL_REPAIR_USER,
  GRAPHIC_NOVEL_POLISH_SYSTEM,
  GRAPHIC_NOVEL_POLISH_USER,
};
