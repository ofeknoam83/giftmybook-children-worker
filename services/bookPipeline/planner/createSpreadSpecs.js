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
  renderPersonalizationSnapshotForPlanner,
} = require('./personalizationSnapshot');

const PARENT_THEMES = new Set(['mothers_day', 'fathers_day', 'grandparents_day']);
const PARENT_VISIBILITY_VALUES = new Set([
  'full', 'hand', 'shoulder-back', 'cropped-torso', 'shadow', 'object', 'absent',
]);

const SYSTEM_PROMPT = `You design spread-level contracts for a premium personalized children's book.

Hard rules:
- Produce exactly ${TOTAL_SPREADS} spread specs. Do not merge or skip.
- **Variety + connection:** the book must travel across at least 4 visually distinct, photogenic places — but those places must feel like **one connected journey**, not a slideshow. Honor \`storyBible.visualJourneySpine\` and \`storyBible.recurringVisualMotifs\` when you pick \`location\` and \`focalAction\`. Each spread after the first should have a clear story reason to exist where it is (discovery, following, escalation, return, echo of an earlier beat). Avoid unmotivated "teleport" jumps.
- **continuityAnchors (required substance):** for spread 1, name motifs or props you will reuse later — **prefer** anchors from the PERSONALIZATION SNAPSHOT (interests/questionnaire objects, named colors, props from custom details). For spreads 2–${TOTAL_SPREADS}, include at least one anchor that explicitly ties to an earlier spread (same object, same companion beat, same weather thread, **or** a personalization callback such as a scarf color, snack tin, toy from interests, **or** optionally a light/glow thread **only** if the bible already established it from the brief — do not assume a "light trail" is the default thread). Empty continuityAnchors on spreads 2+ is a failure.
- **sceneBridge:** for spread 1, one line launching the quest/world. For spreads 2–${TOTAL_SPREADS}, one short sentence: how this beat follows the previous spread and what it hands off to the next (cause → effect, question → answer, problem → try).
- The child hero appears in almost every spread. Outfit stays locked to the cover unless the brief justifies change.
- Text usually lives on one side; no text line may cross the horizontal center. Alternate sides where possible.
- Each spread has ONE clear focal action, even when the world behind it is rich.
- Use the PERSONALIZATION SNAPSHOT, storyBible personalizationTargets, and customDetails concretely across the book — invent **different** focal images per spread; repeat ideas only when continuityAnchors call for a callback.
- No preachy moments. No generic "day at the park" fallback unless the brief demands it.
- Return ONLY strict JSON matching the user-message schema.`;

