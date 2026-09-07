/**
 * Render resolution helpers shared by the renderer (the guard) and the
 * catalog illustrator (the size echo). Pure sharp header reads — no model,
 * no I/O beyond the buffer — and fail-open: an unreadable buffer yields
 * null, never a throw.
 */

'use strict';

/**
 * The 16:9 pixel HEIGHT floor per requested Gemini output tier — about 87%
 * of the tier's own height (4K ≈ 2304 px, 2K ≈ 1152 px, 1K ≈ 576 px), so
 * the guard trips only when the model fell to a LOWER tier (the default
 * size after `imageConfig.imageSize` was rejected), never on the small
 * variance between model versions of the same tier.
 * @type {Object<string, number>}
 */
const RENDER_TIER_FLOORS = Object.freeze({ '1K': 500, '2K': 1000, '4K': 2000 });

/**
 * The floor for a requested tier (0 when nothing specific was requested —
 * the model's default size is then the expected size).
 * @param {string|null|undefined} imageSize '1K' | '2K' | '4K'
 * @returns {number}
 */
function renderTierFloor(imageSize) {
  return RENDER_TIER_FLOORS[String(imageSize || '').trim().toUpperCase()] || 0;
}

/**
 * Pixel dimensions of an image buffer (header read only).
 * @param {Buffer} buffer
 * @returns {Promise<{width: number, height: number}|null>}
 */
async function imageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  try {
    const sharp = require('sharp');
    const meta = await sharp(buffer).metadata();
    const width = Number(meta.width);
    const height = Number(meta.height);
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

module.exports = { RENDER_TIER_FLOORS, renderTierFloor, imageDimensions };
