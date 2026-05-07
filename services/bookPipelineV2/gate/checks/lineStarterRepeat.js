/**
 * Line-starter repeat detector.
 *
 * Flags spreads where ≥3 of 4 lines start with the same first word.
 * Real production failure (Scarlett, PB_INFANT):
 *
 *   Mama carries her near.
 *   The breeze brushes her ear.
 *   Scarlett looks at the yard.
 *   Mama holds her in the yard.
 *
 * "Mama" starts 2/4 — that's fine. But across the whole book, "Mama"
 * starts 9 of ~52 lines, which destroys narrative motion and turns
 * every spread into the same shape. We can't run a book-wide check
 * inside a per-spread gate, so we flag the local pattern: 3+ lines in a
 * single spread starting with the same word — that's clearly stuck.
 *
 * Case-insensitive, whitespace-tolerant.
 */

function firstWord(line) {
  if (typeof line !== 'string') return null;
  const m = line.trim().toLowerCase().match(/^([a-z']+)/);
  return m ? m[1] : null;
}

function lineStarterRepeatCheck(draft) {
  const lines = String(draft?.text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 3) return { passed: true };
  const counts = {};
  for (const line of lines) {
    const w = firstWord(line);
    if (!w) continue;
    counts[w] = (counts[w] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [topWord, topCount] = entries[0] || [null, 0];
  if (topCount >= 3) {
    return {
      passed: false,
      code: 'line_starter_repeat',
      message: `${topCount} of ${lines.length} lines start with '${topWord}'. Vary line beginnings — let the camera move.`,
      detail: { word: topWord, count: topCount, total: lines.length },
    };
  }
  return { passed: true };
}

module.exports = { lineStarterRepeatCheck, firstWord };
