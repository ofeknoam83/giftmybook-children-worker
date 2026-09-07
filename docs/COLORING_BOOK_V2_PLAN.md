# Coloring Book V2 — companion scenes from the story world (plan, cb-1)

> **Status:** PLAN (2026-09-07). Nothing on this branch implements it yet. The old
> implementation (`services/coloringBookGenerator.js`, `services/coloringBookLayout.js`,
> `POST /generate-coloring-book`, `POST /cancel-coloring-book`,
> `POST /rebuild-coloring-cover-pdf`, `__tests__/services/coloringBookGenerator.test.js`) is
> DELETED by this plan, not refactored — §5.3 lists every line that goes and the 410 stubs
> that replace the routes, the 2026-08 cutover's pattern.
> **Scope:** `giftmybook-children-worker` (this plan) + `giftmybook-standalone`
> (`docs/COLORING_BOOK_V2_APP_WIRING.md` — the app-side companion, same branch).
> **Branch:** `claude/coloring-book-redesign-l10xpt` in both repos.
> **Siblings:** `docs/ILLUSTRATION_CONSISTENCY_REFACTOR_PLAN.md` (the Book Bible + selection
> gate this reuses wholesale), `docs/GIFT_VIDEO_PLAN.md` (the most recent "pinned inputs in,
> N candidates out, verified, fail closed" product — this plan is that shape applied to line
> art), `docs/RUNTIME_CONTRACT_V1_3.md` (the catalog the scenes are authored against).

**Trigger.** A customer adds the coloring-book add-on to a children's book order (cart item
`coloring_book`, $14.90), or an admin clicks **Generate coloring book** on a finished book.
They get a printed 8.5×11 saddle-stitched coloring book whose pages are **new scenes from the
same story world — the moments the picture book does not show** — drawn as clean, premium
line art, starring the same child (same face, hair, outfit) and the same companion, with the
child's own comfort object where the story's evidence declared it. Every page is verified;
nothing ships unchecked.

**The one-paragraph diagnosis.** The current coloring book is the only product on the worker
that still runs the pre-V1.3 way: an LLM invents sixteen free-text scenes at temperature 0.9
from a four-spread synopsis (`coloringBookGenerator.js` L340-409), each page is rendered from
the raw child photo with no character sheet, no outfit spec, no companion sheet and no world
plate (L222-246), "line art" is forced afterwards with a hard `sharp.threshold(150)` that
turns anti-aliased strokes into jagged speckle and erases every mid-grey line (L16-22,
`coloringBookLayout.js` L105-108 and L200-203), the render's aspect ratio is never requested
(`callGeminiImage` L103-114 sends no `imageConfig`) so the page is stretched onto the
612×744 pt box (L217-218), nothing is checked — no text gate, no identity check, no
duplicate-child check, no shading/fill measurement — and the cover is a pencil re-render that
asks the model to hand-letter the title (L454-456), the exact spelling risk the printed-offer
path had to lock away (`upsellOffer.js`). The layout is a navy caption band on every page
(L119, L221). Meanwhile the worker already owns everything a beautiful, consistent coloring
book needs: the frozen catalog definition with twelve fixed beats per book, the theme's world
card and companion, the pinned personalization evidence, and the Book Bible — an elected
character model sheet, a per-garment outfit spec, companion and prop sheets, a world plate —
plus the candidate/QA/select/repair machinery and the deterministic image metrics. The
design is therefore: **author the pages as DATA from the catalog (a closed grammar of
"beside-the-story" scene kinds, never a plot), pin identity through the Bible as line art,
specify line art as a measurable spec instead of thresholding it into existence, verify every
page with a structured verdict plus pixel metrics, select among candidates, repair within a
budget, fail closed, and typeset the book like a designed object with zero model-painted
words.**

---

## 1. Goal

1. **Scenes that fit the story but are not in it.** Every page is one of a closed set of
   companion-scene KINDS (§4.1) that sit beside the twelve beats by construction — the walk
   between two beats, the morning before, the evening after, a portrait of a place the story
   visits, the companion on its own, the creatures the beats name, a quiet parallel moment at
   the emotional peak. A deterministic planner assigns the kinds; a bounded moment writer
   (§4.2) phrases each one, and a duplication gate proves the phrase restates no beat and no
   spread text. No new plot, no new characters, no peril, no text.
2. **The same hero and the same companion.** Pages render against the book's own Book Bible
   (`buildBookBible`, `illustrator/bible/index.js` L133): the character sheet, the outfit
   spec, the companion sheet + spec, the prop sheets, the world plate — converted ONCE into
   pinned LINE-ART model sheets (§4.3) that ride every render as reference 1. Consistency comes
   from references and verification, never from "keep it consistent" lines.
3. **Beautiful line art, specified and measured.** A pinned `LINE_RULES` spec per age band
   (§4.4) — stroke weight, closed shapes, pure black on pure white, no shading, breathing room
   — rides every prompt; deterministic metrics (§4.6) measure ink coverage, grey mass, solid
   fills and stroke width on the returned pixels; the only post-processing is a non-destructive
   white-flatten / black-snap that leaves anti-aliased edges alone. The hard threshold is gone.
