/**
 * Shared text primitives for gate checks and book lints (2026-07-29 QA
 * hardening). Extracted from bookLints.js when the banned-word /
 * sentence-quality checks became additional consumers — one sentence
 * splitter, one inflection matcher, no drift.
 */

/** Normalize a sentence for comparison: lowercase, strip punctuation/quotes. */
function normalizeSentence(s) {
  return String(s)
    .toLowerCase()
    .replace(/[“”"'‘’…—–-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split spread text into sentences (., !, ? boundaries). */
function sentencesOf(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Sorted spreads accessor shared by whole-manuscript checks. */
function sortedSpreads(manuscript) {
  return (manuscript.spreads || []).slice().sort((a, b) => a.spread - b.spread);
}

/** A spread's lines, tolerating text-only spreads. */
function linesOf(s) {
  if (Array.isArray(s.lines) && s.lines.length) return s.lines.map(String);
  return String(s.text || '').split('\n').filter((l) => l.trim());
}

/** Word tokens of a sentence/text (letters + apostrophes), original case. */
function wordsOf(text) {
  return String(text || '').match(/[A-Za-z’']+/g) || [];
}

/** Whether a sentence is (or contains) quoted dialogue. */
function isDialogue(sentence) {
  return /["“”]/.test(String(sentence || ''));
}

/**
 * Inflected forms of a base word: base, +s, +es, +ed, +ing, with final-e
 * drop (glide → gliding) and CVC consonant doubling (skim → skimming),
 * and consonant+y → -ies/-ied (carry → carries/carried).
 *
 * @param {string} base
 * @returns {string[]} lowercase surface forms
 */
function inflectionsOf(base) {
  const w = String(base || '').toLowerCase();
  if (!w) return [];
  const forms = new Set([w, `${w}s`, `${w}es`]);
  if (w.endsWith('e')) {
    forms.add(`${w}d`);
    forms.add(`${w.slice(0, -1)}ing`);
  } else if (/[^aeiou]y$/.test(w)) {
    forms.add(`${w.slice(0, -1)}ies`);
    forms.add(`${w.slice(0, -1)}ied`);
    forms.add(`${w}ing`);
  } else {
    forms.add(`${w}ed`);
    forms.add(`${w}ing`);
    if (/[^aeiou][aeiou][^aeiouwxy]$/.test(w)) {
      const doubled = w + w[w.length - 1];
      forms.add(`${doubled}ed`);
      forms.add(`${doubled}ing`);
    }
  }
  return [...forms];
}

/**
 * Build a Set of every inflected surface form for a list of base words.
 *
 * @param {string[]} bases
 * @returns {Set<string>}
 */
function inflectionSet(bases) {
  const set = new Set();
  for (const b of bases || []) for (const f of inflectionsOf(b)) set.add(f);
  return set;
}

module.exports = {
  normalizeSentence,
  sentencesOf,
  sortedSpreads,
  linesOf,
  wordsOf,
  isDialogue,
  inflectionsOf,
  inflectionSet,
};
