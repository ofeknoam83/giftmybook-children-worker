/**
 * Spread specs planner.
 *
 * Produces exactly TOTAL_SPREADS spread-level contracts. Each contract tells
 * the writer what to write and tells the illustrator what the picture must
 * show, without writing final prose or final render prompts.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS, TOTAL_SPREADS, TEXT_LINE_TARGET } = require('../constants');
const { updateSpread, appendLlmCall } = require('../schema/bookDocument');
const { selectRetryMemory, renderRetryMemoryForPrompt } = require('../retryMemory');
const { renderThemeDirectiveBlock } = require('./themeDirectives');
const {
  PLANNER_CREATIVE_BAR,
  formatQuestionnaireBlock,
  renderVarietySteeringFromBookId,
} = require('./plannerPromptHelpers');
const { PARENT_DAY_THEMES } = require('./spreadLocationAudit');

const SYSTEM_PROMPT = `You design spread-level contracts for a premium personalized children's book.

Hard rules:
- Produce exactly ${TOTAL_SPREADS} spread specs. Do not merge or skip.
${PLANNER_CREATIVE_BAR}
- **Variety + connection:** the book must travel across at least 4 visually distinct, **spectacular** places (film-style locations: light, materials, scale or wonder) — one connected journey, not a slideshow. Honor \`storyBible.visualJourneySpine\` and \`storyBible.recurringVisualMotifs\` when you pick \`location\` and \`focalAction\`. Each spread after the first should have a clear story reason to exist where it is (discovery, following, escalation, return, echo of an earlier beat). Avoid unmotivated "teleport" jumps.
- **Arc:** purpose progression must build toward a real **peak** spread (surprise, funniest moment, or biggest wonder) — not a flat chain of equally mild beats.
- **continuityAnchors (required substance):** for spread 1, name motifs or props you will reuse later. For spreads 2–${TOTAL_SPREADS}, include at least one anchor that explicitly ties to an earlier spread (same object, same companion beat, same weather/light thread, or a callback location-type). Empty continuityAnchors on spreads 2+ is a failure.
- **sceneBridge:** for spread 1, one line launching the quest/world. For spreads 2–${TOTAL_SPREADS}, one short sentence: how this beat follows the previous spread and what it hands off to the next (cause → effect, question → answer, problem → try).
- The child hero appears in almost every spread. Outfit stays locked to the cover unless the brief justifies change.
- Text usually lives on one side; no text line may cross the horizontal center. Alternate sides where possible.
- Each spread has ONE clear focal action, even when the world behind it is rich.
- Use the storyBible's personalizationTargets, parent questionnaire, and the brief's customDetails concretely across the book.
- No preachy moments. No generic "day at the park" fallback unless the brief demands it.
- Return ONLY strict JSON matching the user-message schema.`;

function userPrompt(doc) {
  const { storyBible, visualBible, brief, request } = doc;
  const retries = selectRetryMemory(doc.retryMemory, 'spreadSpecs');
  const retryBlock = renderRetryMemoryForPrompt(retries);
  const themeBlock = renderThemeDirectiveBlock(request.theme);
  const lineTarget = TEXT_LINE_TARGET[request.ageBand] || { min: 2, max: 4 };

  const customDetailsBlock = Object.entries(brief.customDetails || {})
    .filter(([, v]) => v != null && String(v).trim())
    .map(([k, v]) => `  - ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n') || '  (none)';

  const questionnaireBlock = formatQuestionnaireBlock(brief.child);
  const varietyBlock = renderVarietySteeringFromBookId(request.bookId);
  const parentDay = PARENT_DAY_THEMES.has(String(request.theme || '').toLowerCase());
  const parentDayLocationContract = parentDay
    ? [
      '',
      'PARENT-DAY LOCATION CONTRACT (critical):',
      '- At most **4** spreads may use realistic home interiors (kitchen, couch, hallway, bedroom, nursery) in the `location` field.',
      '- **All other spreads** MUST use outward, cinematic set pieces from the theme directive (e.g. lantern pier, floating market, greenhouse, festival gate, harbor, rooftop garden, meadow stage, tidepool walk, public plaza) — even when the story bible or seed mentions flour, baking, or couch; **translate** that beat to a paintable exterior or magical public venue while keeping the same emotional beat and props (spoon, crumbs, timer can appear anywhere).',
      '- Pipeline validation allows at most **5** home-interior spreads total (non-bedtime). Plan so the writer can depict **beautiful, varied** places; do not rely on the writer to fix a house crawl.',
    ].join('\n')
    : '';

  return [
    `Child: ${brief.child.name}, age ${brief.child.age}. Age band: ${request.ageBand}. Format: ${request.format}.`,
    `Theme: ${request.theme}.`,
    themeBlock,
    parentDayLocationContract,
    request.format === 'picture_book'
      ? `Target rendered lines per spread: EXACTLY 4 (picture-book format is locked to 4 lines per spread, AABB rhyming couplets). Set textLineTarget to 4 on every spread.`
      : `Target rendered lines per spread: ${lineTarget.min}-${lineTarget.max}.`,
    '',
    `Story bible:\n${JSON.stringify(storyBible, null, 2)}`,
    '',
    `Visual bible (condensed):\n${JSON.stringify({
      hero: visualBible.hero,
      supportingCastPolicy: visualBible.supportingCastPolicy,
      supportingCast: visualBible.supportingCast,
      environmentAnchors: visualBible.environmentAnchors,
      compositionRules: visualBible.compositionRules,
      textRenderingRules: visualBible.textRenderingRules,
      prohibitedVisualDrift: visualBible.prohibitedVisualDrift,
    }, null, 2)}`,
    '',
    'Parent questionnaire:',
    questionnaireBlock,
    '',
    `Custom details:\n${customDetailsBlock}`,
    '',
    varietyBlock,
    '',
    'Return JSON with this exact shape (array of length 13):',
    `{
  "spreads": [
    {
      "spreadNumber": 1,
      "purpose": "hook | discovery | rising | deeper | heart | turn | peak | aftermath | resolution | new_world | warm_glow | reflection | last_line",
      "plotBeat": "one sentence: what happens in the story here",
      "emotionalBeat": "one short phrase: the feeling",
      "humorBeat": "one short phrase or null",
      "location": "film-style specific location: place name + light + materials + scale or wonder (not 'a park' or 'backyard' alone unless brief names it — add differentiator)",
      "focalAction": "one sentence: what the reader's eye locks onto",
      "cameraIntent": "one phrase: e.g. wide low-angle, intimate close, over-shoulder tracking",
      "textSide": "left|right",
      "textLineTarget": ${Math.round((lineTarget.min + lineTarget.max) / 2)},
      "mustUseDetails": ["custom-detail keys this spread must land"],
      "sceneBridge": "spread 1: one line that launches the journey | spreads 2-13: one line that bridges from the prior spread to this one (causal, emotional, or prop-based)",
      "continuityAnchors": ["elements from earlier spreads that must persist — spreads 2+ must include at least one explicit callback"],
      "qaTargets": ["things QA should specifically verify on this spread"],
      "forbiddenMistakes": ["things this spread must not do (include 'unmotivated location change' for any spread that would otherwise teleport)"]
    }
  ]
}`,
    retryBlock ? `\n${retryBlock}` : '',
    `Rules for textSide: alternate left/right across the book, avoiding more than 2 consecutive same-side spreads.`,
    'Emit the JSON now.',
  ].filter(Boolean).join('\n');
}

/**
 * @param {object} doc
 * @returns {Promise<object>}
 */
