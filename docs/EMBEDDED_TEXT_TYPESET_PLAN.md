# Embedded text — deterministic typography and no text panels (plan, ce-15)

> **Status: PLAN** (2026-09-03). Nothing in this document is implemented yet.
> It follows the ce-9 plan's principles (fixed inputs, no chaining, closed
> vocabularies, bounded budgets, cache-key folds, kill-switches, spreadQa is
> the shipping gate) and changes WHO owns the typography of an `embedded`
> spread: the layout engine, not the image model.

**Trigger.** An Art Bench round (Build-It Yard, `embedded` layout, twelve
spreads, rendered under `ce-13`/`ce-14`) shows two recurring defects:

1. **The painted font size varies wildly between spreads.** Spreads 1, 2,
   4, 8 and 12 came out at the intended small body size; spreads 3, 6, 7,
   9, 10 and 11 came out at caption/poster scale — two to three times
   larger, on the same book, under the same pinned `TEXT_RULES` spec.
2. **Spread 10 painted its text on a solid beige panel** covering the whole
   right half of the image — exactly the `text_on_band` defect that ce-11
   made BLOCKING — and the bench still shows it with a "QA advisories"
   badge.

The owner's ask: fix both **in a general way**, not with another prompt
sentence.

---

## 1. Diagnosis — why prompt rules cannot fix either symptom

### 1.1 Font size is an instruction to a model that cannot measure

Every lever the pipeline has on the painted text's size is prose in the
render prompt: `TEXT_RULES.fontSize` ("cap height about 1.5% of the image
height … when unsure, go SMALLER"), the renderer's FONT SIZE line ("err on
the side of TOO SMALL"), the pre-wrapped 30-character lines (ce-13), the
column box (ce-13), and the ce-14 shrink. Four consecutive style versions
(ce-4, ce-12, ce-13, ce-14) tightened that prose, and the round above still
came out bimodal: the model either "gets" small body type or falls back to
the caption scale it was trained on. That is not a prompt-wording problem;
a diffusion model does not hold a ruler.

Meanwhile **nothing in the pipeline measures the size**:

- `text_style_inconsistent` (spreadQa v2) is intra-block — it fires when
  ONE block mixes sizes, never when the whole block is twice too large.
- The world gate's `text_treatment` is a cross-spread advisory that asks a
  vision model whether the typography "clearly differs"; a two-times size
  difference is exactly the kind of judgment a lenient yes/no lets through,
  and an advisory never sinks a candidate or fails a book anyway.
- The v2 verdict already returns `text_bbox`, but it is only used for the
  fold-straddle backstop (ce-12). The block's height divided by the known
  line count (`wrapStoryLines` decides the line count before the render)
  is the font size — the number is on the table and nobody reads it.
- The app-side judge's "Typography" trait says "ONE modest size"; a per-
  spread judge has no reference for what modest is.

By the repository's own doctrine ("an invariant no check enforces is an
aspiration"), the size was never guaranteed.

### 1.2 The panel is the model's answer to the legibility we demand

The render prompt asks for small, crisp, high-contrast, perfectly typeset
text over a busy 3D construction site. The model's cheapest way to satisfy
"legible" is a flat plane behind the words — a sign board, a cream wall, a
parchment — which is what spread 10 is. The pipeline's only defence is
rejection: the judge's `text_on_band` boolean (prompted as a "blank, solid,
or lightened band/strip/panel (letterbox)" — a warm beige plane that reads
as "a wall" can pass that wording), then the ce-11 blocking class, then
two candidates and two repair passes that ask the same model for the same
legibility. When every candidate and repair carries a panel, the probe
reports `qa.pass=false` + `unresolved[]`, and the bench renders that as the
same amber "QA advisories" badge it uses for a soft finding
(`AdminIllustrationTuning.jsx` render card: `render.qa.pass ? 'QA pass' :
'QA advisories'`). Either the judge missed the panel or the loop exhausted
on it — both are consequences of the same design: **a gate can only
reject** (the ce-13 note), and we keep asking the model to solve legibility
by itself.

