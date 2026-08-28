/**
 * Catalog-engine feature flags (V1.3 staged-rollout gates).
 *
 * All default OFF — the handoff's launch posture: fixed-plot generation with
 * name/pronoun personalization only, until the per-book sidecars (selection
 * profiles + personalization maps) are editorially approved.
 *
 * Each flag is independently reversible via Cloud Run env, no redeploy of
 * code required:
 *  - CATALOG_FIT_RANKING=1        — score candidates by profile fit instead of
 *                                   seeded variety-only selection.
 *  - CATALOG_PERSONALIZATION_MAPS=1 — books WITH an approved map generate with
 *                                   deep personalization; books without stay
 *                                   name-only regardless of the flag.
 *  - CATALOG_EVIDENCE_REQUIRED=1  — a deep-personalized response missing
 *                                   personalization_evidence fails validation
 *                                   (always on for map-mode books; this flag
 *                                   additionally hard-fails empty evidence
 *                                   when usable details existed).
 */

function envOn(name) {
  const v = process.env[name];
  return v === '1' || v === 'true';
}

module.exports = {
  fitRankingEnabled: () => envOn('CATALOG_FIT_RANKING'),
  personalizationMapsEnabled: () => envOn('CATALOG_PERSONALIZATION_MAPS'),
  evidenceRequired: () => envOn('CATALOG_EVIDENCE_REQUIRED'),
};
