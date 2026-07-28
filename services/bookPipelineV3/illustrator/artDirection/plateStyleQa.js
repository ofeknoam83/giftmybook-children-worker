/**
 * Plate style QA (A1) — one cheap QA_VISION medium check per rendered
 * reference plate (world plates + prop plate).
 *
 * Why: plates render best-effort and were the ONLY images in the pipeline
 * that never met a judge. A plate that drifts to a different render medium
 * (flat 2D / painterly / photoreal) then rides EVERY spread that shares its
 * location as "match this setting's colors and lighting" — the 2026-07-18
 * fix (book 6e018c20) attached style REFERENCES to the plate render but
 * never VERIFIED the output, and book 16758e3c still shipped a cluster of
 * flat cel-shaded spreads all sharing one drifted plate's world elements.
 *
 * The check is medium-only (the same closed class-6 definition the spread
 * judge uses): palette, mood, and composition are never failures. A failed
 * plate gets ONE repair render; if the repair fails too the plate is
 * DROPPED — spreads still carry the sheet + cover as style references, so
 * losing a plate degrades continuity, while keeping a 2D plate seeds a
 * book-wide style break.
 */

const { callVisionRole } = require('../../llm/visionClient');

/**
 * Repair line appended to a plate re-render after a failed medium check —
 * same premium-3D vocabulary as the spread repair templates (qa/select.js).
 */
const PLATE_STYLE_REPAIR =
  'CRITICAL REPAIR: the previous attempt broke the book\'s signature style. Render in the premium 3D CGI animated-film medium EXACTLY — dimensional modeled geometry, physically based materials, rich saturated cinematic lighting. NOT a flat 2D illustration, NOT painterly/watercolor/line-art/cel-shaded, NOT a live-action photograph.';

/**
 * @param {'location'|'props'} subject
 * @param {boolean} hasReference
 * @returns {string}
 */
function buildPlateStyleQaPrompt(subject, hasReference) {
  return `You are checking ONE thing about a ${subject === 'props' ? 'prop' : 'location'} reference plate for a children's picture book: its render MEDIUM.
The book's signature style is a premium STYLIZED 3D CGI animated-film render — dimensional modeled geometry, physically based materials, cinematic lighting.
${hasReference ? 'Image 1 is the PLATE. Image 2 is this book\'s style ground truth — compare the render MEDIUM only; never compare subjects, palette, or mood.' : 'Judge the plate image on its own.'}
FAIL only if the plate clearly reads as a DIFFERENT medium: a flat 2D / painterly / watercolor / line-art / cel-shaded / hard-outline vector look, or a live-action photograph / photoreal real-camera render.
Palette choice, lighting warmth, level of detail, and composition are NEVER failures — medium only. When unsure, pass.
Return STRICT JSON: { "medium_ok": true|false, "reason": "one short sentence" }`;
}

/**
 * Medium-check one plate image. Best-effort like the plate renders
 * themselves: an unavailable judge passes the plate (never fail or stall a
 * book on QA infrastructure).
 *
 * @param {object} opts
 * @param {{base64: string, mimeType?: string}} opts.plate
 * @param {Array<{base64: string, mimeType?: string, kind?: string}>} [opts.styleReferences]
 *   book reference pack; the cover (or the sheet, for coverless books) is
 *   attached as the medium ground truth
 * @param {'location'|'props'} [opts.subject]
 * @param {string} [opts.label]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
async function qaPlateStyle({ plate, styleReferences = [], subject = 'location', label = 'v3.plate.styleqa', abortSignal }) {
  const reference = styleReferences.find((r) => r.kind === 'cover')
    || styleReferences.find((r) => r.kind === 'sheet')
    || null;
  try {
    const { json } = await callVisionRole('QA_VISION', {
      prompt: buildPlateStyleQaPrompt(subject, Boolean(reference)),
      images: reference ? [plate, reference] : [plate],
      label,
      expectJson: true,
      temperature: 0,
      abortSignal,
    });
    if (json.medium_ok === false) {
      return { ok: false, reason: json.reason ? String(json.reason) : 'render medium does not match the signature 3D style' };
    }
    return { ok: true, reason: null };
  } catch (err) {
    // Unreachable judge = unverified, not failed.
    return { ok: true, reason: `style QA unavailable (${err.message}) — plate shipped unverified` };
  }
}

module.exports = { qaPlateStyle, buildPlateStyleQaPrompt, PLATE_STYLE_REPAIR };
