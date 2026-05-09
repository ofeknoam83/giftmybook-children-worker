/**
 * Canonical internal book document for the new generation pipeline.
 *
 * A single immutable-by-convention object is threaded through every stage
 * (input -> planners -> writer -> illustrator -> QA -> adapters). Each
 * stage produces a new version of this document by returning a shallow
 * merge over its prior state. Stages MUST NOT mutate earlier fields.
 */

const { PIPELINE_VERSION, VISUAL_STYLE, TOTAL_SPREADS } = require('../constants');

/**
 * Create an empty book document skeleton from a normalized input payload.
 *
 * @param {object} input
 * @param {object} input.request - raw request context (bookId, format, theme, ageBand, callbackUrl)
 * @param {object} input.brief - normalized creative brief (child, customDetails, constraints, goals)
 * @param {object} input.cover - approved cover metadata (title, imageUrl, locks)
 * @param {object} [input.operationalContext] - progress/callback/abort plumbing
 * @returns {object} canonical book document
 */
function createBookDocument(input) {
  const { request, brief, cover, operationalContext = {} } = input;

  const spreads = Array.from({ length: TOTAL_SPREADS }, (_, i) => ({
    spreadNumber: i + 1,
    spec: null,
    manuscript: null,
    illustration: null,
    qa: {
      writerChecks: [],
      spreadChecks: [],
      repairHistory: [],
    },
  }));

  return {
    version: PIPELINE_VERSION,
    request: { ...request },
    brief: { ...brief },
    cover: {
      styleLock: VISUAL_STYLE,
      ...cover,
    },
    storyBible: null,
    visualBible: null,
    spreads,
    retryMemory: [],
    writerQa: null,
    bookWideQa: null,
    trace: {
      llmCalls: [],
      stages: [],
      checkpoints: [],
    },
    // Operational counters surfaced at end-of-pipeline. Three signals
    // drive most of our quality regressions:
    //   - writer.reviseLoopsUsed       — writer QA churn (rule mismatch, refrain, pronoun)
    //   - illustrator.softFailsShipped — drift accepted on the late-attempt path
    //   - proseRevisionRequests        — illustrator-side QA caused a writer rewrite (Phase 4)
    // Kept flat + named so Cloud Logging filters and metrics stay simple.
    counters: {
      writer: { reviseLoopsUsed: 0 },
      illustrator: { softFailsShipped: 0 },
      proseRevisionRequests: 0,
    },
    result: {
      status: 'pending',
      failureCode: null,
      failureSummary: null,
    },
    operationalContext,
  };
}

/**
 * Produce a new book document with a stage result merged in. Shallow merge
 * at the top level; callers pass either full replacement fields or spreads
 * arrays to splice onto the skeleton.
 *
 * @param {object} doc - current book document
 * @param {object} patch - fields to set on the new document
 * @returns {object} new book document
 */
function withStageResult(doc, patch) {
  return { ...doc, ...patch };
}

/**
 * Update a single spread by number. Returns a new document; the target
 * spread entry is replaced with `next(prevSpread)`.
 *
 * @param {object} doc
 * @param {number} spreadNumber - 1-based
 * @param {(spread: object) => object} next
 * @returns {object}
 */
function updateSpread(doc, spreadNumber, next) {
  const spreads = doc.spreads.map(s => (s.spreadNumber === spreadNumber ? next(s) : s));
  return { ...doc, spreads };
}

/**
 * Append an entry to retryMemory. Callers should pass a structured failure
 * record (see retryMemory.js) so downstream retries can use it directly.
 *
 * @param {object} doc
 * @param {object} entry
 * @returns {object}
 */
function appendRetryMemory(doc, entry) {
  return { ...doc, retryMemory: [...doc.retryMemory, entry] };
}

/**
 * Append a trace record for stage execution history. Keeps the pipeline
 * debuggable without relying on external logs.
 *
 * @param {object} doc
 * @param {object} stage
 * @returns {object}
 */
function appendStageTrace(doc, stage) {
  const stages = [...doc.trace.stages, { ...stage, at: new Date().toISOString() }];
  return { ...doc, trace: { ...doc.trace, stages } };
}

/**
 * Append an LLM call record (prompt metadata + usage, never full responses).
 * Full raw responses should be handled by the LLM client layer.
 *
 * @param {object} doc
 * @param {object} call
 * @returns {object}
 */
function appendLlmCall(doc, call) {
  const llmCalls = [...doc.trace.llmCalls, { ...call, at: new Date().toISOString() }];
  return { ...doc, trace: { ...doc.trace, llmCalls } };
}

/**
 * Mark the final result status of the document.
 *
 * @param {object} doc
 * @param {'success'|'failed'} status
 * @param {{ failureCode?: string, failureSummary?: string }} [details]
 * @returns {object}
 */
function setResult(doc, status, details = {}) {
  return {
    ...doc,
    result: {
      status,
      failureCode: details.failureCode || null,
      failureSummary: details.failureSummary || null,
    },
  };
}

/**
 * Increment one of the three operational counters in-place. Mutation is
 * deliberate here — the counters are scratch state, not part of the
 * stage-immutability contract that applies to storyBible / spreads / etc.
 *
 * Counter paths:
 *   - 'writer.reviseLoopsUsed'
 *   - 'illustrator.softFailsShipped'
 *   - 'proseRevisionRequests'
 *
 * Unknown paths are silently ignored so a typo in a callsite never crashes
 * a book — but they are logged once so we notice.
 *
 * @param {object} doc
 * @param {string} path
 * @param {number} [by=1]
 */
function incrementCounter(doc, path, by = 1) {
  if (!doc || !doc.counters) return;
  const c = doc.counters;
  switch (path) {
    case 'writer.reviseLoopsUsed':
      c.writer.reviseLoopsUsed += by;
      return;
    case 'illustrator.softFailsShipped':
      c.illustrator.softFailsShipped += by;
      return;
    case 'proseRevisionRequests':
      c.proseRevisionRequests += by;
      return;
    default:
      console.warn(`[bookDocument] incrementCounter: unknown counter path '${path}'`);
  }
}

/**
 * Render the counters as a single grep-friendly log line for end-of-pipeline
 * observability. Format: `[BOOK_COUNTERS] bookId=... writer.reviseLoopsUsed=N
 * illustrator.softFailsShipped=N proseRevisionRequests=N`.
 *
 * @param {object} doc
 * @returns {string}
 */
function formatCountersLogLine(doc) {
  const bookId = doc?.operationalContext?.bookId || 'n/a';
  const c = doc?.counters || {};
  const writer = c.writer?.reviseLoopsUsed ?? 0;
  const illustrator = c.illustrator?.softFailsShipped ?? 0;
  const prose = c.proseRevisionRequests ?? 0;
  return `[BOOK_COUNTERS] bookId=${bookId} writer.reviseLoopsUsed=${writer} illustrator.softFailsShipped=${illustrator} proseRevisionRequests=${prose}`;
}

module.exports = {
  createBookDocument,
  withStageResult,
  updateSpread,
  appendRetryMemory,
  appendStageTrace,
  appendLlmCall,
  setResult,
  incrementCounter,
  formatCountersLogLine,
};
