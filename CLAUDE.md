# giftmybook-children-worker

Cloud Run microservice that generates personalized children's books on the
**Catalog Engine (V1.3)** — a fixed catalog of 228 pre-authored plots rendered
per child. The AI never invents or selects a plot.

## Architecture

- **Express server** on port 8080 with API key auth (`x-api-key` header)
- **CommonJS modules** throughout (no ESM)
- **Flow**: `/v13/select-books` (sync, deterministic, no LLM) →
  `/v13/generate-stories` (202 + callback, 3 parallel validated stories) →
  `/generate-book` (202 + callbacks, illustrates the CHOSEN story → PDFs)

The **2026-08 cutover** deleted the entire generative writer + illustrator
(`bookPipelineV3` with its judge panels/gates/art director, `storyPlanner`,
the legacy `prompts/` directory) and all game-asset generation. The handoff
spec lives in `docs/RUNTIME_CONTRACT_V1_3.md` + `docs/WRITER_HANDOFF_V1_3_README.md`.

## Catalog Engine (`services/catalogEngine/`)

- `data/catalog.json` — the frozen 12-theme / 228-book / 12-beat catalog
  (age bands `1-3`/`4-5`/`6-7`/`8-10`). **Never edit plots.** Legacy book ids
  keep `2_3`; route by the catalog's age-band KEY, never by parsing ids.
- `data/writerEngine.system.md` — the LOCKED Writer Engine V1.3 system prompt.
  Any edit bumps `WRITER_ENGINE_VERSION` (versions.js).
- `data/ageEngines.json` — per-band word budgets + exact-age calibration for
  ages 1/2/3 (`ageBounds.js` holds the machine-checkable numbers; a test keeps
  the two consistent).
- `catalog.js` — loader with boot invariant validation (12 themes, 228 unique
  books, 12 ordered beats each — ported from the handoff's validate_release.py).
- `catalogOverlay.js` — **Catalog Studio** (admin plot editing): versioned
  PROSE patches over the frozen catalog — allowlisted fields only (theme
  display/world/companion naming; book title_template, premise, refrain
  text+spreads, beat text). Structure (ids, bands, archetypes, 12/228/12)
  is rejected. The MERGED catalog must re-pass every boot invariant before
  activation; blobs persist in GCS by content hash with an `active.json`
  pointer (restored at boot by `initCatalogOverlay`, fail-safe to base;
  every instance also polls the pointer — `startCatalogOverlayWatch`,
  `CATALOG_OVERLAY_POLL_SECONDS` default 60, 0 disables — so the warm
  instances that did not serve the activate call converge within the
  interval). Every key check is an own-property check (`__proto__` /
  `constructor` patch keys are hostile input, never prototype writes);
  `title_template` takes exactly one `{name}` and no other placeholder; a
  patched refrain must fit the band's tightest per-spread word max.
  Every request pins `versions.catalog = <base>+<hash8>`; stored stories
  re-validate AND illustrate against their PINNED definitions
  (`getBookForTag`, small LRU) so reshaping a theme never breaks earlier
  stories — a pinned tag that no longer resolves HARD-FAILS
  (`missing_book_definition`, in `/v13/render-spreads` too), never a silent
  fallback to current beats. Endpoints: GET `/v13/catalog`, POST
  `/v13/catalog-overlay/{validate,activate,deactivate}`. Kill-switch
  `CATALOG_OVERLAY=0`. catalog.json itself stays frozen in git. A book
  patch may also set `retired: true` — the plot's SOFT DELETE: it leaves
  selection/eligibility/band counts immediately AND `buildStoryRequest`
  refuses fresh generation by id (customers can never get it again) while
  its definition remains so stored stories keep validating and printing;
  the merged gate refuses to drop any theme/band below 3 active books (one
  full slate). `retired: false` restores.
- `profile.js` — deterministic normalization (NFC, control-char rejection,
  dedupe, length caps). No LLM. Profile strings are data, never instructions.
- `selection.js` — fit-weighted candidate selection: the handoff's exact
  scoring formula, archetype diversity, seeded shuffle for TIE-BREAKS ONLY
  (`fnv1a(sessionId|catalogVersion|selectorVersion)`); insufficient-fit signal.
  The caller persists the slate BEFORE generation; refresh never reselects.
- `writer.js` — one pinned request per candidate (engine + age engine + book
  definition + approved map + profile + rendered title) on
  `CATALOG_WRITER_MODEL` (default `gpt-5.4`, via `shared/llm/openaiClient`,
  Gemini fallback disabled). The pinned profile offers only details the
  book's map can legally use, capped at `targets.max_details`
  (`selectOfferedDetails` — deterministic; makes the caps structurally
  satisfiable), and the map prompt carries an explicit HARD LIMITS line.
  Structural retries with the validation errors fed back at lower
  temperature (`CATALOG_WRITER_MAX_ATTEMPTS`, default 3 attempts total);
  after that, targeted repair passes (`CATALOG_WRITER_MAX_REPAIRS`, default
  2, contract-sanctioned) fix bounded failures only — word bounds, evidence
  caps/legality, banned terms, leakage (`isRepairable`) — with minimal
  edits on the model's own response, fully re-validated each pass (a pass
  that still carries bounded violations inside the minimal-edit boundary
  becomes the next pass's base; one that breaks the boundary or a
  non-repairable check is discarded); plot-level failures never reach
  repair. A candidate that exhausts both budgets fails — never a silent
  plot substitution. The tuning overlay is framed SCOPE-subordinate (binding on
  prose, never on plot/refrain/title/slots/contract), restated at the END
  of the user prompt (`buildStyleCheckpoint` — NON-NEGOTIABLE lines
  verbatim), and, when an overlay is pinned, a validated story gets ONE
  style-polish call (`maybePolish`, kill-switch `CATALOG_STYLE_POLISH=0`)
  that rewrites prose only and ships only if it re-passes the full
  validation with identical personalization evidence — a good story is
  never lost to polish (`polished: true` on the result when it lands).
