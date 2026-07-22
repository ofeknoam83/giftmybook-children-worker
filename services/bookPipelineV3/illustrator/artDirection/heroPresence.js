/**
 * Hero-presence gate (P1, 2026-07-23 audit — "Amit's Star Map Adventure"
 * shipped with the hero MISSING from 12 spreads, including the emotional
 * climax). A personalized book must star the child it is FOR: a spread whose
 * narration makes the child the acting subject may NOT be staged hero-absent,
 * and only a small budget of pure scene-setting plates across the whole book
 * may omit the child.
 *
 * As with the shot budget, the model's plan is never the contract: art
 * direction VALIDATES the plan deterministically, re-asks once naming the
 * violations, then falls back to a deterministic repair.
 */

const HERO_PRESENCE_VALUES = ['required', 'optional', 'absent'];

// At most this many spreads across the whole book may be hero-light
// ("optional" or "absent" combined) — everything else must star the child.
const MAX_HERO_LIGHT_SPREADS = 3;

/**
 * Does this scene contract describe the child DOING something (an action
 * spread), as opposed to a pure landscape/scene-setting beat? Used both for the
 * deterministic heroPresence fallback and to catch action spreads staged
 * hero-absent. Conservative: anything with a non-trivial hero_action counts.
 *
 * @param {object|null|undefined} sceneContract
 * @returns {boolean}
 */
function isActionSpread(sceneContract) {
  const action = String(sceneContract?.hero_action || '').trim().toLowerCase();
  if (!action) return false;
  // Treat explicit "no hero" / scene-only sentinels as non-action.
  if (/^(none|n\/?a|no action|scene only|establishing)\b/.test(action)) return false;
  return action.length > 0;
}

/**
 * Normalize a model-emitted heroPresence onto the enum. When missing/invalid,
 * fall back deterministically from the scene contract: an action spread
 * defaults to "required" (the child stars); a contract with no hero action
 * defaults to "optional" (the child MAY appear but the beat can be scene-first).
 *
 * @param {string|null|undefined} raw
 * @param {object|null|undefined} sceneContract
 * @returns {'required'|'optional'|'absent'}
 */
function normalizeHeroPresence(raw, sceneContract) {
  const v = String(raw || '').trim().toLowerCase();
  if (HERO_PRESENCE_VALUES.includes(v)) return v;
  return isActionSpread(sceneContract) ? 'required' : 'optional';
}

/**
 * @param {Array<{spread: number, heroPresence: string, isAction: boolean}>} rows - ordered by spread
 * @returns {{ ok: boolean, violations: string[] }}
 */
function validateHeroPresence(rows) {
  const violations = [];
  for (const r of rows) {
    if (r.isAction && r.heroPresence === 'absent') {
      violations.push(`spread ${r.spread}: the child is the acting subject but the spread is staged hero-absent (must be "required")`);
    }
  }
  const light = rows.filter((r) => r.heroPresence === 'optional' || r.heroPresence === 'absent');
  if (light.length > MAX_HERO_LIGHT_SPREADS) {
    violations.push(`${light.length} hero-light spreads (optional/absent) exceed the book budget of ${MAX_HERO_LIGHT_SPREADS} — the child must star on the rest (spreads ${light.map((r) => r.spread).join(', ')})`);
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Deterministic repair — the guaranteed fallback after the one re-ask.
 * Forces every action spread to "required", then, if too many hero-light
 * spreads remain, promotes the LATER ones back to "required" (keeping the
 * earliest establishing beats hero-light) until within budget. Pure and stable.
 *
 * @param {Array<{spread: number, heroPresence: string, isAction: boolean}>} rows
 * @returns {Array<{spread: number, heroPresence: string, reassigned?: boolean}>}
 */
function reassignHeroPresence(rows) {
  const out = rows.map((r) => ({ spread: r.spread, heroPresence: r.heroPresence, isAction: r.isAction, reassigned: false }));

  // 1. action spreads must star the child
  for (const r of out) {
    if (r.isAction && r.heroPresence === 'absent') {
      r.heroPresence = 'required';
      r.reassigned = true;
    }
  }
  // 2. trim the hero-light budget from the END of the book forward, so the
  // climax and later action beats never stay hero-absent.
  let light = out.filter((r) => r.heroPresence !== 'required');
  for (let i = out.length - 1; i >= 0 && light.length > MAX_HERO_LIGHT_SPREADS; i -= 1) {
    if (out[i].heroPresence !== 'required') {
      out[i].heroPresence = 'required';
      out[i].reassigned = true;
      light = out.filter((r) => r.heroPresence !== 'required');
    }
  }
  return out.map((r) => ({ spread: r.spread, heroPresence: r.heroPresence, ...(r.reassigned ? { reassigned: true } : {}) }));
}

module.exports = {
  HERO_PRESENCE_VALUES,
  MAX_HERO_LIGHT_SPREADS,
  isActionSpread,
  normalizeHeroPresence,
  validateHeroPresence,
  reassignHeroPresence,
};
