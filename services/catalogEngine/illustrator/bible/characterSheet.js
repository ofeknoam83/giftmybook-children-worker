/**
 * Approved-cover character sheets. Verified legacy sheets remain fixed.
 * New candidates and judgments are durable; confirmed defects get an
 * immediate targeted repair within one saved budget. Unavailable checks
 * retain the image. No failure cooldown and no unverified cover-only fallback.
 *
 * Garment lettering is CLOTHING (2026-09-08, `shared/illustration/
 * garmentLettering.js`): a logo, patch, badge, name or number the approved
 * cover shows ON a garment is reproduced by the render prompt and judged
 * under the outfit fields; only annotation text — labels, view names,
 * captions, notes, arrows, watermarks — outside the clothing is `sheet_text`.
 *
 * The render climbs a PROMPT-VARIANT SAFETY LADDER (2026-09-15, recovery-3):
 * every other Gemini image path in this worker retries a provider block on
 * a sanitized and then a generic-safe prompt, but the sheet render posted
 * ONE prompt, stamped the block with the VERIFIER's wording ("Verifier
 * blocked the request: PROHIBITED_CONTENT" — no verifier had run), saved it
 * as the slot's durable failure and paused the book for a review that could
 * only ever replay the same block. A block now advances to the next rung of
 * `sheetPromptLadder` inside the SAME slot — `sanitized` (the fixed template
 * with none of the caller-supplied text: the cover-time description of a
 * real child's photo, the name and the age are the only per-book words in
 * the prompt), then `generic-safe` (the same sheet asked for in calm,
 * character-centric language and no repair source) — and only a block on
 * every rung is the durable `provider_blocked` failure, named as the RENDER's
 * with each rung's outcome on record. A blocked call buys no image, so a
 * slot still purchases at most one; the judge holds a degraded-rung sheet to
 * every required check like any other candidate, and an elected one carries
 * a stage advisory naming the rung it rendered on.
 *
 * Two more things the first laddered book taught (all three rungs blocked,
 * and "regenerate" changed nothing): (1) the fixed REFERENCE 1 label — "the
 * parent-approved rendering of the child: … body proportions …" — rode every
 * rung, the generic-safe one included, so the last rung never was free of
 * the child/body vocabulary it exists to drop; it is neutral there now.
 * (2) The recovery root was purely content-keyed, so an admin's explicit
 * regeneration (`forceNew` / `forceRerender`) replayed the saved refusal
 * without ever calling the provider again — `retryNamespace` (the explicit
 * regeneration's key, threaded from the pipeline) opens a fresh durable
 * budget for the anchor; a plain resume still replays. A refusal on every
 * rung is tagged `providerRefusedRender` on the thrown error so the bible
 * can fall back to cover-anchored rendering (`CATALOG_SHEET_REFUSAL_FALLBACK`)
 * instead of pausing a book no retry can unblock.
 */

const { getNextApiKey, GEMINI_MODEL, fetchWithTimeout, renderStyleBlock } = require('../../../illustrationGenerator');
const { PIXAR_STYLE, GEMINI_QA_MODEL, GEMINI_IMAGE_SAFETY_SETTINGS } = require('../../../shared/illustration/config');
const { sanitizeForGemini } = require('../../../promptSanitizer');
const { judgeImage, digest, responseOutcome } = require('../../../shared/llm/visualJudge');
const { GARMENT_LETTERING_JUDGE_NOTE } = require('../../../shared/illustration/garmentLettering');
const { pending } = require('../referenceContract');
const { downloadBuffer, uploadBuffer, uploadBufferIfAbsent } = require('../../../gcsStorage');
const { STYLE_VERSION } = require('../../versions');
const { fnv1a } = require('../../selection');
const { anchorHash } = require('../outfitLock');
const flags = require('../../flags');

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
/** The vision judge honors the same knob as spread QA (CATALOG_QA_VISION_MODEL). */
const QA_MODEL = () => process.env.CATALOG_QA_VISION_MODEL || GEMINI_QA_MODEL;
const SHEET_TIMEOUT_MS = 180000;
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

