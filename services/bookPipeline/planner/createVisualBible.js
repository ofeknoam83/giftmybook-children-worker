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
    "rules": ["planner-guided introductions only, never invent named family members"],
    "castVisibility": "Only characters on the cover appear as full figures. Off-cover declared characters appear only in text and as partial presence (hand, shoulder, back-of-head, silhouette, or a personal object)."
  },
  "supportingCast": [
    {
      "role": "e.g. mom|dad|sibling|friend|creature",
      "name": "string or null",
      "onCover": false,
      "isThemedParent": "true ONLY for the mom on a Mother's Day / Love-to-mom book or the dad on a Father's Day book — false otherwise",
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
  const supportingCast = (Array.isArray(json.supportingCast) ? json.supportingCast : []).map(c => {
    const lock = c?.partialPresenceLock || {};
    return {
      role: c?.role ? String(c.role) : null,
      name: c?.name ? String(c.name) : null,
      onCover: c?.onCover === true,
      isThemedParent: c?.isThemedParent === true,
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

  ensureThemedParentBible({
    supportingCast,
    theme: doc?.brief?.theme || doc?.request?.theme,
    coverParentPresent: doc?.brief?.coverParentPresent === true,
    childGender: doc?.brief?.child?.gender,
    childPhysicalDescription: json?.hero?.physicalDescription,
  });
  const visualBible = {
    hero: json.hero || null,
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

/**
 * For parent-theme books, guarantee that the implied-parent supportingCast
 * entry exists with a populated partialPresenceLock — even when the visualBible
 * LLM call returned a thin or missing entry. This is the deterministic fallback
 * so identity is locked regardless of LLM verbosity.
 *
 * Matches the contract consumed by buildIllustrationSpec.js (which reads
 * `c.isThemedParent === true && c.onCover !== true` to derive the implied
 * parent descriptor) and the systemInstruction.js implied-parent outfit
 * defaults.
 *
 * Mutates `supportingCast` in place.
 *
 * @param {{
 *   supportingCast: Array<object>,
 *   theme: string,
 *   coverParentPresent: boolean,
 *   childGender?: string,
 *   childPhysicalDescription?: string,
 * }} ctx
 */
function ensureThemedParentBible(ctx) {
  const PARENT_THEMES = new Set(['mothers_day', 'fathers_day']);
  if (!PARENT_THEMES.has(ctx.theme)) return;

  // If the themed parent is on the cover, identity flows from the cover render
  // — no implied-parent bible needed.
  if (ctx.coverParentPresent) return;

  const isMother = ctx.theme === 'mothers_day';
  const role = isMother ? 'mom' : 'dad';

  let entry = ctx.supportingCast.find(c => c?.isThemedParent === true && c?.onCover !== true);
  if (!entry) {
    // Fallback: a supportingCast entry whose role names the themed parent.
    entry = ctx.supportingCast.find(c => {
      const r = String(c?.role || '').toLowerCase();
      return c?.onCover !== true && (
        isMother
          ? (r === 'mom' || r === 'mother' || r === 'mommy')
          : (r === 'dad' || r === 'father' || r === 'daddy')
      );
    });
    if (entry) entry.isThemedParent = true;
  }
  if (!entry) {
    entry = {
      role,
      name: null,
      onCover: false,
      isThemedParent: true,
      description: isMother
        ? 'The hero\'s mother — present in the story but not on the cover; appears as implied presence only.'
        : 'The hero\'s father — present in the story but not on the cover; appears as implied presence only.',
      partialPresenceIdeas: isMother
        ? ['a warm hand entering frame', 'a soft cardigan sleeve at the edge of the page', 'a familiar mug on the table']
        : ['a steady hand entering frame', 'a rolled shirt sleeve at the edge of the page', 'work boots beside the doorway'],
      partialPresenceLock: { skinTone: '', hand: '', sleeve: '', signatureProp: '' },
    };
    ctx.supportingCast.push(entry);
  }

  const lock = entry.partialPresenceLock || (entry.partialPresenceLock = {});
  if (!lock.skinTone) {
    const heroDesc = (ctx.childPhysicalDescription || '').trim();
    lock.skinTone = heroDesc
      ? `same family as the hero — match skin tone and undertone described as: ${heroDesc.replace(/\s+/g, ' ').slice(0, 220)}`
      : 'same family as the hero — match the cover child\'s skin tone and undertone exactly';
  }
  if (!lock.hand) {
    lock.hand = isMother
      ? 'an adult woman\'s hand — relaxed fingers, neat short clean nails, no nail polish, no visible scars; same skin tone as the hero'
      : 'an adult man\'s hand — relaxed fingers, neat short clean nails, no visible scars; same skin tone as the hero';
  }
  if (!lock.sleeve) {
    lock.sleeve = isMother
      ? 'a soft mauve cardigan sleeve over a plain white tee, casual everyday weight, no logos or patterns'
      : 'a long-sleeve henley shirt sleeve in muted blue, simple cuff, no logos or patterns';
  }
  if (!lock.signatureProp) {
    lock.signatureProp = isMother
      ? 'a plain gold band on the left ring finger (and no other jewelry)'
      : 'a simple casual wristwatch on the left wrist (and no other jewelry)';
  }
}

module.exports = { createVisualBible };
