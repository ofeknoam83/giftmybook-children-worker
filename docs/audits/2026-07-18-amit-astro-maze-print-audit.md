# Print audit: "Amit Explores the Astro-Maze" (cover_4.pdf + interior_4.pdf, 2026-07-18)

Full-book audit of a v3-pipeline / native-illustrator output pair: the Lulu cover wrap
(1 page, 1367×738 pt ≈ 19.0″×10.25″ casewrap) and the 32-page interior (630×630 pt =
8.5″ trim + 0.125″ bleed). Method: every page rendered with poppler and visually
reviewed; text layer extracted; print specs verified with `pdfinfo` / `pdfimages -list`.

Page numbers below are interior PDF pages. Spreads: (4,5)…(28,29) = spreads 1–13;
text pages are 4, 7, 8, 10, 13, 14, 16, 19, 20, 23, 24, 26, 29. The book runs in
**embedded** text layout throughout (wide 16:9 render split across the fold, caption
typeset over the art).

Severity: **SB** = ship-blocker · **H** = high · **M** = moderate · **L** = low.

---

## 1. Cover findings

| # | Sev | Finding |
|---|-----|---------|
| C1 | **SB** | **Back panel is a 3D book-mockup photo, not flat print art.** The back-cover area contains a rendered *picture of a closed book lying on a beige tabletop* — drop shadow, page edges, spine highlight — with the blurb typeset onto the mockup's tilted face. Printed, the physical back cover will show a photo of a book on a table. The wrap must be flat art edge to edge. |
| C2 | H | Back-panel scene is off-theme: pastoral hills, green trees, garden lanterns at dusk — nothing to do with the space/crystal-maze story on the front. Back and front read as two different books. |
| C3 | H | Back blurb: white text over a light lavender sky — contrast well below comfortable print legibility; and the copy narrates the entire plot **including the resolution** ("chooses a new path himself… leads him to the hidden final bridge and the rocket ship"). A back cover should tease, not spoil. |
| C4 | M | Right wrap edge shows crude single-pixel-row stretch smearing (~0.9″ band of horizontal streaks). It mostly falls in the wrap zone, but streaks intrude toward the front-panel trim and will be visible on the wrapped board edge. Mirrored or painted bleed extension would be invisible. |
| C5 | L | Spine is a flat blank blue-gray band. At ~0.25″ this is acceptable, but a spine tint matched to the front art (or a tiny star motif) would finish the package. |

Front panel itself is good: strong composition, clean title lettering, likeness matches
the interior hero.

## 2. Interior — layout & typography (systemic)

| # | Sev | Finding |
|---|-----|---------|
| L1 | **SB** | **Caption typeset across the hero's face.** p. 4: two lines run directly over Amit's hair and forehead. p. 14: several lines cross his face and torso. p. 24: lines clip his head and raised arm. The luminance-based quiet-zone band analysis (`analyzeZoneBand` / `computeOverlayPlacement`, `services/layoutEngine.js`) sees a tonally smooth band and places text there — it cannot see that the smooth area *is the subject*. This is the #1 "parent test" failure in the book. |
| L2 | H | **Fold-straddling subjects.** Spread 1: the rocket ship sits exactly on the fold and is split across pp. 4–5 (reads as two half-rockets). Spread 4: a gold tunnel straddles pp. 10–11 with visibly mismatched halves. The renderer's GUTTER rule protects *text*, but art direction doesn't keep salient objects out of the center band of wide renders. |
| L3 | H | **Duplicated landmarks in wide renders.** Spread 2 (pp. 6–7) contains two nearly identical red brick arches, one per half — the model composed the 16:9 canvas quasi-symmetrically. Combined with L2, spread 1 reads as having two rockets. No QA check targets mirrored twin landmarks. |
| L4 | M | Widow/orphan lines throughout: one-word lines "gold." (p. 4), "map." (p. 7), "completely." (p. 16), "way!" (pp. 13, 14), "takes." (p. 23), "rose."/"gleam." (p. 24), "ship." (p. 20), "gem." (p. 26). The size-ladder shrinks text but the greedy line-breaker never rebalances. |
| L5 | M | Caption blocks of 6–8 lines cover up to ~40% of the art on pp. 4, 10, 16 — embedded overlay was designed for short captions; at this length it competes with the illustration. |
| L6 | M | Typography vs. audience: ornate italic serif (decorative "w" glyphs) fully centered on every page. For a read-aloud 5–8 book, a rounder upright face, left-aligned or shorter centered lines, would read far better. Contrast is borderline on busy bands behind text on pp. 4, 10, 14 despite the halo. |
| L7 | L | The halo is drawn as 3–5 stacked text draws, so the PDF text layer contains every word multiple times — noisy for screen readers, search, and copy/paste in digital previews. A true outline (stroke render mode or flattened halo) would fix it. |

