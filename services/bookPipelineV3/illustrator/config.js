/**
 * Native V3 illustrator — configuration + version resolution.
 *
 * The native illustrator is the ONLY illustrator (cutover 2026-07-15; the
 * legacy v1 session/quad adapter was deleted). Version resolution survives
 * because checkpoints and requests written before the cutover may still say
 * 'legacy' — those map LOUDLY onto native instead of crashing, the same way
 * pipelineRouter maps v1/v2 checkpoints onto v3.
 */

const ILLUSTRATOR_VERSIONS = new Set(['native']);

/** The one illustrator. 'legacy' has no code behind it anymore. */
const DEFAULT_ILLUSTRATOR = 'native';

/**
 * Progress sub-steps the native illustrator reports (all inside the
 * existing `illustrating` band so the admin progress bar keeps working).
 */
const ILLUSTRATOR_STEPS = ['identity_kit', 'art_direction', 'rendering', 'spread_qa', 'book_pass'];

// ── Image renderer models ──
// Image generation is not a text-LLM role, so renderer models resolve here
// (not in llm/modelRouter). Same env-override spirit; upgrade seam for
// Gemini 3 Pro Image when provisioned.
const SHEET_RENDERER_MODEL = process.env.BOOK_PIPELINE_V3_SHEET_RENDERER_MODEL || 'gemini-3.1-flash-image';
const SPREAD_RENDERER_MODEL = process.env.BOOK_PIPELINE_V3_SPREAD_RENDERER_MODEL || 'gemini-3.1-flash-image';

// ── Bounded budgets (plan §5 — no unbounded loop exists on the native path) ──
// Sheet budgets are env-tunable (ops lever after an identity_kit_exhausted
// wave in production); defaults unchanged.
const SHEET_BEST_OF = Number(process.env.BOOK_PIPELINE_V3_SHEET_BEST_OF) >= 1
  ? Number(process.env.BOOK_PIPELINE_V3_SHEET_BEST_OF) : 3; // candidates per wave
const SHEET_EXTRA_WAVES = Number(process.env.BOOK_PIPELINE_V3_SHEET_EXTRA_WAVES) >= 0
  ? Number(process.env.BOOK_PIPELINE_V3_SHEET_EXTRA_WAVES) : 1; // defect-fed repair waves, then needs_review
const CANDIDATES_PER_SPREAD = 2;  // parallel candidates per spread
const REPAIR_WAVES_PER_SPREAD = 1; // one defect-named repair wave, then needs_review
const ART_DIRECTION_REASKS = 1;   // one re-ask on shot-budget violation, then deterministic reassignment
const BOOK_PASS_REGEN_WAVES = 1;  // one targeted regen wave, then needs_review
const RENDER_CONCURRENCY = Number(process.env.BOOK_PIPELINE_V3_RENDER_CONCURRENCY || 6);

/**
 * Resolve which illustrator a run uses. Always 'native' — this function's
 * remaining job is provenance (`source`) and loud handling of pre-cutover
 * 'legacy' state.
 *
 * @param {object} opts
 * @param {(string|null)} [opts.requestedVersion] - request override (validated 400 in server.js)
 * @param {(string|null)} [opts.checkpointVersion] - illustrator persisted in the book checkpoint
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ version: 'native', source: 'checkpoint'|'request'|'env'|'default' }}
 */
function resolveIllustratorVersion({ requestedVersion = null, checkpointVersion = null, log = () => {} } = {}) {
  if (checkpointVersion && ILLUSTRATOR_VERSIONS.has(checkpointVersion)) {
    return { version: checkpointVersion, source: 'checkpoint' };
  }
  if (checkpointVersion) {
    // Pre-cutover checkpoint (e.g. 'legacy'): the code it pinned is deleted.
    // Restart illustration on native — the manuscript still replays from the
    // checkpoint, only the render work is redone.
    log(`checkpoint pins illustrator '${checkpointVersion}' but that code was deleted in the native cutover — restarting illustration on 'native'`);
    return { version: DEFAULT_ILLUSTRATOR, source: 'default' };
  }
  if (requestedVersion) {
    if (!ILLUSTRATOR_VERSIONS.has(requestedVersion)) {
      // server.js 400s invalid request values before the 202; this is a
      // second line of defense for internal callers.
      throw Object.assign(
        new Error(`Unsupported illustratorVersion '${requestedVersion}' — 'native' is the only illustrator`),
        { code: 'ILLUSTRATOR_VERSION_INVALID' },
      );
    }
    return { version: requestedVersion, source: 'request' };
  }
  const env = process.env.BOOK_PIPELINE_V3_ILLUSTRATOR;
  if (env) {
    if (ILLUSTRATOR_VERSIONS.has(env)) return { version: env, source: 'env' };
    log(`BOOK_PIPELINE_V3_ILLUSTRATOR='${env}' is stale — the native illustrator is the only illustrator; ignoring`);
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