### 1.3 Painted body type cannot be print-sharp anyway

The renders are ~1K–2K pixels wide and print as a 17-inch spread (two
8.5-inch pages): 60–120 dpi. A glyph with a cap height of 1.5% of the image
is 9–17 pixels tall. That is why the *correctly* small spreads (1, 2, 8,
12) look soft at print size and why OCR (`verifyImageText` /
`compareTexts`) keeps flagging garbled edges: at the size we ask for, the
pixels are not there. Real PDF type is vector at any size. The caption and
half layouts already ship exactly that (`computeBookCaptionBlock`: one
face, one ink, one fixed size on every spread of every book, asserted by a
test).

### 1.4 The conclusion

Both symptoms are properties the image model controls least reliably and
the PDF layer controls perfectly. The general fix is to move the words
out of the pixels: **`embedded` renders text-free art with a reserved calm
column, and the layout engine typesets the manuscript over it with one
book-wide deterministic spec.** Size becomes a number in config, identical
on all twelve spreads by construction; a panel becomes impossible because
the art is text-free and the only backdrop the words can ever have is the
artwork itself (plus a feathered, non-rectangular legibility treatment we
control). The pre-ce-2 overlay path (`layoutEmbeddedSpread`,
`drawCaptionOverlay`) still exists in the layout engine; §3 says why it
failed in July and what is different now.

Section 4 keeps the painted path alive behind a kill-switch and hardens it
with deterministic measurement, because (a) the bench needs an A/B and
(b) two of the new checks — text-zone calmness and the size measurement —
are useful whichever surface owns the words.

---

## 2. Principles carried over (unchanged)

- **Fixed inputs, verified against.** The text column is pinned per spread
  by the shot plan (`textSide`, ce-8) and `TEXT_RULES` geometry, rides the
  scene prompt, is measured on the render, and is the same rectangle the
  layout engine typesets into. One helper owns the geometry (§3.2).
- **No chaining.** Nothing about a spread's typesetting depends on another
  spread's render; the spec is book-wide constant.
- **Closed vocabularies.** New QA fields and defect strings are fixed
  strings; repair notes restate pinned data only.
- **Bounded budgets, cache folds, kill-switches.** New behaviour is
  cache-keyed (`STYLE_VERSION` bump + a distinct cache aspect), and the old
  behaviour stays reachable behind `CATALOG_EMBEDDED_PAINTED=1` for the
  bench.
- **D5 for the whole book:** words are PDF type, never pixels — the rule
  caption and half already obey. `embedded` stops being the exception.

---

## 3. The structural fix — `embedded` = calm-column art + typeset overlay

### 3.1 Rendering: text-free art with a reserved column

`renderSpread` (illustrator/index.js) stops passing `embedText` /
`pageText` for the embedded layout; the renderer runs its `skipTextEmbed`
path exactly as caption and half do (no TEXT RENDERING RULES block, no
OCR retries, `BASE_MAX_RETRIES` instead of `TEXT_HEAVY_MAX_RETRIES`).