- `storyValidation.js` — the 10-step deterministic sequence: ajv schema →
  identity/version echo → 12 ordered spreads → exact title equality → refrain
  exact text + placement → exact-age word bounds → evidence-vs-map legality →
  evidence-to-spread text alignment (a literal evidence value may occur ONLY
  on spreads its evidence declares — every path, first-pass included, holds
  the same invariant) → callback-before-introduction + caps → banned
  brand/IP lexicon (`data/bannedBrands.json`) + unused-detail leakage.
- `augments.js` — per-book sidecars joined by `book_id`:
  `data/augments/approved/{book_id}.json` ({selection_profile,
  personalization_map}) schema-validated at boot; `data/augments/drafts/` is
  NEVER loaded. No approved map ⇒ the book generates **name-only** — maps are
  never fabricated at runtime.
- `pipeline.js` — full-book run: resolve story (request pair → checkpoint →
  fresh) → illustrate → `assemblePdf` (minPages 32; 12 spreads + front matter)
  → cover PDF (`coverGenerator`, unchanged) → callback payload. Failure codes:
  `invalid_story`, `missing_book_definition`; `StoryGenerationError` carries
  `validationErrors`.
- `illustrator/` — the slim illustrator: the fixed BEAT is the scene
  (`scenes.js`), identity anchors on the parent-approved cover (raw photo only
  as coverless-test fallback; NO anchor at all fails the run with
  `missing_identity_reference`), one render + ONE vision QA check
  (`spreadQa.js`: painted text / missing / duplicated child / broken medium) +
  one corrective re-render, then ship-with-advisory (`qaAdvisories`). Renders
  cache at `children-jobs/{bookId}/ce-renders/{STYLE_VERSION}/{storyHash}/spread-N.{aspect}.png`
  — the story fingerprint (definition id + spread texts) means a regenerated
  manuscript re-renders while an unchanged story replays; a `.qa.json`
  marker beside each render records QA completion (a cached render without
  one is re-checked, never silently approved); bump
  `STYLE_VERSION` (versions.js) to invalidate globally. Text is
  LAYOUT-AWARE (`ce-2`, 2026-08-31): `embedded` renders paint the story
  text INTO the art via Gemini (the renderer's legacy `embedText` path —
  typography rules + OCR `verifyImageText` with extra retries) and spread
  QA transcribes + `compareTexts`-verifies it (missing/garbled painted
  text is the defect). Placement is HARDENED (`ce-3`): the painted text is
  ONE block on ONE side (left or right 35%), over continuous artwork —
  split-across-both-sides or a blank letterbox band is a QA defect
  (`text_split_both_sides` / `text_on_band`) with its own repair note.
  Typography is LOCKED (`ce-4`): text lines
  must be straight, level, LEFT-ALIGNED to one shared margin with even
  spacing, and the whole book uses ONE font, ONE size, ONE color — the
  pinned `TEXT_RULES` spec (fontStyle/fontSize/fontColor/textAlignment/
  typographyConsistency in `shared/illustration/config.js`) rides every
  stateless render, per-scene color retinting is gone, and QA gates
  `text_lines_misaligned` / `text_style_inconsistent` with their own
  repair notes. Such entries carry `textEmbeddedInArt: true`
  through storyContent so `layoutEmbeddedSpread` / the overlay preview
  embed the art full-bleed and NEVER typeset the caption over it again.
  `caption` renders keep D5 — words are PDF type, never pixels
  (`skipTextEmbed`; painted text is the defect).
  `illustrator/tuning.js` is the **Art Tuning Layer** (see below): when an
  `illustrationTuning` overlay rides the request, its framed style-only block
  is appended below each spread's scene and the cache path's version segment
  becomes `{STYLE_VERSION}+{label.hash8}` — tuned and untuned renders can
  never replay each other, and `none` keeps the legacy path byte-identical.
  World consistency (`ce-5`) attacks stateless-render drift with FIXED
  inputs, never chaining (previous-spread chaining was deleted 2026-08-06 as
  the photocopy drift source): (1) every scene prompt carries the theme's
  **world-law card** (`data/worldCards.json` + `worldCards.js` — palette,
  era, physical/magical laws; boot-validated full coverage; editing a card
  changes pixels ⇒ bump STYLE_VERSION); (2) every render attaches the
  theme's **world plate** (`illustrator/worldPlate.js`) — a fixed
  environment-only reference image beside the identity anchor, lazily
  generated once per theme, GCS-cached at
  `catalog-assets/world-plates/{STYLE_VERSION}/{themeId}-{promptHash}.png`
  (the prompt hash folds in overlay-patchable world naming + the card, so
  a Catalog Studio activation resolves a new plate; creation uses
  ifGenerationMatch so racing instances adopt ONE winning plate), its
  content hash folded into the render cache key (fail-open: a plate
  failure renders plate-less, never fails a run); (3) after the run, the **world gate**
  (`checkWorldConsistency` in `spreadQa.js` + `runWorldConsistencyGate`) —
  ONE multi-image check across the run's renders (skipped under 2), then
  one corrective re-render per flagged FRESH spread through the full
  per-spread path, capped at `CATALOG_WORLD_QA_MAX_RERENDERS` (default 3).
  Replayed cached renders are comparison references only, NEVER re-rendered
  (their storageKey is shared with earlier captured probe rounds); every
  finding ships as a `stage: 'worldQa'` advisory, and the book-level
  verdict rides completion/probe callbacks as `worldQa`. The gate runs
  identically for a full book and a probe subset — a subset is checked for
  internal consistency, mirroring the app-side judge.