// Successful sheets are cached; concurrent callers share the active work.
// Failed work lives in GCS, including its cause and bounded attempt claims.
const SHEET_CACHE_MAX = 16;
const _sheets = new Map();
const _inFlight = new Map();
// recovery-2 (2026-09-08): the render prompt and the judge treat garment
// lettering as clothing — recovery-1 roots hold candidates rejected for the
// letters on their own patches and are never replayed.
// recovery-3 (2026-09-15): the render climbs the prompt-variant safety
// ladder — recovery-2 roots hold slots whose ONE prompt the image provider
// blocked (a block the sanitized / generic-safe rungs exist to clear) and
// are never replayed.
const RECOVERY_VERSION = 'character-sheet-recovery-3';
/** The prompt-variant safety ladder, climbed in order on a provider block. */
const RUNGS = ['original', 'sanitized', 'generic-safe'];
const RENDER_LEASE_MS = SHEET_TIMEOUT_MS + 30000;

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
 * Total candidate/repair budget per anchor: CATALOG_SHEET_CANDIDATES, clamped 1-4
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
    'OUTFIT: the SAME complete outfit in all three views — every garment, colour, pattern, and length identical from view to view. Where the reference crops a garment (legs, shoes), complete it ONCE and draw that completion identically in every view. Apart from consistently completing cropped clothing and footwear, do not add garments or worn accessories.',
    'CLOTHING EVIDENCE: copy only clothing actually visible in the approved cover. Complete cropped hems, legs and shoes consistently once. A held story object (such as a bell), scenery and cover text are NOT clothing and must be omitted. Preserve garment construction and underlying colours while removing dramatic scene lighting.',
    'HEAD INSETS: two small head-and-shoulders insets in the top corner — one happy, one curious — the same child, same hair, same skin tone.',
    'BACKGROUND: a flat light-grey studio background with even, soft lighting. NO scene, NO environment, NO props, NO other people, animals, or creatures.',
    'ANATOMY: exactly two arms and two hands with exactly five clearly separated fingers per hand, two legs, and two feet on every figure — no third arm, no extra or duplicated hand, no stray hand, no fused fingers.',
    'GARMENT LETTERING: a word, logo, emblem, patch, badge, name or number that REFERENCE 1 shows ON a garment is part of that garment — reproduce it exactly as the cover shows it (same garment, same place, same size, same wording) in every view that shows that garment; never enlarge it and never add any.',
    'Apart from garment lettering copied from REFERENCE 1, ABSOLUTELY NO text: no labels, view names, captions, notes, arrows, numbers, or watermarks anywhere in the image — not on the background, not beside, above, or over the figures — the sheet is a pure visual reference.',
  );
  return lines.join('\n');
}

/**
 * The ladder's LAST rung: the same model sheet asked for in calm,
 * character-centric language — no caller-supplied text, no age, none of
 * the full template's body-part vocabulary or capitalised prohibitions
 * (the wire sanitizer's own note: harsh meta-directives skew the image
 * classifier toward PROHIBITED_CONTENT), and no repair source. The judge
 * still holds the result to every required check against the approved
 * cover, so a calmer ASK never lowers the bar on the RESULT.
 * @returns {string}
 */
function buildGenericSafeSheetPrompt() {
  return [
    renderStyleBlock(PIXAR_STYLE),
    'CHARACTER MODEL SHEET (turnaround) of the cartoon character in REFERENCE 1, in the same rendering style.',
    'The approved character in REFERENCE 1 is ground truth for the face, hair, skin tone, proportions, apparent age, and the colours and materials of the outfit: reproduce them; only the viewing angle and the expression change.',
    'LAYOUT: three complete standing views of the same character side by side in one row, each shown whole from the top of the head to the shoes — front view on the left, three-quarter view in the middle, back view on the right — standing relaxed with the arms at the sides, entirely inside the frame.',
    'OUTFIT: the identical complete outfit in every view — every garment, colour, pattern and length the same from view to view; complete any garment or shoe the reference crops, once, and draw that completion identically in each view. Add nothing that is not worn in the reference; a held story object, scenery and cover text are not clothing.',
    'HEAD INSETS: two small head-and-shoulders insets in a top corner, one happy and one curious — the same character, hair and skin tone.',
    'BACKGROUND: a flat light-grey studio background with even, soft lighting and nothing else in the picture.',
    'ANATOMY: correct anatomy on every figure — two arms, two hands with five separated fingers each, two legs, two feet.',
    'TEXT: apart from lettering the reference shows on the clothing, the image contains no writing of any kind.',
  ].join('\n');
}

