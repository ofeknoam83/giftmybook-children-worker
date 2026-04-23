# bookPipeline

New children book generation pipeline. Replaces the legacy
`storyPlanner` + `writer/engine` + `illustrator/index` path with a single
staged orchestrator.

## Public API

```js
const { generateBook, PipelineError } = require('./services/bookPipeline');

const { document, layout } = await generateBook(rawRequest, {
  onProgress: event => {},
  abortSignal,
  bookId,
});
```

`rawRequest` is the existing `/generate-book` payload. The response
contains:

- `document` — the canonical book document (schema + trace + QA history)
- `layout` — layout payload ready to feed into `services/layoutEngine.assemblePdf`

`PipelineError.failureCode` is machine-readable; see
`constants.FAILURE_CODES`.

## Stages (orchestrated in `index.js`)

1. `input/normalizeRequest` — validate payload, require approved cover.
2. `planner/createStoryBible` — narrative spine (OpenAI, strict JSON).
3. `planner/createVisualBible` — style, hero locks, cast policy.
4. `planner/createSpreadSpecs` — 13 spread contracts.
5. `writer/draftBookText` — full manuscript.
6. `writer/rewriteBookText` — QA + targeted rewrite loop.
7. `illustrator/renderAllSpreads` — cover-anchored Gemini session, per-spread QA + repair.
8. `qa/checkBookWide` — whole-book review.
9. `adapters/toLayoutPayload` — layout-ready artifact.

## Design rules

- The canonical `bookDocument` is passed through every stage. Stages never mutate previous fields.
- All retries record a structured entry in `doc.retryMemory` so next attempts differ materially.
- Illustrator uses the approved cover as the only character/style anchor. The uploaded child photo is NOT used for interior continuity.
- Text is painted INTO each illustration; layout does not render caption text.
- OpenAI is the primary model for reasoning stages; Gemini handles image generation and vision QA.
