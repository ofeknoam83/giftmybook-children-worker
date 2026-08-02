/**
 * Art director (A1) — ONE multimodal call over the whole manuscript,
 * seeing the character sheet + approved cover, producing the per-spread
 * visual plan:
 *
 *   shot (from the enforced variety budget) · quiet/text zone · palette
 *   arc per act · continuity locks · world-plate list · BOUNCES —
 *   unstageable scene contracts returned to the writer BEFORE any pixels
 *   render (the feedback edge v1/v2 never had).
 *
 * The shot budget is validated deterministically after the call: one
 * re-ask naming the violations, then deterministic reassignment. Model
 * promises are never the contract; the validator is.
 */

const { callVisionRole } = require('../../llm/visionClient');
const { validateShotBudget, reassignShots, SHOT_TYPES, normalizeShot } = require('./shotBudget');
const {
  normalizeHeroPresence, validateHeroPresence, reassignHeroPresence, isActionSpread,
} = require('./heroPresence');
const { ART_DIRECTION_REASKS } = require('../config');

const ZONES = ['left-top', 'left-bottom', 'right-top', 'right-bottom', 'left', 'right'];

function buildDirectorPrompt({ manuscript, ageBand, ageYears = null, textLayout = 'caption', themeArtNote = null, familyFactsNote = null, violations = null }) {
  const embedded = textLayout === 'embedded';
  const contracts = manuscript.spreads.map((s) => ({
    spread: s.spread,
    setting: s.scene_contract?.setting,
    characters: s.scene_contract?.characters_present,
    action: s.scene_contract?.hero_action,
    emotion: s.scene_contract?.emotion,
    objects: s.scene_contract?.key_objects,
    time: s.scene_contract?.time_of_day,
    // The printed story text (2026-07-28 audit, book 4c8daf08: the prose read
    // "behind his visor" and "gloved finger" while the art showed a bare-headed
    // kid in a hoodie — the director never saw the words the parent reads
    // beside the art, so story-worn gear and named focal objects went unstaged).
    text: s.text,
  }));

  // Bounce judgments must use the child's REAL age when known — the top
  // band (PB_EARLY_READER) covers every child 6+, and judging an 11-year-old
  // by the band label flagged perfectly feasible actions as "age-impossible"
  // (2026-07-15 needs_review).
  const heroDescriptor = Number.isFinite(Number(ageYears)) && Number(ageYears) > 0
    ? `a ${Number(ageYears)}-year-old child`
    : `an ${ageBand} child`;

  return `You are the art director for a children's picture book ("${manuscript.title}", age band ${ageBand}; the hero is ${heroDescriptor}).
Image 1 is the child's character model sheet; image 2 (if present) is the parent-approved cover — outfit and style ground truth.

MANUSCRIPT SCENE CONTRACTS (${contracts.length} spreads):
${JSON.stringify(contracts, null, 1)}

Plan the book's visual storytelling. Return STRICT JSON:
{
  "spreads": [
    {
      "spread": 1,
      "shot": "one of: ${SHOT_TYPES.join(' | ')}",
      "heroPresence": "one of: required | optional | absent — see the HERO PRESENCE rule below",
      "textZone": "one of: ${ZONES.join(' | ')} — the area kept visually quiet",
      "palette": "palette + lighting for this spread, consistent with its act",
      "moment": "ONE concrete, paintable instant of the contracted action — a single freeze-frame (e.g. 'both hands on the closed chest lid, body braced to lift'), never a sequence. The pose must be HOLDABLE — something the child could hold for a photograph (contact and rest states: 'boot pressed onto the round stone'), NEVER a split-second motion phase ('mid-tap', 'mid-air', 'just leaving the foot', 'mid-bounce'): a still image cannot prove motion and the QA judge compares literally",
      "poseHint": "when hands interact with objects: a simple, natural grip/pose that is easy to draw correctly — or null",
      "continuityNotes": "recurring props/outfit/cast locks relevant HERE"
    }, ...
  ],
  "paletteArc": { "act1": "...", "act2": "...", "act3": "..." },
  "continuityLocks": { "outfit": "from the cover", "props": [{ "name": "...", "spreads": [..], "design": "ONE locked visual design — shape, color, material — in a single sentence (e.g. 'a small brass camping lantern with a curved handle and a warm round glass window'); the prop must look like THIS every single time it appears" }], "gear": [{ "item": "e.g. helmet", "rule": "when it is worn vs. removed, tied to settings (e.g. 'clear dome helmet ON in every outdoor/vacuum scene; OFF inside the ship')" }], "cast": [{ "name": "exactly as written in characters_present (e.g. 'Mom', 'the robot')", "spreads": [..], "design": "ONE locked visual design for this recurring supporting character — for a person: hair color+style, skin tone, and a specific outfit; for a companion creature/robot: body shape, colors, and countable features (antennas, limbs, eyes) — in a single sentence; this character must look like THIS every single time they appear" }] },
  "worldPlates": [ { "location": "exact setting string as it appears in the contracts", "spreads": [..] } ],
  "bounces": [ { "spread": n, "problem": "why this contract cannot be staged (age-impossible action, prop soup, unstageable)", "suggestion": "targeted prose fix" } ]
}

RULES:
- HERO PRESENCE (2026-07-23 audit: the hero — the child the book is FOR — was missing from 12 spreads, including the climax; a personalized book must star its child): for EVERY spread set heroPresence by reading the action. "required" when the child is the acting subject of the moment (they do, hold, look, climb, reach, feel something) — this is the DEFAULT and covers almost every spread. "optional" only for a pure scene-setting/establishing beat where the child could appear small or not at all without breaking the story. "absent" ONLY for a deliberate pure-landscape/world-establishing plate with no character action. At most 2-3 spreads in the whole book may be "optional" or "absent" COMBINED — the child must clearly star in the rest, and the emotional climax is ALWAYS "required".
- SHOT VARIETY IS A HARD BUDGET: at least 4 distinct shot types across the book; NO two adjacent spreads may share a shot type.
- The palette arc must move with the story (e.g. darken at the low point, warm at the resolution).${themeArtNote ? `
- ORDERED THEME MOOD: the parent ordered this book with a specific occasion/story theme — ${themeArtNote}. Fold this into paletteArc and the per-spread palettes as COLOR, LIGHT, and MOTIF guidance only; it never changes the rendering medium or overrides a scene contract's setting.` : ''}
- worldPlates: only locations visited on 2+ spreads.
- PROP LOCKS: every prop that appears on 2+ spreads (a map, a lamp, a vehicle, a toy) gets a continuityLocks.props entry with a LOCKED design — the same object must not morph between spreads (the same "lamp" rendering as a crystal, then a pendant, then a lantern is a book-killing continuity break). Choose designs that are simple to draw consistently.
- CAST LOCKS: every INDIVIDUAL supporting character who appears on 2+ spreads gets a continuityLocks.cast entry with a LOCKED design. That means (a) every NAMED person (Mom, Dad, Grandma, a named friend) — hair color+style, skin tone, one specific outfit (2026-07-28 audit, book 16758e3c: Mom and Dad swam in swimwear on one spread and sat fully dressed as different-looking people two pages later; the hero was locked to the cover but the family had NO ground truth) — AND (b) every recurring UNNAMED companion — a robot, a pet, a dragon, a sidekick creature — locked under the role name used in characters_present (e.g. "the robot") with its full physical design: body shape, colors, and countable features like antenna/limb/eye count (2026-07-28 audit, book 4c8daf08: "his robot" rode 10 spreads as a bare name string and rendered as a completely different robot mid-book — round two-antenna bot became an EVE-style pod). Never lock the child hero (the model sheet owns them) and never lock declared GROUPS. Keep designs simple to draw consistently, letter-free, logo-free.
${familyFactsNote ? `- FAMILY CAST FACTS (2026-08-02 feedback: a book's mother and father were rendered as two men of invented, contrasting ethnicities — parent roles are questionnaire data the model never saw): ${familyFactsNote}
` : ''}- GEAR STATE: if the hero wears removable gear (a helmet, goggles, a backpack), define a continuityLocks.gear rule tied to settings (2026-07-19 audit: a space helmet appeared and vanished at random across outdoor Mars scenes — vacuum logic that parents notice) AND state the gear state explicitly in EVERY spread's continuityNotes (e.g. "helmet dome ON — outdoors"). TEXT-WORN GEAR: when a spread's STORY TEXT dresses the hero in wearable gear ("behind his visor", "gloved finger", "pulls on her goggles"), that gear MUST exist in the art — add a continuityLocks.gear rule and reflect it in that spread's continuityNotes; if the gear genuinely cannot be drawn consistently, bounce the spread asking the writer to drop the gear wording (2026-07-28 audit, book 4c8daf08: the text mentioned a visor and gloves the art never showed — parents read the mismatch).
- TEXT-NAMED FOCAL OBJECTS: when a spread's STORY TEXT centers on a specific object or beat ("the folded blue leaf", "the leaf slowly opens behind him"), the moment MUST stage that object visibly — the emotional beat a parent reads beside the art must be findable in the art (2026-07-28 audit: a spread's whole text was about a folded leaf reopening; the art showed a maze entrance with no leaf).${embedded ? `
- WIDE SPREADS (this book prints each illustration across TWO facing pages, folded at the exact center): stage every moment with the hero and each named landmark clearly on ONE side of the center line (left or right third) — the binding swallows the middle. Never plan a composition that centers the focal subject, and never one that would read as two mirrored halves.` : ''}
- NO CHOREOGRAPHY: never specify WHICH hand (left/right), how many hands, finger placement, or a position relative to a small prop feature (a pocket, a strap, a buckle) in moment/poseHint — renderers mirror hands freely and cannot hit prop-relative positions, so any such detail becomes an unwinnable QA target. Describe the action at the level a parent would: 'holding a vine aside', 'tucking the compass into his backpack' — never 'his left hand…', 'one hand just over the open side pocket…'.
- CAST GROUPS: when a scene's cast includes a crowd or collective (e.g. "small aliens", "a group of creatures", "friends", "children", "birds"), treat it as a GROUP — a background cluster whose exact number does NOT matter — never as one countable individual. State it as a group in continuityNotes ("a small group of small aliens gathered behind him") and stage the moment so the crowd reads as a cluster; do not plan the scene as if the group were a single character (2026-07-22 audit, book 20d4fd6e: "small aliens" was counted as exactly one, so a realistic crowd of 4-5 failed QA as an extra character).
- WRITTEN LABELS: the manuscript may COIN a fantasy world/city name ("Giggleopolis") — it is a SPOKEN word that lives in the typeset story text only; never stage it as signage, a banner, a gate inscription, or any lettering. More generally: never reference map locations, signs, or any written label BY NAME in moment/poseHint/continuityNotes ('the waterfall symbol', not 'the mark labeled Waterfall'; 'a crescent-moon mark', not 'the Moon Cave mark') — naming a label makes the renderer paint the word, and lettering is an automatic QA kill. Inherently text-bearing props (planispheres, calendar dials, star wheels, clock faces) must be staged as symbol-marked instruments (ticks, dots, star glyphs) or swapped for a pictorial equivalent — never rely on their text to read. WEARABLE TECH & COSTUME DISPLAYS: when the hero wears tech (a spacesuit, an astronaut chest control panel, a wrist computer, a helmet HUD, goggles) or the scene has screens/gauges/dashboards, stage every readout as WORDLESS symbol indicators — glowing dots, bars, rings, star-glyphs, abstract icons — the same treatment as planispheres/clock faces; never describe a numeric or lettered readout (2026-07-22 audit, book 20d4fd6e: astronaut chest displays kept rendering "88:88"/"ERROR" digits → D5 lettering auto-fail).
- REFLECTIONS: when a contract's action involves the child seeing their reflection (a mirror, still water, a polished lid), stage the moment so the reflected image is clearly ON the reflective surface — framed by it, softened/distorted by it, smaller than the child — and say so in the moment (e.g. 'leaning over the chest's polished lid, her softened reflection visible IN the lid'). Never stage it in a way that could render as a second free-standing child (2026-07-28, book 16758e3c: "sees her reflection" rendered another child inside the chest).
- PROP MECHANISMS: when a contract lists 3+ small interacting props (pegs, grooves, panels, latches), the moment must foreground ONE clear mechanical interaction — the child plus the 1-2 props that carry the action — and fold the rest into the environment via continuityNotes rather than requiring each to read separately. If the action is unreadable without all of them, bounce it as prop soup.
- bounces: flag a contract ONLY when it truly cannot be staged for ${heroDescriptor} — impossible locomotion, prop soup, unstageable geometry. Judge feasibility and safety against the hero's ACTUAL age above (what is dangerous for a toddler is ordinary for an older child); do not bounce ordinary, age-appropriate adventure.${violations ? `\n\nYOUR PREVIOUS PLAN VIOLATED THE SHOT BUDGET:\n- ${violations.join('\n- ')}\nFix exactly these violations and return the corrected full JSON.` : ''}`;
}

