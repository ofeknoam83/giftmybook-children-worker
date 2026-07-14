# Illustrator V3 — Milestone 2 Implementation Plan ("Art Studio")

Status: **IMPLEMENTED (code-complete, pre-validation)** — phases 0-6 (W3-W10)
landed 2026-07-14 on this branch; `BOOK_PIPELINE_V3_ILLUSTRATOR` defaults to
`legacy` until the Phase C validation gate passes. Two deliberate deltas from
the plan below: (1) native art renders at **1:1** and ships in the proven
caption layout mode (typeset verso + full-bleed recto) — D5 satisfied with the
existing engine; wide-art zone-overlay typesetting is a post-cutover
enhancement, and (2) the style bible ships as a **versioned placeholder**
(`illustrator/styleBible.js`) pending the product-authored artifact — bumping
STYLE_VERSION regenerates every cached identity kit.
Scope: picture books, V3 pipeline only. Implements the illustrator half (§5–§7) of
`docs/PIPELINE_V3_DESIGN.md`; milestone 1 (V3 writer + v1 illustrator adapter) is the
starting point.

---

## 0. Where we are, and the seam we replace

Milestone 1 renders V3 books through
[`services/bookPipelineV3/orchestration/activities/illustrationDirector.js`](../services/bookPipelineV3/orchestration/activities/illustrationDirector.js)
— a deliberate adapter that synthesizes a v1-shaped document from V3 artifacts and calls
`renderAllSpreadsQuad`. That file *is* the contract boundary: the raw scene contracts it
consumes are preserved under `doc.v3`, so the native art director never re-derives them.
Milestone 2 replaces that one activity with a native illustrator; the adapter stays in the
tree as the `legacy` fallback behind a flag.

What the native path must fix (the failure classes v1/v2 QA exists to fight):

| Failure class | v1/v2 root cause | M2 structural fix |
|---|---|---|
| Likeness drift across spreads | identity chains cover → spread N−1 → spread N (photocopy-of-photocopy) | every spread renders from the same fixed reference set; identity flows one direction from the photo |
| Skin-tone / age / hair drift | same chaining + per-spread prompt reinforcement only | canonical character model sheet, likeness-judged against the photo |
| Correlated pair failures, mid-object slicing | quad 4:1 batching | fully independent per-spread renders |
| Retry storms converging to "not broken" | generate-1-then-patch | generate 2 candidates, select best (repair only as a bounded second wave) |
| Garbled text in pixels, OCR QA fragility | story text painted into the illustration | **no text in art ever** (D5); typeset by the layout engine into planned quiet zones |
| 13 medium shots | camera intent is per-spread free text | book-level shot budget, deterministically validated |
| Ship-anyway states | QA warnings that don't block | review queue as the terminal state (D6) |

## 1. Goals / non-goals

**Goals**
1. Likeness stability: the child on spread 13 is the child on spread 1 is the child in the photo.
2. Zero drift by construction (references, not sessions), not by QA repair.
3. Shot variety, palette arc, and text-safe zones planned before pixels, enforced after.
4. No lettering in generated art; text typeset over art by `layoutEngine`.
5. No ship-anyway: defects land in a review queue payload, never in a customer's hands.

**Non-goals (explicitly out of scope for M2)**
- Cover pipeline redesign (design doc: later; cover remains the approved wardrobe truth).
- Early readers / chapter books / graphic novels (stay on their current paths).
- The review **dashboard UI** in giftmybook-standalone — worker-side contract only
  (dashboard is a separate track in the other repo; §7 of the design doc defines the actions).
- Authoring the signature style bible (D11) — a parallel workstream, but a **blocking input**
  to Phase 1 (see §10).

## 2. Module layout