4. **Verified, selected, repaired, fail-closed.** N candidates per page, one structured vision
   verdict each (identity vs sheet, outfit garment by garment, companion, props, painted text,
   shading, fills, open shapes, extra people, scene match) + metrics, scored with the
   `select.js` shape, best promoted, bounded repair while BLOCKING defects remain, residuals
   fail the book `coloring_unresolved` with the scored candidates attached and an admin
   **Pick** remedy (`/v13/pick-coloring-candidate`). Two set gates hold the pages to each
   other: a contact sheet vs the line-art model sheet (identity drift) and a stroke-weight
   gate (the book's own median line weight).
5. **A designed object.** Margins instead of bands, one typeset caption per page in the book's
   own hand-lettered face (PDF type, never pixels — D5), a "Meet {name}" model-sheet page, a
   themed line-art border plate on the title / draw-your-own / colored-by pages, and a cover
   built from the approved parent cover's OWN pixels with the title typeset — no model touches
   the cover.
6. **Replayable, versioned, cheap.** Every page key folds `COLORING_VERSION`, the story
   fingerprint, the Bible hash and the plan hash; a re-dispatch replays finished pages and
   rebuilds PDFs for free; ≈ $1.5–2.5 and 6–9 minutes per book (§7).

## 2. The four honest constraints (read before the design)

### 2.1 "Not in the book" must be a property of the plan, not a request to the model

The old planner asked Gemini to "complement, not duplicate" the story moments (L346-350) and
never checked. A model that is handed twelve beats will paraphrase them. The only way to
guarantee that no page retells a spread is to make retelling structurally impossible: the
planner chooses scene KINDS whose definition excludes plot events (§4.1), the moment writer
is confined to phrasing one already-chosen kind for one already-chosen anchor, and a
deterministic duplication gate (§4.2) rejects any phrase that shares a distinctive n-gram or
too much of its content vocabulary with any beat or spread text. The gate, not the prompt, is
the guarantee; the template fallback (no LLM) always passes it.

### 2.2 Line art is a spec the model must hit, not a filter applied afterwards

`threshold(150)` (L19) is why the current pages look cheap: anti-aliased stroke edges become
staircase pixels, every grey line under the cut vanishes, every grey wash above it becomes a
black blob, and thin detail lines break into dashes. A printed coloring page needs continuous,
smooth, closed strokes at a print-legible weight (≈ 2–3 pt for a 4–5 year old's crayon), and
Gemini 3.1 Flash Image produces exactly that when asked for it in concrete terms — but it also
happily adds a grey wash, a hatched shadow or a solid black hair mass, and it paints signage
when a scene suggests it. So the spec is pinned in the prompt in the model's own terms
(§4.4), the result is MEASURED (§4.6: grey mass, ink coverage, largest solid component,
stroke width, painted text), a failing candidate sinks and a fixed repair note steers the
next pass, and the only pixel edit the pipeline makes is a near-white flatten and a
near-black snap that never touches the 40–235 anti-aliasing band. Print resolution comes
from requesting a larger output (`imageConfig.imageSize`, the ce-16 pattern), never from
upscaling a thresholded image.

### 2.3 Identity in line art is harder than identity in colour

Colour, lighting and rendering carry most of what makes a stateless render "the same child";
a line drawing has only silhouette, hair shape, face proportions and the outfit's cut. Two
consequences. (1) The reference the model copies must itself BE line art: a colour sheet
translated ad hoc on every page drifts per page, while ONE pinned line-art model sheet
(front / three-quarter / back, §4.3), elected once per anchor with its own QA, gives every
page the same silhouette to trace. (2) The judge needs the pinned outfit spec quoted as data
(garment cut, length, pattern — colour words are irrelevant on a coloring page and the verdict
ignores them) and the line sheet attached beside the render, exactly as `checkSpreadRenderV2`
attaches the colour sheet. Pages that carry no child at all (world portraits, companion and
cast portraits, still lifes) are deliberately part of the plan: they are the pages with zero
identity risk and they are what makes a coloring book feel like a world.

### 2.4 The cover cannot be a model output

The wrap PDF prints whatever the front image contains. The current cover re-renders the
parent cover in pencil and instructs the model to reproduce the title "hand-lettered in
pencil" (L454-456) — the same operation that mis-spelled advertised titles on the upsell
spread until the caller locked them. Since ce-9 the parent's wrap cover prints the approved
cover's OWN pixels (`preGeneratedCoverBuffer`), and the approved cover is title-less key art
(the title is typeset by `coverGenerator`). The coloring cover therefore reuses those pixels
and typesets the title in the parent's typographic system on a palette band derived from the
art (§4.8); no image model is called for the cover, so it costs nothing, cannot mis-spell,
and is byte-reproducible.

## 3. What exists today (grounding)

### Worker

| Today | Where | Consequence |
|---|---|---|
| The catalog book definition: 12 ordered beats, premise, archetype, refrain, `learning[]`, `safety[]`; the theme's `world_name`, `companion {name, type}`; a per-theme world-law card | `data/catalog.json`; `catalog.js` `getBookForTag`; `data/worldCards.json` + `worldCards.js` `renderWorldCardBlock` | The scene plan is authored from pinned data the story was written against, resolved by the story's PINNED catalog tag (an overlay-reshaped theme never changes an old book's coloring pages). |
| The validated story pair with 12 spread texts + `personalization_evidence` (`visual_required`, `moment_type`, `spread`, `source_value`) | `/generate-book` `story:{request,response}`; `scenes.js` `visualPropsForSpread` L27, `continuityPropsForSpread` L71, `inertPropValue` L89, `companionOnSpread` L140 | The duplication gate has the exact texts to reject against; carried props and companion presence per anchor spread come from the same functions the book used. |
| The Book Bible: character sheet (elected per anchor, `catalog-assets/character-sheets/{STYLE_VERSION}/{anchorHash}.png`), outfit spec v3 (per-slot cut/length/pattern/colourHex), companion sheet + spec (creature or PERSON since ce-19), prop sheets, world plate, emotion plan, `bibleHash` | `illustrator/bible/index.js` `buildBookBible` L133, `buildReferencePack` L282, `summarizeBible` L371; `bible/characterSheet.js`; `bible/propSheet.js`; `worldPlate.js`; `emotionPlan.js` `getEmotionPlan` | One call gives the coloring book every identity input the picture book had, already elected and cached. The line-art sheets (§4.3) derive from these, keyed by their hashes. |
| The structured spread verdict v2 + defect classification + candidate scoring + bounded repair + set gates | `spreadQa.js` `checkSpreadRenderV2`, `classifyDefects`, `BLOCKING_PREFIXES`, `repairNoteV2`; `select.js` `pickBest`, `compareCandidates`, `residualBlocking`, `WEIGHTS`; `contactSheet.js`; `candidates.js` | The coloring page verdict is a sibling schema with the same fixed-defect-string discipline, the same scoring shape, the same contact-sheet tiling. |
| Deterministic image metrics on sharp (bbox crops, ΔE, ink polarity at native resolution) | `illustrator/metrics.js` (`textInkColour`, `inkSetOutliers`) | The line-art metrics (§4.6) are the same module style: pure functions on raw pixel buffers, thresholds pinned as constants, fail-open on unmeasurable input. |
| The shared Gemini image client: key pool, endpoint failover, NSFW error typing, `GEMINI_IMAGE_SAFETY_SETTINGS`, the `imageConfig.imageSize` 400-retry, per-image cost rates | `illustrationGenerator.js` L21, `callGeminiImageApi` (`imageConfig` L1152-1159, the `imageSize` retry L1221-1223, the endpoint loop L1275-1345), `getNextApiKey`, `fetchWithTimeout`, `downloadPhotoAsBase64`; `costTracker.js` RATES L16-28 | The coloring renderer is a thin adapter over ONE exported primitive (§5.1 `callGeminiImageParts`) — no second Gemini client like the old `callGeminiImage` (L103-130). |
| Strict-JSON judge config for the 2.5 flash family | `shared/llm/geminiJson.js` `jsonQaGenerationConfig`, `parseJsonText` | The moment writer and the page judge use it (thinking off, ≥ 2048 tokens — the 2026-09-02 clipping lesson). |
| Versioned, content-keyed render cache + `.qa.json` markers + admin-vouched promotion | `illustrator/index.js` `renderCachePath` L104-107, `renderContentHash` L74-76; `server.js` `/v13/pick-candidate` L859 | The coloring cache is the same discipline under `children-jobs/{bookId}/coloring/{COLORING_VERSION}/{planHash}/`. |
| The async endpoint pattern: validate everything before the 202, register a book context under its own map key, heartbeat, deliver a stable-shaped callback, 410 stubs for deleted routes | `server.js` `/v13/generate-video` L891-1040, `createBookContext` L165-197, `coloringActiveJobKey` L154-156, stubs L302 / L1356 / L2150 | `/v13/generate-coloring-book` copies the video route line for line; the three old coloring routes become 410s. |
| pdf-lib layout with the fonts directory (Bubblegum, Comic Neue Bold, Dancing Script, **Kalam**, Playfair, Liberation Sans) and the book-wide caption standard | `layoutEngine.js` `computeBookCaptionBlock`; `coloringBookLayout.js` L26-47; `fonts/` | The new layout typesets captions and matter in Kalam (the hand-lettered face already shipped) and never rasterizes text. |
| The old implementation | `coloringBookGenerator.js` (795 lines), `coloringBookLayout.js` (622), `server.js` L1364-1687 + L2017-2090, the test (299) | Deleted in full (§5.3). |

### App — what it already knows (detail in the companion doc)

The app holds the chosen story pair (`childrenStoryFlow.chosenStoryPair`), the normalized
profile and identity inputs it sends `/generate-book` (`buildWorkerPayload`:
`approvedCoverUrl`, `childPhotoUrls`, `characterDescription`, `textLayout`), the persisted
`storyContent.catalog` (definition id, theme, band, versions, evidence), the `ColoringBook`
table with its Lulu lifecycle, cart links and shipping override, a paid-item cron queue, and
the `giftVideo` dispatch discipline (`dispatchId` reserved before the call, `stale_dispatch`
rejected on callback). Today's payload builder discards all of the V1.3 inputs and sends a
synopsis, "story moments" and a questionnaire instead.

## 4. Core design

### 4.1 The scene plan — a closed grammar of beside-the-story kinds (`coloring/plan.js`)

The plan is a pure function of pinned inputs: the book definition, the theme, the story's
spread texts, the evidence, the profile's age band, the emotion plan, and a seed
(`fnv1a(storyFingerprint | bibleHash | COLORING_VERSION)`). Same inputs → same plan, byte for
byte, so the plan hash is a cache dimension and a regenerated manuscript replans.

**Scene kinds** (the closed enum; each is non-plot by definition):

| kind | what it depicts | anchor | child? | companion? |
|---|---|---|---|---|
| `meet` | the line-art model sheet itself as a coloring page — the hero in three views ("Meet {name}") | — | yes | no |
| `hero_portrait` | the child in the world, full body, big simple shapes; carries the comfort object when evidence declares one | spread 1 or 12 | yes | optional |
| `companion_portrait` | the companion alone doing what its type does | — | no | yes |
| `world_portrait` | a place the beats visit, empty of people (the barn, the gate, the pond) | the beat that names it | no | no |
| `cast_portrait` | the creatures/objects the beats name with their "small behaviors" (exactly three chicks) — the `learning[]` lines seed these (a counting page IS a learning page) | the naming beat | optional | no |
| `between` | the quiet transition between beat k and k+1: walking, waiting, looking, carrying, preparing — never the event of either beat | spreads k, k+1 | yes | when `companionOnSpread` on k or k+1 |
| `before` | the morning of / getting ready / arriving (prologue) | spread 1 | yes | no |
| `after` | the evening after / telling the day / bedtime with the memory (epilogue) | spread 12 | yes | optional |
| `quiet_parallel` | a calm parallel moment at the emotional peak: listening, resting, noticing | the peak spread | yes | optional |
| `prop_still_life` | the comfort object + two or three world objects, large and simple (band 1-3's best page) | the object's evidence spread | no | no |
| `pattern` | a decorative page of world motifs from the border plate (band 8-10 only) | — | no | no |

**Quotas by band** (coloring pages, before front/back matter; `CATALOG_COLORING_PAGES`
overrides the total, the planner scales quotas proportionally and keeps `meet`):

| band | pages | meet | hero | companion | world | cast | between | before/after | quiet | still life | pattern |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1-3 | 16 | 1 | 2 | 2 | 2 | 3 | 5 | 0/0 | 0 | 1 | 0 |
| 4-5 | 20 | 1 | 1 | 1 | 2 | 2 | 8 | 1/1 | 1 | 1* | 0 |
| 6-7 | 20 | 1 | 1 | 1 | 2 | 2 | 8 | 1/1 | 1 | 1* | 0 |
| 8-10 | 20 | 1 | 1 | 1 | 2 | 2 | 7 | 1/1 | 1 | 1* | 1 |

\* `prop_still_life` only when object evidence exists; otherwise the slot becomes a third
`world_portrait`. The peak spread is the emotion plan's highest-intensity turn (the same
selection the gift-video plan makes; expose it from `video/plan.js` rather than re-deriving).
The `between` gaps are the eleven (k, k+1) pairs, seeded-shuffled and the first N taken, then
sorted by k — the book reads in story order without retelling it. Portraits are interleaved
at fixed positions (world portraits after the first between-page, the companion portrait
mid-book, cast portraits beside their naming beats).

**Composition** is assigned deterministically too, the shot-plan pattern: a closed vocabulary
of three shot sizes (wide / medium / close) with no adjacent repeats and a band-1-3 menu of
medium/close only, plus a placement (centred / left third / right third) — each page's
COMPOSITION line is fixed text, so pages vary without a model choosing.

**Invariants the planner enforces** (tests): every kind's quota is met; adjacent pages never
share a kind (except `between`); no two pages anchor on the same gap; band 1-3 never gets
`quiet_parallel`, `before`, `after` or `pattern`; a `retired` or missing definition fails
`missing_book_definition` before any spend; the plan JSON is schema-validated (ajv, the
sidecar pattern).

### 4.2 The moment writer and the duplication gate (`coloring/moments.js`)

Each planned page needs one or two sentences the renderer can draw. Two sources, in order:

1. **Template line** (deterministic, always available): a fixed template per kind over pinned
   data — e.g. `between`: "On the way from {place noun of beat k, if any} toward {beat k+1's
   setting}, {name} walks with {companion} along the path, looking around; a calm moment
   between two parts of the day." The template never copies a beat verb phrase, so it passes
   the gate by construction.
2. **Moment writer** (ON by default, kill-switch `CATALOG_COLORING_MOMENT_WRITER=0`): ONE
   strict-JSON call per book on `gemini-2.5-flash` (`jsonQaGenerationConfig`, the emotion
   classifier's shape) that receives the plan (kinds + anchors + the two adjacent beats per
   slot, quoted as data), the theme, the `safety[]` lines, and the rule set — "phrase the
   quiet in-between moment; never the event of either beat; no new characters, no new
   problems, no peril, no food unless listed, no text or signs; one clear subject; name only
   {child}, {companion}, {world}" — and returns `{pages:[{index, moment, title}]}` (`title`
   ≤ 5 words, the page caption). One retry with the gate's rejections fed back; a slot that
   still fails takes its template line. The writer never fails the book.

**The duplication gate** (pure, tested on real catalog books): a moment is REJECTED when,
against ANY of the 12 beats or 12 spread texts (normalized: lowercase, NFD-stripped,
punctuation out, stop words out, lemmatized by a small suffix table),
(a) it shares a content-word 4-gram; or (b) its content-word Jaccard with one text exceeds
0.45; or (c) the Levenshtein ratio between the two normalized sentences exceeds 0.6.
Also rejected: a capitalized token outside the allowlist {child name, companion name, world
name, display name, the beat's own proper nouns} (no invented characters); any term in
`data/bannedBrands.json`; any word from a small pinned peril lexicon (lost, trapped, hurt,
scared, storm, chase, fall …); any quoted string or digit sequence (nothing to paint as text).
The gate output (`{ok, reasons[]}`) rides the page manifest so the admin sees why a slot fell
back to its template.

### 4.3 Identity as line art — the pinned line-art sheets (`coloring/sheets.js`)

Three sheets, each elected ONCE, GCS-pinned create-if-absent (the character-sheet election
pattern: `uploadBufferIfAbsent` + sidecar JSON, single winner under a race), and fail-open
except the hero's:

1. **Hero line sheet** — from the elected colour character sheet (reference) + the approved
   cover: "redraw this exact model sheet as coloring-book line art: the same three views,
   same proportions, same hair shape and length, the same outfit garment by garment
   ({outfit spec quoted as data}), pure black closed outlines on pure white, no shading, no
   grey, no text, two head insets kept". `CATALOG_COLORING_SHEET_CANDIDATES` (default 3)
   candidates, each judged against the colour sheet (identity, outfit slot by slot, three
   views present, no text) + the §4.6 metrics; the best passing one is elected to
   `catalog-assets/coloring-sheets/{COLORING_VERSION}/{anchorHash}-{sheetHash8}.png` (+ `.json`
   with the verdict, the outfit spec hash and the metrics). REQUIRED: no passing candidate
   fails the book `coloring_identity_failed` (`CATALOG_COLORING_SHEET_REQUIRED=0` degrades to
   an advisory and renders from the colour sheet alone). `/v13/prepare-identity` gains an
   optional `coloring: true` so the app can pre-build it at cover approval.
2. **Companion line sheet** — from the companion sheet + spec (creature or person), same
   recipe, pinned per theme + companion hash under `catalog-assets/coloring-companions/`.
   Fail-open (the companion then renders from the colour sheet, with an advisory).
3. **Theme border plate** — a decorative line-art frame of the theme's world motifs (from the
   world card + companion type + beat nouns: fences and wheat for the farm), 3:4, empty
   centre, no text; pinned per theme under `catalog-assets/coloring-borders/`. Used by the
   layout (§4.8) on the title, draw-your-own and colored-by pages and as the `pattern` page's
   reference. Fail-open (the layout falls back to a typeset rule frame).

The line sheets' hashes fold into the plan hash: a re-elected sheet re-keys every page.

### 4.4 `LINE_RULES` — the pinned line-art spec and the page prompt (`coloring/lineRules.js`, `coloring/render.js`)

A frozen spec object per band (the `TEXT_RULES` pattern in `shared/illustration/config.js`;
editing it bumps `COLORING_VERSION`):

| field | 1-3 | 4-5 | 6-7 | 8-10 |
|---|---|---|---|---|
| primary stroke (% of image width) | 1.1 | 0.9 | 0.7 | 0.55 |
| detail stroke (% width, never below) | 0.7 | 0.55 | 0.4 | 0.3 |
| subjects | 1 | 1–2 | 2–3 | 3+ |
| background | almost none | a few large shapes | a simple full scene | a detailed scene |
| smallest colorable area (% of page) | 4 | 2 | 1 | 0.5 |
| inner margin (% each side, nothing crosses) | 6 | 5 | 5 | 4 |

Rendered into the prompt as fixed blocks, in this order, after the scene:

- **LINE ART RULES** — "Clean, confident ink line art for a premium children's coloring book:
  smooth continuous outlines of even weight (about {primary}% of the image width; a 4-year-old
  colours with a crayon), a few lighter interior lines (never thinner than {detail}%) that give
  each area character; EVERY shape closed so colour cannot leak; pure black lines on pure
  white paper; NO shading, hatching, stippling, screentone, grey, gradient, texture or wash;
  NO solid black areas except tiny accents (pupils); large colourable areas; rounded, friendly
  storybook proportions matching the reference character's head-to-body ratio."
- **PAGE COMPOSITION** — the assigned shot size + placement, "one clear main subject, the
  environment simple, nothing crowded, nothing cut off, keep {margin}% clear inside every edge,
  no drawn frame or border, no vignette".
- **NO TEXT** — "absolutely no letters, words, numbers, signs, labels, logos or speech bubbles
  anywhere; a sign or banner in the scene is blank".
- **FINAL CHECK** — the four things the judge measures, restated: black-on-white only, every
  shape closed, no grey or fills, no text.

The medium language must OVERRIDE the renderer's frozen 3D-premium style, so the coloring
renderer does not go through `buildCharacterPrompt`: it assembles its own prompt (scene block
from the plan, CHARACTER / COMPANION / PROPS / CAST blocks in the Bible's structured style
with the outfit spec's colour words stripped, WORLD block from the world card with the palette
line dropped, then the four fixed blocks) and calls the shared primitive (§5.1) with
`imageConfig: { aspectRatio: '3:4', imageSize }` — 3:4 is the page's art box exactly (§4.8),
so a render is never stretched again. The reference pack, fixed order and labels: hero line
sheet (TRACE THIS IDENTITY), colour character sheet (identity aid), approved cover (identity
aid), companion line sheet (when planned), prop sheets (declared + carried), world plate
(GEOGRAPHY ONLY — never its colours or rendering), border plate (`pattern` pages only).

### 4.5 Rendering: candidates, concurrency, post-processing

Per page `CATALOG_COLORING_CANDIDATES` (default 2, clamped 1-3) concurrent renders, pages
in parallel under `CATALOG_RENDER_CONCURRENCY` (the illustrator's bound), every call
heartbeating the book context. Each returned image is (1) dimension-checked (3:4 ± 2%,
else the candidate fails `wrong aspect` — never resized to fit), (2) measured (§4.6),
(3) post-processed by `cleanLineArt`: grayscale at native resolution, pixels ≥ 235 → 255,
pixels ≤ 40 → 0, the band between untouched (anti-aliasing survives), isolated dark specks
≤ 3 px removed (gated `CATALOG_COLORING_DESPECKLE`, default on), encoded as 8-bit grayscale
PNG. A candidate keeps its own bytes at `page-{i}.c{k}.png` (repair pass P: `.r{P}c{k}.png`);
only the promoted one lands at `page-{i}.png` with its `.qa.json` marker (`coloringQaVersion`,
`contentHash`, verdict, metrics, `unresolved`). The safety ladder is the illustrator's:
`original` → `sanitized` (trigger words stripped from the moment only, pinned blocks intact)
→ `generic-safe`; a page accepted below `original` carries a stage `render` advisory.

### 4.6 Verification: the page verdict, the metrics, classification, repair (`coloring/pageQa.js`, `coloring/metrics.js`)

**The verdict** (`checkColoringPage`, strict JSON, `jsonQaGenerationConfig`, the line sheet +
colour sheet attached beside the render, the outfit spec and companion spec quoted as data):

| field | type | class when bad |
|---|---|---|
| `child_present`, `child_count` | bool, int | BLOCKING `child missing` / `child duplicated` (when the kind expects one); BLOCKING `unexpected person` on no-child kinds |
| `identity_match` | match/mismatch + notes (face, hair shape/length, build vs the line sheet) | BLOCKING `identity mismatch` |
| `outfit` | per slot match/mismatch/not_visible by cut, length, pattern (colour ignored) | BLOCKING `outfit mismatch: <slot>` |
| `companion` | present, look_match, count | BLOCKING `companion missing` / `companion look mismatch` / `companion duplicated` |
| `props` | per declared prop: present, as_text | BLOCKING declared missing; ADVISORY carried not visible; BLOCKING rendered as text |
| `extra_people` | int | BLOCKING `invented character` |
| `painted_text` | bool + transcription | BLOCKING `painted text` |
| `shading_present`, `solid_fills`, `open_shapes`, `frame_drawn` | bool | BLOCKING / BLOCKING / ADVISORY (`open_shapes` — the judge is soft on it; the metrics are the hard signal for the first two) / ADVISORY |
| `scene_match` | bool + note (the moment is what is drawn) | ADVISORY `scene drift` (shades selection, steers repair) |
| `complexity_fit` | too_simple/ok/too_busy for the band | ADVISORY |
| `scary_or_unsafe` | bool | BLOCKING |
| `child_bbox`, `companion_bbox` | soft | contact-sheet crops |

**The metrics** (pure, native resolution, fail-open): `grayRatio` (pixels 41–234; > 6% is
BLOCKING `grey shading present`, 3–6% advisory — anti-aliasing alone measures ≈ 1–3% on line
art), `inkRatio` (pixels ≤ 40; band bounds 3–14% for 1-5, 4–16% for 6-10; > 20% BLOCKING
`solid fills / too dense`, below the floor ADVISORY `too sparse`), `largestSolid` (connected
dark components on a ¼-scale mask; any component whose area exceeds 0.5% of the page with
bounding-box solidity > 0.6 is a fill → BLOCKING; strokes have low solidity), `strokeWidth`
(median distance-transform width of dark strokes as % of width; < 60% or > 180% of the band's
primary target → ADVISORY `stroke weight off spec`, and the input to the stroke set gate),
`frameRing` (dark density along a ring inside all four edges → ADVISORY `frame drawn`),
`marginBreach` (ink inside the pinned inner margin → ADVISORY). All thresholds are constants
verified in Phase 0 (§9) and named in the marker so a replay under a newer checker re-checks.

**Classification and selection.** Fixed defect strings, `classifyDefects` with a coloring
`BLOCKING_PREFIXES` list; candidates scored with `select.js`'s shape and a coloring
`WEIGHTS` table (blocking sinks below zero, advisories shade, `grayRatio` and `strokeWidth`
deviation charged linearly, unchecked ranks below checked); `pickBest` promotes; the repair
loop runs `CATALOG_COLORING_MAX_REPAIRS` (default 2, clamped 0-4) passes ONLY while blocking
defects remain, each pass N fresh candidates steered by a fixed `repairNote` per defect class
("the hair was drawn as a solid black mass — outline the hair shape and leave it white
inside", "grey shading was painted under the arm — remove all grey; lines only", "a word was
painted on the barn — the sign is blank", "the child's jacket is missing its hood — match the
LINE-ART MODEL SHEET garment by garment"). An unchecked repair never replaces a render whose
defects are known.

### 4.7 Set gates: the pages held to each other (`coloring/gates.js`)

1. **Contact-sheet gate** (kill-switch `CATALOG_COLORING_CONTACT_QA=0`): tiles the child crops
   of every child-bearing page beside the hero line sheet in one image (reuse
   `contactSheet.js`'s tiler), asks for `character_rendering` outliers (hair, proportions,
   outfit cut), re-renders flagged FRESH pages once against their own plan directive,
   `CATALOG_COLORING_CONTACT_MAX_RERENDERS` (default 3); a re-render with MORE blocking
   defects is never adopted. Same for companion crops beside the companion line sheet.
2. **Stroke-weight gate** (kill-switch `CATALOG_COLORING_STROKE_GATE=0`): every page's median
   `strokeWidth` vs the book's own median; outliers beyond ±35% re-render with a note that
   restates the target and cites the majority ("the other pages use a stroke about X% of the
   width — match them"); budget `CATALOG_COLORING_STROKE_MAX_RERENDERS` (default 2). The ink
   set gate's shape (ce-18) applied to line weight — uniform weight is most of what reads as
   "one artist drew this".

Both gates' verdicts ride the callback (`gates.contact`, `gates.stroke`), every finding as a
stage `coloringSetQa` advisory. Replayed cached pages are comparison references only.

### 4.8 The printed object (`coloring/layout.js`)

**Trim and bleed** unchanged: 8.5×11 in, 0.125 in bleed (interior page 8.75×11.25 in), Lulu
SKU `0850X1100BWSTDSS060UW444MXX` (saddle stitch, B&W 60# uncoated, colour cover), page
count a multiple of 4, minimum 8. Interior = coloring pages + 4 matter pages (24 for band
4-10, 20 for band 1-3).

**Page geometry.** Art box 7.5 × 9.75 in at 0.5 in from the left/right trim, from 0.75 in to
10.5 in vertically (inside Lulu's 0.5 in safety); the 3:4 render is scaled to the box width
(10 in tall) and the 0.125 in that overflows top and bottom is cropped by `sharp.extract`
before embedding — a 1.25% crop the prompt's 4–6% inner margin already protects. White bleed.
No band, no rule, no page number. One caption per page: the plan's `title` typeset in Kalam,
11 pt, black, centred at 0.5 in from the bottom trim (`CATALOG_COLORING_CAPTIONS=0` removes
it). Words are PDF type, never pixels (D5).

**Matter pages** (all typeset over the border plate, or a typeset double rule when the plate
failed): (1) title page — the book title, "COLORING BOOK", "This book belongs to" with a
rule line, the border plate around; (2) `meet` — the hero line sheet as the first coloring
page ("Meet {name}"); … coloring pages …; (n-1) "Draw what {name} saw next" — the border
plate with an empty centre; (n) "Colored by ______" + the brand line. The `meet` page is
counted among the coloring pages; the interior's final page count is padded with white pages
to a multiple of 4 (as today).

**The cover** (wrap 17.25 × 11.25 in, no spine; front = right half): background = the approved
cover art's dominant colour (sharp `stats()` dominant channel, clamped to a print-safe
lightness), the approved cover's OWN pixels (square) at 7.5 in wide centred with a 0.06 in
white keyline, title typeset above in the parent cover's title face and size rules
(`coverGenerator`'s typesetting helpers, exported), "COLORING BOOK" in small caps under it,
"A coloring book for {name}" and the brand below the art; ink colour chosen by the band's
luminance (white on dark, deep cocoa on light). Back cover: the same palette, the companion
line sheet's front view (or the hero's) as a white vignette panel, a two-line typeset blurb
("{n} new scenes from {world_name} — the moments between the pages of {title}"), no barcode,
no ISBN. `coverImageUrl` for the app is the front half rendered by sharp from the same
geometry (art + palette + SVG title with the Kalam face embedded as a base64 `@font-face`;
verify librsvg honours it in Phase 0, else a sans fallback — it is an admin thumbnail).
Previews: the first four coloring pages at 800 px.

### 4.9 Storage, keys, replay

```
children-jobs/{bookId}/coloring/{COLORING_VERSION}/{planHash}/
  plan.json                       the plan + moments + gate reasons + hashes (saveJson)
  page-{i}.png  (+ .qa.json)      promoted page + marker
  page-{i}.c{k}.png / .r{P}c{k}.png   scored candidates (kept)
  contact-hero.png / contact-companion.png   set-gate sheets
  interior.pdf  cover.pdf  cover-thumb.png  preview-{1..4}.png  manifest.json
catalog-assets/coloring-sheets/{COLORING_VERSION}/{anchorHash}-{h8}.png (+ .json)
catalog-assets/coloring-companions/{COLORING_VERSION}/{themeId}-{h8}.png (+ .json)
catalog-assets/coloring-borders/{COLORING_VERSION}/{themeId}-{h8}.png (+ .json)
```

`planHash = fnv1a(COLORING_VERSION | storyFingerprint | bibleHash | heroLineSheetHash |
companionLineSheetHash | borderPlateHash | LINE_RULES hash | plan JSON)`. A re-dispatch
without `forceNew` replays every page whose marker is current (`coloringQaVersion`,
`contentHash` match) and not `unresolved`, re-runs only the gates that had fresh pages, and
rebuilds the PDFs — so **Rebuild** in the admin is a plain re-dispatch. `forceNew` re-renders
everything under a fresh nonce folded into the key. `manifest.json` is the callback payload
minus signed URLs. Candidates get a 30-day lifecycle rule once the feature is stable
(open decision).

## 5. Worker changes

### 5.1 New module — `services/catalogEngine/coloring/`

| file | owns | pure? |
|---|---|---|
| `plan.js` | kinds, quotas by band, gap selection, composition rotation, `buildColoringPlan`, `planHash`, the ajv schema | yes |
| `moments.js` | templates per kind, the moment writer call, `duplicationGate`, proper-noun / brand / peril / text checks | gate pure; writer mocked |
| `lineRules.js` | `LINE_RULES` by band, `renderLineRulesBlock`, `renderCompositionBlock`, `NO_TEXT_BLOCK`, `FINAL_CHECK_BLOCK` | yes |
| `sheets.js` | hero / companion line sheets + border plate: prompts, election, paths, sidecars | election mocked |
| `render.js` | `buildPagePrompt`, `buildColoringReferencePack`, `renderPageCandidates` over the shared primitive, the safety ladder | prompt/pack pure |
| `metrics.js` | `measureLineArt` (grayRatio, inkRatio, largestSolid, strokeWidth, frameRing, marginBreach), `cleanLineArt`, `checkAspect` | yes (sharp on buffers) |
| `pageQa.js` | `checkColoringPage` (verdict schema, prompt, parse), `classifyColoringDefects`, `repairNote`, `COLORING_BLOCKING_PREFIXES` | prompt/classify pure |
| `select.js` | coloring `WEIGHTS` + `scoreColoringCandidate` feeding `illustrator/select.js` `pickBest` / `compareCandidates` | yes |
| `gates.js` | contact-sheet gate (hero + companion), stroke-weight gate | tiling pure; judge mocked |
| `layout.js` | `buildInteriorPdf`, `buildCoverWrapPdf`, `renderCoverThumbnail`, `renderPreviews`, geometry constants | yes |
| `index.js` | `generateColoringBook` orchestration, replay, `pickColoringCandidate`, `ColoringError` | — |

One shared refactor: generalize `callGeminiImageApi` (`illustrationGenerator.js`
L1152-1159 `imageConfig`, L1221-1223 the `imageSize` 400-retry, L1275-1345 the endpoint loop
— key pool, failover, NSFW typing, cost accounting) into an exported parts-based
`callGeminiImageParts(parts, {aspectRatio, imageSize, timeoutMs, abortSignal, costTracker,
label})`, and make `callGeminiImageApi` build its parts and call it. Byte-identical for every existing caller (a test asserts the
request body shape); the coloring renderer and the sheets use it. No second Gemini client.

Order of work in `index.js`: resolve story + pinned definition → Bible (`buildBookBible`) →
line sheets + border plate (concurrently) → plan → moments + gate → replay check → pages
(candidates → measure → clean → judge → score → promote → repair) → set gates → layout →
upload → manifest → callback. Progress stages: `identity` 0.05–0.15, `plan` 0.15–0.20,
`pages` 0.20–0.80 (per page), `gates` 0.80–0.88, `layout` 0.88–0.95, `upload` 0.95–1.0, every
model call touching the context; absolute timeout `CATALOG_COLORING_TIMEOUT_MINUTES`
(default 30).

### 5.2 Endpoints

**`POST /v13/generate-coloring-book`** (202 + callback; `authenticate`):

```
{ bookId, dispatchId?, story:{request,response}, profile, approvedCoverUrl,
  childPhotoUrls?, characterDescription?, pageCount?, pages?: [1..n subset],
  forceNew?, callbackUrl, progressCallbackUrl? }
```

Validation before the 202, the video route's order: kill-switch (503
`coloring_disabled`); `bookId` regex; `callbackUrl` required; `profile` normalized; `story`
pair required and resolved through `resolveStory` (`invalid_story`); the pinned definition
through `getBookForTag` (`missing_book_definition`, a retired plot included — a customer who
bought a since-retired book still gets its coloring book because the definition remains);
an `approvedCoverUrl` or a photo (`missing_identity_reference`); `pageCount` within the
band's allowed range (12–28, multiple of 4 after matter); `pages` a unique subset. 409 when
`coloring:{bookId}` is active. Response `{success, bookId, dispatchId, engine:'catalog-v13',
coloringVersion, plan:{band, pages}}`.

Callback — every key present on failure:

```
{ success, bookId, dispatchId, engine, coloringVersion, qaVersion, planHash, cached,
  interiorPdfUrl, coverPdfUrl, coverImageUrl, previewImageUrls, pageCount, coloringPageCount,
  pages:[{index, kind, anchor:{spreads:[k,k+1]|spread|null}, title, moment, momentSource:'writer'|'template',
          storageKey, url, qa:{pass, blocking:[], advisory:[], metrics:{grayRatio, inkRatio, strokeWidth}},
          candidates, repairs, cached}],
  plan:{hash, band, kinds:{...}, momentWriter:'gemini-2.5-flash'|'template', gateRejections:[{index, reasons}]},
  bookBible:{...summarizeBible, lineSheet:{url,hash,likeness}, companionLineSheet, borderPlate},
  gates:{contact, stroke}, unresolved:[{page, defects, candidates:[{storageKey,url,score}]}],
  advisories, warnings, costs, elapsedMs, failureCode, error }
```

Failure codes: `coloring_disabled` (sync 503), `invalid_story`, `missing_book_definition`,
`missing_identity_reference`, `coloring_identity_failed`, `coloring_unresolved`,
`coloring_pdf_failed`, `cancelled`, plus the inherited `identity_kit_failed`.

**`POST /v13/pick-coloring-candidate`** `{bookId, storageKey}` — a `page-{i}.c{k}.png` /
`.r{P}c{k}.png` key from an `unresolved` payload → promoted to `page-{i}.png` with an
admin-vouched marker; a re-dispatch without `forceNew` replays it into the PDFs.

**`POST /v13/cancel-coloring-book`** `{bookId}` — aborts the `coloring:{bookId}` context
(today's `/cancel-coloring-book`, moved under `/v13`, same body).

### 5.3 Deletions (the old implementation, in full)

- `services/coloringBookGenerator.js` — all 795 lines (trace mode, generate mode, the
  free-text planner, the pencil covers, the questionnaire back-cover planner, the threshold).
- `services/coloringBookLayout.js` — all 622 lines (the band layout, the legacy combined PDF,
  the programmatic fallbacks).
- `__tests__/services/coloringBookGenerator.test.js`.
- `server.js`: `POST /generate-coloring-book` (L1364-1669), `POST /cancel-coloring-book`
  (L1671-1687), `POST /rebuild-coloring-cover-pdf` (L2017-2090) → three 410 stubs naming the
  `/v13` replacements (the L302 / L1356 pattern). `coloringActiveJobKey` (L154-156) stays —
  the new run keys the same way.
- `CLAUDE.md`: the "Kept: `/generate-coloring-book` + coloring endpoints" line and the
  `coloringBookGenerator/Layout` mention under Kept services → the new module + endpoints.
- No `legacy.pdf` (the combined cover+interior PDF) is produced any more; the app's
  `coloring_book_pdf_url` column stops being written (companion doc).

`sharp`, `pdf-lib`, `p-limit` stay; nothing is added to `package.json`.

### 5.4 Versions, flags, cost rates

`versions.js`: `COLORING_VERSION = 'cb-1'` (owns the page cache namespace and every pinned
prompt block, `LINE_RULES`, the layout geometry — bump on any change) and
`COLORING_QA_VERSION = 'cq-1'` (the verdict + metric thresholds — a replay under a newer
checker re-checks).

`flags.js` (everything ON by default; envs are kill-switches, the repo rule):

| env | default | meaning |
|---|---|---|
| `CATALOG_COLORING_BOOK=0` | on | 503 the endpoints |
| `CATALOG_COLORING_CANDIDATES` | 2 (1-3) | candidates per page |
| `CATALOG_COLORING_MAX_REPAIRS` | 2 (0-4) | repair passes while blocking defects remain |
| `CATALOG_COLORING_MOMENT_WRITER=0` | on | template lines only |
| `CATALOG_COLORING_SHEET_CANDIDATES` | 3 (1-4) | line-sheet candidates |
| `CATALOG_COLORING_SHEET_REQUIRED=0` | on | degrade a failed hero line sheet to an advisory |
| `CATALOG_COLORING_CONTACT_QA=0`, `CATALOG_COLORING_CONTACT_MAX_RERENDERS` | on, 3 | contact-sheet gate |
| `CATALOG_COLORING_STROKE_GATE=0`, `CATALOG_COLORING_STROKE_MAX_RERENDERS` | on, 2 | stroke-weight gate |
| `CATALOG_COLORING_IMAGE_SIZE` | `2K` (`1K`\|`2K`\|`4K`) | requested output size; a model that rejects the field renders at default (folded into the key) |
| `CATALOG_COLORING_DESPECKLE=0` | on | speck removal in `cleanLineArt` |
| `CATALOG_COLORING_CAPTIONS=0` | on | the typeset page caption |
| `CATALOG_COLORING_PAGES` | by band | coloring-page count override |
| `CATALOG_COLORING_SHIP_ON_EXHAUSTION=1` | off | ship blocking residuals with a stage `shipPolicy` advisory |
| `CATALOG_COLORING_TIMEOUT_MINUTES` | 30 | absolute run timeout |

`costTracker.js` RATES: add `gemini-3.1-flash-image:2K` (**verify** the published 2K token
count — the 4K entry is 2,520 tokens at $60/M; 2K should be about a quarter of that) so a
2K page is billed correctly instead of at the 1K rate.

## 6. Cross-repo contract (what the app must do — detail in the companion doc)

1. Send the V1.3 inputs: the chosen story pair, the normalized profile, the re-signed
   `approvedCoverUrl` (the 7-day signature bug applies), `childPhotoUrls`,
   `characterDescription`, a `dispatchId` reserved on the `ColoringBook` row before the call,
   `pageCount` from the band's product constant.
2. Guard before dispatch: parent `complete`, a story pair (`no_story`), an approved cover
   (`no_anchor` — the line sheet derives from the character sheet, which derives from the
   cover), no live dispatch (`in_flight`).
3. Persist the callback's page manifest, plan, Bible summary, gates, unresolved list,
   advisories and costs on the `ColoringBook` row (new JSON columns; the Lulu lifecycle, cart
   links and shipping override stay where they are), reject `stale_dispatch`, map
   `coloring_unresolved` to status `unresolved` with the candidates, and drop the legacy PDF
   column + the raw `children_books.coloring_book_pdf_url` write.
4. Admin: **Pick** (`/v13/pick-coloring-candidate`) then re-dispatch; **Rebuild** = re-dispatch
   without `forceNew`; **Regenerate** = `forceNew`; the page grid; no more "rebuild cover".
5. Cron: per-parent concurrency (the worker keys `coloring:{bookId}`), stale threshold above
   the worker's absolute timeout, bounded retries.

## 7. Mechanics, cost, time

**Cost per 20-page book at N = 2, 2K output** (**verify** the 2K rate; at the 1K rate the
image line halves): pages 40 × ≈ $0.04 ≈ $1.60; repairs ≈ 6 renders ≈ $0.25; judge calls
≈ 50 × $0.003 ≈ $0.15; line sheets (hero 3 + companion 3 + border 1, amortized per anchor /
theme) ≈ $0.15 on the first book, ≈ $0 after; set gates + moment writer ≈ $0.05. **≈ $2.2 per
book** (≈ $1.4 at 1K), against $14.90 retail. The old path cost ≈ $0.40 and shipped
unverified pages with a stretched aspect.

**Time**: 20 pages × 2 candidates at concurrency 6 ≈ 4 rounds × 40 s + judging ≈ 4 min,
line sheets ≈ 1 min (first book per anchor), repairs + gates ≈ 1–2 min, PDFs + upload
< 30 s → **6–9 minutes**, inside the 30-minute absolute timeout and heartbeating throughout
(a run killed by the idle watchdog posts no callback — the 2026-09-03 probe lesson).

**Versioning**: `COLORING_VERSION` on the cache namespace; `COLORING_QA_VERSION` on the
markers; the line sheets pinned per version so a `cb-2` re-elects; the plan hash folds every
input hash so any upstream change (new manuscript, re-elected character sheet, edited world
card via `STYLE_VERSION`, a Catalog Studio companion rename) re-keys automatically.

## 8. What this plan deliberately does NOT do

- **No `trace` mode** (converting the book's own spreads to line art) — the product is scenes
  the book does not contain; the old mode is deleted, not kept as a fallback.
- **No free-text scene invention.** The writer phrases a planned kind; it never picks the
  scene, and the gate can always fall back to the template.
- **No new plot.** Every kind is a portrait, a transition, a prologue/epilogue or a parallel
  moment. No new events, problems, characters, food outside evidence, or peril.
- **No model-drawn cover or title.** The cover is the parent's approved pixels plus type.
- **No pencil / grey "finished artwork" anywhere.** Line art inside, colour outside.
- **No questionnaire-driven back cover.** Personalization reaches the pages through the
  story's validated evidence (the comfort object on hero pages and the still life); the back
  cover is deterministic.
- **No Art Bench probe surface** for coloring pages in cb-1 — `pages` subset + `forceNew`
  give an admin the iteration loop; a bench card is a follow-up.
- **No customer-facing preview flow** beyond what the order page shows today (the companion
  doc lists the copy and sample-image changes only).

## 9. Order & tests

0. **Bake-off spike (2 days, no product change).** A scratch script (not committed to
   `services/`) runs three real finished books (bands 1-3, 4-5, 8-10; one with a comfort
   object, one farm book for the human companion) through: the hero line-sheet recipe, six
   planned pages each with the template moments, at 1K and 2K, on `gemini-3.1-flash-image`
   (and `gpt-image-2` through the edits endpoint if the key is at hand — line-art cleanliness
   is a known strength and the adapter seam in §5.1 makes it a config value). Measure every
   output with `metrics.js`, judge with the §4.6 prompt, and PRINT four pages on 60# paper at
   8.5×11 to judge stroke weight and speck. Decide: image size default, the `LINE_RULES`
   stroke percentages, the metric thresholds, whether librsvg honours the embedded font for the
   thumbnail. Output `docs/audits/coloring-bakeoff.md`.
1. **`plan.js` + `moments.js` gate + `lineRules.js` (pure).** Tests
   (`__tests__/services/catalogEngine/coloring/`): quotas per band on real catalog books;
   determinism (same inputs → same JSON and hash; a changed spread text → a new hash); no
   adjacent kind repeats; gap uniqueness; band 1-3 exclusions; the gate rejects a beat
   paraphrase, a copied 4-gram, an invented proper noun, a brand, a peril word, a quoted
   string, and accepts every template line for all 228 books (a full-catalog sweep like the
   sidecar coverage test); `LINE_RULES` blocks are byte-stable snapshots.
2. **`metrics.js`** on synthetic PNGs built with sharp: a clean-line page passes; a grey-wash
   page fails `grey shading`; a solid black disc fails `solid fills`; a hairline page reads a
   low `strokeWidth`; a framed page trips `frameRing`; `cleanLineArt` leaves 41–234 untouched
   and snaps the rest; `checkAspect` rejects 1:1.
3. **`sheets.js`, `render.js`, `pageQa.js`, `select.js`** with mocked `callGeminiImageParts`
   and judge: prompt block order and reference-pack order/labels; colour words stripped from
   the outfit spec; verdict → defect strings → classes; every repair note per class; scoring
   sinks blocking, prefers lower `grayRatio`; unchecked never outranks checked; the safety
   ladder's advisory; election is single-winner (`uploadBufferIfAbsent` race test, the world
   plate's pattern); a failed hero sheet → `coloring_identity_failed` unless degraded.
4. **`gates.js` + `layout.js`.** Contact tiling; stroke outliers; a worse re-render never
   adopted; interior page sizes with bleed, art-box geometry, the 1.25% crop, caption
   position, page count multiple of 4 and ≥ 8, `meet` first, matter last, no `drawText` on a
   coloring page beyond the caption; cover wrap dimensions, front-half geometry, palette
   luminance → ink colour, no text on the back beyond the typeset blurb.
5. **`index.js` + the three routes + the `callGeminiImageParts` extraction + versions/flags/
   rates + deletions/410s.** Tests (`server.test.js` pattern + a new
   `serverColoringBook.test.js`): every validation before the 202; 409 on a live key; the
   callback shape on success / `coloring_unresolved` / `coloring_identity_failed`; `cached:
   true` replay with no image call; pick-candidate promotes with the admin marker; the old
   routes answer 410; `generateIllustration`'s request body is byte-identical before/after
   the extraction. *Deploy the worker once* (the app's cron marks the brief 410 window's
   dispatches failed and retries them after the app deploy — bounded by the queue's retry
   rule).
6. **App wiring** — companion doc changes 1–7. *Deploy the app.*
7. **Validation recipe.** The three bake-off books plus one with a person companion and one
   band 1-3 book: assert per callback `unresolved` empty, every page `qa.pass`, `grayRatio`
   < 3% on every page, stroke gate no outliers, `pageCount` a multiple of 4, cost under the
   cap; order one physical proof from Lulu per band and review it on paper before the flag
   goes on for customers. Canary: ship with `CATALOG_COLORING_BOOK=0`, flip on for admin
   generation first, then for the paid-item queue.

## 10. Open decisions (defaults chosen — flag if you disagree)

1. **Page count.** 20 coloring pages (24 interior) for bands 4-10, 16 (20) for 1-3. The old
   product printed 16 + matter = 20; Lulu's price for 24 vs 20 saddle-stitched pages is a few
   cents. Env-overridable.
2. **Captions on pages?** Default yes (Kalam, 11 pt, bottom margin) — they carry the story
   link ("On the way to the henhouse") at zero visual cost. `CATALOG_COLORING_CAPTIONS=0`.
3. **Image size.** Default `2K` pending the bake-off print test; 1K line art at 8.5×11 is
   ≈ 120 dpi and shows on paper.
4. **Moment writer model.** `gemini-2.5-flash` strict JSON (the classifier pattern) rather
   than the `gpt-5.4` writer — it phrases, it does not write prose; switchable by a constant.
5. **Double-sided pages.** Yes (Lulu's coloring default; single-sided doubles the page count).
   The title page carries a one-line "crayons and pencils work best" note; marker bleed-through
   on 60# is accepted.
6. **Cover reframing.** Typeset palette bands around the square art (deterministic), not an
   outpainted full-bleed cover; an outpaint variant can be added behind a flag later if the
   bands look plain on a proof.
7. **The `meet` page.** In (the child colours their own model sheet — it is also the
   reference that makes every other page's hero recognizable to them).
8. **Pattern page for 8-10.** In, one page, from the border plate.
9. **Auto-generate on parent completion.** Keep today's hook (the paid add-on is the trigger;
   the hook only pre-warms) but switch it to `forceNew: false` so a parent regeneration that
   did not change the story replays instead of re-spending.
10. **Candidate retention.** 30-day lifecycle on `.c{k}` bytes once stable; promoted pages,
    sheets and PDFs are kept.
11. **`gpt-image-2` as a second renderer.** Only if the bake-off shows a clear cleanliness win;
    the §5.1 seam is the only thing that must exist for it.

---

## Appendix A — evidence index (why each old piece goes)

- Free-text scene invention at temperature 0.9 from a four-spread synopsis, JSON parsed
  without a schema: `services/coloringBookGenerator.js` L340-409; the app's synopsis is the
  first four spreads' text sliced to 400 chars (`giftmybook-standalone/server/services/
  coloringBookGeneration.js` L50-55).
- Identity from the raw photo + a legacy `characterRefUrl`, no sheet, no outfit spec, no
  companion: L222-246; app payload L44-48.
- Hard threshold as the line-art mechanism, applied twice: L16-22 (`enforceBlackAndWhite`),
  `coloringBookLayout.js` L105-108 and L200-203; the dark-pixel retry L141-182.
- No aspect ratio requested (`callGeminiImage` L103-114, `generationConfig` only), image drawn
  into a 612×744 pt box: `coloringBookLayout.js` L217-218.
- No QA of any kind on pages: `generateOriginalColoringPages` L284-327 returns whatever came
  back.
- The navy caption band: `coloringBookLayout.js` L119 and L221.
- The pencil cover that re-letters the title: L439-476 (title rule L454-456); the
  questionnaire back-cover planner L522-599; from-scratch cover prompts L697-752.
- Three PDFs including a combined "legacy" one: `server.js` L1562-1566, uploaded L1576-1583;
  persisted through a raw SQL update on `children_books.coloring_book_pdf_url`
  (`children.js` L1354-1359).
- A globally serial cron queue with a 100-minute stale threshold and `sceneCount: 16`:
  `cron/coloringBookQueue.js` L18, L56-61; `coloringBookGeneration.js` L114.
- The reusable machinery this plan stands on: `illustrator/bible/index.js` (L133, L282, L371,
  L411), `illustrator/spreadQa.js` (`checkSpreadRenderV2`, `classifyDefects`), `illustrator/
  select.js`, `illustrator/contactSheet.js`, `illustrator/metrics.js`, `illustrator/scenes.js`
  (L27, L71, L89, L140), `worldCards.js`, `shared/llm/geminiJson.js`, `illustrationGenerator.js`
  L1152-1159 / L1221-1223 / L1275-1345, `gcsStorage.js` (`uploadBufferIfAbsent`, `saveJson`, `loadJson`), `server.js`
  L891-1040 (the endpoint pattern), `versions.js`, `flags.js`, `costTracker.js` L16-28.
