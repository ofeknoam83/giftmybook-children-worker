/**
 * Character model sheet — the per-anchor FIXED identity reference of the
 * Book Bible (ce-9, ILLUSTRATION_CONSISTENCY_REFACTOR_PLAN §3.1).
 *
 * The approved cover is the wrong KIND of identity image for stateless
 * spread renders: one pose, one angle, legs usually cropped, a scene behind
 * the child. Every render that anchors on it re-invents whatever the cover
 * does not show — and an unspecified garment is per-spread freedom (the
 * ce-8 lesson). This module turns the parent-approved character into ONE
 * wide model sheet — the same child full-body front / three-quarter / back,
 * the SAME complete outfit in all three views, two small head insets, flat
 * light-grey background, no scene, no text — generated ONCE from the cover
 * (one hop, then frozen; never chained from renders) and elected in GCS the
 * way the world plate is, so racing instances adopt one sheet.
 *
 * Best-of-N, judged, elected: N candidates (CATALOG_SHEET_CANDIDATES,
 * default 3) each get one structured vision check (no text, exactly three
 * full-body figures of ONE child, feet visible, outfit identical across the
 * views, anatomy), explicit identity/outfit agreement with the approved
 * cover, and a minimum cover-likeness score. The passing candidate with
 * the highest COVER likeness wins (ties keep candidate order). The child's
 * photo is an optional QA diagnostic only: cover-to-photo resemblance is
 * established before cover approval, never by redesigning the kit. Raw
 * photos and face crops never ride the sheet render. Low photo likeness
 * carries an advisory to review the cover. Judge fields are type-checked;
 * caller strings are sanitized before entering the prompt.
 *
 * Failure contract — deliberately NOT the world plate's fail-open: a book
 * that cannot build its sheet must never silently render on the cover
 * alone (that is how drift shipped unnoticed). Any total failure THROWS an
 * Error carrying `failureCode = 'identity_kit_failed'` and `advisories`;
 * the caller decides between `needs_review` (flags.sheetRequired()) and a
 * sheet-less advisory run. A failed anchor sits out a cooldown so a broken
 * cover costs one attempt per window, not N generations per book. The ONLY
 * null result is the kill-switch: CATALOG_CHARACTER_SHEET=0.
 */

const { getNextApiKey, GEMINI_MODEL, fetchWithTimeout, renderStyleBlock } = require('../../../illustrationGenerator');
const { PIXAR_STYLE, GEMINI_QA_MODEL, GEMINI_IMAGE_SAFETY_SETTINGS } = require('../../../shared/illustration/config');
const { jsonQaGenerationConfig, responseText, parseJsonText, unparseableDetail } = require('../../../shared/llm/geminiJson');
const { downloadBuffer, uploadBuffer, uploadBufferIfAbsent } = require('../../../gcsStorage');
const { STYLE_VERSION } = require('../../versions');
const { fnv1a } = require('../../selection');
const { anchorHash } = require('../outfitLock');
const flags = require('../../flags');

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
/** The vision judge honors the same knob as spread QA (CATALOG_QA_VISION_MODEL). */
const QA_MODEL = () => process.env.CATALOG_QA_VISION_MODEL || GEMINI_QA_MODEL;
const SHEET_TIMEOUT_MS = 180000;
const QA_TIMEOUT_MS = 60000;
const SHEET_ASPECT = '16:9';
const FAILURE_CODE = 'identity_kit_failed';
const STAGE = 'characterSheet';

const CANDIDATES_DEFAULT = 3;
const CANDIDATES_MIN = 1;
const CANDIDATES_MAX = 4;
/** Cover fidelity is required; photo resemblance remains advisory at this stage. */
const COVER_LIKENESS_MIN = 0.8;
const PHOTO_LIKENESS_ADVISORY = 0.5;

/** Sanitization caps for caller-supplied strings that get pinned into the prompt. */
const DESCRIPTION_MAX_CHARS = 300;
const NAME_MAX_CHARS = 40;
const AGE_MIN = 1;
const AGE_MAX = 12;

// In-process caches keyed by the anchor's path hash. Each entry holds a
// multi-megabyte base64 image, so the LRU is small and BOUNDED (16 covers
// the anchors a warm instance sees in flight); the in-flight map dedupes
// concurrent first-use generation across parallel renders; failed anchors
// sit out a cooldown so a broken cover costs one attempt per window.
const SHEET_CACHE_MAX = 16;
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const FAILURE_MAX = 32;
const _sheets = new Map();
const _inFlight = new Map();
const _failures = new Map();

