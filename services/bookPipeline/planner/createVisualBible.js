/**
 * Visual bible planner.
 *
 * Takes the approved cover plus the storyBible and produces a reusable
 * visual contract for the whole book. Defines the hero's hard locks, how
 * supporting cast may be introduced, style rules, composition rules, and
 * the text rendering rules used by every spread.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS, VISUAL_STYLE, TEXT_PLACEMENT } = require('../constants');
const { appendLlmCall, withStageResult } = require('../schema/bookDocument');
const { selectRetryMemory, renderRetryMemoryForPrompt } = require('../retryMemory');

const SYSTEM_PROMPT = `You are the art director for a premium personalized children's book.
You do NOT generate spread prompts. You produce a visual contract that every spread must obey.

Hard rules:
- Visual language is locked globally: premium 3D character-driven ("${VISUAL_STYLE}"), warm cinematic lighting, materials with weight.
- The approved cover is the hard anchor for hero identity, face, body, hair, and outfit. Do not contradict the cover.
- Interior continuity uses the cover plus accepted interior spreads. No uploaded photo reference.
- Support richer, busier worlds with high camera-angle variety, but keep one clear focal action per spread.
- Text is painted INTO the illustration. Text usually lives on one side of the spread; no single line may cross the horizontal center of the spread.
- Family members NOT shown on the cover may only appear if the brief declares them. Undeclared family members must not be introduced visually.
- Return ONLY strict JSON matching the schema in the user message.`;

function formatCoverLocks(cover) {
  const locks = cover.characterLocks || {};
  const outfit = cover.outfitLocks || {};
  const entries = [];
  if (Object.keys(locks).length) entries.push(`characterLocks: ${JSON.stringify(locks)}`);
  if (Object.keys(outfit).length) entries.push(`outfitLocks: ${JSON.stringify(outfit)}`);
  return entries.join('\n') || '(none explicit — infer from cover title + brief)';
}

function userPrompt(doc) {
  const { brief, cover, storyBible } = doc;
  const retries = selectRetryMemory(doc.retryMemory, 'visualBible');
  const retryBlock = renderRetryMemoryForPrompt(retries);

  return [
    `Child: ${brief.child.name}, age ${brief.child.age}, gender ${brief.child.gender}.`,
    `Approved cover title: "${cover.title}". Cover image URL: ${cover.imageUrl || '(provided as base64 reference)'}.`,
    `Cover locks carried in from input:\n${formatCoverLocks(cover)}`,
    '',
    `Story bible:\n${JSON.stringify(storyBible, null, 2)}`,
    '',
    `Text placement policy: ${TEXT_PLACEMENT.DEFAULT_SIDE_POLICY}; never_cross_center=${TEXT_PLACEMENT.NEVER_CROSS_CENTER}.`,
    '',
    'Return JSON with this exact shape:',
    `{
  "hero": {
    "name": "string",
    "physicalDescription": "precise sentence describing face/hair/body/skin from the cover",
    "outfitDescription": "precise sentence describing cover outfit (locked)",
    "signatureProp": "optional concrete prop that appears across the book or null"
  },
  "outfitLocks": {
    "ruleSummary": "one sentence: how outfits behave across spreads",
    "allowedVariations": ["rare, story-justified additions like a coat or scarf"]
  },
  "supportingCastPolicy": {
    "declaredCast": ["named family members/friends that the brief explicitly provided"],
    "maxIncidentalCharacters": 2,
    "rules": ["planner-guided introductions only, never invent named family members"]
  },
  "supportingCast": [
    { "role": "e.g. mom|dad|sibling|friend|creature", "name": "string or null", "description": "visual description if they may appear" }
  ],
  "environmentAnchors": ["3-6 reusable visual anchors: palette cues, lighting cues, recurring props"],
  "palette": "one sentence about color palette and light logic",
  "styleRules": ["bullets that define the premium 3D Pixar-like look"],
  "compositionRules": ["bullets on focal clarity, camera variety, scale, negative space for text"],
  "textRenderingRules": [
    "text usually on one side of the spread",
    "no single line crosses the horizontal center",
    "near-exact wording from the manuscript; no stray or duplicated text",
    "guided line breaks honor the spread spec"
  ],
  "continuityRules": {
    "hardLocks": ["things that MUST stay identical across all spreads"],
    "softEvolution": ["things that may drift subtly when the story justifies it"]
  },
  "prohibitedVisualDrift": ["mistakes this book must not make (extra family members, wrong outfit, cover-face drift, etc.)"]
}`,
    retryBlock ? `\n${retryBlock}` : '',
    'Emit the JSON now.',
  ].filter(Boolean).join('\n');
}

/**
 * @param {object} doc
 * @returns {Promise<object>}
 */
async function createVisualBible(doc) {
  const result = await callText({
    model: MODELS.PLANNER,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPrompt(doc),
    jsonMode: true,
    temperature: 0.7,
    maxTokens: 4000,
    label: 'visualBible',
    abortSignal: doc.operationalContext?.abortSignal,
  });

  const json = result.json || {};
  const visualBible = {
    hero: json.hero || null,
    outfitLocks: json.outfitLocks || null,
    supportingCastPolicy: json.supportingCastPolicy || null,
    supportingCast: Array.isArray(json.supportingCast) ? json.supportingCast : [],
    environmentAnchors: Array.isArray(json.environmentAnchors) ? json.environmentAnchors.map(String) : [],
    palette: String(json.palette || '').trim(),
    styleRules: Array.isArray(json.styleRules) ? json.styleRules.map(String) : [],
    compositionRules: Array.isArray(json.compositionRules) ? json.compositionRules.map(String) : [],
    textRenderingRules: Array.isArray(json.textRenderingRules) ? json.textRenderingRules.map(String) : [],
    continuityRules: json.continuityRules || null,
    prohibitedVisualDrift: Array.isArray(json.prohibitedVisualDrift) ? json.prohibitedVisualDrift.map(String) : [],
  };

  const traced = appendLlmCall(doc, {
    stage: 'visualBible',
    model: result.model,
    attempts: result.attempts,
    usage: result.usage,
  });
  return withStageResult(traced, { visualBible });
}

module.exports = { createVisualBible };
