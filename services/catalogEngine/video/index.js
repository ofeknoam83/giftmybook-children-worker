/**
 * The gift video (gv-1 — docs/GIFT_VIDEO_PLAN.md): a 10-second, text-free,
 * FULLY ANIMATED film of one book — the approved cover coming alive, the
 * opening spread, the emotional peak, the resolution — built from the exact
 * shipped renders and the Book Bible, one image-to-video clip per segment,
 * each verified against the character sheet, selected among candidates,
 * repaired within a bounded budget, and failed closed (`video_unresolved`
 * with the scored candidates attached) rather than degraded.
 *
 * Order of work: resolve provider → anchor + bible → plan → start frames
 * (embedded books re-render text-free) → text gate → film-level replay
 * check → references + briefs → per segment: candidates → verify → repair
 * → promote → stitch → upload → manifest.
 */

const path = require('path');
const fs = require('fs');
const pLimit = require('p-limit');
const { downloadPhotoAsBase64 } = require('../../illustrationGenerator');
const { downloadBuffer, uploadBuffer, getSignedUrl, objectExists, loadJson, saveJson } = require('../../gcsStorage');
const { renderStorySpreads, storyFingerprint } = require('../illustrator');
const { buildBookBible, summarizeBible, anchorHash } = require('../illustrator/bible');
const { buildShotPlan } = require('../illustrator/shotPlan');
const { visualPropsForSpread, continuityPropsForSpread, beatMentionsCompanion } = require('../illustrator/scenes');
const { isModestBathWaterScene } = require('../../illustrationGenerator');
const { pickBest, compareCandidates, residualBlocking } = require('../illustrator/select');
const { EMOTION_CUES } = require('../illustrator/emotionPlan');
const { normalizePropValue } = require('../illustrator/bible/propSheet');
const { QA_VERSION, VIDEO_VERSION } = require('../versions');
const { fnv1a } = require('../selection');
const flags = require('../flags');
const { buildFilmPlan } = require('./plan');
const { buildClipBrief, repairBrief } = require('./brief');
const { validateRenders, fetchStill, prepareStartFrame, textGate, contentHash } = require('./stills');
const { resolveProvider } = require('./providers');
const { generateCandidates, videoBase } = require('./generate');
const { verifyClip } = require('./verify');
const ffmpeg = require('./ffmpeg');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CANDIDATE_CONCURRENCY = 4;

class VideoError extends Error {
  constructor(message, failureCode, details) {
    super(message);
    this.name = 'VideoError';
    this.failureCode = failureCode || null;
    this.details = details || null;
  }
}

/**
 * Upload bytes at a deterministic key and return a signed URL for the vendor.
 * @param {Buffer} buffer
 * @param {string} key
 * @param {string} contentType
 * @returns {Promise<string>}
 */
async function stage(buffer, key, contentType) {
  return uploadBuffer(buffer, key, contentType);
}

/**
 * The film's music bed, when configured and bundled.
 * @param {string} music
 * @returns {string|null}
 */
function musicPathFor(music) {
  if (!music || music === 'none') return null;
  const safe = String(music).replace(/[^A-Za-z0-9_-]/g, '');
  const file = path.join(__dirname, '..', 'data', 'video', 'music', `${safe}.mp3`);
  return fs.existsSync(file) ? file : null;
}

/**
 * Generate the gift video for one book.
 * @param {object} p
 * @param {string} p.bookId
 * @param {object} p.story validated writer response (the pinned story)
 * @param {object} p.bookDef {book, theme, ageBand} from getBookForTag
 * @param {object} p.profile normalized profile
 * @param {Array<{spread: number, storageKey: string}>} p.renders the exact shipped render keys
 * @param {string|null} p.approvedCoverUrl
 * @param {string|null} [p.childPhotoUrl]
 * @param {string|null} [p.characterDescription]
 * @param {string} [p.textLayout]
 * @param {object|null} [p.tuning] illustrationTuning overlay (for embedded re-renders)
 * @param {boolean} [p.identityKeyed]
 * @param {number|null} [p.seed]
 * @param {string|null} [p.probeNonce]
 * @param {string|null} [p.provider]
 * @param {string|null} [p.model]
 * @param {string} [p.aspect]
 * @param {string} [p.music]
 * @param {boolean} [p.forceNew]
 * @param {string|null} [p.providerToken] request-injected provider token (fallback to the env)
 * @param {number} [p.pollIntervalMs] vendor poll interval (tests)
 * @param {object} p.costTracker
 * @param {(fraction: number, message: string) => void} [p.onProgress]
 * @param {() => void} [p.touch] book-context activity touch
 * @param {AbortSignal} [p.abortSignal]
 * @param {(level: string, msg: string) => void} [p.log]
 * @returns {Promise<object>} the callback body fields (video, plan, textGate, bookBible, unresolved, advisories, warnings)
 */
