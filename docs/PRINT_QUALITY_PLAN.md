# Print Quality — the printed picture book (plan, pq-1)

> **Status:** IMPLEMENTED on this branch (2026-09-09) — the code phases below
> are in, every one behind a kill-switch and fail-open, with NO
> `STYLE_VERSION` bump: a book rendered before pq-1 replays its own pixels
> (Phase 1's legacy-key fallback) and only fresh renders take the new
> tiers and prompt lines. Worker: `flags.js` (`printImageSize*`,
> `minPrintRenderHeight`, `coverImageSize`, `printPpiFloor`,
> `foldSafetyEnabled`, `printPreviewsEnabled`, `coverOutpaint*`),
> `illustrator/index.js` (per-layout tier + `-is{tier}` fold + legacy-key
> replay list), `illustrator/printPreview.js`, `illustrator/metrics.js`
> (fold + cast safe-zone rules), `illustrationGenerator.js` (the print
> safety lines; 2K cost label), `coverGenerator.js` (cover tier,
> `extendWithOutpaint`, sRGB), `layoutEngine.js` (`pageReport`, sRGB, the
> shadow-lift knob, the gamut measure), `luluSpec.js` (PPI + gamut in the
> preflight), `pipeline.js` (all of it on the callback as `preflight` /
> `printPreviewUrls`). App: `services/luluPreflight.js` (Lulu's own
> validation before every bulk send — the one path that sends children's
> books to Lulu; auto-send and the chat-book resend never carry them),
> `routes/children.js`
> (persists `preflight`, `renderSizes`, `printPreviewUrls`), the
> print-readiness card on the admin book page. NOT done, by design: the
> proofs (Phase 0.2, `docs/PRINT_PROOF_CHECKLIST.md`), the tone curve VALUE
> (the knob ships OFF), Premium colour / matte (SKU decisions), the barcode
> decision, half-at-1:1 (2.3) and the cover bbox check (2.5).
> Earlier: Phase G (the Lulu geometry spec + build-time preflight) —
> `giftmybook-children-worker#355` / `giftmybook-standalone#515`.
> **Scope:** `giftmybook-children-worker` (rendering, layout, cover, preflight) +
> `giftmybook-standalone` (SKUs, order-time validation, admin preview).
> **Siblings:** `services/luluSpec.js` (the numbers every phase measures against),
> `docs/audits/2026-07-18-amit-astro-maze-print-audit.md` (the fold-straddling and
> cover-smear findings this plan closes), `docs/COLORING_BOOK_V2_PLAN.md` (whose
> `preflightLulu` + `pageReport` pattern Phase 1.3 copies).

**Trigger.** A parent orders the 8.5 × 8.5 in picture book (paperback perfect bound or
hardcover casewrap). The PDFs are already built to Lulu's geometry. This plan is about
what the reader *sees*: sharp pictures, nothing important cut by the trim or the fold, a
cover whose wrap is real art, colour that survives paper, and a preview that shows the
book that will actually arrive.

## 1. What "perfect" means (acceptance)

1. **Sharp.** Every printed page image is at least 234 dpi effective (the 4K embedded
   pages today), target 300 — *measured by the preflight*, never assumed.
2. **Nothing lost.** No face, companion, declared prop or story text sits in the band the
   square-page fit + trim removes (the top and bottom 6.8 % of a wide render), in the outer
   0.7 in, or across the fold.
3. **What you approve is what prints.** The admin, the Art Bench and the customer flipbook
   show the print crop with the fold, not the raw 16:9 render.
4. **A real wrap.** The cover's bleed/wrap band is continuous artwork to the board edge —
   no copy-and-blur smear.
5. **Predictable colour.** Every page carries an sRGB profile, dark scenes are proof-tuned
   for coated stock, and the colour tier (Standard vs Premium) is chosen on a printed proof.
6. **Verified twice.** The worker's preflight at build time, Lulu's own validation at
   order time, and a physical proof before any version change ships.

## 2. Where we are (measured 2026-09-09)

| Area | Today | Gap |
|---|---|---|
| Geometry (trim, bleed, safety, gutter, spine, page order) | In spec; `preflightPictureBook` gates both PDFs | none (Phase G, done) |
| Resolution — `embedded` layout | 4K requested (template path) → ≈ 234 dpi | fine |
| Resolution — `half` layout | no size requested → model default 1K across a 17.5 in spread → ≈ 59 dpi | **critical** |
| Resolution — `caption` layout | no size requested → 1K on the 8.75 in page → ≈ 117 dpi | **critical** |
| Resolution — front cover | `generateFrontCoverImage` requests no size → 1K on 8.5 in → ≈ 120 dpi | **critical** (it is the first thing a parent sees) |
| Resolution — back cover / upsell cards | 2K (≈ 241 dpi) / 1K on a 3.4 in card (≈ 300 dpi) | fine |
| Composition — the child | shot plan pins a third; `SAFE_ZONE` x 4 % / y 7.5 % on the child bbox | fine |
| Composition — companion, props, faces | no fold rule, no crop-band rule (the July audit's rocket on the fold) | gap |
| Preview | `previewImageUrls` are the raw 16:9 renders | gap |
| Cover wrap | outer 0.125 in / 0.875 in is `extendWithSoftWrap` copy + blur (streaks, audit C4) | gap |
| Colour | untagged sRGB JPEG; Standard colour SKU (`FCSTD`); gloss laminate (`GXX`) | decide on proofs |
| Order-time validation | none — Lulu's `printable_normalization` is the first check | gap |

The 16:9 → spread arithmetic, for reference: the render is scaled to the 5250 px spread
width (2 × 8.75 in at 300 dpi) and centre-cropped from 2953 px to 2625 px, so 5.6 % of the
height goes at the top and bottom; the 0.125 in trim takes another 1.3 % each; the
middle 86.3 % prints, full width. The fold sits at x = 50 % with ≈ 0.2 in of gutter each side.

## 3. Phases

Order matters: Phase 0's numbers set Phase 1's size tier and Phase 4's tone curve.

### Phase 0 — Measure first (½ day + proof turnaround)

- **0.1 Read the callbacks.** `renderSizes` has ridden every completion callback since
  2026-09-07. Pull the last few weeks per layout and confirm the 1K default for `half`
  and `caption`, and how often the 4K request fell back (`imageSize` 400 → retry
  without it) on the current image model.
- **0.2 Order proofs.** One book per binding for the two live layouts (embedded hardcover,
  caption paperback at minimum; half if it is still sold). Photograph the fold, the
  page edges, the text size and the colour beside the screen.
- **Output:** the pixel sizes actually shipping, and a physical baseline to compare every
  later phase against.

### Phase 1 — Resolution (S–M; the biggest visible win)

- **1.1 One print size per layout.** `illustrator/index.js` gates `imageSize` on
  `embedText` only. Replace it with a per-layout print tier: `embedded` 4K (unchanged),
  `half` 4K (its right half alone is a printed page), `caption` 2K minimum (2048 px on
  8.75 in ≈ 234 dpi; 4K downsamples to a sharper 300). Fold the tier into the render key
  (the `-is{size}` fold already exists) so a 1K render never replays into a new book,
  apply `minRenderHeight` to every layout, keep `renderSizes` on the callback.
- **1.2 The cover.** `generateFrontCoverImage` and the harmonize path request 2K or 4K
  1:1 (2048 px on 8.5 in ≈ 241 dpi; 4K ≈ 480). Confirm the app's cover *options* — the
  ones parents approve — come through this path (`/v13/generate-cover-image`) and inherit it.
- **1.3 Measure it in the preflight.** `layoutEngine` records each page image's pixel
  size; `preflightPictureBook` reports effective PPI per page (px ÷ page inches):
  **error** below 150, **warning** below 234, exactly the coloring book's `pageReport`
  pattern. The pipeline treats the error like any preflight error.
- **1.4 Cost.** Larger output tiers cost more per image on the flash-image model
  (`CostTracker` already carries a `:4K` rate). Only fresh renders pay; finished books
  replay their cache. Expect roughly 1.5–3× per spread render.
- **Acceptance:** preflight PPI ≥ 234 on every page of a fresh book; the proof reads
  sharp at reading distance; no `undersized` advisory on a fresh run.

### Phase 2 — Compose for the physical page (M)

- **2.1 Fold safety for subjects.** The child is already pinned to a third. Add one scene
  rule: *no face, companion or declared prop within the central 8 % band (x 46–54 %); the
  fold may cross continuous background only.* Enforce it deterministically from the boxes
  QA already returns (`bbox`, `companionBox`, `propBoxes`) → advisory `subject_on_fold`
  with a fixed repair note; `select.js` shades it. Bump `QA_VERSION`.
- **2.2 Crop-band safety.** Today `SAFE_ZONE` (y 7.5–92.5 %) guards the child bbox only.
  Extend it to the companion and prop boxes and state the print reality in the prompt:
  *the top and bottom 7 % of this frame are cut by the page — every character's head and
  feet inside the middle 85 %.*
- **2.3 Half layout at 1:1 (decide).** Half prints only the art's right half; the left
  half is discarded under the text panel. Rendering that layout at 1:1 doubles pixels
  per printed inch for free and lets the composition use the whole frame. Trade-off: the
  gift video's text-free trio reuses the `wide-plain` renders — keep wide for those or
  accept a re-render. Only worth doing if `half` stays a sold layout.
- **2.4 Print-crop preview.** The worker emits `printPreviewUrls` beside
  `previewImageUrls`: the 2:1 crop with thin trim, fold and safety guides. The admin
  book page and the Art Bench show the print crop by default (guides on); the customer
  flipbook shows the crop without guides. Approval happens on what prints.
- **2.5 Cover safety check.** The cover prompt's safe zone (12 % / 8 % sides, 26 % / 36 %
  vertical) is generous; add the deterministic half — the child bbox against the 0.75 in
  casewrap safety — as an advisory on the cover QA.

### Phase 3 — The cover wrap (M)

- **3.1 Outpaint the band.** Replace copy + blur with ONE bounded Gemini edit that extends
  the approved cover outward by the wrap band (0.875 in hardcover, 0.125 in paperback) at
  4K, then paste the ORIGINAL pixels back over the trim area so the approved art never
  changes. QA: the band is continuous scenery with no text; fail-open to copy + blur with
  an advisory.
- **3.2 Spine.** Keep the dominant-colour band (Lulu: no spine text under 80 pages).
  Revisit a small motif only if the proof reads the flat band as dull.
- **3.3 Back-cover barcode.** The Code128 encodes the internal book id; a parent who
  scans it gets nothing. Keep it only if fulfilment scans it; otherwise drop it and keep
  the QR, which is a real URL.
- **3.4 Finish.** `GXX` (gloss laminate) vs `MXX` (matte): matte hides fingerprints and
  reads as a premium picture book, gloss pops colour. Decide on the Phase 0 proofs.

### Phase 4 — Colour and paper (S–M; proof-driven)

- **4.1 Tag the pixels.** Embed an sRGB ICC profile in every page JPEG and the cover
  (`sharp().withMetadata({ icc })`) so Lulu's CMYK conversion starts from a declared
  source. Today the JPEGs are untagged.
- **4.2 Print tone.** Night and underwater scenes print darker than they display (dot gain
  on coated stock). After the proof, add a print-only shadow lift in
  `encodeFullBleedJpeg` (order of +4–6 % below 20 % luminance) behind a flag; never
  applied to previews.
- **4.3 Gamut advisory.** Per page, the share of pixels above 0.9 saturation → an
  advisory "expect duller print" past a threshold; steer the art tuning's palette words,
  not the pixels.
- **4.4 Premium colour.** `FCSTD` → `FCPRE` on both SKUs is the single biggest
  paper-side lever for full-bleed art. Confirm the exact premium SKUs through Lulu's
  cost calculation before switching; decide the price delta on a Standard-vs-Premium
  proof pair.

### Phase 5 — Verify with Lulu, every time (S)

- **5.1 Order-time validation (app).** Before any children's print job (today the
  admin bulk sends are the one path; auto-send and the chat-book resend never carry
  children's books) call Lulu's `validate-interior` + `validate-cover` (at minimum
  `print-job-cover-dimensions`) and persist the verdict on the book; block the send on
  `ERROR` with Lulu's message. The worker's preflight is the build-time guard; Lulu's is
  the order-time truth.
- **5.2 Proof protocol.** Any `STYLE_VERSION`, SKU, paper or layout change ships only
  after one proof per binding passes a fixed checklist: crop band, fold, page text ≥ 14 pt,
  ink colour, sharpness at 30 cm, wrap continuity, spine colour, colour vs screen.
- **5.3 Print-readiness panel (app).** Keep `preflight` and `renderSizes` on the book
  record and show them on the admin book page: PPI per page, product + canvas, fonts,
  Lulu validation status.

## 4. Order and effort

| Step | Phase | Effort | Why now |
|---|---|---|---|
| 1 | 0.1 + 1.1–1.4 (resolution), with 0.2 proofs ordered in parallel | 1–2 days | biggest visible change; everything else is judged on sharp proofs |
| 2 | 2.1, 2.2, 2.4 (fold, crop band, print-crop preview) | 2–3 days | the July audit's open findings; approval on what prints |
| 3 | 5.1 (Lulu validation at order time) | 1 day | closes the last unverified step before money is spent |
| 4 | 3.1 (wrap outpaint), 3.3 / 3.4 decisions | 2 days | hardcover is the premium product; the wrap band is visible on every copy |
| 5 | 4.1–4.4 after the proofs | 1–2 days | colour decisions need paper in hand |
| 6 | 2.3 (half at 1:1) | 1 day | only if `half` remains sold |

## 5. Risks and trade-offs

- **Render cost** rises with the output tier; the cache re-key means only fresh books pay.
- **Model support**: a model that rejects `imageSize` falls back to its default — Phase 1.3's
  PPI error is what keeps that fallback from shipping silently.
- **Half at 1:1** touches the gift video's text-free source renders.
- **Outpainting** can drift the style at the band; it is verified and fails open to today's
  copy + blur, and the trim area is always the approved pixels.
- **Premium colour and matte** change unit cost; both are proof decisions, not code.
