/**
 * bookPipeline — new children book generation pipeline.
 *
 * Single public entry point: `generateBook`. Owns the full lifecycle:
 *   0. normalize request              (input/normalizeRequest)
 *   1. detect cover composition       (planner/detectCoverComposition)
 *   2. create storyBible              (planner/createStoryBible)
 *   3. create visualBible             (planner/createVisualBible)
 *   4. create spreadSpecs             (planner/createSpreadSpecs)
 *   5. draft manuscript               (writer/draftBookText)
 *   6. writer QA + targeted rewrites  (writer/rewriteBookText + qa/checkWriterDraft)
 *   7. render spreads in order        (illustrator/renderSpread + continuityMemory)
 *   8. per-spread QA + repair         (qa/checkSpread + qa/planRepair)
 *   9. book-wide QA + late repair     (qa/checkBookWide + qa/planRepair)
 *  10. layout adapter + callbacks     (adapters/toLayoutPayload)
 *
 * The external API contract (`/generate-book` in server.js) stays stable.
 * This module replaces the internals end-to-end.
 */

const {
  createBookDocument,
  withStageResult,
  appendStageTrace,
  appendRetryMemory,
  setResult,
} = require('./schema/bookDocument');
const { buildRetryEntry } = require('./retryMemory');

const {
  validateInput,
  validateStoryBible,
  validateVisualBible,
  validateSpreadSpecs,
  validateManuscript,
  validateAllIllustrations,
} = require('./schema/validateBookDocument');

const { FAILURE_CODES, getIllustrationRenderer } = require('./constants');

const { normalizeRequest } = require('./input/normalizeRequest');
const { detectCoverComposition } = require('./planner/detectCoverComposition');
const { createStoryBible } = require('./planner/createStoryBible');
const { createVisualBible } = require('./planner/createVisualBible');
const { createSpreadSpecs } = require('./planner/createSpreadSpecs');
const { draftBookText } = require('./writer/draftBookText');
const { writerQaAndRewrite } = require('./writer/rewriteBookText');
const { renderAllSpreads } = require('./illustrator/renderAllSpreads');
const { renderAllSpreadsQuad } = require('./illustrator/renderAllSpreadsQuad');
const { runBookWideQa } = require('./qa/checkBookWide');
const { validateRecurringProps } = require('./qa/validateRecurringProps');
const { toLayoutPayload } = require('./adapters/toLayoutPayload');

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
 * Report pipeline progress through whatever callback the server attached,
 * and always emit a local console log so Cloud Logging shows every stage
 * transition even without a progress callback.
 *
 * @param {object} doc
 * @param {{ step: string, message?: string, progress?: number }} event
 */
