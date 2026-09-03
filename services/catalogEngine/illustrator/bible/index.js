/**
 * The Book Bible (ce-9) — every fixed input a book's renders are held to,
 * built ONCE before any spread renders, verified, hashed, and pinned on
 * every render, every QA call, and every cache key.
 *
 * Components (each its own module, each elected in GCS so racing instances
 * converge on one asset):
 *  - character model sheet  (bible/characterSheet.js)   — identity + outfit as PIXELS
 *  - outfit spec v3         (outfitLock.js, source: the sheet — every slot seen)
 *  - prop / companion sheets (bible/propSheet.js)        — personal items as PIXELS
 *  - world plate            (worldPlate.js, ce-5, unchanged)
 *  - emotion plan           (emotionPlan.js)             — closed-enum per-spread mood
 *  - shot plan              (shotPlan.js, ce-8, unchanged — built by the caller)
 *
 * The manifest's `bibleHash` folds every pixel input's content hash into
 * ONE identity that the orchestrator folds into the render cache key: any
 * change to any fixed input re-keys every render. Nothing here chains —
 * every asset is generated from FIXED sources (the approved cover, the
 * profile word, the theme) and then frozen.
 */

const { getCharacterSheet } = require('./characterSheet');
const { getBibleProps, normalizePropValue } = require('./propSheet');
const { getOutfitLock } = require('../outfitLock');
const { getEmotionPlan, renderEmotionLine } = require('../emotionPlan');
const { getWorldPlate } = require('../worldPlate');
const { uploadBuffer, uploadBufferIfAbsent, downloadBuffer, getSignedUrl } = require('../../../gcsStorage');
const { fnv1a } = require('../../selection');
const { STYLE_VERSION } = require('../../versions');
const flags = require('../../flags');

