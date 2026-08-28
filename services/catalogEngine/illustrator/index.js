/**
 * Slim illustrator — renders the CHOSEN story's 12 spreads.
 *
 * Design (deliberate contrast with the deleted native illustrator):
 *  - the fixed catalog beat IS the scene (no art director, no concept pass);
 *  - identity anchors on the parent-APPROVED COVER character (the reference
 *    image on every render); the raw photo is only a fallback for coverless
 *    admin test books;
 *  - one render per spread + ONE vision QA check + ONE corrective re-render,
 *    then ship-with-advisory (closed critical list: painted text, missing or
 *    duplicated child, broken medium);
 *  - renders cache under a deterministic STYLE_VERSION-keyed GCS path so a
 *    re-dispatch replays finished spreads instead of re-paying for them.
 *
 * Words are PDF type, never pixels (D5): every render uses skipTextEmbed
 * and QA hard-checks readable_text.
 */

const { generateIllustration } = require('../../illustrationGenerator');
const { downloadBuffer, getSignedUrl } = require('../../gcsStorage');
const { buildScenePrompt } = require('./scenes');
const { checkSpreadRender, repairNote } = require('./spreadQa');
const { STYLE_VERSION } = require('../versions');
const { fnv1a } = require('../selection');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RENDER_CONCURRENCY = 4;

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
 * Deterministic render-cache path for one spread.
 * @param {string} bookId
 * @param {string} storyHash storyFingerprint of the story being illustrated
 * @param {number} spread
 * @param {string} aspect 'square' | 'wide'
 * @returns {string}
 */
function renderCachePath(bookId, storyHash, spread, aspect) {
  return `children-jobs/${bookId}/ce-renders/${STYLE_VERSION}/${storyHash}/spread-${spread}.${aspect}.png`;
}

/**
 * Render (or replay) one spread; returns the layout-ready record.
 * @returns {Promise<{spread: number, buffer: Buffer|null, storageKey: string, url: string|null, advisories: object[]}>}
 */
async function renderSpread({ bookId, book, theme, profile, story, storyHash, spread, aspect, characterRefUrl, characterDescription, costTracker, forceRerender, log }) {
  const storageKey = renderCachePath(bookId, storyHash, spread, aspect);
  const advisories = [];

  if (!forceRerender) {
    try {
      const cached = await downloadBuffer(storageKey);
      log('info', `Spread ${spread}: replaying cached render (${cached.length} bytes)`);
      return { spread, buffer: cached, storageKey, url: await getSignedUrl(storageKey, SIGNED_URL_TTL_MS), advisories };
    } catch {
      // cache miss — render fresh
    }
  }

  const spreadText = story.spreads.find(s => s.spread === spread)?.text || '';
  const baseScene = buildScenePrompt({
    book, theme, spread, spreadText, profile,
    evidence: story.personalization_evidence,
  });
  const renderOpts = {
    aspectRatio: aspect === 'wide' ? '16:9' : '1:1',
    skipTextEmbed: true,
    isSpread: true,
    spreadIndex: spread - 1,
    totalSpreads: 12,
    childName: profile.name,
    childAge: profile.age,
    characterDescription: characterDescription || null,
    bookId,
    costTracker,
    gcsPath: storageKey,
  };

  let url = await generateIllustration(baseScene, characterRefUrl, 'pixar_premium', renderOpts);
  if (!url) {
    advisories.push({ stage: 'render', spread, note: 'render failed (all prompt variants rejected) — spread has no illustration' });
    return { spread, buffer: null, storageKey, url: null, advisories };
  }
  let buffer = await downloadBuffer(storageKey);

  const qa = await checkSpreadRender(buffer, { label: `spreadQa:${bookId}:s${spread}` });
  if (!qa.pass) {
    log('warn', `Spread ${spread} QA failed (${qa.defects.join('; ')}) — one corrective re-render`);
    // Best-effort by contract: any repair-path failure keeps the first
    // render (with an advisory) instead of failing the whole book.
    try {
      const repairedScene = `${baseScene}\n${repairNote(qa.defects)}`;
      const repairedUrl = await generateIllustration(repairedScene, characterRefUrl, 'pixar_premium', renderOpts);
      if (repairedUrl) {
        url = repairedUrl;
        buffer = await downloadBuffer(storageKey);
        const recheck = await checkSpreadRender(buffer, { label: `spreadQa:${bookId}:s${spread}:repair` });
        if (!recheck.pass) {
          advisories.push({ stage: 'spreadQa', spread, note: `shipped with residual defects after repair: ${recheck.defects.join('; ')}` });
        }
      } else {
        advisories.push({ stage: 'spreadQa', spread, note: `repair render failed; shipped first render with defects: ${qa.defects.join('; ')}` });
      }
    } catch (repairErr) {
      log('warn', `Spread ${spread} repair errored (${repairErr.message}) — shipping the first render`);
      advisories.push({ stage: 'spreadQa', spread, note: `repair render errored (${repairErr.message}); shipped first render with defects: ${qa.defects.join('; ')}` });
    }
  }
  return { spread, buffer, storageKey, url, advisories };
}

