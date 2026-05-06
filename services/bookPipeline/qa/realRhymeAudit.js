/**
 * AA-CW-23 — real rhyme rescue audit.
 *
 * The LLM judge (gpt-5.4 self-critique) hallucinates `rhyme_fail` on
 * spreads whose lines 1+2 actually DO rhyme. Production failure on
 * book e3f4e0c0 (post-AA-CW-22 deploy):
 *   spread 6:  face / place  → judge said rhyme_fail
 *   spread 9:  cheek / peek  → judge said rhyme_fail
 *   spread 10: chin / grin   → judge said rhyme_fail
 *   spread 11: cheek / peek  → judge said rhyme_fail
 *   ...
 * All real rhymes. AA-CW-22's rhymeBank actually delivered the rewrite,
 * but the same-model self-critique then killed the rewrite anyway.
 *
 * This audit RESCUES spreads where the judge said rhyme_fail but the
 * end-words actually rhyme. It is the inverse of the identity-rhyme
 * audit:
 *
 *   identity-rhyme audit:  if same word twice  → FORCE rhyme_fail
 *   real-rhyme rescue:     if real rhyme       → DROP rhyme_fail
 *
 * Detection heuristics (one is enough):
 *   1. Words listed as partners in the curated rhyme bank.
 *   2. Shared "rime" — the last vowel and everything after. Two
 *      different words whose terminal vowel-to-end character sequence
 *      matches are treated as rhyming for the purposes of dropping
 *      rhyme_fail. This catches face/place, cheek/peek, chin/grin,
 *      see/glee, day/play, light/tight, near/dear, smushy/cushy, etc.
 *
 * Conservative: only DROPS rhyme_fail when the words are different AND
 * one of the two heuristics fires. Never drops on identity rhymes
 * (those are blocked by the prior audit, but a defensive check exists
 * anyway). Never adds tags. Never affects spreads the judge passed.
 *
 * NOT a regex on prose. NOT pattern matching on text. Just a phoneme-
 * suffix comparison on the line-end words.
 */

const { lookupRhymes } = require('../writer/rhymeBank');

/**
 * Strip a single end-word to its rhyme-comparison form: lowercase,
 * trim, strip trailing punctuation (.!?,;:") and possessive 's.
 * Returns '' for empty / non-string.
 *
 * @param {string} word
 * @returns {string}
 */
