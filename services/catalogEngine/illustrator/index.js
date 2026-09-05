/**
 * Slim illustrator — renders the CHOSEN story's 12 spreads.
 *
 * Design (deliberate contrast with the deleted native illustrator):
 *  - the fixed catalog beat IS the scene (no art director, no concept pass);
 *  - identity anchors on the parent-APPROVED COVER character and, since
 *    ce-9, on the BOOK BIBLE built from it (bible/index.js): a character
 *    model sheet, the outfit spec derived from that sheet, prop and
 *    companion sheets, the world plate, and an emotion plan — every fixed
 *    input as pixels + schema-validated specs, hashed into the cache key
 *    and attached to every render as a labeled REFERENCE PACK;
 *  - every spread renders N CANDIDATES (CATALOG_RENDER_CANDIDATES, default
 *    2), each scored by the structured QA verdict v2 (spreadQa.js — checked
 *    AGAINST the sheets) plus deterministic metrics (metrics.js), and the
 *    best is selected; bounded corrective re-renders run only while
 *    BLOCKING defects remain (CATALOG_SPREAD_QA_MAX_REPAIRS + a separate
 *    CATALOG_DRIFT_MAX_REPAIRS budget for identity/outfit/prop defects);
 *  - the set-level gate keeps the ce-5 world check and adds ce-9 CONTACT
 *    SHEETS (contactSheet.js): the child crops of every spread beside the
 *    model sheet, and the prop crops beside their sheets, in one call each;
 *  - graded ship policy: advisory-class residuals ship with advisories (as
 *    always); BLOCKING residuals fail the book `consistency_unresolved`
 *    with the spread's candidates attached, unless CATALOG_SHIP_ON_EXHAUSTION=1;
 *  - renders cache under a deterministic STYLE_VERSION-keyed GCS path so a
 *    re-dispatch replays finished spreads instead of re-paying for them; the
 *    `.qa.json` marker records the QA_VERSION it was checked under.
 *
 * Text policy (per layout — 2026-08-31 change of D5):
 *  - `caption` layout: words are PDF type, never pixels — renders use
 *    skipTextEmbed and QA hard-checks readable_text as a defect.
 *  - `embedded` layout: the story text is painted INTO the art by Gemini
 *    (the legacy embedText path: prompt typography rules + OCR verify with
 *    extra retries inside generateIllustration), and spread QA verifies the
 *    painted text matches the manuscript instead of forbidding it.
 */

