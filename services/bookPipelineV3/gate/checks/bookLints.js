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
 * 2026-07-28 additions (book 16758e3c, "Liv's Great Underwater Discovery"):
 *
 *   unintroduced_refrain_object — the refrain chases a definite object
 *                      ("Could this be the sound?") that no line ever
 *                      introduced before the refrain's first use — the
 *                      book's central question arrived from nowhere
 *   monotone_page_turn — (nearly) every spread ends on a question; the
 *                      page-turn hook has become formulaic (flagged in the
 *                      2026-07-19 Rocket-Ride audit, unaddressed since)
 *   repetitive_opener — the same words open well over half the spreads
 *                      ("Swish, swish—Liv..." ×10 of 13)
 *   refrain_never_evolves — the manuscript declares refrain evolution
 *                      variants but only ever prints the base refrain
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

/**
 * The manuscript's declared refrain as plain text. `normalizeManuscript`
 * emits `refrain` as `{text, evolution}|null`; the original lints coerced
 * the object with String() ("[object Object]") which silently broke the
 * refrain exemptions. Tolerates the legacy plain-string form.
 */
function refrainTextOf(manuscript) {
  const r = manuscript?.refrain;
  if (!r) return '';
  if (typeof r === 'string') return r;
  return String(r.text || '');
}

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
  const refrain = normalizeSentence(refrainTextOf(manuscript));
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
  const refrainWords = new Set(normalizeSentence(refrainTextOf(manuscript)).split(' ').filter(Boolean));
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

/** Sorted spreads with normalized text/lines accessors — shared by the lints below. */
function sortedSpreads(manuscript) {
  return (manuscript.spreads || []).slice().sort((a, b) => a.spread - b.spread);
}
function linesOf(s) {
  if (Array.isArray(s.lines) && s.lines.length) return s.lines.map(String);
  return String(s.text || '').split('\n').filter((l) => l.trim());
}

