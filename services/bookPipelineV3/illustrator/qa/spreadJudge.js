/**
 * Spread vision judge (A3, second tier) — scores one candidate against
 * its scene contract on the non-likeness dimensions:
 *
 *   anatomy / integrity, scene-contract adherence, cast compliance,
 *   style fidelity, quiet-zone compliance
 *
 * Likeness is deliberately NOT judged here — it has its own cross-family
 * judge (likenessJudge.js); this judge is single-family (QA_VISION,
 * cheap at candidate volume). The tag taxonomy mirrors the legacy
 * qaTagCounts so existing Cloud Logging dashboards keep working.
 */

const { callVisionRole } = require('../../llm/visionClient');

const SPREAD_PASS_SCORE = 4;

/** qaTagCounts-compatible tags the judge may emit. */
const SPREAD_QA_TAGS = [
  'anatomy_hands', 'anatomy_limbs', 'anatomy_face', 'object_integrity',
  'action_mismatch', 'setting_mismatch', 'missing_object', 'emotion_mismatch',
  'extra_character', 'duplicated_hero', 'missing_character',
  'style_drift', 'zone_busy',
];

function buildSpreadJudgePrompt({ sceneContract, direction }) {
  return `You are quality-judging a children's picture-book illustration against its scene contract. You are the PRINT-DEFECT gate: block images a parent would consider broken; do not block images over stylistic or interpretive nitpicks.

SCENE CONTRACT (what the image MUST show):
- Setting: ${sceneContract.setting || 'unspecified'}
- Characters present (exactly these, nobody else): ${(sceneContract.characters_present || []).join(', ') || 'the child'}
- The child's action: ${sceneContract.hero_action || 'unspecified'}
${direction?.moment ? `- THE DEPICTED MOMENT (judge the action against THIS, not the full action sentence): ${direction.moment}` : ''}
- Emotion: ${sceneContract.emotion || 'unspecified'}
- Required objects: ${(sceneContract.key_objects || []).join(', ') || 'none'}
${direction?.shot ? `- Directed shot (ADVISORY — never a scoring failure): ${direction.shot}` : ''}
${direction?.textZone ? `- Quiet zone: the ${direction.textZone} area must be visually calm/low-detail` : ''}

Score each dimension 1-5 (4 = good with minor imperfections, 5 = flawless) and tag concrete defects.
Return STRICT JSON:
{
  "anatomy": 1-5,          // hands, limbs, faces, object coherence
  "contract": 1-5,         // shows the contracted setting + action + objects
  "cast": 1-5,             // exactly the listed characters; 1 if the hero appears twice or strangers appear
  "style": 1-5,            // consistent storybook style, no photoreal/3D drift
  "zone": 1-5,             // quiet zone actually quiet (5 if no zone directed)
  "tags": ["choose only from: ${SPREAD_QA_TAGS.join(', ')}"],
  "defects": ["specific, actionable notes with locations"]
}
Rules:
- HARD FAILS (these always block): duplicated hero or a wrong/extra person caps cast at 1. Countable extra fingers, fused hands, or a third arm caps anatomy at 2.
- ONE-MOMENT RULE: a picture shows ONE instant. If the image plausibly depicts ANY moment within the contracted action ("tries to lift the lid" = hands on a closed lid OR a lid cracked open; "climbs the ladder" = on the ladder OR just arrived at the top), contract is satisfied — never fail for not depicting a sequence of actions in one frame.
- MOTION-PHASE ALLOWANCE: a still image cannot depict a motion phase. If the pose is consistent with the action at ANY plausible phase (foot ON the stone satisfies "mid-tap, connecting"; the stone AT the foot satisfies "just leaving the foot"), the contract is satisfied — never fail for static-vs-in-motion, resting-vs-tapping, or about-to-vs-just-did.
- MINOR-ANATOMY ALLOWANCE: subtle stiffness, a slightly awkward grip, or "somewhat unnatural" posing scores 4, not 3. "Stiff", "awkward", or "slightly unnatural" NEVER scores below 4 — only countably wrong anatomy (extra/missing/fused fingers, a third arm) blocks.
- OBJECT EQUIVALENCE: a required object is satisfied by a reasonable visual equivalent (judge intent, not the literal phrase).
- OBJECT CRITICALITY: a missing required object blocks ONLY when the action becomes unreadable without it. A small mechanism prop (peg, groove, panel, latch) that is absent while the action still reads clearly is an advisory defect note at contract 4, not a failure.
- NO IDENTITY OR GENDER JUDGING: you have no reference art. Never assess whether the character matches a name, assumed gender, or appearance — a separate likeness judge owns identity. Cast counts PEOPLE only.
- The directed shot is advisory context: a different framing is never a defect or score reduction.`;
}

/**
 * @param {object} opts
 * @param {{base64: string, mimeType?: string}} opts.candidate
 * @param {object} opts.sceneContract
 * @param {object|null} [opts.direction]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{ scores: object, minScore: number, pass: boolean, tags: string[], defects: string[], model: string }>}
 */
async function judgeSpreadCandidate({ candidate, sceneContract, direction = null, abortSignal }) {
  const { json, model } = await callVisionRole('QA_VISION', {
    prompt: buildSpreadJudgePrompt({ sceneContract, direction }),
    images: [candidate],
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
  return {
    scores,
    minScore,
    pass: minScore >= SPREAD_PASS_SCORE,
    tags: Array.isArray(json.tags) ? json.tags.filter((t) => SPREAD_QA_TAGS.includes(t)) : [],
    defects: Array.isArray(json.defects) ? json.defects.map(String) : [],
    model,
  };
}

module.exports = {
  judgeSpreadCandidate,
  buildSpreadJudgePrompt,
  SPREAD_PASS_SCORE,
  SPREAD_QA_TAGS,
};
