# giftmybook-children-worker

Cloud Run microservice that generates personalized children's books with AI-generated illustrations featuring a child's photo-realistic likeness.

## Architecture

- **Express server** on port 8080 with API key auth (`x-api-key` header)
- **CommonJS modules** throughout (no ESM)
- **Async pipeline**: POST /generate-book returns 202, processes in background, reports progress via callbacks

## Shared services (`services/shared/`)

Cross-pipeline code: `shared/llm/openaiClient.js` (unified LLM client), `shared/llm/modelRouter.js` (role routing, used by the storyPlanner brainstorm), `shared/text/sanitize.js`, `shared/illustration/config.js` (used by games, cover, comics, illustrationGenerator), `shared/emotionalTiers.js`. The v1 document contract (constants, bookDocument schema, toLayoutPayload, toLegacyStoryPlan) lives in `services/bookPipelineV3/contract/`.

**Deletion status:** `bookPipelineV2`, the v1 pipeline engine, Writer V2 (`services/writer/`), textGenerator, and the chapter-book/graphic-novel generation paths were deleted in W12. The **legacy illustrator** — `services/bookPipeline/` (12-file render subset), `services/illustrator/` (session/quad machinery), and the v3 legacy adapter activity — was deleted in the native-illustrator cutover (2026-07-15). The native illustrator (`services/bookPipelineV3/illustrator/`) is the ONLY illustrator.

## Key Services

- `storyPlanner.js` — survives for `brainstormStorySeed` only (runs before the v3 pipeline; the seed feeds customDetails). The legacy planners inside it (planStory/planChapterBook/planGraphicNovel/critics) are dead code slated for a slimming pass.
- `illustrationGenerator.js` — Gemini 3.1 Flash image API with child photo reference for face-consistent illustrations
- `faceEngine.js` — Gemini Vision face validation and appearance description (cached in GCS)
- `layoutEngine.js` — pdf-lib assembles V2 entries into Lulu-compliant print-ready PDF
- `coverGenerator.js` — Generates Lulu wrap-around cover PDF (back + spine + front)

## Book Formats

- **Picture books ONLY** (v3-only cutover): 8.5x8.5", 13 spreads (32 pages total). Early readers, chapter books, and graphic novels are RETIRED — validation rejects them 400 before the 202. Emotional books are picture books at every age. `/finalize-book` keeps a graphic-novel path for finalizing legacy books already in the system.
- **Text layout (admin-selectable, request field `textLayout`):** `'caption'` (default — typeset story text on a white verso page + full-bleed 1:1 art recto) or `'embedded'` (one wide 16:9 illustration spanning both facing pages, caption typeset OVER the art in the art director's quiet zone — integrated, no panel). Art is wordless in BOTH modes (D5 — words are PDF type, never pixels). Mode is checkpoint-pinned, persisted at `doc.v3.textLayout`, and rides per-spread entries as `textLayout`+`textZone`.
  - **Overlay decision (2026-07-18 hardening):** the caption band (top/bottom 38% of the quiet-zone half) is sampled in 4 side-by-side segments; tone comes from the luminance WEIGHTED by each segment's overlap with the centered text block (`analyzeZoneBand`, pure/exported), and a band whose max segment stdev exceeds 45 is "busy" → the halo escalates to a wider double ring. Placement is gutter-aware (`computeOverlayPlacement`): overlay text never sits within 10% of the fold (matching the renderer's GUTTER rule), and long captions expand toward the page center (size ladder 22→14, capped at 55% of page height) instead of clipping at the bleed.
  - **Contrast advisories:** every embedded spread's tone-vs-band WCAG-inspired contrast is computed at layout; below 4.5:1 it ships anyway but records a `{stage:'layout'}` qaAdvisory (closed-gate pattern) + a bookWarnings line. `POST /v3/preview/embedded-overlay {bookId, entries?}` renders the ACTUAL overlay PDF pages (same code path as assemblePdf) + per-spread metrics for admin pre-print review.
  - **Admin flip on an existing book:** `POST /v3/set-text-layout {bookId, textLayout}` re-pins the checkpoint; an illustrated checkpoint drops its stale storyPlan so the re-dispatch re-renders. The render cache is ASPECT-KEYED (`candidatePath(..., textLayout)` — embedded candidates live at `spread-N-cI.wide.png`, caption keeps the legacy path), so a flip re-renders only the missing aspect and a flip-back replays the original renders from GCS.
  - **D5 guardrail (do not drift):** never ask the image model to paint the manuscript's words into pixels — model lettering is unreliable (spelling/kerning), unfixable without a full re-render, non-selectable, and non-localizable. If a future request wants baked-in stylized text (comic "POW!" callouts), scope it as a SEPARATE feature with a locked short-SFX whitelist + heavy QA — never as a substitute for typeset body text. The `ABSOLUTELY NO TEXT` instruction in `buildSpreadRenderPrompt` must not be weakened.

