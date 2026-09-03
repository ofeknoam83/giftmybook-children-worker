/**
 * Version identifiers pinned on every catalog-engine request/response.
 *
 * The V1.3 runtime contract requires every generation to echo the exact
 * versions it ran with (writer engine, age engine, catalog, book definition,
 * personalization map, map schema, selector, prompt template, model) so a
 * stored book is fully reproducible and rollback never guesses.
 *
 * Bump rules:
 *  - WRITER_ENGINE_VERSION: any edit to data/writerEngine.system.md
 *  - AGE_ENGINE_VERSION: any edit to data/ageEngines.json — ALSO add a
 *    matching bounds table to ageBounds.js BOUNDS_BY_ENGINE and keep the
 *    old tables (stored stories re-validate under their pinned version)
 *  - PROMPT_TEMPLATE_VERSION: any edit to the user-prompt assembly in writer.js
 *  - SELECTOR_VERSION: any change to the fit-score formula or tie-breaking
 *  - CATALOG_VERSION comes from data/catalog.json itself
 *
 * versions.writer_tuning is NOT pinned here: it carries the Style Tuning
 * Layer tag (`<label>.<hash8>`) from the per-request writerTuning overlay the
 * main app sends, or 'none'. The base engine file stays locked either way.
 */

const WRITER_ENGINE_VERSION = '1.3.0';
const AGE_ENGINE_VERSION = '1.4.0'; // 1.4.0: tightened word budgets (1-3: 8-30/spread, 4-5: 30-40, 6-7: 40-50, 8-10: 50-60; totals = 12 spreads)
const MAP_SCHEMA_VERSION = '1.3.0';
const BOOK_DEFINITION_VERSION = '1.1.0'; // the frozen V1.1 plots, per the handoff
const SELECTOR_VERSION = '1.0.0';
const PROMPT_TEMPLATE_VERSION = '1.2.0'; // 1.2.0: scope-subordinate tuning frame + end-of-prompt style checkpoint + polish pass; 1.1.0: HARD LIMITS caps line + per-book detail pre-selection

