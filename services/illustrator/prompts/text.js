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
  parts.push(`- CENTER NO-TEXT ZONE (THIS IS THE MOST COMMON MISTAKE): This is ONE single illustration, not a book layout. The middle ${TEXT_RULES.centerExclusionPercent * 2}% of the image is reserved for imagery only and must stay free of text. Place ALL text entirely within the ${placement.side.toUpperCase()} ${safePct}% strip of the image. If you are unsure, push the text further toward the ${placement.side} edge. Do NOT draw or imply any center fold, page break, or spine.`);
  parts.push(`- EDGE PADDING: at least ${TEXT_RULES.edgePaddingPercent}% from left and right edges`);
  parts.push(`- TOP PADDING: at least ${TEXT_RULES.topPaddingPercent}% from the TOP edge — do not place text flush against the top; leave comfortable breathing room above the text.`);
  parts.push(`- BOTTOM PADDING (CRITICAL): at least ${TEXT_RULES.bottomPaddingPercent}% from the BOTTOM edge — the bottom gets cropped during print. Keep text well above the bottom ${TEXT_RULES.bottomPaddingPercent}%.`);
  parts.push(`- Maximum ${TEXT_RULES.maxWordsPerLine} words per line`);
  parts.push('');
  parts.push('### FONT (HARD CONSTRAINT — MUST MATCH EVERY OTHER SPREAD IN THIS BOOK)');
  parts.push(`- Font: ${TEXT_RULES.fontStyle}`);
  parts.push('- The font must be PIXEL-IDENTICAL to every other spread in this book — same family, same weight, same slant, same x-height, same stroke contrast, same letter spacing. Treat the font used on spread 1 as the locked reference.');
  parts.push('- Upright only. NEVER italic, NEVER script, NEVER handwritten, NEVER decorative, NEVER bubble, NEVER condensed. If the text on this spread looks different from earlier spreads in this book, that is a FAILURE.');
  parts.push('- When in doubt, render as plain Georgia regular weight.');
  parts.push(`- Size: ${TEXT_RULES.fontSize}. The illustration is the star.`);
  parts.push(`- Color: ${TEXT_RULES.fontColor}`);
  parts.push('- Text must be CRISP and SHARP — NOT blurry or fuzzy');
  parts.push('- NEVER place text over the main character\'s face, head, or eyes.');

  return parts.join('\n');
}

module.exports = { buildTextInstruction, getTextPlacement };
