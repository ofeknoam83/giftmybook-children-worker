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
  'style_drift', 'zone_busy',
];

/**
 * Tags that ALWAYS escalate to critical regardless of the model's severity
 * label — the deterministic enforcement rail for the hard classes.
 */
const HARD_FAIL_TAGS = ['duplicated_hero', 'extra_character', 'missing_character'];

function buildSpreadJudgePrompt({ sceneContract, direction, hasCover = false }) {
  return `You are quality-judging a children's picture-book illustration against its scene contract. You are the PRINT-DEFECT gate: block images a parent would consider broken; do not block images over stylistic or interpretive nitpicks.
${hasCover ? 'Image 1 is the CANDIDATE illustration. Image 2 is the parent-approved COVER of this book — a RENDERING-STYLE reference ONLY (brushwork, color saturation, line weight, lighting quality). Never judge identity, likeness, or outfit from it.' : ''}

SCENE CONTRACT (what the image MUST show):
- Setting: ${sceneContract.setting || 'unspecified'}
- Characters present ${formatCastList(sceneContract.characters_present)}
- The child's action: ${sceneContract.hero_action || 'unspecified'}
${direction?.moment ? `- THE DEPICTED MOMENT (judge the action against THIS, not the full action sentence): ${direction.moment}` : ''}
- Emotion: ${sceneContract.emotion || 'unspecified'}
- Required objects: ${(sceneContract.key_objects || []).join(', ') || 'none'}
${direction?.shot ? `- Directed shot (ADVISORY — never a scoring failure): ${direction.shot}` : ''}
${direction?.textZone ? `- Quiet zone: the ${direction.textZone} area must be visually calm/low-detail` : ''}

Score each dimension 1-5 (4 = good with minor imperfections, 5 = flawless) and list every defect you see with a severity.

THE PARENT TEST — a defect is "critical" ONLY if a parent flipping through the printed book would consider the page BROKEN or WRONG. The complete list of critical classes:
1. readable words or lettering painted in the artwork
2. the child duplicated, or a stranger/extra person present
3. countably wrong anatomy (extra/missing/fused fingers, a third arm)
4. the contracted action ENTIRELY absent (not merely staged differently)
5. the wrong setting
6. a jarring style break — photoreal/3D drift${hasCover ? ', or a rendering style clearly inconsistent with the COVER reference (e.g. flat/desaturated colors or thin line-art where the cover is warm and painterly)' : ''}
EVERYTHING ELSE IS "minor": prop versions and details, composition, stiffness, choreography, emotion nuance, zone busyness, micro-positions. Minor defects are recorded and shipped as advisories — never mark them critical.

Return STRICT JSON:
{
  "anatomy": 1-5,          // hands, limbs, faces, object coherence — stiffness or awkwardness is NEVER below 4; only countably wrong anatomy (extra/missing/fused fingers, a third arm) goes lower
  "contract": 1-5,         // shows the contracted setting + action + objects — choreography (which hand, how many hands, exact prop-relative position) never lowers this score
  "cast": 1-5,             // exactly the listed characters; 1 if the hero appears twice or strangers appear
  "style": 1-5,            // consistent storybook style, no photoreal/3D drift${hasCover ? '; must MATCH the cover reference\'s rendering style (no flat/desaturated/line-art drift)' : ''}
  "zone": 1-5,             // quiet zone actually quiet (5 if no zone directed)
  "tags": ["choose only from: ${SPREAD_QA_TAGS.join(', ')}"],
  "defects": [ { "note": "specific, actionable, with location", "severity": "critical|minor" } ]
}
Rules:
- HARD FAILS (these always block): duplicated hero or a wrong/extra person caps cast at 1. Countable extra fingers, fused hands, or a third arm caps anatomy at 2.
- ONE-MOMENT RULE: a picture shows ONE instant. If the image plausibly depicts ANY moment within the contracted action ("tries to lift the lid" = hands on a closed lid OR a lid cracked open; "climbs the ladder" = on the ladder OR just arrived at the top), contract is satisfied — never fail for not depicting a sequence of actions in one frame.
- MOTION-PHASE ALLOWANCE: a still image cannot depict a motion phase. If the pose is consistent with the action at ANY plausible phase (foot ON the stone satisfies "mid-tap, connecting"; the stone AT the foot satisfies "just leaving the foot"), the contract is satisfied — never fail for static-vs-in-motion, resting-vs-tapping, or about-to-vs-just-did.
- MINOR-ANATOMY ALLOWANCE: subtle stiffness, a slightly awkward grip, or "somewhat unnatural" posing scores 4, not 3. "Stiff", "awkward", or "slightly unnatural" NEVER scores below 4 — only countably wrong anatomy (extra/missing/fused fingers, a third arm) blocks.
- OBJECT EQUIVALENCE: a required object is satisfied by a reasonable visual equivalent (judge intent, not the literal phrase).
- OBJECT CRITICALITY: a missing required object is critical ONLY when the action becomes unreadable without it. A small mechanism prop (peg, groove, panel, latch) that is absent while the action still reads clearly is a minor defect.
- PROP MICRO-GEOMETRY: the exact point a finger touches or traces on a map or prop, which segment of a path is indicated, or which mark is nearest is NEVER a defect — if the child interacts with the right prop in the right general manner, the contract is satisfied.
- CHOREOGRAPHY ALLOWANCE: which hand performs an action (left/right are interchangeable — renders mirror freely), how many hands hold an object, and an object's position relative to a small prop feature (over a pocket, near a strap) are NEVER defects. Judge whether the ACTION reads, not its choreography.
- NO IDENTITY OR GENDER JUDGING: ${hasCover ? 'the cover reference is for RENDERING STYLE comparison ONLY. ' : 'you have no reference art. '}Never assess whether the character matches a name, assumed gender, appearance, or the cover's child/outfit — a separate likeness judge owns identity. Cast counts PEOPLE only.
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
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{ scores: object, minScore: number, pass: boolean, tags: string[],
 *   defects: string[], criticalDefects: string[], minorDefects: string[], model: string }>}
 *   `pass` is true iff NO critical defects exist (scores rank, they don't gate).
 *   `defects` stays a flat string list (criticals first) for the repair-wave
 *   and needs_review consumers.
 */
async function judgeSpreadCandidate({ candidate, sceneContract, direction = null, coverImage = null, abortSignal }) {
  const { json, model } = await callVisionRole('QA_VISION', {
    prompt: buildSpreadJudgePrompt({ sceneContract, direction, hasCover: Boolean(coverImage) }),
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

  let normalized = normalizeDefects(json.defects);
  // Deterministic backstop: hard tags escalate every defect note to critical
  // even if the model labeled them minor (or emitted legacy strings) — the
  // enumerated tag list is the enforcement rail, not the model's prose.
  const hardTagged = tags.some((t) => HARD_FAIL_TAGS.includes(t));
  if (hardTagged) {
    normalized = normalized.map((d) => ({ ...d, severity: 'critical' }));
    if (normalized.length === 0) {
      normalized.push({ note: `hard-fail tag present (${tags.filter((t) => HARD_FAIL_TAGS.includes(t)).join(', ')})`, severity: 'critical' });
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
    model,
  };
}

module.exports = {
  judgeSpreadCandidate,
  buildSpreadJudgePrompt,
  SPREAD_PASS_SCORE,
  SPREAD_QA_TAGS,
  HARD_FAIL_TAGS,
};
