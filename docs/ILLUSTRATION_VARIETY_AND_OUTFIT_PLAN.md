# Illustration variety + hermetic outfit lock — plan (ce-8)

> **Status: implemented** (this branch, `ce-8`) — Fixes 1-7 below are live:
> the deterministic shot plan (`illustrator/shotPlan.js`, kill-switch
> `CATALOG_SHOT_PLAN` with the `-sp0` cache fold), the renderer's
> `low-angle` shot type + identity-anchor pose-decoupling, per-spread
> `shot_type_mismatch` / `outfit_mismatch` QA with their repair notes, the
> world gate's `composition_duplicate` dimension repaired against the
> flagged spread's own plan directive, outfit lock v2 (structured
> full-coverage spec with elected `inferred` completion, `v2/` GCS path),
> and the lock-state surfacing (`outfitLockUsed` echo + stage `outfitLock`
> advisory; gate thumbnails at 1024px). The validation recipe (§Order &
> tests step 8) and the optional app-side bench wiring remain operational
> follow-ups. Nothing here touches the locked writer engine, the frozen
> catalog plots, story validation, or the deleted-for-cause previous-spread
> chaining.

**Trigger** (Art Bench, `jungle_6_7_footprint_trail`, embedded layout, all 12
spreads): two set-level failures that every existing gate scores clean.

1. **Monotony.** The twelve renders are compositionally near-identical: the
   same mid-wide camera distance, the same eye-level angle, the same
   crouch-by-the-mud pose, the child in the same third of the frame, the same
   jungle-and-stream backdrop. Each spread is individually fine; the set is
   boring — pages could be shuffled without anyone noticing.
2. **Outfit drift.** The child's top stays locked (red tee) but the lower
   body drifts spread to spread: full-length jeans vs rolled capris vs
   shorts; the shoes change style and color. The outfit lock (ce-7) shipped
   and did not stop it.

Both failures have the same architectural shape as every drift problem this
pipeline has already solved: **a stateless render can only be held to FIXED
inputs, and an invariant that no check enforces is an aspiration.** Variety
currently has neither a fixed input nor a check; the outfit has a fixed input
with holes and no per-spread check. The fix plan below closes both with the
established ce-4/ce-5/ce-7 machinery patterns — pinned deterministic specs,
closed defect vocabularies, bounded repair budgets, cache-key folds, and
kill-switches.

---

## Root causes (as the code stands)

### A. Nothing in the system directs, varies, or checks composition

Sameness is the default outcome, not an accident:

- **The scene prompt carries zero composition direction.**
  `scenes.js buildScenePrompt` emits: scene number, ACTION (the beat), the
  child line, companion, story text, props, the "setting stays consistent"
  line, and the world-law card — the card and the consistency line are
  IDENTICAL on all 12 spreads by design. Camera distance, angle, staging,
  and placement are left entirely to the model, which converges on its one
  favorite template for "child examines something in a jungle."
- **The renderer's composition machinery exists and is dormant.**
  `illustrationGenerator.js` `buildCharacterPrompt` already implements
  `opts.shotType` enforcement (`wide`/`medium`/`close-up`/`overhead`, lines
  ~756-767) — and the catalog illustrator never sets it. This is exactly the
  pre-ce-7 `characterOutfit` situation: the arsenal is built, nothing arms it.
- **The only "be different" instruction is aspirational.** The CONTINUITY
  block tells each render its composition "must all be visibly distinct from
  every other spread" — but spread 7's render never sees spreads 1-6. The
  repo's own doctrine (CLAUDE.md, ce-7): cross-spread sameness "never comes
  from aspirational 'keep it identical' prompt lines." The mirror statement
  is equally true: cross-spread DIFFERENCE never comes from an aspirational
  "be distinct" line.
- **The fixed references pull every render toward one template.** The
  identity anchor (the approved cover — the child in ONE pose at ONE camera
  distance) rides every render labeled "the exact child character to draw,"
  with no instruction not to copy its pose or framing. The world plate has
  that instruction ("Do NOT copy its composition"); the identity anchor does
  not. The world card additionally mandates "the same river/clearing
  geography across all scenes" — correct for consistency, but with nothing
  varying the camera, it collapses the background too.
