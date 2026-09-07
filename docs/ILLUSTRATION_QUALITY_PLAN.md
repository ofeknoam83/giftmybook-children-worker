# Illustration quality — measure, diet, arm, construct (plan, ce-19 → ce-20 / qa-11)

> **Status: proposal** (2026-09-07). Nothing in this document is code yet.
> **Scope: how the illustrations are CREATED** — the render prompt, the
> reference pack, the models, per-spread QA, candidate selection, the set
> gates and the shared assets (sheet, plate, template). Customer and admin
> flows are out of scope; where a step needs the app at all it is one line.
> Written against the worker at `#313`, from the code itself, the three
> sample spreads checked into `docs/` (`spread-3/5/7.png`), the July print
> audits (`docs/audits/`) and the earlier plans (`ART_CONSISTENCY_FIX_PLAN`,
> `ILLUSTRATION_VARIETY_AND_OUTFIT_PLAN`,
> `ILLUSTRATION_CONSISTENCY_REFACTOR_PLAN`).
> Every workstream keeps the established doctrine — fixed inputs, no
> chaining, closed vocabularies, bounded budgets, cache-key folds,
> kill-switches, the beat is the scene, `spreadQa` is the shipping gate —
> and stays inside the render envelope `#295` set (≤ 3 automatic renders
> per spread).

**Trigger.** The owner asked how the illustrations can be improved. This is
the answer as a plan: what the output looks like today, why the render
path produces it, and the ordered set of changes — each with its
mechanism, its check, its cost and its kill-switch — that move the art
from "defects mostly caught" to "right the first time, and measured".

**The one-paragraph diagnosis.** Eighteen style versions have made the
renderer's *inputs* fixed and the *checks* many, but three things now cap
the result. **(1) The consistency machinery is switched down in
production.** `#295` (2026-09-05) set candidates per spread to 1, general
repairs to 1, drift repairs to 0, typography-anchor candidates to 1, the
text-size ruler to 4×, and `CATALOG_SHIP_ON_EXHAUSTION` is ON by default
(`flags.js:185-191`, `index.js:114-117`, `spreadQa.js:904-905`) — so a
book is best-of-one with one do-over, and blocking residuals ship with an
advisory. The ce-9 selection gate exists but rarely selects. **(2) The
prompt is a document, not a brief.** One embedded spread sends ≈ 24-30 k
characters plus six reference images and a 4K edit base: the
2.6 k-character style paragraph three times (`illustrationGenerator.js:891,
1000, 1003`), the child's identity five times (`:605, :626, :644, :788,
:839`), ≈ 35 NEVER/NOT clauses, percentages an image model cannot perceive
("cap height 1.1 % of the image height"), and four internal contradictions
(§2.2). Every ce-N added a paragraph; none removed one; nobody measured
what the length — or the reference count — costs. **(3) Nothing measures
the render path.** No per-book record of renders spent, repairs by class,
residuals shipped, cost or wall-clock exists; every vision check runs on
`gemini-2.5-flash` while the renderer is `gemini-3.1-flash-image`; the five
text-layout checks are judged although the ink is a known hex; the elected
character sheet has no likeness floor and the cover it derives from gets
no likeness check. Underneath all three, **the art is undirected**: every
spread gets the same warm window light (see the sample spreads), no plan
varies lighting or palette with the story, and no check scores appeal —
QA is defects and sameness only.

**The plan in one sentence.** Measure first (P0); make the first render
right by cutting the prompt and the reference pack to what the model can
follow (P1) and by pinning a lighting/mood plan the way the shot plan pins
composition (P3); make verification as strong as the renderer and as
deterministic as the ink allows (P2); spend the bounded render budget on
the assets that propagate book-wide (P3); every step gated by a golden
set, never by a hunch.

---

## 1. What the output looks like today

The three sample spreads in `docs/` (one book, spreads 3/5/7, 2026-08-31)
are the clearest statement of the problem, and the July print audits
confirm each item on paper.

| Symptom (visible in the samples) | Root cause in the render path | Status after ce-18 |
|---|---|---|
| The child reads as a **different age and haircut** on each spread (toddler with a bowl cut → 7-year-old → a third face) | identity was one cropped, title-bearing cover + prose; no likeness measurement | partly — ce-9's character sheet + contact gate; likeness judged only vs the cover, no floor on the elected sheet (`characterSheet.js:437-441`), embedding metric off (`flags.js:188`) |
| The mother's hair is **brown on spread 3, blonde on 5 and 7** | human companions were never pinned (38 books) | ce-11 pins the companion by manuscript; human adults get no sheet (`isDrawableCompanion`) — still prose-only |
| The **cracker changes shape** (square → bitten round → a crumb) | props were words | ce-9 prop sheets + per-prop QA — declared props only; beat-level objects are free |
| **Jeans → brown trousers**, slippers → socks | outfit was a sentence | ce-7/8/9 outfit lock from the sheet; optional slots coerced to `not_visible` on malformed verdicts (`spreadQa.js:813-816`) |
| **Same medium shot, same window light, same room angle** on every spread | nothing planned variety; nothing plans light | ce-8 shot plan pins composition; **light/palette are still unplanned** (§4 P3) |
| Painted text: large, white, right-aligned on one spread, over the mother's hair on another | text was free | ce-12…ce-18 + the typography template (`#306-#308`): text is now typeset pixels the model edits around — the one place the render path already does "pixels, not words" |
| The face says *worried* while the text says *serious chef, bustling prod* | no emotion input | ce-9 emotion plan (advisory) |

