/**
 * Cover pre-flight (2026-07-28) — verify the approved cover's render medium
 * BEFORE it anchors the book.
 *
 * The approved cover is simultaneously the sheet-generation anchor, the
 * likeness tiebreaker, reference #2 on every spread render, the plates'
 * style ground truth, AND the spread judge's style yardstick. Nothing ever
 * validated it: a 2D cover (watercolor upsell, admin upload) inverts every
 * style guard — 2D sheet → 2D spreads → a judge that AGREES with the drift
 * — and the existing harmonize-to-3D pass runs only at cover-PDF time,
 * AFTER the interiors are rendered (server.js → generateCover), with the
 * harmonized buffer discarded.
 *
 * This module resolves ONE cover anchor URL up front:
 *   - no cover / known-3D URL marker → unchanged (no vision spend)
 *   - medium check passes → unchanged
 *   - medium check fails → harmonize NOW, re-check, upload to a
 *     `cover-3d-harmonized` GCS path (the marker makes the later cover-PDF
 *     harmonize skip via shouldSkipCoverStyleHarmonize) and anchor the book
 *     on the harmonized image
 *   - anything fails → keep the original URL, loudly (advisory) — the
 *     pre-flight must never block a book.
 */

const { callVisionRole } = require('../llm/visionClient');
const { downloadPhotoAsBase64 } = require('../../illustrationGenerator');
const { uploadBuffer } = require('../../gcsStorage');
const { shouldSkipCoverStyleHarmonize, harmonizeChosenCoverToInteriorStyle } = require('../../coverGenerator');

function buildCoverPreflightPrompt() {
  return `You are checking ONE thing about a children's picture-book COVER illustration: its render MEDIUM.
This book's interiors render as a premium STYLIZED 3D CGI animated-film style — dimensional modeled geometry, physically based materials, cinematic lighting — and this cover is the style ground truth they will match.
FAIL only if the cover clearly reads as a DIFFERENT medium: a flat 2D / painterly / watercolor / paper-cutout / line-art / cel-shaded / hard-outline vector look, or a live-action photograph / photoreal real-camera render.
Palette, mood, composition, typography, and subject are NEVER failures — medium only. When unsure, pass.
Return STRICT JSON: { "medium_ok": true|false, "reason": "one short sentence" }`;
}

/**
 * Resolve the book's cover anchor. Never throws.
 *
 * @param {object} opts
 * @param {string} opts.bookId
 * @param {string|null} opts.coverImageUrl - rawRequest.cover.imageUrl
 * @param {AbortSignal} [opts.abortSignal]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{url: string|null, harmonized: boolean, advisory: string|null}>}
 */
async function resolveCoverAnchor({ bookId, coverImageUrl, abortSignal, log = () => {} }) {
  if (!coverImageUrl) return { url: null, harmonized: false, advisory: null };
  try {
    if (shouldSkipCoverStyleHarmonize(coverImageUrl)) {
      return { url: coverImageUrl, harmonized: false, advisory: null };
    }

    const cover = await downloadPhotoAsBase64(coverImageUrl);
    const check = async (image) => {
      const { json } = await callVisionRole('QA_VISION', {
        prompt: buildCoverPreflightPrompt(),
        images: [image],
        label: 'v3.cover.preflight',
        expectJson: true,
        temperature: 0,
        abortSignal,
      });
      return json.medium_ok === false
        ? { ok: false, reason: json.reason ? String(json.reason) : 'cover reads as a non-3D medium' }
        : { ok: true, reason: null };
    };

    const verdict = await check(cover);
    if (verdict.ok) {
      log('cover pre-flight: medium OK — anchoring interiors on the approved cover as-is');
      return { url: coverImageUrl, harmonized: false, advisory: null };
    }

    log(`cover pre-flight: anchor cover FAILED the medium check (${verdict.reason}) — harmonizing to 3D BEFORE interiors`);
    const originalBuffer = Buffer.from(cover.base64, 'base64');
    const harmonizedBuffer = await harmonizeChosenCoverToInteriorStyle(originalBuffer, {});
    // Harmonize silently degrades to the ORIGINAL buffer on its own infra
    // failures — re-checking the same pixels would just replay verdict #1
    // (or, worse, contradict it and mint a false known-3D marker for an
    // image that failed the first check). Treat a no-op as unfixed.
    if (harmonizedBuffer === originalBuffer) {
      const advisory = `cover anchor reads as a non-3D medium (${verdict.reason}) and the pre-flight harmonize was a NO-OP (harmonize infra/key issue?) — interiors anchored on the ORIGINAL cover; expect the book pass to flag cover parity`;
      log(`WARNING: ${advisory}`);
      return { url: coverImageUrl, harmonized: false, advisory };
    }
    const harmonizedMime = sniffImageMime(harmonizedBuffer);
    const recheck = await check({ base64: harmonizedBuffer.toString('base64'), mimeType: harmonizedMime });
    if (!recheck.ok) {
      const advisory = `cover anchor reads as a non-3D medium (${verdict.reason}) and the pre-flight harmonize did not fix it (${recheck.reason}) — interiors anchored on the ORIGINAL cover; expect the book pass to flag cover parity`;
      log(`WARNING: ${advisory}`);
      return { url: coverImageUrl, harmonized: false, advisory };
    }

    // The path carries the KNOWN_3D_SOURCE_MARKER ("3d-harmonized") so the
    // cover-PDF step later skips its own harmonize for this source. The
    // extension/content-type follow the ACTUAL bytes (Gemini image parts
    // commonly come back as JPEG regardless of what was sent).
    const ext = harmonizedMime === 'image/jpeg' ? 'jpg' : 'png';
    const path = `children-jobs/${bookId}/cover-3d-harmonized.${ext}`;
    const url = await uploadBuffer(harmonizedBuffer, path, harmonizedMime);
    const advisory = `cover anchor was ${verdict.reason || 'non-3D'} — harmonized to premium 3D before the interiors rendered (anchor: ${path})`;
    log(`cover pre-flight: harmonized cover uploaded (${path}) — the book anchors on it`);
    return { url, harmonized: true, advisory };
  } catch (err) {
    // Unverified beats blocked — the original anchor proceeds, but LOUDLY:
    // the advisory rides doc.qaAdvisories so a book whose anchor was never
    // medium-verified is visible to the admin, not just in Cloud Logging.
    const advisory = `cover pre-flight unavailable (${err.message}) — interiors anchored on the UNVERIFIED original cover`;
    log(advisory);
    return { url: coverImageUrl, harmonized: false, advisory };
  }
}

/**
 * Detect the actual image format from magic bytes (PNG signature / JPEG SOI).
 * Defaults to PNG for unrecognized buffers. Pure — exported for tests.
 *
 * @param {Buffer} buf
 * @returns {'image/png'|'image/jpeg'}
 */
function sniffImageMime(buf) {
  if (Buffer.isBuffer(buf) && buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  return 'image/png';
}

module.exports = { resolveCoverAnchor, buildCoverPreflightPrompt, sniffImageMime };
