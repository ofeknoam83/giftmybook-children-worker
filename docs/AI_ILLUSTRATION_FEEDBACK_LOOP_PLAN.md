# AI Illustration Feedback Loop — Design Plan

**Status:** implemented on this branch (worker: Art Tuning Layer + tag-keyed render cache +
`/v13/render-spreads` probe endpoint + coverage extension; app: tuningDirectives factory +
illustrationTuning store, proxyVision + judge, compiler, workbench + regression, migration,
callbacks, `/api/admin/illustration-tuning` routes, `AdminIllustrationTuning` UI + `RenderAnatomy`
+ the Art Bench deep link from writer story cards; remaining: one-click cover generation for
anchors, `AdminChildrenBookDetails` spread integration, judge-on-production). The plan was
revised against the SHIPPED writer-loop implementation before building — the mirrored mechanics
below cite the real code.
**Scope:** `giftmybook-standalone` (app) + `giftmybook-children-worker` (worker)
**Branch:** `claude/illustrations-feedback-loop-2th4ns`
**Sibling:** `docs/AI_WRITER_FEEDBACK_LOOP_PLAN.md` (shipped) — this plan deliberately mirrors its
architecture (versioned tuning layer → judge → comments → compiler → lock → activate) and reuses its
app infrastructure wherever the illustration domain allows.

## 1. Goal

Give admins the same closed, converging improvement loop for the V1.3 **slim illustrator** that the
writer already has:

1. Admin picks a finished story (usually straight from a Writer Tuning workbench session), picks a
   **subset of spreads**, and renders them **cheaply — no PDFs, no cover, no upsell spread**.
2. An **AI vision judge** scores each render on illustration craft traits (identity fidelity, action
   fidelity, composition, style integrity, world consistency, emotion, props, cleanliness) and shows
   the scorecard next to the image.
3. Admin writes comments — per trait, per spread, per book, or general.
4. The system **compiles comments into a versioned, cumulative Art Tuning rulebook** appended to the
   render prompts dynamically — no redeploy.
5. Admin re-renders the *same story + same spreads + same identity anchor* under the new rules and
   compares images side-by-side. Iterate until happy.
6. Admin **locks** a version (immutable forever) and separately **activates** one for production
   renders.

After the one-time deploy that ships this feature, every iteration/lock/activation is pure data —
**zero deployments**.

---

## 2. What makes illustrations different (the four honest constraints)

The writer loop's shape carries over, but four properties of image generation force real design
changes. Naming them up front is what keeps this loop from being a cargo-culted copy:

1. **Cost.** A story is one text call; a full book is 12+ image renders plus QA calls. The
   iteration unit therefore cannot be "generate the whole book" — it is a **spread probe**: render
   K chosen spreads (default 3) of an existing validated story. Story spend is zero (the story is
   reused, never regenerated) and image spend is K renders, not 12.
2. **Non-determinism.** Two renders of the identical prompt differ. Same-input regeneration — the
   writer loop's honesty mechanism — is only meaningful with (a) optional seeding in the workbench
   (`generationConfig.seed` already exists behind `BOOK_PIPELINE_V3_RENDER_SEED`,
   `illustrationGenerator.js:858-862`, retried without on a seed-rejecting 400), and (b) an explicit
   **variance baseline** (§5.5): render one spread 3× under *no* tuning before attributing any
   visual change to a directive. Single-sample comparisons are labeled as such in the UI.
3. **The render cache would silently defeat the loop.** Renders replay from
   `children-jobs/{bookId}/ce-renders/{STYLE_VERSION}/{storyHash}/spread-N.{aspect}.png`
   (`illustrator/index.js:50-52`). A tuning overlay changes pixels, so the overlay tag MUST become
   part of the cache key (§7.2) — otherwise iteration 2 replays iteration 1's images and, worse, a
   production activation would ship pre-activation cached art under a new tag's name.
4. **The identity anchor is an input, not a given.** Every render anchors on the parent-approved
   cover (raw photo only as coverless-test fallback; no anchor at all fails with
   `missing_identity_reference`, `illustrator/index.js:205-225`). A workbench session therefore
   needs an explicit anchor setup step (§5.1), and "identity fidelity" — the single most
   customer-visible trait — is judged **against that anchor image**, which the judge receives.

One thing is the same and load-bearing: like the writer's 10 deterministic steps, the worker's
existing spread QA (`spreadQa.js` — closed critical list: painted text, missing/duplicated child,
broken medium, one corrective re-render, ship-with-advisory) **remains the only shipping gate**.
The new judge is advisory decision-support for admins; it never gates a render.

---

## 3. What exists today (grounding)

### Worker (`giftmybook-children-worker`)

- The slim illustrator is deliberately dumb: the fixed catalog beat IS the scene
  (`illustrator/scenes.js` — deterministic `buildScenePrompt`: beat action, world, single-child
  identity line, companion when the beat names them, inert quoted personal props from validated
  evidence), style/medium language is owned entirely by the renderer (the frozen `PIXAR_STYLE`
  single source of truth in `services/shared/illustration/config.js`, rendered via
  `renderStyleBlock`), and identity is carried by the reference image + `characterDescription`
  blocks in `buildCharacterPrompt` (`illustrationGenerator.js:444+`).
- Per spread: one render + ONE vision QA (`CATALOG_QA_VISION_MODEL`, default `gemini-2.5-flash`) +
  one corrective re-render (`repairNote`), then ship-with-advisory. A `.qa.json` marker beside each
  cached render records QA completion; a cached render without one is re-checked, never silently
  approved.
