/**
 * Spread specs planner.
 *
 * Produces exactly TOTAL_SPREADS spread-level contracts. Each contract tells
 * the writer what to write and tells the illustrator what the picture must
 * show, without writing final prose or final render prompts.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS, TOTAL_SPREADS, TEXT_LINE_TARGET, AGE_BANDS } = require('../constants');
const { updateSpread, appendLlmCall } = require('../schema/bookDocument');
const { selectRetryMemory, renderRetryMemoryForPrompt } = require('../retryMemory');
const { renderThemeDirectiveBlock } = require('./themeDirectives');
const {
  renderPersonalizationSnapshotForPlanner,
} = require('./personalizationSnapshot');
const {
  buildAnchorAllocation,
  renderAllocationBlockForPlanner,
} = require('./anchorAllocation');
const { runPlannerGuard } = require('./plannerGuard');

const PARENT_THEMES = new Set(['mothers_day', 'fathers_day', 'grandparents_day']);
const PARENT_VISIBILITY_VALUES = new Set([
  'full', 'hand', 'shoulder-back', 'cropped-torso', 'shadow', 'object', 'absent',
]);

// AA-CW-5a — arcContext schema. Every spread carries an explicit arc record
// so downstream stages (writer, illustrator, writer QA, consistency QA) can
// reason about WHERE the spread sits in the book — not just what beat it is
// in isolation. The writer-QA tag `arc_break` (AA-CW-5b) checks against
// these fields; the writer prompt threads them so spread 7 knows it's the
// midpoint pivot, spread 12 knows it's calling back to spread 1, etc. This
// is what gives the book continuity instead of 13 vignettes.
const ARC_BEAT_VALUES = new Set([
  'opening', 'setup', 'rising', 'midpoint', 'deeper', 'peak', 'aftermath', 'return', 'closing',
]);
const EMOTIONAL_REGISTER_VALUES = new Set([
  'warm', 'curious', 'playful', 'tender', 'wonder', 'triumphant', 'reflective',
]);

// Deterministic fallback: if the LLM omits arcContext on a spread, derive a
// usable arc record from spreadNumber + purpose so writer/illustrator never
// see undefined. Pure dictionary lookup — no regex, no heuristics on prose.
const PURPOSE_TO_BEAT = {
  hook: 'opening',
  discovery: 'setup',
  rising: 'rising',
  deeper: 'deeper',
  heart: 'midpoint',
  turn: 'midpoint',
  peak: 'peak',
  aftermath: 'aftermath',
  resolution: 'aftermath',
  new_world: 'rising',
  warm_glow: 'return',
  reflection: 'return',
  last_line: 'closing',
};
const SPREAD_TO_DEFAULT_BEAT = {
  1: 'opening', 2: 'setup', 3: 'rising', 4: 'rising',
  5: 'deeper', 6: 'deeper', 7: 'midpoint',
  8: 'peak', 9: 'aftermath',
  10: 'return', 11: 'return', 12: 'closing', 13: 'closing',
};
const SPREAD_TO_DEFAULT_REGISTER = {
  1: 'warm', 2: 'curious', 3: 'curious', 4: 'playful',
  5: 'curious', 6: 'tender', 7: 'wonder',
  8: 'wonder', 9: 'tender',
  10: 'triumphant', 11: 'tender', 12: 'reflective', 13: 'reflective',
};

/**
 * Compute act number from spread number. Three-act structure across 13
 * spreads: act 1 = setup (1-4), act 2 = exploration & midpoint (5-9),
 * act 3 = return & resolution (10-13).
 *
 * @param {number} spreadNumber
 * @returns {1|2|3}
 */
function actNumberFor(spreadNumber) {
  if (spreadNumber <= 4) return 1;
  if (spreadNumber <= 9) return 2;
  return 3;
}

/**
 * Normalize the LLM's arcContext object onto a strict shape with deterministic
 * fallbacks for any missing field. Never throws; never invents content beyond
 * the lookup tables above.
 *
 * @param {object|undefined} raw - rawSpec.arcContext from the LLM
 * @param {number} spreadNumber
 * @param {string} purpose - already-trimmed spec.purpose
 * @returns {{ actNumber: 1|2|3, beat: string, callbackToSpread: number|null, setsUpSpread: number|null, emotionalRegister: string }}
 */
