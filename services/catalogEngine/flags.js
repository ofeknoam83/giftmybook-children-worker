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
 *  - CATALOG_HUMAN_COMPANION_SHEET=0 — (ce-19) stop building the reference
 *                                   sheet + character spec for a PERSON-
 *                                   typed companion (Farmer Bea, Builder
 *                                   Sam): the companion rides as a noun
 *                                   again, unchecked, as before ce-19.
 *                                   Creature companion sheets unaffected.
 *  - CATALOG_EMOTION_PLAN=0       — (ce-9) stop pinning a per-spread emotion
 *                                   (cache fold -e0).
 *  - CATALOG_EMOTION_CLASSIFIER=0 — (ce-9) emotion plan from the keyword
 *                                   table only (no per-story classifier call).
 *  - CATALOG_CONTACT_QA=0         — (ce-9) skip the contact-sheet set gate
 *                                   (character/prop crops vs the sheets)
 *                                   and its re-renders; independent of
 *                                   CATALOG_WORLD_QA.
 *  - CATALOG_SHIP_ON_EXHAUSTION=0 — opt out of automatic best-art completion;
 *                                   stop for review when blocking findings
 *                                   survive the bounded candidate budget.
 *  - CATALOG_IDENTITY_METRICS=1   — (ce-9, OPT-IN) run the deterministic
 *                                   identity metrics (embedding similarity)
 *                                   beside vision QA; off until calibrated.
 *  - CATALOG_RENDER_CANDIDATES=N  — (ce-9) candidates rendered per spread
 *                                   and scored before selection (1-3, default 1).
 *  - CATALOG_DRIFT_MAX_REPAIRS=N  — (ce-9) extra corrective passes reserved
 *                                   for drift-class defects (0-4, default 0).
 *  - CATALOG_RENDER_BUDGET_PER_SPREAD=N — total automatic candidates per spread
 *                                   per run across all gates (1-12, default 3).
 *  - CATALOG_RENDER_CONCURRENCY=N — spreads rendered in parallel (1-8,
 *                                   default 6 — the refactor plan's key-pool
 *                                   sizing; each spread slot fans out into
 *                                   CATALOG_RENDER_CANDIDATES concurrent
 *                                   image calls). Also bounds the set gates'
 *                                   parallel corrective re-renders.
 *
 *  - CATALOG_TEXT_ANCHOR=0        — (ce-15) stop electing the book's own
 *                                   first painted page as the TYPOGRAPHY
 *                                   REFERENCE for its other embedded
 *                                   spreads (they render on the text rules
 *                                   alone; the caller folds -ta0 into the
 *                                   render cache key so anchored and
 *                                   anchor-less renders never replay each
 *                                   other).
 *
 *  - CATALOG_TEXT_ANCHOR_CANDIDATES=N — (ce-16) candidates rendered for the
 *                                   typography anchor page (1-4, default 1):
 *                                   the whole book copies the elected page's
 *                                   type size, with no extra rolls by default.
 *  - CATALOG_TYPOGRAPHY_GUIDE=0   — stop drawing the book's lettering
 *                                   (Playfair Display Regular, one numeric
 *                                   size per age tier, ONE dark ink) as a
 *                                   reference image; embedded spreads fall
 *                                   back to the ce-15 page-crop anchor.
 *  - CATALOG_TYPOGRAPHY_TEMPLATE=0 — disable the approved readable full-spread
 *                                   manuscript template for new books (the
 *                                   sample-column guide rides instead).
 *                                   Default is ON with 4K output.
 *                                   Retries retain saved artwork and size.
 *  - CATALOG_MIN_EMBEDDED_RENDER_HEIGHT=N — (2026-09-07) the pixel height an
 *                                   embedded render must reach or the
 *                                   attempt fails (illustrationGenerator's
 *                                   resolution guard). Unset: follows the
 *                                   requested tier (4K → 2000, 2K → 1000,
 *                                   1K → 500; nothing requested → off).
 *                                   0 disables; the measured size still
 *                                   rides every callback (`renders[].size`,
 *                                   `renderSizes`).
 *  - CATALOG_EMBEDDED_IMAGE_SIZE=2K — (ce-16, OPT-IN) request this output
 *                                   size ('1K'|'2K'|'4K') on embedded renders
 *                                   (more pixels per glyph keeps small
 *                                   painted text crisp); a model that rejects
 *                                   the field renders at its default. Folded
 *                                   into the render key as -is{size}.
 *
 *  - CATALOG_TEXT_INK_QA=0        — (ce-18) stop measuring the painted text's
 *                                   INK colour: no per-spread ink defect and
 *                                   no book-level ink gate (the pinned ink
 *                                   still rides every prompt).
 *  - CATALOG_TEXT_INK_MAX_RERENDERS=N — (ce-18) corrective re-renders the ink
 *                                   set gate may spend per run (0-4, default 2).
 *
 *  - CATALOG_GIFT_VIDEO=0          — (gv-1) disable the gift-video endpoints
 *                                   (`/v13/generate-video` answers 503).
 *  - CATALOG_VIDEO_PROVIDERS=a,b   — (gv-1) the providers an admin may select
 *                                   (default `replicate`; the first is the
 *                                   default when a request names none).
 *  - CATALOG_VIDEO_MODEL=id        — (gv-1) default model id for the default
 *                                   provider (default `kwaivgi/kling-v3-video`).
 *  - CATALOG_VIDEO_ELEMENTS=0      — (gv-1) stop attaching the identity kit as
 *                                   the video model's reference elements
 *                                   (start frame + prompt only).
 *  - CATALOG_VIDEO_SCENES=N        — (gv-2) illustrations the single take
 *                                   travels through (1-4, default 3) — the
 *                                   still-selection gate picks the best N.
 *  - CATALOG_VIDEO_END_FRAME=0     — (gv-2) stop sending the last picked
 *                                   still as the take's END frame (start
 *                                   frame + prompt only).
 *  - CATALOG_VIDEO_CLIP_CANDIDATES=N — (gv-1) candidate clips per take (1-3,
 *                                   default 1 since gv-2: ONE film per run).
 *  - CATALOG_VIDEO_CLIP_MAX_REPAIRS=N — (gv-1) repair passes while a BLOCKING
 *                                   defect remains (0-4, default 1 since gv-2).
 *  - CATALOG_VIDEO_CLIP_TIMEOUT_SECONDS=N — (gv-1) per-clip vendor deadline (60-1800, default 480).
 *  - CATALOG_VIDEO_MAX_CLIP_SECONDS=N — (gv-1) generated seconds allowed per film,
 *                                   candidates and repairs included (0-600,
 *                                   default 30 since gv-2: one 10 s take, one repair).
 *  - CATALOG_VIDEO_SHIP_ON_EXHAUSTION=1 — (gv-1, OPT-IN) stitch a segment whose
 *                                   BLOCKING defects survived every candidate
 *                                   and repair (advisory) instead of failing
 *                                   the film `video_unresolved`.
 *  - CATALOG_VIDEO_MUSIC=name      — (gv-1) music bed under data/video/music/
 *                                   (default `none`: a silent audio track).
 *
 * Note: a book WITHOUT an approved map always generates name-only regardless
 * of these switches — maps are never fabricated at runtime.
 */

