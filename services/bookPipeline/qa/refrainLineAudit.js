/**
 * Detect identical (normalized) verse lines across multiple spreads — wallpaper refrains.
 */

const MIN_NORMALIZED_LENGTH = 12;

function splitLines(text) {
  return String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
}

/**
 * @param {string} line
 * @returns {string}
 */
function normalizeRefrainLine(line) {
  return String(line || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {Array<{ spreadNumber: number, manuscript?: { text?: string } }>} spreads
 * @returns {Array<{ normalized: string, spreadNumbers: number[] }>}
 */
function findCrossSpreadRepeatedLines(spreads) {
  const lineToSpreads = new Map();
  for (const s of spreads) {
    const lines = splitLines(s.manuscript?.text);
    for (const line of lines) {
      const n = normalizeRefrainLine(line);
      if (n.length < MIN_NORMALIZED_LENGTH) continue;
      if (!lineToSpreads.has(n)) lineToSpreads.set(n, []);
      lineToSpreads.get(n).push(s.spreadNumber);
    }
  }
  const out = [];
  for (const [normalized, nums] of lineToSpreads) {
    const unique = [...new Set(nums)].sort((a, b) => a - b);
    if (unique.length >= 2) out.push({ normalized, spreadNumbers: unique });
  }
  return out;
}

module.exports = {
  splitLines,
  normalizeRefrainLine,
  findCrossSpreadRepeatedLines,
  MIN_NORMALIZED_LENGTH,
};