The scene gains a **TEXT COLUMN** hint, the embedded sibling of the
half-layout hint that already works in production ("keep the LEFT half
continuous calm background … no faces, no companion, no critical story
elements"):

```
COMPOSITION FOR PRINT (TEXT COLUMN): in the printed book the story text is
typeset over the {LEFT|RIGHT} column of this image (x from 7% to 35% of
the width, y from 26% to 64% of the height). Keep that column CONTINUOUS
CALM SCENERY — sky, water, a plain wall, soft foliage, gentle depth haze —
with no faces, no companion, no props, no signage, no small busy detail,
and no strong bright/dark contrast edges inside it. The scenery must
continue THROUGH the column edge to edge: never a blank, solid, lightened
or darkened band, card, plaque, board, or panel; never letterboxing.
The child, the action, and every key element live outside the column.
```

The column side comes from the shot plan's existing `textSide` (opposite
the child's third); the numbers come from `TEXT_RULES`
(`edgePaddingPercent`, `activeSideMaxPercent`, `topPaddingPercent`,
`bottomPaddingPercent`) through the shared geometry helper (§3.2), so the
prompt, the QA check, and the typesetter can never disagree about where
the words go. The hint rides `safeFallbackSuffix` like the half hint and
the shot directive, so the NSFW generic-safe rung keeps the column.

Cache: `cacheAspect` becomes `wide-column` for embedded (half keeps
`wide-plain`; a half render reserves a different region and must never
replay as an embedded one), and `STYLE_VERSION` bumps to `ce-15` — painted
ce-14 renders must never replay as text-free art.

### 3.2 One geometry helper: `textColumnRect`

New pure module `services/catalogEngine/illustrator/textColumn.js`:

```
textColumnRect({ side, childAge })
  → { side, x0, x1, y0, y1 }            // fractions of the RENDER frame
pageColumnRect(rect, { pw, ph })
  → { x, y, w, h }                      // points on the page half that
                                        // carries the column, after
                                        // splitSpreadImage's vertical
                                        // centre-crop (16:9 → two squares
                                        // trims ~5.6% of the render height
                                        // top and bottom)
```

Consumers: the scene hint (§3.1), the calmness metric (§3.3), the QA
prompt (§3.3), the typesetter (§3.4), the bench preview (§5), and the
video plan's text gate (unchanged behaviour — a text-free render is what
it wants). A test asserts the render-frame rectangle equals the numbers
`TEXT_RULES` states today and that the page rectangle respects `SAFE` and
the fold gutter (`OVERLAY.GUTTER_FRAC`).

### 3.3 Verification: the column is calm, text-free, and empty of the cast

Per-spread QA v2 (`spreadQa.js`) for the embedded layout becomes the
caption-layout check ("the art must contain no readable text" —
`readable_text` stays BLOCKING as `painted text in the illustration`) plus
two column fields, phrased on the pinned rectangle:

- `column_has_face_or_prop: true|false` — a face, the companion, a declared
  prop, or signage inside the text column → BLOCKING defect
  `text column occupied` (fixed string; repair note restates the column
  hint verbatim). The child bbox already lets `metrics.js` add a
  deterministic overlap backstop (bbox ∩ column > 10% of the column).
- `column_is_flat_panel: true|false` — the column is a blank, solid,
  lightened or darkened band, card, board, or panel instead of continuous
  scenery → BLOCKING defect `text column is a blank panel` (this is the
  spread-10 failure, now caught on text-free art where it is far rarer:
  the model no longer has words to "protect").

**Deterministic calmness metric** (`metrics.js`, sharp, no model): crop the
column at the render's resolution, compute per-cell luminance mean/stdev
on a 4×6 grid and the fraction of high-gradient pixels (Sobel magnitude
above a threshold). Outputs `columnCalm: {stdev, edgeFrac, flat}`:

- `edgeFrac` above `COLUMN_RULES.MAX_EDGE_FRAC` or `stdev` above
  `COLUMN_RULES.MAX_STDEV` → advisory `text column busy` (shades candidate
  selection; the repair note restates the column hint). Candidates with a
  calmer column win — the same shading `select.js` applies to bbox rules.
- `flat` (≥ 85% of column pixels within ΔE 6 of the modal colour AND a
  straight high-contrast boundary along the column's inner edge) →
  deterministic backstop for `column_is_flat_panel`, the way the bbox
  straddle backstops the fold judgment today.

The world gate's `text_treatment` vocabulary retires for this layout (no
painted text to compare); `composition_duplicate`, `character_rendering`
and the world classes are unchanged.

### 3.4 Typesetting: one book-wide spec, no panel ever

`layoutEmbeddedSpread` (layoutEngine.js) already handles entries without
`textEmbeddedInArt`; the embedded entries stop carrying that flag and
carry `textColumn: {side, rect}` from §3.2 instead. Changes to the overlay
path:

