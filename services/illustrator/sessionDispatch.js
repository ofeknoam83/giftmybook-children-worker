/**
 * Illustrator — Provider Dispatcher
 *
 * Chooses the image-generation backend based on `MODELS.SPREAD_RENDER` in
 * `services/bookPipeline/constants.js`:
 *   - gpt-image-*          → OpenAI Images 2.0 adapter (stateless)
 *   - gemini-*image*       → Gemini chat-session illustrator (stateful)
 *
 * All callers (e.g. renderAllSpreads.js) should import from here rather than
 * from `./session` or `./openaiImageSession` directly, so the provider can be
 * swapped with a single constant change.
 */

const { MODELS } = require('../bookPipeline/constants');

const geminiSession = require('./session');
const openaiSession = require('./openaiImageSession');

function resolveAdapter() {
  const model = String(MODELS.SPREAD_RENDER || '').toLowerCase();
  if (model.startsWith('gpt-image') || model.startsWith('openai-image')) {
    return openaiSession;
  }
  return geminiSession;
}

const adapter = resolveAdapter();

module.exports = {
  createSession: (opts) => adapter.createSession(opts),
  establishCharacterReference: (session) => adapter.establishCharacterReference(session),
  generateSpread: (session, prompt, idx, genOpts) => adapter.generateSpread(session, prompt, idx, genOpts),
  sendCorrection: (session, prompt, idx, opts) => adapter.sendCorrection(session, prompt, idx, opts),
  markSpreadAccepted: (session, idx, imageBase64) => adapter.markSpreadAccepted(session, idx, imageBase64),
  markQuadPairAccepted: (session, ...rest) => adapter.markQuadPairAccepted(session, ...rest),
  pruneLastTurn: (session) => adapter.pruneLastTurn(session),
  rebuildSession: (oldSession) => adapter.rebuildSession(oldSession),
  providerName: (() => {
    const m = String(MODELS.SPREAD_RENDER || '').toLowerCase();
    if (m.startsWith('gpt-image') || m.startsWith('openai-image')) return 'openai-gpt-image-2';
    return String(MODELS.SPREAD_RENDER || 'gemini');
  })(),
};
