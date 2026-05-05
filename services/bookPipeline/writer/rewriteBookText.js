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
const { checkWriterDraft, findInfantForbiddenActionVerbs } = require('../qa/checkWriterDraft');
const { maybeTruncateInfantManuscript } = require('./truncateInfantText');
const { renderInfantContract } = require('./draftBookText');

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
 * @param {object} doc
 * @returns {{ spreadNumber: number, hits: string[] }[]}
 */
function collectInfantActionResiduals(doc) {
  const ageBand = doc?.request?.ageBand;
  if (ageBand !== AGE_BANDS.PB_INFANT) return [];
  const offenders = [];
  for (const s of doc.spreads || []) {
    const text = s?.manuscript?.text;
    if (!text) continue;
    const hits = findInfantForbiddenActionVerbs(text, ageBand);
    if (hits.length > 0) offenders.push({ spreadNumber: s.spreadNumber, hits });
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

Picture-book structure (MANDATORY when format is picture_book):
- LINE COUNT depends on age band:
   * Infant (PB_INFANT, 0-1): EXACTLY 2 lines per spread — one AA couplet. Never 4.
   * Toddler/Preschool (PB_TODDLER, PB_PRESCHOOL): EXACTLY 4 lines per spread — two AABB couplets.
   * Lines separated by "\\n".
- Rhyme scheme: AA for 2-line; AABB for 4-line. Real end-rhymes or near-rhymes only — never same-word rhymes, never non-rhymes.
- LINE LENGTH — match the per-age-band "LINE LENGTH" rule in the age/voice policy block above. Infants (0-1) are extra-tight (~2-4 words/line, hardMax 5). Ages 0-3 (PB_TODDLER) are VERY short (~3-7 words/line, sing-song board-book cadence); ages 3-6 (PB_PRESCHOOL) are short (~6-12 words/line). Consistent pulse across each couplet.
- NEVER invent fake words just to make a rhyme work. Real English only.
- NEVER use a simile ("X as Y", "like Y") where Y is implausible for a child to recognize ("light as code", "soft as math"). Use concrete sensory comparisons.

Return ONLY strict JSON: { "spreads": [ { "spreadNumber": N, "text": "LINE1\\nLINE2[\\nLINE3\\nLINE4]", "side": "left|right", "lineBreakHints": ["..."], "personalizationUsed": ["..."], "writerNotes": "optional" }, ... ] }. The "text" field is a single string with embedded "\\n" line breaks. For infant books emit 2 lines; for toddler/preschool books emit 4 lines.`;

function renderLineCountReminderForRewrite(ageBand) {
  if (ageBand === AGE_BANDS.PB_INFANT) {
    return 'LINE COUNT FOR REWRITES: EXACTLY 2 lines per spread (AA) — infant band. Do NOT emit 4 lines.';
  }
  const target = TEXT_LINE_TARGET[ageBand];
  if (target && target.min === target.max) {
    return `LINE COUNT FOR REWRITES: EXACTLY ${target.min} lines per spread (age band ${ageBand}).`;
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
  const infantContract = renderInfantContract(doc.request?.ageBand);

  return [
    infantContract,
    renderTextPolicyBlock(doc),
    lineCountReminder ? `\n${lineCountReminder}` : '',
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
    const manuscript = maybeTruncateInfantManuscript(manuscriptRaw, doc);
    next = updateSpread(next, n, s => ({ ...s, manuscript }));
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
    // exact lines to fix), so we sample at 0.4 — same as the existing
    // compressInfantSpread stage — to maximise constraint-following.
    const result = await callText({
      model: MODELS.WRITER,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: rewriteUserPrompt(current, targets),
      jsonMode: true,
      temperature: getWriterTemperature('rewrite', current?.request?.ageBand),
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

  return finalDoc;
}

module.exports = { writerQaAndRewrite, collectInfantActionResiduals, WriterUnresolvableError };
