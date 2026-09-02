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
 *  - CATALOG_ART_TUNING_LAYER=0   — ignore any illustrationTuning overlay
 *                                   sent by the main app (spreads render on
 *                                   the bare scene + style prompts).
 *  - CATALOG_WORLD_PLATE=0        — skip the per-theme world reference plate
 *                                   (renders anchor on the cover alone; the
 *                                   world-law card still rides the prompts).
 *  - CATALOG_WORLD_QA=0           — skip the book-level world-consistency
 *                                   QA pass and its corrective re-renders
 *                                   (per-spread QA still runs).
 *  - CATALOG_PROP_CONTINUITY=0    — stop carrying the child's comfort
 *                                   object through spreads after its
 *                                   evidence spread (props appear only on
 *                                   their declared spreads again).
 *  - CATALOG_OUTFIT_LOCK=0        — stop deriving the per-anchor outfit
 *                                   spec and arming the renderer's outfit
 *                                   lock (renders fall back to "match the
 *                                   reference photo"). Also disables the
 *                                   per-spread outfit QA check (no pinned
 *                                   spec means nothing to verify against).
 *  - CATALOG_SHOT_PLAN=0          — stop assigning the deterministic
 *                                   per-spread composition (shot type,
 *                                   staging, placement) and its QA checks
 *                                   (renders compose freely again; the
 *                                   caller folds -sp0 into the render cache
 *                                   key so planned and plan-less renders
 *                                   never replay each other).
 *
 *  - CATALOG_CHARACTER_SHEET=0    — (ce-9) stop building the per-anchor
 *                                   CHARACTER MODEL SHEET (renders anchor on
 *                                   the cover alone; the outfit spec derives
 *                                   from the cover again, with inferred slots).
 *  - CATALOG_SHEET_REQUIRED=0     — (ce-9) let a book whose character sheet
 *                                   cannot be built render sheet-less with an
 *                                   advisory instead of failing needs_review.
 *  - CATALOG_PROP_SHEETS=0        — (ce-9) stop building prop / companion
 *                                   reference sheets (props ride as nouns).
 *  - CATALOG_EMOTION_PLAN=0       — (ce-9) stop pinning a per-spread emotion
 *                                   (cache fold -e0).
 *  - CATALOG_EMOTION_CLASSIFIER=0 — (ce-9) emotion plan from the keyword
 *                                   table only (no per-story classifier call).
 *  - CATALOG_CONTACT_QA=0         — (ce-9) skip the contact-sheet set gate
 *                                   (character/prop crops vs the sheets)
 *                                   and its re-renders; independent of
 *                                   CATALOG_WORLD_QA.
 *  - CATALOG_SHIP_ON_EXHAUSTION=1 — (ce-9, OPT-IN) ship a spread whose
 *                                   BLOCKING defects survived candidates +
 *                                   repairs with an advisory, instead of
 *                                   failing the book `consistency_unresolved`.
 *  - CATALOG_IDENTITY_METRICS=1   — (ce-9, OPT-IN) run the deterministic
 *                                   identity metrics (embedding similarity)
 *                                   beside vision QA; off until calibrated.
 *  - CATALOG_RENDER_CANDIDATES=N  — (ce-9) candidates rendered per spread
 *                                   and scored before selection (1-3, default 2).
 *  - CATALOG_DRIFT_MAX_REPAIRS=N  — (ce-9) extra corrective passes reserved
 *                                   for drift-class defects (0-4, default 2).
 *
 * Note: a book WITHOUT an approved map always generates name-only regardless
 * of these switches — maps are never fabricated at runtime.
 */

function envOff(name) {
  const v = process.env[name];
  return v === '0' || v === 'false';
}

/** Opt-in switch: only an explicit '1' / 'true' enables it. */
function envOn(name) {
  const v = process.env[name];
  return v === '1' || v === 'true';
}

/** Bounded integer knob with a default (non-integers / out-of-range ⇒ default). */
function envInt(name, def, min, max) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

module.exports = {
  fitRankingEnabled: () => !envOff('CATALOG_FIT_RANKING'),
  personalizationMapsEnabled: () => !envOff('CATALOG_PERSONALIZATION_MAPS'),
  evidenceRequired: () => !envOff('CATALOG_EVIDENCE_REQUIRED'),
  tuningLayerEnabled: () => !envOff('CATALOG_TUNING_LAYER'),
  stylePolishEnabled: () => !envOff('CATALOG_STYLE_POLISH'),
  catalogOverlayEnabled: () => !envOff('CATALOG_OVERLAY'),
  artTuningLayerEnabled: () => !envOff('CATALOG_ART_TUNING_LAYER'),
  worldPlateEnabled: () => !envOff('CATALOG_WORLD_PLATE'),
  worldQaEnabled: () => !envOff('CATALOG_WORLD_QA'),
  propContinuityEnabled: () => !envOff('CATALOG_PROP_CONTINUITY'),
  outfitLockEnabled: () => !envOff('CATALOG_OUTFIT_LOCK'),
  shotPlanEnabled: () => !envOff('CATALOG_SHOT_PLAN'),
  // ce-9 — the Book Bible + selection gate
  characterSheetEnabled: () => !envOff('CATALOG_CHARACTER_SHEET'),
  sheetRequired: () => !envOff('CATALOG_SHEET_REQUIRED'),
  propSheetsEnabled: () => !envOff('CATALOG_PROP_SHEETS'),
  emotionPlanEnabled: () => !envOff('CATALOG_EMOTION_PLAN'),
  emotionClassifierEnabled: () => !envOff('CATALOG_EMOTION_CLASSIFIER'),
  contactQaEnabled: () => !envOff('CATALOG_CONTACT_QA'),
  shipOnExhaustion: () => envOn('CATALOG_SHIP_ON_EXHAUSTION'),
  identityMetricsEnabled: () => envOn('CATALOG_IDENTITY_METRICS'),
  renderCandidates: () => envInt('CATALOG_RENDER_CANDIDATES', 2, 1, 3),
  driftMaxRepairs: () => envInt('CATALOG_DRIFT_MAX_REPAIRS', 2, 0, 4),
};
