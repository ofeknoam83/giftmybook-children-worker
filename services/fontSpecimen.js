/**
 * Font specimen generator.
 *
 * Pre-renders a PNG specimen of Bubblegum Sans showing the font at multiple
 * sizes with sample text. This image is passed to Gemini alongside each
 * illustration prompt so the model has a concrete visual target for text
 * rendering — much more consistent than a font name alone.
 */

const fs = require('fs');
const path = require('path');

const FONT_PATH = path.join(__dirname, '..', 'fonts', 'BubblegumSans-Regular.ttf');

/** @type {Buffer|null} Cached specimen PNG (generated once) */
let cachedSpecimenBuffer = null;
/** @type {string|null} Cached base64 of specimen */
let cachedSpecimenBase64 = null;

/**
 * Generate a font specimen image showing Bubblegum Sans at multiple sizes.
 *
 * Uses SVG with embedded @font-face to render with the actual font file,
 * then converts to PNG via sharp.
 *
 * @returns {Promise<{buffer: Buffer, base64: string, mimeType: string}>}
 */
async function generateFontSpecimen() {
  // Return cached version if available
  if (cachedSpecimenBuffer && cachedSpecimenBase64) {
    return { buffer: cachedSpecimenBuffer, base64: cachedSpecimenBase64, mimeType: 'image/png' };
  }

  const sharp = require('sharp');

  // Read and embed the actual font file as base64
  let fontBase64 = '';
  try {
    const fontBuffer = fs.readFileSync(FONT_PATH);
    fontBase64 = fontBuffer.toString('base64');
  } catch (err) {
    console.warn(`[fontSpecimen] Could not read font file: ${err.message}`);
    return null;
  }

  const width = 800;
  const height = 400;

  // Build SVG with embedded font
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      @font-face {
        font-family: 'BubblegumSans';
        src: url('data:font/truetype;base64,${fontBase64}') format('truetype');
      }
    </style>
  </defs>
  <rect width="100%" height="100%" fill="#FFF8F0"/>
  <text x="40" y="55" font-family="BubblegumSans" font-size="36" fill="#2D2D2D">FONT REFERENCE: Bubblegum Sans</text>
  <text x="40" y="110" font-family="BubblegumSans" font-size="28" fill="#333333">ABCDEFGHIJKLMNOPQRSTUVWXYZ</text>
  <text x="40" y="150" font-family="BubblegumSans" font-size="28" fill="#333333">abcdefghijklmnopqrstuvwxyz</text>
  <text x="40" y="190" font-family="BubblegumSans" font-size="28" fill="#333333">0123456789 !?&amp;.,&apos;&quot;()-</text>
  <text x="40" y="245" font-family="BubblegumSans" font-size="24" fill="#555555">The quick brown fox jumps over the lazy dog.</text>
  <text x="40" y="290" font-family="BubblegumSans" font-size="20" fill="#555555">Once upon a time, in a land far away,</text>
  <text x="40" y="320" font-family="BubblegumSans" font-size="20" fill="#555555">a brave little explorer set off on an adventure.</text>
  <text x="40" y="370" font-family="BubblegumSans" font-size="16" fill="#777777">This is the exact font style to use for ALL text in every illustration.</text>
</svg>`;

  try {
    const pngBuffer = await sharp(Buffer.from(svg))
      .png()
      .toBuffer();

    cachedSpecimenBuffer = pngBuffer;
    cachedSpecimenBase64 = pngBuffer.toString('base64');

    console.log(`[fontSpecimen] Font specimen generated (${pngBuffer.length} bytes)`);
    return { buffer: cachedSpecimenBuffer, base64: cachedSpecimenBase64, mimeType: 'image/png' };
  } catch (err) {
    console.warn(`[fontSpecimen] Failed to generate specimen: ${err.message}`);
    return null;
  }
}

/**
 * Get the cached font specimen, generating it if needed.
 *
 * @returns {Promise<{base64: string, mimeType: string}|null>}
 */
async function getFontSpecimen() {
  if (cachedSpecimenBase64) {
    return { base64: cachedSpecimenBase64, mimeType: 'image/png' };
  }
  const result = await generateFontSpecimen();
  return result ? { base64: result.base64, mimeType: result.mimeType } : null;
}

module.exports = { generateFontSpecimen, getFontSpecimen };