## 3. Interior — illustration consistency

| # | Sev | Finding |
|---|-----|---------|
| I1 | **SB** | **The lamp — the story's pivotal prop — is a different object every time it appears**: a glowing crystal cupped in hands (p. 18), a crystal pendant dangling from a cord (p. 21), a treasure-chest-shaped lantern (p. 22), a classic camping lantern (p. 24 and on the dashboard p. 29). A child will ask which one is "his lamp". |
| I2 | H | **Style/palette drift across spreads**: vivid saturated purple (spread 1) → gray desaturated moonscape (spread 3) → washed pastel cave (spread 4) → **photo-blurred depth-of-field red crystals on spread 8 (pp. 18–19) — a hard style break** (photographic bokeh in a flat-illustration book) → soft painterly daylight (spread 9). Same failure class as the 2026-07-18 style-drift hardening (book 6e018c20); the blur variant isn't covered by the current critical class. |
| I3 | H | **Text–art disagreement (action absent / wrong setting).** p. 13: text has Amit slipping *inside the quietest tunnel* with purple crystal walls and the map painting a path over the ceiling; art is an outdoor overhead maze — no tunnel interior, no Amit. p. 20: text describes the crystal light-chain revealing *a narrow bridge* curving toward the rocket; art shows mossy floating asteroids — no bridge, no crystal chain, no rocket, no Amit. pp. 18–19: text says "his small lamp glows"; art shows a bare crystal. |
| I4 | H | **Countably wrong vs. text**: pp. 10–11 text says **three** tunnels; the spread paints **four** distinct openings (blue + gold on p. 10, gold + green on p. 11). This is the existing "countably wrong" critical class, uncaught. |
| I5 | M | Map prop inconsistent: glowing blue star-map (pp. 4, 6, 12, 24, 27), pale green (p. 8), plain white paper maze (pp. 19, 21). The text says it "hums green and gold"; the art is mostly blue/cyan. |
| I6 | M | Likeness drift: chibi proportions on p. 14, notably older/longer-haired on p. 28, rounder face pp. 21–22; freckle/beauty-mark pattern wanders. Identity stays recognizable (no wrong-child failure) but is not tight page to page. |
| I7 | L | Rocket ship design varies (fins, porthole layout) between pp. 4/5, 6, 23, 25 — passable individually, noticeable side by side. |
| I8 | L | p. 16 shows the center platform empty while the facing p. 17 shows Amit sitting on it — acceptable across a spread, but the platform is drawn twice with different geometry. |

## 4. Writing

The manuscript's core is genuinely good: the "This way?" / "That way!" call-and-response
refrain is a strong read-aloud engine; the arc (playful maze → the map goes dark →
Amit makes his own light → "My way") is clean and emotionally right; verbs are concrete
and sensory; spread lengths are consistent. The issues are line-edit level:

| # | Sev | Finding |
|---|-----|---------|
| W1 | H | **The climax line fires twice.** p. 20: "This way? …My way," he says, and steps onto the bridge. p. 26: "Amit laughs, warm and low. 'This way. My way.'" The second occurrence is the true payoff; the first spends it early. |
| W2 | H | **The lamp appears from nowhere.** First mention is p. 19 ("his small lamp glows with a patient golden dot") with possessive "his" — it was never introduced; p. 4's inventory is map-only. The story's turning point rests on an unestablished prop (and I1 compounds it visually). |
| W3 | M | Logic wobble: on p. 8 the map confidently leads Amit to a START AGAIN dead end (map is wrong), yet pp. 14–16 treat the map's failure at the center as the first betrayal. One clarifying beat ("the map giggled too" / the maze rearranges) would reconcile it. |
| W4 | M | Word-frequency: "crystal(s)" ≈18×, "map" ≈15×, "glow/glowing" ≈12× in 13 spreads. A synonym/trim pass would help read-aloud rhythm. |
| W5 | M | Back-cover blurb is one 7-line sentence and spoils the ending (see C3) — should be 2–3 teaser sentences ending on the question, not the answer. |
| W6 | L | Uneven line lengths for read-aloud cadence (some 15+-word lines wrap into the L4 orphans). Target ≤ 12 words/line at layout time or break lines editorially. |

