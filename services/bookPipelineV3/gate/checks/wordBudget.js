/**
 * Words-per-spread budget check.
 *
 * V3 drops v2's syllable-window enforcement (a counterweight to forced
 * rhyme that V3 doesn't need) but keeps the words-per-spread window —
 * that one is a TYPESETTING constraint: the layout engine reserves a
 * text zone sized for the band's budget, and overflowing it breaks the
 * printed page regardless of how good the prose is.
 */

function countWords(text) {
  return String(text || '')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .length;
}

function wordBudgetCheck(draft, beat, ageProfile) {
  const cfg = ageProfile?.narrativeConstraints?.wordsPerSpread;
  if (!cfg) return { passed: true };
  const words = countWords(draft?.text);
  if (words < cfg.min || words > cfg.max) {
    return {
      passed: false,
      code: 'word_budget',
      message: `Spread has ${words} words; band requires ${cfg.min}-${cfg.max} (target ~${cfg.target}). This is a typesetting limit — the printed text zone cannot fit more.`,
      detail: { observed: words, min: cfg.min, max: cfg.max, target: cfg.target },
    };
  }
  return { passed: true };
}

module.exports = { wordBudgetCheck, countWords };
