/**
 * V3 deterministic gate runner.
 *
 * Deliberately SMALLER than v2's (docs/PIPELINE_V3_DESIGN.md §4 W4): most
 * of v2's checks were counterweights to forced rhyme (syllable windows,
 * filler-phrase blocklists, line-starter monotony), and V3 lets the story
 * choose its form — those failure modes become judge-rubric material, not
 * gates. What remains is objective breakage:
 *
 *   - wordBudget          (new)          typesetting limit
 *   - lineCount           (from v2)      band line window
 *   - bannedContent       (new)          brief banned_elements + moralising lexicon
 *   - nameLock            (new)          child-name spelling + pronoun lock
 *   - protagonistAntiVerb (from v2)      objectified child / age-impossible verbs
 *   - identityRhyme       (from v2)      ONLY when the manuscript's form is rhymed_verse
 *   - pastTense           (from v2)      self-gates to PB_INFANT/PB_TODDLER bands
 *
 * All checks share v2's signature: (draft, beat, ageProfile, ctx) →
 * { passed, code?, message?, detail? }. `beat` is unused in V3 (no beat
 * sheet) and passed as null.
 */

const { lineCountCheck } = require('../../bookPipelineV2/gate/checks/lineCount');
const { identityRhymeCheck } = require('../../bookPipelineV2/gate/checks/identityRhyme');
const { protagonistAntiVerbCheck } = require('../../bookPipelineV2/gate/checks/protagonistAntiVerb');
const { pastTenseCheck } = require('../../bookPipelineV2/gate/checks/pastTense');
const { wordBudgetCheck } = require('./checks/wordBudget');
const { bannedContentCheck } = require('./checks/bannedContent');
const { nameLockCheck } = require('./checks/nameLock');

// Codes that must never ship (structural breaks). Everything else the
// judges weigh; these the machine refuses.
const HARD_GATE_CODES = new Set([
  'word_budget',
  'line_count',
  'banned_element',
  'moralising_phrase',
  'name_misspelled',
  'pronoun_lock',
  'protagonist_anti_verb',
  'identity_rhyme',
  'past_tense_regular',
  'past_tense_irregular',
]);

function buildChecks(form) {
  const checks = [
    { name: 'wordBudget', fn: wordBudgetCheck },
    { name: 'lineCount', fn: lineCountCheck },
    { name: 'bannedContent', fn: bannedContentCheck },
    { name: 'nameLock', fn: nameLockCheck },
    { name: 'protagonistAntiVerb', fn: protagonistAntiVerbCheck },
    { name: 'pastTense', fn: pastTenseCheck },
  ];
  if (form === 'rhymed_verse') {
    checks.push({ name: 'identityRhyme', fn: identityRhymeCheck });
  }
  return checks;
}

/**
 * Gate one spread draft.
 *
 * @param {{ spread: number, text: string, lines: string[] }} draft
 * @param {object} ageProfile
 * @param {{ form: string, protagonistName?: string, pronouns?: object, bannedElements?: string[] }} ctx
 */
async function runSpreadGate(draft, ageProfile, ctx = {}) {
  const failures = [];
  for (const { name, fn } of buildChecks(ctx.form)) {
    let r;
    try {
      r = await fn(draft, null, ageProfile, ctx);
    } catch (err) {
      r = { passed: false, code: `${name}_threw`, message: `Gate check '${name}' threw: ${err.message}` };
    }
    if (!r.passed) failures.push({ check: name, ...r });
  }
  return { passed: failures.length === 0, failures };
}

/**
 * Gate a whole manuscript. Synchronous checks only — no LLM calls.
 *
 * @param {{ form: string, spreads: Array }} manuscript
 * @param {object} ageProfile
 * @param {{ protagonistName?: string, pronouns?: object, bannedElements?: string[] }} ctx
 * @returns {{ passed: boolean, perSpread: Array<{spread, passed, failures}>, hardFailureCount: number }}
 */
async function runManuscriptGate(manuscript, ageProfile, ctx = {}) {
  const perSpread = [];
  for (const spread of manuscript.spreads || []) {
    const { passed, failures } = await runSpreadGate(spread, ageProfile, { ...ctx, form: manuscript.form });
    perSpread.push({ spread: spread.spread, passed, failures });
  }
  const hardFailureCount = perSpread.reduce(
    (acc, e) => acc + e.failures.filter((f) => HARD_GATE_CODES.has(f.code)).length,
    0,
  );
  return {
    passed: perSpread.every((e) => e.passed),
    perSpread,
    hardFailureCount,
  };
}

function hardFailures(failures) {
  if (!Array.isArray(failures)) return [];
  return failures.filter((f) => HARD_GATE_CODES.has(f.code));
}

module.exports = {
  runSpreadGate,
  runManuscriptGate,
  buildChecks,
  hardFailures,
  HARD_GATE_CODES,
};
