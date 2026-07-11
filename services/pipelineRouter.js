/**
 * Book pipeline version routing — single place that decides which generation
 * engine a /generate-book run uses.
 *
 * Precedence (mirrors getIllustrationRenderer in bookPipeline/constants.js):
 *   1. BOOK_PIPELINE_V2=off  → v1 for everything (AA-CW-29 emergency revert).
 *   2. BOOK_PIPELINE_V3=off  → v3 never runs, even if requested (kill switch).
 *   3. BOOK_PIPELINE_V3=on   → v3 when deployed; loud fallback to v2 when the
 *      module is missing (an env var set ahead of a deploy must not brick
 *      every customer picture book).
 *   4. Checkpoint version    → a book that started on a pipeline finishes on it,
 *      even when retried without the request flag.
 *   5. Requested version     → explicit 'v2' | 'v3' from the payload (admin test
 *      path). An explicit 'v3' with no deployed module THROWS
 *      PIPELINE_V3_UNAVAILABLE — a silent v2 run would poison A/B comparisons.
 *   6. Default               → v2 for picture books (AA-CW-29 hard cutover),
 *      v1 otherwise.
 *
 * Version selection is a picture-book concern: v3 is scoped to picture books
 * (docs/PIPELINE_V3_DESIGN.md D1) and early readers stay on v1, so for other
 * formats any requested version is logged and ignored.
 */

const path = require('path');

const MODULES = {
  v1: 'bookPipeline',
  v2: 'bookPipelineV2',
  v3: 'bookPipelineV3',
};

/**
 * @returns {boolean} true when services/bookPipelineV3 is deployed on this worker
 */
function isV3Available() {
  try {
    require.resolve(path.join(__dirname, MODULES.v3));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {'v1'|'v2'|'v3'} version
 * @param {'env'|'checkpoint'|'request'|'default'} source
 * @returns {{ version: string, moduleName: string, modulePath: string, source: string }}
 */
function pick(version, source) {
  return {
    version,
    moduleName: MODULES[version],
    modulePath: path.join(__dirname, MODULES[version]),
    source,
  };
}

/**
 * Resolve which book pipeline a run should use.
 *
 * @param {object} opts
 * @param {string} opts.format - normalized book format (e.g. 'picture_book', 'early_reader')
 * @param {('v2'|'v3'|null)} [opts.requestedVersion] - explicit `pipelineVersion` from the request payload
 * @param {(string|null)} [opts.checkpointVersion] - pipeline version persisted in the book's checkpoint
 * @param {(msg: string) => void} [opts.log] - warn-level logger for override/fallback decisions
 * @param {boolean} [opts.v3Available] - test seam; defaults to a real require.resolve check
 * @returns {{ version: string, moduleName: string, modulePath: string, source: string }}
 * @throws {Error} code PIPELINE_V3_UNAVAILABLE when v3 is explicitly requested but not deployed
 */
function resolveBookPipeline({
  format,
  requestedVersion = null,
  checkpointVersion = null,
  log = (msg) => console.warn(`[pipelineRouter] ${msg}`),
  v3Available,
} = {}) {
  const hasV3 = typeof v3Available === 'boolean' ? v3Available : isV3Available();

  // 1. Emergency revert: everything back on v1, no exceptions.
  if (process.env.BOOK_PIPELINE_V2 === 'off') {
    if (requestedVersion || checkpointVersion) {
      log(`BOOK_PIPELINE_V2=off overrides requested pipeline '${checkpointVersion || requestedVersion}' — using v1`);
    }
    return pick('v1', 'env');
  }

  if (format !== 'picture_book') {
    if (requestedVersion || checkpointVersion) {
      log(`pipeline version '${checkpointVersion || requestedVersion}' requested but format=${format} does not support version selection — using default`);
    }
    return pick('v1', 'default');
  }

  const v3Env = process.env.BOOK_PIPELINE_V3;

  // 2. Kill switch beats any request.
  if (v3Env === 'off') {
    if (checkpointVersion === 'v3' || requestedVersion === 'v3') {
      log('pipeline v3 requested but disabled by BOOK_PIPELINE_V3=off — using v2');
      return pick('v2', 'env');
    }
    return pick('v2', checkpointVersion === 'v2' ? 'checkpoint' : requestedVersion === 'v2' ? 'request' : 'default');
  }

  // 3. Global force-on: never brick customer books over a missing module.
  if (v3Env === 'on') {
    if (hasV3) return pick('v3', 'env');
    log('BOOK_PIPELINE_V3=on but services/bookPipelineV3 is missing — FALLING BACK to bookPipelineV2');
    return pick('v2', 'env');
  }

  // 4-5. Checkpoint wins over request so resumes stay on the same pipeline.
  const wanted = checkpointVersion || requestedVersion;
  const source = checkpointVersion ? 'checkpoint' : 'request';
  if (wanted === 'v3') {
    if (hasV3) return pick('v3', source);
    const err = new Error("pipelineVersion 'v3' requested but services/bookPipelineV3 is not deployed on this worker");
    err.code = 'PIPELINE_V3_UNAVAILABLE';
    throw err;
  }
  if (wanted === 'v2') return pick('v2', source);
  // Checkpoints written during a BOOK_PIPELINE_V2=off window record 'v1'.
  if (wanted === 'v1') return pick('v1', source);

  // 6. Today's behavior (AA-CW-29 hard cutover).
  return pick('v2', 'default');
}

module.exports = { resolveBookPipeline, isV3Available };
