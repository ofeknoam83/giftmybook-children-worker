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
 *   - pastTense           (from v2)      self-gates to present-tense books (narrativeTenseFor —
 *                                        the lap-baby bands; past-tense books get the soft
 *                                        tense_drift book lint instead)
 *   - onomatopoeia        (2026-08-02)   sound-effect usage ("tap tap", "Whoosh!") — reduplication
 *                                        is HARD for INFANT/TODDLER/PRESCHOOL
 *
 * All checks share v2's signature: (draft, beat, ageProfile, ctx) →
 * { passed, code?, message?, detail? }. `beat` is unused in V3 (no beat
 * sheet) and passed as null.
 */

const { lineCountCheck } = require('./checks/lineCount');
const { identityRhymeCheck } = require('./checks/identityRhyme');
const { protagonistAntiVerbCheck } = require('./checks/protagonistAntiVerb');
const { pastTenseCheck } = require('./checks/pastTense');
const { wordBudgetCheck } = require('./checks/wordBudget');
const { bannedContentCheck } = require('./checks/bannedContent');
const { nameLockCheck } = require('./checks/nameLock');
const { bannedWordsCheck } = require('./checks/bannedWords');
const { onomatopoeiaCheck } = require('./checks/onomatopoeia');
const { midlinePunctuationCheck } = require('./checks/sentenceQuality');
const { runBookChecks } = require('./checks/bookChecks');
const { runBookLints } = require('./checks/bookLints');

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
  // 2026-07-29 QA-review codes (Liv book) — see QA_REVIEW_HARD_CODES.
  'banned_word',
  'midline_punctuation',
  'opening_beat_name',
  'parent_name_missing',
  // 2026-08-02 customer feedback ("tap tap" everywhere) — also demotable.
  'onomatopoeia',
]);

// The 2026-07-29 additions, individually demotable: with
// BOOK_PIPELINE_V3_QA_HARD=0 they still run and still feed revision notes
// (a non-hard per-spread failure rides mergeTargets) but never count toward
// hardFailureCount — the safe first-deploy posture while the panel
// exhaustion rate is being watched.
const QA_REVIEW_HARD_CODES = new Set([
  'banned_word',
  'midline_punctuation',
  'opening_beat_name',
  'parent_name_missing',
  'onomatopoeia',
]);

/** Whether a failure code hard-blocks, honoring the QA-review rollback env. */
function isHardCode(code) {
  if (!HARD_GATE_CODES.has(code)) return false;
  if (QA_REVIEW_HARD_CODES.has(code) && process.env.BOOK_PIPELINE_V3_QA_HARD === '0') return false;
  return true;
}

function buildChecks(form) {
  const checks = [
    { name: 'wordBudget', fn: wordBudgetCheck },
    { name: 'lineCount', fn: lineCountCheck },
    { name: 'bannedContent', fn: bannedContentCheck },
    { name: 'nameLock', fn: nameLockCheck },
    { name: 'protagonistAntiVerb', fn: protagonistAntiVerbCheck },
    { name: 'pastTense', fn: pastTenseCheck },
    { name: 'bannedWords', fn: bannedWordsCheck },
    { name: 'onomatopoeia', fn: onomatopoeiaCheck },
    { name: 'midlinePunctuation', fn: midlinePunctuationCheck },
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

  // Book-level HARD checks (opening_beat_name, parent_name_missing) —
  // each failure is attributed to a spread and merged into that spread's
  // entry, so hardFailureCount / mergeTargets / the surgical gatefix all
  // see it like any per-spread failure. A throwing implementation becomes
  // a failure entry (same contract as per-spread `${name}_threw`): the
  // gate fails loudly instead of silently skipping its hard checks.
  let bookCheckFailures;
  try {
    bookCheckFailures = runBookChecks(manuscript, ageProfile, ctx);
  } catch (err) {
    bookCheckFailures = [{
      spread: perSpread[0]?.spread ?? 1,
      check: 'bookChecks',
      code: 'book_checks_threw',
      message: `Book checks threw: ${err.message}`,
    }];
  }
  for (const failure of bookCheckFailures) {
    const entry = perSpread.find((e) => e.spread === failure.spread);
    const { spread, ...rest } = failure;
    if (entry) {
      entry.failures.push(rest);
      entry.passed = false;
    } else {
      perSpread.push({ spread, passed: false, failures: [rest] });
    }
  }

  const hardFailureCount = perSpread.reduce(
    (acc, e) => acc + e.failures.filter((f) => isHardCode(f.code)).length,
    0,
  );
  return {
    passed: perSpread.every((e) => e.passed),
    perSpread,
    hardFailureCount,
    // Book-level SOFT lints (duplicate climax, unintroduced prop, word
    // overuse, refrain/hook variety, word length, fragment/staccato style,
    // sentence length, concept overload, name scarcity, story-role usage)
    // — never gate, never count as hard failures; they feed the editor's
    // revision notes when a revision round runs (and the post-panel polish
    // pass).
    softLints: runBookLints(manuscript, {
      ageProfile,
      protagonistName: ctx.protagonistName,
      storyRoles: ctx.storyRoles,
      interests: ctx.interests,
    }),
  };
}

function hardFailures(failures) {
  if (!Array.isArray(failures)) return [];
  return failures.filter((f) => isHardCode(f.code));
}

module.exports = {
  runSpreadGate,
  runManuscriptGate,
  buildChecks,
  hardFailures,
  isHardCode,
  HARD_GATE_CODES,
  QA_REVIEW_HARD_CODES,
};
