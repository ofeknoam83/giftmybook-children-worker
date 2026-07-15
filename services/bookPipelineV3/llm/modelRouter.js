/**
 * Model router for bookPipelineV3.
 *
 * Defaults run entirely on the vendors the worker already has keys for
 * (openai / deepseek / gemini) — product decision 2026-07-13: no new
 * vendor dependency for milestone 1. The anthropic family stays fully
 * wired (client + MODELS + env keys) so any role can be flipped to
 * Claude per-deploy for A/B tests:
 *   BOOK_PIPELINE_V3_WRITER_FAMILY=anthropic  (needs ANTHROPIC_API_KEY)
 *
 * The judge panel stays CROSS-FAMILY — three judges from three different
 * model families score manuscripts blind, so no single family's tastes
 * dominate the verdict (self-preference defense). With an openai writer,
 * JUDGE_B shares the writer's family (same relationship the original
 * claude-writer design had with its claude judge).
 *
 * Roles:
 *   - BRIEF    — W0 creative brief
 *   - CONCEPT  — W1 story concepts (×3, diversity from angles not families)
 *   - EDITOR   — W2 editorial selection (deliberately NOT the writer family)
 *   - WRITER   — W3 manuscripts + W6 revisions + gate mechanical fixes
 *   - JUDGE_A / JUDGE_B / JUDGE_C — W5 panel, one per family
 *   - ART_DIRECTOR — A1 art direction (multimodal: sees cover + sheet)
 *   - QA_VISION — A3 spread QA (anatomy, contract adherence, zones, style, cast)
 *   - LIKENESS_JUDGE_A / LIKENESS_JUDGE_B — A0/A3 likeness vs the photo,
 *     enforced cross-family (validateLikenessFamilies)
 *
 * Per-deploy override: BOOK_PIPELINE_V3_<ROLE>_FAMILY / _TIER (same
 * mechanism as v2's BOOK_PIPELINE_V2_* overrides).
 */

const { callText } = require('../../shared/llm/openaiClient');
const { callClaude } = require('./anthropicClient');

const MODELS = {
  anthropic_strong: 'claude-opus-4-8',
  anthropic_mid:    'claude-sonnet-5',
  openai_strong:    'gpt-5.4',
  openai_mid:       'gpt-5.4-mini',
  gemini_strong:    'gemini-2.5-pro',
  gemini_mid:       'gemini-2.5-flash',
  deepseek_strong:  'deepseek-v4-pro',
  deepseek_mid:     'deepseek-v4-flash',
};

const DEFAULT_ROUTING = {
  BRIEF:   { family: 'openai',   tier: 'strong' },
  CONCEPT: { family: 'openai',   tier: 'strong' },
  // EDITOR + JUDGE_A run the FAST deepseek tier (2026-07-15 latency fix):
  // deepseek-v4-pro is a reasoning model that took 60-230s per call, and
  // the whole panel waits for its slowest judge. Family unchanged (the
  // panel stays cross-family); flip back per-role via
  // BOOK_PIPELINE_V3_<ROLE>_TIER=strong if quality regresses.
  EDITOR:  { family: 'deepseek', tier: 'mid' }, // cross-family from the openai writer
  WRITER:  { family: 'openai',   tier: 'strong' },
  JUDGE_A: { family: 'deepseek', tier: 'mid' },
  JUDGE_B: { family: 'openai',   tier: 'strong' },
  JUDGE_C: { family: 'gemini',   tier: 'strong' },
  // ── Native illustrator roles (milestone 2 Phase 0) ──
  // ART_DIRECTOR must SEE the cover + character sheet (multimodal); the
  // vision QA judge is cheap at candidate volume; the two likeness judges
  // are deliberately cross-family — likeness is the product promise, and a
  // single family grading its own generator invites self-preference.
  ART_DIRECTOR:     { family: 'gemini', tier: 'strong' },
  QA_VISION:        { family: 'gemini', tier: 'mid' },
  LIKENESS_JUDGE_A: { family: 'gemini', tier: 'mid' },
  LIKENESS_JUDGE_B: { family: 'openai', tier: 'strong' },
};

const JUDGE_ROLES = ['JUDGE_A', 'JUDGE_B', 'JUDGE_C'];
const LIKENESS_ROLES = ['LIKENESS_JUDGE_A', 'LIKENESS_JUDGE_B'];

