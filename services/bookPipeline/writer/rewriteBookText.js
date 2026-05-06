/**
 * Writer rewrite loop.
 *
 * Runs writer QA, and if it fails, rewrites only the affected spreads.
 * Repeats up to REPAIR_BUDGETS.writerRewriteWaves waves. Each wave records
 * a structured retry-memory entry so the next attempt must materially
 * differ. If the loop exhausts the budget, callers see the last manuscript
 * plus the issues on `doc.writerQa`.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS, REPAIR_BUDGETS, TOTAL_SPREADS, TEXT_LINE_TARGET, AGE_BANDS, FAILURE_CODES, getWriterTemperature } = require('../constants');
const { updateSpread, appendLlmCall, appendRetryMemory, withStageResult } = require('../schema/bookDocument');
const { renderTextPolicyBlock } = require('./textPolicies');
const { buildRetryEntry } = require('../retryMemory');
const { checkWriterDraft } = require('../qa/checkWriterDraft');
const { renderStoryArcContext } = require('./draftBookText');

/**
 * AA-CW-17 Part A — failure forensics persistence.
 *
 * When the writer hard gate fires (infant residual or AA-CW-12 fatal),
 * the in-memory `doc.trace.llmCalls` and `doc.writerRewriteMemory` die
 * with the function. Cloud Run logs only retain the truncated failure
 * summary line — they do NOT contain wave-N manuscript text. That makes
 * post-mortem text analysis impossible without re-running the book.
 *
 * This helper writes a structured forensics dump to GCS so the next
 * failure is fully debuggable: rewrite memory per spread, the final
 * spread text, the final per-spread/book-level QA result, and the
 * failure metadata. Errors are swallowed — forensics must never crash
 * the real error path.
 *
 * Path: children-jobs/<bookId>/writer-failure.json
 *
 * Test-friendly: the writer test suite stubs out GCS; we lazy-require
 * the GCS module here and only call it when bookId is set.
 *
 * @param {object} finalDoc
 * @param {{ reason: string, waves: number, residualTags: string[] }} meta
 * @returns {Promise<void>}
 */
async function persistWriterFailureForensics(finalDoc, meta) {
  try {
    const bookId = finalDoc?.operationalContext?.bookId || finalDoc?.request?.bookId;
    if (!bookId) return;
    if (finalDoc?.operationalContext?.persistFailureForensics === false) return;

    // Lazy require so unit tests that don't touch GCS aren't forced to
    // mock @google-cloud/storage.
    let saveJson;
    try {
      ({ saveJson } = require('../../gcsStorage'));
    } catch (err) {
      console.warn(`[writer-failure] gcsStorage not available, skipping forensics dump: ${err.message}`);
      return;
    }

    const finalSpreads = Array.isArray(finalDoc?.spreads)
      ? finalDoc.spreads.map(s => ({
          spreadNumber: s.spreadNumber,
          side: s.manuscript?.side || null,
          text: s.manuscript?.text || null,
          lineBreakHints: s.manuscript?.lineBreakHints || null,
          personalizationUsed: s.manuscript?.personalizationUsed || null,
          writerNotes: s.manuscript?.writerNotes || null,
        }))
      : [];

    const dump = {
      schemaVersion: 'aa-cw-17.v1',
      bookId,
      pipelineVersion: finalDoc?.request?.pipelineVersion || finalDoc?._pipelineVersion || null,
      ageBand: finalDoc?.request?.ageBand || null,
      format: finalDoc?.request?.format || null,
      capturedAt: new Date().toISOString(),
      failure: {
        reason: meta.reason,
        waves: meta.waves,
        residualTags: meta.residualTags || [],
      },
      writerQa: finalDoc?.writerQa || null,
      writerRewriteMemory: finalDoc?.writerRewriteMemory || {},
      writerRewriteRejectionCount: finalDoc?.writerRewriteRejectionCount || {},
      finalSpreads,
    };

    const path = `children-jobs/${bookId}/writer-failure.json`;
    await saveJson(dump, path);
    console.log(`[writer-failure] forensics dump saved: gs://.../${path}`);
  } catch (err) {
    // Forensics must never crash the actual error path. Log and move on.
    console.warn(`[writer-failure] failed to persist forensics dump: ${err.message}`);
  }
}

/**
 * After the rewrite loop exhausts, if the book is an infant book and any
 * spread still contains physically-impossible action verbs (twirl, skip,
 * spin, run, ...), the illustrator can never satisfy the text — drawing
 * the verb violates age_action_impossible, and drawing something else
 * violates action_mismatch. Either way ~5 minutes of GPU time is wasted
 * before the pipeline gives up at the illustrator stage. Fail fast at
 * the writer stage instead, with a tag that points the operator at the
 * real culprit.
 *
 * AA-CW-9: this used to call a per-line `gemini-2.5-flash` gate (~38
 * sequential calls, ~65s wall time per book) to redo what the gpt-5.4
 * judge had already evaluated. We now read the judge's authoritative
 * verdict on the doc and trust its `infant_action_verb_in_text` tag.
 * The judge prompt enumerates every banned verb root + body-part
 * displacement construction with concrete examples and lists the
 * offending verb(s) in the issue text.
 *
 * AA-CW-10: structural escape hatch. The judge sometimes raises this
 * tag but lists ONLY a body-part noun in the issue text (e.g. "feet")
 * with no actual verb. This is a prompt false positive — the rule is
 * about VERBS, not nouns. We filter those out before failing the
 * pipeline. The judge prompt was simultaneously tightened to require
 * a real verb in the issue text, but this filter is the belt to that
 * suspenders.
 *
 * @param {object} doc
 * @returns {{ spreadNumber: number, hits: string[] }[]}
 */
const INFANT_BANNED_VERB_ROOTS = [
  'jump', 'run', 'race', 'spin', 'twirl', 'hop', 'walk', 'climb', 'leap',
  'dance', 'chase', 'skip', 'gallop', 'stomp', 'march', 'crawl', 'step',
  'stand', 'stood', 'cartwheel', 'tumble', 'flash', 'pound', 'gallop',
];

function issueMentionsBannedVerb(issueText) {
  if (typeof issueText !== 'string') return false;
  const lc = issueText.toLowerCase();
  return INFANT_BANNED_VERB_ROOTS.some(root => {
    // word-boundary match for root + optional s/ed/ing/es
    const re = new RegExp(`\\b${root}(s|es|ed|ing)?\\b`, 'i');
    return re.test(lc);
  });
}

