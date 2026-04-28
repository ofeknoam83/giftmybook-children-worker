/**
 * OpenAI Images 2.0 (gpt-image-2) illustration flow — public entry.
 *
 * Selected at runtime by:
 *   - services/bookPipeline/illustrator/renderAllSpreads.js (new pipeline)
 *   - services/illustrator/index.js (legacy entries-array pipeline)
 *
 * when `MODELS.SPREAD_RENDER` in `services/bookPipeline/constants.js` is
 * `gpt-image-2` (or any value starting with `gpt-image` / `openai-image`).
 *
 * The Gemini chat-session flow stays as-is and is the fallback for any other
 * value.
 */

const { renderAllSpreads, processOneSpread, canAcceptSpreadAfterExhaustionGate } = require('./newPipeline');
const { generateBookIllustrations, regenerateSpreadIllustration } = require('./legacyPipeline');
const { processSpread } = require('./processSpread');
const { renderSpread } = require('./render');
const { buildRulesBlock } = require('./rulesBlock');

module.exports = {
  // Doc-pipeline entry (called by bookPipeline)
  renderAllSpreads,
  processOneSpread,
  canAcceptSpreadAfterExhaustionGate,

  // Legacy entries-array entry (called by server.js)
  generateBookIllustrations,
  regenerateSpreadIllustration,

  // Re-exports for tests and direct callers
  processSpread,
  renderSpread,
  buildRulesBlock,
};