/**
 * The prompt-variant safety ladder for one anchor, climbed in order when
 * the image provider blocks a rung: `original` (the full template with the
 * sanitized child line and description), `sanitized` (the same template
 * with NONE of the caller-supplied text, through the wire sanitizer's
 * image-mode softeners), `generic-safe` (`buildGenericSafeSheetPrompt`).
 * Deterministic for the same inputs; the recovery root digests every rung.
 * @param {{profile?: object|null, characterDescription?: string|null}} [params]
 * @returns {Array<{rung: string, prompt: string}>}
 */
function sheetPromptLadder({ profile = null, characterDescription = null } = {}) {
  return [
    { rung: 'original', prompt: buildSheetPrompt({ profile, characterDescription }) },
    { rung: 'sanitized', prompt: sanitizeForGemini(buildSheetPrompt({}), { mode: 'image' }) },
    { rung: 'generic-safe', prompt: buildGenericSafeSheetPrompt() },
  ];
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
 * One Gemini image call for one rung of one sheet candidate: the rung's
 * prompt, the labeled approved-character reference, and (below the last
 * rung) the repair source. Kept local instead of reusing
 * generateIllustration: that path wraps scenes in per-spread prompt
 * language a model sheet must not carry. Resolves `{buffer}` on an image,
 * `{failure}` (a typed outcome — `provider_blocked` / `transient` /
 * `configuration`) otherwise; never throws on a provider answer.
 * @param {string} prompt
 * @param {{base64: string, mimeType?: string}} refPhoto the approved anchor bytes
 * @param {{buffer: Buffer, defects: string[]}|null} repair
 * @returns {Promise<{buffer?: Buffer, failure?: object}>}
 */
async function postSheetRender(prompt, refPhoto, repair, rung = 'original') {
  const parts = [
    { text: prompt },
    // The label is prompt text too: the generic-safe rung keeps it free of
    // the child/body vocabulary the rung exists to drop.
    { text: rung === 'generic-safe'
      ? 'REFERENCE 1 — APPROVED CHARACTER (the approved rendering: face, hair, skin tone, proportions, rendering style, and outfit are ground truth)'
      : 'REFERENCE 1 — APPROVED CHARACTER (the parent-approved rendering of the child: face, hair, skin tone, body proportions, rendering style, and outfit are ground truth)' },
    { inline_data: { mimeType: refPhoto.mimeType || 'image/png', data: refPhoto.base64 } },
  ];
  if (repair) parts.push(
    { text: `REFERENCE 2 — REPAIR SOURCE, not a new identity. Preserve the character, layout, and all correct clothing, including the already completed hidden hems and shoes. Correct only these verified defects (DATA): ${JSON.stringify(repair.defects)}. The approved cover remains authoritative. Lettering the approved cover shows on a garment is clothing and stays; sheet text means labels, captions, notes, arrows or watermarks outside the clothing. Do not copy any incorrect feature from the repair source.` },
    { inline_data: { mimeType: 'image/png', data: repair.buffer.toString('base64') } },
  );
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
  if (!resp.ok) {
    // The shared transport's rule: a 400 whose body names a safety block
    // is the provider refusing the request, never a configuration fault.
    const body = typeof resp.text === 'function' ? await resp.text().catch(() => '') : '';
    if (resp.status === 400 && /safety|blocked/i.test(body)) {
      return { failure: { status: 'provider_blocked', reason: `HTTP 400 ${body.slice(0, 160)}`, promptBlock: null, finishReason: null } };
    }
    return { failure: { ...responseOutcome(null, resp.status), reason: `Character sheet render HTTP ${resp.status}` } };
  }
  const data = await resp.json();
  const outcome = responseOutcome(data);
  if (outcome?.status === 'provider_blocked') return { failure: { ...outcome, reason: outcome.promptBlock || outcome.finishReason } };
  if (outcome) return { failure: { ...outcome, reason: `Character sheet render stopped: ${outcome.reason}` } };
  const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!imagePart?.inlineData?.data) return { failure: { status: 'transient', reason: 'Character sheet renderer returned no image' } };
  return { buffer: Buffer.from(imagePart.inlineData.data, 'base64') };
}

