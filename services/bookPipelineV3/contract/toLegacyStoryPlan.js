/**
 * Adapter: new book document -> legacy storyPlan + entriesWithIllustrations.
 *
 * The existing /generate-book handler in server.js has ~400 lines of code
 * after illustration (PDF assembly, upsell injection, cover PDF build,
 * completion callback, DB storyContent). That code reads from `storyPlan`
 * and `entriesWithIllustrations` objects produced by the legacy pipeline.
 *
 * This adapter synthesizes those objects from the new canonical document
 * so the downstream flow keeps working untouched. It also emits the same
 * structural entries (half-title / title / copyright / dedication / closing
 * / blanks) that the legacy writer emitted, so `computePageCount` derives
 * the correct interior page count (and therefore the correct cover spine
 * width).
 */

/**
 * Pull a child's name from either the legacy childDetails shape (`name`) or
 * the DB shape (`childName`), falling back to a safe default.
 */
function resolveChildName(doc) {
  return doc?.brief?.child?.name
    || doc?.brief?.child?.childName
    || doc?.request?.child?.name
    || doc?.request?.child?.childName
    || 'the child';
}

/**
 * Build the structural entries that surround the story spreads. These match
 * what the legacy Writer V2 → illustrator path produced, so downstream
 * `computePageCount` + `computeSynopsis` helpers see an identical shape.
 */
function buildFrontAndBackMatter(doc) {
  const title = doc?.cover?.title || 'My Story';
  const childName = resolveChildName(doc);
  const theme = doc?.request?.theme || null;

  const THEME_SUBS = {
    mothers_day: 'A story about love',
    fathers_day: 'A story about love',
    birthday: 'A birthday story',
    birthday_magic: 'A birthday story',
    adventure: 'An adventure story',
    fantasy: 'A fantasy quest',
    space: 'A space adventure',
    underwater: 'An underwater adventure',
    nature: 'A nature story',
    bedtime: 'A bedtime story',
    school: 'A school story',
    friendship: 'A friendship story',
    holiday: 'A holiday story',
    anxiety: 'A story about being brave',
    anger: 'A story about big feelings',
    fear: 'A story about courage',
    grief: 'A story about remembering',
    loneliness: 'A story about connection',
    new_beginnings: 'A story about new beginnings',
    self_worth: 'A story about being you',
    family_change: 'A story about family',
  };
  const subtitle = `${THEME_SUBS[theme] || 'A story'} for ${childName}`;
  return {
    front: [
      { type: 'half_title_page', title },
      { type: 'blank' },
      { type: 'title_page', title, subtitle },
      { type: 'copyright_page' },
      { type: 'dedication_page', text: `For ${childName}` },
    ],
    back: [
      { type: 'blank' },
      { type: 'closing_page' },
      { type: 'blank' },
    ],
  };
}

/**
 * @param {object} doc - canonical book document from bookPipeline.generateBook
 * @returns {{ storyPlan: object, entriesWithIllustrations: object[] }}
 */
