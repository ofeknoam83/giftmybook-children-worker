/**
 * Illustrator V2 — Text Embedding Instruction Builder
 *
 * Builds the text placement instructions for each spread.
 * Text is embedded by Gemini directly in the image — no Sharp/SVG.
 */

const { TEXT_RULES } = require('../config');

const TEXT_PLACEMENTS = [
  { side: 'left',  vertical: 'upper', anchor: 'upper-left corner' },
  { side: 'right', vertical: 'upper', anchor: 'upper-right corner' },
  { side: 'left',  vertical: 'lower', anchor: 'lower-left area' },
  { side: 'right', vertical: 'lower', anchor: 'lower-right area' },
  { side: 'left',  vertical: 'upper', anchor: 'top-left area' },
  { side: 'right', vertical: 'upper', anchor: 'top-right area' },
];

/**
 * Get the target text placement for a spread, alternating sides.
 * @param {number} spreadIndex - 0-based
 * @returns {{ side: string, vertical: string, anchor: string }}
 */
function getTextPlacement(spreadIndex) {
  return TEXT_PLACEMENTS[spreadIndex % TEXT_PLACEMENTS.length];
}

/**
 * Build text embedding instructions for a spread.
 *
 * @param {string} text - The story text to embed (may be empty)
 * @param {object} [opts]
 * @param {number} [opts.spreadIndex] - 0-based spread index for side alternation
 * @returns {string}
 */
function buildTextInstruction(text, opts = {}) {
  if (!text || !text.trim()) {
    return '### NO TEXT\nDo NOT render any text, words, letters, or numbers in the illustration.';
  }

  const placement = getTextPlacement(opts.spreadIndex || 0);
  const safePct = 50 - TEXT_RULES.centerExclusionPercent;

  const parts = [];

  parts.push('### STORY TEXT TO EMBED');
  parts.push(`"${text.trim()}"`);
  parts.push('- Render EVERY word exactly as written above — spell each word correctly. Do NOT substitute, rearrange, or abbreviate any word.');
  parts.push('');
  parts.push('### TEXT PLACEMENT (CRITICAL — READ CAREFULLY)');
  parts.push(`- TEXT POSITION: Place ALL text in the ${placement.anchor} of the image — the ${placement.side.toUpperCase()} side, ${placement.vertical} portion.`);
  parts.push(`- Render the text EXACTLY ONCE in a single block. ONE text block only — NEVER duplicate or repeat the text anywhere else in the image.`);
  parts.push(`- CENTER NO-TEXT ZONE (THIS IS THE MOST COMMON MISTAKE): This image will be printed as a two-page spread. It is folded at the EXACT CENTER. Any text near the center will disappear into the book's spine. ALL text must be placed entirely within the ${placement.side.toUpperCase()} ${safePct}% of the image. The middle ${TEXT_RULES.centerExclusionPercent * 2}% of the image is FORBIDDEN for text. If you are unsure, push the text further toward the ${placement.side} edge.`);
  parts.push(`- EDGE PADDING: at least ${TEXT_RULES.edgePaddingPercent}% from left, right, and top edges`);
  parts.push(`- BOTTOM PADDING (CRITICAL): at least ${TEXT_RULES.bottomPaddingPercent}% from the BOTTOM edge — the bottom gets cropped during print. Keep text well above the bottom ${TEXT_RULES.bottomPaddingPercent}%.`);
  parts.push(`- Maximum ${TEXT_RULES.maxWordsPerLine} words per line`);
  parts.push(`- Font: ${TEXT_RULES.fontStyle}`);
  parts.push('- The font must be IDENTICAL to all other pages — same family, same weight, same size. NEVER change fonts.');
  parts.push(`- Size: ${TEXT_RULES.fontSize}. The illustration is the star.`);
  parts.push(`- Color: ${TEXT_RULES.fontColor}`);
  parts.push('- Text must be CRISP and SHARP — NOT blurry or fuzzy');

  return parts.join('\n');
}

module.exports = { buildTextInstruction, getTextPlacement };
