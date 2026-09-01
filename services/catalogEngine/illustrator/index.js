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
 * Text policy (per layout — 2026-08-31 change of D5):
 *  - `caption` layout: words are PDF type, never pixels — renders use
 *    skipTextEmbed and QA hard-checks readable_text as a defect.
 *  - `embedded` layout: the story text is painted INTO the art by Gemini
 *    (the legacy embedText path: prompt typography rules + OCR verify with
 *    extra retries inside generateIllustration), and spread QA verifies the
 *    painted text matches the manuscript instead of forbidding it.
 */

const { generateIllustration, downloadPhotoAsBase64 } = require('../../illustrationGenerator');
const { downloadBuffer, uploadBuffer, getSignedUrl, deletePrefix } = require('../../gcsStorage');
const { buildScenePrompt } = require('./scenes');
const { checkSpreadRender, repairNote, checkWorldConsistency, worldRepairNote } = require('./spreadQa');
const { normalizeArtTuning, renderArtTuningBlock } = require('./tuning');
const { getWorldPlate } = require('./worldPlate');
const { renderWorldCardBlock } = require('../worldCards');
const { STYLE_VERSION } = require('../versions');
const { fnv1a } = require('../selection');
const flags = require('../flags');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RENDER_CONCURRENCY = 4;

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
 * Render (or replay) one spread; returns the layout-ready record. `fresh`
 * marks pixels created by THIS call (base render or repair) — a cache
 * replay is not fresh, and only fresh renders are eligible for the world
 * gate's corrective re-render.
 * @returns {Promise<{spread: number, buffer: Buffer|null, storageKey: string, url: string|null, advisories: object[], fresh: boolean}>}
 */