/**
 * Illustrate a validated story: 12 renders → layout entries.
 *
 * @param {object} params
 * @param {string} params.bookId main-app book id (GCS namespace)
 * @param {object} params.story validated writer response
 * @param {object} params.bookDef {book, theme} from catalog.getBook
 * @param {object} params.profile normalized profile
 * @param {string|null} params.approvedCoverUrl identity anchor
 * @param {string|null} [params.childPhotoUrl] fallback anchor for coverless test books
 * @param {string|null} [params.characterDescription]
 * @param {string} [params.textLayout] 'caption' (default) | 'embedded'
 * @param {object} [params.costTracker]
 * @param {boolean} [params.forceRerender]
 * @param {(frac: number, message: string) => void} [params.onProgress]
 * @param {(level: string, msg: string) => void} [params.log]
 * @returns {Promise<{entries: object[], previewImageUrls: string[], qaAdvisories: object[], warnings: string[]}>}
 */
async function illustrateStory(params) {
  const {
    bookId, story, bookDef, profile,
    approvedCoverUrl, childPhotoUrl, characterDescription,
    textLayout = 'caption', costTracker, forceRerender = false,
    onProgress = () => {}, log = (l, m) => console.log(`[illustrator:${bookId}] ${m}`),
  } = params;
  const { book, theme } = bookDef;
  const storyHash = storyFingerprint(story);
  const aspect = textLayout === 'embedded' ? 'wide' : 'square';
  const characterRefUrl = approvedCoverUrl || childPhotoUrl || null;
  const warnings = [];
  if (!characterRefUrl) {
    warnings.push('No approved cover or photo reference — renders have no identity anchor (likeness will drift).');
    log('warn', warnings[0]);
  }

  const pLimit = require('p-limit');
  const limit = pLimit(RENDER_CONCURRENCY);
  let done = 0;
  const results = await Promise.all(book.beats.map(beat => limit(async () => {
    const r = await renderSpread({
      bookId, book, theme, profile, story, storyHash,
      spread: beat.spread, aspect, characterRefUrl, characterDescription,
      costTracker, forceRerender, log,
    });
    done += 1;
    onProgress(done / book.beats.length, `Illustrated spread ${beat.spread} (${done}/12)`);
    return r;
  })));

  results.sort((a, b) => a.spread - b.spread);
  const qaAdvisories = results.flatMap(r => r.advisories);
  const missing = results.filter(r => !r.buffer).map(r => r.spread);
  if (missing.length > 0) {
    warnings.push(`Spread(s) ${missing.join(', ')} have no illustration — regenerate via admin before print.`);
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
    ...(textLayout === 'embedded' ? { textZone: null, heroBox: null, figuresBox: null } : {}),
  }));

  return {
    entries,
    previewImageUrls: results.map(r => r.url).filter(Boolean),
    qaAdvisories,
    warnings,
  };
}

module.exports = { illustrateStory, renderCachePath, storyFingerprint };
