/**
 * Resize a child reference photo to the cached 512×512 JPEG used downstream.
 * Tries sharp first; on HEIC/HEIF decode failures (common on Cloud Run when
 * libvips lacks a codec), falls back to heic-convert (libheif-js).
 */

const sharp = require('sharp');

/**
 * @param {Buffer} photoBuf
 * @param {string} [sourceHint] - URL or GCS path; used to detect .heic/.heif
 * @returns {Promise<Buffer>}
 */
async function resizeChildPhotoForCache(photoBuf, sourceHint = '') {
  const toCacheJpeg = (input) =>
    sharp(input)
      .resize(512, 512, { fit: 'cover' })
      .jpeg({ quality: 80 })
      .toBuffer();

  try {
    return await toCacheJpeg(photoBuf);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const pathLooksHeif = /\.hei[c|f](\?|#|$)/i.test(String(sourceHint));
    const errLooksHeif = /heif|heic|libheif|compression format|bad seek/i.test(msg);
    if (!pathLooksHeif && !errLooksHeif) throw err;

    let convert;
    try {
      convert = require('heic-convert');
    } catch {
      throw err;
    }

    const jpegOut = await convert({
      buffer: photoBuf,
      format: 'JPEG',
      quality: 0.92,
    });
    const jpegBuf = Buffer.isBuffer(jpegOut) ? jpegOut : Buffer.from(jpegOut);
    return toCacheJpeg(jpegBuf);
  }
}

module.exports = { resizeChildPhotoForCache };
