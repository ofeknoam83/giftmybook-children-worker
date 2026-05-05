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

const PARENT_THEMES = new Set(['mothers_day', 'fathers_day', 'grandparents_day']);
const PARENT_VISIBILITY_VALUES = new Set([
  'full', 'hand', 'shoulder-back', 'cropped-torso', 'shadow', 'object', 'absent',
]);

// Locomotion verbs lap babies cannot perform. Mirrors the writer-side QA list
// (INFANT_FORBIDDEN_VERB_PATTERNS) so the planner cannot smuggle a forbidden
// verb into focalAction/plotBeat and have the writer dutifully reproduce it.
// When detected on an infant spread we strip the offender (PR H) and flag it
// on forbiddenMistakes so the writer sees the explicit ban.
const INFANT_FORBIDDEN_PLANNER_VERBS = [
  'jump', 'jumps', 'jumped', 'jumping',
  'run', 'runs', 'running', 'ran',
  'race', 'races', 'racing', 'raced',
  'spin', 'spins', 'spinning',
  'twirl', 'twirls', 'twirling', 'twirled',
  'hop', 'hops', 'hopping', 'hopped',
  'walk', 'walks', 'walking', 'walked',
  'climb', 'climbs', 'climbing', 'climbed',
  'leap', 'leaps', 'leaping', 'leapt',
  'dance', 'dances', 'dancing', 'danced',
  'chase', 'chases', 'chasing', 'chased',
  'grab', 'grabs', 'grabbing', 'grabbed',
  'skip', 'skips', 'skipping', 'skipped',
  'gallop', 'gallops', 'galloping', 'galloped',
  'stomp', 'stomps', 'stomping', 'stomped',
  'march', 'marches', 'marching', 'marched',
  'crawl', 'crawls', 'crawling', 'crawled',
  'cartwheel', 'cartwheels', 'cartwheeling',
  'tumble', 'tumbles', 'tumbling', 'tumbled',
];

/**
 * Scan a planner-produced text field (focalAction, plotBeat) for forbidden
 * infant locomotion verbs. Returns the unique surface forms found.
 */
function findInfantPlannerVerbs(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return [];
  const hits = new Set();
  for (const v of INFANT_FORBIDDEN_PLANNER_VERBS) {
    const rx = new RegExp(`\\b${v}\\b`, 'i');
    if (rx.test(t)) hits.add(v);
  }
  return Array.from(hits);
}

// PR H — verb-level substitution map for planner sanitization.
//
// When the LLM puts a banned locomotion verb into focalAction/plotBeat we
// REWRITE it in place using a safe phrase the lap baby actually can do, OR
// reframe so the parent is the one moving and the baby is held/supported.
// The writer then reads a clean spec; the illustrator receives a clean
// focalAction; the illustrator's age-action QA compares the image against a
// renderable target. Surface form -> replacement phrase. Replacements are
// short and grammatically inert so they slot in without breaking the spec
// sentence (the replacement IS a verb form so subject-verb agreement holds).
//
// Rules of thumb when extending:
//   - prefer a sense/posture verb that keeps the IMAGE intent ("twirl" -> "sway"
//     because both say "motion in place"; "run" -> "reach toward" because both
//     say "oriented toward something ahead")
//   - when the verb is intrinsically locomotion ("climb", "march"), reframe
//     to a held / supported posture
//   - keep singular/plural inflections close to the original ("twirls" ->
//     "sways" not "sway") so we don't break agreement
const INFANT_VERB_SUBSTITUTIONS = {
  // jump / hop / leap — "in Mama's arms" preserves bounce-energy without locomotion
  jump: 'is bounced',          jumps: 'is bounced',          jumped: 'was bounced',          jumping: 'being bounced',
  hop: 'is bounced',           hops: 'is bounced',           hopped: 'was bounced',          hopping: 'being bounced',
  leap: 'reaches up',          leaps: 'reaches up',          leapt: 'reached up',            leaping: 'reaching up',

  // run / race / chase / gallop / march / stomp / skip — "reach toward" or "is carried"
  run: 'reaches toward',       runs: 'reaches toward',       ran: 'reached toward',          running: 'reaching toward',
  race: 'reaches toward',      races: 'reaches toward',      raced: 'reached toward',        racing: 'reaching toward',
  chase: 'follows with eyes',  chases: 'follows with eyes',  chased: 'followed with eyes',   chasing: 'following with eyes',
  gallop: 'is carried',        gallops: 'is carried',        galloped: 'was carried',        galloping: 'being carried',
  march: 'is carried',         marches: 'is carried',        marched: 'was carried',         marching: 'being carried',
  stomp: 'pats',               stomps: 'pats',               stomped: 'patted',              stomping: 'patting',
  skip: 'is bounced',          skips: 'is bounced',          skipped: 'was bounced',         skipping: 'being bounced',

  // spin / twirl / dance — sway in place, in Mama's arms
  spin: 'sways',               spins: 'sways',               spinning: 'swaying',
  twirl: 'sways',              twirls: 'sways',              twirled: 'swayed',              twirling: 'swaying',
  dance: 'sways',              dances: 'sways',              danced: 'swayed',               dancing: 'swaying',

  // walk / climb / crawl / cartwheel / tumble — reframe to looking-up / being-carried
  walk: 'looks up at',         walks: 'looks up at',         walked: 'looked up at',         walking: 'looking up at',
  climb: 'looks up at',        climbs: 'looks up at',        climbed: 'looked up at',        climbing: 'looking up at',
  crawl: 'reaches forward',    crawls: 'reaches forward',    crawled: 'reached forward',     crawling: 'reaching forward',
  cartwheel: 'is jiggled',     cartwheels: 'is jiggled',                                     cartwheeling: 'being jiggled',
  tumble: 'is rolled gently',  tumbles: 'is rolled gently',  tumbled: 'was rolled gently',   tumbling: 'being rolled gently',

  // grab — soft "reach for" (touching, not seizing a moving object)
  grab: 'reaches for',         grabs: 'reaches for',         grabbed: 'reached for',         grabbing: 'reaching for',
};

