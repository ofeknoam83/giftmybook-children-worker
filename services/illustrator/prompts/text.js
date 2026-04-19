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
  parts.push(`- CENTER EXCLUSION ZONE: Text must stay at least ${TEXT_RULES.centerExclusionPercent}% away from the vertical center line. Place ALL text in the outer ${50 - TEXT_RULES.centerExclusionPercent}% of the image (LEFT ${50 - TEXT_RULES.centerExclusionPercent}% or RIGHT ${50 - TEXT_RULES.centerExclusionPercent}%). NEVER in the middle ${TEXT_RULES.centerExclusionPercent * 2}%. This image will be split into two pages at the center.`);
  parts.push(`- EDGE PADDING: at least ${TEXT_RULES.edgePaddingPercent}% from left, right, and top edges`);
  parts.push(`- BOTTOM PADDING (CRITICAL): at least ${TEXT_RULES.bottomPaddingPercent}% from the BOTTOM edge — the bottom of this image gets cropped during print layout, so text near the bottom WILL be cut off. Keep all text well above the bottom ${TEXT_RULES.bottomPaddingPercent}% of the image.`);
  parts.push(`- Maximum ${TEXT_RULES.maxWordsPerLine} words per line`);
  parts.push(`- Font: ${TEXT_RULES.fontStyle}`);
  parts.push('- The font must be IDENTICAL to all other pages — same family, same weight, same size. NEVER change fonts.');
  parts.push(`- Size: ${TEXT_RULES.fontSize}. The illustration is the star.`);
  parts.push(`- Color: ${TEXT_RULES.fontColor}`);
  parts.push('- Text must be CRISP and SHARP — NOT blurry or fuzzy');

  return parts.join('\n');
}

module.exports = { buildTextInstruction };