// Env keys each family needs at run time. Gemini accepts either key
// (openaiClient's resolveGeminiKey checks both).
const FAMILY_ENV_KEYS = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_AI_STUDIO_KEY'],
};

function envOverride(role) {
  const family = process.env[`BOOK_PIPELINE_V3_${role}_FAMILY`];
  const tier = process.env[`BOOK_PIPELINE_V3_${role}_TIER`];
  if (!family && !tier) return null;
  return {
    family: family || DEFAULT_ROUTING[role].family,
    tier: tier || DEFAULT_ROUTING[role].tier,
  };
}

function resolveRole(role) {
  const override = envOverride(role);
  return override || DEFAULT_ROUTING[role] || DEFAULT_ROUTING.WRITER;
}

function modelFor(role) {
  const { family, tier } = resolveRole(role);
  const key = `${family}_${tier}`;
  const model = MODELS[key];
  if (!model) throw new Error(`bookPipelineV3 modelRouter: no model registered for ${key} (role=${role})`);
  return { model, family };
}

/**
 * Env keys the CURRENT routing (defaults + overrides) requires. A family
 * with alternative keys (gemini) is satisfied by any one of them, so it
 * contributes an array entry of alternatives.
 *
 * @returns {Array<string[]>} — each entry is a list of alternative env keys,
 *   at least one of which must be set.
 */
function requiredApiKeys() {
  const families = new Set(Object.keys(DEFAULT_ROUTING).map((role) => resolveRole(role).family));
  return Array.from(families).map((family) => FAMILY_ENV_KEYS[family] || []);
}

/**
 * The panel's whole value is that three DIFFERENT families judge blind.
 * Warn loudly (do not throw) when env overrides collapse the panel into
 * fewer families — the run still works, but the self-preference defense
 * is weakened and the operator should know.
 *
 * @returns {{ ok: boolean, families: string[] }}
 */
function validatePanelFamilies(log = (msg) => console.warn(msg)) {
  const families = JUDGE_ROLES.map((r) => resolveRole(r).family);
  const distinct = new Set(families);
  if (distinct.size < JUDGE_ROLES.length) {
    log(
      `[bookPipelineV3] JUDGE PANEL FAMILY COLLAPSE: judges resolve to [${families.join(', ')}] — ` +
      'fewer than 3 distinct model families. Blind cross-family scoring is degraded; ' +
      'check BOOK_PIPELINE_V3_JUDGE_*_FAMILY overrides.',
    );
    return { ok: false, families };
  }
  return { ok: true, families };
}

/**
 * Likeness judging must stay cross-family (the illustrator plan's hard
 * rule — the core promise is never graded by a single family). Same
 * warn-don't-throw contract as validatePanelFamilies.
 *
 * @returns {{ ok: boolean, families: string[] }}
 */
function validateLikenessFamilies(log = (msg) => console.warn(msg)) {
  const families = LIKENESS_ROLES.map((r) => resolveRole(r).family);
  const distinct = new Set(families);
  if (distinct.size < LIKENESS_ROLES.length) {
    log(
      `[bookPipelineV3] LIKENESS JUDGE FAMILY COLLAPSE: judges resolve to [${families.join(', ')}] — ` +
      'likeness must be scored by two distinct model families; ' +
      'check BOOK_PIPELINE_V3_LIKENESS_JUDGE_*_FAMILY overrides.',
    );
    return { ok: false, families };
  }
  return { ok: true, families };
}

/**
 * Call a role with family-appropriate dispatch. Anthropic goes through
 * callClaude (which never sends sampling params); every other family goes
 * through v1's callText with cross-family fallback disabled — V3 reports
 * exactly which model produced every artifact, so silent family swaps
 * would poison pipeline A/B comparisons.
 */
async function callWithRole(role, params) {
  const { model, family } = modelFor(role);
  const label = params.label || `v3.${role.toLowerCase()}`;
  if (family === 'anthropic') {
    const { temperature: _ignored, ...rest } = params;
    return callClaude({ ...rest, model, label });
  }
  return callText({ ...params, model, label, allowGeminiFallback: false });
}

module.exports = {
  MODELS,
  DEFAULT_ROUTING,
  JUDGE_ROLES,
  LIKENESS_ROLES,
  modelFor,
  resolveRole,
  requiredApiKeys,
  validatePanelFamilies,
  validateLikenessFamilies,
  callWithRole,
};
