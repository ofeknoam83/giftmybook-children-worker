# giftmybook-children-worker

Cloud Run microservice that generates personalized children's books with AI-generated illustrations featuring a child's photo-realistic likeness.

## Architecture

- **Express server** on port 8080 with API key auth (`x-api-key` header)
- **CommonJS modules** throughout (no ESM)
- **Async pipeline**: POST /generate-book returns 202, processes in background, reports progress via callbacks

## Shared services (`services/shared/`)

Cross-pipeline code extracted from the legacy modules ahead of their deletion (v3-only cutover plan): `shared/llm/openaiClient.js` (unified LLM client), `shared/llm/modelRouter.js` (role routing, used by storyPlanner + v2), `shared/text/sanitize.js` + `shared/text/sceneFramingHint.js`, `shared/illustration/config.js` + `illustrationPolicy.js` (used by games, cover, comics, illustrationGenerator), `shared/emotionalTiers.js`. The v1/v2 pipelines require FROM these locations — never the reverse — so deleting `bookPipeline`/`bookPipelineV2` is a pure directory removal. The v1 document contract (constants, bookDocument schema, toLayoutPayload, toLegacyStoryPlan) now lives in `services/bookPipelineV3/contract/`.

## Key Services

- `storyPlanner.js` — GPT-5.4 (Gemini fallback) plans complete V2 story with text + illustration prompts in one call
- `textGenerator.js` — Gemini Flash generates age-appropriate text per spread (legacy, used by /generate-spread)
- `illustrationGenerator.js` — Gemini 3.1 Flash image API with child photo reference for face-consistent illustrations
- `faceEngine.js` — Gemini Vision face validation and appearance description (cached in GCS)
- `layoutEngine.js` — pdf-lib assembles V2 entries into Lulu-compliant print-ready PDF
- `coverGenerator.js` — Generates Lulu wrap-around cover PDF (back + spine + front)

## Book Formats

- **Picture books** (ages 3-6): 8.5x8.5", 12 spreads (32 pages total), rhyming text
- **Early readers** (ages 6-9): **8.5×8.5"** interior trim (same as picture books), prose text; pipeline uses 13 spreads like picture books

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

### Book pipeline version routing

