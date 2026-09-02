# Illustration consistency — the Book Bible, the reference pack, and the selection gate (plan, ce-9)

> **Status: implemented on this branch as `ce-9`** (2026-09-02) — Phases 1-4
> of §10 are code: `illustrator/bible/{index,characterSheet,propSheet}.js`,
> `emotionPlan.js`, `metrics.js`, `contactSheet.js`, `select.js`,
> `candidates.js`, `spreadQa.js` v2, the renderer's reference pack + bible
> blocks, the orchestrator's candidates / repair / contact-sheet gate /
> ship policy, `/v13/prepare-identity` + `/v13/pick-candidate`, and the
> app-side wiring (see the standalone repo). Phase 0 (bench probe of the
> reference-image limit, embedding-backend spike, threshold calibration) and
> the §10.6 validation recipe remain OPERATIONAL follow-ups — the metrics
> ship opt-in until calibrated. See "§12 What the implementation also
> changed" for the audit findings that landed beyond this plan. The plan
> supersedes the per-symptom approach of ce-4…ce-8 for the traits it covers;
> it keeps every established principle (fixed inputs, no chaining, closed
> vocabularies, bounded budgets, cache-key folds, kill-switches, the beat is
> the scene, spreadQa is the shipping gate) and changes WHAT the fixed inputs
> are and HOW a render is accepted.

**Trigger.** After ce-7 (outfit lock) and ce-8 (hermetic outfit lock v2 + shot
plan + per-spread outfit QA) shipped, the owner still sees the child's
CLOTHING and PERSONAL ITEMS change across the twelve illustrations of one
book. The ask: review how every quality trait — Identity, Action,
Composition, Style, Emotion, Props, Typography, Cleanliness — is guaranteed,
and design a robust mechanism, refactoring how illustrations are created if
that is what it takes.