/**
 * @param {object} opts
 * @param {object} opts.manuscript
 * @param {string} opts.ageBand
 * @param {number|null} [opts.ageYears] - the child's real age; sharpens the bounce criteria
 * @param {string} [opts.textLayout] - 'caption' | 'embedded'; embedded books get
 *   the wide-spread fold-composition rule (2026-07-18 print audit: a rocket
 *   split down the fold, twin arches mirrored across it)
 * @param {string|null} [opts.themeArtNote] - ordered occasion/story-theme mood
 *   (shared/themes buildThemeArtNote) — palette/light/motif guidance only,
 *   never medium
 * @param {string|null} [opts.familyFactsNote] - declared parent roles
 *   (familyFacts buildFamilyFactsNote) — mother/father gender + family-look
 *   rules for cast locks; customer data, never inferred from names
 * @param {Array<{base64: string, mimeType?: string}>} opts.referenceImages - [sheet, cover?]
 * @param {AbortSignal} [opts.abortSignal]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ directionBySpread: Map<number, object>, paletteArc: object, continuityLocks: object, worldPlates: object[], bounces: object[], shotBudget: {ok: boolean, reassigned: boolean} }>}
 */
async function runArtDirection({ manuscript, ageBand, ageYears = null, textLayout = 'caption', themeArtNote = null, familyFactsNote = null, referenceImages, abortSignal, log = () => {} }) {
  let plan = null;
  let violations = null;

  for (let attempt = 0; attempt <= ART_DIRECTION_REASKS; attempt += 1) {
    const { json } = await callVisionRole('ART_DIRECTOR', {
      prompt: buildDirectorPrompt({ manuscript, ageBand, ageYears, textLayout, themeArtNote, familyFactsNote, violations }),
      images: referenceImages,
      label: `v3.artdirector.r${attempt}`,
      expectJson: true,
      // Deterministic: the bounce list must not differ between the pre- and
      // post-revision passes by sampling luck (spread-10-only-on-pass-2 bug).
      temperature: 0,
      abortSignal,
    });
    plan = json;
    const scBySpread = new Map((manuscript.spreads || []).map((s) => [Number(s.spread), s.scene_contract || {}]));
    const shotRows = (plan.spreads || []).map((r) => ({ spread: r.spread, shot: r.shot }));
    // P1: validate hero presence alongside the shot budget — action spreads
    // may not be staged hero-absent, and only a small budget of scene plates
    // may omit the child. Both checks feed the same re-ask.
    const heroRows = (plan.spreads || []).map((r) => ({
      spread: r.spread,
      heroPresence: normalizeHeroPresence(r.heroPresence, scBySpread.get(Number(r.spread))),
      isAction: isActionSpread(scBySpread.get(Number(r.spread))),
    }));
    const shotCheck = validateShotBudget(shotRows);
    const heroCheck = validateHeroPresence(heroRows);
    if (shotCheck.ok && heroCheck.ok) {
      return finalize(plan, manuscript, { ok: true, reassigned: false });
    }
    violations = [...shotCheck.violations, ...heroCheck.violations];
    log(`art direction attempt ${attempt}: plan violations — ${violations.join('; ')}`);
  }

  // Deterministic repair — guaranteed to satisfy both budgets.
  log('art direction: re-ask exhausted — deterministic shot + hero-presence reassignment');
  const scBySpread = new Map((manuscript.spreads || []).map((s) => [Number(s.spread), s.scene_contract || {}]));
  const repaired = reassignShots((plan.spreads || []).map((r) => ({ ...r, shot: r.shot })));
  const heroRepaired = reassignHeroPresence((plan.spreads || []).map((r) => ({
    spread: r.spread,
    heroPresence: normalizeHeroPresence(r.heroPresence, scBySpread.get(Number(r.spread))),
    isAction: isActionSpread(scBySpread.get(Number(r.spread))),
  })));
  plan.spreads = plan.spreads.map((r, i) => ({ ...r, shot: repaired[i].shot, heroPresence: heroRepaired[i].heroPresence }));
  return finalize(plan, manuscript, { ok: true, reassigned: true });
}

