/**
 * Spread vision judge (A3, second tier) — scores one candidate against
 * its scene contract on the non-likeness dimensions:
 *
 *   anatomy / integrity, scene-contract adherence, cast compliance,
 *   style fidelity, quiet-zone compliance
 *
 * GATE ARCHITECTURE (2026-07-16, "closed critical gate"): five calibration
 * rounds proved that an open-ended judge invents a new pedantry class every
 * run (motion phases, handedness, prop micro-geometry, ...). The judge can
 * now BLOCK only for a CLOSED list of critical defect classes (THE PARENT
 * TEST); every other observation is a MINOR defect — recorded, shipped as
 * an advisory, never blocking. Scores remain for winner ranking and
 * telemetry; they no longer gate.
 *
 * Likeness is deliberately NOT judged here — it has its own cross-family
 * judge (likenessJudge.js); this judge is single-family (QA_VISION,
 * cheap at candidate volume). The tag taxonomy mirrors the legacy
 * qaTagCounts so existing Cloud Logging dashboards keep working.
 */

const { callVisionRole } = require('../../llm/visionClient');
const { formatCastList } = require('../promptFormat');

const SPREAD_PASS_SCORE = 4; // ranking threshold only (see pickWinner) — the GATE is critical defects

/** qaTagCounts-compatible tags the judge may emit. */
const SPREAD_QA_TAGS = [
  'anatomy_hands', 'anatomy_limbs', 'anatomy_face', 'object_integrity',
  'action_mismatch', 'setting_mismatch', 'missing_object', 'emotion_mismatch',
  'extra_character', 'duplicated_hero', 'missing_character',
  // P1 (2026-07-23 audit): the hero (the child the book is FOR) is absent from
  // a spread the art director marked heroPresence=required.
  'hero_missing',
  'style_drift', 'zone_busy',
  // 2026-07-18 print audit additions: an explicitly numbered object rendered
  // at a countably different number; photographic blur/bokeh drift; and the
  // wide-spread fold classes (landmark painted once per half, or the focal
  // subject split by the fold).
  'object_count_mismatch', 'photo_blur', 'duplicated_landmark', 'fold_collision',
];

/**
 * Tags that ALWAYS escalate to critical regardless of the model's severity
 * label — the deterministic enforcement rail for the hard classes.
 */
const HARD_FAIL_TAGS = ['duplicated_hero', 'extra_character', 'missing_character', 'hero_missing'];

/**
 * Anatomy tags that mark a COUNTABLE limb/hand/finger error (extra hand, third
 * arm, fused/extra fingers). P0 (2026-07-23 audit): these always escalate to a
 * critical anatomy fail — the choreography allowance covers WHICH hand acts,
 * never how many hands/arms a character has.
 */
const ANATOMY_COUNT_TAGS = ['anatomy_hands', 'anatomy_limbs'];

/**
 * Style tags that mark a render-MEDIUM break (flat-2D/painterly/vector drift,
 * or a live-action-photograph look). Book 16758e3c shipped flat cel-shaded
 * spreads beside premium-3D ones because the model tagged the drift and then
 * labeled the defect "minor" — style class 6 had no deterministic rail the
 * way anatomy and cast do. These tags (and a style score <= 2, which the
 * prompt reserves for a medium break) now always escalate to critical.
 */
const STYLE_BREAK_TAGS = ['style_drift', 'photo_blur'];