function normalizeArcContext(raw, spreadNumber, purpose) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawAct = Number(src.actNumber);
  const actNumber = (rawAct === 1 || rawAct === 2 || rawAct === 3) ? rawAct : actNumberFor(spreadNumber);
  const beatRaw = String(src.beat || '').trim().toLowerCase();
  let beat;
  if (ARC_BEAT_VALUES.has(beatRaw)) {
    beat = beatRaw;
  } else if (purpose && PURPOSE_TO_BEAT[purpose.toLowerCase()]) {
    beat = PURPOSE_TO_BEAT[purpose.toLowerCase()];
  } else {
    beat = SPREAD_TO_DEFAULT_BEAT[spreadNumber] || 'rising';
  }
  const callbackRaw = Number(src.callbackToSpread);
  const callbackToSpread = (Number.isFinite(callbackRaw)
    && callbackRaw >= 1
    && callbackRaw <= TOTAL_SPREADS
    && callbackRaw < spreadNumber)
    ? callbackRaw
    : null;
  const setsUpRaw = Number(src.setsUpSpread);
  const setsUpSpread = (Number.isFinite(setsUpRaw)
    && setsUpRaw >= 1
    && setsUpRaw <= TOTAL_SPREADS
    && setsUpRaw > spreadNumber)
    ? setsUpRaw
    : null;
  const registerRaw = String(src.emotionalRegister || '').trim().toLowerCase();
  const emotionalRegister = EMOTIONAL_REGISTER_VALUES.has(registerRaw)
    ? registerRaw
    : (SPREAD_TO_DEFAULT_REGISTER[spreadNumber] || 'warm');
  return { actNumber, beat, callbackToSpread, setsUpSpread, emotionalRegister };
}

// AA-CW-2: the deterministic infant-verb sanitizer (INFANT_FORBIDDEN_PLANNER_VERBS,
// findInfantPlannerVerbs, INFANT_VERB_SUBSTITUTIONS, INFANT_GENERIC_FOCAL_ACTION,
// sanitizeInfantText, sanitizeInfantSpec) was deleted. It silently rewrote noun
// usage (e.g. "a quiet walk" → "a quiet looks up at") and never caught novel
// locomotion phrasings the LLM invented. It is replaced by `runPlannerGuard`,
// a single Gemini Flash call that semantically audits focalAction/plotBeat for
// every infant spread and stashes hits onto `spec.plannerGuardHits`. The hits
// flow into `validateSpreadSpecs`, which surfaces them as gate issues, which
// triggers the existing planner-stage retry budget via runStage's retryMemory.

