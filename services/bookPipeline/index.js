/**
 * bookPipeline — new children book generation pipeline.
 *
 * Single public entry point: `generateBook`. Owns the full lifecycle:
 *   0. normalize request              (input/normalizeRequest)
 *   1. create storyBible              (planner/createStoryBible)
 *   2. create visualBible             (planner/createVisualBible)
 *   3. create spreadSpecs             (planner/createSpreadSpecs)
 *   4. draft manuscript               (writer/draftBookText)
 *   5. writer QA + targeted rewrites  (writer/rewriteBookText + qa/checkWriterDraft)
 *   6. render spreads in order        (illustrator/renderSpread + continuityMemory)
 *   7. per-spread QA + repair         (qa/checkSpread + qa/planRepair)
 *   8. book-wide QA + late repair     (qa/checkBookWide + qa/planRepair)
 *   9. layout adapter + callbacks     (adapters/toLayoutPayload)
 *
 * The external API contract (`/generate-book` in server.js) stays stable.
 * This module replaces the internals end-to-end.
 */

const {
  createBookDocument,
  withStageResult,
  appendStageTrace,
  setResult,
} = require('./schema/bookDocument');

const {
  validateInput,
  validateStoryBible,
  validateVisualBible,
  validateSpreadSpecs,
  validateManuscript,
  validateAllIllustrations,
} = require('./schema/validateBookDocument');

const { FAILURE_CODES } = require('./constants');

const { normalizeRequest } = require('./input/normalizeRequest');
const { createStoryBible } = require('./planner/createStoryBible');
const { createVisualBible } = require('./planner/createVisualBible');
const { createSpreadSpecs } = require('./planner/createSpreadSpecs');
const { draftBookText } = require('./writer/draftBookText');
const { writerQaAndRewrite } = require('./writer/rewriteBookText');
const { renderAllSpreads } = require('./illustrator/renderAllSpreads');
const { runBookWideQa } = require('./qa/checkBookWide');
const { toLayoutPayload } = require('./adapters/toLayoutPayload');

class PipelineError extends Error {
  constructor(message, { failureCode, stage, issues } = {}) {
    super(message);
    this.name = 'PipelineError';
    this.failureCode = failureCode || null;
    this.stage = stage || null;
    this.issues = issues || [];
  }
}

/**
 * Report pipeline progress through whatever callback the server attached,
 * and always emit a local console log so Cloud Logging shows every stage
 * transition even without a progress callback.
 *
 * @param {object} doc
 * @param {{ step: string, message?: string, progress?: number }} event
 */
function reportProgress(doc, event) {
  const bookId = doc?.operationalContext?.bookId || 'n/a';
  const step = event?.step || 'stage';
  const message = event?.message || '';
  console.log(`[bookPipeline:${bookId}] ${step}${message ? ` — ${message}` : ''}`);
  try {
    const fn = doc?.operationalContext?.onProgress;
    if (typeof fn === 'function') fn(event);
  } catch {
    /* swallow — progress reporting must not break the pipeline */
  }
}

/**
 * Abort-aware gate used between stages.
 *
 * @param {object} doc
 */
function assertNotAborted(doc) {
  const signal = doc?.operationalContext?.abortSignal;
  if (signal?.aborted) {
    throw new PipelineError('pipeline aborted', { failureCode: FAILURE_CODES.UPSTREAM_UNAVAILABLE });
  }
}

/**
 * Run one stage, append a trace record, and fail fast with a structured
 * PipelineError if the stage output does not satisfy its acceptance gate.
 *
 * @template T
 * @param {object} doc
 * @param {string} stageName
 * @param {() => Promise<object>} run - returns the updated book document
 * @param {(doc: object) => string[]} [gate]
 * @param {string} [failureCode]
 * @returns {Promise<object>}
 */
async function runStage(doc, stageName, run, gate, failureCode) {
  assertNotAborted(doc);
  const bookId = doc?.operationalContext?.bookId || 'n/a';
  const started = Date.now();
  console.log(`[bookPipeline:${bookId}] stage '${stageName}' starting`);
  let next;
  try {
    next = await run();
  } catch (err) {
    console.error(`[bookPipeline:${bookId}] stage '${stageName}' threw after ${Date.now() - started}ms: ${err.message}`);
    throw new PipelineError(err.message || `${stageName} failed`, {
      stage: stageName,
      failureCode: err.failureCode || failureCode || FAILURE_CODES.UPSTREAM_UNAVAILABLE,
      issues: err.issues || [],
    });
  }
  if (gate) {
    const issues = gate(next) || [];
    if (issues.length > 0) {
      console.error(`[bookPipeline:${bookId}] stage '${stageName}' gate failed after ${Date.now() - started}ms: ${issues.join('; ')}`);
      throw new PipelineError(`${stageName} produced invalid output`, {
        stage: stageName,
        failureCode: failureCode || FAILURE_CODES.UPSTREAM_UNAVAILABLE,
        issues,
      });
    }
  }
  const durationMs = Date.now() - started;
  console.log(`[bookPipeline:${bookId}] stage '${stageName}' done in ${durationMs}ms`);
  const traced = appendStageTrace(next, { name: stageName, durationMs });
  return traced;
}