/**
 * AA-CW-12 — sibling residual collector for writer-side defects that the
 * illustrator can never resolve.
 *
 * Per-spread tags that qualify as "writer-fatal" — if they survive all
 * rewrite waves, shipping the manuscript guarantees the illustrator either
 * loops on action_mismatch (`unrenderable_action`, `writer_invented_prop`)
 * or ships a printed book where the same word ends both lines of a
 * couplet (`identity_rhyme`).
 *
 * AA-CW-13 — added per-spread `semantic_filler` and
 * `forced_rhyme_meaning_drift` (lines that exist only to land a rhyme
 * with no image, or that drag the rhyme into a wrong meaning), AND
 * book-level `verb_crutch` (one verb dominating >25% of spreads is a
 * structural defect the illustrator cannot redeem).
 *
 * Reads:
 *   - doc.writerQa.perSpread[*].tags  — per-spread tags
 *   - doc.writerQa.bookLevel          — book-level issue strings
 *
 * Returns offenders even when issue text is missing because the
 * wave-exhaustion semantic is "the judge said this and the writer
 * could not fix it."
 *
 * @param {object} doc
 * @returns {{ spreadNumber: number|null, tag: string, issue: string }[]}
 */
// AA-CW-20: WRITER_FATAL_TAGS split into UNCONDITIONAL (always fatal,
// every age band) and TASTE (fatal except at PB_INFANT, where the 2-5
// word line budget makes "every line earns a new sensory beat" a goal
// the same-model self-critique cannot reliably satisfy without forcing
// the writer into local optima it cannot escape). Production data on
// book e3f4e0c0 (AA-CW-19 deploy) showed the wave-4 rejection set
// reduced to exactly these taste tags after the structural defects
// (verb_crutch, refrain_crutch, dropped_article, identity_rhyme) were
// cleared. Demoting them at PB_INFANT lets the manuscript ship when
// every structural rule passes; PB_TODDLER and PB_PRESCHOOL keep the
// stricter bar because their longer line budgets give the writer room
// to satisfy semantic_filler / forced_rhyme_meaning_drift cleanly.
const WRITER_FATAL_TAGS_UNCONDITIONAL = [
  'identity_rhyme',
  'unrenderable_action',
  'writer_invented_prop',
];
const WRITER_FATAL_TAGS_TASTE = [
  'semantic_filler',
  'forced_rhyme_meaning_drift',
];
// Backwards-compatible export — the union of both lists, used by tests
// and any caller that wants the full historical fatal set.
const WRITER_FATAL_TAGS = [
  ...WRITER_FATAL_TAGS_UNCONDITIONAL,
  ...WRITER_FATAL_TAGS_TASTE,
];

// Book-level tags. spreadNumber is null on these offenders because the
// defect is a property of the manuscript as a whole, not a single spread.
const WRITER_FATAL_BOOK_LEVEL_TAGS = ['verb_crutch'];

function collectWriterFatalResiduals(doc) {
  const perSpread = doc?.writerQa?.perSpread || [];
  const bookLevel = Array.isArray(doc?.writerQa?.bookLevel) ? doc.writerQa.bookLevel : [];
  const ageBand = doc?.request?.ageBand || null;
  // AA-CW-20: PB_INFANT demotes taste tags from fatal to advisory.
  // ageBand is the VALUE (e.g. '0-1'), not the key — use AGE_BANDS.PB_INFANT
  // for the comparison.
  const fatalTagsForBand = ageBand === AGE_BANDS.PB_INFANT
    ? WRITER_FATAL_TAGS_UNCONDITIONAL
    : WRITER_FATAL_TAGS;
  const offenders = [];

  // Per-spread tags.
  for (const entry of perSpread) {
    const tags = Array.isArray(entry?.tags) ? entry.tags : [];
    const issues = Array.isArray(entry?.issues) ? entry.issues : [];
    for (const tag of fatalTagsForBand) {
      if (!tags.includes(tag)) continue;
      // Find the most-specific issue text for this tag, or fall back to
      // a generic descriptor so the operator still sees the spread number.
      const matching = issues.find(i => typeof i === 'string' && i.toLowerCase().includes(tag.replace(/_/g, ' ').toLowerCase()))
        || issues.find(i => typeof i === 'string' && i.toLowerCase().includes(tag.toLowerCase()))
        || `${tag} flagged on spread ${entry.spreadNumber} but no issue text recorded`;
      offenders.push({
        spreadNumber: entry.spreadNumber,
        tag,
        issue: matching,
      });
    }
  }

  // Book-level tags. These do not carry a spreadNumber. We match against
  // book-level issue strings (the judge prompt requires the tag word to
  // appear in the issue text, e.g. "verb_crutch: 'squeal' appears in 6
  // of 13 spreads…"). If no matching issue string is found but a
  // book-level tag was raised by the judge, we still raise the offender
  // — the wave-exhaustion contract is symmetric with the per-spread case.
  for (const tag of WRITER_FATAL_BOOK_LEVEL_TAGS) {
    const matching = bookLevel.find(i => typeof i === 'string' && i.toLowerCase().includes(tag.toLowerCase()));
    if (matching) {
      offenders.push({ spreadNumber: null, tag, issue: matching });
    }
  }

  return offenders;
}

function collectInfantActionResiduals(doc) {
  const ageBand = doc?.request?.ageBand;
  if (ageBand !== AGE_BANDS.PB_INFANT) return [];
  const perSpread = doc?.writerQa?.perSpread || [];
  const offenders = [];
  for (const entry of perSpread) {
    const tags = Array.isArray(entry?.tags) ? entry.tags : [];
    if (!tags.includes('infant_action_verb_in_text')) continue;
    const issues = Array.isArray(entry?.issues) ? entry.issues : [];
    const matchingIssues = issues
      .filter(i => typeof i === 'string' && /infant_action_verb_in_text/i.test(i));

    // AA-CW-10 escape hatch: if the judge tagged but no issue text names a
    // banned verb root, treat as a prompt false positive and skip. The
    // tightened judge prompt should make this rare; this filter prevents
    // "feet"/"legs"/"toes"-only flags from blocking the pipeline.
    const hasRealVerb = matchingIssues.some(issueMentionsBannedVerb);
    if (matchingIssues.length > 0 && !hasRealVerb) {
      console.warn(
        `[rewriteBookText] dropping infant_action_verb_in_text on spread ${entry.spreadNumber}: judge issue text "${matchingIssues.join(' | ')}" names no banned verb root`,
      );
      continue;
    }

    const hits = matchingIssues
      .map(i => i.replace(/^infant_action_verb_in_text:?\s*/i, '').trim())
      .filter(Boolean);
    offenders.push({
      spreadNumber: entry.spreadNumber,
      hits: hits.length > 0 ? hits : ['(see judge issue)'],
    });
  }
  return offenders;
}