**The one-paragraph diagnosis.** The pipeline's doctrine is right — a
stateless render can only be held to FIXED inputs, and an invariant no check
enforces is an aspiration — but the fixed inputs for clothing and props are
still *words*, the identity anchor is the *wrong kind of image*, and every
check is a *lenient single-image yes/no* that never compares pixels to
pixels. An image model given a cropped, title-bearing cover and 700
characters of garment prose reinvents the trousers, the shoes, and the teddy
bear on every spread; a QA prompt told to flag "only a CLEAR break" lets
each reinvention through; a two-render repair budget then ships the result
with an advisory and a cache marker that replays it forever. The deleted V3
illustrator solved exactly this with an **identity kit** (character sheet +
prop sheet in every render's reference pack) and **candidate selection**,
and the July print audits recorded prop morphing as *fixed* by it; the
2026-08-28 cutover to the slim illustrator dropped both. This plan brings
those two mechanisms back in the slim illustrator's own idiom — pinned,
hashed, kill-switched — and closes the remaining traits the same way.

---

## 1. How each trait is guaranteed today (as the code stands)

Legend for the chain: **pinned+verified** (a fixed input rides the render
AND a check verifies it) · **pinned-unverified** (fixed input, no check) ·
**prompt-only** (aspirational text, nothing pinned or checked) ·
**verified-only** (a check exists but nothing fixed drives the render) ·
**absent**.

| Trait | Fixed input on the render | Per-spread check (`spreadQa.js`) | Set-level check (world gate) | Grade | Why it still fails |
|---|---|---|---|---|---|
| **Identity — face/hair/skin** | the approved COVER as the only identity image (`illustrationGenerator.js` `callGeminiImageApi` L945-957: anchor + optional world plate, nothing else); `characterDescription` is **null for every customer book** (app `childrenGeneration.js` L56 reads `storyContent.characterAnchor`, which no catalog path ever sets — while the sentence the app derived from the photo sits unused in `book.childAppearance`, `routes/children.js` L1586-1591) | none — no likeness field at all | `character_rendering` on 1024px JPEG thumbnails, "flag only when it clearly BREAKS the set" | pinned-unverified | the cover is a scene composition with the title painted into it, made from the photo (downscaled to 512px, L1164-1165) as "LOOSE inspiration … do NOT copy a real person's face" (app `routes/children.js` L1251-1259, L1685-1760); the renderer's hair/skin locks fall back to "as shown in the reference photo"; even the bench judge's consistency pass compares at most 6 of 12 renders (`illustrationJudge.js` `CONSISTENCY_MAX_IMAGES`) |
| **Identity — clothing** | `characterOutfit`: ONE ≤700-char sentence read off the cover by a vision call (`outfitLock.js` L62-82); garments the cover crops (usually legs + shoes) are text-only `inferred` completions that **no image shows**; the sentence is repeated ~6× in the prompt (`buildCharacterPrompt` L532-537, 570-572, 638-643, 725-728, 749-757, 868) | `outfit_mismatch` — one boolean, judged against the TEXT spec, "ONLY on a CLEAR break … garments cropped out of frame never count" (L100-115) | same `character_rendering` class; garments are near-invisible at thumbnail scale | pinned-unverified → weakly verified | the model weights images over prose; the spec's most drift-prone slots (hem length, shoes) have no pixels behind them; a leniency-tuned boolean passes subtle-but-visible drift; the world gate runs once with a 3-re-render budget shared with every other defect |
| **Props — comfort object** | the profile word, quoted, ≤80 chars (`scenes.js` `inertPropValue` L88-97, `buildScenePrompt` L149-161); carried through later spreads (ce-6) as the same word | **none** — no prop field | **none** — the gate's enum has no prop class | prompt-only | "teddy bear" is re-imagined on every spread (colour, size, species); nothing pins a look, nothing compares looks. The renderer's `KEY OBJECTS ("must look EXACTLY the same on every page")` block (L739-742) exists and is never armed — the slim illustrator passes no `keyObjects` |
| **Props — theme companion** | `${name}, a ${type}` on beats whose text names them (`beatMentionsCompanion` L104-107) — 493 of the catalog's 2,736 beats (18%), so the line is absent from most prompts even when the story implies the companion | none | none | prompt-only | Farmer Bea / the companion creature is a different character on every spread; the renderer's `RECURRING COMPANION` block (L733-734) is likewise dormant |
| **Action** | the beat line `ACTION (paint exactly this moment): …` + the spread text as "context" | **none** — no action field | none | pinned-unverified | a render of the right setting with the child posing passes every worker check; only the Art Bench judge (app `illustrationJudge.js` `action_fidelity`) scores it, and only on probes |
| **Emotion** | **nothing** — in caption/half layout the spread text is framed "for mood/props only" (`scenes.js` L138); in embedded layout it is framed only as text to paint (L137); the catalog carries no `emotional_arc` although the locked writer prompt lists one; the anchor's fixed expression rides every render | none | none | absent | the model's default "generic smile" on tense beats; bench-judge-only |
| **Composition** | shot plan (ce-8): shot type / staging / placement / text side, deterministic; renderer `opts.shotType` block; off-center + safe-zone prose | `shot_type_mismatch` (borderline passes) | `composition_duplicate` | pinned+verified (coarse) | the only trait with the full pattern; off-center and safe-zone rules are prompt-only (no bbox check) |
| **Style** | `renderStyleBlock(PIXAR_STYLE)` + the world-law card + the world plate (image) | `flat_or_photo_style` | `palette_lighting` … `character_rendering` (stylization) | pinned+verified (coarse) | the customer cover is rendered by a DIFFERENT prompt in the app; interiors inherit whatever stylization it has; subtle stylization drift is thumbnail-judged |
| **Typography** | TEXT_RULES (ce-4), text side from the shot plan | OCR `compareTexts` + placement/alignment/style booleans | `text_treatment` | pinned+verified | solid; the one remaining primer is the customer anchor itself, which carries painted title text into every render's reference |
| **Cleanliness** | prompt checklist (arm/hand/leg counts) | **none** for interiors — `qaCoverAnatomy` (`coverGenerator.js` L570) runs on worker-made covers only | none | prompt-only | a three-handed hero on spread 7 ships; stray signage/pseudo-script is checked only as `readable_text` |

Cross-cutting weaknesses that hold for every row:

- **Repair = regenerate from scratch.** Each repair (`illustrator/index.js`
  L291-330) re-renders the whole scene with a note appended; it routinely
  trades one defect for another and is capped at 2 per spread. The first
  render that is not "clearly broken" ships — there is **no candidate
  selection**, so quality is whatever a single sample gives.
- **Ship-with-advisory + the marker.** A residual defect ships (advisory
  only), the `.qa.json` marker is written (L333-350), and every later
  replay skips QA. Drift, once shipped, is permanent for that book.
- **The safety-fallback ladder silently discards the scene.** On a Gemini
  safety block, `generateIllustration` (`illustrationGenerator.js`
  L1169-1182) walks three rungs: `original` → `sanitized` (L218-222 —
  `NSFW_TRIGGER_WORDS` L213 regex-strips words such as *bare, strip, love,
  kiss, fight, monster* from the ENTIRE prompt, outfit spec and story text
  included) → `generic-safe` (`buildGenericSafePrompt` L235-250: "a happy
  child … in a colorful scene"; the ACTION line, story text, PERSONAL PROPS
  and CONTINUITY PROP lines are all gone — `safeFallbackSuffix` re-attaches
  only the world card, shot directive, world note and tuning block). A
  render accepted on the third rung is logged to the console (L1234) and
  ships with **no advisory**: a prop-less, action-less, forced-happy spread
  is indistinguishable from a normal one on every callback. The renderer
  also sends no `safetySettings` at all (`callGeminiImageApi` L922-1004),
  although `config.js` L21-26 defines `GEMINI_IMAGE_SAFETY_SETTINGS`
  (BLOCK_ONLY_HIGH) for exactly this — renders trip the ladder at Gemini's
  default thresholds.
- **The scene is told it matters least.** The prompt declares "Character
  consistency is MORE IMPORTANT than artistic creativity or scene
  composition" immediately before `SCENE TO ILLUSTRATE` (~L760), and the
  `characterAnchor`-only blocks (eyes open, ethnicity lock, L514-519,
  L659-676) never fire for customers because `characterAnchor` is null —
  bench and customer prompts differ beyond the anchor image itself.
- **The check never sees a reference image.** `checkSpreadRender` receives
  ONE render and TEXT specs; identity is never compared to the anchor, props
  never to anything. The bench judge does receive the anchor — but it is
  advisory and bench-only (`AI_ILLUSTRATION_FEEDBACK_LOOP_PLAN.md` §2).
- **Bench ≠ customer.** Bench anchors come from the worker's
  `/v13/generate-cover-image` (no title, wardrobe + anatomy QA); customer
  anchors are app-generated title-bearing covers. The loop tunes against an
  input production never uses.
- **Nobody measures drift in production.** Advisories become
  `qaPassed=false` + `adminNeedsRegeneration` on the admin dashboard
  (app `utils/residualQaFlags.js`) and the book stays `complete`; no score,
  no rate, no trend. The owner's report is the monitoring.

---

## 2. Root causes (in priority order)

### A. Clothing and props are text where the model needs pixels

`gemini-3.1-flash-image` is a reference-driven model. It follows attached
images far more reliably than prose, and the current call attaches exactly
one image of the child — the cover — plus a world plate. Every garment the
cover does not show, and every prop, exists only as words; words are
re-interpreted per render, so they drift. The ce-8 v2 lock made the *words*
complete; it could not make them *visible*. The renderer's own dormant
`KEY OBJECTS` / `RECURRING COMPANION` blocks (L733-742) show the same pattern the
outfit had before ce-7 and composition before ce-8: machinery built, nothing
arming it — and even armed, they would still be words.

### B. The identity anchor is the wrong kind of image

The customer's anchor (app `routes/children.js` L1685-1760) is a **front
cover**: a scene, a pose, "not extreme close-up", title text painted in,
outfit invented per cover option, photo used as "LOOSE inspiration". It is
the parent-approved *character* — that is the correct ground truth — but as
a *reference* it (a) crops the lower body, (b) carries lettering into every
render's reference pack, (c) fixes one expression and pose that every render
is told, in prose, not to copy, and (d) was rendered by a different prompt
than the interiors. The deleted V3 design's rule (`PIPELINE_V3_DESIGN.md`
§A0) was: **the cover is the wardrobe/style truth; a neutral full-body
character sheet is the identity reference.** The cutover kept the first half
and dropped the second.

