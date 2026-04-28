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

/** "One, two, three" / "1, 2, 3" style hooks repeated across many spreads (mechanical collage verse). */
const COUNTING_HOOK_RX = /\bone[,\s]+two[,\s]+three\b|\b1[,\s]+2[,\s]+3\b/i;

/**
 * When 3+ spreads contain a counting hook, flag each so the rewrite pass varies beats.
 *
 * @param {Array<{ spreadNumber: number, manuscript?: { text?: string } }>} spreads
 * @returns {Map<number, { issues: string[], tags: string[] }>}
 */
function countingHookSpamBySpread(spreads) {
  const aug = new Map();
  const hitNumbers = (Array.isArray(spreads) ? spreads : [])
    .filter((s) => COUNTING_HOOK_RX.test(s.manuscript?.text || ''))
    .map((s) => s.spreadNumber);
  if (hitNumbers.length < 3) return aug;
  const msg =
    'Mechanical counting hook ("one, two, three") appears on many spreads — use it on at most 1–2 spreads unless it is the book\'s deliberate refrain; vary beats.';
  for (const sn of hitNumbers) {
    if (!aug.has(sn)) aug.set(sn, { issues: [], tags: [] });
    aug.get(sn).issues.push(msg);
    aug.get(sn).tags.push('counting_refrain_spam');
  }
  return aug;
}

module.exports = {
  splitLines,
  normalizeRefrainLine,
  findCrossSpreadRepeatedLines,
  countingHookSpamBySpread,
  COUNTING_HOOK_RX,
  MIN_NORMALIZED_LENGTH,
};