/** @param {string} key @returns {boolean} still inside the failure cooldown */
function inFailureCooldown(key) {
  const at = _failures.get(key);
  if (at === undefined) return false;
  if (Date.now() - at < FAILURE_COOLDOWN_MS) return true;
  _failures.delete(key);
  return false;
}

/** Record a failed resolution (evicting oldest past the cap). @param {string} key */
function recordFailure(key) {
  _failures.delete(key);
  _failures.set(key, Date.now());
  while (_failures.size > FAILURE_MAX) _failures.delete(_failures.keys().next().value);
}

/** LRU get: refresh recency on hit. @param {string} key @returns {object|null} */
function cacheGet(key) {
  if (!_sheets.has(key)) return null;
  const sheet = _sheets.get(key);
  _sheets.delete(key);
  _sheets.set(key, sheet);
  return sheet;
}

/** LRU set: insert as most-recent, evict oldest past the cap. @param {string} key @param {object} sheet */
function cacheSet(key, sheet) {
  _sheets.delete(key);
  _sheets.set(key, sheet);
  while (_sheets.size > SHEET_CACHE_MAX) _sheets.delete(_sheets.keys().next().value);
}

/**
 * Candidates rendered per anchor: CATALOG_SHEET_CANDIDATES, clamped 1-4
 * (non-integers / out-of-range ⇒ default 3).
 * @returns {number}
 */
function sheetCandidateCount() {
  const n = Number(process.env.CATALOG_SHEET_CANDIDATES);
  return Number.isInteger(n) && n >= CANDIDATES_MIN && n <= CANDIDATES_MAX ? n : CANDIDATES_DEFAULT;
}

/**
 * Deterministic GCS path for one anchor's elected sheet. Keyed by
 * STYLE_VERSION (a style bump regenerates sheets) and the anchor's PATH hash
 * (a re-signed URL resolves the same object).
 * @param {string} hash anchorHash of the identity anchor URL
 * @returns {string}
 */
function characterSheetPath(hash) {
  return `catalog-assets/character-sheets/${STYLE_VERSION}/${hash}.png`;
}

/**
 * The sheet's JSON sidecar beside the PNG: `{hash, likeness, photoLikeness,
 * candidates, derivedAt}` — the judge's numbers for the elected bytes,
 * written by the election winner AFTER the PNG is elected.
 * @param {string} hash anchorHash of the identity anchor URL
 * @returns {string}
 */
function characterSheetSidecarPath(hash) {
  return `catalog-assets/character-sheets/${STYLE_VERSION}/${hash}.json`;
}

/**
 * Sanitize one caller-supplied line into inert pinned prompt data: control
 * chars and newlines collapse (a newline would let a description start a
 * "new instruction" line), quotes/backticks strip, whitespace normalizes,
 * length-capped. Null when nothing usable survives.
 * @param {*} value
 * @param {number} maxChars
 * @returns {string|null}
 */
function cleanLine(value, maxChars) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Sanitize the app-supplied character description (the cover-time
 * `describeChildFromPhoto` sentence) before it is pinned into the sheet
 * prompt. Profile strings are data, never instructions.
 * @param {*} value
 * @returns {string|null}
 */
function cleanDescription(value) {
  return cleanLine(value, DESCRIPTION_MAX_CHARS);
}

/**
 * The child's identity line for the prompt: sanitized name + a bounded
 * integer age. Null when the profile carries neither.
 * @param {{name?: string, age?: number|string}|null|undefined} profile
 * @returns {string|null}
 */
function renderChildLine(profile) {
  const name = cleanLine(profile?.name, NAME_MAX_CHARS);
  const ageNum = Number(profile?.age);
  const age = Number.isInteger(ageNum) && ageNum >= AGE_MIN && ageNum <= AGE_MAX ? ageNum : null;
  if (!name && age === null) return null;
  const parts = [];
  if (name) parts.push(`named ${name}`);
  if (age !== null) parts.push(`${age} years old`);
  return `The child is ${parts.join(', ')}.`;
}

