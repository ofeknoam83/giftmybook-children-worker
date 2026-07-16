/**
 * Book pass (A4) — ONE contact-sheet review of the selected winners:
 * did the planned shot variety actually land, outfit/prop continuity,
 * cover-to-interior consistency, and does the ending land visually.
 *
 * Flags trigger at most BOOK_PASS_REGEN_WAVES targeted regen waves for
 * the named spreads (handled by the caller); residual flags become a
 * needs_review item. Never a hard-fail loop.
 */

const { callVisionRole } = require('../../llm/visionClient');
const { buildNeedsReviewPayload } = require('../../reviewQueue/payload');

function buildContactSheetPrompt({ manuscript, direction }) {
  return `You are reviewing the COMPLETE set of interior illustrations for the picture book "${manuscript.title}" — one image per spread, in reading order (image 1 = spread 1). The FINAL image is the parent-approved COVER for comparison.

Check the BOOK AS A WHOLE (individual image quality was already judged):
1. VARIETY: do compositions/camera angles actually vary across the book (planned: ${[...new Set([...direction.directionBySpread.values()].map((d) => d.shot))].join(', ')})?
2. CONTINUITY: same outfit as the cover everywhere; recurring props consistent (${direction.continuityLocks?.props?.map((p) => p.name).join(', ') || 'none listed'}).
3. COVER MATCH: interior character reads as the same child, same rendering style, as the cover.
4. CHARACTER DRIFT: the child keeps the SAME apparent age and build on every spread (flag any spread where the child reads clearly younger/chubbier or older/slimmer than the cover), and the SAME facial marks (flag stray moles, beauty marks, or dark facial spots that are not on the cover).
5. ENDING: the final spread lands visually (warmth/resolution, not an arbitrary stop).

Return STRICT JSON:
{
  "pass": true|false,
  "flags": [ { "spread": n, "issue": "specific, actionable — e.g. 'outfit color differs from cover', 'spread 12 breaks style'" } ],
  "notes": "one-line overall verdict"
}
Only flag spreads that genuinely need re-rendering — style nitpicks that a parent would never notice do not count.`;
}

/**
 * @param {object} opts
 * @param {object} opts.manuscript
 * @param {object} opts.direction - runArtDirection result
 * @param {Array<{spread: number, base64: string, mimeType?: string}>} opts.winners - in reading order
 * @param {{base64: string, mimeType?: string}|null} [opts.cover]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{ pass: boolean, flags: Array<{spread: number, issue: string}>, notes: string }>}
 */
async function runBookPass({ manuscript, direction, winners, cover = null, abortSignal }) {
  const images = winners.map((w) => ({ base64: w.base64, mimeType: w.mimeType || 'image/png' }));
  if (cover) images.push({ base64: cover.base64, mimeType: cover.mimeType || 'image/jpeg' });

  const { json } = await callVisionRole('ART_DIRECTOR', {
    prompt: buildContactSheetPrompt({ manuscript, direction }),
    images,
    label: 'v3.bookpass',
    expectJson: true,
    abortSignal,
  });

  return {
    pass: json.pass === true && (!json.flags || json.flags.length === 0),
    flags: Array.isArray(json.flags)
      ? json.flags.map((f) => ({ spread: Number(f.spread), issue: String(f.issue || 'flagged') })).filter((f) => Number.isFinite(f.spread))
      : [],
    notes: json.notes || '',
  };
}

/**
 * @param {Array<{spread: number, issue: string}>} residualFlags
 * @param {string[]} candidateUrls
 * @returns {object} needs_review payload
 */
function buildBookPassNeedsReview(residualFlags, candidateUrls = []) {
  return buildNeedsReviewPayload({
    stage: 'bookPass',
    reason: 'book_pass_exhausted',
    spread: residualFlags[0]?.spread ?? null,
    defects: residualFlags.map((f) => `spread ${f.spread}: ${f.issue}`),
    candidateUrls,
  });
}

module.exports = { runBookPass, buildContactSheetPrompt, buildBookPassNeedsReview };
