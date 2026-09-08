/**
 * The gift video (gv-2 — docs/GIFT_VIDEO_PLAN.md, revision 4): a 10-second,
 * text-free, FULLY ANIMATED film of one book as ONE continuous take — the
 * child advancing through the book's best illustrations while the camera
 * angle changes along the way — built from the exact shipped renders and
 * the Book Bible, verified against the character sheet, selected among
 * candidates, repaired within a bounded budget, and failed closed
 * (`video_unresolved` with the scored candidates attached) rather than
 * degraded.
 *
 * Order of work: resolve provider → anchor + bible → STILL SELECTION (every
 * render judged once, the best `CATALOG_VIDEO_SCENES` picked in story
 * order; an embedded book re-renders its arc trio text-free instead) →
 * plan (one segment, one act per picked still) → film-level replay check
 * → references + the journey brief → candidates → verify → repair →
 * promote → stitch → upload → manifest.
 */

const path = require('path');
const fs = require('fs');
const pLimit = require('p-limit');
const { downloadPhotoAsBase64 } = require('../../illustrationGenerator');
const { downloadBuffer, uploadBuffer, getSignedUrl, objectExists, loadJson, saveJson } = require('../../gcsStorage');
const { renderStorySpreads, storyFingerprint } = require('../illustrator');
const { buildBookBible, summarizeBible, anchorHash } = require('../illustrator/bible');
const { buildShotPlan } = require('../illustrator/shotPlan');
const { visualPropsForSpread, continuityPropsForSpread, companionOnSpread } = require('../illustrator/scenes');
const { isModestBathWaterScene } = require('../../illustrationGenerator');
const { pickBest, compareCandidates, residualBlocking } = require('../illustrator/select');
const { EMOTION_CUES } = require('../illustrator/emotionPlan');
const { normalizePropValue } = require('../illustrator/bible/propSheet');
const { QA_VERSION, VIDEO_VERSION } = require('../versions');
const { fnv1a } = require('../selection');
const flags = require('../flags');
const { buildFilmPlan, pickStorySpreads, alternateSpread } = require('./plan');
const { buildJourneyBrief, repairBrief } = require('./brief');
const { validateRenders, fetchStill, prepareStartFrame, contentHash } = require('./stills');
const { judgeStill, rankStills } = require('./stillSelect');
const { resolveProvider } = require('./providers');
const { imageBudget } = require('./providers/models');
const { keepWithinBudget } = require('./filmReferences');
const { generateCandidates, videoBase } = require('./generate');
const { verifyClip } = require('./verify');
const ffmpeg = require('./ffmpeg');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CANDIDATE_CONCURRENCY = 4;
const JUDGE_CONCURRENCY = 4;

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
 * Judge one still, replaying a pinned verdict for the same pixels under
 * the same checker (`stills/{renderHash}.json` beside the clips) so a
 * re-dispatch never re-spends the judge and always ranks the same way.
 * @param {object} p
 * @returns {Promise<{spread: number, verdict: object|null, unavailable: string|null}>}
 */
