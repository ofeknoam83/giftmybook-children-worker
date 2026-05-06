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
const WRITER_FATAL_TAGS = [
  'identity_rhyme',
  'unrenderable_action',
  'writer_invented_prop',
  'semantic_filler',
  'forced_rhyme_meaning_drift',
];

// Book-level tags. spreadNumber is null on these offenders because the
// defect is a property of the manuscript as a whole, not a single spread.
const WRITER_FATAL_BOOK_LEVEL_TAGS = ['verb_crutch'];

function collectWriterFatalResiduals(doc) {
  const perSpread = doc?.writerQa?.perSpread || [];
  const bookLevel = Array.isArray(doc?.writerQa?.bookLevel) ? doc.writerQa.bookLevel : [];
  const offenders = [];

  // Per-spread tags.
  for (const entry of perSpread) {
    const tags = Array.isArray(entry?.tags) ? entry.tags : [];
    const issues = Array.isArray(entry?.issues) ? entry.issues : [];
    for (const tag of WRITER_FATAL_TAGS) {
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

Picture-book structure (MANDATORY when format is picture_book):
- LINE COUNT: EXACTLY 4 lines per spread for ALL picture-book age bands (PB_INFANT 0-1, PB_TODDLER 0-3, PB_PRESCHOOL 3-6) — two AABB rhyming couplets. Even the infant board-book band uses 4 lines; bands differ by per-line word budget, not by line count. NEVER emit 2-line spreads for picture books.
   * Lines separated by "\\n".
- Rhyme scheme: AABB — lines 1+2 rhyme; lines 3+4 rhyme. Real end-rhymes or near-rhymes only — never same-word rhymes, never non-rhymes.
- LINE LENGTH — match the per-age-band "LINE LENGTH" rule in the age/voice policy block above. Infants (0-1) are extra-tight (~2-5 words/line, hardMax 6) inside the 4-line shape. Ages 0-3 (PB_TODDLER) are VERY short (~3-7 words/line, sing-song board-book cadence); ages 3-6 (PB_PRESCHOOL) are short (~6-12 words/line). Consistent pulse across each couplet.
- NEVER invent fake words just to make a rhyme work. Real English only.
- NEVER use a simile ("X as Y", "like Y") where Y is implausible for a child to recognize ("light as code", "soft as math"). Use concrete sensory comparisons.

Return ONLY strict JSON: { "spreads": [ { "spreadNumber": N, "text": "LINE1\\nLINE2\\nLINE3\\nLINE4", "side": "left|right", "lineBreakHints": ["..."], "personalizationUsed": ["..."], "writerNotes": "optional" }, ... ] }. The "text" field is a single string with embedded "\\n" line breaks. Picture books always emit EXACTLY 4 lines per spread regardless of age band.`;

function renderLineCountReminderForRewrite(ageBand) {
  const target = TEXT_LINE_TARGET[ageBand];
  if (target && target.min === target.max) {
    return `LINE COUNT FOR REWRITES: EXACTLY ${target.min} lines per spread (age band ${ageBand}). Picture books always emit 4 lines (two AABB couplets).`;
  }
  return '';
}

/**
 * @param {object} doc
 * @param {{ spreadNumber: number, issues: string[], tags: string[], suggestedRewrite: string|null }[]} targets
 * @returns {string}
 */
function rewriteUserPrompt(doc, targets) {
  const bySpread = new Map(doc.spreads.map(s => [s.spreadNumber, s]));
  const items = targets
    .map(t => {
      const s = bySpread.get(t.spreadNumber);
      if (!s) return null;
      return {
        spreadNumber: t.spreadNumber,
        spec: s.spec,
        currentText: s.manuscript?.text || '',
        currentSide: s.manuscript?.side || null,
        issues: t.issues,
        tags: t.tags,
        suggestedRewrite: t.suggestedRewrite,
      };
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

  return [
    renderTextPolicyBlock(doc),
    arcContextBlock ? `\n${arcContextBlock}` : '',
    lineCountReminder ? `\n${lineCountReminder}` : '',
    pronounBlock ? `\n${pronounBlock}` : '',
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

    const targets = qa.repairPlan.length > 0 ? qa.repairPlan : qa.perSpread.filter(s => !s.pass);
    if (targets.length === 0) break;

    for (const t of targets) {
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
  WRITER_FATAL_BOOK_LEVEL_TAGS,
};
