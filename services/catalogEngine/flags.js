/**
 * Catalog-engine feature switches.
 *
 * Everything is ON by default — the full V1.3 behavior ships out of the box:
 * fit-weighted plot selection, per-book deep personalization (all 228 books
 * carry an approved sidecar), and the evidence requirement. Each switch is
 * a KILL-SWITCH: set the env to `0` (or `false`) on the Cloud Run revision
 * to disable that behavior without a redeploy.
 *
 *  - CATALOG_FIT_RANKING=0        — fall back to seeded variety-only selection
 *                                   (no profile-fit scoring).
 *  - CATALOG_PERSONALIZATION_MAPS=0 — every book generates NAME-ONLY
 *                                   (personalization maps ignored).
 *  - CATALOG_EVIDENCE_REQUIRED=0  — stop hard-failing responses that ignore
 *                                   usable details despite approved slots.
 *  - CATALOG_TUNING_LAYER=0       — ignore any writerTuning overlay sent by
 *                                   the main app (stories render on the bare
 *                                   locked engine prompt).
 *  - CATALOG_OVERLAY=0            — ignore any admin catalog overlay (plots
 *                                   serve from the frozen catalog.json file
 *                                   only; activation endpoints refuse).
 *  - CATALOG_STYLE_POLISH=0       — skip the style-polish pass (the extra
 *                                   focused call that rewrites prose of an
 *                                   already-validated story to satisfy the
 *                                   tuning rules; only runs when an overlay
 *                                   is pinned).
 *
 * Note: a book WITHOUT an approved map always generates name-only regardless
 * of these switches — maps are never fabricated at runtime.
 */

function envOff(name) {
  const v = process.env[name];
  return v === '0' || v === 'false';
}

module.exports = {
  fitRankingEnabled: () => !envOff('CATALOG_FIT_RANKING'),
  personalizationMapsEnabled: () => !envOff('CATALOG_PERSONALIZATION_MAPS'),
  evidenceRequired: () => !envOff('CATALOG_EVIDENCE_REQUIRED'),
  tuningLayerEnabled: () => !envOff('CATALOG_TUNING_LAYER'),
  stylePolishEnabled: () => !envOff('CATALOG_STYLE_POLISH'),
  catalogOverlayEnabled: () => !envOff('CATALOG_OVERLAY'),
};
