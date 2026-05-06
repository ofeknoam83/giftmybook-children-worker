/**
 * Moralizing-phrase check.
 *
 * Therapeutic intent must be structural, not stated. The list in
 * lexicons/moralisingPhrases.json is small and high-precision so we
 * can fail loud on it without wrecking creative latitude.
 */

const MORALISING = require('../../lexicons/moralisingPhrases.json');

function moralisingPhrasesCheck(draft) {
  const text = String(draft?.text || '').toLowerCase();
  const hits = MORALISING.phrases.filter((p) => text.includes(p));
  if (!hits.length) return { passed: true };
  return {
    passed: false,
    code: 'moralising_phrase',
    message: `Manuscript contains moralising/preachy phrase(s): ${hits.map((h) => `'${h}'`).join(', ')}. Deliver theme through what the protagonist DOES, not through narration telling the reader what to think.`,
    detail: { hits },
  };
}

module.exports = { moralisingPhrasesCheck };
