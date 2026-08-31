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
  One structural retry with the validation errors fed back at lower
  temperature; after that, ONE targeted repair call (contract-sanctioned)
  fixes bounded failures only — word bounds, evidence caps/legality,
  banned terms, leakage (`isRepairable`) — with minimal edits on the
  model's own response, fully re-validated; plot-level failures never
  reach repair. A candidate that still fails, fails — never a silent plot
  substitution.
- `storyValidation.js` — the 10-step deterministic sequence: ajv schema →
  identity/version echo → 12 ordered spreads → exact title equality → refrain
  exact text + placement → exact-age word bounds → evidence-vs-map legality →
  callback-before-introduction + caps → banned brand/IP lexicon
  (`data/bannedBrands.json`) + unused-detail leakage.
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
  `STYLE_VERSION` (versions.js) to invalidate globally. Words are PDF type,
  never pixels (D5): `skipTextEmbed` on every render.

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
- Tuning: `CATALOG_MIN_FIT_SCORE` (default 3), `CATALOG_WRITER_MODEL`,
  `CATALOG_QA_VISION_MODEL` (default `gemini-2.5-flash`).

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
- `POST /v13/set-text-layout`, `POST /v13/preview/embedded-overlay` — layout
  flip + pre-print overlay preview (entries from the request)
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