## 5. Product & print tech

| # | Sev | Finding |
|---|-----|---------|
| P1 | ✓ | Print tech is solid: every interior art page is 300 DPI at full size (2625×2625 px), page boxes 630 pt with correct bleed, fonts embedded, PDF 1.7. Upsell thumbnails are 200 DPI (fine at their size). |
| P2 | M | 4 of 32 pages are non-story in a keepsake gift: blank p. 1, "The End" + brand p. 30, and two upsell pages (31–32) with QR codes. Consider art endpapers and confining the upsell to a single closing page or a physical insert. |
| P3 | M | Internal style names leak to the consumer on the upsell pages ("PAPER CUTOUT", "CINEMATIC 3D", "SCANDINAVIAN MINIMAL", "WATERCOLOR") and the four preview covers show noticeably different likenesses of the same child. |
| P4 | L | Dedication page is bare ("For Amit") — an easy emotional win to offer the gifter a custom message line. |

---

## 6. Fix roadmap

### Tier 1 — this book (ship-blockers first)

1. **Regenerate the back cover** as flat, themed art (crystal-maze night sky continuing the front panel's world) with a 2–3 sentence teaser blurb in a legible contrast treatment. (`services/coverGenerator.js` prompt: explicitly forbid book mockups, tables, photo surfaces, borders.)
2. **Re-run overlay placement or regen** the text-on-face spreads (1, 6, 11 → `POST /v3/review/regen-spread` with placement notes), plus the style-break spread 8, the action-absent spread 9-left, and the four-tunnel spread 4.
3. **Unify the lamp** to one design (the camping lantern of pp. 24/29 is the strongest) and regen pp. 18, 21, 22 with it in the prompt/reference.
4. **Three text edits**: introduce the lamp on p. 4 ("…and a little lantern clipped to his belt"); rewrite p. 20's closing line so "My way" lands only at p. 26; replace the back-cover blurb.

### Tier 2 — pipeline hardening (so the next book doesn't repeat this)

1. **Cover QA gate** (closed-gate pattern, mirroring the spread judge): critical classes = book-mockup/book-in-book/photographic surface on any panel, painted long text, front↔back style/setting mismatch; plus deterministic blurb contrast check and a spoiler lint (blurb may not contain the final-act resolution).
2. **Prop sheet in the identity kit** (`bookPipelineV3/illustrator/identityKit/`): render the recurring props (map, lamp, rocket) once alongside the character sheet, ride them in every spread's reference pack (`render/referencePack.js`), and add a prop-continuity checklist to the `bookPass` contact-sheet review.
3. **Fold safety + twin-landmark checks for wide renders**: art-direction prompt keeps the hero and named landmarks out of the central ~15% band of 16:9 canvases; QA adds a "mirrored twin landmark near the seam" defect (escalate like the deterministic hard tags).
4. **Subject-aware overlay placement** (`services/layoutEngine.js`): before typesetting, test the candidate band for the subject (cheap saliency/figure detection, or reuse a QA_VISION call that returns the hero's bounding box per spread) and flip band / shrink block / fall back to the opposite zone when it intersects a face or figure. Add orphan control to the line-breaker (min 2 words per line, rebalanced breaks) and cap block height at ~30–35% of page height.
5. **Text-agreement QA**: extend the spread judge with explicit checks that named objects, actions, and **counts** in the caption appear in the art (feeds the existing countably-wrong critical class; "action entirely absent" already exists — give the judge the caption verbatim and ask it to enumerate).
6. **Style-drift**: add photographic blur / depth-of-field detection to critical class 6 (cover-relative style break) — the 2026-07-18 hardening covers flat/desaturated drift but not bokeh-photo drift.
7. **Writer/EDITOR lints**: duplicate-climax/echo detection across spreads; prop-introduction check (a possessive "his/her X" must be introduced in an earlier spread); per-book word-frequency caps for signature nouns.
8. **Product polish**: consumer-facing style names on upsell pages; one upsell page instead of two, or an insert; optional custom dedication line; art endpapers instead of blank p. 1.

---

*Audit artifacts (page renders) were reviewed at 100 DPI; findings cite interior PDF
page numbers. Cover file: `04abdfcd-cover_4.pdf`; interior: `6fb78af4-interior_4.pdf`;
both produced 2026-07-18 11:08–11:09 UTC by pdf-lib (layoutEngine/coverGenerator).*