- **No check judges variety anywhere.** Per-spread QA can't see the other
  spreads by construction. The world gate is explicitly INSTRUCTED not to
  flag it: "DO NOT flag differences in scene, action, … camera angle,
  composition, pose" (`spreadQa.js worldQaPrompt`). Monotony is invisible to
  every layer.
- **The plot compounds it and is off-limits.** `jungle_6_7_footprint_trail`
  has ~8 of 12 beats that are "child studies the prints" — an
  investigation archetype. Plots are frozen (never edit `catalog.json`), so
  the remedy must be cinematographic, not editorial. Many of the 228 books
  share this shape; this is not a one-book problem.

### B. The outfit lock under-specifies, and nothing verifies it per spread

- **The spec has holes exactly where the drift is.** `outfitLock.js` derives
  ONE compact sentence (≤500 chars) from the identity anchor with the
  explicit rule "Do NOT invent items that are not clearly visible." The
  anchor is the approved COVER, which usually crops the lower body — so
  pants cut/length and footwear are simply absent from the spec, and the
  renderer's per-garment OUTFIT LOCK / COLOR VERIFICATION block
  (`illustrationGenerator.js` ~630-635) has nothing to verify them against.
  **An unspecified garment is per-spread freedom** — each stateless render
  re-invents the hem length and the shoes, which is precisely the observed
  drift (jeans → capris → shorts; changing shoes). A one-sentence spec also
  routinely omits sleeve length and garment cut even for visible items.
- **Per-spread QA is blind to the outfit.** `checkSpreadRender`'s closed
  list is painted text / missing child / duplicated child / broken medium
  (+ embedded-text checks). A render with the wrong pants passes per-spread
  QA every single time, ships, gets a `.qa.json` marker, and replays forever.
- **The set-level backstop can't carry the load.** The world gate's
  `character_rendering` class does cover "a different outfit," but it runs
  ONCE per book, judges 768px JPEG thumbnails (garment details like hem
  length are near-invisible at that scale across 12 wide images), shares a
  budget of `CATALOG_WORLD_QA_MAX_RERENDERS` (default 3) with every other
  defect class, and may only re-render FRESH spreads. It is a backstop, not
  a gate.
- **Lock-less renders are silent.** `getOutfitLock` is fail-open by contract
  (correct — a render must never fail on the reader), but a null resolves to
  a server log line only: the completion/probe callback carries no trace, so
  an entire book rendered without any outfit lock is indistinguishable from
  a locked one on the bench.
- Verified NOT the cause: `isModestBathWaterScene` is scoped to explicit
  tub/pool wording — the stream/jungle-water scenes in this book do not trip
  BATH/WATER MODE.

---

## Fix 1 — the SHOT PLAN: a deterministic per-spread composition spec

New `illustrator/shotPlan.js`. The same move as the world-law card and the
outfit lock: replace "the model decides / an aspiration hopes" with a pinned
deterministic input, identical on every retry and replay of the same story.

**Closed vocabulary, fixed template text.** A shot-plan entry is assembled
ONLY from closed lists — no free text, no LLM call, no per-book creative
pass (the deleted art director stays deleted):

