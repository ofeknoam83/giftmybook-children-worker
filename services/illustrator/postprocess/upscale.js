/**
 * Illustrator V2 — Upscale to Print Resolution
 *
 * 4x upscale using ImageMagick Lanczos filter + unsharp mask.
 * Targets print-quality resolution for children's book production.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Upscale factor for print resolution
const UPSCALE_FACTOR = '400%';

// Unsharp mask parameters: radius x sigma + amount + threshold
// Gentle sharpening to restore detail after upscale without artifacts
const UNSHARP = '0x0.5+0.7+0.02';

/**
 * Upscale an image buffer to print resolution using ImageMagick.
 *
 * @param {Buffer} imageBuffer - Source image
 * @returns {Promise<Buffer>} Upscaled image buffer
 */
async function upscaleForPrint(imageBuffer) {
  try {
    const { stdout } = await execFileAsync('convert', [
      'png:-',                         // Read from stdin
      '-filter', 'Lanczos',            // High-quality resampling filter
      '-resize', UPSCALE_FACTOR,       // 4x upscale
      '-unsharp', UNSHARP,             // Sharpen to restore detail
      '-quality', '95',                // High quality output
      'png:-',                         // Write to stdout
    ], {
      encoding: 'buffer',
      input: imageBuffer,
      maxBuffer: 200 * 1024 * 1024, // 200MB (upscaled images can be large)
      timeout: 120000, // 2 minutes
    });

    console.log(`[illustrator/postprocess/upscale] Upscaled: ${imageBuffer.length} bytes -> ${stdout.length} bytes`);
    return stdout;
  } catch (e) {
    console.warn(`[illustrator/postprocess/upscale] ImageMagick upscale failed: ${e.message} — returning original`);
    return imageBuffer;
  }
}

module.exports = { upscaleForPrint };