1. **Placement** comes from `pageColumnRect`, not from the July
   `textZone`/quadrant heuristics (`chooseOverlayZone`, `overlayZoneRect`,
   `computeOverlayPlacement`), which remain only for legacy entries. The
   block is LEFT-aligned inside the column (the `TEXT_RULES.textAlignment`
   intent), top-anchored at the column's top, never centred, never wider
   than the column, never nearer the fold than the gutter inset.
2. **Type spec** is a new frozen `EMBEDDED_TYPE` in
   `shared/illustration/config.js`, the print twin of the painted
   `TEXT_RULES`: `face: 'playfair'` (the traditional book serif the spec
   asks for; Playfair Display already ships on the caption pages and the
   half panels, in its italic cut — the overlay uses the regular cut), `size: 16` pt on
   the 612-pt page (cap height ≈ 1.85% of the page ≈ 1.6% of the render
   frame after crop — the ce-14 target), `leading: 1.32`,
   `maxCharsPerLine: 30` (reuse `wrapStoryLines`: same breaks the prompt
   used to hand the model), `ink: warm ivory`, `halo: dark glyph-outline`
   (the P5 outline machinery, so `pdftotext` sees one copy). The ladder
   `[16, 15, 14]` is an overflow valve only, exactly like
   `BOOK_CAPTION_SIZE_LADDER`, and a test asserts every spread of a
   twelve-spread fixture typesets at the standard size. No per-spread
   auto-sizing, ever.
3. **No rectangle is ever drawn.** The July always-on scrim
   (`shouldScrim` → rounded-rectangle layers in `drawCaptionOverlay`) is
   removed for this layout. Legibility comes from three deterministic
   layers, in order:
   - the calm column the render was asked for and measured against (§3.3)
     — this is the layer that did not exist in July, when the overlay
     went wherever the art director's zone said and the art under it was
     uncontrolled, which is why P4 ended up scrimming everything;
   - the glyph-outline halo (existing `drawGlyphOutlineRun`), tone picked
     from the sampled column luminance (existing `zoneBandStats` /
     `analyzeZoneBand` re-pointed at the column rectangle);
   - only when the sampled contrast is still below `OVERLAY.MIN_CONTRAST`
     (4.5:1): a **feathered radial vignette composited into the art
     pixels** with sharp before embedding (large radius, alpha capped at
     0.35, edge fully transparent — it reads as depth haze, the thing
     `TEXT_RULES.textIntegration` describes, not as a card). Its
     parameters are logged on the overlay report so the bench can show
     when it fired; a fired vignette on more than N spreads of a book is
     an advisory that the column hint is not being honoured.
4. **Paragraph gaps** are kept (the writer's manuscripts carry them; the
   painted path already preserved them via `wrapStoryLines`).

The `/v13/preview/embedded-overlay` endpoint (the admin pre-print preview
that already runs this exact code path) becomes the bench's print view
(§5).

### 3.5 What the model no longer has to do

Retired for the embedded layout: the TEXT RENDERING RULES block, the FONT
/ FONT SIZE / TEXT COLOR / ALIGNMENT / TEXT ZONE / INTEGRATION lines, the
pre-generate checklist items 10/10b, `verifyImageText` and its extra
retries, and the five painted-text QA fields with their repair notes
(`text_split_both_sides`, `text_on_band`, `text_in_center_gutter`,
`text_lines_misaligned`, `text_style_inconsistent`) — all of them stay in
the code for the painted path (§4) but never run for the default. Expect
a visible drop in per-spread cost and wall clock: no OCR call per render
attempt, no `TEXT_HEAVY_MAX_RETRIES`, no text-repair passes.

### 3.6 Failure codes and callbacks

- A column residual (`text column occupied` / `text column is a blank
  panel`) is BLOCKING and follows the ce-9 ship policy: candidates → repair
  → `consistency_unresolved` with the candidate list (or
  `CATALOG_SHIP_ON_EXHAUSTION=1`).