const { renderTierFloor } = require('../shared/illustration/renderSize');

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

/** Bounded real-number knob with a default (unset / NaN / out-of-range ⇒ default). */
function envFloat(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
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
  // ce-19 — secondary characters: a person-typed companion gets a sheet too
  humanCompanionSheetEnabled: () => !envOff('CATALOG_HUMAN_COMPANION_SHEET'),
  emotionPlanEnabled: () => !envOff('CATALOG_EMOTION_PLAN'),
  emotionClassifierEnabled: () => !envOff('CATALOG_EMOTION_CLASSIFIER'),
  contactQaEnabled: () => !envOff('CATALOG_CONTACT_QA'),
  // Finish with the best existing candidate and retain its QA findings.
  // Explicit 0 is the opt-out for diagnostic runs that require a hard gate.
  shipOnExhaustion: () => !envOff('CATALOG_SHIP_ON_EXHAUSTION'),
  identityMetricsEnabled: () => envOn('CATALOG_IDENTITY_METRICS'),
  renderCandidates: () => envInt('CATALOG_RENDER_CANDIDATES', 1, 1, 3),
  driftMaxRepairs: () => envInt('CATALOG_DRIFT_MAX_REPAIRS', 0, 0, 4),
  renderBudgetPerSpread: () => envInt('CATALOG_RENDER_BUDGET_PER_SPREAD', 3, 1, 12),
  renderConcurrency: () => envInt('CATALOG_RENDER_CONCURRENCY', 6, 1, 8),
  // ce-15 — the typography anchor (the book's first painted page as the
  // type reference for its other embedded spreads)
  textAnchorEnabled: () => !envOff('CATALOG_TEXT_ANCHOR'),
  typographyGuideEnabled: () => !envOff('CATALOG_TYPOGRAPHY_GUIDE'),
  // Approved readable lettering is the default for new embedded books.
  // Explicitly disabling it does not invalidate already-saved templates.
  typographyTemplateEnabled: () => !envOff('CATALOG_TYPOGRAPHY_TEMPLATE'),
  textAnchorCandidates: () => envInt('CATALOG_TEXT_ANCHOR_CANDIDATES', 1, 1, 4),
  // ce-18 — the painted text's ink colour
  textInkQaEnabled: () => !envOff('CATALOG_TEXT_INK_QA'),
  textInkMaxRerenders: () => envInt('CATALOG_TEXT_INK_MAX_RERENDERS', 2, 0, 4),
  // 2026-09-07 — the drawn lettering template, HELD TO: every embedded
  // render is measured against the template it was given as its edit base
  // (metrics.templateConformance); below the floor the page DEPARTED from
  // it (blocking). The floor is a share of the template's glyphs painted
  // in place, calibrated on the ace1cc29 render (0.20) vs a preserved
  // template (≥ 0.97); tune it from the `templateConformance` field the
  // markers and callbacks carry, never blind.
  templateConformanceEnabled: () => !envOff('CATALOG_TEMPLATE_CONFORMANCE'),
  templateConformanceMin: () => envFloat('CATALOG_TEMPLATE_CONFORMANCE_MIN', 0.35, 0, 1),
  // 2026-09-07 — the resolution floor for embedded renders (see the header).
  minEmbeddedRenderHeight: (imageSize) => {
    const explicit = envInt('CATALOG_MIN_EMBEDDED_RENDER_HEIGHT', -1, 0, 8000);
    return explicit >= 0 ? explicit : renderTierFloor(imageSize);
  },
  embeddedImageSize: () => {
    const v = String(process.env.CATALOG_EMBEDDED_IMAGE_SIZE || '').trim().toUpperCase();
    return v === '1K' || v === '2K' || v === '4K' ? v : null;
  },
  // gv-1 — the gift video (docs/GIFT_VIDEO_PLAN.md §5.3)
  giftVideoEnabled: () => !envOff('CATALOG_GIFT_VIDEO'),
  videoProviders: () => String(process.env.CATALOG_VIDEO_PROVIDERS || 'replicate')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  videoModel: () => String(process.env.CATALOG_VIDEO_MODEL || 'kwaivgi/kling-v3-video').trim(),
  videoElementsEnabled: () => !envOff('CATALOG_VIDEO_ELEMENTS'),
  // gv-2 — one single-take film through the best stills
  videoSceneCount: () => envInt('CATALOG_VIDEO_SCENES', 3, 1, 4),
  videoEndFrameEnabled: () => !envOff('CATALOG_VIDEO_END_FRAME'),
  videoClipCandidates: () => envInt('CATALOG_VIDEO_CLIP_CANDIDATES', 1, 1, 3),
  videoClipMaxRepairs: () => envInt('CATALOG_VIDEO_CLIP_MAX_REPAIRS', 1, 0, 4),
  videoClipTimeoutSeconds: () => envInt('CATALOG_VIDEO_CLIP_TIMEOUT_SECONDS', 480, 60, 1800),
  videoMaxClipSeconds: () => envInt('CATALOG_VIDEO_MAX_CLIP_SECONDS', 30, 0, 600),
  videoShipOnExhaustion: () => envOn('CATALOG_VIDEO_SHIP_ON_EXHAUSTION'),
  videoMusic: () => String(process.env.CATALOG_VIDEO_MUSIC || 'none').trim() || 'none',
  // ab-1 — the audiobook (docs/AUDIOBOOK_V2_PLAN.md §5.3). Everything ON by
  // default except the opt-ins; every env is a kill-switch or a bounded knob.
  audiobookEnabled: () => !envOff('CATALOG_AUDIOBOOK'),
  audioNarratorProvider: () => String(process.env.CATALOG_AUDIO_NARRATOR_PROVIDER || 'elevenlabs').trim().toLowerCase() || 'elevenlabs',
  audioNarratorModel: () => String(process.env.CATALOG_AUDIO_NARRATOR_MODEL || '').trim() || null,
  audioTakeCandidates: () => envInt('CATALOG_AUDIO_TAKE_CANDIDATES', 2, 1, 3),
  audioMaxRepairs: () => envInt('CATALOG_AUDIO_MAX_REPAIRS', 2, 0, 4),
  audioBudgetPerSegment: () => envInt('CATALOG_AUDIO_BUDGET_PER_SEGMENT', 5, 1, 10),
  audioConcurrency: () => envInt('CATALOG_AUDIO_CONCURRENCY', 4, 1, 8),
  audioCharacterVoicesEnabled: () => !envOff('CATALOG_AUDIO_CHARACTER_VOICES'),
  audioDirectorEnabled: () => !envOff('CATALOG_AUDIO_DIRECTOR'),
  audioTranscriptQaEnabled: () => !envOff('CATALOG_AUDIO_TRANSCRIPT_QA'),
  audioSttModel: () => String(process.env.CATALOG_AUDIO_STT_MODEL || 'gemini-2.5-flash').trim() || 'gemini-2.5-flash',
  audioMusicEnabled: () => !envOff('CATALOG_AUDIO_MUSIC'),
  audioMusicProvider: () => String(process.env.CATALOG_AUDIO_MUSIC_PROVIDER || 'lyria').trim().toLowerCase() || 'lyria',
  audioSfxEnabled: () => !envOff('CATALOG_AUDIO_SFX'),
  audioSfxProvider: () => String(process.env.CATALOG_AUDIO_SFX_PROVIDER || 'elevenlabs').trim().toLowerCase() || 'elevenlabs',
  audioAmbienceEnabled: () => !envOff('CATALOG_AUDIO_AMBIENCE'),
  audioPageTurnEnabled: () => !envOff('CATALOG_AUDIO_PAGE_TURN'),
  audioListenQaEnabled: () => !envOff('CATALOG_AUDIO_LISTEN_QA'),
  audioTargetLufs: () => {
    const n = Number(process.env.CATALOG_AUDIO_TARGET_LUFS);
    return Number.isFinite(n) && n <= -8 && n >= -30 ? n : -16;
  },
  audioShipOnExhaustion: () => envOn('CATALOG_AUDIO_SHIP_ON_EXHAUSTION'),
  audioTimeoutMinutes: () => envInt('CATALOG_AUDIO_TIMEOUT_MINUTES', 20, 5, 90),
  audioTuningLayerEnabled: () => !envOff('CATALOG_AUDIO_TUNING_LAYER'),
  audioAssetCandidates: () => envInt('CATALOG_AUDIO_ASSET_CANDIDATES', 2, 1, 3),
  // cb-1 — the coloring book (docs/COLORING_BOOK_V2_PLAN.md §5.4). Every
  // switch is a kill-switch (on by default) except the explicit opt-ins.
  coloringBookEnabled: () => !envOff('CATALOG_COLORING_BOOK'),
  coloringCandidates: () => envInt('CATALOG_COLORING_CANDIDATES', 2, 1, 3),
  coloringMaxRepairs: () => envInt('CATALOG_COLORING_MAX_REPAIRS', 2, 0, 4),
  coloringMomentWriterEnabled: () => !envOff('CATALOG_COLORING_MOMENT_WRITER'),
  coloringSheetCandidates: () => envInt('CATALOG_COLORING_SHEET_CANDIDATES', 3, 1, 4),
  coloringSheetRequired: () => !envOff('CATALOG_COLORING_SHEET_REQUIRED'),
  coloringContactQaEnabled: () => !envOff('CATALOG_COLORING_CONTACT_QA'),
  coloringContactMaxRerenders: () => envInt('CATALOG_COLORING_CONTACT_MAX_RERENDERS', 3, 0, 6),
  coloringStrokeGateEnabled: () => !envOff('CATALOG_COLORING_STROKE_GATE'),
  coloringStrokeMaxRerenders: () => envInt('CATALOG_COLORING_STROKE_MAX_RERENDERS', 2, 0, 4),
  coloringImageSize: () => {
    const v = String(process.env.CATALOG_COLORING_IMAGE_SIZE || '2K').trim().toUpperCase();
    return v === '1K' || v === '2K' || v === '4K' ? v : '2K';
  },
  coloringDespeckleEnabled: () => !envOff('CATALOG_COLORING_DESPECKLE'),
  coloringCaptionsEnabled: () => !envOff('CATALOG_COLORING_CAPTIONS'),
  // 0 = the band's default page count (plan.js PAGES_BY_BAND).
  coloringPages: () => envInt('CATALOG_COLORING_PAGES', 0, 8, 28),
  coloringShipOnExhaustion: () => envOn('CATALOG_COLORING_SHIP_ON_EXHAUSTION'),
  coloringTimeoutMinutes: () => envInt('CATALOG_COLORING_TIMEOUT_MINUTES', 30, 5, 90),
};