class WriterUnresolvableError extends Error {
  constructor(message, { issues, tags } = {}) {
    super(message);
    this.name = 'WriterUnresolvableError';
    this.failureCode = FAILURE_CODES.WRITER_UNRESOLVABLE;
    this.issues = issues || [];
    this.tags = tags || [];
  }
}

const SYSTEM_PROMPT = `You are rewriting specific spreads of a children's book.
You keep the rest of the book intact. For each spread listed, produce an improved version that fixes the listed issues.
Hard rules (same as original writer):
- Honor the spread spec (side, personalization, beat).
- Read-aloud first. Musical, simple, low repetition, no big metaphors.
- Third-person by default. Funny/playful tone. Never preachy.
- Text must be plausible to render in a few lines on one side without crossing center.
- **HERO PRONOUNS — single source of truth.** The user prompt declares ONE pronoun set for the hero. Use ONLY those pronouns; never swap them across spreads. When a sentence is ambiguous, prefer the hero's name over a different pronoun.
- **Arc context.** When the spec carries \`arcContext.callbackToSpread\` or \`setsUpSpread\`, your rewrite should preserve or strengthen the bond between those spreads (a returning prop, a repeated phrase, a planted seed) so the rewrite doesn't sever the arc.
- **PROSE-PROP WHITELIST (AA-CW-16, hard rule).** Each spread spec carries \`proseProps\` — the EXHAUSTIVE list of concrete physical objects you may name in that spread's text. Any noun outside the whitelist guarantees an action_mismatch loop in the illustrator and will fail QA as \`writer_invented_prop\`. Every concrete physical noun the hero or parent INTERACTS WITH (object of a transitive verb, possessive target, prepositional anchor of a touch/lift/hold/pat/etc.) must be either (a) the child or parent themselves, (b) a body part, (c) the spread's location, or (d) an entry in \`proseProps\` (case-insensitive substring match). Background scenery you only mention is exempt unless the hero touches it. If you cannot complete a couplet using the whitelist, choose a different rhyme word — NEVER invent a prop to land a rhyme.

Picture-book structure (MANDATORY when format is picture_book):
- LINE COUNT: EXACTLY 4 lines per spread for ALL picture-book age bands (PB_INFANT 0-1, PB_TODDLER 0-3, PB_PRESCHOOL 3-6). Even the infant board-book band uses 4 lines; bands differ by per-line word budget, not by line count. NEVER emit 2-line spreads for picture books.
   * Lines separated by "\\n".
- RHYME SCHEME (band-conditional — see the per-age-band block above for the authoritative rule):
   * PB_TODDLER (0-3) and PB_PRESCHOOL (3-6): full AABB — lines 1+2 rhyme; lines 3+4 rhyme. Real end-rhymes or near-rhymes only — never same-word rhymes, never non-rhymes.
   * PB_INFANT (0-1) (AA-CW-18 — DEFAULT FREE-VERSE ON 3+4): Lines 1+2 MUST rhyme (real end-rhyme, no identity, no slant). Lines 3+4 DEFAULT to free-verse with parallel rhythm. STRONG REWRITER GUIDANCE: if a prior wave failed on lines 3+4 with identity_rhyme / rhyme_fail / forced_rhyme_meaning_drift / writer_invented_prop / unrenderable_action, the next wave MUST go free-verse on lines 3+4 — do not try a different rhyme. Do not introduce filler words like "dawning", "teal", "plushy", "gushy". Declare the free-verse choice in \`writerNotes\`.
- LINE LENGTH — match the per-age-band "LINE LENGTH" rule in the age/voice policy block above. Infants (0-1) are extra-tight (~2-5 words/line, hardMax 6) inside the 4-line shape. Ages 0-3 (PB_TODDLER) are VERY short (~3-7 words/line, sing-song board-book cadence); ages 3-6 (PB_PRESCHOOL) are short (~6-12 words/line). Consistent pulse across each couplet.
- NEVER invent fake words just to make a rhyme work. Real English only.
- NEVER use a simile ("X as Y", "like Y") where Y is implausible for a child to recognize ("light as code", "soft as math"). Use concrete sensory comparisons.

Return ONLY strict JSON: { "spreads": [ { "spreadNumber": N, "text": "LINE1\\nLINE2\\nLINE3\\nLINE4", "side": "left|right", "lineBreakHints": ["..."], "personalizationUsed": ["..."], "writerNotes": "optional" }, ... ] }. The "text" field is a single string with embedded "\\n" line breaks. Picture books always emit EXACTLY 4 lines per spread regardless of age band.`;

/**
 * AA-CW-15 — writer rewrite memory.
 *
 * Production logs (book e3f4e0c0) show the rewriter cycling through the same
 * 3-4 defects across waves: wave 1 fixes the verb, breaks the rhyme; wave 2
 * fixes the rhyme, brings back filler; wave 3 fixes filler, brings back the
 * verb. Without context of what it just tried, the writer rediscovers each
 * lossy local optimum.
 *
 * Memory shape on the doc:
 *   doc.writerRewriteMemory = {
 *     <spreadNumber>: [
 *       { wave: 1, rejectedText: '...', killingTags: [...], killingIssues: [...] },
 *       { wave: 2, rejectedText: '...', killingTags: [...], killingIssues: [...] },
 *     ],
 *   }
 *
 * Capped to the last 2 attempts per spread to keep prompt size bounded.
 */
const REWRITE_MEMORY_MAX_ATTEMPTS = 2;

/**
 * AA-CW-16 — escape-hatch threshold. After this many consecutive rejections
 * on the SAME spread, the next rewrite wave for that spread is allowed to
 * relax exactly one craft constraint (rhyme scheme, line count, or repeated
 * phrase). Mirrors the parent-skin / silhouette escape hatches in the
 * illustrator. Default sourced from REPAIR_BUDGETS so production can tune it.
 */
const { REPAIR_BUDGETS: _REPAIR_BUDGETS } = require('../constants');
const WRITER_ESCAPE_HATCH_AFTER_REJECTIONS =
  Number.isFinite(_REPAIR_BUDGETS?.writerEscapeHatchAfterRejections)
    ? _REPAIR_BUDGETS.writerEscapeHatchAfterRejections
    : 3;