/**
 * Render one sheet candidate through the prompt-variant safety ladder: a
 * provider block advances to the next rung (the repair source rides every
 * rung but `generic-safe` — the judge-authored defect text is caller text
 * too, and the last rung is a fresh render by design); any other failure
 * ends the slot as before. Resolves the image with the rung that produced
 * it and the blocked rungs on record; a block on EVERY rung throws a
 * `provider_blocked` failure named as the render's (never the verifier's),
 * with each rung's outcome in `verification.attempts`.
 * @param {Array<{rung: string, prompt: string}>} ladder
 * @param {{base64: string, mimeType?: string}} refPhoto
 * @param {{buffer: Buffer, defects: string[]}|null} [repair]
 * @returns {Promise<{buffer: Buffer, rung: string, attempts: Array<object>}>}
 */
async function renderSheetCandidate(ladder, refPhoto, repair = null) {
  const attempts = [];
  for (const { rung, prompt } of ladder) {
    const { buffer, failure } = await postSheetRender(prompt, refPhoto, rung === 'generic-safe' ? null : repair, rung);
    if (buffer) return { buffer, rung, attempts };
    const attempt = { rung, status: failure.status, reason: failure.reason, promptBlock: failure.promptBlock || null, finishReason: failure.finishReason || null };
    attempts.push(attempt);
    if (failure.status !== 'provider_blocked') {
      throw Object.assign(new Error(failure.reason), { verification: { ...failure, model: GEMINI_MODEL, attempts } });
    }
  }
  const last = attempts.at(-1);
  const reasons = [...new Set(attempts.map(a => a.reason))].join(', ');
  const reason = `Character sheet render blocked by the image provider on every prompt variant (${attempts.map(a => a.rung).join(', ')}): ${reasons}`;
  throw Object.assign(new Error(reason), {
    verification: { status: 'provider_blocked', reason, model: GEMINI_MODEL, promptBlock: last.promptBlock, finishReason: last.finishReason, attempts },
  });
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

A correct sheet shows exactly THREE full-body (head to toe) figures of the SAME single child standing side by side — front view, three-quarter view, back view — wearing the SAME complete outfit in all three, with feet and shoes fully visible, plus two small head insets in a corner (the insets are NOT full-body figures — do not count them), on a flat plain background, with no sheet text (no labels, view names, captions, notes, arrows, numbers or watermarks).

GARMENT LETTERING: ${GARMENT_LETTERING_JUDGE_NOTE} Lettering on a garment that image 2 shows on that garment is correct. Lettering on a garment that image 2 shows WITHOUT it, or with different wording, is an outfit_findings entry with attribute "pattern" — never sheet_text.

OUTFIT EVIDENCE: compare only garments and worn accessories visibly established by image 2. Ignore the held bell or other story props, scenery, cover text, and differences caused only by scene lighting. Cropped hems, legs and shoes may be completed consistently; never reject them for differing from an invisible reference. Do reject changed visible garment colours, patterns, materials, cut or length, extra clothing, and differences between views. Do not claim a mismatch unless you can name the visible expected detail and the observed difference. Uncertainty is not evidence of a defect.

Answer STRICT JSON only:
{
  "outfit_findings": [], // for EACH cover outfit mismatch: {"slot":"top|bottom|footwear|outerwear|accessory", "attribute":"colour|pattern|material|cut|length|presence", "reference_visibility":"visible", "expected":"specific visible cover detail", "observed":"specific different sheet detail"}; empty when cover_outfit_matches is true. Never include hidden details or held props.
  "garment_lettering": "…",      // the exact lettering you can read ON the figures' clothing in image 1 (a logo, patch, badge, name or number), verbatim; "" when there is none
  "sheet_text": true|false,      // any readable text, letters, labels, view names, captions, notes, arrows, numbers, or watermarks on the background, beside, above, or over the figures in image 1 — NOT the garment lettering above
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

const VERDICT_BOOLEANS = ['sheet_text', 'one_child', 'feet_visible', 'outfit_consistent_across_views', 'anatomy_ok', 'cover_identity_matches', 'cover_outfit_matches'];
const SHEET_TEXT_DEFECT = 'readable text on the sheet outside the clothing (a label, caption, note, arrow or watermark — garment lettering is clothing)';
const GARMENT_LETTERING_MAX_CHARS = 120;

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
 * `garment_lettering` is a best-effort transcript of the lettering the judge
 * read ON the clothing (inert data for the log and the advisories, capped,
 * never a gate): the letters on a patch are clothing, so a sheet carrying
 * them passes on `sheet_text: false` — only annotation text outside the
 * clothing is the defect.
 * @returns {{pass: boolean, defects: string[], likeness: number, photoLikeness: number|null, garmentLettering: string|null}|null}
 */
function parseSheetVerdict(json, { detailed = false } = {}) {
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
  const garmentLettering = cleanLine(own('garment_lettering'), GARMENT_LETTERING_MAX_CHARS);
  const findings = own('outfit_findings');
  if (detailed) {
    const line = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 300 && !/[\u0000-\u001f]/.test(v);
    if (!Array.isArray(findings) || findings.length > 12 || findings.some(f => !f ||
      !['top', 'bottom', 'footwear', 'outerwear', 'accessory'].includes(f.slot) ||
      !['colour', 'pattern', 'material', 'cut', 'length', 'presence'].includes(f.attribute) ||
      f.reference_visibility !== 'visible' || !line(f.expected) || !line(f.observed) || f.expected.trim() === f.observed.trim())) return null;
    if (own('cover_outfit_matches') !== (findings.length === 0)) return null;
  }
  const defects = [
    own('sheet_text') && SHEET_TEXT_DEFECT,
    figureCount !== 3 && `${figureCount} full-body figures (expected 3)`,
    !own('one_child') && 'figures do not all depict the same single child',
    !own('feet_visible') && 'feet/shoes not fully visible on every figure',
    !own('outfit_consistent_across_views') && 'outfit differs between views',
    !own('cover_identity_matches') && 'identity differs from the approved character',
    !own('cover_outfit_matches') && (detailed ? findings.map(f => `${f.slot} ${f.attribute}: cover shows ${f.expected}; sheet shows ${f.observed}`).join('; ') : 'outfit differs from the approved character'),
    likeness < COVER_LIKENESS_MIN && `cover likeness ${likeness.toFixed(2)} below the ${COVER_LIKENESS_MIN} floor`,
    !own('anatomy_ok') && 'anatomy error (limbs/hands/fingers)',
  ].filter(Boolean);
  return { pass: defects.length === 0, defects, likeness, photoLikeness, garmentLettering };
}

/** Same saved evidence and full validation on every recheck. */
async function judgeSheetCandidate(sheetBuffer, refPhoto, childPhoto, root, costTracker) {
  const parts = [
    { text: buildSheetQaPrompt(Boolean(childPhoto?.base64)) },
    { inline_data: { mimeType: 'image/png', data: sheetBuffer.toString('base64') } },
    { inline_data: { mimeType: refPhoto.mimeType || 'image/png', data: refPhoto.base64 } },
  ];
  if (childPhoto?.base64) parts.push({ inline_data: { mimeType: childPhoto.mimeType || 'image/jpeg', data: childPhoto.base64 } });
  const verification = await judgeImage({ parts, model: QA_MODEL(), label: 'character-sheet', recoveryRoot: `${root}/checks`, costTracker,
    validate: json => parseSheetVerdict(json, { detailed: true }) ? null : 'Complete character verdict and specific visible outfit mismatch evidence are required' });
  return verification.status === 'verified' ? { verdict: parseSheetVerdict(verification.json, { detailed: true }), verification } : { verification };
}

async function readSaved(path) {
  try { return await downloadBuffer(path); }
  catch (err) { if (err.code === 404 || /not found|No such object|cache miss/i.test(err.message)) return null; throw err; }
}
const saveJson = (path, data) => uploadBufferIfAbsent(Buffer.from(JSON.stringify(data)), path, 'application/json');

function sheetPending(outcome, results = []) {
  const err = pending(`Character reference needs attention: ${outcome.reason}. Saved sheets are retained.`, outcome, 'character_sheet');
  err.advisories = results.map(r => advisory(`candidate ${r.index + 1}: ${(r.verdict?.defects || [r.verification?.reason]).filter(Boolean).join('; ')}`));
  return err;
}

/**
 * The durable record of a candidate that rendered below the ladder's first
 * rung, saved beside its PNG so a resume replays the advisory and the
 * evidence panel shows the blocked rungs. Null for an `original` render.
 * @param {string} key candidate key (no extension)
 * @returns {Promise<{rung: string, attempts: Array<object>}|null>}
 */
async function readRenderRecord(key) {
  const raw = await readSaved(`${key}.render.json`);
  if (!raw) return null;
  try {
    const json = JSON.parse(raw.toString());
    return json && RUNGS.includes(json.rung) ? { rung: json.rung, attempts: Array.isArray(json.attempts) ? json.attempts : [] } : null;
  } catch { return null; }
}

/** One initial candidate, then repairs guided by actual findings, up to the
 * persisted limit (default three TOTAL images, not three per retry). An
 * explicit regeneration (`retryNamespace`) gets its own root — and budget —
 * beside the content-keyed one; a plain resume replays the latter. */
async function resolveCandidates({ path, ladder, refPhoto, childPhoto, retryNamespace = null, costTracker, log }) {
  const image = { mimeType: refPhoto.mimeType || 'image/png', data: refPhoto.base64 };
  const root = `${path}.${digest({ version: RECOVERY_VERSION, model: GEMINI_MODEL, prompts: ladder.map(r => r.prompt), image, ...(retryNamespace ? { retry: retryNamespace } : {}) })}.recovery-v1`;
  if (retryNamespace) log('info', `character sheet: explicit regeneration (${retryNamespace}) — a fresh attempt budget at ${root}`);
  const results = [];
  let repair = null;
  try {
    await saveJson(`${root}/budget.json`, { limit: sheetCandidateCount() });
    const budget = JSON.parse((await readSaved(`${root}/budget.json`)).toString());
    if (!Number.isInteger(budget.limit) || budget.limit < CANDIDATES_MIN || budget.limit > CANDIDATES_MAX) throw new Error('Invalid saved sheet budget');
    for (let index = 0; index < budget.limit; index++) {
      const key = `${root}/candidate-${index}`;
      let buffer = await readSaved(`${key}.png`);
      let renderFailure = await readSaved(`${key}.error.json`);
      let render = buffer ? await readRenderRecord(key) : null;
      if (renderFailure) {
        renderFailure = JSON.parse(renderFailure.toString());
      } else if (!buffer) {
        const claimed = await saveJson(`${key}.claim.json`, { at: Date.now() });
        if (!claimed.created) {
          // The other process may have completed between our read and claim.
          buffer = await readSaved(`${key}.png`);
          if (!buffer) {
            const failure = await readSaved(`${key}.error.json`);
            const claim = JSON.parse((await readSaved(`${key}.claim.json`)).toString());
            if (!Number.isFinite(claim.at)) throw new Error('Invalid character-sheet reservation');
            if (failure) renderFailure = JSON.parse(failure.toString());
            else if (Date.now() - claim.at < RENDER_LEASE_MS) throw sheetPending({ status: 'transient', reason: 'A character sheet is already being generated', evidenceKey: root }, results);
            else renderFailure = { status: 'transient', reason: 'Previous character-sheet generation was interrupted' };
          }
        } else {
          log('info', `character sheet candidate ${index + 1}: ${repair ? 'repairing verified defects' : 'generating'} (${root})`);
          try {
            const rendered = await renderSheetCandidate(ladder, refPhoto, repair);
            buffer = rendered.buffer;
            if (rendered.rung !== 'original') {
              render = { rung: rendered.rung, attempts: rendered.attempts };
              log('warn', `character sheet candidate ${index + 1}: rendered on the ${rendered.rung} prompt after the image provider blocked ${describeBlocks(rendered.attempts)}`);
            }
            costTracker?.addImageGeneration?.(GEMINI_MODEL, 1);
          } catch (err) {
            renderFailure = err.verification || { status: 'transient', reason: 'Character-sheet render transport interrupted' };
            await saveJson(`${key}.error.json`, renderFailure);
          }
          // Save before QA. A storage failure must not be recast as a visual
          // defect or cause more image purchases in this run.
          if (buffer) {
            await uploadBufferIfAbsent(buffer, `${key}.png`, 'image/png');
            if (render) await saveJson(`${key}.render.json`, render);
          }
        }
      } else costTracker?.recordReuse?.('image');
      if (renderFailure) {
        const outcome = { ...renderFailure, evidenceKey: root };
        results.push({ index, verification: outcome, error: outcome.reason });
        if (outcome.status !== 'transient') {
          const err = sheetPending(outcome, results);
          // The provider refused to draw the sheet on every rung of the
          // ladder: no retry can route around it, so the bible may render
          // the book on the cover alone instead of pausing it for good.
          if (outcome.status === 'provider_blocked') err.providerRefusedRender = true;
          throw err;
        }
        continue; // known failed call: next bounded slot can run immediately
      }
      const judged = await judgeSheetCandidate(buffer, refPhoto, childPhoto, root, costTracker);
      results.push({ index, buffer, render, ...judged });
      if (!judged.verdict) throw sheetPending(judged.verification, results);
      await saveJson(`${key}.verdict.json`, judged.verdict);
      if (judged.verdict.pass) return { ...electCandidate(results, log), count: index + 1, root };
      // Repair the best verified candidate seen so far. The cover is still
      // authoritative; correct inferred garments are preserved from this source.
      if (!repair || judged.verdict.defects.length < repair.defects.length ||
        (judged.verdict.defects.length === repair.defects.length && judged.verdict.likeness > repair.likeness)) {
        repair = { buffer, defects: judged.verdict.defects, likeness: judged.verdict.likeness };
      }
    }
    electCandidate(results, log);
    const last = results.filter(r => r.verdict).at(-1);
    throw sheetPending({ status: last ? 'confirmed_defect' : 'exhausted', exhausted: true,
      reason: last ? `Character-sheet repair budget reached: ${last.verdict.defects.join('; ')}` : 'Character-sheet render attempt budget reached', evidenceKey: root }, results);
  } catch (err) {
    if (err.recovery) throw err;
    throw sheetPending({ status: 'configuration', reason: 'Character-sheet evidence storage unavailable', evidenceKey: root }, results);
  }
}

/**
 * The blocked rungs of a laddered render as one log/advisory fragment.
 * @param {Array<{rung: string, reason: string}>} attempts
 * @returns {string}
 */
function describeBlocks(attempts) {
  return attempts.map(a => `the ${a.rung} prompt (${a.reason})`).join(' and ');
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
 * @param {Array<object>} results in candidate order
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
    } else if (r.verification && !r.verdict) {
      advisories.push(advisory(`candidate ${n} unverifiable: ${r.verification.reason}`));
    } else if (r.unverifiable) {
      log('warn', `character sheet candidate ${n}: UNVERIFIABLE (${r.unverifiable})`);
      advisories.push(advisory(`candidate ${n} unverifiable: ${r.unverifiable}`));
    } else if (!r.verdict.pass) {
      log('info', `character sheet candidate ${n}: REJECTED (${r.verdict.defects.join('; ')}; ${describeLikeness(r.verdict)})`);
      advisories.push(advisory(`candidate ${n} rejected: ${r.verdict.defects.join('; ')}`));
    } else {
      log('info', `character sheet candidate ${n}: PASS (${describeLikeness(r.verdict)}${r.verdict.garmentLettering ? `; garment lettering "${r.verdict.garmentLettering}" judged as clothing` : ''})`);
    }
  }
  const passing = results.filter(r => r.verdict?.pass);
  if (passing.length > 0) {
    const winner = passing.reduce((best, r) => (r.verdict.likeness > best.verdict.likeness ? r : best), passing[0]);
    const photoLikeness = typeof winner.verdict.photoLikeness === 'number' ? winner.verdict.photoLikeness : null;
    if (winner.render && winner.render.rung !== 'original') {
      // A degraded-rung sheet is never silent: it passed every required
      // check against the approved cover, but the prompt that produced it
      // carried none of the caller text (or, generic-safe, a calmer ask).
      advisories.push(advisory(`elected sheet (candidate ${winner.index + 1}) rendered on the ${winner.render.rung} prompt variant after the image provider blocked ${describeBlocks(winner.render.attempts)}; it passed every required check against the approved cover`));
    }
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
 * @param {string|null} [params.retryNamespace] an EXPLICIT regeneration's
 *   key (the pipeline derives it from `forceNew` / `forceRerender`): the
 *   sheet's recovery root — and its durable attempt budget — is opened
 *   afresh under it, so a regenerate really calls the provider again. Null
 *   (a plain resume) replays the content-keyed root. An ELECTED sheet is
 *   pinned per anchor and wins either way.
 * @param {object} [params.costTracker]
 * @param {(level: string, msg: string) => void} [params.log]
 * @returns {Promise<{base64: string, mimeType: string, hash: string, storageKey: string, likeness: number|null, photoLikeness: number|null, candidates: number, advisories: Array<{stage: string, note: string}>}|null>}
 *   null ONLY when the kill-switch is off.
 * @throws {Error} `visual_recovery_pending` for unresolved work, retaining
 *   candidates and the original cause (`providerRefusedRender: true` when
 *   the image provider blocked the render on every rung of the ladder);
 *   `identity_kit_failed` for missing input.
 */
async function getCharacterSheet({ anchorUrl, refPhoto, childPhoto = null, profile = null, characterDescription = null, retryNamespace = null, costTracker, log = () => {} }) {
  if (!flags.characterSheetEnabled()) return null;
  if (!anchorUrl || !refPhoto?.base64) {
    throw identityKitError('character sheet: an identity anchor URL and its bytes are required', [advisory('no identity anchor supplied')]);
  }
  const key = anchorHash(anchorUrl);
  const hit = cacheGet(key);
  if (hit) return copySheet(hit);
  if (_inFlight.has(key)) return _inFlight.get(key).then(copySheet);

  const resolve = (async () => {
    const path = characterSheetPath(key);
    const sidecarPath = characterSheetSidecarPath(key);
    try {
      const cached = await readSaved(path);
      if (cached) {
        const meta = parseSidecar(await downloadBuffer(sidecarPath).catch(() => null));
        const sheet = toSheet(cached, path, meta, []);
        cacheSet(key, sheet);
        return sheet;
      }
      const ladder = sheetPromptLadder({ profile, characterDescription });
      const election = await resolveCandidates({ path, ladder, refPhoto, childPhoto, retryNamespace: typeof retryNamespace === 'string' && retryNamespace ? retryNamespace : null, costTracker, log });
      const count = election.count;
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
        // during a GCS outage. The next call retries election using saved bytes.
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
        // to fetch the winner is recoverable — the
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
      if (err.recovery) throw err;
      // Anything else (transport shape we did not anticipate) is still a
      // recoverable storage/election failure; never purchase another sheet.
      log('warn', `character sheet unavailable for anchor ${key} (${err.message})`);
      throw sheetPending({ status: 'configuration', reason: `Character-sheet election unavailable: ${err.message}`, evidenceKey: path });
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
  buildGenericSafeSheetPrompt,
  sheetPromptLadder,
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
