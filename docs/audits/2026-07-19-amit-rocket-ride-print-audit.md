# Print audit #2: "Amit's Rocket Ride to Mars" (cover_5 + interior_5, 2026-07-19)

Second full-book audit, on the first book produced AFTER the Astro-Maze hardening
(docs/audits/2026-07-18-amit-astro-maze-print-audit.md). Same method: every page
rendered and visually reviewed, text layer extracted, print specs verified.
Interior: 32 pages, 630 pt (8.5″ + bleed), art 300 DPI, embedded text layout,
13 spreads (text pages 4, 6, 9, 11, 13, 15, 16, 18, 21, 22, 24, 26, 29).

Severity: **SB** = ship-blocker · **H** = high · **M** = moderate · **L** = low.

---

## 1. What the hardening fixed (verified on this book)

| Audit-1 class | Status |
|---|---|
| Back cover book-mockup | **FIXED** — flat Mars-scape wrap art, calm upper band, readable typeset blurb, no mockup, no photo surface |
| Wrap-edge pixel streaks | **FIXED** — soft fade, no raw streak band |
| Caption printed across the hero's face | **FIXED** — 0/13 spreads collide with Amit (was 3/13) |
| One-word orphan caption lines | **FIXED** — no single-word lines anywhere |
| Prop morphing | **FIXED** — the star map is the same parchment in ~10 appearances; the red-handled tool identical 3×; the fuel tube identical 5×; the rocket consistent throughout (prop plate visibly working) |
| Style drift / photo-blur spread | **FIXED** — one coherent warm storybook palette with a deliberate day→dusk→night arc |
| Duplicated climax / unintroduced prop | **FIXED** — clean single payoff ("I checked, I thought, I tried."); the tool is foreshadowed (curve mark → hook under the seat) before it's used |
| Twin-landmark mirror duplication | **IMPROVED** — no duplicated arches/rockets this book (fold-adjacency remains, see 3.3) |
| Internal style names on upsell pages | **FIXED** — "Paper Magic", "Soft Watercolor", "Movie Magic", "Cozy Classic" |

The writing is also a class better: a real problem-solving arc, a working refrain
("Stop. Check, think, try."), a page-turn question on every spread, and prop
setup/payoff discipline.

## 2. THE headline remaining issue — caption typesetting (user-reported, confirmed)