## Environment Variables

- `API_KEY` — Auth key for incoming requests
- `GCS_BUCKET_NAME` — Google Cloud Storage bucket
- `OPENAI_API_KEY` — For GPT-5.4 text generation (WRITER, CRITIC, ADJUDICATOR; also gpt-image-2 illustrations)
- `DEEPSEEK_API_KEY` — For DeepSeek text generation (PLANNER, DIRECTOR, RHYME_JUDGE by default — see modelRouter)
- `ANTHROPIC_API_KEY` — Optional. Only needed when a bookPipelineV3 role is overridden to the anthropic family (`BOOK_PIPELINE_V3_<ROLE>_FAMILY=anthropic`); the v3 defaults run on OpenAI/DeepSeek/Gemini. `assertV3Config` fails the book loudly before any LLM spend if a routed family's key is missing. Forwardable per-request via the main app's `apiKeys` payload.
- `GEMINI_API_KEY` — For Gemini Flash text and vocabulary checks
- `GEMINI_API_KEY_1` through `GEMINI_API_KEY_10` — Round-robin pool for parallel illustration generation
- `GOOGLE_AI_STUDIO_KEY` — Fallback Gemini key
- `GEMINI_PROXY_URL`, `GEMINI_PROXY_API_KEY` — Optional proxy endpoint for illustration fallback
- `REPLICATE_API_TOKEN` — For Flux character reference generation (legacy)
- `GCP_PROJECT_ID`, `GCP_LOCATION`, `CLOUD_TASKS_QUEUE` — Cloud Tasks config

### Book pipeline routing (v3-only since W12)

- **Resolver:** [`services/pipelineRouter.js`](services/pipelineRouter.js) — every book routes to `bookPipelineV3`; v1/v2 were deleted. Legacy state maps onto v3 LOUDLY instead of crashing: a retried book with a `'v1'`/`'v2'` checkpoint restarts fresh on v3; the old `BOOK_PIPELINE_V2/V3` kill-switch envs log a warning and are ignored (nothing left to revert to). A missing v3 module throws `PIPELINE_V3_UNAVAILABLE` — with the legacy engines gone the worker cannot generate at all, so failing loudly beats a 202-then-brick.
- **Request field:** `pipelineVersion` accepts only `'v3'`; anything else is 400 before the 202.
- **Reporting:** every completion/failure callback carries `pipelineVersionUsed` (always `'v3'` now); the main app persists it into `generationProgress`.

## Model routing (`services/shared/llm/modelRouter.js`)

Roles → providers (`DEFAULT_ROUTING`):

| Role        | Provider | Model              |
|-------------|----------|--------------------|
| PLANNER     | deepseek | `deepseek-v4-pro`  |
| WRITER      | openai   | `gpt-5.4`          |
| CRITIC      | openai   | `gpt-5.4`          |
| ADJUDICATOR | openai   | `gpt-5.4`          |
| DIRECTOR    | deepseek | `deepseek-v4-flash`|
| RHYME_JUDGE | deepseek | `deepseek-v4-flash`|
| SUMMARIZER  | gemini   | `gemini-2.5-flash` |

Post-cutover, this router serves only the storyPlanner brainstorm (PLANNER); the v3 pipeline has its own router (`services/bookPipelineV3/llm/modelRouter.js`).

**Per-role override:** set `BOOK_PIPELINE_V2_<ROLE>_FAMILY=openai|deepseek|gemini` (and optionally `BOOK_PIPELINE_V2_<ROLE>_TIER=strong|mid`) at the Cloud Run revision env to flip any role without a redeploy — e.g., `BOOK_PIPELINE_V2_PLANNER_FAMILY=openai` rolls PLANNER back to gpt-5.4. The startup `[LLM_CONFIG]` check requires both `OPENAI_API_KEY` and `DEEPSEEK_API_KEY` to be set; a missing key fails the boot guard and the deploy workflow blocks promotion.

