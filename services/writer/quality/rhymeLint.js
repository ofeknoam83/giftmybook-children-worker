/**
 * Deterministic identical-word rhyme detection (adjacent line endings).
 * Complements the LLM critic PRE-SCAN A — catches cases the critic misses.
 */

/**
 * Strip trailing punctuation and lowercase for end-word comparison.
 * @param {string} line
 * @returns {string}
 */
function lastWordNormalized(line) {
  const t = String(line || '').trim();
  if (!t) return '';
  const words = t.split(/\s+/);
  let w = words[words.length - 1] || '';
  w = w.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '').toLowerCase();
  w = w.replace(/['\u2018\u2019]/g, '');
  return w;
}

/**
 * Lines of story text for one spread (handles single string with newlines).
 * @param {string} text
 * @returns {string[]}
 */
function linesFromText(text) {
  return String(text || '')
    .split(/\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !/^---/i.test(l));
}

/**
 * @param {Array<{spread: number, text?: string}>} spreads
 * @returns {Array<{ spread: number, lineIndex: number, word: string, note: string }>}
 */
function findIdenticalAdjacentEndWordRhymes(spreads) {
  const out = [];
  if (!Array.isArray(spreads)) return out;

  for (const s of spreads) {
    const lines = linesFromText(s?.text || '');
    for (let i = 0; i < lines.length - 1; i++) {
      const a = lastWordNormalized(lines[i]);
      const b = lastWordNormalized(lines[i + 1]);
      if (a.length < 2 || b.length < 2) continue;
      if (a === b) {
        out.push({
          spread: s.spread,
          lineIndex: i + 1,
          word: a,
          note: `Identical-word rhyme: consecutive lines end on the same word "${a}" — rewrite one line so the rhyme uses different final words.`,
        });
      }
    }
  }
  return out;
}

/**
 * Very long words (ages 0–3) often trip parents when reading aloud.
 * Excludes the child's name tokens.
 *
 * @param {Array<{spread: number, text?: string}>} spreads
 * @param {string} childName
 * @returns {Array<{ spread: number, word: string, note: string }>}
 */
function findOverlongWordsForYoungReader(spreads, childName) {
  const out = [];
  if (!Array.isArray(spreads)) return out;
  const nameTokens = new Set(
    String(childName || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
  const maxLen = 12;
  for (const s of spreads) {
    const words = String(s?.text || '').match(/[a-zA-Z]+/g) || [];
    for (const w of words) {
      const lower = w.toLowerCase();
      if (w.length <= maxLen || nameTokens.has(lower)) continue;
      out.push({
        spread: s.spread,
        word: w,
        note: `Word "${w}" is unusually long for a 0–3 read-aloud — replace with a simpler synonym.`,
      });
    }
  }
  return out;
}

module.exports = {
  findIdenticalAdjacentEndWordRhymes,
  lastWordNormalized,
  linesFromText,
  findOverlongWordsForYoungReader,
};