async function renderSpread({ bookId, book, theme, profile, story, storyHash, spread, aspect, cacheAspect, textLayout, characterRefUrl, refPhoto, characterDescription, tuning, worldPlate, worldNote, seed, costTracker, forceRerender, log }) {
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

  const spreadText = story.spreads.find(s => s.spread === spread)?.text || '';
  const scene = buildScenePrompt({
    book, theme, spread, spreadText, profile,
    evidence: story.personalization_evidence,
    embedText,
  });
  // The Art Tuning Layer rides BELOW the whole scene (and above nothing):
  // renderArtTuningBlock frames it as style-only, subordinate to the action,
  // identity/count, no-text, and medium rules that precede it.
  const tuningBlock = renderArtTuningBlock(tuning, spread);
  // Half layout: the art is a FULL-SPREAD wide composition, but in print
  // the LEFT page is covered by the solid text panel — the model must keep
  // everything that matters in the surviving right half.
  const halfHint = textLayout === 'half'
    ? '\nCOMPOSITION FOR PRINT (HALF-PAGE LAYOUT): this artwork prints as a full spread whose LEFT half is covered by a solid text panel. Place the child and ALL key story action fully in the RIGHT half of the image; keep the LEFT half continuous calm background (water, sky, foliage, scenery) with no faces, no companion, and no critical story elements there.'
    : '';
  const sceneWithLayout = halfHint ? `${scene}${halfHint}` : scene;
  // worldNote: the world-consistency gate's corrective suffix on its one
  // targeted re-render (always with forceRerender, so the cache never
  // conflates a gate-repaired render with a base one at a stale key).
  const sceneWithWorldNote = worldNote ? `${sceneWithLayout}\n${worldNote}` : sceneWithLayout;
  const baseScene = tuningBlock ? `${sceneWithWorldNote}\n${tuningBlock}` : sceneWithWorldNote;
  // Per-attempt diagnostics sink (filled by generateIllustration): when the
  // render fails, the advisory carries WHY — variant ladder, NSFW blocks,
  // Gemini finish/block reasons, the model's own refusal text.
  const attemptLog = [];
  const renderOpts = {
    attemptLog,
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
    bookId,
    costTracker,
    gcsPath: storageKey,
    // The identity anchor: generateIllustration reads the reference image
    // from opts (never from its second positional parameter) — the bytes
    // were resolved ONCE by illustrateStory and ride every render.
    childPhotoUrl: characterRefUrl,
    _cachedPhotoBase64: refPhoto.base64,
    _cachedPhotoMime: refPhoto.mimeType,
    // The fixed per-theme world plate (or null): a second reference image
    // identical on every spread, so stateless renders converge on one world.
    ...(worldPlate ? { worldPlate: { base64: worldPlate.base64, mimeType: worldPlate.mimeType } } : {}),
    // The world-law card must survive the renderer's generic-safe NSFW
    // fallback too — that variant discards the scene (card included), and
    // Layer 1 promises the card on EVERY render.
    safeFallbackSuffix: renderWorldCardBlock(theme.theme_id) || null,
    // Workbench probes may pin a seed for tighter A/B; applying it stays
    // env-gated inside the renderer (BOOK_PIPELINE_V3_RENDER_SEED, with a
    // retry-without on seed-rejecting models). The seed also rides the
    // cache key upstream, so differently-seeded probes never replay each
    // other.
    ...(seed != null ? { seed } : {}),
  };

  let buffer = null;
  let url = null;
  // fresh = this call created new pixels for this spread (base render or
  // repair). The world-consistency gate may only re-render FRESH spreads: a
  // replayed cached render's storageKey is shared with earlier captured
  // rounds, and overwriting it would silently change what they display.
  let fresh = false;
  if (!forceRerender) {
    try {
      const cached = await downloadBuffer(storageKey);
      try {
        const marker = JSON.parse((await downloadBuffer(qaMarkerKey)).toString('utf8'));
        // The marker vouches for SPECIFIC pixels: a forced overwrite that
        // failed before its marker write leaves new bytes beside the old
        // marker, so a replay only trusts a marker whose renderHash matches
        // the cached image — anything else re-checks.
        if (marker.renderHash !== renderContentHash(cached)) {
          throw new Error('marker does not match the cached render');
        }
        log('info', `Spread ${spread}: replaying cached QA-checked render (${cached.length} bytes)`);
        return {
          spread, buffer: cached, storageKey,
          url: await getSignedUrl(storageKey, SIGNED_URL_TTL_MS),
          advisories: Array.isArray(marker.advisories) ? marker.advisories : [],
          fresh: false,
        };
      } catch (markerErr) {
        // No marker (crash between upload and check) or a marker for other
        // pixels — re-check the cached image instead of approving it.
        log('warn', `Spread ${spread}: cached render not QA-vouched (${markerErr.message}) — re-checking before replay`);
        buffer = cached;
        url = await getSignedUrl(storageKey, SIGNED_URL_TTL_MS);
      }
    } catch {
      // cache miss — render fresh
    }
  } else {
    // A forced re-render overwrites a possibly-marked key: drop the stale
    // marker FIRST so a failure anywhere before the new marker write leaves
    // unmarked pixels (re-checked on replay), never new pixels vouched for
    // by the old marker. Best-effort — the hash check above is the backstop.
    await deletePrefix(qaMarkerKey).catch(() => {});
  }

  if (!buffer) {
    url = await generateIllustration(baseScene, characterRefUrl, 'pixar_premium', renderOpts);
    if (!url) {
      advisories.push({
        stage: 'render', spread,
        note: 'render failed (all prompt variants rejected) — spread has no illustration',
        ...(attemptLog.length > 0 ? { detail: { attempts: attemptLog } } : {}),
      });
      return { spread, buffer: null, storageKey, url: null, advisories, fresh: false };
    }
    buffer = await downloadBuffer(storageKey);
    fresh = true;
  }

  const qa = await checkSpreadRender(buffer, {
    label: `spreadQa:${bookId}:s${spread}`,
    expectedText: embedText ? spreadText : null,
  });
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
      const repairedScene = `${baseScene}\n${repairNote(qa.defects, embedText ? spreadText : null)}`;
      const repairedUrl = await generateIllustration(repairedScene, characterRefUrl, 'pixar_premium', renderOpts);
      if (repairedUrl) {
        url = repairedUrl;
        buffer = await downloadBuffer(storageKey);
        fresh = true;
        const recheck = await checkSpreadRender(buffer, {
          label: `spreadQa:${bookId}:s${spread}:repair`,
          expectedText: embedText ? spreadText : null,
        });
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
        // renderHash pins the marker to the exact bytes that were checked:
        // if a repair uploaded new pixels but this in-memory buffer is the
        // first render (post-repair download failed), the hashes differ
        // and the next replay re-checks instead of trusting this marker.
        Buffer.from(JSON.stringify({ advisories, tuningTag, renderHash: renderContentHash(buffer), checkedAt: new Date().toISOString() })),
        qaMarkerKey,
        'application/json',
      );
    } catch (mErr) {
      log('warn', `Spread ${spread}: QA marker write failed (${mErr.message}) — a replay will re-check`);
    }
  }
  return { spread, buffer, storageKey, url, advisories, fresh };
}

