/**
 * Illustrator V2 — Text Embedding Instruction Builder
 *
 * Builds the text placement instructions for each spread.
 * Text is embedded by Gemini directly in the image — no Sharp/SVG.
 */

const { TEXT_RULES } = require('../config');

/**
 * Build text embedding instructions for a spread.
 *
 * @param {string} text - The story text to embed (may be empty)
 * @returns {string}
 */
function buildTextInstruction(text) {
  if (!text || !text.trim()) {
    return '### NO TEXT\nDo NOT render any text, words, letters, or numbers in the illustration.';
  }

  const parts = [];

  parts.push('### STORY TEXT TO EMBED');
  parts.push(`"${text.trim()}"`);
  parts.push('');
  parts.push('### TEXT PLACEMENT (CRITICAL)');
  parts.push('- Place text anywhere vertically (top, bottom, upper, lower — all fine)');
  parts.push('- Text must NEVER cross the left-right center of the image');
  parts.push('- Entire text block stays completely on the LEFT half or RIGHT half');
  parts.push(`- EDGE PADDING: at least ${TEXT_RULES.edgePaddingPercent}% from ALL edges (top, bottom, left, right)`);
  parts.push(`- Maximum ${TEXT_RULES.maxWordsPerLine} words per line`);
  parts.push(`- Font: ${TEXT_RULES.fontStyle}`);
  parts.push(`- Size: ${TEXT_RULES.fontSize}. The illustration is the star.`);
  parts.push(`- Color: ${TEXT_RULES.fontColor}`);
  parts.push('- Text must be CRISP and SHARP — NOT blurry or fuzzy');
  parts.push('- EXACT same font style, size, weight, and color on EVERY page');

  return parts.join('\n');
}

module.exports = { buildTextInstruction };