```
services/bookPipelineV3/illustrator/
  identityKit/
    likenessBrief.js      # photo → illustrator-grade appearance brief (extends faceEngine output)
    characterSheet.js     # best-of-3 model sheet generation + likeness judging
    cache.js              # GCS cache, keyed photoHash + styleVersion + promptVersion (faceEngine pattern)
  artDirection/
    artDirector.js        # one multimodal call over the whole manuscript
    shotBudget.js         # deterministic variety validator + reassignment
    textZones.js          # zone grammar (page/quadrant grid) + machine checks
    worldPlates.js        # empty-location reference renders for settings visited ≥2×
  render/
    referencePack.js      # assembles per-spread refs: sheet + best photo + cover + world plate
    renderSpread.js       # one spread, N candidates, via illustrationGenerator + key pool
  qa/
    deterministicChecks.js # cheap pre-checks: letterform OCR (inverted textQa), resolution, face-crop presence
    spreadJudge.js        # vision judge: anatomy, contract adherence, zone quietness, style, cast
    likenessJudge.js      # vs photo AND sheet; cross-family second opinion (the core promise)
    select.js             # candidate selection + repair-wave orchestration
  bookPass/
    contactSheet.js       # one review over the 13 winners
  reviewQueue/
    payload.js            # structured needs_review payload builder
```

Orchestration stays in `createBook.workflow.js` (same `ctx.execute` engine — content-addressed
artifacts, bounded retries for infra errors only, checkpoint/resume). The `'illustrations'`
step becomes a fan-out of per-spread activities so a resumed book re-renders only missing
spreads.

## 3. Phases

Each phase is independently shippable and testable behind the flag (Phase 0). Recommended
order — the core likeness machinery first, exactly the highest-leverage subset:
**0 → 1 → 3 → 4 → 2(min) → 5 → 6**, where "2(min)" is shot budget + text zones and the rest
of art direction (plates, palette arc, bounce-back) follows.

### Phase 0 — Flag, routing, scaffolding

- `BOOK_PIPELINE_V3_ILLUSTRATOR` env: `native` | `legacy` (default **legacy** until Phase 5
  passes acceptance). Request override `illustratorVersion` on the generate-book payload for
  per-book control from the admin test path — mirrors the `pipelineVersion` pattern, resolved
  once, persisted in the checkpoint so retries finish on the illustrator they started on.
- New roles in `llm/modelRouter.js` (same `BOOK_PIPELINE_V3_<ROLE>_FAMILY/_TIER` override
  pattern, same `assertV3Config` fail-fast, same cross-family guard where flagged):

| Role | Default | Why |
|---|---|---|
| ART_DIRECTOR | gemini / `gemini-2.5-pro` | must *see* cover + character sheet (multimodal) |
| SHEET_RENDERER | gemini / `gemini-3.1-flash-image` | current production image model; upgrade seam for Gemini 3 Pro Image when provisioned |
| SPREAD_RENDERER | gemini / `gemini-3.1-flash-image` | same; fallback `gpt-image-2` stays wired |
| QA_VISION | gemini / `gemini-2.5-flash` | cheap at candidate volume |
| LIKENESS_JUDGE_A | gemini / `gemini-2.5-flash` | first opinion |
| LIKENESS_JUDGE_B | openai / `gpt-5.4` (vision) | **cross-family, enforced** — self-preference on the core promise is not acceptable |

- Progress: sub-steps map into the existing `illustrating` band (`identity_kit`,
  `art_direction`, `rendering`, `spread_qa`, `book_pass`) so the admin progress bar keeps
  working without a main-app change.

*Acceptance:* flag flips between adapters on a smoke book; `assertV3Config` covers the new
roles; unit tests for resolution/override/collapse-warning.

### Phase 1 — Identity Kit (A0)

Runs **in parallel with the writer** (workflow change: kick off right after photo
validation, join before art direction). Cached in GCS — `identity-kit/{photoHash}-{styleVersion}-{promptVersion}/`
— following `faceEngine`'s cache-with-prompt-version pattern, so siblings' repeat orders and
regens don't re-spend.

1. **Likeness brief** — extend the existing `faceEngine` appearance description (its
   skin-tone-precision emphasis is correct; keep it) into an illustrator-grade brief:
   ranked distinguishing features, precise skin/hair/eye language, age-correct proportions
   (head-to-body ratio for the band).
2. **Character model sheet** — ONE canonical image in the signature style: front / ¾ /
   profile turnaround, 2–3 expressions, full body. Generated **with the actual photos as
   reference inputs** (the `illustrationGenerator` multi-reference path already supports
   this), best-of-3 candidates.
