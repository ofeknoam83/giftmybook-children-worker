/**
 * Shared helpers for Gemini generateContent JSON QA responses (multimodal-safe).
 */

/**
 * Concatenate visible model text from all content parts (handles split responses / thinking quirks).
 *
 * @param {object} data - Parsed generateContent response body
 * @returns {string}
 */
function extractGeminiResponseText(data) {
  const parts = data.candidates?.[0]?.content?.parts || [];
  const nonThought = parts
    .filter(p => p && typeof p.text === 'string' && p.text.length && p.thought !== true)
    .map(p => p.text);
  let joined = nonThought.join('\n').trim();
  if (!joined) {
    joined = parts
      .map(p => p.text)
      .filter(t => typeof t === 'string' && t.length)
      .join('\n')
      .trim();
  }
  return joined;
}

/**
 * Strip markdown fences, find first `{...}` block, parse JSON. Returns null on failure.
 *
 * @param {string} text
 * @returns {object|null}
 */
function parseQaJsonFromText(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

module.exports = {
  extractGeminiResponseText,
  parseQaJsonFromText,
};
