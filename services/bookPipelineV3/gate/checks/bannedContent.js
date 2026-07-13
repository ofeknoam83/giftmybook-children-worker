/**
 * Banned-content check.
 *
 * Two sources, one check:
 *   1. Brief-supplied `constraints.banned_elements` — order-specific things
 *      the parent's answers ruled out (threaded via ctx.bannedElements).
 *   2. The shared moralising-phrase lexicon (required from v2 so the two
 *      pipelines never drift) — "believe in yourself"-class narration is
 *      banned content in V3, same as v2.
 */

const { moralisingPhrasesCheck } = require('../../../bookPipelineV2/gate/checks/moralisingPhrases');

function bannedContentCheck(draft, beat, ageProfile, ctx = {}) {
  const text = String(draft?.text || '').toLowerCase();

  const banned = Array.isArray(ctx.bannedElements) ? ctx.bannedElements : [];
  const hits = banned
    .map((b) => String(b || '').toLowerCase().trim())
    .filter((b) => b.length > 2 && text.includes(b));
  if (hits.length) {
    return {
      passed: false,
      code: 'banned_element',
      message: `Spread contains banned element(s) from the creative brief: ${hits.map((h) => `'${h}'`).join(', ')}.`,
      detail: { hits },
    };
  }

  const moral = moralisingPhrasesCheck(draft);
  if (!moral.passed) return moral;

  return { passed: true };
}

module.exports = { bannedContentCheck };
