# AI Writer Feedback Loop — Design Plan

**Status:** implemented on this branch (worker contract, tuning store + scoping, judge, compiler,
workbench + iterations, regression runs, quality map, proposals, AdminWriterTuning UI; remaining:
retargeting the legacy AIWriterFeedbackPanel, auto-PRs for sidecar proposals)
**Scope:** `giftmybook-standalone` (app) + `giftmybook-children-worker` (worker)
**Branch:** `claude/ai-writer-feedback-loop-u51rph`

## 1. Goal

Give admins a closed, converging improvement loop for the V1.3 children's writer:

1. Admin sets every parameter a customer would set (theme, child profile, age, details), picks a book, and generates the story **fast, text-only, no illustration spend**.
2. An **AI judge** scores each story on the seven craft traits from the Story Engine design doc and shows the scorecard in the UI.
3. Admin writes comments — per trait, per spread, per story, or general.
4. The system **compiles comments into a versioned, cumulative rulebook** that is appended to the writer's prompt dynamically — no redeploy.
5. Admin regenerates the *same inputs* under the new rules and compares side-by-side. Iterate until happy.
6. Admin **locks** a version (immutable forever; unlimited locked versions) and can separately **activate** one for production traffic.

After the one-time deploy that ships this feature, every iteration/lock/activation is pure data — **zero deployments**.

---

## 2. What exists today (grounding)

### Worker (`giftmybook-children-worker`)

- The writer is one pinned LLM call: the **locked** system prompt `data/writerEngine.system.md` (read once at boot, `services/catalogEngine/writer.js:23`) + a deterministic user prompt (`buildUserPrompt`, `writer.js:95-137`) → `openaiClient.callText` with `jsonMode`, 2-attempt retry with validation errors fed back (`writer.js:153-203`).
- `POST /v13/generate-stories` is already the fast, story-only admin test mode (202 + callback, per-candidate `failures[].errors`, token usage per story). No rate limit, no CostTracker on this route.
- **10-step deterministic validation** (`storyValidation.js`) gates every story: schema → version echo → spreads → title → refrain/beats → age bounds → evidence legality → caps/ordering → banned brands/leakage. The runtime contract's **step 10 — "optional editorial/LLM evaluator, never as the sole gate" — is explicitly reserved and unimplemented** (`docs/RUNTIME_CONTRACT_V1_3.md:84`). That is the sanctioned slot for the AI judge.
- The **version echo (step 2) is self-referential**: it compares `response.versions` against `request.versions`, both built from `versions.js` at request time. No test or fixture pins the version strings, and stored stories re-validate against their *own* pinned versions (`pipeline.js:79-85`). So a new version key is safe for old stories. One catch: the response schema has `additionalProperties:false` on `versions`, so adding a key requires a one-line schema addition.
- The writer prompt's own priority ladder (`writerEngine.system.md:7-19`, handoff `:59-66`) is: safety/schema → catalog beats → age engine → approved map → profile → **prose polish**. A dynamic layer legitimately slots in at "prose polish" priority and can never outrank the layers above it.
- **No runtime config fetch exists anywhere** — every input is boot-cached. Model choice is the only thing already runtime-swappable (`CATALOG_WRITER_MODEL`, read per call).

### App (`giftmybook-standalone`)

- Express + React/Vite + Prisma/Postgres on Render; admin JWT auth (`server/middleware/adminAuth.js`), access tiers in `client/src/lib/adminAccess.js`.
- **The fast admin generate path already works**: `dispatchTestBookGeneration(book, {textOnly:true})` (`server/services/childrenGeneration.js:177-196`) runs select-books → generate-stories with `{isAdmin:true, force:true}`, zero image spend, on an `isTestBook` ChildrenBook (excluded from all customer surfaces).
- `server/services/childrenStoryFlow.js` encodes non-negotiable concurrency invariants: dispatch-slot claim via conditional `updateMany`, callback ownership by `dispatchId`, 5-minute generating lease, `storyDispatchCount` spend budget. Any new dispatch path must go through it.
- **A v1 feedback loop already exists and dead-ends**: `AIWriterFeedbackPanel` (floating on every admin page) → `AdminFeedbackComment` + `WriterImprovementPlan` tables → `writerFeedbackAgent.js` (gemini-2.5-pro generalizes comments into fixes) → `POST /plans/:id/send` **emails the plan to a human** (`writerFeedback.js:266`, hardcoded recipient). Nothing ever writes back into a prompt. This plan closes that arc.
- Known defects to fix in passing: the two feedback tables have **no migration** (schema-only; prod runs `migrate deploy`), and `writerFeedback.js` reads `req.adminEmail` which is never set (should be `req.admin?.email`) — all attribution is lost.
- `engineVersions` on ChildrenBook already persists the pinned versions block per book (write-only today) — the natural place where the tuning version becomes traceable per customer book.
- Existing dynamic-config precedent: `systemSettings.js` over a `PipelineConfig` KV row — right shape, but single-row/overwrite-in-place; we add real versioning.

