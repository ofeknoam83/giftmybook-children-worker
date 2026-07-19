/**
 * Book-level manuscript lints (2026-07-18 print audit) — deterministic,
 * whole-manuscript checks that catch cross-spread writing defects the
 * per-spread gate cannot see:
 *
 *   duplicate_climax — the same emphatic sentence lands on two spreads
 *                      (the audit book fired its "My way." payoff on
 *                      spread 9 AND spread 12, diluting the ending)
 *   unintroduced_prop — a recurring prop first appears mid-book already
 *                      possessive ("his small lamp", spread 8) with no
 *                      earlier introduction
 *   word_overuse     — a signature noun leaned on so often it deadens
 *                      read-aloud rhythm ("crystal" ×18 in 13 spreads)
 *
 * These are SOFT lints: they never hard-fail the gate and never block a
 * book. They ride the gate result as `softLints`, are logged, and feed
 * the editor's targeted revision notes when a revision round runs.
 */

/** Words that legitimately follow a possessive without being story props. */
const POSSESSIVE_STOPWORDS = new Set([
  // body
  'eyes', 'eye', 'hand', 'hands', 'face', 'hair', 'head', 'feet', 'foot',
  'arms', 'arm', 'legs', 'leg', 'fingers', 'finger', 'chest', 'knees', 'knee',
  'shoulder', 'shoulders', 'chin', 'nose', 'cheeks', 'heart', 'breath', 'voice',
  'smile', 'grin', 'sides', 'side', 'back', 'body', 'ears', 'ear', 'toes',
  // kin & generic narrative nouns
  'mom', 'dad', 'mother', 'father', 'family', 'friend', 'friends', 'name',
  'turn', 'way', 'mind', 'step', 'steps', 'word', 'words', 'thoughts', 'thought',
  'room', 'home', 'bed', 'dream', 'dreams', 'story', 'adventure', 'journey',
]);

/** Frequent function words excluded from the overuse count. */
const FREQUENCY_STOPWORDS = new Set([
  'the', 'and', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'with', 'his', 'her',
  'their', 'into', 'over', 'under', 'then', 'than', 'that', 'this', 'from',
  'like', 'very', 'every', 'each', 'when', 'where', 'while', 'there', 'here',
  'they', 'them', 'says', 'said', 'calls', 'back', 'down', 'again', 'through',
  'across', 'toward', 'still', 'even', 'just', 'more', 'most', 'some', 'what',
  'will', 'wide', 'long', 'little', 'small', 'ahead', 'behind', 'about', 'both',
]);