### C. Every check is a lenient single-image LLM boolean; nothing measures

The QA prompt is deliberately tuned against false positives ("Flag a
mismatch ONLY on a CLEAR break … borderline passes"). That is the right
calibration for a *shipping gate with a two-render budget* — the wrong one
for *consistency*, where the customer sees every borderline difference side
by side across twelve pages. Identity similarity, garment colour, and prop
appearance are all measurable against a reference; today nothing produces a
number, so nothing can select the better of two renders or flag an outlier.

### D. Repair regenerates, budgets are small, and shipped drift is frozen

Best-of-1 with two do-overs and an advisory on exhaustion. With no selection
step, a defect-free set of twelve needs twelve first-or-second-try successes.
The marker then makes the outcome permanent.

### E. Action, Emotion, and Cleanliness have no worker check at all

They are prompt-only traits scored by an advisory judge that customer books
never meet — and the safety-fallback ladder can remove the action and the
props from a spread entirely without anyone being told.

### F. The two repos disagree about the anchor, and production is unobserved

Bench tuning anchors on worker covers; customers get app covers; the
description the app derives from the photo is thrown away; the judge never
sees a customer book.

---

## 3. Design — the Book Bible

**One idea:** before any spread renders, build a *Book Bible* — the complete
set of fixed inputs for this book, as **images + schema-validated specs** —
verify it, hash it, and pin it on every render, every QA call, and every
cache key. Then accept a render by **measuring it against the Bible**, not by
asking whether it looks broken.

```
                    ┌──────────── Book Bible (built once, hashed, GCS) ────────────┐
approved cover ───► │ character sheet (image) ──► outfit spec v3 (schema)          │
child photo ──────► │ prop sheets (image per prop) ──► prop specs (schema)         │
profile/evidence ─► │ companion sheet (image, per theme)                           │
theme ────────────► │ world plate (image, exists)  + world card (exists)           │
story ────────────► │ shot plan (exists)  + emotion plan (closed enum)             │
                    │ TEXT_RULES (exists)                                          │
                    └───────────────────────────── bibleHash ─────────────────────┘
                                                        │
        per spread ──► render N candidates (reference pack + short structured prompt)
                                 │
                       score each candidate: structured vision QA WITH the sheets
                                 + deterministic metrics (child crop ↔ sheet embedding,
                                   garment colours, prop crop ↔ prop sheet, bbox rules)
                                 │
                       select best ≥ threshold ──► else bounded repair (fresh candidates)
                                 │
        book ──► set gate v2: child/prop CONTACT SHEETS vs the Bible + embedding outliers
                                 │
                       graded ship policy: blocking residual ⇒ needs_review with candidates
```

Everything above is a fixed input or a measurement. Nothing chains: the
sheets are generated once from the cover (one hop, then frozen), exactly
like the world plate.

### 3.1 Character sheet (`illustrator/bible/characterSheet.js`)

- **Input:** the approved cover (the parent-blessed character) and, when the
  request carries `childPhotoUrls`, the photo as a secondary likeness
  reference (V3's rule). The cover stays the wardrobe/colour truth.
- **Output:** ONE wide (16:9) model sheet in the pinned `PIXAR_STYLE`: the
  same child full-body **front, three-quarter, back**, relaxed standing pose,
  the SAME complete outfit in all three views (the prompt requires legs and
  shoes visible and tells the model to complete cropped garments *once,
  consistently*), two small head insets (happy, curious), flat light-grey
  background, no scene, **no text or labels**.
- **Best-of-3, judged, elected.** Three candidates; each is QA'd (no text,
  exactly three full-body figures of ONE child, feet visible, outfit
  identical across the three views, anatomy) and scored for likeness against
  the cover (face) — the highest-scoring candidate wins; a sheet that fails
  QA in all three is a `needs_review` for the book, never a silent fallback
  to the cover alone (a lock-less book is how drift shipped unnoticed —
  ce-8 lesson). Election is the world plate's create-if-absent pattern at
  `catalog-assets/character-sheets/{STYLE_VERSION}/{anchorHash}.png` (+
  `.json` with the judge scores), so racing instances adopt one sheet.
- **Outfit spec v3** is then derived FROM THE SHEET by the existing
  `outfitLock.js` machinery (structured slots, sanitized, ≤700 chars) — every
  slot is now `seen`; the `inferred` path becomes an error, not a feature.
  The spec is stored beside the sheet and both hashes ride the cache key.
- **Why not the raw photo as the sheet source?** The customer cover is
  generated with the photo as loose inspiration by policy; the parent
  approved *that* character. The sheet must reproduce the approved character
  or the interiors will not match the cover the parent chose.

### 3.2 Prop sheets and companion sheet (`illustrator/bible/propSheet.js`)

- **Which props.** Every `visual_required` evidence value the story carries
  (`object`, and any `food`/`place`/`interest` moment whose slot has
  `visual_alignment.mode !== 'none'`) plus the theme companion when the
  companion is a creature or character (catalog `theme.companion`).
- **Output per prop:** one square image of the object alone — two angles
  side by side — on a flat background, in the pinned style and the theme's
  world-law palette, no text, no child. Then one vision read produces a
  **prop spec** (schema: `{name, kind, colours[], material, sizeRelativeToChild,
  distinguishingMarks[]}`), sanitized like the outfit spec. QA: no text, one
  object, nothing else; one retry; failure ⇒ that prop renders spec-less
  with an advisory (props are decorative by contract — a missing prop sheet
  must never fail a book).
- **Caching:** by `(normalizedValue, themeId, STYLE_VERSION)` for profile
  props (two children with "teddy bear" in the same theme share one plate —
  that is fine and cheap); per theme for the companion, next to the world
  plate. Elected the same way.
- **Placement rule stays as today:** carried props are small, decorative,
  never plot-critical (ce-6); the sheet only fixes *what it looks like*.

### 3.3 Emotion plan (`illustrator/emotionPlan.js`)

A per-spread mood from a **closed vocabulary**
(`joy | wonder | curiosity | determination | worry | calm | surprise |
pride | tenderness | silly`) × intensity (`soft | clear | big`), pinned like
the shot plan. Two sources, both deterministic in effect:

1. A **beat-keyword table** per archetype (e.g. `discovers` → wonder,
   `does not explain` → puzzled/worry, `says goodbye` → tenderness,
   `counts ONE, TWO, THREE` → joy/big) — zero cost, always available.
2. One **structured text call per STORY** (not per render; cached under the
   story fingerprint) that maps the twelve spread texts onto the same enum
   with `responseSchema` enforcement, used when the table has no confident
   match. It is a classifier over a closed set, not a creative pass — the
   deleted art director stays deleted.

The plan rides the scene as one line (`EMOTION (this spread): clear
curiosity — eyes wide, leaning in, mouth slightly open`) and QA verifies
`emotion_reads_as ∈ enum` against it. Kill-switch `CATALOG_EMOTION_PLAN=0`
(cache fold `-e0`).

### 3.4 The Bible manifest

`children-jobs/{bookId}/bible.json` (also in the checkpoint and echoed on
callbacks as `bookBible`):

```json
{ "styleVersion": "ce-9", "anchorHash": "…", "characterSheet": {"key": "…", "hash": "…", "likeness": 0.91},
  "outfitSpec": {"hash": "…", "slots": {...}}, "props": [{"key": "teddy bear", "sheet": "…", "hash": "…", "spec": {...}}],
  "companion": {"sheet": "…", "hash": "…"}, "worldPlate": {"hash": "…"}, "shotPlanSeed": "…",
  "emotionPlan": {"hash": "…"}, "bibleHash": "…" }
```

`bibleHash` replaces today's separate `-w{plate}-o{outfit}` folds in the
render cache key (`renderStorySpreads`); anything that changes a pixel input
changes the hash. A stored book re-illustrates against its PINNED bible
(the `getBookForTag` discipline), never against a regenerated one.

---

## 4. Rendering — the reference pack and the prompt diet

### 4.1 Reference pack (renderer: `callGeminiImageApi`)

Every render attaches, in this fixed order with fixed labels:

1. `CHARACTER MODEL SHEET` — identity AND the complete outfit ("draw this
   exact child in this exact outfit; the grey background is not part of the
   scene").
2. `APPROVED COVER` — the parent-approved rendering, colours/materials truth
   only ("never its pose, expression, composition, or lettering").
3. `PROP SHEET: "<name>"` — one per prop on this spread (declared or carried).
4. `COMPANION SHEET` — when the beat names the companion.
5. `WORLD PLATE` — unchanged.

Search-engine sources describe `gemini-3.1-flash-image` as accepting up to
14 reference images per request with separate character-consistency and
object-fidelity budgets (the split is reported inconsistently — 4 or 5
character images). **Step 0 of the order below probes the real limit on the
bench before anything depends on it**; the pack above uses at most 5-6
images and stays inside every reported budget. The NSFW generic-safe
variant keeps the pack (it is the identity), as `safeFallbackSuffix` keeps
the fixed text today — and ce-9 closes the ladder's two holes: the
`sanitized` rung strips trigger words from the scene ONLY, never from the
pinned spec blocks (or it is retired in favour of the model's own
`safetySettings`, which the renderer starts sending from
`GEMINI_IMAGE_SAFETY_SETTINGS`), and a render accepted on any rung other
than `original` carries a `stage: 'render'` advisory naming the rung and
what it dropped, so a scene-less spread can never ship silently.

### 4.2 Prompt diet (renderer: `buildCharacterPrompt`)

The prompt today repeats the outfit six times and "IDENTICAL" a dozen; the
tuning block had to be moved to the very end because "mid-prompt it drowned
under the lock/checklist blocks" (ce-7). A reference-driven model is best
served by a short, structured prompt that names its references. ce-9
replaces the redundant blocks with:

- `CHARACTER` — one block: reference 1 + the outfit spec v3 (once) + hair
  line from `characterDescription` (now actually supplied — §7).
- `PROPS` — one line per prop: reference index + spec + placement rule.
- `COMPANION` — reference index + name/type.
- `EMOTION` — the plan line.
- `SCENE` — the beat + world card (unchanged), `COMPOSITION` (shot plan,
  unchanged), `STYLE`, `TEXT RENDERING RULES` (unchanged), a shortened
  checklist, then the Art Tuning block last (unchanged).

The dormant `keyObjects` / `recurringElement` parameters are retired in
favour of the structured blocks (or wired to them — the plumbing choice is
the implementer's; the contract is that props and companion reach the model
as reference-index + spec, once). Prompt assembly changes ⇒ `STYLE_VERSION`
→ `ce-9`.

---

## 5. Verification — measure, select, then gate

### 5.1 Candidates and selection (`illustrator/select.js`)

Render **N = 2 candidates per spread** (`CATALOG_RENDER_CANDIDATES`, default
2, clamped 1-3) concurrently through the same call, score both (§5.2), and
**select the best above threshold**. Only when neither clears the blocking
checks does the bounded repair run (fresh candidates with the fixed repair
note, as today). Selection is what makes the whole book consistent instead
of twelve independent coin flips; it is also what V3 ran ("2 candidates per
spread … best candidate ≥ threshold wins", `PIPELINE_V3_DESIGN.md` §A2-A3).

### 5.2 Scoring a candidate — structured vision QA WITH the Bible + metrics

**Vision (one call, as today, `gemini-2.5-flash`), now given the character
sheet and the relevant prop sheets as images beside the render,** returning
a schema-validated verdict (`responseSchema`, every field required):

| Field group | Fields | Verifies |
|---|---|---|
| identity | `same_child` (bool), `hair_match`, `skin_tone_match`, `age_reads_as_child` | Identity vs the SHEET (image-to-image) |
| outfit | per slot `top/bottom/footwear/outerwear/accessories ∈ {match, mismatch, not_visible}` | Identity-clothing vs the sheet + spec — per garment, not one boolean |
| props | per prop `{presence ∈ {present, absent}, look ∈ {match, wrong_look, n/a}}` | Props vs the prop sheet |
| companion | `present`, `look_match` | Props |
| action | `depicts_beat` (bool), `child_is_agent` (bool) | Action vs the pinned beat text |
| emotion | `emotion_reads_as ∈ enum`, `expression_blank` | Emotion vs the plan |
| composition | `shot_type_mismatch` (exists), `child_bbox` [x,y,w,h] normalized | Composition; the bbox feeds the deterministic checks |
| cleanliness | `extra_limbs`, `hand_defects`, `face_artifacts`, `stray_lettering_or_signage`, `pseudo_script` | Cleanliness (the cover anatomy check, ported to interiors) |
| text | existing embedded/caption fields | Typography (unchanged) |
| existing | `child_absent`, `multiple_children`, `flat_or_photo_style` | unchanged |

**Deterministic metrics (`illustrator/metrics.js`, no LLM, kill-switch
`CATALOG_IDENTITY_METRICS`):**

- **Child crop ↔ sheet embedding distance.** Crop the render at `child_bbox`
  (sharp), embed it and the sheet's front view with an image-embedding model
  (spike in step 0: Vertex AI multimodal embeddings, or a small ONNX
  DINOv2/CLIP in the container — whichever is cheaper to operate; the metric
  is a number in either case), cosine distance ⇒ `identityScore`.
- **Garment colour check.** Dominant colours of the upper/lower/feet
  regions of the crop vs the spec's colours (the spec gains a machine-
  readable `colourHex[]` per slot at derivation) ⇒ per-slot ΔE.
- **Prop crop ↔ prop sheet** the same way when the vision call returns a
  prop bbox.
- **Bbox rules (Composition/Cleanliness):** off-centre rule (`wide`
  renders: bbox centre outside 40-60% width), safe zone (bbox inside the
  print-safe rectangle), shot-type sanity (wide: bbox height < 45% of frame;
  close-up: > 65%).

Thresholds are **calibrated on the bench** with the existing variance
baseline (§5.5 of the feedback-loop plan) before they gate anything:
Phase 0 renders the same spreads 3× under ce-8 and reports the metric
spread, so a threshold is set at "clearly worse than noise", never guessed.

**Score = blocking checks + weighted advisory checks.** Blocking (a
candidate cannot be selected with one): `child_absent`, `multiple_children`,
`same_child=false`, any visible outfit slot `mismatch`, a declared prop
`wrong_look`/`absent`, `extra_limbs`, painted text in caption layout,
`identityScore` below the calibrated floor. Everything else lowers the
score and steers selection.

### 5.3 Repair v2

Unchanged shape (fresh render + fixed repair note, `CATALOG_SPREAD_QA_MAX_REPAIRS`)
but (a) the note names the exact slot/prop from the structured verdict
("the trousers must be full-length blue jeans as in REFERENCE 1"), (b) each
repair pass renders N candidates too, and (c) drift-class defects get their
own budget (`CATALOG_DRIFT_MAX_REPAIRS`, default 2) so a stubborn text
defect cannot starve an outfit fix.

### 5.4 Set gate v2 — contact sheets (`illustrator/contactSheet.js`)

Replace "twelve 1024px JPEG-q72 thumbnails in one call" (`spreadQa.js`
L251, L263 — a 16:9 spread becomes 1024×576, garments a few dozen pixels)
with two purpose-built images: the **child contact sheet** (the twelve child crops from the
selected renders, tiled 4×3 at ~384px with spread labels, the sheet's front
view in the corner) and the **props contact sheet** (prop crops the same
way). One vision call over each asks which tiles differ from the reference
(outfit/hair/age/prop look) — garments are now legible — plus the
deterministic **embedding outlier test** across the twelve crops (z-score
against the set median). Flagged spreads re-render through the full
per-spread path with the repair note, within the existing
`CATALOG_WORLD_QA_MAX_RERENDERS`. The world dimensions (palette, era,
physics, magic, composition_duplicate, text_treatment) keep today's whole-
image thumbnail call unchanged.

### 5.5 Graded ship policy

Today every residual defect ships with an advisory. ce-9 splits the
vocabulary:

- **Advisory class** (ships, as today): emotion mismatch, borderline shot
  type, hand defects, low-weight metric misses.
- **Blocking class** (must be resolved before the book completes): the
  blocking list of §5.2 after candidates + repairs are exhausted.

A customer book with a blocking residual returns
`failureCode: 'consistency_unresolved'` with the spread's candidates (URLs +
scores) on the failure callback; the app maps it to the existing
`adminNeedsRegeneration` + `qaIssues` panel and offers **pick a candidate**
or **re-render this spread** (the existing `rerenderSpreads` probe operation,
exposed for customer books — §7). Kill-switch `CATALOG_SHIP_ON_EXHAUSTION=1`
restores ship-with-advisory for every class. This is a product decision the
owner should confirm: a guarantee needs a gate, and the gate costs delivery
time on the (measured — §8) small fraction of books that exhaust the budget.

### 5.6 The marker

`.qa.json` gains `qaVersion` + the structured verdict + scores. A replay
whose marker predates the current `qaVersion` re-checks (as an unmarked
render does today); an admin re-render clears it. Shipped drift stops being
permanent.

---

## 6. Per-trait guarantee after ce-9

| Trait | Fixed input | Render-time | Per-spread | Set-level | Ship policy |
|---|---|---|---|---|---|
| Identity (face/hair/skin) | character sheet (image) + cover + `characterDescription` | reference 1+2 | `same_child`/hair/skin vs sheet + `identityScore` | child contact sheet + embedding outliers | blocking |
| Identity (clothing) | outfit spec v3 derived from the sheet (all slots seen) | reference 1 + ONE spec block | per-slot match vs sheet + colour ΔE | child contact sheet | blocking (visible slots) |
| Props | prop sheet (image) + spec per prop; carry-through (ce-6) | reference 3… + PROPS block | per-prop presence/look vs prop sheet (+ crop metric) | props contact sheet | blocking (declared props) |
| Companion | companion sheet per theme | reference 4 | `look_match` | child contact sheet (companion tiles) | blocking when named by the beat |
| Action | the beat (unchanged) | SCENE block | `depicts_beat` + `child_is_agent` | — | advisory → blocking after bench calibration |
| Emotion | emotion plan (closed enum) | EMOTION line | `emotion_reads_as` vs plan | — | advisory |
| Composition | shot plan (ce-8) | COMPOSITION block | `shot_type_mismatch` + bbox rules | `composition_duplicate` | advisory (bbox safe-zone blocking) |
| Style | style block + world card + plate (ce-5) + on-style sheets | STYLE block, references | `flat_or_photo_style` + embedding vs sheet | world thumbnails (unchanged) | blocking (`flat_or_photo_style`) |
| Typography | TEXT_RULES (ce-4) | unchanged | unchanged | `text_treatment` | blocking (unchanged) |
| Cleanliness | prompt checklist + text-free sheets | — | anatomy/lettering fields + bbox safe zone | — | `extra_limbs` blocking; rest advisory |

---

## 7. Cross-repo contract (giftmybook-standalone)

Worker-side changes are self-contained, but three app changes are needed
for customers to get the full effect, and two more for the loop to tune what
production runs:

1. **Send the character description the app already has.**
   `describeChildFromPhoto` (app `routes/children.js` L1193) runs at cover
   time and its sentence is persisted as `book.childAppearance`
   (L1586-1591) — but `buildWorkerPayload` reads only
   `storyContent.characterAnchor || storyContent.characterDescription`
   (`childrenGeneration.js` L56), which no catalog path sets, so the worker
   gets `null`. Fall back to `book.childAppearance`: one line, no worker
   change, effective immediately.
2. **Prepare the Bible at cover approval.** New worker endpoint
   `POST /v13/prepare-identity {bookId, approvedCoverUrl, childPhotoUrls,
   profile?}` → `{characterSheetUrl, outfitSpec, advisories}` (sync, like
   `/v13/generate-cover-image`). The app calls it when the parent approves a
   cover (before payment completes), so the sheet is built off the critical
   path and can be shown on the admin book page; `/generate-book` builds it
   lazily if absent (election makes both paths converge on one sheet).
3. **`consistency_unresolved` handling.** Map the new failure code to
   `adminNeedsRegeneration` + `qaIssues` with the candidate thumbnails;
   expose "pick candidate" / "re-render spread" (the worker's existing
   `rerenderSpreads` per-spread force through `/v13/render-spreads`, now
   allowed for non-test books with `identityKeyed:false`, cache-keyed by the
   pinned bible). Show `bookBible` (sheet, props, hashes) on book details.
4. **Bench parity.** The Art Bench anchor step builds its anchor the customer
   way (an app-style cover → `/v13/prepare-identity`) and the app judge
   receives the character sheet as image 1 beside the cover, so "identity
   fidelity" is judged against the same reference the renderer used.
5. **Judge production.** Run `judgeRenders` on every completed customer
   book's twelve renders (12 cheap vision calls + one consistency call —
   the "judge-on-production option" of the feedback-loop plan §6.4) and
   store per-trait scores; the art quality map gets real traffic and the
   owner gets a **drift rate** (share of books with any blocking residual,
   per theme × band × layout) instead of anecdotes.