/**
 * The sheet's generation prompt — a FIXED template (style block + layout,
 * outfit, inset, background, anatomy, and no-text rules) with only the
 * sanitized child line and description interpolated. Deterministic for the
 * same inputs.
 * @param {object} params
 * @param {{name?: string, age?: number|string}|null} [params.profile]
 * @param {string|null} [params.characterDescription]
 * @returns {string}
 */
function buildSheetPrompt({ profile = null, characterDescription = null } = {}) {
  const childLine = renderChildLine(profile);
  const description = cleanDescription(characterDescription);
  const lines = [
    renderStyleBlock(PIXAR_STYLE),
    'CHARACTER MODEL SHEET of this exact child — the parent-approved character in REFERENCE 1. Its face, hair, skin tone, and the colours and materials of its outfit are GROUND TRUTH: reproduce them, never reinterpret them.',
    'IDENTITY LOCK: copy the approved character\'s face shape and roundness, eye size, shape, colour and spacing, eyebrows, nose, mouth, hairline, hairstyle, hair colour and texture, skin tone, and body proportions into EVERY view and both head insets. Preserve the same stylization and apparent age. Only the viewing angle and expression change. Neutral studio lighting must not change the child\'s underlying skin tone.',
  ];
  if (childLine) lines.push(childLine);
  if (description) lines.push(`Character description: ${description}.`);
  lines.push(
    'REFERENCE PRIORITY: the approved character in REFERENCE 1 defines all visible features. The profile and description are context only and must never override it or redesign the child.',
    'LAYOUT (hard rules): three FULL-BODY figures of the SAME child standing side by side in one row — LEFT: front view, MIDDLE: three-quarter view, RIGHT: back view — standing relaxed with arms at the sides, head to toe entirely inside the frame, feet and shoes fully visible on every figure.',
    'OUTFIT: the SAME complete outfit in all three views — every garment, colour, pattern, and length identical from view to view. Where the reference crops a garment (legs, shoes), complete it ONCE and draw that completion identically in every view. Never invent accessories, props, or extra garments the reference does not show.',
    'HEAD INSETS: two small head-and-shoulders insets in the top corner — one happy, one curious — the same child, same hair, same skin tone.',
    'BACKGROUND: a flat light-grey studio background with even, soft lighting. NO scene, NO environment, NO props, NO other people, animals, or creatures.',
    'ANATOMY: exactly two arms and two hands with exactly five clearly separated fingers per hand, two legs, and two feet on every figure — no third arm, no extra or duplicated hand, no stray hand, no fused fingers.',
    'ABSOLUTELY NO text, letters, labels, numbers, captions, arrows, or watermarks anywhere in the image — the sheet is a pure visual reference.',
  );
  return lines.join('\n');
}

/**
 * Build a tagged `identity_kit_failed` error.
 * @param {string} message
 * @param {Array<{stage: string, note: string}>} advisories
 * @returns {Error}
 */
function identityKitError(message, advisories) {
  const err = new Error(message);
  err.failureCode = FAILURE_CODE;
  err.advisories = advisories;
  return err;
}

/** @param {string} note @returns {{stage: string, note: string}} */
function advisory(note) {
  return { stage: STAGE, note };
}

/**
 * One Gemini image call for one sheet candidate: the fixed prompt, the
 * labeled approved-character reference only. Kept local instead of reusing
 * generateIllustration: that path wraps scenes in per-spread prompt language
 * a model sheet must not carry.
 * @param {string} prompt
 * @param {{base64: string, mimeType?: string}} refPhoto the approved anchor bytes
 * @returns {Promise<Buffer>}
 */
async function renderSheetCandidate(prompt, refPhoto) {
  const parts = [
    { text: prompt },
    { text: 'REFERENCE 1 — APPROVED CHARACTER (the parent-approved rendering of the child: face, hair, skin tone, body proportions, rendering style, and outfit are ground truth)' },
    { inline_data: { mimeType: refPhoto.mimeType || 'image/png', data: refPhoto.base64 } },
  ];
  const apiKey = getNextApiKey();
  const resp = await fetchWithTimeout(
    `${GEMINI_API}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: SHEET_ASPECT } },
        safetySettings: GEMINI_IMAGE_SAFETY_SETTINGS,
      }),
    },
    SHEET_TIMEOUT_MS,
  );
  if (!resp.ok) throw new Error(`Gemini sheet render HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
  const data = await resp.json();
  const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!imagePart?.inlineData?.data) throw new Error('no image in Gemini sheet response');
  return Buffer.from(imagePart.inlineData.data, 'base64');
}

