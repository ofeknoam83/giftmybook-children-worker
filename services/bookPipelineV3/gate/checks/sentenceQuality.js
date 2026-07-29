/**
 * Mid-sentence punctuation check (2026-07-29 QA review, Liv birthday book):
 * "No dashes or semicolons mid-sentence. They break reading rhythm." A
 * parent reading aloud to a toddler needs plain sentence shapes.
 *
 * Band routing: PB_INFANT/PB_TODDLER → `midline_punctuation` (HARD — the
 * detection is a zero-false-positive character class and the fix is
 * trivially surgical: split the sentence). PB_PRESCHOOL →
 * `midline_punctuation_soft` (advisory). PB_EARLY_READER exempt (an em-dash
 * aside is legitimate at 6+).
 *
 * Word-internal hyphens (merry-go-round) never match; a dash that ENDS a
 * sentence/line ("Then—" as a cliff-hook) is sentence-final, not
 * mid-sentence, and passes.
 */

const { sentencesOf } = require('./textUtils');

const HARD_BANDS = new Set(['PB_INFANT', 'PB_TODDLER']);
const SOFT_BANDS = new Set(['PB_PRESCHOOL']);

// em dash, en dash, or double hyphen — anywhere; ASCII hyphen only when
// surrounded by whitespace (word-internal hyphens are compounds).
const MID_DASH_RE = /[—–]|--|\s-\s/;
const TRAILING_PUNCT_RE = /[—–;\-\s"“”'‘’.!?…]+$/;

/**
 * @param {{ text?: string }} draft
 * @param {null} beat - unused in V3
 * @param {object} ageProfile
 * @returns {{ passed: boolean, code?: string, message?: string, detail?: object }}
 */
function midlinePunctuationCheck(draft, beat, ageProfile) {
  const band = String(ageProfile?.ageBand || '');
  if (!HARD_BANDS.has(band) && !SOFT_BANDS.has(band)) return { passed: true };

  const offenders = [];
  for (const line of String(draft?.text || '').split('\n')) {
    for (const sentence of sentencesOf(line)) {
      // Strip sentence-final punctuation runs so a closing cliff-dash
      // ("and then—") doesn't count as mid-sentence.
      const body = sentence.replace(TRAILING_PUNCT_RE, '');
      if (MID_DASH_RE.test(body) || body.includes(';')) offenders.push(sentence);
    }
  }
  if (offenders.length === 0) return { passed: true };

  return {
    passed: false,
    code: HARD_BANDS.has(band) ? 'midline_punctuation' : 'midline_punctuation_soft',
    message: `mid-sentence dash/semicolon breaks read-aloud rhythm for ${band}: ${offenders.map((s) => `"${s}"`).join('; ')} — split each into two plain sentences (or use a comma)`,
    detail: { offenders, band },
  };
}

module.exports = { midlinePunctuationCheck };
