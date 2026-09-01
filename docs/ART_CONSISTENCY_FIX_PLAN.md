# Art Bench consistency fixes — plan

**Trigger** (AdminIllustrationTuning, round `art-010.dd6f2800`,
`jungle_6_7_footprint_trail`, spreads 1–5, embedded layout): spread 1 shipped
visibly out of set — the child reads older / differently stylized, the palette
is lighter, and the story text sits on a solid cream side panel while spreads
2–5 carry it painted over continuous artwork. Separately, the child's comfort
object (the profile `object`, a tamagochi) appears on spread 1 only and
vanishes from every later spread.

Three distinct root causes, three fixes (plus one probe-contract addition and
app-side wiring). Nothing here touches the locked writer engine, the catalog,
or story validation.

---

## Root causes (as the code stands)

### A. No set-level check covers character rendering or text treatment

Every spread is a stateless render; consistency is defended by fixed inputs
(cover anchor, world plate, world-law card, pinned `TEXT_RULES`) plus two QA
layers — and each layer has a blind spot that lets a spread-1-style outlier
ship clean:

- **Per-spread QA** (`illustrator/spreadQa.js` `checkSpreadRender`) judges each
  render in isolation. A drifted spread 1 is internally fine — the app-side
  judge even scored it Identity 5 / Style 5 — so it passes alone.
- **The world gate** (`checkWorldConsistency`) is the only cross-spread check,
  but its closed defect vocabulary is world-only: `palette_lighting`,
  `era_technology`, `materials_physics`, `magic_behavior`, `other`. It is
  explicitly instructed NOT to flag lighting/time-of-day differences the story
  moment explains — spread 1's text is literally "warm rain mist", so its
  brighter haze reads as story-explained — and it is never asked about the
  child's apparent age/proportions/stylization, nor about how the embedded
  text is integrated. Spread 1 passes the gate.

### B. The text band gets ONE repair try, then ships and replays forever

The embedded render prompt already forbids the band (TEXT INTEGRATION rule,
`illustrationGenerator.js` `buildPrompt`) and per-spread QA gates it
(`text_on_band` → "sits on a blank band" defect). But:

- The repair budget is exactly one corrective re-render
  (`illustrator/index.js` `renderSpread`); the recheck after the repair is
  **advisory-only** — a repair that still carries the band ships with an
  advisory, and its fresh defect list is never acted on.
- The shipped render is then vouched by its `.qa.json` marker, so every later
  probe with the same story/tuning/anchor **replays the banded spread 1 from
  cache** (Re-judge in the bench, next rounds under the same tag — all replay
  it). Only `forceRerender`/`probeNonce` escapes.
- `forceRerender` is all-or-nothing over the requested subset: there is no way
  to re-render ONLY spread 1 while keeping 2–5 as replayed references. And a
  `spreads:[1]` probe skips the world gate entirely (<2 renders to compare),
  so a solo re-render is never checked against the set it must match.

### C. Personalization props are pinned to their evidence spread

`illustrator/scenes.js` `visualPropsForSpread` surfaces an evidence prop only
on the spread its evidence declares (`ev.spread === spread &&
visual_required`). The map slot (`s01_object_intro`, `object_presence`,
spread 1) pins the tamagochi to spread 1, so only spread 1's scene prompt ever
mentions it — the other renders are never told the child carries a comfort
object, and it disappears. (The evidence-to-spread rule in `storyValidation`
constrains the **text**; a carried object persisting in the **pixels** is
legal and expected — the child physically walks the whole book with it.)

---

## Fix 0 — remediate this round (no code)

Re-dispatch `/v13/render-spreads` for the same story + tuning + anchor with
`spreads: [1]`, `forceRerender: true`. Per-spread QA re-gates the band; cost
is one render. Then run the 5-spread probe again WITHOUT force — 1–5 all
replay (free) and the world gate returns a set verdict on the new spread 1.
This is the stopgap until Fix 2 makes it one call.

## Fix 1 — widen the set-level gate beyond "world"

`illustrator/spreadQa.js` + `illustrator/index.js`:

- Thread `textLayout` into `runWorldConsistencyGate` → `checkWorldConsistency`.
- Add two closed defect classes (same contract as the existing five: the enum
  drives the repair prompt; the free-form `note` stays diagnostics-only):
  - `character_rendering` — the ONE child hero must read as the same rendering
    of the same child across the set: apparent age, body/face proportions,
    stylization level, outfit, hair. Flag the spread that breaks the set.
  - `text_treatment` (embedded layout only) — all spreads must integrate the
    painted text the same way: over continuous artwork, one side, one type
    treatment. A spread whose text sits on a solid band/panel, or whose type
    treatment clearly differs from the book's dominant treatment, is flagged.
- Add matching fixed `WORLD_REPAIR_INSTRUCTIONS` entries, e.g.:
  - `character_rendering`: "Match the child's rendering to the other spreads
    exactly — the same apparent age, proportions, stylization, outfit, and
    hair as the reference character."
  - `text_treatment`: "Paint the story text directly OVER continuous artwork —
    no blank, solid, or lightened band or panel — in the book's one fixed
    font, size, and color, matching the other spreads."
- Repairs stay inside the existing `CATALOG_WORLD_QA_MAX_RERENDERS` budget and
  go back through the full per-spread path (render → QA → marker), so a
  text_treatment repair is still band-gated by per-spread QA.

