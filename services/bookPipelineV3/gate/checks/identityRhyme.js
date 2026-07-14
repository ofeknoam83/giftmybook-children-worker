/**
 * Identity rhyme detector.
 *
 * Direct port of v1's AA-CW-27 `detectIdentityRhyme` (services/bookPipeline/
 * qa/checkWriterDraft.js). When the last word of L1 == last word of L2, or
 * the last word of L3 == last word of L4 (case-insensitive, trailing
 * punctuation stripped), it's an identity rhyme — not a rhyme at all,
 * just the same word twice. Real failures observed in production:
 * trees/trees, shade/shade, close/close, fence/fence, near/near,
 * light/light, sleeve/sleeve, Mama/Mama.
 *
 * The check is intentionally narrow: it only flags last-word equality on
 * couplet lines. Whole-word repetition elsewhere in the manuscript is the
 * book-wide critic's job.
 */

function lastWord(line) {
  if (typeof line !== 'string') return null;
  const m = line.toLowerCase().match(/([a-z']+)[^a-z']*$/);
  return m ? m[1] : null;
}

function detectIdentityRhyme(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  const w1 = lastWord(lines[0]);
  const w2 = lastWord(lines[1]);
  if (w1 && w1 === w2) return { couplet: 'L1L2', word: w1 };

  if (lines.length < 4) return null;
  const w3 = lastWord(lines[2]);
  const w4 = lastWord(lines[3]);
  if (w3 && w3 === w4) return { couplet: 'L3L4', word: w3 };

  return null;
}

function identityRhymeCheck(draft) {
  const text = draft?.text || '';
  const hit = detectIdentityRhyme(text);
  if (!hit) return { passed: true };
  return {
    passed: false,
    code: 'identity_rhyme',
    message: `Identity rhyme on ${hit.couplet}: '${hit.word}' rhymed with itself. Pick a different end-word.`,
    detail: hit,
  };
}

module.exports = { identityRhymeCheck, detectIdentityRhyme, lastWord };
