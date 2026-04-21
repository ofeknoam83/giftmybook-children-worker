/**
 * Final batched illustration gate — re-runs cross-spread consistency on the full set
 * after all regen rounds (fail-closed; no "silent pass").
 */

const { checkCrossSpreadAgent1, checkCrossSpreadAgent2 } = require('./consistency');

/**
 * Final gate: cross-spread Agent 1 (character) then Agent 2 (font + style). Both must pass.
 *
 * @param {Array<{index: number, imageBase64: string, pageText: string}>} generatedImages
 * @param {object} opts - forwarded to agents
 * @returns {Promise<{pass: boolean, failedSpreads: Array<{index: number, issues: string[]}>}>}
 */
async function runFinalIllustrationGate(generatedImages, opts = {}) {
  if (!generatedImages.length) {
    return { pass: true, failedSpreads: [] };
  }
  if (generatedImages.length < 2) {
    return { pass: true, failedSpreads: [] };
  }
  const a1 = await checkCrossSpreadAgent1(generatedImages, opts);
  if (a1.failedSpreads.length > 0) {
    return { pass: false, failedSpreads: a1.failedSpreads, overallScore: a1.overallScore, agent: 1 };
  }
  const a2 = await checkCrossSpreadAgent2(generatedImages, opts);
  const pass = a2.failedSpreads.length === 0;
  const overallScore = (a1.overallScore + a2.overallScore) / 2;
  return { pass, failedSpreads: a2.failedSpreads, overallScore, agent: pass ? null : 2 };
}

module.exports = { runFinalIllustrationGate };
