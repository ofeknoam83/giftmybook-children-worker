# Embedded text — typeset by REFERENCE: the text plate, a ruler, and a flatness meter (plan, ce-15)

> **Status: PLAN** (2026-09-03). Nothing in this document is implemented yet.
> **Owner decision:** the story text stays PAINTED into the art by the image
> model. A text-free render with PDF-typeset words was proposed first and
> rejected (§8). This plan keeps painted text and makes its size and its
> backdrop pixel-referenced and pixel-verified, the way ce-9 made identity
> and props pixel-referenced (a sheet in the pack, a check against it).

**Trigger.** An Art Bench round (Build-It Yard, `embedded` layout, twelve
spreads, rendered under `ce-13`/`ce-14`) shows two recurring defects:

1. **The painted font size varies wildly between spreads.** Spreads 1, 2,
   4, 8 and 12 came out at the intended small body size; spreads 3, 6, 7,
   9, 10 and 11 at caption/poster scale — two to three times larger, on the
   same book, under the same pinned `TEXT_RULES` spec.
2. **Spread 10 painted its text on a solid beige panel** covering the whole
   right half of the image — the `text_on_band` defect ce-11 made
   BLOCKING — and the bench still shows it with a "QA advisories" badge.

The ask: fix both **in a general way**, with the text still painted.

---

## 1. Diagnosis — what the painted path is missing

### 1.1 Size is an instruction to a model that cannot measure

