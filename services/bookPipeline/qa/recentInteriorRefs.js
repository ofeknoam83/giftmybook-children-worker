/**
 * Pick recent accepted spread images for continuity QA (hair/outfit vs last interiors).
 *
 * @param {Array<{ index: number, imageBase64?: string }>} acceptedSpreads - session.acceptedSpreads (0-based index)
 * @param {number[]} excludeZeroBasedIndices - spreads currently being rendered/QA'd (omit from refs)
 * @param {number} maxCount - cap (use QA_RECENT_INTERIOR_REFERENCES from constants)
 * @returns {Array<{ base64: string, mimeType: string, spreadNumber: number }>}
 */
function pickRecentInteriorRefsForQa(acceptedSpreads, excludeZeroBasedIndices, maxCount) {
  if (!Array.isArray(acceptedSpreads) || maxCount <= 0) return [];
  const exclude = new Set((excludeZeroBasedIndices || []).map(n => Number(n)));
  const sorted = acceptedSpreads
    .filter(s => s && typeof s.index === 'number' && typeof s.imageBase64 === 'string' && s.imageBase64.length > 100)
    .filter(s => !exclude.has(s.index))
    .sort((a, b) => a.index - b.index);
  const tail = sorted.slice(-maxCount);
  return tail.map(s => ({
    base64: s.imageBase64,
    mimeType: 'image/jpeg',
    spreadNumber: s.index + 1,
  }));
}

module.exports = { pickRecentInteriorRefsForQa };