3. **Likeness judging of the sheet** — each candidate is compared **to the photo**, not to
   the other candidates; LIKENESS_JUDGE_A + B (cross-family) must both pass the winner.
   No candidate passes → one fresh wave of 3 → still failing → `needs_review`
   (identity is not a dimension we ship "close enough" on).
4. The **approved cover** joins the kit as outfit/wardrobe ground truth (it is the one image
   the parent has blessed).

*Acceptance:* kit persisted + cache hit on re-run; judge scores in `doc.v3.identityKit`;
fixture test with a known photo; a smoke book renders the sheet.

### Phase 2 — Art Direction (A1)

One multimodal ART_DIRECTOR call: manuscript (all scene contracts) + identity kit + cover in;
per-spread plan out. Schema-validated JSON:

- **`shot`** — from an enforced variety budget: ≥4 distinct shot types across 13 spreads, no
  two adjacent spreads share one. Validated **deterministically** after the call
  (`shotBudget.js`); violation → one re-ask with the violation named → then deterministic
  reassignment. The "13 medium shots" problem is fixed structurally, not QA'd.
- **`textZone`** — a coordinate contract with the layout engine: page half + quadrant that
  stays visually quiet (sky, wall, water). Machine-checkable grammar in `textZones.js`.
  Zones must respect the gutter: never the center 15% of the spread.
- **`paletteArc`** — per act, so the book darkens/warms with the story.
- **Continuity locks** — outfit (from cover), recurring props with spread lists (already
  computed by `collectVisualFacts`), supporting-cast presence rules.
- **World plates** — for each location visited ≥2×, render one reference image of the
  *empty* location; revisits attach the plate.
- **Bounce-back edge** — a scene contract the director flags unstageable (age-impossible
  action, prop soup) returns a structured `bounce` item; the workflow routes it through the
  existing `manuscriptRevision` activity for a targeted prose fix **before any spread
  renders**. Bounded: 1 round; still unstageable → `needs_review`. This is the
  writer↔illustrator feedback loop v1/v2 never had.
- **Gutter/composition rules in the prompt layer**: faces and focal action off the center
  fold, key content inside trim-safe margins.

*Acceptance:* schema-validated output on 3 fixture manuscripts; variety validator unit
tests; plates land in GCS; a hand-written unstageable contract produces a bounce.

### Phase 3 — Rendering (A2)

- **Per-spread independent renders.** References attached to every render: character sheet
  + best photo + approved cover + world plate (if any). No sessions. No chaining. No quad.
- **2 candidates per spread**, all spreads fan out concurrently through the existing
  `GEMINI_API_KEY_1..10` pool with a concurrency cap; existing transient-error taxonomy
  (`transientInfraError.js`) and exponential backoff kept per render.
- **Aspect ratio spike (task 3.0):** the design doc wants ~2:1 full-spread art. Verify which
  `imageConfig.aspectRatio` enums the image model actually accepts (the quad path proves
  `4:1` works; `16:9`/`21:9` are the likely fallbacks) and pick: render wide + planned crop
  to 2:1-plus-bleed, documented in one place.
- **Anti-lettering**: negative prompt + system instruction; enforcement is Phase 4's hard fail.
- Every render writes a cost-ledger row (`doc.v3.costs`, existing pattern).

*Acceptance:* 13×2 candidates in GCS for a smoke book; renders resume correctly from a
checkpoint (kill the worker mid-book); render wall-clock for the wave ≤ ~8 min.

### Phase 4 — Spread QA & selection (A3)

Cheap-to-expensive cascade, per candidate:

1. **Deterministic pre-checks** (`deterministicChecks.js`, no LLM spend): letterform OCR —
   the existing `textQa` OCR **inverted**: under D5 *any* detected text is an automatic
   fail (v1 used OCR to verify painted text matched; that entire class of QA retires);
   resolution/dimensions; file integrity.
2. **Vision judge** (QA_VISION): anatomy/integrity, scene-contract adherence (the image
   shows the contracted action/setting — replaces action-mismatch QA), text-zone quietness
   (the contracted zone is actually quiet), style fidelity, cast compliance (no phantom
   extras, no duplicated hero).
