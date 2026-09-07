/**
 * The coloring book (cb-1 — docs/COLORING_BOOK_V2_PLAN.md): companion scenes
 * from the story world, drawn as verified line art, starring the book's own
 * hero and companion, printed as a Lulu saddle-stitched 8.5×11.
 *
 * Order of work: anchor + Book Bible → line sheets (hero REQUIRED, companion
 * and border plate fail-open) → plan → moments (writer behind the gate,
 * template fallback) → plan hash + replay check → per page: candidates →
 * clean + measure → judge → score → promote → bounded repair → set gates
 * (contact, stroke) with one corrective re-render each → ship policy
 * (`coloring_unresolved` fails closed with the scored candidates attached)
 * → layout (interior + cover, Lulu preflight) → upload → manifest.
 */

const pLimit = require('p-limit');
const { downloadPhotoAsBase64 } = require('../../illustrationGenerator');
const { uploadBuffer, downloadBuffer, getSignedUrl, objectExists, loadJson, saveJson } = require('../../gcsStorage');
const { buildBookBible, summarizeBible, anchorHash } = require('../illustrator/bible');
const { storyFingerprint } = require('../illustrator');
const { COLORING_VERSION, COLORING_QA_VERSION } = require('../versions');
const flags = require('../flags');
const { buildColoringPlan, planHash: hashPlan, validateColoringPlan } = require('./plan');
const { resolveMoments, templateMoment } = require('./moments');
const { resolveLineRules, lineRulesHash } = require('./lineRules');
const { getHeroLineSheet, getCompanionLineSheet, getBorderPlate } = require('./sheets');
const { buildColoringReferencePack, promptLadder, renderPageCandidates, stripColourWords } = require('./render');
const { checkAspect, measureLineArt, cleanLineArt } = require('./metrics');
const { checkColoringPage, classifyColoringDefects, repairNote } = require('./pageQa');
const { scoreColoringCandidate, pickBest, compareCandidates, residualBlocking, candidateKey } = require('./select');
const { runColoringContactGate, runStrokeGate, gateRepairNote } = require('./gates');
const { buildInteriorPdf, buildCoverWrapPdf, renderCoverThumbnail, renderPreviews, preflightLulu } = require('./layout');
const { coloringBase, pageKey, contentHash } = require('./candidates');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HEARTBEAT_MS = 30000;
const GATE_PASS_BASE = 10; // candidate keys for gate re-renders: .r1Xc{k} never collide with repair passes 1-4

class ColoringError extends Error {
  /**
   * @param {string} message
   * @param {string} failureCode
   * @param {object} [details] callback fields to carry on failure
   */
  constructor(message, failureCode, details) {
    super(message);
    this.name = 'ColoringError';
    this.failureCode = failureCode || null;
    this.details = details || null;
  }
}

/** @param {string} key @returns {Promise<string|null>} */
async function sign(key) {
  if (!key) return null;
  try { return await getSignedUrl(key, SIGNED_URL_TTL_MS); } catch (err) { return null; }
}

/** The bytes of a base64 record. @param {{base64: string}|null} rec @returns {Buffer|null} */
const bytes = rec => (rec && rec.base64 ? Buffer.from(rec.base64, 'base64') : null);

/**
 * Generate the coloring book for one finished picture book.
 * @param {object} p
 * @param {string} p.bookId
 * @param {object} p.story the validated writer response (title, spreads, personalization_evidence)
 * @param {{book: object, theme: object, ageBand: string}} p.bookDef from getBookForTag
 * @param {object} p.profile normalized profile
 * @param {string|null} p.approvedCoverUrl
 * @param {string|null} [p.childPhotoUrl]
 * @param {string|null} [p.characterDescription]
 * @param {number} [p.pageCount]
 * @param {number[]} [p.pages] a subset of page indices (admin iteration; no PDFs)
 * @param {boolean} [p.forceNew]
 * @param {object} p.costTracker
 * @param {(fraction: number, message: string) => void} [p.onProgress]
 * @param {() => void} [p.touch]
 * @param {AbortSignal} [p.abortSignal]
 * @param {(level: string, msg: string) => void} [p.log]
 * @returns {Promise<object>} the callback fields
 */
