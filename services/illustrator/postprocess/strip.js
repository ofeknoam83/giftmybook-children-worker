/**
 * Illustrator V2 — Sanitize Raw Output
 *
 * Strips metadata and normalizes the raw image buffer from Gemini.
 * Uses Sharp for fast, memory-efficient processing.
 */

const sharp = require('sharp');

/**
 * Sanitize a raw image buffer — strip metadata and ensure consistent format.
 *
 * @param {Buffer} imageBuffer - Raw image from Gemini
 * @returns {Promise<Buffer>} Cleaned image buffer
 */
async function stripMetadata(imageBuffer) {
  try {
    return await sharp(imageBuffer)
      .png({ compressionLevel: 6 })
      .toBuffer();
  } catch (e) {
    console.warn(`[illustrator/postprocess/strip] Strip failed: ${e.message} — using raw buffer`);
    return imageBuffer;
  }
}

module.exports = { stripMetadata };
