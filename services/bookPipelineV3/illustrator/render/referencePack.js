/**
 * Reference pack (A2) — the FIXED set of reference images attached to
 * every spread render:
 *
 *   character model sheet + best real photo + approved cover (+ world
 *   plate for revisited locations, once art direction ships them)
 *
 * Identity flows one direction: photo → sheet → every spread. No spread
 * ever references a previous spread — that photocopy-of-a-photocopy
 * chain is where v1/v2's drift, phantom limbs, and skin-tone mismatch
 * came from.
 */

const { downloadPhotoAsBase64 } = require('../../../illustrationGenerator');
const { downloadBuffer } = require('../../../gcsStorage');

/**
 * Build the per-book reference pack once; renders reuse it for all spreads.
 *
 * @param {object} opts
 * @param {object} opts.identityKit - buildIdentityKit result (sheetPath/sheetUrl or sheetBase64 + photos)
 * @param {string|null} [opts.coverImageUrl] - parent-approved cover (wardrobe/style ground truth)
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<Array<{base64: string, mimeType: string, note: string}>>}
 */
async function buildBookReferencePack({ identityKit, coverImageUrl = null, log = () => {} }) {
  if (!identityKit) throw new Error('buildBookReferencePack: identityKit is required');
  const refs = [];

  // 1. Character model sheet — THE identity ground truth.
  let sheetBase64 = identityKit.sheetBase64 || null;
  let sheetMime = identityKit.sheetMime || 'image/png';
  if (!sheetBase64 && identityKit.sheetPath) {
    const buf = await downloadBuffer(identityKit.sheetPath);
    sheetBase64 = buf.toString('base64');
  } else if (!sheetBase64 && identityKit.sheetUrl) {
    const dl = await downloadPhotoAsBase64(identityKit.sheetUrl);
    sheetBase64 = dl.base64;
    sheetMime = dl.mimeType;
  }
  if (!sheetBase64) throw new Error('buildBookReferencePack: identity kit has no sheet image');
  refs.push({
    base64: sheetBase64,
    mimeType: sheetMime,
    note: 'CHARACTER MODEL SHEET (identity ground truth — match this character design exactly in every view):',
  });

  // 2. Best real photo — the likeness source of truth.
  const photo = identityKit.photos?.[0];
  if (photo) {
    refs.push({
      base64: photo.base64,
      mimeType: photo.mimeType || 'image/jpeg',
      note: 'REAL PHOTO of the child (likeness reference — skin tone, hair, and features must match):',
    });
  }

  // 3. Approved cover — wardrobe + style ground truth (the one image the
  // parent has blessed). Best-effort: a missing cover must not fail renders.
  if (coverImageUrl) {
    try {
      const cover = await downloadPhotoAsBase64(coverImageUrl);
      refs.push({
        base64: cover.base64,
        mimeType: cover.mimeType || 'image/jpeg',
        note: 'APPROVED BOOK COVER (outfit + art style ground truth — same outfit and rendering style):',
      });
    } catch (err) {
      log(`reference pack: cover download failed (continuing without): ${err.message}`);
    }
  }

  return refs;
}

/**
 * Extend the book pack with a per-spread world plate (A1, optional).
 *
 * @param {Array} bookPack - buildBookReferencePack result
 * @param {{base64: string, mimeType?: string, location?: string}|null} plate
 * @returns {Array} references for this spread's render
 */
function withWorldPlate(bookPack, plate) {
  if (!plate) return bookPack;
  return [
    ...bookPack,
    {
      base64: plate.base64,
      mimeType: plate.mimeType || 'image/png',
      note: `WORLD PLATE${plate.location ? ` for "${plate.location}"` : ''} (empty location reference — match this setting's architecture, colors, and lighting):`,
    },
  ];
}

module.exports = { buildBookReferencePack, withWorldPlate };
