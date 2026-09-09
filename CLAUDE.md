# giftmybook-children-worker

Cloud Run microservice that generates personalized children's books on the
**Catalog Engine (V1.3)** — a fixed catalog of 228 pre-authored plots rendered
per child. The AI never invents or selects a plot.

## Architecture

- **Express server** on port 8080 with API key auth (`x-api-key` header)
- **CommonJS modules** throughout (no ESM)
- **Flow**: `/v13/select-books` (sync, deterministic, no LLM) →
  `/v13/generate-stories` (202 + callback, 3 parallel validated stories) →
  `/generate-book` (202 + callbacks, illustrates the CHOSEN story → PDFs)

The **2026-08 cutover** deleted the entire generative writer + illustrator
(`bookPipelineV3` with its judge panels/gates/art director, `storyPlanner`,
the legacy `prompts/` directory) and all game-asset generation. The handoff
spec lives in `docs/RUNTIME_CONTRACT_V1_3.md` + `docs/WRITER_HANDOFF_V1_3_README.md`.

## Catalog Engine (`services/catalogEngine/`)

- `data/catalog.json` — the frozen 12-theme / 228-book / 12-beat catalog
  (age bands `1-3`/`4-5`/`6-7`/`8-10`). **Never edit plots.** Legacy book ids
  keep `2_3`; route by the catalog's age-band KEY, never by parsing ids.
- `data/writerEngine.system.md` — the LOCKED Writer Engine V1.3 system prompt.
  Any edit bumps `WRITER_ENGINE_VERSION` (versions.js).
- `data/ageEngines.json` — per-band word budgets + exact-age calibration for
  ages 1/2/3 (`ageBounds.js` holds the machine-checkable numbers; a test keeps
  the two consistent).
- `catalog.js` — loader with boot invariant validation (12 themes, 228 unique
  books, 12 ordered beats each — ported from the handoff's validate_release.py).
- `catalogOverlay.js` — **Catalog Studio** (admin plot editing): versioned
  PROSE patches over the frozen catalog — allowlisted fields only (theme
  display/world/companion naming; book title_template, premise, refrain
  text+spreads, beat text). Structure (ids, bands, archetypes, 12/228/12)
  is rejected. The MERGED catalog must re-pass every boot invariant before
  activation; blobs persist in GCS by content hash with an `active.json`
  pointer (restored at boot by `initCatalogOverlay`, fail-safe to base;
  every instance also polls the pointer — `startCatalogOverlayWatch`,
  `CATALOG_OVERLAY_POLL_SECONDS` default 60, 0 disables — so the warm
  instances that did not serve the activate call converge within the
  interval). Every key check is an own-property check (`__proto__` /
  `constructor` patch keys are hostile input, never prototype writes);
  `title_template` takes exactly one `{name}` and no other placeholder; a
  patched refrain must fit the band's tightest per-spread word max.
  Every request pins `versions.catalog = <base>+<hash8>`; stored stories
  re-validate AND illustrate against their PINNED definitions
  (`getBookForTag`, small LRU) so reshaping a theme never breaks earlier
  stories — a pinned tag that no longer resolves HARD-FAILS
  (`missing_book_definition`, in `/v13/render-spreads` too), never a silent
  fallback to current beats. Endpoints: GET `/v13/catalog`, POST
  `/v13/catalog-overlay/{validate,activate,deactivate}`. Kill-switch
  `CATALOG_OVERLAY=0`. catalog.json itself stays frozen in git. A book
  patch may also set `retired: true` — the plot's SOFT DELETE: it leaves
  selection/eligibility/band counts immediately AND `buildStoryRequest`
  refuses fresh generation by id (customers can never get it again) while
  its definition remains so stored stories keep validating and printing;
  bands may have 0, 1, or 2 active books. Selection returns up to 3 distinct
  active books and rejects empty bands with 422. `retired: false` restores.
- `profile.js` — deterministic normalization (NFC, control-char rejection,
  dedupe, length caps). No LLM. Profile strings are data, never instructions.
- `selection.js` — fit-weighted candidate selection: the handoff's exact
  scoring formula, archetype diversity, seeded shuffle for TIE-BREAKS ONLY
  (`fnv1a(sessionId|catalogVersion|selectorVersion)`); insufficient-fit signal.
  The caller persists the slate BEFORE generation; refresh never reselects.
- `writer.js` — one pinned request per candidate (engine + age engine + book
  definition + approved map + profile + rendered title) on
  `CATALOG_WRITER_MODEL` (default `gpt-5.4`, via `shared/llm/openaiClient`,
  Gemini fallback disabled). The pinned profile offers only details the
  book's map can legally use, capped at `targets.max_details`
  (`selectOfferedDetails` — deterministic; makes the caps structurally
  satisfiable), and the map prompt carries an explicit HARD LIMITS line.
  Structural retries with the validation errors fed back at lower
  temperature (`CATALOG_WRITER_MAX_ATTEMPTS`, default 3 attempts total);
  after that, targeted repair passes (`CATALOG_WRITER_MAX_REPAIRS`, default
  2, contract-sanctioned) fix bounded failures only — word bounds, evidence
  caps/legality, banned terms, leakage (`isRepairable`) — with minimal
  edits on the model's own response, fully re-validated each pass (a pass
  that still carries bounded violations inside the minimal-edit boundary
  becomes the next pass's base; one that breaks the boundary or a
  non-repairable check is discarded); plot-level failures never reach
  repair. A candidate that exhausts both budgets fails — never a silent
  plot substitution. Since 2026-09-07 a missing LITERAL beat anchor (the
  companion's proper name on a spread whose beat names them; the world
  name anywhere) and a mangled `versions` echo are bounded too — the
  printed-offer path (`upsellOffer.js`, below) exhausted three full
  rewrites over ONE dropped companion name, and the repair pass built for
  exactly that kind of edit never ran; the delta boundary pins a name fix
  to the implicated spread (world name: spread 1 or 12) and an echo fix
  to zero prose changes. Every model call heartbeats through `onProgress`
  so retries + repairs + polish can never outlast the server's idle
  watchdog mid-story (a story killed there posts no callback). The tuning overlay is framed SCOPE-subordinate (binding on
  prose, never on plot/refrain/title/slots/contract), restated at the END
  of the user prompt (`buildStyleCheckpoint` — NON-NEGOTIABLE lines
  verbatim), and, when an overlay is pinned, a validated story gets ONE
  style-polish call (`maybePolish`, kill-switch `CATALOG_STYLE_POLISH=0`)
  that rewrites prose only and ships only if it re-passes the full
  validation with identical personalization evidence — a good story is
  never lost to polish (`polished: true` on the result when it lands).
- `storyValidation.js` — the 10-step deterministic sequence: ajv schema →
  identity/version echo → 12 ordered spreads → exact title equality → refrain
  exact text + placement → accidental doubled words (5c, 2026-09-03:
  "check check" satisfied every earlier check and painted faithfully into
  embedded art; whitespace-only immediate repeats fail REPAIRABLY, every
  VERBATIM-REQUIRED string is masked first — refrain, child name, world +
  companion names, evidence source_values, so a child named "Jo Jo" or a
  "choo choo train" object never creates an unrepairable conflict —
  punctuated deliberate repeats — "plink, plink" — stay legal, and stored
  pairs skip the check so already-sold books keep printing) → exact-age word bounds → evidence-vs-map legality →
  evidence-to-spread text alignment (a literal evidence value may occur ONLY
  on spreads its evidence declares — every path, first-pass included, holds
  the same invariant) → callback-before-introduction + caps → banned
  brand/IP lexicon (`data/bannedBrands.json`) + unused-detail leakage.
- `augments.js` — per-book sidecars joined by `book_id`:
  `data/augments/approved/{book_id}.json` ({selection_profile,
  personalization_map}) schema-validated at boot; `data/augments/drafts/` is
  NEVER loaded. No approved map ⇒ the book generates **name-only** — maps are
  never fabricated at runtime.