/**
 * Restage ONE spread whose candidates exhausted the QA budget (the spread
 * recovery ladder, 2026-07-17). A scene that fails 4 straight tries is often
 * staged wrong rather than unlucky — the director produces a NEW moment that
 * avoids the judges' named defects before the fresh render round runs.
 *
 * @param {object} opts
 * @param {object} opts.spread - manuscript spread (scene_contract inside)
 * @param {object|null} opts.direction - the spread's current direction row
 * @param {string[]} opts.defects - flat defect notes from every rejected candidate
 * @param {number|null} [opts.ageYears]
 * @param {string} [opts.ageBand]
 * @param {string} [opts.textLayout] - 'caption' | 'embedded'; embedded books
 *   get the fold-composition rule (2026-07-20, book d7625d8f: a fold-failed
 *   spread was restaged into another centered composition and exhausted QA)
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{ moment: string|null, poseHint: string|null, continuityNotes: string|null }>}
 */
async function restageSpread({ spread, direction = null, defects = [], ageYears = null, ageBand = 'PB_PRESCHOOL', textLayout = 'caption', abortSignal }) {
  const sc = spread.scene_contract || {};
  const heroDescriptor = Number.isFinite(Number(ageYears)) && Number(ageYears) > 0
    ? `a ${Number(ageYears)}-year-old child`
    : `an ${ageBand} child`;
  const prompt = `You are the art director for a children's picture book. ONE spread has failed illustration QA ${Math.max(defects.length, 4)} times and must be RESTAGED (the hero is ${heroDescriptor}).

THE SCENE CONTRACT:
- Setting: ${sc.setting || 'unspecified'}
- Action: ${sc.hero_action || 'unspecified'}
- Emotion: ${sc.emotion || 'unspecified'}
- Key objects: ${(sc.key_objects || []).join(', ') || 'none'}
${direction?.moment ? `- The FAILED staging (do not repeat it): ${direction.moment}` : ''}

EVERY REJECTED ATTEMPT WAS KILLED FOR:
${defects.slice(0, 10).map((d) => `- ${d}`).join('\n') || '- (no named defects)'}

Produce a NEW staging of the SAME action that a renderer can reliably hit and that avoids every defect above:
- The moment must be HOLDABLE — a pose the child could hold for a photograph; never a split-second motion phase.
- Foreground at most 2 props; fold the rest into the environment.
- Every written artifact stays WORDLESS (symbols, ticks, star glyphs — never letters/numerals); never reference labels by name.
- If the action involves the child's REFLECTION, stage the reflected image clearly ON the reflective surface (framed and softened by it) — never as anything that could render as a second free-standing child.
- NO CHOREOGRAPHY: never specify which hand, how many hands, or prop-relative positions.${textLayout === 'embedded' ? `
- WIDE SPREAD (this image prints across two facing pages, folded at the exact vertical center): the moment must place the child clearly in the LEFT or RIGHT third of the frame — never centered. The staging itself must make an off-center composition natural (the child at a doorway, beside a landmark, at the edge of a clearing).` : ''}

Return STRICT JSON:
{ "moment": "the new single paintable instant", "poseHint": "simple natural pose/grip, or null", "continuityNotes": "locks that help this scene land, or null" }`;

  const { json } = await callVisionRole('ART_DIRECTOR', {
    prompt,
    images: [],
    label: `v3.artdirector.restage.s${spread.spread}`,
    expectJson: true,
    temperature: 0,
    abortSignal,
  });
  return {
    moment: json.moment || null,
    poseHint: json.poseHint || null,
    continuityNotes: json.continuityNotes || null,
  };
}