- **Resolver:** [`services/pipelineRouter.js`](services/pipelineRouter.js) — one place decides v1/v2/v3 for `/generate-book`. Precedence: **env kill-switches → checkpoint → request → default** (v2 for picture books per AA-CW-29, v1 for early readers).
- **`BOOK_PIPELINE_V2=off`** — emergency revert, everything on v1 (unchanged).
- **`BOOK_PIPELINE_V3`** — `off` = v3 never runs even if requested; `on` = v3 for picture books when `services/bookPipelineV3` is deployed, else a loud `FALLING BACK` log + v2 (an env var set ahead of a deploy must not brick customer books).
- **Request override:** `pipelineVersion: 'v2' | 'v3'` on the generate-book payload (sent by the main app's admin test path; stored on the book row there). An explicit `'v3'` on a worker without the module is rejected **400 before the 202** — no silent fallback, so pipeline A/B comparisons stay trustworthy. Invalid values also 400. (The module IS deployed as of milestone 1, so v3 requests route for real.)
- **Checkpoint:** the resolved version is persisted in the book checkpoint, so retries/resumes finish on the pipeline they started on (checkpoint beats a later request flag).
- **Reporting:** every completion/failure callback and `reportComplete`/`reportError` payload carries `pipelineVersionUsed`; the main app persists it into `generationProgress`.
- **V3 contract:** when `services/bookPipelineV3` ships it must export the same `{ generateBook, PipelineError }` and document shape consumed by `toLegacyStoryPlan` (see `docs/PIPELINE_V3_DESIGN.md` §10-11).

### Book pipeline — quad dual-spread illustrator (default on)

- **Default:** Quad path is **on** in code (`USE_QUAD_SPREAD_ILLUSTRATOR_DEFAULT` in [`services/bookPipelineV3/contract/constants.js`](services/bookPipelineV3/contract/constants.js)). Interiors use [`renderAllSpreadsQuad.js`](services/bookPipeline/illustrator/renderAllSpreadsQuad.js) unless overridden.
- **`GIFTMYBOOK_QUAD_SPREAD_ILLUSTRATOR`** — Optional override: `1` / `true` / `yes` / `quad` forces quad; `0` / `false` / `no` / `legacy` forces legacy [`renderAllSpreads.js`](services/bookPipeline/illustrator/renderAllSpreads.js).
- **Request override:** `useQuadSpreadIllustrator: true` or `false` on the generate-book payload (stored on `doc.request`) when you need per-book control without redeploying.
- **API:** Gemini Flash Image uses `imageConfig.aspectRatio: "4:1"` (supported on the Generative Language API). **OpenAI** path uses size **`1792x448`** (`OPENAI_QUAD_IMAGE_SIZE`) for quad batches; if the Images API rejects that size, fall back to Gemini for illustration or disable quad for that deployment.
- **Logs:** Filter `bookPipeline:*:quad` for batch lines (`spreadNumbers=[a, b]`, slice map); spread `13` logs `mode=single_spread` / `aspect=16:9` when present.
- **Gemini resilience:** 4:1 turns use a longer client timeout (`TURN_TIMEOUT_QUAD_MS`, 5 min in [`services/shared/illustration/config.js`](services/shared/illustration/config.js)). HTTP **503 / 504 / 429** and bodies mentioning **Deadline expired** / **UNAVAILABLE** / **RESOURCE_EXHAUSTED** are tagged as transient and retried with exponential backoff (same logical attempt) in [`renderAllSpreads.js`](services/bookPipeline/illustrator/renderAllSpreads.js) and [`renderAllSpreadsQuad.js`](services/bookPipeline/illustrator/renderAllSpreadsQuad.js).

## Illustrator V2 — enforcement tiers

Rules are layered: **session system instruction** and **per-spread prompt** carry the full policy (composition, characters, text, parent themes). **Per-spread QA** (text, anatomy, extra, style) catches repeatable defects and triggers in-session corrections. **Book-wide QA** (`bookWideGate`) is intentionally lenient and overlap-based; it may regen suspect spreads but does not hard-fail the book. Prefer fixing issues at the prompt layer; use QA telemetry (`bookContext.qaTagCounts`, `qaInfraErrors`) to see which tags drive retries.

## Writer V2 (selected picture-book themes)

- **Entry:** `services/writer/engine.js` — `WriterEngine.generate` (plan → write → `QualityGate` → revise loop → full regen waves).
- **Book id in logs:** pass `bookId` in the generate options (main pipeline does this) so every `[writerV2]` line is filterable in Cloud Logging.
- **Two planning passes (by design):** the job first brainstorms a **story seed** in `storyPlanner`, then Writer V2 runs its own **`plan()`** (beats, location palette, refrain). The seed is wired as `storySeed` so brainstormed beats are kept when valid. A future simplification is to merge into a single planner call; not required for correct output today.

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

WRITER, CRITIC, ADJUDICATOR stay on GPT because manuscript quality drives them. PLANNER / DIRECTOR / RHYME_JUDGE are structured-output tasks where DeepSeek is comparable and meaningfully cheaper.

**Per-role override:** set `BOOK_PIPELINE_V2_<ROLE>_FAMILY=openai|deepseek|gemini` (and optionally `BOOK_PIPELINE_V2_<ROLE>_TIER=strong|mid`) at the Cloud Run revision env to flip any role without a redeploy — e.g., `BOOK_PIPELINE_V2_PLANNER_FAMILY=openai` rolls PLANNER back to gpt-5.4. The startup `[LLM_CONFIG]` check requires both `OPENAI_API_KEY` and `DEEPSEEK_API_KEY` to be set; a missing key fails the boot guard and the deploy workflow blocks promotion.

`services/storyPlanner.js` also resolves its primary model via `modelFor('PLANNER')`, so the PLANNER swap takes effect for the brainstorm pass too (not just WriterV2's planning call).

## Book Pipeline V3 (milestone 1 — writer + v1 illustrator adapter)

`services/bookPipelineV3` implements the writer half of `docs/PIPELINE_V3_DESIGN.md` (see the module README). Runs only on explicit `pipelineVersion: 'v3'` (admin test path), a v3 checkpoint, or `BOOK_PIPELINE_V3=on`.

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
- **No ship-anyway:** panel exhaustion (after ≤2 revision rounds + second draft + fresh manuscript from the runner-up concept) throws `PipelineError` `judge_panel_exhausted` with judge history. Smoke-test escape hatch: `BOOK_PIPELINE_V3_SHIP_ON_EXHAUSTION=1`.
- Filter `[bookPipelineV3]` in Cloud Logging; the run ends with a one-line `cost summary` (per-call ledger in `document.v3.costs`).

## Conventions

- All functions use JSDoc comments
- Error handling with retries and exponential backoff
- Cost tracking per generation
- Progress reporting via webhook callbacks