/**
 * The judge prompt: a FIXED template; with the child's photo attached as
 * image 3 it gains an advisory `photo_likeness` field. Image 2 remains
 * the sole authority for the sheet's identity and outfit.
 * @param {boolean} hasPhoto
 * @returns {string}
 */
function buildSheetQaPrompt(hasPhoto) {
  return `You are checking a CHARACTER MODEL SHEET for a children's picture book. Image 1 is the sheet. Image 2 is the APPROVED CHARACTER reference the sheet must reproduce.${hasPhoto ? ' Image 3 is a PHOTO of the real child for an advisory resemblance score only. Do not use image 3 to redefine the approved character or excuse a difference from image 2.' : ''}

A correct sheet shows exactly THREE full-body (head to toe) figures of the SAME single child standing side by side — front view, three-quarter view, back view — wearing the SAME complete outfit in all three, with feet and shoes fully visible, plus two small head insets in a corner (the insets are NOT full-body figures — do not count them), on a flat plain background, with NO text of any kind.

Answer STRICT JSON only:
{
  "readable_text": true|false,   // any readable text, letters, labels, numbers, captions, or watermarks anywhere in image 1
  "figure_count": <integer>,     // number of FULL-BODY (head to toe) figures in image 1; head insets do not count
  "one_child": true|false,       // every figure depicts the SAME single child (no second child, adult, or creature)
  "feet_visible": true|false,    // every full-body figure shows its feet/shoes fully inside the frame
  "outfit_consistent_across_views": true|false, // the same complete outfit (garments, colours, patterns, lengths) in every view
  "cover_identity_matches": true|false, // EVERY figure and head inset is the SAME character as image 2: preserve face roundness, eye size/shape/spacing, eyebrows, nose, mouth, hairline, hair colour/style, underlying skin tone, apparent age and body proportions; allow viewpoint, expression and lighting changes only
  "cover_outfit_matches": true|false, // visible garments, colours, patterns and materials match image 2; consistently completed unseen legs/shoes are allowed
  "anatomy_ok": true|false,      // every figure has exactly two arms, two hands with five separated fingers, two legs; no extra, fused, or duplicated limbs
  "likeness": <number 0.0-1.0>${hasPhoto ? ',' : ''}   // how well the figures match the approved character in image 2: face, hair, skin tone, and outfit colours (1.0 = the same character)${hasPhoto ? `
  "photo_likeness": <number 0.0-1.0> // how recognizably the figures and head insets depict the CHILD IN THE PHOTO (image 3): compare face shape, eye shape and colour, eyebrows, nose, mouth, hair colour, texture, length and style, skin tone, glasses and distinctive marks; ignore the art style, outfit, pose, expression and lighting (1.0 = unmistakably this child to someone who knows them, 0.5 = could be them, 0.0 = a different child)` : ''}
}
Only report what you can clearly see; do not guess.`;
}

const VERDICT_BOOLEANS = ['readable_text', 'one_child', 'feet_visible', 'outfit_consistent_across_views', 'anatomy_ok', 'cover_identity_matches', 'cover_outfit_matches'];

/**
 * Validate the judge's parsed JSON into a closed verdict: every required
 * field type-checked (booleans, an integer figure count, a finite likeness
 * clamped to 0-1). Null when malformed — the caller treats the candidate as
 * unverifiable, never as passed. Only own properties are read; hostile keys
 * (`__proto__`, `constructor`) are ignored data, never prototype writes.
 * @param {*} json
 * `photo_likeness` is optional (only asked for when the photo rides): a
 * finite number is clamped, anything else is null — never a malformed
 * verdict. This diagnostic cannot override cover fidelity or affect election.
 * @returns {{pass: boolean, defects: string[], likeness: number, photoLikeness: number|null}|null}
 */
function parseSheetVerdict(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const own = k => (Object.prototype.hasOwnProperty.call(json, k) ? json[k] : undefined);
  if (!VERDICT_BOOLEANS.every(f => typeof own(f) === 'boolean')) return null;
  const figureCount = own('figure_count');
  if (!Number.isInteger(figureCount)) return null;
  const likenessRaw = own('likeness');
  if (typeof likenessRaw !== 'number' || !Number.isFinite(likenessRaw)) return null;
  const likeness = Math.min(1, Math.max(0, likenessRaw));
  const photoRaw = own('photo_likeness');
  const photoLikeness = typeof photoRaw === 'number' && Number.isFinite(photoRaw) ? Math.min(1, Math.max(0, photoRaw)) : null;
  const defects = [
    own('readable_text') && 'readable text on the sheet',
    figureCount !== 3 && `${figureCount} full-body figures (expected 3)`,
    !own('one_child') && 'figures do not all depict the same single child',
    !own('feet_visible') && 'feet/shoes not fully visible on every figure',
    !own('outfit_consistent_across_views') && 'outfit differs between views',
    !own('cover_identity_matches') && 'identity differs from the approved character',
    !own('cover_outfit_matches') && 'outfit differs from the approved character',
    likeness < COVER_LIKENESS_MIN && `cover likeness ${likeness.toFixed(2)} below the ${COVER_LIKENESS_MIN} floor`,
    !own('anatomy_ok') && 'anatomy error (limbs/hands/fingers)',
  ].filter(Boolean);
  return { pass: defects.length === 0, defects, likeness, photoLikeness };
}

/**
 * One vision call judging a sheet candidate against the approved character.
 * Fail-open per candidate: transport/HTTP/malformed verdicts resolve
 * `{unverifiable: <reason>}` — the caller never passes such a candidate
 * silently.
 * @param {Buffer} sheetBuffer the candidate bytes
 * @param {{base64: string, mimeType?: string}} refPhoto the approved anchor bytes
 * @param {{base64: string, mimeType?: string}|null} [childPhoto] the child's photo — advisory resemblance only
 * @returns {Promise<{pass: boolean, defects: string[], likeness: number, photoLikeness: number|null}|{unverifiable: string}>}
 */
async function judgeSheetCandidate(sheetBuffer, refPhoto, childPhoto = null) {
  try {
    const apiKey = getNextApiKey();
    const hasPhoto = Boolean(childPhoto?.base64);
    const parts = [
      { text: buildSheetQaPrompt(hasPhoto) },
      { inline_data: { mimeType: 'image/png', data: sheetBuffer.toString('base64') } },
      { inline_data: { mimeType: refPhoto.mimeType || 'image/png', data: refPhoto.base64 } },
    ];
    if (hasPhoto) parts.push({ inline_data: { mimeType: childPhoto.mimeType || 'image/jpeg', data: childPhoto.base64 } });
    const resp = await fetchWithTimeout(
      `${GEMINI_API}/${QA_MODEL()}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts,
          }],
          // Thinking OFF + a ≥2048-token ceiling (shared/llm/geminiJson):
          // the 2.5 flash judge counts its reasoning against
          // maxOutputTokens, and a small cap left every answer clipped.
          generationConfig: jsonQaGenerationConfig(1024, QA_MODEL()),
        }),
      },
      QA_TIMEOUT_MS,
    );
    if (!resp.ok) return { unverifiable: `sheet QA HTTP ${resp.status}` };
    const data = await resp.json();
    const text = responseText(data);
    let json;
    try {
      json = parseJsonText(text);
    } catch (parseErr) {
      // Name WHY (a spent budget, a safety block, an empty body) — the
      // advisory is what the admin sees on identity_kit_failed.
      return { unverifiable: `sheet QA returned unparseable JSON${unparseableDetail(data, text)}` };
    }
    const verdict = parseSheetVerdict(json);
    if (!verdict) return { unverifiable: 'sheet QA returned a malformed verdict' };
    return verdict;
  } catch (err) {
    return { unverifiable: `sheet QA errored: ${err.message}` };
  }
}