// Last-resort generic focal action when the original spec is so saturated
// with banned verbs that simple substitution can't produce a clean sentence.
// Used only when sanitizeInfantText still detects a banned verb after one
// substitution pass (defense in depth).
const INFANT_GENERIC_FOCAL_ACTION =
  'Mama holds Everleigh close while she looks at the scene';
// We intentionally hard-code "Everleigh" only as a placeholder — the caller
// passes a doc-aware fallback when one is available.

/**
 * Substitute every banned locomotion verb in a text field with its safe
 * equivalent from INFANT_VERB_SUBSTITUTIONS. Case-insensitive match,
 * preserves the rest of the sentence. Returns the rewritten string.
 *
 * If after one substitution pass any banned verb still survives (e.g. a
 * compound verb form not in the map), we return null so the caller can
 * apply the generic-fallback strategy.
 *
 * @param {string} text
 * @returns {string|null} sanitized text, or null if it cannot be cleaned
 */
function sanitizeInfantText(text) {
  let out = String(text || '');
  if (!out) return out;
  // Apply every substitution. Iterate the map in length-descending order so
  // longer surface forms ("twirling") match before their shorter siblings
  // ("twirl") — \b anchors prevent overlap but order keeps the diff clean.
  const keys = Object.keys(INFANT_VERB_SUBSTITUTIONS).sort((a, b) => b.length - a.length);
  for (const surface of keys) {
    const rx = new RegExp(`\\b${surface}\\b`, 'gi');
    out = out.replace(rx, INFANT_VERB_SUBSTITUTIONS[surface]);
  }
  // Defense in depth: if anything banned survives, signal failure so the
  // caller can fall back to a generic focal action.
  if (findInfantPlannerVerbs(out).length) return null;
  return out;
}

/**
 * Sanitize a single planner spec for an infant book. Mutates a clone of the
 * spec: focalAction and plotBeat are rewritten in place; the original
 * offending text is preserved on the spec metadata so the trace shows what
 * was changed. Returns { spec, changes } where `changes` lists every
 * substitution applied so the caller can log / surface them.
 *
 * If sanitizeInfantText cannot produce a clean string for a field, that
 * field is replaced with a generic infant-safe phrasing built from the
 * spec's location and the hero's name.
 *
 * @param {object} spec planner-produced spec
 * @param {object} ctx  { heroName, fallbackHeroName }
 * @returns {{ spec: object, changes: Array<{field:string, before:string, after:string, hits:string[]}> }}
 */
function sanitizeInfantSpec(spec, ctx = {}) {
  const heroName = ctx.heroName || ctx.fallbackHeroName || 'the baby';
  const changes = [];
  const out = { ...spec };

  for (const field of ['focalAction', 'plotBeat']) {
    const before = String(out[field] || '');
    const hits = findInfantPlannerVerbs(before);
    if (!hits.length) continue;
    const sanitized = sanitizeInfantText(before);
    if (sanitized != null) {
      out[field] = sanitized;
      changes.push({ field, before, after: sanitized, hits });
      continue;
    }
    // Generic fallback: keep the location / mood scaffolding, drop the
    // action. We use a hero-aware sentence so downstream prompts still see
    // a personalized target.
    const loc = String(out.location || '').trim();
    const fallback = loc
      ? `Mama holds ${heroName} close while she looks at the ${loc}`
      : `Mama holds ${heroName} close while she looks at the scene`;
    out[field] = fallback;
    changes.push({ field, before, after: fallback, hits, fallback: true });
  }

  return { spec: out, changes };
}

