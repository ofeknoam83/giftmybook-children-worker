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
const { ART_DIRECTION_REASKS } = require('../config');

const ZONES = ['left-top', 'left-bottom', 'right-top', 'right-bottom', 'left', 'right'];

function buildDirectorPrompt({ manuscript, ageBand, violations = null }) {
  const contracts = manuscript.spreads.map((s) => ({
    spread: s.spread,
    setting: s.scene_contract?.setting,
    characters: s.scene_contract?.characters_present,
    action: s.scene_contract?.hero_action,
    emotion: s.scene_contract?.emotion,
    objects: s.scene_contract?.key_objects,
    time: s.scene_contract?.time_of_day,
  }));

  return `You are the art director for a children's picture book ("${manuscript.title}", age band ${ageBand}).
Image 1 is the child's character model sheet; image 2 (if present) is the parent-approved cover — outfit and style ground truth.

MANUSCRIPT SCENE CONTRACTS (${contracts.length} spreads):
${JSON.stringify(contracts, null, 1)}

Plan the book's visual storytelling. Return STRICT JSON:
{
  "spreads": [
    {
      "spread": 1,
      "shot": "one of: ${SHOT_TYPES.join(' | ')}",
      "textZone": "one of: ${ZONES.join(' | ')} — the area kept visually quiet",
      "palette": "palette + lighting for this spread, consistent with its act",
      "continuityNotes": "recurring props/outfit/cast locks relevant HERE"
    }, ...
  ],
  "paletteArc": { "act1": "...", "act2": "...", "act3": "..." },
  "continuityLocks": { "outfit": "from the cover", "props": [{ "name": "...", "spreads": [..] }] },
  "worldPlates": [ { "location": "exact setting string as it appears in the contracts", "spreads": [..] } ],
  "bounces": [ { "spread": n, "problem": "why this contract cannot be staged (age-impossible action, prop soup, unstageable)", "suggestion": "targeted prose fix" } ]
}

RULES:
- SHOT VARIETY IS A HARD BUDGET: at least 4 distinct shot types across the book; NO two adjacent spreads may share a shot type.
- The palette arc must move with the story (e.g. darken at the low point, warm at the resolution).
- worldPlates: only locations visited on 2+ spreads.
- bounces: be strict — an ${ageBand} child cannot perform impossible locomotion; flag it rather than plan around it.${violations ? `\n\nYOUR PREVIOUS PLAN VIOLATED THE SHOT BUDGET:\n- ${violations.join('\n- ')}\nFix exactly these violations and return the corrected full JSON.` : ''}`;
}

/**
 * @param {object} opts
 * @param {object} opts.manuscript
 * @param {string} opts.ageBand
 * @param {Array<{base64: string, mimeType?: string}>} opts.referenceImages - [sheet, cover?]
 * @param {AbortSignal} [opts.abortSignal]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ directionBySpread: Map<number, object>, paletteArc: object, continuityLocks: object, worldPlates: object[], bounces: object[], shotBudget: {ok: boolean, reassigned: boolean} }>}
 */
async function runArtDirection({ manuscript, ageBand, referenceImages, abortSignal, log = () => {} }) {
  let plan = null;
  let violations = null;

  for (let attempt = 0; attempt <= ART_DIRECTION_REASKS; attempt += 1) {
    const { json } = await callVisionRole('ART_DIRECTOR', {
      prompt: buildDirectorPrompt({ manuscript, ageBand, violations }),
      images: referenceImages,
      label: `v3.artdirector.r${attempt}`,
      expectJson: true,
      abortSignal,
    });
    plan = json;
    const rows = (plan.spreads || []).map((r) => ({ spread: r.spread, shot: r.shot }));
    const check = validateShotBudget(rows);
    if (check.ok) {
      return finalize(plan, manuscript, { ok: true, reassigned: false });
    }
    violations = check.violations;
    log(`art direction attempt ${attempt}: shot-budget violations — ${violations.join('; ')}`);
  }

  // Deterministic repair — guaranteed to satisfy the budget.
  log('art direction: re-ask exhausted — deterministic shot reassignment');
  const repaired = reassignShots((plan.spreads || []).map((r) => ({ ...r, shot: r.shot })));
  plan.spreads = plan.spreads.map((r, i) => ({ ...r, shot: repaired[i].shot }));
  return finalize(plan, manuscript, { ok: true, reassigned: true });
}

function finalize(plan, manuscript, shotBudget) {
  const directionBySpread = new Map();
  for (const row of plan.spreads || []) {
    directionBySpread.set(Number(row.spread), {
      shot: normalizeShot(row.shot) || 'medium',
      textZone: ZONES.includes(row.textZone) ? row.textZone : null,
      palette: row.palette || null,
      continuityNotes: row.continuityNotes || null,
    });
  }
  // Every manuscript spread gets a row, even if the model skipped one.
  for (const s of manuscript.spreads) {
    if (!directionBySpread.has(s.spread)) {
      directionBySpread.set(s.spread, { shot: 'medium', textZone: null, palette: null, continuityNotes: null });
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

module.exports = { runArtDirection, buildDirectorPrompt, ZONES };
