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
const { MODELS, REPAIR_BUDGETS, TOTAL_SPREADS } = require('../constants');
const { updateSpread, appendLlmCall, appendRetryMemory, withStageResult } = require('../schema/bookDocument');
const { renderTextPolicyBlock } = require('./textPolicies');
const { buildRetryEntry } = require('../retryMemory');
const { checkWriterDraft } = require('../qa/checkWriterDraft');

const SYSTEM_PROMPT = `You are rewriting specific spreads of a children's book.
You keep the rest of the book intact. For each spread listed, produce an improved version that fixes the listed issues.
Hard rules (same as original writer):
- Honor the spread spec (side, line target, personalization).
- Read-aloud first. Musical, simple, low repetition, no big metaphors.
- Third-person by default. Funny/playful tone. Never preachy.
- Text must be plausible to render in a few lines on one side without crossing center.
Return ONLY strict JSON: { "spreads": [ { "spreadNumber": N, "text": "...", "side": "left|right", "lineBreakHints": ["..."], "personalizationUsed": ["..."], "writerNotes": "optional" }, ... ] }.`;

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
  return [
    renderTextPolicyBlock(doc),
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
    const manuscript = {
      text: String(entry.text || '').trim(),
      side: entry.side === 'left' ? 'left' : 'right',
      lineBreakHints: Array.isArray(entry.lineBreakHints) ? entry.lineBreakHints.map(String) : [],
      personalizationUsed: Array.isArray(entry.personalizationUsed) ? entry.personalizationUsed.map(String) : [],
      writerNotes: entry.writerNotes ? String(entry.writerNotes) : null,
    };
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

    const result = await callText({
      model: MODELS.WRITER,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: rewriteUserPrompt(current, targets),
      jsonMode: true,
      temperature: 0.85,
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

  return withStageResult(current, {
    writerQa: {
      pass: false,
      perSpread: lastQa?.perSpread || [],
      bookLevel: lastQa?.bookLevel || [],
      waves: wave,
    },
  });
}

module.exports = { writerQaAndRewrite };
