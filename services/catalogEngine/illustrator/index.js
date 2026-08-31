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

const { generateIllustration, downloadPhotoAsBase64 } = require('../../illustrationGenerator');
const { downloadBuffer, uploadBuffer, getSignedUrl } = require('../../gcsStorage');
const { buildScenePrompt } = require('./scenes');
const { checkSpreadRender, repairNote } = require('./spreadQa');
const { normalizeArtTuning, renderArtTuningBlock } = require('./tuning');
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
 * Render (or replay) one spread; returns the layout-ready record.
 * @returns {Promise<{spread: number, buffer: Buffer|null, storageKey: string, url: string|null, advisories: object[]}>}
 */
async function renderSpread({ bookId, book, theme, profile, story, storyHash, spread, aspect, characterRefUrl, refPhoto, characterDescription, tuning, seed, costTracker, forceRerender, log }) {
  const tuningTag = tuning ? tuning.tag : 'none';
  const storageKey = renderCachePath(bookId, storyHash, spread, aspect, tuningTag);
  // The render is uploaded to the cache key BEFORE QA runs, so the image
  // alone does not prove it was ever checked: only this marker (written
  // after QA/repair completes) lets a replay skip the check.
  const qaMarkerKey = `${storageKey}.qa.json`;
  const advisories = [];

  const spreadText = story.spreads.find(s => s.spread === spread)?.text || '';
  const scene = buildScenePrompt({
    book, theme, spread, spreadText, profile,
    evidence: story.personalization_evidence,
  });
  // The Art Tuning Layer rides BELOW the whole scene (and above nothing):
  // renderArtTuningBlock frames it as style-only, subordinate to the action,
  // identity/count, no-text, and medium rules that precede it.
  const tuningBlock = renderArtTuningBlock(tuning, spread);
  const baseScene = tuningBlock ? `${scene}\n${tuningBlock}` : scene;
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
    // The identity anchor: generateIllustration reads the reference image
    // from opts (never from its second positional parameter) — the bytes
    // were resolved ONCE by illustrateStory and ride every render.
    childPhotoUrl: characterRefUrl,
    _cachedPhotoBase64: refPhoto.base64,
    _cachedPhotoMime: refPhoto.mimeType,
    // Workbench probes may pin a seed for tighter A/B; applying it stays
    // env-gated inside the renderer (BOOK_PIPELINE_V3_RENDER_SEED, with a
    // retry-without on seed-rejecting models). The seed also rides the
    // cache key upstream, so differently-seeded probes never replay each
    // other.
    ...(seed != null ? { seed } : {}),
  };

  let buffer = null;
  let url = null;
  if (!forceRerender) {
    try {
      const cached = await downloadBuffer(storageKey);
      try {
        const marker = JSON.parse((await downloadBuffer(qaMarkerKey)).toString('utf8'));
        log('info', `Spread ${spread}: replaying cached QA-checked render (${cached.length} bytes)`);
        return {
          spread, buffer: cached, storageKey,
          url: await getSignedUrl(storageKey, SIGNED_URL_TTL_MS),
          advisories: Array.isArray(marker.advisories) ? marker.advisories : [],
        };
      } catch {
        // Render uploaded but its QA never completed (crash between upload
        // and check) — re-check the cached image instead of approving it.
        log('warn', `Spread ${spread}: cached render has NO QA marker — re-checking before replay`);
        buffer = cached;
        url = await getSignedUrl(storageKey, SIGNED_URL_TTL_MS);
      }
    } catch {
      // cache miss — render fresh
    }
  }

  if (!buffer) {
    url = await generateIllustration(baseScene, characterRefUrl, 'pixar_premium', renderOpts);
    if (!url) {
      advisories.push({ stage: 'render', spread, note: 'render failed (all prompt variants rejected) — spread has no illustration' });
      return { spread, buffer: null, storageKey, url: null, advisories };
    }
    buffer = await downloadBuffer(storageKey);
  }

  const qa = await checkSpreadRender(buffer, { label: `spreadQa:${bookId}:s${spread}` });
  let checkerUnavailable = !!qa.qaUnavailable;
  if (qa.qaUnavailable) {
    // A checker outage must never report silently clean: ship best-effort,
    // but say so on the completion payload.
    advisories.push({ stage: 'spreadQa', spread, note: `shipped UNCHECKED — ${qa.qaUnavailable}` });
  }
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
        if (recheck.qaUnavailable) {
          checkerUnavailable = true;
          advisories.push({ stage: 'spreadQa', spread, note: `repair shipped UNCHECKED — ${recheck.qaUnavailable}` });
        }
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

  // Persist the QA-complete marker so future replays skip the check
  // (best-effort — a failed write only means the replay re-checks). NOT
  // written when the checker itself was unavailable: the next replay must
  // re-attempt a real check instead of inheriting "shipped UNCHECKED".
  if (!checkerUnavailable) {
    try {
      await uploadBuffer(
        Buffer.from(JSON.stringify({ advisories, tuningTag, checkedAt: new Date().toISOString() })),
        qaMarkerKey,
        'application/json',
      );
    } catch (mErr) {
      log('warn', `Spread ${spread}: QA marker write failed (${mErr.message}) — a replay will re-check`);
    }
  }
  return { spread, buffer, storageKey, url, advisories };
}

