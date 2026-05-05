/**
 * Writer-side QA for the full manuscript.
 *
 * Runs two signal layers:
 *   1. Deterministic checks (side mismatch, length, basic readability,
 *      personalization coverage, preachiness markers).
 *   2. A model-assisted literary review that returns a per-spread verdict
 *      and concrete rewrite directives.
 *
 * Returns `{ pass, perSpread, bookLevel, repairPlan }`.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS, FORMATS, WORDS_PER_LINE_TARGET, TEXT_LINE_TARGET, AGE_BANDS } = require('../constants');
const { appendLlmCall } = require('../schema/bookDocument');
const { renderThemeDirectiveBlock } = require('../planner/themeDirectives');
const { isCommonEnglishWord } = require('./wordDictionary');

const PREACH_MARKERS = [
  /\b(always remember|never forget|the lesson is|the moral is|you should always|we all must)\b/i,
];

const MAX_WORDS_PER_LINE_FALLBACK = 14;
// Default picture-book line target when age-band has no entry in TEXT_LINE_TARGET.
// Picture-book toddler/preschool bands lock at 4 lines (AABB couplets); the
// infant band (PB_INFANT, 0-1) requires only 2 lines (a single AA couplet).
// Use resolvePictureBookLineRange(ageBand) — never read this constant directly.
const PICTURE_BOOK_LINES_FALLBACK = { min: 4, max: 4 };

function resolvePictureBookLineRange(ageBand) {
  const target = TEXT_LINE_TARGET[ageBand];
  if (target && Number.isFinite(target.min) && Number.isFinite(target.max)) {
    return { min: target.min, max: target.max };
  }
  return PICTURE_BOOK_LINES_FALLBACK;
}

/**
 * Resolve the hard per-line word cap for a given age band. Picture-book
 * toddler band (0-3) is tight: we fail at `hardMax` so the writer can't
 * ship 15-word run-ons for pre-readers.
 */
function resolveHardMaxWordsPerLine(ageBand) {
  const budget = WORDS_PER_LINE_TARGET[ageBand];
  return budget && Number.isFinite(budget.hardMax) ? budget.hardMax : MAX_WORDS_PER_LINE_FALLBACK;
}

function splitLines(text) {
  return String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
}

function wordCount(s) {
  return (String(s || '').match(/\S+/g) || []).length;
}

/**
 * Extract the last alphabetical "rhyme word" of a line, lowercased. Strips
 * trailing punctuation, quotes, and non-letter characters. Returns '' if no
 * usable word can be extracted.
 */
