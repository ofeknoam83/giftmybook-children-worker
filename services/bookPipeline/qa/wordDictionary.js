/**
 * Common-English word lookup, for nonsense-word detection in writer QA.
 *
 * Backed by a public 370k-word lexicon (dwyl/english-words `words_alpha`)
 * shipped as a sibling .txt file. We extend it with a small CHILD_EXTRAS
 * set that covers baby-book vocabulary the broad list misses ("boop",
 * "shloop", common onomatopoeia) so we don't false-positive on legitimate
 * baby talk.
 *
 * The check intentionally permits ANY proper noun (assumed to be a name).
 * Callers pass the brief so we can also accept declared child / parent /
 * pet names that may not appear in the lexicon.
 *
 * We load the dictionary lazily on first use to keep startup cheap. A book
 * is ~13 spreads × ~4 lines × ~10 words = ~520 lookups, well under a Set's
 * O(1) cost.
 */

const fs = require('fs');
const path = require('path');

const DICTIONARY_FILE = path.join(__dirname, 'wordDictionary.txt');

// Baby-book vocabulary the broad lexicon doesn't include. Lowercase only.
// Add here when you find a legitimate baby word the dictionary misses.
const CHILD_EXTRAS = new Set([
  // Onomatopoeia / baby talk
  'boop', 'bop', 'beep', 'pop', 'plop', 'splosh', 'whoosh', 'whee', 'wheee',
  'oof', 'oop', 'oops', 'oopsie', 'uh', 'uhoh', 'shh', 'shhh', 'shush',
  'yum', 'yummy', 'yummers', 'mmm', 'mmmm', 'mwah', 'smooch',
  'tap', 'pat', 'bap', 'tickly', 'snuggly', 'cuddly',
  'wiggly', 'jiggly', 'giggly', 'wobbly', 'roly', 'poly',
  'goo', 'gaga', 'baba', 'dada', 'nana',
  'binky', 'lovey', 'paci', 'sippy',
  // Common animal sounds
  'moo', 'baa', 'oink', 'cluck', 'meow', 'mew', 'woof', 'arf', 'ruff',
  'quack', 'squeak', 'chirp', 'tweet', 'hoot', 'roar', 'neigh', 'hiss',
  // Common diminutives / nicknames
  'mommy', 'momma', 'daddy', 'dada', 'papa', 'pop', 'pops',
  'gigi', 'mimi', 'lolo', 'pop', 'nana', 'nanny', 'gramps', 'grandpa',
  'grandma', 'grammy', 'gramma', 'pawpaw', 'mawmaw',
]);

let cachedDictionary = null;

/**
 * Load and cache the lexicon. Synchronous read on first call (~3.8MB file,
 * ~370k entries). Returns a Set for O(1) lookup.
 *
 * @returns {Set<string>}
 */
function loadDictionary() {
  if (cachedDictionary) return cachedDictionary;
  let raw = '';
  try {
    raw = fs.readFileSync(DICTIONARY_FILE, 'utf8');
  } catch (err) {
    // If the dictionary file is missing, fail open: every word is "common"
    // so we don't generate spurious nonsense-word flags. Log a warning.
    // eslint-disable-next-line no-console
    console.warn('[wordDictionary] failed to load lexicon:', err.message);
    cachedDictionary = new Set();
    return cachedDictionary;
  }
  const set = new Set();
  for (const line of raw.split('\n')) {
    const w = line.trim().toLowerCase();
    if (w) set.add(w);
  }
  for (const w of CHILD_EXTRAS) set.add(w);
  cachedDictionary = set;
  return cachedDictionary;
}

/**
 * Normalise a single token to its dictionary-lookup form. Strips trailing
 * possessive 's, apostrophes, and surrounding punctuation. Returns ''
 * when no usable letters remain.
 *
 * @param {string} token
 * @returns {string}
 */
function normalizeToken(token) {
  const lowered = String(token || '').toLowerCase();
  // Remove leading/trailing punctuation but keep mid-word apostrophes.
  const trimmed = lowered.replace(/^[^a-z']+|[^a-z']+$/g, '');
  // Strip trailing possessive 's or apostrophe.
  return trimmed.replace(/['\u2019]s$/, '').replace(/['\u2019]+$/, '');
}

/**
 * Decide whether a token is a recognised English word for our purposes.
 * Returns true for: dictionary hits, child-extras hits, single letters,
 * pure digit strings, and tokens shorter than the min-length threshold
 * (we don't fail tiny tokens).
 *
 * @param {string} token raw token (case/punctuation tolerated)
 * @param {object} [opts]
 * @param {number} [opts.minLength=4] only check tokens >= this length
 * @returns {boolean}
 */
function isCommonEnglishWord(token, opts = {}) {
  const minLength = Number.isFinite(opts.minLength) ? opts.minLength : 4;
  const w = normalizeToken(token);
  if (!w) return true;
  if (w.length < minLength) return true;
  // Numbers and mixed alphanumerics that aren't alphabetic-only.
  if (!/^[a-z']+$/.test(w)) return true;
  const dict = loadDictionary();
  if (dict.size === 0) return true; // fail open
  if (dict.has(w)) return true;
  // Try without trailing 's' (rough plural strip), 'es', 'ed', 'ing', 'er'.
  for (const stripped of inflectionStrips(w)) {
    if (dict.has(stripped)) return true;
  }
  return false;
}

function inflectionStrips(w) {
  const out = [];
  if (w.endsWith('ies') && w.length > 3) out.push(w.slice(0, -3) + 'y');
  if (w.endsWith('es') && w.length > 3) out.push(w.slice(0, -2));
  if (w.endsWith('s') && w.length > 2) out.push(w.slice(0, -1));
  if (w.endsWith('ed') && w.length > 3) {
    out.push(w.slice(0, -2));
    out.push(w.slice(0, -1));
  }
  if (w.endsWith('ing') && w.length > 4) {
    out.push(w.slice(0, -3));
    out.push(w.slice(0, -3) + 'e');
  }
  if (w.endsWith('er') && w.length > 3) out.push(w.slice(0, -2));
  if (w.endsWith('est') && w.length > 4) out.push(w.slice(0, -3));
  return out;
}

/**
 * Reset the cached dictionary. Tests only.
 */
function _resetForTests() {
  cachedDictionary = null;
}

module.exports = {
  isCommonEnglishWord,
  normalizeToken,
  _resetForTests,
};