function recordRewriteAttempt(doc, spreadNumber, attempt) {
  const prev = doc.writerRewriteMemory && doc.writerRewriteMemory[spreadNumber]
    ? doc.writerRewriteMemory[spreadNumber]
    : [];
  const next = [...prev, attempt].slice(-REWRITE_MEMORY_MAX_ATTEMPTS);
  // AA-CW-16: independent rejection counter that is NOT capped by the memory
  // window. The memory keeps only the last 2 attempts (prompt-size bound),
  // but the counter must keep growing so the escape hatch eventually unlocks.
  const prevCount =
    doc.writerRewriteRejectionCount && Number.isFinite(doc.writerRewriteRejectionCount[spreadNumber])
      ? doc.writerRewriteRejectionCount[spreadNumber]
      : 0;
  return {
    ...doc,
    writerRewriteMemory: {
      ...(doc.writerRewriteMemory || {}),
      [spreadNumber]: next,
    },
    writerRewriteRejectionCount: {
      ...(doc.writerRewriteRejectionCount || {}),
      [spreadNumber]: prevCount + 1,
    },
  };
}

/**
 * AA-CW-16 — has the escape hatch unlocked for this spread? True iff the
 * spread has been rejected at least `WRITER_ESCAPE_HATCH_AFTER_REJECTIONS`
 * times. Once unlocked, every subsequent wave for that spread sees the
 * relaxation block in the rewrite prompt.
 *
 * @param {object} doc
 * @param {number} spreadNumber
 * @returns {boolean}
 */
function isEscapeHatchUnlocked(doc, spreadNumber) {
  const count =
    doc?.writerRewriteRejectionCount && Number.isFinite(doc.writerRewriteRejectionCount[spreadNumber])
      ? doc.writerRewriteRejectionCount[spreadNumber]
      : 0;
  return count >= WRITER_ESCAPE_HATCH_AFTER_REJECTIONS;
}

/**
 * AA-CW-16 — render the per-spread escape-hatch block for the rewriter.
 * Surfaced ABOVE the JSON payload, alongside the AA-CW-15 rewrite-memory
 * block, so the rewriter sees both "what you tried" and "what you may now
 * relax" before it generates.
 *
 * The block authorizes the LLM to relax EXACTLY ONE craft constraint on this
 * spread (rhyme scheme, line count, or repeated phrase). The other rules
 * (no invented props, hero pronouns, no nonsense words, no infant-locomotion)
 * are NEVER relaxed — those are illustrator-safety rails, not craft taste.
 *
 * @param {number} spreadNumber
 * @returns {string}
 */
function renderEscapeHatchForSpread(spreadNumber) {
  return [
    `ESCAPE HATCH — Spread ${spreadNumber} (AA-CW-16, unlocked after ${WRITER_ESCAPE_HATCH_AFTER_REJECTIONS} consecutive rejections):`,
    'This spread has been rejected too many times to keep insisting on full craft. You are now permitted to RELAX EXACTLY ONE of the following constraints to break the loop:',
    '  (a) Rhyme scheme — you may switch this spread from AABB to ABAB, ABCB, or free verse if the rhyme constraint is forcing filler/invented props. The rest of the book stays AABB.',
    '  (b) Line count — you may emit one fewer line than the band target (e.g. 3 lines for a band that asks for 4) if a clean 4-line shape is unreachable.',
    '  (c) Repeated phrase — you may drop a refrain or echoed phrase on this spread if it is what is forcing the failing tag.',
    'You may relax ONLY ONE of (a)/(b)/(c) on this spread. State which one in `writerNotes` (e.g. "escape-hatch: relaxed rhyme scheme to ABAB"). Hard rules NEVER relaxed: no invented props (proseProps whitelist), hero pronouns, no nonsense words, no infant-locomotion verbs, no parent-name concat with address words.',
  ].join('\n');
}

/**
 * Render the memory block for a single spread's prior failed attempts. The
 * block is consumed by the rewriter so it does NOT re-emit the same lines and
 * does NOT just shuffle them; it must change the meaning, image, or rhyme.
 *
 * @param {object} doc
 * @param {number} spreadNumber
 * @returns {string}
 */
function renderRewriteMemoryForSpread(doc, spreadNumber) {
  const attempts = doc.writerRewriteMemory && doc.writerRewriteMemory[spreadNumber]
    ? doc.writerRewriteMemory[spreadNumber]
    : [];
  if (attempts.length === 0) return '';
  const lines = [
    'WHAT YOU JUST TRIED THAT DID NOT WORK — do NOT re-emit any of these lines verbatim, and do NOT just shuffle them. Change the meaning, image, OR rhyme word so the failing tag goes away:',
  ];
  for (const a of attempts) {
    const tags = Array.isArray(a.killingTags) && a.killingTags.length > 0
      ? a.killingTags.join(', ')
      : 'unspecified';
    lines.push(`  - Wave ${a.wave} (rejected with tags: ${tags}):`);
    const text = (a.rejectedText || '').trim();
    if (text) {
      for (const ln of text.split(/\r?\n/)) {
        if (ln.trim()) lines.push(`      | ${ln}`);
      }
    }
    if (Array.isArray(a.killingIssues) && a.killingIssues.length > 0) {
      for (const issue of a.killingIssues.slice(0, 4)) {
        lines.push(`    • why it failed: ${issue}`);
      }
    }
  }
  lines.push('Your new attempt for this spread MUST differ in substance from every wave above — not just rephrasing.');
  return lines.join('\n');
}

function renderLineCountReminderForRewrite(ageBand) {
  const target = TEXT_LINE_TARGET[ageBand];
  if (target && target.min === target.max) {
    // AA-CW-17 Part B: PB_INFANT uses relaxed scheme; other PB bands stay AABB.
    if (ageBand === AGE_BANDS.PB_INFANT) {
      return `LINE COUNT FOR REWRITES: EXACTLY ${target.min} lines per spread (age band ${ageBand}). Lines 1+2 MUST rhyme; lines 3+4 may rhyme OR may be free-verse — prefer naturalness over forced rhymes.`;
    }
    return `LINE COUNT FOR REWRITES: EXACTLY ${target.min} lines per spread (age band ${ageBand}). Picture books always emit 4 lines (two AABB couplets).`;
  }
  return '';
}

/**
 * @param {object} doc
 * @param {{ spreadNumber: number, issues: string[], tags: string[], suggestedRewrite: string|null }[]} targets
 * @returns {string}
 */