const SYSTEM_PROMPT = `You design spread-level contracts for a premium personalized children's book.

Hard rules:
- Produce exactly ${TOTAL_SPREADS} spread specs. Do not merge or skip.
- **Variety + connection:** the book must travel across at least 4 visually distinct, photogenic places — but those places must feel like **one connected journey**, not a slideshow. Honor \`storyBible.visualJourneySpine\` and \`storyBible.recurringVisualMotifs\` when you pick \`location\` and \`focalAction\`. Each spread after the first should have a clear story reason to exist where it is (discovery, following, escalation, return, echo of an earlier beat). Avoid unmotivated "teleport" jumps.
- **continuityAnchors (required substance):** for spread 1, name motifs or props you will reuse later — **prefer** anchors from the PERSONALIZATION SNAPSHOT (interests/questionnaire objects, named colors, props from custom details). For spreads 2–${TOTAL_SPREADS}, include at least one anchor that explicitly ties to an earlier spread (same object, same companion beat, same weather thread, **or** a personalization callback such as a scarf color, snack tin, toy from interests, **or** optionally a light/glow thread **only** if the bible already established it from the brief — do not assume a "light trail" is the default thread). Empty continuityAnchors on spreads 2+ is a failure.
- **sceneBridge:** for spread 1, one line launching the quest/world. For spreads 2–${TOTAL_SPREADS}, one short sentence: how this beat follows the previous spread and what it hands off to the next (cause → effect, question → answer, problem → try).
- The child hero appears in almost every spread. Outfit stays locked to the cover unless the brief justifies change.
- Text usually lives on one side; no text line may cross the horizontal center. Alternate sides where possible.
- Each spread has ONE clear focal action, even when the world behind it is rich.
- **Ephemeral element budget (soft):** an "ephemeral" element is a person, animal, or distinctive prop that appears in EXACTLY ONE spread (a duck cameo, a stranger waving, a surprise dog, a one-off umbrella). Use them sparingly for delight — the budget for the whole book is **3 across all 13 spreads** (5 across all 18–20 for early-reader formats). Anything you intend to show in 2+ spreads belongs in \`visualBible.recurringProps\` and must be referenced by the SAME name across spreads (so it stays one consistent object, not a redesign each time).
- Use the PERSONALIZATION SNAPSHOT, storyBible personalizationTargets, and customDetails concretely across the book — invent **different** focal images per spread; repeat ideas only when continuityAnchors call for a callback.
- **Sensory \`focalAction\` for parent themes:** for mother's day / father's day / grandparents day, prefer a SENSORY focalAction whenever the spread has space — a touch (hands meeting on a cold latch), a sound (a kettle whistling, a gate's squeak), a smell (warm bread, cut grass), a temperature (sun on a bench, water at the ankles), a weight (a heavy book passed across a lap). Abstract emotional beats ("a warm hug", "a happy smile", "love filling the room") are the weakest possible focalAction when the writer reads them aloud — they translate into thin SVO sentences. Honor the storyBible's chosen sensory motif on at least 3 of the 13 spreads.
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
  const isInfant = request.ageBand === AGE_BANDS.PB_INFANT;

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
  - parentVisibility (when the theme requires it) should lean on 'full' / 'hand' / 'cropped-torso' — the parent is physically supporting the baby in nearly every spread. 'absent' is forbidden for infant books.
  - sceneBridge is a sensory thread ("the same warm light from the kitchen window"), not a plot handoff.`
    : '';

  return [
    `Child: ${brief.child.name}, age ${brief.child.age}. Age band: ${request.ageBand}. Format: ${request.format}.`,
    `Theme: ${request.theme}.`,
    themeBlock,
    personalizationBlock,
    infantPlannerClause,
    isInfant
      ? `Target rendered lines per spread: EXACTLY 2 (lap-baby board books are locked to 2 lines per spread, one AA rhyming couplet). Set textLineTarget to 2 on every spread.`
      : request.format === 'picture_book'
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
  - 'absent' = the child is alone in the frame. Use this for up to 3 spreads across the book — for solo-prep beats (preparing a surprise, picking a flower secretly), for hero-in-spectacle shots (the child mid-leap on a hilltop, racing through a market square, climbing a lighthouse stair), and for active-discovery moments (the child finding the next clue, cresting a ridge). The spread is still ABOUT the parent — their presence is felt in the prior/next spread, in a recurring object, or in the location they shaped — but the camera is on the child experiencing the world. Treat 'absent' as a feature, not a fallback: it is how the parent-theme book earns its adventure-book scope.
  Distribution rule: vary parentVisibility across the book so the composition doesn't repeat. ${coverParentPresent
    ? 'Since the parent IS on the cover, use \\\'full\\\' on roughly 30-40% of spreads (especially spreads 1, 7, and the climax spreads), and vary the rest across the implied palette. The QUIETEST peak beat (the BOND-PEAK image-led wonder moment per qualityBar item #3) is often best as \\\'shadow\\\' so silhouettes overlap.'
    : 'Since the parent is NOT on the cover, NEVER use \\\'full\\\'. Vary the implied values across the book and lean into adventure-book composition: use \\\'absent\\\' for 2-3 hero-in-spectacle / active-discovery / solo-prep spreads (the child mid-leap, racing through the location, finding the clue), \\\'object\\\' for 1-2 spreads where a left-behind prop carries the parent forward, \\\'hand\\\' and \\\'shoulder-back\\\' for active interaction beats, \\\'cropped-torso\\\' for arrival/giving beats, and \\\'shadow\\\' for the QUIETEST peak beat. Aim for at least 4 distinct visibility values across the 13 spreads so the camera/composition keeps changing.'}`
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

    // Infant safety net: even with the planner prompt, the LLM occasionally
    // emits forbidden locomotion verbs in focalAction / plotBeat. The writer
    // reads these as instructions and reproduces them in the manuscript;
    // the illustrator reads focalAction directly and tries to render it.
    //
    // PR H — STRIP MODE. We rewrite focalAction/plotBeat in place via
    // sanitizeInfantSpec so banned verbs never reach the writer or the
    // illustrator. The original offending text + replacement is recorded on
    // spec.sanitization for the trace, and forbiddenMistakes still carries
    // the explicit ban as a breadcrumb for the writer.
    if (doc?.request?.ageBand === AGE_BANDS.PB_INFANT) {
      const heroName = doc?.brief?.child?.name || '';
      const { spec: sanitized, changes } = sanitizeInfantSpec(spec, { heroName });
      if (changes.length) {
        // Replace focalAction/plotBeat in the working spec, and stash the
        // diff so the trace makes the change visible.
        spec.focalAction = sanitized.focalAction;
        spec.plotBeat = sanitized.plotBeat;
        spec.sanitization = {
          stage: 'planner.infantStrip',
          changes,
        };
        const allHits = Array.from(new Set(changes.flatMap(c => c.hits)));
        spec.forbiddenMistakes = [
          ...spec.forbiddenMistakes,
          `INFANT BAND: planner sanitized banned verb(s) ${allHits.join(', ')} from spec; do NOT reintroduce them in the manuscript text. Lap baby cannot do these. Use sit / lie / look / reach / giggle / coo / hold / snuggle instead.`,
        ];
      }
      // Always carry an explicit infant-locomotion ban on every spread, even
      // when the planner spec is clean, so the writer can't drift on its own.
      spec.forbiddenMistakes = [
        ...spec.forbiddenMistakes,
        'INFANT BAND: manuscript text must not contain locomotion verbs (jump/run/race/spin/twirl/hop/walk/climb/leap/dance/chase/skip/gallop/stomp/march/crawl).',
      ];
    }

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
    1: 'shoulder-back',  // setting out — parent presence anchors the start
    2: 'hand',           // first interaction beat
    3: 'absent',         // hero-in-spectacle — child experiencing the first big location
    4: 'object',         // a left-behind prop carries the parent forward; child solves something
    5: 'hand',           // pivot together — hands at work
    6: 'absent',         // active-discovery — child cresting/leaping/finding the next clue
    7: 'cropped-torso',  // arrival — body anchored in scene
    8: 'shadow',         // BOND PEAK — silhouettes overlapping (image-led wonder)
    9: 'absent',         // child leads back — hero-in-spectacle on the return leg
    10: 'cropped-torso', // the giving / reveal
    11: 'shoulder-back', // parent's reaction beat
    12: 'object',        // afterglow — implied presence
    13: 'shoulder-back', // echo transformed
  };
  const pattern = coverParentPresent ? onCoverPattern : offCoverPattern;
  return pattern[spreadNumber] || (coverParentPresent ? 'full' : 'shoulder-back');
}

module.exports = {
  createSpreadSpecs,
  findInfantPlannerVerbs,
  // PR H exports — sanitizer surface for writer/illustrator/test code.
  sanitizeInfantText,
  sanitizeInfantSpec,
  INFANT_VERB_SUBSTITUTIONS,
};