function finalize(plan, manuscript, shotBudget) {
  const directionBySpread = new Map();
  const scBySpread = new Map((manuscript.spreads || []).map((s) => [Number(s.spread), s.scene_contract || {}]));
  for (const row of plan.spreads || []) {
    directionBySpread.set(Number(row.spread), {
      shot: normalizeShot(row.shot) || 'medium',
      // P1 (2026-07-23 audit): whether the child MUST star in this spread.
      // Falls back to a deterministic read of the scene contract when the
      // model omits it (default "required" — a personalized book stars its child).
      heroPresence: normalizeHeroPresence(row.heroPresence, scBySpread.get(Number(row.spread))),
      textZone: ZONES.includes(row.textZone) ? row.textZone : null,
      palette: row.palette || null,
      // The single paintable instant — renderer paints it, spread judge
      // judges against it (one shared target instead of two readings of
      // the writer's multi-beat action sentence).
      moment: row.moment || null,
      poseHint: row.poseHint || null,
      continuityNotes: row.continuityNotes || null,
    });
  }
  // Every manuscript spread gets a row, even if the model skipped one.
  for (const s of manuscript.spreads) {
    if (!directionBySpread.has(s.spread)) {
      directionBySpread.set(s.spread, { shot: 'medium', heroPresence: normalizeHeroPresence(null, s.scene_contract || {}), textZone: null, palette: null, moment: null, poseHint: null, continuityNotes: null });
    }
  }
  return {
    directionBySpread,
    paletteArc: plan.paletteArc || null,
    continuityLocks: plan.continuityLocks || null,
    worldPlates: Array.isArray(plan.worldPlates) ? plan.worldPlates : [],
    bounces: Array.isArray(plan.bounces) ? plan.bounces : [],
    shotBudget,
  };
}

module.exports = { runArtDirection, restageSpread, buildDirectorPrompt, ZONES };