function buildSpreadJudgePrompt({ sceneContract, direction, hasCover = false, captionText = null, wideSpread = false, heroRequired = false }) {
  return `You are quality-judging a children's picture-book illustration against its scene contract. You are the PRINT-DEFECT gate: block images a parent would consider broken; do not block images over stylistic or interpretive nitpicks.
${hasCover ? 'Image 1 is the CANDIDATE illustration. Image 2 is the parent-approved COVER of this book — a RENDERING-STYLE reference ONLY (brushwork, color saturation, line weight, lighting quality). Never judge identity, likeness, or outfit from it.' : ''}
${wideSpread ? 'This is a WIDE spread image: the printed book folds it down its exact vertical center into two facing pages.' : ''}

SCENE CONTRACT (what the image MUST show):
- Setting: ${sceneContract.setting || 'unspecified'}
- Characters present ${formatCastList(sceneContract.characters_present)}
- The child's action: ${sceneContract.hero_action || 'unspecified'}
${direction?.moment ? `- THE DEPICTED MOMENT (judge the action against THIS, not the full action sentence): ${direction.moment}` : ''}
- Emotion: ${sceneContract.emotion || 'unspecified'}
- Required objects: ${(sceneContract.key_objects || []).join(', ') || 'none'}
${direction?.shot ? `- Directed shot (ADVISORY — never a scoring failure): ${direction.shot}` : ''}
${direction?.textZone ? `- Quiet zone: the ${direction.textZone} area must be visually calm/low-detail` : ''}
${captionText ? `
STORY TEXT printed on this spread (context for the count rule below — the reader sees these words beside this art):
"${String(captionText).slice(0, 600)}"` : ''}

Score each dimension 1-5 (4 = good with minor imperfections, 5 = flawless) and list every defect you see with a severity.

THE PARENT TEST — a defect is "critical" ONLY if a parent flipping through the printed book would consider the page BROKEN or WRONG. The complete list of critical classes:
1. readable words or lettering painted in the artwork
2. the child duplicated, or a stranger/extra NAMED person present — but a DECLARED GROUP in the cast list (e.g. "a small group of small aliens") is ALLOWED to show several members: a crowd of the declared group is NOT an extra person and is NEVER a defect. Only an individual who is not in the cast list, or the hero appearing twice, counts here
3. countably wrong anatomy (extra/missing/fused fingers, a third arm)
4. the contracted action ENTIRELY absent (not merely staged differently)
5. the wrong setting
6. a jarring style break — the book's signature style is a premium STYLIZED 3D CGI animated-film render; flat 2D/painterly/watercolor/line-art/cel-shaded drift is the break, AND SO IS a flat VECTOR look with hard cel outlines or uniform flat color fills${hasCover ? ', as is any rendering style clearly inconsistent with the COVER reference (e.g. a drawn/painted look where the cover is a dimensional 3D render, or desaturated washed-out color where the cover is rich)' : ''}. A live-action PHOTOGRAPH look (real people, real sets) OR a photorealistic real-skin/real-camera CGI render is also a break; but cinematic depth-of-field/bokeh WITHIN the stylized 3D render is part of the style, never a defect (judge the RENDER MEDIUM — stylized 3D vs flat-2D vs photoreal — not the amount of background blur)
7. a counted-object mismatch: the contract or the printed story text explicitly NUMBERS an object ("three tunnels", "five stones") and the art shows a clearly countable DIFFERENT number of that object. Applies ONLY to explicitly numbered objects that are easy to count in the image — never estimate crowds, scatter, or background texture${wideSpread ? `
8. (wide spreads only) the same distinctive landmark painted TWICE as symmetric twins (one per half — e.g. two identical archways mirroring each other), or the child/the focal landmark centered ON the fold line where the binding will swallow it` : ''}${heroRequired ? `
9. the CHILD (the hero this book is personalized for) is NOT visible in the artwork. This is a REQUIRED-hero spread: the child must clearly appear. If the child is entirely absent (only scenery, only other characters, or only a background so small the child cannot be recognized), that is critical — set hero_box to null and tag hero_missing.` : ''}
EVERYTHING ELSE IS "minor": prop versions and details, composition, stiffness, choreography, emotion nuance, zone busyness, micro-positions. Minor defects are recorded and shipped as advisories — never mark them critical.

Return STRICT JSON:
{
  "anatomy": 1-5,          // hands, limbs, faces, object coherence — stiffness or awkwardness is NEVER below 4; only countably wrong anatomy (extra/missing/fused fingers, a third arm) goes lower
  "contract": 1-5,         // shows the contracted setting + action + objects — choreography (which hand, how many hands, exact prop-relative position) never lowers this score
  "cast": 1-5,             // the listed NAMED individuals are each present exactly once; a DECLARED GROUP may show any number of members (never lowers this score); 1 only if the hero appears twice or a stranger/extra NAMED individual (not a declared group) appears
  "style": 1-5,            // consistent premium 3D CGI animated-film style, no flat-2D/painterly/live-action drift${hasCover ? '; must MATCH the cover reference\'s rendering style (same dimensional 3D medium, lighting quality, and material realism)' : ''} — a score of 2 or below is reserved EXCLUSIVELY for a broken render MEDIUM (critical class 6: flat-2D/painterly/vector/cel-shaded look, or live-action/photoreal look); tonal or palette nuances WITHIN the stylized-3D medium score 3+
  "zone": 1-5,             // quiet zone actually quiet (5 if no zone directed)
  "hero_box": { "x": 0-1, "y": 0-1, "w": 0-1, "h": 0-1 },  // tight bounding box of the child's FULL figure (head to feet) as fractions of image width/height from the top-left corner; null if the child is not visible
  "figures_box": { "x": 0-1, "y": 0-1, "w": 0-1, "h": 0-1 },  // ONE box enclosing EVERY character/creature in the scene (the child, companions, aliens, animals — anything with a face); null if no figures
  "tags": ["choose only from: ${SPREAD_QA_TAGS.join(', ')}"],
  "defects": [ { "note": "specific, actionable, with location", "severity": "critical|minor" } ]
}
Rules:
- HARD FAILS (these always block): duplicated hero or a wrong/extra NAMED individual caps cast at 1. Countable extra fingers, fused hands, more than two hands or more than two arms on one character, or a third arm caps anatomy at 2 and MUST carry the anatomy_hands (hand/finger) or anatomy_limbs (arm/leg) tag.
- DECLARED GROUPS: when the cast list marks a member as a group (e.g. "a small group of small aliens (a background cluster, 2-5, exact count not enforced)"), the artwork showing several of that group is CORRECT — never cap cast, never emit the extra_character tag, and never list an "extra character"/"too many" defect for the members of a declared group. Cast compliance counts only the NAMED individuals; the group's exact number is not enforced.
- ONE-MOMENT RULE: a picture shows ONE instant. If the image plausibly depicts ANY moment within the contracted action ("tries to lift the lid" = hands on a closed lid OR a lid cracked open; "climbs the ladder" = on the ladder OR just arrived at the top), contract is satisfied — never fail for not depicting a sequence of actions in one frame.
- MOTION-PHASE ALLOWANCE: a still image cannot depict a motion phase. If the pose is consistent with the action at ANY plausible phase (foot ON the stone satisfies "mid-tap, connecting"; the stone AT the foot satisfies "just leaving the foot"), the contract is satisfied — never fail for static-vs-in-motion, resting-vs-tapping, or about-to-vs-just-did.
- MINOR-ANATOMY ALLOWANCE: subtle stiffness, a slightly awkward grip, or "somewhat unnatural" posing scores 4, not 3. "Stiff", "awkward", or "slightly unnatural" NEVER scores below 4 — only countably wrong anatomy (extra/missing/fused fingers, a third arm) blocks.
- OBJECT EQUIVALENCE: a required object is satisfied by a reasonable visual equivalent (judge intent, not the literal phrase).
- OBJECT CRITICALITY: a missing required object is critical ONLY when the action becomes unreadable without it. A small mechanism prop (peg, groove, panel, latch) that is absent while the action still reads clearly is a minor defect.
- PROP MICRO-GEOMETRY: the exact point a finger touches or traces on a map or prop, which segment of a path is indicated, or which mark is nearest is NEVER a defect — if the child interacts with the right prop in the right general manner, the contract is satisfied.
- CHOREOGRAPHY ALLOWANCE: which hand performs an action (left/right are interchangeable — renders mirror freely) and an object's position relative to a small prop feature (over a pocket, near a strap) are NEVER defects. Judge whether the ACTION reads, not its choreography. This allowance covers WHICH of the character's two hands acts — it does NOT excuse a limb COUNT error: a single character showing MORE THAN TWO hands or MORE THAN TWO arms (a third hand, a duplicated/extra arm, a stray hand with no arm) is ALWAYS a countable anatomy defect (critical), tag anatomy_hands or anatomy_limbs, cap anatomy at 2. "How many hands touch the object" is only allowed when the total per character stays at two. (2026-07-23 audit: a three-handed hero shipped on the front cover because the choreography allowance was read as excusing hand COUNT.)
- NO IDENTITY OR GENDER JUDGING: ${hasCover ? 'the cover reference is for RENDERING STYLE comparison ONLY. ' : 'you have no reference art. '}Never assess whether the character matches a name, assumed gender, appearance, or the cover's child/outfit — a separate likeness judge owns identity. Cast counts NAMED individuals only — a declared group is allowed to be many.
- STYLE TAGS ARE MEDIUM VERDICTS: emit style_drift ONLY for a true critical-class-6 medium break (the image reads as flat 2D, painterly, vector/cel-shaded, or line-art instead of a dimensional 3D render), and photo_blur ONLY for a live-action-photograph or photoreal-real-skin look. Never emit them for palette warmth, lighting mood, or background-blur amount within the stylized 3D medium — those are minor defects without a style tag.
- The directed shot is advisory context: a different framing is never a defect or score reduction.`;
}