| # | Sev | Finding |
|---|-----|---------|
| T1 | **H** | **"Staircase" ragged centering.** Manuscript lines that exceed the measure wrap greedily, leaving a short centered continuation line under almost every long line — "and gold." / "map wide." / "bright curve." (p. 16), "in place." / "the rocket." (p. 24), "inside out." (p. 9), "and warm." / "I tried." (p. 29). Orphan control fixed 1-word lines; 2-word stubs still make every block read scattered. The fix is **balanced wrapping**: when a source line must wrap, split it into lines of near-EQUAL width (minimize width variance) instead of greedy-fill-then-remainder. |
| T2 | H | **Mid-page floating blocks over mid-ground subjects.** Bare `left`/`right` zones center the block vertically: p. 9 the caption sits directly across the two aliens' faces/bodies; p. 15 line 1 clips the aliens' antennae; pp. 24/26 blocks float mid-air between landscape elements. The hero-box relocation protects only Amit — secondary cast (aliens!) get no protection. Fix: the spread judge should return boxes for ALL cast members (or a single "figures" union box), and vertical anchoring should prefer top/bottom bands — never a vertical-center float. |
| T3 | M | **Measure runs nearly edge-to-edge** on long lines (p. 6 line 5 ≈ 90% of page width) — professional picture books keep captions to a tidier measure. Cap the text measure at ~75–80% of the printable width and let the size ladder work harder. |
| T4 | M | Ornate italic serif remains the body face — decorative "w"/"q" glyphs are harder for the 5–8 read-aloud audience; an upright rounded book face (or the existing serif's roman cut) would read better over art. |

## 3. Other illustration findings

| # | Sev | Finding |
|---|-----|---------|
| I1 | **H** | **A US flag patch on Amit's spacesuit on the cover and EVERY interior spread.** The interior render prompt forbids national flags, but the COVER pipeline has no such wardrobe rule — and the approved cover is the outfit ground truth, so the flag propagates book-wide, overriding the interior rule. Arbitrary national iconography on a personalized gift (customer plausibly not American) is a real product defect. Fix at the source: add the letter-free/flag-free/logo-free wardrobe rule to the front-cover + harmonize + upsell prompts, and extend cover QA to flag it. |
| I2 | M | **Helmet continuity flip-flops.** Dome ON outdoors on pp. 6, 8, 10 — then OFF outdoors on pp. 12, 14, 17, 19, 23, 25 (helmet ring only). Parents and kids notice vacuum logic. Fix: art-direction **gear-state continuity lock** (helmet on/off per setting) carried in every spread's continuityNotes; judge advisory when violated. |
| I3 | M | **Fold-adjacent focal objects persist** (better than book 4, but present): the boy walks at the wide-image center on spread 5 (p. 12 right edge), the rocket hugs the fold on p. 18, the rocket nose-cone tip is swallowed at p. 24's fold edge, an alien is clipped at p. 26's fold. Fix: make the fold check deterministic — escalate when the judge's hero_box (or a landmark box) straddles x ∈ [0.45, 0.55] of the wide render; strengthen the prompt's no-go language for the center strip. |
| I4 | M | **Map pasted on the rocket's exterior** during liftoff (p. 27) — the map is simultaneously inside with Amit (p. 28). Object-logic flaw, likely the prop-plate reference over-encouraging map visibility. Prompt note: recurring props appear only where the scene calls for them — never decal-ed onto surfaces. |
| I5 | M | **Alien-script signage** (p. 7): a sign with letter-LIKE glyphs over a doorway plus glyphs on the tower — passes the letterform check but reads as "weird writing". Tighten the wordless-props rule: no pseudo-alphabet/alien script; signs carry pictograms only. |
| I6 | M | Facial-mark wander: forehead/cheek moles appear and disappear (none pp. 5–6; two dots p. 8; two p. 17; several p. 28). The book-pass "stray facial marks" check exists — feed it a spread-level advisory + add "no moles/beauty marks" to the character-sheet prompt. |
| I7 | L | Object integrity, p. 8: the hand rests on the hair INSIDE the sealed helmet dome. |
| I8 | L | Rocket scale/placement wobble: tiny atop a rock arch (p. 16) vs. ground level elsewhere; "boot hill" is a literal giant lace-up boot on p. 13 but a generic mesa on pp. 14–15. |
| I9 | L | Spreads 10 and 11 are near-duplicate compositions (boy + rocket + tube fitting) — the book-pass variety check should nudge this as an advisory. |
| I10 | L | Cover clutter: three rockets on the front panel (Amit's + two decorative). |

## 4. Writing findings (small — the manuscript is strong)

| # | Sev | Finding |
|---|-----|---------|
| W1 | M | **Back-cover blurb still spoils the ending** ("…using the map, a found tube, and a brave plan to get his rocket working and blast home"). The teaser-blurb rewrite + spoiler lint from audit #1's roadmap is still open (blurb is authored upstream of the worker). |
| W2 | L | The refrain's first use (spread 2: "Check, think, try.") arrives with no setup — one grounding phrase ("like he practiced") on spread 1 or 2 would earn it. |
| W3 | L | A page-turn question ends EVERY spread; by spread 13 it's formulaic. Vary the hook type (question / sound / cliff-clause) or drop 2–3. |
| W4 | L | Spread 5: an alien points Amit to the answer — slightly undercuts the "he figures it out himself" theme the ending claims. |

## 5. Product/print

- Print tech ✓ (300 DPI, correct trim/bleed, fonts embedded). Halo double-draw still
  pollutes the text layer 2–5× per word (accessibility) — open roadmap item.
- 4/32 non-story pages (blank p. 1, The End, 2 upsell pages) — open roadmap item
  (art endpapers, one upsell page, optional custom dedication line).

---

## 6. Fix plan

### Tier 1 — this book
1. The only near-blocker is **the flag patch (I1)** — a product call: regenerate the
   cover without it (which re-anchors the interior outfit) or ship as-is for this
   customer. Everything else is shippable.

### Tier 2 — pipeline (priority order)
1. **Caption typography overhaul** (`layoutEngine.js` — the user-visible issue):
   balanced wrapping (equal-width lines per wrapped source line, extending
   `wrapTextBalanced` from orphan-rescue to variance-minimizing split); cap the
   measure at ~75–80% of printable width; never vertical-center — anchor bands
   top/bottom; consider an upright rounded body face behind an env flag.
2. **All-cast subject avoidance**: spread judge returns a `figures_box` (union of
   every character) beside `hero_box`; `chooseOverlayZone` avoids both.
3. **Cover wardrobe rules**: flag/logo/letter-free outfit line in front-cover,
   harmonize, and upsell prompts (`coverGenerator.js`, `illustrationGenerator.js`
   style blocks) + a cover-QA check (extend `qaBackCoverArtwork` pattern to the
   front panel or the likeness-brief pass).
4. **Deterministic fold-straddle check**: hero_box/landmark straddling the center
   band of a wide render escalates to the existing fold-collision class; harden
   the center-strip no-go wording in render + art-direction prompts.
5. **Gear-state continuity lock**: art director records helmet/gear state per
   setting in continuityLocks; rides continuityNotes into every render; book-pass
   advisory checks it.
6. **Prop-plate scoping note**: props appear only where the scene calls for them
   (no decals on hulls/walls); pseudo-alphabet signage added to the wordless rule.
7. **Sheet prompt**: "no moles/beauty marks unless in the photo"; book-pass stray-
   marks advisory feeds the repair template.
8. **Upstream (main app)**: teaser blurb prompt + spoiler lint; custom dedication
   option; endpaper art; single upsell page.

*Files: same rendered-page evidence set as audit #1, scratchpad `audit5/`.*