Every lever on the painted size is prose: `TEXT_RULES.fontSize` ("cap
height about 1.5% of the image height … when unsure, go SMALLER"), the
renderer's FONT SIZE line, ce-13's pre-wrapped lines and column box, the
ce-14 shrink. Four style versions tightened that prose and the round still
came out bimodal: the model either "gets" small body type or falls back to
the caption scale it was trained on. A percentage is not something a
diffusion model perceives. **A reference image is.** The pipeline already
knows this: identity is a character sheet in the pack, not a paragraph;
props are prop sheets; the world is a plate. Type is the one fixed input
that still rides as words only.

And nothing measures the result:

- `text_style_inconsistent` is intra-block (mixed sizes inside ONE block),
  never "the whole block is twice too large".
- The world gate's `text_treatment` is a lenient cross-spread advisory.
- The v2 verdict returns `text_bbox`, used only for the fold-straddle
  backstop. Its height divided by the known line count (`wrapStoryLines`
  fixes the line count before the render) is the font size — the number is
  on the table and nobody reads it.
- The app judge's "ONE modest size" has no reference for "modest".

### 1.2 The panel is the model's answer to the legibility we demand

Small, crisp, high-contrast text over a busy 3D construction site is
cheapest to satisfy with a flat plane behind the words — a board, a cream
wall, a parchment. Spread 10 is that. The defences are all rejections: a
judge boolean prompted as "blank, solid, or lightened band/strip/panel
(letterbox)" (a warm beige plane that reads as "a wall" can pass it), the
ce-11 blocking class, then candidates and repair passes that ask the same
model for the same legibility with the same words. When every candidate
carries a panel the probe reports `qa.pass=false` + `unresolved[]`, and the
bench card renders that with the same amber badge as a soft finding
(`render.qa.pass ? 'QA pass' : 'QA advisories'`).

Two things are missing here too: an **example** of the right answer (the
model has never been shown "letters over open scenery, no card") and a
**meter** that reads the backdrop's flatness from the pixels instead of
asking a yes/no.

### 1.3 Every text repair today is a full re-roll

A text defect (size, band, fold, garbled) is repaired by re-rendering the
whole spread: identity, outfit, props, composition and emotion all roll
again, and the repair budget is shared with drift defects. Two repairs of
a text problem can therefore introduce a hair or outfit break on a spread
whose scene had already passed.

---

## 2. The idea in one paragraph

**Typeset by reference.** Everything about the text is known before the
render — the words, the line breaks (`wrapStoryLines`), the column (the
shot plan's `textSide` + `TEXT_RULES` geometry), the typeface, the size. So
we DRAW it, deterministically, with the bundled serif, as a **TEXT PLATE**
in the render's own 16:9 frame, and hand it to the model as the last
reference: *paint exactly this, exactly this big, exactly here, over your
artwork.* The same plate is the ground truth for verification: the judge
sees the plate beside the render and answers RELATIVE questions (larger /
same / smaller; same position; letters over scenery like the plate, or on
a panel) — relative judgments against a reference are what vision models
are reliable at — and a deterministic **ruler** compares the painted
block's bbox with the plate's known bbox while a **flatness meter** reads
the backdrop's pixels. The plate's backdrop is a blurred copy of the
theme's world plate, so the example the model copies is *letters over
continuous scenery*, never letters on a card. Text repairs become
**edits** of the verified render instead of re-rolls. Numbers, not
adjectives, drive selection, repair and a book-level size gate.

---

## 3. Mechanisms

### 3.1 The text plate (`illustrator/textPlate.js`)

- **Inputs:** the spread's manuscript text, the shot plan's `textSide`,
  the age tier (`resolvePictureBookTextRules`: under 3 / 3–8 / over 8),
  the theme's world plate bytes (optional), `STYLE_VERSION`.
- **Output:** a 1536×864 PNG (the render's aspect; every measure is a
  FRACTION of the frame, so the render's pixel size is irrelevant) plus a
  spec: `{lines, side, bbox:{x,y,w,h}, capHeightFrac, pitchFrac, font,
  hash}`.
- **Drawing:** sharp + fontkit glyph outlines of `fonts/PlayfairDisplay.ttf`
  (regular) emitted as SVG `<path>` elements — the `drawGlyphOutlineRun`
  technique already in `layoutEngine.js`; no system fonts, byte-stable
  output. Warm-ivory fill with a soft dark shadow (the `TEXT_RULES.
  fontColor` treatment). Left-aligned at `edgePaddingPercent`, first
  baseline at `topPaddingPercent` + cap height, line pitch 2.8% of the
  height (tier 3–8: 2.6%), cap height 1.5% (tier 3–8: 1.3%). The em size is
  derived from the TTF's own `capHeight` so a font swap keeps the geometry.
  Paragraph gaps are one empty pitch. The block always fits the column
  because `maxCharsPerLine` and the size are chosen together (a test
  asserts the widest possible 30-character line fits the 28% column).
- **Backdrop:** the theme's world plate, Gaussian-blurred (σ ≈ 12),
  desaturated ~40%, darkened ~15% — continuous scenery with no edges. With
  no world plate: a soft vertical sky gradient. Never a flat fill: a grey
  card would TEACH the panel.
- **Cache:** `catalog-assets/text-plates/{STYLE_VERSION}/{hash}.png` +
  `.json`, hash = sha256(text | side | tier | font | worldPlateHash |
  PLATE_VERSION). Create-if-absent; fail-open — a plate failure renders on
  today's prose-only path with a stage `textPlate` advisory (the world
  plate's contract). Cost: zero model calls, ~50 ms of sharp.

### 3.2 Prompt: the plate replaces the prose ruler

- **Reference pack** (`bible/index.js` `buildReferencePack`): a new LAST
  entry after the world plate, `kind: 'textPlate'`, `refs.textPlateRef`:

  ```
  TEXT PLATE — the story text EXACTLY as it must appear in this image:
  these words, these line breaks, this typeface, this SIZE relative to
  the frame (never larger), and this POSITION. Paint ONLY the letters
  (with their soft shadow) over your own artwork; the plate's blurred
  backdrop is NOT part of the scene and must not be painted — the
  scenery of this illustration continues behind the letters.
  ```

- **Renderer** (`illustrationGenerator.js` TEXT RENDERING RULES): the
  FONT / FONT SIZE / ALIGNMENT / TEXT ZONE lines collapse into one
  "match REFERENCE N (the TEXT PLATE) — same typeface, same size, same
  position, same line breaks; if in doubt, smaller than the plate, never
  larger" line plus the page-fold wall sentence (kept verbatim). The
  pre-wrapped lines still ride as text (the model reads words from text
  more reliably than from pixels). TEXT INTEGRATION widens its negatives:
  "no card, plaque, sign board, parchment, scroll, banner, board,
  wall-sized flat fill, letterbox band, or lightened/darkened plane behind
  the words — the plate shows letters over open scenery; do the same".
  The pre-generate checklist item 10 cites the plate index. No numeric
  size prose remains (asserted by a test).
- **Scene hint** (`renderSpread`, beside the half-layout hint): a TEXT
  COLUMN line — "the story text is painted over the {SIDE} column (x …,
  y …); keep that column continuous CALM scenery (sky, water, a plain
  wall, soft foliage, depth haze) with no faces, props, signage or busy
  detail, so the letters are legible WITHOUT any panel". The half layout's
  identical technique already keeps its left half calm in production. It
  rides `safeFallbackSuffix` so the generic-safe rung keeps it.
- **Repair notes** (`repairNoteV2`) cite pinned numbers and the plate:
  "the text was painted {ratio}× larger than REFERENCE k (the TEXT PLATE);
  repaint it EXACTLY the plate's size and position" / "REFERENCE k shows
  the letters over open scenery — remove the panel behind the words; the
  artwork continues behind the letters".

### 3.3 Verification: the judge gets the plate; the ruler gets numbers

- **QA v2** (`spreadQa.js` `checkSpreadRenderV2`) attaches the plate as a
  numbered image beside the render, like the sheets. New required fields
  when `expectedText` rides:
  - `text_size_vs_plate: "larger" | "same" | "smaller"`;
  - `text_position_matches_plate: true | false`;
  - `text_on_band` redefined against the plate: "a flat, blank, solid,
    lightened or darkened plane — card, board, parchment, panel,
    wall-sized fill, letterbox band — behind the words, where the plate
    shows open scenery".
  `text_bbox` stays (soft) and is what the ruler reads.
- **Defects** (fixed strings): `embedded story text larger than the text
  plate` → BLOCKING; `embedded story text off its plate position` →
  advisory (the fold check stays the blocking placement gate); band stays
  BLOCKING.
- **Ruler** (`metrics.js` `textPlateRuler`): `sizeRatio = max(bbox.h /
  plate.bbox.h, bbox.w / plate.bbox.w)` (height catches a bigger face;
  width catches re-broken longer lines). `≥ 1.35` adds the blocking
  "larger" defect whatever the judge said — the fold-straddle pattern;
  `1.15–1.35` → advisory `embedded story text slightly larger than the
  plate`. `positionOffset` = centre distance in frame fractions.
- **Flatness meter** (`metrics.js` `textBackdropFlatness`): the padded
  bbox region at render resolution; glyph pixels masked (ivory-band
  luminance OR local gradient above a threshold, dilated 2 px); on the
  rest, `flatFrac` = share within ΔE ≤ 6 of the modal colour, plus
  `edgeFrac`. `flatFrac ≥ 0.8` → deterministic backstop for `text_on_band`
  (BLOCKING). A synthetic-image test: a beige rectangle behind masked text
  trips it, a sky gradient does not.
- **Column calmness** (same crop, no mask, before the text region is
  considered): `columnBusy` advisory that shades selection.
- All three ride the `.qa.json` marker and the callbacks as
  `qa.textMetrics` (`{sizeRatio, positionOffset, flatFrac, edgeFrac,
  columnBusy, plateHash}`) so the bench shows numbers, not adjectives.

### 3.4 Selection and repair use the numbers

- `select.js` `WEIGHTS`: `textSizeExcess: -40 × max(0, sizeRatio − 1)` (a
  1.3× block loses 12 points to a 1.0× one), `backdropFlat: -30`,
  `columnBusy: -8`. Blocking defects still sink below zero.
- The repair loop keeps its budgets; a repair candidate is scored on the
  same numbers, so a smaller-but-not-yet-passing repair replaces a larger
  one — each pass makes progress instead of re-flipping a coin.

### 3.5 Text repairs are EDITS, not re-renders

For a residual that is text-class ONLY (size, band, fold, garbled,
misaligned — the scene otherwise clean), the repair pass sends the best
candidate as a **SOURCE IMAGE** plus the plate through the same
`generateContent` client (`callGeminiImageApi` already attaches labeled
image parts): "edit this image: repaint ONLY the story text to match the
TEXT PLATE — same size, same position, same words; remove any panel behind
it; change NOTHING else — the child, outfit, props, scene and lighting stay
pixel-identical". The full QA runs on the result (identity, outfit, props
must still pass) and the existing adopt-only-a-higher-score rule discards
an edit that drifted. Budget `CATALOG_TEXT_EDIT_REPAIRS` (default 2,
counted inside the general repair budget); kill-switch
`CATALOG_TEXT_EDIT_REPAIR=0` falls back to full re-renders. Each edit keeps
the verified scene and touches only the text layer — the drift-per-repair
cost of §1.3 goes away.

### 3.6 Book-level size gate (deterministic, no model call)

After the per-spread phase, the median `sizeRatio` across the book's
rendered spreads is computed from the markers; any FRESH spread more than
25% off the median (or above 1.35 absolute) is flagged `text_size_outlier`
and repaired once through `applySetRepairs` — as an edit (§3.5) when
enabled, else a re-render — with the plate-citing note, capped at
`CATALOG_TEXT_QA_MAX_RERENDERS` (default 3). Replayed cached renders are
references only, exactly as in the world gate. The world gate's
`text_treatment` keeps judging band-vs-artwork and typeface family across
spreads.

### 3.7 Resolution

`callGeminiImageApi` sends `imageConfig: { aspectRatio }` only. Gemini 3
image models accept `imageConfig.imageSize` (`'1K' | '2K' | '4K'`). If
`gemini-3.1-flash-image` accepts it (bench probe; a 400 retries once
without it, the seed's pattern), embedded renders request `2K`: doubling
the pixels per glyph is the largest legibility gain painted body type can
get at print size (a 1.5% cap height is ~13 px at 864 px tall and ~26 px at
2K), and it sharpens OCR and the judge. Env `CATALOG_EMBEDDED_IMAGE_SIZE`
(default `2K`; `1K` restores). Contact-sheet tiling cost on 2K sources to
be checked in the same probe.

### 3.8 Versions and cache

`STYLE_VERSION` → `ce-15` (prompt assembly and the reference pack changed;
ce-14 renders must never replay), `QA_VERSION` → `qa-7` (new fields and
metrics; older markers re-check), `PLATE_VERSION` = 1 inside
`textPlate.js`. No new cache-key fold: the plate is a pure function of
inputs already in the key (the story text through `storyHash`, the side
through the story-seeded shot plan, the tier through the book's band); its
hash rides the marker for audit. Kill-switch `CATALOG_TEXT_PLATE=0`
restores the ce-14 prose path with a `-tp0` fold so plated and plate-less
renders never replay each other.

---

## 4. App side (giftmybook-standalone)

1. **Badge honesty.** `qa.pass=false` with `unresolved` entries renders a
   red "QA unresolved" badge listing the blocking defects, distinct from
   the amber advisories badge — the spread-10 case must never look like a
   soft finding again.
2. **Numbers on the card.** `sizeRatio`, `flatFrac` and a thumbnail of the
   plate (`textPlateUrl` on the callback) beside each render.
3. **Judge rubric v3.** The typography trait is judged WITH the plate
   attached: "compare the painted block to the TEXT PLATE — same size,
   same position, same typeface; letters over open scenery, never a
   panel; painted words anywhere else score 1". `world_consistency` keeps
   its cross-spread typography clause.

---

## 5. Rollout

| Phase | Scope | Gate to next |
|---|---|---|
| 0 | `textPlate.js` + tests (geometry from `TEXT_RULES` via the TTF `capHeight`, deterministic hash, blurred world-plate backdrop, gradient fallback, 30-char line fits the column) | Plates for the three tiers reviewed visually |
| 1 | Pack entry + prompt collapse + scene hint + `ce-15`; QA fields + ruler + flatness + `qa-7`; selection weights; plate-citing repair notes; `qa.textMetrics` on callbacks | Bench round of 12 spreads: `sizeRatio` within 0.8–1.2 on ≥ 11 spreads, zero flat backdrops |
| 2 | Edit repairs (§3.5), the book-level size gate (§3.6), the 2K probe (§3.7) | Text-class residuals = 0 on three rounds across age bands |
| 3 | App: badge, numbers, plate in the judge | Judge typography ≥ 4 on the rounds above |

Each phase is one PR with tests; none touches `catalog.json` or the
writer.

---

## 6. Acceptance (the two complaints as tests)

1. **Size:** a verdict whose `text_bbox` is 2× the plate's height fails
   BLOCKING regardless of the judge's field; candidates at ratio 1.0 and
   1.3 pick 1.0; a twelve-spread set with one 1.5× outlier flags exactly
   that spread; the assembled render prompt contains no numeric size
   prose and cites the plate's reference index.
2. **Panel:** a synthetic render with a flat beige rectangle behind masked
   glyphs trips `flatFrac ≥ 0.8` and the blocking band defect; a sky
   gradient does not; the QA prompt attaches the plate and asks the
   relative questions; the plate builder never emits a flat backdrop (a
   test asserts backdrop variance above a floor).

---

## 7. What this does NOT change

Caption and half layouts; the catalog, the writer, `wrapStoryLines` (now
also the plate's line breaker); the identity kit, the shot plan (its
`textSide` gains a second consumer), the world plate and gates; the upsell
spread and the wrap cover; the gift video (it still re-renders embedded
keys text-free for animation).

---

## 8. Considered and rejected: text-free art + PDF typesetting

The first draft of this plan moved the words out of the pixels (render a
text-free calm column, typeset in `layoutEngine.js`). It guarantees one
size by construction and makes a panel impossible, but the owner wants the
text painted into the art. Everything above keeps that: the model paints,
and we (a) show it exactly what to paint, (b) measure what it painted,
(c) fix only the text when it is wrong.