3. **Likeness** (LIKENESS_JUDGE_A, + B as cross-family second opinion): vs photo AND sheet.

Selection: best candidate ≥ threshold wins. Both fail → **one** repair wave — 2 fresh
candidates with the judges' named defects in the prompt. Still failing → spread-level
`needs_review` **with all 4 candidates attached** (a human picking the acceptable one costs
seconds). Keep the QA telemetry contract (`qaTagCounts`-compatible tags) so Cloud Logging
dashboards keep working; the historical tag taxonomy seeds the judge prompts.

*Acceptance:* selection report in `doc.v3.spreadQa`; thresholds env-tunable; judge
calibration gate (§8) passed before thresholds are trusted; fixture tests for the cascade
short-circuit (a lettered image never reaches the vision judge).

### Phase 5 — Book pass (A4) + zone typesetting (D5)

- **Book pass:** one contact-sheet call over the 13 winners — shot variety actually
  delivered, outfit/prop continuity, cover-to-interior match, ending lands visually.
  Flags trigger at most one targeted regen wave for named spreads; residual flags →
  `needs_review`.
- **Layout:** new zone-aware typesetting in `layoutEngine` — place the manuscript block
  inside the spread's contracted zone: one book typeface (embedded fonts already ship),
  auto-size within the band's word budget, widow/orphan control, and a **contrast
  guarantee** (sample the zone's luminance → pick ink color, add a soft scrim when the zone
  under-delivers quietness). The existing `buildSpreadCaptionPage` (OpenAI 1:1 mode) is the
  typesetting fallback when a zone is unusable — the book still ships beautifully rather
  than illegibly.
- Retire on the native path: quad slicing, `splitSpreadImage` mid-text hazards, OCR-as-verification.
- Everything else in layout is untouched: 8.5"×8.5" trim + bleed, page order, Lulu
  compliance, cover PDF, upsell spreads.

*Acceptance:* print-ready PDF with typeset text over art on 3 smoke books; golden-file
layout tests; visual check at print DPI.

### Phase 6 — Review queue, worker side (D6)

- New terminal outcome: `PipelineError` with `failureCode: 'needs_review'` carrying a
  structured payload (stage, defect summary, judge scores, candidate image URLs, manuscript
  + judge history) — persisted via the existing checkpoint, delivered through the existing
  `reportError` callback (the main app already persists arbitrary progress payloads).
- Until the standalone dashboard exists, V3 traffic is admin test books only, so
  `needs_review` surfaces as a failed test book whose `generationProgress` contains
  everything a human needs — including candidate URLs, so "pick the acceptable one" is
  possible today via the existing `/regenerate-illustration`-style admin endpoints.
- Smoke-test escape hatch mirrors the writer: `BOOK_PIPELINE_V3_SHIP_ON_EXHAUSTION=1`.

*Acceptance:* a forced QA failure produces a complete queue payload end-to-end into the
admin book's `generationProgress`.

## 4. Data contracts (additions under `doc.v3`)

```
doc.v3.identityKit   { sheetUrl, briefText, judgeScores, cacheKey, styleVersion }
doc.v3.artDirection  { spreads: [{ spread, shot, textZone, palette, locks, platesRef }], plates, bounces }
doc.v3.renders       { spreads: [{ spread, candidates: [{ url, seed?, ledgerRef }] }] }
doc.v3.spreadQa      { spreads: [{ spread, scores, selected, repairWave?, needsReview? }] }
doc.v3.bookPass      { verdict, flags, regenSpreads }
doc.v3.reviewQueue   [{ stage, spread?, defects, judgeScores, candidateUrls }]
```

The final selected images flow into the same `doc.spreads[*].illustration` slots the layout
engine already consumes — the `toLegacyStoryPlan` / server.js contract does not change.

## 5. Failure policy & budgets (bounded everywhere)

