/**
 * services/bookPipelineV2 — public entry.
 *
 * Same shape as services/bookPipeline (v1):
 *   const { generateBook, PipelineError } = require('./services/bookPipelineV2');
 *   const { document, layout } = await generateBook(rawRequest, opts);
 *
 * The `document` returned matches v1's canonical shape (spreads array
 * with manuscript + illustration + spec, plus storyBible/visualBible),
 * so the existing `toLegacyStoryPlan` adapter in v1 keeps working
 * without modification, and server.js's downstream PDF/upsell/cover
 * code is untouched.
 *
 * The cutover lives in server.js: when `format === 'picture_book'` and
 * `BOOK_PIPELINE_V2 !== 'off'`, this module is required instead of
 * services/bookPipeline. Early reader keeps v1 (it is not a picture
 * book per the design doc). Chapter books and graphic novels are not
 * touched by either path.
 */

const { runCreateBookWorkflow } = require('./orchestration/workflows/createBook.workflow');

class PipelineError extends Error {
  constructor(message, { failureCode, stage, issues, tags } = {}) {
    super(message);
    this.name = 'PipelineError';
    this.failureCode = failureCode || null;
    this.stage = stage || null;
    this.issues = issues || [];
    this.tags = tags || [];
  }
}

/**
 * Public API matching v1.
 *
 * @param {object} rawRequest — server.js's pipelineRequest shape (sanitized + bookId, format, theme, child, customDetails, cover)
 * @param {object} opts
 * @param {string} [opts.bookId]
 * @param {AbortSignal} [opts.abortSignal]
 * @param {function} [opts.touchActivity]
 * @param {function} [opts.onProgress]
 * @returns {Promise<{document: object, layout: object}>}
 */
async function generateBook(rawRequest, opts = {}) {
  const log = (level, msg, meta) => {
    const line = `[bookPipelineV2] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };

  // Inject bookId from opts if rawRequest didn't carry one.
  const requestWithBookId = rawRequest?.bookId
    ? rawRequest
    : { ...rawRequest, bookId: opts.bookId || `book_${Date.now()}` };

  try {
    const { document, layout, artifacts } = await runCreateBookWorkflow({
      rawRequest: requestWithBookId,
      signals: {
        abortSignal: opts.abortSignal,
        touchActivity: opts.touchActivity,
        onProgress: opts.onProgress,
      },
      log,
    });
    log('info', `done. ${artifacts?.length || 0} artifacts persisted.`);
    return { document, layout };
  } catch (err) {
    if (err && err.name === 'WorkflowAbortError') {
      throw new PipelineError(err.message || 'workflow aborted', {
        failureCode: 'aborted', stage: 'workflow',
      });
    }
    if (err && err.name === 'ActivityFailedError') {
      throw new PipelineError(err.message, {
        failureCode: 'activity_failed',
        stage: err.activityName || 'unknown',
        issues: [String(err.cause?.message || err.cause || err.message)],
      });
    }
    throw new PipelineError(err?.message || 'v2 pipeline failed', {
      failureCode: 'unknown',
      stage: 'workflow',
      issues: [String(err?.stack || err)],
    });
  }
}

module.exports = {
  generateBook,
  PipelineError,
};