/**
 * Main public entry. Accepts the existing server payload, returns the
 * final layout-ready artifact plus metadata. Throws `PipelineError` with
 * a machine-readable `failureCode` on unrecoverable failures.
 *
 * @param {object} rawRequest - the payload currently passed to WriterEngine.generate
 * @param {object} [opts]
 * @param {(event: object) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.abortSignal]
 * @param {string} [opts.bookId]
 * @returns {Promise<{ document: object, layout: object }>}
 */
async function generateBook(rawRequest, opts = {}) {
  const operationalContext = {
    onProgress: opts.onProgress,
    abortSignal: opts.abortSignal,
    bookId: opts.bookId || rawRequest?.bookId || 'n/a',
  };

  reportProgress({ operationalContext }, { step: 'input', message: 'Normalizing request' });
  const normalized = await normalizeRequest(rawRequest, { operationalContext });

  let doc = createBookDocument({
    request: normalized.request,
    brief: normalized.brief,
    cover: normalized.cover,
    operationalContext,
  });

  const inputIssues = validateInput(doc);
  if (inputIssues.length > 0) {
    throw new PipelineError('invalid input', {
      stage: 'input',
      failureCode: inputIssues.some(i => i.startsWith('cover.')) ? FAILURE_CODES.COVER_MISSING : FAILURE_CODES.UPSTREAM_UNAVAILABLE,
      issues: inputIssues,
    });
  }
  doc = appendStageTrace(doc, { name: 'input', durationMs: 0 });

  reportProgress(doc, { step: 'planning', message: 'Creating story bible' });
  doc = await runStage(doc, 'storyBible', () => createStoryBible(doc), validateStoryBible, FAILURE_CODES.PLAN_UNRESOLVABLE);

  reportProgress(doc, { step: 'planning', message: 'Creating visual bible' });
  doc = await runStage(doc, 'visualBible', () => createVisualBible(doc), validateVisualBible, FAILURE_CODES.PLAN_UNRESOLVABLE);

  reportProgress(doc, { step: 'planning', message: 'Creating spread specs' });
  doc = await runStage(doc, 'spreadSpecs', () => createSpreadSpecs(doc), validateSpreadSpecs, FAILURE_CODES.PLAN_UNRESOLVABLE);

  reportProgress(doc, { step: 'writing', message: 'Drafting manuscript' });
  doc = await runStage(doc, 'writerDraft', () => draftBookText(doc), validateManuscript, FAILURE_CODES.WRITER_UNRESOLVABLE);

  reportProgress(doc, { step: 'writerQa', message: 'Reviewing and revising text' });
  doc = await runStage(doc, 'writerQa', () => writerQaAndRewrite(doc), validateManuscript, FAILURE_CODES.WRITER_UNRESOLVABLE);

  // Emit the final text snapshot so the admin content tab can show the
  // full manuscript while illustrations render. Previously this only
  // happened at end-of-pipeline, leaving the content tab blank for ~5 min.
  reportProgress(doc, { step: 'writerQa', message: 'Manuscript ready', document: doc });

  reportProgress(doc, { step: 'illustrating', message: 'Rendering spreads' });
  doc = await runStage(doc, 'illustration', () => renderAllSpreads(doc), validateAllIllustrations, FAILURE_CODES.SPREAD_UNRESOLVABLE);

  reportProgress(doc, { step: 'bookWideQa', message: 'Reviewing the whole book' });
  doc = await runStage(doc, 'bookWideQa', () => runBookWideQa(doc), null, FAILURE_CODES.BOOK_WIDE_UNRESOLVABLE);

  reportProgress(doc, { step: 'layout', message: 'Preparing layout payload' });
  const layout = toLayoutPayload(doc);
  doc = withStageResult(setResult(doc, 'success'), {});

  return { document: doc, layout };
}

module.exports = {
  generateBook,
  PipelineError,
};