## Feature switches (everything ON by default; envs are KILL-SWITCHES)

The full V1.3 behavior ships out of the box — fit ranking, deep
personalization (all 228 books carry an approved sidecar), and the evidence
requirement. Set an env to `0` on the Cloud Run revision to disable:

- `CATALOG_FIT_RANKING=0` — fall back to seeded variety-only selection.
- `CATALOG_PERSONALIZATION_MAPS=0` — every book generates name-only.
- `CATALOG_EVIDENCE_REQUIRED=0` — stop hard-failing responses that ignore
  usable details despite approved slots.
- `CATALOG_TUNING_LAYER=0` — ignore any `writerTuning` overlay from the main
  app (stories render on the bare locked engine prompt).
- `CATALOG_STYLE_POLISH=0` — skip the style-polish pass on tuned stories.
- `CATALOG_ART_TUNING_LAYER=0` — ignore any `illustrationTuning` overlay from
  the main app (spreads render on the bare scene + style prompts).
- `CATALOG_WORLD_PLATE=0` — skip the per-theme world reference plate
  (renders anchor on the cover alone; world-law cards still ride prompts).
- `CATALOG_WORLD_QA=0` — skip the book-level world-consistency gate and its
  corrective re-renders (per-spread QA still runs).
- Tuning: `CATALOG_MIN_FIT_SCORE` (default 3), `CATALOG_WRITER_MODEL`,
  `CATALOG_WRITER_MAX_ATTEMPTS` (default 3, clamped 1-6),
  `CATALOG_WRITER_MAX_REPAIRS` (default 2, clamped 0-6),
  `CATALOG_QA_VISION_MODEL` (default `gemini-2.5-flash`),
  `CATALOG_WORLD_QA_MAX_RERENDERS` (default 3).

