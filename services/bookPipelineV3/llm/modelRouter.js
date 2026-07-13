/**
 * Model router for bookPipelineV3.
 *
 * V3 routes its writing-craft roles to Claude (docs/PIPELINE_V3_DESIGN.md §8)
 * and keeps the judge panel CROSS-FAMILY — three judges from three different
 * model families score manuscripts blind, so no family judges its own prose
 * (self-preference defense).
 *
 * Roles:
 *   - BRIEF    — W0 creative brief
 *   - CONCEPT  — W1 story concepts (×3, diversity from angles not families)
 *   - EDITOR   — W2 editorial selection (deliberately NOT the writer family)
 *   - WRITER   — W3 manuscripts + W6 revisions + gate mechanical fixes
 *   - JUDGE_A / JUDGE_B / JUDGE_C — W5 panel, one per family
 *
 * Per-deploy override: BOOK_PIPELINE_V3_<ROLE>_FAMILY / _TIER (same
 * mechanism as v2's BOOK_PIPELINE_V2_* overrides).
 */

const { callText } = require('../../bookPipeline/llm/openaiClient');
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
  BRIEF:   { family: 'anthropic', tier: 'strong' },
  CONCEPT: { family: 'anthropic', tier: 'strong' },
  EDITOR:  { family: 'openai',    tier: 'strong' },
  WRITER:  { family: 'anthropic', tier: 'strong' },
  JUDGE_A: { family: 'anthropic', tier: 'strong' },
  JUDGE_B: { family: 'openai',    tier: 'strong' },
  JUDGE_C: { family: 'gemini',    tier: 'strong' }, // deepseek is the env-flippable alternative
};

const JUDGE_ROLES = ['JUDGE_A', 'JUDGE_B', 'JUDGE_C'];

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
  modelFor,
  resolveRole,
  requiredApiKeys,
  validatePanelFamilies,
  callWithRole,
};