async function generateColoringBook(p) {
  const log = p.log || ((l, m) => console.log(`[coloring:${p.bookId}] ${m}`));
  const onProgress = p.onProgress || (() => {});
  const touch = p.touch || (() => {});
  const { bookId, story, bookDef, profile, costTracker } = p;
  const { book, theme } = bookDef;
  const ageBand = bookDef.ageBand;
  const rules = resolveLineRules(ageBand);
  const advisories = [];
  const warnings = [];
  const title = String((story && story.title) || book.title_template || 'My Story').replace('{name}', profile.name || '');
  const checkAbort = () => { if (p.abortSignal && p.abortSignal.aborted) throw new ColoringError('coloring book generation cancelled', 'cancelled'); };

  // ── Anchor + Book Bible ────────────────────────────────────────────────
  const anchorUrl = p.approvedCoverUrl || p.childPhotoUrl || null;
  if (!anchorUrl) throw new ColoringError('no approved cover and no child photo — the pages would have no identity reference', 'missing_identity_reference');
  let refPhoto;
  try { refPhoto = await downloadPhotoAsBase64(anchorUrl); } catch (err) { throw new ColoringError(`identity reference could not be downloaded (${err.message})`, 'missing_identity_reference'); }
  let childPhoto = null;
  if (p.approvedCoverUrl && p.childPhotoUrl && p.childPhotoUrl !== p.approvedCoverUrl) {
    try { childPhoto = await downloadPhotoAsBase64(p.childPhotoUrl); } catch (err) { log('warn', `child photo unavailable for the character sheet (${err.message})`); }
  }
  const heartbeat = (fraction, message) => setInterval(() => { touch(); onProgress(fraction, message); }, HEARTBEAT_MS);
  let hb = heartbeat(0.05, 'Building the identity kit...');
  let bible;
  try {
    onProgress(0.05, 'Building the identity kit...');
    bible = await buildBookBible({ bookId, theme, book, story, profile, ageBand, anchorUrl, refPhoto, childPhoto, characterDescription: p.characterDescription || null, costTracker, log });
  } catch (err) {
    throw new ColoringError(err.message, err.failureCode || 'identity_kit_failed', { advisories: err.advisories || [] });
  } finally { clearInterval(hb); }
  for (const a of bible.advisories || []) advisories.push(a);
  checkAbort();

  // ── Line sheets ────────────────────────────────────────────────────────
  onProgress(0.1, 'Drawing the line-art model sheets...');
  hb = heartbeat(0.12, 'Drawing the line-art model sheets...');
  let heroLineSheet = null;
  let companionLineSheet = null;
  let borderPlate = null;
  const outfitSpecText = bible.outfit ? bible.outfit.outfit : null;
  try {
    const aHash = anchorHash(anchorUrl);
    const heroTask = (async () => {
      if (!bible.sheet) {
        if (flags.coloringSheetRequired()) throw Object.assign(new ColoringError('no character model sheet is available for this anchor — the line-art model sheet cannot be derived', 'coloring_identity_failed'), { advisories: [] });
        advisories.push({ stage: 'coloringSheet', note: 'no character model sheet — the pages anchor on the cover alone (CATALOG_COLORING_SHEET_REQUIRED=0)' });
        return null;
      }
      try {
        return await getHeroLineSheet({ anchorHash: aHash, colourSheet: bible.sheet, cover: refPhoto, outfitSpecText, profile, ageBand, costTracker, log });
      } catch (err) {
        if (flags.coloringSheetRequired()) throw new ColoringError(err.message, err.failureCode || 'coloring_identity_failed', { advisories: err.advisories || [] });
        advisories.push({ stage: 'coloringSheet', note: `hero line sheet unavailable (${err.message}) — the pages anchor on the colour sheet (CATALOG_COLORING_SHEET_REQUIRED=0)` });
        for (const a of err.advisories || []) advisories.push(a);
        return null;
      }
    })();
    const companionTask = bible.companion && bible.companion.base64
      ? getCompanionLineSheet({ theme, companion: { ...bible.companion, name: bible.companion.key || (theme.companion && theme.companion.name), type: bible.companion.type || (theme.companion && theme.companion.type) }, ageBand, costTracker, log })
      : Promise.resolve(null);
    const borderTask = getBorderPlate({ theme, ageBand, costTracker, log });
    [heroLineSheet, companionLineSheet, borderPlate] = await Promise.all([heroTask, companionTask, borderTask]);
  } finally { clearInterval(hb); }
  if (heroLineSheet) for (const a of heroLineSheet.advisories || []) advisories.push(a);
  if (bible.companion && !companionLineSheet) advisories.push({ stage: 'coloringSheet', note: 'companion line sheet unavailable — the companion renders from its colour sheet' });
  if (!borderPlate) advisories.push({ stage: 'coloringSheet', note: 'border plate unavailable — the matter pages use a typeset rule frame' });
  checkAbort();

  // ── Plan + moments ─────────────────────────────────────────────────────
  onProgress(0.16, 'Planning the pages...');
  const fingerprint = storyFingerprint(story);
  const emotionPlan = bible.emotion ? bible.emotion.plan : null;
  const pageCount = Number.isInteger(p.pageCount) ? p.pageCount : (flags.coloringPages() || undefined);
  const plan = buildColoringPlan({ book, theme, story, profile, ageBand, emotionPlan, seedBasis: fingerprint, pageCount });
  const planCheck = validateColoringPlan(plan);
  if (!planCheck.ok) throw new ColoringError(`the scene plan is invalid: ${planCheck.errors.join('; ')}`, 'coloring_plan_failed');
  // Without a hero line sheet the meet page cannot exist: it becomes a hero portrait.
  if (!heroLineSheet) {
    const meet = plan.pages.find(pg => pg.kind === 'meet');
    if (meet) Object.assign(meet, { kind: 'hero_portrait', shot: 'medium', placement: 'centred', anchor: { spread: 1 }, props: plan.object && plan.object.spread <= 1 ? [plan.object.value] : [] });
  }
  const moments = await resolveMoments({ plan, book, theme, story, profile, costTracker, log });
  for (const pg of plan.pages) {
    const m = moments.pages.find(x => x.index === pg.index) || { ...templateMoment(pg, { name: profile.name, world: theme.world_name, display: theme.display_name, companion: theme.companion }), source: 'template' };
    pg.moment = m.moment;
    pg.title = m.title;
    pg.momentSource = m.source;
  }
  const imageSize = flags.coloringImageSize();
  const planKey = hashPlan(plan, {
    fp: fingerprint, bible: bible.hash,
    hero: heroLineSheet ? heroLineSheet.hash : null, companion: companionLineSheet ? companionLineSheet.hash : null, border: borderPlate ? borderPlate.hash : null,
    rules: lineRulesHash(), size: imageSize, moments: plan.pages.map(pg => pg.moment),
  });
  const base = coloringBase(bookId, planKey);
  const subset = Array.isArray(p.pages) && p.pages.length > 0 ? new Set(p.pages) : null;
  const planReport = { hash: planKey, band: plan.band, kinds: plan.kinds, peakSpread: plan.peakSpread, momentWriter: moments.writer, gateRejections: moments.gateRejections };
  const bookBible = { ...(await summarizeBible(bible)), lineSheet: heroLineSheet ? { url: await sign(heroLineSheet.storageKey), hash: heroLineSheet.hash, likeness: heroLineSheet.likeness } : null, companionLineSheet: companionLineSheet ? { url: await sign(companionLineSheet.storageKey), hash: companionLineSheet.hash } : null, borderPlate: borderPlate ? { url: await sign(borderPlate.storageKey), hash: borderPlate.hash } : null };
  log('info', `plan ${planKey}: ${plan.pageCount} pages (${Object.entries(plan.kinds).map(([k, v]) => `${k}×${v}`).join(', ')}), moments by ${moments.writer}`);

  // ── Whole-book replay ──────────────────────────────────────────────────
  const manifestKey = `${base}/manifest.json`;
  if (!p.forceNew && !subset) {
    const manifest = await loadJson(manifestKey).catch(() => null);
    if (manifest && manifest.interiorKey && await objectExists(manifest.interiorKey).catch(() => false)) {
      log('info', `coloring book ${planKey} replays from ${manifest.interiorKey}`);
      const pages = [];
      for (const pg of manifest.pages || []) pages.push({ ...pg, url: await sign(pg.storageKey), cached: true });
      return {
        cached: true, planHash: planKey, plan: planReport, bookBible,
        interiorPdfUrl: await sign(manifest.interiorKey), coverPdfUrl: await sign(manifest.coverKey), coverImageUrl: await sign(manifest.thumbKey),
        previewImageUrls: (await Promise.all((manifest.previewKeys || []).map(sign))).filter(Boolean),
        pageCount: manifest.pageCount, coloringPageCount: manifest.coloringPageCount, pages,
        gates: manifest.gates || { contact: null, stroke: null }, unresolved: [], preflight: manifest.preflight || null,
        advisories: [...advisories, ...(manifest.advisories || [])], warnings,
      };
    }
  }

  // ── Per-page render ────────────────────────────────────────────────────
  const companionSpec = bible.companion ? { name: bible.companion.key || (theme.companion && theme.companion.name), type: bible.companion.type || (theme.companion && theme.companion.type), specText: bible.companion.specText || null, human: !!bible.companion.human } : (theme.companion && theme.companion.name ? { name: theme.companion.name, type: theme.companion.type, specText: null, human: false } : null);
  const companionSheetForRender = companionLineSheet || (bible.companion && bible.companion.base64 ? bible.companion : null);
  const propSheetFor = value => (bible.props || []).find(x => x && x.sheet && String(x.value).toLowerCase() === String(value).toLowerCase());
  const n = flags.coloringCandidates();
  const maxRepairs = flags.coloringMaxRepairs();
  const pageLimit = pLimit(flags.renderConcurrency());
  const candidateLimit = pLimit(Math.max(n, flags.renderConcurrency()));
  const targets = plan.pages.filter(pg => !subset || subset.has(pg.index));
  let finished = 0;
  hb = setInterval(() => { touch(); onProgress(0.2 + (finished / Math.max(1, targets.length)) * 0.6, `Drawing pages (${finished}/${targets.length} done)...`); }, HEARTBEAT_MS);

  /** Everything one page's render/judge needs, built once per page. */
  const contextFor = (pg) => {
    const propSheets = (pg.props || []).map(v => { const s = propSheetFor(v); return s ? { value: v, base64: s.sheet.base64, mimeType: s.sheet.mimeType } : null; }).filter(Boolean);
    const { pack, refs } = buildColoringReferencePack({ page: pg, heroLineSheet, colourSheet: bible.sheet, cover: refPhoto, companionSheet: pg.companion ? companionSheetForRender : null, propSheets, worldPlate: bible.worldPlate, borderPlate });
    const promptArgs = { page: pg, moment: pg.moment, pageCount: plan.pageCount, title, theme, profile, rules, outfitSpecText, companion: companionSpec, refs, repairNote: null };
    const checks = {
      kind: pg.kind, moment: pg.moment, expectsChild: pg.hasChild, expectsCompanion: pg.companion,
      heroLineSheet, colourSheet: bible.sheet, outfitSpecText: stripColourWords(outfitSpecText),
      companion: companionSpec ? { ...companionSpec, sheet: companionSheetForRender } : null,
      props: (pg.props || []).map(v => { const s = propSheetFor(v); return { name: v, sheet: s ? s.sheet : null, expected: pg.kind === 'prop_still_life' ? 'required' : 'carried' }; }),
      costTracker,
    };
    const repairCtx = { name: profile.name, moment: pg.moment, outfitSpecText: stripColourWords(outfitSpecText), heroRef: refs.heroLineRef, companion: companionSpec ? { name: companionSpec.name, ref: refs.companionRef, specText: companionSpec.specText } : null, props: (pg.props || []).map(v => ({ name: v, ref: refs.props[v] })), rules };
    return { pack, refs, promptArgs, checks, repairCtx };
  };

  /**
   * Render + judge N candidates for one pass; every candidate keeps its
   * own bytes beside the canonical key.
   */
  const renderPass = async (pg, ctx, prompts, pass, canonical, label) => {
    const rendered = await renderPageCandidates({ prompts, pack: ctx.pack, n, pass, imageSize, costTracker, abortSignal: p.abortSignal, label, limit: candidateLimit, touch });
    const scored = [];
    const all = [];
    for (const c of rendered) {
      const key = candidateKey(canonical, c.k, pass);
      if (!c.buffer) { all.push({ k: c.k, pass, storageKey: key, error: c.error, score: null }); continue; }
      const aspect = await checkAspect(c.buffer);
      const cleaned = await cleanLineArt(c.buffer, { despeckle: flags.coloringDespeckleEnabled() });
      const metrics = await measureLineArt(cleaned.buffer, { rules });
      const qa = await checkColoringPage(cleaned.buffer, { ...ctx.checks, label: `${label}:qa${c.k}` });
      const defects = [...(aspect.ok ? [] : [`wrong aspect: ${aspect.ratio} (expected 0.75)`]), ...metrics.blocking, ...metrics.advisory, ...qa.defects];
      const { blocking, advisory } = classifyColoringDefects(defects);
      const cand = {
        k: c.k, pass, storageKey: key, buffer: cleaned.buffer, rung: c.rung,
        qa: { pass: blocking.length === 0 && advisory.length === 0, blocking, advisory, ...(qa.qaUnavailable ? { qaUnavailable: qa.qaUnavailable } : {}) },
        metrics: { grayRatio: metrics.grayRatio, inkRatio: metrics.inkRatio, strokeWidthPercent: metrics.strokeWidthPercent, strokeRatio: metrics.strokeRatio, inkMin: rules.inkMin, inkMax: rules.inkMax, specks: cleaned.specks, frameRing: metrics.frameRing },
        childBbox: qa.childBbox, companionBbox: qa.companionBbox,
      };
      cand.score = scoreColoringCandidate(cand);
      scored.push(cand);
      all.push({ k: c.k, pass, storageKey: key, score: cand.score, blocking, advisory, qaUnavailable: qa.qaUnavailable || null });
      await uploadBuffer(cleaned.buffer, key, 'image/png').catch(err => log('warn', `candidate upload failed (${err.message})`));
      touch();
    }
    return { scored, all };
  };

  /** Promote a chosen candidate to the canonical key with its marker. */
  const promote = async (pg, best, canonical, repairs, allCandidates) => {
    const unresolved = (best.qa.blocking || []).length > 0;
    const renderHash = contentHash(best.buffer);
    await uploadBuffer(best.buffer, canonical, 'image/png');
    await uploadBuffer(Buffer.from(JSON.stringify({
      coloringQaVersion: COLORING_QA_VERSION, coloringVersion: COLORING_VERSION, planHash: planKey, renderHash, score: best.score,
      qa: { blocking: best.qa.blocking, advisory: best.qa.advisory, qaUnavailable: best.qa.qaUnavailable || null }, metrics: best.metrics, rung: best.rung,
      childBbox: best.childBbox, companionBbox: best.companionBbox, candidate: best.storageKey, pass: best.pass, repairs, unresolved, checkedAt: new Date().toISOString(),
    })), `${canonical}.qa.json`, 'application/json');
    return {
      index: pg.index, kind: pg.kind, anchor: pg.anchor, title: pg.title, moment: pg.moment, momentSource: pg.momentSource,
      storageKey: canonical, buffer: best.buffer, renderHash, score: best.score, rung: best.rung,
      qa: { pass: !unresolved && best.qa.advisory.length === 0, blocking: best.qa.blocking, advisory: best.qa.advisory, qaUnavailable: best.qa.qaUnavailable || null, metrics: best.metrics },
      metrics: best.metrics, childBbox: best.childBbox, companionBbox: best.companionBbox,
      candidates: allCandidates.length, repairs, cached: false, candidateFiles: allCandidates.filter(c => c.score != null).map(c => ({ storageKey: c.storageKey, score: c.score })),
    };
  };

  /** The full per-page loop: replay → candidates → repair → promote. */
  const renderPage = async (pg) => {
    const canonical = pageKey(bookId, planKey, pg.index);
    const label = `coloring:${bookId}:p${pg.index}`;
    if (pg.kind === 'meet') {
      // The hero line sheet IS the page (no render, no judge).
      const buffer = bytes(heroLineSheet);
      finished += 1;
      return { index: pg.index, kind: 'meet', anchor: null, title: pg.title, moment: pg.moment, momentSource: pg.momentSource, storageKey: heroLineSheet.storageKey, buffer, renderHash: heroLineSheet.hash, score: null, rung: 'sheet', qa: { pass: true, blocking: [], advisory: [], qaUnavailable: null, metrics: null }, metrics: null, childBbox: null, companionBbox: null, candidates: 0, repairs: 0, cached: true, candidateFiles: [] };
    }
    if (!p.forceNew) {
      const marker = await loadJson(`${canonical}.qa.json`).catch(() => null);
      if (marker && marker.coloringQaVersion === COLORING_QA_VERSION && (marker.adminPicked || !marker.unresolved)) {
        const buffer = await downloadBuffer(canonical).catch(() => null);
        if (buffer && buffer.length > 0 && contentHash(buffer) === marker.renderHash) {
          log('info', `page ${pg.index}: replays from ${canonical}${marker.adminPicked ? ' (admin-picked)' : ''}`);
          finished += 1;
          const qa = marker.adminPicked ? { blocking: [], advisory: [], qaUnavailable: null } : (marker.qa || { blocking: [], advisory: [] });
          return { index: pg.index, kind: pg.kind, anchor: pg.anchor, title: pg.title, moment: pg.moment, momentSource: pg.momentSource, storageKey: canonical, buffer, renderHash: marker.renderHash, score: marker.score ?? null, rung: marker.rung || null, qa: { pass: qa.blocking.length === 0 && (qa.advisory || []).length === 0, blocking: qa.blocking || [], advisory: qa.advisory || [], qaUnavailable: qa.qaUnavailable || null, metrics: marker.metrics || null }, metrics: marker.metrics || null, childBbox: marker.childBbox || null, companionBbox: marker.companionBbox || null, candidates: 0, repairs: 0, cached: true, adminPicked: !!marker.adminPicked, candidateFiles: [] };
        }
      }
    }
    const ctx = contextFor(pg);
    const ladderCtx = { name: profile.name, world: theme.world_name };
    let prompts = promptLadder(ctx.promptArgs, ladderCtx);
    let best = null;
    let repairs = 0;
    const all = [];
    for (let pass = 0; pass <= maxRepairs; pass++) {
      checkAbort();
      if (pass > 0) {
        const residual = residualBlocking(best);
        if (!best || residual.length === 0 || best.qa.qaUnavailable) break;
        prompts = promptLadder({ ...ctx.promptArgs, repairNote: repairNote(residual, ctx.repairCtx) }, ladderCtx);
        repairs += 1;
      }
      const { scored, all: passAll } = await renderPass(pg, ctx, prompts, pass, canonical, label);
      all.push(...passAll);
      const passBest = pickBest(scored);
      if (passBest && (!best || compareCandidates(passBest, best) > 0)) best = passBest;
      log('info', `page ${pg.index} (${pg.kind}): pass ${pass} → ${scored.length} judged, best ${best ? best.score : 'none'}${best && best.qa.blocking.length ? ` (blocking: ${best.qa.blocking.join(' | ')})` : ''}`);
      if (best && !best.qa.qaUnavailable && best.qa.blocking.length === 0) break;
    }
    finished += 1;
    if (!best) throw new ColoringError(`page ${pg.index}: no candidate came back (${all.map(c => c.error).filter(Boolean).slice(0, 2).join('; ') || 'no output'})`, 'coloring_render_failed');
    if (best.rung && best.rung !== 'original') advisories.push({ stage: 'render', page: pg.index, note: `page ${pg.index} rendered on the ${best.rung} safety rung (the moment was ${best.rung === 'generic-safe' ? 'replaced by a generic one' : 'sanitized'})` });
    if (best.qa.qaUnavailable) advisories.push({ stage: 'coloringQa', page: pg.index, note: `page ${pg.index} shipped UNCHECKED (${best.qa.qaUnavailable})` });
    for (const a of best.qa.advisory) advisories.push({ stage: 'coloringQa', page: pg.index, note: `page ${pg.index}: ${a}` });
    const result = await promote(pg, best, canonical, repairs, all);
    result.ctx = ctx;
    return result;
  };

  let results;
  try {
    onProgress(0.2, `Drawing ${targets.length} pages (${n} candidates each)...`);
    results = await Promise.all(targets.map(pg => pageLimit(() => renderPage(pg))));
  } finally { clearInterval(hb); }
  results.sort((a, b) => a.index - b.index);
  checkAbort();

  // ── Set gates ──────────────────────────────────────────────────────────
  onProgress(0.82, 'Checking the pages against each other...');
  hb = heartbeat(0.84, 'Checking the pages against each other...');
  const gates = { contact: null, stroke: null };
  try {
    const gateRerender = async (r, defect, note) => {
      // A replayed page is a comparison reference only; a fresh page renders
      // once more against the gate's note and is adopted only when it does
      // not carry MORE blocking defects than the shipped one.
      if (r.cached || !r.ctx) return false;
      const pg = plan.pages.find(x => x.index === r.index);
      const gateNote = gateRepairNote({ defect, note, heroRef: r.ctx.refs.heroLineRef, companionRef: r.ctx.refs.companionRef, name: profile.name, companionName: companionSpec ? companionSpec.name : null, outfitSpecText: stripColourWords(outfitSpecText), medianStrokePercent: gates.stroke ? gates.stroke.median : null });
      const prompts = promptLadder({ ...r.ctx.promptArgs, repairNote: gateNote }, { name: profile.name, world: theme.world_name });
      const pass = GATE_PASS_BASE + (r.gateRerenders || 0);
      const { scored, all } = await renderPass(pg, r.ctx, prompts, pass, r.storageKey, `coloring:${bookId}:p${pg.index}:gate`);
      const cand = pickBest(scored);
      if (!cand || cand.qa.qaUnavailable || cand.qa.blocking.length > r.qa.blocking.length) return false;
      const promoted = await promote(pg, cand, r.storageKey, r.repairs, [...r.candidateFiles.map(c => ({ ...c, pass: 0 })), ...all]);
      Object.assign(r, promoted, { ctx: r.ctx, gateRerenders: (r.gateRerenders || 0) + 1, gateRepaired: true });
      return true;
    };
    const contact = await runColoringContactGate({
      pages: results.map(r => ({ index: r.index, kind: r.kind, buffer: r.buffer, childBbox: r.childBbox, companionBbox: r.companionBbox, expectsChild: !!(plan.pages.find(x => x.index === r.index) || {}).hasChild, expectsCompanion: !!(plan.pages.find(x => x.index === r.index) || {}).companion })),
      heroLineSheet: heroLineSheet ? { buffer: bytes(heroLineSheet) } : null, companionLineSheet: companionLineSheet ? { buffer: bytes(companionLineSheet) } : null,
      name: profile.name, companionName: companionSpec ? companionSpec.name : null, outfitSpecText: stripColourWords(outfitSpecText), costTracker,
    });
    let contactBudget = flags.coloringContactMaxRerenders();
    const contactLimit = pLimit(flags.renderConcurrency());
    const flagged = [...((contact.hero && contact.hero.flagged) || []), ...((contact.companion && contact.companion.flagged) || [])];
    await Promise.all(flagged.map(f => contactLimit(async () => {
      const r = results.find(x => x.index === f.page);
      if (!r) return;
      advisories.push({ stage: 'coloringSetQa', page: f.page, note: `${f.defect}: ${f.note || 'flagged by the contact-sheet gate'}` });
      if (contactBudget <= 0) return;
      contactBudget -= 1;
      const adopted = await gateRerender(r, f.defect, f.note);
      advisories.push({ stage: 'coloringSetQa', page: f.page, note: adopted ? `page ${f.page} re-rendered against the ${f.defect} finding` : `page ${f.page}: the gate re-render was not adopted (${r.cached ? 'replayed page' : 'no better candidate'})` });
    })));
    gates.contact = { hero: contact.hero ? { pass: contact.hero.pass, flagged: contact.hero.flagged, checked: contact.hero.checked, qaUnavailable: contact.hero.qaUnavailable || null } : null, companion: contact.companion ? { pass: contact.companion.pass, flagged: contact.companion.flagged, checked: contact.companion.checked, qaUnavailable: contact.companion.qaUnavailable || null } : null };
    const stroke = runStrokeGate({ pages: results.filter(r => r.kind !== 'meet').map(r => ({ index: r.index, metrics: r.metrics })) });
    gates.stroke = stroke;
    if (stroke && !stroke.pass) {
      let strokeBudget = flags.coloringStrokeMaxRerenders();
      for (const o of stroke.outliers) {
        const r = results.find(x => x.index === o.page);
        advisories.push({ stage: 'coloringSetQa', page: o.page, note: `stroke_weight: page ${o.page} draws its lines at ${o.ratio}× the book's median weight` });
        if (!r || strokeBudget <= 0) continue;
        strokeBudget -= 1;
        const adopted = await gateRerender(r, 'stroke_weight', null);
        if (adopted) advisories.push({ stage: 'coloringSetQa', page: o.page, note: `page ${o.page} re-rendered toward the book's median stroke weight` });
      }
    }
  } finally { clearInterval(hb); }
  checkAbort();

  // ── Ship policy ────────────────────────────────────────────────────────
  const unresolved = [];
  for (const r of results) {
    if (r.qa.blocking.length > 0) {
      const candidates = [];
      for (const c of r.candidateFiles || []) candidates.push({ storageKey: c.storageKey, url: await sign(c.storageKey), score: c.score });
      unresolved.push({ page: r.index, kind: r.kind, defects: r.qa.blocking, candidates });
    }
  }
  const pageReport = async () => Promise.all(results.map(async r => ({
    index: r.index, kind: r.kind, anchor: r.anchor, title: r.title, moment: r.moment, momentSource: r.momentSource,
    storageKey: r.storageKey, url: await sign(r.storageKey), qa: r.qa, candidates: r.candidates, repairs: r.repairs, cached: !!r.cached, rung: r.rung, ...(r.adminPicked ? { adminPicked: true } : {}), ...(r.gateRepaired ? { gateRepaired: true } : {}),
  })));
  if (unresolved.length > 0 && !flags.coloringShipOnExhaustion()) {
    throw new ColoringError(`${unresolved.length} page(s) could not be drawn to the book's standard: ${unresolved.map(u => `page ${u.page}: ${u.defects.join(' | ')}`).join('; ')}`, 'coloring_unresolved', { unresolved, pages: await pageReport(), plan: planReport, bookBible, gates, advisories, warnings, planHash: planKey });
  }
  if (unresolved.length > 0) advisories.push({ stage: 'shipPolicy', note: `shipped ${unresolved.length} page(s) with BLOCKING residual defects (CATALOG_COLORING_SHIP_ON_EXHAUSTION=1): ${unresolved.map(u => `page ${u.page}`).join(', ')}` });

  if (subset) {
    onProgress(1, 'Pages ready');
    return { cached: false, planHash: planKey, plan: planReport, bookBible, subset: true, interiorPdfUrl: null, coverPdfUrl: null, coverImageUrl: null, previewImageUrls: [], pageCount: null, coloringPageCount: results.length, pages: await pageReport(), gates, unresolved, preflight: null, advisories, warnings };
  }

  // ── Layout + upload ────────────────────────────────────────────────────
  onProgress(0.9, 'Typesetting the book...');
  hb = heartbeat(0.92, 'Typesetting the book...');
  let interior; let cover; let thumb; let previews; let preflight;
  try {
    interior = await buildInteriorPdf({ pages: results.map(r => ({ index: r.index, kind: r.kind, buffer: r.buffer, title: r.title })), title, childName: profile.name, borderPlate: bytes(borderPlate), captions: flags.coloringCaptionsEnabled() });
    let coverArt = bytes(refPhoto);
    if (!p.approvedCoverUrl) {
      coverArt = bytes(bible.sheet) || coverArt;
      advisories.push({ stage: 'cover', note: 'no approved cover — the coloring cover shows the character model sheet instead of the parent cover' });
    }
    cover = await buildCoverWrapPdf({ coverArt, title, childName: profile.name, worldName: theme.world_name, coloringPageCount: interior.coloringPageCount, vignette: bytes(companionLineSheet) || bytes(heroLineSheet) });
    thumb = await renderCoverThumbnail({ coverArt, childName: profile.name, palette: cover.palette }).catch(err => { warnings.push(`cover thumbnail failed: ${err.message}`); return null; });
    previews = await renderPreviews(results.filter(r => r.kind !== 'meet'), 4, 800);
    preflight = await preflightLulu({ interior: interior.buffer, cover: cover.buffer, pageReport: interior.pages });
  } catch (err) {
    throw new ColoringError(`the PDFs could not be built: ${err.message}`, 'coloring_pdf_failed', { pages: await pageReport(), plan: planReport, bookBible, gates, advisories, warnings, planHash: planKey });
  } finally { clearInterval(hb); }
  if (!preflight.ok) throw new ColoringError(`the PDFs fail Lulu's preflight: ${preflight.errors.join('; ')}`, 'coloring_pdf_failed', { pages: await pageReport(), plan: planReport, bookBible, gates, advisories, warnings, planHash: planKey, preflight });
  for (const w of preflight.warnings) warnings.push(w);
  onProgress(0.96, 'Uploading...');
  const interiorKey = `${base}/interior.pdf`;
  const coverKey = `${base}/cover.pdf`;
  const thumbKey = thumb ? `${base}/cover-thumb.png` : null;
  const interiorPdfUrl = await uploadBuffer(interior.buffer, interiorKey, 'application/pdf');
  const coverPdfUrl = await uploadBuffer(cover.buffer, coverKey, 'application/pdf');
  const coverImageUrl = thumb ? await uploadBuffer(thumb, thumbKey, 'image/png') : null;
  const previewKeys = [];
  const previewImageUrls = [];
  for (let i = 0; i < previews.length; i++) {
    const key = `${base}/preview-${i + 1}.png`;
    previewKeys.push(key);
    previewImageUrls.push(await uploadBuffer(previews[i], key, 'image/png'));
  }
  const pages = await pageReport();
  const manifest = {
    coloringVersion: COLORING_VERSION, qaVersion: COLORING_QA_VERSION, planHash: planKey, bibleHash: bible.hash,
    interiorKey, coverKey, thumbKey, previewKeys, pageCount: interior.pageCount, coloringPageCount: interior.coloringPageCount,
    pages: pages.map(({ url, ...rest }) => rest), plan: planReport, gates, preflight, advisories, warnings, createdAt: new Date().toISOString(),
  };
  try { await saveJson(manifest, manifestKey); } catch (err) { log('warn', `manifest write failed (${err.message})`); }
  onProgress(1, 'Coloring book ready');
  return {
    cached: false, planHash: planKey, plan: planReport, bookBible,
    interiorPdfUrl, coverPdfUrl, coverImageUrl, previewImageUrls,
    pageCount: interior.pageCount, coloringPageCount: interior.coloringPageCount, pages, gates, unresolved, preflight, advisories, warnings,
  };
}

module.exports = { generateColoringBook, ColoringError, SIGNED_URL_TTL_MS };