/**
 * Normalize the model's defects array into {note, severity} objects.
 * Tolerates legacy string-form defects (treated as minor — the hard-tag
 * backstop below covers the classes that must never slip through).
 */
function normalizeDefects(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((d) => {
      if (typeof d === 'string') return { note: d, severity: 'minor' };
      if (d && typeof d === 'object' && d.note) {
        return { note: String(d.note), severity: d.severity === 'critical' ? 'critical' : 'minor' };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * @param {object} opts
 * @param {{base64: string, mimeType?: string}} opts.candidate
 * @param {object} opts.sceneContract
 * @param {object|null} [opts.direction]
 * @param {{base64: string, mimeType?: string}|null} [opts.coverImage] - the
 *   parent-approved cover, attached as a RENDERING-STYLE reference only
 *   (2026-07-18: a cover-blind judge passed a flat/desaturated spread that
 *   the book pass then killed as a style break — the judge needs the style
 *   ground truth to catch cover-relative drift at candidate volume)
 * @param {string|null} [opts.captionText] - the spread's printed story text;
 *   enables the counted-object rule (critical class 7) — the 2026-07-18 print
 *   audit shipped "three tunnels" text beside art with four tunnels
 * @param {boolean} [opts.wideSpread] - embedded 16:9 render: enables the
 *   fold classes (twin landmarks / focal subject on the fold)
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{ scores: object, minScore: number, pass: boolean, tags: string[],
 *   defects: string[], criticalDefects: string[], minorDefects: string[],
 *   heroBox: {x: number, y: number, w: number, h: number}|null, model: string }>}
 *   `pass` is true iff NO critical defects exist (scores rank, they don't gate).
 *   `defects` stays a flat string list (criticals first) for the repair-wave
 *   and needs_review consumers. `heroBox` is the judge's normalized bounding
 *   box of the child; `figuresBox` the union box of ALL characters (subject-
 *   aware caption placement consumes them at layout).
 */
async function judgeSpreadCandidate({ candidate, sceneContract, direction = null, coverImage = null, captionText = null, wideSpread = false, abortSignal }) {
  // P1: a spread the art director marked heroPresence=required MUST show the
  // child; the judge gets the hero_missing critical class and a deterministic
  // backstop below.
  const heroRequired = direction?.heroPresence === 'required';
  const { json, model } = await callVisionRole('QA_VISION', {
    prompt: buildSpreadJudgePrompt({ sceneContract, direction, hasCover: Boolean(coverImage), captionText, wideSpread, heroRequired }),
    images: coverImage ? [candidate, coverImage] : [candidate],
    label: 'v3.qa.spread',
    expectJson: true,
    temperature: 0, // stable verdicts — repair waves need a fixed target
    abortSignal,
  });

  const scores = {
    anatomy: Number(json.anatomy) || 1,
    contract: Number(json.contract) || 1,
    cast: Number(json.cast) || 1,
    style: Number(json.style) || 1,
    zone: Number(json.zone) || 5,
  };
  const minScore = Math.min(scores.anatomy, scores.contract, scores.cast, scores.style, scores.zone);
  const tags = Array.isArray(json.tags) ? json.tags.filter((t) => SPREAD_QA_TAGS.includes(t)) : [];

  const heroBox = normalizeHeroBox(json.hero_box);
  // P1 deterministic hero-presence backstop: on a required-hero spread, a null
  // hero_box means the judge could not locate the child — escalate hero_missing
  // even if the model forgot the tag. The hero_box schema explicitly returns
  // null only when the child is not visible, so this does not fire when the
  // child is merely small or partly occluded (the judge still boxes them).
  if (heroRequired && !heroBox && !tags.includes('hero_missing')) {
    tags.push('hero_missing');
  }

  let normalized = normalizeDefects(json.defects);
  // Deterministic backstop: hard tags escalate every defect note to critical
  // even if the model labeled them minor (or emitted legacy strings) — the
  // enumerated tag list is the enforcement rail, not the model's prose.
  //
  // P0 anatomy/limb-count gate (2026-07-23 audit — three-handed hero shipped):
  // a countable extra/duplicated hand or arm is ALWAYS a hard anatomy fail. The
  // prompt reserves an anatomy score <= 2 exclusively for countably-wrong
  // anatomy (extra/missing/fused fingers, a third arm), so anatomy <= 2 is a
  // deterministic critical signal even if the model forgot the tag; likewise an
  // anatomy_hands/anatomy_limbs tag is escalated regardless of the model's
  // severity label. This never fires on stiffness/awkwardness (those score >= 4).
  const anatomyCountTags = tags.filter((t) => ANATOMY_COUNT_TAGS.includes(t));
  const anatomyCountFail = anatomyCountTags.length > 0 || scores.anatomy <= 2;
  const hardTagged = tags.some((t) => HARD_FAIL_TAGS.includes(t));
  // Style-medium gate (book 16758e3c — flat-2D spreads shipped as "minor"):
  // the prompt reserves the style tags and a style score <= 2 for a broken
  // render medium (critical class 6), so either signal escalates
  // deterministically — the model's severity prose no longer decides.
  const styleBreakTags = tags.filter((t) => STYLE_BREAK_TAGS.includes(t));
  const styleBreakFail = styleBreakTags.length > 0 || scores.style <= 2;
  if (hardTagged || anatomyCountFail || styleBreakFail) {
    normalized = normalized.map((d) => ({ ...d, severity: 'critical' }));
    if (normalized.length === 0) {
      const reasons = [];
      if (hardTagged) reasons.push(`hard-fail tag present (${tags.filter((t) => HARD_FAIL_TAGS.includes(t)).join(', ')})`);
      if (anatomyCountFail) reasons.push(anatomyCountTags.length ? `countable anatomy defect (${anatomyCountTags.join(', ')})` : `anatomy score ${scores.anatomy} <= 2 (countable anatomy defect)`);
      if (styleBreakFail) reasons.push(styleBreakTags.length ? `style-medium break (${styleBreakTags.join(', ')})` : `style score ${scores.style} <= 2 (render-medium break)`);
      normalized.push({ note: reasons.join('; '), severity: 'critical' });
    }
  }

  const criticalDefects = normalized.filter((d) => d.severity === 'critical').map((d) => d.note);
  const minorDefects = normalized.filter((d) => d.severity === 'minor').map((d) => d.note);

  return {
    scores,
    minScore,
    pass: criticalDefects.length === 0,
    tags,
    defects: [...criticalDefects, ...minorDefects],
    criticalDefects,
    minorDefects,
    heroBox,
    // Union box of ALL characters — caption placement must dodge companions
    // too (audit #2: a caption typeset across two aliens' faces; the
    // hero-only box could not see them).
    figuresBox: normalizeHeroBox(json.figures_box),
    model,
  };
}

/**
 * Validate/clamp the judge's hero bounding box to normalized [0,1] space.
 * Anything malformed degrades to null (layout then keeps the planned zone).
 * Pure — exported for tests.
 *
 * @param {object|null|undefined} raw
 * @returns {{x: number, y: number, w: number, h: number}|null}
 */
function normalizeHeroBox(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x); const y = Number(raw.y);
  const w = Number(raw.w); const h = Number(raw.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  const cx = Math.min(1, Math.max(0, x));
  const cy = Math.min(1, Math.max(0, y));
  const cw = Math.min(1 - cx, w);
  const ch = Math.min(1 - cy, h);
  if (cw <= 0 || ch <= 0) return null;
  return { x: cx, y: cy, w: cw, h: ch };
}

module.exports = {
  judgeSpreadCandidate,
  buildSpreadJudgePrompt,
  normalizeHeroBox,
  SPREAD_PASS_SCORE,
  SPREAD_QA_TAGS,
  HARD_FAIL_TAGS,
  ANATOMY_COUNT_TAGS,
  STYLE_BREAK_TAGS,
};