const { generateIllustration, downloadPhotoAsBase64, isModestBathWaterScene } = require('../../illustrationGenerator');
const { downloadBuffer, uploadBuffer, getSignedUrl, deletePrefix } = require('../../gcsStorage');
const { buildScenePrompt, hasCarryThroughProps, visualPropsForSpread, continuityPropsForSpread, companionOnSpread, inertPropValue } = require('./scenes');
const { checkSpreadRenderV2, repairNoteV2, checkWorldConsistency, worldRepairNote, classifyDefects } = require('./spreadQa');
const { normalizeArtTuning, renderArtTuningBlock } = require('./tuning');
const { buildShotPlan, renderShotDirective } = require('./shotPlan');
const { buildBookBible, buildReferencePack, buildPromptBible, summarizeBible, propSheetFor } = require('./bible');
const { candidateKey, scoreCandidate, isClean, pickBest, compareCandidates, residualBlocking, hasDriftDefect } = require('./select');
const metrics = require('./metrics');
const { checkCharacterContactSheet, checkPropContactSheet, contactRepairNote } = require('./contactSheet');
const { normalizePropValue } = require('./bible/propSheet');
const { EMOTIONS, EMOTION_CUES } = require('./emotionPlan');
const { renderWorldCardBlock } = require('../worldCards');
const { STYLE_VERSION, QA_VERSION } = require('../versions');
const { fnv1a } = require('../selection');
const flags = require('../flags');
const { electTypographyAnchor, readPinnedTypographyAnchor, anchorPinPath } = require('./textAnchor');
const { expectedTextBlock } = require('../../shared/illustration/textBlock');
const { resolvePictureBookTextRules } = require('../../shared/illustration/config');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Spreads rendered in parallel (each slot fans out into
// CATALOG_RENDER_CANDIDATES concurrent image calls) — env-tunable
// (CATALOG_RENDER_CONCURRENCY, default 6 per the refactor plan's key-pool
// sizing; was a hardcoded 4). Also bounds the set gates' parallel repairs.
const RENDER_CONCURRENCY = () => flags.renderConcurrency();

/**
 * Fingerprint of one rendered image's bytes — written into its `.qa.json`
 * marker so a replay can prove the marker vouches for THESE pixels (a
 * failed overwrite must never pair new bytes with an old verdict).
 * @param {Buffer} buffer
 * @returns {string}
 */
function renderContentHash(buffer) {
  return fnv1a(buffer.toString('base64')).toString(36);
}

/**
 * Content fingerprint of the story the renders are staged for: same story →
 * replay; a regenerated manuscript (different text) → fresh renders. Keyed
 * on the definition id + every spread's text (what the scenes are built
 * from), NOT on request ids (those change on every run).
 * @param {object} story validated writer response
 * @returns {string}
 */
function storyFingerprint(story) {
  const basis = `${story.book_id}|${(story.spreads || []).map(s => s.text).join('|')}`;
  return fnv1a(basis).toString(36);
}

/**
 * Deterministic render-cache path for one spread. The Art Tuning tag is a
 * SECOND, data-owned cache dimension beside the deploy-owned STYLE_VERSION:
 * an overlay changes pixels, so a tuned render must never replay an untuned
 * one (or vice versa). `none` keeps the pre-tuning path byte-identical, so
 * every existing cached book replays untouched.
 * @param {string} bookId
 * @param {string} storyHash storyFingerprint of the story being illustrated
 * @param {number} spread
 * @param {string} aspect 'square' | 'wide'
 * @param {string} [tuningTag] `<label>.<hash8>` or 'none'
 * @returns {string}
 */
function renderCachePath(bookId, storyHash, spread, aspect, tuningTag = 'none') {
  const styleKey = tuningTag && tuningTag !== 'none' ? `${STYLE_VERSION}+${tuningTag}` : STYLE_VERSION;
  return `children-jobs/${bookId}/ce-renders/${styleKey}/${storyHash}/spread-${spread}.${aspect}.png`;
}

/**
 * Corrective per-spread QA re-renders allowed per spread (cost bound). Each
 * extra render happens only for a spread that keeps failing QA; 0 disables
 * repairs entirely (failing renders ship straight to advisory).
 */
const SPREAD_QA_MAX_REPAIRS = () => {
  const n = Number(process.env.CATALOG_SPREAD_QA_MAX_REPAIRS);
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : 2;
};

/**
 * ce-15: the embedded sibling of the half-layout print hint — the column
 * the story text is painted over (the shot plan's side + the TEXT_RULES
 * geometry the renderer states) is asked for as the scene's simpler areas
 * at FULL sharpness (ce-17: "calm scenery / gentle depth haze" was read as
 * "blur the column" — every page shipped a soft haze panel), so small
 * letters are legible WITHOUT the card/board/panel/blur the model otherwise
 * reaches for. Fixed template text over pinned numbers; rides
 * the scene and the generic-safe fallback suffix. Pure — exported for tests.
 * @param {'left'|'right'|null} side the assigned text side (null → no hint)
 * @param {object} rules resolvePictureBookTextRules(childAge)
 * @returns {string} '' without a side
 */
function renderTextColumnHint(side, rules) {
  if (side !== 'left' && side !== 'right' || !rules) return '';
  const edge = rules.edgePaddingPercent;
  const active = rules.activeSideMaxPercent;
  const top = rules.topPaddingPercent ?? rules.cornerVerticalPaddingPercent;
  const bottom = rules.bottomPaddingPercent ?? rules.cornerVerticalPaddingPercent;
  const xRange = side === 'left' ? `x from ${edge}% to ${active}%` : `x from ${100 - active}% to ${100 - edge}%`;
  return `\nCOMPOSITION FOR PRINT (TEXT COLUMN): the story text is painted over the ${side.toUpperCase()} column of this image (${xRange} of the width, y from ${top}% to ${100 - bottom}% of the height). Compose that column from the scene's naturally simpler areas — sky, open ground, distance, water, a wall — rendered at FULL sharpness, colour, and detail like the rest of the picture: NEVER blur, fog, soften, darken, lighten, desaturate, or empty it, and never lay a card, board, panel, band, glow, or vignette there — the small letters get their legibility from their own thin, tight pale hairline, not from treating the background and never from inverting the dark ink to light text. No faces, companion, props, or signage inside the column; the scenery continues through it edge to edge; the child and all key action live outside it.`;
}

/** Corrective world-gate re-renders allowed per run (cost bound). */
const WORLD_QA_MAX_RERENDERS = () => {
  const n = Number(process.env.CATALOG_WORLD_QA_MAX_RERENDERS);
  return Number.isInteger(n) && n >= 0 ? n : 3;
};

/** Corrective contact-sheet re-renders allowed per run (ce-9, cost bound). */
const CONTACT_QA_MAX_RERENDERS = () => {
  const n = Number(process.env.CATALOG_CONTACT_MAX_RERENDERS);
  return Number.isInteger(n) && n >= 0 ? n : 3;
};

/**
 * Whether a verdict still calls for a corrective render: any BLOCKING
 * defect, or an embedded-text defect (the ce-3/ce-4 typography contract
 * repaired on every failing render before ce-9 and still does).
 * @param {{blocking?: string[], advisory?: string[], qaUnavailable?: string}} qa
 * @returns {boolean}
 */
function needsRepair(qa) {
  if (!qa || qa.qaUnavailable) return false;
  if (Array.isArray(qa.blocking) && qa.blocking.length > 0) return true;
  // ce-16: the 'oversized' advisory (1.25–1.5× the footprint) shades
  // selection only — the judged bbox is too rough on small blocks to spend
  // repair renders on; 'too large' (≥ 1.5×) is blocking and repairs.
  return (qa.advisory || []).some(d => d.startsWith('embedded story text') && !d.startsWith('embedded story text oversized'));
}

/**
 * Deterministic metrics for one candidate (fail-open: any failure → null
 * fields). Bbox rules and garment colours run whenever the verdict gave a
 * bbox; the embedding identity score is opt-in (CATALOG_IDENTITY_METRICS).
 * @returns {Promise<{bbox: object|null, colour: object|null, identityScore: number|null, crop: Buffer|null}>}
 */
async function runMetrics({ buffer, qa, bible, shotType, aspect, textLayout, ageBand, log }) {
  const out = { bbox: null, colour: null, identityScore: null, crop: null };
  try {
    if (!qa || !qa.bbox) return out;
    out.bbox = metrics.bboxRules({ bbox: qa.bbox, shotType, aspect, textLayout, ageBand });
    const crop = await metrics.cropBbox(buffer, qa.bbox);
    out.crop = crop;
    if (crop && bible.outfit && bible.outfit.spec) {
      const colours = await metrics.regionColours(crop);
      if (colours) out.colour = metrics.outfitColourCheck(colours, bible.outfit.spec);
    }
    if (crop && bible.sheet && flags.identityMetricsEnabled()) {
      out.identityScore = await metrics.identityScore({ renderCrop: crop, sheetCrop: Buffer.from(bible.sheet.base64, 'base64'), log });
    }
  } catch (err) {
    log('warn', `metrics unavailable (${err.message})`);
  }
  return out;
}

/**
 * Render (or replay) one spread; returns the layout-ready record. `fresh`
 * marks pixels created by THIS call (base render or repair) — a cache
 * replay is not fresh, and only fresh renders are eligible for the set-level
 * gates' corrective re-render.
 * @returns {Promise<{spread: number, buffer: Buffer|null, storageKey: string, url: string|null, advisories: object[], fresh: boolean, blocking: string[], candidates: object[], qa: object|null, bbox: object|null}>}
 */
async function renderSpread({ bookId, book, theme, profile, story, storyHash, spread, aspect, cacheAspect, textLayout, characterRefUrl, refPhoto, characterDescription, tuning, bible, shotEntry, worldNote, seed, costTracker, forceRerender, reviewedOnly = false, ageBand, typographyAnchor = null, candidateCount = null, log }) {
  const tuningTag = tuning ? tuning.tag : 'none';
  // Embedded layout paints the story text into the art (Gemini + OCR
  // verify); caption and half layouts stay text-free (words are PDF type).
  const embedText = textLayout === 'embedded';
  const storageKey = renderCachePath(bookId, storyHash, spread, cacheAspect || aspect, tuningTag);
  // The render is uploaded to the cache key BEFORE QA runs, so the image
  // alone does not prove it was ever checked: only this marker (written
  // after QA/repair completes) lets a replay skip the check.
  const qaMarkerKey = `${storageKey}.qa.json`;
  const advisories = [];

  const beat = book.beats.find(b => b.spread === spread);
  const spreadText = story.spreads.find(s => s.spread === spread)?.text || '';
  const evidence = story.personalization_evidence;
  const scene = buildScenePrompt({
    book, theme, spread, spreadText, profile,
    evidence,
    embedText,
  });
  // The Art Tuning Layer rides the scene string tagged with its 'ART
  // TUNING' marker; the renderer's prompt builder re-attaches it as the
  // FULL prompt's last block (buildCharacterPrompt), where its frame
  // (renderArtTuningBlock) binds it on rendering style and continuity
  // while yielding to the action, identity/count, text, medium, and
  // safety rules.
  const tuningBlock = renderArtTuningBlock(tuning, spread);
  // The spread's assigned composition (shotPlan.js): fixed template text
  // appended BEFORE the half-layout hint, any set-gate repair note, and
  // the Art Tuning block — all of those still outrank it.
  const shotDirective = renderShotDirective(shotEntry);
  const sceneWithShot = shotDirective ? `${scene}\n${shotDirective}` : scene;
  // Half layout: the art is a FULL-SPREAD wide composition, but in print
  // the LEFT page is covered by the solid text panel — the model must keep
  // everything that matters in the surviving right half.
  const halfHint = textLayout === 'half'
    ? '\nCOMPOSITION FOR PRINT (HALF-PAGE LAYOUT): this artwork prints as a full spread whose LEFT half is covered by a solid text panel. Place the child and ALL key story action fully in the RIGHT half of the image; keep the LEFT half continuous calm background (water, sky, foliage, scenery) with no faces, no companion, and no critical story elements there.'
    : '';
  // ce-15: the embedded sibling of the half hint (renderTextColumnHint).
  const textRules = embedText ? resolvePictureBookTextRules(profile?.age) : null;
  const columnHint = embedText ? renderTextColumnHint(shotEntry ? shotEntry.textSide : null, textRules) : '';
  const sceneWithLayout = `${sceneWithShot}${halfHint}${columnHint}`;
  // BATH/WATER MODE spreads deliberately change the child's coverage — the
  // pinned outfit spec must not be enforced against them (the renderer's own
  // heuristic decides, so QA and prompt agree on which spreads those are).
  const bathWater = isModestBathWaterScene(scene, spreadText);

  // ── The Book Bible on THIS spread: the reference pack (fixed order +
  // labels) and the structured prompt blocks that cite it. Declared props
  // are the evidence spread's own; carried props are the comfort object
  // riding every later spread (ce-6).
  const declaredProps = visualPropsForSpread(evidence, spread).map(inertPropValue).filter(Boolean);
  const carriedProps = flags.propContinuityEnabled()
    ? continuityPropsForSpread(evidence, spread).map(inertPropValue).filter(p => p && !declaredProps.includes(p))
    : [];
  // ce-11: the companion signal reads the beat AND the spread's manuscript
  // text — the same signal gates the scene line (buildScenePrompt), this
  // reference pack, the COMPANION prompt block, and the QA companion check,
  // so a companion the story puts on a mid-book spread is always rendered
  // against its sheet and verified, never freestyled.
  const companionPresent = !!(beat && companionOnSpread(beat, spreadText, theme.companion, { theme, childName: profile?.name }));
  const { pack, refs } = buildReferencePack(bible, {
    refPhoto,
    propValues: [...declaredProps, ...carriedProps],
    companionOnSpread: companionPresent,
    // ce-15: the book's own first painted page (text-side crop) as the
    // TYPOGRAPHY REFERENCE — only on spreads other than the anchor itself.
    typographyAnchor: embedText && typographyAnchor && typographyAnchor.base64 ? typographyAnchor : null,
  });
  const promptBible = buildPromptBible(bible, refs, {
    spread, declaredProps, carriedProps, companionOnSpread: companionPresent, characterDescription: characterDescription || null,
  });
  const outfitSpecText = bible.outfit ? bible.outfit.outfit : null;
  // worldNote: a set-level gate's corrective suffix on its one targeted
  // re-render (always with forceRerender, so the cache never conflates a
  // gate-repaired render with a base one at a stale key). A gate that must
  // cite one of THIS render's reference images passes a function of the
  // pack's indices (the prop contact gate names the prop sheet to match).
  const worldNoteText = typeof worldNote === 'function' ? worldNote(refs) : (worldNote || null);
  const sceneWithWorldNote = worldNoteText ? `${sceneWithLayout}\n${worldNoteText}` : sceneWithLayout;
  const baseScene = tuningBlock ? `${sceneWithWorldNote}\n${tuningBlock}` : sceneWithWorldNote;
  const sheetImage = bible.sheet ? { base64: bible.sheet.base64, mimeType: bible.sheet.mimeType || 'image/png' } : null;

  // Per-attempt diagnostics sink (filled by generateIllustration): when the
  // render fails, the advisory carries WHY — variant ladder, NSFW blocks,
  // Gemini finish/block reasons, the model's own refusal text.
  const renderOpts = {
    aspectRatio: aspect === 'wide' ? '16:9' : '1:1',
    // Embedded layout runs the renderer's text-embed path: typography rules
    // in the prompt, plus OCR verification with extra retries for
    // text-heavy spreads (verifyImageText inside generateIllustration).
    skipTextEmbed: !embedText,
    ...(embedText ? { embedText: true, pageText: spreadText } : {}),
    isSpread: true,
    spreadIndex: spread - 1,
    totalSpreads: 12,
    childName: profile.name,
    childAge: profile.age,
    characterDescription: characterDescription || null,
    // The outfit spec still rides as `characterOutfit` for the renderer's
    // generic-safe rung (its OUTFIT line) — bible mode states it ONCE in the
    // CHARACTER block and switches the legacy repetition off.
    ...(outfitSpecText ? { characterOutfit: outfitSpecText } : {}),
    // The assigned shot type arms the renderer's composition enforcement;
    // the assigned text side (ce-13) pins the painted text's COLUMN in the
    // renderer's TEXT ZONE rule — one deterministic side per spread instead
    // of "pick a side" — so the column, the child's placement, and the QA
    // gate all agree on where the words live.
    ...(shotEntry ? { shotType: shotEntry.shotType } : {}),
    ...(shotEntry && shotEntry.textSide ? { textSide: shotEntry.textSide } : {}),
    // ce-15: the pack index of the TYPOGRAPHY REFERENCE (the renderer's
    // text rules cite it: "match REFERENCE IMAGE N").
    ...(Number.isInteger(refs.typographyRef) ? { typographyRef: refs.typographyRef } : {}),
    // ce-16: opt-in output size for embedded renders (CATALOG_EMBEDDED_IMAGE_SIZE) —
    // more pixels per glyph is what keeps SMALL painted text crisp at print.
    ...(embedText && flags.embeddedImageSize() ? { imageSize: flags.embeddedImageSize() } : {}),
    bookId,
    costTracker,
    // The identity anchor bytes still ride (the renderer's with-photo
    // branch); with a reference pack the pack's cover entry is what the
    // model actually receives, in its labeled slot.
    childPhotoUrl: characterRefUrl,
    _cachedPhotoBase64: refPhoto.base64,
    _cachedPhotoMime: refPhoto.mimeType,
    // ce-9: the reference pack replaces the anchor+plate pair (the plate is
    // the pack's last entry), and the structured bible blocks ride the
    // prompt ONCE (renderBibleBlocks) — including on the generic-safe rung.
    ...(pack.length > 0 ? { referencePack: pack } : {}),
    bible: promptBible,
    // The world-law card, the assigned composition, any gate repair note,
    // AND the Art Tuning block must survive the renderer's generic-safe
    // NSFW fallback — that variant discards the scene, and a render that
    // lost its corrective instruction (or the admin's approved style
    // direction, or its assigned composition) would ship as if it had been
    // given them. All are fixed text: the card is versioned data, the
    // directive is closed-vocabulary template text (shotPlan.js), the note
    // maps a closed enum, the tuning is admin-approved and sanitized
    // (tuning.js).
    safeFallbackSuffix: [renderWorldCardBlock(theme.theme_id), shotDirective, columnHint.trim(), worldNoteText, tuningBlock].filter(Boolean).join('\n') || null,
    // Workbench probes may pin a seed for tighter A/B; applying it stays
    // env-gated inside the renderer (BOOK_PIPELINE_V3_RENDER_SEED, with a
    // retry-without on seed-rejecting models). The seed also rides the
    // cache key upstream, so differently-seeded probes never replay each
    // other.
    ...(seed != null ? { seed } : {}),
  };

  // The structured QA check against the bible — the SAME pinned inputs on
  // every candidate, repair, and replay re-check of this spread.
  const qaOpts = {
    expectedText: embedText ? spreadText : null,
    // qa-10 (ce-18): the book's ONE pinned ink — the target the painted
    // block's MEASURED colour is held to (the same hex the prompt states).
    inkHex: embedText && flags.textInkQaEnabled() ? textRules.fontColorHex : null,
    // qa-7: the block's footprint — the ruler the judged text bbox is held to.
    expectedBlock: embedText ? (({ widthPercent, heightPercent }) => ({ widthPercent, heightPercent }))(expectedTextBlock(spreadText, textRules)) : null,
    shotType: shotEntry ? shotEntry.shotType : null,
    outfitSpec: outfitSpecText,
    bathWater,
    sheet: sheetImage,
    props: [...declaredProps, ...carriedProps].map(name => {
      const sheet = propSheetFor(bible, name); // normalized match (case/whitespace)
      // A declared prop is the beat's evidence (absence BLOCKS); a carried
      // comfort object is continuity decoration (absence is advisory).
      return { name, specText: sheet ? sheet.specText || null : null, sheet: sheet ? { base64: sheet.base64, mimeType: sheet.mimeType || 'image/png' } : null, expected: declaredProps.includes(name) ? 'required' : 'carried' };
    }),
    companion: companionPresent && theme.companion && theme.companion.name
      ? { name: theme.companion.name, type: theme.companion.type || null, sheet: bible.companion ? { base64: bible.companion.base64, mimeType: bible.companion.mimeType || 'image/png' } : null }
      : null,
    beat: beat ? beat.beat : null,
    emotion: promptBible.emotion ? { emotion: promptBible.emotion.emotion, intensity: promptBible.emotion.intensity, cue: EMOTION_CUES[promptBible.emotion.emotion] || null } : null,
    emotionVocabulary: EMOTIONS,
  };
  const runQa = (buffer, label) => checkSpreadRenderV2(buffer, { label, ...qaOpts });
  const repairOpts = (qa) => ({
    shotType: qaOpts.shotType,
    outfitSpec: outfitSpecText,
    sheetRef: refs.characterSheetRef,
    expectedBlock: qaOpts.expectedBlock,
    typographyRef: Number.isInteger(refs.typographyRef) ? refs.typographyRef : null,
    inkHex: qaOpts.inkHex,
    props: qaOpts.props.map(p => ({ name: p.name, specText: p.specText, ref: refs.props[p.name] || null })),
    companion: qaOpts.companion ? { name: qaOpts.companion.name, ref: refs.companionRef } : null,
    beat: qaOpts.beat,
    emotion: qaOpts.emotion,
  });
  const metricsFor = (buffer, qa) => runMetrics({ buffer, qa, bible, shotType: qaOpts.shotType, aspect, textLayout, ageBand, log });

  // ── Replay ──────────────────────────────────────────────────────────────
  if (reviewedOnly && forceRerender) throw new Error('Reviewed rebuild cannot generate new artwork');
  let cachedBuffer = null;
  let url = null;
  if (!forceRerender) {
    try {
      const cached = await downloadBuffer(storageKey);
      try {
        const marker = JSON.parse((await downloadBuffer(qaMarkerKey)).toString('utf8'));
        // The marker vouches for SPECIFIC pixels under a SPECIFIC checker: a
        // forced overwrite that failed before its marker write leaves new
        // bytes beside the old marker, and an older QA_VERSION judged with
        // older eyes — either way the replay re-checks instead of trusting it.
        if (marker.renderHash !== renderContentHash(cached)) throw new Error('marker does not match the cached render');
        if (marker.qaVersion !== QA_VERSION) throw new Error(`marker predates ${QA_VERSION}`);
        // An unresolved marker never vouches — EXCEPT the one case where the
        // opt-in ship policy already shipped those pixels with their defects
        // on the record: replaying them keeps the book's advisories and
        // `unresolved[]` truthful instead of re-spending the repair budget
        // on every dispatch. Turn the switch off and the replay re-checks.
        if (marker.unresolved && !(marker.shippedOnExhaustion && flags.shipOnExhaustion())) throw new Error('marker records unresolved blocking defects');
        const markerBlocking = marker.unresolved && Array.isArray(marker.qa?.blocking) ? [...marker.qa.blocking] : [];
        log('info', `Spread ${spread}: replaying cached QA-checked render (${cached.length} bytes${markerBlocking.length > 0 ? `, ${markerBlocking.length} BLOCKING defect(s) on record` : ''})`);
        return {
          spread, buffer: cached, storageKey,
          url: await getSignedUrl(storageKey, SIGNED_URL_TTL_MS),
          advisories: Array.isArray(marker.advisories) ? marker.advisories : [],
          fresh: false,
          bathWater,
          blocking: markerBlocking,
          candidates: [],
          candidateFiles: [],
          qa: marker.qa || null,
          bbox: marker.qa?.bbox || null,
          propBoxes: Array.isArray(marker.qa?.propBoxes) ? marker.qa.propBoxes : [],
        };
      } catch (markerErr) {
        // No marker (crash between upload and check), a marker for other
        // pixels, or an older checker — re-check the cached image instead
        // of approving it.
        if (reviewedOnly) throw markerErr;
        log('warn', `Spread ${spread}: cached render not QA-vouched (${markerErr.message}) — re-checking before replay`);
        cachedBuffer = cached;
        url = await getSignedUrl(storageKey, SIGNED_URL_TTL_MS);
      }
    } catch (err) {
      if (reviewedOnly) throw new Error(`Reviewed artwork unavailable for spread ${spread}: ${err.message}. Restore or explicitly re-render this spread.`);
      // cache miss — render fresh
    }
  } else {
    // A forced re-render overwrites a possibly-marked key: drop the stale
    // marker FIRST so a failure anywhere before the new marker write leaves
    // unmarked pixels (re-checked on replay), never new pixels vouched for
    // by the old marker. Best-effort — the hash check above is the backstop.
    await deletePrefix(qaMarkerKey).catch(() => {});
  }

  // ── Candidates ──────────────────────────────────────────────────────────
  // Render N candidates concurrently, score each with QA v2 + metrics, keep
  // the best. Only the N=1 BASE pass renders straight to the shipped key
  // (the pre-ce-9 flow); every repair pass renders beside it (`.r{p}c{k}`)
  // so a rejected repair never overwrites the better pixels the key holds,
  // and every scored candidate keeps its own bytes for the failure payload.
  // ce-16: the caller may widen the candidate count (the typography anchor
  // page renders CATALOG_TEXT_ANCHOR_CANDIDATES — the whole book copies it).
  const nCandidates = Number.isInteger(candidateCount) && candidateCount >= 1 ? Math.min(candidateCount, 4) : flags.renderCandidates();
  let fresh = false;
  let checkerUnavailable = false;
  const candidateLog = [];
  let best = null;

  const renderCandidates = async (sceneText, passLabel, pass = 0) => {
    const list = await Promise.all(Array.from({ length: nCandidates }, (_, i) => i + 1).map(async (k) => {
      const key = pass > 0 || nCandidates > 1 ? candidateKey(storageKey, k, pass) : storageKey;
      const attemptLog = [];
      let cUrl = null;
      try {
        cUrl = await generateIllustration(sceneText, characterRefUrl, 'pixar_premium', { ...renderOpts, attemptLog, gcsPath: key });
      } catch (err) {
        // One thrown candidate costs only that candidate (the others may
        // still ship); when EVERY candidate throws, the first error
        // propagates with its attempt log — the legacy single-render
        // contract (renderStorySpreads turns it into the spread's
        // `render errored` advisory with detail.attempts).
        if (!Array.isArray(err.attempts) && attemptLog.length > 0) err.attempts = attemptLog;
        return { k, key, url: null, buffer: null, attemptLog, error: err };
      }
      if (!cUrl) return { k, key, url: null, buffer: null, attemptLog };
      const buffer = await downloadBuffer(key);
      const qa = await runQa(buffer, `spreadQa:${bookId}:s${spread}:${passLabel}c${k}`);
      const m = await metricsFor(buffer, qa);
      const accepted = attemptLog.find(a => a.accepted);
      return { k, key, url: cUrl, buffer, attemptLog, qa, metrics: m, score: scoreCandidate({ qa, metrics: m }), variant: accepted ? accepted.variant : 'original' };
    }));
    for (const c of list) candidateLog.push({ pass: passLabel, k: c.k, key: c.key, score: c.score ?? null, defects: c.qa ? c.qa.defects : null, variant: c.variant || null, error: c.error ? String(c.error.message || c.error) : null });
    return list;
  };

  if (cachedBuffer) {
    // Unvouched cached pixels: re-check them as the single candidate.
    const qa = await runQa(cachedBuffer, `spreadQa:${bookId}:s${spread}:recheck`);
    const m = await metricsFor(cachedBuffer, qa);
    best = { k: 0, key: storageKey, url, buffer: cachedBuffer, attemptLog: [], qa, metrics: m, score: scoreCandidate({ qa, metrics: m }), variant: 'cached' };
  } else {
    const list = await renderCandidates(baseScene, 'base');
    const rendered = list.filter(c => c.buffer);
    if (rendered.length === 0 && list.every(c => c.error)) throw list[0].error;
    if (rendered.length === 0) {
      const attempts = list.flatMap(c => c.attemptLog);
      advisories.push({
        stage: 'render', spread,
        note: `render failed (all prompt variants rejected on ${list.length} candidate${list.length === 1 ? '' : 's'}) — spread has no illustration`,
        ...(attempts.length > 0 ? { detail: { attempts } } : {}),
      });
      return { spread, buffer: null, storageKey, url: null, advisories, fresh: false, bathWater, blocking: [], candidates: candidateLog, qa: null, bbox: null };
    }
    best = pickBest(rendered);
    fresh = true;
  }
  if (best.qa && best.qa.qaUnavailable) {
    checkerUnavailable = true;
    // A checker outage must never report silently clean: ship best-effort,
    // but say so on the completion payload.
    advisories.push({ stage: 'spreadQa', spread, note: `shipped UNCHECKED — ${best.qa.qaUnavailable}` });
  }
  if (best.variant && best.variant !== 'original' && best.variant !== 'cached') {
    // The safety-fallback ladder rebuilt (sanitized) or discarded
    // (generic-safe) the scene — never silent (ce-9).
    advisories.push({ stage: 'render', spread, note: `rendered from the "${best.variant}" fallback prompt after a safety block — scene content may be reduced; QA verified the result against the bible` });
  }

  // ── Bounded corrective re-render loop ───────────────────────────────────
  // Runs only while the best candidate still carries BLOCKING (or embedded
  // text) defects; each pass renders N fresh candidates steered by the
  // LATEST verdict's defects and adopts the higher-scoring result. Drift-
  // class defects draw on their own extra budget so a stubborn text defect
  // cannot starve an outfit fix. Best-effort by contract: any repair-path
  // failure ships the best render so far (with an advisory).
  const generalBudget = SPREAD_QA_MAX_REPAIRS();
  const driftBudget = flags.driftMaxRepairs();
  let generalUsed = 0;
  let driftUsed = 0;
  let repairAborted = false;
  while (!checkerUnavailable && !repairAborted && needsRepair(best.qa)) {
    const drift = hasDriftDefect(best.qa.blocking);
    let budgetName;
    if (generalUsed < generalBudget) { generalUsed += 1; budgetName = `${generalUsed}/${generalBudget}`; } else if (drift && driftUsed < driftBudget) { driftUsed += 1; budgetName = `drift ${driftUsed}/${driftBudget}`; } else break;
    log('warn', `Spread ${spread} QA failed (${best.qa.defects.join('; ')}) — corrective re-render ${budgetName}`);
    try {
      const repairedScene = `${baseScene}\n${repairNoteV2(best.qa.defects, embedText ? spreadText : null, repairOpts(best.qa))}`;
      const pass = generalUsed + driftUsed;
      const list = await renderCandidates(repairedScene, `repair${pass}`, pass);
      const rendered = list.filter(c => c.buffer);
      if (rendered.length === 0) {
        advisories.push({ stage: 'spreadQa', spread, note: `repair render failed; shipped render with defects: ${best.qa.defects.join('; ')}` });
        repairAborted = true;
        break;
      }
      const repairedBest = pickBest(rendered);
      if (repairedBest.qa && repairedBest.qa.qaUnavailable) {
        // The checker went away mid-loop: an UNCHECKED repair never
        // replaces a render whose defects are known (the book fails
        // `consistency_unresolved` with both on the candidate list, and
        // the admin sees the unchecked one scored below any checked one);
        // repairing further would spend renders with no verdict to steer.
        advisories.push({ stage: 'spreadQa', spread, note: `repair could not be verified (${repairedBest.qa.qaUnavailable}) — kept the checked render with defects: ${best.qa.defects.join('; ')}` });
        repairAborted = true;
        break;
      }
      // Tier first (checked > unchecked, blocking-free > blocking), score
      // within the tier — a repair that cleared the blocking defect is
      // adopted even when advisories/metrics leave its score lower.
      if (compareCandidates(repairedBest, best) >= 0) {
        best = repairedBest;
        fresh = true;
      }
    } catch (repairErr) {
      log('warn', `Spread ${spread} repair errored (${repairErr.message}) — shipping the best render so far`);
      advisories.push({ stage: 'spreadQa', spread, note: `repair render errored (${repairErr.message}); shipped render with defects: ${best.qa.defects.join('; ')}` });
      repairAborted = true;
    }
  }

  // ── Ship the winner at the canonical key ────────────────────────────────
  // Candidates rendered beside the key; the winner is COPIED to the shipped
  // key so replay, markers, the world gate, and the PDF all read ONE image.
  let buffer = best.buffer;
  if (best.key !== storageKey) {
    try {
      await uploadBuffer(buffer, storageKey, 'image/png');
    } catch (err) {
      // A failed promotion leaves the key holding stale bytes with no
      // marker (the marker hash check re-checks on replay); the shipped
      // buffer + a candidate URL still let the book complete.
      log('warn', `Spread ${spread}: could not promote the winning candidate to the cache key (${err.message})`);
      advisories.push({ stage: 'render', spread, note: `winning candidate could not be written to the cache key (${err.message}) — a replay will re-render` });
    }
  }
  url = await getSignedUrl(storageKey, SIGNED_URL_TTL_MS);

  const blocking = residualBlocking(best);
  if (!best.qa || best.qa.qaUnavailable) {
    // unchecked — already advised above
  } else if (best.qa.defects.length > 0 && !repairAborted) {
    const spent = generalUsed + driftUsed;
    const budgetNote = spent > 0 ? `after ${spent} repair render(s)` : (generalBudget === 0 ? '(repairs disabled)' : '(no repair budget applied)');
    advisories.push({
      stage: 'spreadQa', spread,
      note: blocking.length > 0
        ? `BLOCKING residual defects ${budgetNote}: ${blocking.join('; ')}${best.qa.advisory.length > 0 ? ` (advisory: ${best.qa.advisory.join('; ')})` : ''}`
        : `shipped with advisory defects: ${best.qa.advisory.join('; ')}`,
    });
  }
  // bbox rule findings ride as advisories too (deterministic composition/safe-zone).
  if (best.metrics && best.metrics.bbox && Array.isArray(best.metrics.bbox.notes)) {
    for (const n of best.metrics.bbox.notes) advisories.push({ stage: 'composition', spread, note: n });
  }

  // Persist the QA-complete marker so future replays skip the check
  // (best-effort — a failed write only means the replay re-checks). NOT
  // written when the checker itself was unavailable: the next replay must
  // re-attempt a real check instead of inheriting "shipped UNCHECKED".
  if (!checkerUnavailable) {
    try {
      await uploadBuffer(
        Buffer.from(JSON.stringify({
          advisories, tuningTag,
          renderHash: renderContentHash(buffer),
          qaVersion: QA_VERSION,
          qa: best.qa ? { defects: best.qa.defects, blocking: best.qa.blocking, advisory: best.qa.advisory, bbox: best.qa.bbox || null, propBoxes: Array.isArray(best.qa.propBoxes) ? best.qa.propBoxes : [], textInk: best.qa.textInk || null, score: best.score } : null,
          // An unresolved marker never vouches: the next replay re-checks
          // (an admin may have raised budgets or picked a candidate) —
          // unless the opt-in ship policy shipped it, which the marker
          // records so the replay keeps reporting the defects it carries.
          ...(blocking.length > 0 ? { unresolved: true } : {}),
          ...(blocking.length > 0 && flags.shipOnExhaustion() ? { shippedOnExhaustion: true } : {}),
          checkedAt: new Date().toISOString(),
        })),
        qaMarkerKey,
        'application/json',
      );
    } catch (mErr) {
      log('warn', `Spread ${spread}: QA marker write failed (${mErr.message}) — a replay will re-check`);
    }
  }
  // bathWater rides the result so the set gates can exempt these spreads
  // from outfit judgments (their coverage legitimately differs).
  return {
    spread, buffer, storageKey, url, advisories, fresh, bathWater,
    blocking,
    candidates: candidateLog,
    // Every scored candidate that still holds its own bytes (the N=1 base
    // render lives AT the canonical key, which the promotion above may
    // have overwritten — and picking the canonical key is a no-op anyway).
    candidateFiles: candidateLog.filter(c => c.key && c.key !== storageKey && c.score != null).map(c => ({ storageKey: c.key, score: c.score, pass: c.pass })),
    qa: best.qa || null,
    bbox: best.qa ? best.qa.bbox || null : null,
    propBoxes: best.qa && Array.isArray(best.qa.propBoxes) ? best.qa.propBoxes : [],
    crop: best.metrics ? best.metrics.crop || null : null,
  };
}

/**
 * ce-18 — the book-level INK gate. The per-spread check holds every render
 * to the pinned hex, but its tolerance has to absorb scene light bleeding
 * into thin glyph pixels: two spreads can sit inside it in OPPOSITE
 * directions and still not match each other. This compares every measured
 * ink against the book's own median ink (metrics.inkSetOutliers) and
 * re-renders the outliers — the ce-16 size-outlier shape, applied to
 * colour. Replayed spreads count toward the median (their measured ink
 * rides the QA marker) but are never re-rendered, like every set gate.
 *
 * @param {object} params
 * @param {Array} params.results per-spread records (mutated by the repairs)
 * @param {string|null} params.inkHex the book's pinned ink (for the repair note)
 * @param {(spread: number, note: string) => Promise<object>} params.rerender
 * @param {function} [params.onProgress]
 * @param {function} params.log
 * @returns {Promise<{pass: boolean, checked: number, referenceHex: string|null, flagged?: Array, rerendered?: number[]}|null>}
 */
async function runInkConsistencyGate({ results, inkHex, rerender, onProgress = () => {}, log }) {
  if (!flags.textInkQaEnabled()) return null;
  const measured = results
    .filter(r => r.buffer && r.qa && r.qa.textInk && r.qa.textInk.hex)
    .map(r => ({ spread: r.spread, hex: r.qa.textInk.hex }));
  if (measured.length < 2) return null;
  const { referenceHex, flagged } = metrics.inkSetOutliers(measured);
  if (flagged.length === 0) return { pass: true, checked: measured.length, referenceHex };
  log('warn', `Ink gate: ${flagged.length} spread(s) differ from the book's ink ${referenceHex} (${flagged.map(f => `s${f.spread} ${f.hex} ΔE${f.deltaE}`).join(', ')})`);
  // The repairs below are full render cycles, and the render phase's own
  // heartbeat is already cleared by now: without one here the server's
  // 20-minute idle watchdog can abort a healthy book mid-repair. Same
  // pattern as the world and contact gates.
  const heartbeat = setInterval(() => onProgress(1, 'Ink consistency gate in progress...'), 30000);
  let rerendered;
  try {
    rerendered = await applySetRepairs({
      results,
      // Only the closed defect name and pinned numbers travel; the note is
      // diagnostics for the advisory, never a prompt (noteFor owns that).
      flagged: flagged.map(f => ({ spread: f.spread, defect: 'text_ink', note: `painted ink ${f.hex} differs from the book's ink ${referenceHex} (ΔE ${f.deltaE})` })),
      budget: flags.textInkMaxRerenders(),
      stage: 'textInk',
      rerender,
      noteFor: () => repairNoteV2(['embedded story text ink colour differs'], null, { inkHex }),
      onProgress,
      log,
    });
  } finally {
    clearInterval(heartbeat);
  }
  return { pass: false, checked: measured.length, referenceHex, flagged, rerendered };
}

/**
 * Which flagged spreads a set-level gate may re-render: FRESH renders only
 * (a replayed cached render's storageKey is shared with earlier captured
 * rounds — overwriting it would silently change what they display), oldest
 * flagged first, capped by the re-render budget. Pure — exported for tests.
 * @param {Array<{spread: number, buffer: Buffer|null, fresh?: boolean}>} results
 * @param {Array<{spread: number, note: string}>} flagged
 * @param {number} budget
 * @returns {Array<{spread: number, note: string, skipReason: string|null}>}
 *   every flagged spread, with skipReason null when eligible to re-render
 */
function planWorldRepairs(results, flagged, budget) {
  let remaining = budget;
  // The model's flagged order is arbitrary — spend the budget lowest spread
  // first so the plan is deterministic and matches the documented contract.
  const ordered = [...flagged].sort((a, b) => a.spread - b.spread);
  return ordered.map((f) => {
    const entry = results.find(r => r.spread === f.spread && r.buffer);
    if (!entry) return { ...f, skipReason: 'no render' };
    if (!entry.fresh) return { ...f, skipReason: 'replayed cached render — earlier rounds reference it' };
    if (remaining <= 0) return { ...f, skipReason: `re-render budget exhausted (${budget})` };
    remaining -= 1;
    return { ...f, skipReason: null };
  });
}

/**
 * Apply one set-level verdict's repairs: advisories + one corrective
 * re-render per eligible flagged spread through the full per-spread path.
 * Shared by the world gate and the ce-9 contact-sheet gate.
 * @returns {Promise<number[]>} spreads re-rendered
 */
async function applySetRepairs({ results, flagged, budget, stage, rerender, noteFor, onProgress, log }) {
  const plan = planWorldRepairs(results, flagged, budget);
  // Findings and skip notes land first, in plan order (deterministic); the
  // eligible re-renders then run CONCURRENTLY under the render-phase limit —
  // each targets its own results index, and up to budget serial full-spread
  // cycles per gate was the run's dominant wall-clock tail. Repair spends
  // are already fixed by planWorldRepairs, so parallelism changes nothing
  // about cost or which spreads re-render.
  const eligible = [];
  for (const f of plan) {
    const idx = results.findIndex(r => r.spread === f.spread && r.buffer);
    if (idx === -1) continue;
    const entry = results[idx];
    entry.advisories.push({ stage, spread: f.spread, note: `${stage === 'worldQa' ? 'world consistency' : 'set consistency'}: ${f.note}` });
    if (f.skipReason) {
      entry.advisories.push({ stage, spread: f.spread, note: `shipped without set re-render (${f.skipReason})` });
      continue;
    }
    eligible.push({ f, idx, entry });
  }
  const pLimit = require('p-limit');
  const limit = pLimit(RENDER_CONCURRENCY());
  const rerendered = [];
  await Promise.all(eligible.map(({ f, idx, entry }) => limit(async () => {
    log('warn', `Spread ${f.spread} broke set consistency (${f.defect}: ${f.note}) — one corrective re-render`);
    onProgress(1, `Set repair: re-rendering spread ${f.spread}...`);
    try {
      // The repair prompt is built ONLY from the closed defect enum (plus,
      // for composition_duplicate, the spread's own pinned plan directive)
      // — f.note is free-form diagnostics and never reaches a prompt.
      const repaired = await rerender(f.spread, noteFor(f));
      const worse = repaired.buffer && (repaired.blocking || []).length > (entry.blocking || []).length;
      if (repaired.buffer && !worse) {
        // Keep the audit trail: the gate finding + the fresh render's own
        // advisories ride together on the replacing entry.
        results[idx] = { ...repaired, advisories: [...entry.advisories, ...repaired.advisories] };
        rerendered.push(f.spread);
      } else if (worse) {
        // A set repair must never turn a spread the ship policy would pass
        // into one it fails: a re-render that came back with MORE blocking
        // defects than the flagged render keeps its own candidate bytes
        // but does not replace the entry (the set finding stays advisory).
        // The re-render already overwrote the canonical key — restore the
        // shipped bytes so cache, URL, and PDF stay one image.
        await uploadBuffer(entry.buffer, entry.storageKey, 'image/png').catch((restoreErr) => {
          log('warn', `Spread ${f.spread}: could not restore the shipped render after a worse set re-render (${restoreErr.message})`);
        });
        entry.advisories.push({ stage, spread: f.spread, note: `set re-render carried blocking defects (${repaired.blocking.join('; ')}); kept the flagged render` });
      } else {
        entry.advisories.push({ stage, spread: f.spread, note: 'set re-render failed; shipped the flagged render' });
      }
    } catch (err) {
      // The re-render may have died AFTER uploading new pixels to the
      // shipped entry's storageKey — restore the shipped bytes so the
      // callback URL, the cache, and the PDF stay one image (the stale
      // marker was already dropped; a failed restore just re-checks on
      // the next replay).
      log('warn', `Spread ${f.spread} set re-render errored (${err.message}) — shipping the flagged render`);
      await uploadBuffer(entry.buffer, entry.storageKey, 'image/png').catch((restoreErr) => {
        log('warn', `Spread ${f.spread}: could not restore the shipped render to its cache key (${restoreErr.message})`);
      });
      entry.advisories.push({ stage, spread: f.spread, note: `set re-render errored (${err.message}); shipped the flagged render` });
    }
  })));
  // Concurrent completions land in arbitrary order — the reported list is
  // spread-ordered like everything else in the callback.
  return rerendered.sort((a, b) => a - b);
}

/**
 * The book-level world-consistency gate: ONE multi-image check across the
 * run's renders, then one corrective re-render per flagged FRESH spread
 * (bounded). Runs identically for a full book and a probe subset — a subset
 * is checked for internal consistency, exactly like the app-side judge.
 * Ship-with-advisory: the gate never fails a run, and its re-renders go
 * back through the full per-spread path (render → QA → repair → marker).
 *
 * @param {object} params
 * @param {Array} params.results renderSpread results (mutated in place:
 *   advisories appended; flagged fresh entries replaced by their re-render)
 * @param {(spread: number, worldNote: string) => Promise<object>} params.rerender
 * @param {boolean} [params.embeddedText] embedded layout: the gate also
 *   judges TEXT TREATMENT consistency (band vs over-artwork, typography)
 * @param {(spread: number) => string|null} [params.planDirectiveFor] the
 *   spread's ASSIGNED composition directive (shotPlan.js template text) —
 *   a `composition_duplicate` repair re-renders the flagged spread against
 *   its own plan entry, never against free-form model text
 * @param {(frac: number, message: string) => void} [params.onProgress]
 * @param {(level: string, msg: string) => void} params.log
 * @returns {Promise<{pass: boolean, checked: number, flagged?: Array, rerendered?: number[], unavailable?: string}|null>}
 *   null when the gate did not run (kill-switch, or <2 renders to compare)
 */
async function runWorldConsistencyGate({ results, rerender, embeddedText = false, planDirectiveFor = () => null, onProgress = () => {}, log }) {
  if (!flags.worldQaEnabled()) return null;
  const rendered = results.filter(r => r.buffer);
  if (rendered.length < 2) return null; // consistency needs a comparison
  // The gate + its repairs can legitimately run for many minutes with no
  // per-spread progress events, and the server's per-book watchdog aborts
  // books idle >20min — a 30s heartbeat keeps a healthy gate alive (the
  // same pattern the deleted workflow engine used).
  const heartbeat = setInterval(() => onProgress(1, 'World consistency gate in progress...'), 30000);
  try {
    onProgress(1, `Checking world consistency across ${rendered.length} spreads...`);
    const verdict = await checkWorldConsistency(
      rendered.map(r => ({ spread: r.spread, buffer: r.buffer })),
      {
        label: 'worldQa',
        embeddedText,
        // BATH/WATER spreads legitimately differ in coverage — the gate
        // must not read that as an outfit break (mirrors the per-spread
        // outfit check's exemption).
        outfitExemptSpreads: rendered.filter(r => r.bathWater).map(r => r.spread),
      },
    );
    if (!verdict) return null;
    if (verdict.qaUnavailable) {
      log('warn', `world gate UNCHECKED — ${verdict.qaUnavailable}`);
      return { pass: true, checked: rendered.length, unavailable: verdict.qaUnavailable };
    }
    if (verdict.pass) return { pass: true, checked: rendered.length };
    const rerendered = await applySetRepairs({
      results, flagged: verdict.flagged, budget: WORLD_QA_MAX_RERENDERS(), stage: 'worldQa', rerender,
      noteFor: f => worldRepairNote(f.defect, { planDirective: planDirectiveFor(f.spread) }),
      onProgress, log,
    });
    return { pass: false, checked: rendered.length, flagged: verdict.flagged, rerendered };
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * The reference index of a prop's sheet in one render's pack, matched on
 * the NORMALIZED value (the pack is keyed by the spread's own wording, the
 * bible by the sheet's value). Null when the pack carries no such sheet.
 * @param {{props?: Object<string, number>}|null} refs
 * @param {string} value
 * @returns {number|null}
 */
function propReferenceIndex(refs, value) {
  const want = normalizePropValue(value);
  for (const key of Object.keys(refs && refs.props ? refs.props : {})) {
    if (normalizePropValue(key) === want) return refs.props[key];
  }
  return null;
}

/**
 * ce-9 contact-sheet gate: the child crops of every rendered spread beside
 * the CHARACTER MODEL SHEET in one image (garments legible — the world
 * gate's 1024px thumbnails were not), plus one props contact sheet per
 * prop sheet, each judged in one call; flagged FRESH spreads re-render once
 * through the full per-spread path with the closed-vocabulary repair note.
 * Skipped without a sheet / under 2 tiles. Ship-with-advisory like the
 * world gate.
 * @returns {Promise<{pass: boolean, checked: number, flagged?: Array, rerendered?: number[], unavailable?: string}|null>}
 */
async function runContactSheetGate({ results, bible, evidence = [], rerender, onProgress = () => {}, log }) {
  if (!flags.contactQaEnabled() || !bible || !bible.sheet) return null;
  const rendered = results.filter(r => r.buffer);
  if (rendered.length < 2) return null;
  const heartbeat = setInterval(() => onProgress(1, 'Contact-sheet consistency gate in progress...'), 30000);
  try {
    onProgress(1, `Checking character + prop consistency across ${rendered.length} spreads...`);
    const flagged = [];
    // Child tiles: the QA bbox crop when we have one, else the whole spread
    // — named as such (`cropped: false`), so the judge never reads scene or
    // world differences in a full image as character drift.
    const childTiles = [];
    for (const r of rendered) {
      let tile = r.crop || null;
      if (!tile && r.bbox) tile = await metrics.cropBbox(r.buffer, r.bbox).catch(() => null);
      childTiles.push({ spread: r.spread, buffer: tile || r.buffer, cropped: !!tile });
    }
    const sheetBuffer = Buffer.from(bible.sheet.base64, 'base64');
    const charVerdict = await checkCharacterContactSheet({
      tiles: childTiles,
      sheet: { buffer: sheetBuffer },
      outfitSpecText: bible.outfit ? bible.outfit.outfit : null,
      exemptSpreads: rendered.filter(r => r.bathWater).map(r => r.spread),
      label: 'contactQa:character',
    });
    let unavailable = null;
    if (charVerdict && charVerdict.qaUnavailable) unavailable = charVerdict.qaUnavailable;
    if (charVerdict && !charVerdict.qaUnavailable) flagged.push(...charVerdict.flagged.map(f => ({ ...f, defect: 'character_rendering' })));

    // Props: one contact sheet per prop sheet, over the spreads where the
    // prop is expected (declared or carried) — matched on the NORMALIZED
    // value (the story's wording vs the sheet's value).
    for (const p of (bible.props || []).filter(x => x && x.sheet)) {
      const wantProp = normalizePropValue(p.value);
      const spreads = new Set();
      for (const ev of Array.isArray(evidence) ? evidence : []) {
        if (ev && ev.visual_required === true && normalizePropValue(inertPropValue(ev.source_value)) === wantProp) {
          spreads.add(ev.spread);
          if (flags.propContinuityEnabled() && ev.moment_type === 'object_presence' && ev.source_field === 'object') {
            for (const r of rendered) if (r.spread > ev.spread) spreads.add(r.spread);
          }
        }
      }
      // Prop tiles: the prop's own crop from the structured verdict's
      // per-prop bbox (a small recurring object is only legible beside its
      // sheet when cropped); the whole spread only as a named fallback.
      const tiles = [];
      for (const r of rendered.filter(x => spreads.has(x.spread))) {
        const box = (r.propBoxes || []).find(b => b && b.bbox && normalizePropValue(b.name) === wantProp);
        const crop = box ? await metrics.cropBbox(r.buffer, box.bbox, { pad: 0.08 }).catch(() => null) : null;
        tiles.push({ spread: r.spread, buffer: crop || r.buffer, cropped: !!crop });
      }
      if (tiles.length < 2) continue;
      const v = await checkPropContactSheet({
        tiles,
        propSheet: { buffer: Buffer.from(p.sheet.base64, 'base64'), specText: p.sheet.specText || null, name: p.value },
        label: `contactQa:prop:${p.value.slice(0, 20)}`,
      });
      if (v && v.qaUnavailable) unavailable = unavailable || v.qaUnavailable;
      if (v && !v.qaUnavailable) {
        for (const f of v.flagged) {
          // The prop's identity rides the finding so its repair can cite
          // the exact prop sheet in the re-render's reference pack.
          if (!flagged.some(x => x.spread === f.spread)) flagged.push({ ...f, defect: 'prop_rendering', prop: p.value });
        }
      }
    }

    // Deterministic outliers (opt-in metrics): a child crop far from the
    // set's median embedding is flagged as a character break too.
    if (flags.identityMetricsEnabled()) {
      try {
        const embeddings = {};
        for (const t of childTiles) {
          const e = await metrics.embedImage(t.buffer, { log });
          if (e) embeddings[t.spread] = e;
        }
        for (const s of metrics.outlierSpreads(embeddings)) {
          if (!flagged.some(x => x.spread === s)) flagged.push({ spread: s, defect: 'character_rendering', note: 'embedding outlier against the other spreads' });
        }
      } catch (err) {
        log('warn', `embedding outlier check unavailable (${err.message})`);
      }
    }

    if (flagged.length === 0) {
      return unavailable ? { pass: true, checked: rendered.length, unavailable } : { pass: true, checked: rendered.length };
    }
    const rerendered = await applySetRepairs({
      results, flagged, budget: CONTACT_QA_MAX_RERENDERS(), stage: 'contactQa', rerender,
      // A prop repair is resolved against the RE-RENDER's own reference
      // pack: the note names the prop and cites its sheet's index there
      // (the pinned instruction, never model text).
      noteFor: f => (f.defect === 'prop_rendering'
        ? (refs) => `SET CONSISTENCY REPAIR — compared with the book's other spreads, this render broke prop consistency for "${inertPropValue(f.prop) || 'the prop'}". ${contactRepairNote('prop_rendering', { referenceIndex: propReferenceIndex(refs, f.prop) })} Re-render the SAME scene and action; fix ONLY the prop.`
        : worldRepairNote('character_rendering')),
      onProgress, log,
    });
    return { pass: false, checked: rendered.length, flagged, rerendered, ...(unavailable ? { unavailable } : {}) };
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Render a validated story's spreads (all 12, or a chosen subset) through
 * the ONE production render path (bible → cache → candidates → QA →
 * select → repair → marker → set gates). This is the shared body of the
 * full-book pipeline AND the workbench probe (`/v13/render-spreads`) — the
 * illustration feedback loop tunes exactly what production runs, or it
 * tunes nothing.
 *
 * @param {object} params
 * @param {string} params.bookId main-app book id (GCS namespace)
 * @param {object} params.story validated writer response
 * @param {object} params.bookDef {book, theme} from catalog.getBook
 * @param {object} params.profile normalized profile
 * @param {string|null} params.approvedCoverUrl identity anchor
 * @param {string|null} [params.childPhotoUrl] fallback anchor for coverless test books
 *   (and, beside a cover, the likeness aid for the character sheet)
 * @param {string|null} [params.characterDescription]
 * @param {string} [params.textLayout] 'caption' (default) | 'half' | 'embedded'.
 * @param {number[]|null} [params.spreads] subset of spread numbers (default: all beats)
 * @param {number[]|null} [params.rerenderSpreads] probe-only: spreads forced FRESH
 * @param {object|null} [params.tuning] raw illustrationTuning overlay (normalized here; kill-switch applied)
 * @param {boolean} [params.identityKeyed] fold the identity anchor into the cache key
 * @param {number|null} [params.seed] probe-compat render seed
 * @param {string|null} [params.probeNonce] workbench-only cache-key salt
 * @param {object} [params.costTracker]
 * @param {boolean} [params.forceRerender]
 * @param {(frac: number, message: string) => void} [params.onProgress]
 * @param {(level: string, msg: string) => void} [params.log]
 * @returns {Promise<{results: Array, aspect: string, storyHash: string, tuningTag: string, worldQa: object|null, contactQa: object|null, outfitLockUsed: string, bible: object, bookBible: object|null, unresolved: Array, advisories: object[]}>}
 */
async function renderStorySpreads(params) {
  const {
    bookId, story, bookDef, profile,
    approvedCoverUrl, childPhotoUrl, characterDescription,
    textLayout = 'caption', spreads = null, rerenderSpreads = null, probeNonce = null,
    costTracker, forceRerender = false, reviewedOnly = false,
    onProgress = () => {}, log = (l, m) => console.log(`[illustrator:${bookId}] ${m}`),
  } = params;
  const { book, theme } = bookDef;
  const { identityKeyed = false, seed = null } = params;
  const tuning = normalizeArtTuning(params.tuning || null);
  // 'embedded' and 'half' both render FULL-SPREAD wide compositions; only
  // caption renders square. Half renders are text-FREE wide art, so their
  // cache files live under 'wide-plain' — an embedded book's Gemini-painted
  // wide render must never replay into a half book (or vice versa).
  const aspect = textLayout === 'embedded' || textLayout === 'half' ? 'wide' : 'square';
  const cacheAspect = textLayout === 'half' ? 'wide-plain' : aspect;
  const characterRefUrl = approvedCoverUrl || childPhotoUrl || null;
  if (!characterRefUrl) {
    // A render run with NO identity reference would render a different child
    // on every spread — that is a broken book, not an advisory. Coverless
    // testing belongs on the story-only endpoint.
    const err = new Error('no approved cover and no child photo — the illustrations would have no identity anchor; supply approvedCoverUrl (or childPhotoUrls for a coverless test book)');
    err.failureCode = 'missing_identity_reference';
    throw err;
  }
  // Resolve the reference bytes ONCE for all renders. An unreachable
  // reference fails the run for the same reason a missing one does — the
  // spreads would silently render unanchored.
  let refPhoto;
  try {
    refPhoto = await downloadPhotoAsBase64(characterRefUrl);
  } catch (dlErr) {
    const err = new Error(`identity reference could not be downloaded (${dlErr.message}) — refusing to render unanchored spreads`);
    err.failureCode = 'missing_identity_reference';
    throw err;
  }
  // The raw photo beside a cover is a likeness aid for the character sheet
  // only (best-effort; a cover-anchored run never fails on the photo).
  let childPhoto = null;
  if (approvedCoverUrl && childPhotoUrl && childPhotoUrl !== approvedCoverUrl) {
    try { childPhoto = await downloadPhotoAsBase64(childPhotoUrl); } catch (err) { log('warn', `child photo unavailable for the character sheet (${err.message})`); }
  }

  // ── The Book Bible: built ONCE, before any spread renders ────────────────
  // Phase timings are logged so a slow run names its slow phase — "the whole
  // book took 40 minutes" alone is not diagnosable from the worker logs.
  const phaseStart = Date.now();
  const bibleHeartbeat = setInterval(() => onProgress(0, 'Building the book bible (character sheet, props, plan)...'), 30000);
  let bible;
  try {
    onProgress(0, 'Building the book bible...');
    bible = await buildBookBible({
      bookId, theme, book, story, profile, ageBand: bookDef.ageBand,
      anchorUrl: characterRefUrl, refPhoto, childPhoto, characterDescription: characterDescription || null,
      costTracker, log,
    });
  } finally {
    clearInterval(bibleHeartbeat);
  }
  log('info', `Book bible ready in ${Math.round((Date.now() - phaseStart) / 1000)}s`);
  bible.theme = theme;
  bible.story = story;
  const outfitLock = bible.outfit;

  const baseHash = storyFingerprint(story);
  let keyHash = baseHash;
  // Pin the cache to the story's CATALOG definition version: scenes are
  // built from the pinned beats/world/companion (getBookForTag), so the
  // same manuscript under a different Catalog Studio overlay produces
  // different prompts and must never replay the other overlay's pixels.
  const catalogTag = story?.versions?.catalog;
  if (catalogTag) keyHash = `${keyHash}-c${fnv1a(String(catalogTag)).toString(36)}`;
  // The prop-continuity kill-switch changes scene prompts for stories
  // carrying visual object evidence — folded ONLY when OFF and eligible.
  if (!flags.propContinuityEnabled() && hasCarryThroughProps(story.personalization_evidence)) {
    keyHash = `${keyHash}-p0`;
  }
  // The shot-plan kill-switch changes EVERY scene prompt — folded only when OFF.
  if (!flags.shotPlanEnabled()) {
    keyHash = `${keyHash}-sp0`;
  }
  // ce-16: an output-size override changes every embedded pixel — folded
  // only when set, so default and sized renders never replay each other.
  if (textLayout === 'embedded' && flags.embeddedImageSize()) {
    keyHash = `${keyHash}-is${flags.embeddedImageSize().toLowerCase()}`;
  }
  // ce-9: the bible hash folds EVERY pixel input (sheet, outfit spec, prop
  // and companion sheets, world plate, emotion plan) into one identity —
  // any change to any fixed input re-keys every render. It replaces the
  // ce-5/ce-7 `-w{plate}`/`-o{outfit}` folds.
  keyHash = `${keyHash}-b${bible.hash}`;
  if (identityKeyed) {
    // Probe cache keys carry an IDENTITY fingerprint: a workbench book's
    // anchor is admin-mutable, so the same bookId/story/tag after an anchor
    // (or characterDescription) change must never replay the prior child's
    // cached image. Keyed on the anchor's PATH — a signed URL's rotating
    // query string must not bust the cache for the same object.
    const identityBasis = `${String(characterRefUrl).split('?')[0]}|${characterDescription || ''}`;
    keyHash = `${keyHash}-i${fnv1a(identityBasis).toString(36)}`;
  }
  if (seed != null) keyHash = `${keyHash}-s${seed}`;
  const nonce = probeNonce ? String(probeNonce).replace(/[^A-Za-z0-9-]/g, '').slice(0, 16) : '';
  const storyHash = nonce ? `${keyHash}-${nonce}` : keyHash;

  // The deterministic shot plan — always built over ALL of the book's beats
  // (a probe subset must see the same assignments as the full book) and
  // seeded by the STORY fingerprint, not the folded cache key: an anchor,
  // plate, or outfit change must never reshuffle the book's cinematography.
  const shotPlan = flags.shotPlanEnabled()
    ? buildShotPlan({
      seedBasis: baseHash,
      spreads: book.beats.map(b => b.spread),
      ageBand: bookDef.ageBand,
      textLayout,
    })
    : null;

  const wanted = Array.isArray(spreads) && spreads.length > 0
    ? book.beats.filter(b => spreads.includes(b.spread))
    : book.beats;
  // Per-spread force: listed spreads render fresh (their stale marker is
  // dropped inside renderSpread), everything else replays as usual.
  const forceSet = new Set(Array.isArray(rerenderSpreads) ? rerenderSpreads : []);
  const pLimit = require('p-limit');
  const limit = pLimit(RENDER_CONCURRENCY());
  let done = 0;
  // ce-15: the TYPOGRAPHY ANCHOR — the text-side half of one painted page
  // of THIS story is the type reference every other spread renders
  // against. It is elected ONCE per story and pinned (textAnchor.js); an
  // earlier run's pin is reused whatever this run's subset is (a bench
  // probe on spreads 4–6 pins page 4, and the final book anchors on page
  // 4 too, so the approved probe renders stay replayable). Only a run
  // with NO pin renders its first spread alone before the fan-out to
  // elect it. The pinned page keeps its plain cache key (its key cannot
  // depend on its own crop); every other spread folds the crop's hash
  // (`-ta{hash8}`). With the kill-switch off every embedded key folds
  // `-ta0`, so anchored and anchor-less renders never replay each other.
  const tuningTag = tuning ? tuning.tag : 'none';
  const anchorEnabled = textLayout === 'embedded' && flags.textAnchorEnabled();
  const anchorOff = textLayout === 'embedded' && !flags.textAnchorEnabled();
  const anchorAdvisories = [];
  const anchorPinKey = anchorEnabled ? anchorPinPath(renderCachePath(bookId, storyHash, 1, cacheAspect, tuningTag)) : null;
  const toAnchorRef = (e) => ({ spread: e.spread, side: e.side, base64: e.bytes.toString('base64'), mimeType: 'image/png', hash: e.hash, pinned: e.pinned });
  const pinned = anchorEnabled && !forceRerender ? await readPinnedTypographyAnchor(anchorPinKey) : null;
  let typographyAnchor = pinned ? toAnchorRef(pinned) : null;
  if (typographyAnchor) log('info', `Typography anchor: pinned page ${typographyAnchor.spread} reused (${typographyAnchor.hash})`);
  // The run's anchor spread: the pinned page, else (no pin yet) this run's
  // first spread — rendered alone first so its crop can be elected.
  const electNow = anchorEnabled && !typographyAnchor && wanted.length > 1;
  let anchorSpreadNo = typographyAnchor ? typographyAnchor.spread : (electNow ? wanted[0].spread : null);
  const hashFor = (spread) => {
    if (anchorOff) return `${storyHash}-ta0`;
    if (typographyAnchor && spread !== anchorSpreadNo) return `${storyHash}-ta${typographyAnchor.hash.slice(0, 8)}`;
    return storyHash;
  };
  // Every spread renders WITH the reference once one exists — the pinned
  // page too when it is re-rendered (its own earlier text is the best
  // possible type reference for it); only the fold above skips it.
  const spreadArgs = (spread, extra = {}) => ({
    bookId, book, theme, profile, story, storyHash: hashFor(spread),
    spread, aspect, cacheAspect, textLayout, characterRefUrl, refPhoto, characterDescription,
    reviewedOnly, tuning, bible, shotEntry: shotPlan ? shotPlan[spread] : null, seed, costTracker, ageBand: bookDef.ageBand, log,
    ...(typographyAnchor ? { typographyAnchor } : {}),
    ...extra,
  });
  // allSettled, not all: one thrown spread must cost only THAT spread — the
  // probe contract reports per-spread failures, and the other renders were
  // already paid for (they stay cached either way). The full-book caller
  // still fails the run on any missing buffer below.
  // A spread's N candidates + repair passes + QA calls can take many
  // minutes between two per-spread progress events, and the server's
  // per-book watchdog aborts books idle >20min — a 30s heartbeat keeps a
  // healthy render phase alive (the same pattern the set gates use).
  const renderPhaseStart = Date.now();
  const renderHeartbeat = setInterval(() => onProgress(Math.max(0.01, done / wanted.length), `Illustrating spreads (${done}/${wanted.length} done)...`), 30000);
  let settled;
  try {
    const renderOne = async (beat, extra = {}) => {
      const r = await renderSpread(spreadArgs(beat.spread, { forceRerender: forceRerender || forceSet.has(beat.spread), ...extra }));
      done += 1;
      onProgress(done / wanted.length, `Illustrated spread ${beat.spread} (${done}/${wanted.length})`);
      return r;
    };
    let anchorSettled = null;
    if (electNow) {
      onProgress(0.01, `Illustrating spread ${anchorSpreadNo} first (the book's typography anchor)...`);
      // The anchor page decides the whole book's type size: it renders more
      // candidates than the rest so a small one exists to elect.
      [anchorSettled] = await Promise.allSettled([renderOne(wanted[0], { candidateCount: flags.textAnchorCandidates() })]);
      const anchorBuffer = anchorSettled.status === 'fulfilled' && anchorSettled.value ? anchorSettled.value.buffer : null;
      const side = shotPlan && shotPlan[anchorSpreadNo] ? shotPlan[anchorSpreadNo].textSide : null;
      // ce-18: never elect an anchor whose OWN painted text is blocking —
      // the whole book copies this crop, so a wrong-ink (or banded, hazed,
      // oversized) page would propagate its defect book-wide. That is
      // exactly how the ce-17 haze spread from page 1 to all twelve.
      const anchorTextDefects = anchorSettled.status === 'fulfilled' && anchorSettled.value
        ? (anchorSettled.value.blocking || []).filter(d => d.startsWith('embedded story text'))
        : [];
      if (anchorTextDefects.length > 0) {
        anchorAdvisories.push({ stage: 'typographyAnchor', note: `no typography anchor — spread ${anchorSpreadNo}'s own painted text is blocking (${anchorTextDefects.join('; ')}); the other spreads render on the text rules alone rather than copying it` });
      }
      const elected = side && anchorTextDefects.length === 0
        ? await electTypographyAnchor({ buffer: anchorBuffer, side, spread: anchorSpreadNo, pinKey: anchorPinKey, reelect: !!forceRerender, log })
        : null;
      if (elected) {
        // A lost create race adopts the winner — possibly another page,
        // elected by a concurrent run of a different subset.
        typographyAnchor = toAnchorRef(elected);
        anchorSpreadNo = elected.spread;
        log('info', `Typography anchor: page ${elected.spread} (${elected.side} half, ${elected.pinned ? 'pinned' : 'elected'} ${elected.hash})`);
      } else if (anchorTextDefects.length === 0) {
        anchorAdvisories.push({ stage: 'typographyAnchor', note: `no typography anchor — spread ${anchorSpreadNo} ${side ? 'produced no usable render to crop' : 'has no assigned text side'}; the other spreads render on the text rules alone` });
      }
    }
    const rest = electNow ? wanted.slice(1) : wanted;
    settled = await Promise.allSettled(rest.map(beat => limit(() => renderOne(beat))));
    if (anchorSettled) settled = [anchorSettled, ...settled];
  } finally {
    clearInterval(renderHeartbeat);
  }
  log('info', `Render phase (${wanted.length} spread(s), concurrency ${RENDER_CONCURRENCY()}) done in ${Math.round((Date.now() - renderPhaseStart) / 1000)}s`);
  const results = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const spread = wanted[i].spread;
    const note = `render errored: ${s.reason?.message || String(s.reason)}`;
    log('error', `Spread ${spread} ${note}`);
    // The per-attempt diagnostics the renderer attached to the failure —
    // "failed after 5 attempts" alone is not actionable for the admin.
    const detail = {
      ...(Array.isArray(s.reason?.attempts) && s.reason.attempts.length > 0 ? { attempts: s.reason.attempts } : {}),
      ...(s.reason?.failureCode ? { failureCode: s.reason.failureCode } : {}),
    };
    return {
      spread,
      buffer: null,
      storageKey: renderCachePath(bookId, hashFor(spread), spread, cacheAspect, tuningTag),
      url: null,
      advisories: [{ stage: 'render', spread, note, ...(Object.keys(detail).length > 0 ? { detail } : {}) }],
      fresh: false,
      bathWater: false,
      blocking: [],
      candidates: [],
      qa: null,
      bbox: null,
    };
  });

  results.sort((a, b) => a.spread - b.spread);

  const rerender = (spread, note) => renderSpread(spreadArgs(spread, { worldNote: note, forceRerender: true }));

  // Book-level world-consistency gate: check the set together, re-render
  // flagged FRESH spreads once (through the same full per-spread path).
  const worldGateStart = Date.now();
  const worldQa = reviewedOnly ? null : await runWorldConsistencyGate({
    results,
    embeddedText: textLayout === 'embedded',
    planDirectiveFor: spread => (shotPlan ? renderShotDirective(shotPlan[spread]) || null : null),
    rerender,
    onProgress,
    log,
  });
  if (worldQa) log('info', `World gate done in ${Math.round((Date.now() - worldGateStart) / 1000)}s (${worldQa.rerendered?.length || 0} re-render(s))`);
  // ce-9 contact-sheet gate: character crops vs the model sheet, prop crops
  // vs their sheets.
  const contactGateStart = Date.now();
  const contactQa = reviewedOnly ? null : await runContactSheetGate({ results, bible, evidence: story.personalization_evidence || [], rerender, onProgress, log });
  if (contactQa) log('info', `Contact gate done in ${Math.round((Date.now() - contactGateStart) / 1000)}s (${contactQa.rerendered?.length || 0} re-render(s))`);
  // ce-18 ink gate: every spread's measured text ink vs the book's median.
  const inkGateStart = Date.now();
  const textInkQa = reviewedOnly ? null : await runInkConsistencyGate({
    results,
    inkHex: textLayout === 'embedded' && flags.textInkQaEnabled() ? resolvePictureBookTextRules(profile?.age).fontColorHex : null,
    rerender,
    onProgress,
    log,
  });
  if (textInkQa && textInkQa.pass === false) log('info', `Ink gate done in ${Math.round((Date.now() - inkGateStart) / 1000)}s (${textInkQa.rerendered?.length || 0} re-render(s))`);

  // Book-level advisories (the bible's own + the ce-8 lock-less warning).
  const advisories = [...bible.advisories, ...anchorAdvisories];
  if (flags.outfitLockEnabled() && !outfitLock && !advisories.some(a => a.stage === 'outfitLock')) {
    advisories.push({
      stage: 'outfitLock',
      note: 'renders are NOT outfit-locked — the outfit spec could not be derived from the identity anchor; cross-spread outfit consistency relies on the reference image alone',
    });
  }

  // ── Graded ship policy ──────────────────────────────────────────────────
  // Spreads whose BLOCKING defects survived candidates + repairs. The full-
  // book caller fails `consistency_unresolved` on these unless the opt-in
  // CATALOG_SHIP_ON_EXHAUSTION=1 turns them into advisories; the probe
  // reports them per spread (qa.pass=false + unresolved[]).
  const unresolved = results
    .filter(r => r.buffer && Array.isArray(r.blocking) && r.blocking.length > 0)
    .map(r => ({
      spread: r.spread,
      defects: r.blocking,
      candidates: (r.candidateFiles || []).map(c => ({ storageKey: c.storageKey, score: c.score, pass: c.pass })),
    }));
  for (const u of unresolved) {
    for (const c of u.candidates) {
      try { c.url = await getSignedUrl(c.storageKey, SIGNED_URL_TTL_MS); } catch { c.url = null; }
    }
  }
  if (unresolved.length > 0 && flags.shipOnExhaustion()) {
    advisories.push({ stage: 'shipPolicy', note: `shipped ${unresolved.length} spread(s) with BLOCKING residual defects (CATALOG_SHIP_ON_EXHAUSTION=1): ${unresolved.map(u => `s${u.spread}`).join(', ')}` });
  }

  const bookBible = await summarizeBible(bible);
  return {
    results, aspect, storyHash,
    tuningTag: tuning ? tuning.tag : 'none',
    worldQa,
    contactQa,
    textInkQa,
    outfitLockUsed: outfitLock ? outfitLock.hash : 'none',
    // ce-15: which page's painted text the other spreads were held to
    // (`s{spread}.{hash8}`), or 'none' — an anchor-less embedded run also
    // carries a stage 'typographyAnchor' advisory.
    typographyAnchorUsed: typographyAnchor ? `s${typographyAnchor.spread}.${typographyAnchor.hash.slice(0, 8)}` : 'none',
    bible,
    bookBible,
    unresolved,
    advisories,
  };
}

/**
 * Illustrate a validated story: 12 renders → layout entries.
 *
 * @param {object} params renderStorySpreads params (minus `spreads`/
 *   `rerenderSpreads`/`probeNonce` — a full book always renders every beat,
 *   and the probe-only subset/force/nonce salts never apply; identityKeyed
 *   and seed DO pass through so a bench final book replays probe renders)
 * @returns {Promise<{entries: object[], previewImageUrls: string[], qaAdvisories: object[], warnings: string[], illustrationTuningUsed: string, worldQa: object|null, contactQa: object|null, outfitLockUsed: string, bookBible: object|null}>}
 */
async function illustrateStory(params) {
  const { story, textLayout = 'caption' } = params;
  const warnings = [];
  const { results, aspect, tuningTag, worldQa, contactQa, textInkQa, outfitLockUsed, typographyAnchorUsed, bookBible, bible, unresolved, advisories: bookAdvisories } = await renderStorySpreads({
    ...params, spreads: null, rerenderSpreads: null, probeNonce: null,
  });
  const qaAdvisories = [...bookAdvisories, ...results.flatMap(r => r.advisories)];
  // Residual advisory defects ship with advisories, but the ABSENCE of an
  // image is not advisory-class: a blank spread must fail the run (finished
  // renders stay cached, so the retry re-pays only for the missing spreads).
  const failed = results.filter(r => !r.buffer);
  if (failed.length > 0) {
    const missing = failed.map(r => r.spread);
    const err = new Error(`render failed for spread(s) ${missing.join(', ')} — the book cannot complete with blank art; retry re-renders only the missing spreads`);
    err.failureCode = 'render_failed';
    // The throw discards qaAdvisories, so the per-spread diagnostics must
    // ride the error for the /generate-book failure callback to serialize.
    err.renderFailures = failed.map(r => ({
      spread: r.spread,
      message: r.advisories.map(a => a.note).join('; ') || 'render failed',
      ...(r.advisories.find(a => a.detail) ? { detail: r.advisories.find(a => a.detail).detail } : {}),
    }));
    err.bookBible = bookBible;
    throw err;
  }
  // ce-9 graded ship policy: BLOCKING residuals (identity/outfit/prop/
  // companion breaks, missing or duplicated child, painted text in caption
  // layout, wrong embedded text, extra limbs) fail the book for review with
  // the candidates attached — a book that visibly changes the child's
  // clothes is a product defect, not an advisory. CATALOG_SHIP_ON_EXHAUSTION=1
  // restores ship-with-advisory.
  if (unresolved.length > 0 && !flags.shipOnExhaustion()) {
    const err = new Error(`blocking consistency defects survived candidates and repairs on spread(s) ${unresolved.map(u => u.spread).join(', ')} — the book needs review (pick a candidate or re-render the spread); set CATALOG_SHIP_ON_EXHAUSTION=1 to ship with advisories instead`);
    err.failureCode = 'consistency_unresolved';
    err.unresolved = unresolved;
    err.qaAdvisories = qaAdvisories.slice(0, 40);
    err.bookBible = bookBible;
    throw err;
  }

  const entries = results.map(r => ({
    type: 'spread',
    spread: r.spread,
    spreadIllustrationBuffer: r.buffer,
    spreadIllustrationUrl: r.url,
    spreadIllustrationStorageKey: r.storageKey,
    illustrationAspect: aspect,
    captionText: story.spreads.find(s => s.spread === r.spread)?.text || '',
    textLayout,
    // Embedded spreads carry their text IN the pixels (Gemini-painted,
    // OCR-verified) — the layout engine must embed the art full-bleed and
    // NEVER typeset the caption over it a second time.
    ...(textLayout === 'embedded' ? { textZone: null, heroBox: null, figuresBox: null, textEmbeddedInArt: true } : {}),
  }));

  return {
    entries,
    previewImageUrls: results.map(r => r.url).filter(Boolean),
    qaAdvisories,
    warnings,
    illustrationTuningUsed: tuningTag,
    worldQa: worldQa || null,
    contactQa: contactQa || null,
    textInkQa: textInkQa || null,
    outfitLockUsed,
    typographyAnchorUsed,
    bookBible,
    // In-memory bible (sheet bytes, outfit spec) for the pipeline's other
    // consumers — the upsell spread and the wrap cover; never serialized.
    bible,
  };
}

module.exports = { illustrateStory, renderStorySpreads, renderCachePath, storyFingerprint, planWorldRepairs, needsRepair, runContactSheetGate, runWorldConsistencyGate, runInkConsistencyGate, renderTextColumnHint };
