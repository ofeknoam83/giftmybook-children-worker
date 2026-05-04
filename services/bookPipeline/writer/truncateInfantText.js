/**
 * Infant manuscript truncator.
 *
 * Defense-in-depth for the writer: if the model returns more than 2 lines for
 * an infant (PB_INFANT) spread, we truncate to a 2-line AA couplet rather than
 * letting the gate reject the whole book and burn a rewrite wave. The gate
 * still records the violation so the next wave receives the feedback, but the
 * intermediate manuscript is at least shaped correctly for downstream stages
 * (illustrator, layout) that consume the text.
 *
 * Strategy when more than 2 lines arrive:
 *   - prefer the first AA-rhyming pair found (lines 1+2, then 1+3, then 1+4,
 *     then 2+3, then 2+4, then 3+4)
 *   - fall back to the first two non-empty lines
 */

const { AGE_BANDS } = require('../constants');
const { wordsRhyme } = require('../qa/checkWriterDraft');

function lastWord(line) {
  const m = String(line || '').toLowerCase().match(/([a-z']+)[^a-z']*$/i);
  return m ? m[1] : '';
}

/**
 * Return a 2-line manuscript text given any-line text. Picks the best AA pair
 * if available, else the first two non-empty lines.
 *
 * @param {string} text
 * @returns {string}
 */
function pickInfantCoupletFromText(text) {
  const lines = String(text || '')
    .split('\n')
    .map(l => l.replace(/\s+$/u, ''))
    .filter(l => l.trim().length > 0);
  if (lines.length <= 2) return lines.join('\n');

  // Try every ordered pair (i, j) with i < j and pick the first that rhymes.
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (wordsRhyme(lastWord(lines[i]), lastWord(lines[j]))) {
        return [lines[i], lines[j]].join('\n');
      }
    }
  }
  return [lines[0], lines[1]].join('\n');
}

/**
 * Apply infant truncation only when the document is an infant book. No-op for
 * other bands. Returns a possibly-modified manuscript object.
 *
 * @param {object} manuscript
 * @param {object} doc
 * @returns {object}
 */
function maybeTruncateInfantManuscript(manuscript, doc) {
  if (!manuscript) return manuscript;
  if (doc?.request?.ageBand !== AGE_BANDS.PB_INFANT) return manuscript;
  const text = manuscript.text;
  if (!text) return manuscript;
  const lineCount = text.split('\n').filter(l => l.trim()).length;
  if (lineCount <= 2) return manuscript;
  const truncated = pickInfantCoupletFromText(text);
  return { ...manuscript, text: truncated };
}

module.exports = {
  pickInfantCoupletFromText,
  maybeTruncateInfantManuscript,
};
