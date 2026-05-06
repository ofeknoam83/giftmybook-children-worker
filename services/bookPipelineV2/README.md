# bookPipelineV2 — picture-book engine

Generation v2 for **picture books only** (`PB_INFANT`, `PB_TODDLER`,
`PB_PRESCHOOL`, `PB_EARLY_READER`). Chapter books and graphic novels keep
using the existing v1 (`bookPipeline/`) and `server.js` flows untouched.

## Why this exists

v1's writer-judges-itself loop cannot beat the regression cycle documented
across AA-CW-24 → AA-CW-28: every prompt rule that closes one defect class
gets routed around by a different one (identity rhymes → dropped AABB,
filler words → filler phrases, hair drift → age drift, all-of-the-above →
"where she is kept"-class meaning failures). v2 is structurally different.

See `/giftmybook_writer_v2_design.md` for the full architecture and the
17-stage pipeline. The principles, locked:

1. **Plan before write. Write before render. Render with a bible, not a prompt.**
2. **Different models for different jobs** — writer never judges itself.
3. **Intent is a first-class artifact** (`success_criteria` per spread).
4. **Determinism beats persuasion** — code where we can, LLM where we must.
5. **Personalization is structural, not cosmetic.**
6. **Age is a cognitive architecture.**
7. **Visual continuity is a contract bound to the cover.**
8. **Iterate small, save aggressively, fail loud.**
9. **Therapeutic intent without preachy content.**

## Phase status

| Phase | Status | Notes |
|---|---|---|
| 0 — scaffold + foundations | shipped | this PR |
| 1 — planning stages (1-7) wired with workflow shape | shipped | this PR (real activities; LLM calls real for cheap stages, stubbed-with-canned-JSON for expensive ones gated behind a flag) |
| 1.5 — real LLM for all planning stages | partial | this PR — interpreter, age, intent live; story planner / bibles / beat sheet live |
| 2 — writer loop (page writer + det gate + critic + revision) | shipped (vertical slice) | this PR — runs end-to-end on PB books |
| 3 — illustrator port (cover-first contract) | NOT YET — uses v1 illustrator | next PR |
| 4 — Temporal proper (replace in-process workflow engine) | NOT YET | next PR |

## Workflow engine (interim)

Tonight's build uses a **lightweight in-process workflow engine** that mimics
Temporal semantics: every activity output is persisted as a content-addressed
artifact, every workflow can resume from any artifact, retries are bounded,
failures are loud. The interface is intentionally Temporal-shaped so the
swap is mechanical when we stand up Temporal proper.

See `orchestration/workflowEngine.js` for the contract.

## Hard cutover

`server.js` routes every request with `format === 'picture_book'` to
`bookPipelineV2.generateBook` (which adapts to the same v1 response shape so
the downstream PDF / cover / upsell code is untouched). Chapter books and
graphic novels are untouched. Early-reader keeps v1 for now (it's not a
picture book and nothing in v1's writer-judge loop has burned us on it).

Set env `BOOK_PIPELINE_V2=off` to revert to v1 instantly without redeploy
(emergency switch — default is `on`).

## Files

- `orchestration/workflowEngine.js` — Temporal-shaped in-process engine
- `orchestration/workflows/createBook.workflow.js` — top-level workflow
- `orchestration/activities/*.js` — one activity per pipeline stage
- `gate/` — deterministic gate (identity rhyme, filler phrases, headline
  noun repeat, imperfect rhyme, line-length window, banned phrases,
  protagonist anti-verb)
- `ageProfiles/PB_*.json` — declarative age constraints
- `lexicons/*.json` — banned phrases, filler phrases, anti-verbs
- `artifactStore/` — content-addressed JSON artifact store
- `llm/` — model router (writer = OpenAI, critic = Gemini, or vice versa)
- `index.js` — public entry: `generateBook(rawRequest, opts)`

## Test coverage

See `__tests__/services/bookPipelineV2/` for unit tests of the gate, the
workflow engine, the age-profile loader, and end-to-end workflow happy path
with mocked activities.