The cover prompt itself is not changed by this plan (the cover is a product
artifact with its own loop — feedback-loop plan §13.1); one optional nudge is
worth an A/B: "the child's legs and shoes visible where the composition
allows", which lets the sheet reproduce rather than complete the lower body.

---

## 8. Mechanics, versioning, cost, time

- **`STYLE_VERSION → ce-9`**: prompt assembly, reference pack, and QA all
  change; ce-8 renders must never replay as ce-9. `bibleHash` replaces the
  `-w`/`-o` folds; new kill-switch folds `-e0` (emotion plan), `-cs0`
  (character sheet), `-ps0` (prop sheets).
- **New env (all kill-switches or bounded knobs):** `CATALOG_CHARACTER_SHEET`,
  `CATALOG_PROP_SHEETS`, `CATALOG_EMOTION_PLAN`, `CATALOG_IDENTITY_METRICS`,
  `CATALOG_RENDER_CANDIDATES` (1-3, default 2), `CATALOG_DRIFT_MAX_REPAIRS`
  (0-4, default 2), `CATALOG_SHIP_ON_EXHAUSTION` (default 0 = block).
- **Cost per book** (`gemini-3.1-flash-image` $0.02/render, `costTracker.js`
  L20; vision calls on `gemini-2.5-flash` are cents per book):

  | | today (ce-8) | ce-9 |
  |---|---|---|
  | one-time per anchor | outfit read | sheet best-of-3 ($0.06) + 3 QA reads + spec read |
  | per book, fixed | world plate (cached) | prop sheets ~1-3 ($0.02-0.06, cached by value+theme) |
  | base renders | 12 ($0.24) | 24 ($0.48) |
  | repairs | ≤24 ($0.48 worst) | ≤24 candidates ($0.48 worst; rarer) |
  | set gate | ≤3 re-renders | ≤3 re-renders (+2 contact-sheet calls) |
  | vision QA | ~15-40 calls | ~30-60 calls with 3-6 images each (≈ $0.05-0.15) |
  | embeddings | — | ~40 (≈ $0.01) |
  | **typical total** | **≈ $0.30-0.45** | **≈ $0.70-0.95** |

  Roughly double the image spend on a product whose print cost dwarfs it;
  the money buys selection pressure — the mechanism that makes drift rare
  instead of repaired.