function userPrompt(doc) {
  const { storyBible, visualBible, brief, request } = doc;
  const retries = selectRetryMemory(doc.retryMemory, 'spreadSpecs');
  const retryBlock = renderRetryMemoryForPrompt(retries);
  const themeBlock = renderThemeDirectiveBlock(request.theme);
  const lineTarget = TEXT_LINE_TARGET[request.ageBand] || { min: 2, max: 4 };
  const isParentTheme = PARENT_THEMES.has(String(request.theme || ''));
  const coverParentPresent = brief?.coverParentPresent === true;

  const customDetailsBlock = Object.entries(brief.customDetails || {})
    .filter(([, v]) => v != null && String(v).trim())
    .map(([k, v]) => `  - ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n') || '  (none)';

  const personalizationBlock = renderPersonalizationSnapshotForPlanner(brief.child, brief.customDetails || {});

  return [
    `Child: ${brief.child.name}, age ${brief.child.age}. Age band: ${request.ageBand}. Format: ${request.format}.`,
    `Theme: ${request.theme}.`,
    themeBlock,
    personalizationBlock,
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
      "sceneBridge": "spread 1: one line that launches the journey | spreads 2-13: one line that bridges from the prior spread to this one (causal, emotional, or prop-based)",
      "continuityAnchors": ["elements from earlier spreads that must persist — spreads 2+ must include at least one explicit callback"],${isParentTheme ? `
      "parentVisibility": "full | hand | shoulder-back | cropped-torso | shadow | object | absent — see PARENT-VISIBILITY POLICY below",` : ''}
      "qaTargets": ["things QA should specifically verify on this spread"],
      "forbiddenMistakes": ["things this spread must not do (include 'unmotivated location change' for any spread that would otherwise teleport)"]
    }
  ]
}`,
    retryBlock ? `\n${retryBlock}` : '',
    isParentTheme
      ? `PARENT-VISIBILITY POLICY (parent themes only — every spread MUST have a parentVisibility value):
  - 'full' = render the parent fully visible (face + body), identical to the cover identity. Only valid when the parent IS on the approved cover (this book: ${coverParentPresent ? 'YES, parent IS on cover — full is allowed' : 'NO, parent is NOT on cover — do NOT use full'}).
  - 'hand' = a hand or forearm entering frame, sleeve continuing to a believable off-frame body anchor. No face, no full body.
  - 'shoulder-back' = parent shown from behind or from a cropped shoulder, face turned away or out of frame.
  - 'cropped-torso' = chest-down view, face out of frame, body anchored in scene.
  - 'shadow' = parent shown only as a shadow on a wall or a reflection in a window/water. No body in direct view.
  - 'object' = an empty chair, a coat on a hook, a still-warm mug, a folded blanket — parent is not in frame; their presence is implied by what they left behind.
  - 'absent' = the child is alone in the frame (the one permitted solo-prep beat — preparing a surprise, picking a flower secretly). The spread is still ABOUT the parent, but the parent is not in this image.
  Distribution rule: vary parentVisibility across the book so the composition doesn't repeat. ${coverParentPresent
    ? 'Since the parent IS on the cover, use \\\'full\\\' on roughly 30-40% of spreads (especially spreads 1, 7, and the climax spreads), and vary the rest across the implied palette. The QUIETEST peak beat (the BOND-PEAK image-led wonder moment per qualityBar item #3) is often best as \\\'shadow\\\' so silhouettes overlap.'
    : 'Since the parent is NOT on the cover, NEVER use \\\'full\\\'. Vary the implied values across the book: lots of \\\'hand\\\' and \\\'shoulder-back\\\' for active beats, \\\'shadow\\\' for the QUIETEST peak beat, \\\'object\\\' for tender afterglow, optional \\\'absent\\\' for one solo-prep beat.'}`
      : '',
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

  const isParentTheme = PARENT_THEMES.has(String(doc?.request?.theme || ''));
  const coverParentPresent = doc?.brief?.coverParentPresent === true;

  const arr = Array.isArray(result.json?.spreads) ? result.json.spreads : [];
  let next = doc;
  for (const rawSpec of arr) {
    const spreadNumber = Number(rawSpec?.spreadNumber);
    if (!Number.isFinite(spreadNumber) || spreadNumber < 1 || spreadNumber > TOTAL_SPREADS) continue;
    let parentVisibility = null;
    if (isParentTheme) {
      const v = typeof rawSpec.parentVisibility === 'string' ? rawSpec.parentVisibility.trim() : '';
      if (PARENT_VISIBILITY_VALUES.has(v)) {
        parentVisibility = v;
        // Safety: 'full' is only valid when the parent IS on the cover.
        // If the LLM ignored that constraint, demote silently rather than letting
        // a face appear interior on an off-cover-parent book (illustrator policy
        // would reject it later, costing a regen).
        if (parentVisibility === 'full' && !coverParentPresent) parentVisibility = 'shoulder-back';
      } else {
        // Deterministic fallback when LLM omits or returns junk. Pattern keeps
        // composition rhythm varied across the 13 spreads and concentrates 'full'
        // (when allowed) on opening/peak/closing beats.
        parentVisibility = defaultParentVisibilityForSpread(spreadNumber, coverParentPresent);
      }
    }
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
      parentVisibility,
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

/**
 * Default parentVisibility per spread when the LLM omits one.
 *
 * The pattern aims for varied composition with 'full' (when the parent is on
 * cover) concentrated on opening / mission-arrival / climax / closing beats,
 * 'shadow' on the quiet wonder beat, and a mix of 'hand' / 'shoulder-back' /
 * 'object' across the rest.
 *
 * @param {number} spreadNumber 1-based
 * @param {boolean} coverParentPresent — 'full' is suppressed when false
 * @returns {'full'|'hand'|'shoulder-back'|'cropped-torso'|'shadow'|'object'}
 */
function defaultParentVisibilityForSpread(spreadNumber, coverParentPresent) {
  // Map 1-13 → composition role.
  const onCoverPattern = {
    1: 'full',          // morning ritual at home
    2: 'full',          // setting out together
    3: 'shoulder-back', // walking, child noticing
    4: 'full',          // small hitch — both characters react
    5: 'hand',          // pivot together — hands at work
    6: 'shoulder-back', // bond-mirror beat
    7: 'full',          // destination reached
    8: 'shadow',        // BOND PEAK — quiet recognition, image-led
    9: 'hand',          // child leads back
    10: 'full',         // the giving / reveal
    11: 'full',         // parent's face changes
    12: 'full',         // together in afterglow
    13: 'full',         // echo transformed
  };
  const offCoverPattern = {
    1: 'shoulder-back',
    2: 'hand',
    3: 'shoulder-back',
    4: 'cropped-torso',
    5: 'hand',
    6: 'shoulder-back',
    7: 'cropped-torso',
    8: 'shadow',        // BOND PEAK — silhouettes overlapping
    9: 'hand',
    10: 'cropped-torso',
    11: 'cropped-torso',
    12: 'object',
    13: 'shoulder-back',
  };
  const pattern = coverParentPresent ? onCoverPattern : offCoverPattern;
  return pattern[spreadNumber] || (coverParentPresent ? 'full' : 'shoulder-back');
}

module.exports = { createSpreadSpecs };