- The completion / probe callbacks add `typeset: [{spread, side, rect,
  lines, size, tone, vignetteAlpha, contrastRatio}]` — the deterministic
  numbers the PDF was built from — beside `qa`, and `storyContent`
  entries carry `textColumn` instead of `textEmbeddedInArt`.
- Stored books: an existing checkpoint with `textLayout: 'embedded'`
  re-dispatched after the deploy renders fresh under `ce-15` (the cache
  key changed) and typesets; nothing silently reuses painted pixels. The
  gift video already re-renders embedded keys text-free — with ce-15 the
  canonical embedded key IS text-free, so `video/stills.js` can use it
  directly (a small simplification, not required for the cutover).

---

## 4. The painted path (kill-switch `CATALOG_EMBEDDED_PAINTED=1`)

Kept for the bench's A/B and for any product decision to keep a
"hand-painted" text variant. Off by default. When on, `embedded` behaves
as ce-14 does today PLUS the measurements the round above showed were
missing. These are small, deterministic, and land in the same PR series:

1. **Size is measured, not requested.** `metrics.js` `textSizeMetric`:
   `pitchPct = text_bbox.h / lineCount` (line count from `wrapStoryLines`,
   the same call that built the prompt; paragraph gaps count as lines),
   `capPct ≈ pitchPct / 1.9`. Compared with the pinned target
   (`TEXT_RULES` 2.8% pitch / 1.5% cap, band-tier aware): more than 1.6×
   the target → BLOCKING `embedded story text too large` with a repair
   note that restates the measure; 1.25–1.6× → advisory. Shades candidate
   selection (`select.js` `WEIGHTS.textSize`) so the smaller candidate wins
   before any repair spends. A book-level check in the world gate
   (`text_size_inconsistent`: any spread's pitch more than 25% off the
   book median) re-renders the outliers against the median — the
   contact-sheet pattern applied to type.
2. **Panel detection is deterministic.** The §3.3 `flat` metric runs on
   the padded `text_bbox` with glyph pixels masked (ink-coloured and
   high-gradient pixels excluded) and backstops `text_on_band`; the QA
   prompt's definition widens to "a flat cream/beige/white plane, card,
   plaque, sign board, parchment, or wall-sized flat fill behind the
   words", and the render prompt's negative list names the same objects
   (the model paints a "sign" because a sign is an in-world excuse for a
   panel).
3. **A pixel reference for size.** The reference pack gains a
   **typography tile**: the exact serif at the exact cap height in the
   exact column, rendered deterministically (sharp + the bundled Playfair
   TTF) once per `STYLE_VERSION`/band tier and cached under
   `catalog-assets/type-tiles/{STYLE_VERSION}/{tier}.png`. The prompt says
   "paint the text at EXACTLY the size shown in REFERENCE N". Image models
   copy a visual reference far more reliably than a percentage — the ce-9
   lesson (fixed inputs become PIXELS) applied to type. If this alone
   fixes the bimodal size in the bench, it is the cheapest possible
   interim before §3 lands.

---

## 5. App side (giftmybook-standalone)

