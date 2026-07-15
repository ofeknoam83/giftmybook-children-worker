# Phase C — Native Illustrator Validation Gate

The native "Art Studio" illustrator (milestone 2) is code-complete and, as of
Part B, **policy-safe**: no generation call ever receives the raw child photo
("render this exact real child" is what Gemini's non-configurable safety tier
blocks — it killed real cover generations on 2026-07-15). Identity flows
photo → likeness brief (vision analysis, allowed) → model sheet → spreads,
with the photos used only by the cross-family likeness JUDGES.

Phase C is the exit gate before `BOOK_PIPELINE_V3_ILLUSTRATOR` flips from
`legacy` to `native`. Three steps, in order. Do not flip early — the legacy
path works and the print audits (2026-07-15, books `f417a6ed` and `37cadb95`)
show its remaining defect classes are contained by the interim QA patches.

## C1 — Judge calibration (gate: ≥0.90 agreement per hard-fail class)

The spread-QA and likeness judges must agree with a human on the hard-fail
classes before their thresholds are trusted:

- **lettering** (any painted text — includes wearable text like the garbled
  "RioIt"/"Anilt" name tags from audit book 2)
- **duplicated hero**
- **wrong child** (likeness)

Steps:
1. Build `labels.json` from real spreads. The two audited books are the seed
   set — their defects are already human-labeled in the audit notes:
   - Book `f417a6ed` ("Amit and the Secret Star"): fold-split captions
     (spreads 1, 2, 7, 9), trim-clipped glyphs (spread 7), hero identity flip
     (spreads 1 vs 3–6 vs 9–11), hero bisected on the porch spread.
   - Book `37cadb95` ("Amit's Rocket to the Stars"): garbled wearable text
     (name tag on ~5 spreads), NASA logo/US flag, top-edge caption clip
     (final spread). Clean spreads from both books are the negative labels.
   Pull the spread images from the books' GCS job folders and label each:
   `{ "imagePath": "gs://.../spread7.png", "lettering": true, "duplicatedHero": false, "wrongChild": false }`.
   Aim for 50–100 rows; pad with spreads from new shadow books (C3) as they
   generate.
2. Run `node scripts/calibrateIllustratorJudges.js labels.json` (needs the
   worker env keys — run from Cloud Shell or a dev box with `.env`).
3. Iterate judge prompts until every class shows **≥0.90 agreement**. Record
   the final numbers in this file.

## C2 — Volume run (gate: ≥10 native books, zero silent defects)

Generate at least 10 native test books across themes/ages via the admin
test-copy flow with the illustrator picker set to **native** (standalone,
"Generate Test Copy" → illustrator dropdown; requires standalone PR with the
picker). For every book:
- Audit the PDFs against the checklist below.
- A defect the QA *caught* (needs_review) is fine — that's the design.
- A defect that *shipped* silently is a gate failure: fix the judge/prompt,
  regenerate, restart the count.

Audit checklist (from the two print audits):
- [ ] Zero painted text anywhere in art (captions are typeset in native mode)
- [ ] No lettering/logos/flags on clothing
- [ ] Hero identical across all spreads AND matches the child photo
      (glasses! — book 1 gave the child glasses, book 2 didn't, same photo)
- [ ] No hero or content bisected at the fold (native renders 1:1 full-bleed,
      so this class should be structurally absent)
- [ ] Style consistent with the approved cover
- [ ] Story honors the cover imagery (coverImagery feed)
- [ ] Back cover typeset, no plaques/barcodes

## C3 — Shadow comparison (gate: native ≥ legacy on side-by-side review)

For 5 books: clone the same book twice via test copies — one legacy, one
native (same manuscript replay is automatic when cloning from a completed
book; otherwise compare same-seed runs). Review side by side with whoever
owns product quality: likeness, variety (shot budget), continuity, text
quality (typeset vs painted). Native must win or tie on every axis and
clearly win on text quality.

## Flip + cleanup (after C1–C3 all pass)

1. `services/bookPipelineV3/illustrator/config.js`: `DEFAULT_ILLUSTRATOR = 'native'`
   (update `illustratorConfig.test.js` accordingly).
2. Watch the first 5–10 production books (they report
   `illustratorVersionUsed: 'native'` in callbacks).
3. Then the final deletion: `services/bookPipeline/` (the 12-file legacy
   render subset), the legacy session illustrator machinery it uses, and the
   interim QA patches that exist only for painted-text defects
   (`wearable_text`/fold/trim rules stay — they're cheap and still valid for
   the cover, which remains a painted-title surface).

## Known open items that ride along

- `styleBible.js` is a versioned placeholder — if the product-authored style
  bible lands before the flip, bump `STYLE_VERSION` first (invalidates cached
  identity kits) and re-run C2 on 2–3 books.
- Cross-book likeness stability (the glasses inconsistency) is expected to be
  FIXED by the identity kit (photo-anchored, GCS-cached by photoHash) —
  verify explicitly in C2 with the same test photo across 3 books.