---

## 3. Core design: a versioned **Writer Tuning Layer**, not edits to the locked engine

**Comments never rewrite `writerEngine.system.md`.** The locked engine is safety-bearing and contract-validated. Instead, the loop produces a **Tuning Layer**: a versioned, structured set of *style directives* rendered as a block appended to the system prompt at "prose polish" priority.

Why this shape:

- **Bounded blast radius.** A bad directive can make prose worse; it cannot change plot facts, break the refrain, violate age bounds, or fabricate personalization — the 10 deterministic steps still gate every story after generation.
- **Immutability is natural.** A version is a self-contained materialized artifact (full directive set + rendered text + hash), not a diff chain. Locking = freezing a row.
- **Auditability.** Version N+1 = version N + operations derived from specific comments. Every directive carries provenance to the comments that created it.
- **It reconciles with the repo's stance** ("sidecars are versioned files, never generated at runtime"): the compiler *drafts*, the admin *approves and locks*, and production only ever runs **locked, admin-approved, versioned data** — the LLM never mutates production behavior on its own.

### 3.1 Directives, not freeform prompt blobs (the anti-circle core)

Each comment compiles into one or more **directives**:

```json
{
  "id": "dir_014",
  "trait": "musicality",            // one of the 7 judge traits, or "general"
  "scope": { "ageBands": ["1-3"] },  // multi-axis; empty/omitted axes = unrestricted (§6)
  "polarity": "do",                  // do | avoid
  "rule": "Read every spread aloud mentally; end at least 6 of 12 spreads on a stressed syllable.",
  "example": "…",                    // optional short good/bad example
  "strength": 2,                     // times reinforced by comments
  "provenance": ["cmt_881", "cmt_902"],
  "status": "active"                 // active | superseded | retired
}
```

The **Tuning Compiler** (LLM step, §5.3) receives the *current* directive set + the new comments and returns explicit operations: `add`, `strengthen` (merge into an existing directive), `supersede`, and — critically — `conflict` when a new comment contradicts an existing directive ("more playful" vs. an earlier "calmer tone"). Conflicts are **surfaced to the admin to resolve, never silently averaged**. This is what stops the loop running in circles: improvements accumulate in a deduplicated rulebook instead of each iteration re-deriving from scratch or oscillating between opposite instructions.

Directives are also **directly editable** in the UI — the compiler is an assistant, not the sole author.

### 3.2 Version model: draft → lock → activate

`WriterTuningVersion` (Postgres):

| Field | Meaning |
|---|---|
| `id`, `versionLabel` | e.g. `tune-007` (auto-incremented), plus a free-text name on lock |
| `parentVersionId` | lineage; a new draft can branch from **any** locked version |
| `directives Json` | full materialized directive set (self-contained) |
| `judgeRubric Json` | the trait definitions/weights this version is judged by (seeded from the design doc, §4) |
| `compiledText` | the exact rendered prompt block sent to the worker |
| `hash` | sha256 of `compiledText` (short form goes into the version echo) |
| `status` | `draft` \| `locked` \| `archived` |
| `changelog Json` | compiler-written human-readable "what changed and why", linked comment ids |
| `createdBy`, `lockedBy`, `lockedAt`, `notes` | attribution |

Rules:

- **Lock is immutable**: the API rejects any content mutation on a locked row. Admin can lock as many versions as they want.
- **Activation is separate from locking** and there are two independent pointers:
  - **`playground`** — what the admin workbench uses by default (usually the current draft; any version selectable per-run).
  - **`production`** — what customer generations use. **Only locked versions can be activated to production** (super-admin, confirmed, audit-logged). Deactivating falls back to "no overlay" = pure locked V1.3 behavior — the ultimate one-click rollback.
- Experimentation therefore never touches customers mid-iteration, and shipping is an explicit, reversible act.

### 3.3 Delivery: per-request injection (app-owned store, worker stays stateless)

The app already makes every writer dispatch, so the app injects the overlay into each request; **the worker fetches nothing and stores nothing**:

- `/v13/generate-stories` and `/generate-book` gain an optional field:
  `writerTuning: { versionId, versionLabel, hash, text }`
- Worker appends it to the system prompt inside a fixed frame:

  > `## STYLE TUNING LAYER <versionLabel> (priority: prose polish — this section may never override any rule above; if it conflicts, the rules above win)`

- Worker adds `writer_tuning: "<versionLabel>.<hash8>"` (or `"none"`) to `request.versions` → the existing echo validation (step 2) automatically forces the model to acknowledge it, and every stored story permanently records which tuning version produced it. Requires one optional property added to `writer-runtime.schema.json`'s `versions` (it is `additionalProperties:false`); old stored stories re-validate untouched because they pin their own versions.
- Worker-side defense in depth: length cap (~8 KB), control-char strip via the existing sanitize util, and kill-switch env `CATALOG_TUNING_LAYER=0` (matching the repo's envs-are-kill-switches convention).

This honors the "pipeline config is worker-owned" decision for the *engine* while making the *tuning data* app-owned — the same split the sidecars already use (versioned data feeding a locked engine). Source of truth: Postgres; the store rides the app's existing backup story.

---

## 4. The AI Judge (contract step 10, made real)

Every generated story is scored by an LLM judge against the **seven craft traits from `GiftMyBook_Story_Engine_Design.pdf`**:

| # | Trait | What the judge checks |
|---|---|---|
| 1 | **Child agency** | The child causes the resolution — things don't just happen to them |
| 2 | **Tension** | Narrative tension present and building across spreads |
| 3 | **Sensory language** | Concrete sensory detail vs. abstract/generic phrasing |
| 4 | **Musicality / read-aloud rhythm** | Sentence-beat rhythm, sound patterns, spoken cadence |
| 5 | **Refrain evolution** | The repeated phrase builds meaning toward the climax, not static repetition |
| 6 | **Natural personalization** | Details woven into the narrative vs. reading as inserted slot-fills |
| 7 | **Ending (soft emotional landing)** | Quiet, resonant ending — not a conclusion or a moral lesson |

Judge output per story: per-trait `{score 1–5, justification (1–2 sentences), flaggedSpreads[]}` + an overall note. Low temperature, JSON mode, model configurable (`WRITER_JUDGE_MODEL`, default `gemini-2.5-pro` via the existing `geminiProxy`, key-pooled).

Placement and rules:

- Runs **app-side** in a new `server/services/storyJudge.js`, triggered automatically when workbench stories land via the story callback (and on demand for any stored story). Keeping it out of the worker keeps generate-stories latency/cost unchanged and lets the judge evolve freely.
- **Advisory, never a gate** — exactly what the runtime contract demands ("never as the sole gate"). It informs the admin; the deterministic 10 steps remain the only hard gates.
- The **rubric itself is versioned data** on `WriterTuningVersion.judgeRubric` (trait definitions, anchors for each score, weights), seeded from the table above. Comments can refine trait definitions the same way they refine directives, and locking a version freezes the rubric it was judged by — so scores stay comparable within a version and honest across versions.
- Anti-Goodhart: the judge's scores are decision *support*; the human comparison view and golden set (§5.5) keep a human anchor, so the loop optimizes for the admin's taste, not for the judge's blind spots.

### UI

- A **scorecard** on every generated story: seven trait chips, 1–5 color-coded, justification on hover/expand, flagged spreads highlighted in the spread list.
- **Click a trait chip → comment box opens pre-tagged with that trait** (plus flagged-spread context). A general comment button sits beside it. This is the "comment on a specific trait or a general comment" flow.
- Iteration comparison shows **per-trait deltas** (e.g. Musicality 2 → 4, Ending 4 → 4) next to the side-by-side text diff.

---

## 5. The loop, end to end

### 5.1 Setup (Workbench "Playground" tab)

Admin fills the exact customer-facing parameters: catalog theme (from `GET /v13/themes`), child name/age/details (the V1.3 profile fields), plus workbench-only controls: **pin a specific `bookDefinitionId`** (for apples-to-apples iteration) or let selection produce a slate; choose the tuning version to test (default: current draft, "none" available as baseline).

Under the hood: creates an `isTestBook` ChildrenBook and reuses `childrenStoryFlow` unchanged (slot claim, dispatchId ownership, lease — all preserved).

### 5.2 Generate + judge

Dispatch `/v13/generate-stories` with the chosen `writerTuning`. Stories return in ~1 model call each (no images). The judge scores each story on arrival. UI shows spreads + scorecard + validation failures (`failures[].errors` — free structural signal).

### 5.3 Comment → Compile ("Apply comments")

Comments: `{target: trait|spread|story|general, trait?, spreadNo?, severity, text}` — stored by extending the existing `AdminFeedbackComment` (new nullable columns: `trait`, `spreadNo`, `storyRef`, `tuningVersionId`, `sessionId`, `scope Json`, `route`; plus the backfill migration and the `req.admin?.email` fix). Scope assignment and routing are described in §6.2–6.3.

"Apply comments" runs the **Tuning Compiler** (`server/services/writerTuningCompiler.js`, evolving `writerFeedbackAgent.js`): input = current directives + rubric + new comments + the commented story excerpts; output = proposed operations + changelog. Hard constraints in the compiler prompt: directives must be style-level only — never plot, refrain text, title, age-bound, or personalization-legality instructions (those are owned by higher layers and deterministically validated); caps of ~40 active directives and ~8 KB compiled text force `strengthen`/merge consolidation instead of unbounded prompt growth (prompt bloat is itself a way of running in circles).

**The admin reviews the proposed diff** (added / strengthened / superseded / conflicts-to-resolve), edits if desired, confirms → a new **draft** version is written (parent = previous), comments flip to `included` with a link to the version. Human approval every cycle is deliberate: it prevents drift from a misread comment.

### 5.4 Regenerate + compare

One click re-runs the **same inputs** (same profile, same pinned book) under the new draft. The UI shows previous vs. new side-by-side: text diff per spread, per-trait judge deltas, and the comments that drove the change inline. Same-input comparison is the only honest way to answer "did that comment actually improve the writer?"

### 5.5 Regression guard (the "deep, not circular" backstop)

- Admin can mark any (input, story) pair as **golden** ("this is how I like it") and maintain a small **regression case set** — fixed profiles × books spanning the four age bands (this is also the vehicle for the never-executed 48-book editorial matrix the handoff left outstanding).
- "Run regression" generates all cases under a candidate version and renders a **case × trait heatmap**: deterministic pass/fail, judge scores, and side-by-side against goldens.
- This catches the classic circle: fixing comment #12 regressing what comments #3–#7 achieved — visible as a trait score dropping on cases the admin already liked, *before* locking.

### 5.6 Lock, activate, roll back

- **Lock version** (name + notes) → immutable, listed forever in the Versions tab with lineage, changelog, linked comments, and regression results.
- **Activate for production** (separate, super-admin, confirmed) → next customer generation uses it instantly; the story's echoed `writer_tuning` and the book's `engineVersions` record it permanently.
- Roll back = activate any other locked version, or deactivate to pure V1.3. No deploys anywhere in this loop.

### Why this can't run in circles — summary

1. **Cumulative deduplicated rulebook** — improvements persist across iterations instead of being re-derived.
2. **Explicit conflict detection** surfaced to the admin, never silently averaged.
3. **Full provenance chain**: comment → directive → version → hash echoed in every story.
4. **Same-input regeneration** with side-by-side + per-trait deltas — change is measured, not vibes-judged.
5. **Golden/regression replay before lock** — new fixes can't silently undo old wins.
6. **Human approves every compiled diff** — the LLM proposes, the admin disposes.
7. **Caps force consolidation** — the prompt can't bloat its way into degradation.
8. **Honest routing (§6.3)** — comments that a prompt rule can't fix (slot structure, plot, config) are routed to the right artifact instead of being re-attempted as style rules forever.

---

## 6. Scoped control — themes, occasions, personalization details

A single global rulebook is not enough control: "calmer endings" may be right for bedtime themes and wrong for adventure ones. Directives therefore carry a **multi-axis scope**, and because the app renders the overlay per request (§3.3), all scope resolution happens app-side at dispatch time — **the worker contract never changes as the scoping model grows richer**.

### 6.1 Scope axes

A directive applies when every non-empty axis matches the request context; empty axes are unrestricted.

| Axis | Request context source | Example directive |
|---|---|---|
| `ageBands` | profile age → catalog band | "For 1–3: one clause per sentence; a sound word on every spread." |
| `themeIds` | the selected book's catalog theme | "Underwater books: water imagery must engage at least three senses." |
| `occasions` | workbench param / order gift context (app-side concept — never a worker field) | "Birthday books: anticipatory, celebratory cadence." |
| `detailKinds` | the categories of profile details present (pet, food, color, sibling…) | "When a pet detail is used: weave it through action, never state it as a fact." |
| `bookDefinitionIds` | the exact catalog book | "book_ocean_04: soften the storm spread — it reads scary for the band." |

Rendering order per request: global → age band → theme → occasion → detail-kind → book (most specific last), inside the same subordinate frame. Scoping is also the **scalability mechanism**: only applicable directives render, so the rulebook can grow across 12 themes × 4 bands without ever approaching the per-request size cap.

### 6.2 How scope gets assigned

The workbench knows the full context of every comment (theme, band, book, occasion, which detail kinds the story used). The compiler proposes a scope from the comment text plus that context ("this refrain feels babyish" on a 6–7 book → suggest `ageBands: ["6-7"]`), and the admin confirms, widens, or narrows it in the diff review — one selector: *this book / this theme / this age band / this occasion / when using [detail kind] / everywhere*. Cross-scope contradictions are legal and intentional: a theme-scoped rule contradicting a global one is recorded as a **scoped exception**, not a conflict; only same-scope contradictions surface as conflicts to resolve.

### 6.3 What the tuning layer may and may not control (honest routing)

Personalization *legality* — which slots exist, on which beats, with which fields — is owned by the approved sidecar maps and deterministically validated; plot facts are owned by the catalog. A prompt rule cannot and must not override either. So the compiler **classifies every comment** and routes it to the artifact that can actually fix it:

| Route | Meaning | Destination |
|---|---|---|
| `style` | phrasing, tone, rhythm, how details are woven | scoped directive — this loop, runtime-dynamic |
| `personalization-structure` | wrong/missing/misplaced slots ("this book shouldn't use food") | **sidecar change proposal**: a structured, reviewable edit to `data/augments/approved/{book_id}.json` — a versioned committed file, honoring the repo's never-generated-at-runtime rule |
| `plot-structure` | the beat sheet itself is weak | catalog/blueprint backlog — feeds the Story Engine migration; not fixable in V1.3 by design |
| `config` | word bounds, model choice, retry behavior | config proposal (ageEngines/env), reviewed like code |

Routed proposals land in a **Proposals queue** on the Rulebook tab with full comment provenance, so non-prompt fixes are captured and tracked instead of silently dropped. The loop controls what prompts can control at runtime and *routes* everything else to the right versioned artifact — that honesty is itself an anti-circle mechanism (no more re-commenting a slot problem that a style rule was never going to fix).

### 6.4 Scope-aware testing and measurement

- **Playground probes a scope directly**: pin theme + band + book, set the occasion, toggle which detail kinds the profile includes ("an underwater 1–3 book with a pet detail") — the admin iterates on exactly the slice being tuned.
- **Regression cases are tagged** on the same axes; the case × trait heatmap filters by them, and a coverage check warns when a scope has directives but no regression case ("you have 'space'-scoped rules but no space case").
- **Quality map**: judge scores aggregated by theme × band (and over versions) — a standing instrument showing where the writer is weak, which scope to tune next, and whether a version helped the scope it targeted without hurting the others.

## 7. Data model (Prisma — all with real migrations)

- **`WriterTuningVersion`** — §3.2.
- **`WriterTuningIteration`** — `{id, sessionBookId, iterationNo, tuningVersionId, dispatchId, storiesSnapshot Json, judgeResults Json, createdAt}` — snapshots each iteration's stories + scores before `storyOptions` is overwritten by the next dispatch.
- **`WriterRegressionCase`** — `{id, name, profile Json, bookDefinitionId, themeId, ageBand, occasion?, detailKinds[], goldenStory Json?, goldenVersionId?, enabled}` (the scope tags power the coverage check in §6.4).
- **`WriterRegressionRun`** — `{id, versionId, results Json, startedAt, finishedAt}`.
- **`WriterTuningProposal`** — the routed non-prompt queue (§6.3): `{id, kind: sidecar|catalog|config, targetId, details Json, provenance commentIds[], status: open|accepted|rejected|done, createdAt}`.
- **`WriterTuningEvent`** — append-only audit `{id, versionId?, action: created|compiled|edited|locked|activated|deactivated|regression_run, actorEmail, details Json, createdAt}` (pattern: `BookReviewHistory`).
- **Extend `AdminFeedbackComment`** (nullable: `trait`, `spreadNo`, `storyRef Json`, `tuningVersionId`, `sessionId`) + backfill migration (`CREATE TABLE IF NOT EXISTS`) for it and `WriterImprovementPlan`.

## 8. API surface (`/api/admin/writer-tuning`, adminAuth)

- Versions: `GET /versions`, `GET /versions/:id`, `POST /versions` (new draft from parent + confirmed compiler ops), `PATCH /versions/:id` (draft-only direct edits), `POST /versions/:id/lock`, `POST /versions/:id/activate` + `POST /deactivate` (super-admin), `GET /active`.
- Workbench: `POST /sessions` (params → isTestBook + slate), `GET /sessions/:id`, `POST /sessions/:id/generate` `{tuningVersionId, pinBookIds?}`, `GET /sessions/:id/iterations`.
- Loop: `POST /compile` `{sessionId, commentIds, baseVersionId}` → proposed ops (nothing saved until confirmed), `POST /judge` `{storyRef}` (re-judge on demand).
- Regression: `GET|POST /regression/cases` ("save iteration story as golden"), `POST /regression/run` `{versionId}`, `GET /regression/runs/:id`.
- Proposals: `GET /proposals`, `PATCH /proposals/:id` (accept/reject/done) — the routed sidecar/catalog/config queue.
- Insight: `GET /quality-map` — judge scores aggregated by theme × band × version.
- Comments: existing `/api/admin/writer-feedback/comments` with the new fields.

## 9. Worker changes (one-time deploy, deliberately small)

Note: nothing in §6 touches the worker — scope resolution, routing, proposals, and the quality map are all app-side. The worker's entire contract remains the optional `writerTuning` block below.

1. `writer.js`: `generateStory`/`buildStoryRequest` accept optional `tuning {versionLabel, hash, text}`; system prompt becomes `ENGINE_PROMPT + renderTuningBlock(tuning)`; `versions.writer_tuning = label.hash8 | 'none'`.
2. `writer-runtime.schema.json`: add optional `writer_tuning` to `versions`.
3. `server.js`: `/v13/generate-stories` + `/generate-book` accept/validate/pass `writerTuning` (type/length caps, sanitize); wire through `catalogEngine.generateStories` and `pipeline.js`.
4. `flags.js`: `CATALOG_TUNING_LAYER` kill-switch (default ON, `0` disables).
5. `versions.js`: no bump needed — `writerEngine.system.md` is untouched and the user-prompt template unchanged; the tuning version rides its own key. Document in CLAUDE.md.
6. Tests: keep the marker-string assertions in `engine.test.js:335-383` intact; add coverage for tuning append, caps, kill-switch, echo, and "no tuning" passthrough.

Everything else (validation, illustrator, PDFs, checkpoints) is untouched.

## 10. UI — one new page: `AdminWriterTuning` (four tabs)

1. **Playground** — setup form (theme, profile, book pin, occasion, detail-kind toggles, version selector) → story cards: spreads, **judge scorecard** (7 trait chips, click-to-comment), validation status, comment rail with scope selector; iteration timeline with side-by-side diff + trait deltas; "Apply comments" diff-review modal (scope confirmation + conflict resolution + route review).
2. **Rulebook & Versions** — version list (lineage, Draft/Locked/Active chips), directive table (editable in drafts; filter/pivot by trait, theme, band, detail kind), per-version changelog, **Proposals queue** (§6.3), lock/activate controls.
3. **Regression & Quality** — case list with scope tags, goldens, case × trait heatmap (filterable by theme/band), coverage warnings, the theme × band **quality map**.
4. **Writer Anatomy** — the de-black-boxing view: every layer of the real prompt assembly (locked engine → style tuning layer → book definition → age engine → personalization map → profile → versions echo → model → 10-step validation → judge) color-coded by **mutability class** — *dynamic via comments*, *runtime env config*, *versioned data via proposals*, or *locked (deploy)* — each with its live current value (`GET /anatomy` aggregates app state + the worker's `/v13/coverage` versions/models/flags) and a note on how it changes; a **live configuration table** (flags, models, pinned versions, sidecar coverage); and an **overlay preview** (`POST /overlay-preview`) rendering the exact tuning text the writer would receive for a chosen theme/band/occasion/detail-kind context, with per-directive matched/excluded-by-axis reasons.

Plus: register in `pages.config.js`; retarget the existing `AIWriterFeedbackPanel` (children context) to file comments into this loop with story context (keep the email path for `code_change`-class findings); link from `AdminChildrenBookDetails`'s slate view.

## 11. Safety & cost guardrails

- Deterministic validation always gates; judge is advisory; overlay capped and framed as lowest priority; production requires lock + super-admin activation + audit trail; one-click fallback to pure V1.3; worker env kill-switch underneath it all.
- Playground spend: per-day workbench dispatch budget + per-iteration token usage display (usage already returned per story; the worker route has no rate limit, so the app-side budget is the throttle).
- Compiler/judge inputs treat comments and story text as **data, never instructions** (same framing the profile already uses).

## 12. Phases

- **Phase 1 — plumbing (worker + store):** worker `writerTuning` contract + echo + kill-switch; Prisma tables + migrations; versions API; injection through `childrenStoryFlow` (playground only); bug fixes (§2). *Deploy both services once.*
- **Phase 2 — the loop:** Workbench Playground (incl. occasion + detail-kind controls), judge service + scorecard, trait/spread comments with scope assignment, compiler + diff-review + routing, draft versions, lock. *Loop fully usable.*
- **Phase 3 — confidence & control:** side-by-side compare + trait deltas, golden/regression sets + heatmap + coverage warnings, quality map, Proposals queue, production activation + audit, panel/BookDetails integration.

## 13. Relationship to the Story Engine (blueprint) design

The design doc proposes replacing the catalog with blueprint-driven plan→write→judge. This plan is the **compatible first step**: the judge rubric, the versioned prompt store, the workbench, and the regression harness are exactly the "manually score 20–30 generations, side-by-side A/B in the story-only admin mode" apparatus that migration requires. If/when blueprints land, the tuning loop becomes their evaluation and rollout harness rather than throwaway work.

## 14. Open decisions (defaults chosen, flag if you disagree)

1. **Version echo mechanics** — recommended: explicit optional `writer_tuning` schema key. Zero-schema-change fallback: suffix `writer_engine` as `1.3.0+tune.<label>.<hash8>` (any 1–80-char string validates).
2. **Occasion as content vs. tone** — occasion-scoped directives shape *tone* only (celebratory cadence, etc.). Making the story *mention* the occasion is content, which belongs to the profile/sidecar layer — that needs a deliberate profile-schema + sidecar evolution, not a tuning rule. Default: tone-only now; content later if wanted.
3. **Sidecar proposals → PRs** — Phase 3+ option: an accepted `personalization-structure` proposal auto-generates the sidecar file edit as a worker-repo PR (still human-merged, keeping the versioned-file guarantee).
4. **Judge on production stories** — Phase 3 option: judge the chosen story on every customer book and surface trait scores in AdminChildrenBookDetails (turns the loop into live QA and feeds the quality map real traffic), at ~1 cheap LLM call per book.