- **Time:** candidates render in the same parallel waves
  (`RENDER_CONCURRENCY` 4 → consider 6 with the key pool); expect +30-50%
  wall clock on the illustration stage, offset by fewer repair rounds. The
  sheet is built at cover approval (§7.2), off the critical path.
- **Storage:** sheets/props are small PNGs under `catalog-assets/`; the
  bible is a few KB per book.

## 9. What this plan deliberately does NOT do

- **No previous-spread chaining.** Sheets and prop plates are generated once
  from fixed sources and frozen — a fixed reference cannot accumulate drift
  (the world-plate argument). Renders never see other renders except as
  crops inside a QA contact sheet, which drives *checks*, never prompts.
- **No LLM art director, no per-book creative pass.** The emotion plan is a
  classifier over a closed enum with a deterministic table underneath; shot
  plan and world card stay deterministic.
- **No plot edits, no writer changes.** Beats stay frozen; props stay
  decorative and never plot-critical (ce-6).
- **No free model text in prompts.** Specs are schema-validated and
  sanitized (the outfit-lock discipline); repair notes come from a closed
  vocabulary plus pinned spec fields.
- **No replacement of the Art Bench loop.** The Bible gives the loop the
  same references production uses and the production judge gives it real
  numbers; directives still ride as the final binding-within-scope block.
