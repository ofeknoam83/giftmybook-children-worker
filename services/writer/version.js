/**
 * Writer version stamping — every generated book gets metadata
 * so we can track which writer version produced which story.
 */

const WRITER_VERSION = 'children-v2.0.0';

/**
 * Create metadata object for a generated story.
 * @param {object} story - { spreads: [...], _model, _ageTier }
 * @param {object} quality - { overallScore, scores, pass }
 * @param {string} theme
 * @returns {object} metadata
 */
function stampBook(story, quality, theme) {
  const spreads = story.spreads || [];
  const totalWords = spreads.reduce((sum, s) => {
    const text = (s.text || '').trim();
    return sum + (text ? text.split(/\s+/).length : 0);
  }, 0);

  return {
    writerVersion: WRITER_VERSION,
    writerTimestamp: new Date().toISOString(),
    model: story._model || 'unknown',
    theme,
    ageTier: story._ageTier || 'unknown',
    qualityScore: quality.overallScore,
    qualityDetails: quality.scores,
    qualityPass: quality.pass,
    spreadsCount: spreads.length,
    totalWords,
  };
}

module.exports = { WRITER_VERSION, stampBook };