QA-prompt-only change: base-render prompts don't move, so **no STYLE_VERSION
bump** and no cache invalidation.

## Fix 2 — probe contract: per-spread force re-render

`server.js` `/v13/render-spreads` + `illustrator/index.js`
`renderStorySpreads`:

- New optional field `rerenderSpreads?: number[]` (must be a subset of
  `spreads`; 400 otherwise). Listed spreads render fresh (stale marker
  dropped, same storage key — an explicit re-render intends replacement);
  the rest replay from cache.
- The world gate then compares the fresh spread(s) against the replayed
  references and may correct them — fresh renders are already the only ones
  the gate is allowed to re-render (`planWorldRepairs`), so the invariant
  holds unchanged: replayed spreads stay comparison references, never
  overwritten.

This is the exact "make spread 1 match the rest" operation: one call, one
render paid (plus at most one gate repair), 2–5 untouched. Rounds that must
stay immutable should keep sending a fresh `probeNonce` per round (already
supported) — `rerenderSpreads` overwrites the shared cache key by design,
like `forceRerender` does today.

## Fix 3 — iterative per-spread QA repair

`illustrator/index.js` `renderSpread`:

- Replace the single hardcoded repair with a bounded loop:
  `CATALOG_SPREAD_QA_MAX_REPAIRS` (default **2**, clamped 0–4, same env
  conventions as the writer budgets). Each pass builds its `repairNote` from
  the **latest** recheck's defects (today the recheck result is never acted
  on), re-checks, and stops early on pass.
- After the budget: unchanged contract — ship-with-advisory, marker records
  the residual defects.

Cost note: extra renders happen only for spreads that fail QA twice; a banded
embedded spread is a print-visible defect worth one more try. Default can be
dropped to 1 by env to restore exact current behavior.

## Fix 4 — carry-through continuity props

`illustrator/scenes.js` (+ `flags.js`, `versions.js`, `CLAUDE.md`):

- Derive **continuity props** once per story: evidence records with
  `visual_required === true`, `moment_type === 'object_presence'`, and
  `source_field === 'object'` persist visually on every spread **at or after**
  their declared spread. Values still pass through `inertPropValue` (quoted
  data, never directives).
- Declared spread keeps the current PERSONAL PROPS line; later spreads get a
  framed line, e.g.:
  `CONTINUITY PROP (carry-through): the child keeps their small personal item
  ("<value>") with them in this scene too — visible but small (tucked under an
  arm, in a hand, or right beside them), decorative and comforting only, never
  a tool, a clue, or part of the plot.`
- Only `object_presence`/`object` persists. `food_celebration`, place/interest
  references, etc. stay pinned to their declared spreads — a birthday cake
  must not ride the whole book.
- Kill-switch: `CATALOG_PROP_CONTINUITY=0` (flags.js entry + CLAUDE.md).
- **Bump `STYLE_VERSION` → `ce-6`** — this changes scene prompts (pixels) for
  every story carrying object evidence, so ce-5 renders must never replay as
  ce-6 (same rule as every prior bump; note the global cache invalidation
  cost when scheduling the deploy).
- Optional phase 2 (only if drift persists): a `prop_continuity` defect class
  in the widened gate — the carried item present on some spreads, absent or
  mutated on others.

No `storyValidation` change: the literal-evidence-value text rule constrains
words, not pixels.

## App-side wiring (giftmybook-standalone — separate repo)

- Surface the `worldQa` verdict (already on every probe callback, `null` when
  the gate didn't run) on the round card, beside the per-spread judge scores —
  the cross-spread finding the human made by eye should be visible from data.
- Per-spread **Re-render** button → Fix 2 probe (`spreads` = the round's
  spreads, `rerenderSpreads` = the one card).
- Judge note: the per-spread Props suggestions ("add a friendship bracelet")
  are asking for what personalization already supplies — once Fix 4 lands, the
  judge should see the comfort object on every spread; consider giving the
  judge the story's evidence so Props scores personalization fidelity, not
  generic decoration.

## Order & tests

Ship order: Fix 3 (smallest, immediate quality), Fix 1, Fix 2 (unblocks the
bench workflow), Fix 4 (needs the STYLE_VERSION bump — schedule with a
deploy), Fix 0 anytime.

- `__tests__/services/catalogEngine/spreadQa.test.js` — new defect fields
  parse/gate; malformed-verdict handling still passes-with-`qaUnavailable`.
- `__tests__/services/catalogEngine/worldQa.test.js` /
  `worldConsistency.test.js` — new enum members validated (out-of-set →
  `other`), embedded-only `text_treatment`, repair-note mapping.
- `__tests__/services/catalogEngine/engine.test.js` — repair loop honors
  `CATALOG_SPREAD_QA_MAX_REPAIRS` (0/1/2), latest-defects note, marker still
  written once.
- `__tests__/services/catalogEngine/artProbe.test.js` — `rerenderSpreads`
  validation (subset rule), fresh-vs-replay split, gate may repair the forced
  spread.
- Scenes: continuity prop present on spreads ≥ declared, absent for
  `food_celebration`, absent under `CATALOG_PROP_CONTINUITY=0`, inert-value
  sanitization.