function normalizeEndWord(word) {
  if (typeof word !== 'string') return '';
  return word
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:"']+$/g, '')
    .replace(/['’]s$/u, '')
    .replace(/^[^a-z\u00c0-\u024f]+/, '');
}

/**
 * Extract last vowel cluster + everything after (the rime).
 *
 * Examples:
 *   face   → "ace"
 *   place  → "ace"
 *   chin   → "in"
 *   grin   → "in"
 *   cheek  → "eek"
 *   peek   → "eek"
 *   smushy → "ushy"  (last vowel y, but multiword vowels treated)
 *   cushy  → "ushy"
 *   light  → "ight"
 *   tight  → "ight"
 *
 * Returns '' if the word has no vowel.
 *
 * Note: y is treated as a vowel ONLY when at the end of the word or
 * preceded by a consonant. For our infant-band end-words this is
 * good enough — we do not need full IPA.
 *
 * @param {string} word  already normalized via normalizeEndWord
 * @returns {string}
 */
function tailRime(word) {
  if (!word) return '';
  let w = word;
  // Step 1: detect silent trailing 'e' (face, place, gate, lake) and
  // anchor on the vowel BEFORE the medial consonant rather than on
  // the silent 'e'. "face" → anchor on 'a', rime = "ace".
  let trailingSilentE = false;
  if (w.length >= 4 && /[aeiouy][^aeiouy]e$/i.test(w)) {
    trailingSilentE = true;
    w = w.slice(0, -1); // drop the silent e for vowel-finding only
  }
  // Step 2: find the last vowel index. Treat y as vowel everywhere —
  // children's book end-words rarely have leading-y consonants ("yes").
  const vowels = /[aeiouy\u00e0-\u00fc]/g;
  let lastIdx = -1;
  let m;
  while ((m = vowels.exec(w)) !== null) lastIdx = m.index;
  if (lastIdx < 0) return '';
  // Walk back over consecutive vowels to capture the full vowel cluster
  // ("eek" from cheek, "ay" from day). Common diphthongs are pulled in.
  let start = lastIdx;
  while (start > 0 && /[aeiouy\u00e0-\u00fc]/.test(w[start - 1])) {
    start -= 1;
  }
  let rime = w.slice(start);
  // Re-attach the silent e if we stripped it, so face → "ace" not "ac".
  if (trailingSilentE) rime += 'e';
  // Collapse doubled final consonants (grass → gras, buzz → buz). This
  // lets grass/alas, buzz/fuzz, miss/kiss match without complicating
  // the comparison logic. Only collapses when the last two characters
  // are the same consonant.
  if (
    rime.length >= 2 &&
    rime[rime.length - 1] === rime[rime.length - 2] &&
    /[^aeiouy]/.test(rime[rime.length - 1])
  ) {
    rime = rime.slice(0, -1);
  }
  return rime;
}

/**
 * Decide whether two end-words form a real rhyme. Returns true when
 * the words are different AND either (a) the rhyme bank lists one as
 * a partner of the other, or (b) their tail rimes match.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isRealRhyme(a, b) {
  const x = normalizeEndWord(a);
  const y = normalizeEndWord(b);
  if (!x || !y) return false;
  if (x === y) return false; // identity rhyme — never rescue
  // Stem-rhyme guard: judge correctly flags pairs where one word is
  // a strict suffix of the other (smushy/mushy, bright/right, see/sees,
  // beam/beams). For a real rhyme we need both words to contribute
  // different consonant onsets to the rime. MUST run BEFORE the bank
  // lookup because the bank includes stem-pair entries (light/bright)
  // that should still be rescued in the bright/light direction but NOT
  // in the bright/right direction.
  if (x.endsWith(y) || y.endsWith(x)) return false;
  // Bank check (symmetric).
  const xPartners = lookupRhymes(x);
  if (xPartners.includes(y)) return true;
  const yPartners = lookupRhymes(y);
  if (yPartners.includes(x)) return true;
  // Rime check — last vowel cluster + everything after must match.
  const rx = tailRime(x);
  const ry = tailRime(y);
  if (!rx || !ry) return false;
  if (rx === ry && rx.length >= 2) return true;
  return false;
}

/**
 * Extract the last word of a single line. Mirrors the helper inside
 * the identity-rhyme audit so both audits agree on tokenization.
 *
 * @param {string} line
 * @returns {string}
 */
function lastWordOfLine(line) {
  if (typeof line !== 'string') return '';
  const m = line.toLowerCase().match(/([a-z\u00c0-\u024f']+)[^a-z\u00c0-\u024f']*$/i);
  return m ? m[1] : '';
}

/**
 * Apply the rescue audit to a list of `merged` per-spread entries.
 * Mutates the entries in place: when lines 1+2 of a spread form a
 * real rhyme but the judge raised `rhyme_fail` (and the audit did
 * NOT force `identity_rhyme`), strip `rhyme_fail` from `tags`, drop
 * matching issue strings, and recompute `pass` from the surviving
 * tags / issues.
 *
 * Returns the list of rescued spreads (for logging).
 *
 * @param {Array<{spreadNumber:number, tags:string[], issues:string[], pass:boolean}>} merged
 * @param {object} doc  full book document (for spread.manuscript.text)
 * @returns {Array<{spreadNumber:number, pair:string, lines:string}>}
 */
function applyRealRhymeRescue(merged, doc) {
  const rescued = [];
  for (const entry of merged) {
    if (!Array.isArray(entry.tags) || !entry.tags.includes('rhyme_fail')) continue;
    // Defensive: never rescue spreads also flagged as identity_rhyme
    // by the prior audit. Identity is always fatal.
    if (entry.tags.includes('identity_rhyme')) continue;
    const spread = doc.spreads.find(s => s.spreadNumber === entry.spreadNumber);
    const text = spread?.manuscript?.text;
    const lines = String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const w1 = lastWordOfLine(lines[0]);
    const w2 = lastWordOfLine(lines[1]);
    if (!w1 || !w2) continue;
    if (!isRealRhyme(w1, w2)) continue;
    // The 1+2 couplet rhymes. Drop rhyme_fail from tags + issues.
    entry.tags = entry.tags.filter(t => t !== 'rhyme_fail');
    entry.issues = (entry.issues || []).filter((s) => {
      if (typeof s !== 'string') return true;
      const lower = s.toLowerCase();
      // Drop the judge's rhyme-fail issue strings, not other issues.
      if (lower.startsWith('rhyme_fail')) return false;
      if (lower.includes("don't rhyme") || lower.includes('do not rhyme')) return false;
      if (lower.includes('non-rhyming')) return false;
      if (lower.includes('not a rhyme')) return false;
      return true;
    });
    // Recompute pass.
    entry.pass = entry.issues.length === 0 && entry.tags.length === 0;
    rescued.push({
      spreadNumber: entry.spreadNumber,
      pair: `${w1}/${w2}`,
      lines: '1+2',
    });
  }
  return rescued;
}

module.exports = {
  applyRealRhymeRescue,
  isRealRhyme,
  normalizeEndWord,
  tailRime,
  lastWordOfLine,
};
