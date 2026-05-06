/**
 * Imperfect-rhyme detector.
 *
 * Catches the AA-CW (this session) failure: 'step' / 'kept' was being
 * shipped as a rhyme. They share the final consonant cluster /pt/ vs
 * /p/ but differ in coda and so do not rhyme. The deterministic
 * approach: compute a coarse rime (last-vowel + everything after it)
 * and require equality.
 *
 * Limitations (and we're OK with them):
 *   - English orthography ≠ pronunciation. We use a very small set of
 *     common-vowel-cluster normalizations to handle the highest-volume
 *     cases (e.g. 'eight' vs 'ate', 'tree' vs 'me'). For everything
 *     else, the LLM critic is the safety net.
 *   - We only check end-of-line pairs of the AABB scheme: L1/L2 and
 *     L3/L4. Free verse and other schemes live in their own band's
 *     ageProfile and skip this check via `rhymeStrictness`.
 *
 * Output is a list of failed couplets with both words so the revision
 * engine can pick a replacement that actually rhymes.
 */

const { lastWord } = require('./identityRhyme');

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

// Tiny normalization table for common eye-rhyme traps. Intentionally
// minimal — we'd rather err on the side of flagging and let the
// revision engine fix it than miss a real failure like 'kept' / 'step'.
const RIME_NORMALIZE = [
  [/ight$/, 'ite'],
  [/ought$/, 'ot'],
  [/ould$/, 'ud'],
  [/eigh$/, 'ay'],
  [/aught$/, 'ot'],
  [/tion$/, 'shun'],
];

/**
 * Extract a coarse "rime" — the last vowel and everything after.
 *   "step"  → "ep"
 *   "kept"  → "ept"
 *   "trees" → "ees"
 *   "tries" → "ies"  (caller normalizes 'i' / 'y' / 'ee' separately)
 *   "fight" → "ight" (then normalized to "ite")
 */
function rime(word) {
  if (!word) return null;
  let w = word.toLowerCase();
  for (const [re, repl] of RIME_NORMALIZE) {
    w = w.replace(re, repl);
  }
  let lastVowelIdx = -1;
  for (let i = w.length - 1; i >= 0; i -= 1) {
    if (VOWELS.has(w[i])) { lastVowelIdx = i; break; }
  }
  if (lastVowelIdx < 0) return w;
  return w.slice(lastVowelIdx);
}

function rhymes(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;            // identity (caught by other check)
  return rime(a) === rime(b);
}

/**
 * Returns failures keyed by couplet.
 */
function detectImperfectRhyme(text, { scheme } = {}) {
  if (scheme && /^free/i.test(scheme)) return null;

  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const failures = [];
  if (lines.length >= 2) {
    const a = lastWord(lines[0]);
    const b = lastWord(lines[1]);
    if (a && b && a !== b && !rhymes(a, b)) {
      failures.push({ couplet: 'L1L2', words: [a, b], rimes: [rime(a), rime(b)] });
    }
  }
  if (lines.length >= 4) {
    const a = lastWord(lines[2]);
    const b = lastWord(lines[3]);
    if (a && b && a !== b && !rhymes(a, b)) {
      failures.push({ couplet: 'L3L4', words: [a, b], rimes: [rime(a), rime(b)] });
    }
  }
  return failures.length ? failures : null;
}

function imperfectRhymeCheck(draft, beat, ageProfile) {
  // PB_INFANT softens L3/L4 by design. Skip when the band's strictness
  // says the scheme isn't enforced.
  const strict = ageProfile?.narrativeConstraints?.rhymeStrictness;
  if (!strict || strict === 'free' || strict === 'none') return { passed: true };

  const scheme = ageProfile?.narrativeConstraints?.rhymeScheme;
  const failures = detectImperfectRhyme(draft?.text || '', { scheme });
  if (!failures) return { passed: true };

  return {
    passed: false,
    code: 'imperfect_rhyme',
    message: failures.map((f) =>
      `Imperfect rhyme on ${f.couplet}: '${f.words[0]}' (${f.rimes[0]}) does not rhyme with '${f.words[1]}' (${f.rimes[1]}).`
    ).join(' '),
    detail: failures,
  };
}

module.exports = { imperfectRhymeCheck, detectImperfectRhyme, rime, rhymes };