`services/storyPlanner.js` also resolves its primary model via `modelFor('PLANNER')`, so the PLANNER swap takes effect for the brainstorm pass too (not just WriterV2's planning call).

## Book Pipeline V3 (writer + native illustrator — the only pipeline)

`services/bookPipelineV3` implements `docs/PIPELINE_V3_DESIGN.md` (see the module README). Every book runs on it (v3-only routing since W12).

Roles → providers (`services/bookPipelineV3/llm/modelRouter.js`, override via `BOOK_PIPELINE_V3_<ROLE>_FAMILY`/`_TIER`). Defaults use only already-provisioned vendors (product decision 2026-07-13); the anthropic family stays wired for per-role A/B flips (needs `ANTHROPIC_API_KEY`):

| Role | Provider | Model |
|---|---|---|
| BRIEF / CONCEPT / WRITER | openai | `gpt-5.4` |
| EDITOR | deepseek | `deepseek-v4-pro` |
| JUDGE_A | deepseek | `deepseek-v4-pro` |
| JUDGE_B | openai | `gpt-5.4` |
| JUDGE_C | gemini | `gemini-2.5-pro` |

- Judges must stay **cross-family** (blind panel, median ≥ 4 on all 7 rubric dimensions to pass); a collapsing env override logs `FAMILY COLLAPSE`.
- The anthropic client (`llm/anthropicClient.js`) never sends `temperature`/`top_p` — `claude-opus-4-8` rejects them (400). Best-of-2 draft diversity comes from prompt variants (works across all families).
- **No ship-anyway → review queue:** panel exhaustion (after ≤2 revision rounds + second draft + fresh manuscript from the runner-up concept) throws `PipelineError` with `failureCode: 'needs_review'` and a structured payload (`services/bookPipelineV3/reviewQueue/payload.js`: stage, reason `judge_panel_exhausted`, defects, judge scores + history). server.js persists the payload in the book checkpoint and forwards it on the failure callbacks (`needsReview` field). Admin resolution via `POST /v3/review/approve` (ship best manuscript on re-dispatch) or `/v3/review/regen-manuscript`; `pick-candidate`/`regen-spread` 409 until the native illustrator (milestone 2 W10). The endpoints only mutate the checkpoint — the main app re-dispatches `/generate-book`. Smoke-test escape hatch: `BOOK_PIPELINE_V3_SHIP_ON_EXHAUSTION=1`.
- Filter `[bookPipelineV3]` in Cloud Logging; the run ends with a one-line `cost summary` (per-call ledger in `document.v3.costs`).

### Native V3 illustrator — the ONLY illustrator (cutover 2026-07-15)

- **No versions:** `DEFAULT_ILLUSTRATOR = 'native'` and `'native'` is the only valid value (`services/bookPipelineV3/illustrator/config.js`). A pre-cutover `'legacy'` checkpoint maps LOUDLY onto native (illustration restarts; the manuscript replays); a stale `BOOK_PIPELINE_V3_ILLUSTRATOR=legacy` env warns and is ignored; request `illustratorVersion` accepts only `'native'` (anything else 400s before the 202). Callbacks carry `illustratorVersionUsed: 'native'` beside `pipelineVersionUsed`.
- **Roles — ALL vision on Gemini (product decision 2026-07-17):** ART_DIRECTOR `gemini-2.5-pro`, QA_VISION `gemini-2.5-flash`, LIKENESS_JUDGE_A `gemini-2.5-flash` + LIKENESS_JUDGE_B `gemini-2.5-pro` (cross-MODEL ENFORCED — `validateLikenessFamilies` logs MODEL COLLAPSE when both judges resolve to one model). OpenAI vision was dropped after its wire format broke mid-production (image_url → Responses API); the openai vision path stays wired (Responses API + loud legacy fallback) for per-role A/B via `BOOK_PIPELINE_V3_LIKENESS_JUDGE_*_FAMILY`. Renderer models default to `gemini-3.1-flash-image` (the verified-available id on the public Generative Language API — the guessed pro id 404'd in production); the pro-tier upgrade flips in via `BOOK_PIPELINE_V3_SHEET/SPREAD_RENDERER_MODEL` once the provisioned id is confirmed from ListModels, and `imageClient` falls back LOUDLY to flash if a configured id is invalid (bump the kit cache version when real pro lands).
- **Likeness reference = the APPROVED COVER character** (product decision 2026-07-15): the parent approved the cover, so that character is the book's identity ground truth. A0 sheet candidates are judged vs the cover; A3 spread candidates vs the model sheet + cover (same-medium, illustration-vs-illustration). The RAW PHOTO is never a QA reference (photo-vs-illustration judging is unwinnable — age stylization, medium gap); photos feed only the likeness-brief vision analysis, and act as judge fallback for coverless books.
- **Pipeline:** A0 identity kit (`illustrator/identityKit/` — likeness brief + best-of-3 character sheet judged cross-family vs the photo, GCS-cached by photoHash+styleVersion; runs parallel with the writer; photos feed only vision analysis + judges, NEVER generation — PROHIBITED_CONTENT-safe) → A1 art direction (`artDirection/` — one multimodal call: shot budget deterministically validated/repaired, quiet zones, palette arc, world plates; unstageable contracts BOUNCE to one writer revision round before any pixels) → A2 parallel renders (`render/` — 1:1, 2 candidates/spread from fixed refs [sheet+cover+plate], GCS-resume) → A3 QA cascade (`qa/` — sharp integrity + letterform hard-fail + spread judge + cross-family likeness; one repair wave with named defects; exhaustion → needs_review with ALL candidates) → A4 book pass (`bookPass/` — contact-sheet review, one targeted regen wave). Books lay out in caption mode (typeset verso + full-bleed recto) — **no text in pixels, ever** (D5).
- **Closed critical gate (2026-07-16):** the spread judge and book pass can BLOCK only for a CLOSED list of critical defect classes (THE PARENT TEST: painted words · duplicated child/stranger · countably wrong anatomy · action entirely absent · wrong setting · style break · [book level] wrong child/outfit vs cover). Everything else is a MINOR defect: recorded as `doc.qaAdvisories` (`[{stage, spread, note}]`, capped 40), shipped on the completion callbacks (`qaAdvisories` + a `bookWarnings` summary) and persisted in the checkpoint — never blocking, fixable post-hoc via `/v3/review/regen-spread`. Deterministic backstop: hard tags (`duplicated_hero`/`extra_character`/`missing_character`) escalate to critical regardless of the model's severity label. Judge scores still rank candidates (`pickWinner`) but no longer gate. Repair waves and book-pass regens chase only critical notes.
- **Print-audit hardening (2026-07-18, Astro-Maze audit):** (1) the spread judge returns a normalized `hero_box`; it rides the winner (`illustration.heroBox`) into the layout payload, and `chooseOverlayZone` (layoutEngine, pure/exported) relocates an embedded caption whose planned band the hero covers >15% — luminance sampling alone typeset captions across the hero's face. (2) `wrapTextBalanced` kills one-word orphan lines. (3) The judge also receives the spread's caption text (counted-object critical class 7: "three tunnels" text vs four painted) and, for embedded books, the wide-spread fold classes (twin landmarks / focal subject on the fold); photographic blur/DOF is a named style-break. (4) A1 renders a **prop plate** from the art director's LOCKED `continuityLocks.props[].design` (`artDirection/propPlate.js`) that rides every render's reference pack; prop object-identity morphs are book-pass critical class 7 — BOUNDED (2026-07-19, book 37907cf4 needs_review'd on the class's first outing): the plate also rides the book-pass review as the design ground truth, a critical prop flag must NAME a locked prop or `boundPropFlags` downgrades it to an advisory, and book-pass regens carry a `CRITICAL REPAIR` template quoting the flagged prop's locked design. (5) Back-cover generation forbids and QA-rejects book mockups/photo surfaces (`qaBackCoverArtwork`), and cover bleed/wrap bands are blur-softened (`extendWithSoftWrap`) instead of raw pixel streaks. (6) `runManuscriptGate` adds soft book lints (`gate/checks/bookLints.js`: duplicate climax, unintroduced prop, word overuse) — never gating, they feed revision notes via `mergeTargets`.
- **Typography + wardrobe hardening (2026-07-19, Rocket-Ride audit #2):** (1) `wrapTextBalanced` is now a least-squares balanced wrap (Knuth-style DP) — wrapped caption lines come out near-equal instead of full-line-then-stub ("staircase"); caption measure is capped at `OVERLAY.MAX_MEASURE_FRAC` (78% of page width). (2) The spread judge also returns `figures_box` (union of ALL characters); layout dodges the whole cast, not just the hero (a caption typeset across two aliens' faces). (3) Deterministic fold backstop in `qa/select.js`: on embedded renders a hero_box with ≥`FOLD_SWALLOW_FRAC` (60%) of its width inside the fold band `[FOLD_BAND_MIN, FOLD_BAND_MAX]` fails the candidate as `fold_collision` regardless of judge prose. SWALLOWED, not centered (2026-07-20, book d7625d8f): the first cut failed on box CENTER in the band, which no close-up shot can satisfy — one spread per book (the shot budget requires close-ups) deterministically exhausted spread QA into needs_review. Fold-failed spreads also restage with an explicit off-center composition rule (`restageSpread` gets `textLayout`). (4) Cover wardrobe: flag/logo/letter-free outfit rules in the fresh-cover, harmonize, and upsell prompts + `qaCoverWardrobe` (one vision check + one hardened retry — a US-flag patch on the approved cover had propagated onto every interior spread). (5) `continuityLocks.gear` — gear-state rules per setting (helmet ON outdoors) stated in every spread's continuityNotes, checked by the book pass as an advisory. (6) Pseudo-alphabet/alien-script bans in render/plate prompts; prop-plate note scopes props to scenes (no decals); character-sheet prompt forbids invented moles.
- **Style-drift hardening (2026-07-18, book 6e018c20):** a prose-only world plate drifted flat/desaturated and dragged its spreads into a book-pass style break that the cover-blind spread judge could not see. Now: world plates render WITH the book pack (sheet + approved cover) as rendering-style references (`renderWorldPlates.styleReferences`); the spread judge receives the cover as a STYLE-ONLY reference (critical class 6 covers cover-relative flat/desaturated/line-art drift — identity/outfit still belong to the likeness judges + book pass); and style-break defects get a targeted `CRITICAL REPAIR` template in both the spread repair wave and the book-pass regen (same pattern as the lettering/color-drift templates).
- **Review resolutions:** `/v3/review/pick-candidate` (bypass QA for an admin-picked candidate), `/v3/review/regen-spread` (force fresh renders with the admin note in the prompt), and `/v3/review/pick-sheet` (identity_kit_exhausted: use an admin-picked sheet candidate — the payload carries `candidateUrls` + per-judge verdicts); other spreads replay from GCS on the re-run. The old `/regenerate-illustration` endpoint is a 410 stub.
- **Identity-kit tuning:** the sheet is generated from the likeness brief + the parent-approved COVER as reference (never the photo); wave 2 feeds the judges' named defects back into the prompt. Ops knobs: `BOOK_PIPELINE_V3_LIKENESS_PASS_SCORE` (default 4), `BOOK_PIPELINE_V3_SHEET_BEST_OF`/`_SHEET_EXTRA_WAVES` (3/1), `BOOK_PIPELINE_V3_KIT_SHIP_ON_EXHAUSTION=1` (loud escape hatch: ship best-scoring sheet instead of needs_review).
- **Legacy books:** `/finalize-book` still lays out pre-cutover books (baked-caption wide images split by `layoutEngine.splitSpreadImage`); they cannot be re-rendered per-spread — regenerate in full (restarts on native).
- **Style bible = premium 3D (sb-1, 2026-07-20):** `illustrator/styleBible.js` derives from the FROZEN `PIXAR_STYLE` config (`shared/illustration/config.js`) — the same 3D CGI language the cover pipeline is locked to (`canonicalBookArtStyle()` ignores the request on purpose). The sb-0 placeholder prompted "NOT 3D render" and shipped 2D interiors stapled to 3D covers (book 36e79635 complaint). The spread judge's style class is 3D-relative: flat 2D/painterly/watercolor drift is the break; cinematic bokeh is part of the style; a live-action photograph look also breaks. Never edit the bible without bumping `STYLE_VERSION` (invalidates every cached identity kit).
- **Caption overlay treatment (2026-07-20, book 36e79635 readability):** overlay captions use the rounded upright face (`bubblegum`) at a one-notch larger ladder (24→16) — white caption pages keep the serif — and `shouldScrim` (pure/exported) draws a soft 3-layer translucent scrim behind the block whenever the band is busy or the advisory contrast is below `OVERLAY.MIN_CONTRAST`; halo ring opacity raised (0.70/0.85). The overlay report carries `scrim` per spread.
- **Calibration:** run `node scripts/calibrateIllustratorJudges.js labels.json` — every hard-fail class (lettering / duplicated hero / wrong child) should show ≥0.90 judge–human agreement (see `docs/PHASE_C_VALIDATION.md` for the audit checklist; the staged Phase C gate itself was superseded by the direct cutover).

## Conventions

- All functions use JSDoc comments
- Error handling with retries and exponential backoff
- Cost tracking per generation
- Progress reporting via webhook callbacks
