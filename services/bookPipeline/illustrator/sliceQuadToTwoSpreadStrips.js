/**
 * Split one 4:1 (two-spreads-wide) illustration into two 2:1 spread buffers
 * before layout — Option A from the quad pipeline plan.
 */

const sharp = require('sharp');

/**
 * Slice a wide quad buffer at the horizontal midpoint.
 *
 * @param {Buffer} imageBuffer
 * @returns {Promise<{ leftStrip: Buffer, rightStrip: Buffer, width: number, height: number, halfWidth: number }>}
 */
async function sliceQuadToTwoSpreadStrips(imageBuffer) {
  const meta = await sharp(imageBuffer).metadata();
  const w = meta.width;
  const h = meta.height;
  if (!w || !h) {
    throw new Error('sliceQuadToTwoSpreadStrips: invalid image dimensions');
  }
  const halfWidth = Math.floor(w / 2);
  const leftStrip = await sharp(imageBuffer)
    .extract({ left: 0, top: 0, width: halfWidth, height: h })
    .toBuffer();
  const rightStrip = await sharp(imageBuffer)
    .extract({ left: halfWidth, top: 0, width: w - halfWidth, height: h })
    .toBuffer();
  return {
    leftStrip,
    rightStrip,
    width: w,
    height: h,
    halfWidth,
  };
}

module.exports = { sliceQuadToTwoSpreadStrips };
