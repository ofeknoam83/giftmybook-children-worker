/**
 * Clean wrapper around existing services/pronouns.js for the Writer V2 pipeline.
 *
 * Provides pronoun checking and fixing for generated story text.
 */

const {
  getPronounInfo,
  buildPronounInstruction,
  checkPronounConsistency,
  simpleReplace,
  findPossessivePronounErrors,
  fixPossessivePronounErrors,
} = require('../../pronouns');

/**
 * Check all spreads for pronoun consistency and fix any issues.
 *
 * Fixes two classes of error:
 *   (a) wrong-gender pronouns (e.g. "she" for a boy) — handled by
 *       checkPronounConsistency + simpleReplace.
 *   (b) object-for-possessive grammar (e.g. "him hair" → "his hair") —
 *       handled by findPossessivePronounErrors + fixPossessivePronounErrors.
 *       This runs for ALL genders because `simpleReplace` for male children
 *       converts "her" → "him" (both spellings collapse) and can itself
 *       produce "him hair" that we must repair downstream.
 *
 * @param {Array<{ text: string }>} spreads
 * @param {string} gender - 'female', 'male', or 'neutral'
 * @returns {{ fixed: boolean, issues: Array<object> }}
 */
function checkAndFixPronouns(spreads, gender) {
  let fixed = false;
  const allIssues = [];

  for (const spread of spreads) {
    if (!spread.text) continue;
    const check = checkPronounConsistency(spread.text, gender);
    if (!check.valid) {
      allIssues.push(...check.issues);
      spread.text = simpleReplace(spread.text, gender);
      fixed = true;
    }
    const possessiveErrors = findPossessivePronounErrors(spread.text);
    if (possessiveErrors.length > 0) {
      for (const e of possessiveErrors) {
        allIssues.push({
          pronoun: e.pronoun,
          type: 'object-as-possessive',
          position: e.position,
          context: e.context,
          suggested: `his ${e.noun}`,
        });
      }
      spread.text = fixPossessivePronounErrors(spread.text);
      fixed = true;
    }
  }

  return { fixed, issues: allIssues };
}

/**
 * Score pronoun correctness deterministically (no LLM needed).
 * @param {Array<{ text: string }>} spreads
 * @param {string} gender
 * @returns {number} score 1-10
 */
function scorePronounCorrectness(spreads, gender) {
  if (!gender || gender === 'neutral' || gender === 'not specified') return 10;

  let totalIssues = 0;
  let totalWords = 0;
  for (const spread of spreads) {
    if (!spread.text) continue;
    const check = checkPronounConsistency(spread.text, gender);
    totalIssues += check.issues.length;
    totalWords += spread.text.split(/\s+/).length;
  }

  if (totalIssues === 0) return 10;
  if (totalIssues <= 1) return 7;
  if (totalIssues <= 3) return 4;
  return 1;
}

module.exports = {
  getPronounInfo,
  buildPronounInstruction,
  checkPronounConsistency,
  simpleReplace,
  checkAndFixPronouns,
  scorePronounCorrectness,
};