/** Normalize a sentence for duplicate comparison. */
function normalizeSentence(s) {
  return String(s)
    .toLowerCase()
    .replace(/[“”"'‘’…—–-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split spread text into sentences (., !, ? boundaries). */
function sentencesOf(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * duplicate_climax: a normalized standalone sentence of 2+ words appearing
 * on EXACTLY two or three spreads (2+ repeats of a whole sentence is a
 * duplicated beat; one on 4+ spreads reads as an intentional refrain
 * pattern). Two words is deliberate: the audit book's duplicated payoff was
 * the standalone sentence "My way." — sentence splitting isolates such
 * emphatic beats, so short false positives stay rare. The manuscript's
 * declared refrain (and any sentence containing it) is exempt.
 *
 * @param {object} manuscript
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function duplicateClimaxLint(manuscript) {
  const refrain = normalizeSentence(manuscript.refrain || '');
  const seen = new Map(); // normalized sentence → Set<spread>
  for (const s of manuscript.spreads || []) {
    for (const sentence of sentencesOf(s.text || (s.lines || []).join('\n'))) {
      const norm = normalizeSentence(sentence);
      if (norm.split(' ').length < 2) continue;
      if (refrain && (norm === refrain || norm.includes(refrain) || refrain.includes(norm))) continue;
      if (!seen.has(norm)) seen.set(norm, new Set());
      seen.get(norm).add(s.spread);
    }
  }
  const lints = [];
  for (const [norm, spreads] of seen) {
    if (spreads.size < 2 || spreads.size > 3) continue;
    const list = [...spreads].sort((a, b) => a - b);
    lints.push({
      code: 'duplicate_climax',
      message: `the sentence "${norm}" lands on spreads ${list.join(' and ')} — an emphatic line should pay off ONCE (keep the later occurrence, rewrite the earlier one)`,
      spreads: list,
      // The fix belongs on the EARLIER spread — the later occurrence is the payoff.
      targetSpreads: list.slice(0, -1),
    });
  }
  return lints;
}

/**
 * unintroduced_prop: a recurring noun (2+ spreads) whose FIRST appearance
 * in the book is already possessive ("his lamp") on spread 4 or later —
 * a story prop the reader was never introduced to.
 *
 * @param {object} manuscript
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function unintroducedPropLint(manuscript) {
  const spreads = (manuscript.spreads || []).slice().sort((a, b) => a.spread - b.spread);
  const textOf = (s) => String(s.text || (s.lines || []).join('\n')).toLowerCase();
  // noun → { first: spread, firstPossessive: bool, spreads: Set }
  const nouns = new Map();
  for (const s of spreads) {
    const text = textOf(s);
    for (const m of text.matchAll(/\b(his|her|their)\s+(?:\w+\s+)?([a-z]{4,})\b/g)) {
      const noun = m[2];
      if (POSSESSIVE_STOPWORDS.has(noun)) continue;
      if (!nouns.has(noun)) nouns.set(noun, { firstPossessiveSpread: s.spread });
    }
  }
  const lints = [];
  for (const [noun, info] of nouns) {
    const mentioned = spreads.filter((s) => textOf(s).includes(noun)).map((s) => s.spread);
    if (mentioned.length < 2) continue; // one-off phrasing, not a recurring prop
    const firstMention = mentioned[0];
    if (firstMention !== info.firstPossessiveSpread) continue; // introduced earlier in some form
    if (firstMention < 4) continue; // introduced early enough
    lints.push({
      code: 'unintroduced_prop',
      message: `"${noun}" first appears on spread ${firstMention} already possessed ("his/her ${noun}") and recurs on spreads ${mentioned.join(', ')} — introduce it in the opening spreads (show the child carrying it) or rework the reference`,
      spreads: mentioned,
      // The fix belongs where the prop should have been introduced.
      targetSpreads: [spreads[0]?.spread ?? 1],
    });
  }
  return lints;
}

/**
 * word_overuse: a content word used more times than the spread count
 * (e.g. "crystal" ×18 in a 13-spread book). Advisory only — never a
 * revision target on its own (a whole-book synonym pass is editorial,
 * not surgical).
 *
 * @param {object} manuscript
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function wordOveruseLint(manuscript) {
  const spreads = manuscript.spreads || [];
  const refrainWords = new Set(normalizeSentence(manuscript.refrain || '').split(' ').filter(Boolean));
  const counts = new Map();
  for (const s of spreads) {
    const text = normalizeSentence(s.text || (s.lines || []).join('\n'));
    for (const raw of text.split(' ')) {
      const word = raw.replace(/s$/, ''); // crude plural fold (crystals → crystal)
      if (word.length < 4 || FREQUENCY_STOPWORDS.has(raw) || FREQUENCY_STOPWORDS.has(word) || refrainWords.has(raw)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  const threshold = Math.max(8, spreads.length);
  return [...counts.entries()]
    .filter(([, n]) => n > threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([word, n]) => ({
      code: 'word_overuse',
      message: `"${word}" appears ~${n} times across ${spreads.length} spreads — vary the wording (synonyms, pronouns, imagery) to keep the read-aloud rhythm fresh`,
      spreads: [],
      targetSpreads: [],
    }));
}

/**
 * Run every book-level lint. Never throws — a lint bug must not gate a book.
 *
 * @param {object} manuscript
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function runBookLints(manuscript) {
  const all = [];
  for (const lint of [duplicateClimaxLint, unintroducedPropLint, wordOveruseLint]) {
    try {
      all.push(...lint(manuscript));
    } catch (err) {
      console.warn(`[v3] book lint ${lint.name} threw (skipping): ${err.message}`);
    }
  }
  return all;
}

module.exports = {
  runBookLints,
  duplicateClimaxLint,
  unintroducedPropLint,
  wordOveruseLint,
  normalizeSentence,
};