function toLegacyStoryPlan(doc) {
  // Mirror toLayoutPayload: native-illustrator spreads are 1:1 images with NO
  // on-image text — assemblePdf must typeset the caption on the verso page and
  // place the square art full-bleed on the recto. Absent these two fields
  // assemblePdf falls back to the legacy wide-split path (center-crops the
  // square image and halves it across the spread, no story text anywhere).
  // server.js persists THIS output into the book checkpoint, so the fields
  // survive resume too. (`toLayoutPayload.js` computes the same shape for the
  // workflow's layout return, which server.js never reads — candidate for a
  // later fold, kept separate here.)
  const isNative = doc.v3?.illustrator?.version === 'native';
  // Text layout (2026-07-17, admin-selectable): 'caption' → square art +
  // typeset white verso page; 'embedded' → wide art spanning both pages
  // with the caption typeset OVER the quiet zone. Non-native docs are
  // pre-cutover legacy re-finalizes: wide baked-caption split, no fields.
  const textLayout = isNative ? (doc.v3?.textLayout || 'caption') : null;
  const aspect = isNative ? (textLayout === 'embedded' ? 'wide' : 'square') : 'wide';
  const spreadEntries = doc.spreads.map(s => ({
    type: 'spread',
    spread: s.spreadNumber,
    // The manuscript text on `left.text` predates caption mode (debug/audit);
    // keep it — the server's checkpoint backfill reads it for pre-fix books.
    left: { text: s.manuscript?.text || '' },
    right: { text: '' },
    spreadIllustrationUrl: s.illustration?.imageUrl || null,
    spreadIllustrationStorageKey: s.illustration?.imageStorageKey || null,
    illustrationAspect: aspect,
    captionText: isNative ? (s.manuscript?.text || '') : undefined,
    ...(textLayout ? { textLayout } : {}),
    ...(textLayout === 'embedded' ? { textZone: s.illustration?.textZone || null } : {}),
    // Preserve the scene prompt used by the new pipeline so admin regen /
    // audit flows can reproduce or diff the exact spread brief.
    spread_image_prompt: s.illustration?.scenePrompt || s.spec?.scenePrompt || null,
    location: s.spec?.location || null,
  }));

  const { front, back } = buildFrontAndBackMatter(doc);
  const entriesWithIllustrations = [...front, ...spreadEntries, ...back];

  const supportingCastDescriptions = (doc.visualBible?.supportingCast || [])
    .filter(c => c?.description)
    .map(c => c.description);

  const narrativeSpine = doc.storyBible?.narrativeSpine
    ? String(doc.storyBible.narrativeSpine).trim()
    : '';

  const storyPlan = {
    title: doc.cover.title,
    entries: entriesWithIllustrations,
    /** One-line marketing / back-cover synopsis from the story bible (Writer V2 book-pipeline v1). */
    synopsis: narrativeSpine || null,
    /** Same string as `synopsis` for parity with legacy Writer `plotSynopsis` field in cover metadata. */
    plotSynopsis: narrativeSpine || null,
    tagline: doc.request?.tagline || doc.cover?.tagline || null,
    storyBible: doc.storyBible || null,
    characterDescription: doc.visualBible?.hero?.physicalDescription || null,
    characterOutfit: doc.visualBible?.hero?.outfitDescription || null,
    characterAnchor: null,
    additionalCoverCharacters: supportingCastDescriptions.length > 0
      ? supportingCastDescriptions.join('\n')
      : null,
    // The new pipeline uses the approved cover as a hard anchor for the
    // illustrator directly and doesn't run legacy cover-vision detection, so
    // we can't reliably report parent presence here. Conservative default.
    coverParentPresent: false,
    coverHadVisionSecondaries: supportingCastDescriptions.length > 0,
    heroOutfitFromCover: doc.visualBible?.hero?.outfitDescription || null,
    illustrationPolicy: null,
    isChapterBook: false,
    isGraphicNovel: false,
    _generatedByNewPipeline: true,
    _pipelineVersion: doc.version,
    _bookWideQa: doc.bookWideQa || null,
    _writerQa: doc.writerQa || null,
  };

  return { storyPlan, entriesWithIllustrations };
}

/**
 * Backfill caption-mode fields onto spread entries from a checkpoint written
 * BEFORE toLegacyStoryPlan carried illustrationAspect/captionText (pre
 * 2026-07-16). Native-rendered spreads are square images with no painted
 * text; without these fields assemblePdf takes the legacy wide-split path
 * (bisected art, no story text). The manuscript text was always stashed on
 * `entry.left.text`, so the caption is recoverable in place.
 *
 * Mutates the entries. Only call for checkpoints pinned to the native
 * illustrator — legacy wide-rendered books must keep the split path.
 *
 * @param {object[]} entries - storyPlan.entries from a native checkpoint
 * @returns {number} how many entries were backfilled
 */
function backfillCaptionModeEntries(entries) {
  let backfilled = 0;
  for (const entry of entries) {
    if (!entry || entry.type !== 'spread' || entry.illustrationAspect) continue;
    entry.illustrationAspect = 'square';
    entry.captionText = entry.left?.text || '';
    backfilled += 1;
  }
  return backfilled;
}

module.exports = { toLegacyStoryPlan, backfillCaptionModeEntries };
