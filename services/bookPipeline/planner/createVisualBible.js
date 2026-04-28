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
const { formatQuestionnaireBlock, renderVarietySteeringFromBookId } = require('./plannerPromptHelpers');

const SYSTEM_PROMPT = `You are the art director for a premium personalized children's book.
You do NOT generate spread prompts. You produce a visual contract that every spread must obey.

Hard rules:
- Visual language is locked globally: premium 3D character-driven ("${VISUAL_STYLE}"), warm cinematic lighting, materials with weight.
- The approved cover is the hard anchor for hero identity, face, body, hair, and outfit. Do not contradict the cover.
- **Spectacle:** environments should feel premium and paintable — favor dramatic light, clear scale, rich materials, and age-safe wonder. Avoid generic flat lighting and "stock suburban default" unless the brief demands it.
- **Narrative visual thread:** read \`storyBible.visualJourneySpine\` and \`storyBible.recurringVisualMotifs\`. The \`environmentAnchors\` and \`palette\` you output MUST weave those motifs in (concrete, repeatable art cues) so the book feels like one journey across varied places — not unrelated wallpapers.
- Interior continuity uses the cover plus accepted interior spreads. No uploaded photo reference.
- Support richer, busier worlds with high camera-angle variety, but keep one clear focal action per spread.
- Text is painted INTO the illustration. Text usually lives on one side of the spread; no single line may cross the horizontal center of the spread.
- CAST VISIBILITY RULE (strict): only characters depicted on the approved cover may appear as FULL FIGURES (full face / full body) in interior spreads. Any other character declared by the brief is a STORY presence only — they may be narrated, voiced, and implied through partial presence (a hand, arm, shoulder, back-of-head, silhouette, distant unfocused figure, or a personal object that stands in for them). They must never be drawn with a full face or full body.
- PARTIAL PRESENCE MUST STAY CONSISTENT: for every off-cover character, produce a "partialPresenceLock" describing exactly how their visible parts look every time they appear (skin tone, hand/arm, sleeve or outfit fragment, and an optional signature item like a ring, bracelet, scarf, or watch). The spread-level prompts will echo this lock, so it must be concrete and reusable.
- SKIN-TONE DEFAULT FOR FAMILY: supporting cast skin tone defaults to plausibly matching the hero on the cover (same family ethnicity). Deviate ONLY if the brief explicitly declares a different ethnicity for that character.
- Undeclared characters never appear, visually or otherwise.
- Return ONLY strict JSON matching the schema in the user message.`;

function formatCoverLocks(cover) {
  const locks = cover.characterLocks || {};
  const outfit = cover.outfitLocks || {};
  const entries = [];
  if (Object.keys(locks).length) entries.push(`characterLocks: ${JSON.stringify(locks)}`);
  if (Object.keys(outfit).length) entries.push(`outfitLocks: ${JSON.stringify(outfit)}`);
  return entries.join('\n') || '(none explicit — infer from cover title + brief)';
}

/**
 * Ensures structured hair continuity across spreads: morphology + verbatim lock line.
 *
 * @param {object} doc
 * @param {object|null} heroJson
 * @returns {object|null}
 */
function normalizeHeroWithHairLock(doc, heroJson) {
  if (!heroJson || typeof heroJson !== 'object') return null;
  const hero = { ...heroJson };
  const fromLlm = hero.hairLock && typeof hero.hairLock === 'object' ? hero.hairLock : {};
  const locks = doc.cover?.characterLocks || {};
  const coverHairBits = [];
  if (typeof locks.hairMorphology === 'string' && locks.hairMorphology.trim()) coverHairBits.push(locks.hairMorphology.trim());
  if (typeof locks.hair === 'string' && locks.hair.trim()) coverHairBits.push(locks.hair.trim());
  if (typeof locks.hairLength === 'string' && locks.hairLength.trim()) coverHairBits.push(`length: ${locks.hairLength.trim()}`);
  const fromCover = coverHairBits.join('; ');

  const morphology = typeof fromLlm.morphology === 'string' ? fromLlm.morphology.trim() : '';
  const lengthClass = typeof fromLlm.lengthClass === 'string' ? fromLlm.lengthClass.trim() : '';
  const accessories = fromLlm.accessories != null ? String(fromLlm.accessories).trim() : '';

  let verbatimLock = typeof fromLlm.verbatimLock === 'string' ? fromLlm.verbatimLock.trim() : '';
  if (!verbatimLock && fromCover) {
    verbatimLock = `Match cover exactly — ${fromCover}`;
  }

  const hairLock = {
    morphology: morphology || null,
    lengthClass: lengthClass || null,
    accessories: accessories || null,
    verbatimLock: verbatimLock || null,
  };

  const hairLockLine = hairLock.verbatimLock
    ? (
      `Hero hair — BOOK LOCK (same morphology, length class, and curl/wave family as BOOK COVER on every spread; wind or motion may tousle strands but MUST NOT swap hair families — e.g. do not switch between tight curls vs straight/spiky silhouettes): ${hairLock.verbatimLock}`
    )
    : '';

  return {
    ...hero,
    hairLock,
    hairLockLine,
  };
}

