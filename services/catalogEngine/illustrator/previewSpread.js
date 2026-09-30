/**
 * The FAST pre-purchase preview spread (2026-09-30).
 *
 * The app's product page shows the parent one real illustrated opening
 * before they buy. It used to run the full-book path for spread 1 (the Book
 * Bible — character sheet, story objects, prop/companion sheets, world
 * plate, outfit spec — then a 4K render with the drawn lettering, QA and a
 * repair loop) so the paid book could replay it: ~3 minutes for one page.
 *
 * The preview is now DISPLAY-ONLY. It never lands on the book's render
 * cache (`children-jobs/{bookId}/preview-spread/`, never `ce-renders/`), so
 * `/generate-book` always renders spread 1 through the full path, and it
 * pays for exactly what the screen needs:
 *   - ONE image call anchored on the approved cover (the renderer's own
 *     safety ladder still applies), at the model's default size;
 *   - TEXT-FREE art — the app sets the story text over the calm left side
 *     in the book's typeface, so there is no painted lettering to verify;
 *   - no character sheet, prop sheets, world plate, QA or repairs.
 *
 * Kill-switch: the app decides (it sends `preview: true`); without it the
 * endpoint runs the full path as before.
 */

const { generateIllustration, downloadPhotoAsBase64 } = require('../../illustrationGenerator');
const { getSignedUrl } = require('../../gcsStorage');
const { buildScenePrompt } = require('./scenes');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The composition the app's text overlay relies on. */
const PREVIEW_COMPOSITION = [
  'PREVIEW COMPOSITION: one wide two-page picture-book spread. Place the child and every key action in the RIGHT half of the frame.',
  'Keep the LEFT third calm, simple scenery at full sharpness and colour (open sky, soft grass, water, a plain wall) with no faces, no important objects and no busy detail — story text will be set over it later.',
  'NEVER paint any text, letters, words, numbers, captions, signs or labels anywhere in the image.',
].join(' ');

/**
 * Render the preview of one spread.
 * @param {object} p
 * @param {string} p.bookId
 * @param {object} p.story validated story response
 * @param {{book: object, theme: object}} p.bookDef the pinned definition
 * @param {object} p.profile normalized child profile
 * @param {string|null} p.approvedCoverUrl identity anchor (preferred)
 * @param {string|null} p.childPhotoUrl fallback anchor
 * @param {string|null} [p.characterDescription]
 * @param {number} [p.spread] default 1
 * @param {object} [p.costTracker]
 * @param {(fraction: number, message: string) => void} [p.onProgress]
 * @param {(level: string, msg: string) => void} [p.log]
 * @returns {Promise<{results: object[], aspect: string, tuningTag: string, outfitLockUsed: string, typographyAnchorUsed: string, advisories: object[], timings: object}>}
 */
async function renderPreviewSpread(p) {
  const {
    bookId, story, bookDef, profile, approvedCoverUrl, childPhotoUrl, characterDescription = null,
    spread = 1, costTracker, onProgress = () => {}, log = () => {},
  } = p;
  const started = Date.now();
  const { book, theme } = bookDef;
  const anchorUrl = approvedCoverUrl || childPhotoUrl;
  if (!anchorUrl) {
    const err = new Error('no identity anchor for the preview spread');
    err.failureCode = 'missing_identity_reference';
    throw err;
  }
  let anchor;
  try {
    anchor = await downloadPhotoAsBase64(anchorUrl);
  } catch (dlErr) {
    const err = new Error(`identity reference could not be downloaded (${dlErr.message})`);
    err.failureCode = 'missing_identity_reference';
    throw err;
  }
  const spreadText = (story.spreads || []).find((s) => Number(s.spread) === spread)?.text || '';
  const scene = `${buildScenePrompt({
    book, theme, spread, spreadText, profile, evidence: story.personalization_evidence, embedText: false,
  })}\n${PREVIEW_COMPOSITION}`;

  onProgress(0.1, 'Painting the preview spread...');
  const heartbeat = setInterval(() => onProgress(0.5, 'Painting the preview spread...'), 30000);
  const storageKey = `children-jobs/${bookId}/preview-spread/spread-${spread}-${Date.now().toString(36)}.png`;
  const attemptLog = [];
  let url = null;
  try {
    url = await generateIllustration(scene, anchorUrl, 'pixar_premium', {
      aspectRatio: '16:9',
      isSpread: true,
      skipTextEmbed: true,
      spreadIndex: spread - 1,
      totalSpreads: 12,
      childName: profile.name,
      childAge: profile.age,
      characterDescription,
      bookId,
      costTracker,
      childPhotoUrl: anchorUrl,
      _cachedPhotoBase64: anchor.base64,
      _cachedPhotoMime: anchor.mimeType,
      gcsPath: storageKey,
      attemptLog,
    });
  } finally {
    clearInterval(heartbeat);
  }
  const renderMs = Date.now() - started;
  const timings = { renderMs, attempts: attemptLog.length || 1 };
  if (!url) {
    const detail = { attempts: attemptLog.slice(-6) };
    log('warn', `preview spread ${spread}: no image after ${Math.round(renderMs / 1000)}s`);
    return {
      results: [{ spread, buffer: null, url: null, storageKey, advisories: [{ stage: 'render', spread, note: 'the preview render returned no image', detail }] }],
      aspect: 'wide', tuningTag: 'none', outfitLockUsed: 'none', typographyAnchorUsed: 'none', advisories: [], timings,
    };
  }
  let signed = url;
  try { signed = await getSignedUrl(storageKey, SIGNED_URL_TTL_MS); } catch { /* keep the upload URL */ }
  log('info', `preview spread ${spread} painted in ${Math.round(renderMs / 1000)}s (${timings.attempts} attempt(s))`);
  onProgress(1, `Preview spread painted in ${Math.round(renderMs / 1000)}s`);
  return {
    // `buffer: true` marks success for the endpoint's filter; the bytes are
    // not needed (nothing downstream composes this render).
    results: [{ spread, buffer: true, url: signed, storageKey, size: null, advisories: [] }],
    aspect: 'wide', tuningTag: 'none', outfitLockUsed: 'none', typographyAnchorUsed: 'none', advisories: [], timings,
  };
}

module.exports = { renderPreviewSpread, PREVIEW_COMPOSITION };
