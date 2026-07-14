/**
 * Native V3 illustrator — configuration + version resolution (milestone 2
 * Phase 0, docs/ILLUSTRATOR_V3_MILESTONE2_PLAN.md).
 *
 * The native illustrator replaces the legacy v1 quad adapter behind a flag:
 *   BOOK_PIPELINE_V3_ILLUSTRATOR = native | legacy   (deploy default)
 *   request.illustratorVersion   = native | legacy   (per-book override,
 *     admin test path; validated 400 in server.js)
 *
 * Precedence mirrors pipelineVersion routing: checkpoint → request → env →
 * default. A book that started rendering on one illustrator finishes on it.
 */

const ILLUSTRATOR_VERSIONS = new Set(['native', 'legacy']);

/** Deploy default until the native path passes the Phase C validation gate. */
const DEFAULT_ILLUSTRATOR = 'legacy';

/**
 * Progress sub-steps the native illustrator reports (all inside the
 * existing `illustrating` band so the admin progress bar keeps working;
 * the S3 cutover PR upgrades the client stepper to these keys).
 */
const ILLUSTRATOR_STEPS = ['identity_kit', 'art_direction', 'rendering', 'spread_qa', 'book_pass'];

// ── Image renderer models ──
// Image generation is not a text-LLM role, so renderer models resolve here
// (not in llm/modelRouter). Same env-override spirit; upgrade seam for
// Gemini 3 Pro Image when provisioned.
const SHEET_RENDERER_MODEL = process.env.BOOK_PIPELINE_V3_SHEET_RENDERER_MODEL || 'gemini-3.1-flash-image';
const SPREAD_RENDERER_MODEL = process.env.BOOK_PIPELINE_V3_SPREAD_RENDERER_MODEL || 'gemini-3.1-flash-image';

// ── Bounded budgets (plan §5 — no unbounded loop exists on the native path) ──
const SHEET_BEST_OF = 3;          // character-sheet candidates per wave
const SHEET_EXTRA_WAVES = 1;      // one fresh wave, then needs_review
const CANDIDATES_PER_SPREAD = 2;  // parallel candidates per spread
const REPAIR_WAVES_PER_SPREAD = 1; // one defect-named repair wave, then needs_review
const ART_DIRECTION_REASKS = 1;   // one re-ask on shot-budget violation, then deterministic reassignment
const BOOK_PASS_REGEN_WAVES = 1;  // one targeted regen wave, then needs_review
const RENDER_CONCURRENCY = Number(process.env.BOOK_PIPELINE_V3_RENDER_CONCURRENCY || 6);

/**
 * Resolve which illustrator a run uses.
 *
 * @param {object} opts
 * @param {('native'|'legacy'|null)} [opts.requestedVersion] - request override (validated upstream)
 * @param {(string|null)} [opts.checkpointVersion] - illustrator persisted in the book checkpoint
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ version: 'native'|'legacy', source: 'checkpoint'|'request'|'env'|'default' }}
 */
function resolveIllustratorVersion({ requestedVersion = null, checkpointVersion = null, log = () => {} } = {}) {
  if (checkpointVersion && ILLUSTRATOR_VERSIONS.has(checkpointVersion)) {
    if (requestedVersion && requestedVersion !== checkpointVersion) {
      log(`illustrator '${requestedVersion}' requested but checkpoint pins '${checkpointVersion}' — resumes stay on the illustrator they started on`);
    }
    return { version: checkpointVersion, source: 'checkpoint' };
  }
  if (requestedVersion) {
    if (!ILLUSTRATOR_VERSIONS.has(requestedVersion)) {
      // server.js 400s invalid request values before the 202; this is a
      // second line of defense for internal callers.
      throw Object.assign(
        new Error(`Unsupported illustratorVersion '${requestedVersion}' — expected 'native' or 'legacy'`),
        { code: 'ILLUSTRATOR_VERSION_INVALID' },
      );
    }
    return { version: requestedVersion, source: 'request' };
  }
  const env = process.env.BOOK_PIPELINE_V3_ILLUSTRATOR;
  if (env) {
    if (ILLUSTRATOR_VERSIONS.has(env)) return { version: env, source: 'env' };
    log(`BOOK_PIPELINE_V3_ILLUSTRATOR='${env}' is not 'native'|'legacy' — using default '${DEFAULT_ILLUSTRATOR}'`);
  }
  return { version: DEFAULT_ILLUSTRATOR, source: 'default' };
}

module.exports = {
  ILLUSTRATOR_VERSIONS,
  DEFAULT_ILLUSTRATOR,
  ILLUSTRATOR_STEPS,
  SHEET_RENDERER_MODEL,
  SPREAD_RENDERER_MODEL,
  SHEET_BEST_OF,
  SHEET_EXTRA_WAVES,
  CANDIDATES_PER_SPREAD,
  REPAIR_WAVES_PER_SPREAD,
  ART_DIRECTION_REASKS,
  BOOK_PASS_REGEN_WAVES,
  RENDER_CONCURRENCY,
  resolveIllustratorVersion,
};
