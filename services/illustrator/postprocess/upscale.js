/**
 * Illustrator V2 — Upscale to Print Resolution
 *
 * 2x upscale using Sharp (libvips Lanczos3). Fast and memory-efficient.
 * Gemini outputs ~1024x576; 2x gives ~2048x1152 which is sufficient for
 * children's book print at 300 DPI (covers ~7x4 inches).
 * 4x was causing OOM/timeouts with ImageMagick on Cloud Run.
 */

const sharp = require('sharp');

// 2x is the sweet spot: good print quality without blowing up memory
const UPSCALE_FACTOR = 2;

/**
 * Upscale an image buffer to print resolution using Sharp.
 *
 * @param {Buffer} imageBuffer - Source image
 * @returns {Promise<Buffer>} Upscaled image buffer
 */
async function upscaleForPrint(imageBuffer) {
  try {
    const meta = await sharp(imageBuffer).metadata();
    const targetWidth = Math.round(meta.width * UPSCALE_FACTOR);
    const targetHeight = Math.round(meta.height * UPSCALE_FACTOR);

    const result = await sharp(imageBuffer)
      .resize(targetWidth, targetHeight, { kernel: sharp.kernel.lanczos3 })
      .sharpen({ sigma: 0.5, m1: 0.7, m2: 0.02 })
      .png({ compressionLevel: 6 })
      .toBuffer();

    console.log(`[illustrator/postprocess/upscale] Upscaled ${meta.width}x${meta.height} -> ${targetWidth}x${targetHeight}: ${imageBuffer.length} -> ${result.length} bytes`);
    return result;
  } catch (e) {
    console.warn(`[illustrator/postprocess/upscale] Upscale failed: ${e.message} — returning original`);
    return imageBuffer;
  }
}

module.exports = { upscaleForPrint };