const SYSTEM_PROMPT = `You design spread-level contracts for a premium personalized children's book.

**ANCHORS ARE THE SPINE (read first).** When the user prompt contains an ANCHOR ALLOCATION block, those questionnaire moments ARE this book — not optional decoration. The block pins each beat to a specific spread role (opening / establishing / peak1 / heart / peak2 / closing). The mustUseDetails for those spreads will already include an ANCHOR line that names the exact moment. You MUST honor those allocations:
  - The named moment is the FOCAL ACTION of that spread — not a footnote.
  - The plotBeat for that spread is built around that moment, not around stock board-book imagery.
  - The continuityAnchors for surrounding spreads should reference that moment so the book reads as one arc with peaks, not 13 interchangeable vignettes.
  - **Transform the moment, don't copy or erase it.** The illustrator and writer both read your focalAction and plotBeat. They must capture the emotional truth and concrete specifics of the anchor moment (the people, the action, the place, the feeling) — written in the story's voice, not as a literal copy of the questionnaire answer, and not as a generic stand-in ("a tiny chomp", "a happy hug") that loses what made the moment specific.
  - Spreads with no allocated anchor are CONNECTIVE TISSUE between anchored beats: quiet sensory bridges, not new plot. When the anchor count is low, fewer spreads should carry plot — do NOT invent stock content to fill all 13.

Hard rules:
- Produce exactly ${TOTAL_SPREADS} spread specs. Do not merge or skip.
- **Variety + connection:** the book must travel across at least 4 visually distinct, photogenic places — but those places must feel like **one connected journey**, not a slideshow. Honor \`storyBible.visualJourneySpine\` and \`storyBible.recurringVisualMotifs\` when you pick \`location\` and \`focalAction\`. Each spread after the first should have a clear story reason to exist where it is (discovery, following, escalation, return, echo of an earlier beat). Avoid unmotivated "teleport" jumps.
- **continuityAnchors (required substance):** for spread 1, name motifs or props you will reuse later — **prefer** anchors from the PERSONALIZATION SNAPSHOT (interests/questionnaire objects, named colors, props from custom details). For spreads 2–${TOTAL_SPREADS}, include at least one anchor that explicitly ties to an earlier spread (same object, same companion beat, same weather thread, **or** a personalization callback such as a scarf color, snack tin, toy from interests, **or** optionally a light/glow thread **only** if the bible already established it from the brief — do not assume a "light trail" is the default thread). Empty continuityAnchors on spreads 2+ is a failure.
- **sceneBridge:** for spread 1, one line launching the quest/world. For spreads 2–${TOTAL_SPREADS}, one short sentence: how this beat follows the previous spread and what it hands off to the next (cause → effect, question → answer, problem → try).
- The child hero appears in almost every spread. Outfit stays locked to the cover unless the brief justifies change.
- Text usually lives on one side; no text line may cross the horizontal center. Alternate sides where possible.
- Each spread has ONE clear focal action, even when the world behind it is rich.
- **Camera variety (Phase 3, book-level budget):** \`cameraIntent\` for the 13 spreads MUST cover at least three different shot types so the book breathes visually instead of feeling like 13 medium shots in a row. Across the book:
  - At least ONE wide establishing shot (e.g. "wide low-angle", "wide aerial", "wide silhouette at horizon").
  - At least ONE intimate close-up (e.g. "intimate close on hands", "tight portrait", "macro on the object").
  - At least ONE unusual angle (overhead/bird's-eye, low-angle wonder, silhouette at dusk, over-shoulder POV, profile in shadow).
  Camera serves emotion: empty negative space for loneliness, tight crops for intimacy, low angles for awe. Do not default to "medium shot of the hero doing the action" 13 times — that's the look of a generic AI book, not a real picture book.
- **Ephemeral element budget (soft):** an "ephemeral" element is a person, animal, or distinctive prop that appears in EXACTLY ONE spread (a duck cameo, a stranger waving, a surprise dog, a one-off umbrella). Use them sparingly for delight — the budget for the whole book is **3 across all 13 spreads** (5 across all 18–20 for early-reader formats). Anything you intend to show in 2+ spreads belongs in \`visualBible.recurringProps\` and must be referenced by the SAME name across spreads (so it stays one consistent object, not a redesign each time).
- Use the PERSONALIZATION SNAPSHOT, storyBible personalizationTargets, and customDetails concretely across the book — invent **different** focal images per spread; repeat ideas only when continuityAnchors call for a callback.
- **Sensory \`focalAction\` for parent themes:** for mother's day / father's day / grandparents day, prefer a SENSORY focalAction whenever the spread has space — a touch (hands meeting on a cold latch), a sound (a kettle whistling, a gate's squeak), a smell (warm bread, cut grass), a temperature (sun on a bench, water at the ankles), a weight (a heavy book passed across a lap). Abstract emotional beats ("a warm hug", "a happy smile", "love filling the room") are the weakest possible focalAction when the writer reads them aloud — they translate into thin SVO sentences. Honor the storyBible's chosen sensory motif on at least 3 of the 13 spreads.
- No preachy moments. No generic "day at the park" fallback unless the brief demands it.
- **proseProps (AA-CW-16):** every spread MUST carry an exhaustive whitelist of concrete physical objects the WRITER is allowed to name in that spread's text. The writer is bound to this list — anything outside it counts as \`writer_invented_prop\` and fails. Build it generously from the spread itself:
  - every concrete object referenced in \`focalAction\`, \`plotBeat\`, \`mustUseDetails\`, or \`continuityAnchors\` (e.g. blanket, stroller, tulip, mug, gate)
  - the location's defining surfaces and fixtures (e.g. for "flower market lane": stalls, baskets, petals, awning)
  - the body parts and clothing items the action involves (e.g. cheek, hand, shoe, sleeve, hood)
  - any anchor object the personalization snapshot puts in the scene
  - **do NOT** include abstract nouns (love, joy, day, song, smile), people (Mama, Scarlett — those are characters), or background scenery the child does not interact with (sky, clouds, trees) — those don't need whitelisting.
  Aim for 6–12 entries. Singular, lowercase nouns; one per array slot. The writer reads this list and is told: "every concrete thing you name must appear here." Empty or 1-item lists guarantee the writer will invent.
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

  const personalizationBlock = renderPersonalizationSnapshotForPlanner(brief.child, brief.customDetails || {}, brief.pronouns || null);
  const isInfant = request.ageBand === AGE_BANDS.PB_INFANT;

  // PR Z — anchor allocation block. Render the per-beat → per-spread
  // assignment table at the top of the userPrompt so the LLM reads the
  // anchor plan FIRST and treats it as the spine of the book. We compute
  // the same allocation again at apply-time below to deterministically
  // fold mustUseDetails onto the persisted spec.
  const anchorAllocation = buildAnchorAllocation(brief);
  const anchorBlock = renderAllocationBlockForPlanner(anchorAllocation);

  // Lap-baby spreads cannot describe athletic action or independent
  // locomotion. The focalAction must use a verb the hero can physically
  // perform from a supported position, and the hero must be visibly held
  // or supported in every frame. Without this clause the planner happily
  // writes "Scarlett chases the puppy across the dock" for a 7-month-old.
  const infantPlannerClause = isInfant
    ? `INFANT BAND (PB_INFANT, ages 0-1.5) — HARD CONSTRAINTS for every spread:
  - focalAction MUST use ONLY verbs the hero can physically perform: sees, looks, hears, smiles, snuggles, reaches, holds (a small light object), touches, pats, claps, points, lies, sits (supported), is held, is carried.
  - FORBIDDEN focalAction verbs: walks, runs, climbs, jumps, rides, leads, chases, grabs (a moving object), says (any quoted speech).
  - In every spread the hero MUST be in a parent's arms, on a parent's lap, in a stroller, in a high chair, lying on a blanket, or seated against a soft prop. Never standing alone, never walking the world unaccompanied.
  - There is NO conflict, NO problem, NO chase. plotBeat is a tiny sensory moment ("Mama lifts Scarlett to see the moon"), not a narrative escalation. emotionalBeat is warm/curious/calm — never "determined", "brave", "scared".
  - parentVisibility (when the theme requires it):
      • If the parent IS on the cover: lean on 'full' / 'hand' / 'cropped-torso' — the parent is physically supporting the baby in nearly every spread. 'absent' is forbidden for these books.
      • If the parent is NOT on the cover: ONLY 'object' is allowed (no visible parent of any kind). The baby is physically supported by an OBJECT in every spread — stroller, high chair, crib, soft cushion, blanket on the floor, blanket against a wall — NEVER standing alone or sitting unsupported. The signature object that implies the parent (a folded blanket, a mug, a hat on a hook) is staged within the same scene as the support object.
  - sceneBridge is a sensory thread ("the same warm light from the kitchen window"), not a plot handoff.`
    : '';

  // AA-CW-5a — hero pronouns block, threaded into every prompt that talks
  // about the hero. Replaces per-stage gender→pronoun guessing with a
  // single canonical set resolved at the brief boundary.
  const pronouns = brief.pronouns || null;
  const pronounBlock = pronouns
    ? `Hero pronouns (use ONLY these for ${brief.child.name}; never swap or alternate): ${pronouns.subject} / ${pronouns.object} / ${pronouns.possessive} / ${pronouns.reflexive}.`
    : '';

  return [
    `Child: ${brief.child.name}, age ${brief.child.age}. Age band: ${request.ageBand}. Format: ${request.format}.`,
    `Theme: ${request.theme}.`,
    pronounBlock,
    // PR Z — anchor allocation block at the top, before theme directives.
    anchorBlock,
    themeBlock,
    personalizationBlock,
    infantPlannerClause,
    request.format === 'picture_book'
      ? `Target rendered lines per spread: EXACTLY 4 (picture-book format is locked to 4 lines per spread, ALL age bands including infant 0-1). Rhyme scheme is band-conditional (AA-CW-17): PB_TODDLER and PB_PRESCHOOL use full AABB couplets; PB_INFANT requires lines 1+2 to rhyme but allows lines 3+4 to be free-verse with parallel rhythm. Set textLineTarget to 4 on every spread.`
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
      "continuityAnchors": ["elements from earlier spreads that must persist — spreads 2+ must include at least one explicit callback"],
      "proseProps": ["exhaustive whitelist of concrete physical objects the writer's text is allowed to name in this spread — see proseProps rule above; aim for 6–12 singular lowercase nouns"],${isParentTheme ? `
      "parentVisibility": "full | hand | shoulder-back | cropped-torso | shadow | object | absent — see PARENT-VISIBILITY POLICY below",` : ''}
      "arcContext": {
        "actNumber": 1 | 2 | 3,
        "beat": "opening | setup | rising | midpoint | deeper | peak | aftermath | return | closing",
        "callbackToSpread": <integer 1–${TOTAL_SPREADS} that this spread CALLS BACK to (must be a SMALLER number than this spread's spreadNumber), or null on spread 1>,
        "setsUpSpread": <integer 1–${TOTAL_SPREADS} that this spread sets up (must be a LARGER number than this spread's spreadNumber, often peak/closing), or null when nothing is being set up>,
        "emotionalRegister": "warm | curious | playful | tender | wonder | triumphant | reflective"
      },
      "qaTargets": ["things QA should specifically verify on this spread"],
      "forbiddenMistakes": ["things this spread must not do (include 'unmotivated location change' for any spread that would otherwise teleport)"]
    }
  ]
}

ARC CONTEXT — fill in for every spread. The book is a three-act arc across ${TOTAL_SPREADS} spreads: act 1 (1–4) = setup, act 2 (5–9) = exploration with the midpoint at spread 7 and the visual peak around spread 8, act 3 (10–13) = return + closing. Use \`callbackToSpread\` and \`setsUpSpread\` to bind the book together: the closing should call back to the opening, the peak should be set up by an earlier rising spread, the aftermath should call back to the peak. Empty callback fields on every spread is a failure — the book must read as ONE arc.`,
    retryBlock ? `\n${retryBlock}` : '',
    isParentTheme
      ? `PARENT-VISIBILITY POLICY (parent themes only — every spread MUST have a parentVisibility value):
  - 'full' = render the parent fully visible (face + body), identical to the cover identity. Only valid when the parent IS on the approved cover (this book: ${coverParentPresent ? 'YES, parent IS on cover — full is allowed' : 'NO, parent is NOT on cover — full is FORBIDDEN'}).
  - 'hand' = a hand or forearm entering frame. Only valid when the parent IS on the cover.
  - 'shoulder-back' = parent shown from behind or from a cropped shoulder. Only valid when the parent IS on the cover.
  - 'cropped-torso' = chest-down view, body anchored in scene. Only valid when the parent IS on the cover.
  - 'shadow' = parent shown only as a shadow / silhouette. Only valid when the parent IS on the cover.
  - 'object' = an empty chair, a coat on a hook, a still-warm mug, a folded blanket, the parent's signature item — parent is NEVER in frame; their presence is implied by what they left behind.
  - 'absent' = the child is alone in the frame. Use for solo-prep beats, hero-in-spectacle shots, and active-discovery moments. The spread is still ABOUT the parent — their presence is felt in the prior/next spread, in a recurring object, or in the location they shaped — but the camera is on the child experiencing the world.
  Distribution rule: vary parentVisibility across the book so the composition doesn't repeat. ${coverParentPresent
    ? 'Since the parent IS on the cover, use \\\'full\\\' on roughly 30-40% of spreads (especially spreads 1, 7, and the climax spreads), and vary the rest across the implied palette. The QUIETEST peak beat (the BOND-PEAK image-led wonder moment per qualityBar item #3) is often best as \\\'shadow\\\' so silhouettes overlap.'
    : 'Since the parent is NOT on the cover, the parent NEVER appears visibly in any spread — no face, no hand, no shoulder, no shadow, no silhouette, no cropped torso. Use ONLY \\\'object\\\' (a left-behind item that implies the parent — mug, coat, scarf, blanket, empty rocking chair, signature prop) and \\\'absent\\\' (child alone in frame). The parent\\\'s presence comes through the manuscript text and through these signature objects. Aim for roughly 4-6 \\\'object\\\' spreads spread across the book and the rest \\\'absent\\\'. The book is still a parent-gift theme — the words carry the relationship; the pictures show the child\\\'s world.'}`
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

  // PR Z — recompute the deterministic anchor allocation so we can fold its
  // perSpread.mustUseDetails onto the persisted spec regardless of what the
  // LLM emitted. Belt-and-suspenders: the LLM gets the same allocation in
  // its prompt; this pass guarantees the writer / illustrator see the
  // ANCHOR lines on the right spreads even if the LLM dropped or reshuffled
  // them.
  const anchorAllocation = buildAnchorAllocation(doc.brief || {});
  const anchorPerSpread = anchorAllocation.perSpread;

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
      } else {
        // Deterministic fallback when LLM omits or returns junk. Pattern keeps
        // composition rhythm varied across the 13 spreads and concentrates 'full'
        // (when allowed) on opening/peak/closing beats.
        parentVisibility = defaultParentVisibilityForSpread(spreadNumber, coverParentPresent);
      }
      // Off-cover parent: ONLY 'object' and 'absent' are allowed — the parent
      // never appears visibly in any spread (no face, no hand, no shoulder,
      // no shadow, no silhouette, no cropped torso). Demote any visible
      // fragment the LLM emitted to 'object' so the illustrator policy stays
      // consistent without costing a regen. 'absent' is preserved as-is.
      if (!coverParentPresent && parentVisibility !== 'object' && parentVisibility !== 'absent') {
        parentVisibility = 'object';
      }
    }
    const purpose = String(rawSpec.purpose || '').trim();
    const spec = {
      purpose,
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
      // AA-CW-16: prose-side prop whitelist. Lowercased, deduped, trimmed.
      // Empty arrays are tolerated by the normalizer; the planner SYSTEM_PROMPT
      // teaches the LLM to fill it, and the writer/judge are bound to it.
      proseProps: Array.isArray(rawSpec.proseProps)
        ? Array.from(new Set(
            rawSpec.proseProps
              .map(s => String(s || '').trim().toLowerCase())
              .filter(s => s.length > 0),
          ))
        : [],
      qaTargets: Array.isArray(rawSpec.qaTargets) ? rawSpec.qaTargets.map(String) : [],
      forbiddenMistakes: Array.isArray(rawSpec.forbiddenMistakes) ? rawSpec.forbiddenMistakes.map(String) : [],
      parentVisibility,
      // AA-CW-5a — normalize arcContext with deterministic fallbacks. The
      // writer prompt and the illustration spec both consume this; we never
      // want it undefined.
      arcContext: normalizeArcContext(rawSpec.arcContext, spreadNumber, purpose),
    };

    // AA-CW-2: the deterministic strip-and-substitute sanitizer was deleted.
    // The Planner Guard (single Flash call below) audits focalAction/plotBeat
    // semantically and pushes hits into the gate-retry loop instead of
    // silently rewriting noun usage. We still attach a plain-English ban on
    // every infant spread so the writer LLM has an explicit reminder in its
    // prompt — this is just a string, not a regex check.
    if (doc?.request?.ageBand === AGE_BANDS.PB_INFANT) {
      spec.forbiddenMistakes = [
        ...spec.forbiddenMistakes,
        'INFANT BAND: manuscript text must not put the baby in self-locomotion. The baby is held or seated; energy and motion come from the world around the baby (light, cloth, music, Mama leaning in). Use sit / lie / look / reach / giggle / coo / hold / snuggle / pat / clap / point / watch / wave / blink / gasp on the baby; let the world (or the parent) provide the motion.',
      ];
    }

    // PR Z — fold the deterministic anchor allocation into mustUseDetails.
    // We DEDUPE so we don't double up if the LLM happened to echo the same
    // anchor string back from the prompt.
    const anchorSlot = anchorPerSpread.get(spreadNumber);
    if (anchorSlot && anchorSlot.mustUseDetails && anchorSlot.mustUseDetails.length) {
      const existing = new Set((spec.mustUseDetails || []).map(s => String(s)));
      const additions = anchorSlot.mustUseDetails.filter(s => !existing.has(s));
      if (additions.length) {
        spec.mustUseDetails = [...additions, ...(spec.mustUseDetails || [])];
      }
      if (anchorSlot.anchorRole) {
        spec.anchorRole = anchorSlot.anchorRole;
      }
      if (anchorSlot.verbatimTokens && anchorSlot.verbatimTokens.length) {
        spec.anchorVerbatimTokens = anchorSlot.verbatimTokens;
      }
    }

    next = updateSpread(next, spreadNumber, s => ({ ...s, spec }));
  }

  // PR Z — stash the allocation summary on the document trace so it can be
  // surfaced in QA diagnostics and operator dashboards.
  next = appendLlmCall(next, {
    stage: 'spreadSpecs.anchorAllocation',
    model: 'deterministic',
    attempts: 0,
    usage: {},
    note: `mode=${anchorAllocation.compression.mode} textBeats=${anchorAllocation.compression.textBeatCount} allocations=${anchorAllocation.allocations.filter(a => !a.isAddress && a.spreadNumber != null).map(a => `${a.key}@${a.spreadNumber}`).join(',')}`,
  });

  next = appendLlmCall(next, {
    stage: 'spreadSpecs',
    model: result.model,
    attempts: result.attempts,
    usage: result.usage,
  });

  // AA-CW-2 — Planner Guard. PB_INFANT only. One Flash call audits all 13
  // specs' focalAction/plotBeat for self-locomotion phrasing the planner LLM
  // may have slipped past its own contract. Hits are stashed onto
  // spec.plannerGuardHits and surfaced by validateSpreadSpecs, which triggers
  // the existing planner-stage gate-retry budget via runStage's retryMemory
  // path. Non-infant books skip the call entirely (no-op).
  next = await runPlannerGuard(next);

  return next;
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
  // Off-cover parent: only 'object' and 'absent' are allowed (parent never
  // appears visibly). Mix the two so composition stays varied: 'object' beats
  // carry the parent forward through a left-behind prop; 'absent' beats put
  // the child fully in the world (spectacle, discovery, solo-prep).
  const offCoverPattern = {
    1: 'object',   // opening — a signature item anchors the parent's presence
    2: 'absent',   // setting out — the child taking on the world
    3: 'absent',   // hero-in-spectacle — the first big location
    4: 'object',   // a left-behind prop the child solves with
    5: 'absent',   // active beat — the child engaging the world
    6: 'absent',   // active-discovery — child finding the next clue
    7: 'object',   // arrival — the parent's signature item appears in the new place
    8: 'absent',   // BOND PEAK — image-led wonder, child alone in the frame
    9: 'absent',   // child leads back
    10: 'object',  // the giving / reveal — the gift itself implies the parent
    11: 'absent',  // child's reaction beat
    12: 'object',  // afterglow — implied presence via signature item
    13: 'object',  // echo — close the book on the parent's signature item
  };
  const pattern = coverParentPresent ? onCoverPattern : offCoverPattern;
  return pattern[spreadNumber] || (coverParentPresent ? 'full' : 'object');
}

module.exports = {
  createSpreadSpecs,
  // Exported for unit tests — deterministic arcContext fallback.
  normalizeArcContext,
  ARC_BEAT_VALUES,
  EMOTIONAL_REGISTER_VALUES,
  // AA-CW-16 — exported so tests can prompt-lock the proseProps rule.
  SYSTEM_PROMPT,
};