/**
 * Render + judge one candidate. Never throws: a generation failure is a
 * candidate with `error`, a judge failure one with `unverifiable`.
 * @param {number} index 0-based candidate index
 * @param {string} prompt
 * @param {{base64: string, mimeType?: string}} refPhoto
 * @param {{base64: string, mimeType?: string}|null} childPhoto optional photo for QA only
 * @param {object|undefined} costTracker
 * @returns {Promise<{index: number, buffer?: Buffer, verdict?: object, unverifiable?: string, error?: string}>}
 */
async function produceCandidate(index, prompt, refPhoto, childPhoto, costTracker) {
  let buffer;
  try {
    buffer = await renderSheetCandidate(prompt, refPhoto);
  } catch (err) {
    return { index, error: err.message };
  }
  if (costTracker) costTracker.addImageGeneration(GEMINI_MODEL, 1);
  const judged = await judgeSheetCandidate(buffer, refPhoto, childPhoto);
  if (judged.unverifiable) return { index, buffer, unverifiable: judged.unverifiable };
  return { index, buffer, verdict: judged };
}

/** @param {{likeness: number, photoLikeness?: number|null}} verdict @returns {string} log fragment */
function describeLikeness(verdict) {
  return typeof verdict.photoLikeness === 'number'
    ? `photo likeness ${verdict.photoLikeness.toFixed(2)}, cover likeness ${verdict.likeness.toFixed(2)}`
    : `likeness ${verdict.likeness.toFixed(2)}`;
}