- `renderSpread` (`illustrator/index.js:58`) is the single render path — cache check → render →
  QA → repair → marker. Any workbench probe MUST go through this exact function, or the loop tunes
  a path production doesn't run.
- **There is no per-spread render endpoint**: `/regenerate-illustration` is a 410 stub
  (`server.js:614-622`), and the only way to produce interior renders is the full `/generate-book`
  pipeline (12 renders + upsell + interior PDF + cover PDF).
- The `writerTuning` contract is the proven precedent for a runtime overlay: request-field
  validation before the 202 (`validateTuningInput`, `writer.js:45-68`), normalize + kill-switch
  (`normalizeTuning`, `CATALOG_TUNING_LAYER`), fixed subordinate frame (`buildSystemPrompt`),
  byte-capped text, tag echoed on every stored story (`versions.writer_tuning = label.hash8`).
- `STYLE_VERSION` (`versions.js`, currently `ce-1`) is the deploy-owned global cache invalidator.
  It stays deploy-owned: the tuning tag becomes a *second, data-owned* cache dimension, not a
  replacement.
- Seeds: `generationConfig.seed` support exists but is env-gated OFF and model-dependent
  (`illustrationGenerator.js:858-894`).

### App (`giftmybook-standalone`) — how one writer round ACTUALLY flows

The whole writer-loop chassis is live; the art loop mirrors its exact mechanics, so they are worth
tracing precisely. **This plan adds an art dimension to that chassis rather than cloning it.**