Print-audit items still open (`docs/audits/*`): fold-adjacent focal art
and mirrored twin landmarks (L2/L3, I3); countable disagreement between
text and art ("three tunnels", four painted — I4); gear-state continuity
(helmet on/off — I2); decals painted onto props (I4 of audit 2); the four
upsell covers showing different likenesses (P3 — partly fixed by ce-9's
sheet-referenced upsell).

## 2. Where the render path stands (facts, as of `#313`)

### 2.1 Defaults: the docs say one thing, the code another

| Knob | CLAUDE.md / plan text | Code default | Set by |
|---|---|---|---|
| `CATALOG_RENDER_CANDIDATES` | 2 | **1** (`flags.js:189`) | `#295` |
| `CATALOG_SPREAD_QA_MAX_REPAIRS` | 2 | **1** (`index.js:114-117`) | `#295` |
| `CATALOG_DRIFT_MAX_REPAIRS` | 2 | **0** (`flags.js:190`) | `#295` |
| `CATALOG_TEXT_ANCHOR_CANDIDATES` | 3 | **1** (`flags.js:200`) | `#295` |
| `CATALOG_RENDER_BUDGET_PER_SPREAD` | undocumented | **3** across all gates (`flags.js:191`) | `#295` |
| `CATALOG_SHIP_ON_EXHAUSTION` | "OPT-IN" | **ON** — `=0` opts out (`flags.js:187`) | `#294/#295` |
| text-size ruler (`qa-8`) | 1.5× blocking / 1.25× advisory | **4× / 2×** (`spreadQa.js:904-905`) | `#295` |
| `CATALOG_TYPOGRAPHY_TEMPLATE` | not documented | ON (`flags.js:199`); embedded renders request **4K** when active (`index.js:357`) | `#308` |

The relaxation is the owner's cost/latency call and this plan keeps the
envelope. But it means the ce-9 machinery — candidates, drift repairs,
best-of-N anchor — is mostly dormant, and CLAUDE.md described a pipeline
that was not running. (This PR corrects CLAUDE.md.)

### 2.2 The prompt

`buildCharacterPrompt` (`illustrationGenerator.js:536-1026`) emits, for an
embedded spread, 19 blocks in this order: lettering-template instruction
→ bible CHARACTER/PROPS/COMPANION/EMOTION → CHARACTER APPEARANCE → name
rule → LOCKED APPEARANCE → DRAW THIS EXACT CHILD → CONTINUITY → CRITICAL
RULES 1-7 → MAIN CHARACTER + LIKENESS → CONSISTENCY RULES → SCENE (beat +
shot directive + column hint + world card) → COMPOSITION → BACKGROUND →
STYLE/FORMAT/SAFE ZONE → TEXT RULES (≈ 7 k chars) → FULL SCENE →
CHECKLIST 1-14 → FINAL STYLE REMINDER → TEXT FINAL CHECK → ART TUNING,
then the reference images, then the `si-1` scene-integration part
(`:1182-1185`). The renderer logs the exact size (`Prompt length`, `:1394`);
nothing records it.

