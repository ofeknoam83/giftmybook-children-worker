/**
 * Cross-family model router for v2.
 *
 * Locked principle: the writer model must NEVER be the critic model.
 * v1's writer-judges-itself loop is the single most important thing
 * v2 fixes. We have OpenAI (GPT-5 family) and Gemini available; this
 * router maps logical roles to physical models so the cross-family
 * rule is enforced at one place.
 *
 * Roles:
 *   - PLANNER     — interpreter, intent, story planner, beat sheet
 *   - WRITER      — page writer, revision engine
 *   - CRITIC      — spread critic, book-wide critic, meaning sanity
 *   - ADJUDICATOR — final tie-breaker (3rd family ideally; we use OpenAI strongest)
 *   - DIRECTOR    — illustration director (text-to-spec)
 *   - SUMMARIZER  — rolling-summary memory
 *
 * The router can be reconfigured per env (e.g. set
 * `BOOK_PIPELINE_V2_WRITER=openai` and `BOOK_PIPELINE_V2_CRITIC=gemini`
 * or vice versa to A/B-test both pairings).
 */

const { callText } = require('../../bookPipeline/llm/openaiClient');

// Model identifiers (kept in one place so swaps are one-line).
const MODELS = {
  openai_strong: 'gpt-5',
  openai_mid: 'gpt-5-mini',
  gemini_strong: 'gemini-2.5-pro',
  gemini_mid: 'gemini-2.5-flash',
};

// Default role → family + tier.
const DEFAULT_ROUTING = {
  PLANNER:     { family: 'openai',  tier: 'strong' },
  WRITER:      { family: 'openai',  tier: 'mid' },
  CRITIC:      { family: 'gemini',  tier: 'strong' }, // <-- different family from WRITER
  ADJUDICATOR: { family: 'openai',  tier: 'strong' },
  DIRECTOR:    { family: 'openai',  tier: 'mid' },
  SUMMARIZER:  { family: 'gemini',  tier: 'mid' },
};

function envOverride(role) {
  const family = process.env[`BOOK_PIPELINE_V2_${role}_FAMILY`];
  const tier = process.env[`BOOK_PIPELINE_V2_${role}_TIER`];
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
  if (!model) throw new Error(`modelRouter: no model registered for ${key} (role=${role})`);
  return { model, family };
}

function assertCrossFamily(roleA, roleB) {
  const a = resolveRole(roleA);
  const b = resolveRole(roleB);
  if (a.family === b.family) {
    throw new Error(
      `modelRouter: cross-family rule violated — role '${roleA}' and role '${roleB}' both resolve to family '${a.family}'. v2's locked principle is that writer and critic must never be the same family.`,
    );
  }
}

/**
 * Call a role with an enforced cross-family check against a counterpart
 * role. Use for critic calls so any misconfiguration fails loudly.
 */
async function callWithRole(role, params, { mustDifferFrom } = {}) {
  if (mustDifferFrom) assertCrossFamily(role, mustDifferFrom);
  const { model } = modelFor(role);
  return callText({ ...params, model, label: params.label || `v2.${role.toLowerCase()}` });
}

module.exports = {
  MODELS,
  modelFor,
  assertCrossFamily,
  callWithRole,
  resolveRole,
};
