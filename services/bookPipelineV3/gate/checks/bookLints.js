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
 * 2026-07-29 additions (Liv birthday book QA review, "AI Writer Feedback
 * & Word List"):
 *
 *   verbless_sentence — sentences with no verb read as image fragments
 *                      ("Moonlight silver on sand."), not story
 *   staccato_style   — over half the book's sentences are ≤3 words
 *                      ("Balloons bop. Confetti skips.") — disconnected
 *                      images with no causal chain
 *   sentence_length  — book-average words/sentence above the band's
 *                      read-aloud budget (maxAvgSentenceWords)
 *   concept_overload — a spread introduces 3+ never-seen objects ("a chest
 *                      and a map and confetti in one spread is too much")
 *   name_scarcity    — the child's name anchors too few spreads
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

const {
  normalizeSentence, sentencesOf, sortedSpreads, linesOf, wordsOf, isDialogue, inflectionSet,
} = require('./textUtils');
const { countWords } = require('./wordBudget');
const { containsName } = require('./bookChecks');
const { findOnomatopoeiaEvents } = require('./onomatopoeia');
const { textHasPastTenseMarker } = require('./pastTense');
const { narrativeTenseFor } = require('../../ageProfiles');
const { roleTokens } = require('../../storyRoles');
const COMMON_VERBS = require('../lexicons/commonVerbs.json');

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
 * (e.g. "crystal" ×18 in a 13-spread book). Originally advisory with no
 * targets ("a whole-book synonym pass is editorial, not surgical") —
 * which meant the finding was detected and then DISCARDED on every book
 * (the 2026-07-18 audit's #1 rhythm finding). Now the two spreads where
 * the word is densest become surgical targets: thinning the worst
 * clusters breaks the drone without a whole-book sweep, and gives the
 * post-panel polish pass something to grab.
 *
 * @param {object} manuscript
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function wordOveruseLint(manuscript) {
  const spreads = manuscript.spreads || [];
  const refrainWords = new Set(normalizeSentence(refrainTextOf(manuscript)).split(' ').filter(Boolean));
  const counts = new Map(); // word → total count
  const bySpread = new Map(); // word → Map<spread, count>
  for (const s of spreads) {
    const text = normalizeSentence(s.text || (s.lines || []).join('\n'));
    for (const raw of text.split(' ')) {
      const word = raw.replace(/s$/, ''); // crude plural fold (crystals → crystal)
      if (word.length < 4 || FREQUENCY_STOPWORDS.has(raw) || FREQUENCY_STOPWORDS.has(word) || refrainWords.has(raw)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
      if (!bySpread.has(word)) bySpread.set(word, new Map());
      bySpread.get(word).set(s.spread, (bySpread.get(word).get(s.spread) || 0) + 1);
    }
  }
  const threshold = Math.max(8, spreads.length);
  return [...counts.entries()]
    .filter(([, n]) => n > threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([word, n]) => {
      const perSpread = [...(bySpread.get(word) || new Map()).entries()].sort((a, b) => b[1] - a[1]);
      const densest = perSpread.slice(0, 2).map(([spread]) => spread).sort((a, b) => a - b);
      return {
        code: 'word_overuse',
        message: `"${word}" appears ~${n} times across ${spreads.length} spreads — thin it on the densest spreads (${densest.join(', ')}) with synonyms, pronouns, or imagery to keep the read-aloud rhythm fresh`,
        spreads: perSpread.map(([spread]) => spread).sort((a, b) => a - b),
        targetSpreads: densest,
      };
    });
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
    message: `${questionEnders.length} of ${spreads.length} spreads end on a question — the page-turn hook has become formulaic. On the targeted spreads, swap the closing question for a different hook type: a sound incoming ("Then, plink!"), a pattern about to break, or a cliff-clause ("Liv leans closer, and…")`,
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
 * word_length: words longer than the band's vocabularyConstraints
 * .maxWordLengthChars (the ONLY machine-checkable field in that config —
 * the category labels have no lexicons and stay prompt-only). Advisory
 * with targets: an 11-letter word in an infant book is a read-aloud
 * stumble the writer can fix surgically. Exemptions: the child's name and
 * capitalized tokens (proper nouns).
 *
 * @param {object} manuscript
 * @param {{ageProfile?: object, protagonistName?: string}} [opts]
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function wordLengthLint(manuscript, opts = {}) {
  const maxLen = Number(opts.ageProfile?.vocabularyConstraints?.maxWordLengthChars);
  if (!Number.isFinite(maxLen) || maxLen < 4) return [];
  const nameLower = String(opts.protagonistName || '').toLowerCase();
  const offenders = new Map(); // word → Set<spread>
  for (const s of sortedSpreads(manuscript)) {
    for (const raw of String(s.text || linesOf(s).join(' ')).match(/[A-Za-z']+/g) || []) {
      if (/^[A-Z]/.test(raw)) continue; // proper nouns / sentence-case names
      const word = raw.toLowerCase().replace(/'/g, '');
      if (word.length <= maxLen || word === nameLower) continue;
      if (!offenders.has(word)) offenders.set(word, new Set());
      offenders.get(word).add(s.spread);
    }
  }
  if (offenders.size === 0) return [];
  const words = [...offenders.keys()].sort((a, b) => b.length - a.length).slice(0, 5);
  const targetSpreads = [...new Set(words.flatMap((w) => [...offenders.get(w)]))].sort((a, b) => a - b).slice(0, 3);
  return [{
    code: 'word_length',
    message: `word(s) over the band's ${maxLen}-character read-aloud budget: ${words.map((w) => `"${w}"`).join(', ')} — swap for shorter words on the targeted spreads`,
    spreads: targetSpreads,
    targetSpreads,
  }];
}

/**
 * Wearable-gear vocabulary the illustrator must reconcile (2026-07-28 audit,
 * book 4c8daf08: the prose read "behind his visor" and "gloved finger" while
 * every illustration showed a bare-headed kid in a hoodie with bare hands —
 * a text-vs-art mismatch parents notice on every read). Conservative list:
 * words that unambiguously dress the hero in drawable gear.
 */
const WEARABLE_GEAR_WORDS = new Set([
  'visor', 'helmet', 'goggles', 'spacesuit', 'glove', 'gloves', 'gloved',
]);

/**
 * Surface story-worn gear so the writer (on a revision round) either commits
 * to it or drops it — and so the art-direction stage's TEXT-WORN GEAR rule
 * has a paper trail. Soft lint: never gates.
 *
 * @param {object} manuscript
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function wearableGearLint(manuscript) {
  const bySpread = new Map(); // spread → Set<word>
  for (const s of sortedSpreads(manuscript)) {
    for (const raw of String(s.text || linesOf(s).join(' ')).match(/[A-Za-z']+/g) || []) {
      const word = raw.toLowerCase();
      if (!WEARABLE_GEAR_WORDS.has(word)) continue;
      if (!bySpread.has(s.spread)) bySpread.set(s.spread, new Set());
      bySpread.get(s.spread).add(word);
    }
  }
  if (bySpread.size === 0) return [];
  const spreads = [...bySpread.keys()].sort((a, b) => a - b);
  const detail = spreads.map((n) => `spread ${n}: ${[...bySpread.get(n)].join('/')}`).join('; ');
  return [{
    code: 'wearable_gear',
    message: `the text dresses the hero in wearable gear (${detail}) — the art must show this gear (the art director locks it via continuityLocks.gear) or the prose should drop the gear wording; gear words with no gear in the art read as a mistake on every page`,
    spreads,
    targetSpreads: spreads.slice(0, 3),
  }];
}

/**
 * Verb surface forms for the fragment lint — every inflection of the
 * common-verbs lexicon plus its verbatim auxiliary/irregular forms.
 */
const VERB_FORMS = (() => {
  const set = inflectionSet(COMMON_VERBS.base || []);
  for (const f of COMMON_VERBS.forms || []) set.add(String(f).toLowerCase());
  return set;
})();

/** Contraction suffixes that carry a verb ("it's", "we're", "don't"). */
const VERB_CONTRACTION_RE = /[’'](s|re|m|ll|ve|d)\b|n[’']t\b/i;

/** Interjection/exclamative openers that legitimately head a verbless line. */
const INTERJECTION_OPENERS = new Set([
  'what', 'how', 'oh', 'wow', 'hello', 'goodbye', 'goodnight', 'yay',
  'hooray', 'uh', 'ah', 'ooh', 'aah', 'mmm', 'shh', 'wheee', 'whee',
]);

/**
 * Whether a sentence should be exempt from fragment analysis: dialogue,
 * exclamations, the declared refrain, interjection openers.
 */
function fragmentExempt(sentence, refrainNorm) {
  const s = String(sentence);
  if (isDialogue(s)) return true;
  if (/!\s*$/.test(s.trim())) return true;
  const norm = normalizeSentence(s);
  if (refrainNorm && (norm.includes(refrainNorm) || refrainNorm.includes(norm))) return true;
  const first = norm.split(' ')[0];
  return INTERJECTION_OPENERS.has(first);
}

/**
 * verbless_sentence (2026-07-29 QA review, Liv book): "No sentence without
 * a verb. This is what catches fragments programmatically." A sentence of
 * 3+ words with no token in the verb lexicon and no verb-carrying
 * contraction is fragment-suspect ("Moonlight silver on sand."). SOFT by
 * design — a verb allow-list is inherently incomplete, and a rare verb
 * ("Liv toddles") must never hard-bounce a good book.
 *
 * @param {object} manuscript
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function verblessSentenceLint(manuscript) {
  const refrainNorm = normalizeSentence(refrainTextOf(manuscript));
  const bySpread = new Map(); // spread → offending sentences
  for (const s of sortedSpreads(manuscript)) {
    for (const sentence of sentencesOf(s.text || linesOf(s).join('\n'))) {
      const words = wordsOf(sentence);
      if (words.length < 3) continue;
      if (fragmentExempt(sentence, refrainNorm)) continue;
      if (VERB_CONTRACTION_RE.test(sentence)) continue;
      const hasVerb = words.some((w) => VERB_FORMS.has(w.toLowerCase().replace(/[’']/g, '')));
      if (hasVerb) continue;
      if (!bySpread.has(s.spread)) bySpread.set(s.spread, []);
      bySpread.get(s.spread).push(sentence);
    }
  }
  if (bySpread.size === 0) return [];
  const spreads = [...bySpread.keys()].sort((a, b) => a - b);
  const examples = spreads.slice(0, 3).map((n) => `"${bySpread.get(n)[0]}" (spread ${n})`).join(', ');
  return [{
    code: 'verbless_sentence',
    message: `sentence(s) with no verb read as image fragments, not story: ${examples} — rewrite each as a full sentence where something HAPPENS (subject + action), joining fragments with connectives (and, so, then, but)`,
    spreads,
    targetSpreads: spreads.slice(0, 3),
  }];
}

/**
 * staccato_style (2026-07-29 QA review): the Liv book's signature failure —
 * "Balloons bop. Confetti skips." Grammatically complete, stylistically
 * fragmented: disconnected images with no causal link. Fires when over half
 * the book's sentences are 3 words or fewer (refrain sentences exempt —
 * high intentional repetition is a feature per repetitionDensity) across a
 * meaningful sample (15+ sentences).
 *
 * @param {object} manuscript
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function staccatoStyleLint(manuscript) {
  const refrainNorm = normalizeSentence(refrainTextOf(manuscript));
  let total = 0;
  let short = 0;
  const shortBySpread = new Map();
  for (const s of sortedSpreads(manuscript)) {
    for (const sentence of sentencesOf(s.text || linesOf(s).join('\n'))) {
      const norm = normalizeSentence(sentence);
      if (refrainNorm && (norm.includes(refrainNorm) || refrainNorm.includes(norm))) continue;
      total += 1;
      if (wordsOf(sentence).length <= 3) {
        short += 1;
        shortBySpread.set(s.spread, (shortBySpread.get(s.spread) || 0) + 1);
      }
    }
  }
  if (total < 15 || short / total <= 0.5) return [];
  const densest = [...shortBySpread.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([spread]) => spread).sort((a, b) => a - b);
  return [{
    code: 'staccato_style',
    message: `${short} of ${total} sentences are 3 words or fewer — the book reads as disconnected staccato images ("Balloons bop. Confetti skips."), not a story. Write full sentences with connective words (and, so, then, but) and make every spread connect causally to the one before: this happened, SO THEN this happened`,
    spreads: [...shortBySpread.keys()].sort((a, b) => a - b),
    targetSpreads: densest,
  }];
}

/**
 * sentence_length (2026-07-29 QA review): "Average sentence length under 12
 * words. Longer gets hard to read aloud." Checked against the band's
 * vocabularyConstraints.maxAvgSentenceWords (INFANT 8 / TODDLER 9 /
 * PRESCHOOL 11 / EARLY_READER 12); self-disables when the profile lacks the
 * field. Book-average metric → SOFT (not spread-surgical enough to spend
 * the one gatefix on); targets the longest-winded spreads.
 *
 * @param {object} manuscript
 * @param {{ageProfile?: object}} [opts]
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function sentenceLengthLint(manuscript, opts = {}) {
  const maxAvg = Number(opts.ageProfile?.vocabularyConstraints?.maxAvgSentenceWords);
  if (!Number.isFinite(maxAvg) || maxAvg < 4) return [];
  let totalWords = 0;
  let totalSentences = 0;
  const perSpread = [];
  for (const s of sortedSpreads(manuscript)) {
    const sentences = sentencesOf(s.text || linesOf(s).join('\n'));
    if (sentences.length === 0) continue;
    const words = sentences.reduce((acc, sent) => acc + wordsOf(sent).length, 0);
    totalWords += words;
    totalSentences += sentences.length;
    perSpread.push({ spread: s.spread, avg: words / sentences.length });
  }
  if (totalSentences === 0) return [];
  const avg = totalWords / totalSentences;
  if (avg <= maxAvg) return [];
  const targets = perSpread.sort((a, b) => b.avg - a.avg).slice(0, 3)
    .map((e) => e.spread).sort((a, b) => a - b);
  return [{
    code: 'sentence_length',
    message: `average sentence length is ${avg.toFixed(1)} words against the band's read-aloud budget of ${maxAvg} — split long sentences on the targeted spreads into short plain ones a parent can read without tripping`,
    spreads: targets,
    targetSpreads: targets,
  }];
}

/**
 * concept_overload (2026-07-29 QA review): "Max one new concept per spread.
 * A chest and a map and confetti in one spread is too much." Computed from
 * scene_contract.key_objects head-noun first appearances; spreads 3+ that
 * introduce 3+ never-before-seen objects get linted (spreads 1-2 exempt —
 * world setup; threshold 3 not 2 because object-naming drift across
 * contracts, "red bucket" vs "bucket", creates false positives).
 *
 * @param {object} manuscript
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function conceptOverloadLint(manuscript) {
  const headOf = (obj) => String(obj || '').toLowerCase().trim().split(/\s+/).pop()?.replace(/s$/, '') || '';
  const seen = new Set();
  const offenders = [];
  for (const s of sortedSpreads(manuscript)) {
    const heads = new Set(
      (s.scene_contract?.key_objects || []).map(headOf).filter((h) => h.length >= 3),
    );
    const fresh = [...heads].filter((h) => !seen.has(h));
    fresh.forEach((h) => seen.add(h));
    if (s.spread >= 3 && fresh.length >= 3) offenders.push({ spread: s.spread, fresh });
  }
  if (offenders.length === 0) return [];
  const detail = offenders.map((o) => `spread ${o.spread}: ${o.fresh.join(', ')}`).join('; ');
  const targets = offenders.map((o) => o.spread).slice(0, 3);
  return [{
    code: 'concept_overload',
    message: `too many new objects introduced at once (${detail}) — a young listener holds one new thing per page-turn; keep ONE new concept per spread and reuse objects the story already planted`,
    spreads: offenders.map((o) => o.spread),
    targetSpreads: targets,
  }];
}

/**
 * name_scarcity (2026-07-29 QA review): the child's name should anchor the
 * story ("used at least once every 3-4 sentences" in the guidelines; at
 * spread scale: on well over a third of spreads). Fires when the name
 * appears on fewer than 40% of spreads; targets the middle of the longest
 * nameless run.
 *
 * @param {object} manuscript
 * @param {{protagonistName?: string}} [opts]
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function nameScarcityLint(manuscript, opts = {}) {
  const name = String(opts.protagonistName || '').trim();
  if (!name) return [];
  const spreads = sortedSpreads(manuscript);
  if (spreads.length < 6) return [];
  const withName = spreads.filter((s) => containsName(s.text || linesOf(s).join('\n'), name));
  if (withName.length / spreads.length >= 0.4) return [];
  // Longest consecutive run of spreads without the name.
  const named = new Set(withName.map((s) => s.spread));
  let run = [];
  let longest = [];
  for (const s of spreads) {
    if (named.has(s.spread)) {
      if (run.length > longest.length) longest = run;
      run = [];
    } else {
      run.push(s.spread);
    }
  }
  if (run.length > longest.length) longest = run;
  const mid = longest.length
    ? [...new Set([longest[Math.floor(longest.length / 3)], longest[Math.floor((2 * longest.length) / 3)]])]
    : [];
  return [{
    code: 'name_scarcity',
    message: `${name} is named on only ${withName.length} of ${spreads.length} spreads — this is ${name}'s book; use the name often (roughly every few sentences) so the child hears themselves as the hero, starting with the targeted spreads`,
    spreads: spreads.filter((s) => !named.has(s.spread)).map((s) => s.spread),
    targetSpreads: mid,
  }];
}

/** Where each story role is expected to do its work (13-spread skeleton:
 * tool at first-attempt, trait at turning-point, food at world-entry). */
const ROLE_HOME_SPREADS = { tool: [7], turningPoint: [9], worldObject: [5] };

/**
 * Whether any of a role's tokens appears in the given lowercase text.
 * Plural tokens also match their singular ("bananas" hits "banana boat") —
 * crude on purpose; every consumer is a SOFT lint.
 */
function roleTokenHit(text, tokens) {
  return tokens.some((t) => text.includes(t)
    || (t.length > 4 && t.endsWith('s') && text.includes(t.slice(0, -1))));
}

/**
 * role_unused (2026-07-29 QA review rule 3's deterministic teeth): a cast
 * story role — hobby-tool, funny-trait turning point, food world-object —
 * whose tokens appear NOWHERE in the manuscript was collected and
 * discarded, the Liv book's root failure. SOFT (token matching is fuzzy by
 * nature); targets the role's home beat so the revision knows where the
 * mechanic belongs. Gated on opts.storyRoles.
 *
 * @param {object} manuscript
 * @param {{storyRoles?: object}} [opts]
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function roleUnusedLint(manuscript, opts = {}) {
  const roles = opts.storyRoles;
  if (!roles) return [];
  const allText = sortedSpreads(manuscript)
    .map((s) => normalizeSentence(s.text || linesOf(s).join(' ')))
    .join(' ');
  const lints = [];
  for (const [key, home] of Object.entries(ROLE_HOME_SPREADS)) {
    const role = roles[key];
    if (!role || !role.value) continue;
    const tokens = roleTokens(role.value);
    if (!tokens.length || roleTokenHit(allText, tokens)) continue;
    lints.push({
      code: 'role_unused',
      message: `story role '${key}' is never used: ${role.directive}`,
      spreads: home,
      targetSpreads: home,
    });
  }
  return lints;
}

/**
 * food_role_misplaced (2026-07-29 QA review): the favorite food appearing
 * only in the opening or ending spreads is scenery/reward, not a world
 * object — "a plate of red berries appears in passing, then vanishes". The
 * review requires it MID-STORY. Gated on opts.storyRoles.worldObject.
 *
 * @param {object} manuscript
 * @param {{storyRoles?: object}} [opts]
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function foodRoleMisplacedLint(manuscript, opts = {}) {
  const role = opts.storyRoles?.worldObject;
  if (!role || !role.value) return [];
  const tokens = roleTokens(role.value);
  if (!tokens.length) return [];
  const spreads = sortedSpreads(manuscript);
  if (spreads.length < 8) return [];
  const hitSpreads = spreads
    .filter((s) => roleTokenHit(normalizeSentence(s.text || linesOf(s).join(' ')), tokens))
    .map((s) => s.spread);
  if (hitSpreads.length === 0) return []; // roleUnusedLint owns the fully-absent case
  const midStart = 4;
  const midEnd = spreads.length - 3; // 13 spreads → mid-story = 4-10
  if (hitSpreads.some((n) => n >= midStart && n <= midEnd)) return [];
  return [{
    code: 'food_role_misplaced',
    message: `the favorite food (${role.value}) appears only on spreads ${hitSpreads.join(', ')} — as scenery/reward, not a world object. ${role.directive}`,
    spreads: hitSpreads,
    targetSpreads: [5],
  }];
}

/**
 * opening_beat_loves (2026-07-29 QA review rule 1, the fuzzy half): the
 * opening spreads should show what the child loves — beyond the name
 * (opening_beat_name, HARD), at least one role/interest token should
 * surface in spreads 1-2. SOFT: an interest phrased as world imagery won't
 * string-match, and that must never hard-bounce a book.
 *
 * @param {object} manuscript
 * @param {{storyRoles?: object, interests?: string[]}} [opts]
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function openingBeatLovesLint(manuscript, opts = {}) {
  const roles = opts.storyRoles;
  const interests = Array.isArray(opts.interests) ? opts.interests : [];
  const sources = [
    roles?.tool?.value, roles?.turningPoint?.value, roles?.worldObject?.value, ...interests,
  ].filter(Boolean);
  if (!sources.length) return [];
  const tokens = [...new Set(sources.flatMap((v) => roleTokens(v)))];
  if (!tokens.length) return [];
  const opening = sortedSpreads(manuscript).slice(0, 2);
  if (!opening.length) return [];
  const text = opening.map((s) => normalizeSentence(s.text || linesOf(s).join(' '))).join(' ');
  if (roleTokenHit(text, tokens)) return [];
  return [{
    code: 'opening_beat_loves',
    message: 'the opening spreads never show what the child loves — the first spread should introduce the child in her own world, doing or surrounded by her favorite things (the loves, the funny thing), so the parent gets the "that\'s my kid" moment in the first page-turn',
    spreads: opening.map((s) => s.spread),
    targetSpreads: [opening[0].spread],
  }];
}

/**
 * onomatopoeia_overuse (2026-08-02 customer feedback: "the onomatopoeias
 * everywhere are not good"): the per-spread gate already kills reduplicated
 * sound words; this book-level lint enforces the BUDGET — at most ONE
 * sound-word moment (of any kind: reduplication, pair, "Whoosh!", "BOOM")
 * in the whole book. More than one total sound-word event across the book
 * (even if all on a single spread) → lint.
 *
 * @param {object} manuscript
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function onomatopoeiaOveruseLint(manuscript) {
  const hits = [];
  for (const s of sortedSpreads(manuscript)) {
    const events = findOnomatopoeiaEvents(s.text || linesOf(s).join(' '));
    if (events.length) hits.push({ spread: s.spread, events });
  }
  const total = hits.reduce((acc, h) => acc + h.events.length, 0);
  if (total <= 1) return [];
  const listed = hits.map((h) => `spread ${h.spread}: ${h.events.map((e) => `"${e.match}"`).join(', ')}`).join('; ');
  return [{
    code: 'onomatopoeia_overuse',
    message: `${total} sound-word moments across the book (${listed}) — keep at most ONE, at the single most pivotal beat, and write every other sound as a real action sentence ("Maya tapped twice on the little door"), never as an effect`,
    spreads: hits.map((h) => h.spread),
    targetSpreads: hits.map((h) => h.spread).slice(1),
  }];
}

/**
 * tense_drift (2026-08-02 customer feedback: "the story should be in the
 * past tense"): a book whose resolved narrative tense is 'past' but whose
 * spreads mostly carry NO past-tense marker (irregular past form or -ed
 * token) is being narrated in present tense. Threshold, not per-spread:
 * a genuinely past-tense book has was/were/said/-ed on nearly every
 * spread, while dialogue-heavy spreads legitimately lack them — so we
 * flag only when fewer than 60% of spreads show past evidence. SOFT on
 * purpose (deterministic present-tense detection is not reliable enough
 * to hard-gate); feeds the revision/polish notes.
 *
 * @param {object} manuscript
 * @param {{ageProfile?: object}} [opts]
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function tenseDriftLint(manuscript, opts = {}) {
  if (narrativeTenseFor(opts.ageProfile) !== 'past') return [];
  const spreads = sortedSpreads(manuscript);
  if (spreads.length < 4) return [];
  const noPast = spreads.filter((s) => !textHasPastTenseMarker(s.text || linesOf(s).join(' ')));
  if (spreads.length - noPast.length >= Math.ceil(spreads.length * 0.6)) return [];
  return [{
    code: 'tense_drift',
    message: `this book must be narrated in PAST TENSE (classic storybook voice — "Maya raced", never "Maya races") but ${noPast.length} of ${spreads.length} spreads show no past-tense narration; rewrite the narration into past tense on every spread, leaving only quoted dialogue in its natural spoken tense`,
    spreads: noPast.map((s) => s.spread),
    targetSpreads: noPast.map((s) => s.spread).slice(0, 3),
  }];
}

/**
 * book_word_total (2026-08-06 picture-book length standard) — the summed
 * manuscript word count sits outside the band's whole-book window
 * (`narrativeConstraints.totalBookWords`). The per-spread `word_budget`
 * HARD gate bounds each spread; this lint polices the SUM — a book whose
 * spreads all ride the per-spread floor (or ceiling) can still miss
 * picture-book length. The declared window is clamped into what the
 * per-spread window makes arithmetically reachable so the lint can never
 * demand the impossible (the embedded-layout clamp narrows both). Soft by
 * design: it feeds targeted revision notes, never blocks.
 *
 * @param {object} manuscript
 * @param {{ageProfile?: object}} [opts]
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function bookWordTotalLint(manuscript, opts = {}) {
  const nc = opts.ageProfile?.narrativeConstraints;
  const tb = nc?.totalBookWords;
  if (!tb) return []; // old checkpoint-pinned profiles predate the field
  const spreads = sortedSpreads(manuscript);
  if (!spreads.length) return [];
  const counts = spreads.map((s) => ({
    spread: s.spread,
    words: countWords(s.text || linesOf(s).join(' ')),
  }));
  const total = counts.reduce((sum, c) => sum + c.words, 0);
  const wps = nc.wordsPerSpread;
  let { min, max } = tb;
  if (wps) {
    max = Math.min(max, wps.max * spreads.length);
    min = Math.min(min, max);
  }
  if (total >= min && total <= max) return [];
  const over = total > max;
  const ranked = [...counts].sort((a, b) => (over ? b.words - a.words : a.words - b.words));
  return [{
    code: 'book_word_total',
    message: `the whole manuscript totals ${total} words; this band's picture-book budget is ${min}-${max} words (target ~${tb.target}) — ${over ? 'trim the wordiest spreads' : 'grow the thinnest spreads'} toward the book target without leaving the per-spread window`,
    spreads: counts.map((c) => c.spread),
    targetSpreads: ranked.slice(0, 3).map((c) => c.spread),
  }];
}

/**
 * Run every book-level lint. Never throws — a lint bug must not gate a book.
 *
 * @param {object} manuscript
 * @param {{ageProfile?: object, protagonistName?: string}} [opts] - band
 *   profile + child name for the vocabulary-aware lints
 * @returns {Array<{code: string, message: string, spreads: number[], targetSpreads: number[]}>}
 */
function runBookLints(manuscript, opts = {}) {
  const all = [];
  for (const lint of [
    duplicateClimaxLint, unintroducedPropLint, wordOveruseLint,
    unintroducedRefrainObjectLint, monotonePageTurnLint, repetitiveOpenerLint, refrainNeverEvolvesLint,
    wearableGearLint, verblessSentenceLint, staccatoStyleLint, conceptOverloadLint,
    onomatopoeiaOveruseLint,
  ]) {
    try {
      all.push(...lint(manuscript));
    } catch (err) {
      console.warn(`[v3] book lint ${lint.name} threw (skipping): ${err.message}`);
    }
  }
  for (const lint of [
    wordLengthLint, sentenceLengthLint, nameScarcityLint,
    roleUnusedLint, foodRoleMisplacedLint, openingBeatLovesLint, tenseDriftLint,
    bookWordTotalLint,
  ]) {
    try {
      all.push(...lint(manuscript, opts));
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
  wordLengthLint,
  wearableGearLint,
  verblessSentenceLint,
  staccatoStyleLint,
  sentenceLengthLint,
  conceptOverloadLint,
  nameScarcityLint,
  roleUnusedLint,
  foodRoleMisplacedLint,
  openingBeatLovesLint,
  tenseDriftLint,
  onomatopoeiaOveruseLint,
  bookWordTotalLint,
  normalizeSentence,
};
