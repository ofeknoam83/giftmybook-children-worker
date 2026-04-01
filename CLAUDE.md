# giftmybook-children-worker

Cloud Run microservice that generates personalized children's books with AI-generated illustrations featuring a child's photo-realistic likeness.

## Architecture

- **Express server** on port 8080 with API key auth (`x-api-key` header)
- **CommonJS modules** throughout (no ESM)
- **Async pipeline**: POST /generate-book returns 202, processes in background, reports progress via callbacks

## Key Services

- `storyPlanner.js` — GPT-5.4 plans spread-by-spread story outline
- `textGenerator.js` — GPT-5.4 generates age-appropriate text per spread
- `illustrationGenerator.js` — Replicate Flux.1 + IP-Adapter FaceID for face-consistent illustrations
- `faceEngine.js` — Face embedding extraction and character reference generation
- `layoutEngine.js` — pdf-lib assembles spreads into print-ready PDF
- `coverGenerator.js` — Generates front/back/spine cover

## Book Formats

- **Picture books** (ages 3-6): 8.5x8.5", 12-16 spreads, rhyming text
- **Early readers** (ages 6-9): 6x9", 24-32 pages, simple chapters

## Environment Variables

- `API_KEY` — Auth key for incoming requests
- `GCS_BUCKET_NAME` — Google Cloud Storage bucket
- `OPENAI_API_KEY` — For GPT-5.4 text generation
- `REPLICATE_API_TOKEN` — For Flux illustration generation
- `GEMINI_API_KEY` — For Gemini Flash vocabulary/quality checks
- `GCP_PROJECT_ID`, `GCP_LOCATION`, `CLOUD_TASKS_QUEUE` — Cloud Tasks config

## Conventions

- All functions use JSDoc comments
- Error handling with retries and exponential backoff
- Cost tracking per generation
- Progress reporting via webhook callbacks
