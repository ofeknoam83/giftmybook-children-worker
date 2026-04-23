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
  const spreadEntries = doc.spreads.map(s => ({
    type: 'spread',
    spread: s.spreadNumber,
    // Text is painted into the image by the new pipeline. layoutEngine's
    // assemblePdf ignores left/right text for 'spread' entries (it only
    // reads spreadIllustrationBuffer), but downstream helpers like
    // computeSynopsis still read left.text for the back-cover fallback —
    // so we stash the manuscript text on `left.text` and leave right empty.
    left: { text: s.manuscript?.text || '' },
    right: { text: '' },
    spreadIllustrationUrl: s.illustration?.imageUrl || null,
    spreadIllustrationStorageKey: s.illustration?.imageStorageKey || null,
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

  const storyPlan = {
    title: doc.cover.title,
    entries: entriesWithIllustrations,
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

module.exports = { toLegacyStoryPlan };