/** Illustration style version — bump to invalidate the render cache. */
// ce-2: embedded layout paints the story text INTO the art (Gemini embedText
// path + text-verify QA) — pre-ce-2 wide renders are text-free and must
// never replay as embedded spreads.
// ce-3: embedded text placement hardened — ONE block on ONE side (left or
// right 35%), painted over continuous artwork, never split across both
// sides or letterboxed onto a blank band; QA gates placement. ce-2 embedded
// renders may carry band/split text and must never replay.
// ce-4: embedded typography locked — straight, level, LEFT-ALIGNED text
// lines with even spacing, and ONE book-wide font/size/color (the pinned
// TEXT_RULES spec rides every stateless render; per-scene color retinting
// removed); QA gates alignment (text_lines_misaligned) and intra-block
// consistency (text_style_inconsistent). ce-3 embedded renders may carry
// wavy lines or per-spread type drift and must never replay.
// ce-5: world consistency — every scene prompt carries the theme's fixed
// WORLD-LAW card (worldCards.json: palette, era, physical/magical laws) and
// renders anchor on a fixed per-theme world plate (worldPlate.js, a second
// reference image identical on every spread; its hash also rides the cache
// key). Editing worldCards.json changes pixels — bump this version again.
// ce-4 renders were specified against no world card and must never replay.
// ce-6: continuity props — the child's comfort object (visual_required
// object_presence evidence) persists visually on every spread AFTER its
// introduction (scenes.js CONTINUITY PROP line; kill-switch
// CATALOG_PROP_CONTINUITY). Scene prompts changed for every story carrying
// object evidence — ce-5 renders must never replay as ce-6.
// ce-7: outfit lock + binding tuning placement — every render now pins a
// per-anchor OUTFIT LOCK spec derived from the identity reference
// (outfitLock.js; its content hash also rides the cache key, kill-switch
// CATALOG_OUTFIT_LOCK), and the Art Tuning block moved from mid-prompt to
// the FULL prompt's final block with a binding-within-scope frame
// (tuning.js + buildCharacterPrompt). Both change prompt assembly — ce-6
// renders must never replay as ce-7.
// ce-8: shot plan + hermetic outfit lock — every spread carries its
// ASSIGNED composition (shotPlan.js: deterministic shot type, staging,
// placement, embedded text side; kill-switch CATALOG_SHOT_PLAN with a
// -sp0 cache fold when off), the renderer gained a low-angle shot type
// and the identity-anchor "never copy its pose/composition" rule, the
// outfit lock derives a structured full-coverage v2 spec (elected
// completion for anchor-cropped garments, new v2/ GCS path), and per-
// spread QA now gates shot_type_mismatch and outfit_mismatch against the
// pinned specs while the world gate judges composition_duplicate. Scene
// prompts and prompt assembly changed for every book — ce-7 renders must
// never replay as ce-8.
// ce-9: the Book Bible + selection gate — every render anchors on a per-
// anchor CHARACTER MODEL SHEET (bible/characterSheet.js; the outfit spec now
// derives from the sheet, every slot seen) plus per-prop / companion
// reference sheets (bible/propSheet.js) attached as a labeled REFERENCE PACK,
// the prompt is restructured into single CHARACTER / PROPS / COMPANION /
// EMOTION blocks (buildCharacterPrompt bible mode), spreads render N
// candidates scored by the structured QA verdict v2 (spreadQa.js, the sheets
// attached to the check) and the better one is selected, and blocking
// residual defects fail the book `consistency_unresolved` instead of
// shipping. Prompt assembly, reference parts, and scene prompts all changed
// — ce-8 renders must never replay as ce-9.
// ce-10: bench-feedback generalization — face visibility (no full back
// views: the shot plan's 'seen from behind' staging gained a face-visible
// turn, every composition directive carries a fixed FACE line), prop
// discipline (scene prompts + bible PROPS block close the personal-object
// set: no invented toys/gadgets/trinkets), carried-prop subordination
// (muted, never attention-grabbing), an anti-generic-smile suffix on the
// pinned EMOTION line, and hard-left-margin phrasing on the embedded
// TEXT_RULES alignment spec. All are prompt-text changes — ce-9 renders
// must never replay as ce-10.
// ce-11: the companion is pinned by the MANUSCRIPT, not just the beat —
// companionOnSpread (scenes.js) reads the beat AND the spread's story text
// (companion name as a case-sensitive whole word, or the full type phrase)
// and the one signal gates the scene's companion line, the companion sheet
// in the reference pack, the COMPANION prompt block, and the QA companion
// check. Beats name most companions only on spreads 1/12, so mid-book
// spreads whose story featured the companion rendered it reference-less
// and unchecked (a different-looking creature per spread). Scene prompts
// changed for every such story — ce-10 renders must never replay as ce-11.
// ce-12: the page fold — the embedded TEXT PLACEMENT rule now states the
// print reality (the image is TWO facing pages; the vertical centerline is
// the physical fold that cuts any word crossing it) and QA gates
// text_in_center_gutter (plus a deterministic text-bbox straddle check)
// as a BLOCKING placement defect with its own repair note. The renderer's
// embedded-text prompt changed — ce-11 renders must never replay as ce-12.
// ce-13: typeset-by-prompt — the renderer PRE-WRAPS the manuscript into
// short lines (TEXT_RULES.maxCharsPerLine) and orders the model to keep the
// breaks, pins the shot plan's assigned text side as a CONCRETE column box
// (x within the edge/active-side bounds, y within the top/bottom padding
// band) with the centerline framed as a hard wall, and the FONT SIZE spec
// became a concrete small body-type measure (cap height ≈ 2% of the image
// height) that must fit the column with many lines rather than grow. The
// embedded-text prompt changed — ce-12 renders must never replay as ce-13.
// ce-14: smaller painted text — the FONT SIZE spec drops from cap height
// ≈ 2% to ≈ 1.5% of the image height (line pitch ≈ 2.8%; the 3–8 tier
// nearer 1.3%), framed as "about a third of the usual AI caption size, when
// unsure go smaller", and the renderer's FONT SIZE line says to err on the
// side of too small. Prompt text changed — ce-13 renders must never replay
// as ce-14.
// ce-15: painted text held to a FOOTPRINT and a REFERENCE — the renderer
// states each spread's block size concretely (widest row → "about X% of
// the width wide, Y% of the height tall"; the type never grows to fill the
// column), forwards the shot plan's assigned text side at last (since
// ce-13 generateIllustration dropped `textSide`, so every production
// render got the "pick a side" wording), widens the no-panel rule to
// cards/plaques/signs/boards/parchment/banners, adds a TEXT COLUMN calm-
// scenery hint to the scene, ends the prompt with a TEXT FINAL CHECK, and
// attaches the book's OWN first painted page (a text-side crop —
// illustrator/textAnchor.js) as the TYPOGRAPHY REFERENCE for every other
// embedded spread. Prompt assembly and the reference pack changed — ce-14
// renders must never replay as ce-15.
// ce-16: SMALLER painted text — the owner's call after ce-15: the pinned
// spec steps down ~27% (cap height 1.5% → 1.1% of the image height, line
// pitch 2.8% → 2.1%, footprint 0.6% → 0.45% of the width per character;
// the 3–8 tier to 0.95% / 1.9% / 0.38%), the FONT SIZE prose says "about a
// QUARTER of the usual caption size", the typography anchor page renders
// CATALOG_TEXT_ANCHOR_CANDIDATES (default 3) so a small page exists to
// elect, candidate selection now prefers the smaller measured block, and
// CATALOG_EMBEDDED_IMAGE_SIZE (opt-in) requests a larger output size so
// small glyphs stay crisp. Prompt text changed — ce-15 renders must never
// replay as ce-16.
// ce-17: the text sits INSIDE the picture — the first ce-16 round shipped a
// blurred, darkened haze zone behind every text block (the ce-15 column
// hint's "calm scenery … gentle depth haze … no busy detail" read as "blur
// the column", and the typography anchor copied page 1's haze book-wide).
// Every text rule now demands the scene under and around the letters at
// FULL sharpness, colour and detail (legibility from a thin outline only),
// the column hint asks for the scene's simpler areas at full sharpness, the
// fontColor spec drops the "soft shadow" for a tight outline, and the
// typography reference's label says the same. Prompt text changed — ce-16
// renders must never replay as ce-17.
// ce-18: ONE INK, measured. The ce-17 round painted dark brown text on the
// bright spreads and inverted to white on the darker ones — contrast-
// seeking, because "soft warm ivory" is illegible on a pale savanna sky, so
// the model broke the spec to stay readable and nothing measured the
// result (`text_style_inconsistent` only ever caught a block mixing
// colours WITHIN itself). The pinned ink is now the polarity that survives
// a bright picture book — deep warm cocoa-brown #2A1C12, stated as a name
// AND a hex, legible via a thin pale hairline instead of an inverted fill
// — and that hex is the gate's target too. Prompt text changed on every
// embedded render — ce-17 renders must never replay as ce-18.
const STYLE_VERSION = 'ce-18';