- **No silent fallbacks for identity.** A book that cannot build a
  character sheet is `needs_review`, not "renders on the cover alone" — the
  ce-8 lesson applied at the source.

## 10. Order & tests

0. **Measure and probe (no product change, ~3 days).** (a) Bench probe:
   how many labeled reference images `gemini-3.1-flash-image` honours
   (attach a sheet + 2 prop plates + cover + plate; verify the outfit/prop
   fidelity by eye and with the metric spike). (b) Embedding spike: Vertex
   multimodal embeddings vs in-container DINOv2 on 20 crops — pick one.
   (c) Baseline: run the app judge + the metric over 20 recent customer
   books; record per-trait scores and the variance of 3× re-renders. These
   numbers set the thresholds and become the before/after evidence.
1. **Identity kit (worker).** `bible/characterSheet.js` (generation prompt,
   3-candidate QA + likeness judge, election, `needs_review` on failure),
   outfit spec v3 from the sheet (`outfitLock.js` gains a `source` and
   rejects `inferred` slots), `bible/index.js` (manifest, `bibleHash`),
   reference pack in `callGeminiImageApi`, prompt diet in
   `buildCharacterPrompt`, `STYLE_VERSION` ce-9, flags, CLAUDE.md. Tests:
   sheet QA parsing/election/race (mirror `worldPlateRace.test.js` and
   `outfitLock.test.js`), pack order and labels survive the NSFW fallback,
   the manifest hash folds every input, a book whose sheet fails ends in
   `needs_review`.