/**
 * Render a validated story's spreads (all 12, or a chosen subset) through
 * the ONE production render path (cache → render → QA → repair → marker).
 * This is the shared body of the full-book pipeline AND the workbench probe
 * (`/v13/render-spreads`) — the illustration feedback loop tunes exactly
 * what production runs, or it tunes nothing.
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
 * @param {number[]|null} [params.spreads] subset of spread numbers (default: all beats)
 * @param {object|null} [params.tuning] raw illustrationTuning overlay (normalized here; kill-switch applied)
 * @param {boolean} [params.identityKeyed] probe-only: fold the identity anchor
 *   (URL path + characterDescription) into the cache key so an anchor change
 *   never replays another child's renders
 * @param {number|null} [params.seed] probe-only render seed (cache-keyed; applying
 *   it is env-gated in the renderer)
 * @param {string|null} [params.probeNonce] workbench-only cache-key salt (variance probes re-render instead of replaying)
 * @param {object} [params.costTracker]
 * @param {boolean} [params.forceRerender]
 * @param {(frac: number, message: string) => void} [params.onProgress]
 * @param {(level: string, msg: string) => void} [params.log]
 * @returns {Promise<{results: Array<{spread, buffer, storageKey, url, advisories}>, aspect: string, storyHash: string, tuningTag: string}>}
 */
async function renderStorySpreads(params) {
  const {
    bookId, story, bookDef, profile,
    approvedCoverUrl, childPhotoUrl, characterDescription,
    textLayout = 'caption', spreads = null, probeNonce = null,
    costTracker, forceRerender = false,
    onProgress = () => {}, log = (l, m) => console.log(`[illustrator:${bookId}] ${m}`),
  } = params;
  const { book, theme } = bookDef;
  const { identityKeyed = false, seed = null } = params;
  const tuning = normalizeArtTuning(params.tuning || null);
  const aspect = textLayout === 'embedded' ? 'wide' : 'square';
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

  const baseHash = storyFingerprint(story);
  let keyHash = baseHash;
  if (identityKeyed) {
    // Probe cache keys carry an IDENTITY fingerprint: a workbench book's
    // anchor is admin-mutable, so the same bookId/story/tag after an anchor
    // (or characterDescription) change must never replay the prior child's
    // cached image. Keyed on the anchor's PATH — a signed URL's rotating
    // query string must not bust the cache for the same object. The
    // full-book path stays un-salted so existing production caches replay
    // byte-identically.
    const identityBasis = `${String(characterRefUrl).split('?')[0]}|${characterDescription || ''}`;
    keyHash = `${baseHash}-i${fnv1a(identityBasis).toString(36)}`;
  }
  if (seed != null) keyHash = `${keyHash}-s${seed}`;
  const nonce = probeNonce ? String(probeNonce).replace(/[^A-Za-z0-9-]/g, '').slice(0, 16) : '';
  const storyHash = nonce ? `${keyHash}-${nonce}` : keyHash;

  const wanted = Array.isArray(spreads) && spreads.length > 0
    ? book.beats.filter(b => spreads.includes(b.spread))
    : book.beats;
  const pLimit = require('p-limit');
  const limit = pLimit(RENDER_CONCURRENCY);
  let done = 0;
  // allSettled, not all: one thrown spread must cost only THAT spread — the
  // probe contract reports per-spread failures, and the other renders were
  // already paid for (they stay cached either way). The full-book caller
  // still fails the run on any missing buffer below.
  const settled = await Promise.allSettled(wanted.map(beat => limit(async () => {
    const r = await renderSpread({
      bookId, book, theme, profile, story, storyHash,
      spread: beat.spread, aspect, characterRefUrl, refPhoto, characterDescription,
      tuning, seed, costTracker, forceRerender, log,
    });
    done += 1;
    onProgress(done / wanted.length, `Illustrated spread ${beat.spread} (${done}/${wanted.length})`);
    return r;
  })));
  const results = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const spread = wanted[i].spread;
    const note = `render errored: ${s.reason?.message || String(s.reason)}`;
    log('error', `Spread ${spread} ${note}`);
    return {
      spread,
      buffer: null,
      storageKey: renderCachePath(bookId, storyHash, spread, aspect, tuning ? tuning.tag : 'none'),
      url: null,
      advisories: [{ stage: 'render', spread, note }],
    };
  });

  results.sort((a, b) => a.spread - b.spread);
  return { results, aspect, storyHash, tuningTag: tuning ? tuning.tag : 'none' };
}

/**
 * Illustrate a validated story: 12 renders → layout entries.
 *
 * @param {object} params renderStorySpreads params (minus `spreads`/`probeNonce` — a
 *   full book always renders every beat on the un-salted cache key)
 * @returns {Promise<{entries: object[], previewImageUrls: string[], qaAdvisories: object[], warnings: string[], illustrationTuningUsed: string}>}
 */
async function illustrateStory(params) {
  const { story, textLayout = 'caption' } = params;
  const warnings = [];
  const { results, aspect, tuningTag } = await renderStorySpreads({
    ...params, spreads: null, probeNonce: null,
  });
  const qaAdvisories = results.flatMap(r => r.advisories);
  // Residual QA defects ship with advisories, but the ABSENCE of an image is
  // not advisory-class: a blank spread must fail the run (finished renders
  // stay cached, so the retry re-pays only for the missing spreads).
  const missing = results.filter(r => !r.buffer).map(r => r.spread);
  if (missing.length > 0) {
    const err = new Error(`render failed for spread(s) ${missing.join(', ')} — the book cannot complete with blank art; retry re-renders only the missing spreads`);
    err.failureCode = 'render_failed';
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
    ...(textLayout === 'embedded' ? { textZone: null, heroBox: null, figuresBox: null } : {}),
  }));

  return {
    entries,
    previewImageUrls: results.map(r => r.url).filter(Boolean),
    qaAdvisories,
    warnings,
    illustrationTuningUsed: tuningTag,
  };
}

module.exports = { illustrateStory, renderStorySpreads, renderCachePath, storyFingerprint };