async function generateGiftVideo(p) {
  const log = p.log || ((l, m) => console.log(`[giftVideo:${p.bookId}] ${m}`));
  const onProgress = p.onProgress || (() => {});
  const touch = p.touch || (() => {});
  const { bookId, story, bookDef, profile, costTracker } = p;
  const { book, theme } = bookDef;
  const ageBand = bookDef.ageBand;
  const textLayout = p.textLayout || 'caption';
  const aspect = p.aspect === '9:16' ? '9:16' : '16:9';
  const music = p.music || flags.videoMusic();
  const advisories = [];
  const warnings = [];

  // ── Provider ──────────────────────────────────────────────────────────
  const provider = resolveProvider({ provider: p.provider, model: p.model });
  if (!provider.ok) throw new VideoError(provider.error, 'video_provider_unavailable');

  // ── Renders → entries ──────────────────────────────────────────────────
  const validated = validateRenders(bookId, p.renders);
  if (!validated.ok) throw new VideoError(validated.error, 'video_no_sources');
  const entries = validated.entries;

  // ── Anchor + Book Bible (the identity kit every clip references) ───────
  const characterRefUrl = p.approvedCoverUrl || p.childPhotoUrl || null;
  if (!characterRefUrl) throw new VideoError('no approved cover and no child photo — the clips would have no identity reference', 'missing_identity_reference');
  let refPhoto;
  try {
    refPhoto = await downloadPhotoAsBase64(characterRefUrl);
  } catch (err) {
    throw new VideoError(`identity reference could not be downloaded (${err.message})`, 'missing_identity_reference');
  }
  let childPhoto = null;
  if (p.approvedCoverUrl && p.childPhotoUrl && p.childPhotoUrl !== p.approvedCoverUrl) {
    try { childPhoto = await downloadPhotoAsBase64(p.childPhotoUrl); } catch (err) { log('warn', `child photo unavailable for the character sheet (${err.message})`); }
  }
  const bibleHeartbeat = setInterval(() => { touch(); onProgress(0.02, 'Building the book bible (character sheet, props, plan)...'); }, 30000);
  let bible;
  try {
    onProgress(0.02, 'Building the book bible...');
    bible = await buildBookBible({
      bookId, theme, book, story, profile, ageBand,
      anchorUrl: characterRefUrl, refPhoto, childPhoto, characterDescription: p.characterDescription || null,
      costTracker, log,
    });
  } finally {
    clearInterval(bibleHeartbeat);
  }
  for (const a of bible.advisories || []) advisories.push(a);
  if (!bible.sheet) {
    // The sheet is the identity reference of every clip: without one the
    // film would animate an unpinned child. (CATALOG_SHEET_REQUIRED=0 lets
    // renders proceed sheet-less; the film does not.)
    throw new VideoError('no character model sheet is available for this anchor — the clips would have no identity reference', 'identity_kit_failed');
  }

  // ── Plan ───────────────────────────────────────────────────────────────
  const baseHash = storyFingerprint(story);
  const shotPlan = flags.shotPlanEnabled()
    ? buildShotPlan({ seedBasis: baseHash, spreads: book.beats.map(b => b.spread), ageBand, textLayout })
    : null;
  const emotionPlan = bible.emotion ? bible.emotion.plan : null;
  let plan = buildFilmPlan({ available: entries.map(e => e.spread), coverKind: p.approvedCoverUrl ? 'cover' : 'photo', emotionPlan, shotPlan, textLayout, ageBand });
  if (plan.segments.length === 0) throw new VideoError('no usable spreads for the film', 'video_no_sources');

  // ── Start frames (embedded renders re-rendered text-free) ──────────────
  onProgress(0.08, 'Resolving the start frames...');
  const bySpread = new Map(entries.map(e => [e.spread, e]));
  const plannedSpreads = plan.segments.filter(s => s.kind === 'spread').map(s => s.spread);
  const rerenderSpreads = plannedSpreads.filter(s => bySpread.get(s).embedded);
  const frames = new Map(); // segment index → {buffer, hash, storageKey|null, rerendered}
  if (rerenderSpreads.length > 0) {
    log('info', `re-rendering ${rerenderSpreads.length} embedded spread(s) text-free for the film: ${rerenderSpreads.join(', ')}`);
    onProgress(0.1, `Rendering text-free start frames (${rerenderSpreads.length})...`);
    const art = await renderStorySpreads({
      bookId, story, bookDef, profile,
      approvedCoverUrl: p.approvedCoverUrl, childPhotoUrl: p.childPhotoUrl || null, characterDescription: p.characterDescription || null,
      textLayout: 'half', spreads: rerenderSpreads, tuning: p.tuning || null,
      identityKeyed: !!p.identityKeyed, seed: Number.isInteger(p.seed) ? p.seed : null, probeNonce: p.probeNonce || null,
      costTracker, forceRerender: false,
      onProgress: (f, m) => { touch(); onProgress(0.1 + f * 0.15, m); }, log,
    });
    if (art.unresolved && art.unresolved.length > 0 && !flags.shipOnExhaustion()) {
      throw new VideoError(`text-free start frames for spread(s) ${art.unresolved.map(u => u.spread).join(', ')} ended with unresolved defects`, 'consistency_unresolved', { unresolved: art.unresolved, bookBible: art.bookBible });
    }
    for (const r of art.results) {
      if (!r.buffer) throw new VideoError(`text-free start frame for spread ${r.spread} could not be rendered (${r.advisories.map(a => a.note).join('; ') || 'render failed'})`, 'render_failed');
      frames.set(`spread:${r.spread}`, { buffer: r.buffer, hash: contentHash(r.buffer), storageKey: r.storageKey, rerendered: true });
    }
  }
  for (const s of plan.segments) {
    if (s.kind === 'cover') {
      const still = await fetchStill(p.approvedCoverUrl, 'the approved cover');
      frames.set('cover', { ...still, storageKey: null, rerendered: false });
    } else if (!frames.has(`spread:${s.spread}`)) {
      const entry = bySpread.get(s.spread);
      const still = await fetchStill(entry.storageKey, `render of spread ${s.spread}`);
      frames.set(`spread:${s.spread}`, { ...still, storageKey: entry.storageKey, rerendered: false });
    }
  }
  const frameFor = (s) => frames.get(s.kind === 'cover' ? 'cover' : `spread:${s.spread}`);

  // ── Text gate ──────────────────────────────────────────────────────────
  onProgress(0.26, 'Checking the start frames for text...');
  const gateLimit = pLimit(4);
  const gates = await Promise.all(plan.segments.map(s => gateLimit(async () => ({ segment: s, verdict: await textGate(frameFor(s).buffer, { label: `videoTextGate:${bookId}:${s.kind}${s.spread || ''}`, costTracker }) }))));
  const textGateReport = [];
  let dropCover = false;
  for (const g of gates) {
    touch();
    const entry = { segment: g.segment.index, kind: g.segment.kind, spread: g.segment.spread, pass: g.verdict.pass };
    if (g.verdict.transcript) entry.transcript = g.verdict.transcript;
    if (g.verdict.unavailable) {
      entry.unavailable = g.verdict.unavailable;
      advisories.push({ stage: 'video', spread: g.segment.spread, note: `text gate unavailable for ${g.segment.kind}${g.segment.spread ? ` ${g.segment.spread}` : ''} (${g.verdict.unavailable}) — source is text-free by contract` });
    }
    textGateReport.push(entry);
    if (!g.verdict.pass) {
      if (g.segment.kind === 'cover') {
        dropCover = true;
        advisories.push({ stage: 'video', note: `cover_text_visible: the approved cover carries painted text ("${g.verdict.transcript || ''}") — the film opens on the first spread instead` });
      } else {
        throw new VideoError(`spread ${g.segment.spread} carries painted text ("${g.verdict.transcript || ''}") — a text-free film cannot use it; re-render the spread`, 'video_text_visible', { textGate: textGateReport });
      }
    }
  }
  if (dropCover) {
    plan = buildFilmPlan({ available: entries.map(e => e.spread), coverKind: null, emotionPlan, shotPlan, textLayout, ageBand });
    textGateReport.forEach(t => { t.segment = Math.max(0, t.segment - 1); });
  }

  // ── References (the identity kit as reference elements) ────────────────
  const base = videoBase(bookId);
  const aHash = anchorHash(characterRefUrl);
  const coverRefUrl = await stage(Buffer.from(refPhoto.base64, 'base64'), `${base}/refs/cover-${aHash}.${refPhoto.mimeType === 'image/png' ? 'png' : 'jpg'}`, refPhoto.mimeType || 'image/jpeg');
  const sheetRefUrl = await stage(Buffer.from(bible.sheet.base64, 'base64'), `${base}/refs/sheet-${bible.sheet.hash}.png`, bible.sheet.mimeType || 'image/png');
  const characterRef = { kind: 'character', urls: [coverRefUrl, sheetRefUrl], hash: `${aHash}+${bible.sheet.hash}` };
  let companionRef = null;
  if (bible.companion && bible.companion.base64) {
    const url = await stage(Buffer.from(bible.companion.base64, 'base64'), `${base}/refs/companion-${bible.companion.hash}.png`, bible.companion.mimeType || 'image/png');
    companionRef = { kind: 'companion', urls: [url], hash: bible.companion.hash };
  }
  const propRefs = new Map();
  for (const x of bible.props || []) {
    if (!x || !x.sheet || !x.sheet.base64) continue;
    const url = await stage(Buffer.from(x.sheet.base64, 'base64'), `${base}/refs/prop-${x.sheet.hash}.png`, x.sheet.mimeType || 'image/png');
    propRefs.set(normalizePropValue(x.value), { kind: 'prop', value: x.value, urls: [url], hash: x.sheet.hash, specText: x.sheet.specText || null, sheet: x.sheet });
  }

  // ── Briefs + QA inputs per segment ─────────────────────────────────────
  const evidence = story.personalization_evidence || [];
  const outfitSpec = bible.outfit ? bible.outfit.outfit : null;
  const companionDrawable = !!(theme.companion && theme.companion.name);
  const segmentInputs = plan.segments.map(s => {
    const beat = s.kind === 'spread' ? book.beats.find(b => b.spread === s.spread) : null;
    const companionOnSpread = !!(beat && companionDrawable && beatMentionsCompanion(beat, theme.companion));
    const declared = beat ? visualPropsForSpread(evidence, s.spread) : [];
    const carried = beat && flags.propContinuityEnabled() ? continuityPropsForSpread(evidence, s.spread) : [];
    const propValues = [...new Set([...declared, ...carried])];
    const references = [characterRef];
    if (companionOnSpread && companionRef) references.push(companionRef);
    const propRefList = [];
    for (const v of propValues) {
      const r = propRefs.get(normalizePropValue(v));
      if (r && !propRefList.includes(r)) propRefList.push(r);
    }
    references.push(...propRefList);
    const emotion = s.kind === 'spread' && emotionPlan && emotionPlan[s.spread] ? emotionPlan[s.spread] : null;
    const brief = buildClipBrief({
      segment: s, name: profile.name, beat: beat ? beat.beat : null,
      companion: companionOnSpread ? theme.companion : null,
      emotion, propValues, references, ageBand, theme,
    });
    const spreadText = s.kind === 'spread' ? (story.spreads.find(x => x.spread === s.spread) || {}).text || '' : '';
    const checks = {
      sheet: { base64: bible.sheet.base64, mimeType: bible.sheet.mimeType || 'image/png' },
      outfitSpec: beat && isModestBathWaterScene(`${beat.beat} ${spreadText}`) ? null : outfitSpec,
      props: propValues.map(v => {
        const r = propRefs.get(normalizePropValue(v));
        return { name: v, specText: r ? r.specText : null, sheet: r ? r.sheet : null, expected: declared.includes(v) ? 'required' : 'carried' };
      }),
      companion: companionOnSpread ? { name: theme.companion.name, type: theme.companion.type || null, sheet: bible.companion && bible.companion.base64 ? { base64: bible.companion.base64, mimeType: bible.companion.mimeType || 'image/png' } : null } : null,
      beat: beat ? beat.beat : null,
      emotion: emotion ? { ...emotion, cue: EMOTION_CUES[emotion.emotion] || null } : null,
    };
    return { segment: s, brief, checks, references };
  });

  // ── Film-level replay ─────────────────────────────────────────────────
  const planHash = fnv1a(JSON.stringify({
    v: VIDEO_VERSION, p: provider.provider, m: provider.model, a: aspect, u: music,
    s: segmentInputs.map(x => [x.segment.kind, x.segment.spread, frameFor(x.segment).hash, x.brief.hash, x.segment.seconds]),
  })).toString(36);
  const filmDir = `${base}/${planHash}`;
  const manifestKey = `${filmDir}/video.json`;
  const videoKey = `${filmDir}/video.mp4`;
  const posterKey = `${filmDir}/poster.jpg`;
  const bookBible = await summarizeBible(bible);
  if (!p.forceNew) {
    const manifest = await loadJson(manifestKey).catch(() => null);
    if (manifest && manifest.video && await objectExists(videoKey).catch(() => false)) {
      log('info', `film ${planHash} replays from ${videoKey}`);
      const url = await getSignedUrl(videoKey, SIGNED_URL_TTL_MS).catch(() => null);
      const posterUrl = await getSignedUrl(posterKey, SIGNED_URL_TTL_MS).catch(() => null);
      return {
        video: { ...manifest.video, url, posterUrl, cached: true },
        plan: manifest.plan, textGate: manifest.textGate || textGateReport, bookBible,
        unresolved: [], advisories: [...advisories, ...(manifest.advisories || [])], warnings,
        provider: provider.provider, model: provider.model, planHash,
      };
    }
  }

  // ── Prepared start frames → vendor URLs ────────────────────────────────
  onProgress(0.3, 'Preparing the start frames...');
  const prepared = new Map();
  for (const x of segmentInputs) {
    const f = frameFor(x.segment);
    const prep = await prepareStartFrame(f.buffer, aspect === '9:16' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 });
    const url = await stage(prep.buffer, `${base}/frames/${f.hash}-${aspect.replace(':', 'x')}.jpg`, 'image/jpeg');
    prepared.set(x.segment.index, { url, hash: f.hash, blurFilled: prep.blurFilled });
    touch();
  }

  // ── Per segment: candidates → verify → repair → promote ────────────────
  const n = flags.videoClipCandidates();
  const maxRepairs = flags.videoClipMaxRepairs();
  const secondsCap = flags.videoMaxClipSeconds();
  const limit = pLimit(CANDIDATE_CONCURRENCY);
  const tmp = await ffmpeg.makeTempDir(bookId);
  let generatedSeconds = 0;
  let finished = 0;
  const heartbeat = setInterval(() => { touch(); onProgress(0.3 + (finished / plan.segments.length) * 0.55, `Animating (${finished}/${plan.segments.length} segments done, ${generatedSeconds}s generated)...`); }, 30000);
  const results = [];
  try {
    onProgress(0.32, `Animating ${plan.segments.length} segments (${n} candidates each)...`);
    const perSegment = async (x) => {
      const s = x.segment;
      const label = `s${s.index}`;
      const startFrame = prepared.get(s.index);
      let brief = x.brief;
      const all = [];
      let best = null;
      let repairs = 0;
      let canonicalKey = null;
      let clipHash = null;

      // Replay a promoted clip whose marker still vouches for it.
      const probe = await generateCandidatesMeta(bookId, x, startFrame, provider, aspect);
      canonicalKey = probe.canonicalKey;
      clipHash = probe.clipHash;
      if (!p.forceNew) {
        const marker = await loadJson(`${canonicalKey}.qa.json`).catch(() => null);
        if (marker && marker.qaVersion === QA_VERSION && (marker.adminPicked || !marker.unresolved)) {
          const buffer = await downloadBuffer(canonicalKey).catch(() => null);
          if (buffer && buffer.length > 0 && contentHash(buffer) === marker.renderHash) {
            log('info', `${label}: promoted clip replays from ${canonicalKey}${marker.adminPicked ? ' (admin-picked)' : ''}`);
            finished += 1;
            return { segment: s, buffer, storageKey: canonicalKey, clipHash, score: marker.score ?? null, candidates: 0, repairs: 0, replayed: true, adminPicked: !!marker.adminPicked, blocking: marker.adminPicked ? [] : (marker.qa && marker.qa.blocking) || [], advisory: (marker.qa && marker.qa.advisory) || [], candidateFiles: [] };
          }
        }
      }

      for (let pass = 0; pass <= maxRepairs; pass++) {
        if (pass > 0) {
          const residual = residualBlocking(best);
          if (!best || residual.length === 0) break;
          brief = repairBrief(x.brief, residual);
          repairs += 1;
        }
        if (generatedSeconds + n * probe.seconds > secondsCap) {
          advisories.push({ stage: 'video', spread: s.spread, note: `${label}: the per-film generation budget (${secondsCap}s) leaves no room for ${pass > 0 ? 'another repair pass' : 'candidates'}` });
          break;
        }
        const gen = await generateCandidates({
          bookId, segment: s, brief, startFrame, references: x.references, provider, aspect, n, pass,
          seed: Number.isInteger(p.seed) ? p.seed : null, token: p.providerToken || null, costTracker,
          ctx: { touch, log, abortSignal: p.abortSignal }, limit, forceNew: !!p.forceNew,
          ...(p.pollIntervalMs ? { pollIntervalMs: p.pollIntervalMs } : {}),
        });
        if (pass === 0) { canonicalKey = gen.canonicalKey; clipHash = gen.clipHash; }
        generatedSeconds += gen.candidates.filter(c => c.status === 'done' && !c.cached).length * gen.seconds;
        const scored = [];
        for (const c of gen.candidates) {
          if (c.status !== 'done' || !c.buffer) {
            all.push({ k: c.k, pass, storageKey: c.storageKey, status: c.status, error: c.error, reasons: c.reasons || null, score: null });
            if (c.status === 'filtered') advisories.push({ stage: 'video', spread: s.spread, note: `${label}: candidate ${c.k}${pass > 0 ? ` (repair ${pass})` : ''} refused by the vendor's moderation (${c.error || 'no reason given'})` });
            continue;
          }
          const v = await verifyClip({ buffer: c.buffer, dir: tmp, label: `${label}-p${pass}c${c.k}`, segment: s, brief, checks: x.checks, costTracker, log });
          const cand = { k: c.k, pass, storageKey: c.storageKey, buffer: c.buffer, status: 'done', qa: { pass: v.pass, blocking: v.blocking, advisory: v.advisory, ...(v.qaUnavailable ? { qaUnavailable: v.qaUnavailable } : {}) }, score: v.score, verdict: v, providerJobId: c.providerJobId };
          scored.push(cand);
          all.push({ k: c.k, pass, storageKey: c.storageKey, status: 'done', error: null, score: v.score, blocking: v.blocking, advisory: v.advisory, qaUnavailable: v.qaUnavailable || null });
          touch();
        }
        const passBest = pickBest(scored);
        if (passBest && (!best || compareCandidates(passBest, best) > 0)) best = passBest;
        log('info', `${label}: pass ${pass} → ${scored.length} verified, best score ${best ? best.score : 'none'}${best && best.qa.blocking.length ? ` (blocking: ${best.qa.blocking.join(' | ')})` : ''}`);
        if (best && best.qa && !best.qa.qaUnavailable && best.qa.blocking.length === 0) break;
        if (best && best.qa && best.qa.qaUnavailable) break; // an unchecked clip cannot steer a repair
      }
      finished += 1;
      if (!best) {
        const filtered = all.filter(c => c.status === 'filtered');
        if (filtered.length > 0 && filtered.length === all.length) {
          return { segment: s, buffer: null, storageKey: canonicalKey, clipHash, score: null, candidates: all.length, repairs, blocking: [`vendor moderation refused every candidate (${filtered[0].error || 'no reason given'})`], advisory: [], candidateFiles: [], unresolvedReason: 'filtered' };
        }
        throw new VideoError(`${label}: no candidate clip came back from ${provider.provider} (${all.map(c => c.error).filter(Boolean).slice(0, 2).join('; ') || 'no output'})`, 'video_provider_unavailable');
      }
      // Promote the best candidate to the canonical key + marker.
      const blocking = best.qa.blocking || [];
      const unresolved = blocking.length > 0;
      const renderHash = contentHash(best.buffer);
      await uploadBuffer(best.buffer, canonicalKey, 'video/mp4');
      await uploadBuffer(Buffer.from(JSON.stringify({
        qaVersion: QA_VERSION, clipHash, renderHash, score: best.score,
        qa: { blocking, advisory: best.qa.advisory || [], qaUnavailable: best.qa.qaUnavailable || null },
        briefHash: brief.hash, baseBriefHash: x.brief.hash, provider: provider.provider, model: provider.model,
        providerJobId: best.providerJobId || null, candidate: best.storageKey, pass: best.pass, unresolved,
        checkedAt: new Date().toISOString(),
      })), `${canonicalKey}.qa.json`, 'application/json');
      for (const a of best.qa.advisory || []) advisories.push({ stage: 'video', spread: s.spread, note: `${label}: ${a}` });
      if (best.qa.qaUnavailable) advisories.push({ stage: 'video', spread: s.spread, note: `${label}: shipped UNCHECKED (${best.qa.qaUnavailable})` });
      return { segment: s, buffer: best.buffer, storageKey: canonicalKey, clipHash, score: best.score, candidates: all.length, repairs, blocking, advisory: best.qa.advisory || [], candidateFiles: all.filter(c => c.status === 'done').map(c => ({ storageKey: c.storageKey, score: c.score })) };
    };
    const segLimit = pLimit(plan.segments.length);
    results.push(...await Promise.all(segmentInputs.map(x => segLimit(() => perSegment(x)))));
  } finally {
    clearInterval(heartbeat);
  }

  // ── Ship policy ────────────────────────────────────────────────────────
  const unresolved = [];
  for (const r of results) {
    if (r.blocking && r.blocking.length > 0) {
      const candidates = [];
      for (const c of r.candidateFiles || []) {
        let url = null;
        try { url = await getSignedUrl(c.storageKey, SIGNED_URL_TTL_MS); } catch { url = null; }
        candidates.push({ storageKey: c.storageKey, url, score: c.score });
      }
      unresolved.push({ segment: r.segment.index, spread: r.segment.spread, defects: r.blocking, candidates });
    }
  }
  const planReport = results.map(r => ({
    index: r.segment.index, kind: r.segment.kind, spread: r.segment.spread, seconds: r.segment.seconds, motion: r.segment.motion,
    startFrame: { storageKey: frameFor(r.segment).storageKey, renderHash: frameFor(r.segment).hash, rerendered: !!frameFor(r.segment).rerendered, blurFilled: !!(prepared.get(r.segment.index) || {}).blurFilled },
    clip: r.buffer ? { storageKey: r.storageKey, hash: r.clipHash, score: r.score, candidates: r.candidates, repairs: r.repairs, replayed: !!r.replayed, adminPicked: !!r.adminPicked } : null,
  }));
  if (unresolved.length > 0 && !flags.videoShipOnExhaustion()) {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw new VideoError(`${unresolved.length} segment(s) could not be animated to the book's standard: ${unresolved.map(u => `s${u.segment}${u.spread ? ` (spread ${u.spread})` : ''}: ${u.defects.join(' | ')}`).join('; ')}`, 'video_unresolved', { unresolved, plan: planReport, textGate: textGateReport, bookBible, advisories, warnings, provider: provider.provider, model: provider.model });
  }
  if (unresolved.length > 0) {
    advisories.push({ stage: 'shipPolicy', note: `stitched ${unresolved.length} segment(s) with BLOCKING residual defects (CATALOG_VIDEO_SHIP_ON_EXHAUSTION=1): ${unresolved.map(u => `s${u.segment}`).join(', ')}` });
  }
  if (results.some(r => !r.buffer)) {
    throw new VideoError('a segment has no clip to stitch', 'video_provider_unavailable');
  }

  // ── Stitch ─────────────────────────────────────────────────────────────
  onProgress(0.88, 'Stitching the film...');
  let video;
  try {
    const clipFiles = [];
    for (const r of results) {
      const file = path.join(tmp, `seg-${r.segment.index}.mp4`);
      await fs.promises.writeFile(file, r.buffer);
      clipFiles.push({ path: file, seconds: r.segment.seconds });
    }
    const output = path.join(tmp, 'video.mp4');
    const poster = path.join(tmp, 'poster.jpg');
    const musicPath = musicPathFor(music);
    if (music !== 'none' && !musicPath) advisories.push({ stage: 'video', note: `music bed '${music}' is not bundled — the film ships with a silent track` });
    const portrait = aspect === '9:16';
    const stitch = ffmpeg.buildStitchCommand({ segments: clipFiles, output, width: portrait ? 1080 : 1920, height: portrait ? 1920 : 1080, fps: 30, fadeSeconds: plan.fadeSeconds, xfadeSeconds: plan.xfadeSeconds, musicPath });
    await ffmpeg.runFfmpeg(stitch.args, { timeoutMs: 600000 });
    touch();
    await ffmpeg.runFfmpeg(ffmpeg.buildPosterCommand({ input: output, timeSeconds: 1.2, output: poster }), { timeoutMs: 60000 });
    const probe = await ffmpeg.probeVideo(output);
    const videoBuffer = await fs.promises.readFile(output);
    const posterBuffer = await fs.promises.readFile(poster);
    onProgress(0.95, 'Uploading the film...');
    const url = await uploadBuffer(videoBuffer, videoKey, 'video/mp4');
    const posterUrl = await uploadBuffer(posterBuffer, posterKey, 'image/jpeg');
    video = {
      url, storageKey: videoKey, posterUrl, posterKey,
      hash: contentHash(videoBuffer), version: VIDEO_VERSION,
      durationSeconds: probe.durationSeconds ?? stitch.totalSeconds, width: probe.width || (portrait ? 1080 : 1920), height: probe.height || (portrait ? 1920 : 1080), fps: probe.fps || 30,
      bytes: videoBuffer.length, music: musicPath ? music : 'none', cached: false,
    };
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  const manifest = {
    videoVersion: VIDEO_VERSION, planHash, provider: provider.provider, model: provider.model, aspect, music,
    video: { ...video, url: undefined, posterUrl: undefined }, plan: planReport, textGate: textGateReport, unresolved, advisories,
    bibleHash: bible.hash, generatedSeconds, createdAt: new Date().toISOString(),
  };
  try { await saveJson(manifest, manifestKey); } catch (err) { log('warn', `film manifest write failed (${err.message})`); }
  onProgress(1, 'Film ready');
  return { video, plan: planReport, textGate: textGateReport, bookBible, unresolved, advisories, warnings, provider: provider.provider, model: provider.model, planHash };
}

/**
 * The canonical clip key + hash a segment WOULD get (without generating) —
 * the replay probe shares generate.js's identity so a promoted clip is
 * found before any vendor call.
 */
async function generateCandidatesMeta(bookId, x, startFrame, provider, aspect) {
  const { clipHashFor, clipKey } = require('./generate');
  const { clipSecondsFor } = require('./providers/models');
  const seconds = clipSecondsFor(x.segment.requestedSeconds, provider.profile.durations);
  const clipHash = clipHashFor({ provider: provider.provider, model: provider.model, briefHash: x.brief.hash, startFrameHash: startFrame.hash, referenceHashes: x.references.map(r => r.hash), seconds, aspect });
  return { clipHash, canonicalKey: clipKey(bookId, x.segment.index, clipHash), seconds };
}

module.exports = { generateGiftVideo, VideoError, musicPathFor };
