/**
 * Illustrator V2 — Sanitize Raw Output
 *
 * Strips metadata and normalizes the raw image buffer from Gemini.
 * Uses ImageMagick to remove EXIF/IPTC metadata and ensure consistent format.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/**
 * Sanitize a raw image buffer — strip metadata and ensure PNG format.
 *
 * @param {Buffer} imageBuffer - Raw image from Gemini
 * @returns {Promise<Buffer>} Cleaned image buffer
 */
async function stripMetadata(imageBuffer) {
  try {
    // Use ImageMagick's convert to strip all metadata and re-encode as PNG
    const { stdout } = await execFileAsync('convert', [
      'png:-',       // Read PNG from stdin
      '-strip',      // Remove all EXIF, IPTC, ICC profiles
      'png:-',       // Write PNG to stdout
    ], {
      encoding: 'buffer',
      input: imageBuffer,
      maxBuffer: 50 * 1024 * 1024, // 50MB
      timeout: 30000,
    });
    return stdout;
  } catch (e) {
    // If ImageMagick is not available or fails, return the original buffer
    console.warn(`[illustrator/postprocess/strip] ImageMagick strip failed: ${e.message} — using raw buffer`);
    return imageBuffer;
  }
}

module.exports = { stripMetadata };