async function createSpreadSpecs(doc) {
  const result = await callText({
    model: MODELS.SPREAD_SPECS,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPrompt(doc),
    jsonMode: true,
    temperature: 0.9,
    maxTokens: 8000,
    label: 'spreadSpecs',
    abortSignal: doc.operationalContext?.abortSignal,
  });

  const arr = Array.isArray(result.json?.spreads) ? result.json.spreads : [];
  let next = doc;
  for (const rawSpec of arr) {
    const spreadNumber = Number(rawSpec?.spreadNumber);
    if (!Number.isFinite(spreadNumber) || spreadNumber < 1 || spreadNumber > TOTAL_SPREADS) continue;
    const spec = {
      purpose: String(rawSpec.purpose || '').trim(),
      plotBeat: String(rawSpec.plotBeat || '').trim(),
      emotionalBeat: String(rawSpec.emotionalBeat || '').trim(),
      humorBeat: rawSpec.humorBeat ? String(rawSpec.humorBeat).trim() : null,
      location: String(rawSpec.location || '').trim(),
      focalAction: String(rawSpec.focalAction || '').trim(),
      cameraIntent: String(rawSpec.cameraIntent || '').trim(),
      textSide: rawSpec.textSide === 'left' ? 'left' : 'right',
      textLineTarget: Number.isFinite(Number(rawSpec.textLineTarget)) ? Number(rawSpec.textLineTarget) : 3,
      mustUseDetails: Array.isArray(rawSpec.mustUseDetails) ? rawSpec.mustUseDetails.map(String) : [],
      sceneBridge: String(rawSpec.sceneBridge || '').trim(),
      continuityAnchors: Array.isArray(rawSpec.continuityAnchors) ? rawSpec.continuityAnchors.map(String) : [],
      qaTargets: Array.isArray(rawSpec.qaTargets) ? rawSpec.qaTargets.map(String) : [],
      forbiddenMistakes: Array.isArray(rawSpec.forbiddenMistakes) ? rawSpec.forbiddenMistakes.map(String) : [],
    };
    next = updateSpread(next, spreadNumber, s => ({ ...s, spec }));
  }

  return appendLlmCall(next, {
    stage: 'spreadSpecs',
    model: result.model,
    attempts: result.attempts,
    usage: result.usage,
  });
}

module.exports = { createSpreadSpecs };
