/**
 * Review-queue payload — the structured `needs_review` contract (design
 * doc §7, cutover plan W2).
 *
 * A book that V3 refuses to ship terminates as `needs_review` instead of
 * a bare failure. The payload built here rides:
 *   1. on the V3ExhaustionError / PipelineError (`err.needsReview`),
 *   2. into the GCS checkpoint (`checkpoint.needsReview`) so resolution
 *      endpoints can act on it after the process is gone,
 *   3. through the failure callback + reportError into the main app's
 *      `generationProgress`, where the admin review dashboard reads it.
 *
 * Producers (wired incrementally):
 *   - writerQa: judge_panel_exhausted (this milestone)
 *   - identityKit / spreadQa / bookPass: native-illustrator exhaustions (W10)
 */

/** Known producer reasons — keep in sync with the admin dashboard copy. */
const NEEDS_REVIEW_REASONS = new Set([
  'judge_panel_exhausted',
  'identity_kit_exhausted',
  'spread_qa_exhausted',
  'book_pass_exhausted',
  'art_direction_unstageable',
]);

/**
 * Build the normalized needs_review payload.
 *
 * @param {object} opts
 * @param {string} opts.stage - pipeline stage that gave up (e.g. 'writerQa', 'spreadQa')
 * @param {string} opts.reason - machine reason (see NEEDS_REVIEW_REASONS)
 * @param {number|null} [opts.spread] - spread number for spread-level items
 * @param {string[]} [opts.defects] - human-readable defect summaries
 * @param {object|null} [opts.judgeScores] - final judge/panel score summary
 * @param {string[]} [opts.candidateUrls] - candidate image URLs (spread-level items)
 * @param {object[]} [opts.manuscriptHistory] - manuscript attempts (id, title, scores)
 * @param {object[]} [opts.judgeHistory] - panel rounds (raw aggregates)
 * @returns {object} normalized payload (JSON-safe)
 */
function buildNeedsReviewPayload({
  stage,
  reason,
  spread = null,
  defects = [],
  judgeScores = null,
  candidateUrls = [],
  manuscriptHistory = [],
  judgeHistory = [],
} = {}) {
  if (!stage) throw new Error('buildNeedsReviewPayload: stage is required');
  if (!reason) throw new Error('buildNeedsReviewPayload: reason is required');
  if (!NEEDS_REVIEW_REASONS.has(reason)) {
    // Loud but not fatal — a new producer should extend the set, not crash a book.
    console.warn(`[reviewQueue] unknown needs_review reason '${reason}' — add it to NEEDS_REVIEW_REASONS`);
  }
  return {
    version: 1,
    stage,
    reason,
    spread: Number.isFinite(spread) ? spread : null,
    defects: (defects || []).map((d) => String(d)).slice(0, 50),
    judgeScores: judgeScores || null,
    candidateUrls: (candidateUrls || []).map((u) => String(u)).slice(0, 20),
    manuscriptHistory: manuscriptHistory || [],
    judgeHistory: judgeHistory || [],
    createdAt: new Date().toISOString(),
  };
}

/** Valid resolution actions the /v3/review endpoints accept. */
const REVIEW_ACTIONS = new Set(['ship_best', 'regen_manuscript', 'pick_candidate', 'regen_spread', 'pick_sheet']);

/**
 * Build the resolution record persisted into the checkpoint by the
 * /v3/review/* endpoints and consumed by the workflow on the next run.
 *
 * @param {{action: string, note?: string, spread?: number, candidateUrl?: string, admin?: string}} opts
 * @returns {object}
 */
function buildReviewResolution({ action, note = null, spread = null, candidateUrl = null, admin = null } = {}) {
  if (!REVIEW_ACTIONS.has(action)) throw new Error(`buildReviewResolution: unknown action '${action}'`);
  return {
    action,
    note: note ? String(note).slice(0, 2000) : null,
    spread: Number.isFinite(spread) ? spread : null,
    candidateUrl: candidateUrl ? String(candidateUrl) : null,
    admin: admin || null,
    resolvedAt: new Date().toISOString(),
  };
}

module.exports = {
  buildNeedsReviewPayload,
  buildReviewResolution,
  NEEDS_REVIEW_REASONS,
  REVIEW_ACTIONS,
};