function userPrompt(doc) {
  const { brief, cover, storyBible, request } = doc;
  const retries = selectRetryMemory(doc.retryMemory, 'visualBible');
  const retryBlock = renderRetryMemoryForPrompt(retries);
  const questionnaireBlock = formatQuestionnaireBlock(brief.child);
  const varietyBlock = renderVarietySteeringFromBookId(request?.bookId);

  return [
    `Child: ${brief.child.name}, age ${brief.child.age}, gender ${brief.child.gender}.`,
    `Approved cover title: "${cover.title}". Cover image URL: ${cover.imageUrl || '(provided as base64 reference)'}.`,
    `Cover locks carried in from input:\n${formatCoverLocks(cover)}`,
    '',
    'Parent questionnaire (for emotional color and grounded props — worlds stay bold):',
    questionnaireBlock,
    '',
    varietyBlock,
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
    "hairLock": {
      "morphology": "concrete phrases that lock hair FAMILY vs the cover — e.g. tight dark curls, straight fine with side part, tousled short spikes, shoulder-length waves (must match BOOK COVER, not approximate)",
      "lengthClass": "short | ear-length | chin | bob | shoulder | past-shoulder | long — must match apparent length on COVER silhouette",
      "accessories": "none | describe visible bows/clips/headbands from cover, or null",
      "verbatimLock": "ONE non-negotiable sentence repeated on every spread prompt — same hair family as cover; must not be vague ('brown hair' alone is invalid)"
    },
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
    "rules": ["planner-guided introductions only, never invent named family members"],
    "castVisibility": "Only characters on the cover appear as full figures. Off-cover declared characters appear only in text and as partial presence (hand, shoulder, back-of-head, silhouette, or a personal object)."
  },
  "supportingCast": [
    {
      "role": "e.g. mom|dad|sibling|friend|creature",
      "name": "string or null",
      "onCover": false,
      "description": "short description for text/voice color; full-figure appearance is forbidden when onCover=false",
      "partialPresenceIdeas": ["a warm hand", "a silhouette in a doorway", "gardening gloves on a bench", "a familiar knitted scarf"],
      "partialPresenceLock": {
        "skinTone": "concrete phrase that is plausible for the hero's family (e.g. 'warm medium, same family as hero', 'fair with pink undertone, matching hero')",
        "hand": "one specific sentence describing the hand/arm (age signals, nails, veins if relevant, finger shape) — reusable every spread",
        "sleeve": "one specific sentence describing a sleeve, cuff or outfit fragment that will always be visible",
        "signatureProp": "one small reusable accessory that always appears with the partial presence (ring, bracelet, watch, scarf color) — or null"
      }
    }
  ],
  "environmentAnchors": ["3-6 reusable visual anchors: palette cues, lighting cues, recurring props"],
  "palette": "one sentence about color palette and light logic",
  "styleRules": ["bullets that define the premium 3D Pixar-like look"],
  "compositionRules": ["bullets on focal clarity, camera variety, scale, negative space for text"],
  "textRenderingRules": [
    "text usually on one side of the spread",
    "no single line crosses the horizontal center",
    "near-exact wording from the manuscript; no stray or duplicated text",
    "guided line breaks honor the spread spec",
    "on-image type is lit and color-graded like the 3D scene — not a flat sticker or UI bar; match scene warmth/cool and soft shadow to depth",
    "one consistent Georgia-like book serif and one modest readable size across all spreads — never headline scale; vary only local light on the letters for blend"
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
    model: MODELS.VISUAL_BIBLE,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPrompt(doc),
    jsonMode: true,
    temperature: 0.7,
    maxTokens: 8000,
    label: 'visualBible',
    abortSignal: doc.operationalContext?.abortSignal,
  });

  const json = result.json || {};
  const heroMerged = normalizeHeroWithHairLock(doc, json.hero || null);

  const supportingCast = (Array.isArray(json.supportingCast) ? json.supportingCast : []).map(c => {
    const lock = c?.partialPresenceLock || {};
    return {
      role: c?.role ? String(c.role) : null,
      name: c?.name ? String(c.name) : null,
      onCover: c?.onCover === true,
      description: c?.description ? String(c.description) : '',
      partialPresenceIdeas: Array.isArray(c?.partialPresenceIdeas) ? c.partialPresenceIdeas.map(String) : [],
      partialPresenceLock: {
        skinTone: lock.skinTone ? String(lock.skinTone) : '',
        hand: lock.hand ? String(lock.hand) : '',
        sleeve: lock.sleeve ? String(lock.sleeve) : '',
        signatureProp: lock.signatureProp ? String(lock.signatureProp) : '',
      },
    };
  });
  const visualBible = {
    hero: heroMerged,
    outfitLocks: json.outfitLocks || null,
    supportingCastPolicy: json.supportingCastPolicy || null,
    supportingCast,
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