/**
 * Elect the winning candidate from the judged set: the PASSING candidate
 * with the highest COVER likeness (ties keep candidate order). The photo
 * score is diagnostic only. When no candidate passes the set is a failure;
 * the returned `error` carries every candidate's verdict — INCLUDING the
 * case where the judge was unavailable for every candidate: an elected
 * sheet is pinned per anchor for good (this book and every later book on
 * the anchor), so a sheet nothing verified is never elected blind (unlike
 * the fail-open world plate, which is not an identity ground truth).
 * `CATALOG_SHEET_REQUIRED=0` turns that failure into a sheet-less render
 * with an advisory — never into a pinned guess. An elected sheet whose
 * photo likeness sits below PHOTO_LIKENESS_ADVISORY carries an advisory.
 * @param {Array<object>} results from produceCandidate, in index order
 * @param {(level: string, msg: string) => void} log
 * @returns {{winner: object|null, likeness: number|null, photoLikeness: number|null, advisories: Array<{stage: string, note: string}>, error?: Error}}
 */
function electCandidate(results, log) {
  const advisories = [];
  for (const r of results) {
    const n = r.index + 1;
    if (r.error) {
      log('warn', `character sheet candidate ${n}: generation failed (${r.error})`);
      advisories.push(advisory(`candidate ${n} generation failed: ${r.error}`));
    } else if (r.unverifiable) {
      log('warn', `character sheet candidate ${n}: UNVERIFIABLE (${r.unverifiable})`);
      advisories.push(advisory(`candidate ${n} unverifiable: ${r.unverifiable}`));
    } else if (!r.verdict.pass) {
      log('info', `character sheet candidate ${n}: REJECTED (${r.verdict.defects.join('; ')}; ${describeLikeness(r.verdict)})`);
      advisories.push(advisory(`candidate ${n} rejected: ${r.verdict.defects.join('; ')}`));
    } else {
      log('info', `character sheet candidate ${n}: PASS (${describeLikeness(r.verdict)})`);
    }
  }
  const passing = results.filter(r => r.verdict?.pass);
  if (passing.length > 0) {
    const winner = passing.reduce((best, r) => (r.verdict.likeness > best.verdict.likeness ? r : best), passing[0]);
    const photoLikeness = typeof winner.verdict.photoLikeness === 'number' ? winner.verdict.photoLikeness : null;
    if (photoLikeness !== null && photoLikeness < PHOTO_LIKENESS_ADVISORY) {
      advisories.push(advisory(`elected sheet photo likeness ${photoLikeness.toFixed(2)} — the child may not be recognizable in the illustrations; review the cover against the child photo and regenerate the cover if needed; do not redesign the kit independently`));
    }
    return { winner, likeness: winner.verdict.likeness, photoLikeness, advisories };
  }
  const generated = results.filter(r => r.buffer);
  if (generated.length > 0 && generated.every(r => r.unverifiable)) {
    log('warn', 'character sheet: every candidate was unverifiable — no sheet elected (a sheet nothing verified is never pinned)');
    advisories.push(advisory(`no sheet elected: the judge was unavailable for every candidate (${generated[0].unverifiable})`));
  }
  const summary = advisories.map(a => a.note).join(' | ');
  return {
    winner: null,
    likeness: null,
    photoLikeness: null,
    advisories,
    error: identityKitError(`character sheet failed: no candidate passed QA (${summary})`, advisories),
  };
}

/**
 * Parse a stored sidecar (our own write, still treated as data): likeness
 * and photoLikeness as finite 0-1 numbers or null, candidates as a positive
 * integer or null.
 * @param {Buffer|null|undefined} raw
 * @returns {{likeness: number|null, photoLikeness: number|null, candidates: number|null}}
 */