async function judgeStillPinned({ bookId, spread, buffer, hash, forceNew, costTracker, log }) {
  const key = `${videoBase(bookId)}/stills/${hash}.json`;
  if (!forceNew) {
    const pinned = await loadJson(key).catch(() => null);
    if (pinned && pinned.qaVersion === QA_VERSION && pinned.verdict && typeof pinned.verdict === 'object') {
      return { spread, verdict: pinned.verdict, unavailable: null };
    }
  }
  const j = await judgeStill(buffer, { label: `videoStillJudge:${bookId}:s${spread}`, costTracker });
  if (j.verdict) {
    try { await saveJson({ qaVersion: QA_VERSION, spread, renderHash: hash, verdict: j.verdict, judgedAt: new Date().toISOString() }, key); } catch (err) { log('warn', `still verdict pin failed for spread ${spread} (${err.message})`); }
  }
  return { spread, verdict: j.verdict, unavailable: j.unavailable || null };
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
 * @returns {Promise<object>} the callback body fields (video, plan, stills, textGate, bookBible, unresolved, advisories, warnings)
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
  const bySpread = new Map(entries.map(e => [e.spread, e]));

  // ── Anchor + Book Bible (the identity kit the take references) ─────────
  const characterRefUrl = p.approvedCoverUrl || p.childPhotoUrl || null;
  if (!characterRefUrl) throw new VideoError('no approved cover and no child photo — the clip would have no identity reference', 'missing_identity_reference');
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
    // The sheet is the identity reference of the take: without one the
    // film would animate an unpinned child. (CATALOG_SHEET_REQUIRED=0 lets
    // renders proceed sheet-less; the film does not.)
    throw new VideoError('no character model sheet is available for this anchor — the clip would have no identity reference', 'identity_kit_failed');
  }

  // ── Pinned plans ───────────────────────────────────────────────────────
  const baseHash = storyFingerprint(story);
  const shotPlan = flags.shotPlanEnabled()
    ? buildShotPlan({ seedBasis: baseHash, spreads: book.beats.map(b => b.spread), ageBand, textLayout })
    : null;
  const emotionPlan = bible.emotion ? bible.emotion.plan : null;

  // ── Still selection: pick the best illustrations FIRST ─────────────────
  const sceneCount = flags.videoSceneCount();
  const frames = new Map(); // spread → {buffer, hash, storageKey, rerendered}
  const stillReport = [];
  const judgeLimit = pLimit(JUDGE_CONCURRENCY);
  const judgeAll = (spreads) => Promise.all(spreads.map(spread => judgeLimit(async () => {
    const f = frames.get(spread);
    const r = await judgeStillPinned({ bookId, spread, buffer: f.buffer, hash: f.hash, forceNew: !!p.forceNew, costTracker, log });
    touch();
    return r;
  })));
  let picked = [];
  const selectable = entries.filter(e => !e.embedded);
  if (selectable.length > 0) {
    onProgress(0.08, `Judging ${selectable.length} illustrations for the film...`);
    for (const e of selectable) {
      const still = await fetchStill(e.storageKey, `render of spread ${e.spread}`);
      frames.set(e.spread, { ...still, storageKey: e.storageKey, rerendered: false });
    }
    const judged = await judgeAll(selectable.map(e => e.spread));
    const ranked = rankStills(judged, { count: sceneCount });
    picked = ranked.picked;
    const unavailable = new Map(judged.map(j => [j.spread, j.unavailable]));
    for (const r of ranked.report) stillReport.push({ ...r, storageKey: bySpread.get(r.spread).storageKey, rerendered: false, unavailable: unavailable.get(r.spread) || null });
    const unchecked = ranked.report.filter(r => r.unchecked).length;
    if (unchecked > 0) advisories.push({ stage: 'video', note: `still judge unavailable for ${unchecked} render(s) (${[...new Set(judged.map(j => j.unavailable).filter(Boolean))].join('; ')}) — ranked as unchecked` });
    log('info', `still selection: picked ${picked.join(', ') || 'none'} of ${selectable.map(e => e.spread).join(', ')} (${ranked.report.map(r => `s${r.spread}=${r.score}${r.disqualified ? 'x' : ''}`).join(' ')})`);
  }
  const embedded = entries.filter(e => e.embedded);
  if (picked.length === 0 && embedded.length > 0) {
    // An embedded book paints its story text INTO every render: there are
    // no text-free stills to choose from, so the story-arc trio is
    // re-rendered text-free through the production path (the gv-1 rule)
    // and gated afterwards.
    //
    // The gate is RECOVERABLE (2026-09-07, dispatch gv_1788803092138): a
    // "text-free" re-render can still carry in-world lettering the beat
    // invites — a moon map labelled "CRATER 1 CRATER 2" — and since #297
    // the illustrator SHIPS such a spread with its blocking 'painted text'
    // finding on record instead of failing it. The film then failed
    // `video_text_visible` on the first hit, and a re-dispatch replayed the
    // same cached lettered render from its `wide-plain` key for ever. Now a
    // rejected start frame first re-renders FRESH (the cached bytes are the
    // defect), then the nearest untried spread substitutes for its role,
    // within `CATALOG_VIDEO_TEXT_GATE_RETRIES` extra renders; the run fails
    // only when the budget is spent with lettering still on the frame.
    const embeddedSpreads = embedded.map(e => e.spread);
    const arc = pickStorySpreads(embeddedSpreads, emotionPlan).spreads.slice(0, sceneCount);
    advisories.push({ stage: 'video', note: `embedded renders carry painted text — spread(s) ${arc.join(', ')} (the story arc) were re-rendered text-free instead of being chosen by the still gate` });
    log('info', `re-rendering ${arc.length} embedded spread(s) text-free for the film: ${arc.join(', ')}`);
    onProgress(0.1, `Rendering text-free start frames (${arc.length})...`);
    const textBlocking = new Map(); // spread → the illustrator's own painted-text finding
    const renderTextFree = async (spreads, fresh) => {
      const art = await renderStorySpreads({
        bookId, story, bookDef, profile,
        approvedCoverUrl: p.approvedCoverUrl, childPhotoUrl: p.childPhotoUrl || null, characterDescription: p.characterDescription || null,
        textLayout: 'half', spreads, rerenderSpreads: fresh ? spreads : null, tuning: p.tuning || null,
        identityKeyed: !!p.identityKeyed, seed: Number.isInteger(p.seed) ? p.seed : null, probeNonce: p.probeNonce || null,
        costTracker, forceRerender: false,
        onProgress: (f, m) => { touch(); onProgress(0.1 + f * 0.15, m); }, log,
      });
      if (art.unresolved && art.unresolved.length > 0 && !flags.shipOnExhaustion()) {
        throw new VideoError(`text-free start frames for spread(s) ${art.unresolved.map(u => u.spread).join(', ')} ended with unresolved defects`, 'consistency_unresolved', { unresolved: art.unresolved, bookBible: art.bookBible });
      }
      for (const r of art.results) {
        if (!r.buffer) throw new VideoError(`text-free start frame for spread ${r.spread} could not be rendered (${r.advisories.map(a => a.note).join('; ') || 'render failed'})`, 'render_failed');
        frames.set(r.spread, { buffer: r.buffer, hash: contentHash(r.buffer), storageKey: r.storageKey, rerendered: true });
        // The illustrator's OWN verdict: a spread shipped on exhaustion with
        // 'painted text in the illustration' on record is lettered whatever
        // the still judge says (and a judge outage must never pass it).
        const painted = (Array.isArray(r.blocking) ? r.blocking : []).find(d => /^painted text/.test(d));
        if (painted) textBlocking.set(r.spread, painted); else textBlocking.delete(r.spread);
      }
      return art;
    };
    const isTextual = (j) => (j.verdict && j.verdict.textPresent) || textBlocking.has(j.spread);
    const transcriptOf = (j) => (j.verdict && j.verdict.transcript) || textBlocking.get(j.spread) || '';
    await renderTextFree(arc, false);
    const judgedAll = await judgeAll(arc.filter(s => frames.has(s)));
    const tried = new Set(arc);
    const retried = new Set();
    const pending = judgedAll.filter(isTextual).map(j => j.spread);
    const textGateLog = []; // every lettered attempt, for the failure payload
    for (const j of judgedAll) if (isTextual(j)) textGateLog.push({ segment: 0, kind: 'spread', spread: j.spread, pass: false, transcript: transcriptOf(j) || undefined });
    let retries = flags.videoTextGateRetries();
    while (pending.length > 0 && retries > 0) {
      const failed = pending[0];
      let target;
      let fresh;
      if (!retried.has(failed)) {
        // First the same spread, rendered fresh: the cached render is the
        // lettered one, and a replay would return it unchanged.
        target = failed; fresh = true; retried.add(failed);
      } else {
        target = alternateSpread(failed, embeddedSpreads, tried);
        if (target === null) break; // nothing left to substitute for this role
        fresh = false; tried.add(target);
      }
      retries -= 1;
      log('info', `text gate: spread ${failed} carries painted text — ${fresh ? `re-rendering spread ${target} fresh` : `substituting spread ${target}`} (${retries} retr${retries === 1 ? 'y' : 'ies'} left)`);
      onProgress(0.2, fresh ? `Re-rendering spread ${target} without lettering...` : `Rendering spread ${target} as a substitute start frame...`);
      await renderTextFree([target], fresh);
      const [j] = await judgeAll([target]);
      const idx = judgedAll.findIndex(x => x.spread === target);
      if (idx >= 0) judgedAll[idx] = j; else judgedAll.push(j);
      if (isTextual(j)) {
        textGateLog.push({ segment: 0, kind: 'spread', spread: target, pass: false, transcript: transcriptOf(j) || undefined });
        continue; // `failed` stays pending: next pass substitutes (or moves on)
      }
      pending.shift();
      advisories.push({ stage: 'video', spread: target, note: fresh
        ? `text gate: spread ${target} re-rendered fresh after its cached text-free render carried painted text`
        : `text gate: spread ${target} stands in for spread ${failed}, whose text-free renders kept carrying painted text` });
    }
    if (pending.length > 0) {
      const worst = textGateLog[textGateLog.length - 1];
      throw new VideoError(`spread ${worst.spread} still carries painted text after the text-free re-render ("${worst.transcript || ''}") — a text-free film cannot use it (${textGateLog.length} lettered render(s): ${textGateLog.map(t => `s${t.spread}`).join(', ')}; ${flags.videoTextGateRetries() === 0 ? 'CATALOG_VIDEO_TEXT_GATE_RETRIES=0' : 'the retry budget is spent'})`, 'video_text_visible', { textGate: textGateLog });
    }
    const ranked = rankStills(judgedAll, { count: arc.length });
    picked = ranked.picked;
    const unavailable = new Map(judgedAll.map(j => [j.spread, j.unavailable]));
    for (const r of ranked.report) stillReport.push({ ...r, storageKey: frames.get(r.spread).storageKey, rerendered: true, unavailable: unavailable.get(r.spread) || null });
  }
  if (picked.length === 0) {
    const allText = stillReport.length > 0 && stillReport.every(r => r.disqualified && r.reasons.some(x => /^painted text/.test(x)));
    throw new VideoError(
      allText
        ? 'every render carries painted text — a text-free film cannot use them; re-render the spreads'
        : `no illustration reads as a complete, text-free picture (${stillReport.map(r => `s${r.spread}: ${r.reasons.join(', ') || 'disqualified'}`).join('; ') || 'nothing to judge'})`,
      allText ? 'video_text_visible' : 'video_no_sources',
      { stills: stillReport },
    );
  }
  for (const r of stillReport) if (r.picked && r.reasons.length > 0) advisories.push({ stage: 'video', spread: r.spread, note: `picked still: ${r.reasons.join(', ')}` });
  const textGateReport = picked.map(spread => {
    const r = stillReport.find(x => x.spread === spread);
    const entry = { segment: 0, kind: 'spread', spread, pass: true };
    if (r && r.unchecked) {
      entry.unavailable = r.unavailable || 'still judge unavailable';
      advisories.push({ stage: 'video', spread, note: `text gate unavailable for spread ${spread} (${entry.unavailable}) — source is text-free by contract` });
    }
    return entry;
  });

  // ── Plan: one take, one act per picked still ───────────────────────────
  const plan = buildFilmPlan({ scenes: picked, emotionPlan, shotPlan, ageBand });
  if (plan.segments.length === 0) throw new VideoError('no usable spreads for the film', 'video_no_sources', { stills: stillReport });
  const segment = plan.segments[0];
  const startFrame = frames.get(segment.acts[0].spread);
  const endFrameEligible = segment.acts.length > 1 && !!provider.profile.supportsEndFrame && flags.videoEndFrameEnabled();
  const endFrame = endFrameEligible ? frames.get(segment.acts[segment.acts.length - 1].spread) : null;
  if (segment.acts.length > 1 && !endFrame) advisories.push({ stage: 'video', note: `the take carries no end frame (${provider.profile.supportsEndFrame ? 'CATALOG_VIDEO_END_FRAME=0' : `${provider.model} takes none`}) — the last moment is described in the brief only` });

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

  // ── The journey brief + QA inputs per act ──────────────────────────────
  const evidence = story.personalization_evidence || [];
  const outfitSpec = bible.outfit ? bible.outfit.outfit : null;
  const companionDrawable = !!(theme.companion && theme.companion.name);
  const companionCheck = companionDrawable
    ? { name: theme.companion.name, type: theme.companion.type || null, sheet: bible.companion && bible.companion.base64 ? { base64: bible.companion.base64, mimeType: bible.companion.mimeType || 'image/png' } : null, specText: bible.companion ? bible.companion.specText || null : null, human: bible.companion ? !!bible.companion.human : undefined }
    : null;
  const actContents = segment.acts.map(a => {
    const beat = book.beats.find(b => b.spread === a.spread) || null;
    const spreadText = (story.spreads.find(x => x.spread === a.spread) || {}).text || '';
    // ce-11 signal (beat OR manuscript names the companion) — the act
    // carries the companion on the same spreads the book does.
    const companionPresent = !!(beat && companionDrawable && companionOnSpread(beat, spreadText, theme.companion, { theme, childName: profile?.name }));
    const declared = beat ? visualPropsForSpread(evidence, a.spread) : [];
    const carried = beat && flags.propContinuityEnabled() ? continuityPropsForSpread(evidence, a.spread) : [];
    const emotion = a.emotion || null;
    return {
      spread: a.spread,
      beat: beat ? beat.beat : null,
      emotion,
      companion: companionPresent ? theme.companion : null,
      propValues: [...new Set([...declared, ...carried])],
      declared,
      bathWater: !!beat && isModestBathWaterScene(`${beat.beat} ${spreadText}`),
    };
  });
  const kit = [characterRef];
  if (companionRef && actContents.some(a => a.companion)) kit.push(companionRef);
  const propValues = [...new Set(actContents.flatMap(a => a.propValues))];
  const declaredValues = new Set(actContents.flatMap(a => a.declared));
  for (const v of propValues) {
    const r = propRefs.get(normalizePropValue(v));
    if (r && !kit.includes(r)) kit.push(r);
  }
  // The vendor counts the start and end frames toward its picture limit
  // (Kling: seven, error 1201), so the kit is held to what the frames
  // leave — the child, the companion, the acts' declared props, then the
  // carried ones; an omitted reference rides as an advisory, never a
  // rejected request (the start frame already shows the prop).
  const budget = imageBudget(provider.profile, { startFrame: true, endFrame: !!endFrame });
  const kept = keepWithinBudget(kit, budget.references, r => (r.kind === 'character' ? 0 : r.kind === 'companion' ? 1 : declaredValues.has(r.value) ? 2 : 3));
  const references = kept.kept;
  if (kept.omitted.length) {
    advisories.push({ stage: 'video', note: `${provider.model} accepts at most ${budget.limit} images per request (start frame, end frame and references together): the take attaches ${references.length} of ${kit.length} references — omitted: ${kept.omitted.map(r => r.value || r.kind).join(', ')} (the start frame shows them; CATALOG_VIDEO_MAX_IMAGES adjusts the limit)` });
    log('warn', `references held to ${provider.model}'s ${budget.limit}-image limit: omitted ${kept.omitted.map(r => r.value || r.kind).join(', ')}`);
  }
  const brief = buildJourneyBrief({ segment, name: profile.name, acts: actContents, references, theme, ageBand, endFrame: !!endFrame });
  const checks = {
    sheet: { base64: bible.sheet.base64, mimeType: bible.sheet.mimeType || 'image/png' },
    outfitSpec,
    props: propValues.map(v => {
      const r = propRefs.get(normalizePropValue(v));
      return { name: v, specText: r ? r.specText : null, sheet: r ? r.sheet : null, expected: declaredValues.has(v) ? 'required' : 'carried' };
    }),
    acts: segment.acts.map((a, i) => ({
      index: a.index, from: a.from, to: a.to, spread: a.spread,
      beat: actContents[i].beat,
      emotion: actContents[i].emotion ? { ...actContents[i].emotion, cue: EMOTION_CUES[actContents[i].emotion.emotion] || null } : null,
      companion: actContents[i].companion ? companionCheck : null,
      outfitSpec: actContents[i].bathWater ? null : outfitSpec,
    })),
  };

  // ── Film-level replay ─────────────────────────────────────────────────
  const planHash = fnv1a(JSON.stringify({
    v: VIDEO_VERSION, p: provider.provider, m: provider.model, a: aspect, u: music,
    s: segment.acts.map(a => a.spread), f: startFrame.hash, e: endFrame ? endFrame.hash : null, b: brief.hash, d: segment.seconds,
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
        plan: manifest.plan, stills: stillReport, textGate: manifest.textGate || textGateReport, bookBible,
        unresolved: [], advisories: [...advisories, ...(manifest.advisories || [])], warnings,
        provider: provider.provider, model: provider.model, planHash,
      };
    }
  }

  // ── Prepared frames → vendor URLs ──────────────────────────────────────
  onProgress(0.3, 'Preparing the start and end frames...');
  const frameSize = aspect === '9:16' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
  const prepareFor = async (f) => {
    const prep = await prepareStartFrame(f.buffer, frameSize);
    const url = await stage(prep.buffer, `${base}/frames/${f.hash}-${aspect.replace(':', 'x')}.jpg`, 'image/jpeg');
    touch();
    return { url, hash: f.hash, blurFilled: prep.blurFilled };
  };
  const preparedStart = await prepareFor(startFrame);
  const preparedEnd = endFrame ? await prepareFor(endFrame) : null;

  // ── The take: candidates → verify → repair → promote ───────────────────
  const n = flags.videoClipCandidates();
  const maxRepairs = flags.videoClipMaxRepairs();
  const secondsCap = flags.videoMaxClipSeconds();
  const limit = pLimit(CANDIDATE_CONCURRENCY);
  const tmp = await ffmpeg.makeTempDir(bookId);
  let generatedSeconds = 0;
  const heartbeat = setInterval(() => { touch(); onProgress(0.35, `Animating the take (${generatedSeconds}s generated)...`); }, 30000);
  let result;
  try {
    onProgress(0.32, `Animating one ${segment.seconds}s take through spreads ${segment.spreads.join(', ')} (${n} candidate${n === 1 ? '' : 's'})...`);
    const s = segment;
    const label = `s${s.index}`;
    const x = { segment: s, brief, checks, references };
    let activeBrief = brief;
    const all = [];
    let best = null;
    let repairs = 0;
    let replayed = null;

    // Replay a promoted clip whose marker still vouches for it.
    const probe = await generateCandidatesMeta(bookId, x, preparedStart, preparedEnd, provider, aspect);
    const { canonicalKey, clipHash } = probe;
    if (!p.forceNew) {
      const marker = await loadJson(`${canonicalKey}.qa.json`).catch(() => null);
      if (marker && marker.qaVersion === QA_VERSION && (marker.adminPicked || !marker.unresolved)) {
        const buffer = await downloadBuffer(canonicalKey).catch(() => null);
        if (buffer && buffer.length > 0 && contentHash(buffer) === marker.renderHash) {
          log('info', `${label}: promoted clip replays from ${canonicalKey}${marker.adminPicked ? ' (admin-picked)' : ''}`);
          replayed = { segment: s, buffer, storageKey: canonicalKey, clipHash, score: marker.score ?? null, candidates: 0, repairs: 0, replayed: true, adminPicked: !!marker.adminPicked, blocking: marker.adminPicked ? [] : (marker.qa && marker.qa.blocking) || [], advisory: (marker.qa && marker.qa.advisory) || [], candidateFiles: [] };
        }
      }
    }
    if (replayed) {
      result = replayed;
    } else {
      let endFrameDropped = false;
      for (let pass = 0; pass <= maxRepairs; pass++) {
        if (pass > 0) {
          const residual = residualBlocking(best);
          if (!best || residual.length === 0) break;
          activeBrief = repairBrief(brief, residual);
          repairs += 1;
        }
        if (generatedSeconds + n * probe.seconds > secondsCap) {
          advisories.push({ stage: 'video', note: `${label}: the per-film generation budget (${secondsCap}s) leaves no room for ${pass > 0 ? 'another repair pass' : 'candidates'}` });
          break;
        }
        const gen = await generateCandidates({
          bookId, segment: s, brief: activeBrief, startFrame: preparedStart, endFrame: preparedEnd, references, provider, aspect, n, pass,
          seed: Number.isInteger(p.seed) ? p.seed : null, token: p.providerToken || null, costTracker,
          ctx: { touch, log, abortSignal: p.abortSignal }, limit, forceNew: !!p.forceNew,
          clipHash, canonicalKey,
          ...(p.pollIntervalMs ? { pollIntervalMs: p.pollIntervalMs } : {}),
        });
        generatedSeconds += gen.candidates.filter(c => c.status === 'done' && !c.cached).length * gen.seconds;
        if (gen.candidates.some(c => c.endFrameDropped)) endFrameDropped = true;
        const scored = [];
        for (const c of gen.candidates) {
          if (c.status !== 'done' || !c.buffer) {
            all.push({ k: c.k, pass, storageKey: c.storageKey, status: c.status, error: c.error, reasons: c.reasons || null, score: null });
            if (c.status === 'filtered') advisories.push({ stage: 'video', note: `${label}: candidate ${c.k}${pass > 0 ? ` (repair ${pass})` : ''} refused by the vendor's moderation (${c.error || 'no reason given'})` });
            continue;
          }
          const v = await verifyClip({ buffer: c.buffer, dir: tmp, label: `${label}-p${pass}c${c.k}`, segment: s, brief: activeBrief, checks, costTracker, log });
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
      if (endFrameDropped) advisories.push({ stage: 'video', note: `${label}: ${provider.model} rejected the end-frame field — the take was generated from the start frame and the brief alone (set CATALOG_VIDEO_MODEL_INPUT_JSON to rename it, or CATALOG_VIDEO_END_FRAME=0)` });
      if (!best) {
        const filtered = all.filter(c => c.status === 'filtered');
        if (filtered.length > 0 && filtered.length === all.length) {
          result = { segment: s, buffer: null, storageKey: canonicalKey, clipHash, score: null, candidates: all.length, repairs, blocking: [`vendor moderation refused every candidate (${filtered[0].error || 'no reason given'})`], advisory: [], candidateFiles: [], unresolvedReason: 'filtered' };
        } else {
          throw new VideoError(`${label}: no candidate clip came back from ${provider.provider} (${all.map(c => c.error).filter(Boolean).slice(0, 2).join('; ') || 'no output'})`, 'video_provider_unavailable', { stills: stillReport });
        }
      } else {
        // Promote the best candidate to the canonical key + marker.
        const blocking = best.qa.blocking || [];
        const unresolved = blocking.length > 0;
        const renderHash = contentHash(best.buffer);
        await uploadBuffer(best.buffer, canonicalKey, 'video/mp4');
        await uploadBuffer(Buffer.from(JSON.stringify({
          qaVersion: QA_VERSION, clipHash, renderHash, score: best.score,
          qa: { blocking, advisory: best.qa.advisory || [], qaUnavailable: best.qa.qaUnavailable || null },
          briefHash: activeBrief.hash, baseBriefHash: brief.hash, provider: provider.provider, model: provider.model,
          providerJobId: best.providerJobId || null, candidate: best.storageKey, pass: best.pass, unresolved,
          spreads: s.spreads, endFrame: !!preparedEnd && !endFrameDropped,
          checkedAt: new Date().toISOString(),
        })), `${canonicalKey}.qa.json`, 'application/json');
        for (const a of best.qa.advisory || []) advisories.push({ stage: 'video', note: `${label}: ${a}` });
        if (best.qa.qaUnavailable) advisories.push({ stage: 'video', note: `${label}: shipped UNCHECKED (${best.qa.qaUnavailable})` });
        result = { segment: s, buffer: best.buffer, storageKey: canonicalKey, clipHash, score: best.score, candidates: all.length, repairs, blocking, advisory: best.qa.advisory || [], candidateFiles: all.filter(c => c.status === 'done').map(c => ({ storageKey: c.storageKey, score: c.score })) };
      }
    }
  } finally {
    clearInterval(heartbeat);
  }

  // ── Ship policy ────────────────────────────────────────────────────────
  const unresolved = [];
  if (result.blocking && result.blocking.length > 0) {
    const candidates = [];
    for (const c of result.candidateFiles || []) {
      let url = null;
      try { url = await getSignedUrl(c.storageKey, SIGNED_URL_TTL_MS); } catch { url = null; }
      candidates.push({ storageKey: c.storageKey, url, score: c.score });
    }
    unresolved.push({ segment: segment.index, spread: null, spreads: segment.spreads, defects: result.blocking, candidates });
  }
  const frameReport = (f, prepared) => (f ? { storageKey: f.storageKey, renderHash: f.hash, rerendered: !!f.rerendered, blurFilled: !!(prepared || {}).blurFilled } : null);
  const planReport = [{
    index: segment.index, kind: 'journey', spread: null, spreads: segment.spreads, seconds: segment.seconds, motion: 'journey',
    acts: segment.acts.map(a => ({ index: a.index, spread: a.spread, from: a.from, to: a.to, angle: a.angle, move: a.move })),
    startFrame: frameReport(startFrame, preparedStart),
    endFrame: frameReport(endFrame, preparedEnd),
    clip: result.buffer ? { storageKey: result.storageKey, hash: result.clipHash, score: result.score, candidates: result.candidates, repairs: result.repairs, replayed: !!result.replayed, adminPicked: !!result.adminPicked } : null,
  }];
  if (unresolved.length > 0 && !flags.videoShipOnExhaustion()) {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw new VideoError(`the take could not be animated to the book's standard: ${unresolved.map(u => u.defects.join(' | ')).join('; ')}`, 'video_unresolved', { unresolved, plan: planReport, stills: stillReport, textGate: textGateReport, bookBible, advisories, warnings, provider: provider.provider, model: provider.model });
  }
  if (unresolved.length > 0) {
    advisories.push({ stage: 'shipPolicy', note: `stitched the take with BLOCKING residual defects (CATALOG_VIDEO_SHIP_ON_EXHAUSTION=1): ${unresolved[0].defects.join(' | ')}` });
  }
  if (!result.buffer) {
    throw new VideoError('the take has no clip to stitch', 'video_provider_unavailable', { stills: stillReport });
  }

  // ── Stitch (one clip: normalize, fade in/out, silent or music track) ───
  onProgress(0.88, 'Finishing the film...');
  let video;
  try {
    const file = path.join(tmp, 'take.mp4');
    await fs.promises.writeFile(file, result.buffer);
    const output = path.join(tmp, 'video.mp4');
    const poster = path.join(tmp, 'poster.jpg');
    const musicPath = musicPathFor(music);
    if (music !== 'none' && !musicPath) advisories.push({ stage: 'video', note: `music bed '${music}' is not bundled — the film ships with a silent track` });
    const portrait = aspect === '9:16';
    const stitch = ffmpeg.buildStitchCommand({ segments: [{ path: file, seconds: segment.seconds }], output, width: portrait ? 1080 : 1920, height: portrait ? 1920 : 1080, fps: 30, fadeSeconds: plan.fadeSeconds, musicPath });
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
    video: { ...video, url: undefined, posterUrl: undefined }, plan: planReport, stills: stillReport, textGate: textGateReport, unresolved, advisories,
    bibleHash: bible.hash, generatedSeconds, createdAt: new Date().toISOString(),
  };
  try { await saveJson(manifest, manifestKey); } catch (err) { log('warn', `film manifest write failed (${err.message})`); }
  onProgress(1, 'Film ready');
  return { video, plan: planReport, stills: stillReport, textGate: textGateReport, bookBible, unresolved, advisories, warnings, provider: provider.provider, model: provider.model, planHash };
}

/**
 * The canonical clip key + hash the take WOULD get (without generating) —
 * the replay probe shares generate.js's identity so a promoted clip is
 * found before any vendor call.
 */
async function generateCandidatesMeta(bookId, x, startFrame, endFrame, provider, aspect) {
  const { clipHashFor, clipKey } = require('./generate');
  const { clipSecondsFor } = require('./providers/models');
  const seconds = clipSecondsFor(x.segment.requestedSeconds, provider.profile.durations);
  const clipHash = clipHashFor({ provider: provider.provider, model: provider.model, briefHash: x.brief.hash, startFrameHash: startFrame.hash, endFrameHash: endFrame ? endFrame.hash : null, referenceHashes: x.references.map(r => r.hash), seconds, aspect });
  return { clipHash, canonicalKey: clipKey(bookId, x.segment.index, clipHash), seconds };
}

module.exports = { generateGiftVideo, VideoError, musicPathFor };