2. **Props (worker).** `bible/propSheet.js` + prop specs, companion sheet per
   theme, PROPS/COMPANION blocks, per-prop QA fields + repair notes, props
   contact sheet. Tests: props declared/carried per spread produce the right
   references, spec sanitization, prop-less advisory path.
3. **Selection gate (worker).** `select.js` (N candidates, scoring,
   thresholds from step 0), structured `responseSchema` verdict with the
   sheets attached to the QA call, `metrics.js` (bbox crop, embedding,
   colour ΔE, bbox rules), child contact sheet + outlier test, graded ship
   policy + `consistency_unresolved` failure payload with candidates, marker
   `qaVersion`. Tests: selection picks the higher score, blocking vs
   advisory classification, exhaustion produces the failure payload, a
   stale marker re-checks, all fail-open paths carry `qaUnavailable`.
4. **Emotion / action / cleanliness (worker).** `emotionPlan.js` (table +
   cached classifier + `-e0` fold), EMOTION line, `depicts_beat`,
   `child_is_agent`, `emotion_reads_as`, anatomy/lettering fields (port
   `qaCoverAnatomy`'s prompt), bbox safe-zone rule. Tests: plan determinism,
   enum validation, advisory-only classification until calibrated.
5. **App wiring** (§7): characterAnchor persistence, `/v13/prepare-identity`
   at cover approval, `consistency_unresolved` UI + pick/re-render, bench
   parity, production judge + drift rate on the art quality map.
6. **Validation recipe.** Same book as ce-8's trigger
   (`jungle_6_7_footprint_trail`, embedded, 12 spreads) plus a band 1-3 farm
   book with a comfort object and Farmer Bea on ≥6 beats. Assert: every
   outfit slot `match` on every visible spread; the comfort object and
   companion `look_match` on every appearance; `identityScore` spread across
   the twelve below the calibrated band; zero blocking residuals; emotion
   matches the plan on ≥10/12; A/B against ce-8 on the bench with the 3×
   variance baseline. Ship ce-9 behind the flags to a canary Cloud Run
   revision; compare the production drift rate (§7.5) for two weeks before
   defaulting.

## 11. Open decisions (defaults chosen — flag if you disagree)

1. **Block or ship on unresolved blocking defects?** Default: block
   (`needs_review` with candidates), kill-switch to ship. A guarantee needs a
   gate.
2. **Candidates per spread.** Default 2; 3 for band 1-3 board books (fewer,
   simpler scenes — cheap) is an option once step 0 shows the marginal gain.
3. **Embedding backend.** Decided by the step-0 spike; both are behind the
   same interface and the kill-switch.
4. **Prop sheet scope.** Default: `object` evidence + companion only. Food
   and place moments (pinned to one spread) get a sheet only if step 0 shows
   single-spread props also morph within the spread's repairs.
5. **Sheet source.** Default: cover (+ photo when supplied). If policy later
   allows stronger photo likeness in the cover, the sheet inherits it
   automatically.

## 12. What the implementation also changed (audit findings beyond the plan)

The adversarially verified audit that preceded implementation (4 trait-pair
auditors, 4 skeptics, 1 completeness critic — 9 agents, every gap checked
against code) surfaced drift sources this plan had not named. ce-9 closes
these too:

- **The printed front cover was not the approved cover.** `runBookPipeline`
  called `generateCover` with neither `preGeneratedCoverBuffer` nor photo
  bytes; `generateFrontCoverImage` therefore rendered a fresh, title-less,
  un-anchored child for the physical cover. ce-9 downloads the approved
  cover once and prints its own pixels (`preGeneratedCoverBuffer`; the
  harmonize step still applies when the source is not provably 3D).
- **The upsell spread printed four un-gated child renders in invented
  outfits inside the same book.** ce-9 passes the locked outfit spec and
  attaches the character sheet as REFERENCE 1 to every upsell render
  (`CATALOG_UPSELL_OUTFIT_LOCK=0` opts out).
- **The safety-fallback ladder silently discarded the scene.** The
  `sanitized` rung regex-stripped words like *bare/love/kiss* from the
  outfit spec and story text; the `generic-safe` rung dropped the action,
  props and continuity lines, and its acceptance was console-only. ce-9
  sanitizes the SCENE only, re-attaches the bible blocks on the last rung,
  sends `GEMINI_IMAGE_SAFETY_SETTINGS` (defined in config.js, never sent),
  and puts a stage `render` advisory on any non-`original` acceptance.
- **The world-law card contradicted the outfit lock on whole themes**
  (under_the_sea: "fabrics float, nothing stays dry" vs "never add
  swimwear, never remove shoes"; space: "suits and helmets" vs "never
  helmets"), and the bath/water exemption matched zero catalog beats. In
  bible mode the legacy "FORBIDDEN OUTFIT CHANGES" block no longer renders;
  the outfit is whatever the approved cover — already a theme-appropriate
  wardrobe — shows, reproduced by the sheet.
- **Two themes' companions are human adults the renderer forbade twice**
  (Farmer Bea, Builder Sam — 38 books) via the NO FAMILY MEMBERS and
  BACKGROUND rules. The COMPANION block now names the fictional guide as
  explicitly allowed; the no-other-humans rule applies to everyone else.
- **The QA marker carried no checker version and a 40-item advisory cap
  dropped findings silently.** Markers record `qaVersion` + the verdict and
  an `unresolved` flag; advisories are capped at 80 with blocking-class
  notes first.
- **Bench and customer prompts differed beyond the anchor**: the
  `characterAnchor`-only blocks never fired for customers because the app
  sent `null`. The app now falls back to the persisted `childAppearance`.
- **Selection inside one render call was OCR-only.** The renderer accepted
  the first attempt (or the first whose painted text matched); outfit and
  identity never influenced which sample shipped. Candidate selection now
  scores every sample against the bible.

Still open (operational, not code): the customer anchor is a 7-day signed
URL persisted verbatim (the app should persist the GCS path and re-sign on
dispatch), and the metric thresholds/embedding backend need the Phase 0
bench calibration before `CATALOG_IDENTITY_METRICS=1` is switched on.

## Appendix — evidence index

- Renderer reference pack: `services/illustrationGenerator.js` L15
  (`GEMINI_MODEL`), L922-1010 (`callGeminiImageApi`, two-image parts).
- Prompt blocks: `buildCharacterPrompt` L479-903 (outfit repeats L532-537,
  570-572, 638-643, 725-728, 749-757, 868; dormant `RECURRING COMPANION`
  L733, `KEY OBJECTS` L739; anchor "identity only" L712; reference parts L945-957).
- Orchestration: `services/catalogEngine/illustrator/index.js` L40
  (`RENDER_CONCURRENCY`), L101-360 (`renderSpread`: options L151-198, marker
  replay L214-240, QA + repair L291-330, marker write L333-350), L412-480
  (world gate), L530-740 (`renderStorySpreads`, cache folds L583-640).
- Scenes/props: `illustrator/scenes.js` L27 (`visualPropsForSpread`), L42
  (`isCarryThroughEvidence`), L72 (`continuityPropsForSpread`), L88
  (`inertPropValue`), L104 (`beatMentionsCompanion`), L124-167.
- Outfit lock: `illustrator/outfitLock.js` L62-82 (prompt, `inferred`),
  L201-237 (`renderOutfitSpec`), L279-343 (`getOutfitLock`, election).
- QA: `illustrator/spreadQa.js` L48-125 (`buildSpreadQaPrompt`, leniency
  text L100-115), L143-235 (`checkSpreadRender`), L251
  (`WORLD_QA_THUMB_WIDTH`), L282-330 (`worldQaPrompt`), L358-430
  (`checkWorldConsistency`), L438 (`WORLD_REPAIR_INSTRUCTIONS`), L553-600 (`repairNote`).
- Safety ladder: `services/illustrationGenerator.js` L213 (`NSFW_TRIGGER_WORDS`),
  L218-222 (`sanitizePrompt`), L235-250 (`buildGenericSafePrompt`),
  L1169-1182 (variants), L1234 (silent acceptance); `services/shared/illustration/config.js`
  L21-26 (`GEMINI_IMAGE_SAFETY_SETTINGS`, unused by the renderer).
- Cover anatomy/wardrobe QA (covers only): `services/coverGenerator.js`
  L512, L570, L774-941.
- Completion payload: `services/catalogEngine/pipeline.js` L326-380.
- App: `server/routes/children.js` L1193 (`describeChildFromPhoto`),
  L1231-1330 (`generateGeminiImage`, "LOOSE inspiration" L1251-1259),
  L1685-1760 (cover prompt; title text L1713); `server/services/childrenGeneration.js`
  L37-63 (`characterDescription: storyContent.characterAnchor || … || null`);
  `server/services/illustrationJudge.js` L22 (`CONSISTENCY_MAX_IMAGES = 6`), L158-310; `server/services/illustrationTuning.js`
  L50-63 (rubric); `server/utils/residualQaFlags.js`.
- History: `docs/PIPELINE_V3_DESIGN.md` §5 (A0 identity kit, A2 two
  candidates, A3 selection), `docs/audits/2026-07-18-…` §2 (prop sheet),
  `docs/audits/2026-07-19-…` ("Prop morphing — FIXED … prop plate visibly
  working"), commit `8b41dad` (cutover: deleted `identityKit/characterSheet.js`,
  `artDirection/propPlate.js`, `qa/select.js`, `qa/likenessJudge.js`,
  `bookPass/contactSheet.js`).