| Stage | Budget | Exhaustion |
|---|---|---|
| Character sheet | best-of-3, +1 wave of 3 | `needs_review` (identity is never "close enough") |
| Art direction | 1 call + 1 re-ask | deterministic shot reassignment; unresolved bounce → `needs_review` |
| Spread render | 2 candidates + 1 repair wave (max 4 images/spread) | spread-level `needs_review` with all candidates |
| Book pass | 1 targeted regen wave | `needs_review` |
| Infra errors (429/503/timeouts) | existing transient taxonomy + workflow-engine outer retry | unchanged |

No unbounded loop exists anywhere in the native path. Content failures never retry the same
prompt blindly — every repair prompt names the judged defect.

## 6. Cost & latency envelope (per book, from the design doc §9)

- Images: sheet 3 + spreads 26 (13×2) + repair ≤8 + plates ~2 ≈ **31–39 generations** —
  versus v2's nominal 13–26 that routinely balloons past 40 in retry storms, with far better
  selection pressure per image.
- Wall-clock: dominated by two parallel waves (renders, then repairs) instead of v1/v2's
  serial session — dramatically lower.
- Within the D2 envelope ("quality at almost any cost, 2–3×") with headroom to raise
  best-of-N on judged-weak spreads only, not globally.

## 7. Testing

- Unit tests per module in `__tests__/` (existing jest setup); fixtures: 3 real (anonymized)
  request payloads spanning bands PB_INFANT / PB_TODDLER / PB_PRESCHOOL.
- Deterministic pieces (shot budget, zone grammar, selection logic, payload builders) get
  full coverage — they're pure functions by design.
- End-to-end smoke: admin test-copy path (`pipelineVersion: 'v3'` + `illustratorVersion:
  'native'`) is the integration harness — it already exists, is free of customer risk, and
  records requested-vs-used versions.

## 8. Judge calibration (do this before trusting any threshold)

An uncalibrated vision judge is worse than none — it launders defects with a green check.

1. Assemble ~50–100 historical spread images labeled from the existing QA tag taxonomy
   (anatomy fails, extra-character fails, likeness fails, clean passes) plus their photos.
2. Run every judge role against the set; require ≥90% agreement with human labels on
   hard-fail classes (lettering, duplicated hero, wrong child) and calibrate score
   thresholds on the soft classes.
3. Track judge–human agreement as a standing metric; re-run the set on every judge-model or
   prompt-version bump (same discipline as `faceEngine`'s `promptVersion` cache busting).

## 9. Rollout

1. Land phases behind `BOOK_PIPELINE_V3_ILLUSTRATOR=legacy` default; native runs only via
   the admin test path's per-request override.
2. **Shadow phase:** for a set of source books, generate v3+legacy and v3+native test copies
   side-by-side; compare in the admin UI (both PDFs land on test-book rows).
3. Flip the default to `native` for V3. V3 itself remains opt-in
   (`pipelineVersion: 'v3'` / `BOOK_PIPELINE_V3=on`), so customer exposure is still gated by
   the existing pipeline rollout plan — and **customer V3 traffic waits for the standalone
   review dashboard** (D6: `needs_review` must have somewhere to go before real orders ride
   the path).
4. Kill switches: `BOOK_PIPELINE_V3_ILLUSTRATOR=legacy` reverts the illustrator alone;
   `BOOK_PIPELINE_V3=off` reverts the pipeline; both instant, no redeploy.

## 10. Dependencies & open questions

- **Signature style bible (D11)** — one authored style document + reference images,
  versioned as `styleVersion` in the identity-kit cache key. **Blocks Phase 1.** Owner: product.
- **Aspect-ratio spike** (Phase 3.0) — confirm supported `imageConfig.aspectRatio` enums for
  full-spread art; decide render-wide-then-crop geometry.
- **Face-embedding pre-check** — the adult-comics work (face detection + crop services,
  PRs #200–#202) may be reusable for the cheap deterministic likeness pre-check; evaluate
  before building new.
- **Gemini 3 Pro Image provisioning** — the design doc's preferred renderer; M2 ships on
  `gemini-3.1-flash-image` with the router seam ready for the upgrade.
- **Standalone review dashboard** — separate track in giftmybook-standalone against the §7
  contract; the worker-side payload (Phase 6) is deliberately dashboard-ready.