- `shotType`: `wide` | `medium` | `close-up` | `overhead` | `low-angle`
  (the renderer's existing enum + one new value, see Fix 2).
- `placement`: `left-third` | `right-third` (the existing off-center rule,
  now VARIED deterministically instead of freely re-chosen by the model).
- `staging`: a closed list of pose-energy directives compatible with any
  beat (e.g. "crouched low, seen from behind over the shoulder", "standing
  and pointing ahead", "walking mid-stride", "leaning in close, face filling
  the frame", "side by side with the companion, both looking at the same
  spot"). The ACTION stays the beat's; staging only picks HOW the fixed
  action is framed.
- `embedded` layout only: `textSide` — pinned OPPOSITE the child's third,
  reinforcing the existing one-block-one-side rule while making the text
  side vary across the book instead of landing wherever the model prefers.

**Deterministic assignment with hard variety constraints.** Seeded by
`fnv1a(storyFingerprint | spread)` (the same identity the render cache keys
on), the planner rotates the vocabulary under invariants a unit test can
assert:

- spread 1 = wide establishing, spread 12 = wide closing (genre convention,
  matching the arrival/farewell beats every catalog book shares);
- no `shotType` repeats on adjacent spreads; every type in the menu appears
  at least once per 12; no type appears more than 4 times;
- `placement` never lands on the same third three spreads running;
- age band 1-3: menu restricted to `wide`/`medium`/`close-up` (the
  renderer's BOARD BOOK composition rule for ≤2 stays in force and outranks
  the plan);
- `half` layout: the plan keeps `shotType`/`staging` but emits NO placement
  line — the existing halfHint owns placement (child and action in the
  right half) and must keep winning.

Same story ⇒ same plan on every retry, repair, gate re-render, and probe
(`rerenderSpreads` included); different stories ⇒ rotated plans.

**Delivery — the same rails every pinned input already rides:**

- `renderSpread` passes `opts.shotType` (arming the dormant machinery) and
  appends the plan's `COMPOSITION (THIS SPREAD)` block to the scene BEFORE
  halfHint/worldNote/tuning — so the layout constraint, gate repairs, and
  the admin's Art Tuning Layer all still outrank it.
- The composition block joins `safeFallbackSuffix` (it is fixed template
  text, exactly like the world card) so the generic-safe NSFW fallback
  variant does not silently render off-plan.
- The aspirational "visibly distinct from every other spread" sentence in
  `buildCharacterPrompt`'s CONTINUITY block is replaced by the concrete
  assignment ("THIS spread's assigned composition — obey it exactly").

**Mechanics:** kill-switch `CATALOG_SHOT_PLAN=0` (flags.js
`shotPlanEnabled`); when disabled, fold `-sp0` into the render cache key
(the `-p0` prop-continuity pattern — planned and plan-less renders must
never replay each other). Prompt assembly changes for every book ⇒
STYLE_VERSION bump (see Mechanics below).

## Fix 2 — renderer: one new shot type + anchor pose-decoupling

Small `illustrationGenerator.js` changes:

- Add `low-angle` to the `opts.shotType` enforcement block ("camera low to
  the ground looking slightly up at the child — the world towers around
  them"), keeping the enum closed.
- Add the missing counterpart of the world plate's no-copy rule to the
  identity anchor label: REFERENCE IMAGE 1 defines the child's identity
  (face, hair, outfit colors) ONLY — NEVER copy its pose, expression,
  camera distance, or composition. One fixed sentence; it removes the
  strongest constant pull toward the cover's framing on all 12 spreads.

## Fix 3 — per-spread composition enforcement (the plan is checked, not hoped)

When a shot plan is pinned, `checkSpreadRender` receives the spread's
assigned `shotType` (quoted as data in the QA prompt, like `expectedText`)
and answers one more explicit boolean: `shot_type_mismatch` — "true only
when the image CLEARLY reads as a different shot type than assigned (e.g. a
close-up delivered as a full wide scene); borderline framing passes."
The defect feeds `repairNote` with a fixed corrective line per shot type and
rides the existing `CATALOG_SPREAD_QA_MAX_REPAIRS` loop — zero new calls,
zero new budgets. Gross monotony (every spread a mid-wide) cannot survive
this check even before any set-level comparison runs.

## Fix 4 — set-level VARIETY dimension on the existing world gate

Extend the ONE existing multi-image gate call (`checkWorldConsistency`) with
a third judged dimension — no additional vision call:

- **COMPOSITION VARIETY**: flag a spread only when it is a NEAR-DUPLICATE of
  another spread in the set — the same camera distance AND angle AND child
  pose AND overall layout, so alike the two pages could be swapped without
  anyone noticing. Normal variation stays exempt; the existing "DO NOT
  flag camera/composition/pose differences" paragraph is re-scoped to the
  WORLD dimensions only (those differences remain required-good there).
- New closed-enum defect `composition_duplicate` (added to `WORLD_DEFECTS`);
  out-of-vocabulary values still collapse to `other`.
- Repair: `worldRepairNote` gains an options argument carrying the flagged
  spread's OWN plan directive (fixed template text from Fix 1 — model
  free-text still never reaches a prompt): "re-render the SAME scene and
  action obeying THIS spread's assigned composition: …". Re-renders go
  through the same fresh-only, `CATALOG_WORLD_QA_MAX_RERENDERS`-capped,
  `planWorldRepairs`-ordered path — `planWorldRepairs` itself is untouched.
- The finding ships as a `stage: 'worldQa'` advisory and rides the `worldQa`
  callback verdict like every other class, so the Art Bench sees it.

## Fix 5 — outfit lock v2: structured, full-coverage, elected completion

Rework `outfitLock.js`'s derivation (the caller contract — resolve once,
GCS single-winner, fail-open null, hash on the cache key — stays identical):

- **Structured spec.** The vision call returns STRICT JSON per garment slot:
  `top`, `bottom`, `footwear`, `outerwear?`, `accessories[]` — each with
  color, pattern/graphic, style, and the LENGTH words the drift lives in
  (sleeve length; pant cut and hem length reaching where; sock/shoe type
  and color).
- **Elected completion for cropped anchors.** Each slot carries
  `visibility: "seen" | "inferred"`. For a slot the anchor does not show
  (the cover crops the legs), the model MUST elect ONE plausible,
  style-consistent completion and mark it `inferred` — because the goal is
  not fidelity to an invisible garment, it is that all 12 renders pin the
  SAME words. Today that slot is simply absent and every spread re-invents
  it; after v2 an unspecified garment no longer exists.
- **Same election discipline.** The JSON is rendered into one fixed-template
  spec sentence (cap raised 500 → 700 chars); GCS create-if-absent still
  elects one winner per anchor, at a NEW path
  `catalog-assets/outfit-locks/v2/{anchorHash}.json` so v1 sentence blobs
  are never half-parsed; the rendered spec's content hash rides the render
  cache key exactly as today (`-o{hash}` — no mechanics change needed:
  a v2 spec re-keys automatically).

## Fix 6 — per-spread OUTFIT QA against the pinned spec

The ce-4 typography pattern applied to clothing: each stateless render is
checked against the SAME fixed spec, so spreads that pass also match each
other — no cross-spread reads required.

- When an outfit lock is pinned, `checkSpreadRender` receives the spec
  (quoted as data) and answers `outfit_mismatch` — "true only on a CLEAR
  break: a different garment, a different color family, a missing or added
  item, or a visibly different pant/sleeve length; lighting shifts and
  minor fold/shading differences pass." An optional `outfit_note` string
  stays diagnostics-only (advisories), never reaching a prompt.
- The defect feeds `repairNote` with a fixed corrective line + the pinned
  spec (already-inert pinned data, the same trust level as `expectedText`)
  and rides the existing per-spread repair budget.
- Scoping falls out naturally: no pinned spec (kill-switch or derivation
  failure) ⇒ no outfit check — `CATALOG_OUTFIT_LOCK=0` keeps covering both.
  Bath/water spreads skip the check (BATH/WATER MODE changes coverage by
  design): export the existing `isModestBathWaterScene` heuristic and pass
  the flag from `renderSpread`.

## Fix 7 — surface lock state; sharpen the backstop's eyes

- A run that renders lock-less while `CATALOG_OUTFIT_LOCK` is enabled
  appends ONE book-level advisory (`stage: 'outfitLock'`, "renders are not
  outfit-locked — spec derivation failed") to `qaAdvisories`, and the probe
  callback echoes `outfitLockUsed: <hash8|none>` beside
  `illustrationTuningUsed`. Silent lock-less books are how ce-7 shipped a
  hole unnoticed.
- Bump `WORLD_QA_THUMB_WIDTH` 768 → 1024 so the gate's
  `character_rendering` judgment can actually resolve garments across 12
  wide thumbnails (still JPEG; modest payload increase, measured before
  merging against the API inline-size limit that motivated 768).

---

## Mechanics, versioning, cost

- **STYLE_VERSION → `ce-8`** (one bump covers all of it: scene prompts gain
  the composition block, prompt assembly changes, the anchor label changes,
  and outfit specs change text). ce-7 renders must never replay as ce-8.
- **Cache folds:** `-sp0` when the shot plan is killed (mirrors `-p0`);
  `-o{hash}` unchanged (v2 specs re-key by content). Everything else rides
  the ce-8 bump.
- **New env:** `CATALOG_SHOT_PLAN=0` kill-switch only. No new tuning knobs.
- **Cost:** ZERO added vision/render calls on the happy path — the shot and
  outfit checks ride the existing per-spread QA call, the variety dimension
  rides the existing gate call, and the v2 outfit derivation is the same
  once-per-anchor single call. Added spend happens only through the two
  EXISTING bounded repair budgets, on renders that are actually defective.

## What this plan deliberately does NOT do

- **No previous-spread chaining** — deleted 2026-08-06 as the
  photocopy-drift source; variety, like consistency, comes from fixed
  per-spread inputs, not from renders looking at each other.
- **No plot edits** — beats stay frozen; repetitive investigation beats are
  handled by cinematography, which is exactly what a human picture-book
  illustrator does with a repetitive manuscript.
- **No LLM art director revival** — the shot plan is a deterministic
  rotation over a closed vocabulary; no per-book creative calls, no
  unbounded prompt text.
- **No model free-text in prompts** — new defects extend the closed enums;
  repair prompts are built from pinned template text only; `outfit_note`
  and gate `note`s stay diagnostics.
- **No aspirational lines as mechanism** — "be distinct" / "keep identical"
  sentences survive only as reinforcement of a concrete pinned spec.

## Order & tests

1. `illustrator/shotPlan.js` + unit tests: determinism (same story ⇒ same
   plan), adjacency/coverage/run-length constraints, band 1-3 and
   half/embedded layout restrictions, textSide-opposite-placement.
2. Renderer: `low-angle` enum + anchor pose-decoupling line + composition
   block and `opts.shotType` plumbing from `renderSpread`;
   `safeFallbackSuffix` fold; prompt-assembly tests.
3. `spreadQa.js`: `shot_type_mismatch` + `outfit_mismatch` (+`outfit_note`)
   fields — required-boolean gating ONLY when the corresponding input was
   pinned (a malformed verdict still fails open with `qaUnavailable`, never
   fails a book); `repairNote` lines for both; tests incl. malformed
   verdicts and the bath/water skip.
4. World gate: variety dimension + `composition_duplicate` enum +
   `worldRepairNote(defect, {planDirective})`; re-scoped DO-NOT-flag
   paragraph; tests that `planWorldRepairs` ordering/budget is unchanged.
5. `outfitLock.js` v2: structured derivation prompt, JSON schema validation,
   `inferred` completion, v2 GCS path, 700-char cap; tests for parsing,
   election, and v1-blob non-interference.
6. Surfacing: lock-less advisory, `outfitLockUsed` echo on probe + book
   callbacks.
7. `versions.js` ce-8, `flags.js` `shotPlanEnabled`, CLAUDE.md update.
8. **Validation recipe** (the book from the trigger): `/v13/render-spreads`
   probe on `jungle_6_7_footprint_trail`, same anchor, all 12 spreads,
   embedded layout — assert (a) rendered shot types match the plan,
   (b) the gate flags no `composition_duplicate` pair, (c) the outfit —
   including pant length and shoes — is identical across all 12, (d) A/B
   the round against the pre-ce-8 renders on the bench.

## App-side wiring (giftmybook-standalone — separate repo, non-blocking)

- Art Bench (`server/services/illustrationTuningWorkbench.js` + UI): display
  the new `outfitLockUsed` echo and per-spread assigned shot types when the
  probe callback carries them; surface `composition_duplicate` /
  `outfit_mismatch` advisories in the round view like existing worldQa
  findings.
- Optionally add a "variety" dimension to the app-side judge rubric
  (`illustrationJudge.judgeRenders` consistency call) mirroring the worker
  gate's near-duplicate definition, so bench scoring and worker gating agree.
- Nothing app-side gates the worker fixes; callbacks stay backward
  compatible (new fields are additive).
