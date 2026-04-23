/**
 * Book-wide QA.
 *
 * After every spread passes its per-spread QA, the whole book is reviewed
 * as one artifact. This is intentionally lenient and overlap-oriented:
 * its job is to catch global defects (repeated compositions, location
 * monotony, mystery characters, outfit drift between non-adjacent spreads,
 * tone inconsistency) that per-spread gates cannot see.
 *
 * The current implementation produces a structured review record and
 * flags spreads that should be re-rendered. It does NOT re-run the render
 * loop here; the orchestrator can choose to trigger a bounded late repair
 * wave in a future iteration. For v1 we ship the review + telemetry and
 * let the pipeline proceed to layout.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS } = require('../constants');
const { appendLlmCall, withStageResult } = require('../schema/bookDocument');

const SYSTEM_PROMPT = `You are the final reviewer on a premium personalized children's book.
Review the full manuscript and the list of illustrations as a whole.
Flag problems that per-spread review cannot see:
  - repeated composition or camera across non-adjacent spreads
  - outfit/hair/identity drift between non-adjacent spreads
  - monotony of locations
  - tone mismatch (e.g. comedic setup, flat resolution)
  - ending that does not pay off the setup
Be specific. Return ONLY strict JSON with the schema in the user message. Be lenient — mark "pass": true unless there is a real defect.`;

function userPrompt(doc) {
  const spreads = doc.spreads.map(s => ({
    spreadNumber: s.spreadNumber,
    spec: s.spec,
    text: s.manuscript?.text,
    illustrationUrl: s.illustration?.imageUrl,
  }));

  return [
    `Story bible:\n${JSON.stringify(doc.storyBible, null, 2)}`,
    '',
    `Spreads:\n${JSON.stringify(spreads, null, 2)}`,
    '',
    'Return JSON:',
    `{
  "pass": true|false,
  "globalIssues": ["..."],
  "flaggedSpreads": [ { "spreadNumber": 1, "issue": "...", "severity": "soft|hard" } ]
}`,
  ].join('\n');
}

/**
 * @param {object} doc
 * @returns {Promise<object>}
 */
async function runBookWideQa(doc) {
  const result = await callText({
    model: MODELS.BOOK_WIDE_QA,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPrompt(doc),
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 5000,
    label: 'bookWideQa',
    abortSignal: doc.operationalContext?.abortSignal,
  });

  const json = result.json || {};
  const bookWideQa = {
    pass: json.pass !== false,
    globalIssues: Array.isArray(json.globalIssues) ? json.globalIssues.map(String) : [],
    flaggedSpreads: Array.isArray(json.flaggedSpreads) ? json.flaggedSpreads : [],
    reviewedAt: new Date().toISOString(),
  };

  const traced = appendLlmCall(doc, {
    stage: 'bookWideQa',
    model: result.model,
    attempts: result.attempts,
    usage: result.usage,
  });
  return withStageResult(traced, { bookWideQa });
}

module.exports = { runBookWideQa };