/**
 * unintroduced_refrain_object: the refrain chases a DEFINITE object
 * ("Could this be the sound?", "Where is the light?") that no non-refrain
 * line introduced before — or on — the spread where the refrain first
 * appears. Book 16758e3c asked "Could this be the sound?" from spread 2
 * onward without any line ever planting a sound to chase; the resolution
 * (the sound is the child's laugh) landed unearned. A quest the reader was
 * never told about cannot pull a page-turn.
 *
 * @param {object} manuscript
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function unintroducedRefrainObjectLint(manuscript) {
  const refrainRaw = refrainTextOf(manuscript);
  const refrain = normalizeSentence(refrainRaw);
  if (!refrain) return [];
  // Definite noun phrases in the refrain: "the (magic) sound" → "sound".
  const nouns = [...refrain.matchAll(/\bthe\s+(?:\w+\s+)?(\w{3,})\b/g)]
    .map((m) => m[1])
    .filter((n) => !POSSESSIVE_STOPWORDS.has(n) && !FREQUENCY_STOPWORDS.has(n));
  if (nouns.length === 0) return [];

  const spreads = sortedSpreads(manuscript);
  const firstRefrainSpread = spreads.find((s) => s.refrain_here === true
    || normalizeSentence(s.text || linesOf(s).join(' ')).includes(refrain))?.spread;
  if (!Number.isFinite(firstRefrainSpread)) return [];

  const lints = [];
  for (const noun of [...new Set(nouns)]) {
    // Introduced = the noun appears in a sentence that is NOT the refrain,
    // on any spread up to and including the refrain's first use.
    const introduced = spreads
      .filter((s) => s.spread <= firstRefrainSpread)
      .some((s) => sentencesOf(s.text || linesOf(s).join('\n')).some((sentence) => {
        const norm = normalizeSentence(sentence);
        if (norm.includes(refrain) || refrain.includes(norm)) return false;
        return new RegExp(`\\b${noun}s?\\b`).test(norm);
      }));
    if (introduced) continue;
    lints.push({
      code: 'unintroduced_refrain_object',
      message: `the refrain asks about "the ${noun}" but no line introduces a ${noun} before its first use on spread ${firstRefrainSpread} — plant the quest object in the opening spread(s) (let the child hear/see/name it) so the refrain's question is about something the reader knows`,
      spreads: [firstRefrainSpread],
      targetSpreads: [spreads[0]?.spread ?? 1],
    });
  }
  return lints;
}

/**
 * monotone_page_turn: (nearly) every spread's last line ends on a question
 * mark. Writer rule 8 and the page_turn_pull judge dimension both push
 * toward hooks; with no counterweight the question-hook wins every spread
 * and reads formulaic by mid-book (Rocket-Ride audit W3, book 16758e3c:
 * a question ends 11 of 13 spreads). Targets a couple of MIDDLE offenders
 * so the revision has concrete spreads to vary.
 *
 * @param {object} manuscript
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function monotonePageTurnLint(manuscript) {
  const spreads = sortedSpreads(manuscript);
  if (spreads.length < 6) return [];
  const questionEnders = spreads.filter((s) => {
    const lines = linesOf(s);
    return /\?\s*$/.test(String(lines[lines.length - 1] || '').trim());
  });
  if (questionEnders.length < spreads.length - 2) return [];
  const targets = [...new Set([
    questionEnders[Math.floor(questionEnders.length / 3)]?.spread,
    questionEnders[Math.floor((2 * questionEnders.length) / 3)]?.spread,
  ].filter(Number.isFinite))];
  return [{
    code: 'monotone_page_turn',
    message: `${questionEnders.length} of ${spreads.length} spreads end on a question — the page-turn hook has become formulaic. On the targeted spreads, swap the closing question for a different hook type: a sound incoming ("Then — plink!"), a pattern about to break, or a cliff-clause ("Liv leans closer, and…")`,
    spreads: questionEnders.map((s) => s.spread),
    targetSpreads: targets,
  }];
}

/**
 * repetitive_opener: the same opening words start well over half the
 * spreads ("Swish, swish—Liv…" opened 10 of 13 in book 16758e3c). Even a
 * deliberate refrain-opener needs breathing room — the lint targets middle
 * occurrences (the bookend uses are usually intentional).
 *
 * @param {object} manuscript
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function repetitiveOpenerLint(manuscript) {
  const spreads = sortedSpreads(manuscript);
  if (spreads.length < 6) return [];
  const prefixOf = (s) => normalizeSentence(linesOf(s)[0] || '').split(' ').slice(0, 2).join(' ');
  const byPrefix = new Map();
  for (const s of spreads) {
    const p = prefixOf(s);
    if (p.split(' ').length < 2) continue;
    if (!byPrefix.has(p)) byPrefix.set(p, []);
    byPrefix.get(p).push(s.spread);
  }
  const lints = [];
  for (const [prefix, list] of byPrefix) {
    if (list.length <= Math.ceil(spreads.length * 0.6)) continue;
    const middle = list.slice(1, -1);
    lints.push({
      code: 'repetitive_opener',
      message: `"${prefix}…" opens ${list.length} of ${spreads.length} spreads — vary the opening on the targeted spreads (start mid-action, start with another character or a sound, or move the repeated phrase deeper into the spread) so the repetition reads as a ritual, not a rut`,
      spreads: list,
      targetSpreads: middle.filter((_, i) => i % 2 === 1).slice(0, 3),
    });
  }
  return lints;
}

/**
 * refrain_never_evolves: the manuscript DECLARES refrain evolution variants
 * (refrain.evolution) but only the base refrain ever prints — the promised
 * deepen/transform beats never happen, so the repetition flattens instead
 * of building. Fires only when the base refrain lands 3+ times (a refrain
 * used twice has no room to evolve).
 *
 * @param {object} manuscript
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function refrainNeverEvolvesLint(manuscript) {
  const r = manuscript?.refrain;
  if (!r || typeof r !== 'object') return [];
  const base = normalizeSentence(String(r.text || ''));
  if (!base) return [];
  const variants = (Array.isArray(r.evolution) ? r.evolution : [])
    .map((e) => normalizeSentence(String(e?.variant || '')))
    .filter((v) => v && v !== base);
  if (variants.length === 0) return [];

  const spreads = sortedSpreads(manuscript);
  const textOf = (s) => normalizeSentence(s.text || linesOf(s).join(' '));
  const baseSpreads = spreads.filter((s) => textOf(s).includes(base)).map((s) => s.spread);
  const anyVariantPrinted = variants.some((v) => spreads.some((s) => textOf(s).includes(v)));
  if (baseSpreads.length < 3 || anyVariantPrinted) return [];
  return [{
    code: 'refrain_never_evolves',
    message: `the refrain "${String(r.text)}" repeats unchanged on spreads ${baseSpreads.join(', ')} while its declared evolution variants never appear — use the variants at their phases (the climax-phase variant must actually differ) so the repetition builds instead of flattening`,
    spreads: baseSpreads,
    // The evolution is most missed at the last (climax-adjacent) use.
    targetSpreads: baseSpreads.slice(-1),
  }];
}

/**
 * Run every book-level lint. Never throws — a lint bug must not gate a book.
 *
 * @param {object} manuscript
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function runBookLints(manuscript) {
  const all = [];
  for (const lint of [
    duplicateClimaxLint, unintroducedPropLint, wordOveruseLint,
    unintroducedRefrainObjectLint, monotonePageTurnLint, repetitiveOpenerLint, refrainNeverEvolvesLint,
  ]) {
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
  unintroducedRefrainObjectLint,
  monotonePageTurnLint,
  repetitiveOpenerLint,
  refrainNeverEvolvesLint,
  normalizeSentence,
};
