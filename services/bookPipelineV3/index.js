/**
 * services/bookPipelineV3 — public entry (milestone 1: V3 writer + v1 illustrator).
 *
 * Same contract as v1/v2:
 *   const { generateBook, PipelineError } = require('./services/bookPipelineV3');
 *   const { document, layout } = await generateBook(rawRequest, opts);
 *
 * The returned `document` matches the v1 canonical shape (spreads with
 * manuscript + illustration + spec, storyBible/visualBible, writerQa/
 * bookWideQa) so toLegacyStoryPlan and server.js downstream code work
 * untouched. V3-native artifacts (concepts, judge reports, scene
 * contracts, cost ledger) ride along under `document.v3`.
 *
 * Routing lives in services/pipelineRouter.js: V3 runs only on explicit
 * request (`pipelineVersion: 'v3'`, the admin test path), a v3 checkpoint,
 * or BOOK_PIPELINE_V3=on. The mere existence of this module flips
 * isV3Available() — the /generate-book fail-fast 400 for explicit v3
 * requests disappears with this file deployed.
 *
 * NOTE the design intent (docs/PIPELINE_V3_DESIGN.md): no ship-anyway.
 * A manuscript the judge panel rejects after the whole exhaustion ladder
 * terminates the book as failureCode 'needs_review' (reason: judge_panel_exhausted)
 * with a structured reviewQueue payload — milestone 1
 * has no review queue, and V3 traffic is admin test books only.
 */

const { runCreateBookWorkflow, V3ExhaustionError } = require('./orchestration/workflows/createBook.workflow');
const { resolveRole, DEFAULT_ROUTING } = require('./llm/modelRouter');

class PipelineError extends Error {
  constructor(message, { failureCode, stage, issues, tags, needsReview } = {}) {
    super(message);
    this.name = 'PipelineError';
    this.failureCode = failureCode || null;
    this.stage = stage || null;
    this.issues = issues || [];
    this.tags = tags || [];
    // Structured review-queue payload (reviewQueue/payload.js). Present iff
    // failureCode === 'needs_review' — server.js persists it in the book
    // checkpoint and forwards it on the failure callbacks so the main app's
    // review dashboard can act on it (cutover plan W2/D6).
    this.needsReview = needsReview || null;
  }
}

// Progress steps server.js maps to progress bands (server.js stageBands).
// The workflow engine also emits raw artifact-key events ('brief',
// 'panel.main.r0', ...) which the server would map to a misleading default;
// this filter forwards only band-named events and any event carrying a
// document snapshot.
const BAND_STEPS = new Set(['input', 'planning', 'writing', 'writerQa', 'illustrating', 'bookWideQa', 'layout']);

function wrapOnProgress(onProgress) {
  if (typeof onProgress !== 'function') return undefined;
  return (event) => {
    if (!event) return;
    if (BAND_STEPS.has(event.step) || event.document) onProgress(event);
  };
}

/**
 * Fail fast — before any LLM spend — when the resolved routing needs an
 * API key the deploy doesn't have. No silent family fallback (the V3
 * prompts are family-tuned; a silent swap masks the config bug and
 * poisons pipeline A/B comparisons).
 */
const FAMILY_ENV_ALTERNATIVES = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_AI_STUDIO_KEY'],
};

function assertV3Config() {
  const missing = [];
  const families = new Set(Object.keys(DEFAULT_ROUTING).map((role) => resolveRole(role).family));
  for (const family of families) {
    const alternatives = FAMILY_ENV_ALTERNATIVES[family] || [];
    const satisfied = alternatives.some((k) => process.env[k] && String(process.env[k]).trim() !== '');
    if (!satisfied) missing.push(`${family} (${alternatives.join(' or ')})`);
  }
  if (missing.length) {
    throw new PipelineError(
      `bookPipelineV3 config missing API key(s) for routed model families: ${missing.join('; ')}. `
      + 'Set the key on the worker (or forward it via the request apiKeys) and retry — V3 never silently falls back to another family.',
      { failureCode: 'config_missing_api_key', stage: 'startup' },
    );
  }
}

/**
 * Public API matching v1/v2.
 *
 * @param {object} rawRequest — server.js's pipelineRequest shape
 * @param {object} opts — { bookId, abortSignal, touchActivity, onProgress }
 * @returns {Promise<{document: object, layout: object}>}
 */
async function generateBook(rawRequest, opts = {}) {
  const log = (level, msg, meta) => {
    const line = `[bookPipelineV3] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };

  assertV3Config();

  const requestWithBookId = rawRequest?.bookId
    ? rawRequest
    : { ...rawRequest, bookId: opts.bookId || `book_${Date.now()}` };

  try {
    const { document, layout, artifacts } = await runCreateBookWorkflow({
      rawRequest: requestWithBookId,
      signals: {
        abortSignal: opts.abortSignal,
        touchActivity: opts.touchActivity,
        onProgress: wrapOnProgress(opts.onProgress),
      },
      log,
    });
    log('info', `done. ${artifacts?.length || 0} artifacts persisted.`);
    return { document, layout };
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    if (err && err.name === 'V3ExhaustionError') {
      throw new PipelineError(err.message, {
        failureCode: 'needs_review',
        stage: 'writerQa',
        issues: err.issues,
        tags: ['needs_review', 'judge_panel_exhausted'],
        needsReview: err.needsReview || null,
      });
    }
    if (err && err.name === 'WorkflowAbortError') {
      throw new PipelineError(err.message || 'workflow aborted', {
        failureCode: 'aborted', stage: 'workflow',
      });
    }
    if (err && err.name === 'ActivityFailedError') {
      // The exhaustion error can surface wrapped by the engine when it
      // occurs inside an execute() — unwrap for the honest failure code.
      if (err.cause?.name === 'V3ExhaustionError') {
        throw new PipelineError(err.cause.message, {
          failureCode: 'needs_review',
          stage: 'writerQa',
          issues: err.cause.issues,
          tags: ['needs_review', 'judge_panel_exhausted'],
          needsReview: err.cause.needsReview || null,
        });
      }
      throw new PipelineError(err.message, {
        failureCode: 'activity_failed',
        stage: err.activityName || 'unknown',
        issues: [String(err.cause?.message || err.cause || err.message)],
      });
    }
    throw new PipelineError(err?.message || 'v3 pipeline failed', {
      failureCode: 'unknown',
      stage: 'workflow',
      issues: [String(err?.stack || err)],
    });
  }
}

module.exports = {
  generateBook,
  PipelineError,
  // exported for tests
  assertV3Config,
  wrapOnProgress,
  V3ExhaustionError,
};
