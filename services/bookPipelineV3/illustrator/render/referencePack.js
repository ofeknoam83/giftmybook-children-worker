/**
 * Reference pack (A2) — the FIXED set of reference images attached to
 * every spread render:
 *
 *   character model sheet + approved cover (+ world plate for revisited
 *   locations, once art direction ships them). The raw photo is NEVER
 *   attached to generation (Part B) — it feeds only the likeness judges.
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
    kind: 'sheet',
    note: 'CHARACTER MODEL SHEET (identity ground truth — match this character design exactly in every view):',
  });

  // 2. (Part B, PROHIBITED_CONTENT safety) The raw child photo is NOT
  // attached to render calls — asking the image model to match a real,
  // identifiable child is what Gemini's non-configurable safety tier
  // blocks, and it killed real cover generations. Likeness flows through
  // the model SHEET (an illustration, safe to reference). Since the
  // cover-relative QA change (2026-07-15) the likeness JUDGES also
  // reference the sheet + approved cover, not the photo — the photo's
  // only remaining consumer is the likeness-brief vision analysis.

  // 3. Approved cover — wardrobe + style ground truth (the one image the
  // parent has blessed). Best-effort: a missing cover must not fail renders.
  if (coverImageUrl) {
    try {
      const cover = await downloadPhotoAsBase64(coverImageUrl);
      refs.push({
        base64: cover.base64,
        mimeType: cover.mimeType || 'image/jpeg',
        // `kind` lets consumers pick a specific reference out of the pack
        // (the spread judge attaches ONLY the cover as its style reference);
        // the image clients read just base64/mimeType/note and ignore it.
        kind: 'cover',
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

/**
 * Extend the pack with the book's prop plate (A1, optional) — the locked
 * designs of recurring props (map, lamp, vehicle), so a prop cannot morph
 * into a different object between spreads.
 *
 * @param {Array} refs - reference list (bookPack, possibly + world plate)
 * @param {{base64: string, mimeType?: string, props?: string[]}|null} propPlate
 * @returns {Array} references for this spread's render
 */
function withPropPlate(refs, propPlate) {
  if (!propPlate) return refs;
  return [
    ...refs,
    {
      base64: propPlate.base64,
      mimeType: propPlate.mimeType || 'image/png',
      note: `PROP PLATE${propPlate.props?.length ? ` (${propPlate.props.join(', ')})` : ''} (locked prop designs — every recurring prop that the SCENE calls for matches its plate design EXACTLY: same shape, colors, and material every time. Props appear only where the story places them — never duplicated, never printed or decal-ed onto vehicles, walls, or clothing):`,
    },
  ];
}

module.exports = { buildBookReferencePack, withWorldPlate, withPropPlate };