One workbench round (`writerTuningWorkbench.js:generateIteration`):
`POST /sessions/:id/generate` → per-day budget check (count of today's iterations, UTC midnight,
vs `WRITER_TUNING_DAILY_ROUNDS`, default 100) → ensure the slate → resolve the overlay for THIS
context (`renderOverlay(version, contextForBook(book, ids))`) → **reserve the iteration row BEFORE
the worker call** (iterationNo, dispatchId, tuningTag, and a `params` snapshot: scope context +
full profile + the version's rubric + requestedBy — so a fast callback always finds its owner and
a mid-generation draft edit can't change what the round is judged by) → dispatch through
`childrenStoryFlow.dispatchStoryGeneration` with `{isAdmin: true, force: true, dispatchId,
writerTuning, overrideBookIds}` → **a dispatch failure deletes the reservation**. The worker
validates EVERYTHING before its 202 (ids, profile, age-band routing, `validateTuningInput`) and
echoes `dispatchId` on the callback (`postWithRetry`). The standard `/api/children/story-callback`
applies slot-ownership rules (`applyStoryCallback`: only the run whose dispatchId still owns
`storyOptions` may land), then fire-and-forgets `captureIteration`, which fills
stories/failures by dispatchId and judges under the rubric snapshot — never throwing, never
touching customer flow.

Other load-bearing contracts the art loop must reproduce:

- **Tri-state tuning semantics** in `dispatchStoryGeneration`: `writerTuning` *undefined* = look up
  the ACTIVE production version's overlay; *null* = bare engine (workbench baseline); *an object* =
  send as-is (workbench version under test). The workbench never implicitly inherits production.
- **Compiler output contract** (`writerTuningCompiler.js:normalizeCompileOutput`): ops are
  `add | strengthen | supersede | conflict`; `routes[]` classifies EVERY comment; ops naming a
  non-existent target directive are DROPPED and counted (`droppedOps`), never silently ignored;
  comments no surviving op or proposal cites land in `unhandledCommentIds` and stay PENDING (no
  default-to-style); an admin-declared comment scope is AUTHORITATIVE over the model's proposal;
  `proposedDirectives` is precomputed via the pure `applyOps` so the UI diff shows the exact
  resulting rulebook. Nothing persists at compile time.
- **Confirm is ONE transaction** (`POST /versions`): the new draft, flipping the source comments to
  `status:'included'` + `tuningVersionId`, and creating the routed proposals commit together — a
  partial failure can neither orphan a version nor duplicate proposals on retry.
- **Judge suggestions**: the judge emits a `suggestion` only for traits scoring ≤ 3; *accept* files
  a real `AdminFeedbackComment` attributed to the accepting admin (severity derived from the
  score, `storyRef.suggestedBy:'judge'`), *dismiss* just records the decision; either way a
  `suggestionState` is stamped into the iteration's judge JSON so the suggestion never re-prompts
  (`resolveSuggestion`). The judge proposes; only the admin's accept enters the loop.
- **Regression runs** use a DEDICATED callback (`/api/children/tuning-regression-callback?runId=&caseId=`,
  worker-auth), a raw-SQL jsonb-atomic append guarded by per-case containment (worker callback
  RETRIES cannot double-append a case), auto-close when `entries` reaches `expected`, a rubric
  snapshot taken at run START, and 30-minute stall reconciliation applied on read
  (`reconcileStaleRegressionRuns`) because the dispatch loop is in-process.
- **Anatomy endpoints**: `GET /anatomy` (worker `/v13/coverage` cached 60s + app config + active/
  draft version summaries), `POST /story-anatomy` (rendered inline by the lazy `StoryAnatomy`
  component on every story card), `POST /overlay-preview` (`explainOverlay`: exact overlay text +
  per-directive matched/excluded-by-axis reasons).
- **UI**: ONE page, four tabs (`Playground`, `Rulebook & Versions`, `Regression & Quality`,
  `Writer Anatomy`), registered in `pages.config.js` and `AdminFloatingNav`; story cards carry
  inner story/judge/comments tabs, the scorecard rail with per-trait deltas vs the previous
  round, click-to-comment with a scope selector, and the `CompileReview` diff modal.
- `AdminFeedbackComment` already carries `trait`, `spreadNo`, `storyRef`, `scope`, `route`,
  `sessionBookId` — exactly what art comments need too (plus an `area` discriminator, §8).
- `dispatchTestBookGeneration(book, {textOnly:false})` can run a full-book test render, but at full
  cost (12 renders + PDFs + cover + upsell) — it stays as the **final pre-lock confirmation**, not
  the iteration unit.
- The completion callback already persists `previewImageUrls`, `qaAdvisories`, `storyContent`,
  `engineVersions`, `illustratorVersionUsed` (`routes/children.js:551+`) — the natural place for
  the art-tuning tag to land per customer book.
- `geminiProxy.proxyText` is text-only; the vision judge needs a small `proxyVision` sibling
  (text + N inline images) — the image-parts plumbing already exists in the proxy's image path.
- Production overlay injection precedent: `buildWorkerPayloadWithTuning`
  (`childrenGeneration.js:74-83`) resolves the writer overlay per dispatch; the art overlay joins it
  there (§9) — but attaches to EVERY `/generate-book` dispatch, not only fresh-story ones, because
  every dispatch renders.

---

## 4. Core design: a versioned **Art Tuning Layer**, not edits to the locked style

**Comments never rewrite `PIXAR_STYLE`, `scenes.js`, or the QA prompt.** Those are deploy-owned and
version-bumped (`STYLE_VERSION`). The loop produces an **Art Tuning Layer**: a versioned, structured
set of *visual style directives* rendered per request and appended to each spread's scene prompt in
a fixed subordinate frame.

Same rationale as the writer layer, same guarantees:

- **Bounded blast radius.** A bad directive can make art worse; it cannot disable the child-count /
  no-text / medium rules (the closed QA list still checks every render), cannot touch layout or
  PDFs, and cannot alter the scene's beat action — the frame subordinates it to everything above.
- **Immutability, auditability, provenance** — identical version model to `WriterTuningVersion`
  (§3.2 of the writer plan): materialized directive set + hash, draft → lock → activate, lineage,
  changelog, append-only events.
- **The worker stays stateless.** The app resolves scope and renders the overlay per dispatch; the
  worker validates, caps, frames, echoes, and has a kill-switch. The worker contract never changes
  as the scoping model grows.

### 4.1 Directives

Identical schema to writer directives (id/trait/scope/polarity/rule/example/strength/provenance/
status — reuse `normalizeDirective` wholesale), with art-specific trait keys (§5) and two extra
scope axes (§6.1): `spreads` (1–12) and `aspects` (`square`|`wide`). Example:

```json
{
  "id": "dir_007",
  "trait": "composition",
  "scope": { "ageBands": ["1-3"], "aspects": ["square"] },
  "polarity": "do",
  "rule": "Frame the child large and close — face clearly readable at arm's length; avoid wide establishing shots except on spread 1.",
  "strength": 3,
  "provenance": ["cmt_1201", "cmt_1240"],
  "status": "active"
}
```

The **Art Tuning Compiler** (§5.3) is the writer compiler with an art prompt: same operations
(`add`/`strengthen`/`supersede`/`conflict`), same conflict-surfacing, same directive editability.

### 4.2 Wire contract (the worker's entire surface for this feature)

`/generate-book` and the new `/v13/render-spreads` (§7.1) gain one optional field:

```json
"illustrationTuning": {
  "versionLabel": "art-003",
  "hash": "<sha256 of the directive set>",
  "text": "<global directive lines>",
  "spreads": { "3": "<extra lines for spread 3 only>", "9": "..." }
}
```

- `text` is the scope-resolved global overlay (all rendered spreads); the optional `spreads` map
  carries spread-scoped lines so a directive aimed at spread 9 never rides (and never bleeds into)
  the other eleven render prompts. Caps: `text` ≤ 2000 UTF-8 bytes, each `spreads` entry ≤ 400,
  ≤ 3000 total — image prompts are already long, and a fat overlay dilutes the identity/style
  blocks that matter more.
- Validation mirrors `validateTuningInput` exactly (label/hash regexes, control-char strip,
  visible-after-sanitize, byte caps) and 400s before the 202.
- The worker appends, per spread, inside a fixed frame at the END of the scene description (after
  the props/consistency lines in `buildScenePrompt`, before `renderSpread` hands it to
  `generateIllustration`):

  > `ART TUNING <label.hash8> (admin-approved style refinement — lowest priority): the notes below
  > refine rendering style ONLY. They can never override the action, the character identity or
  > count rules, the no-text rule, the 3D medium, or any safety rule above; if any note conflicts,
  > ignore that note.`

- Kill-switch: `CATALOG_ART_TUNING_LAYER=0` (matching the envs-are-kill-switches convention;
  `CATALOG_TUNING_LAYER` stays writer-only).
- **Echo:** the tag `<label>.<hash8>` (or `none`) is (a) baked into the render cache path (§7.2),
  (b) written into each `.qa.json` marker, (c) returned on the completion callback as
  `illustrationTuningUsed` and inside `storyContent.catalog.illustrationTuning` — NOT inside the
  story's `versions` echo, which is writer-owned, schema-frozen (`additionalProperties:false`), and
  pinned at story time, while the art tag is pinned at render time. The app persists it on the
  book's `engineVersions` alongside the writer tag.

---

## 5. The AI vision judge and the loop, end to end

### Judge traits (the seed rubric — versioned data on the tuning version, like the writer rubric)

| # | Trait | What the judge checks |
|---|---|---|
| 1 | **Identity fidelity** | The child matches the anchor image: face, hair, skin tone, outfit — judged WITH the anchor supplied |
| 2 | **Action fidelity** | The image depicts the beat's exact moment, child actively causing it (not posing beside it) |
| 3 | **Composition** | Clear focal hierarchy, child prominent, uncluttered; for `embedded` layout, a usable quiet zone for type |
| 4 | **Style integrity** | Premium 3D CGI feature-film medium — no flat/painterly/photo drift (finer-grained than QA's binary check) |
| 5 | **World consistency** | Setting, era, palette, lighting coherent with the theme's fixed world — and stable across the probe's spreads (book-level pass) |
| 6 | **Emotion** | Readable facial acting and body language matching the spread text's mood |
| 7 | **Personal props** | Declared visual evidence props present, natural, decorative — never plot-critical or text-like |
| 8 | **Technical cleanliness** | Anatomy, hands, artifacts, accidental lettering (advisory duplicate of QA's hard check, with nuance) |

Mechanics:

- Runs **app-side** in `server/services/illustrationJudge.js` on probe-callback arrival (and on
  demand), via a new `proxyVision` helper (text + anchor image + render image(s)), model
  `ILLUSTRATION_JUDGE_MODEL` (default `gemini-2.5-pro`). Two passes per iteration: per-spread
  (traits 1–4, 6–8, each render judged with the anchor + beat + spread text) and one book-level
  pass (trait 5, all probe renders in one multi-image call).
- Output per render: `{trait, score 1–5, justification, suggestion?}` — same shape, defensive
  normalization (exactly the rubric's traits, scores clamped), and stinginess calibration as
  `storyJudge.js`; per-render failures return `{error}` instead of throwing (advisory — never
  fails a round). Suggestions only on traits scoring ≤ 3; *accept* files an
  `AdminFeedbackComment` (`area:'art'`, trait, spreadNo, severity from the score, a render ref
  with `suggestedBy:'judge'`) attributed to the accepting admin, *dismiss* records the decision,
  and either way `suggestionState` is stamped into the art iteration's judge JSON so it never
  re-prompts — via an art `resolveSuggestion` mirroring the workbench one (the writer's is
  story-shaped and reads `iteration.stories`; this one reads the iteration's renders).
- **Advisory, never a gate.** The worker's closed QA list remains the only shipping gate; the
  judge's QA-overlapping traits exist so admins see *degree*, not just pass/fail.
- Anti-Goodhart: vision LLMs are known-weak exactly where this loop cares most (fine identity
  likeness). The judge is decision support; the side-by-side image comparison and golden renders
  (§5.5) keep the human anchor, and identity complaints route to the anchor itself when that is the
  actual culprit (§6.3).

### 5.1 Setup (Workbench "Art Bench" tab)

An art session hangs off the SAME workbench session (and `isTestBook` book) the writer loop uses:

- **Story:** pick any story from the session's writer iterations (or paste a stored pair) — the
  pair is snapshotted into the art iteration, so later writer rounds can't mutate it. Story text is
  frozen for the whole art session: apples-to-apples renders require identical scene inputs.
- **Identity anchor:** upload a child photo or pick a saved sample child, then (recommended,
  one-click, ~1 render) **generate a cover** via the existing `coverGenerator` so the probe anchors
  exactly the way production does. Photo-only anchoring is allowed but badged "photo-anchored —
  production anchors on the approved cover" (it exercises the fallback path, `illustrator/index.js:205`).
- **Spreads:** pick K spreads (default 3 — suggested: 1 (establishing), a middle action beat, 9/10
  (climax)); pick `textLayout` (drives aspect); pick the tuning version (default current draft;
  "none" as baseline).

### 5.2 Render + judge

A probe round reproduces `generateIteration`'s reservation discipline exactly: budget check
(§11) → **reserve the `IllustrationTuningIteration` row BEFORE the worker call** (iterationNo,
dispatchId, tuningTag, `params` snapshot: the pinned story pair, spreads, anchor URL + kind,
textLayout, scope context, the version's rubric, requestedBy) → dispatch `/v13/render-spreads`
(§7.1) with the dispatchId → **delete the reservation if the dispatch itself fails**.

One deliberate divergence from the writer round: probes do NOT go through
`childrenStoryFlow.dispatchStoryGeneration`. That path exists to guard mutable book state
(`storyOptions` slot claims, spend budget column, choice invalidation) — a probe touches none of
it, so its ownership is simply the reserved iteration row. The callback is therefore a DEDICATED
route (`/api/children/render-probe-callback`, worker-auth — the regression-callback pattern, not
the story-callback one): it verifies the echoed dispatchId against the reserved row, writes
`renders`/`failures` idempotently (worker callback retries must not double-apply), returns 200
fast, then judges fire-and-forget under the rubric snapshot — logged, never thrown, exactly
`captureIteration`'s posture.

UI shows image cards: render, per-trait chips, worker QA verdict/advisories (free signal, same as
`failures[].errors` in the writer loop), zoom + anchor overlay toggle for likeness checking.

### 5.3 Comment → Compile ("Apply comments")

Comments: `{target: trait|spread|book|general, trait?, spreadNo?, severity, text}` — stored in
`AdminFeedbackComment` with `area:'art'`. "Apply comments" runs the **Art Tuning Compiler**
(`illustrationTuningCompiler.js`, the writer compiler's prompt swapped). Input mirrors the real
compile route's excerpt-gathering: where the writer route pulls the commented spread's text ±1,
the art route pulls each comment's render context — the beat + spread text, the QA verdict, the
judge's justifications, and the commented render itself as an image part (through the same
`proxyVision` helper the judge uses). Hard constraints in the compiler prompt: directives must be
rendering-style-level only — never scene actions, character count, text policy, medium identity,
layout, or QA thresholds (each of those routes elsewhere).

The output honors `normalizeCompileOutput`'s exact contract: ops `add | strengthen | supersede |
conflict`; `routes[]` classifying EVERY comment against the art routes (§6.3); ops naming
non-existent target directives dropped and counted; comments nothing cites landing in
`unhandledCommentIds` and staying PENDING; admin-declared comment scope authoritative over the
model's; `proposedDirectives` precomputed via the pure `applyOps`. Caps (~30 active directives /
the §4.2 byte caps) force consolidation. **Admin reviews the diff, resolves conflicts, confirms →
new draft version** — and the confirm is the same single transaction as the writer's
`POST /versions`: draft + comment inclusion + routed proposals commit together.

### 5.4 Re-render + compare

One click re-runs the same story/spreads/anchor/layout under the new draft. Because the tuning tag
is in the cache key, unchanged spreads under an unchanged tag replay free, and the new tag renders
fresh — no `forceRerender` needed between versions. The comparison view shows previous/new images
side-by-side per spread with per-trait judge deltas and the driving comments inline — flagged
"single sample" unless a variance probe (§5.5) backs it.

### 5.5 Variance baseline + golden renders + regression

- **Variance probe:** render ONE spread 3× under the same version (cache bypassed via a probe
  nonce) to calibrate what run-to-run noise looks like before crediting/blaming a directive.
  Surfaced once per session as a cheap honesty tool, with the judge's per-trait spread shown.
- **Goldens:** mark any render as golden ("this is the look"). Golden renders + their pinned
  story/anchor/spread become **regression cases**
  (`{name, storyPair, spreads, anchorUrl, textLayout, themeId, ageBand, goldenRenders, enabled}`).
- **Regression run:** all enabled cases rendered under a candidate version → judged → case × trait
  heatmap with golden thumbnails beside candidates. Because cases pin story pairs, regression spends
  ZERO writer tokens and exactly `Σ spreads` renders — the run screen shows the render count and
  requires confirmation. Mechanics are the writer run's, verbatim: sequential background dispatch
  to a dedicated callback (`?runId=&caseId=`, worker-auth), a rubric snapshot taken at run START,
  jsonb-atomic entry append with the per-case containment guard (worker callback retries cannot
  double-append), auto-close when `entries` reaches `expected`, and 30-minute stall reconciliation
  on read — generalized so both loops share the run/append/reconcile helpers rather than forking
  them. Entries carry render URLs + QA verdicts + judge scores.

### 5.6 Lock, activate, roll back

Identical to the writer loop: lock = immutable; activate = separate, super-admin, audited, pointer
in `pipeline_config` row `illustration_tuning_state`; deactivate = pure `STYLE_VERSION` behavior —
one-click rollback with no deploy. Lock/activate/deactivate mirror the writer routes exactly
(activate/deactivate gated on `accessLevel === 'super_admin'` at the route, audited via the shared
event log). A **pre-lock full-book confirmation** (the existing `dispatchTestBookGeneration` full
render, 12 spreads + PDFs) is offered — the probe iterates cheaply, but a version should see one
whole book before production. That confirmation passes the CANDIDATE version's overlay explicitly,
using the writer dispatch's tri-state semantics (`illustrationTuning` object = as-is, `null` =
bare, *undefined* = production lookup) — a pre-lock test must never silently render under the
production pointer. On activation, the cache-key
tag means new customer renders are all-or-nothing under the new tag: an in-flight book that
checkpointed mid-render before activation resumes its remaining spreads under the NEW tag (the
completion callback reports the tag that actually rendered; a mid-book activation is rare and
visible, not silent).

### Why this can't run in circles

All eight writer-loop mechanisms carry over (cumulative deduplicated rulebook, surfaced conflicts,
provenance chain, same-input comparison, goldens/regression, human-approved diffs, caps, honest
routing) **plus** the two image-specific ones: the variance baseline (change must beat noise) and
the tag-keyed cache (an iteration can never accidentally re-show old pixels as new).

---

## 6. Scoped control

### 6.1 Scope axes

Writer axes minus `occasions` (occasion shapes prose tone; the fixed beat owns the visual moment),
plus two art-specific ones:

| Axis | Example directive |
|---|---|
| `ageBands` | "1–3: simpler backgrounds, fewer background objects, larger character scale." |
| `themeIds` | "Underwater books: caustic light patterns; palette stays teal/aqua, never murky green." |
| `bookDefinitionIds` | "book_space_07: the rocket interior reads too dark — warm key light on the child's face." |
| `detailKinds` | "Pet props: the pet is small and secondary, never sharing the focal plane with the child." |
| `spreads` | "Spread 1: wide establishing shot of the world; the only spread where the child may be small in frame." |
| `aspects` | "Wide (embedded) renders: keep the left third calm and low-contrast for the text zone." |

Resolution happens app-side at dispatch time (reuse `directiveApplies`/`renderOverlay` with the two
new axes); spread-scoped lines render into the wire `spreads` map instead of the global text, so
per-spread scoping costs nothing on the other spreads' prompts. Same general → specific ordering
and drop-least-specific-first overflow rule.

### 6.2 Scope assignment

Same flow as the writer loop: the compiler proposes a scope from the comment + its render context
(theme, band, book, spread, aspect, props present); the admin confirms/widens/narrows in the diff
review. Cross-scope contradictions are scoped exceptions; same-scope contradictions are conflicts.

### 6.3 What the Art Tuning Layer may and may not control (honest routing)

| Route | Meaning | Destination |
|---|---|---|
| `art-style` | lighting, palette, framing, camera distance, background density, prop treatment — rendering style | scoped directive — this loop, runtime-dynamic |
| `scene-template` | what the scene DEPICTS is wrong (companion missing on a beat that names them, wrong moment, prop placement logic) | `scenes.js` / beat-prompt change proposal — deploy, versioned |
| `style-bible` | the base medium itself needs to change ("everything is too glossy") | `PIXAR_STYLE` config proposal — deploy + `STYLE_VERSION` bump (global cache invalidation, priced in the proposal) |
| `qa-check` | the closed critical list or repair prompts miss/over-fire a defect class | `spreadQa.js` proposal — deploy |
| `identity-anchor` | likeness is wrong because the ANCHOR is wrong (bad cover render, stale characterDescription) | per-book fix (regenerate cover / description) — never a rule |
| `layout` | text overlay, margins, page assembly | `layoutEngine` proposal — deploy |

Routed proposals land in the existing Proposals queue (`WriterTuningProposal` — `kind` is a free
string; add the art kinds and an `area` column rather than a second table). The
`identity-anchor` route matters most: likeness complaints are the loop's highest-volume input and a
prompt rule can never fix a bad reference image — re-attempting them as style rules forever is the
exact circle §6.3 of the writer plan exists to prevent.

### 6.4 Scope-aware measurement

Regression cases carry the same scope tags; the heatmap filters by them; coverage warnings flag
scopes with directives but no case. The **art quality map** aggregates judge scores by theme × band
(× tag) — where is the illustrator weak, did the version help its target scope without hurting
others. Phase 3 option: judge production books' renders on arrival (~1 multi-image call per book)
to feed the map real traffic.

---

## 7. Worker changes (one-time deploy, deliberately small)

### 7.1 `POST /v13/render-spreads` — the probe endpoint

`{bookId, story: {request, response}, spreads: [1..12 subset, 1–12 entries], profile,
approvedCoverUrl | childPhotoUrls, characterDescription?, textLayout?, illustrationTuning?,
dispatchId?, probeNonce?, forceRerender?, callbackUrl}` → 202 `{success, bookId, accepted:
spreads}`; callback (via `postWithRetry`, `dispatchId` echoed when supplied — exactly the
`/v13/generate-stories` shape) carries `{renders: [{spread, url, storageKey, qa: {pass,
advisories}}], illustrationTuningUsed, failures: [{spread, message}], costs}` — `qa.pass` is
derived (no spreadQa-stage advisory on the render) and `qa.advisories` carries the full advisory
records, defect notes included; this is the shape the sibling app's capture/judge/UI consume.

- Like `/v13/generate-stories`, EVERY validation happens before the 202: the spreads list, the
  story pair (resolved + re-validated exactly like `pipeline.js:resolveStory` — pinned-request
  re-validation, profile identity binding; a probe must never render an invalid or foreign story),
  the identity anchor (same rules as `illustrateStory`: cover, or photo fallback; none →
  `missing_identity_reference` 400), and `validateArtTuningInput`.
- Calls the SAME `renderSpread` per spread (cache → render → QA → repair → marker) with the same
  concurrency limit — the loop tunes production's actual path or it tunes nothing. `probeNonce`
  (workbench-only) salts the cache key for variance probes.
- No PDFs, no cover, no upsell, no checkpoint. Admin-only by usage, API-key by auth like every
  other route; app-side daily budget is the throttle (§10).
- This endpoint is also the natural future body for reviving `/regenerate-illustration` on
  catalog-slim (open decision 5).

### 7.2 Cache key + echo

`renderCachePath` gains the tag: `ce-renders/{STYLE_VERSION}/{storyHash}/…` when the tag is `none`
(today's path, byte-compatible — existing cached books replay untouched), else
`ce-renders/{STYLE_VERSION}+{label.hash8}/{storyHash}/…`. The `.qa.json` marker records the tag.
`illustrateStory` and the completion payload thread `illustrationTuningUsed` through; `pipeline.js`
adds `storyContent.catalog.illustrationTuning`.

### 7.3 The overlay itself

1. `illustrator/tuning.js` (new): `validateArtTuningInput` / `normalizeArtTuning` (mirrors
   `writer.js:45-95` including the byte caps and per-spread map) + `renderArtTuningBlock(tuning,
   spread)` producing the framed suffix for one spread.
2. `illustrator/index.js`: `illustrateStory`/`renderSpread` accept `tuning`; append the frame to
   `baseScene`; thread the tag into cache path, marker, and return value.
3. `server.js`: `/generate-book` + `/v13/render-spreads` accept/validate/pass `illustrationTuning`
   (400 on malformed, before the 202 — same contract as `writerTuning`).
4. `flags.js`: `artTuningLayerEnabled()` ← `CATALOG_ART_TUNING_LAYER` (default ON).
5. `GET /v13/coverage`: extend the payload (it already reports flag state) with `STYLE_VERSION`,
   the art-tuning flag, and the render/QA models — Illustrator Anatomy reads it exactly the way
   Writer Anatomy reads coverage today (app-side, 60s-cached `workerInfo()`).
6. `versions.js`: no bump — `PIXAR_STYLE`, `scenes.js`, and `spreadQa.js` are untouched; the tag
   rides the cache key and callbacks, not `versions`. Document in CLAUDE.md.
7. Tests: overlay append + frame wording, caps, kill-switch, cache-path tag (none = legacy path),
   marker tag, probe endpoint validation (invalid story pair, missing anchor, bad spreads list,
   dispatchId echo), `/generate-book` passthrough, per-spread map targeting.

Everything else (writer, validation, layout, cover, checkpoints) is untouched.

## 8. App data model (Prisma — real migrations, mirroring the writer tables)

- **`IllustrationTuningVersion`** — column-for-column `WriterTuningVersion` (unique auto
  `versionLabel` `art-NNN` via the writer's `nextVersionLabel` pattern, directives, judgeRubric,
  `hash` = sha256 of the directive set, status draft|locked|archived, parentVersionId lineage,
  changelog as an appended entry array, notes, lockedBy/lockedAt).
- **`IllustrationTuningIteration`** — mirrors `WriterTuningIteration` (`@@unique([sessionBookId,
  iterationNo])`, `notes`, `failures Json`): `{id, sessionBookId, iterationNo, tuningVersionId,
  tuningTag, dispatchId, params Json (storyPair snapshot, spreads, anchorUrl + anchorKind,
  textLayout, scope context, rubric snapshot, requestedBy, probeKind: probe|variance|fullbook),
  renders Json, failures Json, judge Json, notes, createdAt}`.
- **`IllustrationRegressionCase` / `IllustrationRegressionRun`** — §5.5 (runs reuse the jsonb
  append + stall-reconcile helpers, generalized; `results` keeps the writer shape
  `{expected, rubric, entries[]}`).
- **`AdminFeedbackComment`**: add `area String? // 'story' | 'art'` (+ index); art comments reuse
  `trait`/`spreadNo`/`scope`/`route`/`sessionBookId` as-is and put the render context in the
  existing `storyRef Json` (`{iterationNo, spread, bookDefinitionId, suggestedBy?}` — it is a
  generic artifact ref, no new column needed).
- **`WriterTuningProposal`**: add `area`; new `kind` values `scene-template | style-bible |
  qa-check | identity-anchor | layout`. Note the kind allowlist is enforced in TWO places today —
  the `POST /versions` confirm route and the compiler's `normalizeCompileOutput` — both lists
  extend, ideally hoisted to one shared constant.
- **`WriterTuningEvent`**: reuse with `area` in `details` (append-only audit is shared).
- Activation pointer: `pipeline_config` row **`illustration_tuning_state`**.
- Persist the render-time tag on `ChildrenBook.engineVersions` from the completion callback.

## 9. App services & API surface (`/api/admin/illustration-tuning`, adminAuth)

- `illustrationTuning.js` — the store: generalize the writer store's pure helpers
  (normalize/applies/render/explain) over an axis list instead of duplicating them; art-specific
  wire rendering (`toWorkerField` producing `{versionLabel, hash, text, spreads}`),
  `overlayForBook`, `artAnatomy` (per finished book: tag → resolved directives, drift warning).
- `illustrationTuningWorkbench.js` — art rounds on the shared workbench session: budget check →
  reserve-iteration-before-dispatch → `dispatchRenderProbe` (new, in `childrenGeneration.js`,
  calling `/v13/render-spreads` with the reserved dispatchId; tri-state `illustrationTuning`
  semantics) → delete-reservation-on-dispatch-failure; `captureArtIteration` on the dedicated
  worker-auth callback route `/api/children/render-probe-callback` (dispatchId-verified,
  idempotent, judge fire-and-forget — §5.2); variance probes, regression, art quality map.
- `illustrationJudge.js` + `proxyVision` in `geminiProxy.js` — §5.
- `illustrationTuningCompiler.js` — §5.3.
- Production injection: `buildWorkerPayloadWithTuning` also resolves the art overlay (for every
  dispatch — renders always happen) and attaches `illustrationTuning`; failure = no overlay, never
  a blocked dispatch.
- Routes mirror the writer surface endpoint-for-endpoint (`routes/admin/writerTuning.js` is the
  template, including its status codes and the route-level super-admin checks):
  - Versions: `GET /versions` (+ state + default rubric), `POST /versions` (the single-transaction
    confirm: draft + comment inclusion + routed proposals), `GET /versions/:id` (+ its comments +
    events), `PATCH /versions/:id` (draft-only; 409 on locked), `POST /versions/:id/lock`,
    `POST /versions/:id/activate` + `POST /deactivate` (super-admin), `GET /state`.
  - Art bench (on the SHARED workbench session): `POST /sessions/:id/art/anchor` (photo upload /
    sample pick / one-click cover generation), `POST /sessions/:id/art/generate` (probe round:
    story pick, spreads, tuningVersionId, probeKind), `GET /sessions/:id` extended with
    `artIterations`, `POST /sessions/:id/art/judge` (re-judge on demand),
    `POST /sessions/:id/art/suggestions` (accept/dismiss, §5).
  - `POST /compile` — art comments + render context → proposed ops; nothing persisted (§5.3).
  - Regression: `GET|POST|PATCH /regression/cases` (incl. `{fromArtIteration}` golden save),
    `POST /regression/run` (202), `GET /regression/runs` + `GET /regression/runs/:id`
    (stall-reconciled on read).
  - Insight: `GET /quality-map`; anatomy: `GET /anatomy` (worker coverage via the cached
    `workerInfo()` pattern), `POST /render-anatomy` (one finished book's renders: tag → resolved
    directives + drift warning), `POST /overlay-preview` (`explainArtOverlay`: global + per-spread
    placement with matched/excluded-by-axis reasons).
  - Proposals stay on the shared queue (`/api/admin/writer-tuning/proposals`), filtered by `area`.

## 10. UI — a sibling page: `AdminIllustrationTuning`

`AdminWriterTuning` is already a four-tab, ~1,500-line page; doubling it to eight tabs would bury
both loops. Instead: a separate `AdminIllustrationTuning` page with the SAME four-tab anatomy the
writer page shipped (registered in `pages.config.js` and `AdminFloatingNav`, next to "Writer
Tuning"), sharing the workbench sessions underneath. The bridge is a deep link: every story card
in the writer Playground gains a **"Send to Art Bench"** action carrying
`(sessionBookId, iterationNo, storyIndex)` — the art page opens with that story pinned. The four
tabs:

1. **Art Bench** — anchor setup, story pick, spread pick, version selector → render cards (image,
   QA verdict, judge chips with click-to-comment, anchor-overlay toggle), iteration timeline with
   side-by-side compare + trait deltas + "single sample" badges, variance probe, "Apply comments"
   diff review (scope + conflicts + routes), pre-lock full-book button.
2. **Art Rulebook & Versions** — version list/lineage, directive table (filter by trait/theme/
   band/spread/aspect), changelog, lock/activate. Proposals queue is shared (filter by area).
3. **Art Regression & Quality** — cases with golden thumbnails, case × trait heatmap, coverage
   warnings, art quality map.
4. **Illustrator Anatomy** — the de-black-boxing view mirroring Writer Anatomy: reference photo →
   approved cover → characterDescription → scene prompt (beat/world/companion/props) → Art Tuning
   Layer → style bible → renderer rules → QA → cache, each layer color-coded by mutability class
   (*dynamic via comments* / *runtime env* / *versioned data via proposals* / *locked (deploy)*)
   with live values (flags, models, `STYLE_VERSION`, active tag) and an overlay preview.

Plus: a **`RenderAnatomy`** component mirroring `StoryAnatomy.jsx` exactly (lazy fetch of
`POST /render-anatomy` on first expand) rendered on art-bench render cards and on
`AdminChildrenBookDetails` spreads — which directives applied to this book's renders, from the
persisted tag, with the same draft-drift warning; and `AdminChildrenBookDetails` links spreads
into the loop ("comment on this spread" → art comment with book context).

## 11. Safety & cost guardrails

- Overlay is admin-approved versioned data; subordinate frame + caps + control-char strip +
  kill-switch; the closed QA list gates every render regardless; production needs lock +
  super-admin + audit; one-click deactivate to pure `STYLE_VERSION` behavior. Comments, story text,
  and prop values remain **data, never instructions** in every compiler/judge prompt (the prop
  inert-quoting in `scenes.js:37-44` stays exactly as is, below the overlay's priority).
- The overlay text passes through the same NSFW sanitize path every scene already does; a directive
  can therefore never smuggle prohibited content past it.
- Spend: probes are K renders not 12; per-day render budget
  (`ILLUSTRATION_TUNING_DAILY_RENDERS`, counted in renders, not rounds — a render costs what a
  whole writer round costs) enforced the same way the writer's daily-rounds guard is: checked in
  the workbench generate BEFORE the reservation, summing `params.spreads.length` (× samples for
  variance probes) over today's art iterations from UTC midnight. Every probe/regression screen
  shows its render count before dispatch; CostTracker rides the probe endpoint (unlike
  `/v13/generate-stories`, which deliberately has neither cost tracking nor a rate limit — cheap
  text; renders are not); variance probes and full-book confirmations count against the same
  budget.

## 12. Phases

- **Phase 1 — plumbing (worker + store):** worker §7 (probe endpoint, overlay, cache tag, echo,
  kill-switch, tests); Prisma tables + migrations; versions API; probe dispatch + callback capture;
  tag persisted to `engineVersions`. *Deploy both services once.*
- **Phase 2 — the loop:** Art Bench (anchor setup, probes, image cards), `proxyVision` + judge +
  scorecard, art comments, compiler + diff review + routing, drafts, lock, variance probe.
- **Phase 3 — confidence & control:** side-by-side + deltas, goldens/regression + heatmap +
  coverage, art quality map, production activation + audit + anatomy views, pre-lock full-book
  flow, BookDetails integration, judge-on-production option.

## 13. Open decisions (defaults chosen, flag if you disagree)

1. **Cover in scope?** Default NO: the cover is the identity/style anchor for every interior — a
   cover directive cascades into all interiors through the reference image, which deserves its own
   loop (anchored on what?) later. The Art Bench still *generates* covers, as anchors only.
2. **Seeding in probes** — as built: `/v13/render-spreads` accepts an optional integer `seed`,
   threaded into every render (and into the cache key, so differently-seeded probes never replay
   each other), but APPLYING it stays gated by the renderer's existing
   `BOOK_PIPELINE_V3_RENDER_SEED` env (default OFF; seed-rejecting models are retried without).
   Enable the env on the worker revision to make probe seeding real; production dispatches never
   send a seed either way. Tightens A/B without pretending determinism.
3. **Per-spread wire map** — default YES (§4.2). Fallback if we want a smaller contract: global
   text only, spread-scoped lines rendered as `On spread N only: …` prose (weaker: bleeds tokens
   into all spreads).
4. **Shared vs. cloned store code** — default: generalize the writer store's pure helpers over an
   axis list, keep tables separate. Cloning is faster to ship but forks bug-fixes forever.
5. **Revive `/regenerate-illustration`** (410 stub) on `/v13/render-spreads` + `forceRerender` for
   per-spread production repair — Phase 3+ option; needs its own review-flow design.
6. **Judge every production book's renders** (~1 multi-image call/book) to feed the quality map
   real traffic — Phase 3 option, same shape as writer open decision 4.
