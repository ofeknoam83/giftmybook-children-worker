/**
 * Detects natural-language viewpoint hints in a SCENE string.
 * Used to avoid appending a redundant "vary camera" nudge in convertWriterV2ToLegacyPlan.
 *
 * @param {string} [text]
 * @returns {boolean}
 */
function sceneHasFramingHint(text) {
  if (!text || typeof text !== 'string') return false;
  return /\b(wide(\s+shot)?|wider|establishing|medium|close(?:-up|\s+up)?|closer|over[-\s]the[-\s]shoulder|low\s+angle|high\s+angle|\bcamera\b|\bangle\b|foreground|vantage|framing|focal\s+point|from\s+above|from\s+below|eye[-\s]level|bird(?:'s)?[-\s]eye|worm(?:'s)?[-\s]eye|three[-\s]quarter|profile\s+view)\b/i.test(text);
}

module.exports = { sceneHasFramingHint };