/** Corrective world-gate re-renders allowed per run (cost bound). */
const WORLD_QA_MAX_RERENDERS = () => {
  const n = Number(process.env.CATALOG_WORLD_QA_MAX_RERENDERS);
  return Number.isInteger(n) && n >= 0 ? n : 3;
};

/**
 * Which flagged spreads the world gate may re-render: FRESH renders only
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
 * @param {(level: string, msg: string) => void} params.log
 * @returns {Promise<{pass: boolean, checked: number, flagged?: Array, rerendered?: number[], unavailable?: string}|null>}
 *   null when the gate did not run (kill-switch, or <2 renders to compare)
 */
async function runWorldConsistencyGate({ results, rerender, log }) {
  if (!flags.worldQaEnabled()) return null;
  const rendered = results.filter(r => r.buffer);
  if (rendered.length < 2) return null; // consistency needs a comparison
  const verdict = await checkWorldConsistency(
    rendered.map(r => ({ spread: r.spread, buffer: r.buffer })),
    { label: 'worldQa' },
  );
  if (!verdict) return null;
  if (verdict.qaUnavailable) {
    log('warn', `world gate UNCHECKED — ${verdict.qaUnavailable}`);
    return { pass: true, checked: rendered.length, unavailable: verdict.qaUnavailable };
  }
  if (verdict.pass) return { pass: true, checked: rendered.length };

  const plan = planWorldRepairs(results, verdict.flagged, WORLD_QA_MAX_RERENDERS());
  const rerendered = [];
  for (const f of plan) {
    const idx = results.findIndex(r => r.spread === f.spread && r.buffer);
    if (idx === -1) continue;
    const entry = results[idx];
    entry.advisories.push({ stage: 'worldQa', spread: f.spread, note: `world consistency: ${f.note}` });
    if (f.skipReason) {
      entry.advisories.push({ stage: 'worldQa', spread: f.spread, note: `shipped without world re-render (${f.skipReason})` });
      continue;
    }
    log('warn', `Spread ${f.spread} broke world consistency (${f.note}) — one corrective re-render`);
    try {
      const repaired = await rerender(f.spread, worldRepairNote(f.note));
      if (repaired.buffer) {
        // Keep the audit trail: the gate finding + the fresh render's own
        // advisories ride together on the replacing entry.
        results[idx] = { ...repaired, advisories: [...entry.advisories, ...repaired.advisories] };
        rerendered.push(f.spread);
      } else {
        entry.advisories.push({ stage: 'worldQa', spread: f.spread, note: 'world re-render failed; shipped the flagged render' });
      }
    } catch (err) {
      log('warn', `Spread ${f.spread} world re-render errored (${err.message}) — shipping the flagged render`);
      entry.advisories.push({ stage: 'worldQa', spread: f.spread, note: `world re-render errored (${err.message}); shipped the flagged render` });
    }
  }
  return { pass: false, checked: rendered.length, flagged: verdict.flagged, rerendered };
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
 * @param {string} [params.textLayout] 'caption' (default) | 'half' | 'embedded'.
 *   'half' renders a text-FREE full-spread WIDE composition (subject pushed
 *   into the right half — the left half is covered by the solid text panel
 *   at page assembly), cached under 'wide-plain' so it never replays an
 *   embedded book's text-painted wide render.
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
 * @returns {Promise<{results: Array<{spread, buffer, storageKey, url, advisories, fresh}>, aspect: string, storyHash: string, tuningTag: string, worldQa: object|null}>}
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

  // The fixed per-theme world plate: resolved ONCE (like the anchor bytes)
  // and identical on every spread of the call — full book and probe subset
  // alike. Fail-open: null (kill-switch, or plate generation failed) means
  // plate-less renders, never a failed run.
  const worldPlate = await getWorldPlate({ theme, costTracker, log });

  const baseHash = storyFingerprint(story);
  let keyHash = baseHash;
  if (worldPlate) {
    // The plate is a render input: a regenerated plate (or a plate-less
    // run after a plated one) must never replay the other's cached pixels.
    keyHash = `${keyHash}-w${worldPlate.hash}`;
  }
  if (identityKeyed) {
    // Probe cache keys carry an IDENTITY fingerprint: a workbench book's
    // anchor is admin-mutable, so the same bookId/story/tag after an anchor
    // (or characterDescription) change must never replay the prior child's
    // cached image. Keyed on the anchor's PATH — a signed URL's rotating
    // query string must not bust the cache for the same object. APPENDED to
    // keyHash (never rebuilt from baseHash) so the plate fingerprint above
    // survives on probes; the full-book path stays identity-un-salted.
    const identityBasis = `${String(characterRefUrl).split('?')[0]}|${characterDescription || ''}`;
    keyHash = `${keyHash}-i${fnv1a(identityBasis).toString(36)}`;
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
      spread: beat.spread, aspect, cacheAspect, textLayout, characterRefUrl, refPhoto, characterDescription,
      tuning, worldPlate, seed, costTracker, forceRerender, log,
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
    // The per-attempt diagnostics the renderer attached to the failure —
    // "failed after 5 attempts" alone is not actionable for the admin.
    const detail = {
      ...(Array.isArray(s.reason?.attempts) && s.reason.attempts.length > 0 ? { attempts: s.reason.attempts } : {}),
      ...(s.reason?.failureCode ? { failureCode: s.reason.failureCode } : {}),
    };
    return {
      spread,
      buffer: null,
      storageKey: renderCachePath(bookId, storyHash, spread, cacheAspect, tuning ? tuning.tag : 'none'),
      url: null,
      advisories: [{ stage: 'render', spread, note, ...(Object.keys(detail).length > 0 ? { detail } : {}) }],
      fresh: false,
    };
  });

  results.sort((a, b) => a.spread - b.spread);

  // Book-level world-consistency gate: check the set together, re-render
  // flagged FRESH spreads once (through the same full per-spread path).
  const worldQa = await runWorldConsistencyGate({
    results,
    rerender: (spread, note) => renderSpread({
      bookId, book, theme, profile, story, storyHash,
      spread, aspect, cacheAspect, textLayout, characterRefUrl, refPhoto, characterDescription,
      tuning, worldPlate, worldNote: note, seed, costTracker, forceRerender: true, log,
    }),
    log,
  });

  return { results, aspect, storyHash, tuningTag: tuning ? tuning.tag : 'none', worldQa };
}

/**
 * Illustrate a validated story: 12 renders → layout entries.
 *
 * @param {object} params renderStorySpreads params (minus `spreads`/`probeNonce` — a
 *   full book always renders every beat on the un-salted cache key)
 * @returns {Promise<{entries: object[], previewImageUrls: string[], qaAdvisories: object[], warnings: string[], illustrationTuningUsed: string, worldQa: object|null}>}
 */
async function illustrateStory(params) {
  const { story, textLayout = 'caption' } = params;
  const warnings = [];
  const { results, aspect, tuningTag, worldQa } = await renderStorySpreads({
    ...params, spreads: null, probeNonce: null,
  });
  const qaAdvisories = results.flatMap(r => r.advisories);
  // Residual QA defects ship with advisories, but the ABSENCE of an image is
  // not advisory-class: a blank spread must fail the run (finished renders
  // stay cached, so the retry re-pays only for the missing spreads).
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
  };
}

module.exports = { illustrateStory, renderStorySpreads, renderCachePath, storyFingerprint, planWorldRepairs };