## Endpoints

- `GET /v13/themes` — catalog theme vocabulary (the app picker's source of truth)
- `GET /v13/coverage` — sidecar authoring coverage + flag state
- `POST /v13/select-books` — sync `{sessionId, themeId, profile}` →
  3 candidates + scores + seed (persist before generating)
- `POST /v13/generate-stories` — `{bookId, bookIds[1..3], profile, sessionId,
  callbackUrl, writerTuning?}` → 202; callback `{stories:[{bookDefinitionId,
  request, response, nameOnly, usage}], failures}`. **This is the admin
  story-only test mode** — no illustration spend. `writerTuning`
  (`{versionLabel, hash, text}`, also accepted by `/generate-book` for fresh
  generations) is the app-owned Style Tuning Layer: appended below the locked
  engine at prose-polish priority, echoed as `versions.writer_tuning`
  (`<label>.<hash8>` or `none`), capped at 8KB, killed by
  `CATALOG_TUNING_LAYER=0`. The engine prompt file stays locked; see
  `docs/AI_WRITER_FEEDBACK_LOOP_PLAN.md`.
- `POST /generate-book` — `{bookId, profile, story:{request,response} |
  bookDefinitionId, approvedCoverUrl, childPhotoUrls, textLayout,
  heartfeltNote, bookFrom, bindingType, callbackUrl, progressCallbackUrl,
  forceNew, forceRerender}` → 202; completion callback mirrors the legacy
  shape (interiorPdfUrl, coverPdfUrl, previewImageUrls, storyContent,
  qaAdvisories, warnings, costs) + `pipelineVersionUsed: 'catalog-v13'`,
  `illustratorVersionUsed: 'catalog-slim'`. `storyContent.catalog` carries
  bookDefinitionId/themeId/ageBand/versions/evidence/omissions.
- `POST /v13/render-spreads` — the **admin render-test (probe) mode** for the
  illustration feedback loop: `{bookId, story:{request,response}, spreads[1..12
  subset], profile, approvedCoverUrl|childPhotoUrls, textLayout,
  illustrationTuning?, dispatchId?, seed?, probeNonce?, forceRerender?,
  callbackUrl}` → 202; callback `{renders:[{spread, url, storageKey,
  qa:{pass, advisories}}], failures:[{spread, message}],
  illustrationTuningUsed, costs}` (+dispatchId echo). Renders a SUBSET of an
  existing validated story's spreads through the exact production path — zero
  writer spend, no PDFs/cover/upsell; per-spread render errors land in
  `failures`, never fail the probe. Probe cache keys fold in the identity
  anchor (URL path + characterDescription) and any `seed` (applying the seed
  stays gated by `BOOK_PIPELINE_V3_RENDER_SEED`), so an anchor swap or seed
  change never replays stale renders. `illustrationTuning` (`{versionLabel,
  hash, text?, spreads?}`, also accepted by `/generate-book`) is the app-owned
  Art Tuning Layer: appended below each scene at lowest priority, echoed as
  `illustrationTuningUsed` + `storyContent.catalog.illustrationTuning`
  (`<label>.<hash8>` or `none`), capped at 2000B global / 400B per spread /
  3000B total, killed by `CATALOG_ART_TUNING_LAYER=0`. See
  `docs/AI_ILLUSTRATION_FEEDBACK_LOOP_PLAN.md`.
- `POST /v13/generate-cover-image` — **admin probe-anchor cover** (sync, like
  `/rebuild-cover-pdf`): `{bookId, title?, childName, childAge?,
  childPhotoUrl|childPhotoUrls, artStyle?, bookFormat?, bindingType?}` →
  `{coverUrl, gcsPath, title, coverAnatomyAdvisory, costs}`. Renders ONLY the
  front-cover key art from a child photo through the exact production cover
  path (`coverGenerator.generateFrontCoverImage` — the same coverScene +
  wardrobe/anatomy QA + retries `generateCover` runs), uploads to
  `children-covers/{bookId}/anchor-cover-{ts}.png`, so Art Bench render
  probes can anchor on a cover the way production books do (plan §5.1). No
  wrap PDF, no upsell; `title` is echoed for labeling, never painted (D5).
- `POST /v13/set-text-layout`, `POST /v13/preview/embedded-overlay` — layout
  flip + pre-print overlay preview (entries from the request). Text layouts:
  `caption` (art page + white text page), `half` (FULL-SPREAD wide
  text-free art — the scene pushes the child and all key action into the
  RIGHT half — assembled as art recto + a UNIFORM solid text panel verso;
  cached under `wide-plain` so half and embedded wide renders never
  replay each other), `embedded` (wide Gemini-painted text). ALL typeset
  text pages — caption pages and half panels alike — share ONE book-wide
  typographic standard (`computeBookCaptionBlock`: same serif, brown ink,
  fixed `BOOK_CAPTION_FONT_SIZE` on every spread; the smaller ladder steps
  are an overflow safety valve only, never per-caption auto-sizing).
- `/generate-book` also bakes the 4-style upsell spread into the interior
  (non-blocking, 4-min cap; `upsellCovers` on the completion callback)
- Kept: `/finalize-book` (legacy layout), `/rebuild-cover-pdf`,
  `/generate-coloring-book` + coloring endpoints, `/comics/*`,
  `/manage-checkpoint`, `/upload-*`, `/refresh-url`, health checks.
- 410 stubs: `/regenerate-illustration`, `/generate-style-variant`,
  `/get-spread-data`. Game endpoints are deleted (404).

## Kept services (untouched by the cutover)

`coverGenerator.js` (Lulu wrap cover; still the identity/style anchor),
`layoutEngine.js` (pdf-lib layout; entries contract unchanged),
`coloringBookGenerator/Layout`, `comics/`, `gcsStorage`, `progressReporter`,
`costTracker`, `retry`, `workerCommits`, `promptSanitizer`,
`shared/llm/openaiClient.js`, `shared/text/sanitize.js`,
`shared/illustration/config.js`. `illustrationGenerator.js` is the shared
Gemini image client + key pool + photo utils (cover, coloring, comics, and
the slim illustrator all sit on it) — `opts.gcsPath` pins a deterministic
upload path for the render cache.

## Sidecar authoring (COMPLETE — all 228 approved)

Every catalog book has an approved `selection_profile` + `personalization_map`
sidecar in `data/augments/approved/` (full coverage is asserted by a test and
the boot log; `GET /v13/coverage` reports it). 12 are hand-tuned reference
files; the other 216 were generated by `scripts/buildSidecars.js` —
deterministic per-archetype slot scaffolds placed on the beats that actually
support them (food slots only on explicit celebration beats in
human-food-plausible themes; never underwater/dream/animal-feed books) with
theme + archetype + beat-keyword selection tags. Sidecars are versioned files,
NEVER generated at runtime; to revise one, edit the file (or rerun the script
after deleting it) and commit. `scripts/draftSidecars.js` remains for
LLM-drafting alternatives into `drafts/` (never loaded).

## Checkpoints & resume

`children-jobs/{bookId}/checkpoint.json` (`engine: 'catalog-v13'`,
`completedStage: story|illustration`, the story pair, textLayout). A legacy
(pre-cutover) checkpoint restarts fresh, loudly. Cleared on success. Render
resume comes from the STYLE_VERSION-keyed cache, not the checkpoint.

## Environment Variables

- `API_KEY`, `GCS_BUCKET_NAME` — auth + storage
- `OPENAI_API_KEY` — the writer (gpt-5.4). Required; boot guard + `/healthz`.
- `GEMINI_API_KEY` (+ `GEMINI_API_KEY_1..10` pool, `GOOGLE_AI_STUDIO_KEY`) —
  renders + vision QA + coloring/comics
- `DEEPSEEK_API_KEY` — no longer required (legacy pipelines deleted)
- Catalog flags above

## Conventions

- All functions use JSDoc comments
- Error handling with retries and exponential backoff
- Cost tracking per generation (`CostTracker`)
- Progress reporting via webhook callbacks (`progressReporter`)
- Never edit `data/catalog.json` plots; sidecars are additive and versioned
- Bump `versions.js` identifiers when prompts/formulas change
