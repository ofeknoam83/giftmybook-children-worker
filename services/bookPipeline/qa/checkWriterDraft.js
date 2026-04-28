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
const { findCrossSpreadRepeatedLines } = require('./refrainLineAudit');

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

function wordsRhyme(a, b) {
  if (!a || !b) return false;
  const na = normalizeRhymeWord(a);
  const nb = normalizeRhymeWord(b);
  if (!na || !nb || na === nb) return false;
  const ra = rhymeTail(a);
  const rb = rhymeTail(b);
  if (!ra.tail || !rb.tail) return false;
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
 - AABB rhyme scheme: the last word of line 1 must end-rhyme with the last word of line 2; the last word of line 3 must end-rhyme with the last word of line 4. Flag any spread where a couplet doesn't really rhyme (e.g. "sing/plan", "sigh/Deana", "sniff/off", "high/cuddle") by adding the "rhyme_fail" tag. Flag same-word "rhymes" the same way.
 - Consistent musical pulse within each couplet (roughly matched line length and stress count).
 - Short lines (6–12 words; never over 14).
 - No wallpaper refrains: the same full line must not appear verbatim (or near-verbatim) on 3+ spreads; one intentional callback is fine, not every spread.

Return ONLY strict JSON. Be specific and actionable — when a rhyme fails, name the offending word pair in the spread's issues list. Mark "pass": true only if the book is genuinely strong AND (for picture books) all AABB rhymes hold.`;

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
/**
 * @param {object} doc
 * @returns {Map<number, { issues: string[], tags: string[] }>}
 */
function refrainDuplicationBySpread(doc) {
  const aug = new Map();
  const violations = findCrossSpreadRepeatedLines(doc.spreads);
  for (const v of violations) {
    const msg = `Refrain wallpaper: same line repeats across spreads ${v.spreadNumbers.join(', ')} — rewrite so at most one spread echoes it as a callback; vary other occurrences.`;
    for (const sn of v.spreadNumbers) {
      if (!aug.has(sn)) aug.set(sn, { issues: [], tags: [] });
      aug.get(sn).issues.push(msg);
      aug.get(sn).tags.push('refrain_spam');
    }
  }
  return aug;
}

async function checkWriterDraft(doc) {
  const deterministic = doc.spreads.map(s => ({
    spreadNumber: s.spreadNumber,
    ...deterministicCheck(s, doc),
  }));

  const refrainAug = refrainDuplicationBySpread(doc);

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
  const bookLevel = Array.isArray(literary.bookLevelIssues) ? literary.bookLevelIssues : [];

  const merged = doc.spreads.map(s => {
    const det = deterministic.find(d => d.spreadNumber === s.spreadNumber) || { pass: true, issues: [], tags: [] };
    const ref = refrainAug.get(s.spreadNumber) || { issues: [], tags: [] };
    const lit = perSpreadLit.find(l => Number(l?.spreadNumber) === s.spreadNumber) || {};
    const issues = [
      ...det.issues,
      ...ref.issues,
      ...(Array.isArray(lit.issues) ? lit.issues.map(String) : []),
    ];
    const tags = [
      ...det.tags,
      ...ref.tags,
      ...(Array.isArray(lit.tags) ? lit.tags.map(String) : []),
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
  const pass = literary.pass === true && repairPlan.length === 0;

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
    repairPlan,
    updatedDoc,
  };
}

module.exports = { checkWriterDraft };