function parseSidecar(raw) {
  const out = { likeness: null, photoLikeness: null, candidates: null };
  if (!raw) return out;
  try {
    const json = JSON.parse(raw.toString('utf8'));
    if (!json || typeof json !== 'object') return out;
    const own = k => (Object.prototype.hasOwnProperty.call(json, k) ? json[k] : undefined);
    const likeness = own('likeness');
    if (typeof likeness === 'number' && Number.isFinite(likeness)) out.likeness = Math.min(1, Math.max(0, likeness));
    const photoLikeness = own('photoLikeness');
    if (typeof photoLikeness === 'number' && Number.isFinite(photoLikeness)) out.photoLikeness = Math.min(1, Math.max(0, photoLikeness));
    const candidates = own('candidates');
    if (Number.isInteger(candidates) && candidates > 0) out.candidates = candidates;
  } catch (err) {
    // A corrupt sidecar only loses the judge's numbers, never the sheet.
  }
  return out;
}

/**
 * Package elected bytes into the result shape.
 * @param {Buffer} buffer
 * @param {string} storageKey
 * @param {{likeness: number|null, photoLikeness: number|null, candidates: number|null}} meta the judge's numbers
 * @param {Array<{stage: string, note: string}>} advisories
 * @returns {{base64: string, mimeType: string, hash: string, storageKey: string, likeness: number|null, photoLikeness: number|null, candidates: number, advisories: Array<{stage: string, note: string}>}}
 */
function toSheet(buffer, storageKey, meta, advisories) {
  const base64 = buffer.toString('base64');
  return {
    base64,
    mimeType: 'image/png',
    hash: fnv1a(base64).toString(36),
    storageKey,
    likeness: meta.likeness ?? null,
    photoLikeness: meta.photoLikeness ?? null,
    candidates: meta.candidates ?? 0,
    advisories,
  };
}

/** Shallow copy so a cached entry is never mutated through a caller's result. @param {object} sheet */
function copySheet(sheet) {
  return { ...sheet, advisories: sheet.advisories.map(a => ({ ...a })) };
}

/**
 * Resolve (or lazily build) the character model sheet for one identity
 * anchor.
 * @param {object} params
 * @param {string} params.anchorUrl the identity reference URL (approved
 *   cover, or the raw-photo fallback for coverless test books)
 * @param {{base64: string, mimeType?: string}} params.refPhoto the anchor
 *   bytes the caller already downloaded for the renders
 * @param {{base64: string, mimeType?: string}|null} [params.childPhoto]
 *   the child's photo — QA-only advisory resemblance diagnostic; never
 *   attached to a sheet render or used to override the approved cover
 * @param {{name?: string, age?: number|string}|null} [params.profile]
 * @param {string|null} [params.characterDescription] the app's cover-time
 *   description sentence (sanitized before it is pinned)
 * @param {object} [params.costTracker]
 * @param {(level: string, msg: string) => void} [params.log]
 * @returns {Promise<{base64: string, mimeType: string, hash: string, storageKey: string, likeness: number|null, photoLikeness: number|null, candidates: number, advisories: Array<{stage: string, note: string}>}|null>}
 *   null ONLY when the kill-switch is off.
 * @throws {Error} `failureCode = 'identity_kit_failed'` (+ `advisories`) on
 *   any total failure — bad input, no passing candidate, transport or
 *   election failure, or an anchor inside its failure cooldown.
 */
