/**
 * Story bible planner.
 *
 * Produces the book's narrative spine before any spread-level writing or
 * illustration. Optimizes for read-aloud delight, memorable personalization,
 * cinematic-but-safe adventure, and a concrete ending. Uses OpenAI with
 * strict JSON output.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS } = require('../constants');
const { appendLlmCall, withStageResult } = require('../schema/bookDocument');
const { selectRetryMemory, renderRetryMemoryForPrompt } = require('../retryMemory');
const { renderThemeDirectiveBlock } = require('./themeDirectives');
const {
  PLANNER_CREATIVE_BAR,
  formatQuestionnaireBlock,
  renderVarietySteeringFromBookId,
} = require('./plannerPromptHelpers');
const { PARENT_DAY_THEMES } = require('./spreadLocationAudit');

const SYSTEM_PROMPT = `You are a senior children's picture-book story architect.
You design the narrative spine for a premium personalized book, not the final prose.

Hard rules:
- Optimize for fun read-aloud quality first, emotional payoff, personalization, and visual richness.
- Funny, playful tone, character-based humor. Never preachy.
- Soft but meaningful emotional range. Cinematic but clearly child-safe adventure.
- Push toward memorable, spectacular, paintable locations. Never let the book live mostly inside a house.
${PLANNER_CREATIVE_BAR}
- **One connected adventure (critical):** the book must read as a single through-line — **one outing, quest, vehicle, or mystery** that pulls the hero along. New zones are welcome when they are **legs of that same journey** (next stop on the line, next courtyard of the festival, next bend of the harbor walk), not a new unrelated biome every spread. Every major location change must answer "what story reason brought us here?" Avoid **theme-park roulette** and **questionnaire collage** (each spread a fresh spectacle only to showcase another answer). Prefer fewer anchor worlds **deepened** over many one-off backdrops.
- **Recurring visual motifs:** name 3-5 concrete things that can reappear in the art (carried object, weather thread, signature color accent, sound made visible, etc.) so interiors feel threaded — obey the grounding rule above (at least one motif from real questionnaire/custom-detail nouns).
- The hero is the child provided in the brief. The approved cover is already chosen; the cover locks the hero's look and outfit.
- Do not invent named family members that are not in the brief. Do not turn the child into a stand-in for any family member.
- Return ONLY strict JSON matching the schema in the user message.`;

function userPrompt(doc) {
  const { brief, cover, request } = doc;
  const retries = selectRetryMemory(doc.retryMemory, 'storyBible');
  const retryBlock = renderRetryMemoryForPrompt(retries);
  const themeBlock = renderThemeDirectiveBlock(request.theme);

  const customDetailsBlock = Object.entries(brief.customDetails || {})
    .filter(([, v]) => v != null && String(v).trim())
    .map(([k, v]) => `  - ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n') || '  (none)';

  const questionnaireBlock = formatQuestionnaireBlock(brief.child);
  const varietyBlock = renderVarietySteeringFromBookId(request.bookId);
  const parentDay = PARENT_DAY_THEMES.has(String(request.theme || '').toLowerCase());
  const parentDaySpine = parentDay
    ? [
      '',
      'PARENT-DAY SPINE: `locationStrategy` and `visualJourneySpine` must center on a **shared outward quest** (spectacular public or magical places). At most one short home act; do not plan a book that lives in kitchen/couch/hall. If custom details mention baking, translate to festival bakery row, harbor treat boat, rooftop garden oven, etc.',
    ].join('\n')
    : '';

  return [
    `Child: ${brief.child.name}, age ${brief.child.age}, gender ${brief.child.gender}.`,
    `Format: ${request.format}. Age band: ${request.ageBand}. Theme: ${request.theme}.`,
    `Approved cover title: "${cover.title}".`,
    themeBlock,
    parentDaySpine,
    'Parent questionnaire (every non-empty line must influence personalizationTargets or the emotional payoff — not replace the adventure spine):',
    questionnaireBlock,
    '',
    `Custom details (must be used concretely unless they hurt the story):`,
    customDetailsBlock,
    '',
    varietyBlock,
    '',
    'Return JSON with this exact shape:',
    `{
  "narrativeSpine": "one sentence that names what the book is really about",
  "beginningHook": "one sentence: the opening beat that grabs a child",
  "middleEscalation": "one sentence: how stakes, curiosity, or scale grow toward a peak — include at least one kid-safe surprise or reversal (not only another nice moment)",
  "endingPayoff": "one sentence: the concrete, specific ending that parents remember",
  "emotionalArc": "one sentence: the emotional spine from start to finish",
  "humorStrategy": "one sentence: the comedic engine (e.g. literal-minded sidekick, hero misreads the world)",
  "themeGuidance": "one sentence: how ${request.theme} shows up without being on-the-nose",
  "personalizationTargets": ["3-6 specific custom-detail hooks the book must use"],
  "locationStrategy": "one sentence: name the **small set of anchor venue families** (ideally 2–3) and how the book moves among them; at least 4 **spectacular** beats can be different **zones or times** within those anchors (same festival, same waterfront, same excursion route) — not 13 unrelated tourist stops",
  "visualJourneySpine": "2-4 sentences: the **single causal thread** (mission, object, vehicle, event, or mystery) that earns every move. State the through-line by name so spread specs cannot devolve into random set pieces. Transitions must feel like **consequences or continuations**, not teleportation.",
  "recurringVisualMotifs": ["3-5 concrete, art-friendly motifs — at least one MUST cite a real noun from questionnaire/custom details; avoid default ribbon/lullaby/generic sidekick/light-trail unless brief supports"],
  "forbiddenMoves": ["things this specific book must avoid (generic scenes, bedtime ending, preachiness, etc.)"]
}`,
    retryBlock ? `\n${retryBlock}` : '',
    'Emit the JSON now.',
  ].filter(Boolean).join('\n');
}

/**
 * @param {object} doc
 * @returns {Promise<object>}
 */
async function createStoryBible(doc) {
  const result = await callText({
    model: MODELS.STORY_BIBLE,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPrompt(doc),
    jsonMode: true,
    temperature: 0.9,
    maxTokens: 8000,
    label: 'storyBible',
    abortSignal: doc.operationalContext?.abortSignal,
  });

  const json = result.json || {};
  const storyBible = {
    narrativeSpine: String(json.narrativeSpine || '').trim(),
    beginningHook: String(json.beginningHook || '').trim(),
    middleEscalation: String(json.middleEscalation || '').trim(),
    endingPayoff: String(json.endingPayoff || '').trim(),
    emotionalArc: String(json.emotionalArc || '').trim(),
    humorStrategy: String(json.humorStrategy || '').trim(),
    themeGuidance: String(json.themeGuidance || '').trim(),
    personalizationTargets: Array.isArray(json.personalizationTargets) ? json.personalizationTargets.map(String) : [],
    locationStrategy: String(json.locationStrategy || '').trim(),
    visualJourneySpine: String(json.visualJourneySpine || '').trim(),
    recurringVisualMotifs: Array.isArray(json.recurringVisualMotifs) ? json.recurringVisualMotifs.map(String) : [],
    forbiddenMoves: Array.isArray(json.forbiddenMoves) ? json.forbiddenMoves.map(String) : [],
  };

  const traced = appendLlmCall(doc, {
    stage: 'storyBible',
    model: result.model,
    attempts: result.attempts,
    usage: result.usage,
  });
  return withStageResult(traced, { storyBible });
}

module.exports = { createStoryBible };