const SIGNED_URL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Cache identity of the anchor: its URL path, never the query string (a
 * signed URL's rotating signature must not re-key the same object).
 * @param {string} anchorUrl
 * @returns {string}
 */
function anchorHash(anchorUrl) {
  return fnv1a(String(anchorUrl).split('?')[0]).toString(36);
}

/**
 * Deterministic GCS path for one story's elected emotion plan.
 * @param {string} storyKey fnv1a of the story's identity
 * @returns {string}
 */
function emotionPlanPath(storyKey) {
  return `catalog-assets/emotion-plans/${STYLE_VERSION}/${storyKey}.json`;
}

/**
 * Validate a stored emotion-plan blob: an own-property object of spread →
 * {emotion, intensity} strings (the closed enums are re-checked by
 * renderEmotionLine / the QA vocabulary — a foreign value simply renders
 * nothing). Returns null when unusable.
 * @param {*} blob
 * @returns {{plan: object, hash: string, source: string}|null}
 */
function cleanStoredEmotionPlan(blob) {
  if (!blob || typeof blob !== 'object' || !blob.plan || typeof blob.plan !== 'object') return null;
  const plan = {};
  for (const [k, v] of Object.entries(blob.plan)) {
    const spread = Number(k);
    if (!Number.isInteger(spread) || spread < 1 || spread > 12 || !v || typeof v !== 'object') continue;
    if (typeof v.emotion !== 'string' || typeof v.intensity !== 'string') continue;
    plan[spread] = { emotion: v.emotion.slice(0, 20), intensity: v.intensity.slice(0, 10), source: typeof v.source === 'string' ? v.source.slice(0, 20) : 'elected' };
  }
  if (Object.keys(plan).length === 0) return null;
  return { plan, hash: fnv1a(JSON.stringify(plan)).toString(36), source: typeof blob.source === 'string' ? blob.source.slice(0, 20) : 'elected' };
}

/**
 * Resolve the story's emotion plan with create-if-absent election: the
 * first instance to compute a plan (table + optional classifier) publishes
 * it; every later caller adopts the published plan verbatim. GCS failures
 * fall back to the locally computed plan (logged) — the render still gets
 * a plan, only the cross-instance guarantee weakens.
 * @param {{book: object, story: object, ageBand?: string, log: Function}} p
 * @returns {Promise<{plan: object, hash: string, source: string}|null>}
 */
async function electEmotionPlan({ book, story, ageBand, log }) {
  const storyKey = fnv1a(`${story?.book_id || book?.id || ''}|${ageBand || ''}|${(story?.spreads || []).map(s => `${s.spread}:${s.text}`).join('|')}`).toString(36);
  const path = emotionPlanPath(storyKey);
  try {
    const cached = await downloadBuffer(path).catch(() => null);
    if (cached) {
      const stored = cleanStoredEmotionPlan(JSON.parse(cached.toString('utf8')));
      if (stored) return stored;
    }
  } catch (err) {
    log('warn', `emotion plan cache read failed (${err.message}) — computing locally`);
  }
  const computed = await getEmotionPlan({ book, story, ageBand, log });
  if (!computed) return null;
  const local = { plan: computed.plan, hash: fnv1a(JSON.stringify(computed.plan)).toString(36), source: computed.source || 'table' };
  try {
    const { created } = await uploadBufferIfAbsent(Buffer.from(JSON.stringify({ plan: local.plan, source: local.source, electedAt: new Date().toISOString() })), path, 'application/json');
    if (!created) {
      const winner = cleanStoredEmotionPlan(JSON.parse((await downloadBuffer(path)).toString('utf8')));
      if (winner) return winner;
    }
  } catch (err) {
    log('warn', `emotion plan election failed (${err.message}) — using the locally computed plan`);
  }
  return local;
}

/**
 * Build the Book Bible for one book run. Fail-open for every OPTIONAL
 * component (prop sheets, emotion plan, world plate: null + advisory);
 * the character sheet is REQUIRED by default (flags.sheetRequired) —
 * a book that cannot build one throws `identity_kit_failed` so the run
 * ends `needs_review` instead of rendering on the cover alone (the ce-8
 * lesson: a silently lock-less book is how drift shipped unnoticed).
 *
 * @param {object} p
 * @param {string} p.bookId
 * @param {object} p.theme catalog theme ({theme_id, display_name, world_name, companion})
 * @param {object} p.book catalog book definition (beats)
 * @param {object} p.story validated writer response
 * @param {object} p.profile normalized profile
 * @param {string} [p.ageBand]
 * @param {string} p.anchorUrl identity anchor (approved cover / photo fallback)
 * @param {{base64: string, mimeType: string}} p.refPhoto anchor bytes
 * @param {{base64: string, mimeType: string}|null} [p.childPhoto] raw photo bytes (likeness aid)
 * @param {string|null} [p.characterDescription]
 * @param {object} [p.costTracker]
 * @param {(level: string, msg: string) => void} [p.log]
 * @returns {Promise<object>} the bible (see fields below)
 */
async function buildBookBible(p) {
  const log = p.log || (() => {});
  const advisories = [];
  const aHash = anchorHash(p.anchorUrl);

  // The component families are independent — nothing chains except the
  // outfit spec deriving FROM the sheet — so a cold anchor builds them
  // CONCURRENTLY and pays for the slowest family, not the sum (a warm
  // anchor's families are GCS-elected reads either way). Each branch
  // collects its own advisories; they are appended in the fixed
  // sheet → outfit → props order below so the manifest and callbacks stay
  // byte-stable. Only the identity branch may throw (identity_kit_failed);
  // every other family is fail-open by contract.

  // 1+2. Character model sheet (required by default) and the outfit spec —
  //      from the SHEET when there is one (every slot seen), else the ce-8
  //      cover-derived lock (inferred slots) with an advisory.
  const identityTask = (async () => {
    const notes = [];
    let sheet = null;
    if (flags.characterSheetEnabled()) {
      try {
        sheet = await getCharacterSheet({
          anchorUrl: p.anchorUrl, refPhoto: p.refPhoto, childPhoto: p.childPhoto || null,
          profile: p.profile, characterDescription: p.characterDescription || null,
          costTracker: p.costTracker, log,
        });
        for (const a of (sheet && sheet.advisories) || []) notes.push(a);
      } catch (err) {
        if (flags.sheetRequired()) {
          const e = new Error(`character model sheet could not be built (${err.message}) — the book needs review rather than rendering on the cover alone`);
          e.failureCode = err.failureCode || 'identity_kit_failed';
          e.advisories = err.advisories || [];
          throw e;
        }
        log('warn', `character sheet unavailable (${err.message}) — rendering on the cover alone`);
        notes.push({ stage: 'characterSheet', note: `renders are NOT anchored on a character model sheet (${err.message}); identity and outfit rely on the cover alone` });
      }
    }
    let outfit = null;
    if (sheet) {
      outfit = await getOutfitLock({
        anchorUrl: p.anchorUrl,
        refPhoto: { base64: sheet.base64, mimeType: sheet.mimeType },
        source: 'sheet', sourceHash: sheet.hash, log,
      });
      if (!outfit) notes.push({ stage: 'outfitLock', note: 'outfit spec could not be derived from the character sheet — falling back to the cover-derived lock' });
    }
    if (!outfit) {
      outfit = await getOutfitLock({ anchorUrl: p.anchorUrl, refPhoto: p.refPhoto, log });
      if (!outfit && flags.outfitLockEnabled()) {
        notes.push({ stage: 'outfitLock', note: 'renders are NOT outfit-locked — the outfit spec could not be derived from the identity anchor; cross-spread outfit consistency relies on the reference images alone' });
      }
    }
    return { sheet, outfit, notes };
  })();

  // 3. Prop + companion sheets (optional, fail-open).
  const propsTask = (async () => {
    const notes = [];
    let props = [];
    let companion = null;
    if (flags.propSheetsEnabled()) {
      try {
        const r = await getBibleProps({ evidence: p.story?.personalization_evidence || [], theme: p.theme, costTracker: p.costTracker, log });
        props = (r && r.props) || [];
        companion = (r && r.companion) || null;
        for (const a of (r && r.advisories) || []) notes.push(a);
      } catch (err) {
        log('warn', `prop sheets unavailable (${err.message}) — props ride as nouns`);
        notes.push({ stage: 'propSheet', note: `prop sheets unavailable (${err.message}); props ride as nouns only` });
      }
    }
    return { props, companion, notes };
  })();

  // 4. World plate (ce-5, unchanged; fail-open inside getWorldPlate).
  const plateTask = getWorldPlate({ theme: p.theme, costTracker: p.costTracker, log });

  // 5. Emotion plan (closed enum; fail-open to null) — ELECTED in GCS per
  //    story so every instance and retry pins the SAME plan: the classifier
  //    refinement is fail-open and only cached in-process, and the plan's
  //    hash rides the render cache key, so an un-elected plan would fork
  //    the key across instances (orphaning bench-approved renders).
  const emotionTask = (async () => {
    if (!flags.emotionPlanEnabled()) return null;
    try {
      return await electEmotionPlan({ book: p.book, story: p.story, ageBand: p.ageBand, log });
    } catch (err) {
      log('warn', `emotion plan unavailable (${err.message}) — rendering without one`);
      return null;
    }
  })();

  const [identity, propsResult, worldPlate, emotion] = await Promise.all([identityTask, propsTask, plateTask, emotionTask]);
  const { sheet, outfit } = identity;
  const { props, companion } = propsResult;
  advisories.push(...identity.notes, ...propsResult.notes);

  const manifest = {
    styleVersion: STYLE_VERSION,
    anchorHash: aHash,
    characterSheet: sheet ? { key: sheet.storageKey, hash: sheet.hash, likeness: sheet.likeness ?? null, candidates: sheet.candidates ?? null } : null,
    // The anchor-derived lock never sets `source`; only a sheet-derived one does.
    outfitSpec: outfit ? { text: outfit.outfit, hash: outfit.hash, source: outfit.source || 'anchor' } : null,
    // Each sheet's pixels AND its independently elected spec both shape
    // the prompt + QA, so both hashes are part of the identity below.
    props: props.filter(x => x && x.sheet).map(x => ({ value: x.value, key: x.sheet.storageKey, hash: x.sheet.hash, specHash: x.sheet.specHash || null, specText: x.sheet.specText || null })),
    companion: companion ? { name: companion.key, key: companion.storageKey, hash: companion.hash, specHash: companion.specHash || null, specText: companion.specText || null } : null,
    worldPlate: worldPlate ? { hash: worldPlate.hash } : null,
    emotionPlanHash: emotion ? emotion.hash : null,
  };
  manifest.bibleHash = fnv1a(JSON.stringify({
    s: manifest.styleVersion, a: manifest.anchorHash,
    c: manifest.characterSheet && manifest.characterSheet.hash,
    o: manifest.outfitSpec && manifest.outfitSpec.hash,
    p: manifest.props.map(x => [x.hash, x.specHash]), k: manifest.companion && [manifest.companion.hash, manifest.companion.specHash],
    w: manifest.worldPlate && manifest.worldPlate.hash, e: manifest.emotionPlanHash,
  })).toString(36);

  // Persist the manifest beside the book's job files (best-effort — a
  // failed write only loses the audit copy; the callback echo remains).
  try {
    await uploadBuffer(Buffer.from(JSON.stringify({ ...manifest, builtAt: new Date().toISOString() })), `children-jobs/${p.bookId}/bible.json`, 'application/json');
  } catch (err) {
    log('warn', `bible manifest write failed (${err.message})`);
  }

  return { manifest, hash: manifest.bibleHash, sheet, outfit, props, companion, worldPlate, emotion, advisories };
}

/**
 * The REFERENCE PACK for one render — fixed order, fixed labels: character
 * sheet, approved cover, the spread's props (declared + carried), the
 * companion when the beat names it, the world plate. Returns the pack plus
 * the 1-based indices the prompt blocks cite.
 * @param {object} bible from buildBookBible
 * @param {object} ctx
 * @param {{base64: string, mimeType: string}} ctx.refPhoto the anchor bytes
 * @param {string[]} ctx.propValues prop values present on this spread (declared first, then carried)
 * @param {boolean} ctx.companionOnSpread
 * @returns {{pack: Array<{label: string, base64: string, mimeType: string, kind: string}>, refs: {characterSheetRef: number|null, coverRef: number|null, props: Object<string, number>, companionRef: number|null, worldPlateRef: number|null}}}
 */
function buildReferencePack(bible, ctx) {
  const pack = [];
  // Prop values are PROFILE data: a child's comfort object may be named
  // `__proto__` or `constructor`, so the per-value index is a prototype-
  // less map and membership is an own-property check — an inherited key
  // must never make a sheet look "already attached".
  const refs = { characterSheetRef: null, coverRef: null, props: Object.create(null), companionRef: null, worldPlateRef: null };
  const push = (entry) => { pack.push(entry); return pack.length; };
  if (bible.sheet) {
    refs.characterSheetRef = push({ kind: 'characterSheet', label: 'CHARACTER MODEL SHEET (identity AND the complete outfit of the ONE child in this book — front, three-quarter, back): draw this exact child in this exact outfit. Use it ONLY for who the child is and what they wear; never copy a pose, expression or the plain studio background.', base64: bible.sheet.base64, mimeType: bible.sheet.mimeType || 'image/png' });
  }
  if (ctx.refPhoto && ctx.refPhoto.base64) {
    refs.coverRef = push({ kind: 'cover', label: bible.sheet
      ? 'APPROVED COVER (the parent-approved rendering of the same child: face, hair, skin tone, and the outfit\'s colours and materials are ground truth). Identity only — NEVER copy its pose, expression, camera distance, composition, or any lettering it carries.'
      : 'IDENTITY ANCHOR (the exact child character to draw): use it ONLY for the child\'s identity — face, hair, and outfit colors. NEVER copy its pose, expression, camera distance, or composition; this illustration\'s pose and camera come from the prompt only.', base64: ctx.refPhoto.base64, mimeType: ctx.refPhoto.mimeType || 'image/jpeg' });
  }
  // Prop sheets are matched on the NORMALIZED value (case/whitespace/
  // diacritics), never the raw string — the prompt still quotes the
  // spread's own wording.
  const byValue = new Map((bible.props || []).filter(x => x && x.sheet).map(x => [normalizePropValue(x.value), x.sheet]));
  for (const v of ctx.propValues || []) {
    const sheet = byValue.get(normalizePropValue(v));
    if (!sheet || Object.prototype.hasOwnProperty.call(refs.props, v)) continue;
    refs.props[v] = push({ kind: 'prop', label: `PROP SHEET for "${v}" (this exact object — same object, colours, material and size whenever it appears; the background is not part of the scene).`, base64: sheet.base64, mimeType: sheet.mimeType || 'image/png' });
  }
  if (ctx.companionOnSpread && bible.companion) {
    refs.companionRef = push({ kind: 'companion', label: `COMPANION SHEET for "${bible.companion.key}" (the book's companion character — draw exactly this design, colours and proportions).`, base64: bible.companion.base64, mimeType: bible.companion.mimeType || 'image/png' });
  }
  if (bible.worldPlate) {
    refs.worldPlateRef = push({ kind: 'worldPlate', label: 'WORLD STYLE PLATE (this book\'s fixed world): match its palette, lighting, era, materials, and environment logic exactly. Do NOT copy its composition, and NEVER treat it as the scene to draw — it contains no characters and this illustration\'s action comes from the prompt only.', base64: bible.worldPlate.base64, mimeType: bible.worldPlate.mimeType || 'image/png' });
  }
  return { pack, refs };
}

/**
 * The renderer's `opts.bible` for one render — the structured CHARACTER /
 * PROPS / COMPANION / EMOTION blocks, citing the pack's reference indices.
 * @param {object} bible from buildBookBible
 * @param {object} refs from buildReferencePack
 * @param {object} ctx {spread, declaredProps: string[], carriedProps: string[], companionOnSpread: boolean, characterDescription: string|null}
 * @returns {object}
 */
function buildPromptBible(bible, refs, ctx) {
  const specByValue = new Map((bible.props || []).filter(x => x && x.sheet).map(x => [normalizePropValue(x.value), x.sheet.specText || null]));
  const props = [];
  for (const v of ctx.declaredProps || []) props.push({ name: v, specText: specByValue.get(normalizePropValue(v)) || null, ref: refs.props[v] || null, carried: false });
  for (const v of ctx.carriedProps || []) {
    if (props.some(x => x.name === v)) continue;
    props.push({ name: v, specText: specByValue.get(normalizePropValue(v)) || null, ref: refs.props[v] || null, carried: true });
  }
  const emotionEntry = bible.emotion && bible.emotion.plan ? bible.emotion.plan[ctx.spread] : null;
  return {
    characterSheetRef: refs.characterSheetRef,
    coverRef: refs.coverRef,
    outfitSpecText: bible.outfit ? bible.outfit.outfit : null,
    hairLine: ctx.characterDescription || null,
    props,
    companion: ctx.companionOnSpread && bible.theme?.companion?.name
      ? { name: bible.theme.companion.name, type: bible.theme.companion.type, ref: refs.companionRef }
      : (ctx.companionOnSpread && bible.companion ? { name: bible.companion.key, type: bible.companion.type || 'companion', ref: refs.companionRef } : null),
    emotionLine: emotionEntry ? renderEmotionLine(emotionEntry) : null,
    emotion: emotionEntry || null,
  };
}

/**
 * Callback-shaped summary of the bible (signed URLs, hashes, spec text) —
 * what the app persists as storyContent.bookBible and the bench shows.
 * @param {object|null} bible
 * @returns {Promise<object|null>}
 */
async function summarizeBible(bible) {
  if (!bible) return null;
  const url = async (key) => {
    if (!key) return null;
    try { return await getSignedUrl(key, SIGNED_URL_TTL_MS); } catch { return null; }
  };
  const m = bible.manifest;
  return {
    styleVersion: m.styleVersion,
    anchorHash: m.anchorHash,
    characterSheet: m.characterSheet ? { url: await url(m.characterSheet.key), hash: m.characterSheet.hash, likeness: m.characterSheet.likeness } : null,
    outfitSpec: m.outfitSpec ? { text: m.outfitSpec.text, hash: m.outfitSpec.hash, source: m.outfitSpec.source } : null,
    props: await Promise.all(m.props.map(async x => ({ value: x.value, url: await url(x.key), hash: x.hash, specText: x.specText }))),
    companion: m.companion ? { name: m.companion.name, url: await url(m.companion.key), hash: m.companion.hash } : null,
    emotionPlanHash: m.emotionPlanHash,
    bibleHash: m.bibleHash,
  };
}

/**
 * Look up the prop sheet for one spread prop value (normalized match).
 * @param {object} bible
 * @param {string} value
 * @returns {object|null} the sheet record ({base64, mimeType, hash, specText, …}) or null
 */
function propSheetFor(bible, value) {
  const want = normalizePropValue(value);
  const hit = (bible.props || []).find(x => x && x.sheet && normalizePropValue(x.value) === want);
  return hit ? hit.sheet : null;
}

/**
 * The IDENTITY KIT alone — character sheet + the outfit spec derived from
 * it — for `/v13/prepare-identity` (the app calls it at cover approval so
 * the sheet is ready before /generate-book; GCS election makes the lazy
 * in-run build converge on the same asset). Throws `identity_kit_failed`
 * when no sheet can be built (same contract as the in-run build).
 * @param {{bookId: string, anchorUrl: string, childPhotoUrl?: string|null, profile?: {name?: string|null, age?: number|null}, characterDescription?: string|null, costTracker?: object, log?: Function}} p
 * @returns {Promise<object>} callback-shaped bookBible summary (identity fields only)
 */
async function prepareIdentity(p) {
  const log = p.log || (() => {});
  const { downloadPhotoAsBase64 } = require('../../../illustrationGenerator');
  let refPhoto;
  try {
    refPhoto = await downloadPhotoAsBase64(p.anchorUrl);
  } catch (err) {
    const e = new Error(`identity reference could not be downloaded (${err.message})`);
    e.failureCode = 'missing_identity_reference';
    throw e;
  }
  let childPhoto = null;
  if (p.childPhotoUrl && p.childPhotoUrl !== p.anchorUrl) {
    try { childPhoto = await downloadPhotoAsBase64(p.childPhotoUrl); } catch (err) { log('warn', `child photo unavailable (${err.message})`); }
  }
  const advisories = [];
  const sheet = await getCharacterSheet({
    anchorUrl: p.anchorUrl, refPhoto, childPhoto,
    profile: p.profile || {}, characterDescription: p.characterDescription || null,
    costTracker: p.costTracker, log,
  });
  if (!sheet) {
    const e = new Error('character sheet disabled (CATALOG_CHARACTER_SHEET=0) — nothing to prepare');
    e.failureCode = 'identity_kit_disabled';
    throw e;
  }
  for (const a of sheet.advisories || []) advisories.push(a);
  let outfit = await getOutfitLock({ anchorUrl: p.anchorUrl, refPhoto: { base64: sheet.base64, mimeType: sheet.mimeType }, source: 'sheet', sourceHash: sheet.hash, log });
  if (!outfit) {
    advisories.push({ stage: 'outfitLock', note: 'outfit spec could not be derived from the character sheet — the run will fall back to the cover-derived lock' });
    outfit = await getOutfitLock({ anchorUrl: p.anchorUrl, refPhoto, log });
  }
  let url = null;
  try { url = await getSignedUrl(sheet.storageKey, SIGNED_URL_TTL_MS); } catch { url = null; }
  return {
    styleVersion: STYLE_VERSION,
    anchorHash: anchorHash(p.anchorUrl),
    characterSheet: { url, key: sheet.storageKey, hash: sheet.hash, likeness: sheet.likeness ?? null, candidates: sheet.candidates ?? null },
    outfitSpec: outfit ? { text: outfit.outfit, hash: outfit.hash, source: outfit.source || 'anchor' } : null,
    advisories,
  };
}

module.exports = { buildBookBible, buildReferencePack, buildPromptBible, summarizeBible, prepareIdentity, propSheetFor, anchorHash, electEmotionPlan, emotionPlanPath };