function reportProgress(doc, event) {
  try {
    doc?.operationalContext?.touchActivity?.();
  } catch {
    /* ignore — activity hooks must not break the pipeline */
  }
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
 * How many times a planner stage will retry on a gate (validator) failure
 * before throwing PLAN_UNRESOLVABLE. Total attempts = 1 + PLAN_GATE_RETRIES.
 *
 * Why 2: the planner stages (storyBible, visualBible, spreadSpecs) are LLM
 * calls with non-trivial validators. Empirically a single bad sample is
 * common; a second sample that has been told what to fix succeeds the vast
 * majority of the time. Capping at 2 retries (3 total attempts) keeps the
 * tail latency bounded while eliminating one-shot fragility.
 */
const PLAN_GATE_RETRIES = 2;

/**
 * Run one stage, append a trace record, and fail fast with a structured
 * PipelineError if the stage output does not satisfy its acceptance gate.
 *
 * On gate failure (validator returns issues), the stage may retry up to
 * `opts.gateRetries` times. Each retry pushes a structured retryMemory
 * entry with the validator issues so the next LLM attempt can self-correct
 * (every planner prompt already renders selectRetryMemory(...) into the
 * user message via renderRetryMemoryForPrompt).
 *
 * @template T
 * @param {object} doc
 * @param {string} stageName
 * @param {(doc: object) => Promise<object>} run - takes current doc, returns updated book document
 * @param {(doc: object) => string[]} [gate]
 * @param {string} [failureCode]
 * @param {{ gateRetries?: number }} [opts]
 * @returns {Promise<object>}
 */
async function runStage(doc, stageName, run, gate, failureCode, opts = {}) {
  const gateRetries = Number.isFinite(opts.gateRetries) ? Math.max(0, opts.gateRetries) : 0;
  const bookId = doc?.operationalContext?.bookId || 'n/a';
  const started = Date.now();
  console.log(`[bookPipeline:${bookId}] stage '${stageName}' starting (gateRetries=${gateRetries})`);

  let workingDoc = doc;
  let lastIssues = [];
  for (let attempt = 1; attempt <= gateRetries + 1; attempt++) {
    assertNotAborted(workingDoc);
    const attemptStarted = Date.now();
    let next;
    try {
      next = await run(workingDoc);
    } catch (err) {
      console.error(`[bookPipeline:${bookId}] stage '${stageName}' attempt ${attempt} threw after ${Date.now() - attemptStarted}ms: ${err.message}`);
      // LLM/network errors are not gate-recoverable; surface immediately so
      // we don't burn the retry budget on infrastructure failures.
      throw new PipelineError(err.message || `${stageName} failed`, {
        stage: stageName,
        failureCode: err.failureCode || failureCode || FAILURE_CODES.UPSTREAM_UNAVAILABLE,
        issues: err.issues || [],
        tags: err.tags || [],
      });
    }
    if (gate) {
      const issues = gate(next) || [];
      if (issues.length === 0) {
        const durationMs = Date.now() - started;
        if (attempt > 1) {
          console.log(`[bookPipeline:${bookId}] stage '${stageName}' recovered on attempt ${attempt} in ${durationMs}ms`);
        } else {
          console.log(`[bookPipeline:${bookId}] stage '${stageName}' done in ${durationMs}ms`);
        }
        return appendStageTrace(next, { name: stageName, durationMs });
      }
      lastIssues = issues;
      console.warn(`[bookPipeline:${bookId}] stage '${stageName}' attempt ${attempt} gate failed: ${issues.join('; ')}`);
      if (attempt <= gateRetries) {
        // Push a structured retry-memory entry so the NEXT attempt's prompt
        // sees "prior attempt failed; must change <validator issues>".
        const entry = buildRetryEntry({
          stage: stageName,
          spreadNumber: null,
          failedAttemptNumber: attempt,
          failureTags: ['gate_failed'],
          mustChange: issues,
          mustPreserve: [],
          bannedRepeats: [],
        });
        // Carry forward the prior attempt's structural artifacts (e.g.
        // storyBible, traces) so retryMemory accumulates against the same
        // working doc — only the validator's complaint is added.
        workingDoc = appendRetryMemory(next, entry);
        continue;
      }
      // Exhausted retries.
      console.error(`[bookPipeline:${bookId}] stage '${stageName}' exhausted ${gateRetries + 1} attempts after ${Date.now() - started}ms`);
      throw new PipelineError(`${stageName} produced invalid output`, {
        stage: stageName,
        failureCode: failureCode || FAILURE_CODES.UPSTREAM_UNAVAILABLE,
        issues,
      });
    }
    // No gate — first attempt is authoritative.
    const durationMs = Date.now() - started;
    console.log(`[bookPipeline:${bookId}] stage '${stageName}' done in ${durationMs}ms`);
    return appendStageTrace(next, { name: stageName, durationMs });
  }
  // Unreachable, but keeps the analyzer happy.
  throw new PipelineError(`${stageName} produced invalid output`, {
    stage: stageName,
    failureCode: failureCode || FAILURE_CODES.UPSTREAM_UNAVAILABLE,
    issues: lastIssues,
  });
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
 * @param {() => void} [opts.touchActivity] - called on progress so server idle watchdogs stay reset during long runs
 * @returns {Promise<{ document: object, layout: object }>}
 */
async function generateBook(rawRequest, opts = {}) {
  const operationalContext = {
    onProgress: opts.onProgress,
    abortSignal: opts.abortSignal,
    bookId: opts.bookId || rawRequest?.bookId || 'n/a',
    touchActivity: typeof opts.touchActivity === 'function' ? opts.touchActivity : null,
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

  // Authoritative cover composition detection. Runs BEFORE storyBible/
  // visualBible so every downstream stage reads a verified
  // brief.coverParentPresent. Failure mode is safe (false fallback) — see
  // detectCoverComposition for precedence rules.
  reportProgress(doc, { step: 'planning', message: 'Detecting cover composition' });
  doc = await runStage(doc, 'coverComposition', d => detectCoverComposition(d), null, FAILURE_CODES.PLAN_UNRESOLVABLE);

  // Planner stages get a bounded retry budget on gate (validator) failures.
  // Each retry pushes a structured retryMemory entry naming the validator's
  // complaint, which every planner prompt already injects via
  // renderRetryMemoryForPrompt. This eliminates the one-shot fragility
  // where a single bad LLM sample (e.g. a PB_INFANT bible with 3+
  // cinematicLocations) killed the whole generation.
  reportProgress(doc, { step: 'planning', message: 'Creating story bible' });
  doc = await runStage(
    doc,
    'storyBible',
    d => createStoryBible(d),
    validateStoryBible,
    FAILURE_CODES.PLAN_UNRESOLVABLE,
    { gateRetries: PLAN_GATE_RETRIES },
  );

  reportProgress(doc, { step: 'planning', message: 'Creating visual bible' });
  doc = await runStage(
    doc,
    'visualBible',
    d => createVisualBible(d),
    validateVisualBible,
    FAILURE_CODES.PLAN_UNRESOLVABLE,
    { gateRetries: PLAN_GATE_RETRIES },
  );

  reportProgress(doc, { step: 'planning', message: 'Creating spread specs' });
  doc = await runStage(
    doc,
    'spreadSpecs',
    d => createSpreadSpecs(d),
    validateSpreadSpecs,
    FAILURE_CODES.PLAN_UNRESOLVABLE,
    { gateRetries: PLAN_GATE_RETRIES },
  );

  // Recurring-props + ephemeral-budget validation (PR C, sections C.4b/C.5).
  // Soft gate: tags surface on `doc.recurringPropsQa` for telemetry and feed
  // into the book-wide review later. We do not block the pipeline here
  // because the visualBible has already been produced; we surface issues so
  // QA can flag them in admin and so future iterations can route into a
  // bible-repair step.
  try {
    const spreadSpecsForQa = (doc.spreads || []).map(s => s?.spec).filter(Boolean);
    const propsQa = validateRecurringProps({
      spreadSpecs: spreadSpecsForQa,
      visualBible: doc.visualBible,
    });
    doc = withStageResult(doc, { recurringPropsQa: propsQa });
    if (!propsQa.pass) {
      const bookId = doc.operationalContext?.bookId || doc.request?.bookId || 'n/a';
      console.warn(
        `[bookPipeline:${bookId}] recurringPropsQa flagged ${propsQa.issues.length} issue(s): ${propsQa.tags.join(', ')}`,
      );
    }
  } catch (err) {
    console.warn('[bookPipeline] recurringPropsQa threw, ignoring:', err?.message || err);
  }

  reportProgress(doc, { step: 'writing', message: 'Drafting manuscript' });
  doc = await runStage(doc, 'writerDraft', d => draftBookText(d), validateManuscript, FAILURE_CODES.WRITER_UNRESOLVABLE);

  reportProgress(doc, { step: 'writerQa', message: 'Reviewing and revising text' });
  doc = await runStage(doc, 'writerQa', d => writerQaAndRewrite(d), validateManuscript, FAILURE_CODES.WRITER_UNRESOLVABLE);

  // Emit the final text snapshot so the admin content tab can show the
  // full manuscript while illustrations render. Previously this only
  // happened at end-of-pipeline, leaving the content tab blank for ~5 min.
  reportProgress(doc, { step: 'writerQa', message: 'Manuscript ready', document: doc });

  reportProgress(doc, { step: 'illustrating', message: 'Rendering spreads' });
  doc = await runStage(
    doc,
    'illustration',
    async (d) => {
      const bookId = d.operationalContext?.bookId || d.request?.bookId || 'n/a';
      const ir = getIllustrationRenderer(d);
      const totalSpreads = d.spreads?.length ?? 0;
      console.log(
        `[bookPipeline:${bookId}] illustration renderer=${ir.renderer} (flagSource=${ir.source}, totalSpreads=${totalSpreads})`,
      );
      if (ir.renderer === 'quad') return renderAllSpreadsQuad(d);
      return renderAllSpreads(d);
    },
    validateAllIllustrations,
    FAILURE_CODES.SPREAD_UNRESOLVABLE,
  );

  reportProgress(doc, { step: 'bookWideQa', message: 'Reviewing the whole book' });
  doc = await runStage(doc, 'bookWideQa', d => runBookWideQa(d), null, FAILURE_CODES.BOOK_WIDE_UNRESOLVABLE);

  reportProgress(doc, { step: 'layout', message: 'Preparing layout payload' });
  const layout = toLayoutPayload(doc);
  doc = withStageResult(setResult(doc, 'success'), {});

  return { document: doc, layout };
}

module.exports = {
  generateBook,
  PipelineError,
  // Exported for unit testing the retry-with-memory plumbing in isolation
  // (PR N.2). Not part of the public pipeline contract.
  __testables: { runStage, PLAN_GATE_RETRIES },
};
