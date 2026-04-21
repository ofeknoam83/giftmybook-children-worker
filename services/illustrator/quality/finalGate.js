/**
 * Final illustration gate — delegates to the book-wide easy consistency review.
 * @deprecated Prefer runBookWideConsistencyReview from bookWideGate.js directly.
 */

const { runBookWideConsistencyReview } = require('./bookWideGate');

/**
 * @param {Array<{index: number, imageBase64: string, pageText?: string}>} generatedImages
 * @param {object} opts - storyBible, theme, hasParentOnCover, hasSecondaryOnCover, additionalCoverCharacters, costTracker, abortSignal, **session** (illustrator session for systemInstruction)
 * @returns {Promise<{pass: boolean, failedSpreads: Array<{index: number, issues: string[]}>, overallScore?: number, agent?: number|null}>}
 */
async function runFinalIllustrationGate(generatedImages, opts = {}) {
  if (!generatedImages?.length) {
    return { pass: true, failedSpreads: [] };
  }
  if (generatedImages.length < 2) {
    return { pass: true, failedSpreads: [] };
  }

  const session = opts.session || null;
  const r = await runBookWideConsistencyReview(session, generatedImages, opts);

  if (r.pass) {
    return { pass: true, failedSpreads: [], overallScore: 1, agent: null };
  }

  const issues = Array.isArray(r.issues) ? r.issues : [];
  const failedSpreads = (r.suspectSpreads || []).map(n => ({
    index: n - 1,
    issues: issues.length ? [...issues] : ['book-wide consistency'],
  }));

  return {
    pass: false,
    failedSpreads,
    overallScore: 0,
    agent: 1,
  };
}

module.exports = { runFinalIllustrationGate };
