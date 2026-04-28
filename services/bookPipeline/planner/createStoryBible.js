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

const SYSTEM_PROMPT = `You are a senior children's picture-book story architect.
You design the narrative spine for a premium personalized book, not the final prose.

Hard rules:
- Optimize for fun read-aloud quality first, emotional payoff, personalization, and visual richness.
- Funny, playful tone, character-based humor. Never preachy.
- Soft but meaningful emotional range. Cinematic but clearly child-safe adventure.
- Push toward memorable, spectacular, paintable locations. Never let the book live mostly inside a house.
${PLANNER_CREATIVE_BAR}
- **One connected adventure (critical):** the book must read as a single through-line — cause, quest, or discovery that pulls the hero from place to place. New settings are welcome and must feel spectacular, not like random stock backdrops. Every major location change should answer "what story reason brought us here?" (following a map, chasing a clue, helping a friend, the next riddle, the same storm breaking, a companion leading onward, etc.). Avoid "theme park" jumps with no bridge.
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

  return [
    `Child: ${brief.child.name}, age ${brief.child.age}, gender ${brief.child.gender}.`,
    `Format: ${request.format}. Age band: ${request.ageBand}. Theme: ${request.theme}.`,
    `Approved cover title: "${cover.title}".`,
    themeBlock,
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
  "locationStrategy": "one sentence: travel spine across at least 4 visually distinct, spectacular, film-style places (light + materials + scale or wonder)",
  "visualJourneySpine": "2-4 sentences: the causal thread that connects those places into ONE story — the mission, object, quest, or escalation that justifies each move. Make the chain clear enough that spread-to-spread transitions feel earned, not random.",
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
