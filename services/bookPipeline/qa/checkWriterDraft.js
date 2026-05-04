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
const { MODELS, FORMATS, WORDS_PER_LINE_TARGET, AGE_BANDS } = require('../constants');
const { appendLlmCall } = require('../schema/bookDocument');
const { renderThemeDirectiveBlock } = require('../planner/themeDirectives');

const PREACH_MARKERS = [
  /\b(always remember|never forget|the lesson is|the moral is|you should always|we all must)\b/i,
];

const MAX_WORDS_PER_LINE_FALLBACK = 14;
const PICTURE_BOOK_LINES = 4;

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
      offenders.push({ verb: lemma, count, spreadCount: spreadSet.size, ratio });
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

  if (isPictureBook) {
    if (lines.length !== PICTURE_BOOK_LINES) {
      issues.push(`picture-book spreads must have exactly ${PICTURE_BOOK_LINES} lines; got ${lines.length}`);
      tags.push('wrong_line_count');
    }
    if (lines.length >= 4) {
      const w1 = lastRhymeWord(lines[0]);
      const w2 = lastRhymeWord(lines[1]);
      const w3 = lastRhymeWord(lines[2]);
      const w4 = lastRhymeWord(lines[3]);
      if (!wordsRhyme(w1, w2)) {
        issues.push(`lines 1 and 2 do not rhyme (AABB required): "${w1}" / "${w2}"`);
        tags.push('rhyme_fail');
      }
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
 - EXACTLY 4 lines per spread (separated by "\\n").
 - AABB rhyme scheme: the last word of line 1 must end-rhyme with the last word of line 2; the last word of line 3 must end-rhyme with the last word of line 4.
 - Consistent musical pulse within each couplet (roughly matched line length and stress count).
 - Short lines (6–12 words; never over 14).

Explicit failure modes — each must be tagged exactly as listed:
 - "rhyme_fail": couplet does not really rhyme ("sing/plan", "sigh/Deana", "sniff/off", "high/cuddle"). ALSO use this tag for IDENTITY rhymes ("town/town", "squeals/squeals"), STEM rhymes where one word contains the other ("town/hometown", "light/spotlight", "day/today"), and SUFFIX-ONLY rhymes where the match is carried only by a shared grammatical ending ("running/jumping", "sadly/badly", "quickly/slowly"). Identity, stem, and suffix-only rhymes are NOT real rhymes — fail them.
 - "dropped_article": a preposition is followed directly by a bare singular countable noun with no determiner ("down street", "by feet", "on bench"). Real English requires "down THE street", "by HER feet". This is broken phrasing, never acceptable as a stylistic choice in a children's book.
 - "address_name_concat": a parental address term is jammed against a parent's proper first name ("Mama Courtney", "Daddy John", "Mommy Sarah"). Use the address word OR the name, never both back-to-back.
 - "verb_crutch": one content verb dominates the manuscript — it appears as the action in more than ~25% of spreads (e.g. "squeal" in 8 of 13 spreads). Flag at the BOOK level in bookLevelIssues, naming the overused verb.
 - "low_personalization_saturation": the brief contains substantive personalization items (interests, anecdotes, address forms, custom details) but fewer than ~60% of them appear anywhere in the manuscript. Flag at the BOOK level in bookLevelIssues, naming the missing items.
 - "age_mismatch_action": the action attributed to the child is implausible for the declared age band (e.g. an infant "running down the street"). Flag the offending spread.

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
  const crutches = findVerbCrutches(doc.spreads);
  let bookLevelDeterministicFail = false;
  if (crutches.length) {
    const top = crutches[0];
    bookLevel.push(
      `verb crutch: "${top.verb}" appears in ${top.spreadCount} of ${doc.spreads.length} spreads (${Math.round(top.ratio * 100)}%) — vary the action verbs across spreads`,
    );
    bookLevelTags.push('verb_crutch');
    bookLevelDeterministicFail = true;
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
    const issues = [...det.issues, ...(Array.isArray(lit.issues) ? lit.issues.map(String) : [])];
    const tags = [...det.tags, ...(Array.isArray(lit.tags) ? lit.tags.map(String) : [])];
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
};