/**
 * Spread-QA verdict version — written into every render's `.qa.json`
 * marker. A replay whose marker predates the current version re-checks the
 * cached render instead of trusting a verdict the older checker produced
 * (ce-9: shipped drift stops being permanent).
 * qa-3 (ce-10): the v2 verdict gains the face-visibility and undeclared-
 * personal-object soft fields (both advisory-class), and the outfit
 * mismatch definition now names a missing/added/different garment
 * pattern, print, or graphic.
 * qa-4 (ce-11): the embedded band/split placement defects
 * ('embedded story text sits on a blank band…' / '…split across both
 * sides…') are reclassified BLOCKING (a white text panel breaks the
 * embedded layout's full-bleed contract; it used to ship as an advisory),
 * and the companion check now runs on every spread whose manuscript names
 * the companion, not only beat-named spreads. Markers written under qa-3
 * were judged with softer eyes — replays re-check.
 * qa-5 (ce-12): the verdict gains `text_in_center_gutter` (required with
 * embedded text) and the soft `text_bbox`; text crossing the page fold —
 * judged, or a bbox straddling the middle tenth — is a BLOCKING placement
 * defect ('embedded story text crosses the page fold (center gutter)').
 * qa-6 (ce-13): compareTexts flags a missing FIRST or LAST word as edge
 * truncation ("ron checked the ground" for "Aaron checked …" passed the
 * 25% word-bag threshold), so a block cut by the frame is garbled text.
 */
/**
 * qa-7 (ce-15): the ruler — the v2 verdict's `text_bbox` is held to the
 * block's footprint (the same numbers the prompt stated): ≥ 1.6× too wide
 * or too tall is the BLOCKING 'embedded story text too large', ≥ 1.3× the
 * advisory 'embedded story text oversized'. Markers written under qa-6
 * never measured size — replays re-check.
 */
/**
 * qa-8 (ce-16): the ruler's footprint shrank with the spec and its
 * thresholds tightened (too large ≥ 1.5×, oversized ≥ 1.25×); the verdict
 * exposes `textSizeRatio` for selection. Markers written under qa-7 were
 * measured against the larger footprint — replays re-check.
 */
/**
 * qa-9 (ce-17): the v2 verdict gains `text_backdrop_treated` (required with
 * embedded text) — a blurred, fogged, softened, darkened, lightened,
 * desaturated, or emptied area behind the text is the BLOCKING 'embedded
 * story text sits on a treated backdrop', the soft cousin of the band; the
 * world gate's TEXT TREATMENT dimension names it too. qa-8 markers never
 * judged it — replays re-check.
 */
/**
 * qa-10 (ce-18): the verdict's text bbox is measured for INK COLOUR
 * (metrics.textInkColour: the glyph fill isolated from its background,
 * CIE76 ΔE against the book's pinned hex). A wrong-ink block is the
 * BLOCKING 'embedded story text ink colour differs', the measurement rides
 * the result as `textInk` for candidate scoring and the book-level ink
 * gate, and the marker keeps it so a replayed spread still counts toward
 * the book's ink set. Markers written under qa-9 never measured ink —
 * replays re-check.
 */
const QA_VERSION = 'qa-10';

/**
 * Gift-video version (docs/GIFT_VIDEO_PLAN.md §4.7) — owns the film + clip
 * cache namespace (`children-jobs/{bookId}/gift-video/{VIDEO_VERSION}/…`).
 * Bump on any change to the film plan rules, the duration table, the clip
 * brief template, or the stitch graph: gv-(N-1) films must never replay as
 * gv-N. Provider and model are inside the clip hash, not this version.
 */
const VIDEO_VERSION = 'gv-1';

module.exports = {
  WRITER_ENGINE_VERSION,
  AGE_ENGINE_VERSION,
  MAP_SCHEMA_VERSION,
  BOOK_DEFINITION_VERSION,
  SELECTOR_VERSION,
  PROMPT_TEMPLATE_VERSION,
  STYLE_VERSION,
  QA_VERSION,
  VIDEO_VERSION,
};