async function getCharacterSheet({ anchorUrl, refPhoto, childPhoto = null, profile = null, characterDescription = null, costTracker, log = () => {} }) {
  if (!flags.characterSheetEnabled()) return null;
  if (!anchorUrl || !refPhoto?.base64) {
    throw identityKitError('character sheet: an identity anchor URL and its bytes are required', [advisory('no identity anchor supplied')]);
  }
  const key = anchorHash(anchorUrl);
  const hit = cacheGet(key);
  if (hit) return copySheet(hit);
  if (inFailureCooldown(key)) {
    throw identityKitError(`character sheet for anchor ${key} failed recently — inside the failure cooldown`, [advisory('anchor inside the character-sheet failure cooldown')]);
  }
  if (_inFlight.has(key)) return _inFlight.get(key).then(copySheet);

  const resolve = (async () => {
    const path = characterSheetPath(key);
    const sidecarPath = characterSheetSidecarPath(key);
    try {
      const cached = await downloadBuffer(path).catch(() => null);
      if (cached) {
        const meta = parseSidecar(await downloadBuffer(sidecarPath).catch(() => null));
        const sheet = toSheet(cached, path, meta, []);
        cacheSet(key, sheet);
        return sheet;
      }
      const count = sheetCandidateCount();
      log('info', `character sheet for anchor ${key} not cached — generating ${count} candidate(s) (${path})`);
      // The approved cover alone drives generation. The child's photo
      // remains an optional QA diagnostic, never a competing render anchor.
      const prompt = buildSheetPrompt({ profile, characterDescription });
      const results = await Promise.all(
        Array.from({ length: count }, (_, i) => produceCandidate(i, prompt, refPhoto, childPhoto, costTracker)),
      );
      const election = electCandidate(results, log);
      if (!election.winner) {
        recordFailure(key);
        throw election.error;
      }
      // Create-if-absent: concurrent cold instances race to create the same
      // deterministic object and exactly one write wins — every loser ADOPTS
      // the winning bytes, so all instances anchor on ONE sheet.
      let sheetBuffer = election.winner.buffer;
      let meta = { likeness: election.likeness, photoLikeness: election.photoLikeness, candidates: count };
      const advisories = election.advisories;
      let created;
      try {
        ({ created } = await uploadBufferIfAbsent(sheetBuffer, path, 'image/png'));
      } catch (err) {
        // Never globally elected — using it would fork the fixed reference
        // during a GCS outage. Total failure with the cooldown.
        recordFailure(key);
        throw identityKitError(`character sheet upload failed for anchor ${key}: ${err.message}`, [...advisories, advisory(`sheet upload failed: ${err.message}`)]);
      }
      if (created) {
        // The sidecar is best-effort diagnostics beside an already-elected
        // PNG: a failed write never loses the sheet.
        const body = Buffer.from(JSON.stringify({
          hash: fnv1a(sheetBuffer.toString('base64')).toString(36),
          likeness: meta.likeness,
          photoLikeness: meta.photoLikeness,
          candidates: meta.candidates,
          derivedAt: new Date().toISOString(),
        }));
        await uploadBuffer(body, sidecarPath, 'application/json').catch((err) => {
          log('warn', `character sheet sidecar write failed for anchor ${key} (${err.message})`);
        });
      } else {
        // A KNOWN winner exists: local bytes are never acceptable. Failing
        // to fetch the winner is a total failure WITHOUT a cooldown — the
        // winner exists, and the next cache check fetches it.
        log('info', `character sheet for anchor ${key} was created concurrently — adopting the winning object`);
        try {
          sheetBuffer = await downloadBuffer(path);
        } catch (winErr) {
          throw identityKitError(`character sheet for anchor ${key}: lost the creation race and could not fetch the winning sheet (${winErr.message})`, [...advisories, advisory(`could not fetch the elected sheet: ${winErr.message}`)]);
        }
        meta = parseSidecar(await downloadBuffer(sidecarPath).catch(() => null));
        advisories.push(advisory('adopted the concurrently elected sheet'));
      }
      const sheet = toSheet(sheetBuffer, path, meta, advisories);
      cacheSet(key, sheet);
      return sheet;
    } catch (err) {
      if (err.failureCode === FAILURE_CODE) throw err;
      // Anything else (transport shape we did not anticipate) is still a
      // total failure under the same code, with the cooldown.
      log('warn', `character sheet unavailable for anchor ${key} (${err.message})`);
      recordFailure(key);
      throw identityKitError(`character sheet failed for anchor ${key}: ${err.message}`, [advisory(`sheet build failed: ${err.message}`)]);
    } finally {
      _inFlight.delete(key);
    }
  })();
  _inFlight.set(key, resolve);
  return resolve.then(copySheet);
}

module.exports = {
  getCharacterSheet,
  characterSheetPath,
  characterSheetSidecarPath,
  buildSheetPrompt,
  buildSheetQaPrompt,
  cleanDescription,
  parseSheetVerdict,
  electCandidate,
  sheetCandidateCount,
  anchorHash,
  FAILURE_CODE,
  PHOTO_LIKENESS_ADVISORY,
  COVER_LIKENESS_MIN,
};