Contradictions the model is asked to resolve on its own:

- rule 1 allows "child + one parent → exactly TWO people" (`:690`); rule 4
  forbids any family member (`:711`);
- FULL SCENE forbids "any blank, empty, or reserved areas" (`:971`) while
  the column hint reserves a calm column (`index.js:139`) and the template's
  transparent zone is "missing artwork";
- SAFE ZONE keeps content inside the middle 85 % of the height (`:899`)
  while text padding demands 26 % top / 36 % bottom;
- `buildHairNegatives` forbids "hat" (`:288-308`) on beats that require one;
  `stripHairFromScene` (`:262-265`) deletes "braid/bun/ribbon" from the
  *beat text*, so a beat about braiding loses its action; the `sanitized`
  safety rung strips "bare/love/fight/monster" (`:218`) from legitimate
  beats before a render is accepted;
- in template mode the reference parts are re-ordered but keep their
  original numbers (`:1043-1044`), so "REFERENCE IMAGE 5" arrives first.

Size numbers stated as percentages of the frame are the exact class of
instruction ce-15 diagnosed as unperceivable ("a percentage of the frame is
not something an image model perceives") — and since `#308` the
typography template already shows the size as pixels, making the prose
redundant as well as unperceivable.

### 2.3 The reference pack and the image call

- `buildReferencePack` (`bible/index.js:282-323`) attaches, in fixed order:
  character model sheet, approved cover, one prop sheet per declared and
  carried prop, the companion sheet when the manuscript names it, the
  world plate, and last the typography reference / size-and-ink guide /
  full-spread lettering template. An embedded spread with one prop and a
  companion therefore carries **six or seven images**, one of them a 4K
  edit base. The REFACTOR plan's Phase 0 — "bench probe of the
  reference-image limit" — was never run; nobody knows whether image six
  helps or dilutes image one.
- The image call sends no temperature; a seed only when
  `BOOK_PIPELINE_V3_RENDER_SEED=1` (`illustrationGenerator.js:1141-1157`);
  safety settings `BLOCK_ONLY_HIGH` on every call; embedded renders request
  `imageConfig.imageSize` 4K while the template is on (`index.js:357`).
- The safety ladder's `sanitized` rung edits the *scene* — a render
  accepted on that rung carries an advisory since ce-9, but the words it
  removes are catalog beat words, so the accepted image can be missing the
  beat's action.
- The `si-1` scene-integration part (`#312`) and the lighting rewrite of
  the style suffix (`#311`) are the newest pixel-changing inputs and have
  no measured before/after; `#312` deliberately kept the cache namespace,
  so old and new renders replay each other.
- The cover is still attached beside the sheet that was derived from it.
  Whether the second image adds identity signal or a second, cropped,
  title-bearing pose to copy is unmeasured.

### 2.4 Verification

- Every judge — spread v2, world, contact, sheet, outfit, prop, plate —
  runs `CATALOG_QA_VISION_MODEL` = `gemini-2.5-flash` (`spreadQa.js:35`,
  `characterSheet.js:46`, `contactSheet.js:49`, …). The renderer is
  `gemini-3.1-flash-image`; `gemini-3-flash-preview` is already priced in
  `costTracker.js:11` at the same rate as 2.5-flash and used nowhere in the
  illustrator.
- The emotion classifier builds its own `generationConfig` with
  `maxOutputTokens: 1024` and no thinking config (`emotionPlan.js:572-574`)
  — the exact shape of the 2026-09-02 clipping incident
  `shared/llm/geminiJson.js` exists to prevent.
- Everything fails open: HTTP error, malformed verdict or thrown error ⇒
  `pass: true` (`spreadQa.js:1012-1022, 1157`; `contactSheet.js:424-446`;
  `worldPlate.js:231`). An unchecked render scores −60 but ships if it is
  the only candidate (`select.js:74`, `index.js:565-570`) and writes no
  marker.
- Of the deterministic metrics (`metrics.js`), only the ink ΔE and the
  centre-gutter straddle ever block; garment ΔE, safe zone, off-centre,
  shot size and identity similarity only shade the score. The five
  text-layout fields that are pixel-measurable — band, split, treated
  backdrop, misaligned lines, mixed style — are all judged by the VLM.
- The text-size ruler had to be loosened to 4× because the judged
  `text_bbox` is "too rough on small blocks" (`index.js:161-169`).
- The "never adopt a worse re-render" guard compares **blocking counts
  only** (`index.js:833-838`): a set re-render equal on blocking but worse
  on identity score, colour ΔE, ink, size or composition replaces the
  incumbent; the per-spread loop adopts on `>= 0` (`:630`), so an
  equal-scoring repair replaces a render whose defects are known. Set
  repairs write canonical keys concurrently and the world gate is never
  re-run afterwards (`:802-853`).
- The elected character sheet is "highest likeness among passing
  candidates, **no minimum**" (`characterSheet.js:437-441`); likeness is
  judged against the cover only; the cover itself gets wardrobe, anatomy
  and mockup checks but **no likeness check** (`coverGenerator.js:516,
  574, 441`).
- Nothing scores the art. A search of `illustrator/` and
  `shared/illustration/config.js` for appeal, composition quality, colour
  harmony or finish finds nothing; style is asserted by the `PIXAR_STYLE`
  text and sameness is enforced structurally. QA is defects and
  consistency only.

### 2.5 Observability

The orchestrator logs per-phase durations and the renderer logs prompt
length, to Cloud Logging only. No callback carries renders spent,
repairs by class, unchecked ships, residuals shipped, image calls by
model/size, or prompt size; nothing aggregates cost or wall-clock per
book. The REFACTOR plan's own line still holds: "the owner's report is the
monitoring". The Art Bench's judge exists but its probe anchors come from
`/v13/generate-cover-image`, not from approved covers — so bench numbers
are measured against a face production never renders.

## 3. Principles (inherited, plus three)

Inherited from ce-5 … ce-18: a stateless render is held to FIXED inputs;
no chaining; closed vocabularies drive prompts and gates; bounded budgets;
every pixel-changing input folds into the cache key; every mechanism has
a kill-switch; the beat is the scene; `spreadQa` is the shipping gate; a
defective shared asset is never elected.

Added by this plan:

1. **A gate can only reject — construction wins.** Repairs converge to
   "not broken", never to excellent (`PIPELINE_V3_DESIGN.md` §2). With ≤ 3
   renders per spread, the first render has to be right: shorter
   instructions the model can follow, fewer references that each earn
   their place, and pixel references where prose failed (the typography
   template is the proof).
2. **Measure what can be measured; judge only what cannot.** The ink is a
   known hex; the template is a known raster; the child bbox exists. Every
   check that can be a pixel measurement becomes one — cheaper, exact, and
   immune to the judge's outage.
3. **No style version ships without the golden set.** Every ce-N since
   ce-12 was validated by one bench round and the owner's eyes; ce-13 to
   ce-18 each fixed the previous version's side-effect. A fixed golden set
   with the bench judge and defect rates turns that into a regression
   test.

## 4. Workstreams

Ordering, sizes and gates are in §5. "Size" is engineering effort in the
worker: S ≤ 1 day, M 2-4 days, L a week or more.

### P0 — Measure (no pixel change; no version bump)

| Item | Mechanism | Size |
|---|---|---|
| **P0.1 Illustration run report** | Collect what the orchestrator and renderer already log into one `illustrationReport` on the completion/probe callbacks: per spread — renders spent, candidates, repair passes by class (`spreadQa`/`text`/`world`/`contact`/`ink`), final tier, blocking + advisory counts, `unchecked`, `shippedWithBlocking`, safety rung; per book — bible build time, render/gate phase durations, vision calls, image calls by model/size, cost split, prompt chars (mean/max), reference count, model ids, `STYLE_VERSION`/`QA_VERSION`, flag snapshot. The app only has to persist it. | M |
| **P0.2 Golden set** | 8 fixed stories × 4 fixed anchors (two bands; one child with glasses, one with textured hair) × `embedded`/`half`, chosen so the set exercises a drawable companion, a human companion, a carried prop and a bath/water beat. Anchors are **approved covers from the production cover path**, not `/v13/generate-cover-image` output. Runnable through `/v13/render-spreads` with a regression-only `styleVersionOverride` + `flagOverrides` (folded into the cache key); scored by the existing bench judge plus the worker's own defect rates and P0.1 numbers, candidate vs incumbent. | S (worker) + the bench's existing regression run |
| **P0.3 Judge calibration set** | 60 renders hand-labelled once (identity ok/broken, outfit ok/broken, text ok/broken, appeal 1-5) — the V3 design's "≥ 90 % agreement before a judge decides anything" rule. Used by P2.1 and P2.3. A small script scores any judge model + prompt against the labels. | S (labelling is owner time) |
| **P0.4 Hygiene** | Correct the CLAUDE.md drift (this PR); route the emotion classifier through `jsonQaGenerationConfig`; give `#312`'s `si-1` part its own cache fold so before/after can be compared; record the `#306` Gemini-Pro lettering probe's outcome in this doc. | S |

Exit: two weeks of P0.1 numbers and one golden-set baseline of the
`#313` render path. Every later workstream reports against it.

### P1 — The prompt and reference diet (`ce-19`)

**P1.1 The prompt.** Rewrite bible-mode prompt assembly so one embedded
spread is ≤ 9 k characters: **one** STYLE block, **one** IDENTITY block
(the bible CHARACTER block; delete CHARACTER APPEARANCE / LOCKED
APPEARANCE / DRAW THIS EXACT CHILD / MAIN CHARACTER / CONSISTENCY RULES in
bible mode — they restate the sheet the model can see), **one** SCENE
block (beat, shot directive, column hint, world card, LIGHT line once P3
lands), **one** TEXT block, **one** CHECK block, the tuning overlay last,
the `si-1` part unchanged. Legacy (non-bible) callers — cover, coloring,
comics — stay byte-identical.

Specifically remove or reconcile:

- Delete the 2nd and 3rd style emissions (`:1000`, `:1003`).
- Drop every size percentage from the TEXT block when the typography
  template is attached — the template is the size; keep only the
  footprint sentence (`expectedTextBlock`) as a plain-language cross-check.
- Reconcile rule 1 vs rule 4 (the beat decides whether an adult is
  present; the BACKGROUND rule forbids *extra* humans, not the companion);
  FULL SCENE vs the column hint ("continuous scenery everywhere; the
  assigned column is the scene's calmest area"); SAFE ZONE vs text
  paddings (one band, stated once).
- Fix reference numbering in template mode (`:1043-1044`) so the label
  order matches the attached order.
- `stripHairFromScene` masks only the child's hair descriptors, never a
  beat verb; `buildHairNegatives` drops any item the beat names; the
  `sanitized` rung's word list is reviewed against the 2,736 beats and
  never strips a beat's own nouns.
- Collapse the ≈ 35 negations into one short NOT list per block (the
  antiStyle list stays — it was empirically necessary; the text-panel list
  becomes one sentence).

**P1.2 The reference pack.** Run the Phase 0 probe ce-9 skipped, on the
golden set: (a) sheet + template only, (b) + world plate, (c) + cover,
(d) + prop/companion sheets, (e) the full pack as today. Score identity,
outfit, prop and world traits per arm. Keep every reference that moves a
trait; drop any that does not — the cover is the first suspect (the sheet
derives from it and it carries a title and a cropped pose). Whatever the
probe elects becomes the fixed pack; the label list in `buildReferencePack`
and the bible hash change accordingly.

**Verify.** Golden set, P1 vs `#313`: bench trait means non-inferior on all
nine traits, with identity and outfit watched hardest (the repetition and
the extra references were added for a reason — measure that removing them
does not regress); worker defect rates per class; renders per spread;
prompt chars and reference count from P0.1. A/B the `si-1` part on the
same run. **Version:** `STYLE_VERSION = ce-19` (pixels change).
**Kill-switch:** none — a prompt is not a feature; the old assembly is the
previous version. **Cost:** input tokens fall ≈ 60 % per image call; a
smaller pack removes ≈ 1.3 k tokens per dropped image. **Size:** M + the
probe (bench time).

### P2 — Arm the verification (`qa-11`)

**P2.1 The judge.** Evaluate `gemini-3-flash-preview` against
`gemini-2.5-flash` on P0.3 for spread v2, sheet likeness and contact
verdicts. `jsonQaGenerationConfig` needs a 3.x branch (the thinking knob
differs from `thinkingBudget: 0`) — verify on the calibration set that
the strict-JSON contract holds. Adopt as the default if agreement rises;
same price. **Size:** S.

**P2.2 Measure the text from the ink.** The ink is pinned (`#2A1C12` with
a pale hairline). Build an ink-keyed text mask at native resolution
(ΔE ≤ 12 from the pinned hex, connected components ≥ 6 px, hairline
excluded by the two-sided luminance split already in
`metrics.textInkColour`) → glyph rows → lines. From that mask, measure:
cap height and line pitch (against the template's known values), the
left-edge σ across lines (`text_lines_misaligned`), line-height σ
(`text_style_inconsistent`), the block bbox and its side, the fold
straddle (exact), a second cluster on the other side
(`text_split_both_sides`), and a flat low-variance region hugging the block
(`text_on_band` / `text_backdrop_treated`). The measured bbox replaces the
judged `text_bbox` for the ruler, which tightens back to 1.5× / 1.25×
because the noise that forced 4× is gone. The five VLM text-layout fields
become deterministic with the judge as a fallback only. Blind
transcription (`verifyImageText`) stays — it verifies *which* words, the
mask verifies *how* they sit. **Verify:** P0.3 agreement ≥ 95 % on text
labels; every layout verdict becomes exact and outage-proof. **Version:**
`QA_VERSION = qa-11` (markers re-check). **Kill-switch:**
`CATALOG_TEXT_MASK_QA=0` → judged fields. **Size:** M.

**P2.3 Likeness with a floor.** (a) The elected character sheet must clear
a likeness floor (start 0.6, calibrated on P0.3; below it the pass fails
`identity_kit_failed`, `CATALOG_SHEET_REQUIRED=0` keeps the advisory
path). (b) Calibrate `identityScore` (Vertex multimodal embeddings, opt-in
since ce-9 and never calibrated — REFACTOR §10.0 Phase 0) on the golden
set: distribution for same-child vs different-child crops, then arm it by
default as a selection weight and a contact-gate outlier flag. It never
blocks alone until the calibration says it can. (c) The contact-sheet gate
judges on the P2.1 model. (d) The cover generator gains the same likeness
read against the photo it was made from, as an advisory only — the cover's
own QA today checks wardrobe, anatomy and mockups, never the face.
**Version:** `qa-11`. **Kill-switch:** existing `CATALOG_IDENTITY_METRICS`.
**Size:** M (plus ~$0.01/book of embeddings).

**P2.4 Adoption fixes.** The worse-guard compares `selectionTier` then
full score, not blocking counts; the per-spread loop adopts a repair only
on a strictly better score; after set repairs, when budget allows, one
world-gate re-judge on the final set; an unchecked candidate gets one judge
retry after backoff before it ships as unchecked, and P0.1 counts every
unchecked ship. Optional outfit slots that come back malformed are
`unclaimed`, not coerced to `not_visible`. **Size:** S.

**P2.5 The open audit items as soft fields.** `count_agreement`: a
deterministic extractor pulls "two/three/four …" + plural nouns from the
spread text into a COUNT line in the scene and a soft QA field;
`hero_on_fold`: deterministic from `child_bbox` centre within the middle
10 % of the width on wide renders; `gear_state`: the carried-prop line
gains worn/held/absent from beat keywords (helmet, hat, glasses, backpack);
`prop_decal`: the prop QA gains "the prop's surface carries no added
lettering, map or emblem". All advisory-class — they shade selection and
steer repair notes; the golden set decides whether any graduates to
blocking. **Size:** S each.

### P3 — Quality by construction (`ce-20`)

**P3.1 The mood plan.** Composition is planned (ce-8); light is not. Add
`illustrator/moodPlan.js`: a closed vocabulary of *time-of-day* (dawn /
morning / midday / golden hour / dusk / night-lit) × *light quality*
(soft diffuse / hard directional / dappled / glow-lit / overcast) ×
*palette accent* (from the theme's world card, ≤ 3 accents per theme),
assigned per spread from beat position and the emotion plan (calm beats
soft, the climax hard or glow-lit, the resolution golden), bookends
matched (spreads 1 and 12 share a family), no adjacent repeats, seeded
by the story fingerprint like the shot plan so an anchor change never
reshuffles light. It rides the scene as one fixed LIGHT line; the world
plate stays neutral (environment only); the world gate's prompt receives
the plan so planned variation is never flagged as `palette_lighting`
drift; QA v2 gains a soft `lighting_reads_as`. **Verify:** golden set —
bench `composition` and `style_integrity` means, world-gate false
positives, owner side-by-side. **Version:** `STYLE_VERSION = ce-20`,
`-mp0` fold when off. **Kill-switch:** `CATALOG_MOOD_PLAN=0`. **Size:** M.
This is the deleted art director's "palette arc" brought back as a
deterministic table — no LLM decides anything.

**P3.2 Spend where it compounds.** A defective shared asset propagates
book-wide (ce-17's haze, the audit's flag patch). Within the ≤ 3 envelope:
the typography anchor page renders 2 candidates (that page only — it sets
the type for eleven others); the character sheet keeps best-of-3 but is
judged by the P2.1 model with the P2.3 floor; run a **bake-off, not a
switch**, of `gemini-3-pro-image-preview` for the sheet and the anchor
page only (≈ 4 images/book at the placeholder $0.05 rate — verify the
rate) against the flash model on the golden set. Adopt per asset only
where the judge and the owner agree. **Size:** S (bake-off is bench time).

**P3.3 Text as pixels, finished.** The template (`#306-#308`) is the size
authority; P1 removes the prose that duplicates it; P2.2 measures the
result against the template's own metrics. Add the template's glyph mask
to the QA input so "garbled" is measured as glyph-level IoU against the
template rather than transcribed twice — the second transcription call is
then spent only when IoU is ambiguous. **Size:** S after P2.2.

**P3.4 Human companions get a spec.** `isDrawableCompanion` excludes
adults so the sheet prompt never draws a real person; instead, derive a
**structured appearance spec** (hair colour/length, build, one outfit) for
the named adult once per book from the beat text + a fixed per-theme
table, pin it in the bible manifest, and QA it as a `companion` check the
way creatures are checked. No image of an adult is generated or judged
against a photo. This is the brown-then-blonde mother in the samples.
**Size:** M. **Version:** bible hash changes ⇒ render key changes.

**P3.5 Seed and determinism.** Send a per-spread seed derived from the
story fingerprint + spread + candidate index on every image call (today a
seed rides only under `BOOK_PIPELINE_V3_RENDER_SEED=1`), so a repair pass
is a genuinely different roll and a replay is reproducible when the model
honours seeds. Measured on the golden set for any effect on variety; folded
into the render key. **Size:** S.

### P4 — Style direction (owner decision, measured)

The style is a frozen "cinematic 3D Pixar CGI" descriptor with true
optical bokeh (`config.js` `PIXAR_STYLE`). The samples read as generic AI
3D; the audit called one spread "photographic bokeh". This plan does not
change the style — it proposes one bench round on the golden set
comparing the incumbent against a **refined** descriptor (stylised
proportions matched to the cover, painterly-clean surfaces, shallow but
not photographic depth of field, one named lighting model), judged by the
bench judge and the owner side by side, with P1's shorter prompt so the
comparison is fair. Adopt or not on that evidence. **Size:** S.

### P5 — The cost and latency envelope

Stays at ≤ 3 automatic renders per spread. Expected movement per embedded
book: P1 cuts input tokens ≈ 60 % on ~36 image calls and drops any
reference the probe retires (small $, faster); P2.2 makes text layout free
of the judge's latency and outage; P2.1/P2.3 are price-neutral; P3.1 and
P3.5 are free; P3.2 adds one image (anchor page) and, if the bake-off
wins, ≈ 4 pro-model images; P3.4 adds one text call. Target: cost per
book and p95 wall-clock within +15 % of the P0 baseline while
shipped-with-blocking falls. P0.1 reports it; no target is assumed.

## 5. Sequencing and gates

| Step | Depends on | Gate to proceed |
|---|---|---|
| P0.1-P0.4 | — | two weeks of run reports; golden baseline recorded |
| P1 (`ce-19`) | P0.2 | golden set non-inferior on all traits; identity/outfit defect rates ≤ baseline; reference-pack probe recorded |
| P2.1, P2.4, P0.4 fixes | P0.3 | judge agreement ≥ baseline on the calibration set |
| P2.2 (`qa-11`) | P0.3 | text-label agreement ≥ 95 %; ruler back to 1.5×/1.25× without a rise in false blocking |
| P2.3 | P0.2, P2.1 | calibrated floor + embedding thresholds documented in `metrics.js` |
| P3.1 (`ce-20`), P3.5 | P1 | bench composition/style means up; world-gate false positives not up |
| P3.2, P3.3, P3.4 | P2.x | per-asset bake-off evidence; companion defect rate down on the human-companion golden books |
| P2.5 | P0.2 | advisory rates plausible on the golden set |
| P4 | P1 | owner side-by-side |

Two style versions (ce-19, ce-20) and one QA version (qa-11) total; the
bible hash covers P1.2 and P3.4. Every version keeps the previous cache
namespace intact, as always.

## 6. Success criteria (measured by P0.1 and the golden set)

- **Identity:** bench `identity_fidelity` mean ≥ 4.0 on the golden set
  (baseline to be recorded); contact-gate `character_rendering` flags per
  book halved.
- **Text:** any text defect (blocking or advisory) on ≤ 5 % of embedded
  spreads; ruler back at 1.5× with no rise in false blocking.
- **Residuals:** shipped-with-blocking ≤ 2 % of books;
  `consistency_unresolved` tracked and trending down; zero silent
  unchecked ships.
- **Variety and direction:** bench `composition` mean ≥ 4.0;
  `composition_duplicate` and same-light spreads (judged) near zero.
- **Envelope:** renders per spread mean ≤ 1.5; cost per book and p95
  wall-clock within +15 % of baseline.
- **Human companions:** `companion differs` on the human-companion golden
  books down to the creature-companion rate.

## 7. What this plan deliberately does NOT do

- No customer- or admin-flow changes; the app persists the run report and
  supplies approved covers as bench anchors, nothing more.
- No previous-spread chaining (deleted 2026-08-06 as the drift source);
  the typography anchor's half-page crop remains the only sibling pixel
  that travels.
- No LLM art director, no judge panels; the mood plan is a table.
- No free model text; the manuscript is typeset pixels the model edits
  around, verified against the template.
- No plot, beat or catalog edits.
- No raise of the ≤ 3-render envelope; no default switch to a pro image
  model without a per-asset bake-off.
- No change to how the cover is made; the approved cover stays the
  identity anchor, and no model ever judges a render against the raw
  photo — likeness is measured against the cover and the sheet.

## 8. Open decisions for the owner

1. **P3.2** — is the pro image model in scope for the sheet + anchor page
   if the bake-off wins (≈ +$0.20/book at the placeholder rate)?
2. **P4** — run the style-direction round, or keep the descriptor frozen?
3. **Ship policy** — keep `CATALOG_SHIP_ON_EXHAUSTION` ON (finish the book,
   report the residual) as the default, or return to fail-closed for
   `identity break` only?
4. **P0.3** — who labels the 60-image calibration set (owner time,
   ≈ 1 hour)?
5. **P1.2** — if the probe says the cover adds nothing beside the sheet,
   drop it from the pack (the sheet still derives from it)?

## 9. File map

`services/illustrationGenerator.js` (P1.1 assembly, reference numbering,
P3.5 seed), `services/shared/illustration/config.js` (P1.1 text block; P4
descriptor variant), `services/catalogEngine/illustrator/index.js` (P0.1
report, P2.4 adoption, P3.2 anchor candidates), `bible/index.js` (P1.2
pack, P3.4 companion spec in the manifest), `metrics.js` (P2.2 mask, P2.3
calibration constants, P2.5 `hero_on_fold`), `spreadQa.js` (P2.2
deterministic fields, P2.5 soft fields, `lighting_reads_as`), `select.js`
(P2.4 comparator), `bible/characterSheet.js` (P2.3 floor),
`services/coverGenerator.js` (P2.3d advisory likeness read), new
`moodPlan.js` (P3.1), `emotionPlan.js` (P0.4 config), `scenes.js` (LIGHT
and COUNT lines), `flags.js` (`CATALOG_TEXT_MASK_QA`, `CATALOG_MOOD_PLAN`),
`versions.js` (ce-19, ce-20, qa-11, an `si` fold), `shared/llm/geminiJson.js`
(P2.1 3.x branch), `server.js` (`styleVersionOverride` / `flagOverrides` on
`/v13/render-spreads` for regression runs only).
