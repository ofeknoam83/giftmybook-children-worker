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
 * Elected ONCE per story and PINNED beside the renders as ONE JSON object
 * (the crop rides inside as base64 beside its spread, side and hash — a
 * single create-if-absent write, so racing instances adopt one winner
 * like the world plate). Every later run reuses the pin whatever its
 * subset — a bench probe on spreads 4–6 pins page 4, and the final book
 * anchors on page 4 too, so the approved probe renders stay replayable;
 * `forceRerender` (all-or-nothing) re-elects. The pinned page keeps its
 * plain cache key; every OTHER spread folds the crop's content hash into
 * its key, so a re-elected anchor never replays renders made against the
 * old one. Fail-open: no anchor → the spreads render on the text rules
 * alone with a stage `typographyAnchor` advisory.
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
 * The pin path beside the renders: `…/{storyHash}/typo-anchor.{aspect}.json`
 * — derived from any render key of the story's un-folded directory (the
 * one every run resolves first), never from a folded one.
 * @param {string} renderKey renderCachePath(bookId, storyHash, spread, aspect, tag)
 * @returns {string}
 */
function anchorPinPath(renderKey) {
  return renderKey.replace(/spread-\d+\.([a-z-]+)\.png$/, 'typo-anchor.$1.json');
}

/**
 * Parse a pin blob. Null when unusable (a foreign or truncated object is
 * "no pin", never a throw).
 * @param {Buffer} raw
 * @returns {{spread: number, side: 'left'|'right', bytes: Buffer, hash: string, pinned: true}|null}
 */
function parsePin(raw) {
  try {
    const j = JSON.parse(raw.toString('utf8'));
    if (!j || typeof j !== 'object') return null;
    const spread = Number(j.spread);
    const side = j.side === 'left' || j.side === 'right' ? j.side : null;
    if (!Number.isInteger(spread) || spread < 1 || spread > 12 || !side || typeof j.png !== 'string' || !j.png) return null;
    const bytes = Buffer.from(j.png, 'base64');
    if (bytes.length === 0) return null;
    return { spread, side, bytes, hash: anchorHash(bytes), pinned: true };
  } catch {
    return null;
  }
}

/**
 * The story's pinned anchor, if an earlier run elected one.
 * @param {string} pinKey anchorPinPath(...)
 * @returns {Promise<{spread: number, side: 'left'|'right', bytes: Buffer, hash: string, pinned: true}|null>}
 */
async function readPinnedTypographyAnchor(pinKey) {
  try {
    return parsePin(await downloadBuffer(pinKey));
  } catch {
    return null;
  }
}

/**
 * Elect the story's typography anchor: reuse the pin when one exists
 * (unless re-electing), else crop it from the anchor spread's render and
 * pin it create-if-absent — a lost race adopts the winner (which may be a
 * different page, elected by a concurrent run of another subset).
 * @param {object} params
 * @param {Buffer|null} params.buffer the anchor spread's render bytes
 * @param {'left'|'right'} params.side the anchor spread's assigned text side
 * @param {number} params.spread the anchor spread number (recorded in the pin)
 * @param {string} params.pinKey anchorPinPath(...)
 * @param {boolean} [params.reelect] overwrite the pin (forceRerender)
 * @param {function} [params.crop] the crop function (cropTypographyAnchor; injectable for tests)
 * @param {function} [params.log]
 * @returns {Promise<{spread: number, side: 'left'|'right', bytes: Buffer, hash: string, pinned: boolean}|null>}
 */
async function electTypographyAnchor({ buffer, side, spread, pinKey, reelect = false, crop = cropTypographyAnchor, log = () => {} }) {
  if (!reelect) {
    const pinned = await readPinnedTypographyAnchor(pinKey);
    if (pinned) return pinned;
  }
  const bytes = await crop(buffer, side);
  if (!bytes) return null;
  const own = { spread, side, bytes, hash: anchorHash(bytes), pinned: false };
  const blob = Buffer.from(JSON.stringify({ spread, side, hash: own.hash, png: bytes.toString('base64'), electedAt: new Date().toISOString() }));
  try {
    if (reelect) {
      await uploadBuffer(blob, pinKey, 'application/json');
    } else {
      const { created } = await uploadBufferIfAbsent(blob, pinKey, 'application/json');
      if (!created) {
        const winner = await readPinnedTypographyAnchor(pinKey);
        if (winner) return winner;
      }
    }
  } catch (err) {
    log('warn', `typography anchor pin write failed (${err.message}) — using the unpinned crop for this run`);
  }
  return own;
}

module.exports = { anchorCropRect, cropTypographyAnchor, anchorHash, anchorPinPath, parsePin, readPinnedTypographyAnchor, electTypographyAnchor, ANCHOR_HALF_WIDTH, ANCHOR_MAX_HEIGHT };
