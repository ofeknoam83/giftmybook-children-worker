# giftmybook-children-worker

Cloud Run microservice that generates personalized children's books with AI-generated illustrations featuring a child's photo-realistic likeness.

## Architecture

- **Express server** on port 8080 with API key auth (`x-api-key` header)
- **CommonJS modules** throughout (no ESM)
- **Async pipeline**: POST /generate-book returns 202, processes in background, reports progress via callbacks

## Key Services

- `storyPlanner.js` — GPT-5.4 (Gemini fallback) plans complete V2 story with text + illustration prompts in one call
- `textGenerator.js` — Gemini Flash generates age-appropriate text per spread (legacy, used by /generate-spread)
- `illustrationGenerator.js` — Gemini 3.1 Flash image API with child photo reference for face-consistent illustrations
- `faceEngine.js` — Gemini Vision face validation and appearance description (cached in GCS)
- `layoutEngine.js` — pdf-lib assembles V2 entries into Lulu-compliant print-ready PDF
- `coverGenerator.js` — Generates Lulu wrap-around cover PDF (back + spine + front)

## Book Formats

- **Picture books** (ages 3-6): 8.5x8.5", 12 spreads (32 pages total), rhyming text
- **Early readers** (ages 6-9): 6x9", 24-32 pages, simple chapters

## Environment Variables

- `API_KEY` — Auth key for incoming requests
- `GCS_BUCKET_NAME` — Google Cloud Storage bucket
- `OPENAI_API_KEY` — For GPT-5.4 text generation (story planning primary)
- `GEMINI_API_KEY` — For Gemini Flash text and vocabulary checks
- `GEMINI_API_KEY_1` through `GEMINI_API_KEY_10` — Round-robin pool for parallel illustration generation
- `GOOGLE_AI_STUDIO_KEY` — Fallback Gemini key
- `GEMINI_PROXY_URL`, `GEMINI_PROXY_API_KEY` — Optional proxy endpoint for illustration fallback
- `REPLICATE_API_TOKEN` — For Flux character reference generation (legacy)
- `GCP_PROJECT_ID`, `GCP_LOCATION`, `CLOUD_TASKS_QUEUE` — Cloud Tasks config

### Book pipeline — quad dual-spread illustrator (default on)

- **Default:** Quad path is **on** in code (`USE_QUAD_SPREAD_ILLUSTRATOR_DEFAULT` in [`services/bookPipeline/constants.js`](services/bookPipeline/constants.js)). Interiors use [`renderAllSpreadsQuad.js`](services/bookPipeline/illustrator/renderAllSpreadsQuad.js) unless overridden.
- **`GIFTMYBOOK_QUAD_SPREAD_ILLUSTRATOR`** — Optional override: `1` / `true` / `yes` / `quad` forces quad; `0` / `false` / `no` / `legacy` forces legacy [`renderAllSpreads.js`](services/bookPipeline/illustrator/renderAllSpreads.js).
- **Request override:** `useQuadSpreadIllustrator: true` or `false` on the generate-book payload (stored on `doc.request`) when you need per-book control without redeploying.
- **API:** Gemini Flash Image uses `imageConfig.aspectRatio: "4:1"` (supported on the Generative Language API). **OpenAI** path uses size **`1792x448`** (`OPENAI_QUAD_IMAGE_SIZE`) for quad batches; if the Images API rejects that size, fall back to Gemini for illustration or disable quad for that deployment.
- **Logs:** Filter `bookPipeline:*:quad` for batch lines (`spreadNumbers=[a, b]`, slice map); spread `13` logs `mode=single_spread` / `aspect=16:9` when present.
- **Gemini resilience:** 4:1 turns use a longer client timeout (`TURN_TIMEOUT_QUAD_MS`, 5 min in [`services/illustrator/config.js`](services/illustrator/config.js)). HTTP **503 / 504 / 429** and bodies mentioning **Deadline expired** / **UNAVAILABLE** / **RESOURCE_EXHAUSTED** are tagged as transient and retried with exponential backoff (same logical attempt) in [`renderAllSpreads.js`](services/bookPipeline/illustrator/renderAllSpreads.js) and [`renderAllSpreadsQuad.js`](services/bookPipeline/illustrator/renderAllSpreadsQuad.js).

## Illustrator V2 — enforcement tiers

Rules are layered: **session system instruction** and **per-spread prompt** carry the full policy (composition, characters, text, parent themes). **Per-spread QA** (text, anatomy, extra, style) catches repeatable defects and triggers in-session corrections. **Book-wide QA** (`bookWideGate`) is intentionally lenient and overlap-based; it may regen suspect spreads but does not hard-fail the book. Prefer fixing issues at the prompt layer; use QA telemetry (`bookContext.qaTagCounts`, `qaInfraErrors`) to see which tags drive retries.

## Writer V2 (selected picture-book themes)

- **Entry:** `services/writer/engine.js` — `WriterEngine.generate` (plan → write → `QualityGate` → revise loop → full regen waves).
- **Book id in logs:** pass `bookId` in the generate options (main pipeline does this) so every `[writerV2]` line is filterable in Cloud Logging.
- **Two planning passes (by design):** the job first brainstorms a **story seed** in `storyPlanner`, then Writer V2 runs its own **`plan()`** (beats, location palette, refrain). The seed is wired as `storySeed` so brainstormed beats are kept when valid. A future simplification is to merge into a single planner call; not required for correct output today.

## Conventions

- All functions use JSDoc comments
- Error handling with retries and exponential backoff
- Cost tracking per generation
- Progress reporting via webhook callbacks
