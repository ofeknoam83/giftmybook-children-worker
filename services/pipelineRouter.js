/**
 * Book pipeline routing — v3 is the only pipeline (W12 deletion).
 *
 * bookPipeline (v1) and bookPipelineV2 were deleted after the W11 cutover;
 * every book routes to services/bookPipelineV3. This resolver survives as
 * the single place that:
 *
 *   - maps legacy state onto v3 LOUDLY instead of crashing: a retried book
 *     whose checkpoint recorded 'v1'/'v2' restarts on v3 (the legacy
 *     checkpoint has no v3 artifacts, so the run is simply fresh), and the
 *     old BOOK_PIPELINE_V2/V3 kill-switch envs log a warning and are
 *     ignored — there is nothing left to revert to;
 *   - keeps the `source` provenance ('checkpoint' | 'request' | 'default')
 *     that callbacks and logs report;
 *   - fails loudly (PIPELINE_V3_UNAVAILABLE) if the v3 module is missing —
 *     with the legacy engines gone, a worker without v3 cannot generate at
 *     all, and pretending otherwise would 202 then brick the book.
 *
 * Note the /generate-book validation rejects non-picture_book formats and
 * pipelineVersion values other than 'v3' with a 400 before this runs.
 */

const path = require('path');

const V3_MODULE = 'bookPipelineV3';

/**
 * @returns {boolean} true when services/bookPipelineV3 is deployed on this worker
 */
function isV3Available() {
  try {
    require.resolve(path.join(__dirname, V3_MODULE));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the pipeline for a run. Always v3; `source` records why.
 *
 * @param {object} opts
 * @param {string} opts.format - normalized book format (always 'picture_book' post-validation)
 * @param {(string|null)} [opts.requestedVersion] - explicit `pipelineVersion` from the request payload
 * @param {(string|null)} [opts.checkpointVersion] - pipeline version persisted in the book's checkpoint
 * @param {(msg: string) => void} [opts.log] - warn-level logger for legacy-state decisions
 * @param {boolean} [opts.v3Available] - test seam; defaults to a real require.resolve check
 * @returns {{ version: 'v3', moduleName: string, modulePath: string, source: string }}
 * @throws {Error} code PIPELINE_V3_UNAVAILABLE when the v3 module is not deployed
 */
function resolveBookPipeline({
  format,
  requestedVersion = null,
  checkpointVersion = null,
  log = (msg) => console.warn(`[pipelineRouter] ${msg}`),
  v3Available,
} = {}) {
  const hasV3 = typeof v3Available === 'boolean' ? v3Available : isV3Available();
  if (!hasV3) {
    const err = new Error('services/bookPipelineV3 is not deployed on this worker and the legacy pipelines were deleted — cannot generate');
    err.code = 'PIPELINE_V3_UNAVAILABLE';
    throw err;
  }

  if (process.env.BOOK_PIPELINE_V2 === 'off' || process.env.BOOK_PIPELINE_V3 === 'off') {
    log('BOOK_PIPELINE_V2/V3 kill-switch env is set but the legacy pipelines were deleted (W12) — ignoring, running v3. Remove the stale env var.');
  }

  if (format !== 'picture_book') {
    // Defense-in-depth only: validation 400s retired formats before dispatch.
    log(`format=${format} reached the pipeline router — retired format should have been rejected upstream; running v3`);
  }

  if (checkpointVersion && checkpointVersion !== 'v3') {
    log(`checkpoint recorded pipeline '${checkpointVersion}' but the legacy pipelines were deleted — restarting this book on v3 (no legacy artifacts are reused)`);
  }
  if (requestedVersion && requestedVersion !== 'v3') {
    // Unreachable in practice: /generate-book 400s non-'v3' values.
    log(`requested pipeline '${requestedVersion}' is retired — running v3`);
  }

  const source = checkpointVersion === 'v3' ? 'checkpoint' : requestedVersion === 'v3' ? 'request' : 'default';
  return {
    version: 'v3',
    moduleName: V3_MODULE,
    modulePath: path.join(__dirname, V3_MODULE),
    source,
  };
}

module.exports = { resolveBookPipeline, isV3Available };
