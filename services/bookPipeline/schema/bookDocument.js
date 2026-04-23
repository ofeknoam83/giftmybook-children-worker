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

module.exports = {
  createBookDocument,
  withStageResult,
  updateSpread,
  appendRetryMemory,
  appendStageTrace,
  appendLlmCall,
  setResult,
};
