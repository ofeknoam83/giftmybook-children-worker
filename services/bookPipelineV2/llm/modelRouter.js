/**
 * Model router for v2.
 *
 * Note: prior versions enforced a cross-family rule (writer ≠ critic family).
 * That rule was a v1-era reaction to writer-judges-itself loops. In v2 the
 * deterministic gate + manuscript-level critic prompt + bounded context
 * constrain the critic enough — and gpt-5.4 is empirically our best writer
 * AND our best critic. The cross-family rule is dropped; both writer and
 * critic resolve to gpt-5.4 (strong).
 *
 * Roles:
 *   - PLANNER     — interpreter, intent, story planner, beat sheet
 *   - WRITER      — manuscript writer, revision engine
 *   - CRITIC      — manuscript critic
 *   - ADJUDICATOR — final tie-breaker
 *   - DIRECTOR    — illustration director (text-to-spec)
 *   - RHYME_JUDGE — acoustic rhyme verdicts on couplet end-words (combined call)
 *
 * The router can be reconfigured per env (e.g. set
 * `BOOK_PIPELINE_V2_CRITIC_FAMILY=gemini` to A/B-test pairings).
 */

const { callText } = require('../../bookPipeline/llm/openaiClient');

// Model identifiers (kept in one place so swaps are one-line).
// Note: we use gpt-5.4 family (NOT gpt-5) because gpt-5 reasoning models
// don't accept custom `temperature` (only the default value of 1). v1 has
// run on gpt-5.4 in production for months — sticking with what works.
const MODELS = {
  openai_strong: 'gpt-5.4',
  openai_mid: 'gpt-5.4-mini',
  gemini_strong: 'gemini-2.5-pro',
  gemini_mid: 'gemini-2.5-flash',
};

// Default role → family + tier.
// Manuscript-level v2: WRITER, CRITIC, REVISION (treated as WRITER) all use
// gpt-5.4 strong. They each make ONE call per manuscript (not 12), so the
// cost stays roughly equivalent to the per-spread mid-tier setup, while
// quality goes up because each call sees the whole book.
const DEFAULT_ROUTING = {
  PLANNER:     { family: 'openai',  tier: 'strong' },
  WRITER:      { family: 'openai',  tier: 'strong' },
  CRITIC:      { family: 'openai',  tier: 'strong' },
  ADJUDICATOR: { family: 'openai',  tier: 'strong' },
  DIRECTOR:    { family: 'openai',  tier: 'mid' },
  SUMMARIZER:  { family: 'gemini',  tier: 'mid' }, // legacy; no longer used in v2 manuscript flow
  RHYME_JUDGE: { family: 'openai',  tier: 'mid' }, // acoustic-only task, mid tier is plenty
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

/**
 * Cross-family check is retained as a no-op for back-compat with callers
 * still passing `mustDifferFrom`. v2 no longer enforces this — both writer
 * and critic intentionally resolve to gpt-5.4 strong.
 */
function assertCrossFamily(/* roleA, roleB */) {
  // intentionally no-op; cross-family rule dropped in manuscript-level v2
}

/**
 * Call a role. The optional `mustDifferFrom` parameter is accepted for
 * back-compat but no longer enforced.
 */
async function callWithRole(role, params, /* { mustDifferFrom } = {} */) {
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