- `upsellOffer.js` — the **printed offer** (`/upsell/{bookId}/{index}` QR on
  the interior's upsell spread): a cover whose title has no catalog plot.
  `prepareOfferDefinition` authors ONE private, immutable definition for
  that exact offer + child (Gemini reads the cover; the advertised title is
  LOCKED by the caller and never re-transcribed; beat numbers are coerced,
  never re-ordered), content-hashed to
  `children-upsell-definitions/{sha256}.json` with a pointer per
  (source book, index, title, band, name, image), and `generateOfferStory`
  writes it through the ordinary writer + validation with the
  `upsell-v1-{hash}` catalog tag pinned (`getBookForTag` resolves it for
  print). Requested by `/v13/generate-stories` with
  `bookIds: ['printed-upsell']` + `upsellOffer`; failures carry the
  validation errors.
- `pipeline.js` — full-book run: resolve story (request pair → checkpoint →
  fresh) → illustrate → `assemblePdf` (minPages 32; 12 spreads + front matter)
  → cover PDF (`coverGenerator`, unchanged) → **Lulu preflight** → callback
  payload. Failure codes: `invalid_story`, `missing_book_definition`,
  `interior_pdf_failed`, `cover_pdf_failed`; `StoryGenerationError` carries
  `validationErrors`. **The print spec (`services/luluSpec.js`,
  2026-09-08)** is the ONE place Lulu's numbers live — 0.125" bleed, the
  0.5" safety margin + 0.2" gutter, 300 ppi, the two picture-book
  products by the app's `bindingType` (`0850X0850FCSTDPB080CW444GXX`
  perfect bound, 32–800 pages, spine = pages / 444 + 0.06";
  `0850X0850FCSTDCW080CW444GXX` casewrap, 24–800 pages, 0.875" beyond the
  trim on every outer edge, spine from Lulu's stepped table — 24–84 pages
  0.25", 85–140 0.5" … — so 8.5×8.5 at 32 pages is Lulu's 19.0×10.25"
  canvas; 0.75" cover safety on a casewrap, no spine text under 80 pages)
  — and `layoutEngine` (interior: `SAFE` = bleed + 0.7"), `coverGenerator`
  (the wrap canvas via `coverGeometry`) and `preflightPictureBook` all read
  from it, so the file we build and the file we check can never disagree.
  The preflight runs on BOTH PDFs before upload (page count in the
  product's range and even, every interior page at trim + bleed, the cover
  exactly ONE page of the geometry its page count demands, every
  non-base-14 font embedded) and fails the run `interior_pdf_failed` /
  `cover_pdf_failed` (the app's existing resume contract; deterministic, so
  the cover half is never retried with saved artwork, and the failure
  carries the verdict as `preflight`); the verdict rides
  the completion callback as `preflight` (product, SKU, measured/expected
  sizes, `notes` naming the base-14 fonts still in use — Helvetica-Bold on
  the upsell label, Times on the designed back cover — which Lulu's
  normalizer substitutes; the bylines/footers embed Liberation Sans).
  `/rebuild-cover-pdf` runs the cover half against the interior's page
  count and echoes `preflight` too. The same change moved the interior's
  upsell spread inside the safety margin (its cards sat 0.25" and its
  footer 0.06" inside the trim) and onto a VERSO so its two pages face
  each other (page 1 prints on the right; with 12 spreads it used to open
  on recto 29), the title-page byline onto the safety line, and the
  casewrap spine to Lulu's exact 0.25" (a "6 mm" 17pt spine left the
  canvas 1pt short).
  **The printed picture (pq-1, 2026-09-09 — `docs/PRINT_QUALITY_PLAN.md`,
  proofs per `docs/PRINT_PROOF_CHECKLIST.md`)**: what the reader SEES on
  paper, implemented with NO `STYLE_VERSION` bump — a book rendered
  before pq-1 replays its own pixels and only fresh renders take the new
  tiers and prompt lines. (1) RESOLUTION: the text-free layouts get a
  print tier like the embedded path's 4K — `half` (wide) 4K, `caption`
  (square) 2K by default (`flags.printImageSize`; the model's 1K default
  printed at ≈ 59 / 117 dpi effective) with the same resolution guard
  (`minPrintRenderHeight`), folded into the render key as `-is{tier}`;
  `renderStorySpreads` hands the replay the UN-folded key as the last
  legacy fallback (`legacyKeysFor` — `legacyUnanchoredKey` is a list now,
  in `readReviewedRender` too), so an older book's cached art is replayed,
  never re-rendered or re-keyed (`forceRerender` upgrades). The front
  cover requests 2K (`coverImageSize`; it was 1K ≈ 120 dpi on the 8.5"
  front and it is the identity anchor). `layoutEngine` records every
  printed art page's source pixels (`opts.pageReport`) and the preflight
  reports effective PPI per page + the cover (`preflight.pages`, `minPpi`,
  `coverPpi`): a WARNING below 234 (the 4K spread standard), an ERROR only
  under `CATALOG_PRINT_PPI_FLOOR` (default 0 — an older book must still
  rebuild its PDFs). (2) THE PHYSICAL PAGE: every wide render's prompt
  states the print realities (the top/bottom 7% cut, the outer 2% trim,
  the FOLD at x = 50% that no face, companion or named object may cross
  — `opts.printSafety`), and `metrics.bboxRules` holds the child AND the
  cast boxes QA already returns (`companionBox`, `propBoxes`) to the fold
  band ([0.46, 0.54], subjects narrower than 60% of the frame) and the
  print-safe zone — `child_on_fold` / `companion_on_fold` /
  `prop_on_fold:<name>` / `companion_outside_safe_zone` /
  `prop_outside_safe_zone:<name>` as stage `composition` advisories that
  shade selection (`foldFail` −10, `castSafeZoneFail` −5), never fail a
  book; a caller that passes no cast boxes gets the exact pre-pq-1
  object. `illustrator/printPreview.js` uploads a PRINT-CROP preview
  beside every shipped render (`<renderKey>.print.jpg`: the 2:1 page crop
  the layout engine prints with trim / safety / fold guides; the half
  layout's text page dimmed) — `printPreviewUrls` + `entries[].
  printPreviewUrl` on the completion callback, `renders[].printPreviewUrl`
  on probes; the app persists them and its admin page shows them. (3) THE
  COVER WRAP: `coverGenerator.extendWithOutpaint` paints the bleed/wrap
  band as ART — the copy + blur band is the edit base, ONE bounded image
  edit (`callGeminiImageParts`, 1:1 on a square-padded canvas so nothing
  distorts, `planOutpaint`) repaints only the band, the ORIGINAL trim
  pixels are pasted back over the centre, and a flat/blank band or any
  error falls back to copy + blur with a warning (`coverWrapNotes`);
  casewraps only by default (`CATALOG_COVER_OUTPAINT`: `casewrap` | `all`
  | `0`), `preflight.coverWrap` says which method each panel got. (4)
  COLOUR: every page JPEG and the cover carry an sRGB ICC profile
  (`withIccProfile('srgb')`); `CATALOG_PRINT_SHADOW_LIFT` (default 0 —
  a PROOF decision) is a print-only shadow lift in `encodeFullBleedJpeg`
  (`applyShadowLift`, never on previews); the preflight warns when a
  page's share of pixels above 0.9 saturation exceeds
  `GUIDELINES.gamutWarnShare` (0.35) — the press will dull it. (5) The
  app validates every children's book pair with Lulu's own
  `validate-interior` / `validate-cover` before every bulk send and the
  admin book page's direct print action — the two paths that send
  children's books to Lulu, both on the ONE SKU table
  (`services/luluPreflight.js` there: an explicit ERROR holds the book
  back with Lulu's reasons, a partially rejected batch reports the
  held-back books as `ineligible`, an unavailable or stalled check never
  blocks — one deadline covers every request — and the verdict rides
  `generationProgress.luluValidation`). Kill-switches:
  `CATALOG_PRINT_IMAGE_SIZE=0`, `CATALOG_FOLD_SAFETY=0`,
  `CATALOG_PRINT_PREVIEWS=0`, `CATALOG_COVER_OUTPAINT=0`,
  `CATALOG_COVER_IMAGE_SIZE=0`, app `LULU_PREVALIDATE=0`.
- `illustrator/` — the slim illustrator: the fixed BEAT is the scene
  (`scenes.js`), identity anchors on the parent-approved cover (raw photo only
  as coverless-test fallback; NO anchor at all fails the run with
  `missing_identity_reference`), one render + ONE vision QA check
  (`spreadQa.js`: painted text / missing / duplicated child / broken medium) +
  a bounded corrective re-render loop (`CATALOG_SPREAD_QA_MAX_REPAIRS`,
  default 1 since #295, clamped 0-4 — each pass steered by the LATEST
  check's defects), then ship-with-advisory (`qaAdvisories`). Renders
  cache at `children-jobs/{bookId}/ce-renders/{STYLE_VERSION}/{storyHash}/spread-N.{aspect}.png`
  — the story fingerprint (definition id + spread texts) means a regenerated
  manuscript re-renders while an unchanged story replays; a `.qa.json`
  marker beside each render records QA completion (a cached render without
  one is re-checked, never silently approved); bump
  `STYLE_VERSION` (versions.js) to invalidate globally. Text is
  LAYOUT-AWARE (`ce-2`, 2026-08-31): `embedded` renders paint the story
  text INTO the art via Gemini (the renderer's legacy `embedText` path —
  typography rules + OCR `verifyImageText` with extra retries) and spread
  QA transcribes + `compareTexts`-verifies it (missing/garbled painted
  text is the defect). Placement is HARDENED (`ce-3`): the painted text is
  ONE block on ONE side (left or right 35%), over continuous artwork —
  split-across-both-sides or a blank letterbox band is a QA defect
  (`text_split_both_sides` / `text_on_band`) with its own repair note.
  Typography is LOCKED (`ce-4`): text lines
  must be straight, level, LEFT-ALIGNED to one shared margin with even
  spacing, and the whole book uses ONE font, ONE size, ONE color — the
  pinned `TEXT_RULES` spec (fontStyle/fontSize/fontColor/textAlignment/
  typographyConsistency in `shared/illustration/config.js`) rides every
  stateless render, per-scene color retinting is gone, and QA gates
  `text_lines_misaligned` / `text_style_inconsistent` with their own
  repair notes. Such entries carry `textEmbeddedInArt: true`
  through storyContent so `layoutEmbeddedSpread` / the overlay preview
  embed the art full-bleed and NEVER typeset the caption over it again.
  `caption` renders keep D5 — words are PDF type, never pixels
  (`skipTextEmbed`; painted text is the defect).
  `illustrator/tuning.js` is the **Art Tuning Layer** (see below): when an
  `illustrationTuning` overlay rides the request, its framed block —
  BINDING on rendering style + cross-spread continuity, yielding only to
  the action/identity/count/text/medium/safety rules (`ce-7`; previously a
  "LOWEST priority" frame the model ignored) — is re-attached by
  `buildCharacterPrompt` as the FULL prompt's LAST block (mid-prompt it
  drowned under the lock/checklist blocks), rides the generic-safe NSFW
  fallback via `safeFallbackSuffix`, and the cache path's version segment
  becomes `{STYLE_VERSION}+{label.hash8}` — tuned and untuned renders can
  never replay each other, and `none` keeps the legacy path byte-identical.
  Every render also pins a per-anchor **OUTFIT LOCK** (`ce-7`, hermetic
  since `ce-8`, `illustrator/outfitLock.js`): one vision read of the
  identity anchor's clothing as a STRUCTURED per-slot spec
  (top/bottom/footwear/outerwear/accessories, each with color, cut, and the
  LENGTH words drift lives in; a slot the anchor crops — the cover usually
  crops the legs — gets ONE elected style-consistent completion marked
  `inferred`, because an unspecified garment is per-spread freedom),
  elected once per anchor path in GCS
  (`catalog-assets/outfit-locks/v2/{anchorHash}.json`, create-if-absent
  single-winner like the world plate, fail-open null) and passed as
  `characterOutfit` on every stateless render — arming the renderer's
  per-garment OUTFIT LOCK/COLOR VERIFICATION machinery that was otherwise
  dormant; the spec's content hash folds into the render cache key
  (`-o{hash}`), kill-switch `CATALOG_OUTFIT_LOCK=0`. Per-spread QA verifies
  every render against the SAME pinned spec (`outfit_mismatch`, a fixed
  defect string steering the repair loop; skipped on BATH/WATER spreads
  whose coverage legitimately differs), so spreads that each pass also
  match each other — the ce-4 TEXT_RULES pattern applied to clothing.
  A run that renders lock-less while the switch is ON carries a stage
  `outfitLock` advisory, and callbacks echo `outfitLockUsed`
  (`<hash>`/`none`) beside `illustrationTuningUsed` — a lock-less book is
  never silent. Since `ce-15` they also echo `typographyAnchorUsed`
  (`s{spread}.{hash8}`/`none`). Cross-spread outfit sameness comes from this pinned spec +
  the anchor image + the QA gates — never from aspirational "keep it
  identical" prompt lines.
  Composition VARIETY (`ce-8`) is pinned the same way consistency is: the
  **shot plan** (`illustrator/shotPlan.js`) assigns every spread a
  deterministic composition — shot type (wide/medium/close-up/overhead/
  low-angle), staging, placement third, and (embedded) the text side —
  rotated from CLOSED vocabularies, seeded by the story fingerprint (an
  anchor/plate/outfit change never reshuffles cinematography), with wide
  bookends on spreads 1/12, no adjacent shot-type repeats, full menu
  coverage per book, and a restricted menu for band 1-3 (`half` layout
  emits no placement — its print hint owns it). The assignment rides the
  scene as a fixed COMPOSITION block + the renderer's `opts.shotType`
  enforcement (dormant until ce-8, the pre-ce-7 `characterOutfit`
  situation) and survives the NSFW fallback via `safeFallbackSuffix`; the
  identity anchor is framed "identity ONLY — never copy its pose or
  composition". Per-spread QA gates a clear `shot_type_mismatch`; the
  world gate judges `composition_duplicate` (near-duplicate of another
  spread) and its repair re-renders the flagged spread against its OWN
  plan directive. Kill-switch `CATALOG_SHOT_PLAN=0` folds `-sp0` into the
  render key so planned and plan-less renders never replay each other.
  World consistency (`ce-5`) attacks stateless-render drift with FIXED
  inputs, never chaining (previous-spread chaining was deleted 2026-08-06 as
  the photocopy drift source): (1) every scene prompt carries the theme's
  **world-law card** (`data/worldCards.json` + `worldCards.js` — palette,
  era, physical/magical laws; boot-validated full coverage; editing a card
  changes pixels ⇒ bump STYLE_VERSION); (2) every render attaches the
  theme's **world plate** (`illustrator/worldPlate.js`) — a fixed
  environment-only reference image beside the identity anchor, lazily
  generated once per theme, GCS-cached at
  `catalog-assets/world-plates/{STYLE_VERSION}/{themeId}-{promptHash}.png`
  (the prompt hash folds in overlay-patchable world naming + the card, so
  a Catalog Studio activation resolves a new plate; creation uses
  ifGenerationMatch so racing instances adopt ONE winning plate), its
  content hash folded into the render cache key (fail-open: a plate
  failure renders plate-less, never fails a run); (3) after the run, the **world gate**
  (`checkWorldConsistency` in `spreadQa.js` + `runWorldConsistencyGate`) —
  ONE multi-image check across the run's renders (skipped under 2), then
  one corrective re-render per flagged FRESH spread through the full
  per-spread path, capped at `CATALOG_WORLD_QA_MAX_RERENDERS` (default 3).
  The gate judges the closed set-break vocabulary: the four world classes
  (`palette_lighting`/`era_technology`/`materials_physics`/`magic_behavior`)
  plus `character_rendering` (the child reads as a different age,
  proportions, stylization, outfit, or hair than the other spreads),
  `composition_duplicate` (`ce-8` — the spread is a near-duplicate of
  another: same camera distance, angle, pose, and layout; its repair
  re-renders against that spread's own shot-plan directive) and —
  embedded layout only — `text_treatment` (text on a band/panel or in a
  different typography while the others paint it over continuous artwork);
  only that enum (plus pinned plan text) ever drives a repair prompt.
  Replayed cached renders are comparison references only, NEVER re-rendered
  (their storageKey is shared with earlier captured probe rounds); every
  finding ships as a `stage: 'worldQa'` advisory, and the book-level
  verdict rides completion/probe callbacks as `worldQa`. The gate runs
  identically for a full book and a probe subset — a subset is checked for
  internal consistency, mirroring the app-side judge.
  Personalization props are CARRY-THROUGH (`ce-6`): visual `object`
  evidence (the child's comfort object) rides every scene prompt AFTER its
  evidence spread as a framed CONTINUITY PROP line (small, decorative,
  never plot-critical) so the carried item never vanishes mid-book; only
  `object_presence` persists — food/place/interest moments stay pinned to
  their declared spreads. Kill-switch `CATALOG_PROP_CONTINUITY=0`.
  **The Book Bible + selection gate (`ce-9`, 2026-09-02 —
  `docs/ILLUSTRATION_CONSISTENCY_REFACTOR_PLAN.md`)** is the structural
  answer to clothing/prop drift: every fixed input becomes PIXELS + a
  schema-validated spec, built ONCE per book (`illustrator/bible/index.js`
  `buildBookBible`) before any spread renders, and verified AGAINST. (1) The
  **character model sheet** (`bible/characterSheet.js`): from the approved
  cover alone, ONE 16:9 sheet — the child full-body front / three-quarter /
  back in the complete outfit, feet visible, two head insets, flat grey
  background, no text. Since `ce-22`, the approved cover defines face,
  hair, skin tone, proportions, style and outfit. Best-of-N candidates
  (`CATALOG_SHEET_CANDIDATES`, default 3) must pass layout/anatomy QA,
  `cover_identity_matches`, `cover_outfit_matches`, and cover `likeness`
  >= 0.8. Highest COVER likeness wins; ties keep candidate order. The raw
  photo is QA-only: `photoLikeness` rides the result, sidecar and callbacks,
  with a review-cover advisory below 0.5. Cover-to-photo resemblance must
  be fixed before cover approval, never by independently redesigning the
  kit. The old photo election/floor is retired. Sheets are elected per
  anchor path in GCS
  (`catalog-assets/character-sheets/{STYLE_VERSION}/{anchorHash}.png` +
  `.json`). Every strict-JSON judge call in the illustrator (sheet, prop,
  spread, world, plate, contact, outfit) builds its generationConfig with
  `shared/llm/geminiJson.js` `jsonQaGenerationConfig` — thinking OFF on
  the 2.5 flash family and a ≥2048-token ceiling — because
  `gemini-2.5-flash` counts its reasoning tokens against `maxOutputTokens`
  (2026-09-02: a 256-token cap clipped every sheet verdict and failed every
  book `identity_kit_failed`); `parseJsonText` tolerates fences/prose and
  an unparseable answer names its `finishReason`. REQUIRED by default: a book that cannot build one fails
  `identity_kit_failed` (never a silent cover-only render; a set the judge
  could not verify is never elected either — an elected sheet is pinned
  per anchor for good; `CATALOG_SHEET_REQUIRED=0` degrades to an advisory). (2) The **outfit
  spec v3** derives FROM the sheet (`outfitLock.js` `source: 'sheet'`,
  `catalog-assets/outfit-locks/v3/{sheetHash}.json`, per-slot `colourHex`,
  an `inferred` slot is a derivation failure → cover-derived fallback with
  an advisory). (3) **Prop and companion sheets** (`bible/propSheet.js`):
  one plate per distinct `visual_required` evidence value (two angles,
  flat background, no text) + a vision-read structured spec rendered to one
  inert `specText`; cached by (normalized value, theme, STYLE_VERSION);
  the theme companion gets a sheet when drawable (`isDrawableCompanion` —
  since `ce-19` every named companion, PERSON-typed ones included; a named
  human companion is explicitly ALLOWED by the COMPANION block, which used
  to contradict the no-humans background rule on 38 books); fail-open. (4) The **emotion plan**
  (`emotionPlan.js`): a closed enum (10 emotions × 3 intensities) from a
  beat-keyword table, optionally refined by ONE per-story classifier call
  (`CATALOG_EMOTION_CLASSIFIER`), band 1-3 restricted, no adjacent repeats.
  The manifest (`children-jobs/{bookId}/bible.json`) hashes every input
  into `bibleHash`, folded into the render key as `-b{hash}` (replacing the
  ce-5/ce-7 `-w`/`-o` folds) and echoed on completion/probe callbacks as
  `bookBible` (signed URLs, hashes, spec text).
  **Rendering:** every call attaches the **reference pack** in fixed order
  with fixed labels — character sheet, approved cover, the spread's prop
  sheets (declared + carried), the companion sheet when the beat names it,
  the world plate (`buildReferenceParts`) — and the prompt states the
  identity ONCE in structured CHARACTER / PROPS / COMPANION / EMOTION blocks
  (`renderBibleBlocks`, `opts.bible`), switching the legacy six-fold outfit
  repetition off; legacy callers stay byte-identical. The safety ladder's
  `sanitized` rung now strips trigger words from the SCENE only (pinned
  blocks intact), the `generic-safe` rung re-attaches the bible blocks, the
  renderer sends `GEMINI_IMAGE_SAFETY_SETTINGS` on every image call, and a
  render accepted on any rung other than `original` carries a stage
  `render` advisory (before ce-9 it shipped silently, prop- and action-less).
  **Verification:** `spreadQa.js` `checkSpreadRenderV2` attaches the sheets
  BESIDE the render and returns a schema-shaped verdict — identity vs the
  sheet, the outfit garment BY garment (`match|mismatch|not_visible`), each
  prop vs its sheet (presence/look/duplicated/as_text), the companion, the
  beat's action, the planned emotion, a child bbox, and the cover's anatomy/
  lettering fields — with FIXED defect strings split by `classifyDefects`
  into BLOCKING (missing/duplicated child, identity/hair/skin, any visible
  outfit slot, declared props, companion, extra limbs, painted text in
  caption layout, missing/garbled embedded text, style break) and
  ADVISORY (action, emotion, hands/face, lettering, shot type). Strict
  (blocking-class) fields fail open on a malformed verdict; advisory-class
  fields are soft. `metrics.js` adds deterministic signals from the bbox:
  crop, garment-region colour ΔE vs the spec's `colourHex`, safe-zone /
  off-centre / shot-size rules, and (opt-in `CATALOG_IDENTITY_METRICS=1`,
  Vertex multimodal embeddings) an identity similarity score + set outliers.
  **Selection:** each spread renders `CATALOG_RENDER_CANDIDATES` (default 1 since #295, clamped 1-3)
  candidates concurrently beside the shipped key (`spread-N.<aspect>.cK.png`
  for the base pass, `.rPcK.png` for repair pass P — every scored candidate
  keeps its OWN bytes, so a rejected repair never overwrites better pixels
  and the failure payload's candidates are exactly what was scored; only
  the N=1 base render lives at the canonical key itself),
  scores them (`select.js`: blocking defects sink a candidate below zero,
  advisories and metrics shade the rest, unchecked ranks below checked),
  promotes the best to the canonical key, and runs the bounded repair loop
  ONLY while blocking (or embedded-text) defects remain — each pass renders
  N fresh candidates steered by `repairNoteV2` (slot/prop/companion/action/
  emotion/anatomy notes from pinned data only) and adopts a higher score
  (an UNCHECKED repair — checker outage mid-loop — never replaces a render
  whose defects are known); drift-class defects draw on
  `CATALOG_DRIFT_MAX_REPAIRS` beyond the general budget. A carried comfort
  object that is not visible is ADVISORY (`carried prop not visible`);
  a declared evidence prop missing is BLOCKING. Every automatic candidate
  — base, repair, set-gate re-render, lettering recovery — draws on ONE
  per-spread budget, `CATALOG_RENDER_BUDGET_PER_SPREAD` (default 3, #295).
  **Set gates:** the ce-5
  world gate is unchanged; the **contact-
  sheet gate** (`contactSheet.js`, `runContactSheetGate`, kill-switch
  `CATALOG_CONTACT_QA=0`) tiles the child
  crops beside the model sheet (and prop crops beside their sheets) in one
  image per call so garments are legible, flags `character_rendering` /
  `prop_rendering`, and re-renders flagged FRESH spreads once
  (`CATALOG_CONTACT_MAX_RERENDERS`, default 3); prop tiles are the
  structured verdict's per-prop bbox crops (`propBoxes`, kept on the
  marker), the whole spread only as a named fallback, and a prop repair
  cites the prop sheet's index in the re-render's own pack. **Ship policy
  (the book FINISHES — 2026-09-08):** every spread ships its best
  candidate. Advisory residuals ship with advisories; BLOCKING residuals
  that survive the budget SHIP with the best candidate and their findings
  on record (since #297 `CATALOG_SHIP_ON_EXHAUSTION` is ON by default —
  "finish with the best existing candidate"), and since 2026-09-08 so does
  EVERY other spread-level finding that used to stop the run for the admin
  to pick a candidate: a painted manuscript that is mismatched or could
  not be verified (a per-spread `shipPolicy` advisory names the page —
  "proof this page"), a critical story object that differs or could not be
  verified (its `spreadQa` advisory), and a checker outage ("shipped
  UNCHECKED"); the `visualRecovery` pause (`visual_recovery_pending`) is
  a strict-mode behaviour too. The one finding no policy can carry is the
  ABSENCE of an image: a spread that comes back with NO illustration is
  rendered again in bounded **missing-render rounds**
  (`CATALOG_MISSING_RENDER_ROUNDS`, default 3, each round the whole
  per-spread path — candidates, QA, repairs — FRESH on a restarted render
  budget with the durable slot cap widened in step, after a growing
  backoff `CATALOG_MISSING_RENDER_BACKOFF_MS` × round, default 15 s; the
  probe keeps its one-pass contract), and only a spread still blank after
  the last round fails the run `render_failed` — carrying the missing
  spreads' typed `recovery` (stage `scene_generation`) so the app shows
  the saved evidence and resumes a transient outage on its own schedule
  (a provider block stays a review). Set `CATALOG_SHIP_ON_EXHAUSTION=0`
  for a diagnostic run that must stop instead: every finding above is a
  hard gate again — `consistency_unresolved` (or `visual_recovery_pending`
  under `visualRecovery`) with `unresolved: [{spread, defects,
  candidates:[{storageKey, url, score}]}]` + `bookBible` on the failure
  callback; the `.qa.json` marker records `qaVersion`
  (`QA_VERSION`, versions.js) and an `unresolved` flag, so a replay under a
  newer checker — or of an unresolved render — re-checks instead of
  trusting it (the one exception: a render the opt-in switch shipped is
  marked `shippedOnExhaustion` and replays WITH its blocking list while the
  switch stays on, so the callback keeps reporting it; switch off and it
  re-checks). The render phase and both set gates emit a 30s progress
  heartbeat so the server's idle watchdog never aborts a healthy book. Admin remedies: `POST /v13/pick-candidate` promotes a
  candidate to the canonical key with an admin-vouched marker;
  `/v13/render-spreads` with `identityKeyed:false` re-renders one spread
  of a CUSTOMER book onto its own cache key. **The printed product:** the
  wrap cover now prints the approved cover's OWN pixels
  (`preGeneratedCoverBuffer` — before ce-9 `runBookPipeline` passed no
  photo bytes and the physical front cover was a fresh, title-less,
  un-anchored render), and the upsell spread's four covers render with the
  locked outfit and the character sheet as REFERENCE 1
  (`CATALOG_UPSELL_OUTFIT_LOCK=0` frees them). `qaAdvisories` is capped at
  80 with blocking-class notes first.
  **Bench-feedback generalization (`ce-10`, 2026-09-02)** folds the Art
  Bench judges' recurring findings into fixed engine rules: (1) FACE
  VISIBILITY — the shot plan's staging vocabulary no longer contains a full
  back view (`seen from behind` gained a face-visible head turn), every
  composition directive pins a fixed FACE line (at least partly visible,
  never fully from behind — phrased so it never fights the assigned shot
  type, e.g. overhead), and QA v2 reports `face_fully_hidden` (advisory
  `face hidden: …` + its own repair note); (2) PROP DISCIPLINE — the
  personal-object set is CLOSED: scene prompts and the bible PROPS block
  forbid invented toys/gadgets/trinkets beyond declared props + the beat's
  own needs, QA v2 reports `undeclared_object` (advisory `undeclared
  personal object in the scene` + repair note); (3) carried comfort objects
  are VISUALLY SUBDUED (muted, never attention-grabbing — the face and
  action stay the focus); (4) the outfit-mismatch definition (v1+v2) now
  names a missing/added/different garment pattern, print, or graphic (the
  spec always captured them; QA never checked them); (5) the pinned EMOTION
  line ends with an anti-generic-smile sentence; (6) embedded typography
  alignment (TEXT_RULES + QA + repair notes) demands every line start at
  the EXACT same horizontal position; (7) the world gate's WORLD dimension
  and `materials_physics` repair pin ONE biome/vegetation family per book.
  Both new QA fields are soft and advisory-class — they shade candidate
  selection and steer repairs, never fail a book.
  **Manuscript-pinned companion + full-bleed embedded text (`ce-11`,
  2026-09-03)**: (1) `companionOnSpread` (scenes.js) reads the beat AND the
  spread's manuscript text — companion NAME as a case-sensitive whole word
  ("Patch" the parrot never fires on "a patch of mud") or the full type
  phrase case-insensitively ("A young toucan swooped down") — and that ONE
  signal gates the scene's companion line, the companion sheet in the
  reference pack, the COMPANION prompt block, and the QA companion check.
  Beats name most companions only on spreads 1/12, so mid-book spreads
  whose story featured the companion rendered it reference-less and
  unchecked — a different-looking creature per spread. (2) The embedded
  band/split placement defects (`text_on_band` / `text_split_both_sides`)
  are BLOCKING-class (qa-4): a white text panel breaks the embedded
  layout's full-bleed contract, so a banded candidate sinks in selection
  and a residual fails `consistency_unresolved` instead of shipping one
  inconsistent spread (it used to ship as an advisory); the ce-4
  typography findings (misaligned / style-inconsistent) stay advisory.
  **The page fold (`ce-12`, 2026-09-03)**: an embedded render prints as
  TWO facing pages, and text crossing the vertical centerline is cut in
  half by the physical fold — the render prompt's TEXT PLACEMENT rule now
  states that print reality, and QA gates `text_in_center_gutter`
  (required with embedded text; a judged boolean PLUS a deterministic
  straddle check on the new soft `text_bbox` against the middle tenth of
  the width) as a BLOCKING placement defect with its own fold repair
  note — enforcement for the middle-30% exclusion the prompt always
  demanded but nothing verified.
  **Typeset by prompt (`ce-13`, 2026-09-03)**: a gate can only reject —
  ce-12 rounds still crossed the fold because the model broke lines at 7–9
  words in a caption-size face, which cannot fit a 35%-wide side. The
  renderer now PRE-WRAPS the manuscript (`wrapStoryLines`,
  `TEXT_RULES.maxCharsPerLine` 30, paragraph gaps kept, widths balanced)
  and orders the model to paint EXACTLY those line breaks; the TEXT ZONE
  rule states the shot plan's assigned text side (`opts.textSide`, ce-8's
  `textSide` finally consumed by the renderer) as a CONCRETE column box
  (x within the edge/active-side bounds, y within the top/bottom padding
  band) with the centerline framed as a hard wall; and `TEXT_RULES.
  fontSize` is a concrete SMALL body-type measure (cap height ≈ 2% of the
  image height, line pitch ≈ 3.5%) that must fit the column with many
  lines rather than grow. The fold repair note now says "smaller font,
  more shorter lines" first. `compareTexts` (qa-6) flags a missing FIRST
  or LAST word as edge truncation ("ron checked …" passed the 25% bag
  threshold). STYLE_VERSION `ce-13`, QA_VERSION `qa-6`. `ce-14` shrinks
  the painted text again: cap height ≈ 1.5% of the image height (line
  pitch ≈ 2.8%; the 3–8 tier nearer 1.3%), "about a third of the usual AI
  caption size — when unsure, go smaller".
  **Painted text held to a footprint and a reference (`ce-15`,
  2026-09-03)**: an Art Bench round showed the painted font size varying
  two to three times between spreads of one book and one spread painting
  its text on a solid beige panel — after four prompt-only style versions,
  because a percentage of the frame is not something an image model
  perceives and nothing measured the result. (1) The FONT SIZE rule is now
  followed by the block's FOOTPRINT in the model's own terms
  (`expectedTextBlock` in `shared/illustration/textBlock.js`: the widest
  pre-wrapped row × `TEXT_RULES.charWidthPercent` → "this block is about
  X% of the width wide", rows × `linePitchPercent` → "Y% of the height
  tall"; the type never grows to fill the column), restated in the
  checklist and in a `TEXT — FINAL CHECK` block that is the prompt's last
  fixed block before any tuning. (2) `generateIllustration` now forwards
  the shot plan's `textSide` (since ce-13 the builder read it but the
  renderer never passed it — every production render got the "pick a
  single side" wording) and the typography reference index. (3) The
  no-panel rule names what the model reaches for — card, plaque, sign,
  board, parchment, scroll, banner, box, any flat/lightened/darkened plane
  — and the scene carries a TEXT COLUMN hint (`renderTextColumnHint`, the
  half layout's proven technique): the assigned column is continuous CALM
  scenery so small letters are legible without a panel. (4) **The
  typography anchor** (`illustrator/textAnchor.js`, kill-switch
  `CATALOG_TEXT_ANCHOR=0`): the text-side HALF of one painted page of the
  story (a crop at full height — never a whole sibling frame; the
  2026-08-06 photocopy-drift deletion stands) rides every other spread's
  reference pack as the LAST entry, labeled TYPE ONLY ("each row of your
  text as tall as one of its rows"). It is elected ONCE per story and
  pinned beside the renders as ONE json object (`typo-anchor.wide.json`:
  the crop with its spread, side and hash; create-if-absent, single
  winner) — every later run reuses the pin whatever its subset (a bench
  probe on spreads 4–6 pins page 4 and the final book anchors on page 4
  too, so approved probe renders stay replayable); only a run with NO pin
  renders its first spread alone before the fan-out to elect it;
  `forceRerender` re-elects. The pinned page keeps its plain cache key
  and every other spread folds the crop's hash (`-ta{hash8}`, `-ta0` when
  off); callbacks echo `typographyAnchorUsed` (`s{spread}.{hash8}` or
  `none`, with a stage `typographyAnchor` advisory when an embedded run
  has none). (5) The
  ruler (`qa-7`): QA v2 holds the judged `text_bbox` to the same footprint
  — ≥ 1.6× too wide or tall is BLOCKING `embedded story text too large`
  (the smaller candidate wins; a residual never ships), ≥ 1.3× the
  advisory `oversized`; the repair note restates the footprint and cites
  the reference. STYLE_VERSION `ce-15`, QA_VERSION `qa-7`.
  **Smaller painted text (`ce-16`, 2026-09-03)**: the owner's call after
  ce-15 — the pinned spec steps down ~27% (cap height 1.5% → 1.1% of the
  image height, line pitch 2.8% → 2.1%, footprint 0.6% → 0.45% of the
  width per character; the 3–8 tier to 0.95% / 1.9% / 0.38%; "about a
  QUARTER of the usual caption size"), and the machinery pushes toward it
  instead of merely permitting it: the typography anchor page renders
  `CATALOG_TEXT_ANCHOR_CANDIDATES` (default 3, clamped 1-4) so a small
  page exists to elect, QA v2 exposes `textSizeRatio` and `select.js`
  charges `textSizeExcess` (-40 × the excess over the footprint) so the
  smaller painted block wins between otherwise-equal candidates, the ruler
  tightens to ≥ 1.5× blocking / ≥ 1.25× advisory (`qa-8`; the `oversized`
  advisory shades selection only — `needsRepair` no longer spends repair
  renders on it, the judged bbox being too rough on small blocks), and
  `CATALOG_EMBEDDED_IMAGE_SIZE` (OPT-IN, `1K`|`2K`|`4K`) requests a larger
  output size on embedded renders through `imageConfig.imageSize` (a 400
  naming the field retries once without it, the seed's pattern; folded
  into the render key as `-is{size}`) — more pixels per glyph is what
  keeps small painted text crisp at print. STYLE_VERSION `ce-16`.
  **The text sits INSIDE the picture (`ce-17`, 2026-09-03)**: the first
  ce-16 round shipped a blurred, darkened haze zone behind every text
  block — the ce-15 column hint's "calm scenery … gentle depth haze … no
  busy detail" read as "blur the column", and the typography anchor then
  copied page 1's haze book-wide. Every text rule now demands the scene
  under and around the letters at FULL sharpness, colour, and detail
  (TEXT INTEGRATION, the REMINDER, the FINAL CHECK, the column hint —
  "the scene's simpler areas at full sharpness, never blur, fog, soften,
  darken, lighten, desaturate, or empty it" — and the typography
  reference's label), legibility comes only from a thin, tight dark
  outline (`TEXT_RULES.fontColor` drops the "soft contact shadow"), and QA
  v2 gains `text_backdrop_treated` (required with embedded text; `qa-9`):
  a blurred, fogged, softened, darkened, lightened, desaturated, or
  emptied area behind the text is the BLOCKING `embedded story text sits
  on a treated backdrop` with its own repair note, and the world gate's
  TEXT TREATMENT dimension names it too. STYLE_VERSION `ce-17`.
  **ONE ink, measured (`ce-18`, 2026-09-03)**: the ce-17 round painted dark
  brown text on the bright spreads and inverted to WHITE on the darker
  ones — contrast-seeking, because "soft warm ivory" is illegible on a pale
  savanna sky, so the model broke the spec to stay readable. Nothing caught
  it: `text_style_inconsistent` only ever flagged a block mixing colours
  WITHIN itself (a uniformly wrong-coloured block scored a clean pass), and
  the world gate's colour clause is one lenient advisory. (1) The pinned
  ink is now the polarity that survives a bright picture book — **deep warm
  cocoa-brown #2A1C12**, the family the typeset caption pages already print
  in — stated as a NAME and a HEX (`TEXT_RULES.fontColorHex`, inherited by
  every age tier), legible through a thin PALE hairline instead of an
  inverted fill; a colour rule the model must break to stay legible always
  drifts. (2) That hex is the GATE's target too, so prompt and check can
  never disagree: `metrics.textInkColour` extracts the text bbox at native
  resolution (never downscaled — interpolation drags thin strokes toward
  the background), takes the pixels furthest in luminance from the region's
  median, splits them by side and keeps the LARGER group (the glyph fill;
  the allowed hairline is thinner than the stroke it hugs, which is what
  makes the read report the painted POLARITY), and CIE76-ΔEs it against the
  pinned ink. Beyond ΔE 26 it is the BLOCKING `embedded story text ink
  colour differs` (`qa-10`) with its own repair note; the measurement rides
  the result as `textInk`, `select.js` charges `textInkDelta` (-0.8 × ΔE)
  so the closest-to-spec candidate wins, and the QA marker keeps it so a
  replayed spread still counts toward the book's ink. Fail-open
  throughout: an unmeasurable block yields no verdict. (3) The **ink set
  gate** (`runInkConsistencyGate` + `metrics.inkSetOutliers`, budget
  `CATALOG_TEXT_INK_MAX_RERENDERS` default 2) holds every spread to the
  book's OWN median ink (ΔE 14) and re-renders the outliers — the ce-16
  size-outlier shape applied to colour, closing the gap where two spreads
  sit inside the absolute tolerance in opposite directions. Its verdict
  rides completion/probe callbacks as `textInkQa`. (4) The typography
  anchor's label now names the ink FIRST, and — the ce-17 lesson
  generalised — **a page whose own painted text is blocking is never
  elected as the anchor** (a wrong-ink, banded or hazed page 1 would
  otherwise propagate its defect book-wide, which is exactly how the ce-17
  haze spread to all twelve). Kill-switch `CATALOG_TEXT_INK_QA=0`.
  STYLE_VERSION `ce-18`, QA_VERSION `qa-10`.
  Three false-positive guards landed the same day (each could fail a
  full book `consistency_unresolved` on its own): `compareTexts`
  normalizes glyphs before comparing (curly↔straight quotes, NFD-stripped
  accents, dash/ellipsis spacing) and treats an edge word inside a merged
  OCR token as present; `companionOnSpread` masks the theme's world and
  display names ("Maple Harvest Hall" must never summon Maple) and falls
  back to the beat-only signal when the child shares the companion's
  name; and a set-gate re-render that comes back with MORE blocking
  defects than the flagged render is never adopted (the shipped bytes are
  restored to the key, the finding stays advisory).
  **Secondary characters are Bible identities (`ce-19`, 2026-09-07)**: a
  farm book's Farmer Bea was a different woman on two spreads. Two causes,
  both general. (1) `isDrawableCompanion` EXCLUDED every person-typed
  companion from the companion sheet (the renderer forbade inventing adult
  faces), so the two human-guide themes (farm, construction — 38 books)
  rendered their companion as a bare noun: no pixels, no spec, no
  `look_match` (the check was sheet-gated), no set gate — twelve stateless
  renders drew twelve farmers. (2) The ce-11 world/display-name masks in
  `companionOnSpread` were raw substring splits, and the farm display name
  "Farm" is a substring of "Farmer" — every "Farmer Bea" became "er Bea"
  before the name was looked for, so on the farm theme the signal never
  fired on ANY spread (no companion line, no COMPANION block, no QA check;
  the beat's ACTION line was the only thing drawing her). The masks are
  whole-word now (a mask that is a whole word of the companion's own name
  is skipped). The general fix treats every named recurring companion —
  human or creature, present catalog or overlay-patched — exactly like the
  child: ONE shared `shared/illustration/companionKind.js` decides PERSON
  vs creature for the sheet builder, the renderer, QA and the contact gate
  alike (two divergent regexes before); a person-typed companion gets a
  SECONDARY CHARACTER model sheet (one fictional person full-body in two
  views, no child hero, no text, its own content check + retry note)
  elected per theme like the creature sheet, plus a CHARACTER spec
  (closed-vocab apparent age + build, skin tone, hair, face notes, outfit
  garment by garment, dominant hex colours, marks —
  `sanitizeCharacterSpec` / `renderCharacterSpecText`, inert and capped at
  420 chars; creatures keep the object spec); the companion's spec
  sentence now rides the COMPANION prompt block as FIXED LOOK (before
  ce-19 it was derived, hashed and dropped on the floor) with the
  reference cited in a person's terms and an "exactly ONE" rule (the
  scene line and the pack label say it too); QA v2 (`qa-11`) judges
  `look_match` against sheet + spec by face/age/hair/skin/build/outfit,
  adds the soft `duplicated` (BLOCKING `companion duplicated`) and a soft
  companion bbox; the new **companion contact-sheet gate**
  (`checkCompanionContactSheet`, defect `companion_rendering`) tiles the
  companion crops of every spread that expected it beside the companion
  sheet — the set-level view two individually-passing spreads never get —
  and re-renders flagged spreads citing the companion sheet's index in
  the re-render's own pack; `renderSpread` results and `.qa.json` markers
  carry `companionBox` + `companionExpected`, and callbacks'
  `bookBible.companion` carries `specText` + `human`. The bible hash
  folds the new sheet/spec, so the two themes re-key automatically; an
  elected companion sheet is pinned per theme + prompt hash under
  `catalog-assets/companion-sheets/{STYLE_VERSION}/` (delete the object to
  re-elect). Kill-switch `CATALOG_HUMAN_COMPANION_SHEET=0` (person
  companions back to nouns; creature sheets unaffected). STYLE_VERSION
  `ce-19`, QA_VERSION `qa-11`.
  **The drawn lettering (2026-09-06, #304/#305/#308 — no STYLE_VERSION
  bump)**: embedded text is no longer typeset by prompt alone. For a new
  embedded book `illustrator/typographyGuide.js` DRAWS the lettering with
  the real font (`fonts/PlayfairDisplay.ttf` via fontkit → SVG → PNG):
  `createTypographyTemplate` renders THIS spread's manuscript on the
  ENTIRE transparent 16:9 canvas in its shot-plan column — Playfair
  Display Regular, the "readable" 1.5× size (`resolveTypographyGuideRules`
  `capHeightPercent` 1.425 % of the height / line pitch 2.85 % on the 3–8
  tier, 1.65 % / 3.15 % under 3 and over 8 — ≈ 14 pt / 16 pt on the
  printed 8.5" page), `wrapSentenceLines` rows (every sentence starts a
  row, 5–7 words per row, ONE empty row between sentences), left-aligned
  at the column's edge — and the render receives it as the FIRST image, the
  `EDIT BASE` ("complete the illustration around and behind those glyphs";
  `buildReferenceParts` sorts it first without renumbering the identity
  slots), at 4K (`imageSize`, the per-glyph pixels small type needs). The
  template's content hash is the embedded namespace (`-ta{hash8}`, the
  ce-15 fold), `canUseTypographyGuide` keeps a partially rendered book on
  its paid-for namespace (legacy page-anchor, sample-column guide, compact
  1× template) on ordinary retries and only `forceRerender` upgrades it,
  and callbacks echo `typographyAnchorUsed` as `template.{hash8}` /
  `guide.{hash8}`. Kill-switches `CATALOG_TYPOGRAPHY_GUIDE=0` (back to the
  ce-15 page-crop anchor) and `CATALOG_TYPOGRAPHY_TEMPLATE=0` (the sample
  column guide instead of the full-spread template). `textRecovery.js`
  (#310/#313) repairs a misspelt saved page by a bounded local edit
  (`repairImageText`) rather than a fresh render, under the shared
  `CATALOG_RENDER_BUDGET_PER_SPREAD` (default 3).
  **ONE typography spec (2026-09-07, `qa-12`)**: an underwater book
  shipped page A in small dark left-aligned Playfair over the reef and
  page B as WHITE, BOLD, ROUNDED SANS-SERIF, CENTRED rows twice the
  template's size with a thick dark contour — the subtitle look — and
  every qa-11 field page B was asked passed. Three causes, all fixed.
  (1) #304 chose the book's ink from the COVER's median luminance (dark
  cover ⇒ ivory `#FFF4DE` glyphs with a cocoa hairline) — asking an image
  model for light text with an outline is what summons bold centred
  sans-serif (the ce-18 finding, repeated), and the same story could flip
  ink between a probe anchored on one cover and a book on another. The ink
  is ONE for every book again: `#2A1C12` deep cocoa-brown, the family the
  caption/half pages already print in (`resolveBookTextRules(childAge)`
  and `resolveTypographyGuideRules(childAge, scale)` take no ink; the
  cover-luminance chooser is deleted). Legibility on a dark scene comes
  from COMPOSITION, not the fill: the TEXT COLUMN hint
  (`renderTextColumnHint`) now asks for the scene's naturally LIGHTER
  calm area — sky, mist, sunlit water, pale sand, a lit surface — the way
  printed picture books set dark type over sky, so the model never has a
  legibility reason to invert. (2) The size ruler had been relaxed on
  2026-09-05 (#295) to 4× blocking / 2× advisory, so a block at TWICE its
  footprint shipped as an advisory; it is back at the ce-16 values (1.5× /
  1.25×) — with the drawn template the footprint is exact, a correct
  render measures ≈ 1.0×, and `needsRepair` still never spends renders on
  the advisory band. (3) Nothing judged the FACE or the ALIGNMENT of a
  uniformly wrong block (`text_style_inconsistent` only ever caught a
  block mixing styles within itself; the left-margin clause hid inside
  the advisory misalignment field). QA v2 gains two REQUIRED fields with
  embedded text — `text_typeface_mismatch` (bold, sans-serif, rounded,
  handwritten, italic, or outlined/glowing display lettering instead of
  plain regular-weight book serif) and `text_not_left_aligned` (centred,
  right-aligned, or no shared left margin) — both BLOCKING with their own
  repair notes (`TEXT_TYPEFACE_DEFECT` / `TEXT_ALIGNMENT_DEFECT`), a
  TYPOGRAPHY section that states the sentence gap is by design, and the
  spread's own drawn template attached as the LETTERING REFERENCE image
  (`letteringJudgeImage`: the transparent template flattened onto paper
  and scaled to 1536 px — dark glyphs on an alpha channel vanish on a
  black composite; built lazily once per spread, never sent to the image
  model); the `EDIT BASE` and FONT rules now forbid restyling the drawn
  glyphs (weight, face, alignment, any contour) in the model's own words.
  STYLE_VERSION stays `ce-19` on purpose: a formerly-ivory book's template
  bytes change, so it re-keys by itself; a dark-ink book's template is
  byte-identical, so its good pages replay and only the pages qa-12
  rejects re-render. The app-side Art Bench judge and the typography
  rubric (`illustrationJudge.js`, `illustrationTuning.js` there) name the
  same face and ink.
  **Print resolution (2026-09-07)**: the template path requests Gemini's
  largest tier (`imageSize: '4K'`, about 4096×2304 for 16:9 — the pinned
  cap height is ~33 px there) and the print path upscales that 1.28× onto
  the 300 DPI spread canvas (`layoutEngine` `splitSpreadImage`, 5250 px
  incl. bleed), so painted text prints at ~234 DPI; vector type in the
  PDF is the only way past that ceiling. Two things used to lose
  sharpness between the model and the printer. (1) Nothing measured what
  came back: a 400 naming the `imageSize` field retries once WITHOUT it,
  and the model's 1K default (an 8 px cap height) would have passed every
  gate. `illustrationGenerator` now enforces `opts.minRenderHeight` — an
  image below it is a failed attempt with `undersized: true` + its
  measured size on the attempt log (`shared/illustration/renderSize.js`
  `imageDimensions`, fail-open); the illustrator passes the floor for
  embedded renders from `flags.minEmbeddedRenderHeight(tier)` (4K → 2000,
  2K → 1000, 1K → 500; `CATALOG_MIN_EMBEDDED_RENDER_HEIGHT` pins it, 0
  disables), records the shipped `size` on every result and `.qa.json`
  marker, flags a replayed page below the floor with a stage `render`
  advisory, and echoes it as `renders[].size` on probe callbacks and
  `renderSizes` on completion callbacks. (2) The PDF encoded every spread
  THREE times — the split canvas at JPEG 93, each half again at sharp's
  default 80 (the format-preserving extract), the page embed at 93 — all
  with 4:2:0 chroma subsampling, which halves colour resolution exactly on
  dark brown strokes over coloured scenery. The split now stays lossless
  and `encodeFullBleedJpeg` is the ONE encode: quality 95 with 4:4:4
  chroma for text-bearing pages (`textEmbeddedInArt`), 93 / 4:2:0 for
  text-free art.
  **The template is HELD TO (2026-09-07, `qa-13`, book ace1cc29)**: one
  spread of an enchanted-forest book shipped with its manuscript
  re-typeset — CENTRED rows at 1.57× the template's size, lower on the
  page and into the fold margin, over a lightened wash — beside eleven
  pages that kept the drawn lettering. Two causes, both general. (1)
  Nothing compared a render against the template it was given as its
  EDIT BASE: the judge's `text_not_left_aligned` / `text_backdrop_treated`
  booleans both passed, and the size ruler read the judge's rough bbox as
  1.4× (the advisory band `needsRepair` ignores by design) for a block
  that measured 1.57×. (2) The ce-18 ink read was measuring SCENERY:
  `textInkColour` averaged the 20% most background-deviant pixels of the
  judged bbox, but the glyphs of a real block cover ~5% of their own
  tight bbox (measured on the template), so over a night forest the
  "ink" read #7b7269 for glyphs that were #1e0201 — ten of twelve
  spreads carried a phantom BLOCKING ink defect, each spent its ONE
  repair render on it (the real defects never steered a repair), the
  ink set gate elected the forest (#3b443a) as the book's ink and spent
  two more re-renders, and −0.8 × a scenery ΔE shaded every candidate
  score. Now `metrics.templateConformance` measures every embedded
  render against THIS spread's template (the transparent full canvas
  rides QA as `letteringTemplate`): the template's alpha resampled onto
  the render's grid, each glyph-core pixel counted as painted IN PLACE
  when the render within a small placement tolerance (0.2% of the width)
  is ink-dark — or ink-light: an inverted fill still sits where the
  template put it, and its polarity is reported — AGAINST the scenery
  ring around it (contrast, never an absolute threshold: a dark scene
  with no text reads 0). Calibrated on that render: a preserved template
  0.97–1.0 (6–12 px jitter absorbed), a 25 px shift 0.68, 1.1× / 1.25×
  enlargements 0.60 / 0.53, the shipped page 0.20. Below
  `CATALOG_TEMPLATE_CONFORMANCE_MIN` (default 0.35) it is the BLOCKING
  `embedded story text departs from the drawn lettering template` (its
  own repair note names the EDIT BASE and its contract); below 0.7 the
  advisory `drifts` (selection only — `select.js` charges
  `templateDrift`, −40 × (1 − ratio)); the ratio rides the verdict, the
  `.qa.json` marker and the callbacks as `templateConformance` — tune the
  floor from those numbers, never blind. The painted INK is now read at
  the template's in-place glyph pixels (`textInk.source: 'template'`;
  suppressed on a departed page, whose template positions hold scenery),
  the bbox heuristic runs only on the legacy guide/page-crop paths (its
  pixel share dropped from 20% to the measured 5%), and the ink set gate
  therefore compares real inks. Kill-switch `CATALOG_TEMPLATE_CONFORMANCE=0`.
  The same audit closed a third hole on the one path that DOES recreate
  pixels without the reference pack: the automatic lettering recovery
  (`textRecovery.js` → `repairImageText`, a reference-free Gemini edit of
  the whole canvas whose text-column patch is pasted over the saved
  render) replaced the buffer but kept the ORIGINAL render's verdict —
  only its spelling status was updated — so identity, outfit, template
  conformance, ink and the child bbox the contact gate crops from all
  described pixels no judge had seen. A repaired page is now re-judged
  (`checkSpreadRenderV2` on the corrected pixels, on the fresh path and
  the reviewed rebuild alike; a checker outage keeps the old verdict with
  a `spreadQa` advisory, never a silent pass), so a re-typeset or drifted
  patch is caught like any other render. It did not fire on book
  ace1cc29 (no recovery log lines, no composite seam in the shipped
  pixels) — that spread was a single full-reference render the gates
  failed to reject. QA_VERSION `qa-13`; STYLE_VERSION stays `ce-19` (no
  prompt change — qa-12 markers re-check on replay, and only the pages
  the new checker rejects re-render).
  **The whole body (`ce-20` / `qa-14`, 2026-09-07)**: a savanna book's
  kneeling child shipped with her body ending at the hem of her shorts —
  no lower legs, no feet, the ground plane swallowing them — and a sibling
  spread bent the other leg past what a knee can do. Every rule and every
  QA field was satisfied, because both only ever COUNTED limbs (the
  ANATOMY rule's "2 legs, 2 feet", the checklist's LEG COUNT, the
  verdict's `extra_limbs`): a legless kneeling figure has two legs by any
  count. (1) The render prompt's ANATOMY rule now states the body is
  COMPLETE for its pose and GROUNDED — a kneeling/crouching/sitting/
  bending child shows the knees AND the lower legs and feet on the ground
  beside or behind them ("choose an angle that keeps them in view"), never
  ending at a hem/waist/knees, never sunk into or merged with the ground,
  never floating; only the image edge or a real scene object may hide part
  of the body, and then it reads as hidden, not missing — and JOINTED like
  a real child's (no twisted, reversed, rubbery or over-long limbs); the
  checklist's LEG COUNT became LEGS AND FEET, and every shot-plan
  directive carries a fixed BODY line beside FACE (the shot type decides
  what the FRAME crops; whatever it shows is whole). (2) QA v2 gains two
  STRICT blocking-class fields with their own fixed defect strings and
  repair notes: `body_truncated` (`anatomy defect: body incomplete …`,
  BODY REPAIR — the body ends INSIDE the image where the pose needs more of
  it; a body cut by the image EDGE is framing, not truncation) and
  `limb_pose_impossible` (`anatomy defect: impossible limb pose …`, LIMB
  REPAIR); both suppressed with an absent child. The legacy count fields
  are unchanged (`extra_limbs` blocking; hands/face advisory). The app's
  Art Bench rubric names the same two failures under Technical
  cleanliness (rubric v3). STYLE_VERSION `ce-20`, QA_VERSION `qa-14`.
  **Garment lettering is CLOTHING (`qa-16`, 2026-09-08 —
  `shared/illustration/garmentLettering.js`)**: an astronaut book's
  approved cover dressed the child in a spacesuit with an agency emblem, a
  flag patch and a mission badge; every character-sheet candidate copied
  that outfit faithfully (cover likeness 1.0) and every one was rejected
  `readable text on the sheet`, because the judge's text question counted
  the letters on the patches as sheet text, and the repair pass was then
  asked to remove "readable text" while preserving every garment — the
  same three candidates, durable with their verdicts, replayed the same
  failure on every regeneration with no new render (the app's "Resume
  saved work" could never get past it). The rule, stated ONCE for every
  judge: lettering that is part of a garment's own design — a word, logo,
  emblem, patch, badge, name or number ON the clothing — is judged under
  the OUTFIT checks (correct when the reference shows it on that garment,
  an outfit difference when it does not), never as readable, painted or
  stray text; text on the background, a sign, a panel, beside or over the
  figures stays text. The sheet render prompt reproduces cover garment
  lettering exactly and forbids every OTHER text; the sheet judge asks for
  `garment_lettering` (an inert transcript for the log) and `sheet_text`
  (annotation text outside the clothing — the field `readable_text` is
  retired, so an old-shaped answer is malformed, never a pass), and
  `RECOVERY_VERSION` is `character-sheet-recovery-2` so recovery-1 roots
  (candidates rejected for their own patches, budget exhausted) are never
  replayed — the next dispatch renders fresh. The same exemption rides
  caption-layout spread QA v1/v2 (`readable_text` → `painted text in the
  illustration`), v2's `stray_lettering_or_signage`, and the gift-video
  still judge (`text_present`, whose pins follow QA_VERSION); the coloring
  hero/companion line-sheet prompts keep a garment's logo/patch/badge as
  its BLANK outline shape (the shape stays, the letters go — the pages
  that copy it stay text-free) and the line-sheet judge names that blank
  shape as the same garment, not text. QA_VERSION `qa-16` (lenience only:
  markers re-check, and only a page the new checker rejects re-renders);
  STYLE_VERSION and COLORING_VERSION stay — the sheet prompts only govern
  anchors with no elected sheet, and an elected sheet passed the stricter
  check.

- `coloring/` — **the coloring book (`cb-1`, 2026-09-07 —
  `docs/COLORING_BOOK_V2_PLAN.md`)**: companion scenes from the story world,
  drawn as verified LINE ART, printed as a Lulu saddle-stitched 8.5×11.
  `plan.js` assigns every page a kind from a CLOSED non-plot grammar
  (`meet` — the hero's own model sheet page; `hero_portrait`,
  `companion_portrait`, `world_portrait`, `cast_portrait`, `between` (the
  quiet transition between beats k and k+1), `before`, `after`,
  `quiet_parallel` (the emotion plan's peak), `prop_still_life` (the comfort
  object), `pattern` (8-10 only)) with per-band quotas (16 pages for 1-3,
  20 otherwise; `CATALOG_COLORING_PAGES` overrides), seeded gap selection
  (story fingerprint), no adjacent kind repeats, a rotated shot/placement,
  and ajv + invariant validation. `moments.js` phrases each slot: ONE
  strict-JSON writer call (`gemini-2.5-flash`, kill-switch
  `CATALOG_COLORING_MOMENT_WRITER=0`) behind the deterministic
  **duplication gate** (shared content-word 4-gram, Jaccard > 0.45, or
  Levenshtein ratio > 0.6 against ANY beat or spread text; invented proper
  nouns; banned brands; a peril lexicon; quoted strings / digits) with one
  retry and a per-kind TEMPLATE fallback (every template passes the gate for
  all 228 books — a test sweeps them). `sheets.js` pins identity AS LINE
  ART: the elected colour character sheet redrawn as a LINE-ART MODEL SHEET
  (best-of-N, measured + judged, elected create-if-absent under
  `catalog-assets/coloring-sheets/{COLORING_VERSION}/`; REQUIRED —
  `coloring_identity_failed`, `CATALOG_COLORING_SHEET_REQUIRED=0` degrades),
  the companion sheet likewise (`coloring-companions/`, fail-open) and a
  per-theme BORDER PLATE (`coloring-borders/`, fail-open). `lineRules.js` is
  the pinned per-band `LINE_RULES` spec (stroke weight as % of the image
  width, detail floor, subjects, background, smallest area, inner margin)
  rendered into fixed prompt blocks; `render.js` assembles the page prompt
  (structured CHARACTER / COMPANION / PROPS / WORLD blocks with every colour
  word stripped, then LINE ART RULES / PAGE COMPOSITION / NO TEXT / FINAL
  CHECK), the fixed reference pack (hero line sheet, colour sheet, cover,
  companion sheet, prop sheets, world plate / border plate) and N candidates
  at 3:4 through `illustrationGenerator.callGeminiImageParts` on the safety
  ladder — this renderer never goes through `buildCharacterPrompt`.
  `metrics.js` measures the returned pixels at native resolution (grey mass,
  ink density, largest solid component, 2A/P stroke width vs the band,
  frame ring, margin breach) and `cleanLineArt` is the ONLY pixel edit
  (near-white → white, near-black → black, the anti-aliasing band untouched,
  specks removed — never a threshold); `pageQa.js` is the structured verdict
  (identity vs the line sheet, outfit slot by slot, companion, props,
  painted text, shading, fills, extra people, scene match, complexity) with
  FIXED defect strings split BLOCKING / ADVISORY and fixed repair notes;
  `select.js` scores (blocking sinks, grey and stroke deviation shade);
  `index.js` runs candidates → repair loop (`CATALOG_COLORING_MAX_REPAIRS`)
  → the two set gates (`gates.js`: a contact sheet vs the line sheet, a
  stroke-weight gate on the book's own median; one corrective re-render
  each, never adopting a worse result) → ship policy (`coloring_unresolved`
  fails closed with scored candidates; `CATALOG_COLORING_SHIP_ON_EXHAUSTION=1`
  opts in) → `layout.js` (pdf-lib: trim + 0.125 in bleed pages, 0.5 in
  safety, the 7.5×9.75 in art box with a centre crop never a stretch,
  captions in Kalam as PDF type, the matter pages over the border plate,
  saddle-stitch page count a multiple of 4, images upscaled to Lulu's 300
  PPI floor, DeviceGray ink, the one-page 17.25×11.25 in cover wrap from the
  approved cover's OWN pixels + typeset bands, `preflightLulu` reported on
  the callback). Pages cache at
  `children-jobs/{bookId}/coloring/{COLORING_VERSION}/{planHash}/page-N.png`
  (+ `.cK` / `.rPcK` candidates, `.qa.json` markers, `manifest.json`); the
  plan hash folds the story fingerprint, the bible hash, every sheet hash,
  the LINE_RULES hash, the image size and the moments, so a re-dispatch
  without `forceNew` replays finished pages and rebuilds the PDFs for free.
  `COLORING_VERSION` (`cb-1`) / `COLORING_QA_VERSION` (`cq-1`) in
  versions.js.

- `audio/` — **the audiobook (`ab-1`, 2026-09-07 —
  `docs/AUDIOBOOK_V2_PLAN.md`)**: the performed read-aloud of one finished
  V1.3 story with a per-theme score and sound design, built the way the
  book itself is — pinned inputs → N candidates → verified → selected →
  bounded repair → fail-closed, every asset elected once. `script.js`
  derives the AUDIO SCRIPT from the pinned story + Book Bible (the beats,
  the refrain, the emotion plan, the companion via the ce-19 whole-word
  masks): intro / dedication / 12 spread / outro segments of LINES (text,
  speaker `narrator|companion` — a companion-voiced line is the
  manuscript's own quoted dialogue, attributed deterministically —
  direction from a CLOSED vocabulary: emotion × intensity × pace × shape,
  `isRefrain`, `pauseAfterMs`), per-band pacing (`BAND_WPM`), the music cue
  per segment (`music/plan.js`: a 9-cue grammar — theme_intro, playful,
  calm, wonder, tension, tender, triumph, lullaby_outro, motif — from the
  emotion plan + `data/audio/musicPalettes.json`), the sound placements
  (`sfx/plan.js`: `data/audio/sfxCues.json` — 75 spot cues keyed by
  keyword/theme/band with `maxGainDb`, a per-theme ambience bed, the page
  turn; min spacing, never on a line, startle cues excluded for 1-3) and a
  schema (`data/audio/schemas/audioScript.schema.json`) + invariant gate;
  `director.js` is ONE optional strict-JSON pass (`CATALOG_AUDIO_DIRECTOR`)
  that may only re-pick directions from the closed vocabulary — never a
  word of text. `cast.js` resolves the CAST from `data/audio/cast.json`
  (3 narrators, 5 companion voices, each with ElevenLabs / Gemini / OpenAI
  ids + settings; the default narrator per theme, the 1-3 band's bedtime
  reader, the companion voice by PERSON/creature kind) — the admin picks a
  narrator, the worker never invents a voice. `providers/` are the narrator
  adapters (ElevenLabs `eleven_v3` with audio tags + `with-timestamps`
  alignment, Gemini TTS, OpenAI `gpt-4o-mini-tts`; `CATALOG_AUDIO_NARRATOR_
  PROVIDER`), `pronounce.js` pins each verbatim name ONCE per voice
  (elected under `catalog-assets/pronunciations/{AUDIO_VERSION}/…`: the
  name is read, transcribed, and an alias spelling elected when the read
  drifts). `narrate.js` renders every segment as `CATALOG_AUDIO_TAKE_
  CANDIDATES` takes (`children-jobs/{bookId}/audiobook/{AUDIO_VERSION}/
  takes/{takeHash}/chunkN.wav` + `.cK` / `.rPcK` candidates + `.qa.json`
  markers keyed by `AUDIO_QA_VERSION`), each measured (`wav.js` — a pure-JS
  BS.1770-4 ruler: integrated LUFS, true peak, silence/dead-air profile,
  trim; `metrics.js`) and judged (`takeQa.js`: the transcript vs the
  script's text — `compareTexts` word match with the verbatim names
  masked — a spoken direction tag, duration vs the expected window, dead
  air, clipping, artifacts BLOCKING; name not heard, level outlier,
  monotone, too fast/slow, emotion reads differently ADVISORY; Gemini
  audio through `geminiAudio.js` `judgeAudio` + `jsonQaGenerationConfig`),
  scored (`select.js`), promoted, and repaired with a fixed note per
  defect (`CATALOG_AUDIO_MAX_REPAIRS`, one per-segment budget
  `CATALOG_AUDIO_BUDGET_PER_SEGMENT`) on the safety ladder (full →
  plain-direction → tag-less); an exhausted take fails the book
  `audiobook_unresolved` with scored candidates (`CATALOG_AUDIO_SHIP_ON_
  EXHAUSTION=1` opts in). `music/suites.js` elects ONE suite per theme
  (Lyria on Vertex — `GOOGLE_CLOUD_PROJECT`, or Eleven Music; `CATALOG_
  AUDIO_MUSIC_PROVIDER`) under `catalog-assets/music-suites/{AUDIO_VERSION}/
  {themeId}-{hash8}/{cue}` — fixed prompts from the palette + the world-law
  card, N candidates judged (vocals / heavy percussion / harsh hits / mood
  / abrupt ending), create-if-absent single winner — with the CC0 files in
  `data/audio/fallback/` (+ CREDITS.md) as the ADVISORY fallback per cue;
  `sfx/library.js` elects every cue the same way (ElevenLabs sound
  generation, `catalog-assets/sfx/{AUDIO_VERSION}/{cueId}-{hash8}`; a
  rejected cue is SKIPPED with an advisory, never a wrong sound).
  `timeline.js` lays the takes on ONE clock (fixed gaps per kind and band,
  page turns between spreads, the refrain motif before its line, cues
  after their line with a minimum spacing that widens the gap, music
  spans with 3 s crossfades) and the read-along `speechWindows` /
  `spreads[].lines[].start/end` the app's player highlights; `mix.js`
  drives ffmpeg by argv only (takes trimmed + level-matched → voice stem;
  music looped/trimmed/faded + SIDECHAIN-ducked under the voice; ambience
  band-limited; cues placed; a −16 LUFS master with a −1 dBTP limiter into
  MP3 192k) and `gates.js` measures the result (`measureMaster`: the
  target ± tolerance, true peak, NO dead air; `speechMusicRatio` ≥ 12 LU
  per spread from the stems — a failure re-mixes with the music lowered
  ONCE; `startleCheck` ≤ −8 dBTP on cues/music; `listenThrough`: ONE
  Gemini listen of the mastered file — ADVISORY). `index.js`
  `generateAudiobook` runs it (takes + assets concurrently; the mix at
  `children-jobs/{bookId}/audiobook/{AUDIO_VERSION}/{mixHash}/audiobook.mp3
  + timeline.json + manifest.json` — a re-dispatch without `forceNew`
  replays the manifest for free; `forceRetake: [spreads]` re-records
  those; `segments: [subset]` renders takes only), heartbeats through
  `onProgress`, and `auditionAudiobook` performs one spread on a cast
  synchronously (the Audio Bench's voice picker); `candidates.js`
  `pickTake` is the `audiobook_unresolved` remedy (admin-vouched marker).
  Failure codes: `audiobook_disabled`, `audiobook_provider_unavailable`,
  `audiobook_bad_cast`, `audiobook_render_failed`, `audiobook_unresolved`,
  `audiobook_mix_failed`, `cancelled` + the inherited story codes. The
  app-owned `audioTuning` overlay (`{versionLabel, hash, text}`, ≤ 8 KB,
  `CATALOG_AUDIO_TUNING_LAYER=0`) is framed scope-subordinate — binding on
  delivery, never on a word — and echoed as `audioTuningUsed`.
  `AUDIO_VERSION` (`ab-1`) / `AUDIO_QA_VERSION` (`aq-1`) in versions.js:
  bump `AUDIO_VERSION` on any change to the script grammar, the cast
  file, a prompt, the timeline rules or the mix graph (every elected asset
  and every take re-keys), `AUDIO_QA_VERSION` when the take judge changes
  (markers re-check). Cost: `CostTracker.addAudioCharacters` /
  `addAudioSeconds`.

## Feature switches (everything ON by default; envs are KILL-SWITCHES)

The full V1.3 behavior ships out of the box — fit ranking, deep
personalization (all 228 books carry an approved sidecar), and the evidence
requirement. Set an env to `0` on the Cloud Run revision to disable:

- `CATALOG_FIT_RANKING=0` — fall back to seeded variety-only selection.
- `CATALOG_PERSONALIZATION_MAPS=0` — every book generates name-only.
- `CATALOG_EVIDENCE_REQUIRED=0` — stop hard-failing responses that ignore
  usable details despite approved slots.
- `CATALOG_TUNING_LAYER=0` — ignore any `writerTuning` overlay from the main
  app (stories render on the bare locked engine prompt).
- `CATALOG_STYLE_POLISH=0` — skip the style-polish pass on tuned stories.
- `CATALOG_ART_TUNING_LAYER=0` — ignore any `illustrationTuning` overlay from
  the main app (spreads render on the bare scene + style prompts).
- `CATALOG_WORLD_PLATE=0` — skip the per-theme world reference plate
  (renders anchor on the cover alone; world-law cards still ride prompts).
- `CATALOG_WORLD_QA=0` — skip the book-level world-consistency gate and its
  corrective re-renders (per-spread QA still runs).
- `CATALOG_PROP_CONTINUITY=0` — stop carrying the child's comfort object
  through spreads after its evidence spread (cache-keyed: eligible stories
  fold `-p0` into the render key when disabled, so carried-prop and
  prop-less renders never replay each other).
- `CATALOG_OUTFIT_LOCK=0` — stop deriving the per-anchor outfit spec
  (renders fall back to "match the reference photo"; locked and lock-less
  renders stay cache-separated by the `-o{hash}` fold). Also disables the
  per-spread outfit QA check.
- `CATALOG_SHOT_PLAN=0` — stop assigning the deterministic per-spread
  composition (shot type/staging/placement) and its QA checks (cache-keyed:
  `-sp0` folds into the render key when disabled, so planned and plan-less
  renders never replay each other).
- `CATALOG_TEXT_ANCHOR=0` — (ce-15) stop electing the book's first painted
  embedded spread as the TYPOGRAPHY REFERENCE for its other spreads (they
  render on the text rules alone; cache-keyed: `-ta0` folds into the
  render key when disabled, so anchored and anchor-less renders never
  replay each other).
- `CATALOG_TEXT_ANCHOR_CANDIDATES=N` — (ce-16) candidates rendered for the
  typography anchor page (default 1 since #295, clamped 1-4); the whole
  book copies the elected page's type size. Moot when the drawn lettering
  template rides (the default): the template is the reference.
- `CATALOG_TYPOGRAPHY_GUIDE=0` — (#304) stop drawing the book's lettering
  (Playfair Display Regular, one numeric size per age tier, ONE cocoa ink)
  as a reference image; embedded spreads fall back to the ce-15 page-crop
  anchor. `CATALOG_TYPOGRAPHY_TEMPLATE=0` — (#308) the sample-column guide
  instead of the full-spread manuscript template (new books only; a
  partially rendered book keeps its namespace).
- `CATALOG_EMBEDDED_IMAGE_SIZE=2K` — (ce-16, OPT-IN) request this output
  size (`1K`|`2K`|`4K`) on embedded renders; the template path requests
  `4K` by default. Cache-keyed (`-is{size}`).
- `CATALOG_PRINT_IMAGE_SIZE=0` — (pq-1) no print tier for the text-free
  layouts (the model's default size, the pre-pq-1 render keys).
  `CATALOG_PRINT_IMAGE_SIZE_WIDE` (`4K`) / `CATALOG_PRINT_IMAGE_SIZE_SQUARE`
  (`2K`) set the tiers; `CATALOG_MIN_PRINT_RENDER_HEIGHT` pins the guard
  (0 disables); `CATALOG_COVER_IMAGE_SIZE` (`2K`, `0` = model default) the
  front cover's; `CATALOG_PRINT_PPI_FLOOR` (0 = report only) fails the
  preflight below an effective PPI.
- `CATALOG_FOLD_SAFETY=0` — (pq-1) the pre-pq-1 SAFE ZONE prompt lines and
  child-only bbox checks (no fold / cast rules).
- `CATALOG_PRINT_PREVIEWS=0` — (pq-1) no print-crop previews.
- `CATALOG_COVER_OUTPAINT` — (pq-1) `casewrap` (default) | `all` | `0`: which
  covers get the painted wrap band; `CATALOG_COVER_OUTPAINT_SIZE` (`2K`).
- `CATALOG_PRINT_SHADOW_LIFT` — (pq-1, OPT-IN, 0–0.15) the print-only
  shadow lift; a proof decision.
- `CATALOG_MIN_EMBEDDED_RENDER_HEIGHT=N` — (2026-09-07) the pixel height an
  embedded render must reach or the attempt fails (the resolution guard).
  Unset: follows the requested tier (4K → 2000, 2K → 1000, 1K → 500;
  nothing requested → off). `0` disables; the measured size still rides
  every callback.
- `CATALOG_TEXT_INK_QA=0` — (ce-18) stop measuring the painted text's INK
  colour: no per-spread ink defect and no book-level ink gate (the pinned
  ink still rides every prompt).
- `CATALOG_TEXT_INK_MAX_RERENDERS=N` — (ce-18) corrective re-renders the ink
  set gate may spend per run (0-4, default 2).
- `CATALOG_TEMPLATE_CONFORMANCE=0` — (qa-13) stop measuring embedded
  renders against their drawn lettering template (no `departs`/`drifts`
  defects; the ink falls back to the bbox heuristic).
  `CATALOG_TEMPLATE_CONFORMANCE_MIN=0.35` — the share of the template's
  glyphs that must be painted in place (0-1) before a page is BLOCKING;
  the advisory band ends at 0.7.
- `CATALOG_CHARACTER_SHEET=0` — (ce-9) no character model sheet (renders
  anchor on the cover alone; the outfit spec derives from the cover again).
- `CATALOG_SHEET_REQUIRED=0` — (ce-9) a book whose sheet cannot be built
  renders sheet-less with a stage `characterSheet` advisory instead of
  failing `identity_kit_failed`.
- `CATALOG_SHEET_PHOTO_LIKENESS_MIN` — retired in ce-22; has no effect.
  Sheet election requires cover identity/outfit agreement and cover
  likeness >= 0.8. Photo likeness is advisory only at this stage.
- `CATALOG_PROP_SHEETS=0` — (ce-9) no prop / companion sheets (props ride
  as quoted nouns only).
- `CATALOG_HUMAN_COMPANION_SHEET=0` — (ce-19) no SECONDARY CHARACTER sheet
  / character spec for a PERSON-typed companion (Farmer Bea, Builder Sam
  ride as nouns again, unchecked, as before ce-19); creature companion
  sheets unaffected.
- `CATALOG_EMOTION_PLAN=0` — (ce-9) no per-spread emotion line/check;
  `CATALOG_EMOTION_CLASSIFIER=0` keeps the keyword table only.
- `CATALOG_CONTACT_QA=0` — (ce-9) skip the contact-sheet set gate and its
  corrective re-renders (independent of `CATALOG_WORLD_QA`).
- `CATALOG_SHIP_ON_EXHAUSTION=0` — (ce-9; ON by default since #297, and
  since 2026-09-08 it covers EVERY spread-level finding — blocking
  residuals, lettering, critical story objects, checker outages, the
  `visualRecovery` pause) opt OUT of finishing the book with the best
  candidate: fail it `consistency_unresolved` / `visual_recovery_pending`
  instead, candidates attached (diagnostic runs).
- `CATALOG_MISSING_RENDER_ROUNDS=N` — (2026-09-08) extra render rounds the
  full-book path spends on a spread that came back with NO illustration
  before failing `render_failed` (0-10, default 3; each round is the whole
  per-spread path, fresh, on a restarted budget).
  `CATALOG_MISSING_RENDER_BACKOFF_MS=N` — the wait before round N is
  N × this (0-300000, default 15000).

- `CATALOG_IDENTITY_METRICS=1` — (ce-9, OPT-IN) embedding identity score +
  set outliers (`CATALOG_EMBEDDING_BACKEND`, default `vertex`).
- `CATALOG_UPSELL_OUTFIT_LOCK=0` — (ce-9) upsell covers dress freely again.
- `CATALOG_COLORING_BOOK=0` — (cb-1) 503 the coloring endpoints. Tuning:
  `CATALOG_COLORING_CANDIDATES` (2, 1-3), `CATALOG_COLORING_MAX_REPAIRS`
  (2, 0-4), `CATALOG_COLORING_MOMENT_WRITER=0` (template lines only),
  `CATALOG_COLORING_SHEET_CANDIDATES` (3, 1-4),
  `CATALOG_COLORING_SHEET_REQUIRED=0` (a failed hero line sheet degrades to
  an advisory instead of `coloring_identity_failed`),
  `CATALOG_COLORING_CONTACT_QA=0` / `CATALOG_COLORING_CONTACT_MAX_RERENDERS`
  (3), `CATALOG_COLORING_STROKE_GATE=0` /
  `CATALOG_COLORING_STROKE_MAX_RERENDERS` (2), `CATALOG_COLORING_IMAGE_SIZE`
  (`2K` default; `1K`|`2K`|`4K`), `CATALOG_COLORING_DESPECKLE=0`,
  `CATALOG_COLORING_CAPTIONS=0`, `CATALOG_COLORING_PAGES` (page-count
  override, 8-28), `CATALOG_COLORING_SHIP_ON_EXHAUSTION=1` (OPT-IN),
  `CATALOG_COLORING_TIMEOUT_MINUTES` (30). Bump `COLORING_VERSION`
  (versions.js, `cb-1`) on any change to the grammar, the templates, the
  LINE_RULES, a prompt block, the pack order or the layout geometry.
- `CATALOG_AUDIOBOOK=0` — (ab-1) 503 the audiobook endpoints. Tuning:
  `CATALOG_AUDIO_NARRATOR_PROVIDER` (`elevenlabs` | `gemini` | `openai`),
  `CATALOG_AUDIO_NARRATOR_MODEL`, `CATALOG_AUDIO_TAKE_CANDIDATES` (2, 1-3),
  `CATALOG_AUDIO_MAX_REPAIRS` (2, 0-4), `CATALOG_AUDIO_BUDGET_PER_SEGMENT`
  (5, 1-10), `CATALOG_AUDIO_CONCURRENCY` (4, 1-8),
  `CATALOG_AUDIO_CHARACTER_VOICES=0` (the narrator reads the companion's
  lines too), `CATALOG_AUDIO_DIRECTOR=0` (the direction table only),
  `CATALOG_AUDIO_TRANSCRIPT_QA=0` (takes ship on measurement alone, marked
  unchecked), `CATALOG_AUDIO_STT_MODEL` (`gemini-2.5-flash`),
  `CATALOG_AUDIO_MUSIC=0` (the CC0 library only) / `CATALOG_AUDIO_MUSIC_
  PROVIDER` (`lyria` | `elevenlabs`) / `CATALOG_AUDIO_MUSIC_MODEL` /
  `CATALOG_AUDIO_MUSIC_LOCATION`, `CATALOG_AUDIO_SFX=0` (no sound cues) /
  `CATALOG_AUDIO_SFX_PROVIDER`, `CATALOG_AUDIO_AMBIENCE=0`,
  `CATALOG_AUDIO_PAGE_TURN=0`, `CATALOG_AUDIO_LISTEN_QA=0`,
  `CATALOG_AUDIO_TARGET_LUFS` (−16, −30…−8), `CATALOG_AUDIO_ASSET_
  CANDIDATES` (2, 1-3), `CATALOG_AUDIO_TIMEOUT_MINUTES` (20, 5-90),
  `CATALOG_AUDIO_TUNING_LAYER=0`, `CATALOG_AUDIO_SHIP_ON_EXHAUSTION=1`
  (OPT-IN). Bump `AUDIO_VERSION` (versions.js, `ab-1`) on any change to
  the script grammar, the cast file, a prompt, the timeline rules or the
  mix graph; `AUDIO_QA_VERSION` (`aq-1`) when the take judge changes.
- `CATALOG_GIFT_VIDEO=0` — (gv-1) disable `/v13/generate-video` and
  `/v13/pick-clip` (503). `CATALOG_VIDEO_PROVIDERS` (default `replicate`),
  `CATALOG_VIDEO_MODEL` (default `kwaivgi/kling-v3-video`),
  `CATALOG_VIDEO_ELEMENTS=0` (no identity-kit reference elements),
  `CATALOG_VIDEO_MAX_IMAGES` (3-32; unset: the model's own limit — Kling
  takes at most SEVEN pictures per request, start frame + end frame +
  reference images/elements TOGETHER, vendor error 1201 on 2026-09-08 when
  a full-story shot sent one start frame + seven sheets; `imageBudget` in
  `video/providers/models.js` is what every reference pack is selected
  against — the child's sheet, the companion, then props by priority, the
  full-story film choosing each shot's props from ITS spread's story-object
  occurrences (`shotReferenceSheets`) — with every omission a stage `video`
  advisory / result warning, never a refused request),
  `CATALOG_VIDEO_MODEL_INPUT_JSON` (per-revision input field overrides),
  `CATALOG_VIDEO_SCENES` (gv-2: stills the single take travels through,
  3, 1-4), `CATALOG_VIDEO_END_FRAME=0` (gv-2: no end frame on the take),
  `CATALOG_VIDEO_CLIP_CANDIDATES` (1 since gv-2, 1-3),
  `CATALOG_VIDEO_CLIP_MAX_REPAIRS` (1 since gv-2, 0-4),
  `CATALOG_VIDEO_CLIP_TIMEOUT_SECONDS` (480), `CATALOG_VIDEO_MAX_CLIP_SECONDS`
  (30 since gv-2 — the per-film generation budget),
  `CATALOG_VIDEO_TEXT_GATE_RETRIES` (2, 0-6 — extra text-free renders the
  film may spend when an embedded book's start frame still carries painted
  lettering: the same spread FRESH first, then the nearest untried spread
  as a substitute; 0 fails on the first hit),
  `CATALOG_VIDEO_SHIP_ON_EXHAUSTION=1` (OPT-IN), `CATALOG_VIDEO_MUSIC`
  (`none`), `CATALOG_FILM_DIRECTOR_REPAIRS` (1, 0-3 — corrected-screenplay
  rounds the full-story film's director gets when its screenplay fails
  validation, the failing fragments fed back with id, spread, text and
  reason; assignments are matched by fragment id, silent whitespace/
  punctuation fragments need no speaker, and a cast NAME as the speaker,
  `certain` as a string or an emotion in another case are normalized —
  2026-09-08, after one blank fragment marked uncertain failed a whole
  film `film_script_ambiguous`), `FFMPEG_PATH`. Bump `VIDEO_VERSION` (versions.js, `gv-2`) on
  any change to the film plan, the still-selection scoring, the brief
  template or the stitch graph.
- Tuning (ce-9): `CATALOG_RENDER_CANDIDATES` (default 1, clamped 1-3),
  `CATALOG_DRIFT_MAX_REPAIRS` (default 0, clamped 0-4),
  `CATALOG_RENDER_BUDGET_PER_SPREAD` (default 3, clamped 1-12 — every
  automatic candidate a spread may buy per run across all gates),
  `CATALOG_CONTACT_MAX_RERENDERS` (default 3), `CATALOG_SHEET_CANDIDATES`
  (default 3, clamped 1-4), `CATALOG_RENDER_CONCURRENCY` (default 6,
  clamped 1-8 — spreads rendered in parallel, each fanning out into
  `CATALOG_RENDER_CANDIDATES` image calls; also bounds the set gates'
  corrective re-renders, which run CONCURRENTLY since 2026-09-03 — before
  that up to 3+3 full re-render cycles ran one at a time and dominated a
  many-spread run's wall clock; the bible's component families build
  concurrently too, and the illustrator logs per-phase durations).
- Tuning: `CATALOG_MIN_FIT_SCORE` (default 3), `CATALOG_WRITER_MODEL`,
  `CATALOG_WRITER_MAX_ATTEMPTS` (default 3, clamped 1-6),
  `CATALOG_WRITER_MAX_REPAIRS` (default 2, clamped 0-6),
  `CATALOG_QA_VISION_MODEL` (default `gemini-2.5-flash`),
  `CATALOG_WORLD_QA_MAX_RERENDERS` (default 3),
  `CATALOG_SPREAD_QA_MAX_REPAIRS` (default 1 since #295, clamped 0-4).

## Endpoints

- `GET /v13/themes` — catalog theme vocabulary (the app picker's source of truth)
- `GET /v13/coverage` — sidecar authoring coverage + flag state
- `POST /v13/select-books` — sync `{sessionId, themeId, profile}` →
  3 candidates + scores + seed (persist before generating)
- `POST /v13/generate-stories` — `{bookId, bookIds[1..3], profile, sessionId,
  callbackUrl, writerTuning?}` → 202; callback `{stories:[{bookDefinitionId,
  request, response, nameOnly, usage}], failures}`. **This is the admin
  story-only test mode** — no illustration spend. `writerTuning`
  (`{versionLabel, hash, text}`, also accepted by `/generate-book` for fresh
  generations) is the app-owned Style Tuning Layer: appended below the locked
  engine at prose-polish priority, echoed as `versions.writer_tuning`
  (`<label>.<hash8>` or `none`), capped at 8KB, killed by
  `CATALOG_TUNING_LAYER=0`. The engine prompt file stays locked; see
  `docs/AI_WRITER_FEEDBACK_LOOP_PLAN.md`.
- `POST /generate-book` — `{bookId, profile, story:{request,response} |
  bookDefinitionId, approvedCoverUrl, childPhotoUrls, textLayout,
  heartfeltNote, bookFrom, bindingType, callbackUrl, progressCallbackUrl,
  forceNew, forceRerender, identityKeyed?, seed?}` → 202; completion callback
  mirrors the legacy shape (interiorPdfUrl, coverPdfUrl, previewImageUrls,
  storyContent, qaAdvisories, warnings, costs) + `pipelineVersionUsed:
  'catalog-v13'`, `illustratorVersionUsed: 'catalog-slim'`.
  `storyContent.catalog` carries
  bookDefinitionId/themeId/ageBand/versions/evidence/omissions.
  `identityKeyed`/`seed` are the probe-compat cache knobs for the Art
  Bench's **"create final book"** dispatch: sent with the SAME anchor URL,
  characterDescription, illustrationTuning, and textLayout the bench probed
  with, the final Lulu pair (interior + cover PDF) is assembled from the
  exact approved probe renders (cache replay; never-probed spreads render
  fresh through the same QA + world gate). Customer books omit both and
  keep the legacy un-salted cache keys.
- `POST /v13/render-spreads` — the **admin render-test (probe) mode** for the
  illustration feedback loop: `{bookId, story:{request,response}, spreads[1..12
  subset], profile, approvedCoverUrl|childPhotoUrls, textLayout,
  illustrationTuning?, dispatchId?, seed?, probeNonce?, forceRerender?,
  rerenderSpreads?, callbackUrl}` → 202; callback `{renders:[{spread, url,
  storageKey, qa:{pass, advisories}}], failures:[{spread, message}],
  illustrationTuningUsed, costs}` (+dispatchId echo). Renders a SUBSET of an
  existing validated story's spreads through the exact production path — zero
  writer spend, no PDFs/cover/upsell; per-spread render errors land in
  `failures`, never fail the probe. Probe and `/v13/generate-stories` runs
  register in the watchdog's activity tracking under their own
  `probe:`/`stories:` map keys (2026-09-03; before that the global idle
  check `process.exit(0)`'d the instance ~10 min into an unregistered
  background run — every long probe died with no callback), with the
  illustrator's 30s heartbeats wired to `touchActivity`. `rerenderSpreads` (a unique subset of
  `spreads`) is the per-spread force: the listed spreads render FRESH while
  the rest replay from cache as world-gate references, so the gate can
  correct the fresh render against the set it must match — the
  "make this one spread match the rest" operation (`forceRerender` stays
  the all-or-nothing variant). Probe cache keys fold in the identity
  anchor (URL path + characterDescription) and any `seed` (applying the seed
  stays gated by `BOOK_PIPELINE_V3_RENDER_SEED`), so an anchor swap or seed
  change never replays stale renders. `illustrationTuning` (`{versionLabel,
  hash, text?, spreads?}`, also accepted by `/generate-book`) is the app-owned
  Art Tuning Layer: the full prompt's final binding-within-scope block
  (`ce-7` — see the illustrator section), echoed as
  `illustrationTuningUsed` + `storyContent.catalog.illustrationTuning`
  (`<label>.<hash8>` or `none`), capped at 2000B global / 400B per spread /
  3000B total, killed by `CATALOG_ART_TUNING_LAYER=0`. See
  `docs/AI_ILLUSTRATION_FEEDBACK_LOOP_PLAN.md`.
- `POST /v13/generate-cover-image` — **admin probe-anchor cover** (sync, like
  `/rebuild-cover-pdf`): `{bookId, title?, childName, childAge?,
  childPhotoUrl|childPhotoUrls, artStyle?, bookFormat?, bindingType?}` →
  `{coverUrl, gcsPath, title, coverAnatomyAdvisory, costs}`. Renders ONLY the
  front-cover key art from a child photo through the exact production cover
  path (`coverGenerator.generateFrontCoverImage` — the same coverScene +
  wardrobe/anatomy QA + retries `generateCover` runs), uploads to
  `children-covers/{bookId}/anchor-cover-{ts}.png`, so Art Bench render
  probes can anchor on a cover the way production books do (plan §5.1). No
  wrap PDF, no upsell; `title` is echoed for labeling, never painted (D5).
- `POST /v13/prepare-identity` — (ce-9) `{bookId, approvedCoverUrl,
  childPhotoUrls?, profile:{name,age}?, characterDescription?}` → sync
  `{bookBible:{characterSheet:{url,hash,likeness}, outfitSpec:{text,hash,
  source}, advisories}}`: builds (or fetches) the identity kit for an anchor
  so the app can prepare it at cover approval; 422 `identity_kit_failed`
  when no sheet candidate passes. `/generate-book` builds it lazily
  otherwise (GCS election converges both paths on one sheet).
- `POST /v13/pick-candidate` — (ce-9) `{bookId, storageKey}` (a
  `…/spread-N.<aspect>.cK.png` candidate from a `consistency_unresolved`
  failure payload) → promotes it to the spread's canonical key with an
  admin-vouched marker; a re-dispatch of `/generate-book` (no
  `forceRerender`) then replays it into the PDFs.
- `POST /v13/generate-video` — (gv-2, `docs/GIFT_VIDEO_PLAN.md` revision 4)
  the **gift video**: `{bookId, renders:[{spread, storageKey}],
  story:{request,response}, profile, approvedCoverUrl|childPhotoUrls,
  characterDescription?, textLayout, illustrationTuning?, identityKeyed?,
  seed?, probeNonce?, provider?, model?, aspect?, music?, forceNew?,
  dispatchId?, callbackUrl, progressCallbackUrl?}` → 202 `{videoVersion,
  provider, model, accepted:{spreads}}`; callback `{video:{url, storageKey,
  posterUrl, posterKey, hash, durationSeconds, width, height, fps, bytes,
  music, cached}, plan:[{index: 0, kind: 'journey', spread: null, spreads,
  seconds, motion: 'journey', acts:[{index, spread, from, to, angle, move}],
  startFrame:{storageKey, renderHash, rerendered}, endFrame:{…}|null,
  clip:{storageKey, hash, score, candidates, repairs}}], stills:[{spread,
  storageKey, score, quality, reasons, disqualified, unchecked, picked,
  rerendered}], textGate, bookBible, unresolved, advisories, warnings,
  costs, failureCode, error}` — every key present on failure. A 10-second,
  text-free, FULLY ANIMATED film of a finished book as ONE continuous take:
  **the best illustrations are picked FIRST** (`video/stillSelect.js` — every
  shipped render judged once by a strict-JSON vision call for what a film
  frame needs: no painted text or overlay, no side reserved for a text
  panel, no band/panel, the child fully in frame, `complete_picture` +
  quality 1-5; verdicts pinned per render hash under
  `gift-video/{VIDEO_VERSION}/stills/`; a deterministic ranking picks the
  best `CATALOG_VIDEO_SCENES` in story order with spacing/bookend bonuses so
  equal stills give an evenly spaced arc; painted text, a band or a missing
  child disqualify — every render disqualified by text fails
  `video_text_visible`, otherwise `video_no_sources` with the reasons), then
  **one clip** carries the child through them (`video/plan.js`: one
  `journey` segment, one ACT per pick with a distinct camera ANGLE from a
  closed vocabulary keyed by the spread's shot type and the MOVE that
  carries the take into it — band 1-3 calm; `video/brief.js`
  `buildJourneyBrief`: "ONE continuous, unbroken shot … no cuts", a MOMENT
  line per act with its time window, action, camera; companion / emotion /
  props / lock / negative lines from pinned data; the identity kit as
  `@Element` references). The take opens on the first pick as `start_image`
  and — when the model profile `supportsEndFrame` and `CATALOG_VIDEO_END_FRAME`
  is on — lands on the last pick as `end_image` (a 422 while the end frame
  rides the input resubmits ONCE without it, flagged `endFrameDropped` with
  an advisory; `CATALOG_VIDEO_MODEL_INPUT_JSON` renames the field). The
  cover is no longer a segment (it stays the identity reference); before
  gv-2 a film cost four to sixteen vendor clips (cover + opening + peak +
  resolution × 2 candidates + repairs) and never read as one story.
  `renders[]` are the EXACT canonical render keys the app holds (candidate
  keys are rejected). An EMBEDDED book paints its text into every render,
  so there is nothing text-free to choose from: the story-arc trio
  (`pickStorySpreads`, kept only for this) is re-rendered text-free through
  `renderStorySpreads` under the `half` layout (its `wide-plain` key) and
  gated by the same judge afterwards. That gate RECOVERS (2026-09-07): a
  "text-free" render can still carry in-world lettering the beat invites
  (a moon map labelled "CRATER 1 CRATER 2"), the illustrator ships it
  with the blocking finding on record (ship-on-exhaustion), and before the
  fix the film failed `video_text_visible` on the first hit — and a
  re-dispatch replayed the same lettered bytes from the cache for ever.
  Now a rejected frame is re-rendered FRESH (`rerenderSpreads`) first,
  then `alternateSpread` substitutes the nearest untried spread for its
  role, within `CATALOG_VIDEO_TEXT_GATE_RETRIES` (default 2) extra
  renders; the illustrator's own `painted text` blocking finding rejects a
  frame whatever the still judge says (a judge outage never passes it);
  `textGate[]` on the failure lists every lettered attempt, and each
  recovery rides a stage `video` advisory. Provider adapters (`video/providers/`
  — Replicate's `kwaivgi/kling-v3-video` by default on the existing
  `REPLICATE_API_TOKEN`; the app's body-injected copy is the fallback),
  N candidates per take (`CATALOG_VIDEO_CLIP_CANDIDATES`, default 1) each
  VERIFIED (`video/verify.js`: five sampled frames through
  `checkSpreadRenderV2` against the sheet — each frame checked against the
  ACT its timestamp falls in (that moment's beat, emotion, companion, a
  bath act's null outfit spec), worst frame governs — plus ONE video-level
  judge for morphing / identity drift / outfit change / new character /
  text / speech / frozen / a CUT (`cut break`, BLOCKING — the take must be
  one unbroken shot) and, advisory, `journey break` (the surroundings never
  change) and `composition break` (the camera angle never changes);
  `select.js` scoring), best promoted to
  `children-jobs/{bookId}/gift-video/{VIDEO_VERSION}/clips/s0-{clipHash}.mp4`
  (+ `.qa.json`; candidates keep their own `.cK` / `.rPcK` bytes), a bounded
  repair loop (`CATALOG_VIDEO_CLIP_MAX_REPAIRS`, default 1; single-take /
  journey / camera repair notes) while BLOCKING defects remain, then
  `video/ffmpeg.js` finishes the take (blur-fill, white fades, silent AAC
  or a bundled music bed) at exactly 10 s and uploads `{planHash}/video.mp4
  + poster.jpg + video.json`. Fail-closed: `video_unresolved` carries
  `unresolved:[{segment: 0, spread: null, spreads, defects,
  candidates:[{storageKey, url, score}]}]` — no stills fallback
  (`CATALOG_VIDEO_SHIP_ON_EXHAUSTION=1` is the opt-in); other codes:
  `video_no_sources`, `video_source_missing`, `video_text_visible`,
  `video_provider_unavailable`, `video_provider_input_rejected`,
  `video_encode_failed`, plus the inherited identity/story codes. The run
  registers a `video:{bookId}` book context so the idle watchdog never
  kills a job that polls a vendor for minutes. Kill-switch
  `CATALOG_GIFT_VIDEO=0` (503).
- `POST /v13/pick-clip` — (gv-1) `{bookId, storageKey}` (a
  `…/clips/s0-{hash}.cK.mp4` candidate from a `video_unresolved` payload)
  → promotes it to the take's canonical clip key with an admin-vouched
  marker; a re-dispatch of `/v13/generate-video` (no `forceNew`) replays it
  and only re-finishes the film.
- `/generate-book` completion callbacks now also carry `bookBible`,
  `contactQa`; failure callbacks may carry `failureCode:
  'consistency_unresolved'` + `unresolved[]` + `qaAdvisories` + `bookBible`,
  or `identity_kit_failed`. `/v13/render-spreads` callbacks carry
  `bookBible`, `contactQa`, `unresolved[]`, and the request accepts
  `identityKeyed:false` (customer-key per-spread re-render).
- `POST /v13/set-text-layout`, `POST /v13/preview/embedded-overlay` — layout
  flip + pre-print overlay preview (entries from the request). Text layouts:
  `caption` (art page + white text page), `half` (FULL-SPREAD wide
  text-free art — the scene pushes the child and all key action into the
  RIGHT half — assembled as art recto + a UNIFORM solid text panel verso;
  cached under `wide-plain` so half and embedded wide renders never
  replay each other), `embedded` (wide Gemini-painted text). ALL typeset
  text pages — caption pages and half panels alike — share ONE book-wide
  typographic standard (`computeBookCaptionBlock`: same serif, brown ink,
  fixed `BOOK_CAPTION_FONT_SIZE` on every spread; the smaller ladder steps
  are an overflow safety valve only, never per-caption auto-sizing).
- `/generate-book` also bakes the 4-style upsell spread into the interior
  (non-blocking, 4-min cap; `upsellCovers` on the completion callback)
- `POST /v13/generate-coloring-book` — (cb-1, `docs/COLORING_BOOK_V2_PLAN.md`)
  the **coloring book**: `{bookId, dispatchId?, story:{request,response},
  profile, approvedCoverUrl, childPhotoUrls?, characterDescription?,
  pageCount?, pages?: [subset], forceNew?, callbackUrl, progressCallbackUrl?}`
  → 202 `{coloringVersion, plan:{band, pages}}`; callback `{planHash, cached,
  interiorPdfUrl, coverPdfUrl, coverImageUrl, previewImageUrls, pageCount,
  coloringPageCount, pages:[{index, kind, anchor, title, moment,
  momentSource, storageKey, url, qa:{pass, blocking, advisory, metrics},
  candidates, repairs, cached}], plan:{hash, band, kinds, peakSpread,
  momentWriter, gateRejections}, bookBible (+ lineSheet, companionLineSheet,
  borderPlate), gates:{contact, stroke}, unresolved, preflight, advisories,
  warnings, costs, failureCode, error}` — every key present on failure.
  Companion scenes from the story world — the moments the picture book does
  NOT show — as verified line art (see the `coloring/` section). Failure
  codes: `coloring_disabled` (503), `invalid_story`,
  `missing_book_definition`, `missing_identity_reference`,
  `coloring_identity_failed`, `coloring_unresolved` (+ `unresolved:[{page,
  kind, defects, candidates:[{storageKey,url,score}]}]`),
  `coloring_pdf_failed` (a Lulu preflight failure included), `cancelled`.
  `pages` (a subset) renders those pages only, no PDFs — the admin's
  iteration loop. 409 `in_flight` while a run is live on the book.
- `POST /v13/pick-coloring-candidate` — `{bookId, storageKey}` (a
  `…/coloring/{cb}/{planHash}/page-N.cK.png` / `.rPcK.png` candidate from a
  `coloring_unresolved` payload) → promotes it to the page's canonical key
  with an admin-vouched marker; a re-dispatch (no `forceNew`) replays it
  into the PDFs. `POST /v13/cancel-coloring-book` `{bookId}` aborts a run.
- `POST /v13/generate-audiobook` — (ab-1, `docs/AUDIOBOOK_V2_PLAN.md`) the
  **audiobook**: `{bookId, dispatchId?, story:{request,response}, profile,
  language? (en|es|he), cast?:{narrator?, companion?} (cast.json keys),
  dedication?:{text, from}, audioTuning?, segments?:[subset],
  forceRetake?:[spreads], forceNew?, callbackUrl, progressCallbackUrl?,
  ELEVENLABS_API_KEY?}` → 202 `{engine, audioVersion, cast, language,
  accepted:{segments}}`; callback `{success, bookId, dispatchId, engine,
  audioVersion, qaVersion, scriptHash, cached, audiobookUrl, storageKey,
  timelineUrl, timeline (segments / spreads[].lines[].start,end / chapters
  / music / motifs / sfx / pageTurns / ambience / speechWindows),
  durationSeconds, bytes, loudness, cast, script, audioTuningUsed,
  language, pronunciations, segments:[{index, kind, spread, cached,
  chunks:[{chunk, speaker, storageKey, url, seconds, lufs, qa:{pass,
  blocking, advisory, qaUnavailable, wordMatch, transcript}, candidates,
  repairs, cached, rung, adminPicked?}]}], music, sfx, ambience, gates:
  {loudness, speechMusicRatio, deadAir, startle, listen}, unresolved:
  [{segment, spread, chunk, defects, candidates:[{storageKey, url,
  score}]}], advisories, warnings, costs, elapsedMs, failureCode, error,
  subset?, cancelled?}` — every key present on failure. Progress events
  ride `stage: 'audiobook'`. 409 `in_flight` while a run is live.
- `POST /v13/audiobook-audition` — (ab-1) `{bookId, story, profile,
  language?, cast?, spread? (1), forceNew?}` → sync `{url, storageKey,
  spread, seconds, wordMatch, transcript, cast, blocking, advisory,
  unresolved, costs}`: one spread through the full take path on a cast —
  the Audio Bench's voice picker. `GET /v13/audiobook-cast?themeId&ageBand`
  → `{narrators, companions, recommended:{narrator, companion},
  languages, castHash}` (the vocabulary the app offers; never duplicated
  there). `POST /v13/pick-take` `{bookId, storageKey}` (a `…/takes/{hash}/
  chunkN.cK.wav` / `.rPcK.wav` candidate from an `audiobook_unresolved`
  payload) → promotes it with an admin-vouched marker; a re-dispatch (no
  `forceNew`) replays it into the mix. `POST /v13/cancel-audiobook`
  `{bookId}` aborts a run.
- Kept: `/finalize-book` (legacy layout), `/rebuild-cover-pdf`, `/comics/*`,
  `/manage-checkpoint`, `/upload-*`, `/refresh-url`, health checks.
- 410 stubs: `/regenerate-illustration`, `/generate-style-variant`,
  `/get-spread-data`, and since cb-1 `/generate-coloring-book`,
  `/cancel-coloring-book`, `/rebuild-coloring-cover-pdf` (the pre-cb-1
  coloring book — free-text scene invention, raw-photo identity, a hard
  threshold as the line-art mechanism, no QA, a model-lettered pencil cover
  — was deleted outright). Game endpoints are deleted (404).

## Kept services (untouched by the cutover)

`luluSpec.js` (the Lulu print spec + picture-book preflight — see
`pipeline.js` above), `coverGenerator.js` (Lulu wrap cover, its canvas from
`luluSpec.coverGeometry`; still the identity/style anchor —
since 2026-09-07 every cover prompt it builds carries `FLAT_COVER_ART_RULE`:
a cover IS the printed surface, full-bleed to all four edges, NEVER a
picture of a book — no 3D mockup, pages, spine, shadow, border, mat, card
or background; `qaCoverFlatArtwork` is the matching vision gate on the
front cover with one hardened retry, ship-and-flag as `coverArtworkAdvisory`
beside `coverAnatomyAdvisory`, and a pre-generated cover is flagged as-is;
the app's cover OPTIONS carry the same rule and DROP a cover that still
depicts a book — `coverArtworkGuard.js` there),
`layoutEngine.js` (pdf-lib layout; entries contract unchanged),
`comics/`, `gcsStorage`, `progressReporter`,
`costTracker`, `retry`, `workerCommits`, `promptSanitizer`,
`shared/llm/openaiClient.js`, `shared/text/sanitize.js`,
`shared/illustration/config.js`. `illustrationGenerator.js` is the shared
Gemini image client + key pool + photo utils (cover, coloring, comics, and
the slim illustrator all sit on it) — `opts.gcsPath` pins a deterministic
upload path for the render cache.

## Sidecar authoring (COMPLETE — all 228 approved)

Every catalog book has an approved `selection_profile` + `personalization_map`
sidecar in `data/augments/approved/` (full coverage is asserted by a test and
the boot log; `GET /v13/coverage` reports it). 12 are hand-tuned reference
files; the other 216 were generated by `scripts/buildSidecars.js` —
deterministic per-archetype slot scaffolds placed on the beats that actually
support them (food slots only on explicit celebration beats in
human-food-plausible themes; never underwater/dream/animal-feed books) with
theme + archetype + beat-keyword selection tags. Sidecars are versioned files,
NEVER generated at runtime; to revise one, edit the file (or rerun the script
after deleting it) and commit. `scripts/draftSidecars.js` remains for
LLM-drafting alternatives into `drafts/` (never loaded).

## Checkpoints & resume

`children-jobs/{bookId}/checkpoint.json` (`engine: 'catalog-v13'`,
`completedStage: story|illustration`, the story pair, textLayout). A legacy
(pre-cutover) checkpoint restarts fresh, loudly. Cleared on success. Render
resume comes from the STYLE_VERSION-keyed cache, not the checkpoint; the
Book Bible's manifest sits beside it (`bible.json`) and its assets are
elected per anchor/theme under `catalog-assets/`.

## Environment Variables

- `API_KEY`, `GCS_BUCKET_NAME` — auth + storage
- `OPENAI_API_KEY` — the writer (gpt-5.4). Required; boot guard + `/healthz`.
- `GEMINI_API_KEY` (+ `GEMINI_API_KEY_1..10` pool, `GOOGLE_AI_STUDIO_KEY`) —
  renders + vision QA + coloring/comics
- `DEEPSEEK_API_KEY` — no longer required (legacy pipelines deleted)
- `REPLICATE_API_TOKEN` — the gift video's default provider host (Kling 3.0 on
  Replicate); optional at boot — the app also injects its copy into every
  worker request body, which the adapter accepts as the fallback
- `ELEVENLABS_API_KEY` — the audiobook's narrator / sound-effects (and
  Eleven Music) host; optional at boot — the app injects its copy into
  every children-worker request body, which the adapters accept as the
  fallback. Lyria (the default score provider) reads the Vertex project
  from `GOOGLE_CLOUD_PROJECT` / `GCP_PROJECT` / `GCLOUD_PROJECT` with
  application-default credentials; `FFMPEG_PATH` for the mix.
- Catalog flags above

## Conventions

- All functions use JSDoc comments
- Error handling with retries and exponential backoff
- Cost tracking per generation (`CostTracker`)
- Progress reporting via webhook callbacks (`progressReporter`)
- Never edit `data/catalog.json` plots; sidecars are additive and versioned
- Bump `versions.js` identifiers when prompts/formulas change
