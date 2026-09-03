/**
 * ce-15 — the TYPOGRAPHY ANCHOR: the book's own first painted page as the
 * type reference for every other embedded spread.
 *
 * "Use the other illustrations as reference" has a history here: whole-image
 * sibling references were deleted on 2026-08-06 as the photocopy-drift
 * source (the model copies the composition it is shown). The anchor is
 * therefore a CROP — the text-side half of the first rendered spread at
 * FULL height (the shot plan puts the text opposite the child's third, so
 * the crop is mostly scenery plus the painted block) — labeled TYPE ONLY.
 * The scale survives (full height: "each row this tall relative to the
 * page" is visible); the composition does not.
 *
 * Elected ONCE per story: pinned beside the renders (create-if-absent,
 * single winner like the world plate), so every later run and every
 * per-spread re-render matches the same page; `forceRerender`
 * (all-or-nothing) re-elects. Its content hash folds into the OTHER
 * spreads' cache keys — a re-elected anchor never replays renders made
 * against the old one. Fail-open: no anchor → the spreads render on the
 * text rules alone with a stage `typographyAnchor` advisory.
 */

'use strict';

const sharp = require('sharp');
const { downloadBuffer, uploadBuffer, uploadBufferIfAbsent } = require('../../gcsStorage');
const { fnv1a } = require('../selection');

/** Fold-safe half: x ∈ [0, 0.45] for 'left', [0.55, 1] for 'right'; full height. */
const ANCHOR_HALF_WIDTH = 0.45;
/** Crop height cap (px) — enough to read the type at a fraction of the render's tokens. */
const ANCHOR_MAX_HEIGHT = 640;

/**
 * The normalized crop rectangle (fractions of the frame) of the text-side
 * half. Pure — exported for tests.
 * @param {'left'|'right'} side the shot plan's textSide
 * @returns {{x: number, y: number, w: number, h: number}|null}
 */
function anchorCropRect(side) {
  if (side === 'left') return { x: 0, y: 0, w: ANCHOR_HALF_WIDTH, h: 1 };
  if (side === 'right') return { x: 1 - ANCHOR_HALF_WIDTH, y: 0, w: ANCHOR_HALF_WIDTH, h: 1 };
  return null;
}

/**
 * Crop the text-side half out of a rendered spread (PNG bytes, height
 * capped). Null on an unknown side or unreadable image — fail-open.
 * @param {Buffer|null} buffer the spread's render
 * @param {'left'|'right'} side
 * @returns {Promise<Buffer|null>}
 */
async function cropTypographyAnchor(buffer, side) {
  const rect = anchorCropRect(side);
  if (!rect || !buffer) return null;
  try {
    const meta = await sharp(buffer).metadata();
    const W = meta.width || 0;
    const H = meta.height || 0;
    if (W < 16 || H < 16) return null;
    const left = Math.round(rect.x * W);
    const width = Math.min(Math.max(1, Math.round(rect.w * W)), W - left);
    let img = sharp(buffer).extract({ left, top: 0, width, height: H });
    if (H > ANCHOR_MAX_HEIGHT) img = img.resize({ height: ANCHOR_MAX_HEIGHT, kernel: 'lanczos3' });
    return await img.png().toBuffer();
  } catch {
    return null;
  }
}

/**
 * Content hash of the anchor bytes — folded into the other spreads' keys.
 * @param {Buffer} bytes
 * @returns {string}
 */
function anchorHash(bytes) {
  return fnv1a(bytes.toString('base64')).toString(36);
}

/**
 * The pin path beside the renders: `…/{storyHash}/typo-anchor.{aspect}.png`
 * (derived from the anchor spread's own render key so it lives in the
 * un-folded directory every run resolves first).
 * @param {string} anchorSpreadRenderKey renderCachePath(...) of the anchor spread
 * @returns {string}
 */
function anchorPinPath(anchorSpreadRenderKey) {
  return anchorSpreadRenderKey.replace(/spread-\d+\.([a-z-]+)\.png$/, 'typo-anchor.$1.png');
}

/**
 * Elect the story's typography anchor: reuse the pinned crop when one
 * exists (unless re-electing), else crop it from the anchor spread's render
 * and pin it (create-if-absent — a racing instance adopts the winner).
 * @param {object} params
 * @param {Buffer|null} params.buffer the anchor spread's render bytes
 * @param {'left'|'right'} params.side the anchor spread's assigned text side
 * @param {string} params.pinKey anchorPinPath(...)
 * @param {boolean} [params.reelect] overwrite the pin (forceRerender)
 * @param {function} [params.crop] the crop function (cropTypographyAnchor; injectable for tests)
 * @param {function} [params.log]
 * @returns {Promise<{bytes: Buffer, hash: string, pinned: boolean}|null>}
 */
async function electTypographyAnchor({ buffer, side, pinKey, reelect = false, crop = cropTypographyAnchor, log = () => {} }) {
  if (!reelect) {
    try {
      const pinned = await downloadBuffer(pinKey);
      if (pinned && pinned.length > 0) return { bytes: pinned, hash: anchorHash(pinned), pinned: true };
    } catch {
      // no pin yet — elect below
    }
  }
  const bytes = await crop(buffer, side);
  if (!bytes) return null;
  try {
    if (reelect) {
      await uploadBuffer(bytes, pinKey, 'image/png');
    } else {
      const { created } = await uploadBufferIfAbsent(bytes, pinKey, 'image/png');
      if (!created) {
        try {
          const winner = await downloadBuffer(pinKey);
          if (winner && winner.length > 0) return { bytes: winner, hash: anchorHash(winner), pinned: true };
        } catch {
          // fall through to our own bytes for this run
        }
      }
    }
  } catch (err) {
    log('warn', `typography anchor pin write failed (${err.message}) — using the unpinned crop for this run`);
  }
  return { bytes, hash: anchorHash(bytes), pinned: false };
}

module.exports = { anchorCropRect, cropTypographyAnchor, anchorHash, anchorPinPath, electTypographyAnchor, ANCHOR_HALF_WIDTH, ANCHOR_MAX_HEIGHT };
