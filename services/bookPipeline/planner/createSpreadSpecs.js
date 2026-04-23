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

const SYSTEM_PROMPT = `You design spread-level contracts for a premium personalized children's book.

Hard rules:
- Produce exactly ${TOTAL_SPREADS} spread specs. Do not merge or skip.
- Strong location variety: the book must travel across at least 4 visually distinct, photogenic places.
- The child hero appears in almost every spread. Outfit stays locked to the cover unless the brief justifies change.
- Text usually lives on one side; no text line may cross the horizontal center. Alternate sides where possible.
- Each spread has ONE clear focal action, even when the world behind it is rich.
- Use the storyBible's personalizationTargets and the brief's customDetails concretely across the book.
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

  return [
    `Child: ${brief.child.name}, age ${brief.child.age}. Age band: ${request.ageBand}. Format: ${request.format}.`,
    `Theme: ${request.theme}.`,
    themeBlock,
    `Target rendered lines per spread: ${lineTarget.min}-${lineTarget.max}.`,
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
    `Custom details:\n${customDetailsBlock}`,
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
      "location": "concrete specific location (not 'a park')",
      "focalAction": "one sentence: what the reader's eye locks onto",
      "cameraIntent": "one phrase: e.g. wide low-angle, intimate close, over-shoulder tracking",
      "textSide": "left|right",
      "textLineTarget": ${Math.round((lineTarget.min + lineTarget.max) / 2)},
      "mustUseDetails": ["custom-detail keys this spread must land"],
      "continuityAnchors": ["elements from earlier spreads that must persist"],
      "qaTargets": ["things QA should specifically verify on this spread"],
      "forbiddenMistakes": ["things this spread must not do"]
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
    model: MODELS.PLANNER,
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