function lastRhymeWord(line) {
  const match = String(line || '')
    .toLowerCase()
    .match(/([a-z']+)[^a-z']*$/i);
  return match ? match[1].replace(/'+$/, '') : '';
}

/**
 * Heuristic end-rhyme check. We don't run IPA — we compare the "rhyme tail"
 * (last vowel-run + everything after it) of each word. Rules:
 *   1. Normalize: strip trailing silent "e" (tune → tun, wide → wid).
 *   2. If tails equal, it's a rhyme (wid/sid → "id"/"id").
 *   3. Otherwise if the final consonant cluster matches AND the final
 *      vowel-spelling groups into the same broad English vowel family
 *      (e.g. "u"≈"oo", "i"≈"y", "ee"≈"ea"), it's a near-rhyme.
 *   4. Same-word "rhymes" are rejected.
 *
 * The check is deliberately conservative on false accepts — catches
 * obvious non-rhymes like "sing/plan" or "sigh/Deana" while accepting
 * real pairs like "tune/moon", "door/floor", "high/sky".
 */
const VOWEL_EQUIV = [
  new Set(['oo', 'u', 'ue', 'ui', 'ou']),
  new Set(['ee', 'ea', 'e', 'ie', 'y', 'ey']),
  new Set(['i', 'y', 'igh', 'ie']),
  new Set(['ai', 'ay', 'a', 'ei', 'ey']),
  new Set(['o', 'oa', 'ow', 'oe']),
  new Set(['ou', 'ow', 'au']),
];

function normalizeRhymeWord(word) {
  let w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  // Drop a trailing silent 'e' unless the word is too short to survive it.
  if (w.length > 3 && w.endsWith('e') && !/[aeiouy]e$/.test(w.slice(-2))) {
    w = w.slice(0, -1);
  }
  // Drop silent trailing "gh" after a vowel (high, sigh, light, night, bright).
  w = w.replace(/([aeiouy])gh([^aeiouy]*)$/, '$1$2');
  return w;
}

/** Canonicalize end-consonants so /s/ and /z/, /f/ and /v/, /p/ and /b/ etc. collapse. */
function canonicalCoda(coda) {
  return String(coda || '')
    .replace(/z/g, 's')
    .replace(/v/g, 'f')
    .replace(/b/g, 'p')
    .replace(/d/g, 't')
    .replace(/g/g, 'k');
}

function rhymeTail(word) {
  const w = normalizeRhymeWord(word);
  if (!w) return { tail: '', vowel: '', coda: '' };
  const m = w.match(/([aeiouy]+)([^aeiouy]*)$/);
  if (!m) return { tail: w, vowel: '', coda: w };
  return { tail: m[1] + m[2], vowel: m[1], coda: m[2] };
}

function vowelsEquivalent(va, vb) {
  if (va === vb) return true;
  for (const set of VOWEL_EQUIV) {
    if (set.has(va) && set.has(vb)) return true;
  }
  return false;
}

/**
 * A small set of grammatical-suffix-only matches that share an ending but
 * don't actually rhyme. "running/jumping" is the canonical fail — both end
 * in -ing but the stressed syllable is different (RUN-ning / JUMP-ing).
 * We catch the most common -ing/-ed/-ly/-ness/-ous/-tion/-er/-est family so
 * the AABB check in checkWriterDraft does not silently accept these.
 *
 * Returns true if a and b both end in the SAME suffix and the part before
 * the suffix differs (i.e. the rhyme is carried only by the suffix).
 */
const SUFFIX_ONLY_PATTERNS = [
  /(ing|ed|ly|ness|ous|tion|sion|er|est|able|ible|ment|ful|less|ish)$/,
];

function sharesOnlyAGrammaticalSuffix(a, b) {
  for (const rx of SUFFIX_ONLY_PATTERNS) {
    const ma = a.match(rx);
    const mb = b.match(rx);
    if (!ma || !mb || ma[0] !== mb[0]) continue;
    const stemA = a.slice(0, -ma[0].length);
    const stemB = b.slice(0, -mb[0].length);
    if (!stemA || !stemB) continue;
    // If the part before the shared suffix doesn't itself rhyme on its own
    // tail (vowel + coda), the "rhyme" is being carried purely by the
    // grammatical suffix — reject.
    const stemA_tail = rhymeTail(stemA);
    const stemB_tail = rhymeTail(stemB);
    if (!stemA_tail.vowel || !stemB_tail.vowel) return true;
    if (stemA_tail.tail === stemB_tail.tail) return false;
    if (vowelsEquivalent(stemA_tail.vowel, stemB_tail.vowel)
      && canonicalCoda(stemA_tail.coda) === canonicalCoda(stemB_tail.coda)) return false;
    return true;
  }
  return false;
}

/**
 * Stem-rhyme rejection: "town/hometown", "light/spotlight", "day/today".
 * One word entirely contains the other (after trimming a small set of
 * compound prefixes/suffixes), so the rhyme is identity-by-substring — a
 * child reads them as the same word, not as a real couplet pair.
 */
function isStemRhyme(a, b) {
  if (!a || !b || a === b) return false;
  if (a.length < 3 || b.length < 3) return false;
  if (a.endsWith(b) || b.endsWith(a)) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  return false;
}

function wordsRhyme(a, b) {
  if (!a || !b) return false;
  const na = normalizeRhymeWord(a);
  const nb = normalizeRhymeWord(b);
  if (!na || !nb || na === nb) return false;
  // Reject "town/hometown" — one word fully contains the other. A child reads
  // these as the same end-sound, not as a real rhyming pair.
  if (isStemRhyme(na, nb)) return false;
  const ra = rhymeTail(a);
  const rb = rhymeTail(b);
  if (!ra.tail || !rb.tail) return false;
  // Reject suffix-only matches ("running/jumping", "sadly/badly" where the
  // rhyme is carried only by the -ing or -ly).
  if (sharesOnlyAGrammaticalSuffix(na, nb)) return false;
  if (ra.tail === rb.tail) return true;
  if (ra.coda === rb.coda && vowelsEquivalent(ra.vowel, rb.vowel)) return true;
  // Near-rhyme: same vowel class AND voicing-equivalent end consonants
  // (trees/breeze, leaf/believe, bat/bad).
  if (
    vowelsEquivalent(ra.vowel, rb.vowel)
    && canonicalCoda(ra.coda) === canonicalCoda(rb.coda)
  ) return true;
  return false;
}

/**
 * B.2 — Detect dropped articles in prepositional phrases ("down street",
 * "by feet"). The writer was emitting toddler-broken English to force
 * rhymes; this catches the most common shape: PREPOSITION + bare singular
 * countable noun at the end of a line, with no article in between.
 *
 * Returns the offending phrase(s) found in the line, or [] if clean.
 */
const DROPPED_ARTICLE_PREPS = ['down', 'by', 'on', 'in', 'at', 'near', 'past', 'over', 'under', 'up', 'across', 'through', 'beside', 'beyond'];
const DROPPED_ARTICLE_NOUNS = new Set([
  'street', 'road', 'path', 'hill', 'foot', 'feet', 'hand', 'hands', 'river',
  'fence', 'gate', 'door', 'window', 'wall', 'floor', 'roof', 'tree', 'bench',
  'house', 'shop', 'store', 'park', 'lake', 'pond', 'beach', 'shore', 'bridge',
  'porch', 'kitchen', 'garden', 'meadow', 'field', 'yard', 'sky', 'cloud',
  'moon', 'sun', 'cup', 'plate', 'bed', 'chair', 'table', 'stair', 'stairs',
]);
// Articles, possessives, demonstratives, numerals, quantifiers, common
// proper-noun starts — anything that legitimately precedes the noun.
const PRECEDING_DETERMINERS = new Set([
  'a', 'an', 'the', 'my', 'your', 'his', 'her', 'their', 'our', 'its',
  'this', 'that', 'these', 'those', 'one', 'two', 'three', 'four', 'five',
  'some', 'any', 'each', 'every', 'no', 'both', 'all',
]);

function findDroppedArticles(text) {
  const offenders = [];
  const lines = splitLines(text);
  for (const line of lines) {
    // Tokenize into bare lowercase word sequences per phrase; we look at
    // every preposition followed directly by a bare singular noun.
    const tokens = String(line).toLowerCase().match(/[a-z']+/g) || [];
    for (let i = 0; i < tokens.length - 1; i++) {
      const prep = tokens[i];
      const next = tokens[i + 1];
      if (!DROPPED_ARTICLE_PREPS.includes(prep)) continue;
      if (!DROPPED_ARTICLE_NOUNS.has(next)) continue;
      // If a determiner immediately precedes the preposition, it's still
      // fine ("down THE street"). But by definition the next token IS the
      // noun, so there is no determiner between prep and noun — fail.
      offenders.push(`${prep} ${next}`);
    }
  }
  return offenders;
}

/**
 * B.3 — Detect address-form + proper-name concatenation ("Mama Courtney",
 * "Daddy John"). Address terms are direct-address words a child uses for a
 * parent; proper names are the parent's first name. They should never be
 * jammed together as if it were a title-and-name (we never write
 * "Mr. Mama Courtney"). The bug appeared 4x in Scarlett's Mother's Day book.
 *
 * Returns the offending phrases.
 */
const PARENT_ADDRESS_TERMS = [
  'mama', 'mom', 'mommy', 'mother', 'mum', 'mummy',
  'dada', 'dad', 'daddy', 'father', 'papa', 'pop', 'pops',
  'grandma', 'granny', 'nana', 'nan',
  'grandpa', 'grandad', 'grampa', 'pappap', 'pappy', 'pop-pop',
];
const ADDRESS_NAME_CONCAT_RX = new RegExp(
  `\\b(${PARENT_ADDRESS_TERMS.join('|')})\\s+([A-Z][a-z]+)\\b`,
  'gi',
);

function findAddressNameConcat(text, brief) {
  const offenders = [];
  // Build the set of known proper names from the brief so we don't false-
  // positive on phrases like "Mama Bear" (a character) where Bear isn't a
  // declared parent name. We only fail when the matched proper name is one
  // of the brief's declared parent first names.
  const knownNames = collectParentProperNames(brief);
  if (knownNames.size === 0) return offenders;
  const lines = splitLines(text);
  for (const line of lines) {
    let m;
    ADDRESS_NAME_CONCAT_RX.lastIndex = 0;
    while ((m = ADDRESS_NAME_CONCAT_RX.exec(line)) !== null) {
      const properName = m[2];
      if (knownNames.has(properName.toLowerCase())) {
        offenders.push(m[0]);
      }
    }
  }
  return offenders;
}

function collectParentProperNames(brief) {
  const names = new Set();
  if (!brief) return names;
  const sources = [
    brief?.customDetails?.mom_name, brief?.customDetails?.moms_name, brief?.customDetails?.mother_name,
    brief?.customDetails?.dad_name, brief?.customDetails?.dads_name, brief?.customDetails?.father_name,
    brief?.customDetails?.grandma_name, brief?.customDetails?.grandpa_name,
    brief?.child?.anecdotes?.mom_name, brief?.child?.anecdotes?.dad_name,
    brief?.child?.anecdotes?.moms_name, brief?.child?.anecdotes?.dads_name,
  ];
  for (const v of sources) {
    if (typeof v !== 'string') continue;
    // A questionnaire field may contain a single name, a list, or a free
    // sentence — take any capitalized word as a candidate.
    const matches = v.match(/[A-Z][a-z]+/g) || [];
    for (const name of matches) names.add(name.toLowerCase());
  }
  return names;
}

/**
 * B.4 — Verb-crutch detection. If one content verb appears in >25% of
 * spreads, flag it. Excludes a small allowlist of high-frequency verbs that
 * are basically free in narration (is/was/has/goes/sees/looks/says/etc.).
 *
 * @param {Array} spreads doc.spreads
 * @returns {Array<{ verb: string, count: number, spreadCount: number, ratio: number }>}
 */
const VERB_CRUTCH_THRESHOLD = 0.25;
const VERB_CRUTCH_ALLOWLIST = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'has', 'have', 'had',
  'do', 'does', 'did', 'done',
  'go', 'goes', 'going', 'went', 'gone',
  'see', 'sees', 'saw', 'seen',
  'look', 'looks', 'looking', 'looked',
  'say', 'says', 'said', 'saying',
  'come', 'comes', 'came', 'coming',
  'get', 'gets', 'got',
  'make', 'makes', 'made',
  'feel', 'feels', 'felt',
  'know', 'knows', 'knew',
  // Articles/prepositions/etc. shouldn't surface as verbs anyway, but
  // include the most ambiguous to keep the crutch detector quiet.
]);
const VERB_LEMMA_RULES = [
  // very small lemmatizer: only collapse the most common inflections so
  // squeals/squealed/squealing all count toward "squeal".
  [/(.+)ies$/, '$1y'],
  [/(.+)ied$/, '$1y'],
  [/(.+)ying$/, '$1y'],
  [/(.+[^aeiou])s$/, '$1'],
  [/(.+)ed$/, '$1'],
  [/(.+)ing$/, '$1'],
];
function lemmatizeVerb(word) {
  let w = word.toLowerCase();
  for (const [rx, repl] of VERB_LEMMA_RULES) {
    if (rx.test(w)) {
      const candidate = w.replace(rx, repl);
      // Only collapse if the result is still a plausible word.
      if (candidate.length >= 3) {
        w = candidate;
        break;
      }
    }
  }
  return w;
}

function findVerbCrutches(spreads) {
  // We don't run a real POS tagger — we look for any non-allowlisted
  // word ending in -s/-ed/-ing/-y as a candidate "content verb". This is
  // a heuristic; the allowlist filters the most common false positives.
  const perVerb = new Map(); // lemma -> { count, spreadSet:Set }
  let spreadCount = 0;
  for (const s of spreads) {
    const text = s?.manuscript?.text;
    if (!text) continue;
    spreadCount++;
    const seenInSpread = new Set();
    const tokens = String(text).toLowerCase().match(/[a-z']+/g) || [];
    for (const tok of tokens) {
      if (tok.length < 4) continue;
      // Only candidates that look like inflected verbs: ends in s, ed, ing.
      if (!/(s|ed|ing)$/.test(tok)) continue;
      if (VERB_CRUTCH_ALLOWLIST.has(tok)) continue;
      const lemma = lemmatizeVerb(tok);
      if (VERB_CRUTCH_ALLOWLIST.has(lemma)) continue;
      if (lemma.length < 3) continue;
      seenInSpread.add(lemma);
    }
    for (const lemma of seenInSpread) {
      if (!perVerb.has(lemma)) perVerb.set(lemma, { count: 0, spreadSet: new Set() });
      const entry = perVerb.get(lemma);
      entry.count += 1;
      entry.spreadSet.add(s.spreadNumber);
    }
  }
  if (spreadCount === 0) return [];
  const offenders = [];
  for (const [lemma, { count, spreadSet }] of perVerb.entries()) {
    const ratio = spreadSet.size / spreadCount;
    if (ratio > VERB_CRUTCH_THRESHOLD && spreadSet.size >= 3) {
      offenders.push({
        verb: lemma,
        count,
        spreadCount: spreadSet.size,
        spreadNumbers: Array.from(spreadSet).sort((a, b) => a - b),
        ratio,
      });
    }
  }
  // Sort by spread coverage descending so the worst offender shows first.
  offenders.sort((a, b) => b.spreadCount - a.spreadCount);
  return offenders;
}

/**
 * B.5 — Personalization saturation. Build a list of substantive
 * personalization items from brief.child + brief.customDetails, then
 * keyword-match each against the full manuscript. Fail when fewer than
 * 60% of substantive items appear at least once.
 *
 * Returns { ratio, threshold, missing[], landed[], total }.
 */
const PERSONALIZATION_SATURATION_THRESHOLD = 0.6;
// Free-text questionnaire fields where one answer is one item.
const PERSONALIZATION_TEXT_KEYS = [
  'funny_thing', 'meaningful_moment', 'moms_favorite_moment', 'dads_favorite_moment',
  'favorite_food', 'favorite_toys', 'anything_else', 'other_detail',
  'nickname', 'nicknames', 'special_routine', 'comfort_object',
];
// Address-term fields — each is one item ("calls_mom: Mama" is one item).
const PERSONALIZATION_ADDRESS_KEYS = ['calls_mom', 'calls_dad'];
// Tokens that are too generic to count as "used" (a, the, of, etc.).
const PERSONALIZATION_STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'to', 'in', 'on', 'at', 'is', 'it', 'for',
  'with', 'her', 'his', 'my', 'our', 'their', 'i', 'me', 'we', 'you', 'be',
  'as', 'by', 'or', 'so', 'do', 'does', 'did', 'has', 'have', 'had',
  'this', 'that', 'these', 'those', 'one', 'two', 'three', 'all',
]);

function extractPersonalizationItems(brief) {
  const items = []; // { label, keywords:Set<string> }
  const child = brief?.child || {};
  const customDetails = brief?.customDetails || {};
  const anecdotes = (child.anecdotes && typeof child.anecdotes === 'object') ? child.anecdotes : {};

  // Each interest is its own item.
  if (Array.isArray(child.interests)) {
    for (const interest of child.interests) {
      const text = String(interest || '').trim();
      if (text) items.push(makePersonalizationItem(`interest: ${text}`, text));
    }
  }

  // Each anecdote / questionnaire text field is its own item.
  for (const k of PERSONALIZATION_TEXT_KEYS) {
    const fromAnec = typeof anecdotes[k] === 'string' ? anecdotes[k].trim() : '';
    const fromCustom = typeof customDetails[k] === 'string' ? customDetails[k].trim() : '';
    const text = fromAnec || fromCustom;
    if (text) items.push(makePersonalizationItem(`questionnaire ${k}: ${text}`, text));
  }

  // Address-form items: the address word itself ought to surface in the book.
  for (const k of PERSONALIZATION_ADDRESS_KEYS) {
    const fromAnec = typeof anecdotes[k] === 'string' ? anecdotes[k].trim() : '';
    const fromCustom = typeof customDetails[k] === 'string' ? customDetails[k].trim() : '';
    const text = fromAnec || fromCustom;
    if (text) items.push(makePersonalizationItem(`address ${k}: ${text}`, text));
  }

  // Free-text custom details that aren't one of the structured keys above.
  for (const [k, v] of Object.entries(customDetails)) {
    if (PERSONALIZATION_TEXT_KEYS.includes(k) || PERSONALIZATION_ADDRESS_KEYS.includes(k)) continue;
    if (typeof v !== 'string') continue;
    const text = v.trim();
    if (text && text.length >= 2) items.push(makePersonalizationItem(`custom ${k}: ${text}`, text));
  }

  return items;
}

function makePersonalizationItem(label, sourceText) {
  // Reduce to a small set of "signal" tokens — lowercased content words
  // longer than 2 chars, excluding stopwords. Match if ANY signal token
  // appears in the manuscript (substring match on word boundaries).
  const tokens = String(sourceText).toLowerCase().match(/[a-z']+/g) || [];
  const signal = new Set();
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (PERSONALIZATION_STOPWORDS.has(t)) continue;
    signal.add(t);
  }
  return { label, keywords: signal };
}

function checkPersonalizationSaturation(brief, spreads) {
  const items = extractPersonalizationItems(brief);
  if (items.length === 0) {
    return { ratio: 1, threshold: PERSONALIZATION_SATURATION_THRESHOLD, missing: [], landed: [], total: 0 };
  }
  const fullText = spreads
    .map(s => s?.manuscript?.text || '')
    .join('\n')
    .toLowerCase();
  const corpusTokens = new Set(fullText.match(/[a-z']+/g) || []);
  const landed = [];
  const missing = [];
  for (const item of items) {
    if (item.keywords.size === 0) {
      // No usable signal tokens — don't count it against saturation.
      continue;
    }
    let hit = false;
    for (const k of item.keywords) {
      if (corpusTokens.has(k)) { hit = true; break; }
    }
    if (hit) landed.push(item.label);
    else missing.push(item.label);
  }
  const total = landed.length + missing.length;
  const ratio = total === 0 ? 1 : landed.length / total;
  return { ratio, threshold: PERSONALIZATION_SATURATION_THRESHOLD, missing, landed, total };
}

/**
 * D.2 — infant_action_verb_in_text. The planner already strips locomotion
 * verbs from infant spread specs, but the writer occasionally smuggles them
 * back in ("Up jumps Everleigh", "feet flash past", "laughs jump with each
 * bound"). Lap babies physically can't do these things, so the verse breaks
 * age-fit for the parent reading aloud.
 *
 * Scans the rendered text for forbidden infant action verbs and returns the
 * surface forms found. Empty array when none are present or when the age
 * band isn't PB_INFANT.
 *
 * @param {string} text rendered manuscript text for one spread
 * @param {string} ageBand doc.request.ageBand
 * @returns {string[]} matched surface verb forms (e.g. ["jumps", "twirl"])
 */
const INFANT_FORBIDDEN_VERB_PATTERNS = [
  // Each entry is a regex matching all common inflections of the verb.
  // Word-boundary anchored so we don't false-positive on substrings.
  /\bjump(?:s|ed|ing)?\b/i,
  /\brun(?:s|ning)?\b/i,
  /\brace(?:s|d|ing)?\b/i,
  /\bspin(?:s|ning)?\b/i,
  /\btwirl(?:s|ed|ing)?\b/i,
  /\bhop(?:s|ped|ping)?\b/i,
  /\bwalk(?:s|ed|ing)?\b/i,
  /\bclimb(?:s|ed|ing)?\b/i,
  /\bleap(?:s|ed|t|ing)?\b/i,
  /\bdance(?:s|d|ing)?\b/i,
  /\bchase(?:s|d|ing)?\b/i,
  /\bgrab(?:s|bed|bing)?\b/i,
  /\bskip(?:s|ped|ping)?\b/i,
  /\bgallop(?:s|ed|ing)?\b/i,
  /\bstomp(?:s|ed|ing)?\b/i,
  /\bmarch(?:es|ed|ing)?\b/i,
  /\bcrawl(?:s|ed|ing)?\b/i,
  /\bcartwheel(?:s|ed|ing)?\b/i,
  /\btumble(?:s|d|ing)?\b/i,
  // PR G additions — these escaped earlier rounds because they're not
  // textbook "locomotion" verbs, but they paint a walking/standing picture
  // the illustrator faithfully renders, then age QA correctly rejects.
  // Real failing example from prod: "Her brave steps bounce with thrill"
  // — Gemini drew a walking toddler, then `age_action_impossible` fired
  // on every retry. Catching these at the writer stage prevents the loop.
  //   - step(s/ped/ping): unambiguous locomotion when subject is the child
  //   - stand(s/ing/stood): independent standing is not an infant capability
  //   - bounce(s/d/ing): "baby bounces" implies independent posture; if a
  //     parent is bouncing the baby, the rewriter will pick a different verb
  //     (jiggle/rock/sway) that doesn't carry the standing implication
  /\bstep(?:s|ped|ping)?\b/i,
  /\bstand(?:s|ing)?\b/i,
  /\bstood\b/i,
  /\bbounc(?:e|es|ed|ing)\b/i,
  // "feet flash" / "feet pound" — displaced action attributing locomotion to
  // body parts. We catch by the body part + motion verb construction.
  // PR G: extend the body-part pattern with the same new verbs.
  /\bfeet\s+(?:flash|pound|fly|race|run|skip|hop|march|stomp|tap|step|bounce|stand)\w*\b/i,
];

function findInfantForbiddenActionVerbs(text, ageBand) {
  if (ageBand !== AGE_BANDS.PB_INFANT) return [];
  const t = String(text || '');
  const hits = [];
  const seen = new Set();
  for (const rx of INFANT_FORBIDDEN_VERB_PATTERNS) {
    const m = t.match(rx);
    if (m) {
      const surface = m[0].toLowerCase();
      if (!seen.has(surface)) {
        seen.add(surface);
        hits.push(surface);
      }
    }
  }
  return hits;
}

/**
 * D.3 — nonsense_word. Detect invented rhyme-fill non-words like "farf"
 * (a fake rhyme for "scarf"). Walks each token in the text and asks the
 * common-English dictionary whether it's a real word. Skips:
 *   - capitalized tokens that aren't sentence-initial (proper nouns)
 *   - tokens shorter than 4 chars (small functional words rarely fail)
 *   - hyphenated compounds where each half is real ("sun-warmed")
 *
 * Returns matched surface forms.
 *
 * @param {string} text
 * @param {object} [brief] used to whitelist declared names
 * @returns {string[]}
 */
function findNonsenseWords(text, brief) {
  const t = String(text || '');
  if (!t) return [];
  const declaredNames = collectDeclaredProperNames(brief);
  const hits = [];
  const seen = new Set();
  // Token regex captures alphabetic runs (with optional inner apostrophe and
  // hyphen) so "sun-warmed" and "don't" stay as single tokens.
  const tokenRx = /[A-Za-z][A-Za-z'\u2019\-]*/g;
  // Track positions so we can identify sentence-initial tokens.
  // A token is sentence-initial if the preceding non-space char is one of
  // .?!”" or it's the first non-space char in the text.
  let match;
  while ((match = tokenRx.exec(t)) !== null) {
    const surface = match[0];
    const lower = surface.toLowerCase();
    if (declaredNames.has(lower)) continue;
    // Skip capitalized tokens unless they're sentence-initial — we treat
    // unrecognized proper nouns as names rather than nonsense.
    const isCapitalized = /^[A-Z]/.test(surface);
    if (isCapitalized) {
      const start = match.index;
      let i = start - 1;
      while (i >= 0 && /\s/.test(t[i])) i--;
      const isSentenceInitial = i < 0 || /[.?!”"]/.test(t[i]);
      if (!isSentenceInitial) continue;
    }
    // Hyphenated compounds: accept if every part is recognized.
    if (lower.includes('-')) {
      const parts = lower.split('-').filter(Boolean);
      const allReal = parts.every(p => isCommonEnglishWord(p, { minLength: 3 }));
      if (allReal) continue;
    }
    if (isCommonEnglishWord(surface, { minLength: 4 })) continue;
    if (!seen.has(lower)) {
      seen.add(lower);
      hits.push(surface);
    }
  }
  return hits;
}

function collectDeclaredProperNames(brief) {
  const names = new Set();
  if (!brief || typeof brief !== 'object') return names;
  const child = brief.child || {};
  const customDetails = brief.customDetails || {};
  const anecdotes = (child.anecdotes && typeof child.anecdotes === 'object') ? child.anecdotes : {};
  const candidates = [
    child.name, child.firstName, child.first_name, child.nickname,
    customDetails.child_name, customDetails.childs_name,
    customDetails.mom_name, customDetails.moms_name, customDetails.mother_name,
    customDetails.dad_name, customDetails.dads_name, customDetails.father_name,
    customDetails.grandma_name, customDetails.grandpa_name,
    customDetails.pet_name, customDetails.pets_name,
    anecdotes.mom_name, anecdotes.dad_name,
    anecdotes.calls_mom, anecdotes.calls_dad,
  ];
  for (const v of candidates) {
    if (typeof v !== 'string') continue;
    const matches = v.match(/[A-Za-z][a-z']+/g) || [];
    for (const name of matches) names.add(name.toLowerCase());
  }
  // Also accept anything from interests — may include a place / pet name.
  if (Array.isArray(child.interests)) {
    for (const interest of child.interests) {
      const matches = String(interest || '').match(/[A-Z][a-z']+/g) || [];
      for (const name of matches) names.add(name.toLowerCase());
    }
  }
  return names;
}

/**
 * D.4 — nonsense_simile. Catches similes whose comparand makes no sense in
 * a baby/preschool book context. Two surface patterns:
 *   - "as <X> as <Y>"
 *   - "like (a|an|the)? <Y>"
 * Y is rejected when it's in a curated list of comparands that are
 * abstract, technical, or unrecognizable to a small child ("code", "math",
 * "app", "data", "meme", "crypto", "server"...). The list intentionally
 * skews toward modern-tech nouns since those are the most common
 * AI-hallucinated children's-book similes.
 *
 * Returns matched simile fragments (e.g. ["as light as code"]).
 *
 * @param {string} text
 * @returns {string[]}
 */
const NONSENSE_SIMILE_COMPARANDS = new Set([
  // Tech / abstractions a baby cannot parse.
  'code', 'math', 'data', 'app', 'apps', 'algorithm', 'algorithms',
  'meme', 'memes', 'crypto', 'bitcoin', 'server', 'servers', 'cloud',
  'wifi', 'broadband', 'spreadsheet', 'spreadsheets', 'database',
  'pixel', 'pixels', 'firmware', 'software', 'hardware', 'gigabyte',
  'megabyte', 'kilobyte', 'protocol', 'protocols', 'api', 'apis',
  'compiler', 'syntax', 'binary', 'integer', 'integers', 'variable',
  'metadata', 'analytics', 'kpi', 'kpis',
  // Adult / concept domains that don't translate to a child's frame.
  'mortgage', 'mortgages', 'taxes', 'invoice', 'invoices', 'receipt',
  'audit', 'audits', 'budget', 'budgets', 'paperwork', 'meeting',
  'meetings', 'deadline', 'deadlines', 'inflation', 'recession',
  'derivative', 'derivatives',
  // Ambiguously-sized things that don't resolve to a sensory comparison.
  'logic', 'theory', 'concept', 'principle',
]);

function findNonsenseSimiles(text) {
  const t = String(text || '');
  if (!t) return [];
  const hits = [];
  const seen = new Set();
  // Form 1: "as X as Y" — the canonical book simile ("as light as code").
  const asAsRx = /\bas\s+[a-z]+\s+as\s+(?:a\s+|an\s+|the\s+)?([a-z]+)\b/gi;
  // Form 2: "<adj> as Y" — the dropped-leading-as variant baby books often
  // use ("a blanket soft as math", "warm as toast"). We require an adjective
  // immediately before "as" so we don't false-positive on "see her as Mama".
  // We can't POS-tag, so we approximate: any word ending in -y/-er/-ly/-ed
  // OR one of a small adjective allow-list, followed by "as Y".
  const adjAsRx = /\b([a-z]+(?:y|er|ly|ed|ft|rm|ld|ee|ow|ll|st)|tiny|small|big|huge|tall|short|fast|slow|warm|cool|cold|hot|wet|dry|new|old|sad|wee|kind|bold|wild|wise|brave|sweet|fierce|loud|quiet|bright|deep|wide|high|low|light|dark|soft|hard|rough|smooth|safe|free|true|sure|pure|clear|cute|nice)\s+as\s+(?:a\s+|an\s+|the\s+)?([a-z]+)\b/gi;
  // Form 3: "like (a|an|the)? Y" — standalone like-simile.
  const likeRx = /\blike\s+(?:a\s+|an\s+|the\s+)?([a-z]+)\b/gi;

  let m;
  for (const [rx, captureIdx] of [[asAsRx, 1], [adjAsRx, 2], [likeRx, 1]]) {
    rx.lastIndex = 0;
    while ((m = rx.exec(t)) !== null) {
      const candidate = m[captureIdx].toLowerCase();
      if (!NONSENSE_SIMILE_COMPARANDS.has(candidate)) continue;
      const surface = m[0];
      const key = surface.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(surface);
    }
  }
  return hits;
}

/**
 * D.5 — parent_theme_relationship_framing. For Mother's/Father's/Grandparents'
 * Day books, the writer must NOT cast the child and parent as peers. Phrases
 * like "best friends", "best buds", "buddies" misframe the relationship and
 * undercut the gift's intent (a child celebrating their parent).
 *
 * Returns matched surface phrases. Empty when not a parent theme.
 *
 * @param {string} text
 * @param {string} theme
 * @returns {string[]}
 */
const PARENT_THEMES = new Set(['mothers_day', 'fathers_day', 'grandparents_day']);
const PEER_FRAMING_PATTERNS = [
  /\bbest\s+friends?\b/i,
  /\bbest\s+buds?\b/i,
  /\bbest\s+mates?\b/i,
  /\bbest\s+pals?\b/i,
  /\bbuddies\b/i,
  /\bbestie(?:s)?\b/i,
  /\bBFF(?:s)?\b/i,
];

function findParentThemePeerFraming(text, theme) {
  if (!PARENT_THEMES.has(String(theme || ''))) return [];
  const t = String(text || '');
  const hits = [];
  const seen = new Set();
  for (const rx of PEER_FRAMING_PATTERNS) {
    const m = t.match(rx);
    if (m) {
      const surface = m[0];
      const key = surface.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        hits.push(surface);
      }
    }
  }
  return hits;
}

/**
 * D.6 — refrain_crutch. The verb-crutch detector at line ~347 looks for
 * inflected verb forms only (-s/-ed/-ing). It misses non-verb refrains:
 * "peekaboo" appears in 5/13 Everleigh spreads (38%) and never trips because
 * it's a noun. This detector counts ANY content word ≥4 chars that doesn't
 * end in a verb inflection AND isn't already covered by VERB_CRUTCH_ALLOWLIST,
 * flagging when it appears in >25% of spreads.
 *
 * @param {Array} spreads doc.spreads
 * @returns {Array<{ word: string, count: number, spreadCount: number, ratio: number }>}
 */
const REFRAIN_CRUTCH_THRESHOLD = 0.25;
// Infant board books are shorter (~12 spreads) and rely on more repetition by
// design; the same 25% threshold lets too many crutches squeak through. Use a
// tighter bar so 3 of 12 = 25% (which currently does NOT fail) starts to fail.
const REFRAIN_CRUTCH_THRESHOLD_INFANT = 0.20;
const REFRAIN_STOPWORDS = new Set([
  // High-frequency function/closed-class words that can legitimately repeat
  // without being a refrain crutch. The verb crutch list is for verbs; this
  // list focuses on non-verb closed-class items.
  'with', 'from', 'into', 'onto', 'upon', 'over', 'under', 'down',
  'than', 'then', 'this', 'that', 'these', 'those', 'there',
  'here', 'when', 'while', 'where', 'will', 'would', 'could', 'should',
  'they', 'them', 'their', 'theirs', 'your', 'yours', 'mine',
  'just', 'very', 'much', 'such', 'each', 'some', 'most', 'more',
  'what', 'which', 'whose', 'whom', 'about',
  // The child's address forms appear EVERYWHERE in books ("Mama", "Mommy")
  // by design — personalization saturation, not a crutch. Excluded here.
  'mama', 'mommy', 'momma', 'mom', 'mum', 'mummy', 'mama',
  'dada', 'daddy', 'dad', 'papa', 'pop', 'pops',
  'nana', 'gigi', 'mimi', 'grandma', 'grandpa',
]);

function findRefrainCrutches(spreads, options = {}) {
  const perWord = new Map(); // word -> { count, spreadSet:Set }
  let spreadCount = 0;
  // Build extra exclusions: child name + parent address forms from the brief.
  // The personalization saturation check explicitly WANTS these to repeat;
  // flagging them as refrain crutches is a false positive (e.g. "everleigh"
  // appearing in 7 of 13 spreads is correct, not a bug).
  const extraExclusions = new Set();
  const brief = options.brief;
  if (brief) {
    const childName = brief?.child?.name;
    if (childName) extraExclusions.add(String(childName).toLowerCase());
    const cd = brief?.customDetails || {};
    for (const key of ['mom_name', 'dad_name', 'parent_name', 'grandparent_name', 'mother_name', 'father_name']) {
      const v = cd[key];
      if (v) extraExclusions.add(String(v).toLowerCase());
    }
  }
  const ageBand = options.ageBand;
  const threshold = ageBand === AGE_BANDS.PB_INFANT
    ? REFRAIN_CRUTCH_THRESHOLD_INFANT
    : REFRAIN_CRUTCH_THRESHOLD;
  for (const s of spreads) {
    const text = s?.manuscript?.text;
    if (!text) continue;
    spreadCount++;
    const seenInSpread = new Set();
    const tokens = String(text).toLowerCase().match(/[a-z']+/g) || [];
    for (const tok of tokens) {
      if (tok.length < 4) continue;
      // Skip verb-inflected tokens — the verb crutch detector owns those.
      if (/(s|ed|ing)$/.test(tok)) continue;
      if (REFRAIN_STOPWORDS.has(tok)) continue;
      if (VERB_CRUTCH_ALLOWLIST.has(tok)) continue;
      if (extraExclusions.has(tok)) continue;
      seenInSpread.add(tok);
    }
    for (const word of seenInSpread) {
      if (!perWord.has(word)) perWord.set(word, { count: 0, spreadSet: new Set() });
      const entry = perWord.get(word);
      entry.count += 1;
      entry.spreadSet.add(s.spreadNumber);
    }
  }
  if (spreadCount === 0) return [];
  const offenders = [];
  for (const [word, { count, spreadSet }] of perWord.entries()) {
    const ratio = spreadSet.size / spreadCount;
    if (ratio > threshold && spreadSet.size >= 3) {
      offenders.push({
        word,
        count,
        spreadCount: spreadSet.size,
        spreadNumbers: Array.from(spreadSet).sort((a, b) => a - b),
        ratio,
      });
    }
  }
  offenders.sort((a, b) => b.spreadCount - a.spreadCount);
  return offenders;
}

function deterministicCheck(spread, doc) {
  const issues = [];
  const tags = [];
  const m = spread.manuscript;
  const spec = spread.spec;
  if (!m || !m.text) {
    return { pass: false, issues: ['manuscript missing'], tags: ['missing_text'] };
  }

  if (spec && m.side !== spec.textSide) {
    issues.push(`side mismatch: spec=${spec.textSide} manuscript=${m.side}`);
    tags.push('side_mismatch');
  }

  const lines = splitLines(m.text);
  const isPictureBook = doc?.request?.format === FORMATS.PICTURE_BOOK;
  const ageBand = doc?.request?.ageBand;

  if (isPictureBook) {
    // Line-count gate is age-band aware. Infant books (PB_INFANT, 0-1) get
    // 2 lines (one AA couplet) per board-book brevity rules; toddler and
    // preschool bands stay at 4 lines (AABB). Without this, the writer was
    // shipping 4-line spreads even for infant books, blowing past the
    // planner's 2-line target and breaking the read-aloud cadence.
    const lineRange = resolvePictureBookLineRange(ageBand);
    const expectedDescription = lineRange.min === lineRange.max
      ? `exactly ${lineRange.min} lines`
      : `between ${lineRange.min} and ${lineRange.max} lines`;
    if (lines.length < lineRange.min || lines.length > lineRange.max) {
      issues.push(`picture-book spreads must have ${expectedDescription} for age band ${ageBand || 'default'}; got ${lines.length}`);
      tags.push('wrong_line_count');
    }
    if (lines.length >= 2) {
      // Always check the first couplet (AA). For 4-line books we also check
      // the second couplet (BB). Infant 2-line books only need AA to hold.
      const w1 = lastRhymeWord(lines[0]);
      const w2 = lastRhymeWord(lines[1]);
      if (!wordsRhyme(w1, w2)) {
        issues.push(`lines 1 and 2 do not rhyme (AA required): "${w1}" / "${w2}"`);
        tags.push('rhyme_fail');
      }
    }
    if (lines.length >= 4) {
      const w3 = lastRhymeWord(lines[2]);
      const w4 = lastRhymeWord(lines[3]);
      if (!wordsRhyme(w3, w4)) {
        issues.push(`lines 3 and 4 do not rhyme (AABB required): "${w3}" / "${w4}"`);
        tags.push('rhyme_fail');
      }
    }
  } else if (lines.length > 5) {
    issues.push(`too many lines: ${lines.length}`);
    tags.push('too_many_lines');
  }

  const hardMax = resolveHardMaxWordsPerLine(doc?.request?.ageBand);
  const overLong = lines.filter(l => wordCount(l) > hardMax);
  if (overLong.length) {
    const ageNote = doc?.request?.ageBand === AGE_BANDS.PB_TODDLER
      ? ' (ages 0-3 require very short lines — sing-song board-book cadence)'
      : '';
    issues.push(`lines too long (>${hardMax} words${ageNote}): ${overLong.length}`);
    tags.push('line_too_long');
  }

  const preachy = PREACH_MARKERS.some(rx => rx.test(m.text));
  if (preachy) {
    issues.push('preachy phrasing detected');
    tags.push('preachy');
  }

  // B.2 — dropped articles in prepositional phrases.
  const dropped = findDroppedArticles(m.text);
  if (dropped.length) {
    issues.push(`dropped article(s) in prepositional phrase: ${dropped.join(', ')} — write "down THE street", not "down street"`);
    tags.push('dropped_article');
  }

  // B.3 — "Mama Courtney" / "Daddy John" address-form + proper-name concat.
  const concat = findAddressNameConcat(m.text, doc?.brief);
  if (concat.length) {
    issues.push(`address term concatenated with proper name: ${concat.join(', ')} — write the name OR the address word, not both jammed together`);
    tags.push('address_name_concat');
  }

  // D.2 — forbidden infant action verbs (jumps/runs/twirl/etc. for
  // PB_INFANT). Lap babies cannot do these things — break age-fit.
  const forbiddenInfantVerbs = findInfantForbiddenActionVerbs(m.text, ageBand);
  if (forbiddenInfantVerbs.length) {
    issues.push(`infant book uses forbidden action verb(s): ${forbiddenInfantVerbs.join(', ')} — lap babies don't jump, run, race, twirl, walk, climb, dance, step, stand, or bounce. Use sit/lie/look/reach/giggle/coo/hold/snuggle.`);
    tags.push('infant_action_verb_in_text');
  }

  // D.3 — nonsense / invented words. Ban writer fabrications used as rhyme
  // fillers ("farf" to rhyme "scarf"). Real English only.
  const nonsenseWords = findNonsenseWords(m.text, doc?.brief);
  if (nonsenseWords.length) {
    issues.push(`invented non-English word(s): ${nonsenseWords.join(', ')} — use real English. If a rhyme requires a fake word, pick a different rhyme.`);
    tags.push('nonsense_word');
  }

  // D.4 — nonsense similes ("light as code", "like an algorithm"). Tech /
  // abstract comparands that a small child cannot parse.
  const nonsenseSimiles = findNonsenseSimiles(m.text);
  if (nonsenseSimiles.length) {
    issues.push(`nonsense simile(s) for a baby/preschool book: ${nonsenseSimiles.join('; ')} — use concrete sensory comparisons (soft as fluff, warm as toast).`);
    tags.push('nonsense_simile');
  }

  // D.5 — parent-theme peer framing. "Best friends" misframes the relationship
  // for Mother's / Father's / Grandparents' Day.
  const peerFraming = findParentThemePeerFraming(m.text, doc?.request?.theme);
  if (peerFraming.length) {
    issues.push(`parent-theme relationship framing error: ${peerFraming.join(', ')} — the child and parent are not peers. Use "my Mama", "my hero", "the one who loves me" instead of peer/buddy language.`);
    tags.push('parent_theme_relationship_framing');
  }

  return { pass: issues.length === 0, issues, tags };
}

const LITERARY_QA_SYSTEM = `You are a senior children's book editor.
You review an existing manuscript for:
 - story coherence and payoff
 - read-aloud musicality
 - age fit for the given band
 - personalization that feels real, not tacked on
 - absence of preachy moralizing
 - rhyme quality where rhyme applies

For picture-book manuscripts specifically, enforce:
 - LINE COUNT depends on age band:
     * Infant band (PB_INFANT, age 0-1): EXACTLY 2 lines per spread (one AA couplet) — board-book brevity.
     * Toddler / Preschool bands (PB_TODDLER 0-3, PB_PRESCHOOL 3-6): EXACTLY 4 lines per spread (two AABB couplets).
     * Lines separated by "\\n".
 - Rhyme scheme: AA for 2-line; AABB for 4-line. Same-word rhymes, identity rhymes, stem rhymes, and suffix-only rhymes are NOT real rhymes — fail them.
 - Consistent musical pulse within each couplet (roughly matched line length and stress count).
 - Short lines: infant 2-4 words/line (hardMax 5); toddler 3-7 words/line (hardMax 8); preschool 6-12 words/line (hardMax 14).

Explicit failure modes — each must be tagged exactly as listed:
 - "rhyme_fail": couplet does not really rhyme ("sing/plan", "sigh/Deana", "sniff/off", "high/cuddle"). ALSO use this tag for IDENTITY rhymes ("town/town", "squeals/squeals"), STEM rhymes where one word contains the other ("town/hometown", "light/spotlight", "day/today"), and SUFFIX-ONLY rhymes where the match is carried only by a shared grammatical ending ("running/jumping", "sadly/badly", "quickly/slowly"). Identity, stem, and suffix-only rhymes are NOT real rhymes — fail them.
 - "dropped_article": a preposition is followed directly by a bare singular countable noun with no determiner ("down street", "by feet", "on bench"). Real English requires "down THE street", "by HER feet". This is broken phrasing, never acceptable as a stylistic choice in a children's book.
 - "address_name_concat": a parental address term is jammed against a parent's proper first name ("Mama Courtney", "Daddy John", "Mommy Sarah"). Use the address word OR the name, never both back-to-back.
 - "verb_crutch": one content verb dominates the manuscript — it appears as the action in more than ~25% of spreads (e.g. "squeal" in 8 of 13 spreads). Flag at the BOOK level in bookLevelIssues, naming the overused verb.
 - "low_personalization_saturation": the brief contains substantive personalization items (interests, anecdotes, address forms, custom details) but fewer than ~60% of them appear anywhere in the manuscript. Flag at the BOOK level in bookLevelIssues, naming the missing items.
 - "age_mismatch_action": the action attributed to the child is implausible for the declared age band (e.g. an infant "running down the street"). Flag the offending spread.
 - "infant_action_verb_in_text": for INFANT books (PB_INFANT, age 0-1) the manuscript text must NEVER use locomotion verbs the baby physically cannot do: jump/jumps/jumped, run/runs/running, race/races, spin/spins, twirl/twirls, hop/hops, walk/walks, climb/climbs, leap/leaps, dance/dances, chase/chases, grab/grabs, skip/skips, gallop, stomp, march, crawl, step/steps/stepped, stand/stands/standing/stood, bounce/bounces/bounced. Also reject body-part displacements ("feet flash", "feet pound", "feet step", "feet bounce"). Use sit/lie/look/reach/giggle/coo/hold/snuggle instead. Flag the offending spread.
 - "nonsense_word": the manuscript invents a fake word to force a rhyme ("farf" rhymed with "scarf", "blurp" rhymed with "burp"). Real English only. If the rhyme requires fabrication, pick a different rhyme — don't ship the made-up word. Flag the offending spread; name the invented word.
 - "nonsense_simile": a simile ("X as Y", "like Y") whose comparand makes no sense in a baby/preschool context — "light as code", "soft as math", "like an algorithm". Use concrete sensory comparisons ("soft as fluff", "warm as toast"). Flag the offending spread.
 - "parent_theme_relationship_framing": for Mother's Day / Father's Day / Grandparents' Day themes, the manuscript MUST NOT cast the child and parent as peers — ban "best friends", "best buds", "best mates", "buddies", "besties", "BFF". Frame the parent as the loving caregiver / hero / the one who tucks me in. Flag the offending spread.
 - "refrain_crutch": one non-verb content word (noun or onomatopoeia) dominates the manuscript — it appears in more than ~25% of spreads (e.g. "peekaboo" in 5 of 13 spreads, "scarf" on every page). Distinct from verb_crutch (which catches verbs). Flag at the BOOK level in bookLevelIssues, naming the overused word.

Return ONLY strict JSON. Be specific and actionable — when a rhyme fails, name the offending word pair in the spread's issues list and explain WHICH failure mode it is (identity / stem / suffix-only / non-rhyming). Mark "pass": true only if the book is genuinely strong AND (for picture books) all AABB rhymes hold AND none of the failure modes above are triggered.`;

function literaryQaUserPrompt(doc) {
  const spreads = doc.spreads.map(s => ({
    spreadNumber: s.spreadNumber,
    spec: s.spec,
    text: s.manuscript?.text,
    side: s.manuscript?.side,
  }));
  const themeBlock = renderThemeDirectiveBlock(doc.request.theme);
  return [
    `Format: ${doc.request.format}. Age band: ${doc.request.ageBand}. Theme: ${doc.request.theme}.`,
    themeBlock,
    themeBlock ? 'If the manuscript uses any BANNED CLICHÉS from the theme directive, tag those spreads with "theme_cliche" and fail.' : '',
    `Story bible:\n${JSON.stringify(doc.storyBible, null, 2)}`,
    `Spreads:\n${JSON.stringify(spreads, null, 2)}`,
    '',
    'Return JSON:',
    `{
  "pass": true|false,
  "bookLevelIssues": ["..."],
  "perSpread": [
    { "spreadNumber": 1, "issues": ["..."], "tags": ["..."], "suggestedRewrite": "optional short directive" }
  ]
}`,
  ].join('\n');
}

/**
 * @param {object} doc
 * @returns {Promise<{ pass: boolean, perSpread: object[], bookLevel: string[], repairPlan: object[], updatedDoc: object }>}
 */
async function checkWriterDraft(doc) {
  const deterministic = doc.spreads.map(s => ({
    spreadNumber: s.spreadNumber,
    ...deterministicCheck(s, doc),
  }));

  const result = await callText({
    model: MODELS.WRITER_QA,
    systemPrompt: LITERARY_QA_SYSTEM,
    userPrompt: literaryQaUserPrompt(doc),
    jsonMode: true,
    temperature: 0.3,
    maxTokens: 7000,
    label: 'writerQa',
    abortSignal: doc.operationalContext?.abortSignal,
  });

  const literary = result.json || {};
  const perSpreadLit = Array.isArray(literary.perSpread) ? literary.perSpread : [];
  const bookLevel = Array.isArray(literary.bookLevelIssues) ? literary.bookLevelIssues.map(String) : [];
  const bookLevelTags = [];

  // B.4 — verb-crutch (book-level).
  // Track per-spread injections so we can inject book-level failures into the
  // repair plan as targeted spread-level instructions — otherwise the rewrite
  // loop sees pass=false but no targets and silently exits without fixing.
  const bookLevelSpreadInjections = new Map(); // spreadNumber -> { issues:[], tags:[] }
  const addBookLevelInjection = (spreadNumber, issue, tag) => {
    if (!bookLevelSpreadInjections.has(spreadNumber)) {
      bookLevelSpreadInjections.set(spreadNumber, { issues: [], tags: [] });
    }
    const entry = bookLevelSpreadInjections.get(spreadNumber);
    entry.issues.push(issue);
    if (!entry.tags.includes(tag)) entry.tags.push(tag);
  };

  const crutches = findVerbCrutches(doc.spreads);
  let bookLevelDeterministicFail = false;
  if (crutches.length) {
    const top = crutches[0];
    bookLevel.push(
      `verb crutch: "${top.verb}" appears in ${top.spreadCount} of ${doc.spreads.length} spreads (${Math.round(top.ratio * 100)}%) — vary the action verbs across spreads`,
    );
    bookLevelTags.push('verb_crutch');
    bookLevelDeterministicFail = true;
    // Inject a per-spread directive so the rewrite loop has actionable targets.
    for (const sn of top.spreadNumbers || []) {
      addBookLevelInjection(
        sn,
        `verb_crutch: avoid the overused verb "${top.verb}" — it appears in ${top.spreadCount} of ${doc.spreads.length} spreads. Replace it on this spread with a different action verb (or recast the line so it isn't needed).`,
        'verb_crutch',
      );
    }
  }

  // D.6 — refrain crutch (book-level). Catches non-verb content words
  // repeated >25% of spreads (>20% for infant). Excludes child name and
  // declared parent address-form names from the brief.
  const refrains = findRefrainCrutches(doc.spreads, {
    brief: doc?.brief,
    ageBand: doc?.request?.ageBand,
  });
  if (refrains.length) {
    const top = refrains[0];
    bookLevel.push(
      `refrain crutch: "${top.word}" appears in ${top.spreadCount} of ${doc.spreads.length} spreads (${Math.round(top.ratio * 100)}%) — vary the recurring nouns/refrains across spreads`,
    );
    bookLevelTags.push('refrain_crutch');
    bookLevelDeterministicFail = true;
    for (const sn of top.spreadNumbers || []) {
      addBookLevelInjection(
        sn,
        `refrain_crutch: avoid the overused word "${top.word}" — it appears in ${top.spreadCount} of ${doc.spreads.length} spreads. Replace it on this spread with different imagery.`,
        'refrain_crutch',
      );
    }
  }

  // B.5 — personalization saturation (book-level).
  const saturation = checkPersonalizationSaturation(doc.brief, doc.spreads);
  if (saturation.total > 0 && saturation.ratio < saturation.threshold) {
    bookLevel.push(
      `low personalization saturation: only ${saturation.landed.length} of ${saturation.total} brief items (${Math.round(saturation.ratio * 100)}%) appear in the manuscript; missing: ${saturation.missing.slice(0, 8).join('; ')}`,
    );
    bookLevelTags.push('low_personalization_saturation');
    bookLevelDeterministicFail = true;
  }

  const merged = doc.spreads.map(s => {
    const det = deterministic.find(d => d.spreadNumber === s.spreadNumber) || { pass: true, issues: [], tags: [] };
    const lit = perSpreadLit.find(l => Number(l?.spreadNumber) === s.spreadNumber) || {};
    const injection = bookLevelSpreadInjections.get(s.spreadNumber) || { issues: [], tags: [] };
    const issues = [
      ...det.issues,
      ...(Array.isArray(lit.issues) ? lit.issues.map(String) : []),
      ...injection.issues,
    ];
    const tags = [
      ...det.tags,
      ...(Array.isArray(lit.tags) ? lit.tags.map(String) : []),
      ...injection.tags,
    ];
    return {
      spreadNumber: s.spreadNumber,
      pass: issues.length === 0,
      issues,
      tags,
      suggestedRewrite: lit.suggestedRewrite ? String(lit.suggestedRewrite) : null,
    };
  });

  const repairPlan = merged.filter(m => !m.pass);
  const pass = literary.pass === true && repairPlan.length === 0 && !bookLevelDeterministicFail;

  const updatedDoc = appendLlmCall(doc, {
    stage: 'writerQa',
    model: result.model,
    attempts: result.attempts,
    usage: result.usage,
  });

  return {
    pass,
    perSpread: merged,
    bookLevel,
    bookLevelTags,
    repairPlan,
    updatedDoc,
  };
}

module.exports = {
  checkWriterDraft,
  // exported for unit tests
  wordsRhyme,
  findDroppedArticles,
  findAddressNameConcat,
  findVerbCrutches,
  checkPersonalizationSaturation,
  extractPersonalizationItems,
  // PR D detectors
  findInfantForbiddenActionVerbs,
  findNonsenseWords,
  findNonsenseSimiles,
  findParentThemePeerFraming,
  findRefrainCrutches,
  resolvePictureBookLineRange,
};
