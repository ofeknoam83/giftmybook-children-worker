# Print proof checklist (pq-1 Phase 5.2)

Any `STYLE_VERSION`, SKU, paper, laminate or layout change ships only after one
printed proof per binding (paperback perfect bound + hardcover casewrap) passes
every line below. Order the proofs through the normal Lulu path so the file
Lulu prints is the file the pipeline built (`preflight` on the callback names
the product and canvas; `generationProgress.luluValidation` on the book is
Lulu's own verdict).

Photograph each item beside the screen render of the same spread.

## Interior

- [ ] **Crop band.** Nothing the story needs is lost in the top/bottom 7 % of a
      wide render: every head and foot, the companion, every named object.
- [ ] **Fold.** No face, companion or named object is cut by the fold; the
      gutter swallows only background.
- [ ] **Trim.** Nothing important within 0.5 in of any page edge; no white
      sliver at any edge (bleed present on all four sides).
- [ ] **Sharpness at 30 cm.** No visible pixelation or softness in faces,
      hands, and painted or typeset text. (`preflight.minPpi` ≥ 234 on the
      callback; Lulu recommends 300.)
- [ ] **Text size.** Page text reads at ≥ 14 pt equivalent on the page;
      painted (embedded) text matches the drawn template (no restyle).
- [ ] **Ink.** Painted text is the one cocoa ink on every spread; typeset
      pages match it.
- [ ] **Page order.** Page 1 is a right-hand page; every spread's two halves
      face each other; the upsell spread opens on a left-hand page.
- [ ] **Colour vs screen.** Skin tones, sky and foliage read naturally; note
      any spread that prints visibly duller (the preflight's saturation
      warning) or darker (night / underwater) — these feed Phase 4's tone
      curve and the Standard-vs-Premium decision.

## Cover

- [ ] **Wrap band (hardcover).** The outer 0.875 in is continuous artwork to
      the board edge — no blurred or streaked band, no seam at the trim line
      (`preflight.coverWrap.front === 'outpaint'`).
- [ ] **Front sharpness.** The approved cover prints sharp (`preflight.coverPpi`
      ≥ 234).
- [ ] **Spine.** The colour band matches the cover; nothing important within
      0.75 in (hardcover) / 0.625 in (paperback) of any edge.
- [ ] **Back cover.** Blurb and codes legible; the QR scans.
- [ ] **Laminate.** Gloss vs matte judged in daylight and under a lamp.

## Sign-off

| Field | Value |
|---|---|
| Book ids (paperback / hardcover) | |
| `STYLE_VERSION` / `QA_VERSION` | |
| SKUs printed | |
| Proof date | |
| Reviewed by | |
| Decisions taken (tone curve, colour tier, laminate) | |