1. **Bench print view for embedded rounds.** The render card already has
   the half-layout "Art only / Print view" toggle (`HalfPrintPreview`,
   CSS-simulated from the worker's palette). For embedded rounds the
   worker supplies the composite itself: every probe/completion render
   carries `printPreviewUrl`, a PNG of the art with the typeset block
   composited by sharp from the SAME fontkit glyph outlines the PDF halo
   uses (`drawGlyphOutlineRun`'s paths emitted as SVG `<path>` elements —
   no system fonts, geometry identical to the PDF). The card's print view
   shows that PNG, and it is what the judge is given. Default the
   embedded card to the print view.
2. **Badge honesty.** `qa.pass=false` with `unresolved` entries renders as
   a red "QA unresolved" badge listing the blocking defects, distinct from
   the amber advisories badge — the spread-10 case must never look like
   a soft finding again. (Two-line change in the render card.)
3. **Judge rubric v3.** `typography`: "For embedded rounds, judge the
   PRINT VIEW: the typeset block sits inside its column over continuous
   scenery, legible without a panel; score the ART for a calm, text-free
   column. Painted words anywhere in the art score 1." `composition`
   already asks for "a calm low-detail zone usable for type"; point it at
   the assigned column. `world_consistency` drops the "identical font,
   size, color" clause (now true by construction).
4. **Book page.** `AdminChildrenBookDetails` shows `typeset[]` and the
   vignette advisories; the customer-facing spread preview
   (`ChildrenBook.jsx`) uses the worker's preview URLs, which for
   embedded books must be the composited print pages, not the raw art —
   `previewImageUrls` for this layout point at the same sharp-composited
   PNGs as `printPreviewUrl` (the worker has no PDF rasterizer, and none
   is needed: the composite is built from the art plus glyph outlines) so
   the customer sees the words.
5. **Proposals routing.** Any queued `layout`-kind proposal about font
   size or text panels is dispositioned against this plan rather than
   re-attempted as a prompt directive (`docs/AI_ILLUSTRATION_FEEDBACK_LOOP_PLAN.md`
   §6.3 already routes `layout` to the layout engine).

---

## 6. Rollout

| Phase | Scope | Gate to next |
|---|---|---|
| 0 | `textColumn.js` + tests; `EMBEDDED_TYPE`; the typeset overlay rewrite in `layoutEngine.js` (no scrim, column placement, fixed size) with a fixture PDF test; `/v13/preview/embedded-overlay` produces it | Preview PDF reviewed on two age-band extremes: one size on every spread, no rectangle anywhere |
| 1 | Worker: text-free embedded render + TEXT COLUMN hint + `wide-column` cache aspect + `STYLE_VERSION ce-15`; QA column fields + calmness metric + `QA_VERSION qa-7`; callbacks carry `typeset[]`; painted path behind `CATALOG_EMBEDDED_PAINTED=1` | Bench round of 12 spreads: zero painted words, column residuals ≤ 1 per book, vignette fires on ≤ 3 spreads |
| 2 | App: embedded print view, unresolved badge, rubric v3, customer preview pages | Judge typography ≥ 4 on the print view across a 12-spread round |
| 3 | Painted-path hardening (§4) for the A/B; size + panel metrics on both paths | A/B: painted vs typeset on the same story/anchor — decide whether the painted variant stays selectable at all |

Every phase is a separate PR with its own tests; none requires a
`catalog.json` or writer change. Kill-switches: `CATALOG_EMBEDDED_PAINTED`
(default `0`), `CATALOG_COLUMN_QA=0` (skip the column checks and metric —
the render still gets the hint), `CATALOG_TEXT_VIGNETTE=0` (halo only).

---

## 7. What this does NOT change

- Caption and half layouts (already deterministic type).
- The catalog, the writer, `wrapStoryLines` (reused as the typesetter's
  line breaker), the identity kit, the shot plan (its `textSide` is now
  consumed by two places instead of one), the world plate, the set gates.
- The upsell spread and the wrap cover.

---

## 8. Acceptance (the owner's two complaints, as tests)

1. **Font size:** a Jest fixture assembles a twelve-spread embedded book
   and asserts every spread's typeset `size === EMBEDDED_TYPE.size` and
   every block's rectangle lies inside its column and outside the gutter.
   There is no code path that can pick a different size per spread.
2. **No panel:** `drawCaptionOverlay` for the embedded layout has no
   `drawRectangle` call (unit test on the pdf-lib operator stream of a
   fixture page); the vignette compositor's alpha map is asserted to be
   radially feathered with zero alpha at its boundary; and on the render
   side `text column is a blank panel` is BLOCKING with the deterministic
   `flat` backstop covered by a synthetic-image test (a beige rectangle in
   the column trips it; a sky gradient does not).
