/**
 * Comics — server-side face crop service.
 *
 * Takes a group-photo URL plus a normalized bounding box and produces a padded
 * JPEG crop centered on that face, uploaded to GCS. Used by the admin
 * comics-book cast-builder flow to feed clean per-character faces into the
 * downstream Cast Visual Bible / faceEngine pipeline.
 */

const crypto = require('crypto');
const sharp = require('sharp');
const { uploadBuffer, downloadBuffer } = require('../gcsStorage');

/**
 * Coerce a box input (array or object) into { x, y, w, h } normalized 0..1.
 *
 * @param {*} box
 * @returns {{ x: number, y: number, w: number, h: number } | null}
 */
function normalizeBox(box) {
  if (!box) return null;
  let x;
  let y;
  let w;
  let h;
  if (Array.isArray(box)) {
    if (box.length < 4) return null;
    [x, y, w, h] = box;
  } else if (typeof box === 'object') {
    ({ x, y, w, h } = box);
  } else {
    return null;
  }
  x = Number(x);
  y = Number(y);
  w = Number(w);
  h = Number(h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/**
 * Crop a face from a group photo, with padding, and upload the JPEG to GCS.
 *
 * @param {string} groupPhotoUrl - Source group photo URL
 * @param {Array<number>|{x:number,y:number,w:number,h:number}} box - Normalized 0..1 box (top-left origin)
 * @param {{ comicId: string, padding?: number }} opts
 * @returns {Promise<{ faceCropUrl: string }>}
 */
async function cropFace(groupPhotoUrl, box, opts = {}) {
  const totalStart = Date.now();
  const { comicId, padding = 0.35 } = opts;

  if (!groupPhotoUrl || typeof groupPhotoUrl !== 'string') {
    throw new Error('groupPhotoUrl is required');
  }
  if (!comicId || typeof comicId !== 'string') {
    throw new Error('comicId is required');
  }
  const nb = normalizeBox(box);
  if (!nb) {
    throw new Error('box must be {x,y,w,h} or [x,y,w,h] with finite positive w/h');
  }

  // 1. Download the original image
  const dlStart = Date.now();
  let buf;
  try {
    buf = await downloadBuffer(groupPhotoUrl);
  } catch (err) {
    // Fallback to a direct fetch (e.g. for non-GCS URLs)
    const resp = await fetch(groupPhotoUrl);
    if (!resp.ok) throw new Error(`Failed to download group photo: HTTP ${resp.status}`);
    buf = Buffer.from(await resp.arrayBuffer());
  }
  console.log(`[comics/cropFace] Downloaded source (${buf.length} bytes, ${Date.now() - dlStart}ms)`);

  // 2. Read metadata
  const meta = await sharp(buf).metadata();
  const imgW = meta.width;
  const imgH = meta.height;
  if (!imgW || !imgH) {
    throw new Error('Unable to read image dimensions from source');
  }

  // 3. Convert normalized box → pixels, expand by `padding` each side, clamp, round
  const baseLeft = nb.x * imgW;
  const baseTop = nb.y * imgH;
  const baseW = nb.w * imgW;
  const baseH = nb.h * imgH;

  const padX = baseW * padding;
  const padY = baseH * padding;

  let left = Math.round(baseLeft - padX);
  let top = Math.round(baseTop - padY);
  let width = Math.round(baseW + padX * 2);
  let height = Math.round(baseH + padY * 2);

  // Clamp to image bounds
  if (left < 0) {
    width += left; // shrink width by however far we went out
    left = 0;
  }
  if (top < 0) {
    height += top;
    top = 0;
  }
  if (left + width > imgW) width = imgW - left;
  if (top + height > imgH) height = imgH - top;

  // Ensure at least 1px on each side
  width = Math.max(1, width);
  height = Math.max(1, height);

  console.log(
    `[comics/cropFace] Cropping ${imgW}x${imgH} → extract ` +
    `left=${left} top=${top} width=${width} height=${height} (padding=${padding})`
  );

  // 4. Extract crop as JPEG
  const cropBuf = await sharp(buf)
    .extract({ left, top, width, height })
    .jpeg({ quality: 92 })
    .toBuffer();

  // 5. Upload to GCS
  const filename = crypto.randomUUID();
  const destination = `comics/${comicId}/faces/${filename}.jpg`;
  const faceCropUrl = await uploadBuffer(cropBuf, destination, 'image/jpeg');
  console.log(`[comics/cropFace] Uploaded crop to ${destination} (${cropBuf.length} bytes, total ${Date.now() - totalStart}ms)`);

  return { faceCropUrl };
}

module.exports = {
  cropFace,
};