/**
 * AA-CW-18 Part A: parse a book-level QA issue string into a structured
 * directive that the rewriter can act on. The QA judge emits strings like:
 *   "verb_crutch: 'give' appears in 5 of 13 spreads (38%) — spreads 4, 8, 9, 10, 12. Diversify the actions."
 *   "refrain_crutch: 'blanket' appears in 5 of 13 spreads — spreads 1, 2, 4, 6, 8."
 *   "refrain_crutch: ... 'sleeve' appears in 8/13 spreads, 'hand' in 7/13 ..."
 * Returns an array of { kind, lemma, spreads }. The kind is the lowercase
 * tag (e.g. 'verb_crutch'). When the issue mentions multiple lemmas, one
 * directive is returned per lemma. Spreads default to [] when the judge
 * does not enumerate them — in that case the rewriter still sees the
 * directive in its book-level block and can self-diversify on every
 * occurrence it finds.
 *
 * @param {string[]} bookLevelIssues
 * @returns {{ kind: string, lemma: string, spreads: number[], raw: string }[]}
 */
function parseBookLevelDirectives(bookLevelIssues) {
  const out = [];
  for (const issue of Array.isArray(bookLevelIssues) ? bookLevelIssues : []) {
    if (typeof issue !== 'string' || issue.length === 0) continue;
    const lower = issue.toLowerCase();
    let kind = null;
    if (lower.startsWith('verb_crutch')) kind = 'verb_crutch';
    else if (lower.startsWith('refrain_crutch')) kind = 'refrain_crutch';
    else continue;

    // Pull every “spreads <list>” enumeration in the message.
    // Multiple lemmas may share a single enumeration (one verb-crutch line)
    // or each lemma may have its own (one refrain-crutch line per lemma).
    const lemmaMatches = [...issue.matchAll(/['‘]([A-Za-z][A-Za-z'-]*)['’]/g)].map(m => m[1].toLowerCase());
    const spreadMatch = issue.match(/spreads?\s+([0-9,\s]+)/i);
    let spreads = [];
    if (spreadMatch && spreadMatch[1]) {
      spreads = spreadMatch[1]
        .split(/[,\s]+/)
        .map(s => Number(s))
        .filter(n => Number.isInteger(n) && n > 0);
    }
    if (lemmaMatches.length === 0) {
      out.push({ kind, lemma: '', spreads, raw: issue });
      continue;
    }
    for (const lemma of lemmaMatches) {
      out.push({ kind, lemma, spreads, raw: issue });
    }
  }
  return out;
}

/**
 * AA-CW-18 Part A: render a high-priority book-level instruction block
 * for the rewriter prompt. Goes ABOVE the per-spread JSON payload because
 * book-level diversification has to happen across the corpus, not inside
 * any one spread.
 *
 * @param {{ kind: string, lemma: string, spreads: number[] }[]} directives
 * @returns {string}
 */
function renderBookLevelDirectivesBlock(directives) {
  if (!Array.isArray(directives) || directives.length === 0) return '';
  const verbDirectives = directives.filter(d => d.kind === 'verb_crutch');
  const refrainDirectives = directives.filter(d => d.kind === 'refrain_crutch');
  const lines = [
    'BOOK-LEVEL DIVERSIFICATION (AA-CW-18 — HIGHEST PRIORITY across this rewrite wave):',
    'The previous wave produced corpus-wide repetition. Per-spread fixes alone will NOT clear these flags — you must replace the overused tokens listed below across the spreads named, choosing different concrete details on each spread you touch.',
  ];
  if (verbDirectives.length > 0) {
    lines.push('', 'Overused VERBS (verb_crutch):');
    for (const d of verbDirectives) {
      const spreadList = d.spreads.length > 0 ? `spreads ${d.spreads.join(', ')}` : 'every spread it appears on';
      lines.push(`- "${d.lemma}" — replace on ${spreadList}. Pick a DIFFERENT verb on each spread; avoid "give", "pat", "hold" if they are also flagged. Use the infant-safe whitelist (sees, hears, smiles, reaches, claps, snuggles, points, looks, touches, gasps, giggles, watches, waves, blinks).`);
    }
  }
  if (refrainDirectives.length > 0) {
    lines.push('', 'Overused NOUNS / WORDS (refrain_crutch):');
    for (const d of refrainDirectives) {
      const spreadList = d.spreads.length > 0 ? `spreads ${d.spreads.join(', ')}` : 'every spread it appears on';
      lines.push(`- "${d.lemma}" — swap for a different concrete sensory detail on ${spreadList}. Don’t replace one crutch with another from the same set (sleeve / hand / leaf / blanket / arm). Vary the sensory channel (sound, light, breath, weight, texture, shadow) instead of recycling the same prop.`);
    }
  }
  lines.push(
    '',
    'AA-CW-19 SENSORY-CHANNEL ROTATION — when replacing a crutch verb, you do NOT have to swap verb-for-verb. Drop the verb-led construction entirely and write a sensory image, state line, or sound line instead. Examples:',
    '  - verb-led: "Mama gives a warm hug." → sensory image: "Soft sun on her cheek."',
    '  - verb-led: "Scarlett pats the leaf." → state line: "The room is hush."',
    '  - verb-led: "Mama says hello." → sound line: "A small bird sings."',
    'A book of 13 spreads where every line opens with a verb is a book that will crutch. Vary the opening: noun-led, adjective-led, sound-led, image-led. Replacing one crutch verb with another crutch verb (give → say → pat → hold) WILL fail the next wave — the same gate fires on the new lemma.',
    '',
    'WHEN YOU EMIT THE NEW SPREAD TEXT FOR EACH TARGET, you MUST avoid the listed lemma on that spread — even if it appeared safely in your prior attempt. The book-level flag is a corpus problem, not a per-spread problem.',
  );
  return lines.join('\n');
}

/**
 * AA-CW-19 — cumulative forbidden-lemma list across rewrite waves.
 *
 * The bug AA-CW-18 left behind: when wave 1 flags `verb_crutch "give"` the
 * rewriter dutifully removes "give" but freely replaces it with "say".
 * Wave 2 flags `verb_crutch "say"`. Rewriter removes "say", replaces with
 * "pat". Wave 3 flags "pat". The rewriter has no memory of which lemmas
 * are already burned, so it whack-a-moles forever and the 5-wave budget
 * runs out.
 *
 * Fix: every wave, append the lemma(s) flagged by `verb_crutch` /
 * `refrain_crutch` to a cumulative `doc.writerForbiddenLemmas` set, and
 * pass that whole set into every subsequent rewriter prompt as a
 * "FORBIDDEN LEMMAS — may not appear in any spread you rewrite" block.
 * Once burned, a lemma stays burned for the remainder of the book.
 *
 * Shape on the doc:
 *   doc.writerForbiddenLemmas = {
 *     verbs: ['give', 'say', 'pat'],
 *     nouns: ['sleeve', 'leaf'],
 *   }
 *
 * Both arrays are deduplicated, lower-cased, and sorted. We DO NOT track
 * which wave first burned a lemma — the rewriter only needs the union.
 *
 * @param {object} doc
 * @param {{ kind: string, lemma: string }[]} directives
 * @returns {object}
 */
function recordForbiddenLemmasFromDirectives(doc, directives) {
  if (!Array.isArray(directives) || directives.length === 0) return doc;
  const prev = doc.writerForbiddenLemmas || { verbs: [], nouns: [] };
  const verbs = new Set((prev.verbs || []).map(s => String(s).toLowerCase()));
  const nouns = new Set((prev.nouns || []).map(s => String(s).toLowerCase()));
  for (const d of directives) {
    if (!d || !d.lemma) continue;
    const lemma = String(d.lemma).toLowerCase().trim();
    if (!lemma) continue;
    if (d.kind === 'verb_crutch') verbs.add(lemma);
    else if (d.kind === 'refrain_crutch') nouns.add(lemma);
  }
  return {
    ...doc,
    writerForbiddenLemmas: {
      verbs: [...verbs].sort(),
      nouns: [...nouns].sort(),
    },
  };
}

/**
 * AA-CW-19 — render the cumulative forbidden-lemma block for the rewriter.
 * Goes ABOVE the per-spread JSON payload, near the book-level directives,
 * so the rewriter sees the union of every burned lemma before it generates.
 *
 * @param {object} doc
 * @returns {string}
 */
function renderForbiddenLemmasBlock(doc) {
  const fl = doc?.writerForbiddenLemmas;
  if (!fl) return '';
  const verbs = Array.isArray(fl.verbs) ? fl.verbs : [];
  const nouns = Array.isArray(fl.nouns) ? fl.nouns : [];
  if (verbs.length === 0 && nouns.length === 0) return '';
  const lines = [
    'FORBIDDEN LEMMAS — CUMULATIVE ACROSS ALL WAVES (AA-CW-19, hardest rule in this prompt):',
    'These tokens were flagged as crutches in earlier rewrite waves. They are now BANNED from every spread you rewrite, in every form (singular/plural, all conjugations, possessive). Replacing one banned lemma with a non-banned crutch is the loop that wasted the last 5 waves — do NOT do it.',
  ];
  if (verbs.length > 0) {
    lines.push(`- BANNED VERB LEMMAS (any conjugation): ${verbs.map(v => `"${v}"`).join(', ')}.`);
  }
  if (nouns.length > 0) {
    lines.push(`- BANNED NOUN LEMMAS (any number/possessive): ${nouns.map(n => `"${n}"`).join(', ')}.`);
  }
  lines.push(
    'If a spread you must rewrite previously contained one of these lemmas, you MUST express that beat WITHOUT using any banned lemma. Use a different verb (or no verb — sensory image / state line / sound line are encouraged), and a different concrete noun.',
    'If you find yourself unable to write a spread without a banned lemma, you are reaching for a crutch — stop, change the sentence shape, and use a sensory image instead.',
  );
  return lines.join('\n');
}

function rewriteUserPrompt(doc, targets) {
  const bySpread = new Map(doc.spreads.map(s => [s.spreadNumber, s]));
  const items = targets
    .map(t => {
      const s = bySpread.get(t.spreadNumber);
      if (!s) return null;
      // AA-CW-15: pass prior-wave rejected attempts so the rewriter does not
      // loop B->C->B on the same defects. Surfaced in a top-level field so
      // the rewriter sees "WHAT YOU JUST TRIED" for THIS spread before it
      // emits the next attempt.
      const priorAttempts = (doc.writerRewriteMemory && doc.writerRewriteMemory[t.spreadNumber])
        ? doc.writerRewriteMemory[t.spreadNumber]
        : [];
      // AA-CW-16: signal the escape hatch on the JSON payload so the rewriter
      // sees both the relax-instruction block (above the JSON) and a flag in
      // its own item.
      const escapeHatchUnlocked = isEscapeHatchUnlocked(doc, t.spreadNumber);
      return {
        spreadNumber: t.spreadNumber,
        spec: s.spec,
        currentText: s.manuscript?.text || '',
        currentSide: s.manuscript?.side || null,
        issues: t.issues,
        tags: t.tags,
        suggestedRewrite: t.suggestedRewrite,
        priorAttempts,
        escapeHatchUnlocked,
      };
    })
    .filter(Boolean);

  // AA-CW-15: build a separate, prominent memory block per spread so the
  // "do not re-emit" instruction is loud, not buried inside JSON.
  // AA-CW-16: prepend the escape-hatch authorization for any spread that has
  // crossed the rejection threshold, so the rewriter sees both "what you
  // tried" and "what you may now relax" before the JSON payload.
  const memoryBlocks = items
    .map(it => {
      const memBlock = renderRewriteMemoryForSpread(doc, it.spreadNumber);
      const escapeBlock = isEscapeHatchUnlocked(doc, it.spreadNumber)
        ? renderEscapeHatchForSpread(it.spreadNumber)
        : '';
      if (!memBlock && !escapeBlock) return '';
      const parts = [`--- Spread ${it.spreadNumber} ---`];
      if (escapeBlock) parts.push(escapeBlock);
      if (memBlock) parts.push(memBlock);
      return parts.join('\n');
    })
    .filter(Boolean);
  const lineCountReminder = renderLineCountReminderForRewrite(doc.request?.ageBand);

  // AA-CW-5a — thread the canonical pronoun set into the rewrite prompt.
  // Each `items[i].spec` already carries `arcContext`, so we just need
  // the pronouns block at the top.
  const pronouns = doc?.brief?.pronouns || null;
  const heroName = doc?.brief?.child?.name || 'the hero';
  const pronounBlock = pronouns
    ? `HERO PRONOUNS — USE ONLY THESE FOR ${heroName} (never swap, never alternate, never use a different pronoun set anywhere in the rewrite):\n  subject: ${pronouns.subject}\n  object: ${pronouns.object}\n  possessive: ${pronouns.possessive}\n  reflexive: ${pronouns.reflexive}`
    : '';

  // AA-CW-5b — surface the curated arc context (narrativeSpine, beats,
  // motifs, locations) above the spread payload so each rewrite wave keeps
  // the through-line in view instead of re-reading the full storyBible JSON.
  const arcContextBlock = renderStoryArcContext(doc.storyBible);

  // AA-CW-18 Part A — thread book-level diversification directives so the
  // rewriter can act on verb_crutch / refrain_crutch instead of fixing one
  // spread at a time blindly.
  const bookLevelDirectives = parseBookLevelDirectives(doc?.writerQa?.bookLevel || []);
  const bookLevelDirectivesBlock = renderBookLevelDirectivesBlock(bookLevelDirectives);

  // AA-CW-19 — cumulative forbidden-lemma block. The rewrite loop calls
  // `recordForbiddenLemmasFromDirectives` BEFORE building this prompt, so
  // `doc.writerForbiddenLemmas` already contains the union of every lemma
  // flagged in any prior wave plus the lemmas flagged this wave.
  const forbiddenLemmasBlock = renderForbiddenLemmasBlock(doc);

  return [
    renderTextPolicyBlock(doc),
    arcContextBlock ? `\n${arcContextBlock}` : '',
    lineCountReminder ? `\n${lineCountReminder}` : '',
    pronounBlock ? `\n${pronounBlock}` : '',
    forbiddenLemmasBlock ? `\n${forbiddenLemmasBlock}` : '',
    bookLevelDirectivesBlock ? `\n${bookLevelDirectivesBlock}` : '',
    // AA-CW-15: surface the rewrite-memory block ABOVE the JSON payload so
    // the rewriter cannot miss it (model attention drops by mid-prompt).
    memoryBlocks.length > 0
      ? `\n${memoryBlocks.join('\n\n')}\n`
      : '',
    '',
    `Story bible:\n${JSON.stringify(doc.storyBible, null, 2)}`,
    '',
    `Rewrite ONLY these spreads. Leave all other spreads untouched:\n${JSON.stringify(items, null, 2)}`,
    '',
    'Emit the JSON now.',
  ].join('\n');
}

/**
 * Merge rewritten manuscript entries onto the document, leaving others as-is.
 *
 * @param {object} doc
 * @param {any} json
 * @returns {object}
 */
function mergeRewrites(doc, json) {
  const arr = Array.isArray(json?.spreads) ? json.spreads : [];
  let next = doc;
  for (const entry of arr) {
    const n = Number(entry?.spreadNumber);
    if (!Number.isFinite(n) || n < 1 || n > TOTAL_SPREADS) continue;
    const manuscriptRaw = {
      text: String(entry.text || '').trim(),
      side: entry.side === 'left' ? 'left' : 'right',
      lineBreakHints: Array.isArray(entry.lineBreakHints) ? entry.lineBreakHints.map(String) : [],
      personalizationUsed: Array.isArray(entry.personalizationUsed) ? entry.personalizationUsed.map(String) : [],
      writerNotes: entry.writerNotes ? String(entry.writerNotes) : null,
    };
    // AA-CW-3: no regex truncation. The rewrite output is taken as-is and
    // any line-count miss is caught by the next writerQA wave.
    next = updateSpread(next, n, s => ({ ...s, manuscript: manuscriptRaw }));
  }
  return next;
}

/**
 * Writer QA + targeted rewrite loop. Returns the updated document, with
 * `writerQa` populated for the final iteration.
 *
 * @param {object} doc
 * @returns {Promise<object>}
 */
async function writerQaAndRewrite(doc) {
  let current = doc;
  let wave = 0;
  let lastQa = null;

  while (wave <= REPAIR_BUDGETS.writerRewriteWaves) {
    const qa = await checkWriterDraft(current);
    current = qa.updatedDoc;
    lastQa = qa;

    if (qa.pass) {
      return withStageResult(current, {
        writerQa: { pass: true, perSpread: qa.perSpread, bookLevel: qa.bookLevel, waves: wave },
      });
    }
    if (wave >= REPAIR_BUDGETS.writerRewriteWaves) break;

    let targets = qa.repairPlan.length > 0 ? qa.repairPlan : qa.perSpread.filter(s => !s.pass);

    // AA-CW-18 Part A: when the judge raised book-level tags (verb_crutch /
    // refrain_crutch) we MUST rewrite the spreads named in those tags even
    // if they passed per-spread QA — a per-spread fix alone cannot clear
    // a book-level flag. This keeps the rewriter from getting stuck in a
    // local optimum where every spread looks fine in isolation but "give"
    // still appears in 5 of 13 spreads.
    const bookLevelDirectivesForTargeting = parseBookLevelDirectives(qa.bookLevel || []);

    // AA-CW-19 — record every flagged lemma into the cumulative forbidden
    // set BEFORE we build the rewrite prompt. This is the central change
    // that breaks the give→say→pat→hold whack-a-mole loop: once a lemma
    // is burned in any wave, it is banned for every subsequent wave.
    current = recordForbiddenLemmasFromDirectives(current, bookLevelDirectivesForTargeting);
    const bookLevelSpreads = new Set();
    for (const d of bookLevelDirectivesForTargeting) {
      for (const sn of d.spreads) bookLevelSpreads.add(sn);
    }
    if (bookLevelSpreads.size > 0) {
      const existingTargetSpreads = new Set(targets.map(t => t.spreadNumber));
      const passingByNumber = new Map(qa.perSpread.map(p => [p.spreadNumber, p]));
      for (const sn of bookLevelSpreads) {
        if (existingTargetSpreads.has(sn)) continue;
        const passingEntry = passingByNumber.get(sn);
        // Only synthesize a target when the spread exists. Carry over the
        // existing entry's tags/issues (likely empty if it passed) and add
        // a synthetic book-level note so the per-spread rewrite block also
        // mentions WHY this previously-passing spread is being touched.
        const baseEntry = passingEntry || { spreadNumber: sn, issues: [], tags: [], suggestedRewrite: null };
        const issues = Array.isArray(baseEntry.issues) ? [...baseEntry.issues] : [];
        const tags = Array.isArray(baseEntry.tags) ? [...baseEntry.tags] : [];
        issues.push('book_level_diversification: this spread is named in a book-level verb_crutch or refrain_crutch tag. Replace the overused token (see BOOK-LEVEL DIVERSIFICATION block above).');
        if (!tags.includes('book_level_diversification')) tags.push('book_level_diversification');
        targets = [...targets, { ...baseEntry, issues, tags, pass: false }];
      }
    }

    if (targets.length === 0) break;

    // AA-CW-15: snapshot the about-to-be-rewritten text + killing tags/issues
    // BEFORE we call the rewriter. The current manuscript is exactly what the
    // QA just rejected, so this is the canonical "what you tried that failed"
    // payload for the next wave's prompt.
    const bySpreadForSnapshot = new Map(current.spreads.map(s => [s.spreadNumber, s]));
    for (const t of targets) {
      const snapshotSpread = bySpreadForSnapshot.get(t.spreadNumber);
      const rejectedText = snapshotSpread?.manuscript?.text || '';
      current = recordRewriteAttempt(current, t.spreadNumber, {
        wave: wave + 1,
        rejectedText,
        killingTags: Array.isArray(t.tags) ? [...t.tags] : [],
        killingIssues: Array.isArray(t.issues) ? [...t.issues] : [],
      });
      current = appendRetryMemory(current, buildRetryEntry({
        stage: 'writerDraft',
        spreadNumber: t.spreadNumber,
        failedAttemptNumber: wave + 1,
        failureTags: t.tags,
        mustChange: t.issues,
      }));
    }

    // PR J.4 — per-band rewrite temperature. Infant rewrite is the
    // narrowest constraint surface in the pipeline (we already know which
    // exact lines to fix), so we sample at a lower temperature
    // (see getWriterTemperature('rewrite', ...)) to maximise
    // constraint-following.
    // PR J.1.5 diagnostic: log resolved temperature + ageBand per wave so we
    // can confirm the J.4 rewrite temperature (0.4 for infant) is in effect.
    const _rewriteAgeBand = current?.request?.ageBand || '(none)';
    const _rewriteTemp = getWriterTemperature('rewrite', current?.request?.ageBand);
    console.log(
      `[writer:rewrite.wave${wave + 1}] ageBand=${_rewriteAgeBand} temperature=${_rewriteTemp} (PR J.1.5 diagnostic)`
    );
    const result = await callText({
      model: MODELS.WRITER,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: rewriteUserPrompt(current, targets),
      jsonMode: true,
      temperature: _rewriteTemp,
      maxTokens: 7000,
      label: `writerRewrite.wave${wave + 1}`,
      abortSignal: current.operationalContext?.abortSignal,
    });

    current = mergeRewrites(current, result.json);
    current = appendLlmCall(current, {
      stage: 'writerRewrite',
      wave: wave + 1,
      model: result.model,
      attempts: result.attempts,
      usage: result.usage,
    });
    wave += 1;
  }

  const finalDoc = withStageResult(current, {
    writerQa: {
      pass: false,
      perSpread: lastQa?.perSpread || [],
      bookLevel: lastQa?.bookLevel || [],
      waves: wave,
    },
  });

  // PR F hard gate: if the writer never managed to remove the infant-
  // forbidden action verbs, do not let the bad text reach the illustrator.
  // The illustrator cannot resolve text-induced age violations and would
  // burn its full per-pair budget for nothing.
  const residuals = collectInfantActionResiduals(finalDoc);
  if (residuals.length > 0) {
    const issues = residuals.map(r => `spread ${r.spreadNumber}: infant-forbidden action verb(s) remain after ${wave} rewrite wave(s): ${r.hits.join(', ')}`);
    const bookId = finalDoc.operationalContext?.bookId || finalDoc.request?.bookId || 'n/a';
    console.error(
      `[bookPipeline:${bookId}] writer hard gate: ${residuals.length} spread(s) still contain forbidden infant action verbs after ${wave} wave(s) — failing before illustrator`,
    );
    // AA-CW-17 Part A: persist forensics before throwing.
    await persistWriterFailureForensics(finalDoc, {
      reason: 'infant_action_text_residual',
      waves: wave,
      residualTags: ['infant_action_text_residual'],
    });
    throw new WriterUnresolvableError(
      `writer could not produce infant-safe text after ${wave} rewrite wave(s)`,
      { issues, tags: ['infant_action_text_residual'] },
    );
  }

  // AA-CW-12 hard gate: identity_rhyme / unrenderable_action / writer_invented_prop.
  // Production log on book e3f4e0c0 proved the pipeline shipped manuscript
  // text with `identity_rhyme` ("mama/mama") flagged on 3 spreads after
  // wave 3, and a separate book burned the entire illustrator budget on
  // "Mama holds her purr" / "Scarlett bites her grin" before SIGTERM.
  // The renderer cannot resolve any of these — they are writer defects
  // disguised as illustration failures. Fail fast at the writer stage
  // with a tag pointing the operator at the real culprit.
  const writerFatal = collectWriterFatalResiduals(finalDoc);
  if (writerFatal.length > 0) {
    const byTag = writerFatal.reduce((acc, r) => {
      acc[r.tag] = (acc[r.tag] || 0) + 1;
      return acc;
    }, {});
    const issues = writerFatal.map(r => {
      const where = r.spreadNumber == null ? 'book-level' : `spread ${r.spreadNumber}`;
      return `${where} [${r.tag}]: ${r.issue}`;
    });
    const bookId = finalDoc.operationalContext?.bookId || finalDoc.request?.bookId || 'n/a';
    console.error(
      `[bookPipeline:${bookId}] writer hard gate (AA-CW-12): ${writerFatal.length} writer-fatal residual(s) after ${wave} wave(s) — ${JSON.stringify(byTag)} — failing before illustrator`,
    );
    // AA-CW-17 Part A: persist forensics before throwing.
    await persistWriterFailureForensics(finalDoc, {
      reason: 'writer_fatal_residual',
      waves: wave,
      residualTags: Object.keys(byTag),
    });
    throw new WriterUnresolvableError(
      `writer could not produce illustrator-safe text after ${wave} rewrite wave(s) (${Object.keys(byTag).join(', ')})`,
      { issues, tags: ['writer_fatal_residual', ...Object.keys(byTag)] },
    );
  }

  return finalDoc;
}

module.exports = {
  writerQaAndRewrite,
  collectInfantActionResiduals,
  collectWriterFatalResiduals,
  WriterUnresolvableError,
  WRITER_FATAL_TAGS,
  WRITER_FATAL_TAGS_UNCONDITIONAL,
  WRITER_FATAL_TAGS_TASTE,
  WRITER_FATAL_BOOK_LEVEL_TAGS,
  // AA-CW-15 — exported for tests and future composition.
  recordRewriteAttempt,
  renderRewriteMemoryForSpread,
  rewriteUserPrompt,
  REWRITE_MEMORY_MAX_ATTEMPTS,
  // AA-CW-16 — escape hatch.
  isEscapeHatchUnlocked,
  renderEscapeHatchForSpread,
  WRITER_ESCAPE_HATCH_AFTER_REJECTIONS,
  // AA-CW-17 Part A — failure forensics persistence (exported for tests).
  persistWriterFailureForensics,
  // AA-CW-17 Part B — exported so tests can prompt-lock the band-conditional rhyme rule.
  SYSTEM_PROMPT,
  renderLineCountReminderForRewrite,
  // AA-CW-18 Part A — book-level diversification helpers (exported for tests).
  parseBookLevelDirectives,
  renderBookLevelDirectivesBlock,
  // AA-CW-19 — cumulative forbidden-lemma helpers (exported for tests).
  recordForbiddenLemmasFromDirectives,
  renderForbiddenLemmasBlock,
};
